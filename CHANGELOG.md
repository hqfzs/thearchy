# Changelog

## 0.2.0-beta.1 — 2026-08-20

- Added structured mode, plan, risk, conflict, and merge decisions.
- Added inquiry-component priority and safe fallback behavior.
- Added model-audited Luna Max child-agent leases and heartbeats.
- Added stale lease recovery and read-only snapshot migration recovery.
- Added persistent workspace candidates, comparison, selection, and integration.
- Added plugin validation, package smoke testing, 20-run stability testing,
  CodeQL, and Dependabot.
- Reduced default full-mode governance to four child agents, concurrency two,
  and a ten-minute budget.
- Moved routing, dispatching, and publishing to the root agent and removed the
  duplicate planning submission.
- Added active-run fingerprinting and duplicate-run prevention.
- Parallelized tester and result judge execution during verification.
- Added a Python standard-library test fallback without increasing the
  four-agent limit.

## 0.1.0-beta.0 — 2026-08-20

- Initial Codex and Claude Code adapters.
- Deterministic local coordinator and five official templates.
