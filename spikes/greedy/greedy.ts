// A greedy scheduler for the same synthetic week as the HiGHS spike, to compare speed and quality.
// Not the real scheduler. It staffs the school programs first, then repeatedly adds the single
// shift that does the most good, until no shift helps. Scores match the HiGHS model's objective,
// so the two objectives can be compared directly (lower is better).
import {
	BLOCK_MIN,
	CENTER_DAYS,
	EMPLOYEES,
	OPEN,
	PROGRAMS,
	RANK,
	RATIO,
	demand,
	type Employee,
} from "../highs/model.ts";

const MIN_SHIFT = 8; // blocks: 2 h
const MAX_SHIFT = 28; // 7 h
const HOURS_PER_BLOCK = BLOCK_MIN / 60;

// The HiGHS model's penalties.
const P_SHORT = 1000; // per instructor short, per block
const P_PRESENCE = 5000; // per missing person or supervisor, per block
const P_PROGRAM_SHORT = 10000;
const P_PROGRAM_NOT_PREFERRED = 5;
const P_WFH = 40; // a center shift on a work-from-home day
const P_HOURS = 20; // per hour away from preferred
const P_BELOW_MIN = 200; // per hour below minimum

interface DayState {
	people: number[];
	sups: number[];
	// Teaching capacity of the staff on site able to teach at least E, M and H.
	capAll: number[];
	capMH: number[];
	capH: number[];
	need: Record<"E" | "M" | "H", number>[];
}

const hoursCost = (e: Employee, h: number) =>
	P_BELOW_MIN * Math.max(0, e.minHours - h) + P_HOURS * Math.abs(h - e.prefHours);

/** Instructors short in a block: the level groups are nested, so check each from the top. */
function deficit(s: DayState, b: number): number {
	const n = s.need[b]!;
	return Math.max(0, n.H - s.capH[b]!, n.H + n.M - s.capMH[b]!, n.H + n.M + n.E - s.capAll[b]!);
}

