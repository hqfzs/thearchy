# Routing and light-mode benchmark — 2026-08-21

This Windows/Codex-targeted control-plane benchmark executed 10
tasks three times, for 30 isolated coordinator runs.

## Results

| Metric | Result |
|---|---:|
| Routing classification matches | 30/30 |
| Completed coordinator runs | 30/30 |
| Mode questions after optimization | 9/30 |
| Mode questions under previous policy | 30/30 |
| Light-mode runs | 12/30 |
| Light runs using exactly two children | 12/12 |
| Average children in light mode | 2.0 |
| Average coordinator processing time | 843.3 ms |

## Interpretation

- The contextual classifier matched all expected low, medium, and high routes.
- Only medium-risk tasks requested a mode decision.
- Every low-risk task completed with one domain expert and one independent
  verifier.
- Risk, plan, and merge gates remain enforced.

This benchmark measures deterministic routing and coordinator overhead. It does
not replace the end-to-end model-quality benchmark in
`docs/FULL-BENCHMARK-2026-08-21.md`.
