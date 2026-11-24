// The scheduler (feature 6): builds a week's draft as an integer program,
// solves it with HiGHS, and reads the result back into shifts and a coverage
// report. Pure apart from the solver: the inputs are loaded by
// server/draftApi.ts.
//
// The model works in blocks of BLOCK minutes. For each employee and day:
//   on_b   1 if working at the center in block b
//   st_b   1 if a center shift starts at b (makes on_b contiguous runs)
//   rm_b   1 if on a remote shift in block b (only where there are online students)
//   rs_b   1 if a remote shift starts at b
//   p_s    1 if working school program session s (session plus the drive each way)
// and continuous teaching variables: tc (in-center students) and to (online
// students), in instructors, per level. Coverage, presence, program staffing
// and hours have slack variables with penalties, so the model always has a
// solution and the slack shows what couldn't be met.
//
// Fixed shifts: existing Sling shifts, and the draft shifts to keep (locked
// ones when generating again, every one when checking an edited draft). The
// person is busy then, and a fixed shift counts toward presence, teaching and
// program staffing like a drafted one. With `draftNew` false nothing new is
// drafted: the model then only works out teaching and the coverage report,
// which is how a hand-edited draft is checked.

import type { DemandDay } from "./demand";
import type { Level } from "./radiusData";
import type { Employee } from "./roster";
import { availabilityOn, SUPERVISOR_ROLES } from "./roster";
import type { CenterSettings, OpeningHours, SchoolProgram } from "./setup";
import type { SlingShift, SlingTimeOff } from "./slingData";
import { addDays, fromMinutes, toMinutes, weekday } from "./time";

export const BLOCK = 15;
const DAY = 24 * 60;

// Objective weights. Labor is 1 per block (4 per hour), so anything weighted
// above 4 per hour is worth paying for with extra time on the schedule.
const W = {
  labor: 1, // per block at the center
  remoteLabor: 1.2, // per block on a remote shift
  shiftStart: 3, // per shift: prefer fewer, longer shifts
  wfhAtCenter: 6, // per block at the center on a work-from-home day
  avoid: 4, // per block worked in an "avoid" window
  prefer: -0.5, // per block worked in a "prefer" window
  shortInstructor: 1000, // per instructor per block of students not covered
  noStaff: 5000, // per person per block below the people-on-site rule
  noSupervisor: 5000, // per supervisor per block below the supervisor rule
  programShort: 3000, // per person missing from a program session
  notAssigned: 150, // per program session worked by someone not assigned to it
  underPreferred: 3, // per hour under preferred hours: a tie-breaker, not worth idle time
  overPreferred: 6, // per hour over preferred hours
  belowMinimum: 60, // per hour under minimum hours: worth adding time for
  teachingOverLimit: 30, // per block of teaching over a person's teaching limit
} as const;

export interface SchedulerInput {
  /** The week's dates, Monday first. */
  dates: string[];
  settings: CenterSettings;
  hours: OpeningHours[];
  programs: SchoolProgram[];
  employees: Employee[];
  levels: Level[];
  /** Booked demand per BLOCK over the whole day (00:00–24:00), for each date. */
  demand: DemandDay[];
  /** Existing Sling shifts in the week, kept as they are. */
  fixedShifts: SlingShift[];
  timeOff: SlingTimeOff[];
  /** Draft shifts to keep as they are (they stay in the draft). */
  keep: DraftShift[];
  /** Whether to draft new shifts around the fixed ones, or only check them. */
  draftNew: boolean;
}

export interface DraftShift {
  id: string;
  /** Kept when the draft is generated again. */
  locked: boolean;
  slingUserId: number;
  name: string;
  date: string;
  start: string;
  end: string; // may be "24:00"
  where: "center" | "remote" | "program";
  programId: number | null;
  /** Sling location to publish to; null if it isn't mapped yet. */
  slingLocationId: number | null;
  teachingMinutes: number;
  breakStart: string | null;
  /** True when the shift is long enough for a break but none fit without leaving students uncovered. */
  breakMissed: boolean;
  /** Rules this shift breaks (from hand edits, or kept from an earlier draft). */
  issues: string[];
}

export interface CoverageBlock {
  time: string;
  open: boolean;
  /** Instructors needed for in-center and online students, at Radius' ratios. */
  neededInCenter: number;
  neededOnline: number;
  /** Instructors not found for them. */
  shortInCenter: number;
  shortOnline: number;
  /** People at the center (drafted and existing shifts), and how many are supervisors. */
  onSite: number;
  supervisors: number;
  remote: number;
  /** Why the block is short, when it is. */
  gaps: string[];
}

export interface CoverageDay {
  date: string;
  blocks: CoverageBlock[];
}

export interface EmployeeSummary {
  slingUserId: number;
  name: string;
  draftedHours: number;
  existingHours: number;
  minHours: number | null;
  preferredHours: number | null;
  maxHours: number | null;
  notes: string[];
}

export interface ProgramStaffing {
  programId: number;
  name: string;
  date: string;
  start: string;
  end: string;
  needed: number;
  existing: number;
  drafted: string[];
  short: number;
}

export interface Draft {
  weekStart: string;
  /** When Radius and Sling were read for this draft. */
  generatedAt: number;
  /** When the draft last changed (generated or edited). */
  updatedAt: number;
  /** HiGHS' model status: Optimal, or Time limit reached with the best found. */
  status: string;
  solveSeconds: number;
  shifts: DraftShift[];
  coverage: CoverageDay[];
  employees: EmployeeSummary[];
  programs: ProgramStaffing[];
  warnings: string[];
  /** For editing: who can be given shifts, and the school programs. */
  choices: { people: { slingUserId: number; name: string }[]; programs: { id: number; name: string }[] };
}

