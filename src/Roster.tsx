import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  gradeLabel,
  localToday,
  ROLE_LABELS,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  type AvailabilitySuggestion,
  type Employee,
  type Role,
  type SchoolProgram,
  type Setup,
  type Window,
} from "./api";
import { WindowsEditor } from "./WindowsEditor";

// The roster (feature 2) with each person's availability and preferences
// (feature 3). People come from Sling; everything else is entered here.
export function Roster() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [programs, setPrograms] = useState<SchoolProgram[]>([]);
  const [suggestions, setSuggestions] = useState<AvailabilitySuggestion[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ employees: Employee[] }>("/api/roster").then(
      (r) => setEmployees(r.employees),
      (err: Error) => setStatus(err.message),
    );
    api<Setup>("/api/setup").then((s) => setPrograms(s.programs), () => {});
  }, []);

  async function sync() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ added: number; updated: number; employees: Employee[] }>("/api/roster/sync", { method: "POST" });
      setEmployees(r.employees);
      setStatus(`Imported from Sling: ${r.added} added, ${r.updated} updated.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't read Sling.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSuggestions() {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ suggestions: AvailabilitySuggestion[] }>("/api/roster/availability-suggestions?weeks=8");
      setSuggestions(r.suggestions);
      setStatus("Loaded each person's usual times from the last 8 weeks of Sling shifts. Open a person to use them.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't read Sling.");
    } finally {
      setBusy(false);
    }
  }

  if (!employees) return <p className="radius-note page">{status ?? "Loading…"}</p>;
  const shown = employees.filter((e) => showInactive || e.active);

  return (
    <div className="page">
      <div className="toolbar">
        <button type="button" className="radius-button" onClick={sync} disabled={busy}>
          Import from Sling
        </button>
        <button type="button" className="radius-secondary" onClick={loadSuggestions} disabled={busy || employees.length === 0}>
          Suggest availability from past shifts
        </button>
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show people
          inactive in Sling
        </label>
      </div>
      {status && <p className="radius-note">{status}</p>}
      {employees.length === 0 && <p className="radius-note">No one yet. Import the roster from Sling to start.</p>}

      <table className="roster">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Teaches up to</th>
            <th>Hours (min / preferred / max)</th>
            <th>Availability</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => {
            const current = e.availability.filter((p) => p.effectiveFrom <= localToday()).at(-1);
            return (
              <tr
                key={e.slingUserId}
                className={`${open === e.slingUserId ? "selected" : ""} ${e.active && e.schedulable ? "" : "muted"}`}
                onClick={() => setOpen(open === e.slingUserId ? null : e.slingUserId)}
              >
                <td>
                  <button type="button" className="link-button">
                    {e.name}
                  </button>
                  {!e.active && " (inactive in Sling)"}
                  {e.active && !e.schedulable && " (not scheduled)"}
                </td>
                <td>{ROLE_LABELS[e.role]}</td>
                <td>{e.maxGrade === null ? <span className="warn">Not set</span> : gradeLabel(e.maxGrade)}</td>
                <td>
                  {[e.minHours, e.preferredHours, e.maxHours].map((h) => (h === null ? "–" : h)).join(" / ")}
                </td>
                <td>{current?.windows.length ? summarize(current.windows) : <span className="warn">None entered</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {open !== null && employees.find((e) => e.slingUserId === open) && (
        <EmployeeEditor
          key={open}
          employee={employees.find((e) => e.slingUserId === open)!}
          programs={programs}
          suggestion={suggestions?.find((s) => s.slingUserId === open) ?? null}
          onSaved={setEmployees}
        />
      )}
    </div>
  );
}

function summarize(windows: Window[]): string {
  return [...new Set(windows.map((w) => w.weekday))]
    .sort()
    .map((d) => WEEKDAYS_SHORT[d])
    .join(", ");
}

const GRADES = Array.from({ length: 14 }, (_, i) => i - 1);

function EmployeeEditor({
  employee,
  programs,
  suggestion,
  onSaved,
}: {
  employee: Employee;
  programs: SchoolProgram[];
  suggestion: AvailabilitySuggestion | null;
  onSaved: (employees: Employee[]) => void;
}) {
  const [e, setE] = useState(employee);
  const [status, setStatus] = useState<string | null>(null);
  const put = async (path: string, body: unknown) => {
    setStatus(null);
    try {
      const r = await api<{ employees: Employee[] }>(`/api/roster/${employee.slingUserId}${path}`, { method: "PUT", body });
      onSaved(r.employees);
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save.");
    }
  };
  const numberOrNull = (v: string) => (v === "" ? null : Number(v));
  const toggle = (list: number[], n: number, on: boolean) => (on ? [...list, n] : list.filter((x) => x !== n));

  function saveDetails(ev: FormEvent) {
    ev.preventDefault();
    void put("", e);
  }

  return (
    <section className="panel">
      <h2>{employee.name}</h2>
      {employee.email && <p className="radius-note">{employee.email}</p>}

      <form onSubmit={saveDetails}>
        <div className="fields">
          <label>
            Role
            <select value={e.role} onChange={(x) => setE({ ...e, role: x.target.value as Role })}>
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Teaches up to
            <select value={e.maxGrade ?? ""} onChange={(x) => setE({ ...e, maxGrade: numberOrNull(x.target.value) })}>
              <option value="">Not set</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {gradeLabel(g)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Teaching limit (% of time on site)
            <input
              type="number"
              min={0}
              max={100}
              placeholder="No limit"
              value={e.teachingLimitPct ?? ""}
              onChange={(x) => setE({ ...e, teachingLimitPct: numberOrNull(x.target.value) })}
            />
          </label>
          <label>
            Minimum hours a week
            <input type="number" min={0} step={0.5} value={e.minHours ?? ""} onChange={(x) => setE({ ...e, minHours: numberOrNull(x.target.value) })} />
          </label>
          <label>
            Preferred hours a week
            <input
              type="number"
              min={0}
              step={0.5}
              value={e.preferredHours ?? ""}
              onChange={(x) => setE({ ...e, preferredHours: numberOrNull(x.target.value) })}
            />
          </label>
          <label>
            Maximum hours a week
            <input type="number" min={0} step={0.5} value={e.maxHours ?? ""} onChange={(x) => setE({ ...e, maxHours: numberOrNull(x.target.value) })} />
          </label>
          <label>
            Shortest shift they'd take (minutes)
            <input
              type="number"
              min={15}
              step={15}
              placeholder="Center's rule"
              value={e.minShiftMinutes ?? ""}
              onChange={(x) => setE({ ...e, minShiftMinutes: numberOrNull(x.target.value) })}
            />
          </label>
          <label>
            Priority (higher wins ties)
            <input type="number" value={e.priority} onChange={(x) => setE({ ...e, priority: Number(x.target.value) })} />
          </label>
        </div>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={e.schedulable} onChange={(x) => setE({ ...e, schedulable: x.target.checked })} /> Include in
            schedules
          </label>
          <label className="check">
            <input type="checkbox" checked={e.canWorkRemote} onChange={(x) => setE({ ...e, canWorkRemote: x.target.checked })} /> Can work
            from home
          </label>
          <label className="check">
            <input type="checkbox" checked={e.testPrep} onChange={(x) => setE({ ...e, testPrep: x.target.checked })} /> SAT/ACT prep
          </label>
          <label className="check">
            <input type="checkbox" checked={e.assessments} onChange={(x) => setE({ ...e, assessments: x.target.checked })} /> Runs
            assessments
          </label>
        </div>
        <fieldset>
          <legend>Days they'd rather work from home</legend>
          {WEEKDAYS.map((_, i) => (
            <label key={i} className="check">
              <input
                type="checkbox"
                checked={e.wfhWeekdays.includes(i)}
                onChange={(x) => setE({ ...e, wfhWeekdays: toggle(e.wfhWeekdays, i, x.target.checked) })}
              />{" "}
              {WEEKDAYS_SHORT[i]}
            </label>
          ))}
        </fieldset>
        {programs.length > 0 && (
          <fieldset>
            <legend>First choice for these school programs</legend>
            {programs.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={e.programIds.includes(p.id)}
                  onChange={(x) => setE({ ...e, programIds: toggle(e.programIds, p.id, x.target.checked) })}
                />{" "}
                {p.name}
              </label>
            ))}
          </fieldset>
        )}
        <label className="block">
          Notes
          <textarea value={e.notes ?? ""} onChange={(x) => setE({ ...e, notes: x.target.value || null })} rows={2} />
        </label>
        <div className="radius-actions">
          <button type="submit" className="radius-button">
            Save details
          </button>
          {status && <span className="radius-note">{status}</span>}
        </div>
      </form>

      <AvailabilityEditor employee={employee} suggestion={suggestion} save={(body) => put("/availability", body)} />

      <h3>Preferences</h3>
      <p className="radius-note">Times they'd like to work or avoid. The scheduler tries to honor these but may not.</p>
      <PreferencesEditor employee={employee} save={(preferences) => put("/preferences", { preferences })} />
    </section>
  );
}

function AvailabilityEditor({
  employee,
  suggestion,
  save,
}: {
  employee: Employee;
  suggestion: AvailabilitySuggestion | null;
  save: (body: { effectiveFrom: string; windows: Window[] }) => Promise<void>;
}) {
  const latest = employee.availability.at(-1);
  const [effectiveFrom, setEffectiveFrom] = useState(latest?.effectiveFrom ?? localToday());
  const [windows, setWindows] = useState<Window[]>(latest?.windows ?? []);

  const pick = (date: string) => {
    setEffectiveFrom(date);
    const existing = employee.availability.find((p) => p.effectiveFrom === date);
    if (existing) setWindows(existing.windows);
  };

  return (
    <>
      <h3>Availability</h3>
      <p className="radius-note">
        When they can work each week. The scheduler never schedules anyone outside these times. A new starting date keeps the
        old times for earlier weeks (for example a new school term).
      </p>
      {employee.availability.length > 1 && (
        <p className="radius-note">
          Saved patterns:{" "}
          {employee.availability.map((p) => (
            <button key={p.effectiveFrom} type="button" className="link-button" onClick={() => pick(p.effectiveFrom)}>
              from {p.effectiveFrom}
            </button>
          ))}
        </p>
      )}
      <label>
        Starting{" "}
        <input type="date" value={effectiveFrom} onChange={(e) => e.target.value && setEffectiveFrom(e.target.value)} />
      </label>
      {suggestion && (
        <p className="radius-note">
          Worked in the last {suggestion.weeks} weeks:{" "}
          {suggestion.windows.map((w) => `${WEEKDAYS_SHORT[w.weekday]} ${w.start}–${w.end} (${w.timesWorked}×)`).join(", ")}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => setWindows(suggestion.windows.map(({ weekday, start, end }) => ({ weekday, start, end })))}
          >
            Use these
          </button>
        </p>
      )}
      <WindowsEditor value={windows} onChange={setWindows} blank={{ weekday: 1, start: "13:00", end: "18:00" }} addLabel="Add available time" />
      <div className="radius-actions">
        <button type="button" className="radius-button" onClick={() => void save({ effectiveFrom, windows })}>
          Save availability
        </button>
      </div>
    </>
  );
}

type Preference = Window & { kind: "prefer" | "avoid" };

function PreferencesEditor({ employee, save }: { employee: Employee; save: (p: Preference[]) => Promise<void> }) {
  const [prefs, setPrefs] = useState<Preference[]>(employee.preferences);
  return (
    <>
      <WindowsEditor<Preference>
        value={prefs}
        onChange={setPrefs}
        blank={{ kind: "avoid", weekday: 1, start: "13:00", end: "18:00" }}
        addLabel="Add preference"
        extra={(row, update) => (
          <select value={row.kind} onChange={(e) => update({ kind: e.target.value as Preference["kind"] })} aria-label="Prefer or avoid">
            <option value="prefer">Prefers</option>
            <option value="avoid">Avoids</option>
          </select>
        )}
      />
      <div className="radius-actions">
        <button type="button" className="radius-button" onClick={() => void save(prefs)}>
          Save preferences
        </button>
      </div>
    </>
  );
}
