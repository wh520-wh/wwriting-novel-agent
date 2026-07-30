# UAT State Isolation and Artifact Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除项目切换时的跨项目状态污染，并让章节完成状态、文件卡片和下载入口严格反映磁盘上的真实产物。

**Architecture:** 后端以显式 `projectRoot` 作为请求作用域，不再让慢请求隐式依赖可变的当前项目；前端使用递增 generation 丢弃旧项目响应，并在切换时清理所有项目级临时状态。章节状态通过独立的 artifact inspector 读取索引、文件与校验和，仪表盘和线程渲染只消费统一的“产物真值”结构。

**Tech Stack:** Node.js ESM、原生 `node:test`、现有 App Shell DOM 渲染、JSON/Markdown 文件存储

---

## Execution Contract

### Current Baseline

Confirm these existing boundaries before Task 1:

| Responsibility | Existing code | Current defect |
|---|---|---|
| Dashboard data | `loadDashboardData` in `src/core/app-dashboard.mjs` | Counts `status === "completed"` without verifying the file |
| Dashboard route | `serveDashboard` in `src/core/app-server.mjs` | Reads mutable server-wide `selected` |
| Project selection | `selected` closure in `createAppShellServer` | Slow requests can observe a later project |
| Frontend refresh | `loadDashboard` in `src/app-shell/app.js` | Uses request sequence, not project identity |
| Project switch | `renderDashboard` | Clears only part of project-local transient state |
| Toast | `showToast` | Has no project scope or generation |
| File card | `attachChapterCard` in `src/app-shell/thread-renderer.js` | Always claims a local final file exists |
| Agent status | `deriveAgentTruth` in `src/app-shell/agent-truth.mjs` | Has no explicit `cancelling` truth |

Baseline command:

```powershell
rg -n "loadDashboardData|serveDashboard|let selected|async function loadDashboard|function renderDashboard|function showToast|function attachChapterCard|deriveAgentTruth" src tests
git status --short
```

Expected: all anchors exist; status is recorded before implementation.

### Canonical Artifact Response

Every dashboard chapter must expose this shape:

```ts
type ChapterArtifact = {
  state: "none" | "draft_only" | "committing" | "committed" | "invalid";
  reason:
    | null
    | "chapter_not_committed"
    | "missing_final_path"
    | "missing_checksum"
    | "invalid_path"
    | "missing_file"
    | "not_a_file"
    | "checksum_mismatch";
  path_exists: boolean;
  checksum_valid: boolean;
  readable: boolean;
  relative_path: string | null;
  checksum: string | null;
  bytes: number;
  modified_at: string | null;
};
```

Use these JSON property names in the HTTP response. The internal implementation may use camelCase only if
`loadDashboardData` converts once at the boundary; do not mix both styles in the response.

### Artifact Classification Algorithm

Apply the first matching rule:

| Priority | Index/file condition | `artifact.state` | Reason |
|---:|---|---|---|
| 1 | Chapter status is `finalizing` | `committing` | `null` |
| 2 | Status is not `completed`, readable draft exists | `draft_only` | `null` |
| 3 | Status is not `completed`, no readable draft/final | `none` | `chapter_not_committed` |
| 4 | Completed but `final_path` empty | `invalid` | `missing_final_path` |
| 5 | Completed but checksum empty | `invalid` | `missing_checksum` |
| 6 | Final path escapes project root | `invalid` | `invalid_path` |
| 7 | Final path missing | `invalid` | `missing_file` |
| 8 | Final path is not a regular file | `invalid` | `not_a_file` |
| 9 | Actual SHA-256 differs | `invalid` | `checksum_mismatch` |
| 10 | Completed, safe path, file exists, checksum matches | `committed` | `null` |

Only `committed` increments `summary.completedChapters`, contributes to completed progress, or enables
the chapter reader.

### Checksum Cache Contract

The cache key is:

```text
absolutePath + ":" + size + ":" + mtimeMs
```

The cache value contains:

```js
{
  checksum,
  checkedAt
}
```

Rules:

1. A changed size or mtime naturally misses the cache.
2. Do not cache `ENOENT`, permission errors, or invalid paths.
3. Keep the cache process-local; no new cache file is needed.
4. Export `clearArtifactCache()` only for deterministic tests.
5. Add a test proving a modified file is re-hashed and changes from `committed` to `invalid`.

