import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/gu, "\n");
const styles = () => read("src/app-shell/styles.css");
const agentCss = () => read("src/app-shell/agent/agent.css");
const html = () => read("src/app-shell/index.html");
const appJs = () => read("src/app-shell/app.js");
const captureScript = () => read("scripts/capture-visual-acceptance.cjs");

test("round10 visual evidence: waits for exact target states before capture", () => {
  const source = captureScript();
  assert.match(source, /BUILTIN_STYLE_NAMES/u);
  assert.match(source, /focusBuiltinStylesForCapture/u);
  assert.match(source, /narrowTopbarTitle/u);
  assert.match(source, /planDropdownTopmost/u);
  assert.match(source, /memoryCardsReady/u);
});

test("round10 tokens: shared axes, integer type scale and control dimensions have one owner", () => {
  const css = styles();
  for (const declaration of [
    "--content-column: 1040px",
    "--reading-column: 720px",
    "--reader-column: 800px",
    "--drawer-width: 380px",
    "--font-2xl: 22px",
    "--font-xl: 18px",
    "--font-lg: 16px",
    "--font-md: 15px",
    "--font-base: 14px",
    "--font-sm: 13px",
    "--font-xs: 12px",
    "--control-compact: 32px",
    "--control-default: 36px",
    "--target-critical: 40px",
    "--motion-press: 80ms",
    "--motion-hover: 140ms",
    "--motion-layer: 200ms"
  ]) assert.ok(css.includes(declaration), `missing ${declaration}`);

  // 单一所有权：round10 token 只能在 styles.css 的 :root 声明一次；
  // 不得在 styles.css 其他位置或 agent.css 重新声明（选择器引用不受限）。
  const rootBlock = css.match(/:root\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.ok(rootBlock, "styles.css :root 块应存在");
  for (const name of [
    "content-column", "reading-column", "reader-column", "drawer-width",
    "font-2xl", "font-xl", "font-lg", "font-md", "font-base", "font-sm", "font-xs",
    "control-compact", "control-default", "target-critical",
    "motion-press", "motion-hover", "motion-layer"
  ]) {
    const re = new RegExp(`--${name}\\s*:`, "gu");
    assert.equal((rootBlock.match(re) ?? []).length, 1, `--${name} 应在 :root 声明一次`);
    assert.equal((css.match(re) ?? []).length, 1, `--${name} 不得在 styles.css 重复声明`);
    assert.doesNotMatch(agentCss(), re, `--${name} 不得在 agent.css 声明`);
  }
});

test("round10 shell: narrow rail has an entry and drawer switches modal semantics", () => {
  const source = html();
  assert.match(source, /id="rail-toggle"/u);
  assert.match(source, /id="rail-scrim"/u);
  assert.match(source, /id="topbar-more"/u);
  assert.match(source, /id="topbar-secondary"/u);
  assert.match(source, /id="drawer"[^>]*aria-hidden="true"/u);
  assert.doesNotMatch(source, /id="drawer"[^>]*aria-modal="true"/u);
  assert.match(styles(), /@media\s*\(min-width:\s*1280px\)[\s\S]*\.drawer/u);
  assert.match(styles(), /@media\s*\(max-width:\s*480px\)[\s\S]*\.drawer[\s\S]*width:\s*100%/u);
  // 动态模态语义接线：app shell 拥有 syncDrawerMode/isDrawerModal/rail 覆盖态，
  // Tab trap 只对模态 drawer 生效（删除接线会让这些断言失败）。
  const app = appJs();
  assert.match(app, /function syncDrawerMode\(\)/u);
  assert.match(app, /function isDrawerModal\(\)/u);
  assert.match(app, /function openRail\(\)/u);
  assert.match(app, /function closeRail\(/u);
  assert.match(app, /isDrawerModal\(\)\)\s+trapTab/u);
});

test("round10 html: layout styles are not embedded in markup", () => {
  assert.doesNotMatch(html(), /\sstyle="/u);
});

test("round10 drawer: research uses stable rows and memory uses rendered markdown", () => {
  const source = read("src/app-shell/drawer-panels.js");
  assert.match(source, /className = "research-row"/u);
  // Round10 memory：记忆卡正文统一走 renderMemoryContent（剥离重复 H1/空态），
  // 内部仍用安全 renderMarkdown 渲染，绝不 textContent 直显原始 Markdown。
  assert.match(source, /renderMemoryContent\(/u);
  assert.match(source, /function renderMemoryContent/u);
  assert.match(source, /renderMarkdown\(body\)/u);
  assert.doesNotMatch(source, /content\.textContent = data2\?\.content/u);
});

test("round10 reader: prose width and toolbar labels stay stable", () => {
  const source = html();
  assert.match(source, /class="reader-font-stepper"/u);
  assert.match(styles(), /\.reader-body\s*\{[^}]*font-size:\s*17px[^}]*line-height:\s*1\.95/us);
  assert.match(styles(), /\.reader-body\s*>\s*\*\s*\{[^}]*max-width:\s*var\(--reader-column\)/us);
  assert.match(styles(), /\.reader-tool-text\s*\{[^}]*white-space:\s*nowrap/u);
  // 级联细节：段落不得压掉居中（margin-inline:auto）；text 按钮 52px 最小宽度在
  // .reader-tools 作用域内生效；<=768px 工具条换行到第二行、close 提前到标题行。
  assert.match(styles(), /\.reader-body\s+p\s*\{[^}]*margin:\s*0\s+auto\s+1\.1em/u);
  assert.match(styles(), /\.reader-tools\s+\.reader-tool-text\s*\{[^}]*min-width:\s*52px/u);
  assert.match(
    styles(),
    /@media\s*\(max-width:\s*768px\)[\s\S]*\.reader-head\s*\{[^}]*flex-wrap:\s*wrap[\s\S]*\.reader-tools\s*\{[^}]*flex:\s*1\s+1\s+100%[\s\S]*#reader-close\s*\{[^}]*order:\s*-1/u
  );
});

test("round10 settings: footer status slot and model rows are three-layer", () => {
  const source = html();
  assert.match(source, /id="settings-save-status"[^>]*role="status"/u);
  const modalSource = read("src/app-shell/settings-modal.js");
  assert.match(modalSource, /function setFooterMode/u);
  assert.doesNotMatch(modalSource, /settingsSave\.textContent = "无需保存"/u, "不得再把状态伪装成禁用主按钮");
  const pageSource = read("src/app-shell/model-settings-page.js");
  assert.match(pageSource, /class: "model-row-main"/u);
  assert.match(pageSource, /class: "model-row-actions"/u);
  assert.match(pageSource, /icon\("trash"/u);
  assert.match(pageSource, /icon\("eye"/u);
  assert.doesNotMatch(pageSource, /🗑|👁/u, "结构图标走 icon 体系，不用 emoji");
});

test("round10 overlays: toast clears the composer and cards are solid", () => {
  const css = styles();
  // Toast 移到顶栏下方右上角，不遮挡 Composer；<=768px 两侧自适应
  assert.match(css, /\.toast-stack\s*\{[^}]*top:\s*56px[^}]*right:\s*20px[^}]*left:\s*auto[^}]*bottom:\s*auto/u);
  assert.match(css, /@media\s*\(max-width:\s*768px\)[\s\S]*\.toast-stack\s*\{[^}]*left:\s*16px[^}]*right:\s*16px[^}]*top:\s*52px/u);
  // 新建/快捷键卡片实色 surface，无顶部装饰渐变
  assert.match(css, /\.create-card\s*\{[^}]*background:\s*var\(--surface\)/u);
  assert.doesNotMatch(css, /\.create-card::before/u, "新建小说卡片去掉顶部装饰渐变");
  assert.match(css, /\.shortcuts-card\s*\{[^}]*background:\s*var\(--surface\)/u);
  // showToast：error → role=alert，其余 role=status
  const app = read("src/app-shell/app.js");
  assert.match(app, /toast\.setAttribute\("role", type === "error" \? "alert" : "status"\)/u);
});

