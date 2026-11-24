// A synthetic but realistically sized week, written as a MIP in CPLEX LP format.
// Not the real scheduler: just enough structure to see whether HiGHS solves a week in time.

export const BLOCK_MIN = 15;

type Level = "E" | "M" | "H"; // elementary, middle, high
const LEVELS: Level[] = ["E", "M", "H"];
const RATIO: Record<Level, number> = { E: 4, M: 4, H: 3 };
const RANK: Record<Level, number> = { E: 0, M: 1, H: 2 };

interface Employee {
	id: string;
	supervisor: boolean;
	maxLevel: Level;
	minHours: number;
	prefHours: number;
	maxHours: number;
	teachShareMax?: number; // Carol: 0.5
	wfhDays?: number[]; // days she'd rather not be at the center
	preferredPrograms?: boolean;
	// available[day] = [startBlock, endBlock) within that day's open window, or undefined
	available: Record<number, [number, number]>;
}

// Days: 0 Mon .. 3 Thu, 4 Fri (programs only), 6 Sun.
// Open windows, in blocks from 12:00.
const OPEN: Record<number, [number, number]> = {
	0: [0, 28], // 12:00–19:00
	1: [0, 28],
	2: [0, 28],
	3: [0, 28],
	6: [0, 16], // 12:00–16:00
};
const CENTER_DAYS = [0, 1, 2, 3, 6];

interface Program {
	id: string;
	day: number;
	start: number; // block from 12:00
	end: number;
	needed: number;
	travel: number; // blocks each way
}
const PROGRAMS: Program[] = [
	{ id: "val_mon", day: 0, start: 9, end: 15, needed: 2, travel: 1 }, // 2:15–3:45
	{ id: "val_fri", day: 4, start: 1, end: 7, needed: 2, travel: 1 }, // 12:15–1:45
	{ id: "rio_tue", day: 1, start: 9, end: 15, needed: 3, travel: 1 },
	{ id: "rio_thu", day: 3, start: 9, end: 15, needed: 3, travel: 1 },
];

const ALL_DAYS: Record<number, [number, number]> = {
	0: [0, 28], 1: [0, 28], 2: [0, 28], 3: [0, 28], 4: [0, 28], 6: [0, 16],
};

export const EMPLOYEES: Employee[] = [
	{ id: "carol", supervisor: true, maxLevel: "H", minHours: 10, prefHours: 20, maxHours: 30, teachShareMax: 0.5, wfhDays: [2, 6], available: ALL_DAYS },
	{ id: "deven", supervisor: true, maxLevel: "H", minHours: 15, prefHours: 25, maxHours: 32, available: { 0: [0, 28], 1: [0, 28], 3: [4, 28], 6: [0, 16] } },
	{ id: "grace", supervisor: true, maxLevel: "H", minHours: 15, prefHours: 25, maxHours: 32, available: { 0: [8, 28], 2: [0, 28], 3: [0, 28], 4: [0, 28], 6: [0, 16] } },
	{ id: "keiko", supervisor: false, maxLevel: "M", minHours: 8, prefHours: 15, maxHours: 20, preferredPrograms: true, available: { 0: [0, 28], 1: [0, 28], 3: [0, 28], 4: [0, 28] } },
	{ id: "i1", supervisor: false, maxLevel: "H", minHours: 6, prefHours: 12, maxHours: 20, available: { 0: [12, 28], 1: [12, 28], 2: [12, 28], 3: [12, 28] } },
	{ id: "i2", supervisor: false, maxLevel: "M", minHours: 6, prefHours: 12, maxHours: 20, available: { 1: [10, 28], 2: [10, 28], 3: [10, 28], 6: [0, 16] } },
	{ id: "i3", supervisor: false, maxLevel: "E", minHours: 4, prefHours: 10, maxHours: 16, available: { 0: [12, 28], 2: [12, 28], 4: [0, 28] } },
	{ id: "i4", supervisor: false, maxLevel: "H", minHours: 4, prefHours: 10, maxHours: 16, available: { 1: [14, 28], 3: [14, 28], 6: [0, 16] } },
];

// Deterministic pseudo-random demand: students at the center per block and level.
function demand(day: number, b: number, level: Level): number {
	const [, end] = OPEN[day];
	const t = b / end; // 0..1 through the day
	const peak = Math.exp(-((t - 0.65) ** 2) / 0.04); // after school
	const base = { E: 10, M: 4, H: 4 }[level] * (day === 6 ? 0.6 : 1);
	const wobble = ((day * 31 + b * 17 + RANK[level] * 7) % 5) / 10;
	return Math.round(base * (0.15 + peak) * (0.8 + wobble));
}

