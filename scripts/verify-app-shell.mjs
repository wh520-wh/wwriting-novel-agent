import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createProject, loadState, saveState } from "../src/core/project-store.mjs";
import { runProject } from "../src/core/agent-engine.mjs";
import { runReviewerAgent } from "../src/core/reviewer-agent.mjs";
import { searchWeb } from "../src/core/research-tools.mjs";
import {
  MAIN_TASK_IMPACT_PATTERN,
  REVIEW_PREFIXES,
  SIDE_QUESTION_PREFIXES,
  WRITE_PREFIXES
} from "../src/core/side-question.mjs";
import { FAILURE_COMMANDS as BE_COMMANDS } from "../src/shared/failure-commands.mjs";
import { FAILURE_COMMANDS as FE_COMMANDS } from "../src/app-shell/components/failure-card.js";

// 故障卡命令白名单漂移守卫
checkFailureCommandDrift();

// styles.css 含故障卡样式
const failureCss = await fs.readFile("src/app-shell/styles.css", "utf8");
if (!failureCss.includes(".failure-card")) throw new Error("styles.css 缺失 .failure-card");
console.log("[verify] styles.css 含故障卡样式");

const port = await getFreePort();
const root = path.resolve(".demo_runs", `app-shell-${Date.now()}`);
const secretsRoot = path.join(root, ".local-secrets");
const { projectRoot } = await createProject(root, {
  slug: "dashboard-novel",
  title: "Dashboard Novel",
  story_seed: "A project created for app shell smoke verification.",
  target_chapters: 2,
  min_words_per_chapter: 180,
  target_words_per_chapter: 240,
  network_allowed: true,
  enabled_skills: ["suspense-chapter-end"]
});
// 蓝图门禁（spec §1.4）：新建项目 blueprint_status 默认 "none"，写作入口会拒绝。
// 本脚本验证 app shell 渲染与 API 流而非蓝图内容，预置 complete 放行（与 tests/helpers.mjs 同款模式）。
await markBlueprintReady(projectRoot);
await runProject(projectRoot);
await searchWeb(
  projectRoot,
  { project_id: "app-shell-project", tool_permissions: { network_allowed: true } },
  { query: "app shell source", limit: 1 },
  {
    adapter: {
      async search() {
        return [{ title: "App Shell Source", url: "https://example.test/app-shell", snippet: "dashboard smoke source" }];
      }
    }
  }
);
await runReviewerAgent(projectRoot, { writeReport: true });

const child = spawn(process.execPath, ["scripts/serve-app-shell.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    PROJECT_ROOT: projectRoot,
    WWRITING_SECRETS_ROOT: secretsRoot
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderrText = "";
child.stderr.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
});

