// 全项目 UI/UX 一致性（Task 14）文字样式契约测试。
//
// 冻结契约（plan §2.6，逐条实现）：
//   1. 三层 token（primitive → semantic --text-*/--weight-* → component --agent-*）
//      完整存在；agent component selector 不含 raw hex；dark theme 只覆盖 primitive，
//      不覆盖 component alias。
//   2. .agent-markdown h1/h2 使用 heading primary（不是 accent/status）；H1–H6 的
//      字号、行高、字重与 §2.6 完全一致。
//   3. .agent-plan__title 与唯一 [data-status="in_progress"] 为 semibold；
//      pending/completed 为 regular；completed 步骤删除线。
//   4. success/danger 颜色只作用于 icon/短状态 selector，不命中 .agent-plan-item、
//      .agent-work-item、.agent-markdown 整体。
//   5. 必要 helper、duration、reasoning ticker、路径至少使用 --text-muted，
//      不使用 --text-placeholder/faint；placeholder token 只出现在 placeholder 语境。
//   6. 计算后颜色对比度：primary/secondary/muted/link/状态短语在对应背景 ≥4.5:1；
//      focus ring 与非文字 icon ≥3:1。
//   7. streaming/terminal fixture 命中同一 .agent-markdown typography 路径，
//      不存在 .is-streaming h* / .is-complete h* 重复字级规则。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "..", "src", "app-shell");
const stylesSource = (await fs.readFile(path.join(srcDir, "styles.css"), "utf8")).replace(/\r\n/g, "\n");
const agentCssSource = (await fs.readFile(path.join(srcDir, "agent", "agent.css"), "utf8")).replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// CSS 解析 helper（无 JSDOM：解析源码 + 手工展开 var() 链 + 纯 JS 对比度计算）
// ---------------------------------------------------------------------------

function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const j = source.indexOf("/*", i);
    if (j < 0) { out += source.slice(i); break; }
    out += source.slice(i, j);
    const k = source.indexOf("*/", j + 2);
    i = k < 0 ? source.length : k + 2;
  }
  return out;
}

function allRules(source) {
  const rules = [];
  const clean = stripComments(source);
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/gu;
  let m;
  while ((m = re.exec(clean)) !== null) {
    rules.push({ selector: m[1].trim(), decls: m[2] });
  }
  return rules;
}

// 按精确 selector 取规则声明体（顶层规则；同名只取首次出现 = 基础规则）。
function extractBlock(source, selector) {
  const rule = allRules(source).find((r) => r.selector === selector);
  return rule ? rule.decls : null;
}

