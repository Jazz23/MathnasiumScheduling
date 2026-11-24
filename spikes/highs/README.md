# HiGHS in Workers (spike)

Throwaway test, 2026-11-24: does the HiGHS solver (npm `highs` 1.16.0) run in a Cloudflare Worker and
solve a realistic week of this center's schedule within Workers' limits? Not the real scheduler.

- `model.ts` builds a synthetic week as a MIP in CPLEX LP format: 8 employees, Mon–Thu 12–7 PM and
  Sun 12–4 PM in 15-minute blocks, demand by level, the supervisor and two-person rules, levels,
  Carol's teaching limit and work-from-home days, the school programs with travel, and hours.
  Two ways to write shifts: `compact` (working/starting per block, the default) and `enum` (one
  yes/no per possible shift).
- `worker.ts` solves it in a Worker. `node-run.ts` solves it in Node, for comparison.

Run (from this directory, after `bun install`):

```sh
node node-run.ts "step=1"                       # Node
../../node_modules/.bin/wrangler dev            # Worker, then GET /?step=1
../../node_modules/.bin/vite build              # the app's toolchain
```

Query parameters: `form=compact|enum`, `step` (start every N blocks), `min`/`max` shift length in
blocks, `gap` (relative MIP gap), `limit` (seconds).

## Results

| Run | Form | Starts | Binaries | Solve | Wasm memory |
| --- | --- | --- | --- | --- | --- |
| Node | enum | every 30 min | 1,891 | 6.6 s | 274 MB |
| Node | enum | every 15 min | 3,549 | 4.5 s | 229 MB |
| Node | compact | every 15 min | 1,235 | 0.9 s | 44 MB |
| workerd (wrangler dev) | compact | every 15 min | 1,235 | 1.0 s | 44 MB |
| workerd (vite build) | compact | every 15 min | 1,235 | 0.7 s | 44 MB |

All solves reached the optimum (within the 1% gap).

Findings:

- It runs in workerd, from both Wrangler's and the Vite plugin's builds. The bundle is 1.38 MB
  gzipped, within the Free plan's 3 MB.
- Workers can't compile WebAssembly from bytes, so the module has to be imported as a
  `WebAssembly.Module`. highs 1.16.0's loader ignores its documented `wasmModule` option (it tries
  to read `highs.wasm` from disk), so `worker.ts` passes the module through Emscripten's
  `instantiateWasm` hook instead.
- Write shifts in the compact form. Listing every possible shift used more memory than Workers'
  128 MB and ran slower.
- Deployed on the Free plan (2026-11-24): the upload is accepted (4.1 MB, 1.38 MB gzipped, 40 ms
  startup), but a solve fails with "Worker exceeded resource limits" (10 ms of CPU). Free also
  rejects the `limits.cpu_ms` setting. So the scheduler needs Workers Paid. Not checked yet: a
  deployed run on Paid.
