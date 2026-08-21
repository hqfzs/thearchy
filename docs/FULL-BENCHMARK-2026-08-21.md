# Full benchmark — 2026-08-21

The benchmark executed 10 tasks, two strategies, and three repetitions: 60
isolated Git runs in total.

## Overall results

| Metric | Single agent | Thearchy |
|---|---:|---:|
| Completed | 30/30 | 30/30 |
| Tests passed | 30/30 | 30/30 |
| Seeded defects | 24/24 | 24/24 |
| Regressions | 0 | 0 |
| Average duration | 0.9 s | 103.8 s |
| Median duration | 0.8 s | 108.9 s |
| P95 duration | 2.4 s | 290.4 s |
| Average agents | 1.0 | 4.0 |
| Duplicate runs | 0 | 0 |

## Repetitions

| Repetition | Single completion | Thearchy completion | Single avg | Thearchy avg |
|---|---:|---:|---:|---:|
| 1 | 10/10 | 10/10 | 1.2 s | 135.2 s |
| 2 | 10/10 | 10/10 | 0.8 s | 147.7 s |
| 3 | 10/10 | 10/10 | 0.8 s | 28.3 s |

## Notes

- Repetition 2 was rerun alone after the original concurrent orchestrator
  attempt encountered Windows child-sandbox initialization failures.
- The final dataset uses the isolated retry for Thearchy repetition 2.
- Results are normalized against the seeded-defect IDs declared by each case.
- Single-agent durations were self-reported task execution times, while
  Thearchy durations use coordinator wall-clock time. The latency columns are
  diagnostic and should not be treated as a controlled performance ratio.

## Release gate

The functional release gates passed:

- completion: 30/30 for both strategies;
- seeded-defect discovery: 24/24 for both strategies;
- tests: 30/30 for both strategies;
- regressions: zero;
- Thearchy duplicate runs: zero;
- Thearchy stayed within four audited child agents.

`v0.2.0-beta.1` is eligible for prerelease publication.
