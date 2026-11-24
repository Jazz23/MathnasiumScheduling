import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { WEEKDAYS_SHORT, formatTime, type Window } from "./api";

// A week view you draw on like Google Calendar: drag on an empty spot to add
// a block, drag a block to move it (to another day too), drag its top or
// bottom edge to resize it, and click it to change its kind or delete it.
// Times snap to 15 minutes. Overlapping blocks of the same kind merge, and a
// block drawn over another kind in the same layer replaces that part of it.
// Kinds in different layers (availability under preferences) overlap freely;
// only the layer of the kind being drawn can be edited.

export type CalEvent<K extends string> = Window & { kind: K };
export interface CalKind<K extends string> {
  id: K;
  label: string;
  /** CSS class giving the block its color. */
  className: string;
  /** Kinds in one layer replace each other; layers stack. Defaults to one layer. */
  layer?: string;
  /** Drawn narrower, to the right, so the layer beneath shows. */
  inset?: boolean;
}

const SNAP = 15;
const PX_PER_MIN = 0.8; // 48 px an hour
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first, like Sling
const LAST_END = 23 * 60 + 45; // the API takes times up to 23:59

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return h * 60 + m;
};
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const snap = (m: number) => Math.round(m / SNAP) * SNAP;

/**
 * Lays `events` onto each day minute by minute, later events over earlier
 * ones, and reads the runs back, separately for each layer. This merges
 * overlaps of one kind and lets a later block replace another kind of the same
 * layer where they overlap.
 */
function normalize<K extends string>(events: CalEvent<K>[], layerOf: (kind: K) => string): CalEvent<K>[] {
  const out: CalEvent<K>[] = [];
  const layers = new Set(events.map((e) => layerOf(e.kind)));
  for (const layer of layers) {
    for (let day = 0; day < 7; day++) {
      const minutes: (K | null)[] = new Array(1440).fill(null);
      for (const e of events) {
        if (e.weekday !== day || layerOf(e.kind) !== layer) continue;
        for (let m = toMin(e.start); m < toMin(e.end); m++) minutes[m] = e.kind;
      }
      let runStart = 0;
      for (let m = 1; m <= 1440; m++) {
        if (m < 1440 && minutes[m] === minutes[runStart]) continue;
        const kind = minutes[runStart];
        if (kind !== null && kind !== undefined) out.push({ weekday: day, start: toTime(runStart), end: toTime(m), kind });
        runStart = m;
      }
    }
  }
  return out;
}

type Drag =
  | { type: "create"; day: number; anchor: number; current: number }
  | { type: "move"; index: number; grab: number; day: number; start: number; moved: boolean }
  | { type: "resize"; index: number; edge: "start" | "end"; at: number };

