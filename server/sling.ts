// Sling (https://app.getsling.com): "Log in to Sling" and a same-origin
// reverse proxy so the Sling web app can be shown in an iframe next to Radius.
//
// Login: Sling's API (POST /v1/account/login) requires a reCAPTCHA v2 token
// from its login page (login.getsling.com). The server gets one from
// CapMonster Cloud, signs in, and keeps the token Sling returns in its
// Authorization response header. The password is stored encrypted so the
// server can sign in again (solving a new captcha) when the token expires.
//
// Embed: app.getsling.com sends X-Frame-Options: SAMEORIGIN and its API only
// allows CORS from app.getsling.com, so both are proxied:
//   /sling/*        -> https://app.getsling.com/*  (the AngularJS app's files)
//   /sling/__api/*  -> https://api.getsling.com/*  (adds the stored token)
// The app's JS has its API URL rewritten to /sling/__api/, and its HTML gets
// <base href="/sling/">. Like the Radius proxy, a service worker scoped to
// /sling/ maps the app's other root-relative requests (lazy chunks, Angular
// templates) under /sling/. The app reads its token from the
// "authorization-token" cookie, so the page gets a placeholder cookie; the
// real token never reaches the browser — the API proxy swaps it in.
// Sling's realtime socket (socket.getsling.com) is not proxied, so live
// updates need a reload.

import type { Env } from "./env";
import { getSessionAccount } from "./auth";
import { decryptPassword, encryptPassword } from "./crypto";
import { cancelSlingSignIn, getSlingSignIn, isActive, slingSignIn } from "./accountLock";
import type { SlingSignInJob } from "./slingSignIn";
import { deleteItem, getItem, isConditionFailure, keys, nowSeconds, table, transact, updateItem, updateParts } from "./db";
import { rewriteHtml as rewriteHtmlText } from "./html";

const APP_ORIGIN = "https://app.getsling.com";
const API_ORIGIN = "https://api.getsling.com";
const LOGIN_PAGE = "https://login.getsling.com/";
// Production RECAPTCHA_SITE_KEY from Sling's login bundle.
const RECAPTCHA_SITE_KEY = "6LfWw3soAAAAAHFXwfg7pycuARSxmIG28sHVTzd8";
const CAPMONSTER = "https://api.capmonster.cloud";
// Sling sits behind Cloudflare, which answers 403 to requests without a
// browser-like User-Agent.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export const SLING_PREFIX = "/sling";
const API_PREFIX = `${SLING_PREFIX}/__api`;
const SW_PATH = `${SLING_PREFIX}/__proxy-sw.js`;
const PLACEHOLDER_TOKEN = "proxied";

export class SlingLoginError extends Error {}
/** A newer sign-in, or unlinking Sling, replaced this one before it could save. */
export class SlingSignInSuperseded extends Error {}

// ---------------------------------------------------------------- captcha