/** The part of HiGHS' API the scheduler uses. */
export interface Solver {
  solve(
    lp: string,
    options: Record<string, unknown>,
  ): { Status: string; ObjectiveValue?: number; Columns: Record<string, { Primal: number }> };
}

// --- Small helpers --------------------------------------------------------

type Term = [number, string];

function linear(terms: Term[]): string {
  let out = "";
  for (const [c, v] of terms) {
    if (c === 0) continue;
    const coef = Math.abs(c) === 1 ? "" : `${+Math.abs(c).toFixed(6)} `;
    out += `${out ? (c < 0 ? " - " : " + ") : c < 0 ? "- " : ""}${coef}${v}`;
  }
  return out;
}

const fmt = (n: number) => String(+n.toFixed(6));

interface Interval {
  start: number; // minutes from midnight
  end: number;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** A shift the model can't change: from Sling, or a draft shift being kept. */
interface Fixed extends Interval {
  userId: number;
  date: string;
  kind: "center" | "remote" | "program" | "other";
  programId: number | null;
  /** The draft shift, when it's one; null for a Sling shift. */
  draft: DraftShift | null;
}

/** The part of a shift on `date`, in minutes. Shifts running past midnight end at 24:00. */
function shiftInterval(s: SlingShift): Interval {
  return { start: toMinutes(s.start), end: s.endDate === s.date ? toMinutes(s.end) : DAY };
}

/** Time off on `date` as an interval, or null. */
function timeOffOn(t: SlingTimeOff, date: string): Interval | null {
  let from: string;
  let to: string;
  if (t.fullDay) {
    from = `${t.startDate}T00:00`;
    to = t.endTime === "00:00" && t.endDate > t.startDate ? `${t.endDate}T00:00` : `${addDays(t.endDate, 1)}T00:00`;
  } else {
    from = `${t.startDate}T${t.startTime}`;
    to = `${t.endDate}T${t.endTime}`;
  }
  const dayStart = `${date}T00:00`;
  const dayEnd = `${addDays(date, 1)}T00:00`;
  if (to <= dayStart || from >= dayEnd) return null;
  return {
    start: from <= dayStart ? 0 : toMinutes(from.slice(11)),
    end: to >= dayEnd ? DAY : toMinutes(to.slice(11)),
  };
}

const canTeachAnything = (e: Employee) => e.role !== "front_desk";
const canTeach = (e: Employee, level: Level) => canTeachAnything(e) && (e.maxGrade === null || level.lastGrade <= e.maxGrade);

// --- The model ------------------------------------------------------------

interface DayPlan {
  date: string;
  d: number; // index in the week
  /** Blocks (start minute) when the center is open. */
  open: Set<number>;
  /** Blocks the presence rules apply to: opening hours plus setup before and cleanup after. */
  presence: Set<number>;
  /** Blocks in which center shifts may be drafted: open hours, appointments, setup and cleanup. */
  centerBlocks: number[];
  /** Blocks shown in the coverage report. */
  reportBlocks: number[];
  /** Instructors needed per block start, per level ID. */
  inCenter: Map<number, Map<number, number>>;
  online: Map<number, Map<number, number>>;
}

interface PersonDay {
  /** Blocks free for new work (available, no time off, no existing shift). */
  free: Set<number>;
  /** Blocks available at all (ignoring existing shifts), for gap explanations. */
  available: Set<number>;
  /** Blocks of approved time off. */
  timeOff: Set<number>;
  /** Blocks of an existing shift at the center, and on a remote shift. */
  fixedCenter: Set<number>;
  fixedRemote: Set<number>;
}

interface Session {
  key: string;
  program: SchoolProgram;
  date: string;
  d: number;
  start: number;
  end: number;
  /** The session plus the drive each way. */
  busy: Interval;
  existing: number;
  /** Draft shifts being kept for this session. */
  kept: DraftShift[];
  vars: { e: number; v: string }[];
  short: string;
}

export function solveWeek(input: SchedulerInput, solver: Solver, opts: { timeLimitSeconds: number }): Draft {
  const { settings, levels } = input;
  const warnings: string[] = [];
  const levelById = new Map(levels.map((l) => [l.id, l]));

  const people = input.employees.filter((e) => e.active && e.schedulable);
  const onRoster = new Map(input.employees.map((e) => [e.slingUserId, e]));
  const fixed: Fixed[] = [
    ...input.fixedShifts
      .filter((s) => s.userId !== null && input.dates.includes(s.date))
      .map((s): Fixed => {
        const program = s.locationId === null ? undefined : input.programs.find((p) => p.slingLocationId === s.locationId);
        return {
          ...shiftInterval(s),
          userId: s.userId!,
          date: s.date,
          kind:
            settings.slingCenterLocationId !== null && s.locationId === settings.slingCenterLocationId
              ? "center"
              : settings.slingRemoteLocationId !== null && s.locationId === settings.slingRemoteLocationId
                ? "remote"
                : program
                  ? "program"
                  : "other",
          programId: program?.id ?? null,
          draft: null,
        };
      }),
    ...input.keep
      .filter((s) => input.dates.includes(s.date))
      .map((s): Fixed => ({
        start: toMinutes(s.start),
        end: toMinutes(s.end),
        userId: s.slingUserId,
        date: s.date,
        kind: s.where,
        programId: s.programId,
        draft: s,
      })),
  ];

  if (settings.slingCenterLocationId === null) {
    warnings.push("The center's Sling location isn't set (Center tab), so existing Sling shifts don't count toward coverage.");
  }
  if (input.hours.length === 0) warnings.push("No opening hours are set (Center tab), so the presence rules aren't applied.");

  // Days: open blocks, the blocks shifts may use, and demand per level.
  const setupBlocks = Math.ceil(settings.setupMinutes / BLOCK);
  const cleanupBlocks = Math.ceil(settings.cleanupMinutes / BLOCK);
  const days: DayPlan[] = input.dates.map((date, d) => {
    const open = new Set<number>();
    const presence = new Set<number>();
    for (const h of input.hours.filter((h) => h.weekday === weekday(date))) {
      const from = Math.floor(toMinutes(h.open) / BLOCK) * BLOCK;
      for (let t = from; t < toMinutes(h.close); t += BLOCK) open.add(t);
      for (let t = Math.max(0, from - setupBlocks * BLOCK); t < Math.min(DAY, toMinutes(h.close) + settings.cleanupMinutes); t += BLOCK) presence.add(t);
    }
    const inCenter = new Map<number, Map<number, number>>();
    const online = new Map<number, Map<number, number>>();
    const demandDay = input.demand.find((x) => x.date === date);
    for (const block of demandDay?.blocks ?? []) {
      const t = toMinutes(block.time);
      for (const [id, count] of Object.entries(block.students)) {
        const level = levelById.get(Number(id));
        if (!level) continue;
        if (count.inCenter > 0) {
          const m = inCenter.get(t) ?? new Map<number, number>();
          m.set(level.id, count.inCenter / level.inCenterRatio);
          inCenter.set(t, m);
        }
        if (count.online > 0) {
          const m = online.get(t) ?? new Map<number, number>();
          m.set(level.id, count.online / level.onlineRatio);
          online.set(t, m);
        }
      }
    }
    // Center shifts may run from setup before the first open or busy block to cleanup after the last.
    const busy = [...presence, ...inCenter.keys()];
    const centerBlocks: number[] = [];
    if (busy.length) {
      const first = Math.max(0, Math.min(...busy) - setupBlocks * BLOCK);
      const last = Math.min(DAY - BLOCK, Math.max(...busy) + cleanupBlocks * BLOCK);
      for (let t = first; t <= last; t += BLOCK) centerBlocks.push(t);
    }
    const shown = [...centerBlocks, ...online.keys()];
    for (const f of fixed) {
      if (f.date !== date || f.kind !== "center") continue;
      for (let t = Math.floor(f.start / BLOCK) * BLOCK; t < f.end; t += BLOCK) shown.push(t);
    }
    const reportBlocks: number[] = [];
    if (shown.length) for (let t = Math.min(...shown); t <= Math.max(...shown); t += BLOCK) reportBlocks.push(t);
    return { date, d, open, presence, centerBlocks, reportBlocks, inCenter, online };
  });

  // People's days: availability, time off and existing shifts.
  const approvedTimeOff = input.timeOff.filter((t) => t.approved);
  const pending = input.timeOff.filter((t) => !t.approved && t.userId !== null && onRoster.has(t.userId));
  for (const t of pending) {
    warnings.push(`${onRoster.get(t.userId!)!.name} has time off waiting for approval (${t.startDate}${t.endDate !== t.startDate ? ` to ${t.endDate}` : ""}). It's ignored until approved.`);
  }

  const personDays: PersonDay[][] = people.map((e) => {
    const pattern = availabilityOn(e, input.dates[0]!);
    const laterPatterns = e.availability.filter((p) => p.effectiveFrom > input.dates[0]! && p.effectiveFrom <= input.dates.at(-1)!);
    if (!pattern && laterPatterns.length === 0 && input.draftNew) warnings.push(`${e.name} has no availability entered for this week, so they aren't drafted.`);
    return days.map(({ date }) => {
      const windows = (availabilityOn(e, date)?.windows ?? []).filter((w) => w.weekday === weekday(date));
      const off = approvedTimeOff.filter((t) => t.userId === e.slingUserId).flatMap((t) => timeOffOn(t, date) ?? []);
      const theirs = fixed.filter((f) => f.userId === e.slingUserId && f.date === date);
      const fixedCenter = new Set<number>();
      const fixedRemote = new Set<number>();
      const fixedAny = new Set<number>();
      for (const f of theirs) {
        for (let t = Math.floor(f.start / BLOCK) * BLOCK; t < f.end; t += BLOCK) {
          fixedAny.add(t);
          if (f.kind === "center") fixedCenter.add(t);
          else if (f.kind === "remote") fixedRemote.add(t);
        }
      }
      const available = new Set<number>();
      const free = new Set<number>();
      const timeOff = new Set<number>();
      for (let t = 0; t < DAY; t += BLOCK) if (off.some((o) => overlaps(o, { start: t, end: t + BLOCK }))) timeOff.add(t);
      for (const w of windows) {
        for (let t = Math.ceil(toMinutes(w.start) / BLOCK) * BLOCK; t + BLOCK <= toMinutes(w.end); t += BLOCK) {
          if (timeOff.has(t)) continue;
          available.add(t);
          if (!fixedAny.has(t) && input.draftNew) free.add(t);
        }
      }
      return { free, available, timeOff, fixedCenter, fixedRemote };
    });
  });

  // --- Variables and constraints ---
  const obj: Term[] = [];
  const rows: string[] = [];
  const binaries: string[] = [];
  const row = (terms: Term[], sense: "<=" | ">=" | "=", rhs: number) => {
    const lhs = linear(terms);
    if (lhs) rows.push(` r${rows.length}: ${lhs} ${sense} ${fmt(rhs)}`);
  };
  const bin = (name: string) => {
    binaries.push(name);
    return name;
  };

  const onVar = new Map<string, string>(); // `${e}:${d}:${t}` -> on var
  const rmVar = new Map<string, string>();
  const occupancy = new Map<string, string[]>(); // binaries that occupy a person in a block
  const occupy = (key: string, v: string) => occupancy.set(key, [...(occupancy.get(key) ?? []), v]);
  const hoursTerms: Term[][] = people.map(() => []);
  const tcVars = new Map<string, Term[]>(); // `${d}:${t}:${level}` -> teaching terms (in-center)
  const toVars = new Map<string, Term[]>(); // online
  const teachOf = new Map<string, string[]>(); // `${e}:${d}:${t}` -> that person's teaching vars there
  const teachTerms: Term[][] = people.map(() => []); // for teaching limits
  const centerTime: Term[][] = people.map(() => []);
  const centerTimeFixed: number[] = people.map(() => 0);
  const minBlocks = (e: Employee) => Math.ceil((e.minShiftMinutes ?? settings.minShiftMinutes) / BLOCK);
  const maxBlocks = Math.floor(settings.maxShiftMinutes / BLOCK);
  const homeTravel = Math.ceil(settings.homeTravelMinutes / BLOCK);

  people.forEach((e, i) => {
    const labor = 1 - Math.max(-100, Math.min(100, e.priority)) * 0.002;
    const avoid = e.preferences.filter((p) => p.kind === "avoid");
    const prefer = e.preferences.filter((p) => p.kind === "prefer");
    const preferenceCost = (date: string, t: number) => {
      const wd = weekday(date);
      const inside = (w: { weekday: number; start: string; end: string }) => w.weekday === wd && t >= toMinutes(w.start) && t < toMinutes(w.end);
      return (avoid.some(inside) ? W.avoid : 0) + (prefer.some(inside) ? W.prefer : 0);
    };

    for (const day of days) {
      const pd = personDays[i]![day.d]!;
      const wfh = e.wfhWeekdays.includes(weekday(day.date));
      const starts: string[] = [];

      // Center shift: on_b and st_b.
      const blocks = day.centerBlocks.filter((t) => pd.free.has(t));
      const has = new Set(blocks);
      const min = minBlocks(e);
      const dayOn: string[] = [];
      for (const t of blocks) {
        const b = t / BLOCK;
        const on = bin(`on_${i}_${day.d}_${b}`);
        onVar.set(`${i}:${day.d}:${t}`, on);
        dayOn.push(on);
        occupy(`${i}:${day.d}:${t}`, on);
        hoursTerms[i]!.push([BLOCK / 60, on]);
        centerTime[i]!.push([1, on]);
        obj.push([W.labor * labor + (wfh ? W.wfhAtCenter : 0) + preferenceCost(day.date, t), on]);
        // A start is allowed where a whole minimum-length shift fits.
        let fits = true;
        for (let k = 1; k < min; k++) if (!has.has(t + k * BLOCK)) fits = false;
        const prev = onVar.get(`${i}:${day.d}:${t - BLOCK}`);
        if (fits) {
          const st = bin(`st_${i}_${day.d}_${b}`);
          starts.push(st);
          obj.push([W.shiftStart, st]);
          row([[1, st], [-1, on], ...(prev ? ([[1, prev]] as Term[]) : [])], ">=", 0);
          for (let k = 1; k < min; k++) row([[1, `on_${i}_${day.d}_${b + k}`], [-1, st]], ">=", 0);
        } else {
          // No shift can start here: only continue one.
          row([[1, on], ...(prev ? ([[-1, prev]] as Term[]) : [])], "<=", 0);
        }
      }
      if (dayOn.length) row(dayOn.map((v) => [1, v] as Term), "<=", maxBlocks);

      // Remote shift: only in blocks with online students, never on a work-from-home day.
      if (e.canWorkRemote && !wfh && canTeachAnything(e)) {
        const remoteBlocks = [...day.online.keys()].filter((t) => pd.free.has(t)).sort((a, b) => a - b);
        const rhas = new Set(remoteBlocks);
        const dayRm: string[] = [];
        for (const t of remoteBlocks) {
          const b = t / BLOCK;
          const rm = bin(`rm_${i}_${day.d}_${b}`);
          rmVar.set(`${i}:${day.d}:${t}`, rm);
          dayRm.push(rm);
          occupy(`${i}:${day.d}:${t}`, rm);
          hoursTerms[i]!.push([BLOCK / 60, rm]);
          obj.push([W.remoteLabor * labor + preferenceCost(day.date, t), rm]);
          // Travel between home and the center.
          for (let k = 1; k <= homeTravel; k++) {
            for (const tt of [t - k * BLOCK, t + k * BLOCK]) {
              const on = onVar.get(`${i}:${day.d}:${tt}`);
              if (on) row([[1, rm], [1, on]], "<=", 1);
            }
          }
          const prev = rmVar.get(`${i}:${day.d}:${t - BLOCK}`);
          const rs = bin(`rs_${i}_${day.d}_${b}`);
          starts.push(rs);
          obj.push([W.shiftStart, rs]);
          row([[1, rs], [-1, rm], ...(prev ? ([[1, prev]] as Term[]) : [])], ">=", 0);
          // Remote shifts are as short as the online appointments allow, so the
          // minimum shift length applies only within the blocks that have them.
          for (let k = 1; k < min && rhas.has(t + k * BLOCK); k++) row([[1, `rm_${i}_${day.d}_${b + k}`], [-1, rs]], ">=", 0);
        }
        if (dayRm.length) row(dayRm.map((v) => [1, v] as Term), "<=", maxBlocks);
      }
      if (starts.length) row(starts.map((v) => [1, v] as Term), "<=", settings.maxShiftsPerDay);

      // Teaching, where the person is at the center or on a remote shift.
      for (const t of day.reportBlocks) {
        const key = `${i}:${day.d}:${t}`;
        const on = onVar.get(key);
        const rm = rmVar.get(key);
        const atCenter = !!on || pd.fixedCenter.has(t);
        const remote = !!rm || pd.fixedRemote.has(t);
        if (!atCenter && !remote) continue;
        if (!on && pd.fixedCenter.has(t)) centerTimeFixed[i]! += 1;
        const centerTerms: Term[] = [];
        const allTerms: Term[] = [];
        for (const [levelId] of day.inCenter.get(t) ?? []) {
          if (!atCenter || !canTeach(e, levelById.get(levelId)!)) continue;
          const v = `tc_${i}_${day.d}_${t / BLOCK}_${levelId}`;
          centerTerms.push([1, v]);
          allTerms.push([1, v]);
          tcVars.set(`${day.d}:${t}:${levelId}`, [...(tcVars.get(`${day.d}:${t}:${levelId}`) ?? []), [1, v]]);
        }
        if (!wfh) {
          for (const [levelId] of day.online.get(t) ?? []) {
            if (!canTeach(e, levelById.get(levelId)!)) continue;
            const v = `to_${i}_${day.d}_${t / BLOCK}_${levelId}`;
            allTerms.push([1, v]);
            toVars.set(`${day.d}:${t}:${levelId}`, [...(toVars.get(`${day.d}:${t}:${levelId}`) ?? []), [1, v]]);
          }
        }
        if (!allTerms.length) continue;
        teachOf.set(key, allTerms.map(([, v]) => v));
        teachTerms[i]!.push(...allTerms);
        // In-center students only from the center, and all teaching within the
        // person's time. Blocks of an existing shift have no on/rm variables
        // (they aren't free), so there the limit is a constant.
        const isFixed = pd.fixedCenter.has(t) || pd.fixedRemote.has(t);
        if (centerTerms.length) row([...centerTerms, ...(on ? ([[-1, on]] as Term[]) : [])], "<=", on ? 0 : 1);
        const capVars: Term[] = [];
        if (on) capVars.push([-1, on]);
        if (rm) capVars.push([-1, rm]);
        row([...allTerms, ...capVars], "<=", isFixed ? 1 : 0);
      }
    }
  });

  // School program sessions.
  const sessions: Session[] = [];
  for (const program of input.programs.filter((p) => p.active)) {
    const assigned = new Set(people.filter((e) => e.programIds.includes(program.id)).map((e) => e.slingUserId));
    for (const day of days) {
      for (const s of program.sessions.filter((x) => x.weekday === weekday(day.date))) {
        const start = toMinutes(s.start);
        const end = toMinutes(s.end);
        const busy = { start: Math.max(0, start - program.travelMinutes), end: Math.min(DAY, end + program.travelMinutes) };
        const here = fixed.filter((f) => f.date === day.date && f.kind === "program" && f.programId === program.id && overlaps(f, { start, end }));
        const existing = here.filter((f) => !f.draft).length;
        const kept = here.flatMap((f) => (f.draft ? [f.draft] : []));
        const key = `${program.id}_${day.d}_${start}`;
        const session: Session = { key, program, date: day.date, d: day.d, start, end, busy, existing, kept, vars: [], short: `ps_${key}` };
        people.forEach((e, i) => {
          if (!canTeachAnything(e)) return;
          const pd = personDays[i]![day.d]!;
          for (let t = Math.floor(busy.start / BLOCK) * BLOCK; t < busy.end; t += BLOCK) if (!pd.free.has(t)) return;
          const v = bin(`p_${i}_${key}`);
          session.vars.push({ e: i, v });
          for (let t = Math.floor(busy.start / BLOCK) * BLOCK; t < busy.end; t += BLOCK) occupy(`${i}:${day.d}:${t}`, v);
          hoursTerms[i]!.push([(busy.end - busy.start) / 60, v]);
          if (assigned.size && !assigned.has(e.slingUserId)) obj.push([W.notAssigned, v]);
        });
        const needed = Math.max(0, program.instructorsNeeded - existing - kept.length);
        if (needed > 0) {
          obj.push([W.programShort, session.short]);
          row([...session.vars.map(({ v }) => [1, v] as Term), [1, session.short]], ">=", needed);
        }
        sessions.push(session);
      }
    }
  }

  // One thing at a time for each person.
  for (const vars of occupancy.values()) if (vars.length > 1) row(vars.map((v) => [1, v] as Term), "<=", 1);

  // Coverage and presence, per block.
  const supervisorIdx = new Set(people.flatMap((e, i) => (SUPERVISOR_ROLES.has(e.role) ? [i] : [])));
  const fixedOnSite = (date: string, t: number) => {
    let all = 0;
    let sup = 0;
    for (const f of fixed) {
      if (f.date !== date || f.kind !== "center" || f.start > t || f.end <= t) continue;
      all++;
      const e = onRoster.get(f.userId);
      if (e && SUPERVISOR_ROLES.has(e.role)) sup++;
    }
    return { all, sup };
  };
  for (const day of days) {
    for (const t of day.reportBlocks) {
      for (const [levelId, need] of day.inCenter.get(t) ?? []) {
        const short = `sc_${day.d}_${t / BLOCK}_${levelId}`;
        obj.push([W.shortInstructor, short]);
        row([...(tcVars.get(`${day.d}:${t}:${levelId}`) ?? []), [1, short]], ">=", need);
      }
      for (const [levelId, need] of day.online.get(t) ?? []) {
        const short = `so_${day.d}_${t / BLOCK}_${levelId}`;
        obj.push([W.shortInstructor, short]);
        row([...(toVars.get(`${day.d}:${t}:${levelId}`) ?? []), [1, short]], ">=", need);
      }
      if (!day.presence.has(t)) continue;
      const { all, sup } = fixedOnSite(day.date, t);
      const ons = people.flatMap((_, i) => onVar.get(`${i}:${day.d}:${t}`) ?? []);
      if (settings.minStaffOnSite > all) {
        const slack = `ns_${day.d}_${t / BLOCK}`;
        obj.push([W.noStaff, slack]);
        row([...ons.map((v) => [1, v] as Term), [1, slack]], ">=", settings.minStaffOnSite - all);
      }
      if (settings.minSupervisorsOnSite > sup) {
        const slack = `nv_${day.d}_${t / BLOCK}`;
        obj.push([W.noSupervisor, slack]);
        const supOns = [...supervisorIdx].flatMap((i) => onVar.get(`${i}:${day.d}:${t}`) ?? []);
        row([...supOns.map((v) => [1, v] as Term), [1, slack]], ">=", settings.minSupervisorsOnSite - sup);
      }
    }
  }

  // Hours, and teaching limits.
  const fixedHours = (e: Employee, drafts: boolean) =>
    fixed.filter((f) => f.userId === e.slingUserId && !!f.draft === drafts).reduce((h, f) => h + (f.end - f.start) / 60, 0);
  const existingHours = people.map((e) => fixedHours(e, false));
  const keptHours = people.map((e) => fixedHours(e, true));
  people.forEach((e, i) => {
    const h = hoursTerms[i]!;
    const fixedH = existingHours[i]! + keptHours[i]!;
    if (h.length) {
      if (e.maxHours !== null) row(h, "<=", Math.max(0, e.maxHours - fixedH));
      if (e.preferredHours !== null) {
        obj.push([W.underPreferred, `hu_${i}`], [W.overPreferred, `ho_${i}`]);
        row([...h, [1, `hu_${i}`], [-1, `ho_${i}`]], "=", e.preferredHours - fixedH);
      }
      if (e.minHours !== null && e.minHours > fixedH) {
        obj.push([W.belowMinimum, `hm_${i}`]);
        row([...h, [1, `hm_${i}`]], ">=", e.minHours - fixedH);
      }
    }
    if (e.teachingLimitPct !== null && teachTerms[i]!.length) {
      const share = e.teachingLimitPct / 100;
      obj.push([W.teachingOverLimit, `tl_${i}`]);
      row([...teachTerms[i]!, ...centerTime[i]!.map(([c, v]) => [-c * share, v] as Term), [-1, `tl_${i}`]], "<=", share * centerTimeFixed[i]!);
    }
  });

  // --- Solve ---
  const lp = [
    "Minimize",
    ` obj: ${linear(obj) || "0 x_empty"}`,
    "Subject To",
    ...(rows.length ? rows : [" r0: x_empty >= 0"]),
    ...(binaries.length ? ["Binaries", ` ${binaries.join(" ")}`] : []),
    "End",
  ].join("\n");
  const t0 = performance.now();
  const result = solver.solve(lp, { output_flag: false, mip_rel_gap: 0.01, time_limit: opts.timeLimitSeconds });
  const solveSeconds = (performance.now() - t0) / 1000;
  const cols = result.Columns ?? {};
  if (!["Optimal", "Time limit reached"].includes(result.Status) || Object.keys(cols).length === 0) {
    throw new Error(`The solver couldn't find a schedule (${result.Status}).`);
  }
  if (result.Status === "Time limit reached") {
    warnings.push(`The solver stopped at its ${opts.timeLimitSeconds}-second limit, so this is the best draft it found, not necessarily the best possible.`);
  }
  const val = (name: string) => cols[name]?.Primal ?? 0;
  const yes = (name: string | undefined) => !!name && val(name) > 0.5;

  // --- Read the draft back ---
  const NEW = { locked: false, breakStart: null, breakMissed: false, issues: [] as string[] };
  const shifts: DraftShift[] = [];
  const personIdx = new Map(people.map((e, i) => [e.slingUserId, i]));
  const programById = new Map(input.programs.map((p) => [p.id, p]));
  for (const f of fixed) {
    if (!f.draft) continue;
    const i = personIdx.get(f.userId);
    const d = input.dates.indexOf(f.date);
    let teachingMinutes = 0;
    if (f.kind === "program") teachingMinutes = Math.max(0, f.end - f.start - 2 * (programById.get(f.programId!)?.travelMinutes ?? 0));
    else if (i !== undefined) {
      for (let t = Math.floor(f.start / BLOCK) * BLOCK; t < f.end; t += BLOCK) {
        for (const v of teachOf.get(`${i}:${d}:${t}`) ?? []) teachingMinutes += val(v) * BLOCK;
      }
    }
    shifts.push({
      ...f.draft,
      name: onRoster.get(f.userId)?.name ?? f.draft.name,
      slingLocationId:
        f.kind === "center"
          ? settings.slingCenterLocationId
          : f.kind === "remote"
            ? settings.slingRemoteLocationId
            : (programById.get(f.programId!)?.slingLocationId ?? null),
      teachingMinutes: Math.round(teachingMinutes),
      breakStart: null,
      breakMissed: false,
      issues: [],
    });
  }
  people.forEach((e, i) => {
    for (const day of days) {
      const runs = (vars: Map<string, string>, blocks: number[]) => {
        const out: Interval[] = [];
        for (const t of blocks) {
          if (!yes(vars.get(`${i}:${day.d}:${t}`))) continue;
          const last = out.at(-1);
          if (last && last.end === t) last.end = t + BLOCK;
          else out.push({ start: t, end: t + BLOCK });
        }
        return out;
      };
      const teaching = (iv: Interval) => {
        let blocks = 0;
        for (let t = iv.start; t < iv.end; t += BLOCK) for (const v of teachOf.get(`${i}:${day.d}:${t}`) ?? []) blocks += val(v);
        return Math.round(blocks * BLOCK);
      };
      for (const iv of runs(onVar, day.centerBlocks)) {
        shifts.push({
          id: crypto.randomUUID(),
          slingUserId: e.slingUserId,
          name: e.name,
          date: day.date,
          start: fromMinutes(iv.start),
          end: fromMinutes(iv.end),
          where: "center",
          programId: null,
          slingLocationId: settings.slingCenterLocationId,
          teachingMinutes: teaching(iv),
          ...NEW,
        });
      }
      for (const iv of runs(rmVar, [...day.online.keys()].sort((a, b) => a - b))) {
        shifts.push({
          id: crypto.randomUUID(),
          slingUserId: e.slingUserId,
          name: e.name,
          date: day.date,
          start: fromMinutes(iv.start),
          end: fromMinutes(iv.end),
          where: "remote",
          programId: null,
          slingLocationId: settings.slingRemoteLocationId,
          teachingMinutes: teaching(iv),
          ...NEW,
        });
      }
    }
  });
  const programs: ProgramStaffing[] = sessions.map((s) => {
    const drafted = s.vars.filter(({ v }) => yes(v));
    for (const { e } of drafted) {
      shifts.push({
        id: crypto.randomUUID(),
        slingUserId: people[e]!.slingUserId,
        name: people[e]!.name,
        date: s.date,
        start: fromMinutes(s.busy.start),
        end: fromMinutes(s.busy.end),
        where: "program",
        programId: s.program.id,
        slingLocationId: s.program.slingLocationId,
        teachingMinutes: s.end - s.start,
        ...NEW,
      });
    }
    return {
      programId: s.program.id,
      name: s.program.name,
      date: s.date,
      start: fromMinutes(s.start),
      end: fromMinutes(s.end),
      needed: s.program.instructorsNeeded,
      existing: s.existing,
      drafted: [...s.kept.map((k) => onRoster.get(k.slingUserId)?.name ?? k.name), ...drafted.map(({ e }) => people[e]!.name)],
      short: Math.round(val(s.short)),
    };
  });

  // Coverage report.
  const idx = new Map(people.map((e, i) => [e.slingUserId, i]));
  const coverage: CoverageDay[] = days.map((day) => ({
    date: day.date,
    blocks: day.reportBlocks.map((t): CoverageBlock => {
      const fixedHere = fixedOnSite(day.date, t);
      let onSite = fixedHere.all;
      let supervisors = fixedHere.sup;
      let remote = 0;
      people.forEach((e, i) => {
        if (yes(onVar.get(`${i}:${day.d}:${t}`))) {
          onSite++;
          if (SUPERVISOR_ROLES.has(e.role)) supervisors++;
        }
        if (yes(rmVar.get(`${i}:${day.d}:${t}`)) || personDays[i]![day.d]!.fixedRemote.has(t)) remote++;
      });
      const sum = (m: Map<number, number> | undefined) => [...(m ?? new Map<number, number>()).values()].reduce((a, b) => a + b, 0);
      const shortBy = (prefix: string, m: Map<number, number> | undefined) =>
        [...(m ?? new Map<number, number>()).keys()].map((id) => ({ id, short: val(`${prefix}_${day.d}_${t / BLOCK}_${id}`) }));
      const shortIn = shortBy("sc", day.inCenter.get(t));
      const shortOn = shortBy("so", day.online.get(t));
      const gaps: string[] = [];
      for (const { id, short } of [...shortIn, ...shortOn]) {
        if (short < 0.01) continue;
        const level = levelById.get(id)!;
        const able = people.filter((e) => canTeach(e, level));
        const availableNow = able.filter((e) => personDays[idx.get(e.slingUserId)!]![day.d]!.available.has(t));
        const unused = availableNow.filter((e) => {
          const i = idx.get(e.slingUserId)!;
          return !yes(onVar.get(`${i}:${day.d}:${t}`)) && !personDays[i]![day.d]!.fixedCenter.has(t);
        });
        gaps.push(
          availableNow.length === 0
            ? `${level.name}: nobody who can teach it is available`
            : unused.length === 0
              ? `${level.name}: everyone available who can teach it is already scheduled`
              : `${level.name}: ${unused.map((e) => e.name).join(", ")} available but not scheduled (hours, shift length or other limits)`,
        );
      }
      if (day.presence.has(t)) {
        const availableCount = people.filter((e) => personDays[idx.get(e.slingUserId)!]![day.d]!.available.has(t)).length;
        if (onSite < settings.minStaffOnSite) gaps.push(`${onSite} at the center, ${settings.minStaffOnSite} needed (${availableCount} available)`);
        if (supervisors < settings.minSupervisorsOnSite) gaps.push("No supervisor at the center");
      }
      return {
        time: fromMinutes(t),
        open: day.open.has(t),
        neededInCenter: +sum(day.inCenter.get(t)).toFixed(2),
        neededOnline: +sum(day.online.get(t)).toFixed(2),
        shortInCenter: +shortIn.reduce((a, s) => a + s.short, 0).toFixed(2),
        shortOnline: +shortOn.reduce((a, s) => a + s.short, 0).toFixed(2),
        onSite,
        supervisors,
        remote,
        gaps,
      };
    }),
  }));

  placeBreaks(shifts, coverage, settings, teachOf, val, days);
  findIssues(shifts, input, people, personDays, fixed);

  // Per-person summary.
  const employees: EmployeeSummary[] = people.map((e, i) => {
    const drafted = shifts.filter((s) => s.slingUserId === e.slingUserId).reduce((h, s) => h + (toMinutes(s.end) - toMinutes(s.start)) / 60, 0);
    const total = drafted + existingHours[i]!;
    const notes: string[] = [];
    if (e.minHours !== null && total < e.minHours - 0.01) notes.push(`Below minimum hours (${e.minHours})`);
    if (e.preferredHours !== null && total < e.preferredHours - 0.01) notes.push(`Under preferred hours (${e.preferredHours})`);
    if (e.preferredHours !== null && total > e.preferredHours + 0.01) notes.push(`Over preferred hours (${e.preferredHours})`);
    if (e.maxHours !== null && total > e.maxHours + 0.01) notes.push(`Over maximum hours (${e.maxHours})`);
    if (val(`tl_${i}`) > 0.01) notes.push(`Teaching over their ${e.teachingLimitPct}% limit`);
    const wfhCenter = shifts.some((s) => s.slingUserId === e.slingUserId && s.where === "center" && e.wfhWeekdays.includes(weekday(s.date)));
    if (wfhCenter) notes.push("At the center on a work-from-home day");
    const avoided = e.preferences.filter((p) => p.kind === "avoid");
    const inAvoid = shifts.some(
      (s) =>
        s.slingUserId === e.slingUserId &&
        avoided.some((p) => p.weekday === weekday(s.date) && s.start < p.end && p.start < s.end),
    );
    if (inAvoid) notes.push("Works during a time they'd rather avoid");
    return {
      slingUserId: e.slingUserId,
      name: e.name,
      draftedHours: +drafted.toFixed(2),
      existingHours: +existingHours[i]!.toFixed(2),
      minHours: e.minHours,
      preferredHours: e.preferredHours,
      maxHours: e.maxHours,
      notes,
    };
  });

  shifts.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
  const now = Math.floor(Date.now() / 1000);
  return {
    weekStart: input.dates[0]!,
    generatedAt: now,
    updatedAt: now,
    status: result.Status,
    solveSeconds: +solveSeconds.toFixed(2),
    shifts,
    coverage,
    employees,
    programs,
    warnings,
    choices: {
      people: input.employees.filter((e) => e.active).map((e) => ({ slingUserId: e.slingUserId, name: e.name })),
      programs: input.programs.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name })),
    },
  };
}