export function greedy() {
	const days: Record<number, DayState> = {};
	for (const d of CENTER_DAYS) {
		const end = OPEN[d]![1];
		const zeros = () => new Array<number>(end).fill(0);
		days[d] = {
			people: zeros(),
			sups: zeros(),
			capAll: zeros(),
			capMH: zeros(),
			capH: zeros(),
			need: Array.from({ length: end }, (_, b) => ({
				E: demand(d, b, "E") / RATIO.E,
				M: demand(d, b, "M") / RATIO.M,
				H: demand(d, b, "H") / RATIO.H,
			})),
		};
	}
	const hours: Record<string, number> = Object.fromEntries(EMPLOYEES.map((e) => [e.id, 0]));
	const blocked: Record<string, Set<number>> = {}; // `${e}_${d}` -> blocks away at a program
	const used = new Set<string>(); // `${e}_${d}` with a center shift
	const shifts: { employee: string; day: number; start: number; end: number }[] = [];
	const programs: { program: string; employees: string[]; short: number }[] = [];
	let objective = 0;

	// 1. School programs: preferred people first, then whoever has the fewest hours so far.
	for (const p of PROGRAMS) {
		const length = (p.end - p.start + 2 * p.travel) * HOURS_PER_BLOCK;
		const eligible = EMPLOYEES.filter((e) => {
			const av = e.available[p.day];
			return av && av[0] <= p.start - p.travel && av[1] >= p.end + p.travel && hours[e.id]! + length <= e.maxHours;
		}).sort((a, b) => Number(!!b.preferredPrograms) - Number(!!a.preferredPrograms) || hours[a.id]! - hours[b.id]!);
		const chosen = eligible.slice(0, p.needed);
		for (const e of chosen) {
			hours[e.id]! += length;
			const key = `${e.id}_${p.day}`;
			blocked[key] ??= new Set();
			for (let b = p.start - p.travel; b < p.end + p.travel; b++) blocked[key].add(b);
			if (!e.preferredPrograms) objective += P_PROGRAM_NOT_PREFERRED;
		}
		const short = p.needed - chosen.length;
		objective += P_PROGRAM_SHORT * short;
		programs.push({ program: p.id, employees: chosen.map((e) => e.id), short });
	}

	// 2. Center shifts: add the best shift until none improves the schedule.
	const gains: number[] = [];
	for (;;) {
		let best: { e: Employee; d: number; start: number; len: number; score: number } | null = null;
		for (const e of EMPLOYEES) {
			const teach = e.teachShareMax ?? 1;
			for (const d of CENTER_DAYS) {
				const key = `${e.id}_${d}`;
				const av = e.available[d];
				if (!av || used.has(key)) continue;
				const s = days[d]!;
				const lo = Math.max(av[0], OPEN[d]![0]);
				const hi = Math.min(av[1], OPEN[d]![1]);
				// Prefix sums of what adding this person does in each block.
				gains.length = 0;
				gains.push(0);
				for (let b = lo; b < hi; b++) {
					let g = -1; // labour cost
					if (s.people[b]! < 2) g += P_PRESENCE;
					if (e.supervisor && s.sups[b]! < 1) g += P_PRESENCE;
					const before = deficit(s, b);
					s.capAll[b]! += teach;
					if (RANK[e.maxLevel] >= RANK.M) s.capMH[b]! += teach;
					if (RANK[e.maxLevel] >= RANK.H) s.capH[b]! += teach;
					g += P_SHORT * (before - deficit(s, b));
					s.capAll[b]! -= teach;
					if (RANK[e.maxLevel] >= RANK.M) s.capMH[b]! -= teach;
					if (RANK[e.maxLevel] >= RANK.H) s.capH[b]! -= teach;
					gains.push(gains.at(-1)! + g);
				}
				const away = blocked[key];
				const fixed = (e.wfhDays?.includes(d) ? -P_WFH : 0) + hoursCost(e, hours[e.id]!);
				for (let start = lo; start + MIN_SHIFT <= hi; start++) {
					for (let len = MIN_SHIFT; len <= MAX_SHIFT && start + len <= hi; len++) {
						if (away?.has(start + len - 1)) break; // longer ones overlap the program too
						if (away?.has(start)) break;
						const h = hours[e.id]! + len * HOURS_PER_BLOCK;
						if (h > e.maxHours) break;
						const score = gains[start - lo + len]! - gains[start - lo]! + fixed - hoursCost(e, h);
						if (score > 0 && (!best || score > best.score)) best = { e, d, start, len, score };
					}
				}
			}
		}
		if (!best) break;
		const { e, d, start, len } = best;
		const s = days[d]!;
		const teach = e.teachShareMax ?? 1;
		for (let b = start; b < start + len; b++) {
			s.people[b]!++;
			if (e.supervisor) s.sups[b]!++;
			s.capAll[b]! += teach;
			if (RANK[e.maxLevel] >= RANK.M) s.capMH[b]! += teach;
			if (RANK[e.maxLevel] >= RANK.H) s.capH[b]! += teach;
		}
		hours[e.id]! += len * HOURS_PER_BLOCK;
		used.add(`${e.id}_${d}`);
		shifts.push({ employee: e.id, day: d, start, end: start + len });
		objective += len + (e.wfhDays?.includes(d) ? P_WFH : 0);
	}

	// What's left uncovered, in the HiGHS spike's units.
	let instructorBlocksShort = 0;
	let presenceViolations = 0;
	for (const d of CENTER_DAYS) {
		const s = days[d]!;
		for (let b = 0; b < s.people.length; b++) {
			instructorBlocksShort += deficit(s, b);
			presenceViolations += Math.max(0, 2 - s.people[b]!) + Math.max(0, 1 - s.sups[b]!);
		}
	}
	objective += P_SHORT * instructorBlocksShort + P_PRESENCE * presenceViolations;
	for (const e of EMPLOYEES) objective += hoursCost(e, hours[e.id]!);

	const time = (block: number) => {
		const m = 12 * 60 + block * BLOCK_MIN;
		return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
	};
	const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
	return {
		objective: Math.round(objective),
		instructorBlocksShort: Number(instructorBlocksShort.toFixed(2)),
		presenceViolations,
		hours,
		programs,
		shifts: shifts
			.sort((a, b) => a.day - b.day || a.start - b.start)
			.map((s) => `${DAY[s.day]} ${s.employee} ${time(s.start)}–${time(s.end)}`),
	};
}