async function capmonster<T>(method: string, body: object): Promise<T> {
  const res = await fetch(`${CAPMONSTER}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { errorId: number; errorCode?: string; errorDescription?: string } & T;
  if (data.errorId !== 0) throw new Error(`CapMonster ${method}: ${data.errorCode} ${data.errorDescription ?? ""}`);
  return data;
}

/** Solves Sling's login reCAPTCHA with CapMonster. Usually takes 10–60 s. */
async function solveCaptcha(env: Env): Promise<string> {
  if (!env.CAPMONSTER_API_KEY) throw new Error("CAPMONSTER_API_KEY is not set");
  const { taskId } = await capmonster<{ taskId: number }>("createTask", {
    clientKey: env.CAPMONSTER_API_KEY,
    task: { type: "RecaptchaV2Task", websiteURL: LOGIN_PAGE, websiteKey: RECAPTCHA_SITE_KEY },
  });
  // Checks every 5 s for up to 2 min.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await capmonster<{ status: string; solution?: { gRecaptchaResponse: string } }>("getTaskResult", {
      clientKey: env.CAPMONSTER_API_KEY,
      taskId,
    });
    if (result.status === "ready" && result.solution) return result.solution.gRecaptchaResponse;
  }
  throw new Error("CapMonster timed out solving the Sling captcha");
}

// ------------------------------------------------------------------ login

interface SlingSession {
  token: string;
  orgId: number | null;
}

/** Signs in to Sling. Throws SlingLoginError if Sling rejects the credentials. */
export async function slingLogin(env: Env, email: string, password: string): Promise<SlingSession> {
  const captchaResponse = await solveCaptcha(env);
  const res = await fetch(`${API_ORIGIN}/v1/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://login.getsling.com", "User-Agent": USER_AGENT },
    body: JSON.stringify({ email: email.trim(), password, captchaResponse }),
  });
  const data = (await res.json().catch(() => null)) as { message?: string; org?: { id?: number } } | null;
  const token = res.headers.get("Authorization");
  // Wrong credentials: 409 "Sorry, the email and password you've entered
  // don't match". A rejected captcha is also a 409 ("Captcha verification
  // failed"), which is our problem, not the user's.
  if ((res.status === 401 || res.status === 409) && !/captcha/i.test(data?.message ?? "")) {
    throw new SlingLoginError(data?.message ?? "Sling rejected the email or password");
  }
  if (!res.ok || !token) throw new Error(`Sling login failed (HTTP ${res.status}): ${data?.message ?? ""}`);
  return { token, orgId: typeof data?.org?.id === "number" ? data.org.id : null };
}

