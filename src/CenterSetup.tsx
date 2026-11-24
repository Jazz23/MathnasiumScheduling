import { useEffect, useState, type FormEvent } from "react";
import { api, WEEKDAYS, type CenterSettings, type SchoolProgram, type Setup, type SlingGroups, type Window } from "./api";
import { WeekCalendar, type CalKind } from "./WeekCalendar";

// Center setup (feature 1): hours, presence and shift rules, Sling locations,
// and the school programs.
const OPEN_KIND: CalKind<"open">[] = [{ id: "open", label: "Open", className: "cal-available" }];
const SESSION_KIND: CalKind<"session">[] = [{ id: "session", label: "Session", className: "cal-prefer" }];
const withKind = <K extends string>(windows: Window[], kind: K) => windows.map((w) => ({ ...w, kind }));
const stripKind = (windows: Window[]): Window[] => windows.map(({ weekday, start, end }) => ({ weekday, start, end }));

export function CenterSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [groups, setGroups] = useState<SlingGroups | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Setup>("/api/setup").then(setSetup, (err: Error) => setError(err.message));
    api<SlingGroups>("/api/setup/sling-groups").then(setGroups, () => setGroups({ locations: [], positions: [] }));
  }, []);

  if (error) return <p className="radius-error page">{error}</p>;
  if (!setup) return <p className="radius-note page">Loading…</p>;
  return (
    <div className="page">
      <CenterForm setup={setup} groups={groups} onSaved={setSetup} />
      <Programs
        programs={setup.programs}
        hours={setup.hours.map((h) => ({ weekday: h.weekday, start: h.open, end: h.close }))}
        groups={groups}
        onSaved={setSetup}
      />
    </div>
  );
}

type NumberKey = { [K in keyof CenterSettings]: CenterSettings[K] extends number ? K : never }[keyof CenterSettings];

const NUMBER_FIELDS: [NumberKey, string, string?][] = [
  ["minStaffOnSite", "People at the center whenever it's open", "Someone on a break counts; someone working remotely doesn't."],
  ["minSupervisorsOnSite", "Of them, supervisors (owner or assistant center director)"],
  ["minShiftMinutes", "Shortest shift (minutes)"],
  ["maxShiftMinutes", "Longest shift (minutes)"],
  ["maxShiftsPerDay", "Shifts per person per day"],
  ["setupMinutes", "Setup before the first appointment (minutes)"],
  ["cleanupMinutes", "Cleanup after the last appointment (minutes)"],
  ["breakAfterMinutes", "Paid break for shifts of at least (minutes)"],
  ["breakMinutes", "Break length (minutes)"],
  ["homeTravelMinutes", "Travel allowance between home and the center (minutes)"],
  ["publishLeadDays", "Employees see the schedule this many days ahead"],
  ["radiusCenterId", "Radius center ID"],
];

