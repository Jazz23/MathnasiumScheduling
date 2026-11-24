// Runs the greedy scheduler in Node and times it: node node-run.ts [repeat]
import { greedy } from "./greedy.ts";

const repeat = Number(process.argv[2] ?? 100);
greedy(); // warm up
const t0 = performance.now();
let out = greedy();
for (let i = 1; i < repeat; i++) out = greedy();
const ms = (performance.now() - t0) / repeat;
console.log(JSON.stringify({ msPerRun: Number(ms.toFixed(3)), ...out }, null, 2));
