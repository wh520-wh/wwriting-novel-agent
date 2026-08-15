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
  assert.match(source, /renderMarkdown\(data2\?\.content \?\? ""\)/u);
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
