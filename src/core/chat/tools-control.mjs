// 对话 agent 的控制工具：start_run / pause_run / resolve_failure。
// 全部依赖 ctx.server = { runJobs, getTaskQueue, startProjectRun }；
// 缺 ctx.server 时抛 control_unavailable，让 executeTool 包装为 ok:false。
import path from "node:path";
import { loadProject } from "../project-store.mjs";
import { applyFailureResolution } from "../failure-actions.mjs";

function requireServer(ctx) {
  if (!ctx.server) {
    const e = new Error("当前会话无法控制写作任务（缺少服务端上下文）。");
    e.code = "control_unavailable";
    throw e;
  }
  return ctx.server;
}

// 复制自 src/core/app-server.mjs 的同名函数（避免循环依赖：app-server 不会引入 chat 层）。
// job 形状：{ status, controller, ... }，status === "running" 时认为在跑。
export function isJobRunning(job) {
  return job?.status === "running";
}

export function registerControlTools(registry) {
  registry.register({
    name: "start_run",
    kind: "control",
    description: "开始或继续写作（取下一个队列任务交给流水线）。",
    params: {},
    run: async (_args, ctx) => {
      const server = requireServer(ctx);
      const key = path.resolve(ctx.projectRoot);
      if (isJobRunning(server.runJobs.get(key))) {
        return { started: false, already_running: true };
      }
      const queue = await server.getTaskQueue(ctx.projectRoot);
      const task = await queue.promoteNext();
      if (!task) {
        const e = new Error("任务队列为空，先用 queue_chapters 排任务。");
        e.code = "queue_empty";
        throw e;
      }
      const project = await loadProject(ctx.projectRoot);
      const status = await server.startProjectRun(ctx.projectRoot, project, server, task, { source: "chat_agent" });
      return { started: status.started !== false, task: task.instruction ?? null };
    }
  });

  registry.register({
    name: "pause_run",
    kind: "control",
    description: "暂停当前写作任务（在安全点停下，可随时继续）。",
    params: {},
    run: async (_args, ctx) => {
      const server = requireServer(ctx);
      const job = server.runJobs.get(path.resolve(ctx.projectRoot));
      if (!isJobRunning(job)) {
        const e = new Error("当前没有正在运行的写作任务。");
        e.code = "not_running";
        throw e;
      }
      job.controller.abort("chat_agent 请求暂停");
      return { paused: true };
    }
  });

  registry.register({
    name: "resolve_failure",
    kind: "control",
    description: "处理当前故障卡。command 见故障卡可用动作（如 retry-segment / fill-words / raise-cost-budget / switch-model）。",
    params: {
      command: "动作名",
      args: "动作参数对象（可空）"
    },
    run: async (args, ctx) => {
      requireServer(ctx);
      const result = await applyFailureResolution(ctx.projectRoot, {
        command: String(args.command ?? ""),
        args: args.args ?? {}
      });
      return { applied: true, result };
    }
  });
}