/**
 * Notes on each shift where it breaks a rule. Drafted shifts follow the rules,
 * so these come from hand edits, or from kept shifts after the inputs changed.
 */
function findIssues(shifts: DraftShift[], input: SchedulerInput, people: Employee[], personDays: PersonDay[][], fixed: Fixed[]): void {
  const idx = new Map(people.map((e, i) => [e.slingUserId, i]));
  const min = (e: Employee) => e.minShiftMinutes ?? input.settings.minShiftMinutes;
  for (const s of shifts) {
    const i = idx.get(s.slingUserId);
    if (i === undefined) {
      s.issues.push("Not on the roster as someone to schedule");
      continue;
    }
    const e = people[i]!;
    const pd = personDays[i]![input.dates.indexOf(s.date)]!;
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    const blocks: number[] = [];
    for (let t = Math.floor(start / BLOCK) * BLOCK; t < end; t += BLOCK) blocks.push(t);
    if (blocks.some((t) => pd.timeOff.has(t))) s.issues.push("During approved time off");
    else if (blocks.some((t) => !pd.available.has(t))) s.issues.push("Outside their availability");
    const others = [
      ...fixed.filter((f) => !f.draft).map((f) => ({ id: "", userId: f.userId, date: f.date, start: f.start, end: f.end })),
      ...shifts.map((o) => ({ id: o.id, userId: o.slingUserId, date: o.date, start: toMinutes(o.start), end: toMinutes(o.end) })),
    ];
    if (others.some((o) => o.id !== s.id && o.userId === s.slingUserId && o.date === s.date && overlaps(o, { start, end }))) {
      s.issues.push("Overlaps another of their shifts");
    }
    if (s.where !== "program" && end - start < min(e)) s.issues.push(`Shorter than ${min(e)} minutes`);
    if (s.where !== "program" && end - start > input.settings.maxShiftMinutes) s.issues.push(`Longer than ${input.settings.maxShiftMinutes} minutes`);
    if (s.where === "center" && e.wfhWeekdays.includes(weekday(s.date))) s.issues.push("At the center on a work-from-home day");
    if (s.where === "remote" && !e.canWorkRemote) s.issues.push("Can't work remotely");
  }
}

