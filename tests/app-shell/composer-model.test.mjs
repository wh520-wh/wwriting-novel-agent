// Composer 模型菜单视口钳制基线。
//
// 旧 .model-popover 已随 composer.js 删除；模型菜单现在复用 AgentSurface 的统一
// 向上弹出菜单。本测试冻结统一菜单的视口安全区、模型菜单宽度和长名称行为。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentCssPath = path.join(here, "..", "..", "src", "app-shell", "agent", "agent.css");
const css = await fs.readFile(agentCssPath, "utf8");

function ruleBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

test("模型菜单宽度受内容和视口共同约束（Task 11 基线）", () => {
  assert.match(
    css,
    /\.agent-composer-menu--model \.agent-composer-popover\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单宽度应为 min(320px, 100vw - 32px)"
  );
  assert.match(
    css,
    /\.agent-composer-popover\s*\{[^}]*max-width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单最大宽度应保证左右各 16px 视口安全区"
  );
});

test("模型菜单长名称任意位置换行（不溢出）", () => {
  assert.match(
    css,
    /overflow-wrap:\s*anywhere/u,
    "模型名称应允许任意位置换行"
  );
  assert.match(
    css,
    /\.agent-composer-menu--model \.agent-composer-menu-value\s*\{[^}]*max-width:\s*170px/u,
    "折叠态模型名称应稳定截断，不挤压其他 composer 控件"
  );
});

test("模型菜单复用 AgentSurface 统一向上弹出菜单", () => {
  const block = ruleBlock(".agent-composer-popover");
  assert.ok(block.length > 0, ".agent-composer-popover 规则块应存在");
  assert.match(block, /bottom:\s*calc\(100% \+ 7px\)/u, "菜单应向上展开");
  assert.doesNotMatch(css, /\.model-popover|\.mode-popover/u, "不得恢复旧的两套菜单实现");
});

test("旧 composer 模型菜单实现已删除，不残留", async () => {
  assert.equal(
    await fs
      .access(path.join(here, "..", "..", "src", "app-shell", "composer.js"))
      .then(() => true)
      .catch(() => false),
    false,
    "composer.js 应已删除"
  );
});
