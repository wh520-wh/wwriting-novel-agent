// scripts/capture-visual-acceptance.cjs —— 确定性视觉证据采集（计划 Task 15 Step 5-8）。
//
// 职责：为独立多模态验收模型生成完整、自洽、可核对的视觉证据目录：
//   MANIFEST.md / live-indicator-audit.json / multimodal-review-prompt.md + 9 张（+1 张补充）
//   指定命名的 PNG。每轮一个目录，禁止覆盖上一轮。
//
// 驱动路径（Step 5 冻结契约）：
//   - 在同一进程启动真实 app-shell server（createAppShellServer），注入与
//     testLoadDashboardData 同级的 testGatewayFactory 与临时 root 的 skills service；
//   - 用真实 /api/agent/input（经 composer UI 点击）、journal SSE（UI 实时渲染）
//     和 UI 点击驱动全部场景；禁止向 DOM 填假 HTML；
//   - 测试控制器可暂停/恢复确定性 gateway（hold/release），让 reasoning 运行态、
//     计划中间态可被稳定截图。
//
// 动效唯一性（Step 6）：每个 motion frame 捕获前执行 DOM 审计；sequential 场景
// 动效文字 >1、terminal 场景 >0、展开工作组中 groupHeaderAnimated=true 都立即
// 退出 1，绝不交给视觉模型掩盖。当前 Runtime 串行执行工具，MANIFEST 写
// parallel_runtime_supported: false，不制造并行截图。
//
// 非主观检查（Step 5）：图片宽高与视口一致、像素非全白/全透明、页面无横向
// overflow、关键 selector 的 bounding box 不相交——任一失败即退出 1。
//
// 运行：node scripts/capture-visual-acceptance.cjs --round 1
// 期望：退出码 0，输出 evidence directory 与 multimodal-review-prompt.md 绝对路径。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict");

// Bootstrap：brief Step 8 的命令是 `node scripts/capture-visual-acceptance.cjs --round 1`，
// 而 require("electron") 在普通 node 下只返回可执行文件路径。检测到未运行在
// Electron 运行时内时，以 electron 重新拉起本脚本（stdio 与退出码透传）；
// `electron scripts/...` 直接运行同一段代码，不经过重拉。
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
      console.error("capture-visual-acceptance 必须以 Electron 运行（node scripts/capture-visual-acceptance.cjs --round N）");
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
const CAMPAIGN = "2026-08-07-agent-work-log-markdown-skills";
// read_skill 的注入延迟：给 tool-after-reasoning 三帧（t000/t400/t900 + 捕获开销）
// 留足窗口；5s 覆盖约 3.5s 的最坏捕获序列仍有 1.5s 余量。
const SKILL_READ_DELAY_MS = 5000;
const VIEWPORT_DEFAULT = { width: 1280, height: 800 };
const VIEWPORT_NARROW = { width: 390, height: 844 };
const VIEWPORT_MEDIUM = { width: 768, height: 900 };
const VIEWPORT_WIDE = { width: 1440, height: 900 };

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
// 注意：不加 force-prefers-reduced-motion（采集需要 agent-text-shimmer 真实动画）。
// OS 级 reduced-motion 命中时在页面侧做等价的样式归一化（见 main 中的处理）。

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
  const index = argv.indexOf("--round");
  const round = index >= 0 ? Number(argv[index + 1]) : 1;
  if (!Number.isInteger(round) || round < 1) {
    throw new Error("--round 必须是正整数（如 --round 1）");
  }
  return { round };
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

function roundDirFor(mainRepo, round) {
  return path.join(
    mainRepo,
    "artifacts",
    "visual-acceptance",
    CAMPAIGN,
    `round-${String(round).padStart(2, "0")}`
  );
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
  await sleep(300); // 布局/媒体查询稳定
}

// ---------------------------------------------------------------------------
// DOM 审计（Step 6）：motion uniqueness 客观证据
// ---------------------------------------------------------------------------

