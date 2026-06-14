# R1 Gate — Full automated + verify:local

## Status: GATE NOT PASSED (due to 1 pre-existing failure)

## Command results
- `npm test` → 683/684 PASS, 1 FAIL
  - The single failure: `tests/app-shell/chat-endpoints.test.mjs:147`
    `POST /api/chat/send 无项目时返回 400` — expected HTTP 400, got 404
  - **Pre-existing** (confirmed present on commit 8b8dc86 BEFORE any Batch C work,
    and on the master baseline before all four plans were executed).
  - NOT introduced by Execution Core, State/UI, or Model Config plans.
- `npm run verify:local` → runs `npm test` + a chain of other verify scripts.
  Exits 1 because of the same 1 test failure above.
  - `npm run verify:desktop-shell` → exit 0
  - `npm run verify:app-shell` → FAILS (pre-existing, `budget_config.max_model_calls`
    assertion mismatch; confirmed present on 8b8dc86 in a clean worktree).
  - Other verify scripts (mvp, longrun, faults) → exit 0

## Pre-existing failures (NOT introduced by this remediation)

1. **`tests/app-shell/chat-endpoints.test.mjs:147`** — POST /api/chat/send with no
   selected project returns 404 (`no_project` from `resolveReadProjectRoot`)
   instead of the test-expected 400. The B1.3 scope resolver throws 404 when
   no project is registered; the test was written before B1.3 added the read
   scope. Test is from a pre-B1.3 commit. This is a TEST-vs-IMPL mismatch
   encoding a pre-existing design intent, not a code bug in the new work.

2. **`scripts/verify-app-shell.mjs:429`** — `budget_config.max_model_calls`
   assertion mismatch. The verify script writes `budget_config: { max_model_calls: 77 }`
   via `updateProjectSettings`, then asserts the dashboard response carries
   `project.budget_config.max_model_calls === 77`. The dashboard does not
   surface the budget_config under the expected path. Pre-existing
   (confirmed identical failure on commit 8b8dc86 in a clean worktree).

## Implications for the final report

Both failures are pre-existing. Per the remediation-program plan's Pass/Limited
classification:
- **Pass**: All P1/P2 cases pass, all release gates pass.
- **Limited pass**: All P1 cases pass; only documented non-blocking P2/environment
  issue remains.
- **Fail**: Any P1 case fails.

The chat-send 404/400 and verify-app-shell budget failures are PRE-RELEASE
defects, not UAT case results. They DO block the `verify:local` gate (which the
plan treats as a release gate). Classification will depend on the program-level
review's decision on whether to:
(a) treat the pre-existing defects as out of scope (the four plans didn't list
    them), document them, and proceed to packaging + UAT (Limited pass), OR
(b) fix them as release-blockers before R1 can close.

This R1 status is recorded for the Q1 final review and the final report.
## Files
- .uat_runs/2026-06-13-remediation/logs/04-program-R1-gate.md (this file)
