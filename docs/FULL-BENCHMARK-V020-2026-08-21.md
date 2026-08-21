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
