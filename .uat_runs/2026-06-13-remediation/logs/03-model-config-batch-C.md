# Batch C (Model Config) — Checkpoint Report

## Commits (in order on master)
- 890dd04 feat: validate compatible model configuration
- 915ed8a fix: save model settings transactionally
- d6e72b4 feat: add structured model connection probe
- 7a5521b feat: expose model connection test endpoint
- 8b8dc86 feat: test model connection from settings
- a067c94 fix: block runs with incomplete model config

## Tests run / Pass-fail
- Model Config target set (model-config-validation, settings-runtime, model-connection-test,
  app-server-probe, app-shell/settings-modal, app-shell/app-shell-static):
  90/90 PASS
- npm run verify:desktop-shell: exit 0
- npm run verify:app-shell: **FAILS** at `budget_config.max_model_calls === 77` assertion
  (line 429 of scripts/verify-app-shell.mjs). PRE-EXISTING on parent commit 8b8dc86 —
  confirmed by running verify:app-shell in a clean worktree at 8b8dc86 with the same
  failure. NOT introduced by Batch C. Flagged for program-level review.
- npm test: 683/684 PASS (the 1 fail is the long-known pre-existing
  tests/app-shell/chat-endpoints.test.mjs 400 vs 404 on /api/chat/send).
- git diff --check: clean

## New behavior demonstrated
- OpenAI-compatible configs strictly validated: provider/model_name/base_url/api_key_env
  with field-level Chinese error messages. base_url trailing slash normalized; api_key_env
  rejected if not matching the env-var regex (rejects shell-injection patterns like
  `XIAOMI_MIMO_API_KEY;Remove-Item`).
- Settings save is TRANSACTIONAL: project config + local secrets committed in one
  logical operation. Validation failure writes nothing. Project write failure writes
  neither secrets nor env. Secret write failure restores the old project snapshot
  (or throws `settings_rollback_failed` if the rollback itself fails). Runtime
  apply failure keeps durable files and returns `settings_runtime_apply_failed`
  (the only partial-runtime case; user is told to restart).
- Structured model connection probe: short request, structured error classification
  (configuration_missing / authentication_failed / model_not_found / network_unreachable
  / request_timeout / response_incompatible / provider_error). Caller cancellation
  re-throws AbortError. Secrets redacted from the error message.
- POST /api/settings/test-connection exposes the probe; never persists candidate values;
  appends a redacted `model_connection_tested` audit event.
- Settings modal: 测试连接 button with state machine (idle/testing/success/failure/
  aborted/saving), MiMo preset autofill, password field never echoes the saved key,
  inline field errors from server `fields` map, AbortSignal on close/switch.
- Run-time static guard: /api/commands/submit pre-checks the persisted active_model +
  local secret BEFORE starting the runner. Failure marks the task and project as
  `blocked` with HTTP 400 `configuration_missing` + `action: "open_settings"`.
  No network call, no model budget increment.

## Security check
- rg for `sk-[A-Za-z0-9]`, `temporary-test-key`, `ephemeral-key` across src/tests/docs:
  only TEST fixtures (with explicit assertions that the keys do NOT leak). The
  `sk-real-key` / `sk-secret-abcd1234` matches in `tests/chat-tools.test.mjs` and
  `tests/failure-resolve-flow.test.mjs` are clearly marked as fake keys with
  negative-leak assertions. No real keys in src or docs.

## Known risk / carry-forward
- PRE-EXISTING (NOT introduced by Batch C): `verify:app-shell` fails at
  budget_config.max_model_calls assertion (line 429). Confirmed identical failure
  on commit 8b8dc86. Flagged for program-level review or a separate task.
- PRE-EXISTING (NOT introduced by Batch C): `tests/app-shell/chat-endpoints.test.mjs`
  POST /api/chat/send expects 400 but gets 404. Confirmed on master baseline.
- The plan's expected `error.message` (in C1.1's shell-expression test) was a
  self-inconsistency: the plan's `super("模型配置不完整")` doesn't match
  `/环境变量名/`. The implementer resolved by joining field messages into
  `error.message`. Acceptable.
- The plan's `validateRunnableModelConfig` reference assumed the secret file is
  at `secretsRoot/secrets.json`. Implementation uses `loadLocalSecrets(secretsRoot)`
  which reads the same file. Consistent.

## Reviewer decision: continue to Program gates (R1: full verification)