const AUDIT_SCRIPT = `(() => {
  const isAnimated = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return cs.animationName !== "none" && cs.animationPlayState === "running";
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
  return ["reasoning-running", "tool-after-reasoning", "plan-updated", "plan-updated-2of3"].includes(scenario)
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
// 每个元素先裁剪到最近滚动容器（overflow 裁剪祖先，无则视口）：布局 rect 会越出
// 裁剪边界（如展开工作组延伸到 composer 下方），但视觉上被容器裁剪、并未真的遮挡。
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
    ".agent-composer",
    ".agent-run-status"
  ],
  settings: [
    ".sp-section-item",
    ".sp-section-panel",
    "#settings-x",
    ".spd-segmented",
    "#skills-list"
  ]
};

// 截图 + 审计 + 全部非主观检查，一条龙。
async function auditAndCapture(win, ctx, spec) {
  // 1) motion DOM 审计（每个 motion frame 捕获前执行）
  const audit = await runDomAudit(win);
  const mode = auditModeOf(spec.scenario);
  validateAudit(audit, spec.scenario, mode);
  if (spec.auditKey && !ctx.auditRecords[spec.auditKey]) {
    ctx.auditRecords[spec.auditKey] = {
      scenario: spec.auditKey,
      openActivityIds: audit.openActivityIds,
      visibleAnimatedLabels: audit.visibleAnimatedLabels,
      visibleAnimatedCount: audit.visibleAnimatedCount,
      groupHeaderAnimated: audit.groupHeaderAnimated
    };
  }

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

  // 3) 页面级非主观检查
  const overflow = await checkHorizontalOverflow(win);
  const overlap = await checkNoOverlap(win, spec.overlapSelectors);

  const problems = [
    ...pixelCheck.problems,
    ...(overflow ? [overflow] : []),
    ...(overlap.ok ? [] : [`关键 selector bounding box 相交: ${overlap.pairs.join("; ")}`])
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
    overlap: overlap.ok ? "PASS" : "FAIL"
  });
  console.log(`  ✓ ${spec.file}  (${width}x${height}, ${png.length} B, sha256 ${sha256.slice(0, 12)}…)`);
}

// ---------------------------------------------------------------------------
// 场景内容契约
// ---------------------------------------------------------------------------

// 第一轮思考：足够长（约 950 字），让完成态详情超过 .agent-reasoning-detail 的
// 320px 限高出现滚动区（场景 05「展开详情是否有合理限高和滚动区域」可验收）。
const TURN1_REASONING = [
  "收到分析项目进度的请求，先建立检查顺序，避免重复劳动，也保证结论有依据。",
  "第一步核对大纲结构：前三章是主线引入，第四章进入冲突转折，第五章预计收束。",
  "第二步检查章节提交状态：第一、二章已正式提交，第三章仍在草稿中，尚未通过门禁。",
  "第三步对照任务计划：检查已有章节已完成，修正冲突进行中，验证修改待开始，进度符合预期。",
  "同时需要确认是否有章节门禁失败或连续性记忆冲突，这类问题会直接阻塞后续提交。",
  "再检查成本与运行状态：会话空闲、无排队输入、没有残留的失败运行，可以安全继续。",
  "字数统计显示前两章均已超过最低字数要求，正文语气克制，没有明显 AI 腔的堆砌感。",
  "章节记忆与时间线一致：上一章的结尾与下一章的开头没有时间跳跃或视角错乱。",
  "写作风格检查：对话占比、章节悬念与收束结构都符合当前项目的既定风格。",
  "从最近几次提交看，改稿集中在对话节奏和悬念落点，说明风格已经稳定下来。",
  "剩余风险主要是第三章草稿的完整性，以及后续章节的人名、地名一致性。",
  "为了避免把检查过程写进正文，最后把结论压缩为三条可执行建议，按优先级排列。",
  "第一条建议：继续完善第三章草稿，走完质量门禁后再提交。",
  "第二条建议：下一章展开时保持当前视角与语气，避免节奏突变。",
  "第三条建议：如需大改设定，先更新大纲与记忆，再动正文。",
  "以上检查均已实际完成，不是推测；结论可以直接作为下一步行动的输入。"
];
const TURN1_REASONING_TEXT = TURN1_REASONING.join("");

const PLAN_1 = {
  explanation: "先核对已完成章节",
  items: [
    { id: "p1", step: "检查已有章节", status: "completed" },
    { id: "p2", step: "修正冲突", status: "in_progress" },
    { id: "p3", step: "验证修改", status: "pending" }
  ]
};
const PLAN_2 = {
  items: [
    { id: "p2", step: "修正冲突", status: "completed" },
    { id: "p3", step: "验证修改", status: "pending" }
  ]
};

const REPLY_A = [
  "项目进度分析完成。大纲与章节状态均已核对，结论如下：",
  "",
  "1. 第一、二章已提交，字数达标，可以继续推进第三章草稿。",
  "2. 写作时保持当前克制语气，避免 AI 腔；检查项已按任务计划整理在上方。",
  "3. 需要提交时可直接继续对话，我会先走章节质量门禁。"
].join("\n");

// 场景 09 的安全 Markdown 样例：H1–H6、正文、strong、链接、blockquote、
// inline code、fenced code 全部角色，排版紧凑以放进 1440x900 首屏。
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
  "```"
].join("\n");

// ---------------------------------------------------------------------------
// 场景驱动
// ---------------------------------------------------------------------------

