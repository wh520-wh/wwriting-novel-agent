// Static assertions over app.js / api-client.js source（统一 Agent 内核计划 Task 9 改写）。
// 断言新组合根的接线：AgentSurface 是唯一对话 seam、api-client 通用 helper 保留、
// quick-rail 纯导航、drawer-panels 直接导出、settings-modal 稳定行为。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "..", "src", "app-shell", "app.js");
const apiClientPath = path.join(here, "..", "..", "src", "app-shell", "api-client.js");
const quickRailPath = path.join(here, "..", "..", "src", "app-shell", "components", "quick-rail.js");
const drawerPanelsPath = path.join(here, "..", "..", "src", "app-shell", "drawer-panels.js");
const chapterPresentationPath = path.join(here, "..", "..", "src", "app-shell", "chapter-presentation.mjs");

const appSource = await fs.readFile(appJsPath, "utf8");
const apiClientSource = await fs.readFile(apiClientPath, "utf8");
const quickRailSource = await fs.readFile(quickRailPath, "utf8");
const drawerPanelsSource = await fs.readFile(drawerPanelsPath, "utf8");
const chapterPresentationSource = await fs.readFile(chapterPresentationPath, "utf8");

test("app.js wires the project scope module", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*createProjectScope[^}]*\}\s*from\s*["']\.\/project-scope\.mjs["']/,
    "app.js should import createProjectScope from ./project-scope.mjs"
  );
  const occurrences = appSource.match(/createProjectScope\s*\(/g) ?? [];
  assert.equal(occurrences.length, 1, "createProjectScope() 应只创建一次");
});

test("app.js gates the dashboard load on projectScope.isCurrent", () => {
  assert.match(appSource, /projectScope\.capture\s*\(/);
  assert.match(appSource, /projectScope\.isCurrent\s*\(/);
  assert.match(appSource, /withProjectScope\s*\(/);
});

test("app.js 通过 AgentSurface 唯一对话 seam 接线", () => {
  assert.match(
    appSource,
    /import\s*\{[^}]*createAgentSurface[^}]*\}\s*from\s*["']\.\/agent\/index\.js["']/,
    "app.js 应只从 agent/index.js 导入对话能力"
  );
  assert.match(appSource, /createAgentSurface\s*\(/, "app.js 应创建 AgentSurface");
  assert.match(appSource, /agentSurface\.openProject\s*\(/, "项目切换应调用 surface.openProject");
  assert.doesNotMatch(
    appSource,
    /\.\/agent\/(?:state|view|api)\.js|thread-renderer|composer\.js|agent-truth|run-presentation|write-readiness|command-registry/u,
    "app.js 不得 import Agent 内部或已删除的旧对话模块"
  );
});

test("app.js 保留项目/设置/阅读器/抽屉接线", () => {
  assert.match(appSource, /openProject\s*\(/);
  assert.match(appSource, /initProject\s*\(/);
  assert.match(appSource, /openSettingsModal/);
  assert.match(appSource, /openReader\s*\(/);
  assert.match(appSource, /\/api\/projects\/open/u);
  assert.match(appSource, /\/api\/projects\/init/u);
  assert.match(appSource, /\/api\/chapters\/read/u);
  assert.match(appSource, /openDrawerTab\s*\(/);
  assert.doesNotMatch(appSource, /\/api\/chat\/|\/api\/commands\/submit|\/api\/run\/stop|\/api\/queue\//u);
});

test("api-client.js exports 通用 helper 且无旧 chat helper", () => {
  assert.match(apiClientSource, /export\s+function\s+withProjectScope\s*\(/);
  assert.match(apiClientSource, /export\s+async\s+function\s+getJson\s*\(/);
  assert.match(apiClientSource, /export\s+async\s+function\s+postJson\s*\(/);
  assert.match(apiClientSource, /export\s+async\s+function\s+readResponseJson\s*\(/);
  assert.doesNotMatch(apiClientSource, /sendChatMessage|confirmChatAction|stopChat|fetchChatHistory/u);
  assert.match(apiClientSource, /error\.code\s*=/);
  assert.match(apiClientSource, /error\.fields\s*=/);
  assert.match(apiClientSource, /error\.action\s*=/);
});

test("quick-rail.js 纯导航四槽位，无命令注册副作用", () => {
  assert.ok(quickRailSource.includes("function renderQuickRail"));
  assert.ok(quickRailSource.includes("function bindQuickRailKeys"));
  assert.doesNotMatch(quickRailSource, /commands\/index|command-registry|registerCommand/u);
  for (const key of ["chapters", "skills", "research", "cost"]) {
    assert.ok(quickRailSource.includes(`key: '${key}'`), `quick-rail 应含 ${key} 槽位`);
  }
  assert.ok(!quickRailSource.includes("reviewer"), "审查槽位应删除");
});

test("drawer-panels.js 直接调用确定性导出 route，无旧业务入口", () => {
  assert.match(drawerPanelsSource, /\/api\/projects\/export-book/u, "导出应直接调用确定性 route");
  assert.doesNotMatch(drawerPanelsSource, /sendChatMessageWithUX|renderRunPanel|renderReviewerPanel/u);
  assert.ok(drawerPanelsSource.includes("function renderChapterPanel"));
  assert.ok(drawerPanelsSource.includes("function renderModelPanel"));
  assert.ok(drawerPanelsSource.includes("function renderCostPanel"));
});

test("settings-modal.js re-exports the pure connection helpers", () => {
  const settingsModalPath = path.join(here, "..", "..", "src", "app-shell", "settings-modal.js");
  return fs.readFile(settingsModalPath, "utf8").then((settingsModalSource) => {
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
  });
});

test("settings-modal.js owns the MiMo preset autofill", () => {
  const settingsModalPath = path.join(here, "..", "..", "src", "app-shell", "settings-modal.js");
  return fs.readFile(settingsModalPath, "utf8").then((modalSource) => {
    assert.match(
      modalSource,
      /provider:\s*"openai-compatible"[\s\S]{0,200}baseUrl:\s*"https:\/\/api\.xiaomimimo\.com\/v1"[\s\S]{0,200}apiKeyEnv:\s*"XIAOMI_MIMO_API_KEY"/u,
      "MiMo preset must autofill provider/openai-compatible with exact base_url and api_key_env"
    );
    assert.match(modalSource, /XIAOMI_MIMO_API_KEY/);
    assert.doesNotMatch(modalSource, /mimo-v2-flash/);
  });
});

test("chapter-presentation.mjs 保留（稳定领域展示模块）", () => {
  assert.match(
    chapterPresentationSource,
    /export\s+function\s+presentChapterArtifact\s*\(/,
    "chapter-presentation.mjs should export a presentChapterArtifact function"
  );
});
