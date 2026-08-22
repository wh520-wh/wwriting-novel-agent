// scripts/capture-visual-acceptance.cjs —— 确定性视觉证据采集（Task 13 改写）。
//
// 职责：为独立多模态验收模型生成完整、自洽、可核对的视觉证据目录：
//   MANIFEST.md / live-indicator-audit.json / multimodal-review-prompt.md +
//   22 张指定命名的 PNG（conversation-completed ×4 视口、reasoning-running 三帧、
//   tool-after-reasoning 三帧、markdown-fixture ×2、settings-builtin-styles ×2、
//   settings-style-detail、drawer、plain-folder-first-message、
//   version-panel、version-panel-confirm、memory-tab、plan-panel-open、plan-panel-collapsed）。
// 每轮一个目录（--output 指定），禁止覆盖上一轮。
//
// 驱动路径（全部经真实 UI / API / journal SSE）：
//   - 在同一进程启动真实 app-shell server（createAppShellServer），注入
//     testGatewayFactory 与临时 root 的 skills service；
//   - 真实项目（visual acceptance fixture）驱动对话/设置/drawer 场景；
//   - 普通文件夹（无 project.yaml）+ 应用私有 stateRoot 驱动
//     plain-folder-first-message 场景（真实 UI 打开流程 + composer 发送）；
//   - 用真实 /api/agent/input（经 composer UI 点击）、journal SSE（UI 实时渲染）
//     和 UI 点击驱动全部场景；禁止向 DOM 填假 HTML；
//   - 测试控制器可暂停/恢复确定性 gateway（hold/release），让 reasoning 运行态
//     可被稳定截图。
//
// 动效唯一性：每个 motion frame 捕获前执行 DOM 审计；sequential 场景动效文字
// >1、terminal 场景 >0、展开工作组中 groupHeaderAnimated=true 都立即退出 1，
// 绝不交给视觉模型掩盖。当前 Runtime 串行执行工具，MANIFEST 写
// parallel_runtime_supported: false，不制造并行截图。
//
// 非主观检查：图片宽高与视口一致、像素非全白/全透明、页面无横向 overflow、
// 关键 selector 的 bounding box 不相交——任一失败即退出 1。四视口
// （390x844/768x900/1280x800/1440x900）由 conversation-completed 全覆盖。
//
// 运行：node scripts/capture-visual-acceptance.cjs --output artifacts/visual-acceptance/<campaign>/round-01 [--theme light|dark]
// 期望：退出码 0，输出 evidence directory 与 MANIFEST 全部声明文件。
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

// Bootstrap：`node scripts/capture-visual-acceptance.cjs --output <dir>` 在普通 node
// 下 require("electron") 只返回可执行文件路径。检测到未运行在 Electron 运行时内时，
// 以 electron 重新拉起本脚本（stdio 与退出码透传）。
{
  let electronEntry = null;
  try {
    electronEntry = require("electron");
  } catch {
    electronEntry = null;
  }
  if (typeof electronEntry === "string" || !electronEntry?.app) {
    const { spawnSync } = require("node:child_process");
    let binary = null;
    try {
      binary = require("electron");
    } catch {
      binary = null;
    }
    if (typeof binary !== "string" || binary.length === 0) {
      console.error("capture-visual-acceptance 必须以 Electron 运行（node scripts/capture-visual-acceptance.cjs --output <dir>）");
      process.exit(1);
    }
    const result = spawnSync(binary, [__filename, ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
}

// Guard against EPIPE when stdout pipe is closed (e.g. user interrupted)
process.stdout.on("error", (err) => { if (err.code !== "EPIPE") throw err; });
process.stderr.on("error", (err) => { if (err.code !== "EPIPE") throw err; });

const SCRIPT_DIR = __dirname;
// read_skill 的注入延迟：给 tool-after-reasoning 三帧（t000/t400/t900 + 捕获开销）
// 留足窗口；5s 覆盖约 3.5s 的最坏捕获序列仍有 1.5s 余量。
const SKILL_READ_DELAY_MS = 5000;
// 扫光动画相位：以 1450ms 周期为基准选 680/920/1160ms（左/中/右清晰相位），
// seek 时按实际动画 duration 等比换算（Round10 起产品动画为 agent-label-shine
// 2250ms；OS reduced-motion 命中时注入的归一化样式为 agent-text-shimmer 1450ms）。
const SHIMMER_PHASES_MS = [680, 920, 1160];
const SHIMMER_BASE_PERIOD_MS = 1450;
// 内置写作风格三基座（F2 前端起并入普通行列表；旧「只读分区」场景见第十四轮前的验收存档）。
const BUILTIN_STYLE_NAMES = ["balanced", "fast-readable", "psychological-literary"];
const VIEWPORT_DEFAULT = { width: 1280, height: 800 };
const VIEWPORT_NARROW = { width: 390, height: 844 };
const VIEWPORT_MEDIUM = { width: 768, height: 900 };
const VIEWPORT_WIDE = { width: 1440, height: 900 };
// 四视口验收（SPEC §10.3）：conversation-completed 必须在每个视口验证无横向溢出。
const VIEWPORTS = [VIEWPORT_NARROW, VIEWPORT_MEDIUM, VIEWPORT_DEFAULT, VIEWPORT_WIDE];

let server = null;
let userDataDir = null;
let demoRoot = null;
let windowRef = null;

app.setPath("userData", (userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwriting-vac-"))));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-http-cache");
// 确定性视口：强制 devicePixelRatio=1，offscreen capturePage 精确等于内容尺寸。
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// 视觉验收固定为 no-preference，始终验证产品自己的动画 CSS。
app.commandLine.appendSwitch("force-prefers-reduced-motion", "no-preference");

app.whenReady().then(() =>
  main()
    .then((result) => {
      console.log(result.output);
      cleanup(0);
    })
    .catch((error) => {
      console.error(error?.stack || String(error));
      cleanup(1);
    })
);

// ---------------------------------------------------------------------------
// CLI 解析 / 路径定位
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const index = argv.indexOf("--output");
  if (index < 0) {
    throw new Error("必须指定 --output <证据目录>（如 --output artifacts/visual-acceptance/<campaign>/round-01）");
  }
  const output = argv[index + 1];
  if (!output || output.trim() === "") {
    throw new Error("--output 缺少目录参数");
  }
  const themeIdx = argv.indexOf("--theme");
  const theme = themeIdx >= 0 ? argv[themeIdx + 1] : "light";
  if (!["light", "dark"].includes(theme)) {
    throw new Error(`--theme 只支持 light|dark（当前 ${theme}）`);
  }
  // Task 25：--mode round7 运行「真实渲染 + 三 viewport 机器断言」模式（输出
  // 每个 viewport 的 JSON {width,height,horizontalOverflow,overlaps,imageNonBlank}）。
  const modeIdx = argv.indexOf("--mode");
  const mode = modeIdx >= 0 ? argv[modeIdx + 1] : "campaign";
  if (!["campaign", "round7"].includes(mode)) {
    throw new Error(`--mode 只支持 campaign|round7（当前 ${mode}）`);
  }
  return { output: output.trim(), theme, mode };
}

// 证据必须落在主仓库（D:\WWriting）的 artifacts/ 下，即使脚本从 worktree 运行。
// worktree 的 <root>/.git 是一个文件，内容形如 "gitdir: D:/WWriting/.git/worktrees/<name>"；
// 主仓库根 = gitdir 路径中 ".git" 段之前的全部（worktrees/<name> → .git → <root>）。
function mainRepoRootOf(scriptDir) {
  const candidate = path.resolve(scriptDir, "..");
  const gitEntry = path.join(candidate, ".git");
  try {
    const stat = fs.statSync(gitEntry);
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    } else if (stat.isFile()) {
      const content = fs.readFileSync(gitEntry, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(content);
      if (match) {
        const gitDir = path.resolve(String(match[1]).trim());
        const parts = gitDir.split(/[\\/]+/);
        const dotGitIndex = parts.lastIndexOf(".git");
        if (dotGitIndex > 0) {
          const root = parts.slice(0, dotGitIndex).join(path.sep);
          if (fs.existsSync(path.join(root, "package.json"))) return root;
        }
      }
    }
  } catch {
    // 落到下方兜底
  }
  return candidate; // 兜底：当前仓库根（非 worktree 时即主仓库）
}

// --output 的相对路径按主仓库根解析（保证 brief 的完整命令在任何目录运行都落在
// 同一证据目录，符合仓库既有 artifact 约定）；绝对路径原样使用。
function resolveOutputDir(mainRepo, output) {
  return path.isAbsolute(output) ? output : path.join(mainRepo, output);
}

// ---------------------------------------------------------------------------
// 确定性 gateway：testGatewayFactory 注入点（与 testLoadDashboardData 同级）
// ---------------------------------------------------------------------------

// 步骤 DSL（按输入依次消费）：
//   { type: "reasoning", tokens: [..] }   —— 经 request.metadata.onReasoningToken 流式发送
//   { type: "hold" }                      —— 暂停当前 complete()，等测试控制器 release()
//   { type: "tool", name, arguments }     —— 返回工具调用（文本回复前闭合 reasoning）
//   { type: "reply", text }               —— 返回最终文本回复
function createTestGatewayFactory() {
  const gateways = new Map();
  const state = {
    stepQueue: [],        // [[steps...], [steps...]]，按输入排列
    holds: [],            // 当前 complete() 内已进入的 hold 记录
    waiters: [],          // waitForHold 的等待者
    callCount: 0,
    callLog: []           // 每次 complete() 的步骤消费与结果（诊断）
  };

  function release() {
    // 1) 让脚本的 waitForHold 立即返回（若尚未被 hold 进入时消费）
    const waiter = state.waiters.shift();
    if (waiter) waiter.resolve();
    // 2) 放行当前已进入的 hold（gateway 的 complete() 继续执行后续步骤）
    const holder = state.holds.shift();
    if (holder) holder.resolver();
    if (!waiter && !holder) state.pendingRelease = true;
    return true;
  }

  function waitForHold(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (state.pendingRelease) {
        state.pendingRelease = false;
        resolve();
        return;
      }
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = state.waiters.indexOf(waiter);
        if (i >= 0) state.waiters.splice(i, 1);
        reject(new Error(`waitForHold 超时（${timeoutMs}ms）：gateway 未进入 hold 点`));
      }, timeoutMs);
      state.waiters.push(waiter);
    });
  }

  function setScripts(scripts) {
    state.stepQueue = scripts.map((steps) => [...steps]);
  }

  async function runStep(step, request, signal) {
    switch (step.type) {
      case "reasoning": {
        const tokens = Array.isArray(step.tokens) ? step.tokens : [];
        for (const token of tokens) {
          if (signal?.aborted) throw abortError();
          if (typeof request?.metadata?.onReasoningToken === "function") {
            request.metadata.onReasoningToken(String(token));
          }
          // 极短间隔让 journal delta writer（24ms flush）把每段独立落盘
          await sleep(30);
        }
        return null;
      }
      case "hold": {
        if (state.pendingRelease) {
          state.pendingRelease = false;
          return null; // 已被提前放行：立即继续
        }
        const holder = { resolver: null };
        const parked = new Promise((resolve) => {
          holder.resolver = resolve;
        });
        state.holds.push(holder);
        if (state.waiters.length > 0) {
          state.waiters.shift().resolve();
        }
        await parked;
        return null;
      }
      case "tool": {
        const id = step.id ?? `call_vac_${crypto.randomUUID().slice(0, 8)}`;
        return { text: null, toolCalls: [{ id, name: String(step.name), arguments: step.arguments ?? {} }] };
      }
      case "reply": {
        return { text: String(step.text ?? ""), toolCalls: [] };
      }
      default:
        throw new Error(`未知 gateway 步骤类型: ${step?.type}`);
    }
  }

  async function complete(request, { signal } = {}) {
    state.callCount += 1;
    const callLog = { call: state.callCount, consumed: [], result: null };
    while (state.stepQueue.length > 0) {
      const current = state.stepQueue[0];
      while (current.length > 0) {
        const step = current.shift();
        callLog.consumed.push(step.type);
        const result = await runStep(step, request, signal);
        if (result) {
          callLog.result = step.type === "tool" ? `tool:${step.name}` : "reply";
          state.callLog.push(callLog);
          return result;
        }
      }
      state.stepQueue.shift();
    }
    callLog.result = "default";
    state.callLog.push(callLog);
    // 脚本耗尽：安全默认答复（防御，正常流程不会走到）
    return { text: "（capture 默认答复）", toolCalls: [] };
  }

  const gatewayFor = () => {
    let gateway = gateways.get("default");
    if (!gateway) {
      gateway = { complete };
      gateways.set("default", gateway);
    }
    return gateway;
  };

  return { gatewayFor, controller: { release, waitForHold, setScripts, state } };
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

// ---------------------------------------------------------------------------
// 注入的 skills service：临时 userHome + read() 延迟（read_skill 慢工具窗口）
// ---------------------------------------------------------------------------

function createDelayedSkillService({ userHome, delayMs }) {
  let real = null;
  const ensureReal = async () => {
    if (!real) {
      const { createSkillService } = await import(
        pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "skills", "index.mjs")).href
      );
      real = createSkillService({ userHome });
    }
    return real;
  };
  return {
    async catalog(args) {
      return (await ensureReal()).catalog(args);
    },
    async read(args) {
      await sleep(delayMs);
      return (await ensureReal()).read(args);
    },
    async importSkill(args) {
      return (await ensureReal()).importSkill(args);
    },
    async removeSkill(args) {
      return (await ensureReal()).removeSkill(args);
    },
    async migrationErrors(args) {
      return (await ensureReal()).migrationErrors(args);
    }
  };
}

// ---------------------------------------------------------------------------
// Electron / DOM 辅助
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function read(win, expression) {
  try {
    return await win.webContents.executeJavaScript(`(() => ${expression})()`);
  } catch (error) {
    console.error(`[read failed] expression: ${expression}\n  ${error?.message ?? error}`);
    throw error;
  }
}

async function waitUntil(win, expression, describe, timeoutMs = 8000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await read(win, expression)) return;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`等待超时: ${describe} (${expression})${lastError ? ` — ${lastError.message}` : ""}`);
}

// 合成 el.click() + elementFromPoint 中心命中测试（与 verify-app-clickability 同机制：
// 本会话 Electron 不投递真实指针事件，click 由合成事件触发同一套 DOM 处理）。
async function clickAndRead(win, selector, { label = selector, expect = null, settleMs = 200 } = {}) {
  const setup = await win.webContents.executeJavaScript(`
    (() => {
      window.__vacClick = window.__vacClick || { clicks: {}, errors: [] };
      const selector = ${JSON.stringify(selector)};
      const el = document.querySelector(selector);
      if (!el) return { present: false };
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
      const rect = el.getBoundingClientRect();
      const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      const hit = center.x > 0 && center.y > 0 ? document.elementFromPoint(center.x, center.y) : null;
      const hitTestable = Boolean(hit && (hit === el || el.contains(hit)));
      el.addEventListener("click", () => {
        window.__vacClick.clicks[selector] = (window.__vacClick.clicks[selector] || 0) + 1;
      }, { once: true });
      el.click();
      return { present: true, hitTestable, hitTag: hit ? hit.tagName : null };
    })()
  `);
  await sleep(settleMs);
  const after = await read(win, `window.__vacClick?.clicks?.[${JSON.stringify(selector)}] ?? 0`);
  const expectationPassed = expect ? await expect() : true;
  if (!setup.present) {
    throw new Error(`点击失败: ${label} — 元素不存在`);
  }
  if (!setup.hitTestable) {
    throw new Error(`点击失败: ${label} — 中心不可命中（顶层元素 ${setup.hitTag}）`);
  }
  if (after <= 0) {
    throw new Error(`点击失败: ${label} — 未触发 click`);
  }
  if (!expectationPassed) {
    throw new Error(`点击失败: ${label} — 期望 UI 状态未达成`);
  }
  return true;
}

async function overlayVisible(win, scrimId) {
  return read(win, `document.getElementById('${scrimId}').classList.contains('show')`);
}

async function setViewport(win, width, height) {
  win.setContentSize(width, height);
  win.webContents.invalidate(); // offscreen 表面强制下一帧
  await waitUntil(
    win,
    `Math.abs(window.innerWidth - ${width}) <= 2 && Math.abs(window.innerHeight - ${height}) <= 2`,
    `视口 ${width}x${height}`,
    6000
  );
  await sleep(600); // 布局/媒体查询稳定（round7 命中测试依赖，比 campaign 多等一帧）
}

