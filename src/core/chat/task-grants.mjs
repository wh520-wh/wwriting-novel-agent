// Task 7: 任务级授权与工具动作授权决策。
// store 是纯内存态：进程重启自动失效；任务结束 / 停止 / 新用户消息 / 项目切换时由
// chat-agent 与 app-shell 显式清理（grants.clear / grants.clearProject）。
// 决策优先级（与 spec 一致）：
//   extreme > read_only 拒绝 > yolo 放行 > 项目内 read 自动 > auto_edit 项目内 write
//   > 任务授权（同一 taskId + grant_key）> 普通确认
export function createTaskGrantStore() {
  const entries = new Map();
  const key = (projectRoot, taskId) => `${projectRoot ?? ""}\u0000${taskId ?? ""}`;
  return {
    allow(projectRoot, taskId, grantKey) {
      const id = key(projectRoot, taskId);
      const set = entries.get(id) ?? new Set();
      set.add(grantKey);
      entries.set(id, set);
    },
    has(projectRoot, taskId, grantKey) {
      return entries.get(key(projectRoot, taskId))?.has(grantKey) === true;
    },
    clear(projectRoot, taskId) {
      entries.delete(key(projectRoot, taskId));
    },
    clearProject(projectRoot) {
      const prefix = `${projectRoot ?? ""}\u0000`;
      for (const id of entries.keys()) if (id.startsWith(prefix)) entries.delete(id);
    }
  };
}

export function decideToolAuthorization({ projectRoot = "", action, permissions = {}, taskId, grants }) {
  if (action.risk === "extreme") return { decision: "extreme_confirm" };
  if (permissions.read_only === true && action.category !== "read") return { decision: "deny", reason: "项目处于只读模式。" };
  if (permissions.yolo === true) return { decision: "allow" };
  if (action.category === "read" && action.scope === "project") return { decision: "allow" };
  if (permissions.auto_edit === true && action.category === "write" && action.scope === "project") return { decision: "allow" };
  if (grants?.has(projectRoot, taskId, action.grant_key) === true) return { decision: "allow" };
  return { decision: "confirm" };
}
