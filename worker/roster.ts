// /api/roster/*: the employee roster (feature 2) and availability and
// preferences (feature 3). People come from Sling; the details are the
// director's, stored in D1.

import type { Env } from "./env";
import { BadRequest, bool, int, intList, json, num, readBody, str, windows, withAccount, type Window } from "./http";
import { loadSettings } from "./setup";
import { fetchCalendar, fetchUsersAndGroups } from "./slingData";
import { addDays, fromMinutes, isDate, toMinutes, today, weekday } from "./time";

export const ROLES = ["owner", "assistant_director", "instructor", "front_desk"] as const;
export type Role = (typeof ROLES)[number];
/** Roles that count as a supervisor for the presence rules. */
export const SUPERVISOR_ROLES: ReadonlySet<string> = new Set(["owner", "assistant_director"]);

export interface AvailabilityPattern {
  effectiveFrom: string;
  windows: Window[];
}

export interface Employee {
  slingUserId: number;
  name: string;
  email: string | null;
  active: boolean;
  role: Role;
  maxGrade: number | null;
  testPrep: boolean;
  assessments: boolean;
  teachingLimitPct: number | null;
  canWorkRemote: boolean;
  priority: number;
  minHours: number | null;
  preferredHours: number | null;
  maxHours: number | null;
  minShiftMinutes: number | null;
  wfhWeekdays: number[];
  schedulable: boolean;
  notes: string | null;
  programIds: number[];
  /** Every availability pattern, oldest first. */
  availability: AvailabilityPattern[];
  preferences: (Window & { kind: "prefer" | "avoid" })[];
}

interface EmployeeRow {
  sling_user_id: number;
  name: string;
  email: string | null;
  active: number;
  role: Role;
  max_grade: number | null;
  test_prep: number;
  assessments: number;
  teaching_limit_pct: number | null;
  can_work_remote: number;
  priority: number;
  min_hours: number | null;
  preferred_hours: number | null;
  max_hours: number | null;
  min_shift_minutes: number | null;
  wfh_weekdays: string;
  schedulable: number;
  notes: string | null;
}

export async function loadRoster(env: Env): Promise<Employee[]> {
  const [employees, programs, availability, preferences] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM employees ORDER BY active DESC, name"),
    env.DB.prepare("SELECT sling_user_id, program_id FROM employee_programs"),
    env.DB.prepare(
      "SELECT sling_user_id, effective_from, weekday, start_time, end_time FROM availability ORDER BY effective_from, weekday, start_time",
    ),
    env.DB.prepare("SELECT sling_user_id, kind, weekday, start_time, end_time FROM employee_preferences ORDER BY weekday, start_time"),
  ]);

  const programsBy = new Map<number, number[]>();
  for (const r of programs!.results as { sling_user_id: number; program_id: number }[]) {
    programsBy.set(r.sling_user_id, [...(programsBy.get(r.sling_user_id) ?? []), r.program_id]);
  }
  const availabilityBy = new Map<number, AvailabilityPattern[]>();
  for (const r of availability!.results as { sling_user_id: number; effective_from: string; weekday: number; start_time: string; end_time: string }[]) {
    const patterns = availabilityBy.get(r.sling_user_id) ?? [];
    let pattern = patterns.find((p) => p.effectiveFrom === r.effective_from);
    if (!pattern) patterns.push((pattern = { effectiveFrom: r.effective_from, windows: [] }));
    pattern.windows.push({ weekday: r.weekday, start: r.start_time, end: r.end_time });
    availabilityBy.set(r.sling_user_id, patterns);
  }
  const preferencesBy = new Map<number, Employee["preferences"]>();
  for (const r of preferences!.results as { sling_user_id: number; kind: "prefer" | "avoid"; weekday: number; start_time: string; end_time: string }[]) {
    preferencesBy.set(r.sling_user_id, [
      ...(preferencesBy.get(r.sling_user_id) ?? []),
      { kind: r.kind, weekday: r.weekday, start: r.start_time, end: r.end_time },
    ]);
  }

  return (employees!.results as unknown as EmployeeRow[]).map((r) => ({
    slingUserId: r.sling_user_id,
    name: r.name,
    email: r.email,
    active: !!r.active,
    role: r.role,
    maxGrade: r.max_grade,
    testPrep: !!r.test_prep,
    assessments: !!r.assessments,
    teachingLimitPct: r.teaching_limit_pct,
    canWorkRemote: !!r.can_work_remote,
    priority: r.priority,
    minHours: r.min_hours,
    preferredHours: r.preferred_hours,
    maxHours: r.max_hours,
    minShiftMinutes: r.min_shift_minutes,
    wfhWeekdays: JSON.parse(r.wfh_weekdays) as number[],
    schedulable: !!r.schedulable,
    notes: r.notes,
    programIds: programsBy.get(r.sling_user_id) ?? [],
    availability: availabilityBy.get(r.sling_user_id) ?? [],
    preferences: preferencesBy.get(r.sling_user_id) ?? [],
  }));
}

