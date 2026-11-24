// Typed reads of Radius data the scheduler needs. Radius has no public API:
// these are the requests Radius' own pages make (see "Radius endpoints found
// so far" in docs/PLAN.md). Responses are checked, and anything unexpected
// throws instead of being guessed at.
//
// Radius blocks clients that send many requests quickly (about 30 in a few
// minutes), so callers should make few requests and never fire them in
// parallel.

import type { Env } from "./env";
import { radiusFetch } from "./radius";

export class RadiusDataError extends Error {}

/** A grade as a number in natural order: Pre K = -1, K = 0, then 1–12. College counts as 12. */
export type Grade = number;

/** A Radius level (a "grade range" in Radius' settings). */
export interface Level {
  id: number;
  name: string;
  firstGrade: Grade;
  lastGrade: Grade;
  inCenterRatio: number;
  onlineRatio: number;
}

export type AppointmentStatus = "Scheduled" | "Attended" | "Drop-In" | "Cancelled" | "Late cancelled" | "No show";

export interface Appointment {
  studentId: number;
  /** Center-local date and start time: 'YYYY-MM-DD', 'HH:MM'. */
  date: string;
  start: string;
  minutes: number;
  status: string;
  online: boolean;
  /** null when Radius gives a grade this app doesn't recognize. */
  grade: Grade | null;
  /** Radius' session type: Standard, HighSchool, Private, Great Foundations, or a membership name. */
  sessionType: string;
}

/** Statuses that mean a student needs (or needed) an instructor. */
export const DEMAND_STATUSES = new Set(["Scheduled", "Attended", "Drop-In"]);

// Radius numbers Pre K and K after 12 in its settings.
function radiusSettingGrade(n: number): Grade {
  if (n === 13) return -1;
  if (n === 14) return 0;
  return n;
}

