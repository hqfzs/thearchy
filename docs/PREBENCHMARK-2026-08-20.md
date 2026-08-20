# v0.2 Pre-benchmark — 2026-08-20

This diagnostic pre-benchmark ran all 10 fixture tasks once with a single
Luna Max agent and once through Thearchy.

## Results

| Metric | Single agent | Thearchy |
|---|---:|---:|
| Completed runs | 10/10 | 6/10 |
| Seeded defects found | 8/8 | 7/8 |
| Average duration | 94.5 s | 883.9 s |
| Average agent count | 1.0 | 7.8 |
| Reported regressions | 0 | 0 |

Automated test execution was unavailable in two Python review cases because
`pytest` was not installed; direct probes were used instead.

## Interpretation

- Thearchy exceeded the 80% seeded-defect threshold at 87.5%.
- Four Thearchy runs did not complete before their orchestration deadline.
- Thearchy was substantially slower than the single-agent baseline.
- The Bug-Python run fixed the seeded issue but did not record it as a detected
  defect, exposing a reporting consistency problem.
- The first four Thearchy runs used the default full budget; the remaining six
  used a 10-minute, four-agent diagnostic cap. This is a pre-benchmark, not a
  final controlled comparison.

## Release decision

`v0.2.0-beta.1` remains unreleased. Before release:

1. Reduce default orchestration overhead and redundant governance agents.
2. Add a fast completion path for review-only templates.
3. Make test-environment availability explicit before dispatch.
4. Normalize defect reporting when a repair implicitly discovers a seeded bug.
5. Repeat the 10-case pre-benchmark with one consistent budget profile.
6. Complete the planned three repetitions per strategy.
