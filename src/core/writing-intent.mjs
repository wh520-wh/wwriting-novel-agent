// src/core/writing-intent.mjs
// 写作意图编译器：把自然语言「开始写 / 继续写 / 修改 / 停止 / 询问」类指令
// 归一化为结构化意图（action + 章节范围 + 指令文本），统一走结构化输出契约。
// 注册 writing_intent@v1 schema；compileWritingIntent 直接委托 parseStructuredOutput，
// 错误分类（enum_violation / empty_content / invalid_json 等）与其它 schema 一致。
import { registerSchema, parseStructuredOutput, STRUCTURED_OUTPUT_ERRORS } from "./structured-output.mjs";

registerSchema("writing_intent", "v1", {
  normalize: (d) => ({
    action: String(d?.action ?? ""),
    chapter_start: Number(d?.chapter_start) || null,
    chapter_end: Number(d?.chapter_end) || null,
    instruction: String(d?.instruction ?? ""),
    confirmation_policy: String(d?.confirmation_policy ?? "auto")
  }),
  validate: (n) => {
    if (!["start", "continue", "revise", "stop", "query"].includes(n.action)) {
      return { ok: false, code: STRUCTURED_OUTPUT_ERRORS.enum_violation, field: "action" };
    }
    return { ok: true };
  }
});

export function compileWritingIntent(rawText) {
  return parseStructuredOutput("writing_intent", "v1", rawText);
}
