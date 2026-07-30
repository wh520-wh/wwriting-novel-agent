# UAT Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MiMo/OpenAI-compatible 配置在保存前完成严格校验，保存过程具备事务性，并提供不会消耗正式写作任务的连通性测试与运行前置检查。

**Architecture:** 将静态配置校验、密钥可用性检查、在线连通性探测拆成三个明确阶段。设置保存先构造候选配置并完整验证，全部通过后再落盘；连接测试使用短请求和结构化错误分类；真正运行任务前只复用本地静态资格检查，失败时直接阻断，不发起网络请求或消耗模型预算。

**Tech Stack:** Node.js ESM、原生 `node:test`、现有 provider adapter/model client、App Shell 设置弹窗

---

## Execution Contract

### Current Baseline

Confirm these existing entry points:

| Responsibility | Existing code | Current defect |
|---|---|---|
| Settings route | `serveSettingsUpdate` in `src/core/app-server.mjs` | Persists secret before project validation |
| Secret extraction | `persistModelSecretIfPresent` | Mutates request body and writes immediately |
| Project settings | `updateProjectSettings` in `src/core/settings-runtime.mjs` | URL validation is incomplete for compatible providers |
| Secret store | `saveLocalSecret` / `loadLocalSecretsSync` | Has single-secret writes but no candidate transaction |
| Provider transport | `OpenAICompatibleAdapter` | Errors need stable connection-test classification |
| Model client | `ModelClient.generate` | Retry defaults are too expensive for a probe |
| Settings UI | `saveModelSection` in `src/app-shell/settings-modal.js` | No test-connection state machine |
| API client | `postJson` in `src/app-shell/api-client.js` | Drops structured field errors and has no caller signal |

Baseline command:

```powershell
rg -n "serveSettingsUpdate|persistModelSecretIfPresent|updateProjectSettings|saveLocalSecret|loadLocalSecretsSync|class OpenAICompatibleAdapter|class ModelClient|saveModelSection|function postJson" src tests
git status --short
```

Expected: all anchors exist and the dirty baseline is recorded.

### Canonical Configuration Shape

Persisted project configuration:

```ts
type ActiveModelConfig = {
  provider: "mock" | "openai-compatible";
  model_name: string;
  base_url?: string;
  api_key_env?: string;
  pricing?: {
    input_per_million: number;
    output_per_million: number;
    cache_hit_per_million?: number;
  };
};
```

The transient request may additionally contain:

```ts
type ActiveModelCandidate = ActiveModelConfig & {
  api_key?: string;
};
```

`api_key` must be removed before serializing `project.yaml`, returning HTTP JSON, appending an event, or
logging an error.

### Static Validation Rules

Apply these rules in order:

| Provider | Field | Rule | Error field |
|---|---|---|---|
| All | `provider` | Non-empty supported provider | `provider` |
| All | `model_name` | Non-empty after trim | `model_name` |
| `mock` | `base_url` | Ignored | None |
| `mock` | `api_key_env` | Ignored | None |
| `openai-compatible` | `base_url` | Valid absolute HTTP(S) URL | `base_url` |
| `openai-compatible` | `api_key_env` | `/^[A-Za-z_][A-Za-z0-9_]*$/` | `api_key_env` |
| `openai-compatible` | Secret | Existing secret or non-empty candidate `api_key` | `api_key` |

Normalize:

```js
{
  provider: input.provider.trim(),
  model_name: input.model_name.trim(),
  base_url: input.base_url.trim().replace(/\/+$/, ""),
  api_key_env: input.api_key_env.trim(),
}
```

Do not lowercase model names, environment variable names, or URL paths.

### Validation Result And Error Payload

Internal error:

```js
new ModelConfigValidationError({
  base_url: "请输入合法的 HTTP(S) 兼容接口地址",
  api_key: "请填写 API Key 或保留已配置密钥"
})
```

HTTP response:

```json
{
  "ok": false,
  "code": "configuration_missing",
  "message": "模型配置不完整",
  "fields": {
    "base_url": "请输入合法的 HTTP(S) 兼容接口地址",
    "api_key": "请填写 API Key 或保留已配置密钥"
  },
  "action": "open_settings",
  "projectRoot": "D:\\Novels\\demo"
}
```

The UI must use `fields` for inline messages and `message` for the summary. It must not parse error text to
infer a field.

### MiMo Preset Contract

Use the existing product preset:

```js
{
  title: "小米 MiMo 官方",
  provider: "openai-compatible",
  base_url: "https://api.xiaomimimo.com/v1",
  api_key_env: "XIAOMI_MIMO_API_KEY",
  models: ["mimo-v2.5-pro", "mimo-v2-pro"]
}
```