export function WeekCalendar<K extends string>({
  value,
  onChange,
  kinds,
  backdrop = [],
  backdropLabel,
}: {
  value: CalEvent<K>[];
  onChange: (next: CalEvent<K>[]) => void;
  kinds: CalKind<K>[];
  /** Shown faintly behind the blocks for reference, for example availability behind preferences. */
  backdrop?: Window[];
  backdropLabel?: string;
}) {
  const [newKind, setNewKind] = useState<K>(kinds[0]!.id);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const kindOf = (id: K) => kinds.find((k) => k.id === id) ?? kinds[0]!;
  const layerOf = (id: K) => kindOf(id).layer ?? "";
  const activeLayer = layerOf(newKind);

  // The hours shown: 8 AM to 9 PM, widened to fit anything already entered.
  const all = [...value, ...backdrop];
  const from = Math.min(8 * 60, ...all.map((w) => Math.floor(toMin(w.start) / 60) * 60));
  const to = Math.min(LAST_END, Math.max(21 * 60, ...all.map((w) => Math.ceil(toMin(w.end) / 60) * 60)));
  const height = (to - from) * PX_PER_MIN;

  /** The weekday and snapped minute under the pointer. */
  const locate = (e: { clientX: number; clientY: number }) => {
    const rect = columnsRef.current!.getBoundingClientRect();
    const col = Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)));
    const minute = Math.min(to, Math.max(from, snap(from + (e.clientY - rect.top) / PX_PER_MIN)));
    const rawMinute = from + (e.clientY - rect.top) / PX_PER_MIN;
    return { day: DAY_ORDER[col]!, minute, rawMinute };
  };

  /** The event as it would look if the current drag ended now. */
  const dragged = (d: Drag): CalEvent<K> | null => {
    if (d.type === "create") {
      const start = Math.min(d.anchor, d.current);
      const end = Math.max(d.anchor, d.current) + SNAP;
      return { weekday: d.day, start: toTime(start), end: toTime(Math.min(to, end)), kind: newKind };
    }
    const e = value[d.index]!;
    if (d.type === "move") {
      const length = toMin(e.end) - toMin(e.start);
      return { ...e, weekday: d.day, start: toTime(d.start), end: toTime(d.start + length) };
    }
    if (d.edge === "start") return { ...e, start: toTime(Math.min(d.at, toMin(e.end) - SNAP)) };
    return { ...e, end: toTime(Math.max(d.at, toMin(e.start) + SNAP)) };
  };

  // While dragging, follow the pointer anywhere on the page.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const { day, minute, rawMinute } = locate(e);
      setDrag((d) => {
        if (!d) return d;
        if (d.type === "create") return { ...d, current: Math.min(to - SNAP, minute) };
        if (d.type === "resize") return { ...d, at: minute };
        const ev = value[d.index]!;
        const length = toMin(ev.end) - toMin(ev.start);
        const start = Math.min(to - length, Math.max(from, snap(rawMinute - d.grab)));
        return d.day === day && d.start === start ? d : { ...d, day, start, moved: true };
      });
    };
    const up = () => {
      // This effect re-subscribes on every render, so `drag` is current.
      const d = drag;
      setDrag(null);
      if (!d) return;
      if (d.type === "move" && !d.moved) {
        setSelected(d.index);
        return;
      }
      const result = dragged(d)!;
      const others = d.type === "create" ? value : value.filter((_, i) => i !== d.index);
      const next = normalize([...others, result], layerOf);
      onChange(next);
      setSelected(
        next.findIndex((n) => n.weekday === result.weekday && n.kind === result.kind && n.start <= result.start && n.end >= result.end),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  });

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    setSelected(null);
  };
  const setKind = (index: number, kind: K) => {
    const e = value[index]!;
    const next = normalize([...value.filter((_, i) => i !== index), { ...e, kind }], layerOf);
    onChange(next);
    setSelected(next.findIndex((n) => n.kind === kind && n.weekday === e.weekday && n.start <= e.start && n.end >= e.end));
  };

  // Delete or Backspace removes the selected block; Escape deselects.
  useEffect(() => {
    if (selected === null) return;
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(selected);
      } else if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const startCreate = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { day, minute } = locate(e);
    const anchor = Math.min(to - SNAP, Math.floor((minute - from) / SNAP) * SNAP + from);
    setSelected(null);
    setDrag({ type: "create", day, anchor, current: anchor });
  };
  const startMove = (e: ReactPointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const ev = value[index]!;
    const { rawMinute } = locate(e);
    setDrag({ type: "move", index, grab: rawMinute - toMin(ev.start), day: ev.weekday, start: toMin(ev.start), moved: false });
  };
  const startResize = (e: ReactPointerEvent, index: number, edge: "start" | "end") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const ev = value[index]!;
    setDrag({ type: "resize", index, edge, at: toMin(edge === "start" ? ev.start : ev.end) });
  };

  const preview = drag ? dragged(drag) : null;
  const hidden = drag && drag.type !== "create" ? drag.index : null;
  const top = (t: string) => (toMin(t) - from) * PX_PER_MIN;
  const hours: number[] = [];
  for (let h = Math.ceil(from / 60) * 60; h < to; h += 60) hours.push(h);

  const block = (e: CalEvent<K>, key: string | number, at: number | null, ghost = false) => {
    const k = kindOf(e.kind);
    // Blocks in another layer are shown but let the pointer through, so you can draw over them.
    const index = at !== null && layerOf(e.kind) === activeLayer ? at : null;
    const isSelected = index !== null && index === selected && !drag;
    const minutes = toMin(e.end) - toMin(e.start);
    return (
      <div
        key={key}
        className={`cal-event ${k.className} ${k.inset ? "inset" : ""} ${at !== null && index === null ? "other-layer" : ""} ${ghost ? "ghost" : ""} ${isSelected ? "selected" : ""}`}
        style={{ top: top(e.start), height: minutes * PX_PER_MIN }}
        onPointerDown={index === null ? undefined : (ev) => startMove(ev, index)}
      >
        {index !== null && <div className="cal-handle top" onPointerDown={(ev) => startResize(ev, index, "start")} />}
        <span className="cal-event-text">
          {kinds.length > 1 && <b>{k.label} </b>}
          {formatTime(e.start)} – {formatTime(e.end)}
        </span>
        {index !== null && <div className="cal-handle bottom" onPointerDown={(ev) => startResize(ev, index, "end")} />}
        {isSelected && (
          <div className="cal-popover" onPointerDown={(ev) => ev.stopPropagation()}>
            {kinds
                .filter((other) => other.id !== e.kind && layerOf(other.id) === activeLayer)
                .map((other) => (
                  <button key={other.id} type="button" className="link-button" onClick={() => setKind(index, other.id)}>
                    Make “{other.label}”
                  </button>
                ))}
            <button type="button" className="link-button" onClick={() => remove(index)}>
              Delete
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="cal">
      <div className="cal-toolbar radius-note">
        {kinds.length > 1 ? (
          <span className="cal-kinds" role="radiogroup" aria-label="New blocks are">
            Draw:
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={newKind === k.id}
                className={`cal-kind ${k.className} ${newKind === k.id ? "active" : ""}`}
                onClick={() => setNewKind(k.id)}
              >
                {k.label}
              </button>
            ))}
          </span>
        ) : null}
        <span>
          Drag on the calendar to add time. Drag a block to move it, its edges to resize it, click it to delete it.
          {new Set(kinds.map((k) => k.layer ?? "")).size > 1 && " Only blocks of the kind you're drawing can be changed."}
        </span>
        {backdrop.length > 0 && backdropLabel && (
          <span>
            <span className="cal-backdrop-swatch" /> {backdropLabel}
          </span>
        )}
      </div>
      <div className="cal-scroll">
        <div className="cal-head">
          <div />
          {DAY_ORDER.map((d) => (
            <div key={d}>{WEEKDAYS_SHORT[d]}</div>
          ))}
        </div>
        <div className="cal-body">
          <div className="cal-gutter" style={{ height }}>
            {hours.map((h) => (
              <span key={h} style={{ top: (h - from) * PX_PER_MIN }}>
                {formatTime(toTime(h)).replace(":00", "")}
              </span>
            ))}
          </div>
          <div className="cal-columns" ref={columnsRef}>
            {DAY_ORDER.map((day) => (
              <div
                key={day}
                className="cal-day"
                style={{ height, backgroundSize: `100% ${60 * PX_PER_MIN}px`, backgroundPositionY: ((Math.ceil(from / 60) * 60 - from) * PX_PER_MIN) }}
                onPointerDown={startCreate}
              >
                {backdrop
                  .filter((w) => w.weekday === day)
                  .map((w, i) => (
                    <div key={`b${i}`} className="cal-backdrop" style={{ top: top(w.start), height: (toMin(w.end) - toMin(w.start)) * PX_PER_MIN }} />
                  ))}
                {value.map((e, i) => (e.weekday === day && i !== hidden && layerOf(e.kind) !== activeLayer ? block(e, i, i) : null))}
                {value.map((e, i) => (e.weekday === day && i !== hidden && layerOf(e.kind) === activeLayer ? block(e, i, i) : null))}
                {preview && preview.weekday === day && block(preview, "preview", null, true)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