try {
  await waitForServer(port);
  const [html, js, truthJs, css, quickRailJs, dashboard, utilsJs, apiClientJs, threadRendererJs, drawerPanelsJs, settingsModalJs, composerJs, projectIdentityJs, workbenchPresentationJs] = await Promise.all([
    fetchText(`http://127.0.0.1:${port}/`),
    fetchText(`http://127.0.0.1:${port}/app.js`),
    fetchText(`http://127.0.0.1:${port}/agent-truth.mjs`),
    fetchText(`http://127.0.0.1:${port}/styles.css`),
    fetchText(`http://127.0.0.1:${port}/components/quick-rail.js`),
    fetchJson(`http://127.0.0.1:${port}/api/dashboard`),
    fetchText(`http://127.0.0.1:${port}/utils.js`),
    fetchText(`http://127.0.0.1:${port}/api-client.js`),
    fetchText(`http://127.0.0.1:${port}/thread-renderer.js`),
    fetchText(`http://127.0.0.1:${port}/drawer-panels.js`),
    fetchText(`http://127.0.0.1:${port}/settings-modal.js`),
    fetchText(`http://127.0.0.1:${port}/composer.js`),
    fetchJavaScriptModule(`http://127.0.0.1:${port}/project-identity.mjs`),
    fetchJavaScriptModule(`http://127.0.0.1:${port}/workbench-presentation.mjs`)
  ]);
  const [motionRuntime, gsapVendor] = await Promise.all([
    fetchText(`http://127.0.0.1:${port}/motion-runtime.js`),
    fetchText(`http://127.0.0.1:${port}/vendor/gsap.js`)
  ]);
  assert.ok(motionRuntime.includes("export const motion"));
  assert.ok(motionRuntime.includes("./vendor/gsap.js"));
  assert.ok(gsapVendor.includes("export const gsap"));
  assert.ok(projectIdentityJs.includes("export function deriveProjectIdentity"));
  assert.ok(workbenchPresentationJs.includes("export function deriveWorkbenchView"));
  assert.ok(workbenchPresentationJs.includes("export function deriveChapterCompletion"));

  // Codex 对话式信息架构：左栏项目 + 顶栏 + 对话流 + 单输入框（斜杠命令）+ 右侧抽屉
  assert.ok(html.includes("小说智能体"));
  assert.ok(html.includes("新建小说"));
  assert.ok(html.includes("我的小说"));
  assert.ok(html.includes("打开本地文件夹"));
  assert.ok(html.includes("开始一部新小说"));
  assert.ok(html.includes("故事设定"));
  assert.ok(html.includes("开始创作"));
  // 主列结构
  assert.ok(html.includes("id=\"new-novel\""));
  assert.ok(html.includes("id=\"project-filter\""));
  assert.ok(html.includes("id=\"thread\""));
  assert.ok(html.includes("thread-wrap"));
  assert.ok(html.includes("id=\"composer\""));
  assert.ok(html.includes("<textarea id=\"composer-input\""));
  assert.ok(html.includes("composer-submit"));
  assert.ok(html.includes("Enter 发送"));
  assert.ok(html.includes("slash-menu"));
  // 右侧抽屉：章节 / 模型 / 运行
  assert.ok(html.includes("id=\"drawer\""));
  assert.ok(html.includes("drawer-body"));
  assert.ok(html.includes("data-dtab=\"chapters\""));
  assert.ok(html.includes("data-dtab=\"model\""));
  assert.ok(html.includes("data-dtab=\"run\""));
  assert.ok(html.includes(">章节<"));
  assert.ok(html.includes(">模型<"));
  assert.ok(html.includes(">运行<"));
  // 设置弹窗（Cherry Studio 两栏）
  assert.ok(html.includes("settings-modal"));
  assert.ok(html.includes("搜索模型平台"));
  assert.ok(html.includes("settings-provider-list"));
  assert.ok(html.includes("settings-detail"));
  assert.ok(html.includes("保存设置"));
  // 章节阅读器
  assert.ok(html.includes("reader-scrim"));
  assert.ok(html.includes("reader-body"));
  // 顶栏 + 隐私 + 状态
  assert.ok(html.includes("topbar"));
  assert.ok(html.includes("project-status"));
  assert.ok(html.includes("id=\"topbar-stop\""));
  assert.ok(html.includes("id=\"topbar-progress\""));
  assert.ok(html.includes("privacy-toggle"));
  assert.ok(html.includes("隐私"));
  assert.ok(html.includes("toast-stack"));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("class=\"topbar-sub\"") || html.includes("id=\"topbar-sub\""));
  // Task4: dialog 名称与 tablist 语义
  assert.ok(html.includes("aria-labelledby=\"create-heading\""));
  assert.ok(html.includes("aria-label=\"设置\""));
  assert.ok(html.includes("role=\"tablist\""));
  assert.ok(html.includes("aria-labelledby=\"drawer-title\""));
  assert.ok(js.includes("aria-selected"));
  // Task5: inert 移出关闭态浮层 + 焦点陷阱/回退
  assert.ok(html.includes("id=\"reader-scrim\" inert") || html.includes("inert id=\"reader-scrim\""));
  assert.ok(js.includes("function trapTab"));
  assert.ok(js.includes("lastFocused"));
  assert.ok(js.includes("setAttribute(\"inert\""));
  // Task6: 动态生成的设置控件有可访问名称
  assert.ok(settingsModalJs.includes("input.setAttribute(\"aria-label\", labelText)"));
  assert.ok(settingsModalJs.includes("button.setAttribute(\"aria-label\", labelText)"));
  // Task7: 斜杠菜单 ARIA + 键盘导航
  assert.ok(html.includes("role=\"combobox\""));
  assert.ok(html.includes("aria-controls=\"slash-menu\""));
  assert.ok(composerJs.includes("aria-activedescendant"));
  assert.ok(composerJs.includes("setSlashActive"));
  assert.ok(composerJs.includes("ArrowDown"));
  // Task8: reduced-motion / 焦点指示 / live region
  assert.ok(css.includes("prefers-reduced-motion"));
  assert.ok(css.includes(".composer:focus-within"));
  assert.ok(css.includes(".sr-only"));
  assert.ok(html.includes("id=\"thread-status\""));
  assert.ok(js.includes("function announce"));
  assert.ok(threadRendererJs.includes("dataset.motionResolving"));
  // Task9: 补齐缺失/失效的样式
  assert.ok(css.includes(".reader-body p.reader-empty"));
  assert.ok(!css.includes("var(--paper)"));
  assert.ok(css.includes(".toast.leaving"));
  // border-radius consistency
  assert.ok(!css.includes("border-radius: var(--r, 12px)"), "failure-card must not have fallback in var(--r)");
  assert.ok(!css.includes("border-radius: 8px"), "all 8px border-radius must use var(--r-sm)");
  // Task10: 仅在贴底时自动滚动 + 抽屉重建保留滚动位置
  assert.ok(threadRendererJs.includes("clientHeight < 80"));
  assert.ok(js.includes("refs.drawerBody.scrollTop = "));
  // Task11: 添加按钮已接线
  assert.ok(js.includes("refs.settingsAdd.addEventListener"));
  // Progress + command-menu fixes.
  assert.ok(css.includes("[hidden] { display: none !important; }"));
  assert.ok(css.includes(".slash-item.active"));
  assert.ok(css.includes("@keyframes writingDots"));
  assert.ok(css.includes(".step-meta.writing"));
  assert.ok(threadRendererJs.includes("function writingStepLabel"));
  assert.ok(threadRendererJs.includes("写入第"));
  assert.ok(threadRendererJs.includes("metaKind"));
  assert.ok(js.includes("if (!button) return;"));
  assert.ok(apiClientJs.includes("if (!text) return { ok: response.ok };"));
  assert.ok(apiClientJs.includes("data.ok === false"));
  // verify extracted modules are wired
  assert.ok(js.includes('from "./utils.js"'), "app.js must import from utils.js");
  assert.ok(js.includes('from "./api-client.js"'), "app.js must import from api-client.js");
  assert.ok(js.includes('from "./thread-renderer.js"'), "app.js must import from thread-renderer.js");
  assert.ok(js.includes('from "./drawer-panels.js"'), "app.js must import from drawer-panels.js");
  assert.ok(js.includes('from "./settings-modal.js"'), "app.js must import from settings-modal.js");
  assert.ok(js.includes('from "./composer.js"'), "app.js must import from composer.js");
  assert.ok(threadRendererJs.includes("export function createThreadRenderer"), "thread-renderer.js must export createThreadRenderer");
  assert.ok(drawerPanelsJs.includes("export function createDrawerPanels"), "drawer-panels.js must export createDrawerPanels");
  assert.ok(settingsModalJs.includes("export function createSettingsModal"), "settings-modal.js must export createSettingsModal");
  assert.ok(composerJs.includes("export function createComposer"), "composer.js must export createComposer");
  assert.ok(utilsJs.includes("export function compactObject"));
  assert.ok(utilsJs.includes("export function translateStage"));
  assert.ok(utilsJs.includes("export function cssEscape"));
  assert.ok(apiClientJs.includes("export async function getJson"));
  assert.ok(apiClientJs.includes("export async function postJson"));
  assert.ok(css.includes("[data-privacy=\"on\"] .peek"));
  assert.ok(css.includes("backdrop-filter"));
  assert.ok(css.includes("--window-control-space"));
  assert.ok(css.includes("calc(20px + var(--window-control-space))"));
  assertWindowDragRegionsAreClickSafe(css);
  assert.ok(html.includes('data-testid="project-workbench"'));
  assert.ok(html.includes('id="workbench-primary"'));
  assert.ok(html.includes('id="workbench-read-latest"'));
  assert.ok(html.includes('id="workbench-activity"'));
  assert.ok(css.includes(".project-workbench"));
  assert.ok(css.includes(".proj-cover"));
  assert.ok(css.includes(".creation-card"));
  assert.ok(css.includes(".reader-scrim"));
  assert.ok(css.includes(".toast"));
  assert.ok(css.includes(".rail"));
  assert.ok(css.includes(".drawer-tabs"));
  assert.ok(css.includes(".dpanel"));
  assert.ok(css.includes(".session-head"));
  assert.ok(css.includes(".composer"));
  assert.ok(css.includes(".filecard"));
  assert.ok(css.includes("--rail"));
  assert.ok(css.includes(".slash-item"));
  assert.ok(css.includes(".sidecard"));
  assert.ok(css.includes(".steps"));
  assert.ok(css.includes(".bubble-user"));
  // transition timing consistency
  assert.ok(!css.match(/transition[^;]*\.13s/), "no .13s transitions allowed");
  assert.ok(!css.match(/transition[^;]*\.14s/), "no .14s transitions allowed");
  assert.ok(!css.match(/transition[^;]*\.15s/), "no .15s transitions allowed");
  assert.ok(!css.match(/transition[^;]*\.16s/), "no .16s transitions allowed");
  assert.ok(!css.match(/transition[^;]*\.18s/), "no .18s transitions allowed");
  // 反向断言：旧的标签式信息架构与开发者面板术语不应回归
  assert.ok(!html.includes("data-view-button"));
  assert.ok(!html.includes("data-view-page"));
  assert.ok(!html.includes("data-composer-mode"));
  assert.ok(!html.includes("状态检查器"));
  assert.ok(!html.includes(">Provider<"));
  assert.ok(!html.includes(">Token<"));
  assert.ok(!html.includes("Writing Control Room"));
  assert.ok(!html.includes("/btw"));
  // 对话式表现层关键函数
  assert.ok(js.includes("loadDashboard"));
  assert.ok(js.includes("syncThread"));
  assert.ok(threadRendererJs.includes("buildAgentBlock"));
  assert.ok(threadRendererJs.includes("computeSteps"));
  assert.ok(js.includes("ensureRefreshLoop"));
  // Task1: 轮询遇错自愈，不在瞬时错误时永久停表
  assert.ok(js.includes("ensureRefreshLoop(true)"));
  // Task1: 完成竞态——liveBlock 未定稿时维持轮询
  assert.ok(js.includes("Boolean(liveBlock && !liveBlock.done)"));
  // Task1: 切项目/切空重置 liveBlock
  assert.ok((js.match(/liveBlock = null/g) || []).length >= 2);
  assert.ok(threadRendererJs.includes("setLiveBlock(null)"));
  assert.ok(composerJs.includes("buildSideBubble"));
  assert.ok(js.includes("openProject"));
  assert.ok(js.includes("initProject"));
  assert.ok(js.includes("openCreateModal"));
  assert.ok(js.includes('createHeading: document.querySelector("#create-heading")'), "create modal heading ref must be wired");
  assert.ok(js.includes('createLead: document.querySelector("#create-card .lead")'), "create modal lead ref must be wired");
  assert.ok(js.includes('let createModalMode = "new"'), "create modal mode state must default to new");
  assert.ok(js.includes("function renderCreateModalCopy"), "create modal copy must be rendered by mode");
  assert.ok(js.includes('mode: "preview"'), "open folder browser fallback must use preview create mode");
  assert.ok(js.includes('mode: "init-folder"'), "opening a non-project folder must use init-folder create mode");
  assert.ok(cssRuleBlock(css, ".rail-new").includes("position: relative"), "new novel rail entry must have stable positioning");
  assert.ok(cssRuleBlock(css, ".rail-new").includes("z-index:"), "new novel rail entry must set a stacking context");
  assert.ok(cssRuleBlock(css, ".rail-new").includes("background:"), "new novel rail entry must paint over scroll content");
  assert.ok(cssRuleBlock(css, ".rail-scroll").includes("position: relative"), "rail scroll area must have stable positioning");
  assert.ok(cssRuleBlock(css, ".rail-scroll").includes("z-index:"), "rail scroll area must set a stacking context");
  assert.ok(cssRuleBlock(css, ".rail-foot").includes("position: relative"), "rail foot must have stable positioning");
  assert.ok(cssRuleBlock(css, ".rail-foot").includes("z-index:"), "rail foot must set a stacking context");
  assert.ok(cssRuleBlock(css, ".rail-foot").includes("background:"), "rail foot must paint over scroll content");
  assert.ok(settingsModalJs.includes("updateEndpointPreview"));
  assert.ok(settingsModalJs.includes("resolveModelEndpoint"));
  // Task2: 资料联网搜索/抓取入口已恢复
  assert.ok(drawerPanelsJs.includes("/api/research/${action}"));
  assert.ok(drawerPanelsJs.includes("function runResearch"));
  assert.ok(css.includes(".research-form"));
  // Task3: 设置可配置联网搜索端点
  assert.ok(settingsModalJs.includes("research_config"));
  assert.ok(settingsModalJs.includes("settingsFields.searchEndpoint"));
  assert.ok(settingsModalJs.includes('settingField("模型", "model-id"'), "settings model field must be editable model-id input");
  assert.ok(!settingsModalJs.includes('settingField("模型", "select"'), "settings model field must no longer be a select");
  assert.ok(settingsModalJs.includes("settings-model-suggestions"), "settings model field must preserve preset suggestions with a datalist");
  assert.ok(settingsModalJs.includes('document.createElement("datalist")'), "settings model field must create a datalist for suggestions");
  assert.ok(js.includes("openSettingsModal"));
  assert.ok(settingsModalJs.includes("PROVIDER_PRESETS"));
  assert.ok(settingsModalJs.includes("detectProviderPreset"));
  assert.ok(drawerPanelsJs.includes("renderChapterPanel"));
  assert.ok(js.includes("setDrawerTab"));
  assert.ok(js.includes("/api/projects/open"));
  assert.ok(js.includes("/api/projects/init"));
  assert.ok(composerJs.includes("/api/commands/submit"));
  assert.ok(js.includes("/api/chapters/read"));
  assert.ok(js.includes("openReader"));
  assert.ok(js.includes("showToast"));
  assert.ok(composerJs.includes("autoGrowComposer"));
  assert.ok(js.includes("initPrivacyMode"));
  assert.ok(js.includes("setPrivacyMode"));
  assert.ok(js.includes("ww:privacy"));
  // Task2: Quick Rail 气泡必须由模块级单例统一清理，且不叠加原生 title tooltip
  assert.ok(quickRailJs.includes("let activePopover"));
  assert.ok(quickRailJs.includes("let activeTimer"));
  assert.ok(quickRailJs.includes("let activeOwner"));
  assert.ok(quickRailJs.includes("function clearQuickRailPopover"));
  assert.ok(quickRailJs.includes("clearTimeout(activeTimer)"));
  assert.ok(quickRailJs.includes("activePopover.remove()"));
  assert.ok(quickRailJs.includes("activeOwner = null"));
  assert.ok(quickRailJs.includes("clearQuickRailPopover();"));
  assert.ok(quickRailJs.includes("if (!text) return"));
  assert.ok(quickRailJs.includes("btn.addEventListener('mouseenter'"));
  assert.ok(quickRailJs.includes("btn.addEventListener('focus'"));
  assert.ok(quickRailJs.includes("btn.addEventListener('mouseleave'"));
  assert.ok(quickRailJs.includes("btn.addEventListener('blur'"));
  assert.ok(quickRailJs.includes("btn.addEventListener('click'"));
  assert.ok(quickRailJs.includes("btn.addEventListener('pointerdown'"));
  assert.ok(quickRailJs.includes("window.addEventListener('blur'"));
  assert.ok(quickRailJs.includes("window.addEventListener('resize'"));
  assert.ok(quickRailJs.includes("window.addEventListener('scroll'"));
  assert.ok(quickRailJs.includes("document.addEventListener('pointerdown'"));
  assert.ok(quickRailJs.includes("activeOwner?.contains(event.target)"));
  assert.ok(!quickRailJs.includes("btn.title = slot.label"));
  assert.ok(composerJs.includes("parseUserCommand"));
  assert.ok(composerJs.includes("submitSideQuestion"));
  assert.ok(composerJs.includes("promoteAskEntry"));
  assert.ok(js.includes("agentPhaseLabel"));
  assert.ok(composerJs.includes("detectMainTaskImpact"));
  assert.ok(composerJs.includes("/api/commands/ask"));
  // Retry candidate, project list remove, and cache summary consistency.
  assert.ok(truthJs.includes("retry_available"));
  assert.ok(truthJs.includes("retry_unavailable_reason"));
  assert.ok(js.includes("retry_task_id"));
  assert.ok(js.includes("/api/projects/forget"));
  assert.ok(js.includes('postJson("/api/projects/forget"'));
  assert.ok(js.includes("forgetProject"));
  assert.ok(js.includes('remove.addEventListener("click"'));
  assert.ok(js.includes("event.stopPropagation()"));
  assert.ok(js.includes("aria-label"));
  assert.ok(drawerPanelsJs.includes("cacheSummary"));
  assert.ok(drawerPanelsJs.includes("缓存键稳定") || drawerPanelsJs.includes("cacheSummary.explanation"));
  assert.ok(css.includes(".proj-menu"));
  assert.ok(css.includes(".proj-remove"));
  assertSideQuestionParityWithBackend(composerJs);
  assertDomSelectorsExist(js, html);
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.hasProject, true);
  assert.equal(dashboard.model_profile.display, "Mock / mock-writer");
  assert.equal(dashboard.summary.completedChapters, 2);
  assert.ok(dashboard.summary.totalTokens > 0);
  assert.ok(dashboard.cost.calls >= 2);
  assert.ok(dashboard.cache.last_call.cacheKey);
  assert.ok(dashboard.skills.items.length >= 5, "built-in skill pack should list 5+ skills");
  const suspenseSkill = dashboard.skills.items.find((skill) => skill.name === "suspense-chapter-end");
  assert.ok(suspenseSkill, "suspense-chapter-end should be listed");
  assert.equal(suspenseSkill.enabled_in_project, true);
  assert.equal(dashboard.sources.count, 1);
  assert.equal(dashboard.review.status, "passed");
  assert.equal(dashboard.project.title, "Dashboard Novel");
  assert.ok(dashboard.project.story_seed.length > 0);
  assert.equal(dashboard.summary.progressPercent, 100);
  assert.ok(dashboard.chapters.some((chapter) => chapter.artifact?.state === "committed"));
  assert.equal(dashboard.review.status, "passed");
  assert.ok(dashboard.review.reviewed_at);
  const chapterRead = await fetchJson(`http://127.0.0.1:${port}/api/chapters/read?chapter=1`);
  assert.equal(chapterRead.ok, true);
  assert.equal(chapterRead.chapter_no, 1);
  assert.ok(chapterRead.content.length > 0);
  assert.ok(!chapterRead.content.includes("segment:"));
  assert.ok(!chapterRead.content.includes("# Chapter"));
  const chapterReadMissing = await fetch(`http://127.0.0.1:${port}/api/chapters/read?chapter=999`);
  assert.equal(chapterReadMissing.ok, false);
  const projectList = await fetchJson(`http://127.0.0.1:${port}/api/projects/list`);
  assert.equal(projectList.ok, true);
  assert.ok(projectList.projects.some((project) => project.projectRoot === projectRoot));
  assert.ok(projectList.projects.find((project) => project.projectRoot === projectRoot).model_label.includes("mock-writer"));
  await postJson(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot });
  const reopenedDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(reopenedDashboard.projectRoot, projectRoot);

  // 旁路询问：只读回答，不修改正文/状态，不重启已完成项目，记录写入独立的 side_questions.md。
  const askResult = await postJson(`http://127.0.0.1:${port}/api/commands/ask`, { question: "现在写到第几章了？" });
  assert.equal(askResult.mainTaskAffecting, false);
  assert.ok(askResult.answer.length > 0);
  assert.equal(askResult.loggedTo, "side_questions.md");
  const askImpact = await postJson(`http://127.0.0.1:${port}/api/commands/ask`, { question: "把女主改成反派" });
  assert.equal(askImpact.mainTaskAffecting, true);
  assert.ok(askImpact.suggestion.includes("是否要将它加入正式写作任务"));
  const afterAskDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(afterAskDashboard.summary.projectStatus, "completed");
  assert.ok(!afterAskDashboard.events.some((event) => event.type === "project_run_started" && event.stage === "side_question"));
  const sideLog = await fs.readFile(path.join(projectRoot, "side_questions.md"), "utf8");
  assert.ok(sideLog.includes("# 旁路询问记录"));
  assert.ok(sideLog.includes("现在写到第几章了？"));
  await postJson(`http://127.0.0.1:${port}/api/skills/disable`, { name: "suspense-chapter-end" });
  const disabledDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(disabledDashboard.skills.items.find((skill) => skill.name === "suspense-chapter-end").enabled_in_project, false);
  await postJson(`http://127.0.0.1:${port}/api/skills/enable`, { name: "suspense-chapter-end" });
  await postJson(`http://127.0.0.1:${port}/api/skills/import`, {
    manifest: {
      name: "dashboard-style",
      version: "1.0.0",
      type: "style",
      scope: "chapter",
      hooks: [{ stage: "planning", action: "append_prompt", content: "Keep scene goals visible." }]
    }
  });
  const updatedDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(updatedDashboard.skills.items.find((skill) => skill.name === "suspense-chapter-end").enabled_in_project, true);
  assert.equal(updatedDashboard.skills.items.find((skill) => skill.name === "dashboard-style").enabled_in_project, true);
  await postJson(`http://127.0.0.1:${port}/api/settings/update`, {
    active_model: {
      provider: "openai-compatible",
      model_name: "writer-smoke",
      base_url: "https://api.example.test/v1",
      api_key: "sk-smoke-key-for-local-secret",
      api_key_env: "WRITER_API_KEY",
      max_output_tokens: 2048
    },
    tool_permissions: {
      network_allowed: true
    },
    budget_config: {
      max_model_calls: 77
    },
    research_config: {
      search_endpoint: "https://search.example.test/api",
      search_api_key_env: "SEARCH_API_KEY"
    }
  });
  const settingsDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(settingsDashboard.project.active_model.provider, "openai-compatible");
  assert.equal(settingsDashboard.project.active_model.model_name, "writer-smoke");
  assert.equal(settingsDashboard.project.active_model.api_key, undefined);
  assert.equal(settingsDashboard.project.active_model.api_key_env, "WRITER_API_KEY");
  assert.equal(settingsDashboard.model_profile.display, "openai-compatible / writer-smoke");
  assert.equal(settingsDashboard.model_profile.api_key_saved, true);
  assert.ok(settingsDashboard.model_profile.api_key_masked.endsWith("cret"));
  assert.equal(settingsDashboard.project.tool_permissions.network_allowed, true);
  assert.equal(settingsDashboard.project.budget_config.max_model_calls, 77);
  assert.equal(settingsDashboard.project.research_config.search_endpoint, "https://search.example.test/api");
  const savedSecrets = await fs.readFile(path.join(secretsRoot, "secrets.json"), "utf8");
  assert.equal(JSON.parse(savedSecrets).WRITER_API_KEY, "sk-smoke-key-for-local-secret");
  const completedCommand = await postJson(`http://127.0.0.1:${port}/api/commands/submit`, { message: "继续下一章，但章节正文必须写入本地文件。" });
  assert.equal(completedCommand.started, false);
  assert.equal(completedCommand.completed, true);
  const commandDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.ok(commandDashboard.events.some((event) => event.type === "user_instruction_received"));
  assert.ok(commandDashboard.events.some((event) => event.type === "project_run_skipped"));
  const commandRoot = path.join(root, "command-run-folder");
  await postJson(`http://127.0.0.1:${port}/api/projects/init`, {
    projectRoot: commandRoot,
    title: "Command Run Novel",
    story_seed: "命令栏启动一个真实写作任务。",
    target_chapters: 1,
    min_words_per_chapter: 80
  });
  // /api/projects/init 走 createProjectAt（blueprint_status "none"），
  // 后续命令栏写作会被门禁拒绝，这里直接对文件系统预置 complete。
  await markBlueprintReady(commandRoot);
  const inheritedCommandDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(inheritedCommandDashboard.projectRoot, commandRoot);
  assert.equal(inheritedCommandDashboard.project.active_model.model_name, "writer-smoke");
  await postJson(`http://127.0.0.1:${port}/api/settings/update`, {
    active_model: {
      provider: "mock",
      model_name: "mock-writer"
    }
  });
  const runCommand = await postJson(`http://127.0.0.1:${port}/api/commands/submit`, {
    message: "从命令栏启动写作，并把正文写入本地文件。"
  });
  assert.equal(runCommand.started, true);
  const finishedRunDashboard = await waitForDashboardEvent(port, "project_run_finished");
  assert.ok(finishedRunDashboard.events.some((event) => event.type === "project_run_started"));
  assert.ok(finishedRunDashboard.events.some((event) => event.type === "project_started"));
  assert.ok(finishedRunDashboard.events.some((event) => event.type === "chapter_completed"));
  assert.equal(finishedRunDashboard.summary.projectStatus, "completed");
  assert.equal(finishedRunDashboard.summary.activityProgressPercent, 100);
  const commandChapter = await fs.readFile(path.join(commandRoot, "chapters", "001.md"), "utf8");
  assert.ok(commandChapter.includes("segment:1"));
  const brokenProject = await createProject(root, {
    slug: "broken-provider",
    title: "Broken Provider",
    target_chapters: 1,
    min_words_per_chapter: 80,
    active_model: {
      provider: "missing-provider",
      model_name: "missing-model"
    }
  });
  // 同上：broken 项目也要通过蓝图门禁，才能走到 provider 失败路径（blocked）。
  await markBlueprintReady(brokenProject.projectRoot);
  await postJson(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot: brokenProject.projectRoot });
  const brokenCommand = await postJson(`http://127.0.0.1:${port}/api/commands/submit`, {
    message: "触发一个失败的 provider，用来验证前端不会一直显示工作中。"
  });
  assert.equal(brokenCommand.started, true);
  const brokenDashboard = await waitForDashboardEvent(port, "project_run_failed");
  assert.equal(brokenDashboard.summary.projectStatus, "blocked");
  assert.equal(brokenDashboard.summary.currentStage, "blocked");
  const initRoot = path.join(root, "empty-picked-folder");
  const openFailure = await postJsonExpectFailure(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot: initRoot });
  assert.equal(openFailure.code, "project_open_failed");
  assert.ok(openFailure.message.includes("不是有效的 WWriting 项目文件夹"));
  await postJson(`http://127.0.0.1:${port}/api/projects/init`, {
    projectRoot: initRoot,
    title: "Initialized From Folder",
    story_seed: "一个空文件夹被初始化为项目。",
    target_chapters: 9,
    min_words_per_chapter: 1200
  });
  const initializedDashboard = await fetchJson(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(initializedDashboard.projectRoot, initRoot);
  assert.equal(initializedDashboard.project.title, "Initialized From Folder");
  assert.equal(initializedDashboard.project.story_seed, "一个空文件夹被初始化为项目。");
  assert.equal(initializedDashboard.summary.targetChapters, 9);
  assert.equal(initializedDashboard.summary.currentChapterNo, 1);
  assert.equal(initializedDashboard.summary.projectStatus, "idle");

  // 持久会话：最近项目列表来自持久化 recents（不再扫描整个工作区噪声项目）
  await postJson(`http://127.0.0.1:${port}/api/projects/open`, { projectRoot });
  const recentList = await fetchJson(`http://127.0.0.1:${port}/api/projects/list`);
  assert.ok(recentList.projects.length <= 12, "recents should be a curated short list, not a workspace scan");
  assert.ok(recentList.projects.some((project) => project.projectRoot === projectRoot));
  assert.ok(recentList.projects.some((project) => project.projectRoot === initRoot));

  // 持久会话：重开应用（新进程，无 PROJECT_ROOT）应恢复最近打开的小说
  const restartPort = await getFreePort();
  const restartChild = spawn(process.execPath, ["scripts/serve-app-shell.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(restartPort), WWRITING_SECRETS_ROOT: secretsRoot, PROJECT_ROOT: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForServer(restartPort);
    const restored = await fetchJson(`http://127.0.0.1:${restartPort}/api/dashboard`);
    assert.equal(restored.hasProject, true);
    assert.equal(restored.projectRoot, projectRoot);
  } finally {
    restartChild.kill();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        url: `http://127.0.0.1:${port}`,
        projectRoot,
        completedChapters: dashboard.summary.completedChapters
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}

async function waitForServer(targetPort) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      await fetchText(`http://127.0.0.1:${targetPort}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`app shell server did not start. ${stderrText}`);
}

// 蓝图门禁适配（spec §1.4）：新建项目 blueprint_status 默认 "none"，
// 写作入口（runProject / /api/commands/submit）会拒绝。verify 脚本只测 shell 渲染与
// API 流，不验证蓝图内容，预置 complete 放行即可（与 tests/helpers.mjs createWritingProject 同款模式）。
async function markBlueprintReady(projectRoot) {
  const state = await loadState(projectRoot);
  state.blueprint_status = "complete";
  await saveState(projectRoot, state);
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  return response.text();
}

async function fetchJavaScriptModule(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/javascript(?:;|$)/iu,
    `${url} must be served as JavaScript`
  );
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} must return 2xx`);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.ok, true, `${url} must return 2xx`);
  const data = await response.json();
  assert.equal(data.ok, true);
  return data;
}

