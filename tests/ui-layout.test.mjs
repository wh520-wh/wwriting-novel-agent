// 统一 Agent 内核计划 Task 9 改写：UI 布局契约。
//
// 保留的布局基线：
//   - 共享 900px 内容列：AgentSurface 对话与 composer 使用 --content-column（agent.css）；
//   - 模型菜单视口钳制 min(420px, calc(100vw - 32px)) + 16px 安全区（agent.css）；
//   - 设置弹窗保留 YOLO 档（红色）与权限分区；
//   - 主列结构：单一对话挂载点、导航、设置、阅读器、确定性工具；
//   - 旧对话/任务卡/准备卡结构与样式不得残留。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src", "app-shell");

const indexSource = await fs.readFile(path.join(srcDir, "index.html"), "utf8");
const appSource = await fs.readFile(path.join(srcDir, "app.js"), "utf8");
const cssSource = await fs.readFile(path.join(srcDir, "styles.css"), "utf8");
const agentCssSource = await fs.readFile(path.join(srcDir, "agent", "agent.css"), "utf8");
const settingsSource = await fs.readFile(path.join(srcDir, "settings-modal.js"), "utf8");

test("共享内容列：AgentSurface 对话与 composer 使用同一 900px 列", () => {
  assert.match(cssSource, /--content-column:\s*900px/u, "styles.css 应定义 900px 内容列变量");
  assert.match(agentCssSource, /--content-column:\s*900px/u, "agent.css 应定义 900px 内容列变量");
  assert.match(
    agentCssSource,
    /\.agent-conversation[\s\S]*max-width:\s*var\(--content-column\)/u,
    "对话应共享 max-width: var(--content-column)"
  );
  assert.match(
    agentCssSource,
    /\.agent-composer[\s\S]*max-width:\s*var\(--content-column\)/u,
    "composer 应共享 max-width: var(--content-column)"
  );
});

test("模型菜单宽度受内容和视口共同约束（16px 视口安全区）", () => {
  assert.match(
    agentCssSource,
    /width:\s*min\(420px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单宽度应为 min(420px, 100vw - 32px)"
  );
  assert.match(agentCssSource, /overflow-wrap:\s*anywhere/u, "模型名称应允许任意位置换行");
});

test("主列结构：单一对话挂载点 + 导航 + 设置 + 阅读器 + 确定性工具", () => {
  assert.ok(indexSource.includes('id="agent-surface"'), "index.html 应含唯一对话挂载点");
  assert.ok(indexSource.includes('id="quick-rail"'), "导航应保留");
  assert.ok(indexSource.includes("settings-modal"), "设置弹窗应保留");
  assert.ok(indexSource.includes("reader-scrim"), "章节阅读器应保留");
  assert.ok(indexSource.includes("toast-stack"), "toast 栈应保留");
  assert.ok(appSource.includes("createAgentSurface"), "app.js 应创建 AgentSurface");
  // 旧对话结构不得残留
  assert.ok(!indexSource.includes('id="thread"'), "旧线程容器不得残留");
  assert.ok(!indexSource.includes('id="composer-input"'), "旧 composer 输入框不得残留");
  assert.ok(!indexSource.includes('id="topbar-stop"'), "旧顶栏停止按钮不得残留");
  assert.ok(!indexSource.includes('id="topbar-progress"'), "旧顶栏进度条不得残留");
  assert.ok(!indexSource.includes("write-readiness"), "准备写作卡不得残留");
  assert.ok(!indexSource.includes("chapter-success"), "章节完成卡不得残留");
  assert.ok(!indexSource.includes("project-workbench"), "创作工作台卡不得残留");
  assert.ok(!indexSource.includes("activity-strip"), "顶部活动条不得残留");
});

test("app.js 不再维护 Agent 状态与业务正则", () => {
  assert.doesNotMatch(
    appSource,
    /thread-renderer|composer\.js|agent-truth|run-presentation|write-readiness|workbench-presentation|command-registry|deriveBadges|deriveActivity/u,
    "app.js 不得引用已删除的旧对话/状态模块"
  );
  assert.doesNotMatch(
    appSource,
    /\/api\/chat\/|\/api\/commands\/submit|\/api\/run\/stop|\/api\/queue\//u,
    "app.js 不得调用旧控制面路由"
  );
});

test("设置弹窗保留 YOLO 档（权限与确认分区）", () => {
  assert.match(settingsSource, /tier\.id === "yolo"/, "设置弹窗权限分区应保留 yolo 处理");
  assert.match(cssSource, /\.spd-radio-option--yolo/, "设置弹窗 yolo 选项样式应保留");
});

test("样式基线：隐私模式、reduced-motion 与窗口拖拽安全区", () => {
  assert.ok(cssSource.includes('[data-privacy="on"] .peek'), "隐私模式样式应保留");
  assert.ok(cssSource.includes("prefers-reduced-motion"), "reduced-motion 应保留");
  assert.ok(cssSource.includes("--window-control-space"), "Electron 窗口控制空间变量应保留");
  assert.ok(cssSource.includes("--rail"), "rail 变量应保留");
});
