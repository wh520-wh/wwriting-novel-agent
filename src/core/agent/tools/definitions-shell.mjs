// src/core/agent/tools/definitions-shell.mjs —— shell 域注册定义（第十五轮 Task 5 拆分）。
//
// 承接原 tools.mjs 的 shell 注册体（机械平移，逻辑不动）。依赖经 h 注入
// （baseAction/redactor/toolError/isProtectedShellCwd/shellRuntime/truncateOutput/
// MAX_TOOL_OUTPUT_CHARS/MAX_TOOL_RESULT_CHARS）；命令分类与企业作用域解析
// 直接 import shell/risk.mjs；超时上下限是本域私有常量，留在此模块。
import path from "node:path";
import { classifyShellCommand, resolveProjectScope } from "../../shell/risk.mjs";
// 第二十一轮 Task 2：shell 的 scope/受保护 cwd 比较都以解析后的真实项目根为基准。
import { projectRootForChecks } from "./runtime-helpers.mjs";

const SHELL_TIMEOUT_DEFAULT_MS = 120000;
const SHELL_TIMEOUT_MIN_MS = 1000;
const SHELL_TIMEOUT_MAX_MS = 1800000;

export function shellToolDefinitions(h) {
  const {
    baseAction, redactor, toolError, isProtectedShellCwd, shellRuntime,
    truncateOutput, MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_RESULT_CHARS
  } = h;
  return {
    shell: {
      interruptible: true,
      description:
        "在本机命令行执行任意命令。默认目录是当前小说项目；查看、搜索和状态检查可直接运行，副作用由软件权限层决定。",
      schema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, description: "完整命令文本" },
          cwd: { type: "string", description: "可选运行目录；默认当前小说项目" },
          timeout_ms: { type: "integer", minimum: SHELL_TIMEOUT_MIN_MS, maximum: SHELL_TIMEOUT_MAX_MS, description: "可选超时毫秒数（1000–1800000）" },
          purpose: { type: "string", minLength: 1, description: "给用户看的用途说明" }
        },
        required: ["command", "purpose"],
        additionalProperties: false
      },
      describeAction(args, context) {
        const root = projectRootForChecks(context);
        const resolvedCwd = path.resolve(context.projectRoot, args.cwd ?? ".");
        const classified = classifyShellCommand({ command: args.command, cwd: resolvedCwd, projectRoot: root });
        const { targetClass } = resolveProjectScope(root, resolvedCwd);
        const action = baseAction({
          category: classified.category,
          scope: classified.scope,
          targetClass,
          grantKey: classified.grant_key,
          title: "运行命令",
          description: redactor.redact(String(args.purpose ?? "")),
          targets: [classified.cwd],
          command: redactor.redact(String(args.command)),
          cwd: classified.cwd
        });
        action.risk = classified.risk;
        return action;
      },
      protectedCheck(args, context) {
        const resolvedCwd = path.resolve(context.projectRoot, args.cwd ?? ".");
        return isProtectedShellCwd(projectRootForChecks(context), resolvedCwd);
      },
      async run(args, context, call) {
        if (typeof shellRuntime !== "function") {
          throw toolError("shell_unavailable", "工具不可用。", { rule: "not_wired", tool: "shell" });
        }
        const resolvedCwd = path.resolve(context.projectRoot, args.cwd ?? ".");
        const timeoutMs = Math.min(
          Math.max(Number(args.timeout_ms) || SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MIN_MS),
          SHELL_TIMEOUT_MAX_MS
        );
        // shell 的 stdout/stderr 输出与受控进程事件（spawn/输出）都刷新工具空闲
        // 期限：onOutput 与 onActivity 都报告 activity（onActivity 覆盖真实
        // runShellCommand 的进程活动，onOutput 兜底增量输出路径与测试桩）。
        const reportShellActivity = () => context.reportActivity?.();
        const result = await shellRuntime({
          command: String(args.command),
          cwd: resolvedCwd,
          timeoutMs,
          purpose: String(args.purpose ?? ""),
          signal: context.signal,
          onOutput: ({ stream, text }) => {
            call.emitDelta({ stream, text });
            reportShellActivity();
          },
          onActivity: reportShellActivity
        });
        // 返回侧脱敏口径：shell 输出对模型侧同样脱敏（前置计划已验收行为）——命令输出
        // 可能回显密钥（如 cat 含密钥的配置），stdout/stderr 在返回前先过脱敏；这与
        // read_file 原样返回文件内容不同（模型需要真实文件内容工作，见 read_file 注释），
        // 有意不对称：shell 输出是进程产生的不受控文本，文件内容是模型自己点名读取的。
        const stdout = redactor.redact(result.stdout);
        const stderr = redactor.redact(result.stderr);
        // R5-15：终态与 tool_output_delta 共用同一截断口径——content_length 与
        // truncated 都基于同一拼接串（stdout + stderr）计算，避免边界 off-by-one。
        const combined = `${stdout}${stderr}`;
        const { truncated } = truncateOutput(combined, MAX_TOOL_OUTPUT_CHARS);
        // 结果内容按 MAX_TOOL_RESULT_CHARS 合并预算截断（stdout 优先、stderr 吃余量），
        // 防止单次 shell 输出独自撞爆上下文硬窗口；content_length 仍报真实长度。
        const stdoutKept = stdout.slice(0, MAX_TOOL_RESULT_CHARS);
        const stderrKept = stderr.slice(0, Math.max(0, MAX_TOOL_RESULT_CHARS - stdoutKept.length));
        return {
          command: redactor.redact(result.command),
          cwd: redactor.redact(result.cwd),
          exit_code: result.exitCode,
          signal: result.signal ?? null,
          duration_ms: result.durationMs,
          stdout: stdoutKept,
          stderr: stderrKept,
          content_length: combined.length,
          truncated: truncated || combined.length > MAX_TOOL_RESULT_CHARS
        };
      }
    }
  };
}