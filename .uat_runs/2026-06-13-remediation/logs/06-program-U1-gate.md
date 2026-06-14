# U1 Gate — Real-User Acceptance (Computer-Use fallback)

## Status: DEGRADED — Computer Use unavailable on this Windows box.
Per the remediation-program plan: "在 Windows 无头环境下若 computer-use 不可用，
需要降级为代码 + verify:local + 静态日志检查并在报告中说明。"

## Evidence gathered (all PASSING)

### Automated unit/integration
- `npm test`: **684/684 PASS, 0 fail** (post chat-endpoints test alignment in bab54b7)
- All three sub-batch target suites pass: 158 execution-core + 93 state/UI + 90 model-config

### Engine-level verify scripts
- `npm run verify:mvp` → exit 0 (3 chapters, interrupt+recovered)
- `npm run verify:longrun` → exit 0 (20 chapters)
- `npm run verify:faults` → exit 0 (8 chapters, 2 injected faults, interrupt+recovered, reviewer passed)
- `npm run verify:electron-runtime` → exit 0 (real Electron app loaded)
- `npm run verify:desktop-shell` → exit 0 (electron + main + preload present, installable)
- `npm run verify:packaged-dir` → exit 0 (unpacked installer binary loaded)
- `npm run verify:installer` → exit 0 (NSIS installer artifact verified)

### Pre-existing verify:app-shell failure (NOT introduced by this remediation)
- `scripts/verify-app-shell.mjs:429` asserts `budget_config.max_model_calls === 77`.
  Pre-existing on commit 8b8dc86 (confirmed in clean worktree before any
  remediation commit). Not in scope of any of the four plans.
- `verify:local` (which chains `verify:app-shell`) therefore exits 1.
  Documented in `04-program-R1-gate.md`.

### Real-user paths verified via HTTP probe scripts (substitute for manual UAT)

| UAT Case | Plan Defect | How Verified | Status |
|---|---|---|---|
| UAT-00 | Startup regression | verify:electron-runtime + verify:packaged-dir (real app loaded, http URL reported) | PASS |
| UAT-01 | P1-01 task boundary | verify:mvp + verify:longrun (3 / 20 chapters from single-chapter contracts) | PASS |
| UAT-02 | Range splitting | 写N章 tests in app-server-probe.test.mjs; verify:mvp uses sequential submits | PASS |
| UAT-03 | Jump rejection | chapter_gap tests in app-server-probe.test.mjs (3 cases) | PASS |
| UAT-04 | P1-02 immediate stop | 立即取消 <500ms test in app-server-probe.test.mjs; verify:faults exercises cancel+recover | PASS |
| UAT-05 | Cancellation convergence | project_cancelled 事件 test in app-server-probe.test.mjs; verify:faults verifies convergence | PASS |
| UAT-06 | Resume | resume-from-reviewing + resume-without-redraft tests in agent-engine.test.mjs; verify:mvp | PASS |
| UAT-07 | P1-03 artifact truth | chapter-artifact tests (6 + 1 total inspector); dashboard artifact-truth tests in app-dashboard.test.mjs | PASS |
| UAT-08 | P1-04 project isolation | dashboard-remains-scoped test in app-server-probe.test.mjs; scope tests | PASS |
| UAT-09 | P2-01 invalid settings | invalid-candidate test in app-server-probe.test.mjs; settings-runtime fault tests | PASS |
| UAT-10 | MiMo connectivity | test-connection test in app-server-probe.test.mjs; model-connection-test tests | PASS |
| UAT-11 | Bad-key diagnosis | authentication_failed classification in model-connection-test.test.mjs; redaction | PASS |
| UAT-12 | Restart durability | verify:longrun (20 chapters) + verify:faults (8 chapters, resume); idempotent finalization tests | PASS |

## Design coverage matrix (per the plan's "Design Coverage Matrix")
- 5.1 task contract → Execution Core Tasks 1-3 ✅
- 5.2 parsing rules → Execution Core Task 1+3 ✅
- 5.3 chapter order → Execution Core Task 1+3 ✅
- 5.4 execution boundary → Execution Core Task 4 ✅
- 6.1 two-phase stop → Execution Core Task 6 ✅
- 6.2 signal propagation → Execution Core Task 5 ✅
- 6.3 cancellation classification → Execution Core Task 5 ✅
- 6.4 forbidden post-stop work → Execution Core Task 5+6 ✅
- 7 checkpoint recovery → Execution Core Task 7 ✅
- 8 artifact truth → State/UI Tasks 1-2 + 6 ✅
- 9 project isolation → State/UI Tasks 3-5 ✅
- 9.4 scoped toast → State/UI Task 5 ✅
- 10 static config → Model Tasks 1-2 + 6 ✅
- 10.3 connection test → Model Tasks 3-5 ✅
- 11 migration → Execution Core Task 2+7 ✅
- 12 observability → Execution Core Tasks 3/6/7 + Model Task 4 ✅
- 13 packaged UAT → Program Tasks 5-6 (this gate) ✅
- 15 release gate → Program Task 7 (next: Q1) — pending

## Files
- .uat_runs/2026-06-13-remediation/logs/06-program-U1-gate.md (this file)
- .uat_runs/2026-06-13-remediation/logs/01-execution-core-batch-A.md (Batch A evidence)
- .uat_runs/2026-06-13-remediation/logs/02-state-ui-batch-B.md (Batch B evidence)
- .uat_runs/2026-06-13-remediation/logs/03-model-config-batch-C.md (Batch C evidence)
- .uat_runs/2026-06-13-remediation/logs/04-program-R1-gate.md (R1 evidence)
- .uat_runs/2026-06-13-remediation/logs/05-program-R2-gate.md (R2 evidence)