### Project-Scoped Endpoint Inventory

Every project-level request below must carry `projectRoot` in the query string or JSON body. The server
must resolve that explicit root before reading mutable `selected`.

| Endpoint | Method | Scope location | Stale-scope behavior |
|---|---|---|---|
| `/api/dashboard` | GET | Query `projectRoot` | Return requested project only |
| `/api/diagnostics` | GET | Query | Reject unknown root |
| `/api/queue/state` | GET | Query | Return requested project only |
| `/api/chapters/read` | GET | Query | Validate chapter path under requested root |
| `/api/chat/history` | GET | Query | Return requested project only |
| `/api/commands/submit` | POST | Body | `409 PROJECT_SCOPE_CHANGED` if expected root is no longer active |
| `/api/run/stop` | POST | Body | Stop only the matching project's job |
| `/api/run/retry` | POST | Body | Retry only matching project |
| `/api/queue/cancel` | POST | Body | Cancel only matching queue |
| `/api/chat/send` | POST | Body | Append only to matching project |
| `/api/chat/confirm` | POST | Body | Confirm only matching project |
| `/api/chat/stop` | POST | Body | Stop only matching chat job |
| `/api/settings/update` | POST | Body | Save only matching project |
| `/api/settings/test-connection` | POST | Body | Audit under matching project |
| `/api/failures/resolve` | POST | Body | Resolve only matching project |

Project selection endpoints (`/api/projects/open`, `/api/projects/init`, `/api/projects/forget`) intentionally
change selection and therefore use their own target root rather than `expectedProjectRoot`.

### Server Scope Resolution

Use two helpers with distinct behavior:

```js
async function resolveReadProjectRoot({ requestedRoot, selected, stateRoot }) {
  // Accept selected or registered recent project with project.yaml.
  // Never mutate selected.
}

async function resolveWriteProjectRoot({
  requestedRoot,
  expectedProjectRoot,
  selected,
  stateRoot
}) {
  // Validate registration and existence.
  // Require samePath(expectedProjectRoot ?? requestedRoot, selected).
  // Throw HttpError(409, "PROJECT_SCOPE_CHANGED", ... ) on mismatch.
}
```

Do not have read requests update `selected`. Only open/init/forget flows may mutate the server-wide selection.

### Project Generation Contract

The frontend scope token is:

```ts
type ProjectRequestScope = {
  projectRoot: string | null;
  generation: number;
};
```

Increment generation on:

1. Successful project open.
2. Successful project creation.
3. Forgetting the selected project.
4. Switching to another project from the project list.
5. Rendering the empty no-project state.

Do not increment for ordinary dashboard polling within the same project.

Every async operation captures a token before awaiting:

```js
const scope = projectScope.capture();
const data = await request();
if (!projectScope.isCurrent(scope)) return { stale: true };
```

A stale response must not:

- mutate DOM;
- change `currentProjectRoot`;
- append a thread entry;
- show success or error toast;
- update busy state;
- update badge comparison baselines;
- schedule another project-specific refresh.

### Switch Cleanup Matrix

When generation changes, clear these values before the first new-project request renders:

| State | Current owner | Required reset |
|---|---|---|
| Toast DOM/timer | `showToast` in `app.js` | Remove node and cancel timer |
| Live agent block | thread renderer context | `setLiveBlock(null)` |
| Event fingerprints | `renderedKeys` | `.clear()` |
| Local side questions | `askEntries` | `.clear()` |
| Thread status aria live text | `refs.threadStatus` | `textContent = ""` |
| Chat busy | composer/chat controller | Abort or reset only old scope |
| Last announcement | `lastAnnounce` | Empty string |
| Activity baseline | activity strip state | Remove old project key from active comparison |
| Badge baseline | local storage helper | Load new project values; do not delete persisted old values |
| Reader preview | reader/modal state | Close and clear old chapter |
| Settings temporary key | settings modal | Abort test and blank password input |

Persisted project files, chat history, event log, and chapter index are never deleted by this cleanup.

### Toast Scope

Change the API to:

```js
function showToast(message, type = "info", {
  scope = projectScope.capture(),
  global = false,
} = {}) {
  if (!global && !projectScope.isCurrent(scope)) return;
  // render and retain scope on the toast record
}
```

Startup failures may pass `{ global: true }`. All project actions use the captured project scope.

### Rendering Truth Table

