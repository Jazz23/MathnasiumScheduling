// Baseline outside Workers: node node-run.ts [query string], e.g. "step=2&gap=0.01"
import loadHighs from "highs";
import { run } from "./solve.ts";

const highs = await loadHighs();
const out = run(highs, new URLSearchParams(process.argv[2] ?? ""), () => performance.now());
console.log(JSON.stringify({ ...out, mem: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1e6)])) }, null, 2));
