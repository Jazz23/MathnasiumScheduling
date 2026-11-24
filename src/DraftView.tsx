import { useEffect, useState, type FormEvent } from "react";
import { addDays, api, formatDate, formatTime, localToday, mondayOf, type Draft, type DraftShift, type ShiftEdit } from "./api";

const WHERE: Record<DraftShift["where"], string> = { center: "Center", remote: "Remote", program: "" };

const hours = (n: number) => `${+n.toFixed(2)} h`;
const endLabel = (end: string) => formatTime(end === "24:00" ? "00:00" : end);
const toEdit = ({ id, slingUserId, date, start, end, where, programId, locked }: DraftShift): ShiftEdit => ({
  id,
  slingUserId,
  date,
  start,
  end,
  where,
  programId,
  locked,
});

// A shift open in the editor: an existing one (with its id) or a new one.
type Editing = ShiftEdit & { isNew: boolean };

// A week's draft schedule (features 6 and 7): generated from Radius'
// appointments, Sling's existing shifts and time off, and the Center and
// Roster tabs; then edited by hand. Locked shifts are kept when it's generated
// again. Not published anywhere yet.
export function DraftView() {
  const [start, setStart] = useState(() => addDays(mondayOf(localToday()), 7));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [failure, setFailure] = useState<{ start: string; message: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const error = failure?.start === start ? failure.message : null;
  const loading = loadedWeek !== start && !error;

  useEffect(() => {
    let cancelled = false;
    api<{ draft: Draft | null }>(`/api/drafts/${start}`).then(
      ({ draft }) => {
        if (cancelled) return;
        setDraft(draft);
        setLoadedWeek(start);
      },
      (err: Error) => !cancelled && setFailure({ start, message: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [start]);

  function changeWeek(week: string) {
    setEditing(null);
    setStart(week);
  }

  async function run(kind: "generate" | "save", request: () => Promise<{ draft: Draft }>): Promise<boolean> {
    setBusy(kind);
    setFailure(null);
    try {
      const { draft } = await request();
      setDraft(draft);
      setLoadedWeek(start);
      return true;
    } catch (err) {
      setFailure({ start, message: (err as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const generate = () => run("generate", () => api(`/api/drafts/${start}/generate`, { method: "POST" }));
  const saveShifts = (shifts: ShiftEdit[]) => run("save", () => api(`/api/drafts/${start}/shifts`, { method: "PUT", body: { shifts } }));

  const shown = loadedWeek === start ? draft : null;
  const lockedCount = shown?.shifts.filter((s) => s.locked).length ?? 0;

  async function saveEdit(edit: Editing) {
    if (!shown) return;
    const { isNew: _isNew, ...shift } = edit; // a new shift has no id; the server gives it one
    const others = shown.shifts.filter((s) => s.id !== shift.id).map(toEdit);
    if (await saveShifts([...others, shift])) setEditing(null);
  }
  async function removeShift(id: string) {
    if (!shown) return;
    if (await saveShifts(shown.shifts.filter((s) => s.id !== id).map(toEdit))) setEditing(null);
  }
  const lockAll = (locked: boolean) => shown && saveShifts(shown.shifts.map((s) => ({ ...toEdit(s), locked })));

  return (
    <div className="page">
      <div className="toolbar">
        <button type="button" className="radius-secondary" onClick={() => changeWeek(addDays(start, -7))} disabled={!!busy}>
          ← Previous week
        </button>
        <strong>Week of {formatDate(start)}</strong>
        <button type="button" className="radius-secondary" onClick={() => changeWeek(addDays(start, 7))} disabled={!!busy}>
          Next week →
        </button>
        <button type="button" className="radius-button" onClick={generate} disabled={!!busy || loading}>
          {busy === "generate"
            ? "Generating…"
            : !shown
              ? "Generate draft"
              : lockedCount
                ? `Generate again, keeping ${lockedCount} locked`
                : "Generate again"}
        </button>
        {shown && shown.shifts.length > 0 && (
          <>
            <button type="button" className="radius-secondary" onClick={() => lockAll(true)} disabled={!!busy}>
              Lock all
            </button>
            <button type="button" className="radius-secondary" onClick={() => lockAll(false)} disabled={!!busy || lockedCount === 0}>
              Unlock all
            </button>
          </>
        )}
        {busy === "generate" && <span className="radius-note">Reading Radius and Sling, then solving. This can take up to a minute.</span>}
        {busy === "save" && <span className="radius-note">Checking the changes…</span>}
      </div>
      {error && (
        <p className="radius-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="radius-note">Loading…</p>}
      {!loading && !shown && !error && (
        <p className="radius-note">
          No draft for this week yet. Generating one reads this week's appointments from Radius and the shifts and time off
          already in Sling, and uses the Center and Roster tabs. Nothing is sent to Sling.
        </p>
      )}
      {shown && (
        <DraftWeek
          draft={shown}
          busy={!!busy}
          editing={editing}
          onEdit={setEditing}
          onSave={saveEdit}
          onRemove={removeShift}
        />
      )}
    </div>
  );
}

function DraftWeek({
  draft,
  busy,
  editing,
  onEdit,
  onSave,
  onRemove,
}: {
  draft: Draft;
  busy: boolean;
  editing: Editing | null;
  onEdit: (e: Editing | null) => void;
  onSave: (e: Editing) => void;
  onRemove: (id: string) => void;
}) {
  const dates = draft.coverage.map((c) => c.date);
  const programName = new Map(draft.choices.programs.map((p) => [p.id, p.name]));
  // Everyone with a shift, hours or notes, then everyone else who can be given one.
  const listed = draft.employees.filter((e) => e.draftedHours > 0 || e.existingHours > 0 || e.notes.length > 0).map((e) => e.slingUserId);
  const withShifts = draft.shifts.map((s) => s.slingUserId).filter((id) => !listed.includes(id));
  const rows = [...new Set([...listed, ...withShifts])];
  const nameOf = new Map(draft.choices.people.map((p) => [p.slingUserId, p.name]));
  for (const s of draft.shifts) if (!nameOf.has(s.slingUserId)) nameOf.set(s.slingUserId, s.name);
  const others = draft.choices.people.filter((p) => !rows.includes(p.slingUserId));
  const issues = draft.shifts.filter((s) => s.issues.length > 0).length;

  const newShift = (slingUserId: number, date: string): Editing => ({
    isNew: true,
    slingUserId,
    date,
    start: "15:00",
    end: "18:00",
    where: "center",
    programId: null,
    locked: true,
  });

  return (
    <>
      <p className="radius-note">
        Radius and Sling read {new Date(draft.generatedAt * 1000).toLocaleString()}
        {draft.updatedAt !== draft.generatedAt && `, edited ${new Date(draft.updatedAt * 1000).toLocaleString()}`}. Solver:{" "}
        {draft.status.toLowerCase()} in {draft.solveSeconds} s. {draft.shifts.length} shifts, not in Sling.
        {issues > 0 && <span className="warn"> {issues} break a rule (in orange).</span>}
      </p>
      {draft.warnings.length > 0 && (
        <ul className="plain-list warn">
          {draft.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <h3>Shifts</h3>
      <p className="radius-note">
        Click a shift to change, lock or remove it, or + to add one. Edits are checked against the data read when the draft
        was generated, and your edits and added shifts are locked, so generating again keeps them.
      </p>
      <div className="grid-scroll">
        <table className="demand-grid draft-grid">
          <thead>
            <tr>
              <th />
              {dates.map((d) => (
                <th key={d}>{formatDate(d)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => (
              <tr key={id}>
                <th>{nameOf.get(id) ?? `Sling user ${id}`}</th>
                {dates.map((d) => (
                  <td key={d}>
                    {draft.shifts
                      .filter((s) => s.slingUserId === id && s.date === d)
                      .map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`shift ${s.issues.length || s.breakMissed ? "warn" : ""} ${editing?.id === s.id ? "selected" : ""}`}
                          title={[...s.issues, s.breakMissed ? "No break fits" : ""].filter(Boolean).join("\n") || undefined}
                          onClick={() => onEdit({ ...toEdit(s), isNew: false })}
                          disabled={busy}
                        >
                          {s.locked && "🔒 "}
                          {formatTime(s.start)}–{endLabel(s.end)} {s.where === "program" ? programName.get(s.programId!) : WHERE[s.where]}
                          {s.breakStart && <span className="radius-note"> · break {formatTime(s.breakStart)}</span>}
                          {s.breakMissed && " · no break fits"}
                          {s.issues.length > 0 && <span> · {s.issues.join("; ")}</span>}
                        </button>
                      ))}
                    <button type="button" className="link-button" onClick={() => onEdit(newShift(id, d))} disabled={busy} aria-label="Add a shift">
                      +
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {others.length > 0 && (
        <p className="radius-note">
          Add a shift for someone else:{" "}
          <select value="" onChange={(e) => e.target.value && onEdit(newShift(Number(e.target.value), dates[0]!))} disabled={busy}>
            <option value="">Choose a person</option>
            {others.map((p) => (
              <option key={p.slingUserId} value={p.slingUserId}>
                {p.name}
              </option>
            ))}
          </select>
        </p>
      )}
      {editing && (
        <ShiftEditor
          key={editing.id ?? "new"}
          shift={editing}
          draft={draft}
          busy={busy}
          onSave={onSave}
          onRemove={onRemove}
          onCancel={() => onEdit(null)}
        />
      )}

      {draft.programs.length > 0 && (
        <>
          <h3>School programs</h3>
          <ul className="plain-list">
            {draft.programs.map((p, i) => (
              <li key={i} className={p.short > 0 ? "warn" : undefined}>
                {formatDate(p.date)} {formatTime(p.start)}–{formatTime(p.end)} {p.name}: {p.needed} needed.{" "}
                {p.existing > 0 && `${p.existing} already in Sling. `}
                {p.drafted.length > 0 && `Drafted: ${p.drafted.join(", ")}. `}
                {p.short > 0 && `${p.short} short.`}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Coverage by time</h3>
      <div className="legend radius-note">
        Each cell: <b>instructors needed</b> · <b>people at the center</b> (draft and Sling). Red: students not covered, or
        below the people or supervisor rule while open; hover for why and who's drafted. Grey: closed.
      </div>
      <CoverageGrid draft={draft} />

      <h3>Hours</h3>
      <table className="demand-grid">
        <thead>
          <tr>
            <th />
            <th>Draft</th>
            <th>Already in Sling</th>
            <th>Min / preferred / max</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {draft.employees.map((e) => (
            <tr key={e.slingUserId}>
              <th>{e.name}</th>
              <td>{hours(e.draftedHours)}</td>
              <td>{hours(e.existingHours)}</td>
              <td>
                {e.minHours ?? "–"} / {e.preferredHours ?? "–"} / {e.maxHours ?? "–"}
              </td>
              <td className={e.notes.length ? "warn" : undefined}>{e.notes.join("; ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ShiftEditor({
  shift,
  draft,
  busy,
  onSave,
  onRemove,
  onCancel,
}: {
  shift: Editing;
  draft: Draft;
  busy: boolean;
  onSave: (e: Editing) => void;
  onRemove: (id: string) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState(shift);
  const dates = draft.coverage.map((c) => c.date);
  const place = s.where === "program" ? `program:${s.programId}` : s.where;
  const choosePlace = (value: string) =>
    value.startsWith("program:")
      ? setS({ ...s, where: "program", programId: Number(value.slice(8)) })
      : setS({ ...s, where: value as "center" | "remote", programId: null });

  function submit(e: FormEvent) {
    e.preventDefault();
    // An edited shift is locked, so generating again keeps it.
    onSave({ ...s, locked: s.locked || !shallowEqual(s, shift) });
  }

  return (
    <form className="panel subpanel shift-editor" onSubmit={submit}>
      <h4>{shift.isNew ? "Add a shift" : "Change shift"}</h4>
      <div className="fields">
        <label>
          Person{" "}
          <select value={s.slingUserId} onChange={(e) => setS({ ...s, slingUserId: Number(e.target.value) })}>
            {draft.choices.people.map((p) => (
              <option key={p.slingUserId} value={p.slingUserId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Day{" "}
          <select value={s.date} onChange={(e) => setS({ ...s, date: e.target.value })}>
            {dates.map((d) => (
              <option key={d} value={d}>
                {formatDate(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From <input type="time" step={900} value={s.start} onChange={(e) => setS({ ...s, start: e.target.value })} required />
        </label>
        <label>
          To <input type="time" step={900} value={s.end === "24:00" ? "23:59" : s.end} onChange={(e) => setS({ ...s, end: e.target.value })} required />
        </label>
        <label>
          Where{" "}
          <select value={place} onChange={(e) => choosePlace(e.target.value)}>
            <option value="center">Center</option>
            <option value="remote">Remote</option>
            {draft.choices.programs.map((p) => (
              <option key={p.id} value={`program:${p.id}`}>
                {p.name} (including the drive)
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.locked} onChange={(e) => setS({ ...s, locked: e.target.checked })} /> Locked
        </label>
      </div>
      <div className="radius-actions">
        <button type="submit" className="radius-button" disabled={busy}>
          {shift.isNew ? "Add" : "Save"}
        </button>
        {!shift.isNew && shift.id && (
          <button type="button" className="radius-secondary" onClick={() => onRemove(shift.id!)} disabled={busy}>
            Remove
          </button>
        )}
        <button type="button" className="radius-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function shallowEqual(a: Editing, b: Editing): boolean {
  return a.slingUserId === b.slingUserId && a.date === b.date && a.start === b.start && a.end === b.end && a.where === b.where && a.programId === b.programId;
}

function CoverageGrid({ draft }: { draft: Draft }) {
  const times = [...new Set(draft.coverage.flatMap((c) => c.blocks.map((b) => b.time)))].sort();
  if (times.length === 0) return <p className="radius-note">Nothing to cover this week.</p>;
  const drafted = (date: string, time: string) =>
    draft.shifts.filter((s) => s.date === date && s.where !== "program" && s.start <= time && time < s.end).map((s) => `${s.name}${s.where === "remote" ? " (remote)" : ""}`);
  return (
    <div className="grid-scroll">
      <table className="demand-grid">
        <thead>
          <tr>
            <th />
            {draft.coverage.map((c) => (
              <th key={c.date}>{formatDate(c.date)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((time) => (
            <tr key={time}>
              <th>{time.endsWith(":00") ? formatTime(time) : ""}</th>
              {draft.coverage.map((c) => {
                const b = c.blocks.find((x) => x.time === time);
                if (!b) return <td key={c.date} className="closed" />;
                const needed = b.neededInCenter + b.neededOnline;
                const short = b.gaps.length > 0;
                const names = drafted(c.date, time);
                const detail = [
                  `${formatDate(c.date)} ${formatTime(time)}`,
                  `Instructors needed: ${b.neededInCenter} in center${b.neededOnline ? `, ${b.neededOnline} online` : ""}`,
                  `At the center: ${b.onSite} (${b.supervisors} supervisors)${b.remote ? `, ${b.remote} remote` : ""}`,
                  names.length ? `Draft: ${names.join(", ")}` : "",
                  ...b.gaps,
                ]
                  .filter(Boolean)
                  .join("\n");
                const empty = needed === 0 && b.onSite === 0 && b.remote === 0;
                return (
                  <td key={c.date} className={`${b.open ? "" : "closed"} ${short ? "short" : ""}`} title={detail}>
                    {!empty && (
                      <>
                        <b>{Math.ceil(needed - 1e-9)}</b>
                        <span> · {b.onSite}</span>
                        {b.remote > 0 && <span> +{b.remote} remote</span>}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