// round7 专用重试点击：视口切换后 offscreen 合成器可能滞后一帧，命中测试失败
// 时重试几次（合成点击幂等，重试不改变 UI 语义）。
async function clickAndReadRetry(win, selector, options = {}, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await clickAndRead(win, selector, options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) {
        const diag = await read(win, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const r = el?.getBoundingClientRect?.();
          const points = [];
          if (r) {
            for (const [dx, dy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.75]]) {
              const x = Math.round(r.left + r.width * dx);
              const y = Math.round(r.top + r.height * dy);
              const hit = x > 0 && y > 0 ? document.elementFromPoint(x, y) : null;
              points.push({ x, y, hit: hit ? (hit.id || hit.className || hit.tagName) : null });
            }
          }
          return {
            inner: [window.innerWidth, window.innerHeight],
            rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
            display: el ? getComputedStyle(el).display : null,
            points
          };
        })()`);
        console.error(`[click retry diag] ${options.label ?? selector}: ${JSON.stringify(diag)}`);
      }
      win.webContents.invalidate();
      await sleep(400);
    }
  }
  throw new Error(`点击失败（重试 ${attempts} 次）: ${options.label ?? selector} — ${lastError?.message ?? String(lastError)}`);
}

// ---------------------------------------------------------------------------
// DOM 审计：motion uniqueness 客观证据（开放 activity ID + live class 数量）
// ---------------------------------------------------------------------------

const AUDIT_SCRIPT = `(() => {
  const isAnimated = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return cs.animationName !== "none" && (cs.animationPlayState === "running" || cs.animationPlayState === "paused");
  };
  const groups = [...document.querySelectorAll("details.agent-work-group")];
  const openActivityIds = [];
  const visibleAnimatedLabels = [];
  let groupHeaderAnimated = false;
  let expandedGroupHeaderAnimated = false;
  for (const group of groups) {
    for (const item of group.querySelectorAll('.agent-work-item[data-state="running"]')) {
      const id = item.dataset.itemId;
      if (id) openActivityIds.push(id);
    }
    for (const label of group.querySelectorAll(".agent-work-item__label.agent-live-text")) {
      if (isAnimated(label)) {
        const text = (label.textContent || "").trim();
        if (text) visibleAnimatedLabels.push(text);
      }
    }
    const status = group.querySelector(".agent-work-status");
    const headerAnimating = Boolean(status && status.classList.contains("agent-live-text") && isAnimated(status));
    if (headerAnimating) {
      groupHeaderAnimated = true;
      if (group.hasAttribute("open")) expandedGroupHeaderAnimated = true;
    }
  }
  return {
    openActivityIds,
    visibleAnimatedLabels,
    visibleAnimatedCount: visibleAnimatedLabels.length,
    groupHeaderAnimated,
    expandedGroupHeaderAnimated,
    timestamp: Date.now()
  };
})()`;

async function runDomAudit(win) {
  return read(win, AUDIT_SCRIPT);
}

function auditModeOf(scenario) {
  // sequential：运行中（允许恰好 1 个动效文字）；terminal：终态/静态（必须 0 个）
  return ["reasoning-running", "tool-after-reasoning"].includes(scenario)
    ? "sequential"
    : "terminal";
}

function validateAudit(audit, scenario, mode) {
  const problems = [];
  if (mode === "sequential" && audit.visibleAnimatedCount > 1) {
    problems.push(`sequential 场景 ${scenario} 同时出现 ${audit.visibleAnimatedCount} 个动效文字（>1，违反动效唯一性）`);
  }
  if (mode === "terminal" && audit.visibleAnimatedCount > 0) {
    problems.push(`终态场景 ${scenario} 残留 ${audit.visibleAnimatedCount} 个动效文字（应为 0）`);
  }
  if (audit.expandedGroupHeaderAnimated) {
    problems.push(`展开工作组中外层"工作中"同时扫光（${scenario}，groupHeaderAnimated=true）`);
  }
  if (problems.length > 0) {
    throw new Error(`动效唯一性审计失败: ${problems.join("；")} — 采集脚本退出 1，不交给视觉模型掩盖。`);
  }
  return audit;
}

// ---------------------------------------------------------------------------
// 非主观检查 + 截图
// ---------------------------------------------------------------------------

function verifyImagePixels(image, width, height) {
  const size = image.getSize(); // Electron NativeImage.getSize() → { width, height }
  const w = size.width;
  const h = size.height;
  const problems = [];
  if (w !== width || h !== height) {
    problems.push(`图片尺寸 ${w}x${h} != 期望 ${width}x${height}`);
  }
  const bitmap = image.toBitmap(); // Windows: BGRA
  const stride = w * 4;
  let nonWhite = 0;
  let opaque = 0;
  for (let y = 0; y < h && y < 4096; y += 1) {
    const row = y * stride;
    for (let x = 0; x < w; x += 4) {
      const i = row + x * 4;
      const alpha = bitmap[i + 3];
      const isWhite = bitmap[i] >= 248 && bitmap[i + 1] >= 248 && bitmap[i + 2] >= 248;
      if (!isWhite) nonWhite += 1;
      if (alpha > 0) opaque += 1;
    }
  }
  if (nonWhite === 0) problems.push("整图全白（无内容）");
  if (opaque === 0) problems.push("整图全透明");
  return { pass: problems.length === 0, problems, nonWhite, opaque };
}

async function checkHorizontalOverflow(win) {
  const result = await read(win, `({
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body ? document.body.scrollWidth : 0,
    innerW: window.innerWidth
  })`);
  const max = Math.max(result.scrollW, result.bodyScrollW);
  if (max > result.innerW + 1) {
    return `页面横向 overflow: scrollWidth=${max} > innerWidth=${result.innerW}`;
  }
  return null;
}

// 关键 selector 的 bounding box 两两不相交（祖先/子孙对排除；1px 容差）。
async function checkNoOverlap(win, selectors) {
  return read(
    win,
    `(() => {
      const sels = ${JSON.stringify(selectors)};
      const clipRect = (el) => {
        const r = el.getBoundingClientRect();
        let ancestor = el.parentElement;
        let clip = null;
        while (ancestor && ancestor !== document.documentElement) {
          const cs = getComputedStyle(ancestor);
          if (/(auto|scroll|hidden)/.test(cs.overflowY) || /(auto|scroll|hidden)/.test(cs.overflowX)) {
            const ar = ancestor.getBoundingClientRect();
            clip = {
              left: Math.max(ar.left, 0),
              top: Math.max(ar.top, 0),
              right: Math.min(ar.right, window.innerWidth),
              bottom: Math.min(ar.bottom, window.innerHeight)
            };
            break;
          }
          ancestor = ancestor.parentElement;
        }
        return {
          left: Math.max(r.left, clip ? clip.left : 0),
          top: Math.max(r.top, clip ? clip.top : 0),
          right: Math.min(r.right, clip ? clip.right : window.innerWidth),
          bottom: Math.min(r.bottom, clip ? clip.bottom : window.innerHeight)
        };
      };
      const els = sels.map((sel) => document.querySelector(sel)).filter(Boolean)
        .map((el) => ({ el, rect: clipRect(el) }))
        .filter((entry) => entry.rect.right > entry.rect.left && entry.rect.bottom > entry.rect.top);
      const pairs = [];
      for (let i = 0; i < els.length; i += 1) {
        for (let j = i + 1; j < els.length; j += 1) {
          const a = els[i], b = els[j];
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const ra = a.rect, rb = b.rect;
          const overlap = ra.left < rb.right - 1 && rb.left < ra.right - 1 && ra.top < rb.bottom - 1 && rb.top < ra.bottom - 1;
          if (overlap) {
            pairs.push(String(a.el.className || a.el.tagName) + " <-> " + String(b.el.className || b.el.tagName));
          }
        }
      }
      return { ok: pairs.length === 0, pairs };
    })()`
  );
}

// 每个场景的关键 selector 集（用于 bbox 不相交检查）。
const OVERLAP_SELECTORS = {
  chat: [
    ".agent-message",
    ".agent-work-group",
    ".agent-composer"
  ],
  settings: [
    ".sp-section-item",
    ".sp-section-panel",
    "#settings-x",
    ".spd-skill-row--readonly",
    "#skills-list"
  ],
  drawer: [
    ".drawer-tabs",
    "#drawer-body",
    "#drawer-close"
  ]
};

// 截图 + 审计 + 全部非主观检查，一条龙。
async function auditAndCapture(win, ctx, spec) {
  // 1) motion DOM 审计（每个 motion frame 捕获前执行）
  const audit = await runDomAudit(win);
  const mode = auditModeOf(spec.scenario);
  validateAudit(audit, spec.scenario, mode);
  ctx.auditRecords[spec.file] = {
    file: spec.file,
    scenario: spec.scenario,
    viewport: `${spec.viewport[0]}x${spec.viewport[1]}`,
    mode,
    openActivityIds: audit.openActivityIds,
    visibleAnimatedLabels: audit.visibleAnimatedLabels,
    visibleAnimatedCount: audit.visibleAnimatedCount,
    groupHeaderAnimated: audit.groupHeaderAnimated,
    parallel_runtime_supported: false
  };

  // 2) capturePage（offscreen 在 setContentSize 后可能出现一帧空白：重试至非空白）
  const [width, height] = spec.viewport;
  let image = null;
  let pixelCheck = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    image = await windowRef.webContents.capturePage();
    pixelCheck = verifyImagePixels(image, width, height);
    if (!pixelCheck.problems.includes("整图全白（无内容）")) break;
    await sleep(250);
    windowRef.webContents.invalidate();
  }

  // 3) 页面级非主观检查 + 场景客观检查
  const overflow = await checkHorizontalOverflow(win);
  const overlap = await checkNoOverlap(win, spec.overlapSelectors);
  const extraResults = spec.extraChecks ? await spec.extraChecks(win) : [];

  // 记录 motion 帧的 live label bbox（sweep-direction 检查用）
  if (spec.sweepPhase != null) {
    const bbox = await read(win, `(() => {
      const el = document.querySelector(".agent-work-item__label.agent-live-text");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    })()`);
    ctx.sweepFrames.push({ scenario: spec.scenario, file: spec.file, phase: spec.sweepPhase, bbox });
  }

  const problems = [
    ...pixelCheck.problems,
    ...(overflow ? [overflow] : []),
    ...(overlap.ok ? [] : [`关键 selector bounding box 相交: ${overlap.pairs.join("; ")}`]),
    ...extraResults.filter((r) => !r.pass).map((r) => `客观检查失败 [${r.name}]: ${r.detail}`)
  ];
  if (problems.length > 0) {
    throw new Error(`${spec.file} 非主观检查失败: ${problems.join(" | ")}`);
  }

  const png = image.toPNG();
  const sha256 = crypto.createHash("sha256").update(png).digest("hex");
  fs.writeFileSync(path.join(ctx.roundDir, spec.file), png);

  ctx.manifest.push({
    file: spec.file,
    absolutePath: path.join(ctx.roundDir, spec.file),
    viewport: `${width}x${height}`,
    scenario: spec.scenario,
    state: spec.state,
    dataSource: spec.dataSource,
    parallel_runtime_supported: false,
    expected: spec.expected,
    spec: spec.spec,
    sha256,
    bytes: png.length
  });
  ctx.checkRows.push({
    file: spec.file,
    imageSize: `${width}x${height}`,
    pixels: pixelCheck.pass ? "PASS" : "FAIL",
    overflow: overflow ? "FAIL" : "PASS",
    overlap: overlap.ok ? "PASS" : "FAIL",
    extra: extraResults
  });
  const extraText = extraResults.length > 0
    ? `  [客观检查] ${extraResults.map((r) => `${r.name}=${r.pass ? "PASS" : "FAIL"}`).join(", ")}`
    : "";
  console.log(`  ✓ ${spec.file}  (${width}x${height}, ${png.length} B, sha256 ${sha256.slice(0, 12)}…)${extraText}`);
}

// 场景客观检查：返回 [{ name, pass, detail }]。
const EXTRA_CHECKS = {
  // Markdown 宽表格：包装层负责滚动，表格保持 760px，窄视口必须真实溢出。
  markdownTableScroll: async (win, { requireOverflow = false } = {}) => {
    const overflowRequirement = requireOverflow ? " && actualOverflow" : "";
    const result = await read(win, `(() => {
      const container = document.querySelector(".agent-markdown-table-scroll");
      const table = container?.querySelector("table");
      if (!container || !table) return { pass: false, detail: "未找到 Markdown 表格滚动层" };
      const cs = getComputedStyle(container);
      const scrollContainer = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const actualOverflow = container.scrollWidth > container.clientWidth;
      return {
        pass: scrollContainer${overflowRequirement},
        detail: "overflowX=" + cs.overflowX +
          " scrollWidth=" + container.scrollWidth + " clientWidth=" + container.clientWidth +
          " tableWidth=" + Math.round(table.getBoundingClientRect().width)
      };
    })()`);
    return [{ name: "markdown-table-scroll", pass: result.pass, detail: result.detail }];
  },
  // 任务列表渲染出 [x]（checked）与 [ ]（未勾选）两类状态
  taskListStates: async (win) => {
    const result = await read(win, `(() => {
      const boxes = [...document.querySelectorAll(".agent-markdown input[type=checkbox]")];
      if (boxes.length === 0) return { pass: false, detail: "未找到任务列表 checkbox" };
      const checked = boxes.filter((b) => b.checked).length;
      const unchecked = boxes.length - checked;
      return { pass: checked >= 1 && unchecked >= 1, detail: "total=" + boxes.length + " checked=" + checked + " unchecked=" + unchecked };
    })()`);
    return [{ name: "task-list-states", pass: result.pass, detail: result.detail }];
  },
  // 内置风格详情：只读详情正文非空、无启用/删除/编辑控件
  builtinStyleDetail: async (win) => {
    const result = await read(win, `(() => {
      const back = document.getElementById("skills-detail-back");
      const body = document.querySelector(".spd-skill-detail-body");
      if (!back || !body) return { pass: false, detail: "back=" + Boolean(back) + " body=" + Boolean(body) };
      const controls = [...document.querySelectorAll(".spd-skill-detail-body .spd-skill-toggle, .spd-skill-detail-body .spd-skill-del, .spd-skill-detail-body .spd-skill-edit")].length;
      return {
        pass: (body.textContent || "").length > 0 && controls === 0,
        detail: "bodyLen=" + (body.textContent || "").length + " controls=" + controls
      };
    })()`);
    return [{ name: "builtin-style-detail", pass: result.pass, detail: result.detail }];
  },
  // 普通文件夹第一条消息：无错误卡、无读取失败、composer 可用
  plainFolderFirstMessage: async (win) => {
    const result = await read(win, `(() => ({
      title: document.getElementById("project-title")?.textContent ?? null,
      errorCards: document.querySelectorAll('[data-testid="agent-error"]').length,
      userMessages: document.querySelectorAll('[data-testid="agent-user-message"]').length,
      assistantMessages: document.querySelectorAll('[data-testid="agent-assistant-message"]').length,
      workStatus: document.querySelector(".agent-work-status")?.textContent ?? null,
      composerDisabled: document.querySelector('[data-testid="agent-composer-input"]')?.disabled ?? null
    }))()`);
    const pass = result.title !== "读取失败" && result.errorCards === 0 && result.userMessages >= 1 && result.assistantMessages >= 1 && (result.workStatus ?? "").includes("工作了") && result.composerDisabled === false;
    return [{ name: "plain-folder-first-message", pass, detail: JSON.stringify(result) }];
  },
  // Round10 视觉证据：390 顶栏项目标题必须有可识别宽度（plan chip 释放标题空间后）。
  narrowTopbarTitle: async (win) => {
    const result = await read(win, `(() => {
      const title = document.getElementById("project-title");
      const rect = title?.getBoundingClientRect();
      return { pass: Boolean(rect && rect.width >= 72), width: rect?.width ?? 0 };
    })()`);
    return [{ name: "narrow-topbar-title", pass: result.pass, detail: `width=${result.width}` }];
  },
  // 设置页内置风格三行全部真实可见（bbox 与视口相交），且关闭按钮不被遮挡。
  settingsBuiltinRowsVisible: async (win) => {
    const result = await read(win, `(() => {
      const rows = [...document.querySelectorAll(".spd-skill-row--readonly")];
      const visible = rows.filter((row) => {
        const r = row.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      });
      const closeEl = document.getElementById("settings-x");
      const close = closeEl?.getBoundingClientRect();
      const closeInside = Boolean(close && close.left >= 0 && close.top >= 0 && close.right <= innerWidth && close.bottom <= innerHeight);
      const modal = document.querySelector(".settings-modal")?.getBoundingClientRect();
      const scrim = document.querySelector(".settings-scrim")?.getBoundingClientRect();
      const detail = {
        pass: rows.length === 3 && visible.length === 3 && closeInside,
        rows: rows.length, visible: visible.length, closeInside,
        close: close ? { l: Math.round(close.left), t: Math.round(close.top), r: Math.round(close.right), b: Math.round(close.bottom), w: Math.round(close.width), h: Math.round(close.height) } : null,
        modal: modal ? { l: Math.round(modal.left), t: Math.round(modal.top), r: Math.round(modal.right), b: Math.round(modal.bottom) } : null,
        scrim: scrim ? { l: Math.round(scrim.left), t: Math.round(scrim.top), r: Math.round(scrim.right), b: Math.round(scrim.bottom) } : null,
        scrollY: Math.round(document.scrollingElement?.scrollTop ?? 0),
        bodyScrollY: Math.round(document.body?.scrollTop ?? 0),
        inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
        detailScroll: (() => { const d = document.querySelector(".sp-detail"); if (!d) return null; return { top: Math.round(d.scrollTop), h: d.scrollHeight, client: d.clientHeight }; })(),
(),
        scrimPos: getComputedStyle(document.querySelector(".settings-scrim")).position,
        docScrollH: document.documentElement.scrollHeight, docClientH: document.documentElement.clientHeight,
        bodyScrollH: document.body?.scrollHeight ?? null, bodyClientH: document.body?.clientHeight ?? null,
        scrimParent: (() => { const s = document.querySelector(".settings-scrim"); if (!s) return null; return { tag: s.offsetParent?.tagName ?? null, cls: s.offsetParent?.className ?? null }; })(),
        scrollables: (() => { const out = []; for (const el of document.querySelectorAll("*")) { if (el.scrollHeight > el.clientHeight + 1) { out.push({ sel: el.id ? "#" + el.id : el.className?.toString?.().slice(0, 40) || el.tagName, sh: el.scrollHeight, ch: el.clientHeight }); } } return out.slice(0, 12); })()
      };
      return detail;
    })()`);
    return [{ name: "settings-builtin-visible", pass: result.pass, detail: JSON.stringify(result) }];
  },
  // 记忆三卡正文均已渲染（故事摘要/工作日志内容非空；设定档案至少渲染出空态文案）。
  memoryCardsReady: async (win) => {
    const result = await read(win, `(() => {
      const cards = [...document.querySelectorAll(".memory-card")];
      const contents = cards.map((card) => card.querySelector(".memory-card-content")?.textContent.trim() ?? "");
      return { pass: cards.length === 3 && contents.every(Boolean), cards: cards.length, contents };
    })()`);
    return [{ name: "memory-cards-ready", pass: result.pass, detail: JSON.stringify(result) }];
  },
  // 计划下拉在命中测试的最上层（elementFromPoint 命中自身或后代）。
  planDropdownTopmost: async (win) => {
    const result = await read(win, `(() => {
      const dropdown = document.querySelector("[data-plan-dropdown]");
      const rect = dropdown?.getBoundingClientRect();
      if (!dropdown || !rect || dropdown.hidden) return { pass: false, detail: "dropdown hidden" };
      const x = Math.min(rect.right - 8, Math.max(rect.left + 8, rect.left + rect.width / 2));
      const y = Math.min(rect.bottom - 8, Math.max(rect.top + 8, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return { pass: Boolean(hit && (hit === dropdown || dropdown.contains(hit))), hit: hit?.className ?? hit?.tagName ?? null };
    })()`);
    return [{ name: "plan-dropdown-topmost", pass: result.pass, detail: JSON.stringify(result) }];
  }
};

// ---------------------------------------------------------------------------
// 场景内容契约（新世界语义：无字数/质量门禁、自然语言驱动）
// ---------------------------------------------------------------------------

// 第一轮思考：足够长，让完成态工作组与时间线内容丰富；内容围绕风格技能、项目
// 记忆与字数工具，不出现字数/质量门禁语义。
const TURN1_REASONING = (() => {
  const lines = [
    "收到按快节奏易读风格写一个短章节的请求，先确认写作约束与项目记忆，避免凭空发挥。",
    "总体方案：先读取内置风格技能，核对项目记忆里的当前要求，再规划短章节并落笔。"
  ];
  for (let chapter = 1; chapter <= 12; chapter += 1) {
    lines.push(`第 ${chapter} 步检查：确认风格选择依据，题材与目标读者是否支持快节奏易读。`);
    lines.push(`再核对项目记忆里的当前有效要求，避免与已确认事实冲突。`);
    lines.push(`确认本章的冲突进入点、段落信息密度与结尾悬念是否符合风格目标。`);
    if (chapter % 3 === 0) {
      lines.push(`本组检查后把新的长期事实补充进项目记忆，不把聊天历史机械追加。`);
    }
  }
  lines.push("以上检查全部按顺序完成，随后直接落笔短章节并调用字数工具核对实际字数。");
  return lines;
})();
const TURN1_REASONING_TEXT = TURN1_REASONING.join("");

// 计划：全部完成（本次工作已收尾；只保留唯一当前项加粗的视觉契约交给 reviewer）
const PLAN_COMPLETED = {
  explanation: "按快节奏易读风格完成短章节",
  items: [
    { id: "p1", step: "读取内置风格技能", status: "completed" },
    { id: "p2", step: "核对项目记忆", status: "completed" },
    { id: "p3", step: "撰写短章节并统计字数", status: "completed" }
  ]
};

const REPLY_A = [
  "短章节已经写好，正文落在 正文/第001章.md。",
  "",
  "写作时按快节奏易读风格推进：场景尽快进入冲突，段落以短句和明确动词为主，章节结尾留了新的变化。",
  "",
  "同时调用字数工具核对了实际字数，并把风格技能 ID 与本章进度更新进了项目记忆，后续新对话可以按索引恢复。"
].join("\n");

// Markdown 渲染样例：H1–H6、正文、strong、链接、blockquote、inline code、
// fenced code，外加多状态任务列表与超 760px 列的宽 GFM 表格（触发容器内横向
// 滚动，页面级不溢出）。不出现字数/质量门禁字段。
const MARKDOWN_SAMPLE = [
  "# 一级标题",
  "",
  "正文段落：这是普通正文文字，用于检查正文行高与字重。",
  "",
  "## 二级标题",
  "",
  "**加粗文字** 与 [外部链接](https://example.com) 与 `行内代码`。",
  "",
  "### 三级标题",
  "",
  "> 引用块：左侧应有边线，颜色略浅于正文。",
  "",
  "#### 四级标题",
  "",
  "##### 五级标题",
  "",
  "###### 六级标题",
  "",
  "```js",
  "const greeting = \"hello\";",
  "console.log(greeting);",
  "```",
  "",
  "## 任务清单",
  "",
  "- [x] 已完成：确认风格技能",
  "- [x] 已完成：核对项目记忆",
  "- [ ] 待办：续写下一章",
  "- [ ] 待办：更新权威文件索引",
  "",
  "## 章节进度表（宽表格：正文列 760px 封顶，超宽时容器内横向滚动）",
  "",
  "| 章节 | 标题 | 状态 | 风格 | 记忆备注 |",
  "|---|---|---|---|---|",
  "| 第 1 章 | 雨夜来信——开场悬念与人物登场的建立 | 已提交 | 快节奏易读 | 与项目记忆一致 |",
  "| 第 2 章 | 城中旧事——人物关系推进与冲突升级的节奏 | 草稿中 | 快节奏易读 | 等待确认后再定稿 |",
  "| 第 3 章 | 阁楼的旧信——线索回收与真相铺垫的展开 | 草稿中 | 待定 | 尚未开始动笔 |",
  "| 第 4 章 | 空屋灯火——转折与收束的节奏控制要点 | 未开始 | — | 等待大纲更新后再动笔 |",
  "| 第 5 章 | 黎明之前——终章前的高潮与伏笔收束计划 | 未开始 | — | 计划为下一阶段预留 |"
].join("\n");

// 数据来源说明（MANIFEST 每行记录）
const DATA_SOURCE = {
  gatewayUi: "testGatewayFactory 确定性脚本 + 真实 /api/agent/input（composer UI 点击）+ journal SSE 实时渲染",
  uiClick: "真实 UI 点击 + 真实 /api/agent/input + journal SSE 实时渲染",
  settings: "真实 UI 点击打开设置 + 真实 /api/skills/catalog",
  settingsDetail: "真实 UI 点击内置风格行 + 真实 /api/skills/:name 只读详情",
  drawer: "真实 UI 点击顶部面板按钮（章节分区）",
  plainFolder: "真实 /api/projects/open 普通文件夹 + 真实 UI 打开流程 + composer 发送第一条消息",
  versionPanel: "真实 UI 点击抽屉章节行历史按钮 + version-panel 组件（暂无历史版本或含版本列表）",
  memoryTab: "真实 UI 点击抽屉记忆分区 tab（data-dtab=memory）",
  planPanel: "真实 UI 点击顶栏任务计划 chip + plan-panel 组件展开/收起"
};

// ---------------------------------------------------------------------------
// 场景驱动
// ---------------------------------------------------------------------------

async function submitViaComposer(win, text) {
  // 项目打开前 composer 是 hidden（display:none），input/send 虽在 DOM 但 rect 全零、
  // 命中测试落在视口原点返回 <html>。先等待 composer 可见且发送可用再提交
  // （与 verify-app-clickability 的 waitForComposerEnabled 同款护栏）。
  await waitUntil(
    win,
    `(() => {
      const c = document.querySelector('.agent-composer');
      const i = document.querySelector('[data-testid="agent-composer-input"]');
      const s = document.querySelector('[data-testid="agent-send"]');
      return Boolean(c && !c.hidden && i && !i.disabled && s && !s.disabled);
    })()`,
    "composer 可见且发送可用",
    15000
  );
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('[data-testid="agent-composer-input"]');
      if (!input) return { ok: false, reason: "composer input missing" };
      const send = document.querySelector('[data-testid="agent-send"]');
      if (!send) return { ok: false, reason: "send button missing" };
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const rect = send.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
      const hitTestable = Boolean(hit && (hit === send || send.contains(hit)));
      send.click();
      return { ok: true, hitTestable, hitTag: hit ? hit.tagName : null };
    })()
  `);
  assert.equal(result.ok, true, `composer 提交失败: ${result.reason}`);
  assert.equal(result.hitTestable, true, `发送按钮中心不可命中（顶层 ${result.hitTag}）`);
}

const LAST_GROUP = `[...document.querySelectorAll("details.agent-work-group")].at(-1)`;

async function waitForReasoningRunning(win) {
  await waitUntil(
    win,
    `(() => {
      const label = document.querySelector('.agent-work-item[data-kind="reasoning"][data-state="running"] .agent-work-item__label');
      return Boolean(label && label.textContent.includes("思考中") && getComputedStyle(label).animationName !== "none");
    })()`,
    "reasoning 运行态（思考中 + 动画）",
    10000
  );
}

async function waitForToolRunning(win, labelText) {
  await waitUntil(
    win,
    `(() => {
      const label = document.querySelector('.agent-work-item[data-kind="tool"][data-state="running"] .agent-work-item__label');
      return Boolean(label && label.textContent.includes(${JSON.stringify(labelText)}) && getComputedStyle(label).animationName !== "none");
    })()`,
    `工具运行态（${labelText} + 动画）`,
    10000
  );
}

async function waitForRunTerminal(win, groupOpen, diag = {}, minGroups = 1) {
  const deadline = Date.now() + 25000;
  let terminal = null;
  while (Date.now() < deadline) {
    terminal = await read(win, `(() => {
      const groups = [...document.querySelectorAll("details.agent-work-group")];
      const g = groups.at(-1);
      const status = g?.querySelector(".agent-work-status")?.textContent || "";
      return {
        done: Boolean(
          groups.length >= ${minGroups} &&
          g && status.includes("工作了") && g.open === ${groupOpen}
        ),
        groups: groups.length,
        open: g?.open ?? null,
        status: status.slice(0, 60),
        workStatus: document.querySelector(".agent-work-status")?.textContent ?? null,
        runHidden: document.querySelector("[data-testid='agent-run']")?.hidden ?? null
      };
    })()`);
    if (terminal.done) return;
    await sleep(150);
  }
  // 诊断：journal 层 session 状态，区分「Run 未完成」与「UI 未反映」
  let journal = null;
  if (diag.port && diag.projectRoot) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${diag.port}/api/agent/snapshot?projectRoot=${encodeURIComponent(diag.projectRoot)}&afterSeq=0&limit=1000`
      );
      const data = await response.json();
      const lastTypes = (data.events ?? []).slice(-12).map((e) => e.type);
      journal = { session: data.session?.status, run: data.session?.active_run?.status, lastTypes };
    } catch (error) {
      journal = { error: error?.message ?? String(error) };
    }
  }
  throw new Error(`Run 终态超时: DOM=${JSON.stringify(terminal)} journal=${JSON.stringify(journal)}`);
}

