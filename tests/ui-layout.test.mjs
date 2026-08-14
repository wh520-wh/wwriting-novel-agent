// 统一 Agent 内核计划 Task 9 改写（Task 12 更新）：UI 布局契约。
//
// 保留的布局基线：
//   - 共享 1040px 内容列：AgentSurface 对话与 composer 使用 --content-column（agent.css）；
//   - composer 菜单从触发器向上浮出，并保留 16px 视口安全区（agent.css）；
//   - 设置弹窗只暴露普通作者真正需要的写作参数、技能和项目管理（模型配置在
//     Task 12 起迁往独立的 model-settings-page，Task 17 cutover 后弹窗不再有模型分区）；
//   - 主列结构：单一对话挂载点、顶部 drawer 入口、设置、阅读器、确定性工具；
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

test("共享内容列：AgentSurface 对话与 composer 使用同一 1040px 列", () => {
  assert.match(cssSource, /--content-column:\s*1040px/u, "styles.css 应定义 1040px 内容列变量");
  assert.match(agentCssSource, /--content-column:\s*1040px/u, "agent.css 应定义 1040px 内容列变量");
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

test("composer 菜单锚定触发器向上浮出，并受视口约束", () => {
  assert.match(
    agentCssSource,
    /\.agent-composer-popover\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)[^}]*max-width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/u,
    "菜单应从 composer 向上浮出并保留 16px 视口安全区"
  );
  assert.match(agentCssSource, /transform-origin:\s*bottom left/u, "菜单动效应锚定触发按钮");
  assert.match(agentCssSource, /overflow-wrap:\s*anywhere/u, "模型名称应允许任意位置换行");
});

test("主列结构：单一对话挂载点 + 顶部抽屉入口 + 设置 + 阅读器 + 确定性工具", () => {
  assert.ok(indexSource.includes('id="agent-surface"'), "index.html 应含唯一对话挂载点");
  assert.ok(indexSource.includes('id="open-drawer"'), "顶部应有 drawer 入口按钮（替代 quick rail）");
  assert.ok(!indexSource.includes('id="quick-rail"'), "右侧 quick rail 应整体删除");
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

test("设置弹窗不暴露旧架构和专家配置入口", () => {
  const sections = settingsSource.match(/const SETTINGS_SECTIONS = \[([\s\S]*?)\];/u)?.[1] ?? "";
  // Task A3：model 分区作为设置弹窗首位分区（注入 model-settings-page 渲染目标）。
  assert.match(sections, /id:\s*"model"/u);
  assert.match(sections, /id:\s*"writing"/u);
  assert.match(sections, /id:\s*"skills"/u);
  assert.match(sections, /id:\s*"danger"/u);
  // 「专家配置」类入口（质量门禁/联网搜索/权限等）不得暴露。
  assert.doesNotMatch(sections, /gates|research|permissions|质量门禁|联网搜索|权限与确认/u);
  assert.doesNotMatch(settingsSource, /预算上限|成本上限|token 总量上限|写作温度|联网搜索\/抓取权限/u);
  assert.doesNotMatch(cssSource, /\.spd-radio-(?:group|option|tx|warn)/u, "已删除的权限表单样式不应残留");
});

test("样式基线：隐私模式、reduced-motion 与窗口拖拽安全区", () => {
  assert.ok(cssSource.includes('[data-privacy="on"] .peek'), "隐私模式样式应保留");
  assert.ok(cssSource.includes("prefers-reduced-motion"), "reduced-motion 应保留");
  assert.ok(cssSource.includes("--window-control-space"), "Electron 窗口控制空间变量应保留");
  assert.ok(cssSource.includes("--rail"), "rail 变量应保留");
});

test("对话控制面提供即时反馈、清晰材料层与完整无障碍降级", () => {
  assert.match(
    cssSource,
    /h1, h2\s*\{[^}]*font-family:\s*var\(--sans\)/u,
    "应用 UI 标题应使用系统无衬线字体"
  );
  assert.match(
    cssSource,
    /:where\(button,[^}]*:active\s*\{[^}]*transform:\s*scale\(/u,
    "主要交互控件应在按下时立即提供物理反馈"
  );
  assert.match(
    agentCssSource,
    /\.agent-composer-shell\s*\{[^}]*border-radius:\s*var\(--r-card\)[^}]*backdrop-filter:[^}]*box-shadow:\s*var\(--shadow-sm\)/u,
    "composer 应是带有层次感的圆角卡片材料层"
  );
  assert.match(
    agentCssSource,
    /\.agent-slash-menu\s*\{[^}]*transform-origin:\s*bottom left/u,
    "斜杠菜单应从 composer 的触发位置出现"
  );
  assert.ok(cssSource.includes("prefers-reduced-transparency"), "全局样式应支持减少透明度");
  assert.ok(cssSource.includes("prefers-contrast: more"), "全局样式应支持增强对比度");
  assert.ok(agentCssSource.includes("prefers-reduced-transparency"), "AgentSurface 应支持减少透明度");
  assert.ok(agentCssSource.includes("prefers-contrast: more"), "AgentSurface 应支持增强对比度");
  assert.match(
    agentCssSource,
    /\.agent-message--assistant \.agent-message-text\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;/u,
    "Agent 回复应继续保持无框正文"
  );
});

test("次级操作融入背景，消息层级不依赖成排胶囊按钮", () => {
  assert.match(
    cssSource,
    /\.new-btn\s*\{[^}]*background:\s*transparent;[^}]*border:\s*1px solid transparent;/u,
    "新建入口应表现为侧栏行，而不是独立实心按钮"
  );
  assert.match(
    cssSource,
    /\.tbtn\s*\{[^}]*border:\s*1px solid transparent;\s*background:\s*transparent;/u,
    "顶栏次级操作应默认融入背景"
  );
  assert.match(
    agentCssSource,
    /--agent-user-bg:\s*var\(--rail\);/u,
    "用户消息应使用安静的浅中性表面（引用全局 rail 表面 primitive）"
  );
  assert.match(
    agentCssSource,
    /--agent-user-ink:\s*var\(--btn\);/u,
    "用户消息文字应引用全局 ink primitive，不硬编码色值"
  );
  assert.match(
    agentCssSource,
    /\.agent-stop-btn,[\s\S]*?\.agent-retry-btn,[\s\S]*?\.agent-promote,[\s\S]*?\.agent-withdraw\s*\{[^}]*background:\s*transparent;/u,
    "停止、重试、立即和撤回应是无常驻外框的行内操作（Task 11 加入撤回后选择器列表扩展）"
  );
  assert.match(
    agentCssSource,
    /\.agent-send\s*\{[^}]*background:\s*var\(--agent-send-bg\)/u,
    "发送按钮应保持独立、清楚的主操作层级"
  );
});