The implementation must not rename the environment variable to `MIMO_API_KEY` or invent
`mimo-v2-flash`.

### Settings Save Transaction

Treat project configuration and local secrets as one logical transaction:

```text
read old project + old secrets
        |
build candidate in memory
        |
validate fields + secret availability
        |
write candidate project atomically
        |
write candidate secrets atomically
        |
apply secrets to process.env
        |
return success
```

Rollback rules:

1. Validation failure writes nothing.
2. Project write failure writes neither candidate secrets nor environment variables.
3. Secret write failure restores the exact old project snapshot with `saveProject`.
4. If rollback fails, return `settings_rollback_failed`, preserve both original and rollback errors in server
   diagnostics, and do not claim success.
5. `process.env` is updated only after both durable writes succeed.
6. The old secret remains when the password field is blank.
7. Changing `api_key_env` with a blank password requires a secret under the new environment name.

Implement an orchestration helper with injected writes for fault tests:

```js
export async function saveModelSettingsTransaction({
  projectRoot,
  secretsRoot,
  candidate,
  readProject = loadProject,
  writeProject = saveProject,
  readSecrets = loadLocalSecrets,
  writeSecrets = saveLocalSecrets,
  applySecrets = applyLocalSecretsToEnv,
}) {
  // Validate, prepare snapshots, commit, rollback on second-write failure.
}
```

If `saveLocalSecrets` does not exist, add it beside `saveLocalSecret` and implement it with
`writeJsonAtomic` plus the same permission handling.

### Transaction Fault Tests

Add deterministic tests for all commit boundaries:

| Injected failure | Expected project | Expected secrets | Expected env |
|---|---|---|---|
| Validation | Old | Old | Old |
| Project write | Old | Old | Old |
| Secret write | Restored old | Old | Old |
| Environment apply | New durable files; response failure with restart guidance | New | Process may be partial |

For environment-apply failure, do not roll durable files backward because another reader may already observe
them. Return `settings_runtime_apply_failed` and instruct restart; this is the only partial-runtime case.

### Connection Test Request

`POST /api/settings/test-connection`:

```json
{
  "projectRoot": "D:\\Novels\\demo",
  "active_model": {
    "provider": "openai-compatible",
    "model_name": "mimo-v2.5-pro",
    "base_url": "https://api.xiaomimimo.com/v1",
    "api_key_env": "XIAOMI_MIMO_API_KEY",
    "api_key": "temporary-value-not-persisted"
  }
}
```

Rules:

1. Validate the unsaved candidate.
2. Prefer non-empty candidate `api_key`; otherwise read the existing secret.
3. Do not call `saveProject`, `saveLocalSecret`, `saveLocalSecrets`, or `applyLocalSecretsToEnv`.
4. Do not append chat history.
5. Append one redacted `model_connection_tested` event.
6. Return the resolved `projectRoot`.

### Connection Probe Contract

Probe request:

```js
await complete({
  config,
  apiKey,
  messages: [{ role: "user", content: "仅回复 OK" }],
  maxTokens: 4,
  signal,
});
```

The production `complete` implementation must reuse the existing adapter:

```js
export async function completeOpenAICompatibleProbe({
  config,
  apiKey,
  messages,
  maxTokens,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  const adapter = new OpenAICompatibleAdapter({ fetchImpl });
  return adapter.generate({
    model: config.model_name,
    modelConfig: {
      ...config,
      api_key: apiKey,
      max_output_tokens: maxTokens,
      stream: false,
    },
    messages,
    metadata: {},
    signal,
  });
}
```

The 10-second timeout and single-attempt behavior belong to `testModelConnection`, which calls the adapter
directly once. Do not route the probe through `ModelClient.generate`, because its normal retry policy is not
appropriate for a user-clicked diagnostic.

Success response:

```json
{
  "ok": true,
  "provider": "openai-compatible",
  "model_name": "mimo-v2.5-pro",
  "latency_ms": 248,
  "projectRoot": "D:\\Novels\\demo"
}
```

The response body from the provider is used only to confirm compatible parsing and is not returned.

### Stable Error Classification

Use this exact public error vocabulary:

| Condition | Public code | HTTP status |
|---|---|---:|
| Missing/invalid candidate field or key | `configuration_missing` | 400 |
| Provider 401 or 403 | `authentication_failed` | 200 probe result |
| Provider 404 or explicit unknown-model response | `model_not_found` | 200 probe result |
| DNS, connection refused, socket failure | `network_unreachable` | 200 probe result |
| 10-second timeout | `request_timeout` | 200 probe result |
| HTTP success but unsupported JSON | `response_incompatible` | 200 probe result |
| Provider 429, 5xx, or uncategorized provider failure | `provider_error` | 200 probe result |
| User closes modal or switches project | Throw `AbortError` | No toast for stale scope |

