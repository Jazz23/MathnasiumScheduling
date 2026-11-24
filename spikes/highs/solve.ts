import { buildModel, EMPLOYEES } from "./model.ts";

// Shared by the Worker and the Node runner. `now` is passed in because Date.now()
// doesn't advance during a Worker's CPU work.
export function run(highs: any, params: URLSearchParams, now: () => number) {
	const opts = {
		minShiftBlocks: Number(params.get("min") ?? 8), // 2 h
		maxShiftBlocks: Number(params.get("max") ?? 28), // 7 h
		startStep: Number(params.get("step") ?? 1), // start on any 15 minutes
		compact: params.get("form") !== "enum", // compact on/start form by default
	};
	const t0 = now();
	const { lp, stats } = buildModel(opts);
	const t1 = now();
	const result = highs.solve(lp, {
		output_flag: false,
		mip_rel_gap: Number(params.get("gap") ?? 0.01),
		time_limit: Number(params.get("limit") ?? 240),
	});
	const t2 = now();

	const shifts: string[] = [];
	let shortage = 0;
	let presence = 0;
	for (const [name, col] of Object.entries<any>(result.Columns ?? {})) {
		if (col.Primal < 0.5 && !(name.startsWith("short_") && col.Primal > 1e-6)) continue;
		if (name.startsWith("x_") || name.startsWith("p_") || name.startsWith("st_")) shifts.push(name);
		if (name.startsWith("short_")) shortage += col.Primal;
		if (name.startsWith("noTwo_") || name.startsWith("noSup_")) presence += col.Primal;
	}
	return {
		options: opts,
		model: stats,
		status: result.Status,
		objective: result.ObjectiveValue,
		buildMs: t1 - t0,
		solveMs: t2 - t1,
		instructorBlocksShort: Number(shortage.toFixed(2)),
		presenceViolations: presence,
		employees: EMPLOYEES.length,
		wasmMemoryMB: Math.round(highs.memoryBytes / 1e6),
		shifts: shifts.sort(),
	};
}
