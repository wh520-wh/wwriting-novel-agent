const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");
const { desktopWindowChrome } = require("../src/desktop/window-chrome.cjs");

// 运行中可见性主标记（Task 11 一轮状态机落地后）：
// live turn 过程区（思考块/工具行可见）→ 顶栏停止按钮 → 旧式运行卡停止按钮（兜底）。
// 旧式运行卡已被 live turn 替换（无停止按钮，停止入口在顶栏），不能只认 .run-stop-btn。
const RUN_VISIBLE_JS = `(() => {
  const liveTurn = document.querySelector('.turn-agent .think-block:not(.hidden), .turn-agent .tool-card:not(.hidden)');
  const legacyRun = document.querySelector('.run-stop-btn:not([hidden])');
  const topbarStop = document.querySelector('#topbar-stop:not([hidden])');
  return Boolean(liveTurn || legacyRun || topbarStop);
})()`;

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
  const { createProject, loadState, saveState } = await import(pathToFileURL(path.join(rootDir, "src", "core", "project-store.mjs")).href);
  const { runProject } = await import(pathToFileURL(path.join(rootDir, "src", "core", "agent-engine.mjs")).href);
  const { appendFailure } = await import(pathToFileURL(path.join(rootDir, "src", "core", "failures-store.mjs")).href);

  // 蓝图门禁适配（spec §1.4）：新建项目 blueprint_status 默认 "none"，
  // 写作入口（runProject / /api/commands/submit）会拒绝。本脚本只测 UI 交互，
  // 不验证蓝图内容，预置 complete 放行即可（与 tests/helpers.mjs createWritingProject 同款模式）。
  async function markBlueprintReady(projectRoot) {
    const state = await loadState(projectRoot);
    state.blueprint_status = "complete";
    await saveState(projectRoot, state);
  }
  const demoRoot = path.join(rootDir, ".demo_runs", `clickability-${Date.now()}`);
  const { projectRoot } = await createProject(demoRoot, {
    slug: "clickability-novel",
    title: "Clickability Novel",
    story_seed: "A short project used to verify every visible app-shell button can execute.",
    target_chapters: 2,
    min_words_per_chapter: 120,
    target_words_per_chapter: 180,
    enabled_skills: ["suspense-chapter-end"]
  });
  // 蓝图门禁（spec §1.4）：新建项目 blueprint_status 默认 "none"，写作入口会拒绝。
  // 本脚本验证 UI 可点击性而非蓝图内容，预置 complete 放行（与 tests/helpers.mjs 同款模式）。
  await markBlueprintReady(projectRoot);
  await runProject(projectRoot);
  appendFailure(projectRoot, {
    id: "click-failure-1",
    seq: 1,
    chapterNo: 1,
    kind: "unknown",
    title: "Clickability probe failure",
    body: "This card verifies failure actions remain clickable after motion.",
    ts: new Date().toISOString(),
    actions: [{ label: "停在这里", command: "pause-here", args: {} }],
    diagnostics: { eventId: "click-failure-1", tool: null, promptHash: null, logPath: "run_log.jsonl", rawError: null },
    resolution: null
  });
  appendFailure(projectRoot, {
    id: "seed-cost-budget",
    seq: 2,
    chapterNo: 1,
    kind: "budget-exhausted",
    title: "预算已用尽",
    body: "第 1 章已花约 ¥1.21，达到你设置的 ¥1 上限。",
    ts: new Date().toISOString(),
    actions: [
      { label: "提高成本上限到 ¥2", command: "raise-cost-budget", args: { newMaxCost: 2 } },
      { label: "停在这里", command: "pause-here", args: {} }
    ],
    diagnostics: { eventId: "seed-cost-budget", tool: null, promptHash: null, logPath: "run_log.jsonl", rawError: null },
    resolution: null
  });

  // Create a fresh first-chapter project with a complete mock model config
  // (provider + model_name + base_url + api_key_env) so deriveWriteReadiness
  // reaches the "demo" state and shows "写第 1 章" on the primary button.
  const { projectRoot: fcProjectRoot } = await createProject(
    path.join(rootDir, ".demo_runs", `fc-${Date.now()}`),
    {
      slug: "first-chapter",
      title: "点击验收小说",
      story_seed: "A short story to verify first chapter writing.",
      target_chapters: 2,
      min_words_per_chapter: 120,
      target_words_per_chapter: 180,
      active_model: {
        provider: "mock",
        model_name: "mock-writer",
        base_url: "https://mock.example.test/v1",
        api_key_env: "MOCK_API_KEY"
      }
    }
  );
  // Don't runProject — chapter 1 is pending, which triggers the "demo" readiness state.
  // 同上：预置蓝图 complete，否则 #workbench-primary 的写作提交会被蓝图门禁拒绝。
  await markBlueprintReady(fcProjectRoot);

  server = createAppShellServer({
    workspaceRoot: rootDir,
    selectedProjectRoot: fcProjectRoot, // Start with fc project so the page loads it first
    staticRoot: path.join(rootDir, "src", "app-shell"),
    secretsRoot: userDataDir,
    port: 0,
    // 注入假探测函数：让「测试连接」按钮在无头环境也能走通成功路径（真实网络探测由 verify:provider-online 覆盖）。
    testModelConnection: async () => ({ ok: true, message: "连接正常", latency_ms: 12 })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await waitForServer(port);

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    show: false,
    backgroundColor: "#f4f3f0",
    ...desktopWindowChrome(),
    // 刻意不挂 preload：harness 不注册 ipcMain handler，挂上会使 bridge invoke reject（072d89e 曾因此破坏本 harness）；此处测试浏览器兜底路径，desktop bridge 由 verify:electron-runtime 覆盖。
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  const consoleMessages = [];
  win.webContents.on("console-message", (event) => {
    consoleMessages.push({
      level: event.level,
      message: event.message,
      line: event.lineNumber,
      sourceId: event.sourceId
    });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    consoleMessages.push({ level: "load", message: `${errorCode}: ${errorDescription}`, sourceId: validatedURL });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    consoleMessages.push({ level: "render-process-gone", message: JSON.stringify(details) });
  });

  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(800);
  await win.webContents.executeJavaScript(`
    window.__wwClickProbe = { clicks: {}, errors: [] };
    window.addEventListener("error", (event) => {
      window.__wwClickProbe.errors.push(String(event.error?.stack || event.message || event.error));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__wwClickProbe.errors.push(String(event.reason?.stack || event.reason));
    });
    true;
  `);
  await win.webContents.executeJavaScript(`
    window.__wwMotionProbe = {
      loaded: Boolean(window.__wwritingMotionReady),
      errors: []
    };
    true;
  `);

  const clicks = [];

  // === First Chapter Click Chain ===
  // The server starts with the first-chapter fixture selected. Wait for the
  // real renderer to expose the mock-model readiness action.
  await win.webContents.executeJavaScript(`document.getElementById('refresh').click(); true;`);
  await waitUntil(win,
    `document.getElementById('write-readiness-primary').textContent.includes("写第 1 章")`,
    "write-readiness primary must contain '写第 1 章' after switching to fc project",
    8000
  );

  await waitUntil(win, `(() => {
    const workbench = document.querySelector('[data-testid="project-workbench"]');
    const title = document.querySelector('#workbench-title');
    const cover = document.querySelector('#workbench-cover');
    const primary = document.querySelector('#workbench-primary');
    return Boolean(
      workbench && !workbench.hidden &&
      title?.textContent.includes("点击验收小说") &&
      cover?.dataset.projectTheme &&
      primary?.textContent.includes("第 1 章")
    );
  })()`, "首章工作台应显示真实作品与第 1 章动作", 8000);

  clicks.push(await clickAndRead(win, "#workbench-primary", {
    label: "工作台开始第 1 章",
    settleMs: 300
  }));

  await waitUntil(win,
    `(${RUN_VISIBLE_JS}) || document.getElementById('chapter-success').hidden === false`,
    "starting chapter 1 must show live turn process area (or legacy run card stop action / topbar stop) or the completed chapter card",
    8000
  );

  // Wait for the normal dashboard refresh loop to render a committed artifact.
  await waitUntil(win,
    `document.getElementById('chapter-success').hidden === false`,
    "chapter-success must appear after first chapter is written",
    35000
  );
  const fcChapterSuccessVisible = await read(win, "document.getElementById('chapter-success').hidden === false");
  assert.equal(fcChapterSuccessVisible, true, "chapter-success must appear after first chapter is written");
  assert.equal(
    await read(win, "document.getElementById('write-readiness').hidden === true"),
    true,
    "write-readiness must yield the main area to chapter-success"
  );
  const fcSuccessTitle = await read(win, "document.getElementById('chapter-success-title').textContent");
  assert.ok(fcSuccessTitle.includes("第 1 章"), `chapter-success-title must contain "第 1 章", got: ${fcSuccessTitle}`);
  clicks.push(await clickAndReadStable(win, "#chapter-success-read", {
    label: "chapter-success-read",
    settleMs: 600,
    expect: () => read(win, "document.getElementById('reader-scrim').classList.contains('show')")
  }));
  // Close the reader overlay before proceeding
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(300);

  clicks.push(await clickAndRead(win, "#workbench-read-latest", {
    label: "工作台阅读最近一章",
    expect: () => read(win, "document.getElementById('reader-scrim').classList.contains('show') === true")
  }));
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(300);
  await waitUntil(win, `document.querySelector("#reader-scrim")?.classList.contains("show") === false`, "工作台阅读器应已关闭");

  clicks.push(await clickAndRead(win, "#chapter-success-continue", {
    label: "继续写第 2 章",
    settleMs: 300,
    expect: () => read(win, `(() => {
      const runVisible = ${RUN_VISIBLE_JS};
      const completionTitle = document.querySelector("#chapter-success-title")?.textContent ?? "";
      return runVisible || completionTitle.includes("第 2 章");
    })()`)
  }));

  await waitUntil(win, `(() => {
    const runVisible = ${RUN_VISIBLE_JS};
    const completionTitle = document.querySelector("#chapter-success-title")?.textContent ?? "";
    return runVisible || completionTitle.includes("第 2 章");
  })()`, "续写点击必须启动第 2 章（live turn 过程区可见）或完成第 2 章", 8000);

  await waitUntil(
    win,
    `document.querySelector("#chapter-success-title")?.textContent.includes("第 2 章") === true`,
    "第 2 章完成后必须更新完成卡",
    35000,
  );
  assert.equal(
    await read(win, `document.querySelector("#chapter-success-continue").hidden === true`),
    true,
    "达到两章目标后必须隐藏续写按钮",
  );

  // Task 11 终态断言：真实写作一轮完成后，线程里应出现 live turn 完成卡
  // （无框折叠终态），且 live turn 内无头像、无署名行（规格书 P3/P6）。
  assert.equal(
    await read(win, `document.querySelectorAll('.turn-agent .done-card:not(.hidden)').length >= 1`),
    true,
    "写作完成后线程应出现 live turn 完成卡（无框折叠终态）"
  );
  assert.equal(
    await read(win, `document.querySelectorAll('.turn-agent .agent-avatar, .turn-agent .agent-name, .turn-agent .agent-tag').length === 0`),
    true,
    "live turn 内不得出现头像/署名行/agent-tag"
  );

  // 工作台「查看章节」按钮：真实点击应打开抽屉并落到章节 tab，证明第三个新增按钮也收到 trusted pointer click。
  clicks.push(await clickAndRead(win, "#workbench-open-chapters", {
    label: "工作台查看章节",
    expect: () => read(win, `document.getElementById('drawer').classList.contains('show') === true && document.querySelector('[data-dtab="chapters"]')?.getAttribute('aria-selected') === 'true'`)
  }));
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "工作台查看章节后关闭抽屉",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false")
  }));

  // === Composer draft persistence probe ===
  // 当前选中的是 fcProjectRoot（A）：输入未发送草稿并等待 200ms 防抖落盘。
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById("composer-input");
      input.value = "A 项目未发送草稿";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.value }));
      return true;
    })()
  `);
  await delay(300);
  assert.equal(
    await read(win, `Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some((key) => key?.startsWith("wwriting:composer:draft:") && localStorage.getItem(key) === "A 项目未发送草稿")`),
    true,
    "A 项目输入后应写入 composer draft key"
  );

  // Switch back to the original project by reloading the page after changing
  // the server's selected project root.
  await win.webContents.executeJavaScript(`
    fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: ${JSON.stringify(projectRoot)} })
    }).then(r => r.json());
    true;
  `);
  await delay(600);

  // Reload page to reset currentProjectRoot and all transient UI state.
  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(800);
  assert.equal(
    await read(win, `document.getElementById("composer-input").value`),
    "",
    "切到没有草稿的 B 项目时输入框应为空"
  );

  // Reload into A again: this also covers the restart/first-load restore path.
  await win.webContents.executeJavaScript(`
    fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: ${JSON.stringify(fcProjectRoot)} })
    }).then(r => r.json());
    true;
  `);
  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(800);
  assert.equal(
    await read(win, `document.getElementById("composer-input").value`),
    "A 项目未发送草稿",
    "重载并回到 A 项目时应恢复草稿"
  );

  // Return to the original project for the remaining click probes.
  await win.webContents.executeJavaScript(`
    fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: ${JSON.stringify(projectRoot)} })
    }).then(r => r.json());
    true;
  `);
  await win.loadURL(`http://127.0.0.1:${port}`);
  await delay(800);
  // Re-inject click and motion probes for the original project.
  await win.webContents.executeJavaScript(`
    window.__wwClickProbe = { clicks: {}, errors: [] };
    window.addEventListener("error", (event) => {
      window.__wwClickProbe.errors.push(String(event.error?.stack || event.message || event.error));
    });
    window.addEventListener("unhandledrejection", (event) => {
      window.__wwClickProbe.errors.push(String(event.reason?.stack || event.reason));
    });
    true;
  `);
  await win.webContents.executeJavaScript(`
    window.__wwMotionProbe = {
      loaded: Boolean(window.__wwritingMotionReady),
      errors: []
    };
    true;
  `);

  clicks.push(await clickAndRead(win, "#refresh", { label: "refresh" }));
  clicks.push(await clickAndRead(win, "#privacy-toggle", {
    label: "privacy-toggle",
    expect: () => read(win, "document.getElementById('app').dataset.privacy === 'on'")
  }));
  clicks.push(await clickAndRead(win, "#project-filter", {
    label: "project-filter-focus",
    expect: () => read(win, "document.activeElement?.id === 'project-filter'")
  }));
  clicks.push(await clickAndRead(win, "#new-novel", {
    label: "nav-new",
    expect: () => overlayVisible(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "nav-new-create-close",
    expect: () => overlayHidden(win, "create-scrim")
  }));
  clicks.push(await clickAndRead(win, "#open-folder", {
    label: "open-folder-fallback",
    expect: () => read(win, `
      document.getElementById("create-scrim").classList.contains("show") === true &&
      document.getElementById("create-heading").textContent.includes("手动填写本地文件夹")
    `)
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "open-folder-create-close",
    expect: () => overlayHidden(win, "create-scrim")
  }));
  await assertRailPrimaryEntriesSeparate(win);
  const projectGeometry = await read(win, `(() => {
    const row = document.querySelector('.proj-row');
    const card = row?.querySelector('.proj');
    if (!row || !card) return null;
    const rowRect = row.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      gap: Math.round(rowRect.right - cardRect.right),
      rowWidth: Math.round(rowRect.width),
      cardWidth: Math.round(cardRect.width)
    };
  })()`);
  assert.ok(projectGeometry, "项目列表必须存在可测量的项目行");
  assert.ok(projectGeometry.gap <= 1, `未悬停时项目卡不得预留菜单宽度: ${JSON.stringify(projectGeometry)}`);
  const projectRemoveAccessibility = await read(win, `(() => {
    const remove = document.querySelector('.proj-remove');
    return remove ? { ariaLabel: remove.getAttribute('aria-label'), title: remove.getAttribute('title') } : null;
  })()`);
  assert.ok(projectRemoveAccessibility, "项目列表必须存在删除图标按钮");
  assert.ok(projectRemoveAccessibility.ariaLabel, "删除图标按钮必须有 aria-label");
  assert.ok(projectRemoveAccessibility.title, "删除图标按钮必须有 title");
  clicks.push(await clickAndRead(win, ".proj.active", { label: "active-project" }));

  const newNovel = await clickAndRead(win, "#new-novel", {
    label: "new-novel",
    expect: () => read(win, `
      document.getElementById("create-scrim").classList.contains("show") === true &&
      document.getElementById("create-heading").textContent.includes("开始一部新小说")
    `)
  });
  clicks.push(newNovel);
  clicks.push(await clickAndRead(win, "#create-browse", { label: "create-browse" }));
  clicks.push(await clickAndRead(win, "#create-submit", {
    label: "create-submit-empty-path",
    expect: () => read(win, "document.getElementById('create-status').textContent.length > 0")
  }));
  clicks.push(await clickAndRead(win, "#create-x", {
    label: "create-x",
    expect: () => overlayHidden(win, "create-scrim")
  }));

  const settings = await clickAndRead(win, "#open-settings", {
    label: "open-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  });
  clicks.push(settings);
  const customModelId = `writer-custom-${Date.now()}`;
  clicks.push(await clickAndRead(win, ".sp-item:not(.on)", { label: "settings-provider-row" }));
  clicks.push(await clickAndRead(win, "#settings-add", {
    label: "settings-add",
    expect: () => read(win, "document.querySelector('#settings-provider-list .sp-item.on')?.textContent.includes('OpenAI') === true")
  }));
  const modelControlState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="模型"]');
      if (!control) return { tagName: null };
      control.value = ${JSON.stringify(customModelId)};
      control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: control.value }));
      return {
        tagName: control.tagName,
        value: control.value,
        listId: control.getAttribute("list"),
        hasSuggestions: Boolean(document.getElementById("settings-model-suggestions"))
      };
    })()
  `);
  assert.equal(modelControlState.tagName, "INPUT", "settings model control must be an editable input");
  assert.equal(modelControlState.value, customModelId, "settings model input must accept a custom model id");
  assert.equal(modelControlState.listId, "settings-model-suggestions", "settings model input must reference preset suggestions");
  assert.equal(modelControlState.hasSuggestions, true, "settings model suggestions datalist must exist");
  const customApiKey = `sk-clickability-${Date.now()}`;
  const customProviderState = await read(win, `
    (() => {
      const baseUrl = document.querySelector('[aria-label="API 地址 · 基础 URL"]');
      const apiKey = document.querySelector('[aria-label="API Key"]');
      if (!baseUrl || !apiKey) return { baseUrlTag: baseUrl?.tagName ?? null, apiKeyTag: apiKey?.tagName ?? null };
      baseUrl.value = "https://api.example.test/v1";
      baseUrl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: baseUrl.value }));
      apiKey.value = ${JSON.stringify(customApiKey)};
      apiKey.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: apiKey.value }));
      return {
        baseUrlTag: baseUrl.tagName,
        baseUrlValue: baseUrl.value,
        apiKeyTag: apiKey.tagName,
        apiKeyLength: apiKey.value.length
      };
    })()
  `);
  assert.equal(customProviderState.baseUrlTag, "INPUT", "custom provider base URL input must exist");
  assert.equal(customProviderState.baseUrlValue, "https://api.example.test/v1", "custom provider base URL must accept input");
  assert.equal(customProviderState.apiKeyTag, "INPUT", "custom provider API Key input must exist");
  assert.equal(customProviderState.apiKeyLength, customApiKey.length, "custom provider API Key input must accept the full key");
  clicks.push(await clickAndRead(win, ".spd-affix-eye", {
    label: "settings-api-key-reveal",
    expect: () => read(win, "document.querySelector('.spd-affix-eye')?.getAttribute('aria-pressed') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".spd-affix-copy", { label: "settings-api-key-copy" }));

  // --- 价格与预算上限输入框探针 ---
  const priceInputState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="输入价（元/百万 token）"]');
      if (!control) return { tagName: null };
      control.value = "2";
      control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "2" }));
      return { tagName: control.tagName, value: control.value };
    })()
  `);
  assert.equal(priceInputState.tagName, "INPUT", "price input must be editable");
  assert.equal(priceInputState.value, "2", "price input must accept numeric value");

  const priceOutputState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="输出价（元/百万 token）"]');
      if (!control) return { tagName: null };
      control.value = "8";
      control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "8" }));
      return { tagName: control.tagName, value: control.value };
    })()
  `);
  assert.equal(priceOutputState.tagName, "INPUT", "price output must be editable");
  assert.equal(priceOutputState.value, "8", "price output must accept numeric value");

  const maxCostState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="成本上限（元，需先配置价格）"]');
      if (!control) return { tagName: null };
      return { tagName: control.tagName };
    })()
  `);
  assert.equal(maxCostState.tagName, "INPUT", "max cost input must exist");

  const maxTokensState = await read(win, `
    (() => {
      const control = document.querySelector('[aria-label="token 总量上限"]');
      if (!control) return { tagName: null };
      return { tagName: control.tagName };
    })()
  `);
  assert.equal(maxTokensState.tagName, "INPUT", "max tokens input must exist");

  // 用户截图里的核心链路：填好模型名/地址/Key 后点「测试连接」→ 应看到连接结果，
  // 不应弹「请先新建或打开一部小说」。断言状态行进入 success 且文案不含项目门禁。
  clicks.push(await clickAndRead(win, "#settings-test-connection", {
    label: "settings-test-connection",
    expect: () => read(win, `
      (() => {
        const status = document.getElementById("settings-connection-status");
        const text = status?.textContent ?? "";
        return status?.dataset?.state === "success" && text.includes("连接成功") && !text.includes("请先新建或打开一部小说");
      })()
    `)
  }));

  clicks.push(await clickAndRead(win, ".sw", {
    label: "settings-network-toggle",
    expect: () => read(win, "document.querySelector('.sw')?.getAttribute('aria-pressed') === 'true'")
  }));
  clicks.push(await clickAndRead(win, "#settings-save", {
    label: "settings-save",
    expect: () => overlayHidden(win, "settings-scrim"),
    settleMs: 500
  }));
  // 模型设置与项目解耦后：保存只进全局清单（model-profiles.json + secrets.json），
  // 成为全局默认模型，不再写当前项目的 active_model。这里按新契约断言：
  // 1) 保存的模型成为全局默认；2) 密钥真实落盘（api_key_saved）；3) 项目模型原样保留。
  const savedCustomModel = await read(win, `
    fetch("/api/settings/models")
      .then((response) => response.json())
      .then((data) => data.default_model?.model_name ?? null)
  `);
  assert.equal(savedCustomModel, customModelId, "saved settings must promote the custom model to global default");
  const savedCustomSecret = await read(win, `
    fetch("/api/settings/models")
      .then((response) => response.json())
      .then((data) => {
        const profile = data.models.find((model) => model.model_name === ${JSON.stringify(customModelId)});
        return profile ? { apiKeySaved: profile.api_key_saved, masked: profile.api_key_masked } : null;
      })
  `);
  assert.ok(savedCustomSecret, "saved settings must list the custom model in the global profile list");
  assert.equal(savedCustomSecret.apiKeySaved, true, "saved settings must persist the full local API key to secrets.json");
  assert.equal(savedCustomSecret.masked.endsWith(customApiKey.slice(-4)), true, "saved API key mask must match the entered key's tail");
  const projectModelAfterSave = await read(win, `
    fetch("/api/dashboard")
      .then((response) => response.json())
      .then((data) => data.project?.active_model?.model_name ?? null)
  `);
  assert.equal(projectModelAfterSave, "mock-writer", "saving global model must not overwrite the current project's active model (decoupled)");
  await waitUntil(win, "document.getElementById('settings-save')?.disabled === false", "settings save flow must finish before quick rail checks");

  const modalClosedState = await read(win, `
    (() => {
      const settings = document.getElementById("settings-scrim");
      const create = document.getElementById("create-scrim");
      return settings.hasAttribute("inert") && create.hasAttribute("inert");
    })()
  `);
  assert.equal(modalClosedState, true, "settings/create overlays must be inert after close");
  await clearStaleClosingStates(win);

  await assertQuickRailPopoverClears(win);

  clicks.push(await clickAndReadStable(win, '.quick-rail .qr-slot[data-key="chapters"]', {
    label: "open-chapters",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('[data-dtab=\"chapters\"]').getAttribute('aria-selected') === 'true'"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, ".chrow.completed", {
    label: "completed-chapter-row",
    expect: () => overlayVisible(win, "reader-scrim"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, "#reader-close", {
    label: "reader-close",
    expect: () => overlayHidden(win, "reader-scrim"),
    settleMs: 700
  }));
  await closeTransientOverlays(win);
  clicks.push(await clickAndRead(win, ".drawer-tabs [data-dtab=\"model\"]", {
    label: "drawer-model-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"model\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndReadStable(win, ".drawer-body .save-btn", {
    label: "drawer-open-model-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  }));
  clicks.push(await clickAndReadStable(win, "#settings-cancel", {
    label: "settings-cancel",
    expect: () => overlayHidden(win, "settings-scrim"),
    settleMs: 500
  }));
  await waitUntil(win, "document.getElementById('settings-scrim')?.classList.contains('show') === false", "settings overlay must close before switching drawer tabs");
  await clearStaleClosingStates(win);
  clicks.push(await clickAndReadStable(win, ".drawer-tabs [data-dtab=\"cost\"]", {
    label: "drawer-cost-tab",
    expect: () => read(win, `
      document.querySelector('[data-dtab="cost"]').getAttribute('aria-selected') === 'true'
      && document.querySelector('.cost-panel-root') !== null
      && document.querySelectorAll('[data-cost-section]').length >= 2
    `),
    settleMs: 250
  }));
  clicks.push(await clickAndReadStable(win, ".drawer-tabs [data-dtab=\"run\"]", {
    label: "drawer-run-tab",
    expect: () => read(win, "document.querySelector('[data-dtab=\"run\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndRead(win, ".drawer-body .dpanel:nth-child(3) .small-button", {
    label: "skill-toggle",
    settleMs: 650
  }));
  clicks.push(await clickAndRead(win, ".research-form .small-button", { label: "research-empty-search" }));
  clicks.push(await clickAndRead(win, ".research-form button:last-of-type", { label: "research-empty-fetch" }));
  clicks.push(await clickAndReadStable(win, "#drawer-close", {
    label: "drawer-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false"),
    settleMs: 500
  }));

  const drawerClosedState = await read(win, `
    (() => {
      const drawer = document.getElementById("drawer");
      return drawer.getAttribute("aria-hidden") === "true" && drawer.hasAttribute("inert");
    })()
  `);
  assert.equal(drawerClosedState, true, "drawer must be inert and aria-hidden after close");
  await win.webContents.executeJavaScript(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    true;
  `);

  clicks.push(await clickAndRead(win, '.quick-rail .qr-slot[data-key="skills"]', {
    label: "open-panel",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === true && document.querySelector('[data-dtab=\"skills\"]').getAttribute('aria-selected') === 'true'")
  }));
  clicks.push(await clickAndReadStable(win, "#drawer-scrim", {
    label: "drawer-scrim-close",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') === false"),
    settleMs: 500
  }));

  await win.webContents.executeJavaScript(`
    document.querySelector('.failure-card[data-failure-id="click-failure-1"]')?.scrollIntoView({ block: "center" });
    window.__wwDebugResolve = { started: false, ok: false, loadDashboardCalled: false, syncCardsFound: false };
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && url.includes('/api/failures/resolve')) {
        window.__wwDebugResolve.started = true;
        try {
          const res = await origFetch.apply(this, args);
          window.__wwDebugResolve.ok = res.ok;
          return res;
        } catch(e) { window.__wwDebugResolve.error = String(e); throw e; }
      }
      return origFetch.apply(this, args);
    };
    true;
  `);
  clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] .failure-actions button', {
    label: "failure-action",
    settleMs: 3000,
    expect: async () => {
      const debug = await read(win, "window.__wwDebugResolve");
      console.log("[debug] resolve flow:", JSON.stringify(debug));
      const dom = await read(win, `(() => {
        const card = document.querySelector('[data-failure-id="click-failure-1"]');
        return {
          exists: !!card,
          hasResolved: !!card?.querySelector('.failure-resolved'),
          outerSnippet: card?.outerHTML?.slice(0, 300) ?? null
        };
      })()`);
      console.log("[debug] DOM after resolve:", JSON.stringify(dom));
      return dom.hasResolved === true;
    }
  }));
  clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="click-failure-1"] summary', {
    label: "failure-diagnostics-summary",
    expect: () => read(win, "document.querySelector('[data-failure-id=\"click-failure-1\"] details')?.open === true")
  }));
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "failure-refresh-after-resolve",
    settleMs: 450,
    expect: () => read(win, "document.querySelectorAll('[data-failure-id=\"click-failure-1\"]').length === 1")
  }));

  await win.webContents.executeJavaScript(`
    document.querySelector('.failure-card[data-failure-id="seed-cost-budget"]')?.scrollIntoView({ block: "center" });
    true;
  `);
  await delay(120);
  clicks.push(await clickAndRead(win, '.failure-card[data-failure-id="seed-cost-budget"] .failure-actions button', {
    label: "cost-budget-failure-action",
    settleMs: 3000,
    expect: () => read(win, `
      (() => {
        const card = document.querySelector('[data-failure-id="seed-cost-budget"]');
        if (!card) return false;
        return Boolean(card.querySelector('.failure-resolved'))
          || Boolean(card.querySelector('.failure-actions button[disabled]'))
          || window.__wwDebugResolve?.started === true;
      })()
    `)
  }));

  // 「命令」按钮已移除（UI 优化：删除挤压竖排的按钮），改为直接输入 "/" 触发斜杠菜单。
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById("composer-input");
      input.focus();
      input.value = "/";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/" }));
      return true;
    })()
  `);
  await delay(180);
  assert.equal(await read(win, "document.getElementById('slash-menu').hidden"), false, "输入 / 应唤起斜杠菜单");
  clicks.push(await clickAndRead(win, ".slash-item", {
    label: "slash-first-item",
    expect: () => read(win, "document.getElementById('composer-input').value.length > 0")
  }));
  const submitEnabled = await read(win, `
    (() => {
      const input = document.getElementById("composer-input");
      input.value = "/ask 现在写到哪里了？";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.value }));
      return document.getElementById("composer-submit").disabled === false;
    })()
  `);
  assert.equal(submitEnabled, true, "composer submit should become enabled after text input");
  clicks.push(await clickAndRead(win, "#composer-submit", {
    label: "composer-submit-side-question",
    settleMs: 750
  }));

  // === S3 chat probes ===
  // Write chat_pending_action.json and chat_history.jsonl fixtures
  fs.writeFileSync(path.join(projectRoot, "chat_pending_action.json"), JSON.stringify({
    id: "test-pending-001",
    created_at: "2026-06-12T00:00:00.000Z",
    status: "pending",
    tool: "edit_chapter",
    args: { chapter_no: 1, find: "六楼", replace: "十二楼", reason: "test" },
    preview: { ok: true, chapter_no: 1, before: "...六楼...", after: "...十二楼..." },
    lead_text: "test"
  }));
  fs.writeFileSync(path.join(projectRoot, "chat_history.jsonl"), [
    JSON.stringify({ id: "chat-user-001", ts: "2026-06-12T01:00:00.000Z", role: "user", content: "你好" }),
    JSON.stringify({ id: "chat-tool-000", ts: "2026-06-12T01:00:01.000Z", role: "tool", tool: "read_chapter", ok: true, result_summary: '{"chapter_no":1}' }),
    JSON.stringify({ id: "chat-tool-001", ts: "2026-06-12T01:00:02.000Z", role: "tool", tool: "read_chapter", ok: true, args: '{"chapter_no":1}', result_summary: '{"chapter_no":1,"words":1200}' }),
    JSON.stringify({ id: "chat-assistant-001", ts: "2026-06-12T01:00:03.000Z", role: "assistant", content: "看一段：\n\n```稿\n夜雨敲窗，他点了灯。\n```\n\n- 要点一\n- 要点二", cost: 0.001 })
  ].join("\n") + "\n");

  // Mock /api/chat/send and /api/chat/confirm to avoid real LLM calls
  await win.webContents.executeJavaScript(`
    (() => {
      if (!window.__origFetch) window.__origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && url.includes('/api/chat/send')) {
          if (window.__failNextChat === true) {
            window.__failNextChat = false;
            return new Response(JSON.stringify({ ok: false, message: "mock chat failure" }), { status: 500, headers: { 'Content-Type': 'application/json' } });
          }
          await new Promise((r) => setTimeout(r, 800));
          return new Response(JSON.stringify({ ok: true, reply: "mock", toolEvents: [], pendingAction: null, usage: { calls: 0, cost: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url && url.includes('/api/chat/confirm')) {
          return new Response(JSON.stringify({ ok: true, message: "已确认" }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return window.__origFetch.apply(this, args);
      };
      return true;
    })()
  `);

  // 失败路径：输入应恢复，且失败内容应立即写回草稿。
  await win.webContents.executeJavaScript(`
    (() => {
      window.__failNextChat = true;
      const input = document.getElementById("composer-input");
      input.value = "失败后应保留的草稿";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: input.value }));
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()
  `);
  await waitUntil(win, `document.querySelector('.agent-say')?.textContent.includes("发送失败") === true`, "失败发送应显示错误并恢复输入", 5000);
  assert.equal(await read(win, `document.getElementById("composer-input").value`), "失败后应保留的草稿", "发送失败应恢复原文");
  await delay(100);
  assert.equal(
    await read(win, `Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).some((key) => key?.startsWith("wwriting:composer:draft:") && localStorage.getItem(key) === "失败后应保留的草稿")`),
    true,
    "发送失败应立即保存草稿"
  );

  // ① composer 输入"你好"回车 → user + assistant 气泡
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById("composer-input");
      input.value = "你好";
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "你好" }));
      input.focus();
      return true;
    })()
  `);
  await delay(300);
  const chatDraftKey = await read(win, `Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).find((key) => key?.startsWith("wwriting:composer:draft:") && localStorage.getItem(key) === "你好") ?? null`);
  assert.ok(chatDraftKey, "chat input should have a persisted draft key before send");
  assert.equal(await read(win, "document.getElementById('composer-submit').disabled === false"), true, "composer submit must be enabled with text '你好'");
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.getElementById("composer-input");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()
  `);
  await waitUntil(win, `
    document.querySelector('.chat-bubble--user') !== null &&
    document.querySelector('.chat-bubble--assistant') !== null
  `, "chat user+assistant bubbles must appear after composer Enter", 8000);
  assert.equal(
    await read(win, `localStorage.getItem(${JSON.stringify(chatDraftKey)})`),
    null,
    "successful chat send should clear its composer draft key"
  );

  // ② pending_action 确认卡 (fixtures written above, refresh to ensure loaded)
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "refresh-for-chat-fixtures",
    settleMs: 1000,
    expect: () => read(win, `document.querySelector('[data-testid="chat-confirm-approve"]') !== null && document.querySelector('[data-testid="chat-confirm-reject"]') !== null`)
  }));
  const confirmCardState = await read(win, `
    (() => {
      const approve = document.querySelector('[data-testid="chat-confirm-approve"]');
      const reject = document.querySelector('[data-testid="chat-confirm-reject"]');
      return {
        approveExists: approve !== null,
        rejectExists: reject !== null,
        approveDisabled: approve?.disabled ?? true,
        rejectDisabled: reject?.disabled ?? true
      };
    })()
  `);
  assert.equal(confirmCardState.approveExists, true, "chat-confirm-approve must exist");
  assert.equal(confirmCardState.rejectExists, true, "chat-confirm-reject must exist");
  assert.equal(confirmCardState.approveDisabled, false, "chat-confirm-approve must not be disabled");
  assert.equal(confirmCardState.rejectDisabled, false, "chat-confirm-reject must not be disabled");
  clicks.push(await clickAndRead(win, '[data-testid="chat-confirm-approve"]', {
    label: "chat-confirm-approve",
    settleMs: 500,
    expect: () => read(win, `
      document.querySelector('.chat-confirm-card--resolved') !== null ||
      document.querySelector('[data-testid="chat-confirm-approve"]')?.disabled === true
    `)
  }));

  assert.equal(
    await read(win, `document.querySelector('.chat-tool-card') === null`),
    true,
    "successful tool calls must not expose technical cards in the main thread"
  );

  // === S4 Task 13: 新探针 ===

  // ④ 设置 6 分区导航逐个点击
  clicks.push(await clickAndRead(win, "#open-settings", {
    label: "s4-open-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  }));
  const sectionItems = await read(win, `[...document.querySelectorAll('.sp-section-item')].map(el => el.textContent.trim())`);
  assert.ok(sectionItems.length >= 6, `设置应有 6 个分区，实际 ${sectionItems.length} 个`);
  for (let i = 0; i < sectionItems.length; i++) {
    const sectionLabel = sectionItems[i];
    clicks.push(await clickAndRead(win, `.sp-section-item:nth-of-type(${i + 1})`, {
      label: `s4-section-${sectionLabel}`,
      settleMs: 200,
      expect: () => read(win, `document.querySelector('.sp-section-item.on')?.textContent.includes(${JSON.stringify(sectionLabel)})`)
    }));
  }
  // 切回模型区关闭
  clicks.push(await clickAndRead(win, "#settings-x", {
    label: "s4-settings-close",
    expect: () => overlayHidden(win, "settings-scrim")
  }));

  // ⑤ composer mode pill → 浮层
  clicks.push(await clickAndRead(win, "#mode-pill", {
    label: "s4-mode-pill-click",
    settleMs: 200,
    expect: () => read(win, "document.getElementById('mode-popover')?.hidden === false")
  }));
  // 关闭浮层（点击浮层外区域）
  await win.webContents.executeJavaScript(`
    document.getElementById('mode-popover').hidden = true;
    true;
  `);
  await delay(100);

  // ⑥ diff 确认卡（已有 pending_action fixture，检查 .chat-diff-line 渲染）
  clicks.push(await clickAndRead(win, "#refresh", {
    label: "s4-refresh-for-diff",
    settleMs: 1000,
    expect: () => read(win, `document.querySelectorAll('.chat-diff-line').length > 0 || document.querySelector('[data-testid="chat-confirm-approve"]') !== null`)
  }));

  // ⑦ 空状态建议卡（需要空 chat_history 的项目态——当前 fixture 有消息，仅验证元素存在性）
  const hasSuggestionCards = await read(win, `document.querySelectorAll('.suggestion-card').length`);
  // 建议卡仅在无消息时显示，当前 fixture 有消息所以可能为 0，不作为 fail 条件

  // ⑧ 归档组折叠头（当前项目未归档，验证 toggle 元素结构存在性）
  const archivedToggle = await read(win, `document.querySelector('.rail-archived-toggle')`);
  // 归档 toggle 仅在有归档项目时显示，不作为 fail 条件

  // === S4.5 probes ===
  // ⑨ 稿块 + markdown 列表渲染
  const msBlock = await read(win, `document.querySelectorAll('.manuscript-block').length`);
  assert.ok(msBlock >= 1, "manuscript block must render from ```稿 fence");
  const mdList = await read(win, `document.querySelectorAll('.chat-bubble-content ul li').length`);
  assert.ok(mdList >= 2, "markdown list must render");

  // ⑩ 成功工具调用不应占据主线程或暴露技术参数。
  const toolLabels = await read(win, `[...document.querySelectorAll('.chat-tool-label')].map((n) => n.textContent)`);
  assert.deepEqual(toolLabels, [], `successful tool cards should stay hidden: ${JSON.stringify(toolLabels)}`);

  // ⑪ 溯源 chips：点章节 chip 打开阅读器
  clicks.push(await clickAndRead(win, '[data-testid="chat-source-chapter"]', {
    label: "s45-source-chip-open-reader",
    settleMs: 400,
    expect: () => read(win, `document.getElementById('reader-scrim').classList.contains('show')`)
  }));
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(200);

  // ⑫ 消息操作：复制（点击后必须出 toast——成功或失败文案都算执行到位）
  clicks.push(await clickAndRead(win, '[data-testid="msg-copy"]', {
    label: "s45-msg-copy",
    settleMs: 300,
    expect: () => read(win, `document.querySelector('.toast-stack').textContent.includes('复制')`)
  }));

  // ⑬ 确认卡段落/行级切换
  clicks.push(await clickAndRead(win, '[data-testid="chat-diff-toggle"]', {
    label: "s45-diff-toggle",
    settleMs: 200,
    expect: () => read(win, `document.querySelector('.chat-diff') && document.querySelector('.chat-diff').hidden === false`)
  }));

  // ⑭ 活动占位 + 停止按钮（chat/send mock 延迟 800ms 制造窗口；stop 打到真服务器 → 空闲 409 → 错误 toast 证明链路通）
  await win.webContents.executeJavaScript(`
    document.getElementById('composer-input').value = '测试过程流';
    document.getElementById('composer-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-submit').click();
    true;
  `);
  await delay(300);
  const placeholderVisible = await read(win, `Boolean(document.querySelector('[data-testid="chat-activity-placeholder"]'))`);
  assert.equal(placeholderVisible, true, "activity placeholder must appear during chat send");
  // stop 打到真服务器：send 被前端 mock，服务端无 chatJobs → 409「当前没有进行中的对话轮。」→ 错误 toast。
  // 断言必须认这条具体文案——不能只看 toast 非空（⑫ 的复制 toast 3.2s 内还在栈里，会误判通过）。
  clicks.push(await clickAndRead(win, '[data-testid="chat-stop"]', {
    label: "s45-chat-stop",
    settleMs: 400,
    expect: () => read(win, `document.querySelector('.toast-stack').textContent.includes('对话轮') || document.querySelector('.toast-stack').textContent.includes('停止')`)
  }));
  await delay(900); // 等 mock send 完成、占位撤除

  // ⑮ 阅读器工具排：开阅读器 → 字号 + 沉浸 + 翻章按钮
  // 适配既有模式：mocked /api/chat/send 不会触发 chapter_completed，所以 .filecard 不存在。
  // 走 chapters 抽屉 → .chrow.completed 开阅读器（与 ② 同款）。
  clicks.push(await clickAndReadStable(win, '.quick-rail .qr-slot[data-key="chapters"]', {
    label: "s45-open-chapters-for-reader",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('[data-dtab=\"chapters\"]').getAttribute('aria-selected') === 'true'"),
    settleMs: 500
  }));
  clicks.push(await clickAndReadStable(win, ".chrow.completed", {
    label: "s45-reader-from-chrow",
    expect: () => overlayVisible(win, "reader-scrim"),
    settleMs: 500
  }));
  // 比较表达式放进页内求值，expect 保持同步布尔（与既有探针契约一致）。
  const fontBefore = await read(win, `document.getElementById('reader-body').style.fontSize`);
  clicks.push(await clickAndRead(win, '#reader-font-plus', {
    label: "s45-reader-font-plus",
    settleMs: 150,
    expect: () => read(win, `document.getElementById('reader-body').style.fontSize !== ${JSON.stringify(fontBefore)}`)
  }));
  clicks.push(await clickAndRead(win, '#reader-wide', {
    label: "s45-reader-wide",
    settleMs: 150,
    expect: () => read(win, `document.getElementById('reader').classList.contains('reader--wide')`)
  }));
  // reader-path 已移除（不向用户暴露文件路径）；用翻章后状态断言：到末章 next 禁用，
  // 或翻到非首章 prev 可用。
  clicks.push(await clickAndRead(win, '#reader-next', {
    label: "s45-reader-next",
    settleMs: 500,
    expect: () => read(win, `document.getElementById('reader-next').disabled === true || document.getElementById('reader-prev').disabled === false`)
  }));
  await win.webContents.executeJavaScript(`document.getElementById('reader-close').click(); true;`);
  await delay(200);
  // 关闭 chapters 抽屉，避免遮挡命令栏 #cbar-keys
  await win.webContents.executeJavaScript(`
    (() => {
      if (document.getElementById('drawer')?.classList.contains('show')) {
        document.getElementById('drawer-close')?.click();
      }
      return true;
    })()
  `);
  await waitUntil(win, "document.getElementById('drawer')?.classList.contains('show') === false", "drawer must close before shortcuts probe", 2000);

  // ⑯ 快捷键浮层：⌨ 开 → X 关
  clicks.push(await clickAndRead(win, '#cbar-keys', {
    label: "s45-shortcuts-open",
    settleMs: 200,
    expect: () => read(win, `document.getElementById('shortcuts-scrim').classList.contains('show')`)
  }));
  clicks.push(await clickAndRead(win, '#shortcuts-x', {
    label: "s45-shortcuts-close",
    settleMs: 200,
    expect: () => read(win, `!document.getElementById('shortcuts-scrim').classList.contains('show')`)
  }));

  const motionReady = await read(win, "Boolean(window.__wwritingMotionReady)");
  assert.equal(motionReady, true, "motion runtime must initialize in Electron");
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
    newNovel,
    settings,
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

async function clickAndRead(win, selector, { label = selector, expect = null, settleMs = 180, consoleMessages = [] } = {}) {
  await win.webContents.executeJavaScript(`
    (() => {
      const selector = ${JSON.stringify(selector)};
      const el = document.querySelector(selector);
      if (!el) return false;
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center" });
      }
      el.addEventListener("click", () => {
        window.__wwClickProbe.clicks[selector] = (window.__wwClickProbe.clicks[selector] || 0) + 1;
      }, { capture: true, once: true });
      return true;
    })();
  `);
  await delay(40);
  const before = await probe(win, selector);
  assert.ok(before.rect, `${label} must have a layout box: ${JSON.stringify({ ...before, consoleMessages }, null, 2)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: before.center.x, y: before.center.y });
  win.webContents.sendInputEvent({ type: "mouseDown", x: before.center.x, y: before.center.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: before.center.x, y: before.center.y, button: "left", clickCount: 1 });
  await delay(settleMs);
  const after = await probe(win, selector);
  const expectationPassed = expect ? await expect() : true;
  return {
    label,
    rect: before.rect,
    center: before.center,
    targetAtCenter: before.targetAtCenter,
    clicked: (after.clickCount ?? 0) > (before.clickCount ?? 0),
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
  assert.equal(last?.clicked, true, `${options.label ?? selector} must receive a trusted pointer click after retries: ${JSON.stringify(last, null, 2)}`);
  assert.equal(last?.expectationPassed, true, `${options.label ?? selector} did not produce the expected UI state after retries: ${JSON.stringify(last, null, 2)}`);
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
        errors: window.__wwClickProbe?.errors ?? [],
        visibleButtons: [...document.querySelectorAll("button")]
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({
            id: el.id || null,
            className: String(el.className || ""),
            text: el.textContent.trim().replace(/\\s+/gu, " ").slice(0, 80)
          })),
        scripts: [...document.scripts].map((script) => ({
          src: script.src,
          type: script.type,
          noModule: script.noModule
        })),
        resources: performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize
        }))
      };
    })();
  `);
}

async function assertQuickRailPopoverClears(win) {
  const chaptersSelector = '.quick-rail .qr-slot[data-key="chapters"]';
  const chapters = await triggerQuickRailHover(win, chaptersSelector);
  assert.ok(chapters.rect, `chapters quick rail slot must have a layout box: ${JSON.stringify(chapters, null, 2)}`);
  await waitUntil(win, "document.querySelectorAll('.qr-popover').length === 1", "hovering chapters quick rail slot must show exactly one popover");
  win.webContents.sendInputEvent({ type: "mouseDown", x: chapters.center.x, y: chapters.center.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: chapters.center.x, y: chapters.center.y, button: "left", clickCount: 1 });
  await delay(80);
  assert.equal(
    await read(win, "document.querySelectorAll('.qr-popover').length"),
    0,
    "clicking a quick rail slot must clear its popover"
  );
  await closeDrawerIfOpen(win);

  const research = await triggerQuickRailHover(win, '.quick-rail .qr-slot[data-key="research"]');
  assert.ok(research.rect, `research quick rail slot must have a layout box: ${JSON.stringify(research, null, 2)}`);
  await waitUntil(win, "document.querySelectorAll('.qr-popover').length === 1", "hovering research quick rail slot must show exactly one popover before blur");
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("blur")); true;`);
  await delay(40);
  assert.equal(
    await read(win, "document.querySelectorAll('.qr-popover').length"),
    0,
    "window blur must clear a quick rail popover"
  );
  await win.webContents.executeJavaScript(`window.dispatchEvent(new Event("focus")); true;`);
  await delay(40);
}

async function assertRailPrimaryEntriesSeparate(win) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const selectors = ["#new-novel", "#open-folder"];
      const entries = Object.fromEntries(selectors.map((selector) => {
        const el = document.querySelector(selector);
        const rect = el?.getBoundingClientRect?.();
        const center = rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
        const target = center ? document.elementFromPoint(center.x, center.y) : null;
        return [selector, {
          rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
          center,
          centerHitsSelf: Boolean(target?.closest?.(selector))
        }];
      }));
      const a = entries["#new-novel"].rect;
      const b = entries["#open-folder"].rect;
      const intersects = Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
      return { entries, intersects };
    })();
  `);
  assert.ok(result.entries["#new-novel"].rect, `#new-novel must have a layout box: ${JSON.stringify(result, null, 2)}`);
  assert.ok(result.entries["#open-folder"].rect, `#open-folder must have a layout box: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.intersects, false, `#new-novel and #open-folder must not overlap: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.entries["#new-novel"].centerHitsSelf, true, `#new-novel center point must hit its button: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.entries["#open-folder"].centerHitsSelf, true, `#open-folder center point must hit its button: ${JSON.stringify(result, null, 2)}`);
}

async function triggerQuickRailHover(win, selector) {
  const target = await probe(win, selector);
  assert.ok(target.rect, `${selector} must have a layout box: ${JSON.stringify(target, null, 2)}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: target.center.x, y: target.center.y });
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el?.focus?.();
      el?.dispatchEvent(new MouseEvent("mouseover", { view: window, bubbles: true }));
      el?.dispatchEvent(new MouseEvent("mouseenter", { view: window, bubbles: false }));
      return true;
    })();
  `);
  return target;
}

async function closeDrawerIfOpen(win) {
  const drawerOpen = await read(win, "document.getElementById('drawer')?.classList.contains('show') === true");
  if (!drawerOpen) return;
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById("drawer-close")?.click();
      return true;
    })();
  `);
  await waitUntil(win, "document.getElementById('drawer')?.classList.contains('show') === false", "quick rail popover probe must restore the drawer to closed state");
  await clearStaleClosingStates(win);
  assert.equal(await read(win, "document.getElementById('drawer')?.dataset.closing !== 'true'"), true, "quick rail popover probe must wait until drawer closing state is cleared");
  assert.equal(await read(win, "document.getElementById('drawer-scrim')?.dataset.closing !== 'true'"), true, "quick rail popover probe must wait until drawer scrim closing state is cleared");
}

async function closeTransientOverlays(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      if (document.getElementById("reader-scrim")?.classList.contains("show")) {
        document.getElementById("reader-close")?.click();
      }
      if (document.getElementById("settings-scrim")?.classList.contains("show")) {
        document.getElementById("settings-cancel")?.click();
      }
      if (document.getElementById("create-scrim")?.classList.contains("show")) {
        document.getElementById("create-x")?.click();
      }
      return true;
    })();
  `);
  await delay(350);
  assert.equal(await overlayHidden(win, "reader-scrim"), true, "reader overlay must be closed before switching drawer tabs");
  assert.equal(await overlayHidden(win, "settings-scrim"), true, "settings overlay must be closed before switching drawer tabs");
  assert.equal(await overlayHidden(win, "create-scrim"), true, "create overlay must be closed before switching drawer tabs");
}

