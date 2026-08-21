# Targeted regression — 2026-08-21

The previously failing `feature-js` case was repeated after:

- active-run fingerprinting and duplicate prevention;
- tester/result-judge parallelization;
- a ten-minute timeout;
- the four-child-agent limit.

## Result

| Metric | Result |
|---|---:|
| Completed | Yes |
| Tests passed | Yes, 6 tests |
| Duration | 414 seconds |
| Audited child agents | 4 |
| Coordinator runs created | 1 |
| Seeded defects identified | 2 |
| Regressions reported | 0 |

The run completed in 6 minutes 54 seconds, used one coordinator run, and stayed
within the unified four-agent budget. This resolves the blocker observed in
pre-benchmark 2.

The next release gate remains the planned three-repetition benchmark across all
10 cases.
