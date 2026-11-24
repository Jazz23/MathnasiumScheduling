// Loads HiGHS from a precompiled WebAssembly module (Workers can't compile Wasm from bytes)
// and solves the synthetic week. GET /?step=1&form=compact|enum&min=8&max=28&gap=0.01
import loadHighs from "highs";
import highsWasm from "./node_modules/highs/build/highs.wasm";
import { run } from "./solve.ts";

export default {
	async fetch(request: Request): Promise<Response> {
		const params = new URL(request.url).searchParams;
		try {
			// highs 1.16.0's loader ignores its documented `wasmModule` option, so use
			// Emscripten's instantiateWasm hook to hand it the precompiled module.
			const highs = await loadHighs({
				instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
					WebAssembly.instantiate(highsWasm as WebAssembly.Module, imports).then(done);
					return {};
				},
			} as any);
			// Date.now() is frozen during CPU work in Workers, so timings come out as 0 here;
			// time the request from outside instead.
			const out = run(highs, params, () => Date.now());
			return Response.json(out);
		} catch (err) {
			return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
		}
	},
};