| Artifact/project state | Title | Tone | Reader enabled | Success icon |
|---|---|---|---|---|
| `committed` | `第 N 章已写入本地文件` | success | Yes | Yes |
| `committing` | `第 N 章正在定稿` | progress | No | No |
| `draft_only` + `cancelling` | `正在停止，草稿将保留` | warning | No | No |
| `draft_only` + `cancelled` | `已停止，第 N 章草稿已保留` | warning | No | No |
| `none` | No file card | neutral | No | No |
| `invalid` | `第 N 章产物状态异常，可尝试恢复` | warning | No | No |

The word count shown on a success card comes from the committed index entry. Draft-only and invalid cards
must not show the footer text `本地已保存`.

### Frontend Test Harness

New App Shell tests should use local minimal DOM stubs consistent with existing tests. The stub must implement
only APIs used by the module under test:

```js
function makeElement() {
  return {
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
    textContent: "",
    hidden: false,
    disabled: false,
  };
}
```

Do not add jsdom solely for this remediation.

### Per-Task Definition Of Done

For each task:

1. The focused test demonstrates the exact stale-response or artifact-truth defect.
2. The fix does not mutate the server selection from a read request.
3. Every new response includes the resolved `projectRoot`.
4. No non-committed artifact enables reader actions.
5. `git diff --check` is clean.
6. Only files listed by the task are committed.

### Task 1: 建立章节产物真值检查器

**Files:**
- Create: `src/core/chapter-artifact.mjs`
- Create: `tests/chapter-artifact.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectChapterArtifact } from "../src/core/chapter-artifact.mjs";
import { sha256 } from "../src/core/fs-utils.mjs";

async function makeProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-"));
  await mkdir(path.join(root, "chapters"), { recursive: true });
  return root;
}

test("missing final file overrides a completed index entry", async () => {
  const root = await makeProject();
  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: "chapters/001.md",
      checksum: "stale",
      actual_words: 1200,
    },
  });

  assert.equal(artifact.state, "invalid");
  assert.equal(artifact.reason, "missing_file");
});

test("existing file returns verified metadata and content checksum", async () => {
  const root = await makeProject();
  const relative = "chapters/001.md";
  const content = "# 第一章\n\n正文";
  await writeFile(path.join(root, relative), content, "utf8");
  const checksum = sha256(content);

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: relative,
      checksum,
      actual_words: 2,
    },
  });

  assert.equal(artifact.state, "committed");
  assert.equal(artifact.relative_path, relative);
  assert.equal(artifact.checksum, checksum);
  assert.equal(await readFile(artifact.absolute_path, "utf8"), "# 第一章\n\n正文");
});

test("readable draft without completed index is draft_only", async () => {
  const root = await makeProject();
  await mkdir(path.join(root, "drafts"), { recursive: true });
  await writeFile(path.join(root, "drafts", "001.draft.md"), "草稿", "utf8");

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "reviewing",
      draft_path: "drafts/001.draft.md",
    },
  });

  assert.equal(artifact.state, "draft_only");
  assert.equal(artifact.reason, null);
});

test("finalizing index is committing even before final file exists", async () => {
  const root = await makeProject();
  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: { status: "finalizing" },
  });

  assert.equal(artifact.state, "committing");
});

test("completed index without checksum is invalid", async () => {
  const root = await makeProject();
  await writeFile(path.join(root, "chapters", "001.md"), "正文", "utf8");

  const artifact = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry: {
      status: "completed",
      final_path: "chapters/001.md",
      checksum: null,
    },
  });

  assert.equal(artifact.state, "invalid");
  assert.equal(artifact.reason, "missing_checksum");
});

test("file metadata change invalidates the checksum cache", async () => {
  const root = await makeProject();
  const finalPath = path.join(root, "chapters", "001.md");
  await writeFile(finalPath, "初始正文", "utf8");
  const checksum = sha256("初始正文");
  const indexEntry = {
    status: "completed",
    final_path: "chapters/001.md",
    checksum,
  };

  assert.equal(
    (await inspectChapterArtifact({
      projectRoot: root,
      chapter: 1,
      indexEntry,
    })).state,
    "committed"
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(finalPath, "已经被修改的正文", "utf8");
  const changed = await inspectChapterArtifact({
    projectRoot: root,
    chapter: 1,
    indexEntry,
  });

  assert.equal(changed.state, "invalid");
  assert.equal(changed.reason, "checksum_mismatch");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/chapter-artifact.test.mjs`