test("round10 responsive: four product breakpoints and user preference fallbacks exist", () => {
  const css = `${styles()}\n${agentCss()}`;
  for (const query of [
    "@media (min-width: 1280px)",
    "@media (max-width: 1279px)",
    "@media (max-width: 768px)",
    "@media (max-width: 480px)",
    "@media (prefers-reduced-motion: reduce)",
    "@media (prefers-reduced-transparency: reduce)",
    "@media (prefers-contrast: more)"
  ]) assert.ok(css.includes(query), `missing ${query}`);
  // <=480px：drawer 与 settings 都全宽。注意：该正则不做花括号配对，仅对
  // 「.drawer 是第一规则、.settings-modal 是第二规则」的当前结构有效——
  // 插入中间规则块会使断言失效（位置相关，改 480px 块时保持两规则相邻）。
  assert.match(styles(), /@media\s*\(max-width:\s*480px\)\s*\{[^}]*\}[^}]*\.settings-modal\s*\{[^}]*width:\s*100vw/u);
  // Round10：长标题省略号截断（阅读器标题 / 计划步骤）
  assert.match(styles(), /\.reader-head h2\s*\{[^}]*text-overflow:\s*ellipsis/u);
  assert.match(styles(), /\.plan-item-step\s*\{[^}]*text-overflow:\s*ellipsis/u);
});

