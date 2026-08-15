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