/** Parses an appointment's Grade string ("Pre K", "K", "1"–"12", "College"). */
export function parseGrade(value: string): Grade | null {
  const v = value.trim().toLowerCase();
  if (v === "pre k" || v === "prek" || v === "pre-k") return -1;
  if (v === "k") return 0;
  if (v === "college") return 12;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/** The level a grade belongs to, if any. */
export function levelForGrade(levels: Level[], grade: Grade): Level | undefined {
  return levels.find((l) => grade >= l.firstGrade && grade <= l.lastGrade);
}

// "11/30/2026" -> "2026-11-30"
function parseUsDate(value: string): string {
  const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new RadiusDataError(`Unexpected date from Radius: ${value}`);
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

// "1:30 PM" -> "13:30"
function parseUsTime(value: string): string {
  const m = value.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!m) throw new RadiusDataError(`Unexpected time from Radius: ${value}`);
  let hour = Number(m[1]) % 12;
  if (m[3]!.toUpperCase() === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

const VERIFICATION_TOKEN = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i;

/** GETs a Radius page as HTML. */
async function getPage(env: Env, accountId: number, path: string): Promise<string> {
  const response = await radiusFetch(env, accountId, path);
  if (!response.ok) throw new RadiusDataError(`Radius ${path} answered HTTP ${response.status}`);
  return response.text();
}

function verificationToken(html: string): string {
  const token = html.match(VERIFICATION_TOKEN)?.[1];
  if (!token) throw new RadiusDataError("No anti-forgery token on the Radius page");
  return token;
}

/**
 * POSTs a Kendo grid read, which needs the page's anti-forgery token. If
 * Radius answers with something other than JSON (its 500 page, after its
 * session was renewed and the token went stale), gets a new token and tries
 * once more.
 */
async function postGrid<T>(
  env: Env,
  accountId: number,
  path: string,
  fields: Record<string, string>,
  token: string,
  tokenPage: string,
): Promise<{ Data: T[]; Total: number }> {
  for (let attempt = 0; ; attempt++) {
    const body = new URLSearchParams({ __RequestVerificationToken: token, ...fields });
    const response = await radiusFetch(env, accountId, path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    });
    const isJson = (response.headers.get("Content-Type") ?? "").includes("json");
    if (response.ok && isJson) {
      const data = (await response.json()) as { Data?: unknown; Total?: unknown; Errors?: unknown };
      if (!Array.isArray(data.Data) || typeof data.Total !== "number") {
        throw new RadiusDataError(`Unexpected response from Radius ${path}`);
      }
      if (data.Errors) throw new RadiusDataError(`Radius ${path} reported errors: ${JSON.stringify(data.Errors)}`);
      return { Data: data.Data as T[], Total: data.Total };
    }
    if (attempt > 0) throw new RadiusDataError(`Radius ${path} answered HTTP ${response.status}`);
    token = verificationToken(await getPage(env, accountId, tokenPage));
  }
}

interface RawLevel {
  MembershipGradeRangeId: number;
  Name: string;
  StartingGrade: number;
  EndingGrade: number;
  InCenterRatio: number;
  OnlineRatio: number;
}

/**
 * Reads the center's levels and ratios from Center Settings, where Radius
 * embeds them in the page as `radius.utilities.levels.push({...})` calls.
 * Also returns the page's anti-forgery token, so a following POST doesn't
 * need another page load.
 */
export async function fetchLevels(
  env: Env,
  accountId: number,
  centerId: number,
): Promise<{ levels: Level[]; token: string; tokenPage: string }> {
  const tokenPage = `/Membership/CenterSettings/${centerId}`;
  const html = await getPage(env, accountId, tokenPage);
  const levels: Level[] = [];
  for (const m of html.matchAll(/radius\.utilities\.levels\.push\((\{.*?\})\);/g)) {
    const raw = JSON.parse(m[1]!) as RawLevel;
    if (typeof raw.InCenterRatio !== "number" || typeof raw.StartingGrade !== "number") {
      throw new RadiusDataError("Unexpected level in Radius' Center Settings");
    }
    levels.push({
      id: raw.MembershipGradeRangeId,
      name: raw.Name,
      firstGrade: radiusSettingGrade(raw.StartingGrade),
      lastGrade: radiusSettingGrade(raw.EndingGrade),
      inCenterRatio: raw.InCenterRatio,
      onlineRatio: raw.OnlineRatio,
    });
  }
  if (levels.length === 0) throw new RadiusDataError("No levels found in Radius' Center Settings");
  levels.sort((a, b) => a.firstGrade - b.firstGrade);
  return { levels, token: verificationToken(html), tokenPage };
}

interface RawAppointment {
  StudentId: number;
  AppointmentDateString: string;
  AppointmentTimeString: string;
  SessionDuration: string;
  SessionStatus: string;
  DeliveryMethod: string;
  Grade: string | null;
  SessionType: string;
}

const PAGE_SIZE = 1000;

/**
 * Reads appointments from Appointment Management for a range of dates
 * (inclusive, 'YYYY-MM-DD'), all statuses. A week is about 60–100
 * appointments, so this is usually one request.
 */
export async function fetchAppointments(
  env: Env,
  accountId: number,
  range: { start: string; end: string },
  auth: { token: string; tokenPage: string },
): Promise<Appointment[]> {
  const out: Appointment[] = [];
  for (let page = 1; ; page++) {
    const { Data, Total } = await postGrid<RawAppointment>(
      env,
      accountId,
      "/AppointmentManagement/GetAppointments",
      {
        sort: "",
        page: String(page),
        pageSize: String(PAGE_SIZE),
        group: "",
        filter: "",
        startDate: range.start,
        endDate: range.end,
        appointmentDateType: "0", // by appointment date
        isSearchAction: "true",
      },
      auth.token,
      auth.tokenPage,
    );
    for (const raw of Data) {
      const minutes = Number(raw.SessionDuration);
      if (typeof raw.StudentId !== "number" || !Number.isFinite(minutes)) {
        throw new RadiusDataError("Unexpected appointment from Radius");
      }
      out.push({
        studentId: raw.StudentId,
        date: parseUsDate(raw.AppointmentDateString),
        start: parseUsTime(raw.AppointmentTimeString),
        minutes,
        status: raw.SessionStatus,
        online: raw.DeliveryMethod !== "In-Center",
        grade: raw.Grade == null ? null : parseGrade(raw.Grade),
        sessionType: raw.SessionType,
      });
    }
    if (out.length >= Total || Data.length === 0) return out;
  }
}
