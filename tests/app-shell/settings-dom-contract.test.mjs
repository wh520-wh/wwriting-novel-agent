// tests/app-shell/settings-dom-contract.test.mjs
//
// 静态 DOM/CSS 契约（Task A2：整页容器退役 + 模型分区样式）。
// 弹窗内模型分区结构由 A3 在 #settings-detail 内以 JS 构建，index.html 不再承载
// 整页容器；styles.css 提供 .model-section 规则并复用 .model-settings-body。
//
// index.html 契约：
//   1. 不再有整页容器 id="model-settings-page"
//   2. #settings-modal 内存在模型分区挂载点：settings-detail 存在
//   3. 弹窗分区 nav 容器 #settings-section-nav 存在
//   4. 不再有 id="model-section-host"（v4：无宿主）
//
// styles.css 契约：
//   1. 不再包含 ".model-settings-page" 规则（含 position: fixed / [hidden] / header 系列）
//   2. 包含 ".model-section" 规则（弹窗内模型分区）
//   3. ".model-settings-body" 的两列 grid 规则保留（弹窗内复用）
//   4. "@media (max-width: 880px)" 的单列折叠规则保留（弹窗内窄窗生效）
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "..", "src", "app-shell");

/** 去掉所有 /*...*\/ 注释（保留源码换行数，便于正则按块解析）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "");
}

// ---------------------------------------------------------------------------
// index.html 契约
// ---------------------------------------------------------------------------
test("index.html：整页容器已退役，弹窗内具备模型分区挂载点", async () => {
  const html = await fs.readFile(path.join(srcDir, "index.html"), "utf8");

  // 1. 不再有整页容器 id="model-settings-page"
  assert.ok(
    !/id="model-settings-page"/u.test(html),
    "index.html 不得再含整页容器 id=\"model-settings-page\""
  );

  // 2. #settings-modal 内存在模型分区挂载点：settings-detail
  const modalEnd = html.indexOf('id="settings-modal"');
  assert.ok(modalEnd >= 0, 'index.html 应含 id="settings-modal"');
  const modalRegion = html.slice(modalEnd);
  assert.match(modalRegion, /id="settings-detail"/u, "#settings-modal 内应存在 #settings-detail 挂载点");

  // 3. 弹窗分区 nav 容器 #settings-section-nav 存在
  assert.match(modalRegion, /id="settings-section-nav"/u, "#settings-modal 内应存在 #settings-section-nav");

  // 4. 不再有 id="model-section-host"（v4：无宿主）
  assert.ok(
    !/id="model-section-host"/u.test(html),
    'index.html 不得再含 id="model-section-host"（v4 无宿主）'
  );
});

// ---------------------------------------------------------------------------
// styles.css 契约
// ---------------------------------------------------------------------------
test("styles.css：整页规则退役，.model-section 与弹窗复用规则保留", async () => {
  const raw = await fs.readFile(path.join(srcDir, "styles.css"), "utf8");
  const css = stripComments(raw);

  // 1. 不再包含 ".model-settings-page" 整页规则
  assert.ok(
    !/\.model-settings-page/u.test(css),
    "styles.css 不得再含 .model-settings-page 整页规则（含 fixed / [hidden] / header 系列）"
  );

  // 2. 包含 ".model-section" 规则（弹窗内模型分区）
  const sectionRule = /\.model-section\s*\{[^}]*\}/u.exec(css)?.[0] ?? "";
  assert.ok(sectionRule, "styles.css 应含 .model-section 规则");
  assert.match(sectionRule, /display\s*:\s*grid/u, ".model-section 应为 grid 分区");
  assert.match(sectionRule, /align-content\s*:\s*start/u, ".model-section 应顶部对齐");

  // 3. ".model-settings-body" 的两列 grid 规则保留（弹窗内复用）
  // 行首锚定：前面还有 .model-section 作用域的单列覆盖规则，非锚定首匹配会抓错块。
  const bodyRule = /^\.model-settings-body\s*\{[^}]*\}/mu.exec(css)?.[0] ?? "";
  assert.ok(bodyRule, "styles.css 应仍含 .model-settings-body 规则");
  assert.match(bodyRule, /grid-template-columns\s*:\s*280px\s+minmax\(0,\s*1fr\)/u, ".model-settings-body 应保留两列 grid（280px + 1fr）");

  // 4. "@media (max-width: 880px)" 的单列折叠规则保留
  assert.match(css, /@media\s*\(\s*max-width\s*:\s*880px\s*\)/u, "styles.css 应保留 @media (max-width: 880px) 折叠块");
  assert.match(css, /@media[^{]*max-width\s*:\s*880px[^{]*\{[^{]*\.model-settings-body[^{]*\{[^}]*grid-template-columns\s*:\s*(?:minmax\(0\s*,\s*1fr\)|1fr)/u, "窄窗下 .model-settings-body 应折叠单列");
});
