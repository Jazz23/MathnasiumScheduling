// /api/auth/* routes: "Login with Radius" and this app's own sessions.

import type { Env } from "./env";
import { encryptPassword, newSessionToken, sha256Hex } from "./crypto";
import { RadiusLoginError, radiusLogin } from "./radius";
import { batchWrite, getItem, isConditionFailure, keys, nextId, nowSeconds, putItem, queryAll, deleteItem, transact, updateItem, table } from "./db";

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

/** A Radius account as stored (keys.account). Timestamps are epoch seconds unless noted. */
export interface AccountItem {
  id: number;
  username: string;
  passwordCiphertext: string; // base64
  passwordIv: string; // base64, 12 bytes
  radiusCookies: string | null; // "name=value; name2=value2" Cookie header
  radiusCookiesUpdatedAt: number | null;
  /** When the server last signed in to Radius itself, in milliseconds. */
  radiusSignedInAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface SessionItem {
  accountId: number;
  expiresAt: number;
}

/**
 * Returns the Radius account behind the request's session cookie, if any.
 * Sessions of a deleted account stop working at once, because the account
 * is looked up too.
 */
export async function getSessionAccount(request: Request, _env: Env): Promise<SessionAccount | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const session = await getItem<SessionItem>(keys.session(await sha256Hex(token)));
  if (!session || session.expiresAt <= nowSeconds()) return null;
  const account = await getItem<AccountItem>(keys.account(session.accountId));
  return account ? { id: account.id, username: account.username } : null;
}

/** Creates or updates the account for `username`, keyed case-insensitively. */
async function saveAccount(username: string, ciphertext: string, iv: string, radiusCookies: string): Promise<SessionAccount> {
  const now = nowSeconds();
  const fields = {
    username,
    passwordCiphertext: ciphertext,
    passwordIv: iv,
    radiusCookies,
    radiusCookiesUpdatedAt: now,
    radiusSignedInAt: Date.now(),
    updatedAt: now,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await getItem<{ accountId: number }>(keys.username(username));
    if (existing) {
      try {
        await updateItem(keys.account(existing.accountId), fields, { mustExist: true });
        return { id: existing.accountId, username };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        continue; // deleted meanwhile; try again
      }
    }
    const id = await nextId("account");
    try {
      await transact([
        {
          Put: {
            TableName: table(),
            Item: { ...keys.username(username), accountId: id },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        { Put: { TableName: table(), Item: { ...keys.account(id), id, ...fields, createdAt: now } } },
      ]);
      return { id, username };
    } catch (err) {
      if (!isConditionFailure(err)) throw err; // someone else created it; use theirs
    }
  }
  throw new Error("Failed to save Radius account");
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
  const account = await saveAccount(username, ciphertext, iv, radiusCookies);

  // Expired sessions are deleted by the table's TTL.
  const token = newSessionToken();
  const expiresAt = nowSeconds() + SESSION_TTL_SECONDS;
  await putItem({ ...keys.session(await sha256Hex(token)), accountId: account.id, expiresAt, ttl: expiresAt });

  return Response.json(
    { username: account.username },
    { headers: { "Set-Cookie": sessionCookie(token, SESSION_TTL_SECONDS) } },
  );
}

// POST /api/auth/logout — ends this browser's session; Radius stays linked.
async function logout(request: Request): Promise<Response> {
  const token = readSessionToken(request);
  if (token) await deleteItem(keys.session(await sha256Hex(token)));
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
}

/**
 * Deletes an account and everything stored under it: its stored password and
 * cookies, Sling link, sign-in records and leases. Its other sessions stop
 * working at once (getSessionAccount looks the account up) and expire by TTL.
 */
export async function deleteAccount(account: SessionAccount): Promise<void> {
  const items = await queryAll(keys.account(account.id).pk);
  await batchWrite([...items.map(({ pk, sk }) => ({ delete: { pk, sk } })), { delete: keys.username(account.username) }]);
}

// DELETE /api/auth/radius — unlinks Radius: deletes the stored password,
// Radius cookies, the Sling link and this browser's session.
async function disconnectRadius(request: Request, env: Env): Promise<Response> {
  const account = await getSessionAccount(request, env);
  if (!account) return Response.json({ error: "Not signed in" }, { status: 401 });
  await deleteAccount(account);
  const token = readSessionToken(request);
  if (token) await deleteItem(keys.session(await sha256Hex(token)));
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
  if (pathname === "/api/auth/logout" && request.method === "POST") return logout(request);
  return null;
}