/** The Sling link as stored (keys.sling). */
interface SlingItem {
  email: string;
  passwordCiphertext: string; // base64
  passwordIv: string; // base64, 12 bytes
  slingToken: string | null; // value for Sling's Authorization header
  orgId: number | null;
  slingTokenUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const aad = (email: string) => `sling:${email}`;

const getRow = (accountId: number) => getItem<SlingItem>(keys.sling(accountId));

async function saveToken(accountId: number, token: string, orgId?: number | null) {
  try {
    await updateItem(
      keys.sling(accountId),
      { slingToken: token, orgId: orgId ?? undefined, slingTokenUpdatedAt: nowSeconds(), updatedAt: nowSeconds() },
      { mustExist: true },
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err; // unlinked meanwhile
  }
}

/**
 * Signs in to Sling and saves the result, marking the sign-in done. Runs in
 * the background (server/slingSignIn.ts). With `link`, saves those
 * credentials as the account's Sling link; otherwise signs in again with the
 * stored ones. Saves only while `signInId` is still the account's latest
 * sign-in, and throws SlingSignInSuperseded otherwise. Throws SlingLoginError
 * if Sling turns the credentials down.
 */
export async function slingSignInAndSave(env: Env, { accountId, signInId, link }: SlingSignInJob): Promise<void> {
  let save: Parameters<typeof transact>[0][number];
  const now = nowSeconds();
  if (link) {
    const password = await decryptPassword(env.RADIUS_CREDENTIAL_KEY, aad(link.email), link.ciphertext, link.iv);
    const session = await slingLogin(env, link.email, password);
    const existing = await getRow(accountId);
    const item: SlingItem = {
      email: link.email,
      passwordCiphertext: link.ciphertext,
      passwordIv: link.iv,
      slingToken: session.token,
      orgId: session.orgId,
      slingTokenUpdatedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    save = { Put: { TableName: table(), Item: { ...keys.sling(accountId), ...item } } };
  } else {
    const row = await getRow(accountId);
    if (!row) throw new SlingLoginError("Sling isn't linked");
    const password = await decryptPassword(env.RADIUS_CREDENTIAL_KEY, aad(row.email), row.passwordCiphertext, row.passwordIv);
    const session = await slingLogin(env, row.email, password);
    save = {
      Update: {
        TableName: table(),
        Key: keys.sling(accountId),
        ...updateParts(
          { slingToken: session.token, orgId: session.orgId ?? undefined, slingTokenUpdatedAt: now, updatedAt: now },
          { mustExist: true },
        ),
      },
    };
  }
  try {
    await transact([
      save,
      {
        ConditionCheck: {
          TableName: table(),
          Key: keys.slingSignInPointer(accountId),
          ConditionExpression: "signInId = :id",
          ExpressionAttributeValues: { ":id": signInId },
        },
      },
      {
        Update: {
          TableName: table(),
          Key: keys.slingSignIn(accountId, signInId),
          ...updateParts(
            { state: "done", finishedAt: Date.now() },
            { condition: { expression: "#state = :pending", names: { "#state": "state" }, values: { ":pending": "pending" } } },
          ),
        },
      },
    ]);
  } catch (err) {
    if (isConditionFailure(err)) throw new SlingSignInSuperseded(`Sling sign-in ${signInId} was replaced`);
    throw err;
  }
}

type SignInState = { state: "pending" } | { state: "done" } | { state: "failed"; credentials: boolean; message: string };

/** A sign-in's state, or null if the account has no such sign-in. */
async function signInState(accountId: number, signInId: string): Promise<SignInState | null> {
  const record = await getSlingSignIn(accountId, signInId);
  if (!record) return null;
  if (record.state === "done") return { state: "done" };
  if (isActive(record)) return { state: "pending" };
  if (record.state === "pending") return { state: "failed", credentials: false, message: "timed out" };
  return { state: "failed", credentials: !!record.credentials, message: record.message ?? record.state };
}

/**
 * Gets a new Sling token, sharing a sign-in with any other request doing the
 * same. `since` is when the caller sent the request Sling turned down. Waits
 * for the background sign-in, which usually takes 10–60 seconds.
 */
async function refreshToken(env: Env, accountId: number, since: number): Promise<string> {
  const ticket = await slingSignIn(env, accountId, { since });
  if ("signInId" in ticket) {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const result = await signInState(accountId, ticket.signInId);
      if (!result) throw new Error("Sling sign-in disappeared");
      if (result.state === "done") break;
      if (result.state === "failed") throw new Error(`Sling sign-in failed: ${result.message}`);
      if (Date.now() > deadline) throw new Error("Timed out waiting for the Sling sign-in");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const row = await getRow(accountId);
  if (!row?.slingToken) throw new Error("Sling sign-in finished without a token");
  return row.slingToken;
}

/**
 * GETs a Sling API path (e.g. "/v1/users/concise") as the account and returns
 * the parsed JSON. Signs in again (through slingSignIn()) if the token has
 * expired. Throws if Sling isn't linked or answers with an error.
 */
export async function slingGet<T>(env: Env, accountId: number, path: string): Promise<T> {
  const row = await getRow(accountId);
  if (!row) throw new SlingLoginError("Sling isn't linked");
  const send = (token: string) =>
    fetch(API_ORIGIN + path, {
      headers: { Authorization: token, Accept: "application/json", "User-Agent": USER_AGENT },
    });
  const sentAt = Date.now();
  let token = row.slingToken ?? (await refreshToken(env, accountId, sentAt));
  let res = await send(token);
  if (res.status === 401) {
    token = await refreshToken(env, accountId, sentAt);
    res = await send(token);
  }
  const fresh = res.headers.get("Authorization");
  if (fresh && fresh !== token) await saveToken(accountId, fresh);
  if (!res.ok) throw new Error(`Sling GET ${path.split("?")[0]} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The linked Sling account's organization ID and user ID. */
export async function slingIdentity(env: Env, accountId: number): Promise<{ orgId: number; userId: number }> {
  const session = await slingGet<{ user?: { id?: unknown }; org?: { id?: unknown } }>(env, accountId, "/v1/account/session");
  const userId = session.user?.id;
  const orgId = session.org?.id;
  if (typeof userId !== "number" || typeof orgId !== "number") throw new Error("Unexpected Sling session");
  return { orgId, userId };
}

// --------------------------------------------------------------- /api/sling

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const account = await getSessionAccount(request, env);
  if (!account) return json({ error: "Not signed in" }, 401);

  // GET /api/sling — { linked, email }
  if (pathname === "/api/sling" && request.method === "GET") {
    const row = await getRow(account.id);
    return json({ linked: !!row, email: row?.email ?? null });
  }

  // POST /api/sling — { email, password }. Starts the sign-in in the
  // background and returns 202 { signIn: signInId } right away; the page
  // polls GET /api/sling/sign-in/:id. The background sign-in only ever gets
  // the encrypted password.
  if (pathname === "/api/sling" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) return json({ error: "Email and password are required." }, 400);

    const { ciphertext, iv } = await encryptPassword(env.RADIUS_CREDENTIAL_KEY, aad(email), password);
    const ticket = await slingSignIn(env, account.id, { link: { email, ciphertext, iv } });
    if (!("signInId" in ticket)) throw new Error("Expected a new Sling sign-in");
    return json({ signIn: ticket.signInId }, 202);
  }

  // GET /api/sling/sign-in/:id — { state: "pending" | "done" | "failed", email?, error? }
  const signInId = pathname.match(/^\/api\/sling\/sign-in\/([^/]+)$/)?.[1];
  if (signInId && request.method === "GET") {
    // Sign-ins are stored under their account, so an account can only see
    // its own.
    const result = await signInState(account.id, decodeURIComponent(signInId));
    if (!result) return json({ error: "Not found" }, 404);
    if (result.state === "done") {
      const row = await getRow(account.id);
      return json({ state: "done", email: row?.email ?? null });
    }
    if (result.state === "failed") {
      if (!result.credentials) console.error("Sling sign-in failed", result.message);
      const error = result.credentials
        ? "Sling didn't accept that email and password."
        : "Couldn't sign in to Sling. Try again in a moment.";
      return json({ state: "failed", error });
    }
    return json({ state: "pending" });
  }

  // DELETE /api/sling — unlink, deleting the stored password and token, and
  // stopping a sign-in that's still running.
  if (pathname === "/api/sling" && request.method === "DELETE") {
    await cancelSlingSignIn(account.id);
    await deleteItem(keys.sling(account.id));
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ proxy

const SERVICE_WORKER = `
const PREFIX = ${JSON.stringify(SLING_PREFIX + "/")};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith(PREFIX)) return;
  if (request.mode === "navigate") return;
  url.pathname = PREFIX.slice(0, -1) + url.pathname;
  event.respondWith((async () => {
    const init = { method: request.method, headers: request.headers, credentials: "same-origin", redirect: "follow" };
    if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
    return fetch(url, init);
  })());
});
`;

const DROP_REQUEST_HEADERS = ["cookie", "host", "origin", "referer", "connection", "content-length", "accept-encoding", "authorization"];
const DROP_REQUEST_PREFIXES = ["sec-", "cf-", "x-forwarded-", "x-real-ip", "x-amz", "via", "cloudfront-"];
const DROP_RESPONSE_HEADERS = [
  "set-cookie",
  "authorization",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "content-length",
  "content-encoding",
  "etag",
];

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.includes(lower)) continue;
    if (DROP_REQUEST_PREFIXES.some((p) => lower.startsWith(p))) continue;
    headers.set(name, value);
  }
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  return headers;
}

function cleanHeaders(upstream: Response): Headers {
  const headers = new Headers(upstream.headers);
  for (const name of DROP_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}

/** Maps an app.getsling.com URL (absolute or root-relative) under /sling/. */
function toProxyUrl(value: string): string {
  if (value.startsWith("//")) return value;
  if (value.startsWith("/")) return SLING_PREFIX + value;
  if (value === APP_ORIGIN || value.startsWith(APP_ORIGIN + "/")) return SLING_PREFIX + (value.slice(APP_ORIGIN.length) || "/");
  return value;
}

function headScript(orgId: number | null): string {
  const cookies = [`authorization-token=${PLACEHOLDER_TOKEN}`, ...(orgId ? [`org-id=${orgId}`] : [])];
  return `<script>(() => {
  ${cookies.map((c) => `document.cookie = ${JSON.stringify(`${c}; path=${SLING_PREFIX}/; SameSite=Lax`)};`).join("\n  ")}
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith(${JSON.stringify(SLING_PREFIX + "/")})) {
      url = ${JSON.stringify(SLING_PREFIX)} + url;
    }
    return open.call(this, method, url, ...rest);
  };
})();</script>`;
}

async function rewriteHtml(upstream: Response, headers: Headers, orgId: number | null): Promise<Response> {
  const html = rewriteHtmlText(await upstream.text(), {
    headPrepend: headScript(orgId),
    attributes: [
      { tag: "base", attribute: "href", map: () => SLING_PREFIX + "/" },
      { tag: "script", attribute: "src", map: toProxyUrl },
      { tag: "link", attribute: "href", map: toProxyUrl },
      { tag: "img", attribute: "src", map: toProxyUrl },
    ],
  });
  return new Response(html, { status: upstream.status, statusText: upstream.statusText, headers });
}

// Points the app's bundles at the API proxy instead of api.getsling.com.
async function rewriteJs(upstream: Response, headers: Headers): Promise<Response> {
  const text = (await upstream.text()).replaceAll(`${API_ORIGIN}/`, `${API_PREFIX}/`);
  return new Response(text, { status: upstream.status, headers });
}

async function proxyApi(request: Request, env: Env, accountId: number, url: URL): Promise<Response> {
  const row = await getRow(accountId);
  if (!row) return json({ message: "Sling isn't linked." }, 401);

  const path = url.pathname.slice(API_PREFIX.length) + url.search;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const send = (token: string) => {
    const headers = forwardHeaders(request);
    headers.set("Authorization", token);
    headers.set("Origin", APP_ORIGIN);
    return fetch(API_ORIGIN + path, { method: request.method, headers, body, redirect: "manual" });
  };

  const sentAt = Date.now();
  let token = row.slingToken ?? (await refreshToken(env, accountId, sentAt));
  let upstream = await send(token);
  if (upstream.status === 401) {
    token = await refreshToken(env, accountId, sentAt);
    upstream = await send(token);
  }
  // Sling can hand back a refreshed token.
  const fresh = upstream.headers.get("Authorization");
  if (fresh && fresh !== token) await saveToken(accountId, fresh);

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: cleanHeaders(upstream) });
}

async function proxyApp(request: Request, accountId: number, url: URL): Promise<Response> {
  const path = (url.pathname.slice(SLING_PREFIX.length) || "/") + url.search;
  const upstream = await fetch(APP_ORIGIN + path, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: forwardHeaders(request),
    redirect: "manual",
  });
  const headers = cleanHeaders(upstream);
  const location = upstream.headers.get("Location");
  if (location) headers.set("Location", toProxyUrl(location));

  const contentType = headers.get("Content-Type") ?? "";
  if (contentType.includes("javascript")) return rewriteJs(upstream, headers);
  if (contentType.startsWith("text/html")) {
    const row = await getRow(accountId);
    return rewriteHtml(upstream, headers, row?.orgId ?? null);
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Handles /api/sling and /sling/* requests, or returns null for other paths. */
export async function handleSling(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  if (pathname === "/api/sling" || pathname.startsWith("/api/sling/")) return handleApi(request, env, pathname);
  if (pathname === SW_PATH) {
    return new Response(SERVICE_WORKER, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  if (pathname !== SLING_PREFIX && !pathname.startsWith(SLING_PREFIX + "/")) return null;

  const account = await getSessionAccount(request, env);
  if (!account) return new Response("Not signed in to the scheduling app.", { status: 401 });
  if (pathname.startsWith(API_PREFIX + "/")) return proxyApi(request, env, account.id, url);
  return proxyApp(request, account.id, url);
}
