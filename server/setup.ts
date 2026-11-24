// /api/setup/*: center setup (feature 1). Settings, opening hours and school
// programs, stored in DynamoDB, plus the Sling locations and positions to map them to.

import type { Env } from "./env";
import { deleteItem, getItem, isConditionFailure, keys, nextId, nowSeconds, putItem, queryAll } from "./db";
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

// Used until the director saves the settings.
export const DEFAULT_SETTINGS: CenterSettings = {
  radiusCenterId: 3600,
  timezone: "America/Los_Angeles",
  // Presence rules: people at the center whenever it's open (on a break
  // counts, remote doesn't), and how many of them must be supervisors.
  minStaffOnSite: 2,
  minSupervisorsOnSite: 1,
  minShiftMinutes: 120,
  maxShiftMinutes: 480,
  maxShiftsPerDay: 1,
  setupMinutes: 0, // before the first appointment
  cleanupMinutes: 0, // after the last one
  // A paid break of breakMinutes for shifts of breakAfterMinutes or more.
  breakAfterMinutes: 240,
  breakMinutes: 10,
  homeTravelMinutes: 0, // between home and the center on the same day
  // Employees get the schedule this many days ahead; the draft is generated on generateWeekday.
  publishLeadDays: 3,
  generateWeekday: 3,
  slingCenterLocationId: null,
  slingRemoteLocationId: null,
};

// Each field, with how it's checked on save.
const SETTINGS_FIELDS: [keyof CenterSettings, (v: unknown) => number | string | null][] = [
  ["radiusCenterId", (v) => int(v, "Radius center ID", 1, 10_000_000)],
  ["timezone", (v) => timeZone(v)],
  ["minStaffOnSite", (v) => int(v, "People on site", 0, 20)],
  ["minSupervisorsOnSite", (v) => int(v, "Supervisors on site", 0, 20)],
  ["minShiftMinutes", (v) => int(v, "Shortest shift", 15, 720)],
  ["maxShiftMinutes", (v) => int(v, "Longest shift", 15, 960)],
  ["maxShiftsPerDay", (v) => int(v, "Shifts per day", 1, 4)],
  ["setupMinutes", (v) => int(v, "Setup time", 0, 120)],
  ["cleanupMinutes", (v) => int(v, "Cleanup time", 0, 120)],
  ["breakAfterMinutes", (v) => int(v, "Break after", 0, 960)],
  ["breakMinutes", (v) => int(v, "Break length", 0, 60)],
  ["homeTravelMinutes", (v) => int(v, "Home travel time", 0, 120)],
  ["publishLeadDays", (v) => int(v, "Days ahead", 0, 28)],
  ["generateWeekday", (v) => int(v, "Generate on", 0, 6)],
  ["slingCenterLocationId", (v) => int(v, "Center location", 1, Number.MAX_SAFE_INTEGER, true)],
  ["slingRemoteLocationId", (v) => int(v, "Remote location", 1, Number.MAX_SAFE_INTEGER, true)],
];

/** The settings item (keys.settings): settings and opening hours. A weekday without hours is closed. */
interface SettingsItem {
  settings: Partial<CenterSettings>;
  hours: OpeningHours[];
  updatedAt: number;
}

/** A school program as stored (keys.program). */
type ProgramItem = Omit<SchoolProgram, "active"> & { active: boolean; createdAt: number; updatedAt: number };

function timeZone(value: unknown): string {
  const zone = str(value, "Time zone", 64)!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new BadRequest("Time zone must be an IANA name such as America/Los_Angeles.");
  }
  return zone;
}

const loadSettingsItem = () => getItem<SettingsItem>(keys.settings());

export async function loadSettings(_env: Env): Promise<CenterSettings> {
  return { ...DEFAULT_SETTINGS, ...(await loadSettingsItem())?.settings };
}

export async function loadHours(_env: Env): Promise<OpeningHours[]> {
  const hours = (await loadSettingsItem())?.hours ?? [];
  return [...hours].sort((a, b) => a.weekday - b.weekday || a.open.localeCompare(b.open));
}

const bySession = (a: { weekday: number; start: string }, b: { weekday: number; start: string }) =>
  a.weekday - b.weekday || a.start.localeCompare(b.start);

export async function loadPrograms(_env: Env): Promise<SchoolProgram[]> {
  const items = await queryAll<ProgramItem>("CENTER", "PROGRAM#");
  return items
    .map((p) => ({
      id: p.id,
      name: p.name,
      slingLocationId: p.slingLocationId ?? null,
      instructorsNeeded: p.instructorsNeeded,
      travelMinutes: p.travelMinutes,
      active: !!p.active,
      sessions: [...(p.sessions ?? [])].sort(bySession),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function saveCenter(body: Record<string, unknown>): Promise<void> {
  const input = body.settings as Record<string, unknown> | undefined;
  if (typeof input !== "object" || input === null) throw new BadRequest("settings is required.");
  const settings = Object.fromEntries(SETTINGS_FIELDS.map(([key, check]) => [key, check(input[key])])) as unknown as CenterSettings;
  if (settings.minShiftMinutes > settings.maxShiftMinutes) throw new BadRequest("The shortest shift can't be longer than the longest.");
  const hours = windows(body.hours, "Opening hours").map((h) => ({ weekday: h.weekday, open: h.start, close: h.end }));
  await putItem({ ...keys.settings(), settings, hours, updatedAt: nowSeconds() } satisfies SettingsItem & { pk: string; sk: string });
}

function programValues(body: Record<string, unknown>) {
  return {
    name: str(body.name, "Name", 100)!,
    slingLocationId: int(body.slingLocationId, "Sling location", 1, Number.MAX_SAFE_INTEGER, true),
    instructorsNeeded: int(body.instructorsNeeded, "Instructors needed", 1, 20)!,
    travelMinutes: int(body.travelMinutes, "Travel time", 0, 180)!,
    active: !!bool(body.active ?? true),
    sessions: windows(body.sessions, "Sessions"),
  };
}

async function saveProgram(id: number | null, body: Record<string, unknown>): Promise<number> {
  const p = programValues(body);
  const now = nowSeconds();
  if (id === null) {
    const newId = await nextId("program");
    await putItem({ ...keys.program(newId), id: newId, ...p, createdAt: now, updatedAt: now } satisfies ProgramItem & { pk: string; sk: string });
    return newId;
  }
  const existing = await getItem<ProgramItem>(keys.program(id));
  if (!existing) throw new BadRequest("No such program.");
  try {
    await putItem(
      { ...keys.program(id), id, ...p, createdAt: existing.createdAt, updatedAt: now } satisfies ProgramItem & { pk: string; sk: string },
      { expression: "attribute_exists(pk)" },
    );
  } catch (err) {
    if (isConditionFailure(err)) throw new BadRequest("No such program.");
    throw err;
  }
  return id;
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
      await saveCenter(await readBody(request));
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
      await saveProgram(null, await readBody(request));
      return json(await setupView(env), 201);
    }
    const programId = pathname.match(/^\/api\/setup\/programs\/(\d+)$/)?.[1];
    if (programId && method === "PUT") {
      await saveProgram(Number(programId), await readBody(request));
      return json(await setupView(env));
    }
    // People's first-choice programs drop a deleted one when they're read (loadRoster).
    if (programId && method === "DELETE") {
      await deleteItem(keys.program(Number(programId)));
      return json(await setupView(env));
    }

    return json({ error: "Not found" }, 404);
  });
}