test("round10 a11y: dialogs, live regions and icon buttons retain names", () => {
  const source = html();
  assert.match(source, /id="settings-modal"[^>]*role="dialog"[^>]*aria-modal="true"/u);
  assert.match(source, /id="reader"[^>]*role="dialog"[^>]*aria-modal="true"/u);
  assert.match(source, /id="toast-stack"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(source, /<button(?![^>]*(?:aria-label|>[^<]+<|title=))[^>]*>\s*<svg/gu);
  // 关键图标按钮显式命名（计划 verbatim 正则只按格式兜底，这里逐按钮核对名字）
  for (const id of ["rail-toggle", "refresh", "drawer-close", "reader-close", "settings-x", "create-x", "shortcuts-x", "topbar-more", "open-drawer"]) {
    const tag = source.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`, "u"))?.[0] ?? "";
    assert.ok(tag, `#${id} 按钮应存在`);
    assert.match(tag, /aria-label=|title=/u, `#${id} 应有 aria-label 或 title`);
  }
});

test("round10 narrow topbar: plan chip keeps progress but releases title width", () => {
  const css = styles();
  const source = html();
  const app = appJs();
  assert.match(css, /\.plan-chip-label\s*\{[^}]*display:\s*inline-flex[^}]*gap:\s*4px/u);
  assert.match(
    source,
    /id="topbar-secondary"[\s\S]*id="open-drawer"[^>]*role="menuitem"[\s\S]*id="privacy-toggle"/u
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*\.plan-chip-title\s*\{[^}]*display:\s*none/u
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*\.topbar\s*\{[^}]*gap:\s*8px[^}]*padding-left:\s*10px/u
  );
  assert.match(app, /insertBefore\(planPanel\.chip,\s*refs\.topbarMore/u);
  assert.match(app, /function closeTopbarSecondary/u);
});

test("round10 plan overlay: topbar owns stacking and completed rows stay neutral", () => {
  const css = styles();
  assert.match(css, /\.topbar\s*\{[^}]*z-index:\s*20/u);
  assert.doesNotMatch(
    css,
    /\.plan-item\.done\s+\.plan-item-step\s*\{[^}]*text-decoration:\s*line-through/u
  );
  assert.match(
    css,
    /\.plan-item\.done\s+\.plan-item-icon\s*\{[^}]*color:\s*var\(--text-success\)/u
  );
  assert.match(
    css,
    /\.plan-item\.active\s+\.plan-item-step\s*\{[^}]*font-weight:\s*var\(--weight-semibold\)/u
  );
});

test("round10 narrow settings: scrolling tabs reserve the close-button zone", () => {
  const css = styles();
  assert.match(
    css,
    /@media\s*\(max-width:\s*768px\)[\s\S]*\.sp-section-nav\s*\{[^}]*padding:\s*8px 52px 8px 10px/u
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*768px\)[\s\S]*\.settings-x\s*\{[^}]*top:\s*8px[^}]*right:\s*8px[^}]*background:\s*var\(--surface-2\)/u
  );
});
