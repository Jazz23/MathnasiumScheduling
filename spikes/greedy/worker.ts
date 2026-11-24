// Runs the greedy scheduler on the synthetic week. GET /?repeat=1
// `repeat` runs it several times in one request, to see how many fit in the CPU limit.
import { greedy } from "./greedy.ts";

export default {
	fetch(request: Request): Response {
		const repeat = Math.min(1000, Math.max(1, Number(new URL(request.url).searchParams.get("repeat") ?? 1)));
		let out = greedy();
		for (let i = 1; i < repeat; i++) out = greedy();
		// Date.now() doesn't advance during CPU work in Workers, so no timings here: the
		// dashboard's CPU time metric, or an "exceeded resource limits" error, tells.
		return Response.json({ repeat, ...out });
	},
};