The endpoint returns HTTP 200 for a completed connectivity diagnosis, even when `ok: false`. It returns HTTP
400 only when the request itself is malformed or missing configuration.

### Secret Redaction

Before logging or returning any provider error:

```js
function redactSecrets(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets.filter(Boolean)) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}
```

Also redact:

- `Authorization: Bearer ...`;
- JSON keys named `api_key`, `apiKey`, `token`, or `authorization`;
- query parameters matching `key`, `api_key`, or `token`.

Tests must assert that the full candidate key does not appear in:

1. HTTP response JSON.
2. `run_log.jsonl`.
3. thrown error message.
4. project YAML.
5. local test snapshots.

### Audit Event

```js
{
  type: "model_connection_tested",
  severity: result.ok ? "info" : "warn",
  stage: "settings",
  message: result.ok ? "model connection succeeded" : "model connection failed",
  data: {
    provider: config.provider,
    model_name: config.model_name,
    base_url_origin: new URL(config.base_url).origin,
    ok: result.ok,
    code: result.code ?? null,
    latency_ms: result.latency_ms ?? null
  }
}
```

Do not store URL paths if they might carry tenant identifiers or credentials.

### Settings UI State Machine

| State | Test button | Save button | Status text |
|---|---|---|---|
| `idle` | Enabled | Enabled | Empty |
| `testing` | Disabled, `正在连接…` | Disabled | `正在连接…` |
| `success` | Enabled | Enabled | `连接成功 · N ms` |
| `failure` | Enabled | Enabled | Server actionable message |
| `aborted` | Enabled | Enabled | Empty |
| `saving` | Disabled | Disabled | Existing save progress |

Closing the modal or changing project aborts `testing` and clears the temporary key. Reopening the modal never
prefills the secret; show only `已配置，可留空保持不变`.

### Run-Time Static Guard

Before starting the runner:

1. Load effective active model.
2. Run static validation.
3. Check the referenced local secret.
4. Do not call the provider.
5. Do not increment `active_budget.model_calls`.
6. On failure, persist task and project as `blocked`.
7. Return `configuration_missing` with `action: "open_settings"`.

The online connection probe is never automatic. It runs only after an explicit user click.

### Existing Test Harness

Use:

| Test file | Helper |
|---|---|
| `tests/app-server-probe.test.mjs` | `setupServer`, `postJson`, `closeServer` |
| `tests/settings-runtime.test.mjs` | Existing temporary project patterns |
| `tests/model-client-retry.test.mjs` | Adapter injection patterns |
| `tests/app-shell/*` | Minimal DOM stubs |

Inject failures through function parameters instead of changing global filesystem behavior.

### Per-Task Definition Of Done

1. Focused tests prove the failure before the fix.
2. No test or event contains a real key.
3. Invalid save leaves old project and secret byte-equivalent.
4. Probe never persists candidate values.
5. Runtime guard makes zero provider calls and zero budget increments.
6. `git diff --check` is clean.
7. Only task-listed files are committed.

### Task 1: 严格校验 OpenAI-compatible 配置

**Files:**
- Create: `src/core/model-config-validation.mjs`
- Create: `tests/model-config-validation.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelConfigValidationError,
  validateModelConfig,
} from "../src/core/model-config-validation.mjs";

test("openai-compatible requires base_url and api_key_env", () => {
  assert.throws(
    () => validateModelConfig({
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "",
      api_key_env: "",
    }),
    (error) => {
      assert.equal(error instanceof ModelConfigValidationError, true);
      assert.deepEqual(error.fields, {
        base_url: "请输入兼容接口地址",
        api_key_env: "请输入 API Key 环境变量名",
      });
      return true;
    },
  );
});

test("MiMo compatible configuration is normalized", () => {
  const config = validateModelConfig({
    provider: "openai-compatible",
    model_name: "mimo-v2.5-pro",
    base_url: "https://api.xiaomimimo.com/v1/",
    api_key_env: "XIAOMI_MIMO_API_KEY",
  });

  assert.equal(config.base_url, "https://api.xiaomimimo.com/v1");
  assert.equal(config.api_key_env, "XIAOMI_MIMO_API_KEY");
});

test("api_key_env rejects shell expressions", () => {
  assert.throws(
    () => validateModelConfig({
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY;Remove-Item",
    }),
    /环境变量名/,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/model-config-validation.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现校验器**

```js
export class ModelConfigValidationError extends Error {
  constructor(fields) {
    super("模型配置不完整");
    this.name = "ModelConfigValidationError";
    this.code = "configuration_missing";
    this.fields = fields;
  }
}

