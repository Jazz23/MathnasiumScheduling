// /api/setup/*: center setup (feature 1). Settings, opening hours and school
// programs, stored in D1, plus the Sling locations and positions to map them to.

import type { Env } from "./env";
import { BadRequest, bool, int, json, readBody, str, windows, withAccount } from "./http";
import { fetchUsersAndGroups } from "./slingData";

export interface CenterSettings {
  radiusCenterId: number;
  timezone: string;
  minStaffOnSite: number;
  minSupervisorsOnSite: number;
  minShiftMinutes: number;
  maxShiftMinutes: number;
  maxShiftsPerDay: number;
  setupMinutes: number;
  cleanupMinutes: number;
  breakAfterMinutes: number;
  breakMinutes: number;
  homeTravelMinutes: number;
  publishLeadDays: number;
  generateWeekday: number;
  slingCenterLocationId: number | null;
  slingRemoteLocationId: number | null;
}

export interface OpeningHours {
  weekday: number;
  open: string;
  close: string;
}

export interface SchoolProgram {
  id: number;
  name: string;
  slingLocationId: number | null;
  instructorsNeeded: number;
  travelMinutes: number;
  active: boolean;
  sessions: { weekday: number; start: string; end: string }[];
}

// Column name <-> API field, with how each field is checked on save.
const SETTINGS_FIELDS: [keyof CenterSettings, string, (v: unknown) => number | string | null][] = [
  ["radiusCenterId", "radius_center_id", (v) => int(v, "Radius center ID", 1, 10_000_000)],
  ["timezone", "timezone", (v) => timeZone(v)],
  ["minStaffOnSite", "min_staff_on_site", (v) => int(v, "People on site", 0, 20)],
  ["minSupervisorsOnSite", "min_supervisors_on_site", (v) => int(v, "Supervisors on site", 0, 20)],
  ["minShiftMinutes", "min_shift_minutes", (v) => int(v, "Shortest shift", 15, 720)],
  ["maxShiftMinutes", "max_shift_minutes", (v) => int(v, "Longest shift", 15, 960)],
  ["maxShiftsPerDay", "max_shifts_per_day", (v) => int(v, "Shifts per day", 1, 4)],
  ["setupMinutes", "setup_minutes", (v) => int(v, "Setup time", 0, 120)],
  ["cleanupMinutes", "cleanup_minutes", (v) => int(v, "Cleanup time", 0, 120)],
  ["breakAfterMinutes", "break_after_minutes", (v) => int(v, "Break after", 0, 960)],
  ["breakMinutes", "break_minutes", (v) => int(v, "Break length", 0, 60)],
  ["homeTravelMinutes", "home_travel_minutes", (v) => int(v, "Home travel time", 0, 120)],
  ["publishLeadDays", "publish_lead_days", (v) => int(v, "Days ahead", 0, 28)],
  ["generateWeekday", "generate_weekday", (v) => int(v, "Generate on", 0, 6)],
  ["slingCenterLocationId", "sling_center_location_id", (v) => int(v, "Center location", 1, Number.MAX_SAFE_INTEGER, true)],
  ["slingRemoteLocationId", "sling_remote_location_id", (v) => int(v, "Remote location", 1, Number.MAX_SAFE_INTEGER, true)],
];

function timeZone(value: unknown): string {
  const zone = str(value, "Time zone", 64)!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new BadRequest("Time zone must be an IANA name such as America/Los_Angeles.");
  }
  return zone;
}

export async function loadSettings(env: Env): Promise<CenterSettings> {
  const row = await env.DB.prepare("SELECT * FROM center_settings WHERE id = 1").first<Record<string, unknown>>();
  if (!row) throw new Error("center_settings is empty; run the D1 migrations");
  return Object.fromEntries(SETTINGS_FIELDS.map(([key, column]) => [key, row[column]])) as unknown as CenterSettings;
}

export async function loadHours(env: Env): Promise<OpeningHours[]> {
  const { results } = await env.DB.prepare(
    "SELECT weekday, open_time AS open, close_time AS close FROM operating_hours ORDER BY weekday, open_time",
  ).all<OpeningHours>();
  return results;
}