function CenterForm({ setup, groups, onSaved }: { setup: Setup; groups: SlingGroups | null; onSaved: (s: Setup) => void }) {
  const [settings, setSettings] = useState(setup.settings);
  const [hours, setHours] = useState<Window[]>(setup.hours.map((h) => ({ weekday: h.weekday, start: h.open, end: h.close })));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const saved = await api<Setup>("/api/setup/center", { method: "PUT", body: { settings, hours } });
      onSaved(saved);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  const locationSelect = (key: "slingCenterLocationId" | "slingRemoteLocationId") => (
    <select
      value={settings[key] ?? ""}
      onChange={(e) => setSettings({ ...settings, [key]: e.target.value ? Number(e.target.value) : null })}
    >
      <option value="">Not set</option>
      {groups?.locations.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </select>
  );

  return (
    <form className="panel" onSubmit={save}>
      <h2>Center</h2>
      <h3>Opening hours</h3>
      <p className="radius-note">Days without hours are closed.</p>
      <WeekCalendar value={withKind(hours, "open")} onChange={(next) => setHours(stripKind(next))} kinds={OPEN_KIND} />

      <h3>Rules</h3>
      <div className="fields">
        {NUMBER_FIELDS.map(([key, label, hint]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              value={settings[key]}
              onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
              required
            />
            {hint && <small className="radius-note">{hint}</small>}
          </label>
        ))}
        <label>
          Generate next week's draft on
          <select value={settings.generateWeekday} onChange={(e) => setSettings({ ...settings, generateWeekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => (
              <option key={i} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Time zone
          <input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} required />
        </label>
      </div>

      <h3>Sling locations</h3>
      {groups && groups.locations.length === 0 && <p className="radius-note">Link Sling to choose its locations.</p>}
      <div className="fields">
        <label>
          The center {locationSelect("slingCenterLocationId")}
        </label>
        <label>
          Remote shifts {locationSelect("slingRemoteLocationId")}
        </label>
      </div>

      <div className="radius-actions">
        <button type="submit" className="radius-button" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {status && <span className="radius-note">{status}</span>}
      </div>
    </form>
  );
}

const NEW_PROGRAM: Omit<SchoolProgram, "id"> = {
  name: "",
  slingLocationId: null,
  instructorsNeeded: 2,
  travelMinutes: 10,
  active: true,
  sessions: [],
};

function Programs({
  programs,
  hours,
  groups,
  onSaved,
}: {
  programs: SchoolProgram[];
  hours: Window[];
  groups: SlingGroups | null;
  onSaved: (s: Setup) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="panel">
      <h2>School programs</h2>
      {programs.map((p) => (
        <ProgramForm key={p.id} program={p} hours={hours} groups={groups} onSaved={onSaved} />
      ))}
      {adding ? (
        <ProgramForm
          program={NEW_PROGRAM}
          hours={hours}
          groups={groups}
          onSaved={(s) => {
            setAdding(false);
            onSaved(s);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="radius-secondary" onClick={() => setAdding(true)}>
          Add a program
        </button>
      )}
    </section>
  );
}

function ProgramForm({
  program,
  hours,
  groups,
  onSaved,
  onCancel,
}: {
  program: Omit<SchoolProgram, "id"> & { id?: number };
  hours: Window[];
  groups: SlingGroups | null;
  onSaved: (s: Setup) => void;
  onCancel?: () => void;
}) {
  const [p, setP] = useState(program);
  const [status, setStatus] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      const saved = await api<Setup>(p.id ? `/api/setup/programs/${p.id}` : "/api/setup/programs", {
        method: p.id ? "PUT" : "POST",
        body: p,
      });
      onSaved(saved);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  async function remove() {
    if (!p.id || !confirm(`Delete ${p.name}?`)) return;
    onSaved(await api<Setup>(`/api/setup/programs/${p.id}`, { method: "DELETE" }));
  }

  return (
    <form className="subpanel" onSubmit={save}>
      <div className="fields">
        <label>
          Name
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} required />
        </label>
        <label>
          Sling location
          <select value={p.slingLocationId ?? ""} onChange={(e) => setP({ ...p, slingLocationId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not set</option>
            {groups?.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Instructors needed
          <input type="number" min={1} value={p.instructorsNeeded} onChange={(e) => setP({ ...p, instructorsNeeded: Number(e.target.value) })} />
        </label>
        <label>
          Drive from the center (minutes, each way)
          <input type="number" min={0} value={p.travelMinutes} onChange={(e) => setP({ ...p, travelMinutes: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={p.active} onChange={(e) => setP({ ...p, active: e.target.checked })} /> Active
        </label>
      </div>
      <h4>Sessions</h4>
      <WeekCalendar
        value={withKind(p.sessions, "session")}
        onChange={(next) => setP({ ...p, sessions: stripKind(next) })}
        kinds={SESSION_KIND}
        backdrop={hours}
        backdropLabel="Center open"
      />
      <div className="radius-actions">
        <button type="submit" className="radius-button">
          Save program
        </button>
        {onCancel && (
          <button type="button" className="radius-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        {p.id && (
          <button type="button" className="radius-secondary" onClick={remove}>
            Delete
          </button>
        )}
        {status && <span className="radius-note">{status}</span>}
      </div>
    </form>
  );
}
