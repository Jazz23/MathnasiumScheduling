// One-off: copies the Cloudflare D1 database into a stage's DynamoDB table,
// for the move to AWS. Reads D1 with Wrangler (fetched by bunx, using the
// wrangler.jsonc from the `main` branch) and writes with the AWS credentials
// in your environment.
//
//   bun run import-d1 <TABLE_NAME> [d1-database-name]
//
// Stored passwords are copied as they are, so the stage must use the same
// RADIUS_CREDENTIAL_KEY as the Worker did. Existing items with the same keys
// are overwritten; nothing else in the table is touched.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchWrite, keys, putItem, type Item } from "../server/db";

const [tableName, database = "mathnasium-scheduling"] = process.argv.slice(2);
if (!tableName) {
  console.error("Usage: bun run import-d1 <TABLE_NAME> [d1-database-name]");
  process.exit(1);
}
process.env.TABLE_NAME = tableName;

const configDir = mkdtempSync(join(tmpdir(), "import-d1-"));
const config = join(configDir, "wrangler.jsonc");
writeFileSync(config, execFileSync("git", ["show", "main:wrangler.jsonc"]));

type Row = Record<string, unknown>;
function select(sql: string): Row[] {
  const out = execFileSync(
    "bunx",
    ["wrangler@4", "d1", "execute", database, "--remote", "--json", "--config", config, "--command", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return (JSON.parse(out) as { results: Row[] }[])[0]!.results;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const items: Item[] = [];

// Accounts, sessions and Sling links.
const accounts = select("SELECT * FROM radius_accounts");
for (const a of accounts) {
  const id = Number(a.id);
  items.push({
    ...keys.account(id),
    id,
    username: a.username,
    passwordCiphertext: a.password_ciphertext,
    passwordIv: a.password_iv,
    radiusCookies: a.radius_cookies ?? null,
    radiusCookiesUpdatedAt: n(a.radius_cookies_updated_at),
    createdAt: Number(a.created_at),
    updatedAt: Number(a.updated_at),
  });
  items.push({ ...keys.username(String(a.username)), accountId: id });
}
for (const s of select("SELECT * FROM sessions WHERE expires_at > unixepoch()")) {
  items.push({ ...keys.session(String(s.token_hash)), accountId: Number(s.account_id), expiresAt: Number(s.expires_at), ttl: Number(s.expires_at) });
}
for (const s of select("SELECT * FROM sling_accounts")) {
  items.push({
    ...keys.sling(Number(s.account_id)),
    email: s.email,
    passwordCiphertext: s.password_ciphertext,
    passwordIv: s.password_iv,
    slingToken: s.sling_token ?? null,
    orgId: n(s.org_id),
    slingTokenUpdatedAt: n(s.sling_token_updated_at),
    createdAt: Number(s.created_at),
    updatedAt: Number(s.updated_at),
  });
}

// Center settings and opening hours.
const settings = select("SELECT * FROM center_settings WHERE id = 1")[0];
if (settings) {
  items.push({
    ...keys.settings(),
    settings: {
      radiusCenterId: n(settings.radius_center_id),
      timezone: settings.timezone,
      minStaffOnSite: n(settings.min_staff_on_site),
      minSupervisorsOnSite: n(settings.min_supervisors_on_site),
      minShiftMinutes: n(settings.min_shift_minutes),
      maxShiftMinutes: n(settings.max_shift_minutes),
      maxShiftsPerDay: n(settings.max_shifts_per_day),
      setupMinutes: n(settings.setup_minutes),
      cleanupMinutes: n(settings.cleanup_minutes),
      breakAfterMinutes: n(settings.break_after_minutes),
      breakMinutes: n(settings.break_minutes),
      homeTravelMinutes: n(settings.home_travel_minutes),
      publishLeadDays: n(settings.publish_lead_days),
      generateWeekday: n(settings.generate_weekday),
      slingCenterLocationId: n(settings.sling_center_location_id),
      slingRemoteLocationId: n(settings.sling_remote_location_id),
    },
    hours: select("SELECT * FROM operating_hours ORDER BY weekday, open_time").map((h) => ({
      weekday: Number(h.weekday),
      open: h.open_time,
      close: h.close_time,
    })),
    updatedAt: Number(settings.updated_at),
  });
}

// School programs.
const sessions = select("SELECT * FROM program_sessions ORDER BY weekday, start_time");
const programs = select("SELECT * FROM school_programs");
for (const p of programs) {
  const id = Number(p.id);
  items.push({
    ...keys.program(id),
    id,
    name: p.name,
    slingLocationId: n(p.sling_location_id),
    instructorsNeeded: Number(p.instructors_needed),
    travelMinutes: Number(p.travel_minutes),
    active: !!p.active,
    sessions: sessions
      .filter((s) => Number(s.program_id) === id)
      .map((s) => ({ weekday: Number(s.weekday), start: s.start_time, end: s.end_time })),
    createdAt: Number(p.created_at),
    updatedAt: Number(p.updated_at),
  });
}

// The roster.
const employeePrograms = select("SELECT * FROM employee_programs");
const availability = select("SELECT * FROM availability ORDER BY effective_from, weekday, start_time");
const preferences = select("SELECT * FROM employee_preferences ORDER BY weekday, start_time");
for (const e of select("SELECT * FROM employees")) {
  const id = Number(e.sling_user_id);
  const patterns: { effectiveFrom: string; windows: { weekday: number; start: string; end: string }[] }[] = [];
  for (const a of availability.filter((a) => Number(a.sling_user_id) === id)) {
    let pattern = patterns.find((p) => p.effectiveFrom === a.effective_from);
    if (!pattern) patterns.push((pattern = { effectiveFrom: String(a.effective_from), windows: [] }));
    pattern.windows.push({ weekday: Number(a.weekday), start: String(a.start_time), end: String(a.end_time) });
  }
  items.push({
    ...keys.employee(id),
    slingUserId: id,
    name: e.name,
    email: e.email ?? null,
    active: !!e.active,
    slingPositionIds: JSON.parse(String(e.sling_position_ids)),
    role: e.role,
    maxGrade: n(e.max_grade),
    testPrep: !!e.test_prep,
    assessments: !!e.assessments,
    teachingLimitPct: n(e.teaching_limit_pct),
    canWorkRemote: !!e.can_work_remote,
    priority: Number(e.priority),
    minHours: n(e.min_hours),
    preferredHours: n(e.preferred_hours),
    maxHours: n(e.max_hours),
    minShiftMinutes: n(e.min_shift_minutes),
    wfhWeekdays: JSON.parse(String(e.wfh_weekdays)),
    schedulable: !!e.schedulable,
    notes: e.notes ?? null,
    programIds: employeePrograms.filter((p) => Number(p.sling_user_id) === id).map((p) => Number(p.program_id)),
    availability: patterns,
    preferences: preferences
      .filter((p) => Number(p.sling_user_id) === id)
      .map((p) => ({ kind: p.kind, weekday: Number(p.weekday), start: p.start_time, end: p.end_time })),
    createdAt: Number(e.created_at),
    updatedAt: Number(e.updated_at),
  });
}

await batchWrite(items.map((put) => ({ put })));

// New IDs carry on after the copied ones.
const maxId = (rows: Row[]) => Math.max(0, ...rows.map((r) => Number(r.id)));
await putItem({ pk: "COUNTER", sk: "account", value: maxId(accounts) });
await putItem({ pk: "COUNTER", sk: "program", value: maxId(programs) });

console.log(`Copied ${items.length} items into ${tableName}.`);
