// Calendar dates ('YYYY-MM-DD') and times of day ('HH:MM') in the center's
// local time. Dates are handled as plain calendar days (UTC arithmetic on
// midnight), so daylight saving never shifts them.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));

export const isTime = (value: unknown): value is string => typeof value === "string" && TIME.test(value);

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: string): number => new Date(date + "T00:00:00Z").getUTCDay();

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

export function fromMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The UTC offset in force at midnight on `date` in `timeZone`, as "-08:00". */
export function localOffset(date: string, timeZone: string): string {
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(instant));
    const m = (parts.find((p) => p.type === "timeZoneName")?.value ?? "").match(/GMT([+-])(\d{2}):(\d{2})/);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  };
  // Guess with the offset at noon, then take the offset at that local midnight
  // (they differ on the days daylight saving starts or ends).
  const midnightUtc = Date.parse(date + "T00:00:00Z");
  const offset = offsetAt(midnightUtc - offsetAt(midnightUtc + 12 * 3_600_000) * 60_000);
  const abs = Math.abs(offset);
  return `${offset < 0 ? "-" : "+"}${fromMinutes(abs)}`;
}

/** Today's date in `timeZone`. */
export function today(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}
