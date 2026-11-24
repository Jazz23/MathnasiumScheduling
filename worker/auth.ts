// /api/auth/* routes: "Login with Radius" and this app's own sessions.

import type { Env } from "./env";
import { encryptPassword, newSessionToken, sha256Hex } from "./crypto";
import { RadiusLoginError, radiusLogin } from "./radius";

const SESSION_COOKIE = "session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readSessionToken(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

export interface SessionAccount {
  id: number;
  username: string;
}

/** Returns the Radius account behind the request's session cookie, if any. */
export async function getSessionAccount(request: Request, env: Env): Promise<SessionAccount | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT a.id, a.username
       FROM sessions s JOIN radius_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch()`,
  )
    .bind(await sha256Hex(token))
    .first<SessionAccount>();
}

// POST /api/auth/radius  { username, password }
async function loginWithRadius(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    return Response.json({ error: "Username and password are required." }, { status: 400 });
  }

  let radiusCookies: string;
  try {
    radiusCookies = await radiusLogin(username, password);
  } catch (err) {
    if (err instanceof RadiusLoginError) {
      return Response.json({ error: "Radius didn't accept that username and password." }, { status: 401 });
    }
    console.error("Radius login failed", err);
    return Response.json({ error: "Couldn't reach Radius. Try again in a moment." }, { status: 502 });
  }

  const { ciphertext, iv } = await encryptPassword(env.RADIUS_CREDENTIAL_KEY, username, password);
  const account = await env.DB.prepare(
    `INSERT INTO radius_accounts (username, password_ciphertext, password_iv, radius_cookies, radius_cookies_updated_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch())
     ON CONFLICT (username) DO UPDATE SET
       username = excluded.username,
       password_ciphertext = excluded.password_ciphertext,
       password_iv = excluded.password_iv,
       radius_cookies = excluded.radius_cookies,
       radius_cookies_updated_at = excluded.radius_cookies_updated_at,
       updated_at = unixepoch()
     RETURNING id, username`,
  )
    .bind(username, ciphertext, iv, radiusCookies)
    .first<SessionAccount>();
  if (!account) throw new Error("Failed to save Radius account");

  const token = newSessionToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= unixepoch()"),
    env.DB.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, unixepoch() + ?)").bind(
      await sha256Hex(token),
      account.id,
      SESSION_TTL_SECONDS,
    ),
  ]);

  return Response.json(
    { username: account.username },
    { headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL_SECONDS) } },
  );
}

// POST /api/auth/logout — ends this browser's session; Radius stays linked.
async function logout(request: Request, env: Env): Promise<Response> {
  const token = readSessionToken(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
}

// DELETE /api/auth/radius — unlinks Radius: deletes the stored password,
// Radius cookies and every session for the account.
async function disconnectRadius(request: Request, env: Env): Promise<Response> {
  const account = await getSessionAccount(request, env);
  if (!account) return Response.json({ error: "Not signed in" }, { status: 401 });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM radius_accounts WHERE id = ?").bind(account.id),
  ]);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
}

/** Handles /api/auth/* routes, or returns null for any other path. */
export async function handleAuth(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === "/api/auth/radius") {
    if (request.method === "POST") return loginWithRadius(request, env);
    if (request.method === "DELETE") return disconnectRadius(request, env);
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (pathname === "/api/auth/me" && request.method === "GET") {
    const account = await getSessionAccount(request, env);
    return account
      ? Response.json({ username: account.username })
      : Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  return null;
}