export interface BuiltModel {
	lp: string;
	stats: { binaries: number; continuous: number; constraints: number; lpBytes: number };
}

export function buildModel(opts: { minShiftBlocks: number; maxShiftBlocks: number; startStep: number; compact?: boolean }): BuiltModel {
	const obj: string[] = [];
	const cons: string[] = [];
	const bins: string[] = [];
	const conts: string[] = [];
	const bounds: string[] = [];
	let c = 0;
	const row = (expr: string) => cons.push(` c${c++}: ${expr}`);

	// Shift candidates: x_e_d_s_len, at the center.
	// covering[e][d][b] = list of shift vars covering block b.
	const covering: Record<string, Record<number, string[][]>> = {};
	const shiftsByEmpDay: Record<string, string[]> = {};
	const hoursTerms: Record<string, string[]> = {};
	for (const e of EMPLOYEES) {
		covering[e.id] = {};
		hoursTerms[e.id] = [];
		for (const d of CENTER_DAYS) {
			const av = e.available[d];
			if (!av) continue;
			const [open0, open1] = OPEN[d];
			const lo = Math.max(av[0], open0);
			const hi = Math.min(av[1], open1);
			covering[e.id][d] = Array.from({ length: open1 }, () => []);
			const key = `${e.id}_${d}`;
			shiftsByEmpDay[key] = [];
			if (opts.compact) {
				// Compact form: on_b = working in block b, st_b = shift starts at b.
				// One start per day makes the work one contiguous shift.
				const on = (b: number) => `on_${e.id}_${d}_${b}`;
				const st = (b: number) => `st_${e.id}_${d}_${b}`;
				const starts: string[] = [];
				const ons: string[] = [];
				for (let b = lo; b < hi; b++) {
					bins.push(on(b), st(b));
					ons.push(on(b));
					starts.push(st(b));
					covering[e.id][d][b].push([on(b)]);
					hoursTerms[e.id].push(`${BLOCK_MIN / 60} ${on(b)}`);
					obj.push(`1 ${on(b)}`);
					if (e.wfhDays?.includes(d)) obj.push(`40 ${st(b)}`);
					// A shift starts wherever work begins.
					row(b === lo ? `${st(b)} - ${on(b)} >= 0` : `${st(b)} - ${on(b)} + ${on(b - 1)} >= 0`);
					// Minimum length: a start forces the next minShiftBlocks blocks on.
					if (b + opts.minShiftBlocks > hi) bounds.push(` ${st(b)} = 0`);
					else for (let k = 1; k < opts.minShiftBlocks; k++) row(`${on(b + k)} - ${st(b)} >= 0`);
					// Starts only on the allowed step.
					if ((b - lo) % opts.startStep !== 0) bounds.push(` ${st(b)} = 0`);
				}
				row(`${starts.join(" + ")} <= 1`);
				row(`${ons.join(" + ")} <= ${opts.maxShiftBlocks}`);
				continue;
			}
			for (let s = lo; s < hi; s += opts.startStep) {
				for (let len = opts.minShiftBlocks; len <= opts.maxShiftBlocks && s + len <= hi; len++) {
					const v = `x_${e.id}_${d}_${s}_${len}`;
					bins.push(v);
					shiftsByEmpDay[key].push(v);
					for (let b = s; b < s + len; b++) covering[e.id][d][b].push([v]);
					hoursTerms[e.id].push(`${(len * BLOCK_MIN) / 60} ${v}`);
					// Small labour cost per block, so it doesn't overstaff for free.
					// Work-from-home days cost extra.
					const wfh = e.wfhDays?.includes(d) ? 40 : 0;
					obj.push(`${len * 1 + wfh} ${v}`);
				}
			}
			if (shiftsByEmpDay[key].length) row(`${shiftsByEmpDay[key].join(" + ")} <= 1`);
		}
	}

	const onsite = (e: string, d: number, b: number) => (covering[e][d]?.[b] ?? []).map((x) => x[0]);

	// School programs: p_e_prog binary.
	for (const p of PROGRAMS) {
		const vars: string[] = [];
		for (const e of EMPLOYEES) {
			const av = e.available[p.day];
			if (!av || av[0] > p.start - p.travel || av[1] < p.end + p.travel) continue;
			const v = `p_${e.id}_${p.id}`;
			bins.push(v);
			vars.push(v);
			hoursTerms[e.id].push(`${((p.end - p.start + 2 * p.travel) * BLOCK_MIN) / 60} ${v}`);
			if (!e.preferredPrograms) obj.push(`5 ${v}`);
			// Can't be at the center during the program or the drive.
			if (covering[e.id][p.day]) {
				for (let b = Math.max(0, p.start - p.travel); b < p.end + p.travel; b++) {
					const on = onsite(e.id, p.day, b);
					if (on.length) row(`${on.join(" + ")} + ${v} <= 1`);
				}
			}
		}
		const short = `pshort_${p.id}`;
		conts.push(short);
		obj.push(`10000 ${short}`);
		row(`${vars.join(" + ")} + ${short} >= ${p.needed}`);
	}

	// Teaching: t_e_d_b_L continuous, coverage by level, presence rules.
	for (const d of CENTER_DAYS) {
		const [, end] = OPEN[d];
		for (let b = 0; b < end; b++) {
			const people: string[] = [];
			const sups: string[] = [];
			const teachByLevel: Record<Level, string[]> = { E: [], M: [], H: [] };
			for (const e of EMPLOYEES) {
				const on = onsite(e.id, d, b);
				if (!on.length) continue;
				people.push(...on);
				if (e.supervisor) sups.push(...on);
				const ts: string[] = [];
				for (const L of LEVELS) {
					if (RANK[L] > RANK[e.maxLevel]) continue;
					const t = `t_${e.id}_${d}_${b}_${L}`;
					conts.push(t);
					ts.push(t);
					teachByLevel[L].push(t);
				}
				row(`${ts.join(" + ")} - ${on.join(" - ")} <= 0`);
			}
			for (const L of LEVELS) {
				const need = demand(d, b, L) / RATIO[L];
				if (need <= 0) continue;
				const short = `short_${d}_${b}_${L}`;
				conts.push(short);
				obj.push(`1000 ${short}`);
				row(`${teachByLevel[L].length ? teachByLevel[L].join(" + ") + " + " : ""}${short} >= ${need.toFixed(4)}`);
			}
			const p2 = `noTwo_${d}_${b}`;
			const ps = `noSup_${d}_${b}`;
			conts.push(p2, ps);
			obj.push(`5000 ${p2}`, `5000 ${ps}`);
			row(`${people.length ? people.join(" + ") + " + " : ""}${p2} >= 2`);
			row(`${sups.length ? sups.join(" + ") + " + " : ""}${ps} >= 1`);
		}
	}

	// Hours: hard max, soft min and preferred.
	for (const e of EMPLOYEES) {
		const h = hoursTerms[e.id].join(" + ");
		if (!h) continue;
		row(`${h} <= ${e.maxHours}`);
		const under = `under_${e.id}`, over = `over_${e.id}`, belowMin = `belowMin_${e.id}`;
		conts.push(under, over, belowMin);
		obj.push(`20 ${under}`, `20 ${over}`, `200 ${belowMin}`);
		row(`${h} + ${under} - ${over} = ${e.prefHours}`);
		row(`${h} + ${belowMin} >= ${e.minHours}`);
	}

	// Carol: teaching at most teachShareMax of her time on site.
	for (const e of EMPLOYEES) {
		if (e.teachShareMax === undefined) continue;
		const teach: string[] = [];
		const on: string[] = [];
		for (const d of CENTER_DAYS) {
			const [, end] = OPEN[d];
			for (let b = 0; b < end; b++) {
				for (const v of onsite(e.id, d, b)) on.push(`${e.teachShareMax} ${v}`);
				for (const L of LEVELS) if (RANK[L] <= RANK[e.maxLevel] && onsite(e.id, d, b).length) teach.push(`t_${e.id}_${d}_${b}_${L}`);
			}
		}
		row(`${teach.join(" + ")} - ${on.join(" - ")} <= 0`);
	}

	const lp = [
		"Minimize",
		` obj: ${obj.join(" + ")}`,
		"Subject To",
		...cons,
		"Bounds",
		...bounds,
		"Binaries",
		` ${bins.join(" ")}`,
		"End",
	].join("\n");
	return {
		lp,
		stats: { binaries: bins.length, continuous: conts.length, constraints: c, lpBytes: lp.length },
	};
}
