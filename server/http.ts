// Small helpers shared by the /api routes: JSON responses, the signed-in
// account, and checking request bodies.

import type { Env } from "./env";
import { getSessionAccount, type SessionAccount } from "./auth";
import { isTime } from "./time";

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Thrown for a request the client should fix; turned into a 400. */
export class BadRequest extends Error {}

/** Runs a handler for a signed-in account, turning BadRequest into 400 and other errors into 500/502. */
export async function withAccount(
  request: Request,
  env: Env,
  handler: (account: SessionAccount) => Promise<Response>,
): Promise<Response> {
  const account = await getSessionAccount(request, env);
  if (!account) return json({ error: "Not signed in" }, 401);
  try {
    return await handler(account);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "Something went wrong." }, 500);
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("Expected a JSON object.");
  return body as Record<string, unknown>;
}

/** An integer within bounds; null/undefined allowed when `nullable`. */
export function int(value: unknown, name: string, min: number, max: number, nullable = false): number | null {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

/** A number within bounds; null/undefined allowed when `nullable`. */
export function num(value: unknown, name: string, min: number, max: number, nullable = false): number | null {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw new BadRequest(`${name} must be a number from ${min} to ${max}.`);
  }
  return n;
}

export function str(value: unknown, name: string, maxLength = 200, nullable = false): string | null {
  if ((value === null || value === undefined || value === "") && nullable) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BadRequest(`${name} is required (up to ${maxLength} characters).`);
  }
  return value.trim();
}

export const bool = (value: unknown): number => (value ? 1 : 0);

export interface Window {
  weekday: number;
  start: string;
  end: string;
}

/** A list of weekly windows: [{ weekday, start, end }], each start before its end. */
export function windows(value: unknown, name: string): Window[] {
  if (!Array.isArray(value)) throw new BadRequest(`${name} must be a list.`);
  if (value.length > 200) throw new BadRequest(`${name} has too many entries.`);
  return value.map((w: unknown) => {
    const { weekday, start, end } = (w ?? {}) as Record<string, unknown>;
    const day = int(weekday, `${name}: weekday`, 0, 6)!;
    if (!isTime(start) || !isTime(end) || start >= end) {
      throw new BadRequest(`${name}: each entry needs a start time before its end time (HH:MM).`);
    }
    return { weekday: day, start, end };
  });
}

/** A list of whole numbers within bounds, without duplicates. */
export function intList(value: unknown, name: string, min: number, max: number): number[] {
  if (!Array.isArray(value)) throw new BadRequest(`${name} must be a list.`);
  return [...new Set(value.map((v) => int(v, name, min, max)!))];
}