export async function loadPrograms(env: Env): Promise<SchoolProgram[]> {
  const [programs, sessions] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, sling_location_id AS slingLocationId, instructors_needed AS instructorsNeeded,
              travel_minutes AS travelMinutes, active FROM school_programs ORDER BY name`,
    ),
    env.DB.prepare(
      "SELECT program_id AS programId, weekday, start_time AS start, end_time AS end FROM program_sessions ORDER BY weekday, start_time",
    ),
  ]);
  const byProgram = new Map<number, SchoolProgram["sessions"]>();
  for (const s of sessions!.results as { programId: number; weekday: number; start: string; end: string }[]) {
    const list = byProgram.get(s.programId) ?? [];
    list.push({ weekday: s.weekday, start: s.start, end: s.end });
    byProgram.set(s.programId, list);
  }
  return (programs!.results as (Omit<SchoolProgram, "sessions" | "active"> & { active: number })[]).map((p) => ({
    ...p,
    active: !!p.active,
    sessions: byProgram.get(p.id) ?? [],
  }));
}

async function saveCenter(env: Env, body: Record<string, unknown>): Promise<void> {
  const settings = body.settings as Record<string, unknown> | undefined;
  if (typeof settings !== "object" || settings === null) throw new BadRequest("settings is required.");
  const values = SETTINGS_FIELDS.map(([key, , check]) => check(settings[key]));
  const min = values[SETTINGS_FIELDS.findIndex(([k]) => k === "minShiftMinutes")] as number;
  const max = values[SETTINGS_FIELDS.findIndex(([k]) => k === "maxShiftMinutes")] as number;
  if (min > max) throw new BadRequest("The shortest shift can't be longer than the longest.");
  const hours = windows(body.hours, "Opening hours");

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE center_settings SET ${SETTINGS_FIELDS.map(([, column]) => `${column} = ?`).join(", ")}, updated_at = unixepoch() WHERE id = 1`,
    ).bind(...values),
    env.DB.prepare("DELETE FROM operating_hours"),
    ...hours.map((h) =>
      env.DB.prepare("INSERT INTO operating_hours (weekday, open_time, close_time) VALUES (?, ?, ?)").bind(h.weekday, h.start, h.end),
    ),
  ]);
}

function programValues(body: Record<string, unknown>) {
  return {
    name: str(body.name, "Name", 100)!,
    slingLocationId: int(body.slingLocationId, "Sling location", 1, Number.MAX_SAFE_INTEGER, true),
    instructorsNeeded: int(body.instructorsNeeded, "Instructors needed", 1, 20)!,
    travelMinutes: int(body.travelMinutes, "Travel time", 0, 180)!,
    active: bool(body.active ?? true),
    sessions: windows(body.sessions, "Sessions"),
  };
}

async function saveProgram(env: Env, id: number | null, body: Record<string, unknown>): Promise<number> {
  const p = programValues(body);
  let programId = id;
  if (programId === null) {
    const row = await env.DB.prepare(
      `INSERT INTO school_programs (name, sling_location_id, instructors_needed, travel_minutes, active)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(p.name, p.slingLocationId, p.instructorsNeeded, p.travelMinutes, p.active)
      .first<{ id: number }>();
    programId = row!.id;
  } else {
    const exists = await env.DB.prepare("SELECT 1 FROM school_programs WHERE id = ?").bind(programId).first();
    if (!exists) throw new BadRequest("No such program.");
    await env.DB.prepare(
      `UPDATE school_programs SET name = ?, sling_location_id = ?, instructors_needed = ?, travel_minutes = ?,
         active = ?, updated_at = unixepoch() WHERE id = ?`,
    )
      .bind(p.name, p.slingLocationId, p.instructorsNeeded, p.travelMinutes, p.active, programId)
      .run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM program_sessions WHERE program_id = ?").bind(programId),
    ...p.sessions.map((s) =>
      env.DB.prepare("INSERT INTO program_sessions (program_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)").bind(
        programId,
        s.weekday,
        s.start,
        s.end,
      ),
    ),
  ]);
  return programId;
}

async function setupView(env: Env) {
  const [settings, hours, programs] = await Promise.all([loadSettings(env), loadHours(env), loadPrograms(env)]);
  return { settings, hours, programs };
}

/** Handles /api/setup/* routes, or returns null for other paths. */
export async function handleSetup(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/setup")) return null;
  return withAccount(request, env, async (account) => {
    const { method } = request;

    // GET /api/setup — settings, hours and programs.
    if (pathname === "/api/setup" && method === "GET") return json(await setupView(env));

    // PUT /api/setup/center — { settings, hours: [{ weekday, start, end }] }
    if (pathname === "/api/setup/center" && method === "PUT") {
      await saveCenter(env, await readBody(request));
      return json(await setupView(env));
    }

    // GET /api/setup/sling-groups — Sling's locations and positions, for mapping.
    if (pathname === "/api/setup/sling-groups" && method === "GET") {
      const { groups } = await fetchUsersAndGroups(env, account.id);
      const pick = (type: string) =>
        groups.filter((g) => g.type === type && !g.archived).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      return json({ locations: pick("location"), positions: pick("position") });
    }

    // POST /api/setup/programs, PUT|DELETE /api/setup/programs/:id
    if (pathname === "/api/setup/programs" && method === "POST") {
      await saveProgram(env, null, await readBody(request));
      return json(await setupView(env), 201);
    }
    const programId = pathname.match(/^\/api\/setup\/programs\/(\d+)$/)?.[1];
    if (programId && method === "PUT") {
      await saveProgram(env, Number(programId), await readBody(request));
      return json(await setupView(env));
    }
    if (programId && method === "DELETE") {
      await env.DB.prepare("DELETE FROM school_programs WHERE id = ?").bind(Number(programId)).run();
      return json(await setupView(env));
    }

    return json({ error: "Not found" }, 404);
  });
}
