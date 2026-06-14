# Batch B (State/UI) — Checkpoint Report

## Commits (in order on master)
- 35d3705 feat: inspect chapter artifacts from disk
- efc7ce3 fix: derive dashboard completion from artifact truth
- 94dc68f fix: make chapter artifact inspection total to protect dashboard from one bad file
- 684c3ea fix: scope project requests explicitly
- 3e4b853 feat: track frontend project generations
- 116cc5c fix: discard stale project responses
- a2699e9 fix: render chapter cards from artifact truth
- 7ff6ddd feat: show cancellation in progress

## Tests run / Pass-fail
- State/UI target set (chapter-artifact, app-dashboard, app-server-probe,
  project-scope, app-shell-project-switch, chapter-presentation, agent-truth,
  app-shell-static): 93/93 PASS
- npm run verify:app-shell: exit 0 (completedChapters 2, artifact-truth counting
  agrees with real engine writes)
- npm test: 662 pass, 1 fail (pre-existing on master, NOT introduced by Batch B —
  `tests/app-shell/chat-endpoints.test.mjs:147` expects 400 from POST
  /api/chat/send with no project, gets 404. Confirmed by code reviewers at B1.3
  and B2.2 to exist on parent commit prior to any Batch B work.)
- git diff --check: clean

## New behavior demonstrated
- chapter-artifact inspector classifies each chapter as committed / committing /
  draft_only / invalid (with reason), with checksum cache and total error
  handling (no per-chapter FS error 500s the dashboard).
- Dashboard completedChapters counts only committed artifacts; chapters carry
  an artifact field preserving the index status.
- Project-data HTTP endpoints accept an explicit projectRoot (query) /
  expectedProjectRoot (body); writes are rejected with 409 PROJECT_SCOPE_CHANGED
  when selected has moved; reads never mutate selected.
- Frontend projectScope activation drops stale responses and runs a Switch
  Cleanup Matrix (dashboard, thread, toasts, reader, composer, badges,
  live block, lastAnnounce, etc.).
- Chapter cards now render strictly from artifact truth — only committed
  artifacts get the openable "已写入本地文件" affordance; draft-only cancelling
  shows "正在停止，草稿将保留"; invalid shows "产物状态异常".
- Run-status UI shows "正在取消第 N 章" with the stop button hidden and a
  screen-reader "正在停止" announcement; cancelling is distinct from cancelled
  terminal ("已停止").

## Known risk / carry-forward
- The pre-existing chat-send 400/404 test failure (not introduced by Batch B) —
  flagged for the program-level review or a follow-up task.
- A2 cross-plan tension (State/UI plan wanted body-scoped /api/run/stop and
  /api/chat/stop; Execution Core Task 6 forbids body-parsing on stop for the
  500ms SLA). Stop left on resolveActiveProjectRoot(selected) — defensible.
- Workspace-clause in resolveReadProjectRoot expands the read allow-list
  beyond the plan's literal text (any project.yaml inside the workspace is
  readable). Acceptable for a local single-user app.
- The `committed_model_calls` checkpoint field remains a schema placeholder
  (carry-over from Batch A).
- `clearArtifactCache` lacks a test-only comment (carry-over from Batch B1.1).

## Reviewer decision: continue to Batch C (Model Config)