async function postJsonExpectFailure(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.ok, false, `${url} must return non-2xx`);
  return response.json();
}

async function waitForDashboardEvent(targetPort, eventType) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const dashboard = await fetchJson(`http://127.0.0.1:${targetPort}/api/dashboard`);
    if (dashboard.events.some((event) => event.type === eventType)) {
      return dashboard;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`dashboard did not receive ${eventType}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (!port) {
          reject(new Error("failed to allocate a free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function assertDomSelectorsExist(js, html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]));
  const selectors = [...js.matchAll(/document\.querySelector\("([^"]+)"\)/gu)].map((match) => match[1]);
  for (const selector of selectors) {
    if (/^#[\w-]+$/u.test(selector)) {
      assert.ok(ids.has(selector.slice(1)), `missing DOM id for selector ${selector}`);
    } else if (selector.startsWith("#")) {
      const id = selector.match(/^#([\w-]+)/u)?.[1];
      assert.ok(!id || ids.has(id), `missing DOM id for selector ${selector}`);
    }
  }
}

function assertWindowDragRegionsAreClickSafe(css) {
  for (const selector of [".topbar", ".rail-top"]) {
    const block = cssRuleBlock(css, selector);
    assert.ok(block, `${selector} CSS rule must exist`);
    assert.equal(
      cssRegionValue(block, "drag"),
      false,
      `${selector} contains buttons, so the container itself must not be an Electron drag region`
    );
  }
  assert.equal(
    cssRegionValue(css, "no-drag"),
    true,
    "interactive controls must opt out of Electron drag regions"
  );
  assert.equal(
    cssRegionValue(cssRuleBlock(css, ".topbar-id"), "drag"),
    true,
    "the non-interactive title area should remain draggable"
  );
  assert.equal(
    cssRegionValue(cssRuleBlock(css, ".brand-mark"), "drag"),
    true,
    "the non-interactive brand mark should remain draggable"
  );
}

function cssRuleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

function cssRegionValue(css, value) {
  return new RegExp(`(?:^|[;\\s{])(?:-webkit-)?app-region:\\s*${value}\\s*;`, "u").test(css);
}

// 漂移守卫：前端 app.js 镜像了后端 side-question.mjs 的命令前缀与改主线正则（前端只用于即时提示，
// 后端始终是权威）。这里断言两边逐字一致，任何一边改了而另一边没跟进都会让验证失败。
function assertSideQuestionParityWithBackend(js) {
  assert.ok(
    js.includes(`const SIDE_QUESTION_PREFIXES = ${jsArrayLiteral(SIDE_QUESTION_PREFIXES)};`),
    "app.js SIDE_QUESTION_PREFIXES drifted from backend side-question.mjs"
  );
  assert.ok(
    js.includes(`const REVIEW_PREFIXES = ${jsArrayLiteral(REVIEW_PREFIXES)};`),
    "app.js REVIEW_PREFIXES drifted from backend side-question.mjs"
  );
  assert.ok(
    js.includes(`const WRITE_PREFIXES = ${jsArrayLiteral(WRITE_PREFIXES)};`),
    "app.js WRITE_PREFIXES drifted from backend side-question.mjs"
  );
  const frontendPattern = js.match(/const MAIN_TASK_IMPACT_PATTERN = (\/.*\/u);/u);
  assert.ok(frontendPattern, "app.js MAIN_TASK_IMPACT_PATTERN not found");
  assert.equal(
    frontendPattern[1],
    MAIN_TASK_IMPACT_PATTERN.toString(),
    "app.js MAIN_TASK_IMPACT_PATTERN drifted from backend side-question.mjs"
  );
}

// 还原 app.js 里数组字面量的书写格式：["/ask", "/side", "/q"]（元素间带逗号空格）。
function jsArrayLiteral(values) {
  return `[${values.map((value) => `"${value}"`).join(", ")}]`;
}

function checkFailureCommandDrift() {
  const a = Object.keys(BE_COMMANDS).sort().join(",");
  const b = Object.keys(FE_COMMANDS).sort().join(",");
  if (a !== b) {
    throw new Error(`故障卡命令白名单已漂移:\n  shared: ${a}\n  frontend: ${b}`);
  }
  console.log("[verify] 故障卡白名单一致:", Object.keys(BE_COMMANDS).length, "个命令");
}
