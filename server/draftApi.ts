// /api/drafts/*: generating a week's draft schedule (feature 6) and reading
// the latest one back. Generating reads Radius (levels and appointments) and
// Sling (existing shifts and time off), solves with HiGHS (server/scheduler.ts)
// and stores the result, so it survives a reload.
//
// It runs inside the request, which CloudFront cuts off after 60 seconds:
// Radius and Sling take a few seconds, and the solver is stopped after
// SOLVE_SECONDS with the best draft found by then.

import highsLoader from "highs";
import type { Env } from "./env";
import { bookedDemand } from "./demand";
import { getItem, keys, nowSeconds, putItem } from "./db";
import { BadRequest, json, withAccount } from "./http";
import { fetchAppointments, fetchLevels } from "./radiusData";
import { loadRoster } from "./roster";
import { BLOCK, solveWeek, type Draft, type Solver } from "./scheduler";
import { loadHours, loadPrograms, loadSettings } from "./setup";
import { fetchCalendar } from "./slingData";
import { addDays, isDate, weekday } from "./time";

const SOLVE_SECONDS = 25;

// The solver's WebAssembly is loaded once per Lambda instance. highs finds
// highs.wasm next to its own module: in node_modules in dev, and next to the
// bundle in Lambda (copied there by infra/stack.ts).
let solver: Promise<Solver> | undefined;
const loadSolver = () => (solver ??= highsLoader() as Promise<Solver>);

interface DraftItem {
  draft: string; // the Draft as JSON
  updatedAt: number;
}

async function generate(env: Env, accountId: number, weekStart: string): Promise<Draft> {
  const settings = await loadSettings(env);
  const [hours, programs, employees] = await Promise.all([loadHours(env), loadPrograms(env), loadRoster(env)]);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const end = dates.at(-1)!;

  // Radius, then Sling, one after the other (Radius dislikes bursts of requests).
  const { levels, token, tokenPage } = await fetchLevels(env, accountId, settings.radiusCenterId);
  const appointments = await fetchAppointments(env, accountId, { start: weekStart, end }, { token, tokenPage });
  const { shifts, timeOff } = await fetchCalendar(env, accountId, { start: weekStart, end: addDays(end, 1) }, settings.timezone);

  const demand = bookedDemand(appointments, levels, dates, { from: "00:00", to: "24:00" }, BLOCK);
  const draft = solveWeek(
    { dates, settings, hours, programs, employees, levels, demand, fixedShifts: shifts, timeOff },
    await loadSolver(),
    { timeLimitSeconds: SOLVE_SECONDS },
  );
  const unknown = appointments.filter((a) => a.grade === null && a.date >= weekStart && a.date <= end).length;
  if (unknown > 0) draft.warnings.push(`${unknown} appointments have a grade the app doesn't recognize, so they aren't counted.`);
  const existing = shifts.filter((s) => s.userId !== null).length;
  if (existing > 0) draft.warnings.push(`${existing} shifts already in Sling this week are kept as they are; the draft fills in around them.`);

  await putItem({ ...keys.draft(weekStart), draft: JSON.stringify(draft), updatedAt: nowSeconds() } satisfies DraftItem & {
    pk: string;
    sk: string;
  });
  return draft;
}

/** Handles /api/drafts/:weekStart and /api/drafts/:weekStart/generate, or returns null for other paths. */
export async function handleDrafts(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const m = pathname.match(/^\/api\/drafts\/([^/]+)(\/generate)?$/);
  if (!m) return null;
  return withAccount(request, env, async (account) => {
    const weekStart = m[1]!;
    if (!isDate(weekStart) || weekday(weekStart) !== 1) throw new BadRequest("The week must start on a Monday (YYYY-MM-DD).");

    // GET /api/drafts/:weekStart — the latest draft, or null.
    if (!m[2] && request.method === "GET") {
      const item = await getItem<DraftItem>(keys.draft(weekStart));
      return json({ draft: item ? (JSON.parse(item.draft) as Draft) : null });
    }

    // POST /api/drafts/:weekStart/generate — a new draft, replacing the stored one.
    if (m[2] && request.method === "POST") return json({ draft: await generate(env, account.id, weekStart) });

    return json({ error: "Not found" }, 404);
  });
}