export function validateModelConfig(input) {
  const config = {
    provider: String(input?.provider ?? "").trim(),
    model_name: String(input?.model_name ?? "").trim(),
    base_url: String(input?.base_url ?? "").trim().replace(/\/+$/, ""),
    api_key_env: String(input?.api_key_env ?? "").trim(),
  };
  const fields = {};
  if (!config.provider) fields.provider = "请选择模型提供商";
  if (!config.model_name) fields.model_name = "请输入模型名称";
  if (config.provider === "openai-compatible") {
    if (!config.base_url) fields.base_url = "请输入兼容接口地址";
    if (!config.api_key_env) fields.api_key_env = "请输入 API Key 环境变量名";
  }
  if (config.base_url) {
    try {
      const url = new URL(config.base_url);
      if (!["http:", "https:"].includes(url.protocol)) {
        fields.base_url = "接口地址必须使用 HTTP 或 HTTPS";
      }
    } catch {
      fields.base_url = "接口地址格式无效";
    }
  }
  if (config.api_key_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key_env)) {
    fields.api_key_env = "API Key 环境变量名格式无效";
  }
  if (Object.keys(fields).length > 0) {
    throw new ModelConfigValidationError(fields);
  }
  return config;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/model-config-validation.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/model-config-validation.mjs tests/model-config-validation.test.mjs
git commit -m "feat: validate compatible model configuration"
```

### Task 2: 让设置保存具备事务性

**Files:**
- Modify: `src/core/local-secrets.mjs`
- Modify: `src/core/settings-runtime.mjs`
- Modify: `src/core/app-server.mjs`
- Create: `tests/local-secrets.test.mjs`
- Modify: `tests/settings-runtime.test.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("invalid candidate leaves project settings and secrets unchanged", async () => {
  const { server, port, projectRoot, secretsRoot } = await setupServer();
  const project = await loadProject(projectRoot);
  await saveProject(projectRoot, {
    ...project,
    active_model: {
      provider: "openai-compatible",
      model_name: "old-model",
      base_url: "https://old.example/v1",
      api_key_env: "OLD_KEY",
    },
  });
  await saveLocalSecret(secretsRoot, "OLD_KEY", "old-secret-value");
  const beforeProject = await loadProject(projectRoot);
  const beforeSecrets = loadLocalSecretsSync(secretsRoot);

  const { res, data } = await postJson(port, "/api/settings/update", {
    projectRoot,
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "",
      api_key_env: "XIAOMI_MIMO_API_KEY",
      api_key: "new-secret",
    },
  });

  assert.equal(res.status, 400);
  assert.equal(data.code, "configuration_missing");
  assert.deepEqual(await loadProject(projectRoot), beforeProject);
  assert.deepEqual(loadLocalSecretsSync(secretsRoot), beforeSecrets);
  await closeServer(server);
});

test("valid candidate persists project config and secret together", async () => {
  const { server, port, projectRoot, secretsRoot } = await setupServer();
  const { res } = await postJson(port, "/api/settings/update", {
    projectRoot,
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
      api_key: "temporary-test-key",
    },
  });

  assert.equal(res.status, 200);
  assert.equal(
    (await loadProject(projectRoot)).active_model.model_name,
    "mimo-v2.5-pro",
  );
  assert.equal(
    loadLocalSecretsSync(secretsRoot).XIAOMI_MIMO_API_KEY,
    "temporary-test-key"
  );
  await closeServer(server);
});

const validCandidate = {
  provider: "openai-compatible",
  model_name: "mimo-v2.5-pro",
  base_url: "https://api.xiaomimimo.com/v1",
  api_key_env: "XIAOMI_MIMO_API_KEY",
  api_key: "temporary-test-key",
};

test("project write failure leaves secrets and runtime untouched", async () => {
  const calls = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => ({
        active_model: { provider: "mock", model_name: "old" },
      }),
      writeProject: async () => {
        calls.push("writeProject");
        throw new Error("project disk full");
      },
      readSecrets: async () => ({ OLD_KEY: "old-secret" }),
      writeSecrets: async () => calls.push("writeSecrets"),
      applySecrets: () => calls.push("applySecrets"),
    }),
    /project disk full/
  );
  assert.deepEqual(calls, ["writeProject"]);
});

