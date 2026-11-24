// Typed reads of Sling data: people, positions and locations, and the
// calendar (shifts and time off). Sling's API is undocumented for third
// parties; shapes are from its own web app (see "Sling endpoints found so far"
// in docs/PLAN.md). Responses are checked rather than trusted.

import type { Env } from "./env";
import { slingGet, slingIdentity } from "./sling";
import { localOffset } from "./time";

export interface SlingUser {
  id: number;
  name: string;
  email: string | null;
  active: boolean;
  groupIds: number[];
}

export interface SlingGroup {
  id: number;
  type: "position" | "location" | "everyone" | string;
  name: string;
  archived: boolean;
}

/** A shift or time off, with center-local date and times. */
export interface SlingShift {
  id: string;
  userId: number | null;
  date: string; // 'YYYY-MM-DD'
  start: string; // 'HH:MM'
  end: string; // 'HH:MM' (on `endDate`)
  endDate: string;
  locationId: number | null;
  positionId: number | null;
  status: string; // published, planning
  repeating: boolean;
  breakMinutes: number;
}

export interface SlingTimeOff {
  id: string;
  userId: number | null;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  fullDay: boolean;
  approved: boolean;
}

interface RawUser {
  id: number;
  name?: string;
  lastname?: string;
  preferredName?: string | null;
  email?: string | null;
  active?: boolean;
  deleted?: boolean;
  groupIds?: number[];
}

/** Every Sling user (active or not) and every group, from /v1/users/concise. */
export async function fetchUsersAndGroups(env: Env, accountId: number): Promise<{ users: SlingUser[]; groups: SlingGroup[] }> {
  const data = await slingGet<{ users?: unknown; groups?: unknown }>(env, accountId, "/v1/users/concise");
  if (!Array.isArray(data.users) || typeof data.groups !== "object" || data.groups === null) {
    throw new Error("Unexpected response from Sling /v1/users/concise");
  }
  const users = (data.users as RawUser[])
    .filter((u) => typeof u.id === "number" && !u.deleted)
    .map((u) => ({
      id: u.id,
      name: [u.preferredName || u.name, u.lastname].filter(Boolean).join(" ") || `User ${u.id}`,
      email: u.email ?? null,
      active: u.active === true,
      groupIds: Array.isArray(u.groupIds) ? u.groupIds : [],
    }));
  const groups = Object.values(data.groups as Record<string, { id: number; type: string; name: string; archivedAt?: string | null }>)
    .filter((g) => typeof g?.id === "number")
    .map((g) => ({ id: g.id, type: g.type, name: g.name, archived: !!g.archivedAt }));
  return { users, groups };
}

interface RawEvent {
  id: string | number;
  type: string;
  status?: string;
  fullDay?: boolean;
  dtstart: string;
  dtend: string;
  approved?: string | null;
  user?: { id?: number } | null;
  location?: { id?: number } | null;
  position?: { id?: number } | null;
  rrule?: unknown;
  breakDuration?: number;
}

// "2026-11-29T12:00:00-08:00" -> ["2026-11-29", "12:00"]. Sling returns times
// in the organization's time zone, so the local part is read as is.
function splitLocal(value: string): [string, string] {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!m) throw new Error(`Unexpected time from Sling: ${value}`);
  return [m[1]!, m[2]!];
}

/**
 * Reads everyone's shifts and time off between two dates (start inclusive,
 * end exclusive, 'YYYY-MM-DD'), from the linked admin's calendar.
 */
export async function fetchCalendar(
  env: Env,
  accountId: number,
  range: { start: string; end: string },
  timeZone: string,
): Promise<{ shifts: SlingShift[]; timeOff: SlingTimeOff[] }> {
  const { orgId, userId } = await slingIdentity(env, accountId);
  const dates = `${range.start}T00:00:00${localOffset(range.start, timeZone)}/${range.end}T00:00:00${localOffset(range.end, timeZone)}`;
  const events = await slingGet<unknown>(
    env,
    accountId,
    // Sent unencoded, as Sling's own app does; only a "+" offset needs escaping.
    `/v1/calendar/${orgId}/users/${userId}?dates=${dates.replaceAll("+", "%2B")}`,
  );
  if (!Array.isArray(events)) throw new Error("Unexpected response from Sling's calendar");

  const shifts: SlingShift[] = [];
  const timeOff: SlingTimeOff[] = [];
  for (const e of events as RawEvent[]) {
    const [date, start] = splitLocal(e.dtstart);
    const [endDate, end] = splitLocal(e.dtend);
    if (e.type === "shift") {
      shifts.push({
        id: String(e.id),
        userId: e.user?.id ?? null,
        date,
        start,
        end,
        endDate,
        locationId: e.location?.id ?? null,
        positionId: e.position?.id ?? null,
        status: e.status ?? "published",
        repeating: !!e.rrule,
        breakMinutes: e.breakDuration ?? 0,
      });
    } else if (e.type === "leave") {
      timeOff.push({
        id: String(e.id),
        userId: e.user?.id ?? null,
        startDate: date,
        startTime: start,
        endDate,
        endTime: end,
        fullDay: !!e.fullDay,
        approved: !!e.approved,
      });
    }
  }
  return { shifts, timeOff };
}
