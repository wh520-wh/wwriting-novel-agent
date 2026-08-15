// Codex 风格 UI 改版的源码级视觉契约（Task 1 骨架，后续任务逐块追加）。
//
// 冻结基线（与 docs/superpowers/plans/2026-08-09-codex-style-ui-redesign.md 对应）：
//   - agent.css 无 raw hex（颜色一律 var(--token)）；hex 只允许在 styles.css
//     :root 与 [data-theme="dark"] 两个 primitive 块；
//   - 对话与 composer 共享 --content-column: 1040px；
//   - Task 2+：运行区无横杠、工作项无左侧竖线、--r-card: 12px；
//   - Task 3+：工作组无框直出；Task 4+：状态小条与压缩条；
//   - Task 5+：composer 卡片化、顶栏发丝下边框、项目行圆角。
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

test("基线保留：agent.css 无 raw hex、内容列 1040px", () => {
  const css = read("src/app-shell/agent/agent.css");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/u.test(css.replace(/var\([^)]*\)/gu, "")));
  assert.match(css, /var\(--content-column\)/u);
});

test("Codex 基线：运行区无横杠、工作项无左侧竖线", () => {
  const css = read("src/app-shell/agent/agent.css");
  assert.ok(!/\.agent-run\s*\{[^}]*border-top/u.test(css), "agent-run 横杠必须移除");
  assert.ok(!/\.agent-work-item::before/u.test(css), "工作项左侧竖线必须移除");
});

test("Codex 基线：styles.css 提供 --r-card 12px", () => {
  assert.match(read("src/app-shell/styles.css"), /--r-card:\s*12px/u);
});

test("Codex 基线：工作组无框直出", () => {
  const css = read("src/app-shell/agent/agent.css");
  const group = cssBlock(css, ".agent-work-group");
  assert.match(group, /border:\s*0/u);
  assert.match(group, /border-radius:\s*0/u);
  assert.match(group, /background:\s*transparent/u);
  assert.match(group, /box-shadow:\s*none/u);
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

test("Codex 基线：composer 为白底细边框圆角卡片带轻阴影", () => {
  const css = read("src/app-shell/agent/agent.css");
  const shell = cssBlock(css, ".agent-composer-shell");
  assert.match(shell, /border:\s*1px solid var\(--agent-line\)/u);
  assert.match(shell, /border-radius:\s*var\(--r-card\)/u);
  assert.match(shell, /box-shadow:\s*var\(--shadow-sm\)/u);
});

test("Codex 基线：顶栏发丝下边框、项目行圆角", () => {
  const css = read("src/app-shell/styles.css");
  assert.match(cssBlock(css, ".topbar"), /border-bottom:\s*1px solid var\(--line-3\)/u);
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