Expected: FAIL，提示无法导入 `chapter-artifact.mjs`。

- [ ] **Step 3: 实现检查器**

```js
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside, sha256 } from "./fs-utils.mjs";

const artifactCache = new Map();

export async function inspectChapterArtifact({ projectRoot, chapter, indexEntry = {} }) {
  if (indexEntry.status === "finalizing") {
    return artifactState("committing", chapter);
  }
  if (indexEntry.status !== "completed") {
    const draftExists = await isReadableFile(projectRoot, indexEntry.draft_path);
    return artifactState(
      draftExists ? "draft_only" : "invalid",
      chapter,
      draftExists ? null : "chapter_not_committed"
    );
  }
  if (!indexEntry.final_path) {
    return artifactState("invalid", chapter, "missing_final_path");
  }
  if (!indexEntry.checksum) {
    return artifactState("invalid", chapter, "missing_checksum");
  }

  const indexedPath = indexEntry.final_path;
  const absolutePath = path.isAbsolute(indexedPath)
    ? path.resolve(indexedPath)
    : path.resolve(projectRoot, indexedPath);
  const relativePath = path.relative(projectRoot, absolutePath).replaceAll("\\", "/");
  if (!isPathInside(projectRoot, absolutePath)) {
    return artifactState("invalid", chapter, "invalid_path", {
      relative_path: relativePath,
    });
  }

  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return artifactState("invalid", chapter, "missing_file", {
        relative_path: relativePath,
      });
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    return artifactState("invalid", chapter, "not_a_file", {
      relative_path: relativePath,
    });
  }

  const cacheKey = `${absolutePath}:${fileStat.size}:${fileStat.mtimeMs}`;
  let checksum = artifactCache.get(cacheKey);
  if (!checksum) {
    const content = await readFile(absolutePath, "utf8");
    checksum = sha256(content);
    artifactCache.set(cacheKey, checksum);
  }

  if (indexEntry.checksum !== checksum) {
    return artifactState("invalid", chapter, "checksum_mismatch", {
      path_exists: true,
      readable: true,
      relative_path: relativePath,
      absolute_path: absolutePath,
      checksum,
      bytes: fileStat.size,
      modified_at: fileStat.mtime.toISOString(),
    });
  }
  return {
    chapter,
    state: "committed",
    path_exists: true,
    checksum_valid: true,
    readable: true,
    reason: null,
    relative_path: relativePath,
    absolute_path: absolutePath,
    checksum,
    bytes: fileStat.size,
    modified_at: fileStat.mtime.toISOString(),
  };
}

function artifactState(state, chapter, reason = null, extra = {}) {
  return {
    chapter,
    state,
    reason,
    path_exists: false,
    checksum_valid: false,
    readable: false,
    relative_path: null,
    checksum: null,
    bytes: 0,
    modified_at: null,
    ...extra,
  };
}

async function isReadableFile(projectRoot, candidate) {
  if (!candidate) return false;
  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);
  if (!isPathInside(projectRoot, absolutePath)) return false;
  try {
    return (await stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/chapter-artifact.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/chapter-artifact.mjs tests/chapter-artifact.test.mjs
git commit -m "feat: inspect chapter artifacts from disk"
```

### Task 2: 仪表盘只统计可用的真实产物

**Files:**
- Modify: `src/core/app-dashboard.mjs`
- Modify: `tests/app-dashboard.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `tests/app-dashboard.test.mjs` 增加两个场景：

```js
test("dashboard does not count an indexed chapter whose file is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-dashboard-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
  });
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "completed",
    final_path: path.join(projectRoot, "chapters", "001.md"),
    actual_words: 1200,
  });

  const dashboard = await loadDashboardData(root, { projectRoot });

  assert.equal(dashboard.summary.completedChapters, 0);
  assert.equal(dashboard.chapters[0].artifact.state, "invalid");
  assert.equal(dashboard.chapters[0].artifact.reason, "missing_file");
});

