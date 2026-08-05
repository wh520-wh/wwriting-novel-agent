// 通用 shell 工具：允许聊天 Agent 在本机命令行执行任意命令（默认目录为当前小说项目）。
// 风险元数据由 describeAction 按命令静态分类得出（read/write/delete/network/install/process/control），
// 模型传入的 risk/allowed 字段一律忽略——inputSchema 里根本不暴露这两个字段。
// ctx.signal / ctx.onToolOutput 由 chat-agent 接线：signal 用于用户停止时中止命令（进程树级），
// onToolOutput 把脱敏后的增量输出转发为 chat_activity 流式事件（同一 activity_id）。
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
        cwd: args.cwd || ctx?.projectRoot,
        projectRoot: ctx?.projectRoot
      });
      return {
        ...classified,
        title: "运行命令",
        description: redactChatData(String(args.purpose)),
        command: redactChatData(String(args.command)),
        targets: [classified.cwd],
        preview: null
      };
    },
    async run(args, ctx) {
      const result = await runShellCommand({
        command: args.command,
        cwd: args.cwd || ctx.projectRoot,
        timeoutMs: Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 1800000),
        signal: ctx.signal,
        onOutput: ({ stream, text }) => {
          // 逐块脱敏存在 chunk 边界切分密钥的窗口（流式闪现明文，结果级脱敏兜底）
          ctx.onToolOutput?.({ stream, text: redactChatData(text) });
        }
      });
      return {
        ...result,
        command: redactChatData(result.command),
        cwd: redactChatData(result.cwd),
        stdout: redactChatData(result.stdout),
        stderr: redactChatData(result.stderr)
      };
    }
  });
}