/** The availability pattern in force on `date`: the latest one starting on or before it. */
export function availabilityOn(employee: Employee, date: string): AvailabilityPattern | undefined {
  return employee.availability.filter((p) => p.effectiveFrom <= date).at(-1);
}

// A first guess at a new employee's role from their Sling positions.
function guessRole(positionNames: string[]): Role {
  const names = positionNames.map((n) => n.toLowerCase());
  if (names.some((n) => n === "owner")) return "owner";
  if (names.some((n) => n.includes("director"))) return "assistant_director";
  if (names.some((n) => n.includes("front desk"))) return "front_desk";
  return "instructor";
}

/**
 * Imports people from Sling: adds active Sling users who aren't on the roster
 * yet (role guessed from their positions), and updates everyone's name, email,
 * positions and active flag. The director's details are kept.
 */
async function syncFromSling(env: Env, accountId: number): Promise<{ added: number; updated: number }> {
  const { users, groups } = await fetchUsersAndGroups(env, accountId);
  const positionName = new Map(groups.filter((g) => g.type === "position").map((g) => [g.id, g.name]));
  const { results } = await env.DB.prepare("SELECT sling_user_id FROM employees").all<{ sling_user_id: number }>();
  const known = new Set(results.map((r) => r.sling_user_id));

  let added = 0;
  let updated = 0;
  const statements: D1PreparedStatement[] = [];
  for (const user of users) {
    const positionIds = user.groupIds.filter((id) => positionName.has(id));
    if (known.has(user.id)) {
      updated++;
      statements.push(
        env.DB.prepare(
          `UPDATE employees SET name = ?, email = ?, active = ?, sling_position_ids = ?, updated_at = unixepoch()
           WHERE sling_user_id = ?`,
        ).bind(user.name, user.email, bool(user.active), JSON.stringify(positionIds), user.id),
      );
    } else if (user.active) {
      added++;
      const role = guessRole(positionIds.map((id) => positionName.get(id)!));
      statements.push(
        env.DB.prepare(
          `INSERT INTO employees (sling_user_id, name, email, active, sling_position_ids, role) VALUES (?, ?, ?, 1, ?, ?)`,
        ).bind(user.id, user.name, user.email, JSON.stringify(positionIds), role),
      );
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return { added, updated };
}

async function saveDetails(env: Env, id: number, body: Record<string, unknown>): Promise<void> {
  const role = body.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new BadRequest("Unknown role.");
  const minHours = num(body.minHours, "Minimum hours", 0, 80, true);
  const preferredHours = num(body.preferredHours, "Preferred hours", 0, 80, true);
  const maxHours = num(body.maxHours, "Maximum hours", 0, 80, true);
  if (minHours !== null && maxHours !== null && minHours > maxHours) {
    throw new BadRequest("Minimum hours can't be more than maximum hours.");
  }
  const programIds = intList(body.programIds ?? [], "Programs", 1, Number.MAX_SAFE_INTEGER);
  const values = [
    role,
    int(body.maxGrade, "Highest grade", -1, 12, true),
    bool(body.testPrep),
    bool(body.assessments),
    int(body.teachingLimitPct, "Teaching limit", 0, 100, true),
    bool(body.canWorkRemote),
    int(body.priority ?? 0, "Priority", -100, 100),
    minHours,
    preferredHours,
    maxHours,
    int(body.minShiftMinutes, "Shortest shift", 15, 720, true),
    JSON.stringify(intList(body.wfhWeekdays ?? [], "Work-from-home days", 0, 6).sort()),
    bool(body.schedulable),
    str(body.notes, "Notes", 2000, true),
  ];
  const exists = await env.DB.prepare("SELECT 1 FROM employees WHERE sling_user_id = ?").bind(id).first();
  if (!exists) throw new BadRequest("No such employee.");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE employees SET role = ?, max_grade = ?, test_prep = ?, assessments = ?, teaching_limit_pct = ?,
         can_work_remote = ?, priority = ?, min_hours = ?, preferred_hours = ?, max_hours = ?, min_shift_minutes = ?,
         wfh_weekdays = ?, schedulable = ?, notes = ?, updated_at = unixepoch()
       WHERE sling_user_id = ?`,
    ).bind(...values, id),
    env.DB.prepare("DELETE FROM employee_programs WHERE sling_user_id = ?").bind(id),
    ...programIds.map((p) =>
      env.DB.prepare(
        "INSERT INTO employee_programs (sling_user_id, program_id) SELECT ?, id FROM school_programs WHERE id = ?",
      ).bind(id, p),
    ),
  ]);
}

/** Replaces one availability pattern: { effectiveFrom, windows }. An empty list removes the pattern. */
async function saveAvailability(env: Env, id: number, body: Record<string, unknown>): Promise<void> {
  if (!isDate(body.effectiveFrom)) throw new BadRequest("Starting date must be YYYY-MM-DD.");
  const effectiveFrom = body.effectiveFrom;
  const list = windows(body.windows, "Availability");
  const exists = await env.DB.prepare("SELECT 1 FROM employees WHERE sling_user_id = ?").bind(id).first();
  if (!exists) throw new BadRequest("No such employee.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM availability WHERE sling_user_id = ? AND effective_from = ?").bind(id, effectiveFrom),
    ...list.map((w) =>
      env.DB.prepare(
        "INSERT INTO availability (sling_user_id, effective_from, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, effectiveFrom, w.weekday, w.start, w.end),
    ),
  ]);
}

async function savePreferences(env: Env, id: number, body: Record<string, unknown>): Promise<void> {
  if (!Array.isArray(body.preferences)) throw new BadRequest("preferences must be a list.");
  const list = windows(body.preferences, "Preferences").map((w, i) => {
    const kind = (body.preferences as { kind?: unknown }[])[i]?.kind;
    if (kind !== "prefer" && kind !== "avoid") throw new BadRequest("Each preference is prefer or avoid.");
    return { ...w, kind };
  });
  const exists = await env.DB.prepare("SELECT 1 FROM employees WHERE sling_user_id = ?").bind(id).first();
  if (!exists) throw new BadRequest("No such employee.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM employee_preferences WHERE sling_user_id = ?").bind(id),
    ...list.map((p) =>
      env.DB.prepare(
        "INSERT INTO employee_preferences (sling_user_id, kind, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, p.kind, p.weekday, p.start, p.end),
    ),
  ]);
}

export interface AvailabilitySuggestion {
  slingUserId: number;
  weeks: number;
  windows: (Window & { timesWorked: number })[];
}

/**
 * Suggests each person's weekly availability from the shifts they worked in
 * Sling over the last `weeks` weeks (any location): for each weekday, the
 * times they worked, merged where they overlap or touch.
 */
async function suggestAvailability(env: Env, accountId: number, weeks: number): Promise<AvailabilitySuggestion[]> {
  const { timezone } = await loadSettings(env);
  const end = today(timezone);
  const start = addDays(end, -7 * weeks);
  // Four weeks per request: a range that size is known to work.
  const shifts = [];
  for (let from = start; from < end; from = addDays(from, 28)) {
    const to = addDays(from, 28) < end ? addDays(from, 28) : end;
    shifts.push(...(await fetchCalendar(env, accountId, { start: from, end: to }, timezone)).shifts);
  }

  const byUserDay = new Map<string, { start: number; end: number }[]>();
  for (const s of shifts) {
    if (s.userId === null || s.endDate !== s.date) continue;
    const key = `${s.userId}:${weekday(s.date)}`;
    byUserDay.set(key, [...(byUserDay.get(key) ?? []), { start: toMinutes(s.start), end: toMinutes(s.end) }]);
  }

  const out = new Map<number, AvailabilitySuggestion>();
  for (const [key, intervals] of byUserDay) {
    const [userId, day] = key.split(":").map(Number) as [number, number];
    intervals.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number; count: number }[] = [];
    for (const i of intervals) {
      const last = merged.at(-1);
      if (last && i.start <= last.end) {
        last.end = Math.max(last.end, i.end);
        last.count++;
      } else merged.push({ ...i, count: 1 });
    }
    const suggestion = out.get(userId) ?? { slingUserId: userId, weeks, windows: [] };
    for (const m of merged) {
      suggestion.windows.push({ weekday: day, start: fromMinutes(m.start), end: fromMinutes(m.end), timesWorked: m.count });
    }
    out.set(userId, suggestion);
  }
  for (const s of out.values()) s.windows.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  return [...out.values()];
}

/** Handles /api/roster/* routes, or returns null for other paths. */
export async function handleRoster(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname !== "/api/roster" && !pathname.startsWith("/api/roster/")) return null;
  return withAccount(request, env, async (account) => {
    const { method } = request;
    if (pathname === "/api/roster" && method === "GET") return json({ employees: await loadRoster(env) });

    // POST /api/roster/sync — import and update people from Sling.
    if (pathname === "/api/roster/sync" && method === "POST") {
      const result = await syncFromSling(env, account.id);
      return json({ ...result, employees: await loadRoster(env) });
    }

    // GET /api/roster/availability-suggestions?weeks=8
    if (pathname === "/api/roster/availability-suggestions" && method === "GET") {
      const weeks = int(new URL(request.url).searchParams.get("weeks") ?? 8, "weeks", 1, 26)!;
      return json({ suggestions: await suggestAvailability(env, account.id, weeks) });
    }

    const m = pathname.match(/^\/api\/roster\/(\d+)(\/availability|\/preferences)?$/);
    if (m && method === "PUT") {
      const id = Number(m[1]);
      const body = await readBody(request);
      if (!m[2]) await saveDetails(env, id, body);
      else if (m[2] === "/availability") await saveAvailability(env, id, body);
      else await savePreferences(env, id, body);
      return json({ employees: await loadRoster(env) });
    }

    return json({ error: "Not found" }, 404);
  });
}
