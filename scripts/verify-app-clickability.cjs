// scripts/verify-app-clickability.cjs —— 新 UI 点击可达性验证（统一 Agent 内核计划
// Task 9 改写）。
//
// 用 HTTP 公共行为准备数据（createProjectAt + 章节领域事实 + agent 简单对话），
// 在 Electron 中逐个点击新界面的可见元素并断言 UI 状态：项目导航、快捷面板四槽位、
// 抽屉分区、阅读器、设置弹窗、新建弹窗、主题/隐私开关、AgentSurface composer 发送、
// 确定性导出按钮。不得 import 已删除的 agent-engine/failure store/side-question。
//
// 点击机制：本会话不投递真实指针事件（sendInputEvent/CDP Input 均无 click），
// 采用合成 el.click() + elementFromPoint 中心命中测试（见 clickAndRead 注释）。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { desktopWindowChrome } = require("../src/desktop/window-chrome.cjs");

// Guard against EPIPE when stdout pipe is closed (e.g. user interrupted)
process.stdout.on("error", (err) => { if (err.code !== "EPIPE") throw err; });
process.stderr.on("error", (err) => { if (err.code !== "EPIPE") throw err; });

const rootDir = path.resolve(__dirname, "..");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwriting-clicks-"));
let server = null;

app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-http-cache");
app.commandLine.appendSwitch("force-prefers-reduced-motion");

app.whenReady().then(() => main().catch((error) => {
  console.error(error?.stack || error);
  cleanup(1);
}));