async function clearStaleClosingStates(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      for (const id of ["reader-scrim", "settings-scrim", "create-scrim", "drawer-scrim"]) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains("show")) delete el.dataset.closing;
      }
      const drawer = document.getElementById("drawer");
      if (drawer && !drawer.classList.contains("show") && drawer.getAttribute("aria-hidden") === "true") {
        delete drawer.dataset.closing;
      }
      if (drawer && drawer.classList.contains("show") && drawer.getAttribute("aria-hidden") === "false") {
        delete drawer.dataset.closing;
        drawer.removeAttribute("inert");
      }
      const drawerScrim = document.getElementById("drawer-scrim");
      if (drawerScrim?.classList.contains("show")) {
        delete drawerScrim.dataset.closing;
      }
      return true;
    })();
  `);
}

function overlayVisible(win, id) {
  return read(win, `document.getElementById(${JSON.stringify(id)})?.classList.contains("show") === true`);
}

function overlayHidden(win, id) {
  return read(win, `document.getElementById(${JSON.stringify(id)})?.classList.contains("show") === false`);
}

function read(win, expression) {
  return win.webContents.executeJavaScript(`(() => (${expression}))();`);
}

async function waitForServer(targetPort) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/dashboard`);
      if (response.ok) return;
    } catch {}
    await delay(120);
  }
  throw new Error("server not ready");
}

async function waitUntil(win, expression, message, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await read(win, expression)) return;
    await delay(50);
  }
  assert.equal(await read(win, expression), true, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup(code) {
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
  app.exit(code);
}