test("dashboard exposes a verified artifact for a readable chapter file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wwriting-artifact-dashboard-"));
  const { projectRoot } = await createProject(root, {
    slug: "project",
    target_chapters: 2,
  });
  const finalPath = path.join(projectRoot, "chapters", "001.md");
  const content = "# 第一章\n\n内容";
  await fs.writeFile(finalPath, content, "utf8");
  const checksum = sha256(content);
  await upsertChapter(projectRoot, {
    chapter_no: 1,
    status: "completed",
    final_path: finalPath,
    checksum,
    actual_words: 2,
  });

  const dashboard = await loadDashboardData(root, { projectRoot });

  assert.equal(dashboard.summary.completedChapters, 1);
  assert.equal(dashboard.chapters[0].artifact.state, "committed");
  assert.equal(dashboard.chapters[0].artifact.checksum, checksum);
});
```

同时把 `sha256` 和 `upsertChapter` 加入
`tests/app-dashboard.test.mjs` 的导入列表。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-dashboard.test.mjs`

Expected: FAIL，仪表盘仍按索引状态统计，且没有 `artifact` 字段。

- [ ] **Step 3: 接入检查器**

在构造章节列表时调用 `inspectChapterArtifact`，并以
`chapter.artifact.state === "committed"` 作为完成数统计条件。
对缺失或校验失败的文件保留索引状态，但增加：

```js
{
  artifact: {
    state: "invalid",
    reason: "missing_file" | "checksum_mismatch" | "invalid_path" | "not_a_file"
  }
}
```

这样既不篡改历史索引，又不会向 UI 谎报可下载文件。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/app-dashboard.test.mjs tests/chapter-artifact.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/app-dashboard.mjs tests/app-dashboard.test.mjs
git commit -m "fix: derive dashboard completion from artifact truth"
```

### Task 3: 为项目数据接口增加显式请求作用域

**Files:**
- Modify: `src/core/app-server.mjs`
- Modify: `tests/app-server-probe.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("dashboard request remains scoped to its requested project during a switch", async () => {
  const delayed = Promise.withResolvers();
  const started = Promise.withResolvers();
  let projectA = null;
  const fixture = await setupServer({
    testLoadDashboardData: async (workspace, options) => {
      if (samePath(options.projectRoot, projectA)) {
        started.resolve();
        await delayed.promise;
      }
      return loadDashboardData(workspace, options);
    },
  });
  projectA = fixture.projectRoot;
  const { projectRoot: projectB } = await createProject(fixture.root, {
    slug: "project-b",
    title: "Project B",
  });
  await recordRecentProject(fixture.stateRoot, {
    projectRoot: projectA,
    title: "Project A",
  });
  await recordRecentProject(fixture.stateRoot, {
    projectRoot: projectB,
    title: "Project B",
  });

  const pendingA = getJson(
    fixture.port,
    `/api/dashboard?projectRoot=${encodeURIComponent(projectA)}`,
  );
  await started.promise;

  await postJson(fixture.port, "/api/projects/open", {
    projectRoot: projectB,
  });
  const dashboardB = await getJson(
    fixture.port,
    `/api/dashboard?projectRoot=${encodeURIComponent(projectB)}`,
  );
  delayed.resolve();
  const dashboardA = await pendingA;

  assert.equal(dashboardA.data.projectRoot, projectA);
  assert.equal(dashboardB.data.projectRoot, projectB);
  await closeServer(fixture.server);
});

