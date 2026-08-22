# Changelog

## 0.2.1 — 2026-08-22

- Paused run budgets while awaiting user decisions and added audited budget extensions.
- Sequenced full-mode verification so result judgment always reads completed tester evidence.
- Renewed runtime capability leases automatically during active coordination.
- Required structured boundary checks for feature, bug-fix, and migration verification.
- Migrated npm publishing from long-lived tokens to GitHub OIDC trusted publishing.

## 0.2.0 — 2026-08-21

- Declared Windows and Codex Desktop as the stable support target.
- Added runtime capability registration and fail-closed child-agent claims.
- Upgraded persisted runs to schema v3 with v1/v2 migration.
- Added contextual risk dimensions and runtime light-to-full escalation.
- Added structured, independently attributable verification results.
- Added transactional run persistence and interrupted-write recovery.
- Hardened Git status and Windows path handling.
- Added Windows release gates and optimized routing/light-mode benchmarks.

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
- Passed the full 60-run benchmark: 30/30 completed, 24/24 seeded defects
  found, 30/30 tests passed, and zero regressions for Thearchy.

## 0.1.0-beta.0 — 2026-08-20

- Initial Codex and Claude Code adapters.
- Deterministic local coordinator and five official templates.
