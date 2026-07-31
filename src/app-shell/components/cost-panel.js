// Cost panel component — three sections: 总览 / 缓存健康 / 章节成本.
//
// Renders directly into a container element. Returns the root element so the
// caller (drawer-panels.js) can decide where to mount it. Uses the same DOM
// building style as components/activity-strip.js so the existing CSS
// (dpanel / dpanel-head / dpanel-body / kv / dpanel-empty) applies without
// new stylesheets.
//
// The container is the *body* of a dpanel (created by the caller), not a fresh
// root — so we build child elements and append. We DO NOT call replaceChildren
// on the caller's element, but we do clear it first to ensure idempotence
// across re-renders (drawer body re-mounts on every tab switch).

import { formatNumber } from "../utils.js";
import { isCacheDiscountedMode } from "../../shared/deepseek-detection.mjs";

const SPARKLINE_LENGTH = 20;
const SPARK_GAP = 1; // px
const SPARK_WIDTH = 4; // px
const SPARK_HEIGHT = 16; // px

// D2：缓存折扣平台（DeepSeek / MiMo）的低命中率诊断提示。一行小字、不弹窗、
// 仅缓存折扣平台模式显示（MiMo 价差 120 倍，与 DeepSeek 同享提示）。
// 文案为计划原文（验收核对一字不差）：同时覆盖冷缓存（改配置）与 TTL 掉命中（间隔过久），不做错误归因。
const LOW_HIT_RATE_HINT = "缓存命中率偏低，可能近期改动了规则/风格/技能配置，或章节间间隔过久";
// stableChangedReason == "stable_hash_changed"（cache_report.json 既有字段，D4 确认可归因）时
// 在原文后附具体归因，仍保持一行小字。
const LOW_HIT_RATE_HINT_STABLE_CHANGED = `${LOW_HIT_RATE_HINT}（检测到规则/风格/技能配置有改动）`;
const LOW_HIT_RATE_THRESHOLD = 0.3; // 累计命中率 <30% 触发
const MIN_WRITING_PATH_CALLS = 10; // 写作路径调用数门限，避免冷启动/样本过少误报

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text != null) node.textContent = props.text;
  if (props.dataset) {
    for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  }
  if (props.style) {
    for (const [k, v] of Object.entries(props.style)) node.style[k] = v;
  }
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v != null) node.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  return node;
}

function section(title, ...children) {
  const sec = el("section", { className: "cost-section", dataset: { costSection: title } },
    el("h5", { className: "cost-section-title", text: title })
  );
  const body = el("div", { className: "cost-section-body" });
  for (const c of children) {
    if (c != null) body.appendChild(c);
  }
  sec.appendChild(body);
  return sec;
}

function row(label, value, valueClass = "") {
  return el("div", { className: "cost-row" },
    el("span", { className: "cost-row-label", text: label }),
    el("span", { className: `cost-row-value ${valueClass}`.trim(), text: value })
  );
}

function formatCost(value, costAvailable) {
  if (!costAvailable) return "未配置价格";
  return `${Number(value ?? 0).toFixed(2)} 元`;
}

function chapterCostText(estimatedCost, calls, costAvailable) {
  if (!costAvailable) return "未配置价格";
  if (!calls || calls === 0) return "0.00 元";
  return `${Number(estimatedCost ?? 0).toFixed(2)} 元`;
}

function meanHitRate(recentHitRates) {
  if (!Array.isArray(recentHitRates) || recentHitRates.length === 0) return 0;
  const sum = recentHitRates.reduce((a, b) => a + Number(b || 0), 0);
  return sum / recentHitRates.length;
}

function buildSparkline(recentHitRates) {
  const wrap = el("div", {
    className: "cost-sparkline",
    dataset: { costSpark: "1" },
    attrs: {
      role: "img",
      "aria-label": `最近 20 次缓存命中率，平均 ${(meanHitRate(recentHitRates) * 100).toFixed(1)}%`
    }
  });
  // Left-align: most recent values occupy the right-most slots; missing slots
  // (older history) are zero-height on the right. This is the natural reading
  // order for a "rolling window" indicator.
  const rates = Array.isArray(recentHitRates) ? recentHitRates.slice(-SPARKLINE_LENGTH) : [];
  const present = rates.length;
  const missing = SPARKLINE_LENGTH - present;
  for (let i = 0; i < present; i++) {
    const rate = rates[i];
    const pct = Math.max(0, Math.min(100, Number(rate ?? 0) * 100));
    wrap.appendChild(el("span", {
      className: "cost-spark",
      style: { height: `${pct}%`, width: `${SPARK_WIDTH}px`, marginRight: `${SPARK_GAP}px` }
    }));
  }
  for (let i = 0; i < missing; i++) {
    wrap.appendChild(el("span", {
      className: "cost-spark",
      style: { height: "0%", width: `${SPARK_WIDTH}px`, marginRight: `${SPARK_GAP}px` }
    }));
  }
  return wrap;
}

