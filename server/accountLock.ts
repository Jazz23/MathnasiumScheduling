// One sign-in at a time per app account. Requests that find an expired login
// at the same time share one sign-in, instead of each signing in again (for
// Sling, each solving a paid captcha). Requests can be in different Lambda
// instances, so the coordination is in DynamoDB:
//
// - Radius sign-ins are quick and run in the request that needs one, holding
//   a lease (an item with an expiry, taken with a conditional write). Others
//   wait for the lease holder and use the cookies it saved.
// - Sling sign-ins take up to a couple of minutes, so they run in the
//   background (server/slingSignIn.ts, its own Lambda in production). The
//   account's SLING_SIGN_IN item names the latest one; it's replaced with a
//   compare-and-swap, so only one request starts a new sign-in. A sign-in
//   only saves its result while it's still the latest, which is how a newer
//   one or an unlink stops it.

import type { Env } from "./env";
import type { AccountItem } from "./auth";
import { radiusSignInAgain } from "./radius";
import { deleteItem, getItem, isConditionFailure, keys, nowSeconds, putItem, table, transact, updateItem, updateParts } from "./db";

/** The Sling credentials to link, with the password already encrypted. */
export interface SlingLinkCredentials {
  email: string;
  ciphertext: string;
  iv: string;
}

/** A Sling sign-in's state, stored at keys.slingSignIn. Times in milliseconds. */
export interface SlingSignInRecord {
  signInId: string;
  state: "pending" | "done" | "failed" | "cancelled";
  /** On failure: true if Sling turned down the email and password. */
  credentials?: boolean;
  message?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Either a sign-in already finished, or the sign-in to wait for. */
export type SlingSignInTicket = { done: true } | { signInId: string };

/** A pending sign-in older than this has died (its Lambda timed out or crashed). */
export const SLING_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const RADIUS_LEASE_MS = 60_000;
const RADIUS_WAIT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isActive(record: SlingSignInRecord): boolean {
  return record.state === "pending" && Date.now() - record.startedAt < SLING_SIGN_IN_TIMEOUT_MS;
}

// ------------------------------------------------------------------ Radius

/** Takes the lease if it's free or expired. Returns its owner token, or null. */
async function tryLease(accountId: number, name: string, ms: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  try {
    await putItem(
      { ...keys.lock(accountId, name), owner, until: now + ms, ttl: nowSeconds() + Math.ceil(ms / 1000) + 60 },
      { expression: "attribute_not_exists(pk) OR #until < :now", names: { "#until": "until" }, values: { ":now": now } },
    );
    return owner;
  } catch (err) {
    if (isConditionFailure(err)) return null;
    throw err;
  }
}

async function releaseLease(accountId: number, name: string, owner: string): Promise<void> {
  const current = await getItem<{ owner: string }>(keys.lock(accountId, name));
  if (current?.owner === owner) await deleteItem(keys.lock(accountId, name));
}

/**
 * Returns fresh Radius cookies. `since` is when the caller sent the request
 * that found its session expired (milliseconds): if a sign-in finished after
 * that, its cookies are reused.
 */
export async function radiusSignIn(env: Env, accountId: number, since: number): Promise<string> {
  const deadline = Date.now() + RADIUS_WAIT_MS;
  for (;;) {
    const fresh = async () => {
      const account = await getItem<AccountItem>(keys.account(accountId));
      if (!account) throw new Error(`No Radius account ${accountId}`);
      return (account.radiusSignedInAt ?? 0) >= since && account.radiusCookies ? account.radiusCookies : null;
    };
    const reused = await fresh();
    if (reused) return reused;

    const owner = await tryLease(accountId, "radius", RADIUS_LEASE_MS);
    if (owner) {
      try {
        // Someone may have finished between the check and taking the lease.
        return (await fresh()) ?? (await radiusSignInAgain(env, accountId));
      } finally {
        await releaseLease(accountId, "radius", owner).catch((err) => console.error("Releasing the Radius lease failed", err));
      }
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for another Radius sign-in");
    await sleep(500);
  }
}

// ------------------------------------------------------------------- Sling

export function getSlingSignIn(accountId: number, signInId: string) {
  return getItem<SlingSignInRecord>(keys.slingSignIn(accountId, signInId));
}

async function currentSlingSignIn(accountId: number) {
  const pointer = await getItem<{ signInId: string }>(keys.slingSignInPointer(accountId));
  return { pointer, record: pointer ? await getSlingSignIn(accountId, pointer.signInId) : null };
}

/**
 * Starts a Sling sign-in, or joins the one already running.
 *
 * - With `link`, always starts a new one with those credentials, stopping
 *   any that's running with the old ones.
 * - Otherwise signs in again with the stored login, unless one finished
 *   after `since` (milliseconds; when the caller's token was turned down).
 */
export async function slingSignIn(
  env: Env,
  accountId: number,
  options: { since: number; link?: undefined } | { link: SlingLinkCredentials },
): Promise<SlingSignInTicket> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { pointer, record } = await currentSlingSignIn(accountId);
    if (!options.link && record) {
      if (isActive(record)) return { signInId: record.signInId };
      if (record.state === "done" && (record.finishedAt ?? 0) >= options.since) return { done: true };
    }

    const signInId = `sling-${accountId}-${Date.now()}`;
    const startedAt = Date.now();
    try {
      await transact([
        {
          Put: {
            TableName: table(),
            Item: { ...keys.slingSignInPointer(accountId), signInId },
            ...(pointer
              ? { ConditionExpression: "signInId = :old", ExpressionAttributeValues: { ":old": pointer.signInId } }
              : { ConditionExpression: "attribute_not_exists(pk)" }),
          },
        },
        {
          Put: {
            TableName: table(),
            Item: {
              ...keys.slingSignIn(accountId, signInId),
              signInId,
              state: "pending",
              startedAt,
              ttl: nowSeconds() + RECORD_TTL_SECONDS,
            } satisfies SlingSignInRecord & { ttl: number },
          },
        },
        ...(record && record.state === "pending"
          ? [
              {
                Update: {
                  TableName: table(),
                  Key: keys.slingSignIn(accountId, record.signInId),
                  ...updateParts({ state: "cancelled", finishedAt: startedAt }),
                },
              },
            ]
          : []),
      ]);
    } catch (err) {
      if (isConditionFailure(err)) continue; // another request started one; look again
      throw err;
    }

    try {
      await env.startSlingSignIn({ accountId, signInId, link: options.link });
    } catch (err) {
      await finishSlingSignIn(accountId, signInId, { state: "failed", message: String(err) });
      throw err;
    }
    return { signInId };
  }
  throw new Error("Couldn't start a Sling sign-in: too many at once");
}

/** Records how a sign-in ended, unless it was already stopped. */
export async function finishSlingSignIn(
  accountId: number,
  signInId: string,
  result: Pick<SlingSignInRecord, "state" | "credentials" | "message">,
): Promise<void> {
  try {
    await updateItem(
      keys.slingSignIn(accountId, signInId),
      { ...result, finishedAt: Date.now() },
      { mustExist: true, condition: { expression: "#state = :pending", names: { "#state": "state" }, values: { ":pending": "pending" } } },
    );
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
  }
}

/** Stops a running Sling sign-in, for example when Sling is unlinked. */
export async function cancelSlingSignIn(accountId: number): Promise<void> {
  const { record } = await currentSlingSignIn(accountId);
  await deleteItem(keys.slingSignInPointer(accountId));
  if (record?.state === "pending") await finishSlingSignIn(accountId, record.signInId, { state: "cancelled" });
}