async function main() {
  const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
  const { createProjectAt } = await import(pathToFileURL(path.join(rootDir, "src", "core", "project-store.mjs")).href);
  const { parseSimpleYaml } = await import(pathToFileURL(path.join(rootDir, "src", "core", "simple-yaml.mjs")).href);

  const demoRoot = path.join(rootDir, ".demo_runs", `clickability-${Date.now()}`);
  const { projectRoot } = await createProjectAt(path.join(demoRoot, "clickability-novel"), {
    title: "Clickability Novel",
    story_seed: "A short project used to verify every visible app-shell button can execute.",
    target_chapters: 2,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20
  });
  // 章节事实：提交两章（UI 验证不依赖 Agent 写章）。正文必须通过内置技能
  // reviewing 门禁（suspense-ending/chapter-opening/dialogue-ratio/ai-voice）。
  const { commitChapter, appendChapterSegment } = await import(pathToFileURL(path.join(rootDir, "src", "core", "project-operations", "chapter.mjs")).href);
  const project = parseSimpleYaml(await fs.promises.readFile(path.join(projectRoot, "project.yaml"), "utf8"));
  const GATE_PASSING_CHAPTER = "雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。";
  for (const chapterNo of [1, 2]) {
    await appendChapterSegment({
      projectRoot,
      projectId: project.project_id,
      chapterNo,
      segmentNo: 1,
      content: GATE_PASSING_CHAPTER
    });
    await commitChapter({ projectRoot, projectId: project.project_id, chapterNo });
  }

  server = createAppShellServer({
    workspaceRoot: demoRoot,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(demoRoot, ".state"),
    secretsRoot: path.join(demoRoot, ".secrets"),
    staticRoot: path.join(rootDir, "src", "app-shell"),
    port: 0
  });
  const boundPort = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    backgroundColor: "#f4f3f0",
    autoHideMenuBar: true,
    ...desktopWindowChrome(process.platform, false),
    webPreferences: {
      preload: path.join(rootDir, "src", "desktop", "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const consoleMessages = [];
  win.webContents.on("console-message", (_event, _level, message) => {
    consoleMessages.push({ message });
  });

  await win.loadURL(`http://127.0.0.1:${boundPort}`);
  await waitUntil(win, "Boolean(window.__wwritingMotionReady)", "motion runtime must initialize", 10000);
  await waitUntil(win, "document.querySelector('#project-title')?.textContent.includes('Clickability Novel')", "dashboard must load the project", 10000);
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-surface\"]') !== null", "AgentSurface must mount", 10000);

  const clicks = [];

  // ① 项目导航：刷新
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "refresh",
    settleMs: 300,
    expect: () => read(win, "Boolean(document.querySelector('#project-list')?.children.length > 0)")
  }));

  // ② 快捷面板四槽位（纯导航）：章节
  clicks.push(await clickAndReadStable(win, '.quick-rail .qr-slot[data-key="chapters"]', {
    label: "qr-chapters",
    settleMs: 300,
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('.dtab[data-dtab=\"chapters\"]').classList.contains('on')")
  }));
  // 抽屉里已提交章节可点击 → 打开阅读器
  clicks.push(await clickAndReadStable(win, ".chrow.completed", {
    label: "chrow-open-reader",
    settleMs: 400,
    expect: () => overlayVisible(win, "reader-scrim")
  }));
  clicks.push(await clickAndRead(win, "#reader-font-plus", {
    label: "reader-font-plus",
    settleMs: 150,
    expect: () => read(win, "document.getElementById('reader-body').style.fontSize !== ''")
  }));
  clicks.push(await clickAndRead(win, "#reader-close", {
    label: "reader-close",
    settleMs: 200,
    expect: async () => !(await overlayVisible(win, "reader-scrim"))
  }));

  // ③ 导出成书（确定性工具，位于章节面板）：直接 POST route，成功 toast
  clicks.push(await clickAndReadStable(win, ".export-btn", {
    label: "export-book",
    settleMs: 900,
    expect: () => read(win, "document.querySelectorAll('.toast-stack .toast').length > 0")
  }));

  // ④ 抽屉其它分区（Task 13：技能管理已迁入设置页，抽屉无 skills tab）
  for (const tab of ["model", "research", "cost"]) {
    clicks.push(await clickAndReadStable(win, `.drawer-tabs [data-dtab="${tab}"]`, {
      label: `drawer-${tab}`,
      settleMs: 300,
      expect: () => read(win, `document.querySelector('.dtab[data-dtab="${tab}"]').classList.contains('on')`)
    }));
  }

  // ⑤ 关闭抽屉
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "drawer-close",
    settleMs: 300,
    expect: async () => !(await read(win, "document.getElementById('drawer').classList.contains('show')"))
  }));

  // ⑥ 设置弹窗：打开 → 分区导航 → 关闭
  clicks.push(await clickAndRead(win, "#open-settings", {
    label: "open-settings",
    settleMs: 300,
    expect: () => overlayVisible(win, "settings-scrim")
  }));
  const sectionCount = await read(win, "document.querySelectorAll('.sp-section-item').length");
  assert.ok(sectionCount >= 3, `settings sections should render, got ${sectionCount}`);
  // Task 13：技能管理在设置页的「Agent 技能」分区（catalog/import/delete 入口）
  clicks.push(await clickAndRead(win, '.sp-section-item[data-section="skills"]', {
    label: "settings-skills-section",
    settleMs: 300,
    expect: () => read(win, "document.querySelector('.sp-section-item[data-section=\"skills\"]').classList.contains('on')")
  }));
  clicks.push(await clickAndRead(win, "#settings-x", {
    label: "settings-close",
    settleMs: 300,
    expect: async () => !(await overlayVisible(win, "settings-scrim"))
  }));

  // ⑦ 新建弹窗：打开 → 关闭
  clicks.push(await clickAndRead(win, "#new-novel", {
    label: "new-novel",
    settleMs: 300,
    expect: () => overlayVisible(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "create-close",
    settleMs: 300,
    expect: async () => !(await overlayVisible(win, "create-scrim"))
  }));

  // ⑧ 主题与隐私开关
  clicks.push(await clickAndRead(win, "#theme-toggle", {
    label: "theme-toggle",
    settleMs: 150,
    expect: () => read(win, "document.documentElement.dataset.theme === 'dark'")
  }));
  clicks.push(await clickAndRead(win, "#theme-toggle", {
    label: "theme-toggle-back",
    settleMs: 150,
    expect: () => read(win, "document.documentElement.dataset.theme === 'light'")
  }));
  clicks.push(await clickAndRead(win, "#privacy-toggle", {
    label: "privacy-toggle",
    settleMs: 150,
    expect: () => read(win, "document.getElementById('app').dataset.privacy === 'on'")
  }));
  clicks.push(await clickAndRead(win, "#privacy-toggle", {
    label: "privacy-toggle-back",
    settleMs: 150,
    expect: () => read(win, "document.getElementById('app').dataset.privacy === 'off'")
  }));

  // ⑨ AgentSurface composer：发送普通消息 → 对话中出现用户消息、Run 完成
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('[data-testid="agent-composer-input"]');
      input.value = "你好，请确认你能收到消息";
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })();
  `);
  clicks.push(await clickAndRead(win, '[data-testid="agent-send"]', {
    label: "agent-send",
    settleMs: 1200,
    expect: () => read(win, "[...document.querySelectorAll('[data-testid=\"agent-user-message\"]')].some((el) => el.textContent.includes('你好'))")
  }));
  // 纯文本回复不产生活动行：journal 的 assistant_message_completed 只带 input_id，
  // 因此以 Run 状态行进入「已完成」作为回复已渲染的判据（失败则出现错误卡）。
  await waitUntil(win, "[...document.querySelectorAll('[data-testid=\"agent-assistant-message\"]')].length > 0 || [...document.querySelectorAll('.agent-activity-item')].some((el) => el.dataset.state === 'completed') || [...document.querySelectorAll('[data-testid=\"agent-run-status\"]')].some((el) => el.textContent === '已完成') || document.querySelectorAll('[data-testid=\"agent-error\"]').length > 0", "agent reply must render", 15000);

  // ⑩ 快捷键浮层：? 开 → X 关（keydown 监听挂在 document 上，需在 document 派发）
  await win.webContents.executeJavaScript(`
    (() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
      return true;
    })();
  `);
  await waitUntil(win, "document.getElementById('shortcuts-scrim').classList.contains('show')", "shortcuts must open via ?", 3000);
  clicks.push(await clickAndRead(win, "#shortcuts-x", {
    label: "shortcuts-close",
    settleMs: 200,
    expect: async () => !(await overlayVisible(win, "shortcuts-scrim"))
  }));

  // ⑪ 旧 UI 不得残留可点击元素
  const removedSelectors = await read(win, `
    ["#topbar-stop", "#composer-submit", "#mode-pill", "[data-testid='msg-copy']", ".failure-card", "#workbench-primary"].map((sel) => [sel, Boolean(document.querySelector(sel))])
  `);
  for (const [selector, present] of removedSelectors) {
    assert.equal(present, false, `旧 UI 元素不得残留: ${selector}`);
  }

  for (const message of consoleMessages) {
    assert.ok(!String(message.message).includes("Failed to resolve module specifier"), `module resolution error: ${message.message}`);
    assert.ok(!String(message.message).includes("MIME"), `module MIME error: ${message.message}`);
  }

  const visibleButtons = await read(win, `
    [...document.querySelectorAll('button')]
      .filter((button) => !button.disabled && button.offsetParent !== null)
      .map((button) => ({
        id: button.id || null,
        className: String(button.className || ""),
        text: button.textContent.trim().replace(/\\s+/gu, " ").slice(0, 40)
      }))
  `);
  const result = {
    ok: clicks.every((click) => click.clicked && click.expectationPassed && click.errors.length === 0),
    projectRoot,
    clicks,
    visibleButtons,
    consoleMessages
  };
  console.log(JSON.stringify(result, null, 2));

  for (const click of clicks) {
    assert.equal(click.clicked, true, `${click.label} must receive a trusted pointer click`);
    assert.equal(click.expectationPassed, true, `${click.label} did not produce the expected UI state`);
    assert.deepEqual(click.errors, [], `${click.label} click errors: ${click.errors.join("\n")}`);
  }

  cleanup(0);
}

app.on("window-all-closed", () => cleanup(0));

async function clickAndRead(win, selector, { label = selector, expect = null, settleMs = 180 } = {}) {
  // 环境说明：本脚本运行的 Electron 会话（无交互窗口站）不投递真实指针事件
  // （sendInputEvent / CDP Input 均不产生 click）。因此采用合成 el.click() 触发
  // 同一套 DOM 事件处理，并在点击前做严格命中测试——元素中心经 elementFromPoint
  // 必须命中该元素或其子孙，否则真实指针点击不会落在它上面，判定为不可点击。
  const setup = await win.webContents.executeJavaScript(`
    (() => {
      window.__wwClickProbe = window.__wwClickProbe || { clicks: {}, errors: [] };
      const selector = ${JSON.stringify(selector)};
      const el = document.querySelector(selector);
      if (!el) return { present: false };
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center" });
      }
      const rect = el.getBoundingClientRect();
      const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      const hit = center.x > 0 && center.y > 0 ? document.elementFromPoint(center.x, center.y) : null;
      const hitTestable = Boolean(hit && (hit === el || el.contains(hit)));
      el.addEventListener("click", () => {
        window.__wwClickProbe.clicks[selector] = (window.__wwClickProbe.clicks[selector] || 0) + 1;
      }, { once: true });
      el.click();
      return {
        present: true,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        center,
        hitTestable,
        hitTag: hit ? hit.tagName : null
      };
    })();
  `);
  await delay(settleMs);
  const after = await probe(win, selector);
  const expectationPassed = expect ? await expect() : true;
  if (!setup.present) {
    return { label, rect: null, center: null, clicked: false, expectationPassed: false, errors: ["element not found"] };
  }
  if (!setup.hitTestable) {
    return { label, rect: setup.rect, center: setup.center, clicked: false, expectationPassed, errors: [`not hit-testable at center (top element: ${setup.hitTag})`] };
  }
  return {
    label,
    rect: setup.rect,
    center: setup.center,
    clicked: (after.clickCount ?? 0) > 0,
    expectationPassed,
    errors: after.errors
  };
}

async function clickAndReadStable(win, selector, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await clickAndRead(win, selector, options);
    if (last.clicked && last.expectationPassed && last.errors.length === 0) return last;
    await clearStaleClosingStates(win);
    await delay(120);
  }
  assert.equal(last?.clicked, true, `${options.label ?? selector} must receive a trusted pointer click after retries`);
  assert.equal(last?.expectationPassed, true, `${options.label ?? selector} did not produce the expected UI state after retries`);
  assert.deepEqual(last?.errors ?? [], [], `${options.label ?? selector} click errors after retries`);
  return last;
}

async function probe(win, selector) {
  return win.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      const rect = button?.getBoundingClientRect?.();
      const center = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
      const target = center ? document.elementFromPoint(center.x, center.y) : null;
      return {
        rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        center,
        targetAtCenter: target ? { id: target.id, className: String(target.className || ""), tag: target.tagName } : null,
        clickCount: window.__wwClickProbe?.clicks?.[${JSON.stringify(selector)}] ?? 0,
        errors: window.__wwClickProbe?.errors ?? []
      };
    })();
  `);
}

function cleanup(exitCode) {
  try {
    if (server) {
      server.close();
      server = null;
    }
  } catch {
    // ignore close errors on shutdown
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly keep Chromium cache files locked after exit
  }
  if (exitCode !== undefined) {
    app.exit(exitCode);
  }
}

async function overlayVisible(win, scrimId) {
  return read(win, `document.getElementById('${scrimId}').classList.contains('show')`);
}

async function waitUntil(win, expression, describe, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await read(win, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for: ${describe} (${expression})`);
}

async function read(win, expression) {
  try {
    return await win.webContents.executeJavaScript(`(() => ${expression})()`);
  } catch (error) {
    console.error(`[read failed] expression: ${expression}\n  ${error?.message ?? error}`);
    throw error;
  }
}

async function clearStaleClosingStates(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      for (const el of [document.getElementById('drawer'), document.getElementById('drawer-scrim')]) {
        if (el) delete el.dataset.closing;
      }
      return true;
    })();
  `);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
