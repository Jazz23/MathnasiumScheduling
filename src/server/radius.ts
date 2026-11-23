// Talks to Mathnasium Radius (https://radius.mathnasium.com).
//
// Radius is an ASP.NET MVC app with a plain username/password form and cookie
// sessions: there is no OAuth or refresh token, and it can't be iframed
// (X-Frame-Options: SAMEORIGIN). So the Worker signs in on the user's behalf,
// keeps the session cookies, and signs in again with the stored (encrypted)
// password whenever Radius sends it back to the login page.

import type { Env } from "./env";
import { decryptPassword } from "./crypto";

export const RADIUS_ORIGIN = "https://radius.mathnasium.com";
const LOGIN_PATH = "/Account/Login";
const USER_AGENT = "MathnasiumScheduling/1.0";

export class RadiusLoginError extends Error {}

// A minimal cookie jar: name -> value, serialized as a Cookie header.
type CookieJar = Map<string, string>;

function parseJar(header: string | null | undefined): CookieJar {
  const jar: CookieJar = new Map();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

function serializeJar(jar: CookieJar): string {
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join("; ");
}

// Applies a response's Set-Cookie headers to the jar. Returns true if
// anything changed.
function absorbCookies(jar: CookieJar, response: Response): boolean {
  let changed = false;
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair = "", ...attrs] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((attr) => {
      const [key = "", val = ""] = attr.split("=", 2).map((s) => s.trim());
      if (key.toLowerCase() === "max-age") return Number(val) <= 0;
      if (key.toLowerCase() === "expires") return Date.parse(val) < Date.now();
      return false;
    });
    if (expired || value === "") {
      changed = jar.delete(name) || changed;
    } else if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  return changed;
}

function isLoginRedirect(response: Response): boolean {
  if (response.status === 401) return true;
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get("Location") ?? "";
  return new URL(location, RADIUS_ORIGIN).pathname.toLowerCase() === LOGIN_PATH.toLowerCase();
}

function radiusRequest(path: string, jar: CookieJar, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  if (jar.size > 0) headers.set("Cookie", serializeJar(jar));
  return fetch(new URL(path, RADIUS_ORIGIN), { ...init, headers, redirect: "manual" });
}

/**
 * Signs in to Radius with a username and password. Returns the session
 * cookies as a Cookie header string, or throws RadiusLoginError if Radius
 * rejects the credentials.
 */
export async function radiusLogin(username: string, password: string): Promise<string> {
  const jar: CookieJar = new Map();

  // The login form needs the anti-forgery token from both the page and the
  // cookie it sets.
  const page = await radiusRequest(LOGIN_PATH, jar);
  absorbCookies(jar, page);
  const html = await page.text();
  const form = html.match(/<form[^>]*id="LoginForm"[\s\S]*?<\/form>/i)?.[0] ?? html;
  const token = form.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
  if (!page.ok || !token) {
    throw new Error(`Radius login page unavailable (HTTP ${page.status})`);
  }

  const response = await radiusRequest(LOGIN_PATH, jar, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      __RequestVerificationToken: token,
      UserName: username,
      Password: password,
    }),
  });
  absorbCookies(jar, response);

  // Success redirects away from the login page; failure re-renders the form
  // with a 200.
  if (response.status < 300 || response.status >= 400 || isLoginRedirect(response)) {
    throw new RadiusLoginError("Radius rejected the username or password");
  }
  return serializeJar(jar);
}

interface AccountRow {
  username: string;
  password_ciphertext: string;
  password_iv: string;
  radius_cookies: string | null;
}

async function saveCookies(env: Env, accountId: number, jar: CookieJar) {
  await env.DB.prepare(
    `UPDATE radius_accounts
       SET radius_cookies = ?, radius_cookies_updated_at = unixepoch(), updated_at = unixepoch()
     WHERE id = ?`,
  )
    .bind(serializeJar(jar), accountId)
    .run();
}

function getAccount(env: Env, accountId: number) {
  return env.DB.prepare(
    "SELECT username, password_ciphertext, password_iv, radius_cookies FROM radius_accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<AccountRow>();
}

/**
 * Signs in to Radius again with the account's stored password and saves the
 * new cookies. Only the account's AccountLock calls this, so that requests
 * that find an expired session at the same time share one sign-in.
 */
export async function radiusSignInAgain(env: Env, accountId: number): Promise<string> {
  const account = await getAccount(env, accountId);
  if (!account) throw new Error(`No Radius account ${accountId}`);
  const password = await decryptPassword(
    env.RADIUS_CREDENTIAL_KEY,
    account.username,
    account.password_ciphertext,
    account.password_iv,
  );
  const jar = parseJar(await radiusLogin(account.username, password));
  await saveCookies(env, accountId, jar);
  return serializeJar(jar);
}

/**
 * Makes a request to Radius as the given account. Uses the stored session
 * cookies, and if Radius has expired them, signs in again with the stored
 * password (through the account's AccountLock) and retries once. Redirects
 * are not followed. Because the request may be sent twice, pass a replayable
 * body (string, URLSearchParams, FormData), not a stream.
 */
export async function radiusFetch(
  env: Env,
  accountId: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const account = await getAccount(env, accountId);
  if (!account) throw new Error(`No Radius account ${accountId}`);

  let jar = parseJar(account.radius_cookies);
  const sentAt = Date.now();
  if (jar.size > 0) {
    const response = await radiusRequest(path, jar, init);
    if (!isLoginRedirect(response)) {
      if (absorbCookies(jar, response)) await saveCookies(env, accountId, jar);
      return response;
    }
  }

  const lock = env.ACCOUNT_LOCK.getByName(String(accountId));
  jar = parseJar(await lock.radiusSignIn(accountId, sentAt));
  const response = await radiusRequest(path, jar, init);
  absorbCookies(jar, response);
  await saveCookies(env, accountId, jar);
  return response;
}
