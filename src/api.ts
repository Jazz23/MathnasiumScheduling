// Calls to the Worker's /api routes, and the shapes they return. The Worker
// owns these shapes (worker/*.ts); keep the two in step.

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Window {
  weekday: number;
  start: string;
  end: string;
}

export interface Level {
  id: number;
  name: string;
  firstGrade: number;
  lastGrade: number;
  inCenterRatio: number;
  onlineRatio: number;
}

export interface DemandBlock {
  time: string;
  students: Record<string, { inCenter: number; online: number }>;
  unknownLevel: number;
  instructorsInCenter: number;
  instructorsOnline: number;
  staff: { onSite: number; supervisors: number; remote: number } | null;
}

export interface Demand {
  start: string;
  blockMinutes: number;
  window: { from: string; to: string };
  levels: Level[];
  minStaffOnSite: number;
  minSupervisorsOnSite: number;
  centerLocationMapped: boolean;
  slingError: string | null;
  appointmentsByStatus: Record<string, number>;
  onlineAppointments: number;
  unknownGrades: number;
  hours: { date: string; open: { open: string; close: string }[] }[];
  days: { date: string; blocks: DemandBlock[] }[];
  shifts: { name: string; date: string; start: string; end: string; where: string; status: string; repeating: boolean }[];
  timeOff: { name: string; startDate: string; endDate: string; startTime: string | null; endTime: string | null; approved: boolean }[];
}

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

export interface SchoolProgram {
  id: number;
  name: string;
  slingLocationId: number | null;
  instructorsNeeded: number;
  travelMinutes: number;
  active: boolean;
  sessions: Window[];
}

export interface Setup {
  settings: CenterSettings;
  hours: { weekday: number; open: string; close: string }[];
  programs: SchoolProgram[];
}

export interface SlingGroups {
  locations: { id: number; name: string }[];
  positions: { id: number; name: string }[];
}

export type Role = "owner" | "assistant_director" | "instructor" | "front_desk";
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  assistant_director: "Assistant center director",
  instructor: "Instructor",
  front_desk: "Front desk",
};

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
  availability: { effectiveFrom: string; windows: Window[] }[];
  preferences: (Window & { kind: "prefer" | "avoid" })[];
}

export interface AvailabilitySuggestion {
  slingUserId: number;
  weeks: number;
  windows: (Window & { timesWorked: number })[];
}

export const gradeLabel = (g: number) => (g === -1 ? "Pre K" : g === 0 ? "K" : `Grade ${g}`);

/** 'HH:MM' (24-hour) as '1:30 PM'. */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 'YYYY-MM-DD' as 'Mon 11/30'. */
export function formatDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in the browser's time zone. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The Monday on or before `date` (Sling's weeks start on Monday). */
export function mondayOf(date: string): string {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
