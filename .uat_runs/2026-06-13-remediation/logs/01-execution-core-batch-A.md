# Batch A (Execution Core) — Checkpoint Report

## Commits (in order on master)
- 864dad6 feat(queue): define single-chapter task contracts
- c9da961 feat(queue): persist task contracts in schema v3
- 60a47d5 feat(server): enforce chapter contracts before runs
- 1122b08 fix(engine): stop runs at the single-chapter boundary
- a7864b3 fix(server): finish-event message reflects task/project completion
- 38c3e91 fix(engine): propagate immediate cancellation through model stages
- aedbdf2 feat(run): expose immediate cancelling state
- 40f7e22 fix(resume): make chapter checkpoints and finalization idempotent
- 1609860 fix(engine): restore legacy completed field on task-boundary return for backward compat

## Tests run / Pass-fail
- Execution-core focused set (task-contract, task-queue, schema-migration, agent-engine,
  model-client-retry, model-gateway, tool-runtime, app-server-probe, retry-candidates):
  158/158 PASS
- npm test (full suite): 629/629 PASS, 0 fail
- npm run verify:mvp: exit 0 (3 chapters, interrupt+recovered)
- npm run verify:longrun: exit 0 (20 chapters)
- npm run verify:faults: exit 0 (8 chapters, 2 injected faults, interrupt+recovered, reviewer passed)
- git diff --check: clean

## New behavior demonstrated
- Single-chapter task contracts compiled from NL instructions; chapter_gap / chapter_already_passed
  / ambiguous_task_scope rejections at the API boundary.
- Queue schema v3 persists contracts; v2→v3 migration; markCancelling idempotent.
- Engine stops at the single-chapter task boundary (idle/queued between tasks; completed at project end).
- Cancellation propagates as ProjectCancelledError through fact-check, memory extraction, and retries;
  AbortError never retried; memory watermark not advanced on cancel.
- Two-phase stop: /api/run/stop persists cancelling <500ms without project lock; idempotent;
  converges to cancelled with stop_latency_ms; no duplicate project_run_failed; terminal-state
  resurrection race closed.
- Resume-safe finalization: finalizeChapterFile idempotent (duplicate short-circuit), honors
  pre-aborted signal, no abort check in the rename→index critical section; resume from reviewing
  does not re-draft.

## Known risk / carry-forward (non-blocking, deferred to later tasks)
- committed_model_calls checkpoint field is a schema placeholder (always []) — future task wires producer.
- Duplicate finalize path trusts an existing complete final file's checksum without reconciling
  against the draft; stale-but-complete detection deferred to chapter-artifact truth-checker (Task B1.1).
- Disk error on upsertChapter in the post-rename window could momentarily leave a final without an
  index entry; self-healed by the duplicate-path resume.

## Reviewer decision: continue to Batch B (State/UI)

## Test log capture
command: npm test
exit_code: 0
passed_count: 629
failed_count: 0
commit: 1609860