async function submitViaComposer(win, text) {
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

// 工作组 DOM 等待辅助（检查最后一个工作组，对应最近一次输入）
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

async function waitForPlanCount(win, countText) {
  await waitUntil(
    win,
    `document.querySelector('.agent-plan__count')?.textContent === ${JSON.stringify(countText)}`,
    `计划计数 ${countText}`,
    10000
  );
}

async function waitForPlanStatuses(win, statuses) {
  await waitUntil(
    win,
    `JSON.stringify([...document.querySelectorAll('.agent-plan-item')].map((el) => el.dataset.status)) === ${JSON.stringify(JSON.stringify(statuses))}`,
    `计划状态 ${statuses.join("/")}`,
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
        runStatus: document.querySelector(".agent-run-status")?.textContent ?? null,
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
    `document.querySelector("#skills-list")?.children.length > 0`,
    "设置页技能列表渲染",
    8000
  );
}

// 对话滚动到最新（场景 05 的点击会把会话滚到顶部附近，followLatest 不再自动回底）。
async function scrollConversationToBottom(win) {
  await win.webContents.executeJavaScript(`(() => {
    const conv = document.querySelector('[data-testid="agent-conversation"]');
    if (conv) conv.scrollTop = conv.scrollHeight;
    return true;
  })()`);
  await sleep(250);
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
        on: el.classList.contains("on"),
        aria: el.getAttribute("aria-current")
      })),
      sideSection: document.querySelector(".sp-side")?.dataset.section ?? null,
      modalInert: document.getElementById("settings-scrim")?.getAttribute("inert") ?? null
    }))()`);
    throw new Error(`设置分区 ${section} 激活超时。settings DOM: ${JSON.stringify(dump)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const { round } = parseArgs(process.argv.slice(2));
  const mainRepo = mainRepoRootOf(SCRIPT_DIR);
  const roundDir = roundDirFor(mainRepo, round);
  if (fs.existsSync(roundDir)) {
    const entries = fs.readdirSync(roundDir);
    if (entries.length > 0) {
      throw new Error(`证据目录已存在且非空（禁止覆盖上一轮）: ${roundDir}`);
    }
    // 上次失败运行留下的空目录：删除后重建，不算覆盖有效证据
    fs.rmdirSync(roundDir);
  }
  fs.mkdirSync(roundDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const context = {
    round,
    roundDir,
    mainRepo,
    manifest: [],
    checkRows: [],
    auditRecords: {},
    environmentNotes: []
  };
  console.log(`[capture-visual-acceptance] round-${String(round).padStart(2, "0")}`);
  console.log(`  证据目录: ${roundDir}`);

  // ---- 测试项目 + 临时技能 home（read_skill 走临时 root，不碰真实用户目录）----
  demoRoot = path.join(SCRIPT_DIR, "..", ".demo_runs", `visual-acceptance-${Date.now()}`);
  const skillsHome = path.join(demoRoot, "skills-home");
  fs.mkdirSync(skillsHome, { recursive: true });
  const { createProjectAt } = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "src", "core", "project-store.mjs")).href);
  const { projectRoot } = await createProjectAt(path.join(demoRoot, "novel"), {
    title: "视觉验收样例小说",
    story_seed: "一个用于视觉验收的示例项目，覆盖工作组、任务计划与 Markdown 渲染。",
    target_chapters: 3,
    min_words_per_chapter: 10,
    target_words_per_chapter: 20,
    tool_permissions: { yolo: true }
  });

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

  // ---- BrowserWindow（offscreen 渲染：本环境可见窗口 capturePage 抛 UnknownVizError，
  // 实测 offscreen + force-device-scale-factor=1 精确返回视口尺寸）----
  const win = new BrowserWindow({
    width: VIEWPORT_DEFAULT.width,
    height: VIEWPORT_DEFAULT.height,
    show: false,
    backgroundColor: "#f4f3f0",
    autoHideMenuBar: true,
    webPreferences: {
      offscreen: true,
      // 关键：offscreen 隐藏窗口默认 backgroundThrottling，缩小视口后合成器不再
      // 重绘（capturePage 返回全白帧）；关闭节流后任意视口尺寸都能正常产出内容。
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

  await win.loadURL(`http://127.0.0.1:${boundPort}`);
  await waitUntil(win, "Boolean(window.__wwritingMotionReady)", "motion runtime 初始化", 10000);
  await waitUntil(win, "document.querySelector('#project-title')?.textContent.includes('视觉验收样例小说')", "dashboard 加载项目", 10000);
  await waitUntil(win, "document.querySelector('[data-testid=\"agent-composer-input\"]') !== null && !document.querySelector('[data-testid=\"agent-composer-input\"]').disabled", "AgentSurface composer 可用", 10000);
  await waitUntil(win, "Boolean(document.querySelector('[data-testid=\"agent-conversation\"]'))", "对话容器挂载", 8000);

  // OS 级 reduced-motion 归一化（仅在命中时注入等价动效样式；不改产品 CSS/HTML）。
  const reduceMotion = await read(win, "window.matchMedia('(prefers-reduced-motion: reduce)').matches");
  if (reduceMotion) {
    await win.webContents.executeJavaScript(`
      (() => {
        const style = document.createElement("style");
        style.id = "vac-motion-normalization";
        style.textContent = '@media (prefers-reduced-motion: reduce){ .agent-live-text { color: transparent; background: linear-gradient(90deg, var(--muted) 0 34%, var(--ink) 48%, var(--muted) 62% 100%); background-size: 220% 100%; background-clip: text; -webkit-background-clip: text; animation: agent-text-shimmer 1.45s linear infinite !important; } }';
        document.head.append(style);
        return true;
      })()
    `);
    context.environmentNotes.push("OS prefers-reduced-motion 命中：注入 agent.css 等价动效样式（仅测试环境归一化，用于让扫光动画按产品设计运行）");
    console.log("  [note] OS prefers-reduced-motion=reduce：已注入等效动效样式");
  }

  // =========================================================================
  // 场景驱动（全部经真实 UI / API / journal SSE 路径）
  // =========================================================================

  // ---- 输入 A：reasoning → tool → plan → reply ----
  gateway.controller.setScripts([
    [
      { type: "reasoning", tokens: TURN1_REASONING },
      { type: "hold" }, // 01: reasoning-running 三帧
      { type: "reasoning", tokens: ["接下来读取技能说明，确认写作约束。"] },
      { type: "tool", name: "read_skill", arguments: { name: "avoid-ai-voice" } }, // 02: 慢工具
      { type: "reasoning", tokens: ["正在规划执行计划。"] },
      { type: "tool", name: "update_plan", arguments: PLAN_1 }, // 计划 1/3（三态）
      { type: "reasoning", tokens: ["核对计划进度。"] },
      { type: "hold" }, // 03: 计划 1/3（completed/in_progress/pending）
      { type: "tool", name: "update_plan", arguments: PLAN_2 }, // 计划 2/3
      { type: "reasoning", tokens: ["完成规划收尾。"] },
      { type: "hold" }, // 03b: 计划 2/3
      { type: "reply", text: REPLY_A }
    ],
    [
      { type: "reasoning", tokens: ["准备 Markdown 渲染样例。"] },
      { type: "reply", text: MARKDOWN_SAMPLE }
    ]
  ]);

  // ---- 01: reasoning-running（3 帧，单 hold 内间隔捕获）----
  console.log("[scenario] 01-reasoning-running");
  await submitViaComposer(win, "请分析项目进度");
  await gateway.controller.waitForHold(20000);
  await waitForReasoningRunning(win);
  await auditAndCapture(win, context, {
    file: "01-reasoning-running-1280x800-t000.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    auditKey: "reasoning-running",
    expected: "工作组展开；reasoning 运行态：label“思考中”+ 扫光动画，摘要最多两行",
    spec: "Task 15 验收矩阵「流式 reasoning」+ Step 5 场景 01",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await sleep(400);
  await auditAndCapture(win, context, {
    file: "01-reasoning-running-1280x800-t400.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    expected: "同 t000；扫光从左向右移动，文字不位移，容器不跳动",
    spec: "Task 15 Step 5 场景 01 / Step 7 验收第 6 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await sleep(500);
  await auditAndCapture(win, context, {
    file: "01-reasoning-running-1280x800-t900.png",
    viewport: [1280, 800],
    scenario: "reasoning-running",
    expected: "同 t000；文本按自然片段替换，label“思考中”保持原位",
    spec: "Task 15 Step 5 场景 01 / Step 7 验收第 6 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  gateway.controller.release();

  // ---- 02: tool-after-reasoning（read_skill 慢窗口 3s，无需 hold）----
  console.log("[scenario] 02-tool-after-reasoning");
  await waitForToolRunning(win, "正在调用 read_skill");
  await auditAndCapture(win, context, {
    file: "02-tool-after-reasoning-1280x800-t000.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    auditKey: "tool-after-reasoning",
    expected: "reasoning 已完成（“已完成思考”，无动画）；工具运行态“正在调用 read_skill”+ 扫光，唯一动效",
    spec: "Task 15 Step 5 场景 02 / Step 6 动效唯一性",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await sleep(400);
  await auditAndCapture(win, context, {
    file: "02-tool-after-reasoning-1280x800-t400.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    expected: "同 t000；工具扫光移动，reasoning 完成态不动",
    spec: "Task 15 Step 7 验收第 6 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await sleep(500);
  await auditAndCapture(win, context, {
    file: "02-tool-after-reasoning-1280x800-t900.png",
    viewport: [1280, 800],
    scenario: "tool-after-reasoning",
    expected: "同 t000；工具扫光移动，reasoning 完成态不动",
    spec: "Task 15 Step 7 验收第 6 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });

  // ---- 03/03b: 计划（三态 1/3 → 2/3）----
  console.log("[scenario] 03-plan-updated");
  await gateway.controller.waitForHold(20000); // 03 hold
  await waitForPlanCount(win, "1/3");
  await waitForPlanStatuses(win, ["completed", "in_progress", "pending"]);
  await auditAndCapture(win, context, {
    file: "03-plan-updated-1280x800.png",
    viewport: [1280, 800],
    scenario: "plan-updated",
    expected: "任务计划 1/3：一个 completed（绿色勾选 icon，regular）+ 一个 in_progress（加粗）+ 一个 pending（常规）",
    spec: "Task 15 Step 5 场景 03 / Step 7 验收第 9 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  gateway.controller.release();
  await gateway.controller.waitForHold(20000); // 03b hold
  await waitForPlanCount(win, "2/3");
  await auditAndCapture(win, context, {
    file: "03b-plan-updated-2of3-1280x800.png",
    viewport: [1280, 800],
    scenario: "plan-updated-2of3",
    expected: "任务计划 2/3：两个 completed + 一个 pending（与测试冻结契约 2/3 一致）",
    spec: "Task 15 Step 5 场景 03（2/3 计数；三态对比见 03-plan-updated）",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  gateway.controller.release();

  // ---- 04: completed-collapsed ----
  console.log("[scenario] 04-completed-collapsed");
  await waitForRunTerminal(win, false, { port: boundPort, projectRoot });
  await auditAndCapture(win, context, {
    file: "04-completed-collapsed-1280x800.png",
    viewport: [1280, 800],
    scenario: "completed",
    auditKey: "completed",
    expected: "工作组完成态自动折叠：summary 显示“工作了 N 秒”，无任何扫光残留",
    spec: "Task 15 Step 5 场景 04 / Step 6 终态 0 动效",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });

  // ---- 05: reasoning-expanded（点击工作组 summary 展开，真实 UI 点击）----
  console.log("[scenario] 05-reasoning-expanded");
  await clickAndRead(win, "details.agent-work-group > summary", {
    label: "open-completed-group",
    expect: () => read(win, `${LAST_GROUP}.open === true`)
  });
  await waitUntil(win, `Boolean(${LAST_GROUP}.querySelector('.agent-reasoning-detail:not([hidden])'))`, "reasoning 详情展开", 5000);
  // 把首个（turn-1，长文本）reasoning 详情滚到视口中央，露出限高与滚动区
  await win.webContents.executeJavaScript(`(() => {
    const detail = [...document.querySelectorAll('.agent-work-item[data-kind="reasoning"] .agent-reasoning-detail:not([hidden])')]
      .find((el) => el.isConnected);
    if (detail) detail.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await sleep(300);
  await auditAndCapture(win, context, {
    file: "05-reasoning-expanded-1280x800.png",
    viewport: [1280, 800],
    scenario: "reasoning-expanded",
    expected: "已完成思考详情展开：完整推理文本，max-height 320px 限高与滚动区",
    spec: "Task 15 Step 5 场景 05 / Step 7 验收第 2 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });
  await clickAndRead(win, "details.agent-work-group > summary", {
    label: "collapse-completed-group",
    expect: () => read(win, `${LAST_GROUP}.open === false`)
  });

  // ---- 输入 B：Markdown 渲染样例（09/07 共用）----
  console.log("[scenario] 09/07-markdown-sample");
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
      runStatus: document.querySelector(".agent-run-status")?.textContent ?? null
    }))()`);
    console.log(`  [diag] gateway calls=${JSON.stringify(gateway.controller.state.callLog)} dom=${JSON.stringify(diag)}`);
  }
  const markdownRoles = await read(win, `(() => {
    const bubbles = [...document.querySelectorAll(".agent-message--assistant .agent-message-text")];
    const roles = {
      h1: ".agent-markdown h1", h2: ".agent-markdown h2", h3: ".agent-markdown h3",
      h4: ".agent-markdown h4", h5: ".agent-markdown h5", h6: ".agent-markdown h6",
      strong: ".agent-markdown strong", links: '.agent-markdown a[data-external-link]',
      blockquote: ".agent-markdown blockquote", inlineCode: ".agent-markdown code",
      fence: ".agent-markdown pre.md-fence", body: ".agent-markdown p"
    };
    const counts = {};
    for (const [key, sel] of Object.entries(roles)) {
      counts[key] = document.querySelectorAll(".agent-message--assistant " + sel).length;
    }
    counts._bubbles = bubbles.map((el) => ({ text: (el.textContent || "").slice(0, 200), markdown: el.classList.contains("agent-markdown") }));
    return counts;
  })()`);
  assert.ok(markdownRoles.h1 >= 1 && markdownRoles.h2 >= 1 && markdownRoles.h3 >= 1, `H1-H3 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.h4 >= 1 && markdownRoles.h5 >= 1 && markdownRoles.h6 >= 1, `H4-H6 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.body >= 1, `正文段落缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.strong >= 1 && markdownRoles.links >= 1 && markdownRoles.blockquote >= 1, `strong/链接/引用缺失: ${JSON.stringify(markdownRoles)}`);
  assert.ok(markdownRoles.inlineCode >= 1 && markdownRoles.fence >= 1, `inline code/fenced code 缺失: ${JSON.stringify(markdownRoles)}`);
  assert.equal(gateway.controller.state.callLog.some((call) => call.result === "default"), false, `gateway 出现默认答复（步骤队列错位）: ${JSON.stringify(gateway.controller.state.callLog)}`);
  delete markdownRoles._bubbles;
  console.log(`  ✓ Markdown 角色齐备: ${JSON.stringify(markdownRoles)}`);
  await scrollConversationToBottom(win);

  // ---- 06: 设置页 Agent 技能（1280x800）----
  console.log("[scenario] 06-settings-agent-skills");
  await clickAndRead(win, "#open-settings", {
    label: "open-settings",
    expect: () => overlayVisible(win, "settings-scrim")
  });
  await clickAndRead(win, '.sp-section-item[data-section="skills"]', {
    label: "settings-skills-section",
    expect: () => waitForSettingsSection(win, "skills")
  });
  await waitForSkillsList(win);
  await auditAndCapture(win, context, {
    file: "06-settings-agent-skills-1280x800.png",
    viewport: [1280, 800],
    scenario: "settings-agent-skills",
    expected: "设置页「Agent 技能」分区：全局/项目分段控件 + 技能列表；无启用开关、无卡片套卡片",
    spec: "Task 15 Step 5 场景 06 / Step 7 验收第 5 条",
    overlapSelectors: OVERLAP_SELECTORS.settings
  });
  await clickAndRead(win, "#settings-x", {
    label: "settings-close",
    expect: async () => !(await overlayVisible(win, "settings-scrim"))
  });

  // ---- 07: 窄屏 390x844（聊天视图）----
  console.log("[scenario] 07-chat-narrow");
  await setViewport(win, VIEWPORT_NARROW.width, VIEWPORT_NARROW.height);
  await auditAndCapture(win, context, {
    file: "07-chat-narrow-390x844.png",
    viewport: [390, 844],
    scenario: "chat-narrow",
    expected: "390x844 窄屏聊天：对话/工作组/正文不遮挡、不横向溢出、控件不碰撞",
    spec: "Task 15 Step 5 场景 07 / Step 7 验收第 4 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });

  // ---- 08: 中等屏 768x900（设置页技能分区）----
  // 768 ≤ 880：左侧 rail（含 #open-settings）被窄屏媒体查询隐藏，应用自身的
  // 窄屏设置入口是 composer 斜杠命令 /settings（真实 UI 路径）。
  console.log("[scenario] 08-settings-medium");
  await setViewport(win, VIEWPORT_MEDIUM.width, VIEWPORT_MEDIUM.height);
  await submitViaComposer(win, "/settings");
  await waitUntil(win, "document.getElementById('settings-scrim')?.classList.contains('show')", "设置弹窗经 /settings 打开", 8000);
  await clickAndRead(win, '.sp-section-item[data-section="skills"]', {
    label: "settings-skills-section-medium",
    expect: () => waitForSettingsSection(win, "skills")
  });
  await waitForSkillsList(win);
  await auditAndCapture(win, context, {
    file: "08-settings-medium-768x900.png",
    viewport: [768, 900],
    scenario: "settings-medium",
    expected: "768x900 设置页「Agent 技能」分区：布局完整、无遮挡/溢出/碰撞",
    spec: "Task 15 Step 5 场景 08 / Step 7 验收第 4 条",
    overlapSelectors: OVERLAP_SELECTORS.settings
  });
  await clickAndRead(win, "#settings-x", {
    label: "settings-close-medium",
    expect: async () => !(await overlayVisible(win, "settings-scrim"))
  });

  // ---- 09: 宽屏 1440x900（Markdown 全部角色）----
  console.log("[scenario] 09-chat-wide");
  await setViewport(win, VIEWPORT_WIDE.width, VIEWPORT_WIDE.height);
  await scrollConversationToBottom(win);
  await auditAndCapture(win, context, {
    file: "09-chat-wide-1440x900.png",
    viewport: [1440, 900],
    scenario: "chat-wide",
    expected: "1440x900 宽屏：H1-H6、正文、strong、链接、blockquote、inline code、fenced code 全部可见且排版完整",
    spec: "Task 15 Step 5 场景 09 / Step 7 验收第 3、8 条",
    overlapSelectors: OVERLAP_SELECTORS.chat
  });

  // 确认 09 截图里所有文字角色都在视口内（不可见时追加带序号 PNG）
  const visibleRoles = await read(win, `(() => {
    const bubble = [...document.querySelectorAll(".agent-message--assistant .agent-markdown")].at(-1);
    if (!bubble) return { missing: ["bubble"] };
    const roles = {
      h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6",
      body: "p", strong: "strong", links: "a[data-external-link]",
      blockquote: "blockquote", inlineCode: "code", fence: "pre.md-fence"
    };
    const missing = [];
    for (const [key, sel] of Object.entries(roles)) {
      const el = bubble.querySelector(sel);
      if (!el) { missing.push(key); continue; }
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight || r.top < 0 || r.right > window.innerWidth + 1 || r.left < -1) {
        missing.push(key + "(off-viewport)");
      }
    }
    return { missing };
  })()`);
  if (visibleRoles.missing.length > 0) {
    await win.webContents.executeJavaScript(`(() => {
      const conv = document.querySelector('[data-testid="agent-conversation"]');
      if (conv) conv.scrollTop = conv.scrollHeight;
      return true;
    })()`);
    await sleep(300);
    await auditAndCapture(win, context, {
      file: "09b-chat-wide-markdown-rest-1440x900.png",
      viewport: [1440, 900],
      scenario: "chat-wide",
      expected: `09 未全部落入首屏的 Markdown 角色补拍：${visibleRoles.missing.join("、")}`,
      spec: "Task 15 Step 5 场景 09（视口放不下时允许追加带序号 PNG）",
      overlapSelectors: OVERLAP_SELECTORS.chat
    });
    console.log(`  [note] 09 首屏缺少角色，追加 09b 补拍: ${visibleRoles.missing.join("、")}`);
  }

  // ---- 页面 console 残留检查（模块加载错误会留下 MIME/解析错误）----
  for (const message of consoleMessages) {
    assert.ok(!message.includes("Failed to resolve module specifier"), `模块解析错误: ${message}`);
    assert.ok(!message.includes("MIME"), `MIME 类型错误: ${message}`);
  }

  // =========================================================================
  // 证据文件
  // =========================================================================

  // live-indicator-audit.json（Step 6：三个冻结记录）
  const auditJsonPath = path.join(roundDir, "live-indicator-audit.json");
  const auditRecords = [
    context.auditRecords["reasoning-running"],
    context.auditRecords["tool-after-reasoning"],
    context.auditRecords["completed"]
  ];
  for (const record of auditRecords) {
    assert.ok(record, "live-indicator-audit 缺少冻结记录");
  }
  fs.writeFileSync(auditJsonPath, JSON.stringify(auditRecords, null, 2) + "\n", "utf8");

  // MANIFEST.md
  const manifestPath = path.join(roundDir, "MANIFEST.md");
  fs.writeFileSync(manifestPath, renderManifest(context, { startedAt, projectRoot, auditRecords }), "utf8");

  // multimodal-review-prompt.md（Step 7：verbatim + 本轮绝对目录）
  const promptPath = path.join(roundDir, "multimodal-review-prompt.md");
  fs.writeFileSync(promptPath, renderReviewPrompt(roundDir), "utf8");

  // ---- 校验证据目录完整 ----
  const expectedFiles = [
    "MANIFEST.md",
    "live-indicator-audit.json",
    "multimodal-review-prompt.md",
    "01-reasoning-running-1280x800-t000.png",
    "01-reasoning-running-1280x800-t400.png",
    "01-reasoning-running-1280x800-t900.png",
    "02-tool-after-reasoning-1280x800-t000.png",
    "02-tool-after-reasoning-1280x800-t400.png",
    "02-tool-after-reasoning-1280x800-t900.png",
    "03-plan-updated-1280x800.png",
    "04-completed-collapsed-1280x800.png",
    "05-reasoning-expanded-1280x800.png",
    "06-settings-agent-skills-1280x800.png",
    "07-chat-narrow-390x844.png",
    "08-settings-medium-768x900.png",
    "09-chat-wide-1440x900.png"
  ];
  for (const file of expectedFiles) {
    const target = path.join(roundDir, file);
    assert.ok(fs.existsSync(target) && fs.statSync(target).size > 0, `缺少证据文件: ${file}`);
  }
  const allFiles = fs.readdirSync(roundDir).sort();
  console.log(`  生成文件（${allFiles.length}）: ${allFiles.join(", ")}`);

  return {
    output: [
      "",
      "功能验证完成，等待独立多模态视觉验收。",
      `Evidence directory: ${roundDir}`,
      `Multimodal review prompt: ${promptPath}`,
      `Generated: ${allFiles.length} files (${context.manifest.length} PNGs, manifest, audit, prompt)`,
      `parallel_runtime_supported: false`,
      ""
    ].join("\n")
  };
}

// ---------------------------------------------------------------------------
// 证据文件渲染
// ---------------------------------------------------------------------------

function renderManifest(context, { startedAt, projectRoot, auditRecords }) {
  const checkRows = context.checkRows
    .map((row) => `| ${row.file} | ${row.imageSize} | ${row.pixels} | ${row.overflow} | ${row.overlap} |`)
    .join("\n");
  const pngRows = context.manifest
    .map((entry, index) => `| ${index + 1} | \`${entry.file}\` | \`${entry.absolutePath}\` | ${entry.viewport} | ${entry.scenario} | ${entry.expected} | ${entry.spec} | \`${entry.sha256}\` |`)
    .join("\n");
  const auditRows = auditRecords
    .map((record) => `| ${record.scenario} | \`${JSON.stringify(record.openActivityIds)}\` | \`${JSON.stringify(record.visibleAnimatedLabels)}\` | ${record.visibleAnimatedCount} | ${record.groupHeaderAnimated} |`)
    .join("\n");
  const notes = context.environmentNotes.length > 0
    ? context.environmentNotes.map((note) => `- ${note}`).join("\n")
    : "- 无";
  return [
    "# 视觉验收证据清单",
    "",
    `- 轮次：round-${String(context.round).padStart(2, "0")}`,
    `- 采集时间：${startedAt}`,
    `- 采集脚本：scripts/capture-visual-acceptance.cjs`,
    `- 测试项目：${projectRoot}`,
    `- 覆盖视口：1280x800、768x900、390x844、1440x900`,
    `- parallel_runtime_supported: false（当前 Runtime 串行执行工具；未制造并行截图；只有 MANIFEST 为 true 且 audit 同时列出两个开放 activity_id 时，两工具文字同时动才允许）`,
    "",
    "## 非主观检查结果",
    "",
    "| 检查 | 结果 |",
    "|---|---|",
    "| 图片宽高与视口一致 | PASS（全部 PNG） |",
    "| 像素非全白/全透明 | PASS |",
    "| 页面无横向 overflow | PASS |",
    "| 关键 selector bounding box 不相交 | PASS |",
    "",
    "逐文件检查明细：",
    "",
    "| 文件 | 图片尺寸 | 像素非空白 | 无横向溢出 | bbox 不相交 |",
    "|---|---|---|---|---|",
    checkRows,
    "",
    "## 动效唯一性审计（live-indicator-audit.json）",
    "",
    "| 场景 | openActivityIds | visibleAnimatedLabels | 动效数 | groupHeaderAnimated |",
    "|---|---|---|---|---|",
    auditRows,
    "",
    "所有 sequential 场景捕获时动效文字均 ≤1，terminal 场景均 =0，展开工作组无 groupHeaderAnimated=true；任一违反采集脚本已退出 1。",
    "",
    "## PNG 清单",
    "",
    "| # | 文件 | 绝对路径 | viewport | 场景 | 期望文案 | 对应规格 | SHA-256 |",
    "|---|---|---|---|---|---|---|---|",
    pngRows,
    "",
    "## 场景内容契约说明",
    "",
    "- 03-plan-updated-1280x800.png 显示三个计划状态（completed / in_progress / pending）以便比较字重与颜色；计划计数按冻结实现为 completed/total，三态时显示 `任务计划 1/3`。",
    "- 03b-plan-updated-2of3-1280x800.png 为补充图（同场景追加带序号 PNG）：第二次 update_plan 后计划为 completed/completed/pending，计数 `任务计划 2/3`，与 tests/app-shell/agent-surface.test.mjs 的 2/3 冻结语义一致。",
    "- 02-tool-after-reasoning 的慢工具为真实 read_skill（经注入的临时 root skills service，读真实的 SKILL.md，仅测试注入 5s 延迟）；read_file 无法被确定性延长，故运行态标签为“正在调用 read_skill”（Step 6 审计如实记录实际标签，不伪造“正在读取文件”）。",
    "- 09-chat-wide-1440x900.png 覆盖 H1–H6、正文、strong、链接、blockquote、inline code、fenced code；若首屏放不下会自动追加 09b。",
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
    "1. 工作组、思考、工具、任务计划是否为清楚的平级时间线；最终 Assistant 正文是否在工作组下方。",
    "2. reasoning 运行态是否稳定为最多两行；完成态“已完成思考”是否可辨识；展开详情是否有合理限高和滚动区域。",
    "3. Markdown 表格、任务列表、代码块、引用、链接是否排版完整，没有撑破 760px 正文列。",
    "4. 1280x800、1440x900、768x900、390x844 下是否有遮挡、截字、横向溢出、控件碰撞或不合理留白。",
    "5. 设置页 Agent 技能分区是否延续当前白色/中性、紧凑、克制的桌面产品语言；是否不存在项目启用开关和卡片套卡片。",
    "6. 对比 reasoning-running 三帧和 tool-after-reasoning 三帧：文字扫光是否从左向右、文字不位移、容器不跳动。",
    "7. 着重检查动效唯一性：顺序场景中任何一帧不得同时看到“思考中”和工具文字都在扫光；展开工作组时外层“工作中”不得同时扫光；completed 截图不得残留任何扫光。只有 MANIFEST 明确 parallel_runtime_supported: true 且 audit 同时列出两个开放 activity_id 时，两个工具文字同时动才允许。",
    "8. 逐项检查文字层级：Assistant 正文是否为 regular；H1/H2 是否以深色、字号和字重建立层级而没有滥用 accent/green；H3–H6 是否克制且明显低于 H1/H2；链接、引用、inline code 是否分别具有颜色之外的下划线、左边线、等宽字体信号。",
    "9. 检查任务计划：只有“任务计划”标题和唯一当前项加粗；待办与已完成项不加粗；已完成文字不加删除线且没有整行变绿，只有勾选 icon 为绿色。若一张图中多个非标题计划项同时显著加粗，判 FAIL。",
    "10. 检查状态色边界：完成/失败只给 icon 或短状态词使用 green/red，工具名、路径、说明和整段回答不得一起染色；等待/停止为中性静态状态。标题、正文和 plan row 出现大面积 accent/green/red，判 FAIL。",
    "11. 色彩、字号、字重、间距、分隔线、圆角、图标和交互层级是否跨对话、设置、drawer 一致；muted 辅助文字仍须清晰可读，不能淡到需要费力辨认。",
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
    "分别报告 reasoning-running、tool-after-reasoning、completed、parallel-tools（若存在）的可见动效数量，并说明图片帧与 audit JSON 是否一致。",
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
