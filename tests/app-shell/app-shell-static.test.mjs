// Static assertions over app.js / api-client.js source（统一 Agent 内核计划 Task 9 改写，
// Task 12 追加：quick rail 删除后的静态契约与抽屉可达性）。
// 断言新组合根的接线：AgentSurface 是唯一对话 seam、api-client 通用 helper 保留、
// quick rail 已整体删除且功能可经顶部按钮/drawer 到达、drawer-panels 直接导出、
// settings-modal 稳定行为。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.join(here, "..", "..", "src", "app-shell", "app.js");
const apiClientPath = path.join(here, "..", "..", "src", "app-shell", "api-client.js");
const drawerPanelsPath = path.join(here, "..", "..", "src", "app-shell", "drawer-panels.js");
const chapterPresentationPath = path.join(here, "..", "..", "src", "app-shell", "chapter-presentation.mjs");
const indexHtmlPath = path.join(here, "..", "..", "src", "app-shell", "index.html");
const stylesPath = path.join(here, "..", "..", "src", "app-shell", "styles.css");
const iconsPath = path.join(here, "..", "..", "src", "app-shell", "icons.js");
const agentCssPath = path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css");
const slashCommandsPath = path.join(here, "..", "..", "src", "app-shell", "agent", "slash-commands.mjs");

const appSource = await fs.readFile(appJsPath, "utf8");
const apiClientSource = await fs.readFile(apiClientPath, "utf8");
const drawerPanelsSource = await fs.readFile(drawerPanelsPath, "utf8");
const chapterPresentationSource = await fs.readFile(chapterPresentationPath, "utf8");
const indexHtmlSource = await fs.readFile(indexHtmlPath, "utf8");
const stylesSource = await fs.readFile(stylesPath, "utf8");
const iconsSource = await fs.readFile(iconsPath, "utf8");
const agentCssSource = await fs.readFile(agentCssPath, "utf8");
const slashCommandsSource = await fs.readFile(slashCommandsPath, "utf8");

