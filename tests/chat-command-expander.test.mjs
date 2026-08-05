import assert from "node:assert/strict";
import test from "node:test";
import { expandChatCommand } from "../src/core/chat/chat-command-expander.mjs";

test("/init 保留用户原文并注入长期文件目标与 AGENTS.md 模板", () => {
  const out = expandChatCommand({ command: "init", message: "/init 重点核对人物关系", args: "重点核对人物关系" });
  assert.equal(out.userMessage, "/init 重点核对人物关系");
  assert.match(out.modelInstruction, /自行读取和搜索项目/u);
  assert.match(out.modelInstruction, /OUTLINE\.md/u);
  assert.match(out.modelInstruction, /SETTING\.md/u);
  assert.match(out.modelInstruction, /AGENTS\.md/u);
  assert.match(out.modelInstruction, /## 故事意图/u);
  assert.match(out.modelInstruction, /重点核对人物关系/u);
  assert.doesNotMatch(out.modelInstruction, /必须先调用|固定顺序/u);
});

test("普通消息不展开", () => {
  assert.deepEqual(expandChatCommand({ message: "继续写" }), {
    userMessage: "继续写",
    modelInstruction: "继续写",
    command: null
  });
});