// ===========================================================================
// 冻结布局约束（Task 7 Step 3）：固定宽度 + 360/768/1280 无横向溢出
// ===========================================================================

test("冻结布局约束：390/768/1280 无横向溢出（百分比优先 + 固定上限）", () => {
  // 四档视口宽度推演（对话内容宽 = min(视口, 1040px) - 左右各 gutter 内边距）：
  //   390px  → 内容约 358px：用户 ≤min(800px,100%-32px)=326px、助手 ≤min(100%,720px)=358px、工作组 358px；
  //   768px  → 内容约 728px：用户 ≤696px、助手 ≤728px、工作组 728px；
  //   1280px → 内容约 1040px（列封顶 1040px）：用户 ≤800px、助手 ≤720px、工作组 1040px。
  // 百分比项 ≤ 容器自身宽度，固定上限只在容器足够宽时封顶，因此各档都不会撑出横向滚动。
  assert.match(agentCssSource, /max-width:\s*min\(800px,\s*calc\(100% - 32px\)\)/u, "用户消息：封顶 800px，留 32px 边距");
  assert.match(
    agentCssSource,
    /\.agent-message-text\.agent-markdown\s*\{[^}]*width:\s*min\(100%,\s*720px\)/u,
    "助手 Markdown 正文：100% 优先，封顶 720px（作用域限定在正文规则，避免经由 max-width 误匹配）"
  );
  assert.match(agentCssSource, /width:\s*min\(100%,\s*1040px\)/u, "工作组：100% 优先，封顶 1040px");
  // 长内容（URL/代码/长单词）原地换行，不撑破消息容器。
  assert.match(agentCssSource, /\.agent-message-text\s*\{[^}]*overflow-wrap:\s*anywhere/u, "消息文本应任意位置换行");
  // 对话容器本身 width:min(100%,1040px) + box-sizing:border-box，padding 计入宽度不溢出。
  assert.match(
    agentCssSource,
    /\.agent-conversation\s*\{[^}]*width:\s*min\(100%,\s*1040px\)[^}]*max-width:\s*var\(--content-column\)[^}]*box-sizing:\s*border-box/u,
    "对话容器宽度含内边距，不横向溢出"
  );
});

test("冻结布局约束：用户消息靠右，ticker 固定两行，详情 320px 内部滚动", () => {
  assert.match(agentCssSource, /\.agent-message--user\s*\{[^}]*align-self:\s*flex-end/u, "用户消息靠右");
  assert.match(
    agentCssSource,
    /\.agent-reasoning-ticker\s*\{[^}]*min-height:\s*2lh[^}]*max-height:\s*2lh[^}]*line-clamp:\s*2/u,
    "reasoning ticker 高度锁定两行，文本替换不改变工作项高度"
  );
  assert.match(agentCssSource, /\.agent-reasoning-detail\s*\{[^}]*max-height:\s*320px[^}]*overflow-y:\s*auto/u, "详情 max-height:320px 内部滚动");
});