async function waitForSkillsList(win) {
  await waitUntil(
    win,
    `(() => {
      const expected = ${JSON.stringify(BUILTIN_STYLE_NAMES)};
      const rows = [...document.querySelectorAll(".spd-skill-row--readonly")];
      const names = new Set(rows.map((row) => row.dataset.skillName));
      return rows.length === 3 && expected.every((name) => names.has(name));
    })()`,
    "三个内置写作风格只读行渲染",
    12000
  );
}

async function focusBuiltinStylesForCapture(win) {
  await win.webContents.executeJavaScript(`(() => {
    const first = document.querySelector(".spd-skill-row--readonly");
    first?.scrollIntoView({ block: "start" });
    return Boolean(first);
  })()`);
  await sleep(200);
}

async function scrollConversationToBottom(win) {
  await win.webContents.executeJavaScript(`(() => {
    const conv = document.querySelector('[data-testid="agent-conversation"]');
    if (conv) conv.scrollTop = conv.scrollHeight;
    return true;
  })()`);
  await sleep(250);
}

// 用 Web Animations API 把 live 标签的扫光动画暂停并 seek 到指定相位，使扫光带
// 确定性地位于标签左/中/右。动画名动态匹配（Round10 起为 agent-label-shine；
// OS reduced-motion 归一化注入时为 agent-text-shimmer），相位按实际 duration
// 等比换算（SHIMMER_BASE_PERIOD_MS 基准）。找不到动画时返回 0，由调用方回退
// 时间捕获并记录警告。
async function seekShimmerPhase(win, ctx, phaseMs) {
  const paused = await win.webContents.executeJavaScript(`(() => {
    let count = 0;
    for (const el of document.querySelectorAll(".agent-work-item__label.agent-live-text")) {
      const name = getComputedStyle(el).animationName;
      if (name === "none") continue;
      for (const anim of el.getAnimations()) {
        if (anim.animationName !== name) continue;
        const timing = anim.effect?.getTiming?.();
        const duration = Number(timing?.duration);
        const t = Number.isFinite(duration) && duration > 0
          ? (${phaseMs} / ${SHIMMER_BASE_PERIOD_MS}) * duration
          : ${phaseMs};
        anim.pause();
        anim.currentTime = t;
        count += 1;
      }
    }
    return count;
  })()`);
  if (paused === 0) {
    ctx.environmentNotes.push(`[warn] seekShimmerPhase(${phaseMs}ms) 未找到 live 标签动画，回退时间捕获`);
  }
  win.webContents.invalidate();
  await sleep(150); // 等合成器应用 seeking 后的帧
  return paused;
}

// 对同一场景的三帧 PNG，在 label bbox 内跟踪扫光带：Round10 的 label-shine 是
// muted↔透明渐变（background-clip:text），没有旧版 agent-text-shimmer 的 ink 暗带，
// 因此按「字形列」判据——浅色下字形列 = 列内最暗像素 < 128（muted 字形暗、透明带
// 字形露出底色亮、空隙列无暗像素）；深色下字形列 = 列内最亮像素 > 128（muted 字形
// 亮、透明带字形露出暗底色、空隙列无亮像素）。跟踪字形列集合的质心 x：扫光带移动
// 时字形列集合边界随之变化。断言三帧质心互不相同且跨度 ≥2px，给出扫光随相位移动
// 的机器证据（方向由 label-shine 关键帧决定，不预设左→右）。
async function checkSweepDirection(ctx, scenario, frames) {
  const isDark = ctx.theme === "dark";
  const positions = [];
  for (const frame of frames) {
    const img = nativeImage.createFromPath(path.join(ctx.roundDir, frame.file));
    const { width: w, height: h } = img.getSize();
    const bmp = img.toBitmap();
    const [left, top, width, height] = frame.bbox;
    const glyphCols = [];
    for (let x = left; x < left + width && x < w; x += 1) {
      let colMin = 256;
      let colMax = -1;
      for (let y = top; y < top + height && y < h; y += 1) {
        const i = (y * w + x) * 4;
        const lum = 0.3 * bmp[i] + 0.59 * bmp[i + 1] + 0.11 * bmp[i + 2];
        if (lum < colMin) colMin = lum;
        if (lum > colMax) colMax = lum;
      }
      const isGlyphCol = isDark ? colMax > 128 : colMin < 128;
      if (isGlyphCol) glyphCols.push(x);
    }
    const centroid = glyphCols.length > 0
      ? Math.round(glyphCols.reduce((sum, x) => sum + x, 0) / glyphCols.length)
      : -1;
    positions.push({ file: frame.file, centroid, glyphCols: glyphCols.length });
  }
  const [a, b, c] = positions;
  const span = Math.abs(c.centroid - a.centroid);
  const ok = a.centroid >= 0 && b.centroid >= 0 && c.centroid >= 0 &&
    a.centroid !== b.centroid && b.centroid !== c.centroid && span >= 2;
  const summary = positions.map((p) => `${p.file.split("-")[0]}=x${p.centroid}(cols${p.glyphCols})`).join(" ");
  console.log(`  [客观检查] sweep-direction(${scenario}, ${ctx.theme}) ${ok ? "PASS" : "FAIL"} — ${summary}`);
  if (!ok) {
    throw new Error(`sweep-direction 检查失败（${scenario}, ${ctx.theme}）：字形列质心未随扫光相位移动 — ${JSON.stringify(positions)}`);
  }
  return { ok, positions };
}

