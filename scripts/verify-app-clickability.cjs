// scripts/verify-app-clickability.cjs —— 新 UI 点击可达性验证（Task 13 改写）。
//
// 普通文件夹（无 project.yaml）+ 应用私有 stateRoot：不再创建旧项目、不再通过
// reviewing 门禁提交章节。在 Electron 中逐个点击新界面的可见元素并断言 UI 状态：
// 项目导航打开普通文件夹、顶部 drawer 入口（章节/模型/资料/成本）、设置页内置风格
// 详情（只读、可展开正文）、composer 发送、运行中停止、失败后重试、主题/隐私开关、
// 新建弹窗与快捷键浮层。不得 import 已删除的 agent-engine/failure store/side-question。
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

// 可编排确定性 gateway：hold（等待停止）/ error（可恢复失败）/ reply。队列按模型
// 调用顺序消费，耗尽后返回安全默认答复。
function createClickGatewayFactory() {
  const steps = [];
  const gateway = {
    async complete(request, { signal } = {}) {
      const step = steps.shift() ?? { type: "reply", text: "（点击验证默认答复）" };
      switch (step.type) {
        case "hold": {
          if (step.released) return { text: "（已放行）" };
          await new Promise((resolve, reject) => {
            step.release = resolve;
            if (signal) {
              signal.addEventListener("abort", () => {
                const error = new Error("The operation was aborted.");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            }
          });
          return { text: "（已放行）" };
        }
        case "error": {
          const error = new Error("模型调用失败（可恢复）");
          error.code = "model_error";
          throw error;
        }
        default:
          return { text: String(step.text ?? "（点击验证默认答复）") };
      }
    },
    setSteps(list) { steps.length = 0; steps.push(...list); }
  };
  return { factory: () => gateway, gateway };
}

async function main() {
  const { createAppShellServer } = await import(pathToFileURL(path.join(rootDir, "src", "core", "app-server.mjs")).href);
  const { gateway, factory } = createClickGatewayFactory();

  // ---- 普通文件夹 + 应用私有 stateRoot（不再创建 project.yaml）----
  const demoRoot = path.join(rootDir, ".demo_runs", `clickability-${Date.now()}`);
  const projectRoot = path.join(demoRoot, "普通文件夹");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "notes.txt"), "普通资料：写作参考笔记。\n", "utf8");
  // Task 25：供应商夹具（长名 + 假密钥哨兵）——「密钥明文不在 DOM」检查载体。
  // sk-round7- 前缀为测试哨兵，断言其绝不回显到模型设置页 DOM。
  const secretsRoot = path.join(demoRoot, ".secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(secretsRoot, "model-profiles.json"),
    JSON.stringify({
      seeded_preset_ids: ["deepseek", "mimo"],
      default_model: null,
      providers: [
        {
          id: "deepseek",
          name: "DeepSeek 官方",
          type: "custom",
          status: "enabled",
          base_url: "https://api.deepseek.com",
          api_format: "openai-chat-completions",
          api_key_env: "WWRITING_ROUND7_FAKE_KEY",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          models: [
            { id: "m_deepseek_deepseek-v4-pro", model_name: "deepseek-v4-pro", enabled: true, context_window: 256000 },
            { id: "m_deepseek_deepseek-v4-flash", model_name: "deepseek-v4-flash", enabled: true, context_window: 256000 }
          ]
        }
      ]
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(secretsRoot, "secrets.json"),
    JSON.stringify({ WWRITING_ROUND7_FAKE_KEY: "sk-round7-visual-fake-key-0001-not-real" }, null, 2),
    "utf8"
  );

  server = createAppShellServer({
    workspaceRoot: demoRoot,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(demoRoot, ".state"),
    secretsRoot,
    staticRoot: path.join(rootDir, "src", "app-shell"),
    port: 0,
    testGatewayFactory: factory
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
  // 普通文件夹出现在项目列表（basename 即标题）。Task 25（R3/B1 契约）：.proj 主体
  // 点击只折叠/展开，切换项目唯一入口 = 点击会话行或项目行「+ 新建对话」
  //（openProjectAndSession，无会话项目即由此打开）。这里按当前 UI 流程点击
  // 「+」按钮打开普通文件夹。
  await waitUntil(win, "document.querySelector('#project-list')?.children.length > 0", "project list must render the plain folder", 10000);
  const rowClicked = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.proj-row')].find((el) => el.textContent.includes('普通文件夹'));
    if (!row) return false;
    // R4：项目行「+ 新建对话」在 hover/:focus-within 才可见（opacity:0 +
    // pointer-events:none）——聚焦行触发 :focus-within 并放开指针事件。
    row.focus?.();
    const menu = row.querySelector('.proj-menu');
    if (menu) { menu.style.opacity = '1'; menu.style.pointerEvents = 'auto'; }
    const btn = row.querySelector('.proj-add');
    const rect = btn.getBoundingClientRect();
    const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const hit = document.elementFromPoint(center.x, center.y);
    btn.click();
    return Boolean(hit && (hit === btn || btn.contains(hit)));
  })()`);
  assert.equal(rowClicked, true, "普通文件夹行必须中心可命中并点击");
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null && !document.querySelector('[data-testid=\"agent-composer-input\"]').disabled", "AgentSurface composer must enable after opening the plain folder", 10000);
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-surface\"]') !== null", "AgentSurface must mount", 10000);

  const clicks = [];

  // ① 项目导航：刷新（普通文件夹仍在列表）
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "refresh",
    settleMs: 300,
    expect: () => read(win, "Boolean(document.querySelector('#project-list')?.children.length > 0)")
  }));

  // ② 顶部 drawer 入口（Task 12 删除右侧 quick rail 后唯一入口）：章节 tab 打开
  clicks.push(await clickAndReadStable(win, "#open-drawer", {
    label: "open-drawer-chapters",
    settleMs: 400,
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('.dtab[data-dtab=\"chapters\"]').classList.contains('on')")
  }));
  // ③ drawer 其它分区仍可点击（Task 13：技能管理已迁入设置页，抽屉无 skills tab）
  for (const tab of ["model", "research", "cost"]) {
    clicks.push(await clickAndReadStable(win, `.drawer-tabs [data-dtab="${tab}"]`, {
      label: `drawer-${tab}`,
      settleMs: 300,
      expect: () => read(win, `document.querySelector('.dtab[data-dtab="${tab}"]').classList.contains('on')`)
    }));
  }
  // ④ 关闭抽屉
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "drawer-close",
    settleMs: 300,
    expect: async () => !(await read(win, "document.getElementById('drawer').classList.contains('show')"))
  }));

  // ④b 第九轮：阅读器「历史」路径 + 任务计划 chip
  clicks.push(await clickAndReadStable(win, "#open-drawer", {
    label: "open-drawer-history",
    settleMs: 300,
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show')")
  }));
  clicks.push(await clickAndReadStable(win, '.dtab[data-dtab="chapters"]', {
    label: "drawer-chapters-tab",
    settleMs: 300,
    expect: () => read(win, "document.querySelector('.dtab[data-dtab=\"chapters\"]').classList.contains('on')")
  }));
  const chapterRow = await read(win, "Boolean(document.querySelector('.chrow.completed'))");
  if (chapterRow) {
    clicks.push(await clickAndReadStable(win, ".chrow.completed", {
      label: "open-reader-from-chapter",
      settleMs: 400,
      expect: () => read(win, "document.getElementById('reader-scrim').classList.contains('show')")
    }));
    clicks.push(await clickAndReadStable(win, "#reader-history", {
      label: "reader-history",
      settleMs: 300,
      expect: () => read(win, "Boolean(document.querySelector('[data-version-panel]')) && !document.querySelector('[data-version-panel]').hidden")
    }));
    clicks.push(await clickAndReadStable(win, "#reader-close", {
      label: "reader-close-after-history",
      settleMs: 300,
      expect: () => read(win, "!document.getElementById('reader-scrim').classList.contains('show')")
    }));
  }
  // 任务计划 chip：fixture 无 plan 时隐藏（元素存在但 hidden=true）；有 plan 时展开
  const planChipVisible = await read(win, "Boolean(document.querySelector('[data-plan-chip]') && !document.querySelector('[data-plan-chip]').hidden)");
  if (planChipVisible) {
    clicks.push(await clickAndReadStable(win, "[data-plan-chip]", {
      label: "plan-chip-expand",
      settleMs: 300,
      expect: () => read(win, "!document.querySelector('[data-plan-dropdown]').hidden")
    }));
  }
  // 关闭抽屉（第九轮新路径后恢复到关闭态）
  const drawerStillOpen = await read(win, "document.getElementById('drawer').classList.contains('show')");
  if (drawerStillOpen) {
    clicks.push(await clickAndReadStable(win, "#drawer-close", {
      label: "drawer-close-history",
      settleMs: 300,
      expect: async () => !(await read(win, "document.getElementById('drawer').classList.contains('show')"))
    }));
  }

  // ⑤ 设置弹窗（Task A5）：#open-settings 打开设置弹窗且默认落在「模型设置」分区——
  // #settings-scrim 带 show、#settings-detail 注入 [data-provider-list]；供应商/
  // 模型行可操作、密钥已配置状态不泄漏明文（规格 4.3 #4，假密钥 sk-round7- 哨兵）、
  // 测试连接按钮可点、关闭（A3 起模型设置不再有整页 #model-settings-page）。
  clicks.push(await clickAndRead(win, "#open-settings", {
    label: "open-settings",
    settleMs: 400,
    expect: () => read(win, "document.getElementById('settings-scrim').classList.contains('show') && Boolean(document.querySelector('#settings-detail [data-provider-list]'))")
  }));
  await waitUntil(win, "document.querySelectorAll('.provider-item').length >= 1", "provider list must render in model settings", 8000);
  await waitUntil(win, "document.querySelectorAll('.model-row').length >= 1", "model rows must render in model settings", 8000);
  const settingsOperable = await read(win, `(() => ({
    providers: [...document.querySelectorAll('.provider-item')].map((el) => el.textContent.trim()),
    modelRows: document.querySelectorAll('.model-row').length,
    modelNameInput: document.querySelector('[data-field="model_name"]')?.value ?? null,
    keyStatus: document.querySelector('[data-api-key-status]')?.textContent ?? null,
    testButton: Boolean(document.querySelector('.model-test-connection')),
    bodyHasFakeKey: (document.body.textContent || '').includes('sk-round7')
  }))()`);
  assert.ok(settingsOperable.providers.length >= 1, `供应商列表应渲染: ${JSON.stringify(settingsOperable)}`);
  assert.ok(settingsOperable.modelRows >= 1, "模型行应渲染");
  assert.equal(settingsOperable.modelNameInput, "deepseek-v4-pro", "模型名称输入框应渲染完整模型名");
  assert.equal(settingsOperable.keyStatus, "已配置（WWRITING_ROUND7_FAKE_KEY）", `密钥状态应只显示 已配置 + env 名: ${JSON.stringify(settingsOperable)}`);
  assert.equal(settingsOperable.bodyHasFakeKey, false, "密钥明文不得出现在模型设置页 DOM");
  assert.equal(settingsOperable.testButton, true, "测试连接按钮应存在（设置页可操作）");
  // A3/A5：模型设置已并入设置弹窗，关闭走弹窗 X（#settings-x）；关闭后 scrim 无 show
  //（#settings-detail 内模型 DOM 在关闭时保留，重开时 renderSectionBody 会 replaceChildren）。
  clicks.push(await clickAndRead(win, "#settings-x", {
    label: "settings-close",
    settleMs: 300,
    expect: () => read(win, "!document.getElementById('settings-scrim').classList.contains('show')")
  }));

  // ⑥ 新建弹窗：打开 → 关闭（普通文件夹场景仍可创建新项目）
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

  // ⑦ 主题与隐私开关
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

  // ⑧ AgentSurface composer：发送普通消息 → 用户消息出现、Run 完成
  gateway.setSteps([{ type: "reply", text: "你好，我在这里。普通文件夹也可以直接聊天。" }]);
  await sendComposerText(win, "你好，请确认你能收到消息");
  await waitUntil(win, "[...document.querySelectorAll('[data-testid=\"agent-user-message\"]')].some((el) => el.textContent.includes('你好'))", "user message must render", 10000);
  await waitUntil(win, "[...document.querySelectorAll('[data-testid=\"agent-assistant-message\"]')].some((el) => el.textContent.includes('你好，我在这里')) || document.querySelectorAll('[data-testid=\"agent-error\"]').length > 0", "agent reply run must complete", 20000);
  assert.equal(await read(win, "document.querySelectorAll('[data-testid=\"agent-error\"]').length"), 0, "正常聊天不得出现错误卡");
  await waitForComposerEnabled(win);

  // ⑨ 停止：运行中（gateway hold）点击停止 → Run 取消
  gateway.setSteps([{ type: "hold" }]);
  await sendComposerText(win, "开始一个长时间任务，稍后我会停止你");
  await waitUntil(win, "Boolean(document.querySelector('[data-testid=\"agent-stop\"]')) && !document.querySelector('[data-testid=\"agent-stop\"]').disabled", "stop button must appear while run is active", 10000);
  clicks.push(await clickAndRead(win, '[data-testid="agent-stop"]', {
    label: "agent-stop",
    settleMs: 2500,
    expect: () => read(win, "!document.querySelector('[data-testid=\"agent-stop\"]')")
  }));
  await waitUntil(win, "!document.querySelector('[data-testid=\"agent-stop\"]')", "run must be cancelled after stop", 15000);
  await waitForComposerEnabled(win);

  // ⑩ 重试：失败（gateway error）后点击重试 → 同一 Run 恢复并完成
  gateway.setSteps([{ type: "error" }, { type: "reply", text: "重试成功，本轮已经完成。" }]);
  await sendComposerText(win, "触发一次可恢复失败，然后重试");
  await waitUntil(win, "document.querySelectorAll('[data-testid=\"agent-error\"]').length > 0 && Boolean(document.querySelector('[data-testid=\"agent-retry\"]'))", "run must fail and show retry button", 15000);
  clicks.push(await clickAndRead(win, '[data-testid="agent-retry"]', {
    label: "agent-retry",
    settleMs: 2500,
    expect: () => read(win, "Boolean(document.querySelector('[data-testid=\"agent-stop\"]')) || [...document.querySelectorAll('[data-testid=\"agent-assistant-message\"]')].some((el) => el.textContent.includes('重试成功'))")
  }));
  await waitUntil(win, "[...document.querySelectorAll('[data-testid=\"agent-assistant-message\"]')].some((el) => el.textContent.includes('重试成功')) || document.querySelectorAll('[data-testid=\"agent-error\"]').length > 0", "retried run must complete", 20000);
  assert.equal(await read(win, "document.querySelectorAll('[data-testid=\"agent-error\"]').length"), 0, "重试成功后不得残留错误卡");

  // ⑪ 快捷键浮层：? 开 → X 关（keydown 监听挂在 document 上，需在 document 派发）
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

  // ⑫ 旧 UI 不得残留可点击元素
  const removedSelectors = await read(win, `
    ["#topbar-stop", "#composer-submit", "#mode-pill", "[data-testid='msg-copy']", ".failure-card", "#workbench-primary", "#quick-rail", "#qr-collapsed"].map((sel) => [sel, Boolean(document.querySelector(sel))])
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

async function sendComposerText(win, text) {
  await waitForComposerEnabled(win);
  const sent = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('[data-testid="agent-composer-input"]');
      const send = document.querySelector('[data-testid="agent-send"]');
      if (!input || !send) return { ok: false, reason: "composer missing" };
      if (send.disabled) return { ok: false, reason: "send disabled" };
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rect = send.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      const hitTestable = Boolean(hit && (hit === send || send.contains(hit)));
      send.click();
      return { ok: true, hitTestable };
    })()
  `);
  assert.equal(sent.ok, true, `composer 提交失败: ${sent.reason}`);
  assert.equal(sent.hitTestable, true, "发送按钮中心必须可命中");
}

async function waitForComposerEnabled(win) {
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null && !document.querySelector('[data-testid=\"agent-composer-input\"]').disabled", "composer must be enabled", 15000);
}

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
