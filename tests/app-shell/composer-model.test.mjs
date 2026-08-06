// 模型菜单视口钳制基线（统一 Agent 内核计划 Task 9 改写）。
//
// 旧 composer 的模型菜单已随 composer.js 删除；模型菜单视口钳制（Task 11 布局
// 基线）由 agent.css 承担（agent-surface 私有模型菜单）。本测试断言该基线
// 在 agent.css 中完整保留：宽度钳制、16px 视口安全区、长名称任意换行与 title。
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
    /width:\s*min\(420px,\s*calc\(100vw - 32px\)\)/u,
    "模型菜单宽度应为 min(420px, 100vw - 32px)"
  );
  assert.match(
    css,
    /max-width:\s*calc\(100vw - 32px\)/u,
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
    /white-space:\s*normal/u,
    "模型名称应允许换行"
  );
});

test("模型菜单样式块存在且属于 AgentSurface 私有作用域", () => {
  const block = ruleBlock(".agent-surface .model-popover");
  assert.ok(block.length > 0, ".agent-surface .model-popover 规则块应存在");
  assert.match(block, /min\(420px,\s*calc\(100vw - 32px\)\)/u, "宽度钳制应落在该规则块内");
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
