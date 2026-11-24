// /api/drafts/*: a week's draft schedule (features 6 and 7). Generating reads
// Radius (levels and appointments) and Sling (existing shifts and time off),
// solves with HiGHS (server/scheduler.ts) and stores the draft together with
// those inputs. Editing sends the whole list of shifts back; it's checked
// against the stored inputs, with nothing new drafted, so an edit doesn't read
// Radius or Sling again. Generating again keeps the locked shifts.
//
// Generating runs inside the request, which CloudFront cuts off after 60
// seconds: Radius and Sling take a few seconds, and the solver is stopped
// after SOLVE_SECONDS with the best draft found by then.

import highsLoader from "highs";
import type { Env } from "./env";
import { bookedDemand } from "./demand";
import { getItem, keys, nowSeconds, putItem } from "./db";
import { BadRequest, json, readBody, withAccount } from "./http";
import { fetchAppointments, fetchLevels } from "./radiusData";
import { loadRoster } from "./roster";
import { BLOCK, solveWeek, type Draft, type DraftShift, type SchedulerInput, type Solver } from "./scheduler";
import { loadHours, loadPrograms, loadSettings } from "./setup";
import { fetchCalendar } from "./slingData";
import { addDays, isDate, isTime, toMinutes, weekday } from "./time";

const SOLVE_SECONDS = 25;
const CHECK_SECONDS = 20;

// The solver's WebAssembly is loaded once per Lambda instance. highs finds
// highs.wasm next to its own module: in node_modules in dev, and next to the
// bundle in Lambda (copied there by infra/stack.ts).
let solver: Promise<Solver> | undefined;
const loadSolver = () => (solver ??= highsLoader() as Promise<Solver>);

/** The week's inputs as read when the draft was generated, without `keep` and `draftNew`. */
type StoredInput = Omit<SchedulerInput, "keep" | "draftNew"> & { notes: string[] };

interface DraftItem {
  draft: string; // Draft as JSON
  input: string; // StoredInput as JSON
  updatedAt: number;
}

async function loadDraftItem(weekStart: string): Promise<{ draft: Draft; input: StoredInput } | null> {
  const item = await getItem<DraftItem>(keys.draft(weekStart));
  // Drafts from before editing existed have no stored inputs; they count as none.
  if (!item?.input) return null;
  return { draft: JSON.parse(item.draft) as Draft, input: JSON.parse(item.input) as StoredInput };
}

async function saveDraft(weekStart: string, draft: Draft, input: StoredInput): Promise<void> {
  await putItem({
    ...keys.draft(weekStart),
    draft: JSON.stringify(draft),
    input: JSON.stringify(input),
    updatedAt: nowSeconds(),
  } satisfies DraftItem & { pk: string; sk: string });
}

async function solve(input: StoredInput, keep: DraftShift[], draftNew: boolean): Promise<Draft> {
  const draft = solveWeek({ ...input, keep, draftNew }, await loadSolver(), { timeLimitSeconds: draftNew ? SOLVE_SECONDS : CHECK_SECONDS });
  draft.warnings.push(...input.notes);
  return draft;
}

async function generate(env: Env, accountId: number, weekStart: string): Promise<Draft> {
  const settings = await loadSettings(env);
  const [hours, programs, employees, previous] = await Promise.all([loadHours(env), loadPrograms(env), loadRoster(env), loadDraftItem(weekStart)]);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const end = dates.at(-1)!;

  // Radius, then Sling, one after the other (Radius dislikes bursts of requests).
  const { levels, token, tokenPage } = await fetchLevels(env, accountId, settings.radiusCenterId);
  const appointments = await fetchAppointments(env, accountId, { start: weekStart, end }, { token, tokenPage });
  const { shifts, timeOff } = await fetchCalendar(env, accountId, { start: weekStart, end: addDays(end, 1) }, settings.timezone);

  // Only blocks with students are stored.
  const demand = bookedDemand(appointments, levels, dates, { from: "00:00", to: "24:00" }, BLOCK).map((d) => ({
    date: d.date,
    blocks: d.blocks.filter((b) => Object.keys(b.students).length > 0),
  }));
  const notes: string[] = [];
  const unknown = appointments.filter((a) => a.grade === null && a.date >= weekStart && a.date <= end).length;
  if (unknown > 0) notes.push(`${unknown} appointments have a grade the app doesn't recognize, so they aren't counted.`);
  const existing = shifts.filter((s) => s.userId !== null).length;
  if (existing > 0) notes.push(`${existing} shifts already in Sling this week are kept as they are; the draft fills in around them.`);

  const input: StoredInput = { dates, settings, hours, programs, employees, levels, demand, fixedShifts: shifts, timeOff, notes };
  const locked = previous?.draft.shifts.filter((s) => s.locked) ?? [];
  const draft = await solve(input, locked, true);
  await saveDraft(weekStart, draft, input);
  return draft;
}

