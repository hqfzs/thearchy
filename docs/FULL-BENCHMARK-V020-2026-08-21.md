# v0.2.0 live Codex benchmark — 2026-08-21

10 tasks × 2 strategies × 3 repetitions = 60 real model runs.

| Metric | Single agent | Thearchy |
|---|---:|---:|
| Completed | 30/30 | 30/30 |
| Tests passed | 30/30 | 30/30 |
| Seeded defects | 24/24 | 24/24 |
| Regressions | 0 | 1 |
| Average duration | 55.3 s | 2030.6 s |
| Average agents | 1.0 | 2.4 |
| Duplicate runs | 0 | 0 |

Release gate: **FAIL**.

Thearchy found all seeded defects, but independent post-run verification found one regression in repetition 1 feature-py: Python boolean `True` is accepted as `max_failures`. The zero-regression release gate therefore failed.

## Follow-up

The verification contract and Agent instructions were strengthened to require explicit type-confusion and boundary evidence. Three fresh `feature-py` Thearchy reruns completed with 45/45 boundary checks and zero regressions. See `BOUNDARY-RETEST-V020-2026-08-21.md`.

The remaining affected feature, bug-fix, and migration cases were subsequently rerun three times: 15/15 completed, 15/15 tests passed, 160/160 boundary checks passed, and zero regressions. Combined with the three successful `feature-py` reruns, all 18 affected runs passed.

Final release gate after hardening: **PASS**. See `AFFECTED-RETEST-V020-2026-08-21.md`.
