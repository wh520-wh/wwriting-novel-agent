# M1 Change Audit

## Purpose

This report groups the current working-tree changes before M1 stabilization continues. It is meant to prevent unrelated edits from being mixed into one large, hard-to-review commit.

## Snapshot

Generated from:

- `git status --short`
- `git diff --stat`

Current tracked diff summary (final M1 tree, after the test changes in later tasks):

- 22 tracked files changed.
- 1249 insertions.
- 2124 deletions.

There are also many untracked files from the full optimization and maturity planning work. They must be reviewed and staged by group, not with `git add -A`.

## Backend Reliability

| File | Why It Changed | Review Status |
| --- | --- | --- |
| `src/core/model-client.mjs` | Retry, timeout, abort, retry callback behavior. | Needs focused diff review |
| `src/core/provider-adapters.mjs` | Real streaming, CRLF SSE handling, stream usage options, transport error classification. | Needs focused diff review |
| `src/core/event-log.mjs` | Recent-event tail reading. | Needs focused diff review |
| `src/core/agent-engine.mjs` | Runtime/model/adapter integration and failure handling. | Needs focused diff review |
| `src/core/app-server.mjs` | Unified errors, queue/run lifecycle changes. | Needs focused diff review |
| `src/core/app-dashboard.mjs` | Dashboard data integration. | Needs focused diff review |
| `src/core/app-state.mjs` | Missing state file is quiet; invalid state file is reported. | Needs focused diff review |
| `src/core/skill-runtime.mjs` | Silent error handling changed to visible logging. | Needs focused diff review |
| `src/core/http-error.mjs` | Shared HTTP error envelope. | Needs focused diff review |

## Frontend Split

| File | Why It Changed | Review Status |
| --- | --- | --- |
| `src/app-shell/app.js` | Reduced entry file and delegated rendering/helpers. | Needs focused diff review |
| `src/app-shell/api-client.js` | API request wrapper. | Needs focused diff review |
| `src/app-shell/composer.js` | Command parsing and submission. | Needs focused diff review |
| `src/app-shell/drawer-panels.js` | Right drawer rendering. | Needs focused diff review |
| `src/app-shell/icons.js` | Shared icon helpers. | Needs focused diff review |
| `src/app-shell/settings-modal.js` | Settings modal behavior. | Needs focused diff review |
| `src/app-shell/thread-renderer.js` | Thread rendering. | Needs focused diff review |
| `src/app-shell/utils.js` | Shared app-shell helpers. | Needs focused diff review |
| `src/app-shell/components/activity-strip.js` | Safer rendering path. | Needs focused diff review |
| `src/app-shell/components/quick-rail.js` | Quick rail interaction/layout work. | Needs focused diff review |
| `src/app-shell/styles.css` | CSS cleanup and anchor removal. | Needs focused diff review |
| `src/app-shell/vendor/gsap.js` | Vendor file touched; verify this is intentional before staging. | Uncertain |

## Tests

| File | Coverage Added | Review Status |
| --- | --- | --- |
| `tests/model-client-retry.test.mjs` | Retry, timeout, abort behavior. | Needs focused diff review |
| `tests/provider-adapters.test.mjs` | Streaming, CRLF SSE, malformed frame reporting. | Needs focused diff review |
| `tests/event-log.test.mjs` | Tail reads and missing log behavior. | Needs focused diff review |
| `tests/app-state.test.mjs` | Missing/invalid app state logging behavior. | Needs focused diff review |
| `tests/app-server-probe.test.mjs` | Server queue/run lifecycle coverage. | Needs focused diff review |
| `tests/app-shell/activity-strip-render.test.mjs` | Activity strip render coverage. | Needs focused diff review |
| `tests/app-shell/failure-card-render.test.mjs` | Failure card render coverage. | Needs focused diff review |
| `tests/chapter-memory.test.mjs` | Chapter memory coverage. | Needs focused diff review |
| `tests/cost-tracker.test.mjs` | Cost tracking coverage. | Needs focused diff review |
| `tests/retry-candidates.test.mjs` | Retry candidate selection coverage. | Needs focused diff review |
| `tests/schema-migration.test.mjs` | Queue schema migration coverage. | Needs focused diff review |
| `tests/simple-yaml.test.mjs` | YAML parser coverage. | Needs focused diff review |

## Documentation And Plans

| File | Purpose | Review Status |
| --- | --- | --- |
| `docs/superpowers/specs/2026-06-01-full-optimization-design.md` | Prior full optimization spec. | Needs final acceptance |
| `docs/superpowers/plans/2026-06-01-full-optimization.md` | Prior full optimization plan. | Needs final acceptance |
| `docs/superpowers/specs/2026-06-01-software-maturity-roadmap-design.md` | M1/M2/M3 maturity roadmap. | Approved by user |
| `docs/superpowers/plans/2026-06-01-software-maturity-m1.md` | M1 implementation plan. | Approved for inline execution |
| `docs/superpowers/reports/2026-06-01-m1-change-audit.md` | This change grouping report. | M1 evidence |
| `docs/superpowers/reports/2026-06-01-m1-verification-matrix.md` | M1 verification gate matrix. | M1 evidence |

## Unrelated Or Uncertain Changes

These files need explicit classification before staging:

| File | Reason |
| --- | --- |
| `README.md` | Documentation changed outside the M1 plan. |
| `CLAUDE.md` | New agent instruction file; classify before staging. |
| `docs/superpowers/specs/2026-06-01-settings-popover-rail-overlap-design.md` | Separate prior workstream. |
| `docs/superpowers/plans/2026-06-01-settings-popover-rail-overlap-fixes.md` | Separate prior workstream. |
| `scripts/verify-app-clickability.cjs` | Verification script changed; likely relevant, but needs focused review. |
| `scripts/verify-app-shell.mjs` | Verification script changed; likely relevant, but needs focused review. |

## Review Rule

Do not use `git add -A`. Stage backend, frontend, tests, docs, and uncertain changes separately.