test("secret write failure restores the old project snapshot", async () => {
  const oldProject = {
    active_model: { provider: "mock", model_name: "old" },
  };
  const writes = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => oldProject,
      writeProject: async (root, value) => writes.push(value),
      readSecrets: async () => ({ OLD_KEY: "old-secret" }),
      writeSecrets: async () => {
        throw new Error("secret disk full");
      },
      applySecrets: () => assert.fail("must not apply runtime secrets"),
    }),
    (error) => error.code === "settings_save_failed"
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].active_model.model_name, "mimo-v2.5-pro");
  assert.deepEqual(writes[1], oldProject);
});

test("runtime apply failure keeps durable new files and requests restart", async () => {
  const writes = [];
  await assert.rejects(
    () => saveModelSettingsTransaction({
      projectRoot: "project",
      secretsRoot: "secrets",
      activeModel: validCandidate,
      readProject: async () => ({
        active_model: { provider: "mock", model_name: "old" },
      }),
      writeProject: async (root, value) =>
        writes.push(["project", value.active_model.model_name]),
      readSecrets: async () => ({}),
      writeSecrets: async (root, value) =>
        writes.push(["secrets", value.XIAOMI_MIMO_API_KEY]),
      applySecrets: () => {
        throw new Error("runtime apply failed");
      },
    }),
    (error) => error.code === "settings_runtime_apply_failed"
  );
  assert.deepEqual(writes, [
    ["project", "mimo-v2.5-pro"],
    ["secrets", "temporary-test-key"],
  ]);
});
```

在 `tests/app-server-probe.test.mjs` 的导入中加入
`loadProject`、`saveProject`、`loadLocalSecretsSync` 和 `saveLocalSecret`。
在 `tests/settings-runtime.test.mjs` 中导入
`saveModelSettingsTransaction`。
与该文件其他 server 测试一致，把每个测试主体包在 `try/finally` 中，并在
`finally` 调用 `await closeServer(server)`；上面末尾的直接关闭语句移入该块。

- [ ] **Step 2: 运行测试确认失败**

Run:
`node --test tests/settings-runtime.test.mjs tests/app-server-probe.test.mjs`

Expected: FAIL，当前实现可能先写 secret，再发现项目设置无效。

- [ ] **Step 3: 重排保存流程**

在 server handler 中严格按以下顺序处理：

1. 解析并校验 `projectRoot`。
2. 使用 `validateModelConfig` 构造候选 `active_model`。
3. 从 `active_model.api_key` 读取临时密钥，确认候选的 `api_key_env` 已有旧 secret，
   或本次请求提供了非空临时密钥；构造持久化项目配置时必须删除 `api_key`。
4. 计算完整的新项目 JSON 和新 secrets JSON，但此时不写磁盘。
5. 先通过现有原子写接口写项目配置，再写 secrets；若 secrets 写失败，立即用保存前快照恢复项目配置并返回 `settings_save_failed`。
6. 两者成功后才调用 `applyLocalSecretsToEnv` 和刷新运行时配置。

将 `ModelConfigValidationError.fields` 原样映射为 400 响应，便于前端定位具体输入框。

在 `local-secrets.mjs` 增加完整对象读写：

```js
export async function loadLocalSecrets(secretsRoot = defaultSecretsRoot()) {
  const root = path.resolve(secretsRoot);
  return normalizeSecrets(
    (await readJson(path.join(root, SECRET_FILE_NAME), {})) ?? {}
  );
}