/**
 * Gives each center or remote shift of breakAfterMinutes or more a break of
 * breakMinutes, in the block nearest its middle (not in the first or last
 * hour) where the others working can cover the students for those minutes:
 * at least the whole instructors' worth of students there. A fraction over
 * is fine for a short break (one instructor with 5 elementary students, say).
 * Marks the shift when no block allows it.
 * Program shifts are fixed sessions and get no break here.
 */
function placeBreaks(
  shifts: DraftShift[],
  coverage: CoverageDay[],
  settings: CenterSettings,
  teachOf: Map<string, string[]>,
  val: (name: string) => number,
  days: DayPlan[],
): void {
  if (settings.breakMinutes <= 0) return;
  // Teaching assigned per day and block, over everyone.
  const teaching = new Map<string, number>();
  for (const [key, vars] of teachOf) {
    const [, d, t] = key.split(":");
    const k = `${d}:${t}`;
    teaching.set(k, (teaching.get(k) ?? 0) + vars.reduce((a, v) => a + val(v), 0));
  }
  for (const s of shifts) {
    if (s.where === "program") continue;
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    if (end - start < settings.breakAfterMinutes) continue;
    const day = days.find((d) => d.date === s.date)!;
    const blocks = new Map(coverage.find((c) => c.date === s.date)!.blocks.map((b) => [toMinutes(b.time), b]));
    const canSpare = (t: number) => {
      const block = blocks.get(t);
      if (!block) return true;
      if (block.shortInCenter + block.shortOnline > 0.01) return false;
      const others = block.onSite + block.remote - 1;
      return others >= Math.floor((teaching.get(`${day.d}:${t}`) ?? 0) + 1e-6);
    };
    const mid = (start + end) / 2;
    const candidates: number[] = [];
    for (let t = Math.ceil((start + 60) / BLOCK) * BLOCK; t + BLOCK <= end - 60; t += BLOCK) candidates.push(t);
    candidates.sort((a, b) => Math.abs(a + BLOCK / 2 - mid) - Math.abs(b + BLOCK / 2 - mid));
    const fits = candidates.find(canSpare);
    if (fits !== undefined) s.breakStart = fromMinutes(fits);
    else s.breakMissed = true;
  }
}
