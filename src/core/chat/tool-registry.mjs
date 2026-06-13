// 对话 agent 的工具注册表：注册、权限检查、统一执行包装、文档生成。
import { appendEvent } from "../event-log.mjs";

// edit 类写工具受 safe_edit 控制；其余写工具只受 read_only 控制。
const SAFE_EDIT_TOOLS = new Set(["edit_chapter", "update_continuity", "update_outline"]);

// 归档态下仍允许的工具：归档/解档与导出书（导出是「读」类操作的延伸，解档是归档态入口）。
const ARCHIVE_EXEMPT_TOOLS = new Set(["archive_project", "export_book"]);

export function createToolRegistry() {
  const tools = new Map();
  return {
    register(tool) {
      if (!tool?.name || !tool?.kind || typeof tool.run !== "function") {
        throw new Error("tool must have name, kind, run()");
      }
      tools.set(tool.name, tool);
    },
    get: (name) => tools.get(name) ?? null,
    list: () => [...tools.values()]
  };
}

export function checkToolPermission(tool, toolPermissions = {}, { archived = false } = {}) {
  if (tool.kind === "read") return { allowed: true };
  // 硬安全底线：dangerous 字段被封印。即便 settings-runtime 已经拒绝，运行时再校一次，挡住直接改 YAML / 未来旁路。
  if (toolPermissions.dangerous === true) {
    return { allowed: false, message: "tool_permissions.dangerous is sealed; this field cannot be enabled." };
  }
  if (toolPermissions.read_only === true) {
    return { allowed: false, message: "项目处于只读模式（tool_permissions.read_only），不能执行修改或控制操作。" };
  }
  if (tool.kind === "write" && toolPermissions.safe_edit === false && SAFE_EDIT_TOOLS.has(tool.name)) {
    return { allowed: false, message: "项目关闭了安全编辑（tool_permissions.safe_edit=false），不能直接修改正文或设定。" };
  }
  if (archived && !ARCHIVE_EXEMPT_TOOLS.has(tool.name)) {
    return { allowed: false, message: "项目已归档（只读）。先解除归档（说「解除归档」即可），再进行修改或控制操作。" };
  }
  return { allowed: true };
}

export async function executeTool(registry, name, args, ctx) {
  const tool = registry.get(name);
  let outcome;
  if (!tool) {
    outcome = { ok: false, error: "unknown_tool", message: `没有名为 ${name} 的工具。可用工具见系统提示。` };
  } else {
    const permission = checkToolPermission(tool, ctx.project?.tool_permissions ?? {}, { archived: Boolean(ctx.project?.archived_at) });
    if (!permission.allowed) {
      outcome = { ok: false, error: "permission_denied", message: permission.message };
    } else {
      try {
        const result = await tool.run(args ?? {}, ctx);
        outcome = { ok: true, result };
      } catch (error) {
        outcome = { ok: false, error: error.code ?? "tool_failed", message: error.message };
      }
    }
  }
  await appendEvent(ctx.projectRoot, {
    type: "chat_tool_executed",
    project_id: ctx.project?.project_id ?? null,
    stage: "chat",
    message: `chat tool ${name}: ${outcome.ok ? "ok" : outcome.error}`,
    data: { tool: name, args_summary: summarizeArgs(args), ok: outcome.ok, error: outcome.ok ? null : outcome.error }
  }).catch(() => {});
  return outcome;
}

export function renderToolDocs(registry) {
  return registry.list().map((tool) => {
    const params = Object.entries(tool.params ?? {}).map(([k, v]) => `    ${k}: ${v}`).join("\n");
    return [`- ${tool.name} (${tool.kind}): ${tool.description}`, params].filter(Boolean).join("\n");
  }).join("\n");
}

export function summarizeArgs(args) {
  const json = JSON.stringify(args ?? {});
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}