export async function saveLocalSecrets(secretsRoot, candidate) {
  const root = path.resolve(secretsRoot ?? defaultSecretsRoot());
  const secrets = normalizeSecrets(candidate);
  await ensureDir(root);
  const filePath = path.join(root, SECRET_FILE_NAME);
  await writeJsonAtomic(filePath, secrets);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows ACLs do not map cleanly to chmod.
  }
  return secrets;
}
```

在 `settings-runtime.mjs` 增加事务函数：

```js
export async function saveModelSettingsTransaction({
  projectRoot,
  secretsRoot,
  activeModel,
  readProject = loadProject,
  writeProject = saveProject,
  readSecrets = loadLocalSecrets,
  writeSecrets = saveLocalSecrets,
  applySecrets = applyLocalSecretsToEnv,
}) {
  const oldProject = await readProject(projectRoot);
  const oldSecrets = await readSecrets(secretsRoot);
  const apiKey = String(activeModel?.api_key ?? "").trim();
  const persistedModel = validateModelConfig(activeModel);
  const existingSecret = oldSecrets[persistedModel.api_key_env] ?? "";
  if (
    persistedModel.provider === "openai-compatible" &&
    !apiKey &&
    !existingSecret
  ) {
    throw new ModelConfigValidationError({
      api_key: "请填写 API Key 或保留已配置密钥",
    });
  }

  const nextProject = {
    ...oldProject,
    active_model: persistedModel,
  };
  const nextSecrets = {
    ...oldSecrets,
    ...(apiKey ? { [persistedModel.api_key_env]: apiKey } : {}),
  };

  await writeProject(projectRoot, nextProject);
  try {
    await writeSecrets(secretsRoot, nextSecrets);
  } catch (error) {
    try {
      await writeProject(projectRoot, oldProject);
    } catch (rollbackError) {
      const failure = new Error("模型设置保存失败，且项目配置回滚失败");
      failure.code = "settings_rollback_failed";
      failure.cause = { error, rollbackError };
      throw failure;
    }
    const failure = new Error("模型设置保存失败，旧配置已恢复");
    failure.code = "settings_save_failed";
    failure.cause = error;
    throw failure;
  }

  try {
    applySecrets(nextSecrets);
  } catch (error) {
    const failure = new Error("配置已保存，但运行时加载失败，请重启应用");
    failure.code = "settings_runtime_apply_failed";
    failure.cause = error;
    throw failure;
  }

  return {
    project: nextProject,
    secrets: nextSecrets,
    secret_saved: Boolean(apiKey),
    secret_env: persistedModel.api_key_env ?? null,
  };
}
```

`serveSettingsUpdate` 只调用这个事务函数，不能再先调用
`persistModelSecretIfPresent`。

- [ ] **Step 4: 运行测试确认通过**

Run:
`node --test tests/settings-runtime.test.mjs tests/app-server-probe.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/local-secrets.mjs src/core/settings-runtime.mjs src/core/app-server.mjs tests/local-secrets.test.mjs tests/settings-runtime.test.mjs tests/app-server-probe.test.mjs
git commit -m "fix: save model settings transactionally"
```

### Task 3: 建立结构化模型连通性探测

**Files:**
- Create: `src/core/model-connection-test.mjs`
- Create: `tests/model-connection-test.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import { testModelConnection } from "../src/core/model-connection-test.mjs";

test("successful probe returns latency and provider identity", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    now: (() => {
      const values = [1000, 1125];
      return () => values.shift();
    })(),
    complete: async () => ({ text: "OK" }),
  });

  assert.deepEqual(result, {
    ok: true,
    provider: "openai-compatible",
    model_name: "mimo-v2.5-pro",
    latency_ms: 125,
  });
});

test("authentication failure is actionable and does not expose the key", async () => {
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "secret-value" },
    complete: async () => {
      const error = new Error("401 secret-value");
      error.status = 401;
      throw error;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "authentication_failed");
  assert.match(result.message, /API Key/);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("missing secret is rejected before making a network request", async () => {
  let calls = 0;
  const result = await testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: {},
    complete: async () => {
      calls += 1;
      return { text: "OK" };
    },
  });

  assert.equal(result.code, "configuration_missing");
  assert.equal(calls, 0);
});

