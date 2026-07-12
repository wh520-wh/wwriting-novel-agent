// Static assertions over app.js / api-client.js source.
// The plan allows source-grep assertions: the key is to prove the wiring exists.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "..", "src", "app-shell", "app.js");
const apiClientPath = path.join(here, "..", "..", "src", "app-shell", "api-client.js");
const composerPath = path.join(here, "..", "..", "src", "app-shell", "composer.js");
const threadRendererPath = path.join(here, "..", "..", "src", "app-shell", "thread-renderer.js");
const chapterPresentationPath = path.join(here, "..", "..", "src", "app-shell", "chapter-presentation.mjs");

const appSource = await fs.readFile(appJsPath, "utf8");
const apiClientSource = await fs.readFile(apiClientPath, "utf8");
const composerSource = await fs.readFile(composerPath, "utf8");
const threadRendererSource = await fs.readFile(threadRendererPath, "utf8");
const chapterPresentationSource = await fs.readFile(chapterPresentationPath, "utf8");

test("app.js wires the project scope module", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*createProjectScope[^}]*\}\s*from\s*["']\.\/project-scope\.mjs["']/,
    "app.js should import createProjectScope from ./project-scope.mjs"
  );
});

test("app.js creates exactly one projectScope instance", () => {
  const occurrences = appSource.match(/createProjectScope\s*\(/g) ?? [];
  assert.equal(
    occurrences.length,
    1,
    "createProjectScope() should be called exactly once to create a single instance"
  );
  assert.match(
    appSource,
    /const\s+projectScope\s*=\s*createProjectScope\s*\(\s*\)/,
    "projectScope should be bound to a single const"
  );
});

test("app.js activates the project scope on every project selection", () => {
  // The single activation point is `projectScope.activate(...)` inside
  // commitProjectSwitch; that helper is called from openProject, initProject,
  // and forgetProject. Allow the direct match OR a one-caller helper.
  const directActivate = (appSource.match(/projectScope\.activate\s*\(/g) ?? []).length;
  const commitCalls = (appSource.match(/commitProjectSwitch\s*\(/g) ?? []).length;
  assert.ok(
    directActivate >= 1,
    `projectScope.activate should be wired (saw ${directActivate} direct call(s))`
  );
  assert.ok(
    commitCalls >= 3,
    `commitProjectSwitch should be invoked from at least 3 switch paths (open/init/forget); saw ${commitCalls} call site(s)`
  );
});

test("app.js gates the dashboard load on projectScope.isCurrent", () => {
  assert.match(
    appSource,
    /projectScope\.capture\s*\(/,
    "loadDashboard should call projectScope.capture to obtain a token"
  );
  assert.match(
    appSource,
    /projectScope\.isCurrent\s*\(/,
    "post-fetch path should call projectScope.isCurrent to drop stale responses"
  );
});

test("app.js carries projectRoot in dashboard fetches", () => {
  // Either the URL is built with withProjectScope, or the body has projectRoot
  // alongside the dashboard fetch call. The api-client should expose withProjectScope.
  const usesHelper = /withProjectScope\s*\(/.test(appSource);
  assert.ok(
    usesHelper,
    "app.js should call api-client's withProjectScope helper to attach projectRoot"
  );
});

test("api-client.js exports withProjectScope helper", () => {
  assert.match(
    apiClientSource,
    /export\s+function\s+withProjectScope\s*\(/,
    "api-client.js should export a withProjectScope helper that appends ?projectRoot=…"
  );
});

test("settings-modal.js re-exports the pure connection helpers", () => {
  const settingsModalPath = path.join(here, "..", "..", "src", "app-shell", "settings-modal.js");
  return fs.readFile(settingsModalPath, "utf8").then((settingsModalSource) => {
    // Re-export form: `export { formatConnectionStatus, submitModelConnectionTest } from "..."`
    assert.match(
      settingsModalSource,
      /export\s*\{[^}]*formatConnectionStatus[^}]*\}\s*from\s*["']\.\/settings-connection\.mjs["']/,
      "settings-modal.js should re-export formatConnectionStatus from ./settings-connection.mjs"
    );
    assert.match(
      settingsModalSource,
      /export\s*\{[^}]*submitModelConnectionTest[^}]*\}\s*from\s*["']\.\/settings-connection\.mjs["']/,
      "settings-modal.js should re-export submitModelConnectionTest from ./settings-connection.mjs"
    );
    assert.match(
      settingsModalSource,
      /fetchModelSecret\s*\(\s*\)[\s\S]{0,240}settingsFields\.apiKey\.input\.value/u,
      "settings-modal.js should fetch the saved model secret and put the full key back into the API Key input"
    );
    assert.doesNotMatch(
      settingsModalSource,
      /DO NOT prefill|must not echo the saved key|value:\s*""[\s\S]{0,80}secret:\s*true/u,
      "settings-modal.js should no longer intentionally keep the saved API Key field empty"
    );
  });
});

test("composer.js supports /model switching from the chat box", () => {
  assert.match(
    composerSource,
    /MODEL_PREFIXES/u,
    "composer.js should define /model as a first-class command prefix"
  );
  assert.match(
    composerSource,
    /\/api\/settings\/model-switch/u,
    "composer.js should call the model-switch endpoint from /model"
  );
  assert.match(
    composerSource,
    /await\s+ctx\.loadDashboard\s*\(/u,
    "model switching should refresh dashboard so the model pill updates"
  );
});

test("settings-connection.mjs defines the pure helpers", () => {
  const settingsConnectionPath = path.join(here, "..", "..", "src", "app-shell", "settings-connection.mjs");
  return fs.readFile(settingsConnectionPath, "utf8").then((source) => {
    assert.match(
      source,
      /export\s+function\s+formatConnectionStatus[\s\S]*?\(/,
      "settings-connection.mjs should export formatConnectionStatus"
    );
    assert.match(
      source,
      /export\s+async\s+function\s+submitModelConnectionTest[\s\S]*?\(/,
      "settings-connection.mjs should export submitModelConnectionTest"
    );
  });
});

test("settings-connection.mjs owns the MiMo preset autofill", () => {
  const settingsConnectionPath = path.join(here, "..", "..", "src", "app-shell", "settings-connection.mjs");
  const settingsModalPath = path.join(here, "..", "..", "src", "app-shell", "settings-modal.js");
  return Promise.all([
    fs.readFile(settingsConnectionPath, "utf8"),
    fs.readFile(settingsModalPath, "utf8"),
  ]).then(([source, modalSource]) => {
    // MiMo preset exact fields per plan.
    assert.match(
      source,
      /provider:\s*"openai-compatible"[\s\S]{0,200}model_name:\s*"mimo-v2\.5-pro"[\s\S]{0,200}base_url:\s*"https:\/\/api\.xiaomimimo\.com\/v1"[\s\S]{0,200}api_key_env:\s*"XIAOMI_MIMO_API_KEY"/u,
      "MiMo preset must autofill provider/openai-compatible with exact base_url and api_key_env"
    );
    // Plan forbids renaming the env var.
    assert.match(
      modalSource,
      /XIAOMI_MIMO_API_KEY/,
      "settings-modal.js must reference XIAOMI_MIMO_API_KEY (no rename)"
    );
    assert.doesNotMatch(
      modalSource,
      /mimo-v2-flash/,
      "settings-modal.js must not invent a mimo-v2-flash model"
    );
  });
});

test("api-client.js preserves error code/fields/actions on post failure", () => {
  // The new behavior is to attach code, fields, action onto the thrown error.
  assert.match(apiClientSource, /error\.code\s*=/);
  assert.match(apiClientSource, /error\.fields\s*=/);
  assert.match(apiClientSource, /error\.action\s*=/);
});

test("api-client.js postJson accepts an AbortSignal", () => {
  assert.match(
    apiClientSource,
    /function\s+postJson\s*\([\s\S]*?signal/,
    "postJson should accept an options bag with a signal"
  );
  assert.match(
    apiClientSource,
    /signal/,
    "the signal should be forwarded into fetch()"
  );
});

test("thread-renderer.js imports presentChapterArtifact from the chapter-presentation module", () => {
  assert.match(
    threadRendererSource,
    /import\s*\{[^}]*presentChapterArtifact[^}]*\}\s*from\s*["']\.\/chapter-presentation\.mjs["']/,
    "thread-renderer.js should import presentChapterArtifact from ./chapter-presentation.mjs"
  );
});

test("chapter-presentation.mjs exports presentChapterArtifact and reason text", () => {
  assert.match(
    chapterPresentationSource,
    /export\s+function\s+presentChapterArtifact\s*\(/,
    "chapter-presentation.mjs should export a presentChapterArtifact function"
  );
  // The hardening in B1.1 introduced inspect_error; the renderer should not
  // show empty detail text for that reason.
  assert.match(
    chapterPresentationSource,
    /inspect_error\s*:\s*"读取章节文件失败（可能文件被锁定）"/u,
    "reasonText should include an inspect_error entry"
  );
});

test("thread-renderer.js calls presentChapterArtifact when rendering a chapter card", () => {
  assert.match(
    threadRendererSource,
    /presentChapterArtifact\s*\(/,
    "attachChapterCard should call presentChapterArtifact"
  );
});

test("thread-renderer.js gates the open-reader click and 'open' affordance on canOpen", () => {
  // The plan requires: only bind openReader when canOpen is true; never show
  // "已写入本地文件" or enable the open action for a non-committed artifact.
  // We assert at least one conditional that gates the click handler on canOpen
  // and at least one that gates the "打开阅读" affordance on canOpen.
  assert.match(
    threadRendererSource,
    /view\.canOpen[\s\S]*?addEventListener\s*\(\s*["']click["']/u,
    "click handler binding must be conditional on view.canOpen"
  );
  assert.match(
    threadRendererSource,
    /view\.canOpen[\s\S]*?打开阅读/u,
    "the '打开阅读' affordance must be conditional on view.canOpen"
  );
});

test("thread-renderer.js hides the stop button while projectStatus is cancelling", () => {
  // The plan requires: the per-run stop button must be hidden once the run
  // is cancelling, and the task-card stop button must not be rendered for
  // any non-running status (including cancelling). We assert that
  // `cancelling` appears in the same statement that toggles stopBtn.hidden,
  // and that the task-card stop button branch is gated to `running` only.
  const stopBtnContext = threadRendererSource.match(
    /block\.stopBtn\.hidden[\s\S]{0,200}/u
  );
  assert.ok(
    stopBtnContext && /cancelling/.test(stopBtnContext[0]),
    "run-stop-btn hidden condition should account for cancelling"
  );
  assert.match(
    threadRendererSource,
    /task\.status\s*===\s*["']running["']/u,
    "task-card stop button branch should be gated to status === running"
  );
  // No branch should render a stop button for a cancelling task. The task
  // card builder uses `if (task.status === "running")` for the stop button
  // and falls through to other branches (queued/completed/blocked/etc).
  const cancellingStopBranch = threadRendererSource.match(
    /task\.status\s*===\s*["']cancelling["'][\s\S]{0,160}stopBtn/u
  );
  assert.equal(
    cancellingStopBranch,
    null,
    "no stop button branch should be wired for cancelling tasks"
  );
});

test("thread-renderer 主动徽标认 timeline_check 类型", () => {
  assert.match(threadRendererSource, /timeline_check/, "thread-renderer 应识别 timeline_check 主动消息");
});

// ---- Task 3: Writing readiness and chapter success cards ----

const indexPath = path.join(here, "..", "..", "src", "app-shell", "index.html");
const indexSource = await fs.readFile(indexPath, "utf8");

test("index.html contains write-readiness section with stable IDs", () => {
  assert.match(indexSource, /id="write-readiness"/, "index.html should have a #write-readiness element");
  assert.match(indexSource, /id="write-readiness-primary"/, "index.html should have a #write-readiness-primary button");
  assert.match(indexSource, /id="write-readiness-secondary"/, "index.html should have a #write-readiness-secondary button");
});

test("index.html contains chapter-success section with stable IDs", () => {
  assert.match(indexSource, /id="chapter-success"/, "index.html should have a #chapter-success element");
  assert.match(indexSource, /id="chapter-success-read"/, "index.html should have a #chapter-success-read button");
  assert.match(indexSource, /id="chapter-success-continue"/, "index.html should have a #chapter-success-continue button");
});

test("app.js imports deriveWriteReadiness from write-readiness.mjs", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*deriveWriteReadiness[^}]*\}\s*from\s*["']\.\/write-readiness\.mjs["']/,
    "app.js should import deriveWriteReadiness from ./write-readiness.mjs"
  );
});
