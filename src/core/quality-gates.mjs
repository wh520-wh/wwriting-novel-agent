import { countEffectiveWords } from "./word-count.mjs";

export function runWordCountGate(content, minWords) {
  const actualWords = countEffectiveWords(content);
  if (actualWords >= minWords) {
    return {
      gate: "word-count-gate",
      status: "passed",
      actual_words: actualWords,
      min_words: minWords,
      shortfall: 0
    };
  }
  return {
    gate: "word-count-gate",
    status: "failed",
    actual_words: actualWords,
    min_words: minWords,
    shortfall: minWords - actualWords,
    instruction: `Chapter is short by ${minWords - actualWords} effective words. Continue through a file-writing tool; do not claim the word count is reached.`
  };
}

export function assertToolCallForChapter(output, context = {}) {
  if (!output || output.type !== "tool_call") {
    return {
      ok: false,
      code: "invalid_output_channel",
      message: "Chapter body must be written through a tool_call, not delivered in chat."
    };
  }

  const allowedTools = context.allowedTools ?? ["append_chapter_segment"];
  if (!allowedTools.includes(output.tool)) {
    return {
      ok: false,
      code: "unsupported_tool",
      message: `Unsupported tool for chapter writing: ${output.tool ?? "missing"}`
    };
  }
  if (!output.input || typeof output.input !== "object") {
    return {
      ok: false,
      code: "missing_tool_input",
      message: "Tool call input is required."
    };
  }

  const input = output.input;
  if (context.project_id && input.project_id !== context.project_id) {
    return {
      ok: false,
      code: "invalid_project_id",
      message: "Tool call project_id does not match the active project."
    };
  }
  if (!Number.isInteger(input.chapter_no) || input.chapter_no < 1) {
    return {
      ok: false,
      code: "invalid_chapter_no",
      message: "Tool call chapter_no must be a positive integer."
    };
  }
  if (context.chapter_no !== undefined && input.chapter_no !== context.chapter_no) {
    return {
      ok: false,
      code: "invalid_chapter_no",
      message: "Tool call chapter_no does not match the active chapter."
    };
  }
  if (!Number.isInteger(input.segment_no) || input.segment_no < 1) {
    return {
      ok: false,
      code: "invalid_segment_no",
      message: "Tool call segment_no must be a positive integer."
    };
  }
  if (context.segment_no !== undefined && input.segment_no !== context.segment_no) {
    return {
      ok: false,
      code: "invalid_segment_no",
      message: "Tool call segment_no does not match the expected next segment."
    };
  }
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    return {
      ok: false,
      code: "empty_content",
      message: "Tool call content must be a non-empty string."
    };
  }

  const maxContentChars = context.maxContentChars ?? 200_000;
  if (input.content.length > maxContentChars) {
    return {
      ok: false,
      code: "content_too_large",
      message: `Tool call content exceeds ${maxContentChars} characters.`
    };
  }

  return { ok: true };
}
