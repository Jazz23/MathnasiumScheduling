import { useEffect, useState } from "react";
import { addDays, api, formatDate, formatTime, localToday, mondayOf, type Draft, type DraftShift } from "./api";

const WHERE: Record<DraftShift["where"], string> = { center: "Center", remote: "Remote", program: "" };

const hours = (n: number) => `${+n.toFixed(2)} h`;

// A draft schedule for a week (feature 6): generated on request from Radius'
// appointments, Sling's existing shifts and time off, and the setup in the
// Center and Roster tabs. Not published anywhere yet.
export function DraftView() {
  const [start, setStart] = useState(() => addDays(mondayOf(localToday()), 7));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadedWeek, setLoadedWeek] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ start: string; message: string } | null>(null);
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

  async function generate() {
    setBusy(true);
    setFailure(null);
    try {
      const { draft } = await api<{ draft: Draft }>(`/api/drafts/${start}/generate`, { method: "POST" });
      setDraft(draft);
      setLoadedWeek(start);
    } catch (err) {
      setFailure({ start, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const shown = loadedWeek === start ? draft : null;
  return (
    <div className="page">
      <div className="toolbar">
        <button type="button" className="radius-secondary" onClick={() => setStart(addDays(start, -7))} disabled={busy}>
          ← Previous week
        </button>
        <strong>Week of {formatDate(start)}</strong>
        <button type="button" className="radius-secondary" onClick={() => setStart(addDays(start, 7))} disabled={busy}>
          Next week →
        </button>
        <button type="button" className="radius-button" onClick={generate} disabled={busy || loading}>
          {busy ? "Generating…" : shown ? "Generate again" : "Generate draft"}
        </button>
        {busy && <span className="radius-note">Reading Radius and Sling, then solving. This can take up to a minute.</span>}
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
      {shown && <DraftWeek draft={shown} />}
    </div>
  );
}

function DraftWeek({ draft }: { draft: Draft }) {
  const dates = draft.coverage.map((c) => c.date);
  const people = draft.employees.filter((e) => e.draftedHours > 0 || e.existingHours > 0 || e.notes.length > 0);
  const generated = new Date(draft.generatedAt * 1000).toLocaleString();
  const programName = new Map(draft.programs.map((p) => [p.programId, p.name]));

  return (
    <>
      <p className="radius-note">
        Generated {generated}. Solver: {draft.status.toLowerCase()} in {draft.solveSeconds} s. {draft.shifts.length} new
        shifts, not in Sling.
      </p>
      {draft.warnings.length > 0 && (
        <ul className="plain-list warn">
          {draft.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <h3>Shifts</h3>
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
            {people.map((e) => (
              <tr key={e.slingUserId}>
                <th>{e.name}</th>
                {dates.map((d) => (
                  <td key={d}>
                    {draft.shifts
                      .filter((s) => s.slingUserId === e.slingUserId && s.date === d)
                      .map((s, i) => (
                        <div key={i} className={s.breakMissed ? "warn" : undefined}>
                          {formatTime(s.start)}–{formatTime(s.end === "24:00" ? "00:00" : s.end)}{" "}
                          {s.where === "program" ? programName.get(s.programId!) : WHERE[s.where]}
                          {s.breakStart && <span className="radius-note"> · break {formatTime(s.breakStart)}</span>}
                          {s.breakMissed && " · no break fits"}
                        </div>
                      ))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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

      <h3>Coverage</h3>
      <div className="legend radius-note">
        Each cell: <b>instructors needed</b> · <b>people at the center</b> (drafted and already in Sling). Red: students
        not covered, or below the people or supervisor rule while open; hover for why. Grey: closed.
      </div>
      <CoverageGrid draft={draft} />

      <h3>Hours</h3>
      <table className="demand-grid">
        <thead>
          <tr>
            <th />
            <th>Drafted</th>
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

function CoverageGrid({ draft }: { draft: Draft }) {
  const times = [...new Set(draft.coverage.flatMap((c) => c.blocks.map((b) => b.time)))].sort();
  if (times.length === 0) return <p className="radius-note">Nothing to cover this week.</p>;
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
                const detail = [
                  `${formatDate(c.date)} ${formatTime(time)}`,
                  `Instructors needed: ${b.neededInCenter} in center${b.neededOnline ? `, ${b.neededOnline} online` : ""}`,
                  `At the center: ${b.onSite} (${b.supervisors} supervisors)${b.remote ? `, ${b.remote} remote` : ""}`,
                  ...b.gaps,
                ].join("\n");
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
