# v0.2 Pre-benchmark 2 — 2026-08-20

This second diagnostic run used a uniform Thearchy budget:

- four audited child agents;
- concurrency two;
- eight-minute timeout;
- root-managed routing, dispatching, and publishing;
- one planner, one reusable judge, one domain expert, and one tester.

All 10 fixture tasks were run once with a single Luna Max agent and once with
Thearchy.

## Results

| Metric | Single agent | Thearchy |
|---|---:|---:|
| Completed runs | 10/10 | 9/10 |
| Seeded defects found | 8/8 | 8/8 |
| Average duration | 55.5 s | 373.7 s |
| Audited child-agent count | 1.0 | 4.0 |
| Reported regressions | 0 | 0 |

## Comparison with pre-benchmark 1

| Thearchy metric | First run | Optimized run |
|---|---:|---:|
| Completion | 6/10 | 9/10 |
| Seeded defects | 7/8 | 8/8 |
| Average duration | 883.9 s | 373.7 s |
| Average agents | 7.8 | 4.0 |

The streamlined topology reduced average duration by approximately 58% and
raised completion from 60% to 90%.

## Remaining blocker

`feature-js` reached verification with passing tests but did not complete final
result review and merge approval before the eight-minute deadline. The run also
attempted to start a second coordinator run instead of recovering the original
run after the timeout.

The prerelease remains paused because Thearchy completion is still below the
single-agent baseline. Before the three-repetition benchmark:

1. prevent duplicate coordinator runs for the same task and repository;
2. resume an existing timed-out run instead of creating a new run;
3. add a fast path from successful verification to final judgment;
4. evaluate a ten-minute timeout without increasing the four-agent budget.