/** Checks one shift from an edit. The server fills in the rest (name, teaching, break, issues). */
function readShift(value: unknown, input: StoredInput): DraftShift {
  const s = (value ?? {}) as Record<string, unknown>;
  const person = input.employees.find((e) => e.slingUserId === s.slingUserId);
  if (!person) throw new BadRequest("Each shift needs someone on the roster.");
  if (typeof s.date !== "string" || !input.dates.includes(s.date)) throw new BadRequest("Each shift's date must be in this week.");
  const time = (v: unknown) => v === "24:00" || isTime(v);
  if (!time(s.start) || !time(s.end) || toMinutes(s.start as string) >= toMinutes(s.end as string)) {
    throw new BadRequest("Each shift needs a start time before its end time (HH:MM).");
  }
  if (s.where !== "center" && s.where !== "remote" && s.where !== "program") throw new BadRequest("A shift is at the center, remote or a program.");
  let programId: number | null = null;
  if (s.where === "program") {
    const program = input.programs.find((p) => p.id === s.programId);
    if (!program) throw new BadRequest("Choose the school program.");
    programId = program.id;
  }
  return {
    id: typeof s.id === "string" && /^[\w-]{1,64}$/.test(s.id) ? s.id : crypto.randomUUID(),
    locked: s.locked === true,
    slingUserId: person.slingUserId,
    name: person.name,
    date: s.date,
    start: s.start as string,
    end: s.end as string,
    where: s.where,
    programId,
    slingLocationId: null,
    teachingMinutes: 0,
    breakStart: null,
    breakMissed: false,
    issues: [],
  };
}

/** Handles /api/drafts/:weekStart, .../generate and .../shifts, or returns null for other paths. */
export async function handleDrafts(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/api\/drafts\/([^/]+)(\/generate|\/shifts)?$/);
  if (!m) return null;
  return withAccount(request, env, async (account) => {
    const weekStart = m[1]!;
    if (!isDate(weekStart) || weekday(weekStart) !== 1) throw new BadRequest("The week must start on a Monday (YYYY-MM-DD).");

    // GET /api/drafts/:weekStart — the latest draft, or null.
    if (!m[2] && request.method === "GET") return json({ draft: (await loadDraftItem(weekStart))?.draft ?? null });

    // POST /api/drafts/:weekStart/generate — a new draft, keeping the locked shifts.
    if (m[2] === "/generate" && request.method === "POST") return json({ draft: await generate(env, account.id, weekStart) });

    // PUT /api/drafts/:weekStart/shifts — { shifts: [{ id?, slingUserId, date, start, end, where, programId?, locked }] }
    // Replaces the draft's shifts with these and checks them.
    if (m[2] === "/shifts" && request.method === "PUT") {
      const stored = await loadDraftItem(weekStart);
      if (!stored) throw new BadRequest("Generate a draft for this week first.");
      const body = await readBody(request);
      if (!Array.isArray(body.shifts) || body.shifts.length > 500) throw new BadRequest("shifts must be a list.");
      const shifts = body.shifts.map((s) => readShift(s, stored.input));
      const draft = await solve(stored.input, shifts, false);
      draft.generatedAt = stored.draft.generatedAt;
      await saveDraft(weekStart, draft, stored.input);
      return json({ draft });
    }

    return json({ error: "Not found" }, 404);
  });
}
