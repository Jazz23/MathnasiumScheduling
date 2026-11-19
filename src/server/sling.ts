// Sling (https://app.getsling.com): "Log in to Sling" and a same-origin
// reverse proxy so the Sling web app can be shown in an iframe next to Radius.
//
// Login: Sling's API (POST /v1/account/login) requires a reCAPTCHA v2 token
// from its login page (login.getsling.com). The Worker gets one from
// CapMonster Cloud, signs in, and keeps the token Sling returns in its
// Authorization response header. The password is stored encrypted so the
// Worker can sign in again (solving a new captcha) when the token expires.
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
import type { HTMLRewriter as HTMLRewriterType } from "@cloudflare/workers-types/index.ts";
import { getSessionAccount } from "./auth";
import { decryptPassword, encryptPassword } from "./crypto";

declare const HTMLRewriter: typeof HTMLRewriterType;

const APP_ORIGIN = "https://app.getsling.com";
const API_ORIGIN = "https://api.getsling.com";
const LOGIN_PAGE = "https://login.getsling.com/";
// Production RECAPTCHA_SITE_KEY from Sling's login bundle.
const RECAPTCHA_SITE_KEY = "6LfWw3soAAAAAHFXwfg7pycuARSxmIG28sHVTzd8";
const CAPMONSTER = "https://api.capmonster.cloud";
// Sling sits behind Cloudflare, which answers 403 to requests without a
// browser-like User-Agent (the Workers runtime sends none by default).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export const SLING_PREFIX = "/sling";
const API_PREFIX = `${SLING_PREFIX}/__api`;
const SW_PATH = `${SLING_PREFIX}/__proxy-sw.js`;
const PLACEHOLDER_TOKEN = "proxied";

export class SlingLoginError extends Error {}

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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
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

interface SlingRow {
  email: string;
  password_ciphertext: string;
  password_iv: string;
  sling_token: string | null;
  org_id: number | null;
}

const aad = (email: string) => `sling:${email}`;

function getRow(env: Env, accountId: number) {
  return env.DB.prepare(
    "SELECT email, password_ciphertext, password_iv, sling_token, org_id FROM sling_accounts WHERE account_id = ?",
  )
    .bind(accountId)
    .first<SlingRow>();
}

async function saveToken(env: Env, accountId: number, token: string, orgId?: number | null) {
  await env.DB.prepare(
    `UPDATE sling_accounts SET sling_token = ?, org_id = COALESCE(?, org_id),
       sling_token_updated_at = unixepoch(), updated_at = unixepoch() WHERE account_id = ?`,
  )
    .bind(token, orgId ?? null, accountId)
    .run();
}

async function relogin(env: Env, accountId: number, row: SlingRow): Promise<string> {
  const password = await decryptPassword(env.RADIUS_CREDENTIAL_KEY, aad(row.email), row.password_ciphertext, row.password_iv);
  const session = await slingLogin(env, row.email, password);
  await saveToken(env, accountId, session.token, session.orgId);
  return session.token;
}

// --------------------------------------------------------------- /api/sling

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const account = await getSessionAccount(request, env);
  if (!account) return json({ error: "Not signed in" }, 401);

  // GET /api/sling — { linked, email }
  if (pathname === "/api/sling" && request.method === "GET") {
    const row = await getRow(env, account.id);
    return json({ linked: !!row, email: row?.email ?? null });
  }

  // POST /api/sling — { email, password }
  if (pathname === "/api/sling" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) return json({ error: "Email and password are required." }, 400);

    let session: SlingSession;
    try {
      session = await slingLogin(env, email, password);
    } catch (err) {
      if (err instanceof SlingLoginError) return json({ error: "Sling didn't accept that email and password." }, 401);
      console.error("Sling login failed", err);
      return json({ error: "Couldn't sign in to Sling. Try again in a moment." }, 502);
    }
    const { ciphertext, iv } = await encryptPassword(env.RADIUS_CREDENTIAL_KEY, aad(email), password);
    await env.DB.prepare(
      `INSERT INTO sling_accounts (account_id, email, password_ciphertext, password_iv, sling_token, org_id, sling_token_updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())
       ON CONFLICT (account_id) DO UPDATE SET
         email = excluded.email, password_ciphertext = excluded.password_ciphertext,
         password_iv = excluded.password_iv, sling_token = excluded.sling_token,
         org_id = excluded.org_id, sling_token_updated_at = excluded.sling_token_updated_at,
         updated_at = unixepoch()`,
    )
      .bind(account.id, email, ciphertext, iv, session.token, session.orgId)
      .run();
    return json({ linked: true, email });
  }

  // DELETE /api/sling — unlink, deleting the stored password and token.
  if (pathname === "/api/sling" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM sling_accounts WHERE account_id = ?").bind(account.id).run();
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
const DROP_REQUEST_PREFIXES = ["sec-", "cf-", "x-forwarded-", "x-real-ip"];
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

class AttributeRewriter {
  constructor(private readonly attribute: string) {}
  element(el: { getAttribute(n: string): string | null; setAttribute(n: string, v: string): unknown }) {
    const value = el.getAttribute(this.attribute);
    if (value) el.setAttribute(this.attribute, toProxyUrl(value));
  }
}

function rewriteHtml(response: Response, orgId: number | null): Response {
  return new HTMLRewriter()
    .on("head", {
      element(el: { prepend(content: string, options: { html: boolean }): unknown }) {
        el.prepend(headScript(orgId), { html: true });
      },
    })
    .on("base[href]", {
      element(el: { setAttribute(n: string, v: string): unknown }) {
        el.setAttribute("href", SLING_PREFIX + "/");
      },
    })
    .on("script[src]", new AttributeRewriter("src"))
    .on("link[href]", new AttributeRewriter("href"))
    .on("img[src]", new AttributeRewriter("src"))
    .transform(response as any) as unknown as Response;
}

// Points the app's bundles at the API proxy instead of api.getsling.com.
async function rewriteJs(upstream: Response, headers: Headers): Promise<Response> {
  const text = (await upstream.text()).replaceAll(`${API_ORIGIN}/`, `${API_PREFIX}/`);
  return new Response(text, { status: upstream.status, headers });
}

async function proxyApi(request: Request, env: Env, accountId: number, url: URL): Promise<Response> {
  const row = await getRow(env, accountId);
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

  let token = row.sling_token ?? (await relogin(env, accountId, row));
  let upstream = await send(token);
  if (upstream.status === 401) {
    token = await relogin(env, accountId, row);
    upstream = await send(token);
  }
  // Sling can hand back a refreshed token.
  const fresh = upstream.headers.get("Authorization");
  if (fresh && fresh !== token) await saveToken(env, accountId, fresh);

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: cleanHeaders(upstream) });
}

async function proxyApp(request: Request, env: Env, accountId: number, url: URL): Promise<Response> {
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
  const response = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  if (contentType.startsWith("text/html")) {
    const row = await getRow(env, accountId);
    return rewriteHtml(response, row?.org_id ?? null);
  }
  return response;
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
  return proxyApp(request, env, account.id, url);
}