test("顶栏不显示待命胶囊或闪烁状态条", () => {
  assert.doesNotMatch(indexHtmlSource, /project-status|>待命</u);
  assert.doesNotMatch(appSource, /refs\.status|setStatus\(|is-busy/u);
  assert.doesNotMatch(stylesSource, /topbar\.is-busy|topbarSweep|pillShimmer/u);
});

test("项目列表使用 Codex 式紧凑单行导航", () => {
  assert.match(iconsSource, /folder:\s*["']/u, "项目导航应提供文件夹图标");
  assert.match(appSource, /icon\(["']folder["'],\s*16\)/u, "每个项目应以文件夹图标开头");
  assert.doesNotMatch(appSource, /proj-cover|proj-dot|proj-sub|deriveProjectIdentity/u);
  assert.match(stylesSource, /\.proj-icon\s*\{/u);
  // R3/B1：项目不可选中——不再存在 .proj.active 选中态样式（行主体点击只折叠/展开）。
  assert.doesNotMatch(stylesSource, /\.proj\.active/u, "项目行不可选中：应无 .proj.active 样式");
});

test("空项目侧栏保持简洁，不重复教授主界面的创建操作", () => {
  assert.doesNotMatch(appSource, /点上方「新建小说」开始/u);
});

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

test("Task 5 静态契约：归档/删除共用「移除后切走 + 占位兜底」解析器", () => {
  // 缺陷 B（归档当前活跃会话后消息写进隐藏归档会话）：归档路径与删除路径共用
  // createSessionRemovalResolver（依赖注入纯函数，切走 + 新代次重拉落盘 + 占位兜底，
  // 见 session-sidebar.mjs），app.js 只做依赖接线并经 onArchiveSession 注入侧边栏。
  assert.match(
    appSource,
    /createSessionRemovalResolver/,
    "app.js 应使用可注入的会话移除解析器（session-sidebar.mjs 导出）"
  );
  assert.match(appSource, /resolveActiveAfterSessionRemoval\s*\(sessionId\)/, "删除路径调用共用解析函数");
  assert.match(appSource, /resolveActiveAfterSessionRemoval\s*\(session\.session_id\)/, "归档路径调用共用解析函数");
  assert.match(appSource, /onArchiveSession\s*:/, "app.js 应向侧边栏注入归档 handler（切走编排入口）");
  assert.match(appSource, /refreshSessions:\s*\(\s*\)\s*=>\s*agentSurface\.refreshSessions/, "解析器接线重拉列表（新代次落盘后占位判定才权威）");
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

test("Task 12 静态契约：quick rail 删除、无框时间线、1040px 主轴（token）、/review 下线", () => {
  // brief Step 1 verbatim 断言：
  assert.doesNotMatch(indexHtmlSource, /id="quick-rail"|id="qr-collapsed"/u, "quick rail 与折叠按钮应整体删除");
  assert.doesNotMatch(appSource, /renderQuickRail|bindQuickRailKeys/u, "app.js 不得引用 quick rail 渲染/键盘绑定");
  assert.doesNotMatch(slashCommandsSource, /\/review/u, "斜杠命令不得再含 /review");
  assert.doesNotMatch(
    agentCssSource,
    /\.agent-(?:work|reasoning|tool|plan)[^{]*\{[^}]*background:\s*var\(--(?:surface|accent|green|red)/su,
    "时间线容器不得使用 surface/accent/green/red 底色"
  );
  // Round10：主内容轴 token 由 styles.css :root 独占声明，agent.css 只引用。
  assert.match(stylesSource, /--content-column:\s*1040px/u, "styles.css :root 应声明 1040px 内容列 token");
  assert.match(agentCssSource, /var\(--content-column\)/u, "agent.css 应引用内容列 token");
  assert.doesNotMatch(agentCssSource, /--content-column\s*:/u, "agent.css 不得重新声明内容列");
});

test("quick rail 删除后：顶部按钮打开 drawer，drawer 分区保持可点击", () => {
  assert.match(indexHtmlSource, /id="open-drawer"/u, "顶栏应有抽屉入口按钮");
  assert.match(appSource, /open-drawer/u, "app.js 应绑定抽屉入口按钮");
  assert.match(appSource, /openDrawerTab\s*\(/u, "抽屉入口应接线 openDrawerTab");
  // 章节/模型/资料/成本四个 drawer 分区仍然存在并可点击。
  for (const tab of ["chapters", "model", "research", "cost"]) {
    assert.ok(indexHtmlSource.includes(`data-dtab="${tab}"`), `drawer 应保留 ${tab} 分区`);
  }
  assert.doesNotMatch(stylesSource, /\.quick-rail|\.qr-slot|\.qr-collapsed-btn/u, "quick rail 样式应整体删除");
});

test("drawer-panels.js 直接调用确定性导出 route，无旧业务入口", () => {
  assert.match(drawerPanelsSource, /\/api\/projects\/export-book/u, "导出应直接调用确定性 route");
  assert.doesNotMatch(drawerPanelsSource, /sendChatMessageWithUX|renderRunPanel|renderReviewerPanel/u);
  assert.ok(drawerPanelsSource.includes("function renderChapterPanel"));
  assert.ok(drawerPanelsSource.includes("function renderModelPanel"));
  assert.ok(drawerPanelsSource.includes("function renderCostPanel"));
});

// Task 21/25（spec 4.3 #4）+ Round10：成本统一人民币元——drawer-panels 两处成本展示
//（章节列表 meta / 模型面板估算成本 kv）必须走 formatYuan；成本抽屉头部金额 pill
// 已按 Round10 移除（主金额只在 cost-panel.js「总览」显示一次，cost-panel 自有测试覆盖）。
test("drawer-panels 成本展示统一走 formatYuan，无 formatMoney", async () => {
  const utilsPath = path.join(here, "..", "..", "src", "app-shell", "utils.js");
  const utilsSource = await fs.readFile(utilsPath, "utf8");
  const costPanelPath = path.join(here, "..", "..", "src", "app-shell", "components", "cost-panel.js");
  const costPanelSource = await fs.readFile(costPanelPath, "utf8");
  // 单一出口在 utils.js：formatMoney 已删除，formatYuan 存在。
  assert.match(utilsSource, /export function formatYuan\(/u, "formatYuan 应是 utils.js 的单一出口");
  assert.doesNotMatch(utilsSource, /formatMoney/u, "utils.js 不得再保留 formatMoney");
  // drawer-panels 两处成本展示全部使用 formatYuan。
  assert.match(drawerPanelsSource, /formatYuan\(costRow\.estimatedCost\)/u, "章节列表 meta 成本应走 formatYuan");
  assert.match(drawerPanelsSource, /formatYuan\(summary\.estimatedCost\)/u, "模型面板估算成本应走 formatYuan");
  assert.equal((drawerPanelsSource.match(/formatYuan\(/gu) ?? []).length, 2, "drawer-panels 应有且只有两处 formatYuan 成本展示");
  assert.doesNotMatch(drawerPanelsSource, /formatMoney/u, "drawer-panels 不得残留 formatMoney");
  // cost-panel 组件同样无本地 formatMoney 残留，formatYuan 从 utils.js 导入。
  assert.doesNotMatch(costPanelSource, /formatMoney/u, "cost-panel 不得引用 formatMoney");
  assert.match(costPanelSource, /import\s*\{[^}]*formatYuan[^}]*\}\s*from\s*["']\.\.\/utils\.js["']/u, "cost-panel 应从 utils.js 导入 formatYuan");
});

test("章节导出操作使用文字按钮，不得复用固定宽度的图标按钮", () => {
  assert.match(
    drawerPanelsSource,
    /exportBtn\.className\s*=\s*["']small-button export-btn["']/u,
    "导出成书应使用可容纳文字的按钮样式"
  );
  assert.match(
    drawerPanelsSource,
    /revealBtn\.className\s*=\s*["']small-button export-reveal-btn["']/u,
    "打开导出文件夹应使用可容纳文字的按钮样式"
  );
  assert.match(stylesSource, /\.export-toolbar\s*\{[^}]*display:\s*flex/u, "导出工具栏应保持稳定的横向布局");
  assert.match(stylesSource, /\.export-toolbar\s+\.small-button\s*\{[^}]*white-space:\s*nowrap/u, "导出按钮文字不得被压缩换行");
});

test("settings-modal.js re-exports the pure connection helper", () => {
  const settingsModalPath = path.join(here, "..", "..", "src", "app-shell", "settings-modal.js");
  return fs.readFile(settingsModalPath, "utf8").then((settingsModalSource) => {
    assert.match(
      settingsModalSource,
      /export\s*\{[^}]*formatConnectionStatus[^}]*\}\s*from\s*["']\.\/settings-connection\.mjs["']/,
      "settings-modal.js should re-export formatConnectionStatus from ./settings-connection.mjs"
    );
    assert.doesNotMatch(
      settingsModalSource,
      /export\s*\{[^}]*submitModelConnectionTest[^}]*\}\s*from\s*["']\.\/settings-connection\.mjs["']/u,
      "Task 17 cutover：submitModelConnectionTest 不再 re-export（随模型区块删除）"
    );
  });
});

test("chapter-presentation.mjs 保留（稳定领域展示模块）", () => {
  assert.match(
    chapterPresentationSource,
    /export\s+function\s+presentChapterArtifact\s*\(/,
    "chapter-presentation.mjs should export a presentChapterArtifact function"
  );
});

test("Task 12：app.js 把未消费 ESC 交给 AgentSurface（统一 ESC 路由）", () => {
  assert.match(appSource, /function\s+closeAppTopLayer\s*\(/, "app.js 应提供 closeAppTopLayer()");
  assert.match(appSource, /agentSurface\.handleEscape\s*\(/, "app.js 应把未消费 ESC 交给 surface.handleEscape");
  assert.match(appSource, /event\.defaultPrevented/, "内层已消费的 ESC 不得再进入全局路由");
  assert.match(
    appSource,
    /if\s*\(\s*closeAppTopLayer\(\)\s*\)\s*\{\s*event\.preventDefault\(\);\s*return;\s*\}/,
    "app 顶层 ESC 关闭保持原有优先级"
  );
});

test("Task 12：slash-commands 提供 /compact 补全（识别仍由 runtime 严格 === 完成）", () => {
  assert.match(slashCommandsSource, /command:\s*"\/compact"/u, "/compact 应在补全列表");
  assert.match(slashCommandsSource, /压缩当前上下文/u, "/compact 带中文标签");
  assert.doesNotMatch(slashCommandsSource, /startsWith\(\s*["']\/compact/u, "前端不得用 startsWith(/compact) 决定压缩");
});

test("Task 12：生产 bundle 文本不含 Worked for / નિર્ણ（运行态文案全中文）", async () => {
  // app-shell 以原生 ES 模块发布（无打包器），「bundle 文本」= src/app-shell
  // 全部源码拼接；断言用户可见运行态文案不存在英文残留与 Gujarati 乱码。
  const root = path.join(here, "..", "..", "src", "app-shell");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:js|mjs|html|css)$/u.test(entry.name)) files.push(full);
    }
  };
  await walk(root);
  assert.ok(files.length > 0, "应收集到 app-shell 源码文件");
  const bundle = (await Promise.all(files.map((f) => fs.readFile(f, "utf8")))).join("\n");
  assert.doesNotMatch(bundle, /Worked for/u, "bundle 不得包含英文耗时文案 Worked for");
  assert.doesNotMatch(bundle, /નિર્ણ/u, "bundle 不得包含 Gujarati 乱码 નિર્ણ");
  assert.doesNotMatch(
    bundle,
    /String\(\s*(?:run\.status|entry\.state)\s*\)/u,
    "状态文本不得回退为英文 status code（必须来自单一中文 map）"
  );
});

test("第十一轮 A：app.js 接线 onDashboardRefresh -> loadDashboard（composer 保存后同屏一致）", () => {
  assert.match(
    appSource,
    /onDashboardRefresh:\s*\(\)\s*=>\s*\{\s*void loadDashboard\(\{ background: true \}\);/u,
    "createAgentSurface 必须把 onDashboardRefresh 接到后台 loadDashboard"
  );
});