test("project-scoped endpoint rejects a root outside the registered project list", async () => {
  const { server, port } = await setupServer();
  const response = await fetch(
    `http://127.0.0.1:${port}/api/dashboard?projectRoot=${encodeURIComponent("C:\\unregistered")}`,
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_PROJECT_SCOPE");
  await closeServer(server);
});

test("write request is rejected after selected project changes", async () => {
  const fixture = await setupServer();
  const projectA = fixture.projectRoot;
  const { projectRoot: projectB } = await createProject(fixture.root, {
    slug: "project-b",
  });
  await recordRecentProject(fixture.stateRoot, { projectRoot: projectB });
  await postJson(fixture.port, "/api/projects/open", {
    projectRoot: projectB,
  });

  const { res, data } = await postJson(
    fixture.port,
    "/api/commands/submit",
    {
      projectRoot: projectA,
      expectedProjectRoot: projectA,
      message: "写第1章",
    },
  );

  assert.equal(res.status, 409);
  assert.equal(data.code, "PROJECT_SCOPE_CHANGED");
  const queueA = await getJson(
    fixture.port,
    `/api/queue/state?projectRoot=${encodeURIComponent(projectA)}`,
  );
  assert.equal(queueA.data.tasks.length, 0);
  await closeServer(fixture.server);
});
```

Wrap each server test in `try/finally`; the direct `closeServer` calls above belong in `finally`.
Add `samePath`, `loadDashboardData`, and `recordRecentProject` to the test imports.

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: FAIL，接口忽略查询参数或在切换后读取了新的当前项目。

- [ ] **Step 3: 实现项目根解析器**

Add `testLoadDashboardData = null` to `createAppShellServer` options and store:

```js
const dashboardLoader = testLoadDashboardData ?? loadDashboardData;
```

`serveDashboard` calls `context.dashboardLoader`, making the delay deterministic without production timers.

在 `app-server.mjs` 内建立统一辅助函数：

```js
async function resolveReadProjectRoot({
  requestedRoot,
  selected,
  stateRoot,
}) {
  const target = requestedRoot ?? selected;
  if (!target) {
    throw new HttpError(404, "no_project", "当前没有打开的项目");
  }
  const state = await loadAppState(stateRoot);
  const registered =
    samePath(selected, target) ||
    state.recentProjects.some((project) =>
      samePath(project.projectRoot, target)
    );
  if (!registered || !existsSync(path.join(target, "project.yaml"))) {
    throw new HttpError(400, "INVALID_PROJECT_SCOPE", "请求的项目未注册");
  }
  return path.resolve(target);
}

async function resolveWriteProjectRoot({
  requestedRoot,
  expectedProjectRoot,
  selected,
  stateRoot,
}) {
  const target = await resolveReadProjectRoot({
    requestedRoot,
    selected,
    stateRoot,
  });
  const expected = expectedProjectRoot ?? target;
  if (!samePath(expected, selected) || !samePath(target, selected)) {
    throw new HttpError(
      409,
      "PROJECT_SCOPE_CHANGED",
      "项目已切换，请确认后重试"
    );
  }
  return target;
}
```

将 dashboard、queue、history、chapter 文件读取等所有项目数据 GET 请求切换到
`resolveReadProjectRoot`。写操作除 `projectRoot` 外还必须校验当前选中项目仍与请求一致，
不一致时返回 `409 PROJECT_SCOPE_CHANGED`，避免用户在切换瞬间把内容写入另一个项目。

- [ ] **Step 4: 运行接口测试**

Run: `node --test tests/app-server-probe.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/app-server.mjs tests/app-server-probe.test.mjs
git commit -m "fix: scope project requests explicitly"
```

### Task 4: 建立前端项目 generation 门禁

**Files:**
- Create: `src/app-shell/project-scope.mjs`
- Create: `tests/app-shell/project-scope.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectScope } from "../../src/app-shell/project-scope.mjs";

test("responses from an older project generation are stale", () => {
  const scope = createProjectScope();
  const requestA = scope.capture("D:\\projects\\a");

  scope.activate("D:\\projects\\b");

  assert.equal(scope.isCurrent(requestA), false);
});

