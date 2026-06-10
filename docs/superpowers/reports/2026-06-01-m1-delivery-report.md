# M1 Delivery Report

## Summary

M1 turns the current optimization work into a stable, reviewable baseline. The main result is not a large new feature screen, but a safer project lifecycle: state-changing server operations are serialized per project, queue transitions are documented by tests, recent event reads are protected by regression coverage, and a small diagnostics API can explain what happened when a project stops or fails.

## Completed

- Change audit report created.
- Verification matrix created.
- Per-project mutation lock added in `src/core/project-lock.mjs`.
- App-server stop, retry, cancel, submit, and run-completion mutations are protected by the project lock.
- Task queue terminal and retry transition contracts are covered by tests.
- Event-log recent-read behavior is covered by a large-log regression test.
- Minimal project diagnostics builder and `GET /api/diagnostics` endpoint added.
- External review feedback was checked before implementation. The real issues were folded into the plan: `failures-store.mjs`, `project-store.mjs`, local failure slicing, existing app-server probe helper names, and the `TaskQueue(projectRoot)` constructor.

## Verification Evidence

| Command | Result | Notes |
| --- | --- | --- |
| `node --test tests/project-lock.test.mjs tests/task-queue.test.mjs tests/event-log.test.mjs tests/project-diagnostics.test.mjs tests/app-server-probe.test.mjs` | Passed, 57/57 tests | Focused M1 regression suite. |
| `node --check src/core/app-server.mjs` | Passed | Syntax check for the changed server file. |
| `node --check src/core/project-diagnostics.mjs` | Passed | Syntax check for the new diagnostics module. |
| `npm test` | Passed, 329/329 tests | Full Node test suite passed with 0 failures. |
| `npm run verify:app-shell` | Passed, `ok: true` | Demo project rendered at `D:\WWriting\.demo_runs\app-shell-1780307218117\dashboard-novel`; completed chapters: 2. |
| `npm run verify:app-clickability` | Passed, `ok: true` | Electron clickability probe confirmed primary controls and failure diagnostics interactions are clickable. |
| `npm run verify:local` | Passed, `ok: true` | Ran the local verification bundle, including tests, MVP/longrun/fault checks, app-shell, desktop/electron runtime checks, clickability, packaged-dir verification, installer build, and installer artifact verification. |

## Accepted Exceptions

No accepted exceptions.

## Remaining Risks

- M2 still needs user-facing project management and history improvements.
- M3 still needs release packaging and upgrade maturity.
- The diagnostics endpoint is intentionally data-first. A larger visual diagnostics page should wait until the M2 product-management layer is designed.

## Next Step

Review and stage M1 files by group. Do not use `git add -A`.
