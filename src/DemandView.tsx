import { useEffect, useState } from "react";
import { addDays, api, formatDate, formatTime, localToday, mondayOf, type Demand, type DemandBlock } from "./api";

// Booked demand for a week, per 15-minute block: students and the instructors
// they need at Radius' ratios, next to who's on Sling's schedule at the center.
export function DemandView() {
  const [start, setStart] = useState(() => mondayOf(localToday()));
  const [data, setData] = useState<Demand | null>(null);
  // Errors are kept with the week they belong to, so changing week clears them.
  const [failure, setFailure] = useState<{ start: string; message: string } | null>(null);
  const error = failure?.start === start ? failure.message : null;
  const loading = !error && data?.start !== start;

  useEffect(() => {
    let cancelled = false;
    api<Demand>(`/api/demand?start=${start}&days=7`).then(
      (d) => !cancelled && setData(d),
      (err: Error) => !cancelled && setFailure({ start, message: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [start]);

  return (
    <div className="page">
      <div className="toolbar">
        <button type="button" className="radius-secondary" onClick={() => setStart(addDays(start, -7))} disabled={loading}>
          ← Previous week
        </button>
        <strong>Week of {formatDate(start)}</strong>
        <button type="button" className="radius-secondary" onClick={() => setStart(addDays(start, 7))} disabled={loading}>
          Next week →
        </button>
        <button type="button" className="radius-secondary" onClick={() => setStart(mondayOf(localToday()))} disabled={loading}>
          This week
        </button>
        {loading && <span className="radius-note">Reading Radius and Sling…</span>}
      </div>
      {error && (
        <p className="radius-error" role="alert">
          {error}
        </p>
      )}
      {data && data.start === start && <DemandWeek data={data} />}
    </div>
  );
}

function sumStudents(block: DemandBlock) {
  let inCenter = 0;
  let online = 0;
  for (const c of Object.values(block.students)) {
    inCenter += c.inCenter;
    online += c.online;
  }
  return { inCenter, online };
}

function DemandWeek({ data }: { data: Demand }) {
  const levelName = new Map(data.levels.map((l) => [String(l.id), l.name]));
  const times = data.days[0]?.blocks.map((b) => b.time) ?? [];
  const isOpen = (date: string, time: string) =>
    data.hours.find((h) => h.date === date)?.open.some((h) => time >= h.open && time < h.close) ?? false;
  const statuses = Object.entries(data.appointmentsByStatus)
    .map(([s, n]) => `${n} ${s.toLowerCase()}`)
    .join(", ");

  return (
    <>
      <p className="radius-note">
        Appointments this week: {statuses || "none"}. Counted as demand: scheduled, attended and drop-in.
        {data.onlineAppointments > 0 && ` ${data.onlineAppointments} online.`}
        {data.unknownGrades > 0 && ` ${data.unknownGrades} with a grade the app doesn't recognize (not counted).`}
      </p>
      {data.slingError && <p className="radius-error">Sling: {data.slingError}</p>}
      {!data.centerLocationMapped && !data.slingError && (
        <p className="radius-note">
          Choose the center's Sling location in the Center tab to see who's scheduled next to the demand.
        </p>
      )}
      <div className="legend radius-note">
        Each cell: <b>students</b> at the center · <b>instructors needed</b> · <b>on Sling</b> at the center. Red: fewer
        people on Sling than instructors needed or than the {data.minStaffOnSite}-person minimum while open. Grey:
        closed.
      </div>
      <div className="grid-scroll">
        <table className="demand-grid">
          <thead>
            <tr>
              <th />
              {data.days.map((d) => (
                <th key={d.date}>{formatDate(d.date)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((time, row) => (
              <tr key={time}>
                <th>{time.endsWith(":00") ? formatTime(time) : ""}</th>
                {data.days.map((d) => {
                  const block = d.blocks[row]!;
                  const open = isOpen(d.date, time);
                  const { inCenter, online } = sumStudents(block);
                  const needed = Math.ceil(block.instructorsInCenter - 1e-9);
                  const staff = block.staff;
                  const short =
                    data.centerLocationMapped &&
                    staff !== null &&
                    (staff.onSite < needed ||
                      (open && (staff.onSite < data.minStaffOnSite || staff.supervisors < data.minSupervisorsOnSite)));
                  const detail = [
                    `${formatDate(d.date)} ${formatTime(time)}`,
                    ...Object.entries(block.students).map(
                      ([id, c]) => `${levelName.get(id) ?? id}: ${c.inCenter} in center${c.online ? `, ${c.online} online` : ""}`,
                    ),
                    block.unknownLevel ? `Unknown grade: ${block.unknownLevel}` : "",
                    `Instructors needed: ${block.instructorsInCenter.toFixed(2)} in center${block.instructorsOnline ? `, ${block.instructorsOnline.toFixed(2)} online` : ""}`,
                    staff ? `On Sling: ${staff.onSite} at the center (${staff.supervisors} supervisors), ${staff.remote} remote` : "",
                  ]
                    .filter(Boolean)
                    .join("\n");
                  const empty = inCenter + online + block.unknownLevel === 0 && !staff?.onSite;
                  return (
                    <td key={d.date} className={`${open ? "" : "closed"} ${short ? "short" : ""}`} title={detail}>
                      {!empty && (
                        <>
                          <b>{inCenter + online}</b>
                          <span> · {needed}</span>
                          {staff && data.centerLocationMapped && <span> · {staff.onSite}</span>}
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

      <details>
        <summary>Time off ({data.timeOff.length})</summary>
        <ul className="plain-list">
          {data.timeOff.map((t, i) => (
            <li key={i}>
              {t.name}: {formatDate(t.startDate)}
              {t.startTime ? ` ${formatTime(t.startTime)}` : ""} – {formatDate(t.endDate)}
              {t.endTime ? ` ${formatTime(t.endTime)}` : ""}
              {!t.approved && " (not approved yet)"}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Shifts on Sling ({data.shifts.length})</summary>
        <ul className="plain-list">
          {data.shifts.map((s, i) => (
            <li key={i}>
              {formatDate(s.date)} {formatTime(s.start)}–{formatTime(s.end)}: {s.name}, {s.where}
              {s.repeating ? " (repeating)" : ""}
              {s.status !== "published" ? ` (${s.status})` : ""}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
