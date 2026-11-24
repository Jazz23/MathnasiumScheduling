// Booked demand per time block: students by level and delivery, and the
// instructors that takes at Radius' ratios. Pure: no network or database, so
// the scheduler can reuse it.

import type { Appointment, Level } from "./radiusData";
import { DEMAND_STATUSES, levelForGrade } from "./radiusData";
import { fromMinutes, toMinutes } from "./time";

export interface LevelCount {
  inCenter: number;
  online: number;
}

export interface DemandBlock {
  time: string; // block start, 'HH:MM'
  /** Students by level ID. */
  students: Record<number, LevelCount>;
  /** Students whose grade doesn't map to a level; not counted in instructors. */
  unknownLevel: number;
  /** Instructors needed for in-center students, summed over levels at the in-center ratios. */
  instructorsInCenter: number;
  /** Instructors needed for online students, at the online ratios. */
  instructorsOnline: number;
}

export interface DemandDay {
  date: string;
  blocks: DemandBlock[];
}

/**
 * Counts appointments that need an instructor (scheduled, attended, drop-in)
 * in each block of each date. Blocks run from `from` to `to` ('HH:MM') every
 * `blockMinutes`. An appointment occupies every block it overlaps.
 */
export function bookedDemand(
  appointments: Appointment[],
  levels: Level[],
  dates: string[],
  window: { from: string; to: string },
  blockMinutes: number,
): DemandDay[] {
  const from = toMinutes(window.from);
  const to = toMinutes(window.to);
  const days = new Map<string, DemandBlock[]>();
  for (const date of dates) {
    const blocks: DemandBlock[] = [];
    for (let t = from; t < to; t += blockMinutes) {
      blocks.push({ time: fromMinutes(t), students: {}, unknownLevel: 0, instructorsInCenter: 0, instructorsOnline: 0 });
    }
    days.set(date, blocks);
  }

  for (const a of appointments) {
    if (!DEMAND_STATUSES.has(a.status)) continue;
    const blocks = days.get(a.date);
    if (!blocks) continue;
    const level = a.grade == null ? undefined : levelForGrade(levels, a.grade);
    const start = toMinutes(a.start);
    const end = start + a.minutes;
    for (const block of blocks) {
      const b = toMinutes(block.time);
      if (b + blockMinutes <= start || b >= end) continue;
      if (!level) {
        block.unknownLevel++;
        continue;
      }
      const count = (block.students[level.id] ??= { inCenter: 0, online: 0 });
      if (a.online) {
        count.online++;
        block.instructorsOnline += 1 / level.onlineRatio;
      } else {
        count.inCenter++;
        block.instructorsInCenter += 1 / level.inCenterRatio;
      }
    }
  }

  return dates.map((date) => ({ date, blocks: days.get(date)! }));
}

/**
 * The earliest start and latest end ('HH:MM') across appointments that need
 * an instructor, rounded out to whole blocks. Null if there are none.
 */
export function appointmentWindow(appointments: Appointment[], blockMinutes: number): { from: string; to: string } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const a of appointments) {
    if (!DEMAND_STATUSES.has(a.status)) continue;
    const start = toMinutes(a.start);
    from = Math.min(from, start);
    to = Math.max(to, start + a.minutes);
  }
  if (!Number.isFinite(from)) return null;
  return {
    from: fromMinutes(Math.floor(from / blockMinutes) * blockMinutes),
    to: fromMinutes(Math.ceil(to / blockMinutes) * blockMinutes),
  };
}