function buildOverview(cost, summary) {
  const totalCalls = cost?.calls ?? summary?.modelCalls ?? 0;
  const totalTokens = cost?.totalTokens ?? summary?.totalTokens ?? 0;
  const estimatedCost = cost?.estimatedCost ?? summary?.estimatedCost ?? 0;
  const costAvailable = cost?.costAvailable ?? summary?.costAvailable ?? false;
  const refillCalls = cost?.refillCalls ?? 0;

  return section("总览",
    row("总调用", `${formatNumber(totalCalls)} 次`),
    row("累计 token", formatNumber(totalTokens)),
    row("已计费", formatCost(estimatedCost, costAvailable), costAvailable ? "mono" : "muted"),
    row("补写轮次", `${formatNumber(refillCalls)}`)
  );
}

// 累计命中率 = cacheHitTokens / hitRateInputTokens（token 加权，不含 chat）。
// 无任何写入调用数据时显示占位，避免把 0 当成真实命中率误报。
function cumulativeHitRateText(cost) {
  const base = Number(cost?.hitRateInputTokens ?? 0);
  if (!(base > 0)) return "暂无数据";
  const hitTokens = Number(cost?.cacheHitTokens ?? 0);
  return `${((hitTokens / base) * 100).toFixed(1)}%`;
}

// D2：缓存折扣平台模式（DeepSeek / MiMo）+ 写作路径调用数 ≥10 + 累计命中率 <30% 时返回一行小字提示，否则 null。
// 统计口径沿用 L2：hitRateInputTokens / cacheHitTokens 已排除 chat（cost-tracker 按 stage==="chat" 剔除）；
// 写作路径调用数 = 总调用 - chat 调用（byStage.chat.calls），同样排除 chat。
function lowHitRateHint({ cost = {}, modelConfig = null, cacheSummary = null } = {}) {
  if (!isCacheDiscountedMode(modelConfig)) return null;
  const base = Number(cost.hitRateInputTokens ?? 0);
  if (!(base > 0)) return null; // 无命中率数据不提示（与累计命中率「暂无数据」占位一致，不把 0 当真实命中率）
  if (Number(cost.cacheHitTokens ?? 0) / base >= LOW_HIT_RATE_THRESHOLD) return null;
  const writingPathCalls = Number(cost.calls ?? 0) - Number(cost.byStage?.chat?.calls ?? 0);
  if (writingPathCalls < MIN_WRITING_PATH_CALLS) return null;
  // cache_report.json 的 stableChangedReason == "stable_hash_changed"：最近一次调用稳定区已变更，
  // 归因到「改配置导致的打断」（D4 既有字段，成本为零）。
  if (cacheSummary?.stableChangedReason === "stable_hash_changed") {
    return LOW_HIT_RATE_HINT_STABLE_CHANGED;
  }
  return LOW_HIT_RATE_HINT;
}

function buildCacheHealth(cost, opts = {}) {
  const rates = cost?.recentHitRates ?? [];
  const saved = Number(cost?.cacheSavedCost ?? 0);
  const costAvailable = cost?.costAvailable ?? false;
  const mean = meanHitRate(rates);
  const meanPct = (mean * 100).toFixed(1);
  const children = [
    row("累计命中率", cumulativeHitRateText(cost), "mono"),
    row(`最近 ${SPARKLINE_LENGTH} 次命中率`, `${meanPct}%`, "mono"),
    buildSparkline(rates)
  ];
  if (costAvailable && saved > 0) {
    children.splice(1, 0, row("缓存节省", `${saved.toFixed(2)} 元`, "mono"));
  }
  const hint = lowHitRateHint({ cost, modelConfig: opts.modelConfig, cacheSummary: opts.cacheSummary });
  if (hint) {
    children.push(el("div", {
      className: "cost-hint",
      dataset: { costHint: "low-hit-rate" },
      attrs: { role: "status" },
      text: hint
    }));
  }
  return section("缓存健康", ...children);
}

