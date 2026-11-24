import { WEEKDAYS, type Window } from "./api";

// Edits a list of weekly windows ({ weekday, start, end }), one row each.
// `extra` renders more controls for a row (for example prefer/avoid).
export function WindowsEditor<T extends Window>({
  value,
  onChange,
  blank,
  addLabel = "Add time",
  extra,
}: {
  value: T[];
  onChange: (next: T[]) => void;
  blank: T;
  addLabel?: string;
  extra?: (row: T, update: (patch: Partial<T>) => void) => React.ReactNode;
}) {
  const update = (i: number, patch: Partial<T>) => onChange(value.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  return (
    <div className="windows">
      {value.map((w, i) => (
        <div className="window-row" key={i}>
          {extra?.(w, (patch) => update(i, patch))}
          <select value={w.weekday} onChange={(e) => update(i, { weekday: Number(e.target.value) } as Partial<T>)} aria-label="Day">
            {WEEKDAYS.map((d, n) => (
              <option key={n} value={n}>
                {d}
              </option>
            ))}
          </select>
          <input type="time" step={900} value={w.start} onChange={(e) => update(i, { start: e.target.value } as Partial<T>)} aria-label="From" />
          <span>to</span>
          <input type="time" step={900} value={w.end} onChange={(e) => update(i, { end: e.target.value } as Partial<T>)} aria-label="To" />
          <button type="button" className="link-button" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="link-button" onClick={() => onChange([...value, { ...blank }])}>
        + {addLabel}
      </button>
    </div>
  );
}
