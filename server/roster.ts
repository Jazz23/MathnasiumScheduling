// /api/roster/*: the employee roster (feature 2) and availability and
// preferences (feature 3). People come from Sling; the details are the
// director's, stored in DynamoDB.

import type { Env } from "./env";
import { batchWrite, getItem, isConditionFailure, keys, nowSeconds, queryAll, updateItem } from "./db";
import { BadRequest, int, intList, json, num, readBody, str, windows, withAccount, type Window } from "./http";
import { loadPrograms, loadSettings } from "./setup";
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

/**
 * A person on the roster as stored (keys.employee): everything in Employee,
 * plus their Sling positions. Program IDs may include deleted programs,
 * which loadRoster drops.
 */
type EmployeeItem = Employee & { slingPositionIds: number[]; createdAt: number; updatedAt: number };

const byWindow = (a: Window, b: Window) => a.weekday - b.weekday || a.start.localeCompare(b.start);

export async function loadRoster(env: Env): Promise<Employee[]> {
  const [items, programs] = await Promise.all([queryAll<EmployeeItem>("CENTER", "EMPLOYEE#"), loadPrograms(env)]);
  const programIds = new Set(programs.map((p) => p.id));
  return items
    .map(
      (r): Employee => ({
        slingUserId: r.slingUserId,
        name: r.name,
        email: r.email ?? null,
        active: !!r.active,
        role: r.role,
        maxGrade: r.maxGrade ?? null,
        testPrep: !!r.testPrep,
        assessments: !!r.assessments,
        teachingLimitPct: r.teachingLimitPct ?? null,
        canWorkRemote: !!r.canWorkRemote,
        priority: r.priority ?? 0,
        minHours: r.minHours ?? null,
        preferredHours: r.preferredHours ?? null,
        maxHours: r.maxHours ?? null,
        minShiftMinutes: r.minShiftMinutes ?? null,
        wfhWeekdays: r.wfhWeekdays ?? [],
        schedulable: !!r.schedulable,
        notes: r.notes ?? null,
        programIds: (r.programIds ?? []).filter((id) => programIds.has(id)),
        availability: [...(r.availability ?? [])]
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
          .map((p) => ({ effectiveFrom: p.effectiveFrom, windows: [...p.windows].sort(byWindow) })),
        preferences: [...(r.preferences ?? [])].sort(byWindow),
      }),
    )
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

const getEmployee = (id: number) => getItem<EmployeeItem>(keys.employee(id));

/** Sets fields on an existing person; BadRequest if there's no such person. */
async function updateEmployee(id: number, values: Partial<EmployeeItem>): Promise<void> {
  try {
    await updateItem(keys.employee(id), { ...values, updatedAt: nowSeconds() }, { mustExist: true });
  } catch (err) {
    if (isConditionFailure(err)) throw new BadRequest("No such employee.");
    throw err;
  }
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
  const known = new Map((await queryAll<EmployeeItem>("CENTER", "EMPLOYEE#")).map((e) => [e.slingUserId, e]));

  let added = 0;
  let updated = 0;
  const now = nowSeconds();
  const puts: EmployeeItem[] = [];
  for (const user of users) {
    const slingPositionIds = user.groupIds.filter((id) => positionName.has(id));
    const existing = known.get(user.id);
    if (existing) {
      updated++;
      puts.push({ ...existing, name: user.name, email: user.email, active: user.active, slingPositionIds, updatedAt: now });
    } else if (user.active) {
      added++;
      puts.push({
        slingUserId: user.id,
        name: user.name,
        email: user.email,
        active: true,
        slingPositionIds,
        role: guessRole(slingPositionIds.map((id) => positionName.get(id)!)),
        maxGrade: null,
        testPrep: false,
        assessments: false,
        teachingLimitPct: null,
        canWorkRemote: true,
        priority: 0,
        minHours: null,
        preferredHours: null,
        maxHours: null,
        minShiftMinutes: null,
        wfhWeekdays: [],
        schedulable: true,
        notes: null,
        programIds: [],
        availability: [],
        preferences: [],
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  // Whole items are written back, so an edit made in the moment between
  // reading and writing would be lost. With one director that's acceptable.
  await batchWrite(puts.map((e) => ({ put: { ...keys.employee(e.slingUserId), ...e } })));
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
  const programs = new Set((await loadPrograms(env)).map((p) => p.id));
  const programIds = intList(body.programIds ?? [], "Programs", 1, Number.MAX_SAFE_INTEGER).filter((p) => programs.has(p));
  await updateEmployee(id, {
    role: role as Role,
    maxGrade: int(body.maxGrade, "Highest grade", -1, 12, true),
    testPrep: !!body.testPrep,
    assessments: !!body.assessments,
    teachingLimitPct: int(body.teachingLimitPct, "Teaching limit", 0, 100, true),
    canWorkRemote: !!body.canWorkRemote,
    priority: int(body.priority ?? 0, "Priority", -100, 100)!,
    minHours,
    preferredHours,
    maxHours,
    minShiftMinutes: int(body.minShiftMinutes, "Shortest shift", 15, 720, true),
    wfhWeekdays: intList(body.wfhWeekdays ?? [], "Work-from-home days", 0, 6).sort(),
    schedulable: !!body.schedulable,
    notes: str(body.notes, "Notes", 2000, true),
    programIds,
  });
}

/** Replaces one availability pattern: { effectiveFrom, windows }. An empty list removes the pattern. */
async function saveAvailability(id: number, body: Record<string, unknown>): Promise<void> {
  if (!isDate(body.effectiveFrom)) throw new BadRequest("Starting date must be YYYY-MM-DD.");
  const effectiveFrom = body.effectiveFrom;
  const list = windows(body.windows, "Availability");
  const employee = await getEmployee(id);
  if (!employee) throw new BadRequest("No such employee.");
  const availability = (employee.availability ?? []).filter((p) => p.effectiveFrom !== effectiveFrom);
  if (list.length > 0) availability.push({ effectiveFrom, windows: list });
  await updateEmployee(id, { availability });
}

async function savePreferences(id: number, body: Record<string, unknown>): Promise<void> {
  if (!Array.isArray(body.preferences)) throw new BadRequest("preferences must be a list.");
  const preferences = windows(body.preferences, "Preferences").map((w, i) => {
    const kind = (body.preferences as { kind?: unknown }[])[i]?.kind;
    if (kind !== "prefer" && kind !== "avoid") throw new BadRequest("Each preference is prefer or avoid.");
    return { ...w, kind } as Window & { kind: "prefer" | "avoid" };
  });
  await updateEmployee(id, { preferences });
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
      else if (m[2] === "/availability") await saveAvailability(id, body);
      else await savePreferences(id, body);
      return json({ employees: await loadRoster(env) });
    }

    return json({ error: "Not found" }, 404);
  });
}