async function waitForSettingsSection(win, section) {
  const ok = await (async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await read(win, `document.querySelector('.sp-section-item[data-section="${section}"]')?.classList.contains("on")`)) return true;
      await sleep(120);
    }
    return false;
  })();
  if (!ok) {
    const dump = await read(win, `(() => ({
      scrim: document.getElementById("settings-scrim")?.classList.contains("show") ?? null,
      modal: Boolean(document.querySelector("#settings-modal")),
      navItems: [...document.querySelectorAll(".sp-section-item")].map((el) => ({
        section: el.dataset.section,
        on: el.classList.contains("on")
      })),
      sideSection: document.querySelector(".sp-side")?.dataset.section ?? null
    }))()`);
    throw new Error(`设置分区 ${section} 激活超时。settings DOM: ${JSON.stringify(dump)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const { output, theme, mode } = parseArgs(process.argv.slice(2));
  const mainRepo = mainRepoRootOf(SCRIPT_DIR);
  const roundDir = resolveOutputDir(mainRepo, output);
  if (fs.existsSync(roundDir)) {
    const entries = fs.readdirSync(roundDir);
    if (entries.length > 0) {
      throw new Error(`证据目录已存在且非空（禁止覆盖上一轮）: ${roundDir}`);
    }
    // 上次失败运行留下的空目录：删除后重建，不算覆盖有效证据
    fs.rmdirSync(roundDir);
  }
  fs.mkdirSync(roundDir, { recursive: true });

  // Task 25：round7 模式——真实渲染三 viewport 机器断言（不依赖视觉模型）。
  if (mode === "round7") {
    const lines = await runRound7({ mainRepo, roundDir, theme });
    return { output: ["", "round7 视觉验收完成。", `Evidence directory: ${roundDir}`, ""].join("\n") + lines.join("\n") + "\n" };
  }

  const startedAt = new Date().toISOString();
  const context = {
    output,
    roundDir,
    mainRepo,
    theme,
    manifest: [],
    checkRows: [],
    sweepFrames: [],
    auditRecords: {},
    environmentNotes: []
  };
  console.log(`[capture-visual-acceptance] ${path.basename(roundDir)}`);
  console.log(`  证据目录: ${roundDir}`);

  // ---- 测试项目 + 临时技能 home（read_skill 走临时 root，不碰真实用户目录）----
  demoRoot = path.join(SCRIPT_DIR, "..", ".demo_runs", `visual-acceptance-${Date.now()}`);
  const skillsHome = path.join(demoRoot, "skills-home");
  fs.mkdirSync(skillsHome, { recursive: true });
  const { createProjectAt, upsertChapter } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "project-store.mjs")).href);
  const { chapterFinalPath } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "project-operations", "chapter.mjs")).href);
  const { snapshotChapter } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "project-operations", "versions.mjs")).href);
  const { countEffectiveWords } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "word-count.mjs")).href);
  const { sha256 } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "fs-utils.mjs")).href);
  const { projectRoot } = await createProjectAt(path.join(demoRoot, "novel"), {
    title: "视觉验收样例小说",
    story_seed: "一个用于视觉验收的示例项目，覆盖工作组、任务计划与 Markdown 渲染。",
    target_chapters: 3,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20,
    tool_permissions: { yolo: true }
  });
  // 普通文件夹场景 fixture：无 project.yaml，仅一个普通 notes.txt
  const plainFolder = path.join(demoRoot, "普通文件夹");
  fs.mkdirSync(plainFolder, { recursive: true });
  fs.writeFileSync(path.join(plainFolder, "notes.txt"), "普通资料：写作参考笔记。\n", "utf8");

  // 预置「已完成章节 + 版本快照」：复用生产路径、字数、索引和快照 helper，
  // 让版本时间线场景覆盖真实存储形状。
  const FIXTURE_CHAPTER_TEXT = "# 第一章 雨夜来信\n\n雨夜，雨声突然变大。林深猛地推开门，冲进老宅的客厅。他浑身湿透，抹了一把脸，低声道：“信上说，老宅的钟会在午夜敲十三下。”烛光下，墙上的照片里竟是多年不见的父亲。他正要细看，门外却传来一阵急促的敲门声。\n";
  {
    const fixtureChapterNo = 1;
    const fixtureFinalAbs = chapterFinalPath(projectRoot, fixtureChapterNo, "md");
    const fixtureFinalRel = path.relative(projectRoot, fixtureFinalAbs);
    fs.mkdirSync(path.dirname(fixtureFinalAbs), { recursive: true });
    fs.writeFileSync(fixtureFinalAbs, FIXTURE_CHAPTER_TEXT, "utf8");
    await upsertChapter(projectRoot, {
      chapter_no: fixtureChapterNo,
      status: "completed",
      draft_path: null,
      final_path: fixtureFinalRel,
      actual_words: countEffectiveWords(FIXTURE_CHAPTER_TEXT),
      checksum: sha256(FIXTURE_CHAPTER_TEXT)
    });
    await snapshotChapter({ projectRoot, chapterNo: fixtureChapterNo, content: FIXTURE_CHAPTER_TEXT, source: "commit" });
    context.environmentNotes.push("fixture 通过生产 helper 预置第 1 章已完成 + commit v1 版本");
  }

  // 写入代表性记忆内容（仅临时 fixture，不改项目模板/真实用户文件）：让抽屉
  // 「记忆」分区的故事摘要与工作日志卡渲染真实内容（memoryCardsReady/Step7 依赖）。
  // 必须在 server 启动/页面加载前写入，否则记忆卡读取时读不到。
  fs.writeFileSync(
    path.join(projectRoot, "book_summary.md"),
    "# 全书摘要\n\n雨夜来信已完成，林深在老宅发现了与父亲有关的照片。\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(projectRoot, "WORKLOG.md"),
    "# WORKLOG\n\n- 已完成：第 1 章\n- 下一步：确认来信来源并推进第 2 章\n",
    "utf8"
  );
  // ---- server：testGatewayFactory + 延迟 skills service 注入 ----
  const { createAppShellServer } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "app-server.mjs")).href);
  const gateway = createTestGatewayFactory();
  const skills = createDelayedSkillService({ userHome: skillsHome, delayMs: SKILL_READ_DELAY_MS });

  server = createAppShellServer({
    workspaceRoot: demoRoot,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(demoRoot, ".state"),
    secretsRoot: path.join(demoRoot, ".secrets"),
    staticRoot: path.join(SCRIPT_DIR, "..", "src", "app-shell"),
    port: 0,
    testGatewayFactory: gateway.gatewayFor,
    skills
  });
  const boundPort = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  // ---- BrowserWindow（offscreen 渲染：可见窗口 capturePage 抛 UnknownVizError；
  // offscreen + force-device-scale-factor=1 精确返回视口尺寸）----
  const win = new BrowserWindow({
    width: VIEWPORT_DEFAULT.width,
    height: VIEWPORT_DEFAULT.height,
    show: false,
    backgroundColor: "#f4f3f0",
    autoHideMenuBar: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      preload: path.join(SCRIPT_DIR, "..", "src", "desktop", "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowRef = win;
  const consoleMessages = [];
  win.webContents.on("console-message", (event, level, message) => {
    // Electron 32+ 事件为单参数 Event（event.message）；旧式 (level, message, ...) 兼容
    const text = typeof message === "string" ? message : (event?.message ?? "");
    consoleMessages.push(String(text));
  });

  async function bootToProject(titleText) {
    await win.loadURL(`http://127.0.0.1:${boundPort}`);
    await waitUntil(win, "Boolean(window.__wwritingMotionReady)", "motion runtime 初始化", 10000);
    await waitUntil(win, "document.querySelector('#project-title')?.textContent.includes('" + titleText + "')", "dashboard 加载项目", 10000);
    await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null", "AgentSurface composer 挂载", 10000);
    await waitUntil(win, "Boolean(document.querySelector('[data-testid=\"agent-conversation\"]'))", "对话容器挂载", 8000);
  }

  await bootToProject("视觉验收样例小说");

  // ---- 主题归一：经真实 #theme-toggle 切换到目标主题（--theme light|dark）----
  // 切换幂等：先读当前主题，不一致才点击（主题持久化在 localStorage，避免上次运行残留）。
  if ((await read(win, `document.documentElement.dataset.theme`)) !== theme) {
    await win.webContents.executeJavaScript(`document.querySelector("#theme-toggle")?.click(); true`);
    await waitUntil(win, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `切换到 ${theme} 主题`, 8000);
  }
  context.environmentNotes.push(`主题：${theme}（经 #theme-toggle 真实切换）`);

  // =========================================================================
  // 场景驱动（全部经真实 UI / API / journal SSE 路径）
  // =========================================================================

  // ---- 输入 A：reasoning → tool(read_skill 慢窗口) → plan → reply ----
  gateway.controller.setScripts([
    [
      { type: "reasoning", tokens: TURN1_REASONING },
      { type: "hold" }, // 01: reasoning-running 三帧
      { type: "reasoning", tokens: ["读取风格技能说明，确认写作约束。"] },
      { type: "tool", name: "read_skill", arguments: { name: "fast-readable" } }, // 02: 慢工具
      { type: "reasoning", tokens: ["更新任务计划，收尾本次工作。"] },
      { type: "tool", name: "update_plan", arguments: PLAN_COMPLETED },
      { type: "reply", text: REPLY_A }
    ],
    [
      { type: "reasoning", tokens: ["准备 Markdown 渲染样例。"] },
      { type: "reply", text: MARKDOWN_SAMPLE }
    ],
    [
      { type: "reply", text: "你好，我可以在普通文件夹里协助你写作。没有 project.yaml 也能直接开始。" }
    ]
  ]);

  // ---- 01: reasoning-running（3 帧；WAAPI pause+seek 固定扫光相位）----
  console.log("[scenario] 01-reasoning-running");
  await submitViaComposer(win, "请按快节奏易读风格写一个短章节");
  await gateway.controller.waitForHold(20000);
  await waitForReasoningRunning(win);
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[0]); // 左
  await auditAndCapture(win, context, {
    file: "reasoning-running-t000-1280x800.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    sweepPhase: 0,
    state: "reasoning 运行中（思考中 + 扫光带位于左侧）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "工作组展开；reasoning 运行态：label“思考中”+ 扫光带位于左侧",
    spec: "Task 13 Step 4 / SPEC §10.1 工作组时间线",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[1]); // 中
  await auditAndCapture(win, context, {
    file: "reasoning-running-t400-1280x800.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    sweepPhase: 1,
    state: "reasoning 运行中（扫光带位于中部）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "扫光带位于中部；文字不位移，容器不跳动",
    spec: "Task 13 Step 4 / 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[2]); // 右
  await auditAndCapture(win, context, {
    file: "reasoning-running-t900-1280x800.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    sweepPhase: 2,
    state: "reasoning 运行中（扫光带位于右侧）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "扫光带位于右侧；label“思考中”保持原位",
    spec: "Task 13 Step 4 / 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await checkSweepDirection(context, "reasoning-running", context.sweepFrames.filter((f) => f.scenario === "reasoning-running"));
  gateway.controller.release();

  // ---- 02: tool-after-reasoning（read_skill 慢窗口 5s；同款 seek）----
  console.log("[scenario] 02-tool-after-reasoning");
  await waitForToolRunning(win, "正在调用 read_skill");
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[0]); // 左
  await auditAndCapture(win, context, {
    file: "tool-after-reasoning-t000-1280x800.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    sweepPhase: 0,
    state: "reasoning 已完成；工具运行中（read_skill + 扫光带位于左侧）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光带位于左侧，唯一动效",
    spec: "Task 13 Step 4 / 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[1]); // 中
  await auditAndCapture(win, context, {
    file: "tool-after-reasoning-t400-1280x800.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    sweepPhase: 1,
    state: "reasoning 已完成；工具运行中（扫光带位于中部）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "扫光带位于中部；reasoning 完成态不动",
    spec: "Task 13 Step 4 / 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await seekShimmerPhase(win, context, SHIMMER_PHASES_MS[2]); // 右
  await auditAndCapture(win, context, {
    file: "tool-after-reasoning-t900-1280x800.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    sweepPhase: 2,
    state: "reasoning 已完成；工具运行中（扫光带位于右侧）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "扫光带位于右侧；reasoning 完成态不动",
    spec: "Task 13 Step 4 / 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await checkSweepDirection(context, "tool-after-reasoning", context.sweepFrames.filter((f) => f.scenario === "tool-after-reasoning"));

  // ---- 03: conversation-completed（四个视口，同一完成会话）----
  console.log("[scenario] 03-conversation-completed");
  await waitForRunTerminal(win, false, { port: boundPort, projectRoot });
  await scrollConversationToBottom(win);
  for (const vp of VIEWPORTS) {
    await setViewport(win, vp.width, vp.height);
    await scrollConversationToBottom(win);
    await auditAndCapture(win, context, {
      file: `conversation-completed-${vp.width}x${vp.height}.png`,
      viewport: [vp.width, vp.height],
      scenario: "conversation-completed",
      state: "会话完成态：用户消息 + 自动折叠工作组（工作了 N 秒）+ 最终正文 + composer",
      dataSource: DATA_SOURCE.gatewayUi,
      expected: `${vp.width}x${vp.height} 会话完成态：无横向溢出、无遮挡、composer 不遮最后一条消息`,
      spec: "Task 13 Step 4 / SPEC §10.3 四视口响应式验收",
      overlapSelectors: OVERLAP_SELECTORS.chat,
      extraChecks: vp === VIEWPORT_NARROW ? EXTRA_CHECKS.narrowTopbarTitle : undefined
    });
  }
  await setViewport(win, VIEWPORT_DEFAULT.width, VIEWPORT_DEFAULT.height);

  // ---- 04: markdown-fixture（1280x800 顶部角色 + 390x844 表格行为）----
  console.log("[scenario] 04-markdown-fixture");
  await submitViaComposer(win, "请展示 Markdown 渲染效果");
  // 输入 B 会新建第二个工作组：必须等新组出现并终态，不能只看 A 的旧组
  await waitForRunTerminal(win, false, { port: boundPort, projectRoot }, 2);
  // 诊断快照：gateway 调用序列 + 会话 DOM 概览
  {
    const diag = await read(win, `(() => ({
      groups: [...document.querySelectorAll("details.agent-work-group")].map((g) => ({
        open: g.open,
        status: g.querySelector(".agent-work-status")?.textContent?.slice(0, 20),
        items: g.querySelectorAll(".agent-work-item").length
      })),
      userMessages: [...document.querySelectorAll('[data-testid="agent-user-message"]')].map((el) => (el.textContent || "").slice(0, 30)),
      assistantCount: document.querySelectorAll('[data-testid="agent-assistant-message"]').length,
      workStatus: document.querySelector(".agent-work-status")?.textContent ?? null
    }))()`);
    console.log(`  [diag] gateway calls=${JSON.stringify(gateway.controller.state.callLog)} dom=${JSON.stringify(diag)}`);
  }
  const markdownRoles = await read(win, `(() => {
    const roles = {
      h1: ".agent-markdown h1", h2: ".agent-markdown h2", h3: ".agent-markdown h3",
      h4: ".agent-markdown h4", h5: ".agent-markdown h5", h6: ".agent-markdown h6",
      strong: ".agent-markdown strong", links: '.agent-markdown a[data-external-link]',
      blockquote: ".agent-markdown blockquote", inlineCode: ".agent-markdown code",
      fence: ".agent-markdown pre.md-fence", body: ".agent-markdown p",
      table: ".agent-markdown table", taskCheckbox: '.agent-markdown input[type=checkbox]'
    };
    const counts = {};
    for (const [key, sel] of Object.entries(roles)) {
      counts[key] = document.querySelectorAll(".agent-message--assistant " + sel).length;
    }
    return counts;
  })()`);
  assert.ok(markdownRoles.h1 >= 1 && markdownRoles.h2 >= 1 && markdownRoles.h3 >= 1, `H1-H3 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.h4 >= 1 && markdownRoles.h5 >= 1 && markdownRoles.h6 >= 1, `H4-H6 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.body >= 1, `正文段落缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.strong >= 1 && markdownRoles.links >= 1 && markdownRoles.blockquote >= 1, `strong/链接/引用缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.inlineCode >= 1 && markdownRoles.fence >= 1, `inline code/fenced code 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.table >= 1, `Markdown 表格缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.taskCheckbox >= 2, `任务列表 checkbox 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.equal(gateway.controller.state.callLog.some((call) => call.result === "default"), false, `gateway 出现默认答复（步骤队列错位）: ${JSON.stringify(gateway.controller.state.callLog)}`);
  console.log(`  ✓ Markdown 角色齐备（含表格/任务列表）: ${JSON.stringify(markdownRoles)}`);

  const markdownChecks = async (w, options) => {
    const out = [];
    out.push(...(await EXTRA_CHECKS.markdownTableScroll(w, options)));
    out.push(...(await EXTRA_CHECKS.taskListStates(w)));
    return out;
  };
  // 1280x800：Markdown 消息首段角色 + 表格/任务列表可见
  await win.webContents.executeJavaScript(`(() => {
    const bubble = [...document.querySelectorAll(".agent-message--assistant .agent-markdown")].at(-1);
    if (bubble) bubble.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await sleep(300);
  await auditAndCapture(win, context, {
    file: "markdown-fixture-1280x800.png",
    viewport: [1280, 800],
    scenario: "markdown-fixture",
    state: "Markdown 渲染完成态（H1-H6/正文/链接/引用/代码/表格/任务列表）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "1280x800：Markdown 全部角色排版完整，表格在容器内滚动、页面级不溢出",
    spec: "Task 13 Step 4 / SPEC §10.3 响应式验收",
    overlapSelectors: OVERLAP_SELECTORS.chat,
    extraChecks: markdownChecks
  });
  // 390x844：同一表格的窄视口行为（容器内横向滚动）
  await setViewport(win, VIEWPORT_NARROW.width, VIEWPORT_NARROW.height);
  await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector(".agent-message--assistant .agent-markdown table");
    if (table) table.scrollIntoView({ block: "start" });
    return true;
  })()`);
  await sleep(300);
  await auditAndCapture(win, context, {
    file: "markdown-fixture-390x844.png",
    viewport: [390, 844],
    scenario: "markdown-fixture",
    state: "Markdown 渲染完成态（窄视口表格容器内滚动）",
    dataSource: DATA_SOURCE.gatewayUi,
    expected: "390x844 窄视口：宽 Markdown 表格容器内横向滚动、任务列表不遮挡/不溢出、页面级无横向溢出",
    spec: "Task 13 Step 4 / SPEC §10.3 响应式验收",
    overlapSelectors: OVERLAP_SELECTORS.chat,
    extraChecks: (w) => markdownChecks(w, { requireOverflow: true })
  });

  // ---- 05: settings-builtin-styles（1280x800 + 390x844）----
  console.log("[scenario] 05-settings-builtin-styles");
  await setViewport(win, VIEWPORT_DEFAULT.width, VIEWPORT_DEFAULT.height);
  await clickAndReadRetry(win, "#open-settings", {
    label: "open-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  });
  await clickAndRead(win, '.sp-section-item[data-section="skills"]', {
    label: "settings-skills-section",
    expect: () => waitForSettingsSection(win, "skills")
  });
  await waitForSkillsList(win);
  await focusBuiltinStylesForCapture(win);
  await auditAndCapture(win, context, {
    file: "settings-builtin-styles-1280x800.png",
    viewport: [1280, 800],
    scenario: "settings-builtin-styles",
    state: "设置页 Agent 技能分区：内置写作风格只读行（无启用/删除/编辑控件）",
    dataSource: DATA_SOURCE.settings,
    expected: "设置页「Agent 技能」分区：内置写作风格分区展示三个只读行，无卡片套卡片、无启用开关",
    spec: "Task 13 Step 4 / SPEC §6.1 内置风格只读展示",
    overlapSelectors: OVERLAP_SELECTORS.settings,
    extraChecks: EXTRA_CHECKS.settingsBuiltinRowsVisible
  });
  await setViewport(win, VIEWPORT_NARROW.width, VIEWPORT_NARROW.height);
  // 390 视口尺寸可能触发响应式重排，重排后须再次等待并聚焦目标行（否则滚动位置漂移）。
  await waitForSkillsList(win);
  await focusBuiltinStylesForCapture(win);
  await auditAndCapture(win, context, {
    file: "settings-builtin-styles-390x844.png",
    viewport: [390, 844],
    scenario: "settings-builtin-styles",
    state: "设置页 Agent 技能分区（390x844 窄视口）",
    dataSource: DATA_SOURCE.settings,
    expected: "390x844 窄视口设置技能分区：布局完整、无横向溢出、无遮挡",
    spec: "Task 13 Step 4 / SPEC §10.3 响应式验收",
    overlapSelectors: OVERLAP_SELECTORS.settings,
    extraChecks: EXTRA_CHECKS.settingsBuiltinRowsVisible
  });

  // ---- 06: settings-style-detail（1280x800，点击内置风格行展开只读详情）----
  console.log("[scenario] 06-settings-style-detail");
  await setViewport(win, VIEWPORT_DEFAULT.width, VIEWPORT_DEFAULT.height);
  await clickAndRead(win, '.spd-skill-row--readonly', {
    label: "open-builtin-style-detail",
    settleMs: 200
  });
  // 注入的 skills service 对 read 有 5s 延迟（read_skill 慢工具窗口共用同一 service）：
  // 详情正文要等真实 read 完成后才渲染，显式等待而不是猜测时序
  await waitUntil(win, "Boolean(document.getElementById('skills-detail-back')) && (document.querySelector('.spd-skill-detail-body')?.textContent || '').length > 0", "内置风格详情正文渲染", 12000);
  await auditAndCapture(win, context, {
    file: "settings-style-detail-1280x800.png",
    viewport: [1280, 800],
    scenario: "settings-style-detail",
    state: "内置风格只读详情（完整正文，可滚动，无编辑/删除/启用控件）",
    dataSource: DATA_SOURCE.settingsDetail,
    expected: "内置写作风格详情：完整 SKILL.md 正文经 agent-markdown 渲染，无启用/删除/编辑控件",
    spec: "Task 13 Step 4 / SPEC §6.1 可查看但不可编辑",
    overlapSelectors: OVERLAP_SELECTORS.settings,
    extraChecks: EXTRA_CHECKS.builtinStyleDetail
  });
  await clickAndRead(win, "#skills-detail-back", {
    label: "skills-detail-back",
    expect: () => read(win, "document.querySelector('.spd-skill-row--readonly') !== null")
  });
  await clickAndRead(win, "#settings-x", {
    label: "settings-close",
    expect: async () => !(await overlayVisible(win, "settings-scrim"))
  });

  // ---- 07: drawer（1280x800，顶部面板按钮打开章节分区）----
  console.log("[scenario] 07-drawer");
  await clickAndReadRetry(win, "#open-drawer", {
    label: "open-drawer",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show') && document.querySelector('.dtab[data-dtab=\"chapters\"]').classList.contains('on')")
  });
  await sleep(300);
  await auditAndCapture(win, context, {
    file: "drawer-1280x800.png",
    viewport: [1280, 800],
    scenario: "drawer",
    state: "顶部面板按钮打开的 drawer（章节分区 + 导出工具栏）",
    dataSource: DATA_SOURCE.drawer,
    expected: "drawer 章节分区：章节目录、导出成书工具条；顶部入口可点击、分区导航正常",
    spec: "Task 13 Step 4 / SPEC §10.2 取消右侧竖轨后入口收敛到顶部按钮",
    overlapSelectors: OVERLAP_SELECTORS.drawer
  });
  await clickAndRead(win, "#drawer-close", {
    label: "drawer-close",
    expect: async () => !(await read(win, "document.getElementById('drawer').classList.contains('show')"))
  });

  // ---- 16: version-panel（1280x800，时间线展开 + 确认恢复态）----
  console.log("[scenario] 16-version-panel");
  await setViewport(win, 1280, 800);
  await clickAndReadRetry(win, "#open-drawer", {
    label: "open-drawer-vp",
    expect: () => read(win, "document.getElementById('drawer').classList.contains('show')")
  });
  await clickAndReadRetry(win, '.dtab[data-dtab="chapters"]', {
    label: "chapters-tab-vp",
    expect: () => read(win, "document.querySelector('.dtab[data-dtab=\"chapters\"]').classList.contains('on')")
  });
  // 点击章节历史按钮（chrow-history）打开版本面板
  const chrowHistoryExists = await read(win, "Boolean(document.querySelector('.chrow-history'))");
  if (chrowHistoryExists) {
    await clickAndReadRetry(win, ".chrow-history", {
      label: "chapter-history-vp",
      expect: () => read(win, "Boolean(document.querySelector('[data-version-panel]'))")
    });
    await auditAndCapture(win, context, {
      file: "version-panel-1280x800.png",
      viewport: [1280, 800],
      scenario: "version-panel",
      state: "版本时间线展开（含恢复按钮）",
      dataSource: DATA_SOURCE.versionPanel,
      expected: "版本行显示 vN/时间/来源，无校验和；恢复按钮行内二次确认；fixture 无版本时显示「暂无历史版本」",
      spec: "第九轮 §3.2",
      overlapSelectors: OVERLAP_SELECTORS.drawer
    });
    // 点击恢复按钮触发确认态（若有版本行）
    const restoreButtonExists = await read(win, "Boolean(document.querySelector('[data-restore-button]'))");
    if (restoreButtonExists) {
      await clickAndReadRetry(win, "[data-restore-button]", {
        label: "restore-confirm-state-vp",
        expect: () => read(win, "Boolean(document.querySelector('[data-restore-confirm]'))")
      });
      await auditAndCapture(win, context, {
        file: "version-panel-confirm-1280x800.png",
        viewport: [1280, 800],
        scenario: "version-panel-confirm",
        state: "恢复按钮确认态（确认恢复？）",
        dataSource: DATA_SOURCE.versionPanel,
        expected: "行内二次确认，不弹窗",
        spec: "第九轮 §3.2",
        overlapSelectors: OVERLAP_SELECTORS.drawer
      });
    }
  } else {
    // 无 chrow-history（fixture 无已完成章节）：直接捕获空状态
    await sleep(300);
    await auditAndCapture(win, context, {
      file: "version-panel-1280x800.png",
      viewport: [1280, 800],
      scenario: "version-panel",
      state: "版本时间线入口（无已完成章节，仅抽屉章节分区）",
      dataSource: DATA_SOURCE.versionPanel,
      expected: "抽屉章节分区可见，无已完成章节行的历史按钮",
      spec: "第九轮 §3.2",
      overlapSelectors: OVERLAP_SELECTORS.drawer
    });
  }
  // ---- 16b: memory-tab（1280x800，抽屉记忆分区）----
  console.log("[scenario] 16b-memory-tab");
  await clickAndReadRetry(win, '.dtab[data-dtab="memory"]', {
    label: "memory-tab-vp",
    expect: () => read(win, "document.querySelector('.dtab[data-dtab=\"memory\"]').classList.contains('on')")
  });
  await waitUntil(
    win,
    `(() => {
      const cards = [...document.querySelectorAll(".memory-card")];
      return cards.length === 3 && cards.every((card) => (card.querySelector(".memory-card-content")?.textContent.trim() ?? "") !== "");
    })()`,
    "记忆三卡正文渲染",
    10000
  );
  await auditAndCapture(win, context, {
    file: "memory-tab-1280x800.png",
    viewport: [1280, 800],
    scenario: "memory-tab",
    state: "抽屉记忆分区（摘要/日志/设定档案三块）",
    dataSource: DATA_SOURCE.memoryTab,
    expected: "三块卡片：故事摘要、工作日志（各带历史按钮）、设定档案只读",
    spec: "第九轮 §3.3",
    overlapSelectors: OVERLAP_SELECTORS.drawer,
    extraChecks: EXTRA_CHECKS.memoryCardsReady
  });
  // ---- 17: plan-panel（1280x800，chip 收起 + 展开）----
  console.log("[scenario] 17-plan-panel");
  await clickAndReadRetry(win, "#drawer-close", {
    label: "drawer-close-vp",
    expect: () => read(win, "!document.getElementById('drawer').classList.contains('show')")
  });
  // chip 存在且可见时测试展开/收起；隐藏时仍捕获收起态
  const planChipEl = await read(win, "Boolean(document.querySelector('[data-plan-chip]'))");
  if (planChipEl) {
    const chipHidden = await read(win, "document.querySelector('[data-plan-chip]').hidden");
    if (!chipHidden) {
      await clickAndReadRetry(win, "[data-plan-chip]", {
        label: "plan-chip-vp",
        // 展开后必须真实可见（hidden=false + 有尺寸 + 不被 overflow 祖先裁剪 + 在视口内），
        // 否则截图拍不到下拉却仍算通过（回归防线：见 2026-08-16 plan-panel 修复）。
        expect: () => read(win, `(() => {
          const el = document.querySelector('[data-plan-dropdown]');
          if (!el || el.hidden) return false;
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          let L = r.left, T = r.top, R = r.right, B = r.bottom;
          for (let cur = el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
            const cs = getComputedStyle(cur);
            const ox = cs.overflowX, oy = cs.overflowY;
            const clipped = (ox === "hidden" || ox === "clip" || ox === "scroll" || ox === "auto") || (oy === "hidden" || oy === "clip" || oy === "scroll" || oy === "auto");
            if (clipped) {
              const ar = cur.getBoundingClientRect();
              L = Math.max(L, ar.left + (parseFloat(cs.paddingLeft) || 0));
              T = Math.max(T, ar.top + (parseFloat(cs.paddingTop) || 0));
              R = Math.min(R, ar.right - (parseFloat(cs.paddingRight) || 0));
              B = Math.min(B, ar.bottom - (parseFloat(cs.paddingBottom) || 0));
              if (R <= L || B <= T) return false;
            }
            if (cur === document.body) break;
          }
          return R > 0 && B > 0 && L < innerWidth && T < innerHeight;
        })()`)
      });
      await auditAndCapture(win, context, {
        file: "plan-panel-open-1280x800.png",
        viewport: [1280, 800],
        scenario: "plan-panel-open",
        state: "任务计划面板展开态",
        dataSource: DATA_SOURCE.planPanel,
        expected: "chip 进度 N/M + 条目状态图标/删除线/进行中高亮",
        spec: "第九轮 §3.6",
        overlapSelectors: [],
        extraChecks: EXTRA_CHECKS.planDropdownTopmost
      });
      await clickAndReadRetry(win, "[data-plan-chip]", {
        label: "plan-chip-collapse-vp",
        expect: () => read(win, "document.querySelector('[data-plan-dropdown]').hidden")
      });
      await auditAndCapture(win, context, {
        file: "plan-panel-collapsed-1280x800.png",
        viewport: [1280, 800],
        scenario: "plan-panel-collapsed",
        state: "任务计划面板收起态（仅 chip）",
        dataSource: DATA_SOURCE.planPanel,
        expected: "仅顶栏 chip，无遮挡",
        spec: "第九轮 §3.6",
        overlapSelectors: []
      });
    } else {
      // chip 存在但 hidden（fixture 无 plan 事件）：捕获顶栏无 chip 遮挡的截图
      await sleep(200);
      await auditAndCapture(win, context, {
        file: "plan-panel-collapsed-1280x800.png",
        viewport: [1280, 800],
        scenario: "plan-panel-collapsed",
        state: "任务计划面板收起态（fixture 无 plan，chip 隐藏）",
        dataSource: DATA_SOURCE.planPanel,
        expected: "chip 隐藏（fixture 无计划事件），顶栏无遮挡",
        spec: "第九轮 §3.6",
        overlapSelectors: []
      });
    }
  } else {
    // chip 元素不存在（理论上不应发生）：捕获顶栏状态
    await sleep(200);
    await auditAndCapture(win, context, {
      file: "plan-panel-collapsed-1280x800.png",
      viewport: [1280, 800],
      scenario: "plan-panel-collapsed",
      state: "任务计划面板（chip 元素不存在）",
      dataSource: DATA_SOURCE.planPanel,
      expected: "顶栏无计划 chip（组件未挂载）",
      spec: "第九轮 §3.6",
      overlapSelectors: []
    });
  }

  // ---- 08: plain-folder-first-message（1280x800，普通文件夹第一条消息）----
  console.log("[scenario] 08-plain-folder-first-message");
  // 注册普通文件夹（应用私有 stateRoot 记录 workspace id；不创建 project.yaml）
  const registered = await fetch(`http://127.0.0.1:${boundPort}/api/projects/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot: plainFolder })
  });
  assert.equal(registered.status, 200, "普通文件夹必须可打开");
  // 重载页面：普通文件夹出现在项目列表，经真实 UI 流程打开
  await bootToProject("开始创作");
  await waitUntil(win, "document.querySelector('#project-list')?.children.length > 0", "项目列表渲染普通文件夹", 10000);
  const rowOpened = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.proj-row')].find((el) => el.textContent.includes('普通文件夹'));
    if (!row) return { ok: false, reason: "row missing" };
    // R4（第十轮）：项目行「+ 新建对话」在 hover/:focus-within 才可见——
    // 聚焦真实按钮触发 :focus-within，再验证菜单确实可见、可命中。
    const menu = row.querySelector('.proj-menu');
    const btn = row.querySelector('.proj-add');
    if (!btn) return { ok: false, reason: "proj-add missing" };
    btn.focus();
    const menuStyle = menu ? getComputedStyle(menu) : null;
    if (!menuStyle || Number(menuStyle.opacity) < 0.99 || menuStyle.pointerEvents === 'none') {
      return { ok: false, reason: "proj-menu not visible after focus" };
    }
    const rect = btn.getBoundingClientRect();
    const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const hit = document.elementFromPoint(center.x, center.y);
    const hitTestable = Boolean(hit && (hit === btn || btn.contains(hit)));
    btn.click();
    return { ok: true, hitTestable };
  })()`);
  assert.equal(rowOpened.ok, true, `普通文件夹行缺失: ${rowOpened.reason}`);
  assert.equal(rowOpened.hitTestable, true, "普通文件夹行中心必须可命中");
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null && !document.querySelector('[data-testid=\"agent-composer-input\"]').disabled", "普通文件夹 composer 可用", 10000);
  await setViewport(win, VIEWPORT_DEFAULT.width, VIEWPORT_DEFAULT.height);
  await submitViaComposer(win, "你好");
  await waitUntil(win, "[...document.querySelectorAll('[data-testid=\"agent-user-message\"]')].some((el) => el.textContent.includes('你好'))", "普通文件夹第一条用户消息渲染", 10000);
  await waitForRunTerminal(win, false, { port: boundPort, projectRoot: plainFolder });
  // 客观检查：无错误卡、无读取失败、第一条消息已交换
  await scrollConversationToBottom(win);
  await auditAndCapture(win, context, {
    file: "plain-folder-first-message-1280x800.png",
    viewport: [1280, 800],
    scenario: "plain-folder-first-message",
    state: "普通文件夹（无 project.yaml）打开并完成第一条消息",
    dataSource: DATA_SOURCE.plainFolder,
    expected: "普通文件夹打开后可直接聊天：第一条“你好”已交换、无读取失败、无错误卡、composer 可用",
    spec: "Task 13 Step 4 / SPEC §2.1 任意文件夹即可聊天 + §12 验收",
    overlapSelectors: OVERLAP_SELECTORS.chat,
    extraChecks: EXTRA_CHECKS.plainFolderFirstMessage
  });
  // 磁盘事实：普通文件夹根无 project.yaml / .wwriting/agent
  assert.equal(fs.existsSync(path.join(plainFolder, "project.yaml")), false, "普通文件夹不得创建 project.yaml");
  assert.equal(fs.existsSync(path.join(plainFolder, ".wwriting", "agent")), false, "普通文件夹不得创建 .wwriting/agent");
  const journalInStateRoot = fs.existsSync(path.join(demoRoot, ".state", "workspaces"));
  assert.equal(journalInStateRoot, true, "应用私有历史必须写入 stateRoot/workspaces");

  // ---- 页面 console 残留检查（模块加载错误会留下 MIME/解析错误）----
  for (const message of consoleMessages) {
    assert.ok(!message.includes("Failed to resolve module specifier"), `模块解析错误: ${message}`);
    assert.ok(!message.includes("MIME"), `MIME 类型错误: ${message}`);
  }

  // =========================================================================
  // 证据文件
  // =========================================================================

  // live-indicator-audit.json：每张图开放 activity ID + live class 数量
  const auditJsonPath = path.join(roundDir, "live-indicator-audit.json");
  const auditRecords = Object.values(context.auditRecords).sort((a, b) => a.file.localeCompare(b.file));
  assert.ok(auditRecords.length >= context.manifest.length, `live-indicator-audit 应覆盖全部 ${context.manifest.length} 张图，实际 ${auditRecords.length}`);
  fs.writeFileSync(
    auditJsonPath,
    JSON.stringify(
      {
        parallel_runtime_supported: false,
        notes: "每条记录对应 MANIFEST 中的一张 PNG；openActivityIds 为捕获时开放的 activity id（运行中工作项），visibleAnimatedCount 为 live class 动效文字数量。sequential 场景 ≤1、terminal 场景 =0，违反即采集失败。图片与 JSON 冲突时视觉验收判 FAIL。",
        records: auditRecords
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // MANIFEST.md
  const manifestPath = path.join(roundDir, "MANIFEST.md");
  fs.writeFileSync(manifestPath, renderManifest(context, { startedAt, projectRoot, plainFolder }), "utf8");

  // multimodal-review-prompt.md（独立多模态验收模型任务书）
  const promptPath = path.join(roundDir, "multimodal-review-prompt.md");
  fs.writeFileSync(promptPath, renderReviewPrompt(roundDir), "utf8");

  // ---- 校验证据目录完整（MANIFEST 声明的 PNG 全部存在、非空）----
  const expectedFiles = [
    "MANIFEST.md",
    "live-indicator-audit.json",
    "multimodal-review-prompt.md",
    "conversation-completed-390x844.png",
    "conversation-completed-768x900.png",
    "conversation-completed-1280x800.png",
    "conversation-completed-1440x900.png",
    "reasoning-running-t000-1280x800.png",
    "reasoning-running-t400-1280x800.png",
    "reasoning-running-t900-1280x800.png",
    "tool-after-reasoning-t000-1280x800.png",
    "tool-after-reasoning-t400-1280x800.png",
    "tool-after-reasoning-t900-1280x800.png",
    "markdown-fixture-390x844.png",
    "markdown-fixture-1280x800.png",
    "settings-builtin-styles-390x844.png",
    "settings-builtin-styles-1280x800.png",
    "settings-style-detail-1280x800.png",
    "drawer-1280x800.png",
    "plain-folder-first-message-1280x800.png",
    "version-panel-1280x800.png",
    "version-panel-confirm-1280x800.png",
    "memory-tab-1280x800.png",
    "plan-panel-open-1280x800.png",
    "plan-panel-collapsed-1280x800.png"
  ];
  const pngNames = expectedFiles.filter((name) => name.endsWith(".png"));
  const declaredInManifest = new Set(context.manifest.map((entry) => entry.file));
  for (const file of expectedFiles) {
    const target = path.join(roundDir, file);
    assert.ok(fs.existsSync(target) && fs.statSync(target).size > 0, `缺少证据文件: ${file}`);
  }
  for (const name of pngNames) {
    assert.ok(declaredInManifest.has(name), `PNG 未声明进 MANIFEST: ${name}`);
  }
  // MANIFEST 声明的 PNG 必须全部落盘（多余/缺失都会导致验收失败）
  for (const entry of context.manifest) {
    assert.ok(fs.existsSync(path.join(roundDir, entry.file)), `MANIFEST 声明的 PNG 未落盘: ${entry.file}`);
  }
  // 全部 PNG 可解码且尺寸与 MANIFEST 一致
  for (const name of pngNames) {
    const image = nativeImage.createFromPath(path.join(roundDir, name));
    const entry = context.manifest.find((item) => item.file === name);
    const size = image.getSize();
    const [w, h] = entry.viewport.split("x").map(Number);
    assert.ok(!image.isEmpty(), `PNG 不可解码: ${name}`);
    assert.equal(size.width, w, `${name} 尺寸宽不符: ${size.width} != ${w}`);
    assert.equal(size.height, h, `${name} 尺寸高不符: ${size.height} != ${h}`);
  }

  const allFiles = fs.readdirSync(roundDir).sort();
  console.log(`  生成文件（${allFiles.length}）: ${allFiles.join(", ")}`);

  return {
    output: [
      "",
      "视觉证据采集完成。",
      `Evidence directory: ${roundDir}`,
      `Multimodal review prompt: ${promptPath}`,
      `Generated: ${allFiles.length} files (${context.manifest.length} PNGs, manifest, audit, prompt)`,
      `parallel_runtime_supported: false`,
      ""
    ].join("\n")
  };
}

// ---------------------------------------------------------------------------
// Task 25：round7 模式——真实渲染 + 三 viewport 机器断言
// ---------------------------------------------------------------------------
// 与 campaign 模式共享同一真实 app-shell server / Electron 渲染路径，但输出是
// 每个 viewport 的机器可核对 JSON：{width,height,horizontalOverflow:false,
// overlaps:[],imageNonBlank:true}。任一断言失败退出 1。
//
// 场景内容（规格 §6.5 / 4.3）：
//   - 模型设置页：超长 provider/model 名完整渲染、密钥已配置（无明文回显）、
//     连接错误状态（test-connection 失败红字）；
//   - 对话区：queue B/C/D 三行排队输入 + priority pending（B 标「下一条」、
//     全部「立即」禁用）、context popover 固定打开、会话行内 rename editor；
//   - 成本抽屉：成本统一人民币元（N.NN 元），DOM 无 $ / ¥（Task 21/25 收尾）。
// 测试数据不含真实密钥（sk-round7- 前缀为测试哨兵，断言其绝不出现在 DOM）。
//
// 两个辅助函数按计划原样定义（不依赖执行者猜测）：
//   isInsideScrollableRegion(el)  —— 沿父节点向上找 scrollHeight>clientHeight ||
//                                     scrollWidth>clientWidth 的滚动容器；
//   assertNoUnexpectedOverlaps(selectors) —— 可见元素两两比较，面积交集 >1px
//     即抛错（含两个 selector、元素索引与矩形坐标）。固定 header 与其子节点
//     不纳入同一 selector 集合（本模式的选择器集合均为内容区元素）。
const ROUND7_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 900 },
  { width: 390, height: 844 }
];
// 计划模板里的 .agent-queued-input 在本仓库的真实队列行类名为 .agent-queue-item
//（view.js syncQueue 渲染），其余三个 selector 与计划一致。
const ROUND7_OVERLAP_SELECTORS = [".model-row", ".agent-queue-item", ".agent-context-popover", ".session-rename-editor"];
// 模型设置页状态下的重叠检查集合（模型行 vs 页面兄弟元素；.model-row 与固定
// header 不混入同一集合——header 与页面内容属于固定/滚动两类上下文）。
const ROUND7_SETTINGS_OVERLAP_SELECTORS = [".model-row", ".provider-item", ".api-key-status", ".model-connection-result"];
const ROUND7_FAKE_KEY = "sk-round7-visual-fake-key-0001-not-real";
const ROUND7_LONG_PROVIDER_NAME = "深度智能云算力平台-华东二区-超长供应商名称-abcdefghijklmnopqrstuvwxyz0123456789";
const ROUND7_LONG_MODEL_NAME = "deepseek-chat-v4-ultra-flash-preview-20260813-long-extra-descriptor-name-abcdefghijklmnopqrstuvwxyz";

// round7 页面侧审计脚本工厂：对话区/模型设置两个审计共享同一套辅助函数与审计
// 循环（isInsideScrollableRegion / isRendered / 交互元素边界 / assertNoUnexpectedOverlaps），
// 仅 overlapSelectors 与 settingsExtras（模型设置内容断言）不同。
// assertNoUnexpectedOverlaps 按计划语义抛错（含 selector / 元素索引 / 矩形坐标）；
// 固定 header 与其子节点不纳入同一 selector 集合（调用方传的集合均为内容区元素）。
function makeRound7AuditScript({ overlapSelectors, settingsExtras = null }) {
  const extrasBlock = settingsExtras
    ? `  const bodyText = document.body.textContent || "";
  const keyStatus = document.querySelector("[data-api-key-status]")?.textContent ?? null;
  const modelNameInput = document.querySelector('[data-field="model_name"]');
  const providerItems = [...document.querySelectorAll(".provider-item")].map((el) => el.textContent.trim());
  if (!providerItems.some((t) => t.includes(${JSON.stringify(settingsExtras.longProviderName)}))) {
    failures.push("long provider name not fully rendered in provider list");
  }
  if (!modelNameInput || modelNameInput.value !== ${JSON.stringify(settingsExtras.longModelName)}) {
    failures.push("long model name not preserved in model name input");
  }
  if (keyStatus !== "已配置（WWRITING_ROUND7_FAKE_KEY）") {
    failures.push("key status should be 已配置(env) only, got " + keyStatus);
  }
  if (bodyText.includes("sk-round7")) {
    failures.push("plaintext fake key leaked into DOM");
  }`
    : "";
  return `(() => {
  const failures = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) {
    failures.push("horizontal overflow: scrollWidth=" + doc.scrollWidth + " > clientWidth=" + doc.clientWidth);
  }
  const isInsideScrollableRegion = (el) => {
    let ancestor = el.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      if (ancestor.scrollHeight > ancestor.clientHeight || ancestor.scrollWidth > ancestor.clientWidth) {
        return true;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  };
  const isRendered = (el) => {
    if (typeof el.checkVisibility === "function") {
      try { if (!el.checkVisibility()) return false; } catch { /* fall through */ }
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    // 关闭态抽屉/菜单等以 pointer-events:none 表达不可交互（仍占据布局）——
    // 用户无法点到的元素不参与可交互审计。
    if (getComputedStyle(el).pointerEvents === "none") return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // 完全在视口外且不在任何滚动容器内 = 关闭态右抽屉（translateX(101%)）的
    // 离屏残留，用户不可见也不可交互，不参与审计；滚动容器内折叠内容仍允许。
    const intersectsViewport = r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0;
    if (!intersectsViewport && !isInsideScrollableRegion(el)) return false;
    return true;
  };
  for (const el of document.querySelectorAll("button,input,select,[role=button]")) {
    // 只审计实际渲染的交互元素：隐藏表单/未打开的 slash 菜单等不可见控件
    //（自身或祖先 display:none）不属于渲染问题。
    if (!isRendered(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) {
      failures.push("zero-size interactive: " + String(el.className || el.tagName));
      continue;
    }
    const insideViewport = r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    if (!insideViewport && !isInsideScrollableRegion(el)) {
      failures.push("interactive outside viewport and not inside scrollable region: " + String(el.className || el.tagName) +
        " rect=" + JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }));
    }
  }
  const assertNoUnexpectedOverlaps = (selectors) => {
    const groups = selectors.map((selector, index) => ({
      selector,
      index,
      els: [...document.querySelectorAll(selector)]
        .filter((el) => isRendered(el))
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    }));
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        for (const a of groups[i].els) {
          for (const b of groups[j].els) {
            if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (w > 1 && h > 1) {
              throw new Error(
                "unexpected overlap: " + groups[i].selector + "[" + groups[i].index + "] <-> " +
                groups[j].selector + "[" + groups[j].index + "] rectA=" +
                JSON.stringify({ left: Math.round(a.rect.left), top: Math.round(a.rect.top), right: Math.round(a.rect.right), bottom: Math.round(a.rect.bottom) }) +
                " rectB=" +
                JSON.stringify({ left: Math.round(b.rect.left), top: Math.round(b.rect.top), right: Math.round(b.rect.right), bottom: Math.round(b.rect.bottom) })
              );
            }
          }
        }
      }
    }
    return [];
  };
${extrasBlock}
  return {
    horizontalOverflow: doc.scrollWidth > doc.clientWidth,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    failures,
    overlaps: assertNoUnexpectedOverlaps(${JSON.stringify(overlapSelectors)})
  };
})()`;
}

// 对话区审计（queue + context popover + rename editor 状态）。
const ROUND7_AUDIT_SCRIPT = makeRound7AuditScript({ overlapSelectors: ROUND7_OVERLAP_SELECTORS });

// 模型设置状态审计（settings 页覆盖全屏时对话区元素仍在 DOM，与其重叠属预期遮挡；
// 故该状态只对 settings 页内部元素跑 assertNoUnexpectedOverlaps，并追加内容断言：
// 长名完整、密钥已配置、无明文密钥）。
const ROUND7_SETTINGS_AUDIT_SCRIPT = makeRound7AuditScript({
  overlapSelectors: ROUND7_SETTINGS_OVERLAP_SELECTORS,
  settingsExtras: { longProviderName: ROUND7_LONG_PROVIDER_NAME, longModelName: ROUND7_LONG_MODEL_NAME }
});

// 成本抽屉状态审计：DOM 无 $ / ¥；出现金额必须是两位小数 + 元。
const ROUND7_COST_AUDIT_SCRIPT = `(() => {
  const failures = [];
  const drawerText = document.getElementById("drawer-body")?.textContent || "";
  if (drawerText.includes("$") || drawerText.includes("¥")) {
    failures.push("cost drawer DOM contains $ or ¥");
  }
  const costPanel = document.querySelector(".cost-panel-root");
  if (!costPanel) failures.push("cost panel root missing");
  const costText = (costPanel ? costPanel.textContent : "") + drawerText;
  for (const m of costText.matchAll(/[0-9][0-9,]*\.[0-9]{6}(?![0-9])/gu)) {
    failures.push("six-decimal cost residue: " + m[0]);
  }
  return { failures };
})()`;

// 落盘截图机器校验：nativeImage.createFromPath 非空、尺寸等于 viewport、
// 抽样 bitmap 至少两种不同 RGB 值。
function verifyRound7ImageFile(filePath, width, height) {
  const image = nativeImage.createFromPath(filePath);
  const problems = [];
  if (image.isEmpty()) problems.push("image is empty (nativeImage.isEmpty() === true)");
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    problems.push(`image size ${size.width}x${size.height} != viewport ${width}x${height}`);
  }
  const bmp = image.toBitmap();
  const colors = new Set();
  for (let y = 0; y < size.height && colors.size < 3; y += 7) {
    for (let x = 0; x < size.width && colors.size < 3; x += 7) {
      const i = (y * size.width + x) * 4;
      colors.add(`${bmp[i]},${bmp[i + 1]},${bmp[i + 2]}`);
    }
  }
  if (colors.size < 2) problems.push(`sampled bitmap has only ${colors.size} distinct RGB value(s)`);
  return { pass: problems.length === 0, problems, distinctColors: colors.size };
}

async function captureRound7Png(win, roundDir, fileName, [width, height]) {
  let image = null;
  let pixelCheck = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    image = await windowRef.webContents.capturePage();
    pixelCheck = verifyImagePixels(image, width, height);
    if (!pixelCheck.problems.includes("整图全白（无内容）")) break;
    await sleep(250);
    windowRef.webContents.invalidate();
  }
  if (pixelCheck.problems.length > 0) {
    throw new Error(`${fileName} 像素检查失败: ${pixelCheck.problems.join(" | ")}`);
  }
  fs.writeFileSync(path.join(roundDir, fileName), image.toPNG());
}

async function runRound7({ mainRepo, roundDir, theme }) {
  console.log(`[capture-visual-acceptance] round7（真实渲染 + 三 viewport 机器断言）`);
  console.log(`  证据目录: ${roundDir}`);

  demoRoot = path.join(SCRIPT_DIR, "..", ".demo_runs", `visual-round7-${Date.now()}`);
  const skillsHome = path.join(demoRoot, "skills-home");
  fs.mkdirSync(skillsHome, { recursive: true });
  const { createProjectAt } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "project-store.mjs")).href);
  const { projectRoot } = await createProjectAt(path.join(demoRoot, "novel"), {
    title: "视觉验收样例小说",
    story_seed: "一个用于 round7 视觉验收的示例项目。",
    target_chapters: 3,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20,
    tool_permissions: { yolo: true }
  });
  // 成本夹具：costAvailable + 人民币元金额（cost.json 由 dashboard 直接读取）。
  fs.writeFileSync(
    path.join(projectRoot, "cost.json"),
    JSON.stringify({
      calls: 5,
      unpricedCalls: 0,
      costAvailable: true,
      estimatedCost: 1.2,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      byChapter: { "1": { estimatedCost: 0.8, calls: 4 } }
    }, null, 2),
    "utf8"
  );
  // 供应商/密钥夹具：超长名称 + 假密钥（sk-round7- 哨兵）。seeded_preset_ids
  // 预填避免内置预设重新播种，只保留长名供应商。
  const secretsRoot = path.join(demoRoot, ".secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(secretsRoot, "model-profiles.json"),
    JSON.stringify({
      seeded_preset_ids: ["deepseek", "mimo"],
      default_model: null,
      providers: [
        {
          id: "longcloud",
          name: ROUND7_LONG_PROVIDER_NAME,
          type: "custom",
          status: "enabled",
          base_url: "http://127.0.0.1:1/v1",
          api_format: "openai-chat-completions",
          api_key_env: "WWRITING_ROUND7_FAKE_KEY",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          models: [{ id: "m1", model_name: ROUND7_LONG_MODEL_NAME, enabled: true, context_window: 256000 }]
        }
      ]
    }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(secretsRoot, "secrets.json"),
    JSON.stringify({ WWRITING_ROUND7_FAKE_KEY: ROUND7_FAKE_KEY }, null, 2),
    "utf8"
  );

  const { createAppShellServer } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "app-server.mjs")).href);
  const gateway = createTestGatewayFactory();
  const skills = createDelayedSkillService({ userHome: skillsHome, delayMs: 0 });
  server = createAppShellServer({
    workspaceRoot: demoRoot,
    selectedProjectRoot: projectRoot,
    stateRoot: path.join(demoRoot, ".state"),
    secretsRoot,
    staticRoot: path.join(SCRIPT_DIR, "..", "src", "app-shell"),
    port: 0,
    testGatewayFactory: gateway.gatewayFor,
    skills
  });
  const boundPort = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  const win = new BrowserWindow({
    width: ROUND7_VIEWPORTS[0].width,
    height: ROUND7_VIEWPORTS[0].height,
    show: false,
    backgroundColor: "#f4f3f0",
    autoHideMenuBar: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      preload: path.join(SCRIPT_DIR, "..", "src", "desktop", "electron-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowRef = win;
  const consoleMessages = [];
  win.webContents.on("console-message", (event, level, message) => {
    const text = typeof message === "string" ? message : (event?.message ?? "");
    consoleMessages.push(String(text));
  });

  await win.loadURL(`http://127.0.0.1:${boundPort}`);
  await waitUntil(win, "Boolean(window.__wwritingMotionReady)", "motion runtime must initialize", 10000);
  await waitUntil(win, "document.querySelector('#project-title')?.textContent.includes('视觉验收样例小说')", "dashboard must load project", 10000);
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null", "AgentSurface composer must mount", 10000);
  await waitUntil(win, "Boolean(document.querySelector('[data-testid=\"agent-conversation\"]'))", "conversation must mount", 8000);

  // ---- 队列场景（一次性 stage）：A 运行中（hold）+ B/C/D 排队 + priority pending ----
  gateway.controller.setScripts([[{ type: "hold" }]]);
  await submitViaComposer(win, "任务 A：起草第三章开头的雨夜冲突场景");
  await waitUntil(win, "Boolean(document.querySelector('[data-testid=\"agent-stop\"]'))", "run A must be active", 15000);
  const QUEUE_TEXTS = [
    "队列任务 B：续写第三章雨夜冲突",
    "队列任务 C：整理人物小传",
    "队列任务 D：核对伏笔设定"
  ];
  for (const text of QUEUE_TEXTS) await submitViaComposer(win, text);
  await waitUntil(win, "document.querySelectorAll('.agent-queue-item').length === 3", "queue B/C/D must render", 15000);
  // 队列行相对顺序不保证（SSE 时序），按文本定位 B 行的「立即」按钮点击。
  const promoteB = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.agent-queue-item')]
      .find((r) => (r.querySelector('.agent-queue-text')?.textContent ?? '').includes('队列任务 B'));
    const btn = row?.querySelector('.agent-promote');
    if (!row || !btn) return { ok: false };
    btn.scrollIntoView?.({ block: 'center' });
    const rect = btn.getBoundingClientRect();
    const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    const hit = center.x > 0 && center.y > 0 ? document.elementFromPoint(center.x, center.y) : null;
    const hitTestable = Boolean(hit && (hit === btn || btn.contains(hit)));
    btn.click();
    return { ok: true, hitTestable, hitTag: hit ? hit.tagName : null };
  })()`);
  assert.equal(promoteB.ok, true, `B 行缺失: ${JSON.stringify(promoteB)}`);
  assert.equal(promoteB.hitTestable, true, `B 行「立即」中心不可命中（顶层 ${promoteB.hitTag}）`);
  await waitUntil(win, "document.querySelector('.agent-queue-item--next') !== null", "priority pending must mark next", 8000);
  await waitUntil(win, "[...document.querySelectorAll('.agent-queue-item')].every((r) => r.querySelector('.agent-promote').disabled)", "all promote buttons disabled after priority pending", 8000);

  // ---- 重载页面：会话列表刷新只在 submit/切会话等事件触发，重载走 openProject →
  // refreshSessions 让会话行渲染；队列/优先状态在服务端 snapshot 中保留。----
  await win.loadURL(`http://127.0.0.1:${boundPort}`);
  await waitUntil(win, "Boolean(window.__wwritingMotionReady)", "motion runtime after reload", 10000);
  await waitUntil(win, "document.querySelector('#project-title')?.textContent.includes('视觉验收样例小说')", "dashboard after reload", 10000);
  await waitUntil(win, "document.querySelectorAll('.agent-queue-item').length === 3", "queue rows after reload", 15000);
  await waitUntil(win, "Boolean(document.querySelector('.session-op-compose'))", "session row after reload", 10000);

  const queueAssert = await read(win, `(() => {
    const rows = [...document.querySelectorAll('.agent-queue-item')];
    return {
      count: rows.length,
      rows: rows.map((r) => ({
        text: r.querySelector('.agent-queue-text')?.textContent ?? null,
        badge: r.querySelector('.agent-queue-state')?.textContent ?? null,
        next: r.classList.contains('agent-queue-item--next')
      }))
    };
  })()`);
  assert.equal(queueAssert.count, 3, `queue count after reload: ${JSON.stringify(queueAssert)}`);
  // 队列行的到达顺序可能因 SSE 时序交错（B/C/D 相对顺序不保证），按文本内容断言
  // 集合与徽标（priority pending 只标目标 input，与行位置无关）。
  for (const text of QUEUE_TEXTS) {
    const row = queueAssert.rows.find((r) => r.text === text);
    assert.ok(row, `queue row missing after reload: ${text} (${JSON.stringify(queueAssert)})`);
    assert.equal(row.next, text === QUEUE_TEXTS[0], `${text} 下一条 标记错误（重载后）`);
    assert.equal(row.badge, text === QUEUE_TEXTS[0] ? "下一条" : "排队", `${text} 徽标错误（重载后）`);
  }

  const viewportResults = [];
  const outputLines = [];

  for (const vp of ROUND7_VIEWPORTS) {
    console.log(`[round7] viewport ${vp.width}x${vp.height}`);
    await setViewport(win, vp.width, vp.height);
    const result = { width: vp.width, height: vp.height, horizontalOverflow: false, overlaps: [], imageNonBlank: true, notes: [] };

    // ---- 状态 1：模型设置（弹窗内模型分区，A3/A5：长名 / 密钥已配置 / 连接错误）----
    // 窄视口（≤880px）左侧 rail 按设计隐藏，设置入口走抽屉「模型配置」→「打开
    // 模型设置」（三视口统一路径，避免依赖 rail 可见性）。A3 起该入口打开设置弹窗
    //（#settings-scrim show）并默认落在「模型设置」分区——#settings-detail 内
    // 注入 [data-provider-list]，无整页 #model-settings-page。
    await clickAndReadRetry(win, "#open-drawer", {
      label: "open-drawer-for-settings",
      expect: () => read(win, "document.getElementById('drawer').classList.contains('show')")
    });
    await clickAndReadRetry(win, '.drawer-tabs [data-dtab="model"]', {
      label: "drawer-model-tab",
      expect: () => read(win, "document.querySelector('.dtab[data-dtab=\"model\"]').classList.contains('on')")
    });
    await clickAndReadRetry(win, "#drawer-body .save-btn", {
      label: "open-model-settings",
      settleMs: 300,
      expect: () => read(win, "document.getElementById('settings-scrim').classList.contains('show') && Boolean(document.querySelector('#settings-detail [data-provider-list]'))")
    });
    await waitUntil(win, "document.querySelectorAll('.model-row').length > 0", "model rows must render", 10000);
    await waitUntil(win, "Boolean(document.querySelector('[data-api-key-status]'))", "key status must render", 8000);
    const settingsAudit = await read(win, ROUND7_SETTINGS_AUDIT_SCRIPT);
    assert.deepEqual(settingsAudit.failures, [], `model settings DOM failures: ${JSON.stringify(settingsAudit.failures)}`);
    assert.equal(settingsAudit.horizontalOverflow, false, `model settings horizontal overflow: scrollWidth=${settingsAudit.scrollWidth} clientWidth=${settingsAudit.clientWidth}`);
    assert.deepEqual(settingsAudit.overlaps, [], `model settings overlaps: ${JSON.stringify(settingsAudit.overlaps)}`);
    // 连接错误状态：点击测试连接 → 红字 ✗ 错误行（真实 server fetch 到 127.0.0.1:1
    // 必然失败；commitCurrentDraft → POST test-connection 链较长，用 waitUntil 等终态）
    const testClicked = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('.model-test-connection');
      if (!btn) return { ok: false, reason: 'test button missing' };
      btn.scrollIntoView?.({ block: 'center' });
      const rect = btn.getBoundingClientRect();
      const center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      const hit = center.x > 0 && center.y > 0 ? document.elementFromPoint(center.x, center.y) : null;
      const hitTestable = Boolean(hit && (hit === btn || btn.contains(hit)));
      btn.click();
      return { ok: true, hitTestable, hitTag: hit ? hit.tagName : null };
    })()`);
    assert.equal(testClicked.ok, true, `测试连接按钮缺失: ${testClicked.reason}`);
    assert.equal(testClicked.hitTestable, true, `测试连接按钮中心不可命中（顶层 ${testClicked.hitTag}）`);
    await waitUntil(
      win,
      "Boolean(document.querySelector('.model-connection-result .connection-result.error'))",
      "test-connection error state",
      15000
    );
    const connErrText = await read(win, "document.querySelector('.model-connection-result .connection-result.error')?.textContent ?? null");
    assert.ok(String(connErrText).includes("✗"), `连接错误行应带 ✗: ${connErrText}`);
    await sleep(200);
    await captureRound7Png(win, roundDir, `model-settings-${vp.width}x${vp.height}.png`, [vp.width, vp.height]);

    // ---- 布局检查点（Task A5）：弹窗内模型分区的响应式验收 ----
    // 在已捕获 PNG 的同一渲染状态测量模型分区几何。既有
    // horizontalOverflow:false + overlaps:[] 已覆盖「无横向溢出、无重叠」；
    // 这里按视口宽度追加宽度/折叠/可用性断言。width>=1100 → 双列 + 详情列
    // ≥360px；<=880 → 单列折叠（列表与详情垂直排列、无裁切）；<=720 → .sp-side
    // 隐藏后模型分区仍可用（settings-modal focusFirstInModal 已处理隐藏 nav 焦点）。
    const modelLayout = await read(win, `(() => {
      const list = document.querySelector('#settings-detail [data-provider-list]');
      const detail = document.querySelector('#settings-detail [data-provider-detail]');
      const side = document.querySelector('.sp-side');
      const rl = list ? list.getBoundingClientRect() : null;
      const rd = detail ? detail.getBoundingClientRect() : null;
      const focusable = [...document.querySelectorAll('#settings-scrim button, #settings-scrim [href], #settings-scrim input, #settings-scrim select, #settings-scrim textarea, #settings-scrim [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      return {
        hasList: Boolean(list),
        hasDetail: Boolean(detail),
        listWidth: rl ? Math.round(rl.width) : -1,
        detailWidth: rd ? Math.round(rd.width) : -1,
        listLeft: rl ? Math.round(rl.left) : -1,
        detailLeft: rd ? Math.round(rd.left) : -1,
        detailTop: rd ? Math.round(rd.top) : -1,
        listTop: rl ? Math.round(rl.top) : -1,
        sideDisplay: side ? getComputedStyle(side).display : null,
        focusableCount: focusable.length
      };
    })()`);
    assert.ok(modelLayout.hasList && modelLayout.hasDetail, `model section missing in modal: ${JSON.stringify(modelLayout)}`);
    if (vp.width >= 1100) {
      // 检查点 1（1280）：详情列宽度 ≥360px（双列 280px 侧栏 + 可收缩详情列）
      assert.ok(modelLayout.detailWidth >= 360, `checkpoint1 fail: detail column ${modelLayout.detailWidth}px < 360px at ${vp.width} width`);
      result.notes.push(`checkpoint1 detailColumn>=360px PASS width=${modelLayout.detailWidth}`);
    } else if (vp.width <= 880) {
      // 检查点 2（768/390）：单列折叠——列表与详情共享同一左列、详情在列表下方
      //（垂直排列），即无裁切的双列拆分。
      const stacked = Math.abs(modelLayout.listLeft - modelLayout.detailLeft) <= 1 && modelLayout.detailTop >= modelLayout.listTop;
      assert.ok(stacked, `checkpoint2 fail: single-column collapse at ${vp.width} width not in effect: ${JSON.stringify(modelLayout)}`);
      result.notes.push(`checkpoint2 single-column collapse PASS (listL=${modelLayout.listLeft} detailL=${modelLayout.detailLeft} detailT=${modelLayout.detailTop} listT=${modelLayout.listTop})`);
      // 检查点 3（390，≤720）：.sp-side 隐藏后模型分区仍可用（仍有可聚焦元素）
      if (vp.width <= 720) {
        assert.equal(modelLayout.sideDisplay, "none", `checkpoint3 fail: .sp-side should be hidden at ${vp.width} width`);
        assert.ok(modelLayout.focusableCount >= 1, `checkpoint3 fail: model section not usable (focusable=${modelLayout.focusableCount}) at ${vp.width} width`);
        result.notes.push(`checkpoint3 sp-side hidden + usable PASS focusable=${modelLayout.focusableCount}`);
      }
    }

    await clickAndReadRetry(win, "#settings-x", {
      label: "settings-close",
      expect: () => read(win, "!document.getElementById('settings-scrim').classList.contains('show')")
    });
    // 关闭设置弹窗后显式关抽屉——抽屉在打开设置时不会自动关闭（drawer-panels
    // 的设置按钮直接调 openSettingsModal，未调 closeDrawer），不关则遮挡
    // context-ring-pin 等对话区元素。
    if (await read(win, "document.querySelector('.drawer.show') !== null")) {
      await clickAndReadRetry(win, "#drawer-close", {
        label: "drawer-close-after-settings",
        expect: () => read(win, "!document.querySelector('.drawer').classList.contains('show')")
      });
    }

    // ---- 状态 2：对话区（context popover 固定 + queue B/C/D + priority pending）----
    await clickAndReadRetry(win, '[data-testid="agent-context-ring"]', {
      label: "context-ring-pin",
      expect: () => read(win, "document.querySelector('.agent-context-popover[data-open=\"true\"]') !== null")
    });
    const agentAudit = await read(win, ROUND7_AUDIT_SCRIPT);
    assert.deepEqual(agentAudit.failures, [], `agent view DOM failures: ${JSON.stringify(agentAudit.failures)}`);
    assert.equal(agentAudit.horizontalOverflow, false, `agent view horizontal overflow: scrollWidth=${agentAudit.scrollWidth} clientWidth=${agentAudit.clientWidth}`);
    assert.deepEqual(agentAudit.overlaps, [], `agent view overlaps: ${JSON.stringify(agentAudit.overlaps)}`);
    await captureRound7Png(win, roundDir, `round7-${vp.width}x${vp.height}.png`, [vp.width, vp.height]);

    // ---- 状态 3：rename editor（会话行内改名；规格 4.3 #6 / §6.5）----
    // 会话行在重载后的 openProject → refreshSessions 已渲染（见 staging 段）。
    // 注意：≤880px 视口左侧 rail（含会话列表）按响应式设计隐藏，rename editor
    // 属桌面宽度特性——只在 rail 可见的视口捕获截图，窄视口跳过并在汇总注明。
    const railVisible = vp.width > 880;
    let renameAudit = null; // 仅 railVisible 视口运行；窄视口保持 null（result 汇总时短路跳过）
    if (railVisible) {
      await waitUntil(win, "Boolean(document.querySelector('.session-op-compose'))", "rename button must exist", 10000);
      // 聚焦真实按钮触发 :focus-within，并验证产品 CSS 已让菜单可见可点。
      const renameMenuReady = await win.webContents.executeJavaScript(`(() => {
        const row = document.querySelector('.session-row:not(.session-draft)');
        const menu = row?.querySelector('.session-menu');
        const button = row?.querySelector('.session-op-compose');
        button?.focus();
        const style = menu ? getComputedStyle(menu) : null;
        return {
          ok: Boolean(button && style && Number(style.opacity) >= 0.99 && style.pointerEvents !== 'none'),
          opacity: style?.opacity ?? null,
          pointerEvents: style?.pointerEvents ?? null
        };
      })()`);
      assert.equal(renameMenuReady.ok, true, `session menu focus visibility: ${JSON.stringify(renameMenuReady)}`);
      await sleep(120);
      await clickAndReadRetry(win, ".session-op-compose", {
        label: "rename-editor",
        settleMs: 200,
        expect: () => read(win, "Boolean(document.querySelector('.session-rename-editor'))")
      });
      const renameAssert = await read(win, `(() => {
        const input = document.querySelector('.session-rename-editor');
        return input ? { aria: input.getAttribute('aria-label'), type: input.type } : null;
      })()`);
      assert.equal(renameAssert?.aria, "重命名对话", `rename editor aria-label: ${JSON.stringify(renameAssert)}`);
      // 改名编辑器状态下重跑完整审计（含 .session-rename-editor 参与重叠检查）
      renameAudit = await read(win, ROUND7_AUDIT_SCRIPT);      assert.deepEqual(renameAudit.failures, [], `rename editor DOM failures: ${JSON.stringify(renameAudit.failures)}`);
      assert.deepEqual(renameAudit.overlaps, [], `rename editor overlaps: ${JSON.stringify(renameAudit.overlaps)}`);
      await captureRound7Png(win, roundDir, `rename-editor-${vp.width}x${vp.height}.png`, [vp.width, vp.height]);
      // 复位：Escape 关 rename + 关 popover
      await win.webContents.executeJavaScript(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(250);
    } else {
      console.log(`  [note] ${vp.width}x${vp.height}：rail 按响应式设计隐藏，rename editor 属桌面宽度特性，跳过截图（DOM/行为断言由 verify-app-shell 与 session-sidebar 测试覆盖）`);
      result.notes.push("renameEditor skipped: rail hidden below 880px by responsive design");
    }

    // ---- 状态 4：成本抽屉（人民币元，无 $ / ¥）----
    await clickAndReadRetry(win, "#open-drawer", {
      label: "open-drawer",
      expect: () => read(win, "document.getElementById('drawer').classList.contains('show')")
    });
    await clickAndRead(win, '.drawer-tabs [data-dtab="cost"]', {
      label: "drawer-cost-tab",
      settleMs: 300,
      expect: () => read(win, "Boolean(document.querySelector('.cost-panel-root'))")
    });
    const costAudit = await read(win, ROUND7_COST_AUDIT_SCRIPT);
    assert.deepEqual(costAudit.failures, [], `cost drawer failures: ${JSON.stringify(costAudit.failures)}`);
    const costText = await read(win, "document.getElementById('drawer-body').textContent");
    assert.ok(costText.includes("1.20 元"), "cost drawer pill must be 1.20 元");
    assert.ok(costText.includes("0.80 元"), "chapter cost must be 0.80 元");
    await captureRound7Png(win, roundDir, `cost-panel-${vp.width}x${vp.height}.png`, [vp.width, vp.height]);
    await clickAndRead(win, "#drawer-close", {
      label: "drawer-close",
      expect: async () => !(await read(win, "document.getElementById('drawer').classList.contains('show')"))
    });

    // ---- 截图机器校验（nativeImage.createFromPath）----
    const round7Files = [
      `round7-${vp.width}x${vp.height}.png`,
      `model-settings-${vp.width}x${vp.height}.png`,
      `cost-panel-${vp.width}x${vp.height}.png`
    ];
    if (railVisible) round7Files.push(`rename-editor-${vp.width}x${vp.height}.png`);
    for (const name of round7Files) {
      const check = verifyRound7ImageFile(path.join(roundDir, name), vp.width, vp.height);
      if (!check.pass) {
        throw new Error(`${name} nativeImage 校验失败: ${check.problems.join(" | ")}`);
      }
    }

    // 记录真实审计结果：各状态断言已通过（失败路径早已 throw），此处汇总各状态
    // 审计返回值，保证 JSON 记录的就是实际检查数据而非硬编码默认值。
    result.horizontalOverflow =
      settingsAudit.horizontalOverflow ||
      agentAudit.horizontalOverflow ||
      (railVisible ? renameAudit.horizontalOverflow : false);
    result.overlaps = [
      ...settingsAudit.overlaps,
      ...agentAudit.overlaps,
      ...(railVisible ? renameAudit.overlaps : [])
    ];
    result.imageNonBlank = true; // 截图 nativeImage 校验通过才走到这里
    viewportResults.push(result);
    const jsonLine = JSON.stringify(result);
    console.log(jsonLine);
    outputLines.push(jsonLine);
  }

  // 页面 console 残留检查（模块加载错误）
  for (const message of consoleMessages) {
    assert.ok(!message.includes("Failed to resolve module specifier"), `module resolution error: ${message}`);
    assert.ok(!message.includes("MIME"), `MIME type error: ${message}`);
  }

  // ---- 证据汇总 ----
  const summary = {
    mode: "round7",
    generatedAt: new Date().toISOString(),
    projectRoot,
    notes: [
      "round7 机器断言：三个 viewport 各自覆盖 设置弹窗-模型分区(A3/A5：长名/密钥已配置/连接错误) + 对话区(queue B/C/D + priority pending + context popover + rename editor) + 成本抽屉(人民币元无 $/¥)。",
      "模型设置已在设置弹窗内（#settings-detail 注入 [data-provider-list]），无整页 #model-settings-page。",
      "布局检查点（model-settings 状态）：1280 视口 模型分区无横向溢出/重叠 + 详情列 ≥360px；≤880 视口 .model-settings-body 单列折叠（列表与详情垂直排列、无裁切）；≤720 视口 .sp-side 隐藏后模型分区仍可用。",
      "isInsideScrollableRegion / assertNoUnexpectedOverlaps 为脚本内置辅助函数（计划原文语义）；固定 header 与其子节点不纳入同一 selector 集合。",
      "计划模板 .agent-queued-input 在本仓库为 .agent-queue-item（view.js syncQueue 渲染的真实类名）。",
      "测试数据不含真实密钥：sk-round7- 前缀为测试哨兵，模型设置 DOM 断言其绝不出现。",
      "截图经 nativeImage.createFromPath 校验：非空、尺寸等于 viewport、抽样 bitmap ≥2 种 RGB。"
    ],
    viewports: viewportResults
  };
  fs.writeFileSync(path.join(roundDir, "visual-acceptance-round7.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(roundDir, "MANIFEST.md"),
    [
      "# round7 视觉验收证据清单（真实渲染机器断言）",
      "",
      `- 采集时间：${summary.generatedAt}`,
      "- 采集脚本：scripts/capture-visual-acceptance.cjs（--mode round7）",
      "- 覆盖视口：1280x800、768x900、390x844",
      "- 机器判据（不依赖视觉模型）：横向无溢出、关键 selector 无意外重叠、截图非空且尺寸=viewport、抽样 bitmap ≥2 种 RGB",
      "",
      "| 视口 | 横向溢出 | 重叠 | 截图非空白 |",
      "|---|---|---|---|",
      ...viewportResults.map((r) => `| ${r.width}x${r.height} | ${r.horizontalOverflow ? "FAIL" : "PASS"} | ${r.overlaps.length === 0 ? "PASS" : `FAIL ${JSON.stringify(r.overlaps)}`} | ${r.imageNonBlank ? "PASS" : "FAIL"} |`),
      "",
      "PNG 清单（每视口：对话区 / 设置弹窗-模型分区 / 成本抽屉；rename editor 仅 rail 可见的桌面视口落盘）：",
      "",
      ...ROUND7_VIEWPORTS.flatMap((vp) => [
        `- \`round7-${vp.width}x${vp.height}.png\`（对话区：queue B/C/D + priority pending + context popover）`,
        ...(vp.width > 880 ? [`- \`rename-editor-${vp.width}x${vp.height}.png\`（会话行内改名编辑器：aria-label 重命名对话；≤880px rail 隐藏故无此图）`] : []),
        `- \`model-settings-${vp.width}x${vp.height}.png\`（弹窗内模型分区：超长 provider/model 名 + 密钥已配置 + 连接错误红字）`,
        `- \`cost-panel-${vp.width}x${vp.height}.png\`（成本统一人民币元，无 $ / ¥）`
      ]),
      "",
      `机器 JSON：\`visual-acceptance-round7.json\``,
      ""
    ].join("\n"),
    "utf8"
  );

  const allFiles = fs.readdirSync(roundDir).sort();
  console.log(`  生成文件（${allFiles.length}）: ${allFiles.join(", ")}`);
  return outputLines;
}