function extractDecls(block) {
  const out = {};
  if (!block) return out;
  for (const raw of block.split(";")) {
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const prop = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

// 顶层 @media 块列表（allRules 的 regex 跳过 media 嵌套，这里单独拆块）。
function mediaBlocks(source) {
  const out = [];
  const re = /@media\s*[^{]*\{/gu;
  let m;
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf("{", m.index);
    let depth = 1;
    let i = open + 1;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(source.slice(m.index, i));
  }
  return out;
}

// 浅色 :root 的 token 表（唯一来源）。
const rootBlock = extractBlock(stylesSource, ":root");
const rootTokens = extractDecls(rootBlock);

function resolveVar(name, seen = new Set()) {
  const raw = rootTokens[name] ?? "";
  if (seen.has(name)) return raw;
  seen.add(name);
  const m = raw.match(/^var\(--([a-z0-9-]+)\)$/u);
  return m ? resolveVar(`--${m[1]}`, seen) : raw;
}

// WCAG 相对亮度与对比度
function srgbChannel(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}
function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 最小 DOM fixture（挂载关键结构，验证 class/data-status 接线与 CSS 覆盖）
// ---------------------------------------------------------------------------
class FixtureEl {
  constructor(className = "") {
    this.className = className;
    this.dataset = {};
    this.children = [];
    this._set = new Set(String(className).split(/\s+/).filter(Boolean));
  }
  get classList() {
    return {
      contains: (c) => this._set.has(c),
      add: (c) => this._set.add(c),
    };
  }
  append(...els) { this.children.push(...els); return this; }
  queryAll(cls) { return this.children.filter((el) => el.classList.contains(cls)); }
}

function markdownFixture() {
  const streaming = new FixtureEl("agent-message-text agent-markdown");
  const terminal = new FixtureEl("agent-message-text agent-markdown");
  for (const el of [streaming, terminal]) {
    el.append(new FixtureEl("h1"), new FixtureEl("h2"), new FixtureEl("p"));
  }
  return { streaming, terminal };
}

// ===========================================================================
// 1) 三层 token + 无 raw hex + dark 只覆盖 primitive
// ===========================================================================
test("三层 token 完整存在：primitive → semantic → component，dark 只覆盖 primitive", () => {
  for (const token of [
    "--text-primary", "--text-secondary", "--text-muted", "--text-placeholder",
    "--text-link", "--text-success", "--text-warning", "--text-danger"
  ]) {
    assert.ok(token in rootTokens, `styles.css :root 应声明 ${token}`);
  }
  for (const token of [
    "--weight-regular", "--weight-medium", "--weight-semibold", "--weight-bold"
  ]) {
    assert.ok(token in rootTokens, `styles.css :root 应声明 ${token}`);
  }
  for (const token of [
    "--agent-answer-fg", "--agent-heading-fg", "--agent-subheading-fg",
    "--agent-work-title-fg", "--agent-work-label-fg", "--agent-work-live-fg",
    "--agent-work-meta-fg", "--agent-plan-current-fg", "--agent-plan-rest-fg",
    "--agent-plan-complete-fg"
  ]) {
    assert.ok(token in rootTokens, `styles.css :root 应声明 ${token}`);
  }
  // semantic 映射到现有 primitive（冻结契约，不私造同义变量）
  assert.equal(resolveVar("--text-primary"), "#202522");
  assert.equal(resolveVar("--text-secondary"), "#3f4742");
  assert.equal(resolveVar("--text-muted"), "#69716c");
  assert.equal(resolveVar("--text-placeholder"), "#8b938e");
  assert.equal(resolveVar("--text-link"), "#3f6b4f");
  assert.equal(resolveVar("--text-success"), "#2c6e49");
  assert.equal(resolveVar("--text-warning"), "#8a6d2f");
  assert.equal(resolveVar("--text-danger"), "#a4422f");
  // 字重 token 精确
  assert.equal(resolveVar("--weight-regular"), "400");
  assert.equal(resolveVar("--weight-medium"), "550");
  assert.equal(resolveVar("--weight-semibold"), "650");
  assert.equal(resolveVar("--weight-bold"), "700");
});

test("agent component selector 不含 raw hex；dark theme 不覆盖 component alias", () => {
  assert.doesNotMatch(agentCssSource, /#[0-9a-fA-F]{3,8}\b/u, "agent.css 不得出现任何 raw hex 色值");
  // agent.css 的 --agent-* 定义只能引用全局 primitive/semantic token，
  // 不得写成 raw hex 或私造色值（阴影等装饰值允许 rgba）
  const agentDefs = [...agentCssSource.matchAll(/--agent-[a-z0-9-]+\s*:\s*([^;]+);/gu)];
  for (const [, value] of agentDefs) {
    assert.doesNotMatch(value, /#[0-9a-fA-F]{3,8}/u, `--agent-* 定义不得写 raw hex：${value.trim()}`);
    if (value.includes("rgba")) continue;
    assert.match(value, /var\(--/u, `--agent-* 必须引用全局 token：${value.trim()}`);
  }
  const darkBlock = extractBlock(stylesSource, ':root[data-theme="dark"]');
  assert.ok(darkBlock, "dark theme 覆盖块应存在");
  assert.doesNotMatch(darkBlock, /--(?:text|agent)-[a-z0-9-]+\s*:/u, "dark 块只覆盖 primitive，不得重定义 semantic/component alias");
  // agent.css 不得私造同义色值变量（自己定义 --agent-* = hex）
  assert.doesNotMatch(agentCssSource, /--agent-[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}/u);
});

// ===========================================================================
// 2) .agent-markdown 标题层级：primary 非 accent；H1–H6 与 §2.6 完全一致
// ===========================================================================
test(".agent-markdown h1/h2 使用 heading primary；H1–H6 字号/行高/字重与 §2.6 一致", () => {
  const h1 = extractDecls(extractBlock(agentCssSource, ".agent-markdown h1"));
  const h2 = extractDecls(extractBlock(agentCssSource, ".agent-markdown h2"));
  const h3 = extractDecls(extractBlock(agentCssSource, ".agent-markdown h3"));
  const h456 = extractDecls(extractBlock(agentCssSource, ".agent-markdown :is(h4, h5, h6)"));

  assert.equal(h1.color, "var(--agent-heading-fg)");
  assert.equal(h2.color, "var(--agent-heading-fg)");
  assert.equal(resolveVar("--agent-heading-fg"), "#202522", "heading 应为 primary 深色");
  assert.notEqual(resolveVar("--agent-heading-fg"), "#3f6b4f", "标题不得染 accent");
  assert.equal(resolveVar("--agent-subheading-fg"), "#3f4742", "H3–H6 应为 secondary");

  const expect = [
    [h1, "20px", "1.35", "700"],
    [h2, "17px", "1.4", "700"],
    [h3, "15px", "1.45", "650"],
    [h456, "14px", "1.5", "650"],
  ];
  for (const [decls, size, lh, weight] of expect) {
    assert.equal(decls["font-size"], size, "字号应与 §2.6 一致");
    assert.equal(decls["line-height"], lh, "行高应与 §2.6 一致");
    const weightToken = decls["font-weight"].match(/^var\(--([a-z0-9-]+)\)$/u)?.[1];
    assert.equal(resolveVar(`--${weightToken}`), weight, "字重应与 §2.6 一致");
  }
});

// ===========================================================================
// 3) 计划：title 与唯一 in_progress semibold；completed 删除线（AICSS task-list）
// ===========================================================================
test("任务计划标题与唯一 in_progress 项 semibold，completed regular + 步骤删除线", () => {
  const title = extractDecls(extractBlock(agentCssSource, ".agent-plan__title"));
  assert.equal(title["font-weight"], "var(--weight-semibold)");
  assert.equal(title["font-size"], "13px");

  const base = extractDecls(extractBlock(agentCssSource, ".agent-plan-item"));
  assert.equal(base["font-weight"], "var(--weight-regular)");
  assert.equal(base["font-size"], "13px");
  assert.equal(base["line-height"], "1.5");

  const inProgress = extractDecls(extractBlock(agentCssSource, '.agent-plan-item[data-status="in_progress"]'));
  assert.equal(inProgress["font-weight"], "var(--weight-semibold)", "仅 in_progress 为 semibold");
  assert.equal(inProgress.color, "var(--agent-plan-current-fg)");

  const completed = extractDecls(extractBlock(agentCssSource, '.agent-plan-item[data-status="completed"]'));
  assert.equal(completed["font-weight"], "var(--weight-regular)", "completed 为 regular");
  assert.equal(completed.color, "var(--agent-plan-complete-fg)");

  // AICSS task-list：完成项步骤文本带删除线（仅步骤文本，不落整行）
  const completedStep = extractDecls(extractBlock(agentCssSource, '.agent-plan-item[data-status="completed"] .agent-plan-item__step'));
  assert.equal(completedStep["text-decoration"], "line-through", "完成项步骤必须有删除线");
});

// ===========================================================================
// 4) success/danger 只落在 icon/短状态 selector
// ===========================================================================
test("success/danger 颜色只作用于 icon/短状态 selector，不命中行容器与 Markdown 整体", () => {
  const planItem = extractBlock(agentCssSource, ".agent-plan-item");
  const workItem = extractBlock(agentCssSource, ".agent-work-item");
  const markdown = extractBlock(agentCssSource, ".agent-markdown");
  for (const [name, block] of [["plan-item", planItem], ["work-item", workItem], [".agent-markdown", markdown]]) {
    assert.doesNotMatch(block ?? "", /--text-(success|danger)/u, `${name} 整行不得承载成功/失败色`);
  }
  const iconCompleted = extractDecls(extractBlock(agentCssSource, '.agent-work-item__icon[data-state="completed"]'));
  assert.equal(iconCompleted.color, "var(--text-success)");
  const iconFailed = extractDecls(extractBlock(agentCssSource, '.agent-work-item__icon[data-state="failed"]'));
  assert.equal(iconFailed.color, "var(--text-danger)");
  const stateWord = extractDecls(extractBlock(agentCssSource, ".agent-work-item__state"));
  assert.equal(stateWord.color, "var(--text-danger)", "「失败」短状态词单独着色");
  const planIcon = extractDecls(extractBlock(agentCssSource, '.agent-plan-item[data-status="completed"] .agent-plan-item__icon'));
  assert.equal(planIcon.color, "var(--text-success)", "计划完成勾选 icon 使用 success");
});

// ===========================================================================
// 5) helper/duration/ticker/路径 ≥ muted，禁用 placeholder/faint
// ===========================================================================
test("必要 helper、duration、ticker、路径至少 --text-muted，不使用 placeholder/faint", () => {
  const cases = [
    [agentCssSource, ".agent-work-duration", "duration"],
    [agentCssSource, ".agent-reasoning-ticker", "reasoning ticker"],
    [agentCssSource, ".agent-tool-path", "路径"],
    [stylesSource, ".spd-hint", "设置 helper"],
    [stylesSource, ".spd-connection-status", "连接状态"],
  ];
  for (const [src, selector, label] of cases) {
    const decls = extractDecls(extractBlock(src, selector));
    const color = decls.color ?? "";
    assert.ok(color, `${label} 应有 color`);
    assert.doesNotMatch(color, /--text-placeholder|--faint/u, `${label} 不得使用 placeholder/faint`);
    const m = color.match(/^var\(--([a-z0-9-]+)\)$/u);
    const resolved = m ? resolveVar(`--${m[1]}`) : color;
    assert.ok(
      resolved === "#69716c" || contrast(resolved, "#ffffff") >= 4.5,
      `${label}（${resolved}）必须 ≥ muted 或对比度 ≥4.5:1`
    );
  }
  // placeholder token 只能出现在 placeholder/disabled 语境
  for (const m of agentCssSource.matchAll(/var\(--text-placeholder\)/gu)) {
    const before = agentCssSource.slice(Math.max(0, m.index - 120), m.index);
    assert.match(before, /::placeholder|:disabled|\.placeholder/u, "--text-placeholder 只用于 placeholder/disabled");
  }
});

// ===========================================================================
// 6) 计算后颜色对比度（light 主题契约）
// ===========================================================================
test("计算后对比度：primary/secondary/muted/link/状态短语 ≥4.5:1，focus/icon ≥3:1", () => {
  const bg = resolveVar("--bg");
  const surface2 = resolveVar("--surface-2");
  const rail = resolveVar("--rail");
  const redSoft = resolveVar("--red-soft");
  const greenSoft = resolveVar("--green-soft");
  const amberSoft = resolveVar("--amber-soft");
  const accentSoft = resolveVar("--accent-soft");

  const textCases = [
    ["primary", resolveVar("--text-primary"), [bg]],
    ["secondary", resolveVar("--text-secondary"), [bg]],
    ["muted", resolveVar("--text-muted"), [bg, surface2, rail]],
    ["link", resolveVar("--text-link"), [bg]],
    ["success 短语", resolveVar("--text-success"), [bg, greenSoft]],
    ["danger 短语", resolveVar("--text-danger"), [bg, redSoft]],
    ["warning 短语", resolveVar("--text-warning"), [bg, amberSoft]],
    ["testing/accent 短语", resolveVar("--accent"), [accentSoft]],
  ];
  for (const [label, fg, backgrounds] of textCases) {
    for (const background of backgrounds) {
      const ratio = contrast(fg, background);
      assert.ok(
        ratio >= 4.5,
        `${label} ${fg} 在 ${background} 上的对比度 ${ratio.toFixed(2)} 应 ≥ 4.5:1`
      );
    }
  }
  // focus ring（:focus-visible outline 用 accent，accent 允许用于 focus）≥3:1
  const focusRule = allRules(stylesSource).find((r) => r.selector.includes(":focus-visible"));
  assert.ok(focusRule, "全局 focus-visible 规则应存在");
  const focusOutline = extractDecls(focusRule.decls)["outline"] ?? "";
  const focusColor = focusOutline.match(/var\(--[a-z0-9-]+\)/u)?.[0];
  assert.ok(focusColor, "focus outline 应使用 token");
  assert.ok(contrast(resolveVar(focusColor.slice(4, -1)), bg) >= 3, "focus outline 对比度应 ≥ 3:1");
  // 非文字 icon：success/danger icon 在 surface 上 ≥3:1
  assert.ok(contrast(resolveVar("--text-success"), bg) >= 3, "success icon ≥3:1");
  assert.ok(contrast(resolveVar("--text-danger"), bg) >= 3, "danger icon ≥3:1");
});

// ===========================================================================
// 7) streaming/terminal 同一 .agent-markdown 路径；无重复字级规则
// ===========================================================================
test("streaming/terminal 命中同一 .agent-markdown typography；无 .is-streaming/.is-complete 重复字级", () => {
  const { streaming, terminal } = markdownFixture();
  for (const el of [streaming, terminal]) {
    assert.ok(el.classList.contains("agent-markdown"), "流式与终态消息都应带 .agent-markdown");
    assert.ok(!/is-streaming|is-complete/.test(el.className), "不得引入 streaming/complete 专属类");
  }
  // 规则级检查：不得存在 .is-streaming/.is-complete 选择器（注释里的说明文字不算）
  const dupRules = allRules(agentCssSource).filter((r) => /is-streaming|is-complete/u.test(r.selector));
  assert.equal(dupRules.length, 0, "不得存在 .is-streaming/.is-complete 重复字级规则");
  // 所有命中 h1–h6 的规则都必须属于 .agent-markdown 单一路径
  const headingRules = allRules(agentCssSource).filter((r) => /\bh[1-6]\b/u.test(r.selector));
  assert.ok(headingRules.length >= 5, "应存在 H1–H6 字级规则");
  for (const rule of headingRules) {
    assert.match(rule.selector, /\.agent-markdown/u, `标题字级只能由 .agent-markdown 路径定义：${rule.selector}`);
  }
});

// ===========================================================================
// 10) 模型设置布局契约（Task 22）：模型行响应式 grid/minmax + min-width:0，
//     长输入截断不扩父容器；窄窗 media query 折叠单列；技能添加菜单 popover
//     有视口边界（max-inline-size）。
// ===========================================================================
test("模型设置布局：model-row 响应式 grid/minmax + min-width:0，窄窗折叠，popover 有边界", () => {
  // .model-settings-body 双列 grid 的详情列必须可收缩（minmax(0,1fr)）。
  const body = extractDecls(extractBlock(stylesSource, ".model-settings-body"));
  assert.match(body["grid-template-columns"] ?? "", /minmax\(0,\s*1fr\)/u, ".model-settings-body 详情列应为 minmax(0,1fr)");

  // 详情 section 的隐式列必须显式可收缩：否则单列 auto 轨道按 max-content 撑宽。
  const section = extractDecls(extractBlock(stylesSource, ".model-settings-body section"));
  assert.match(section["grid-template-columns"] ?? "", /minmax\(0,\s*1fr\)/u, ".model-settings-body section 应为可收缩单列");

  // .model-row：grid + 首列 minmax(0,1fr) + min-width:0（长模型名截断不撑破父容器）。
  const row = extractDecls(extractBlock(stylesSource, ".model-row"));
  assert.equal(row["display"], "grid", ".model-row 应为 grid 布局");
  assert.match(row["grid-template-columns"] ?? "", /minmax\(0,\s*1fr\)/u, ".model-row 首列应可收缩（minmax(0,1fr)）");
  assert.equal(row["min-width"], "0", ".model-row 应有 min-width:0");

  // 行内输入框可收缩：长文本截断（内部滚动）而非撑破父容器。
  const rowInput = extractDecls(extractBlock(stylesSource, ".model-row input"));
  assert.equal(rowInput["min-width"], "0", ".model-row input 应有 min-width:0");

  // 窄窗 media query：模型设置页折叠为单列（280px 侧栏 + 详情双列放不下）。
  const narrow = mediaBlocks(stripComments(stylesSource)).find((b) => /\.model-settings-body/u.test(b));
  assert.ok(narrow, "窄窗 media query 应包含 .model-settings-body 规则");
  assert.match(narrow, /grid-template-columns:\s*(?:minmax\(0,\s*1fr\)|1fr)/u, "窄窗下 .model-settings-body 应折叠单列");

  // popover（技能添加菜单）有边界：max-inline-size 不超过视口宽度。
  const menu = extractDecls(extractBlock(stylesSource, ".spd-addmenu-pop"));
  assert.match(
    menu["max-inline-size"] ?? "",
    /min\([^)]*,\s*calc\(100vw/u,
    ".spd-addmenu-pop 应有视口边界（max-inline-size）"
  );
});

// ===========================================================================
// 8) 圆角契约（Codex 基线）：卡片/控件圆角 ≤12px（99px/999px 圆形 pill 与头像除外）
// ===========================================================================
test("圆角不超过 12px：radius token 全部 ≤12px，无 13–98px 圆角", () => {
  for (const [file, src] of [["styles.css", stylesSource], ["agent.css", agentCssSource]]) {
    const offenders = [...src.matchAll(/border-radius:\s*(1[3-9]|2[0-9]|[3-8][0-9]|9[0-8])px/gu)].map((m) => m[0]);
    assert.equal(offenders.length, 0, `${file} 不得出现 13–98px 圆角：${offenders.join(", ")}`);
  }
  for (const token of ["--r", "--r-sm", "--r-lg", "--r-xl", "--r-card"]) {
    const value = rootTokens[token] ?? "";
    assert.match(value, /^\d+px$/u, `${token} 应为 px 值（当前 ${value}）`);
    assert.ok(parseInt(value, 10) <= 12, `${token} 应 ≤12px（当前 ${value}）`);
  }
});

// ===========================================================================
// 9) Codex 基线：Assistant 正文 regular；对话画布非纯白冷调，卡片白底允许
// ===========================================================================
test("Codex 基线：Assistant 正文 regular；对话画布非纯白冷调，卡片白底允许", () => {
  const markdown = extractDecls(extractBlock(agentCssSource, ".agent-markdown"));
  assert.equal(markdown["font-weight"], "var(--weight-regular)", "Assistant 正文应为 regular");

  // 对话画布（--agent-canvas → --bg）不得纯白且为冷调/中性（蓝 ≥ 红，排除泛黄纸色）；
  // 卡片白底（--surface=#ffffff）允许；rail 仍不得纯白。
  const canvasDecl = [...agentCssSource.matchAll(/--agent-canvas:\s*([^;]+);/gu)][0]?.[1] ?? "";
  assert.match(canvasDecl, /var\(--bg\)/u, "--agent-canvas 应引用 --bg");
  const bg = resolveVar("--bg");
  assert.notEqual(bg, "#ffffff", "对话画布（--bg）不得纯白");
  assert.match(bg, /^#[0-9a-fA-F]{6}$/u, "--bg 应是 hex primitive");
  const r = parseInt(bg.slice(1, 3), 16);
  const b = parseInt(bg.slice(5, 7), 16);
  assert.ok(b >= r, "--bg 应为冷调或中性灰（蓝≥红）");
  const rail = resolveVar("--rail");
  assert.notEqual(rail, "#ffffff", "--rail 不得纯白");
  // H1/H2 深色分级：同为深色 primary，不统一染 accent/green。
  assert.equal(resolveVar("--agent-heading-fg"), "#202522", "标题应为深色 primary");
  assert.notEqual(resolveVar("--agent-heading-fg"), resolveVar("--accent"), "标题不得染 accent");
});
