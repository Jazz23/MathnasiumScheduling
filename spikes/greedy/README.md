# Greedy scheduler (spike)

Throwaway test, 2026-11-24: how fast and how good is a greedy scheduler on the same synthetic week
as `../highs`? Not the real scheduler.

`greedy.ts` staffs the school programs first (people who prefer programs, then the fewest hours),
then repeatedly adds the one center shift that improves the week most, until none does. Shifts are
2–7 hours, one per person per day. It scores with the HiGHS model's penalties, so the objectives
compare directly (lower is better).

Run from this directory:

```sh
node node-run.ts 200                      # Node: average time over 200 runs
../../node_modules/.bin/wrangler deploy   # Worker, then GET /?repeat=1
```

`repeat` runs it several times in one request, to see how much headroom there is under the Free
plan's 10 ms of CPU.

## Results (Node)

| | Greedy | HiGHS |
| --- | --- | --- |
| Time | 1.1 ms | 840 ms |
| Objective | 105,883 | 32,549 (optimal) |
| Instructor-blocks short | 25 | 2 |
| Blocks missing a 2nd person or a supervisor | 16 | 0 |

Greedy is fast enough for the Free plan but leaves gaps the solver shows can be covered. It commits
to early choices (for example sending the supervisors to the programs, then running short of
supervisors at the center) and can't undo them. Repair passes would narrow the gap, at the cost of
more code and more CPU.
