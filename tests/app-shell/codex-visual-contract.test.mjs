// Codex 风格 UI 改版的源码级视觉契约（Task 1 骨架，后续任务逐块追加）。
//
// 冻结基线（与 docs/superpowers/plans/2026-08-09-codex-style-ui-redesign.md 对应）：
//   - agent.css 无 raw hex（颜色一律 var(--token)）；hex 只允许在 styles.css
//     :root 与 [data-theme="dark"] 两个 primitive 块；
//   - 消息和状态保留 --content-column: 760px（2026-10-30 视觉改版，原 1040px），
//     滚动区与 composer 同轴；
//   - 运行区无横杠、工作项无左侧竖线；圆角遵循统一书 §7 的三档层级（8/12/16）；
//   - 工作组一组一卡（2026-10-30 取代「无框直出」）；
//   - composer 单行化、顶栏无下边框。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/u, "$1"), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
export function cssBlock(css, selector) {
  const start = css.indexOf(selector + " {");
  assert.ok(start >= 0, `selector not found: ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}
// 顶层 @media 块（逐块提取，避免正则跨块误匹配）。
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

test("基线保留：agent.css 无 raw hex、内容列/阅读列走全局 token", () => {
  const css = read("src/app-shell/agent/agent.css");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/u.test(css.replace(/var\([^)]*\)/gu, "")));
  assert.match(css, /var\(--content-column\)/u);
  // Round10：全局轴 token 由 styles.css 独占声明，选择器只引用 token 名称
  assert.match(read("src/app-shell/styles.css"), /--content-column:\s*760px/u);
  assert.match(read("src/app-shell/styles.css"), /--reading-column:\s*720px/u);
});

test("Codex 基线：运行区无横杠、工作项无左侧竖线", () => {
  const css = read("src/app-shell/agent/agent.css");
  assert.ok(!/\.agent-run\s*\{[^}]*border-top/u.test(css), "agent-run 横杠必须移除");
  assert.ok(!/\.agent-work-item::before/u.test(css), "工作项左侧竖线必须移除");
});

test("圆角层级：styles.css 提供大表面 --r-lg 16px（控件 8 / 卡片 12 / 大表面 16 / 气泡 24）", () => {
  const css = read("src/app-shell/styles.css");
  assert.match(css, /--r-sm:\s*8px/u);
  assert.match(css, /--r:\s*12px/u);
  assert.match(css, /--r-lg:\s*16px/u);
  assert.match(css, /--r-bubble:\s*24px/u);
});

test("Codex 基线：工作组一组一卡（2026-10-30 取代无框直出）", () => {
  const css = read("src/app-shell/agent/agent.css");
  const group = cssBlock(css, ".agent-work-group");
  assert.match(group, /border:\s*1px solid var\(--line\)/u);
  assert.match(group, /border-radius:\s*var\(--r\)/u);
  assert.match(group, /box-shadow:\s*none/u);
  // 卡头必须铺满卡片：曾把 summary 限到 --reading-column(720) 比卡宽(760)窄 40px，
  // 悬停底色与展开分隔线都在右侧断开，露出一条缝和卡右边框（2026-10-30 修复）。
  const summary = cssBlock(css, ".agent-work-group > summary");
  assert.ok(!/max-width/u.test(summary), "卡头不得再收窄到阅读轴，否则悬停底色右侧留缝");
  assert.match(summary, /width:\s*100%/u, "卡头应铺满卡片宽度");
});

test("Codex 基线：状态行是紧凑小条（无全宽边框）", () => {
  const css = read("src/app-shell/agent/agent.css");
  const header = cssBlock(css, ".agent-run-header");
  assert.match(header, /display:\s*flex/u);
  assert.ok(!/border-(top|bottom)/u.test(header));
});

test("Codex 基线：压缩行为细边框紧凑条", () => {
  const css = read("src/app-shell/agent/agent.css");
  const row = cssBlock(css, ".agent-compaction");
  assert.match(row, /border:\s*1px solid var\(--agent-line\)/u);
  assert.match(row, /border-radius:\s*var\(--r\)/u);
});

test("Codex 基线：composer 为细边框 12px 圆角卡片、无阴影", () => {
  const css = read("src/app-shell/agent/agent.css");
  const shell = cssBlock(css, ".agent-composer-shell");
  assert.match(shell, /border:\s*1px solid var\(--agent-line\)/u);
  assert.match(shell, /border-radius:\s*var\(--r\)/u);
  assert.match(shell, /box-shadow:\s*none/u);
});

test("Codex 基线：顶栏无下边框（36px 细标题）、项目行圆角", () => {
  const css = read("src/app-shell/styles.css");
  const topbar = cssBlock(css, ".topbar");
  assert.match(topbar, /border-bottom:\s*0/u, "顶栏下边框必须显式归零");
  assert.match(topbar, /min-height:\s*36px/u);
  assert.match(cssBlock(css, ".proj"), /border-radius:\s*var\(--r\)/u);
});

// 第九轮：抽屉滚轮修复契约——.dpanel 必须防 grid/flex 压缩。
// 根因：.dpanel 的 overflow:hidden 使子项 min-height:auto 解析为 0，
// 内容超高时被 .drawer-body（grid 单行）压到容器高度 → 无溢出 → 滚轮无效。
// 修复：min-height: min-content 恢复内容高度，让溢出回到 .drawer-body 滚动。
test("第九轮契约：.dpanel 必须含 min-height: min-content（抽屉滚轮修复）", () => {
  assert.match(
    read("src/app-shell/styles.css"),
    /\.dpanel\s*\{[^}]*min-height:\s*min-content/u,
    ".dpanel 必须含 min-height: min-content（第九轮抽屉滚轮修复契约）"
  );
});

test("AICSS 基线：流式光标实心态、令牌取色、无闪烁动画", () => {
  const css = read("src/app-shell/agent/agent.css");
  const caret = cssBlock(css, ".agent-stream-caret");
  assert.match(caret, /width:\s*8px/u);
  assert.match(caret, /height:\s*1\.05em/u);
  assert.match(caret, /background:\s*var\(--agent-ink\)/u);
  assert.match(caret, /animation:\s*none/u);
});

test("AICSS 基线：live shimmer 用 aicss 三档渐变与 2.25s 曲线", () => {
  const css = read("src/app-shell/agent/agent.css");
  const live = cssBlock(css, ".agent-live-text");
  assert.match(live, /background-size:\s*300%\s*100%/u, live);
  assert.match(live, /2\.25s cubic-bezier\(0\.25,\s*0\.1,\s*0\.25,\s*1\)/u, live);
  assert.match(live, /color-mix\(in srgb, var\(--muted\) 45%, transparent\)/u, live);
  assert.match(css, /@keyframes agent-label-shine/u);
});

test("AICSS 基线：composer 扫描边框只绑提交在途，选项圆角 --r-sm（round17 §3.4）", () => {
  const css = read("src/app-shell/agent/agent.css");
  assert.match(cssBlock(css, ".agent-composer-shell[data-busy]::after"), /conic-gradient/u);
  assert.match(css, /@keyframes agent-pi-border-spin/u);
  assert.ok(!css.includes(".agent-composer-shell:focus-within::after"), "扫描边框不得绑 focus-within");
  assert.match(cssBlock(css, ".agent-composer-option"), /border-radius:\s*var\(--r-sm\)/u);
});

test("Round10 契约：Composer 单行起手、设置项在框下、send 28px", () => {
  const css = read("src/app-shell/agent/agent.css");
  // 2026-10-30：输入框本体 44px 单行；模型/权限/思考强度移到框下 .agent-composer-meta
  const shell = cssBlock(css, ".agent-composer-shell");
  assert.match(shell, /display:\s*flex/u, "composer 外壳为单行 flex");
  assert.match(shell, /min-height:\s*44px/u, "composer 空态 44px");
  assert.match(shell, /align-items:\s*flex-end/u, "多行草稿时发送键贴底");
  assert.match(cssBlock(css, ".agent-composer-meta"), /display:\s*flex/u, "设置项在框下独立一行");
  const view = read("src/app-shell/agent/view.js");
  assert.match(view, /composerShell\.append\(input, send\)/u, "输入框与发送键同在外壳内");
  assert.match(view, /composerMeta\.append\(controls, contextRing\.element\)/u, "三个设置项与上下文环在框下");
  // send 28px（尺寸声明在第二个块；第一个块是通用 flex 基线）
  assert.match(cssBlock(css, ".agent-send"), /width:\s*28px[^}]*height:\s*28px[^}]*border-radius:\s*var\(--r-sm\)/u, "send 固定 28px");
  // 历史损坏提示不再用 JS 内联样式
  assert.match(cssBlock(css, ".agent-history-clear-hint"), /font-size:\s*var\(--font-xs\)/u, "history 提示样式在 CSS");
  assert.doesNotMatch(view, /Object\.assign\(historyClearHint\.style/u, "不得用 JS 内联样式写 history 提示");
});