test("connection probe propagates caller cancellation", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const pending = testModelConnection({
    config: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    secrets: { XIAOMI_MIMO_API_KEY: "test-key" },
    signal: controller.signal,
    complete: async ({ signal }) => {
      started.resolve();
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
  });

  await started.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/model-connection-test.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现探测服务**

`testModelConnection` 应：

1. 复用 `validateModelConfig`。
2. 从传入的 secrets 读取 `api_key_env`，不得把 key 放入返回值或日志。
3. 调用注入的 `complete`，默认值为 `completeOpenAICompatibleProbe`；提示词固定为要求仅返回
   `OK`，`max_tokens` 不超过 4，超时 10 秒且不重试。
4. 将缺少字段或密钥映射为 `configuration_missing`，401/403 映射为
   `authentication_failed`，404 映射为 `model_not_found`，超时映射为
   `request_timeout`，DNS/连接拒绝映射为 `network_unreachable`，无法解析兼容响应映射为
   `response_incompatible`，其余供应商错误映射为 `provider_error`。
5. 无论错误对象中是否含 key，返回前都对 message 做 secret 替换。
6. 接受调用方 `signal`，通过 `AbortSignal.any` 与 10 秒超时信号合并；调用方取消直接抛出
   `AbortError`，不转换成供应商错误。

核心调用结构：

```js
await complete({
  config,
  apiKey,
  messages: [{ role: "user", content: "仅回复 OK" }],
  maxTokens: 4,
  signal: combinedSignal,
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/model-connection-test.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/model-connection-test.mjs tests/model-connection-test.test.mjs
git commit -m "feat: add structured model connection probe"
```

### Task 4: 暴露连接测试 API

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("connection test validates unsaved candidate without persisting it", async () => {
  const seen = [];
  const { server, port, projectRoot, secretsRoot } = await setupServer({
    testModelConnection: async (input) => {
      seen.push(input);
      return {
        ok: true,
        provider: input.config.provider,
        model_name: input.config.model_name,
        latency_ms: 31,
      };
    },
  });
  const beforeProject = await loadProject(projectRoot);
  const beforeSecrets = await loadLocalSecrets(secretsRoot);

  const { res, data } = await postJson(port, "/api/settings/test-connection", {
    projectRoot,
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
      api_key: "ephemeral-key",
    },
  });

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(seen[0].config.model_name, "mimo-v2.5-pro");
  assert.deepEqual(await loadProject(projectRoot), beforeProject);
  assert.deepEqual(await loadLocalSecrets(secretsRoot), beforeSecrets);
  const events = await readEvents(projectRoot);
  assert.ok(events.some((event) =>
    event.type === "model_connection_tested" &&
    event.data?.ok === true &&
    JSON.stringify(event).includes("ephemeral-key") === false
  ));
  await closeServer(server);
});
```

在测试导入中加入 `loadLocalSecrets`，并按现有测试模式用 `try/finally`
保证 `closeServer(server)` 在断言失败时也会执行。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: FAIL，路由不存在。

- [ ] **Step 3: 实现路由**

增加 `POST /api/settings/test-connection`。路由使用请求中的候选配置和临时 key，
但不得调用任何项目或 secret 写入函数。响应始终使用结构化对象：

```js
{
  ok: boolean,
  code?: string,
  message?: string,
  provider: string,
  model_name: string,
  latency_ms?: number
}
```

为可测试性，在 `createAppShellServer` 选项中接受
`testModelConnection = null`；路由使用
`testModelConnection ?? runModelConnectionTest`，测试通过现有 `setupServer(options)`
把替身传入。测试连接结束后追加不含密钥、提示词或响应正文的
`model_connection_tested` 审计事件。

- [ ] **Step 4: 运行接口测试**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/app-server.mjs tests/app-server-probe.test.mjs
git commit -m "feat: expose model connection test endpoint"
```

### Task 5: 在设置弹窗增加测试连接和字段错误

**Files:**
- Modify: `src/app-shell/settings-modal.js`
- Modify: `src/app-shell/api-client.js`
- Modify: `src/app-shell/index.html`
- Modify: `src/app-shell/styles.css`
- Create: `tests/app-shell/settings-modal.test.mjs`
- Create: `tests/app-shell/app-shell-static.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import {
  formatConnectionStatus,
  submitModelConnectionTest,
} from "../../src/app-shell/settings-modal.js";

test("test connection posts the unsaved MiMo candidate", async () => {
  const calls = [];
  const controller = new AbortController();
  const result = await submitModelConnectionTest({
    postJsonImpl: async (pathname, body, options) => {
      calls.push({ pathname, body, signal: options.signal });
      return {
        ok: true,
        provider: "openai-compatible",
        model_name: "mimo-v2.5-pro",
        latency_ms: 48,
      };
    },
    projectRoot: "D:\\novels\\demo",
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    apiKey: "temporary-key",
    signal: controller.signal,
  });

  assert.equal(calls[0].pathname, "/api/settings/test-connection");
  assert.equal(calls[0].body.active_model.model_name, "mimo-v2.5-pro");
  assert.equal(calls[0].body.active_model.api_key, "temporary-key");
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(formatConnectionStatus(result), "连接成功 · 48 ms");
});

test("connection failure keeps the actionable provider message", () => {
  assert.equal(formatConnectionStatus({
    ok: false,
    code: "authentication_failed",
    message: "API Key 无效或无权限",
  }), "API Key 无效或无权限");
});

test("test connection propagates AbortSignal", async () => {
  const controller = new AbortController();
  const pending = submitModelConnectionTest({
    postJsonImpl: async (pathname, body, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      });
    },
    projectRoot: "D:\\novels\\demo",
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "https://api.xiaomimimo.com/v1",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
    apiKey: "temporary-key",
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
`node --test tests/app-shell/settings-modal.test.mjs tests/app-shell/app-shell-static.test.mjs`

Expected: FAIL，没有测试连接行为和字段级错误展示。

- [ ] **Step 3: 实现 UI**

在保存按钮旁增加“测试连接”按钮，状态依次为：

- 默认：`测试连接`
- 请求中：`正在连接…`，保存与测试按钮均禁用
- 成功：`连接成功 · 48 ms`
- 失败：显示后端 `message`，保留表单内容

MiMo 预设选择后填入：

```js
{
  provider: "openai-compatible",
  model_name: "mimo-v2.5-pro",
  base_url: "https://api.xiaomimimo.com/v1",
  api_key_env: "XIAOMI_MIMO_API_KEY"
}
```

密码输入框不得回显已有 key；已有 secret 时显示“已配置，可留空保持不变”。
关闭或切换项目时清空输入框中的临时 key 和连接状态。

把 `api-client.js` 的 `postJson` 签名扩展为
`postJson(url, body, { signal } = {})` 并把 signal 传入 fetch。错误响应还要保留
`code`、`fields` 和 `action`，供设置弹窗把后端裁决显示到对应字段。为测试和取消连接请求，
把设置弹窗构造函数改为
`createSettingsModal(ctx, { getJsonImpl = getJson, postJsonImpl = postJson } = {})`，
所有设置请求只调用注入后的函数。导出纯函数 `submitModelConnectionTest` 和
`formatConnectionStatus`，弹窗内部的按钮也调用这两个函数；关闭弹窗或切换项目时
abort 当前连接测试。

- [ ] **Step 4: 运行 UI 测试**

Run:
`node --test tests/app-shell/settings-modal.test.mjs tests/app-shell/app-shell-static.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/settings-modal.js src/app-shell/api-client.js src/app-shell/index.html src/app-shell/styles.css tests/app-shell/settings-modal.test.mjs tests/app-shell/app-shell-static.test.mjs
git commit -m "feat: test model connection from settings"
```

### Task 6: 在运行前执行静态模型资格校验

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("invalid legacy model config blocks a task without provider access", async () => {
  let runCalls = 0;
  const { server, port, projectRoot } = await setupServer({
    testRunProject: async () => {
      runCalls += 1;
    },
  });
  const project = await loadProject(projectRoot);
  await saveProject(projectRoot, {
    ...project,
    active_model: {
      provider: "openai-compatible",
      model_name: "mimo-v2.5-pro",
      base_url: "",
      api_key_env: "XIAOMI_MIMO_API_KEY",
    },
  });

  const { res, data } = await postJson(port, "/api/commands/submit", {
    projectRoot,
    message: "写第 1 章",
  });

  assert.equal(res.status, 400);
  assert.equal(data.code, "configuration_missing");
  assert.equal(runCalls, 0);
  const queue = await getJson(port, "/api/queue/state");
  assert.equal(queue.data.tasks.length, 1);
  assert.equal(queue.data.tasks[0].status, "blocked");
  assert.equal(queue.data.tasks[0].error, "configuration_missing");
  const state = await loadState(projectRoot);
  assert.equal(state.project_status, "blocked");
  assert.equal(state.blocked_reason, "模型配置不完整");
  await closeServer(server);
});
```

该测试同样使用 `try/finally` 关闭 server，并把 `saveProject` 加入
`project-store.mjs` 导入。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: FAIL，旧项目中的无效活动配置仍可能进入 runner。

- [ ] **Step 3: 接入前置检查**

`/api/commands/submit` 在编译任务合同后、启动 runner 前调用
`validateRunnableModelConfig`。该函数只做本地静态检查：

1. 复用 `validateModelConfig` 校验 `provider/model_name/base_url/api_key_env`。
2. 对 `openai-compatible` 从本机 secrets 检查 `api_key_env` 对应值非空。
3. 不发起网络请求，不调用 model client，不增加模型调用预算。
4. 校验失败时仍保留审计所需的任务记录，但立即把任务和项目都置为 `blocked`，
   返回 `400 configuration_missing` 与字段级错误。
5. 错误响应附带 `action: "open_settings"`，让 App Shell 直接引导用户修复配置。

保存设置时继续执行同一静态校验；在线可达性只由用户明确点击“测试连接”触发。

- [ ] **Step 4: 运行接口测试**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/app-server.mjs tests/app-server-probe.test.mjs
git commit -m "fix: block runs with incomplete model config"
```

### Task 7: 模型配置子系统回归验证

**Files:**
- Modify only if a failing assertion exposes a defect in files already listed above.

- [ ] **Step 1: 运行目标测试**

Run:

```bash
node --test tests/model-config-validation.test.mjs
node --test tests/settings-runtime.test.mjs
node --test tests/model-connection-test.test.mjs
node --test tests/app-server-probe.test.mjs
node --test tests/app-shell/settings-modal.test.mjs
node --test tests/app-shell/app-shell-static.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行设置与桌面壳验证**

Run:

```bash
npm run verify:app-shell
npm run verify:desktop-shell
```

Expected: 两条命令退出码均为 0。

- [ ] **Step 3: 运行完整测试**

Run: `npm test`

Expected: 全部 PASS。

- [ ] **Step 4: 检查差异**

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 5: 提交必要的验证修复**

仅当本任务产生了修复时执行：

```bash
git add src/core src/app-shell tests
git commit -m "test: complete model configuration coverage"
```