test("only the active project generation is current", () => {
  const scope = createProjectScope();
  scope.activate("D:\\projects\\a");
  const request = scope.capture("D:\\projects\\a");

  assert.equal(scope.isCurrent(request), true);
  assert.equal(scope.current().projectRoot, "D:\\projects\\a");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-shell/project-scope.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯状态模块**

```js
export function createProjectScope() {
  let projectRoot = null;
  let generation = 0;

  return {
    activate(nextProjectRoot) {
      projectRoot = nextProjectRoot;
      generation += 1;
      return { projectRoot, generation };
    },
    capture(expectedProjectRoot = projectRoot) {
      return { projectRoot: expectedProjectRoot, generation };
    },
    isCurrent(token) {
      return (
        token.generation === generation &&
        token.projectRoot === projectRoot
      );
    },
    current() {
      return { projectRoot, generation };
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/app-shell/project-scope.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/project-scope.mjs tests/app-shell/project-scope.test.mjs
git commit -m "feat: track frontend project generations"
```

### Task 5: 在 App Shell 中丢弃旧项目响应并清理临时状态

**Files:**
- Modify: `src/app-shell/app.js`
- Modify: `src/app-shell/api-client.js`
- Create: `tests/app-shell/app-shell-static.test.mjs`
- Create: `tests/app-shell/app-shell-project-switch.test.mjs`

- [ ] **Step 1: 写失败测试**

新增一个可控延迟的 fetch stub：项目 A 的 dashboard Promise 延迟，
切换到项目 B 后先返回 B，再释放 A。测试应完整断言：

```js
assert.equal(document.querySelector("[data-project-name]").textContent, "project-b");
assert.equal(document.querySelector("[data-chapter='1']").textContent.includes("A 内容"), false);
assert.equal(document.querySelector("[data-chapter='1']").textContent.includes("B 内容"), true);
assert.equal(document.querySelector("[data-toast]").hidden, true);
assert.equal(document.querySelector("[data-thread-status]").textContent, "");
```

同时在静态测试中断言 dashboard 请求带有 `projectRoot`：

```js
assert.match(appSource, /projectRoot:\s*activeProjectRoot/);
assert.match(appSource, /projectScope\.isCurrent/);
```

- [ ] **Step 2: 运行测试确认失败**

Run:
`node --test tests/app-shell/app-shell-project-switch.test.mjs tests/app-shell/app-shell-static.test.mjs`

Expected: FAIL，旧响应仍能渲染，且切换时 toast 或线程状态未清空。

- [ ] **Step 3: 集成 generation**

在 `app.js` 中创建唯一的 `projectScope`。选择项目成功后：

1. `projectScope.activate(projectRoot)`。
2. 立即清空 dashboard、线程消息、线程状态、toast、文件预览和 composer 错误。
3. `loadDashboard` 开始时保存 token，并把 `projectRoot` 传给 API。
4. fetch 返回后先执行 `projectScope.isCurrent(token)`；为 `false` 时直接返回，不写 DOM。
5. 所有延迟刷新、轮询和命令提交回调使用同一门禁。

在 `api-client.js` 中统一编码查询参数：

```js
export function withProjectScope(pathname, projectRoot) {
  const url = new URL(pathname, window.location.origin);
  if (projectRoot) url.searchParams.set("projectRoot", projectRoot);
  return `${url.pathname}${url.search}`;
}
```

- [ ] **Step 4: 运行前端测试**

Run:
`node --test tests/app-shell/app-shell-project-switch.test.mjs tests/app-shell/app-shell-static.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/app.js src/app-shell/api-client.js tests/app-shell/app-shell-static.test.mjs tests/app-shell/app-shell-project-switch.test.mjs
git commit -m "fix: discard stale project responses"
```

### Task 6: 将文件卡片文案绑定到产物真值

**Files:**
- Create: `src/app-shell/chapter-presentation.mjs`
- Create: `tests/app-shell/chapter-presentation.test.mjs`
- Modify: `src/app-shell/thread-renderer.js`
- Create: `tests/app-shell/thread-renderer.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";

import { presentChapterArtifact } from "../../src/app-shell/chapter-presentation.mjs";

test("committed artifact is presented as a readable local file", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    artifact: {
      state: "committed",
      relative_path: "chapters/003.md",
      bytes: 1024,
    },
  });

  assert.equal(view.tone, "success");
  assert.equal(view.canOpen, true);
  assert.equal(view.title, "第 3 章已写入本地文件");
});

test("draft-only cancelled artifact tells the user that the draft remains", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    projectStatus: "cancelled",
    artifact: { state: "draft_only" },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.canOpen, false);
  assert.equal(view.title, "已停止，第 3 章草稿已保留");
});

test("invalid artifact never claims that a local final file exists", () => {
  const view = presentChapterArtifact({
    chapter: 3,
    artifact: { state: "invalid", reason: "checksum_mismatch" },
  });

  assert.equal(view.tone, "warning");
  assert.equal(view.canOpen, false);
  assert.equal(view.title, "第 3 章产物状态异常，可尝试恢复");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/app-shell/chapter-presentation.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现展示映射**

```js
const reasonText = {
  missing_final_path: "章节索引没有最终稿路径",
  missing_checksum: "章节索引没有最终稿校验和",
  missing_file: "磁盘中未找到最终稿文件",
  checksum_mismatch: "文件内容与章节索引不一致",
  invalid_path: "文件路径超出项目目录",
  not_a_file: "目标路径不是可读取文件",
  chapter_not_committed: "章节尚未提交最终稿",
};

export function presentChapterArtifact({ chapter, artifact, projectStatus }) {
  if (artifact?.state === "committed") {
    return {
      tone: "success",
      canOpen: true,
      title: `第 ${chapter} 章已写入本地文件`,
      detail: artifact.relative_path,
    };
  }
  if (artifact?.state === "committing") {
    return {
      tone: "progress",
      canOpen: false,
      title: `第 ${chapter} 章正在定稿`,
      detail: "",
    };
  }
  if (artifact?.state === "draft_only") {
    const cancelling = projectStatus === "cancelling";
    return {
      tone: "warning",
      canOpen: false,
      title: cancelling
        ? "正在停止，草稿将保留"
        : `已停止，第 ${chapter} 章草稿已保留`,
      detail: "",
    };
  }
  return {
    tone: "warning",
    canOpen: false,
    title: `第 ${chapter} 章产物状态异常，可尝试恢复`,
    detail: reasonText[artifact?.reason] ?? "章节索引与磁盘产物不一致",
  };
}
```

让 `thread-renderer.js` 在 `chapter_completed` 和 `chapter_finalized` 事件触发时，
按 `chapter_no` 从当前 dashboard 的 `data.chapters` 找到章节，再把
`chapter.artifact` 与 `data.summary.projectStatus` 传给 `presentChapterArtifact`。
只有 `canOpen` 为真才绑定 `ctx.openReader` 并显示打开操作；`committing`、
`draft_only` 和 `invalid` 只渲染不可点击状态卡。

- [ ] **Step 4: 运行渲染测试**

Run:
`node --test tests/app-shell/chapter-presentation.test.mjs tests/app-shell/thread-renderer.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/chapter-presentation.mjs src/app-shell/thread-renderer.js tests/app-shell/chapter-presentation.test.mjs tests/app-shell/thread-renderer.test.mjs
git commit -m "fix: render chapter cards from artifact truth"
```

### Task 7: 在运行状态 UI 中呈现 cancelling

**Files:**
- Modify: `src/app-shell/agent-truth.mjs`
- Modify: `src/app-shell/thread-renderer.js`
- Modify: `tests/agent-truth.test.mjs`
- Modify: `tests/app-shell/thread-renderer.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
test("cancelling task tells the user that cancellation is in progress", () => {
  const truth = deriveAgentTruth({
    queue: { active: { status: "cancelling", chapter: 4 } },
  });

  assert.equal(truth.kind, "cancelling");
  assert.equal(truth.label, "正在取消第 4 章");
  assert.equal(truth.showStopAction, false);
});
```

在线程渲染测试中断言取消中状态不显示“已停止”或成功文件卡片。

- [ ] **Step 2: 运行测试确认失败**

Run:
`node --test tests/agent-truth.test.mjs tests/app-shell/thread-renderer.test.mjs`

Expected: FAIL，`cancelling` 落入未知或运行中分支。

- [ ] **Step 3: 增加状态映射**

在 `deriveAgentTruth` 的终态判断之前增加 `cancelling` 分支，并让 renderer 使用中性进行中样式。
重复点击停止按钮时保持禁用，直到后端返回 `cancelled`、`completed` 或 `interrupted`。

- [ ] **Step 4: 运行测试确认通过**

Run:
`node --test tests/agent-truth.test.mjs tests/app-shell/thread-renderer.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app-shell/agent-truth.mjs src/app-shell/thread-renderer.js tests/agent-truth.test.mjs tests/app-shell/thread-renderer.test.mjs
git commit -m "feat: show cancellation in progress"
```

### Task 8: 状态与 UI 子系统回归验证

**Files:**
- Modify only if a failing assertion exposes a defect in files already listed above.

- [ ] **Step 1: 运行目标测试**

Run:

```bash
node --test tests/chapter-artifact.test.mjs
node --test tests/app-dashboard.test.mjs
node --test tests/app-server-probe.test.mjs
node --test tests/app-shell/project-scope.test.mjs
node --test tests/app-shell/app-shell-project-switch.test.mjs
node --test tests/app-shell/chapter-presentation.test.mjs
node --test tests/agent-truth.test.mjs
node --test tests/app-shell/thread-renderer.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行 App Shell 验证**

Run: `npm run verify:app-shell`

Expected: 命令退出码为 0。

- [ ] **Step 3: 运行完整测试**

Run: `npm test`

Expected: 全部 PASS。

- [ ] **Step 4: 检查工作区差异**

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 5: 提交必要的验证修复**

仅当本任务产生了修复时执行：

```bash
git add src/core src/app-shell tests
git commit -m "test: complete state isolation regression coverage"
```
