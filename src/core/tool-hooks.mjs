// 工程安全层 Tool Hook 生命周期（与写作 skill hook 分开）：
// BeforeToolUse 可一票否决工具执行；AfterToolUse 用于审计，单个 hook 失败不阻断主流程。
import { appendEvent } from "./event-log.mjs";

const registry = { BeforeToolUse: [], AfterToolUse: [] };
let defaultsRegistered = false;

export function registerToolHook(phase, fn) {
  if (!registry[phase]) {
    throw new Error(`Unknown tool hook phase: ${phase}`);
  }
  if (typeof fn !== "function") {
    throw new Error("tool hook must be a function");
  }
  registry[phase].push(fn);
  return () => {
    const index = registry[phase].indexOf(fn);
    if (index >= 0) registry[phase].splice(index, 1);
  };
}

export async function runBeforeToolUse(context) {
  for (const hook of registry.BeforeToolUse) {
    const result = await hook(context);
    if (result && result.allow === false) {
      return { allow: false, reason: result.reason ?? "blocked by BeforeToolUse hook" };
    }
  }
  return { allow: true };
}

export async function runAfterToolUse(context) {
  for (const hook of registry.AfterToolUse) {
    try {
      await hook(context);
    } catch (error) {
      console.warn("AfterToolUse hook failed:", error.message);
    }
  }
}

export function ensureDefaultToolHooks() {
  if (defaultsRegistered) {
    return;
  }
  defaultsRegistered = true;
  registerToolHook("AfterToolUse", async (context) => {
    await appendEvent(context.projectRoot, {
      type: "tool_executed",
      project_id: context.project?.project_id ?? null,
      chapter_no: context.toolCall?.input?.chapter_no ?? null,
      stage: context.state?.current_stage ?? null,
      severity: context.ok ? "info" : "warn",
      message: `${context.toolCall?.tool ?? "unknown-tool"} ${context.ok ? "executed" : "failed"} in ${context.durationMs}ms`,
      data: {
        tool: context.toolCall?.tool ?? null,
        ok: context.ok,
        duration_ms: context.durationMs,
        bytes_written: context.result?.bytes_written ?? null,
        actual_words: context.result?.actual_words ?? null,
        checksum: context.result?.checksum ?? null,
        error: context.error?.message ?? null
      }
    });
  });
}

export function _resetToolHooks() {
  registry.BeforeToolUse.length = 0;
  registry.AfterToolUse.length = 0;
  defaultsRegistered = false;
}
