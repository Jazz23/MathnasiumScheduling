// GET /api/demand?start=YYYY-MM-DD&days=7: booked demand per 15-minute block
// from Radius (feature 4), next to the staff already on Sling's schedule.
// Radius is read with two requests (Center Settings for the levels and a
// token, then the appointments), Sling with two (session and calendar).

import type { Env } from "./env";
import { appointmentWindow, bookedDemand } from "./demand";
import { BadRequest, int, json, withAccount } from "./http";
import { fetchAppointments, fetchLevels, type Appointment } from "./radiusData";
import { loadRoster, SUPERVISOR_ROLES } from "./roster";
import { loadHours, loadPrograms, loadSettings } from "./setup";
import { fetchCalendar, type SlingShift, type SlingTimeOff } from "./slingData";
import { addDays, fromMinutes, isDate, toMinutes, weekday } from "./time";

const BLOCK_MINUTES = 15;

interface StaffCount {
  /** People on a shift at the center location. */
  onSite: number;
  supervisors: number;
  /** People on a shift at the remote location. */
  remote: number;
}

function widen(window: { from: string; to: string } | null, from: string, to: string) {
  if (!window) return { from, to };
  return { from: from < window.from ? from : window.from, to: to > window.to ? to : window.to };
}

async function demand(env: Env, accountId: number, start: string, days: number) {
  const settings = await loadSettings(env);
  const [hours, programs, roster] = await Promise.all([loadHours(env), loadPrograms(env), loadRoster(env)]);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const end = dates.at(-1)!;

  // Radius. Without it there's nothing to show, so its errors fail the request.
  const { levels, token, tokenPage } = await fetchLevels(env, accountId, settings.radiusCenterId);
  const appointments: Appointment[] = await fetchAppointments(env, accountId, { start, end }, { token, tokenPage });

  // Sling. Optional here: the demand still makes sense without it.
  let shifts: SlingShift[] = [];
  let timeOff: SlingTimeOff[] = [];
  let slingError: string | null = null;
  try {
    ({ shifts, timeOff } = await fetchCalendar(env, accountId, { start, end: addDays(end, 1) }, settings.timezone));
  } catch (err) {
    console.error("Reading Sling's calendar failed", err);
    slingError = err instanceof Error ? err.message : "Couldn't read Sling's calendar.";
  }

  // The rows to show: opening hours, appointments and center shifts.
  let window = appointmentWindow(appointments, BLOCK_MINUTES);
  for (const h of hours) if (dates.some((d) => weekday(d) === h.weekday)) window = widen(window, h.open, h.close);
  const centerShifts = shifts.filter((s) => s.locationId !== null && s.locationId === settings.slingCenterLocationId);
  for (const s of centerShifts) if (s.endDate === s.date) window = widen(window, s.start, s.end);
  window ??= { from: "12:00", to: "19:00" };
  window = {
    from: fromMinutes(Math.floor(toMinutes(window.from) / BLOCK_MINUTES) * BLOCK_MINUTES),
    to: fromMinutes(Math.ceil(toMinutes(window.to) / BLOCK_MINUTES) * BLOCK_MINUTES),
  };

  const demandDays = bookedDemand(appointments, levels, dates, window, BLOCK_MINUTES);

  const supervisors = new Set(roster.filter((e) => SUPERVISOR_ROLES.has(e.role)).map((e) => e.slingUserId));
  const names = new Map(roster.map((e) => [e.slingUserId, e.name]));
  const staffAt = (date: string, time: string): StaffCount => {
    const t = toMinutes(time);
    const count: StaffCount = { onSite: 0, supervisors: 0, remote: 0 };
    for (const s of shifts) {
      if (s.date !== date || s.userId === null) continue;
      const end = s.endDate === s.date ? toMinutes(s.end) : 24 * 60;
      if (toMinutes(s.start) > t || end <= t) continue;
      if (s.locationId === settings.slingCenterLocationId) {
        count.onSite++;
        if (supervisors.has(s.userId)) count.supervisors++;
      } else if (s.locationId !== null && s.locationId === settings.slingRemoteLocationId) count.remote++;
    }
    return count;
  };

  const locationNames = new Map<number, string>(programs.flatMap((p) => (p.slingLocationId ? [[p.slingLocationId, p.name]] : [])));
  if (settings.slingCenterLocationId) locationNames.set(settings.slingCenterLocationId, "Center");
  if (settings.slingRemoteLocationId) locationNames.set(settings.slingRemoteLocationId, "Remote");

  const counted = appointments.filter((a) => a.date >= start && a.date <= end);
  const byStatus: Record<string, number> = {};
  for (const a of counted) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;

  return {
    start,
    blockMinutes: BLOCK_MINUTES,
    window,
    levels,
    minStaffOnSite: settings.minStaffOnSite,
    minSupervisorsOnSite: settings.minSupervisorsOnSite,
    centerLocationMapped: settings.slingCenterLocationId !== null,
    slingError,
    appointmentsByStatus: byStatus,
    onlineAppointments: counted.filter((a) => a.online).length,
    unknownGrades: counted.filter((a) => a.grade === null).length,
    hours: dates.map((date) => ({ date, open: hours.filter((h) => h.weekday === weekday(date)).map((h) => ({ open: h.open, close: h.close })) })),
    days: demandDays.map((d) => ({
      date: d.date,
      blocks: d.blocks.map((b) => ({ ...b, staff: slingError ? null : staffAt(d.date, b.time) })),
    })),
    shifts: shifts
      .filter((s) => s.userId !== null)
      .map((s) => ({
        name: names.get(s.userId!) ?? `Sling user ${s.userId}`,
        date: s.date,
        start: s.start,
        end: s.end,
        where: (s.locationId && locationNames.get(s.locationId)) || "Other location",
        status: s.status,
        repeating: s.repeating,
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.name.localeCompare(b.name)),
    timeOff: timeOff.map((t) => ({
      name: t.userId === null ? "Unknown" : (names.get(t.userId) ?? `Sling user ${t.userId}`),
      startDate: t.startDate,
      endDate: t.endDate,
      startTime: t.fullDay ? null : t.startTime,
      endTime: t.fullDay ? null : t.endTime,
      approved: t.approved,
    })),
  };
}

/** Handles GET /api/demand, or returns null for other paths. */
export async function handleDemand(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/demand") return null;
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  return withAccount(request, env, async (account) => {
    const start = url.searchParams.get("start");
    if (!isDate(start)) throw new BadRequest("start must be YYYY-MM-DD.");
    const days = int(url.searchParams.get("days") ?? 7, "days", 1, 14)!;
    return json(await demand(env, account.id, start, days));
  });
}
