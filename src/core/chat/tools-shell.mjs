// 通用 shell 工具：允许聊天 Agent 在本机命令行执行任意命令（默认目录为当前小说项目）。
// 风险元数据由 describeAction 按命令静态分类得出（read/write/delete/network/install/process/control），
// 模型传入的 risk/allowed 字段一律忽略——inputSchema 里根本不暴露这两个字段。
import { classifyShellCommand } from "./command-risk.mjs";
import { redactChatData } from "./chat-redaction.mjs";
import { runShellCommand } from "./shell-runtime.mjs";

export function registerShellTools(registry) {
  registry.register({
    name: "shell",
    kind: "shell",
    description: "在本机命令行执行任意命令。默认目录是当前小说项目；查看、搜索和状态检查可直接运行，副作用由软件权限层决定。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "完整命令文本" },
        cwd: { type: "string", description: "可选运行目录；默认当前小说项目" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 1800000, description: "可选超时毫秒数" },
        purpose: { type: "string", minLength: 1, description: "给用户看的用途说明" }
      },
      required: ["command", "purpose"],
      additionalProperties: false
    },
    describeAction(args, ctx) {
      const classified = classifyShellCommand({
        command: args.command,
        cwd: args.cwd || ctx.projectRoot,
        projectRoot: ctx.projectRoot
      });
      return {
        ...classified,
        title: "运行命令",
        description: String(args.purpose),
        command: String(args.command),
        targets: [classified.cwd],
        preview: null
      };
    },
    async run(args, ctx) {
      const result = await runShellCommand({
        command: args.command,
        cwd: args.cwd || ctx.projectRoot,
        timeoutMs: Number(args.timeout_ms) || 120000,
        signal: ctx.signal,
        onOutput: ({ stream, text }) => ctx.onToolOutput?.({ stream, text: redactChatData(text) })
      });
      return {
        ...result,
        command: redactChatData(result.command),
        stdout: redactChatData(result.stdout),
        stderr: redactChatData(result.stderr)
      };
    }
  });
}