function buildChapterCost(cost, summary, warning) {
  const byChapter = cost?.byChapter ?? {};
  const costAvailable = cost?.costAvailable ?? summary?.costAvailable ?? false;
  const entries = Object.entries(byChapter)
    .map(([k, v]) => [String(k), v])
    .sort((a, b) => {
      const na = Number(a[0]);
      const nb = Number(b[0]);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a[0]).localeCompare(String(b[0]));
    });

  const body = el("div", { className: "cost-section-body" });
  if (entries.length === 0) {
    body.appendChild(el("div", { className: "dpanel-empty", text: "暂无章节成本记录。" }));
  } else {
    for (const [chapterNo, bucket] of entries) {
      const isWarning = warning && String(warning.chapter_no ?? warning.data?.chapter) === chapterNo;
      const rowEl = el("div", {
        className: `cost-chapter-row${isWarning ? " cost-chapter-warn" : ""}`,
        dataset: { chapterNo }
      },
        el("span", { className: "cost-chapter-no mono", text: `第 ${chapterNo} 章` }),
        el("span", { className: "cost-chapter-calls mono", text: `${formatNumber(bucket.calls ?? 0)} 次调用` }),
        el("span", { className: "cost-chapter-cost mono", text: chapterCostText(bucket.estimatedCost, bucket.calls, costAvailable) })
      );
      if (isWarning) {
        const badge = el("span", {
          className: "cost-warning",
          dataset: { costWarn: "1", chapterNo },
          text: "⚠ 成本预警"
        });
        if (warning.message) badge.title = warning.message;
        rowEl.appendChild(badge);
      }
      body.appendChild(rowEl);
    }
  }
  const sec = el("section", { className: "cost-section", dataset: { costSection: "chapter-cost" } },
    el("h5", { className: "cost-section-title", text: "章节成本" })
  );
  sec.appendChild(body);
  return sec;
}

function buildWarningBanner(warning) {
  if (!warning) return null;
  const chapterNo = warning.chapter_no ?? warning.data?.chapter;
  const chapterText = chapterNo != null ? `第 ${chapterNo} 章` : "未知章节";
  return el("div", {
    className: "cost-warning-banner",
    attrs: { role: "status" },
    dataset: { costWarningBanner: "1", chapterNo: String(chapterNo ?? "") }
  },
    el("span", { className: "cost-warning-icon", text: "⚠" }),
    el("span", { className: "cost-warning-text", text: `${chapterText} 成本预警：${warning.message ?? "token 消耗异常"}` })
  );
}

function resolveLastEvent(events, lastEvent) {
  if (lastEvent && lastEvent.type === "chapter_cost_warning") return lastEvent;
  if (!Array.isArray(events)) return null;
  // events come append-order (oldest first); the most recent warning is the last one
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "chapter_cost_warning") return events[i];
  }
  return null;
}

/**
 * Render the 3-section cost panel into `container`.
 *
 * @param {object} args
 * @param {object|null} args.cost - the cost.json summary object
 * @param {object|null} args.summary - the dashboard summary object (for costAvailable, modelCalls fallback)
 * @param {Array} [args.events=[]] - the events stream (oldest-first); the last chapter_cost_warning is used for the badge
 * @param {object} [args.lastEvent] - optional override for the warning event
 * @param {object|null} [args.modelConfig] - the active_model config ({base_url, model_name}); D2 判定 DeepSeek 模式用
 * @param {object|null} [args.cacheSummary] - dashboard cacheSummary; stableChangedReason 驱动 D2 归因
 * @returns {HTMLElement} the container (for chaining)
 */
export function renderCostPanel({ cost = null, summary = null, events = [], lastEvent = null, modelConfig = null, cacheSummary = null } = {}) {
  const container = el("div", { className: "cost-panel-root" });

  const safeCost = cost ?? {};
  const safeSummary = summary ?? {};
  const warning = resolveLastEvent(events, lastEvent);

  const banner = buildWarningBanner(warning);
  if (banner) container.appendChild(banner);

  container.appendChild(buildOverview(safeCost, safeSummary));
  container.appendChild(buildCacheHealth(safeCost, { modelConfig, cacheSummary }));
  container.appendChild(buildChapterCost(safeCost, safeSummary, warning));

  return container;
}