// ---------------------------------------------------------------------------
// 证据文件渲染
// ---------------------------------------------------------------------------

function renderManifest(context, { startedAt, projectRoot, plainFolder }) {
  const checkRows = context.checkRows
    .map((row) => {
      const extra = Array.isArray(row.extra) && row.extra.length > 0
        ? row.extra.map((r) => `${r.name}=${r.pass ? "PASS" : "FAIL"}`).join("<br>")
        : "—";
      return `| ${row.file} | ${row.imageSize} | ${row.pixels} | ${row.overflow} | ${row.overlap} | ${extra} |`;
    })
    .join("\n");
  const pngRows = context.manifest
    .map((entry, index) => {
      const audit = context.auditRecords[entry.file];
      const auditRef = audit
        ? `\`${JSON.stringify(audit.openActivityIds)}\` / ${audit.visibleAnimatedCount} 个动效`
        : "—";
      return `| ${index + 1} | \`${entry.file}\` | ${entry.viewport} | ${entry.state} | ${entry.dataSource} | ${entry.parallel_runtime_supported} | ${auditRef} | ${entry.expected} | \`${entry.sha256}\` |`;
    })
    .join("\n");
  const notes = context.environmentNotes.length > 0
    ? context.environmentNotes.map((note) => `- ${note}`).join("\n")
    : "- 无";
  return [
    "# 视觉验收证据清单",
    "",
    `- 采集时间：${startedAt}`,
    `- 采集脚本：scripts/capture-visual-acceptance.cjs（Task 13 改写）`,
    `- 主题：${context.theme}（经 #theme-toggle 真实切换）`,
    `- 真实项目：${projectRoot}`,
    `- 普通文件夹场景：${plainFolder}（无 project.yaml；应用私有历史在 stateRoot）`,
    `- 覆盖视口：390x844、768x900、1280x800、1440x900（conversation-completed 四视口全覆盖）`,
    `- parallel_runtime_supported: false（当前 Runtime 串行执行工具；未制造并行截图。只有 MANIFEST 为 true 且 audit 同时列出两个开放 activity_id 时，两工具文字同时动才允许）`,
    "",
    "## 非主观检查结果",
    "",
    "| 检查 | 结果 |",
    "|---|---|",
    "| 图片宽高与视口一致 | PASS（全部 PNG） |",
    "| 像素非全白/全透明 | PASS |",
    "| 页面无横向 overflow（四个视口） | PASS |",
    "| 关键 selector bounding box 不相交 | PASS |",
    "",
    "逐文件检查明细：",
    "",
    "| 文件 | 图片尺寸 | 像素非空白 | 无横向溢出 | bbox 不相交 | 场景客观检查 |",
    "|---|---|---|---|---|---|",
    checkRows,
    "",
    "场景客观检查说明：",
    "- `sweep-direction`（reasoning-running / tool-after-reasoning）：三帧 PNG 中 label bbox 内的字形列质心 x（浅色 = 列内最暗 <128，深色 = 列内最亮 >128）三帧互不相同且跨度 ≥2px，机器证明扫光带随相位移动；相位由 Web Animations API pause+seek 固定（680/920/1160ms 按实际动画周期等比换算）。Round10 起产品动画为 agent-label-shine（muted↔透明渐变，无旧版 ink 暗带），方向由关键帧决定，不预设左→右。",
    "- `markdown-table-scroll`（markdown-fixture）：Markdown 表格由独立容器承载（`overflow-x: auto`），表格保持 760px 宽；390px 视口必须出现真实容器内溢出（页面级不溢出）。",
    "- `task-list-states`（markdown-fixture）：任务列表同时渲染 checked 与未勾选 checkbox（[x]/[ ] 两态）。",
    "- `builtin-style-detail`（settings-style-detail）：只读详情正文非空，且无启用/删除/编辑控件。",
    "- `plain-folder-first-message`（plain-folder-first-message）：标题非“读取失败”、无错误卡、用户/助手消息各 ≥1、Run 已完成、composer 可用；磁盘上文件夹根无 `project.yaml`、无 `.wwriting/agent`。",
    "",
    "## 动效唯一性审计（live-indicator-audit.json）",
    "",
    "| 文件 | 场景 | 状态 | openActivityIds | 动效文字 | 动效数 | groupHeaderAnimated |",
    "|---|---|---|---|---|---|---|",
    ...context.manifest.map((entry) => {
      const audit = context.auditRecords[entry.file];
      return `| \`${entry.file}\` | ${entry.scenario} | ${entry.state} | \`${JSON.stringify(audit?.openActivityIds ?? [])}\` | \`${JSON.stringify(audit?.visibleAnimatedLabels ?? [])}\` | ${audit?.visibleAnimatedCount ?? 0} | ${audit?.groupHeaderAnimated ?? false} |`;
    }),
    "",
    "所有 sequential 场景（reasoning-running / tool-after-reasoning）捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。图片与 audit JSON 冲突时视觉验收判 FAIL。",
    "",
    "## PNG 清单",
    "",
    "| # | 文件 | viewport | 状态 | 数据来源 | parallel_runtime_supported | 开放 activity / 动效数 | 期望文案 | SHA-256 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    pngRows,
    "",
    "## 场景内容契约说明",
    "",
    "- reasoning-running / tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；运行态标签如实记录，不伪造“正在读取文件”。",
    "- conversation-completed 在四个视口分别采集同一完成会话：用户消息、自动折叠工作组（工作了 N 秒）、最终正文与 composer，验证无横向溢出、无遮挡。",
    "- settings-builtin-styles / settings-style-detail 覆盖设置页「Agent 技能」分区：三个内置写作风格只读行（均衡/快节奏易读/心理文学），点击行展开只读详情（完整 SKILL.md 正文，无启用开关、无编辑/删除控件、无卡片套卡片）。",
    "- drawer 覆盖顶部「面板」按钮打开的章节分区（含导出成书工具条）；右侧常驻竖轨已删除，入口收敛到顶部按钮。",
    "- plain-folder-first-message 覆盖普通文件夹（仅 notes.txt，无 project.yaml）打开后第一条“你好”：真实 /api/projects/open + 真实 UI 打开流程 + composer 发送。",
    "- version-panel 覆盖第九轮版本时间线面板：点击章节历史按钮打开版本面板（fixture 无版本时显示「暂无历史版本」），有版本时可点击恢复按钮触发行内二次确认（确认恢复？）。",
    "- memory-tab 覆盖第九轮抽屉记忆分区：点击记忆 tab 展示三块卡片（故事摘要、工作日志、设定档案）。",
    "- plan-panel 覆盖第九轮任务计划面板：顶栏 chip 展示进度（任务计划 N/M ▾），点击展开条目列表，再次点击收起；fixture 无 plan 事件时 chip 隐藏。",
    "",
    "## 环境说明",
    "",
    notes,
    ""
  ].join("\n");
}

function renderReviewPrompt(roundDir) {
  const directory = roundDir.replace(/\//g, "\\");
  return [
    "你是独立的多模态桌面 UI 验收模型。不要修改代码，也不要相信实现模型对视觉质量的自述。",
    "",
    "视觉证据目录：",
    directory,
    "",
    "请先读取该目录中的 MANIFEST.md 和 live-indicator-audit.json，再逐张检查目录内全部 PNG。若缺图、图片打不开、尺寸与 MANIFEST 不符或关键状态未覆盖，结论必须是 BLOCKED，不能猜测。",
    "",
    "验收内容：",
    "1. 工作组、思考、工具是否为清楚的平级时间线；最终 Assistant 正文是否在工作组下方。",
    "2. reasoning 运行态是否稳定为最多两行；完成态“已完成思考”是否可辨识。",
    "3. Markdown 表格、任务列表、代码块、引用、链接是否排版完整，没有撑破 760px 正文列；窄视口表格在容器内滚动，页面不横向溢出。",
    "4. 390x844、768x900、1280x800、1440x900 下是否有遮挡、截字、横向溢出、控件碰撞或不合理留白（conversation-completed 四视口必须逐张检查）。",
    "5. 设置页 Agent 技能分区：内置写作风格（均衡/快节奏易读/心理文学）是否无框只读展示，不存在项目启用开关、删除/编辑按钮和卡片套卡片；详情正文是否完整可读。",
    "6. 对比 reasoning-running 三帧和 tool-after-reasoning 三帧：扫光带是否随相位移动（label-shine 渐变，无旧版 ink 亮带）、文字不位移、容器不跳动。",
    "7. 着重检查动效唯一性：顺序场景中任何一帧不得同时看到“思考中”和工具文字都在扫光；展开工作组时外层“工作中”不得同时扫光；terminal 场景（conversation-completed / markdown-fixture / settings / drawer / plain-folder）不得残留任何扫光。只有 MANIFEST 明确 parallel_runtime_supported: true 且 audit 同时列出两个开放 activity_id 时，两个工具文字同时动才允许。",
    "8. 逐项检查文字层级：Assistant 正文是否为 regular；H1/H2 是否以深色、字号和字重建立层级而没有滥用 accent/green；H3–H6 是否克制且明显低于 H1/H2；链接、引用、inline code 是否分别具有颜色之外的下划线、左边线、等宽字体信号。",
    "9. 检查任务计划（若可见）：只有“任务计划”标题和唯一当前项加粗；已完成文字不加删除线且没有整行变绿，只有勾选 icon 为绿色。",
    "10. 检查状态色边界：完成/失败只给 icon 或短状态词使用 green/red，工具名、路径、说明和整段回答不得一起染色；等待/停止为中性静态状态。标题、正文和 plan row 出现大面积 accent/green/red，判 FAIL。",
    "11. plain-folder-first-message：顶部不得出现“读取失败”或错误卡；第一条“你好”必须已交换；composer 可用；不得看到 ENOENT、绝对内部路径或 Node.js 原始异常。",
    "12. 色彩、字号、字重、间距、分隔线、圆角、图标和交互层级是否跨对话、设置、drawer 一致；muted 辅助文字仍须清晰可读，不能淡到需要费力辨认。",
    "13. 版本时间线（version-panel）：版本行应显示 vN / 时间 / 来源，无校验和字段；点击恢复按钮后确认态文案 2–6 字（如「确认恢复？」），行内确认不弹窗。",
    "14. 记忆分区（memory-tab）：抽屉记忆 tab 须呈现三块卡片——故事摘要、工作日志（各带历史按钮）、设定档案只读；三块卡片布局完整、无横向溢出。",
    "15. 任务计划面板（plan-panel）：chip 收起时仅顶栏显示进度文字（如「任务计划 2/3 ▾」），不遮挡对话区内容；展开时条目状态图标（✓/●/○）与文字对齐。",
    "16. 版本面板无校验和：version-panel 任意帧中不得出现「校验和」「checksum」「hash」等技术字段，面向用户的版本行仅含版本号、时间、来源标签。",
    "17. 确认恢复文案长度：版本面板确认恢复态的按钮文案须在 2–6 个汉字范围内（如「确认恢复？」），不得出现英文或超长提示。",
    "",
    "不要仅凭单张静态图判断动画，必须交叉比较同场景 t000/t400/t900 三帧与 live-indicator-audit.json。JSON 只能证明 class 数量，图片负责证明视觉上确实只有相应文字在动；两者冲突时判 FAIL。",
    "",
    "请严格返回以下 Markdown，不添加客套话：",
    "",
    "# 视觉验收报告",
    "Verdict: PASS | FAIL | BLOCKED",
    "",
    "## Findings",
    "按 P0/P1/P2/P3 从高到低列出。每条必须包含：严重级别、图片文件名、具体区域、观察到的问题、违反的验收项、建议修改。没有问题时写“无”。",
    "",
    "## Motion Uniqueness",
    "分别报告 reasoning-running、tool-after-reasoning、conversation-completed、markdown-fixture、settings-builtin-styles、settings-style-detail、drawer、plain-folder-first-message、version-panel、memory-tab、plan-panel-open、plan-panel-collapsed 的可见动效数量，并说明图片帧与 audit JSON 是否一致。",
    "",
    "## Viewport Coverage",
    "逐个报告 390x844、768x900、1280x800、1440x900：PASS/FAIL/BLOCKED。",
    "",
    "## Required Recaptures",
    "列出必须重新截图的场景和原因；没有则写“无”。",
    "",
    "## Machine Result",
    "```json",
    '{"verdict":"PASS|FAIL|BLOCKED","p0":0,"p1":0,"p2":0,"p3":0,"motion_uniqueness":"PASS|FAIL|BLOCKED","required_recaptures":[]}',
    "```",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

function cleanup(exitCode) {
  try {
    if (windowRef) {
      windowRef.destroy();
      windowRef = null;
    }
  } catch {
    // 忽略销毁错误
  }
  try {
    if (server) {
      server.close();
      server = null;
    }
  } catch {
    // 忽略关闭错误
  }
  try {
    if (demoRoot) {
      fs.rmSync(demoRoot, { recursive: true, force: true });
      demoRoot = null;
    }
  } catch {
    // Windows 可能短暂占用文件
  }
  try {
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = null;
    }
  } catch {
    // 同上
  }
  if (exitCode !== undefined) {
    app.exit(exitCode);
  }
}

app.on("window-all-closed", () => cleanup(0));
