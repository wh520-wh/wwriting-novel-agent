// 声明式 slash 命令注册表
// 单一职责:存储命令,提供按需查询
const commands = new Map();

export function registerCommand(cmd) {
  if (!cmd || typeof cmd !== "object") {
    throw new Error("command must be an object");
  }
  if (!cmd.name || typeof cmd.name !== "string") {
    throw new Error("command.name must be a non-empty string");
  }
  if (typeof cmd.run !== "function") {
    throw new Error(`command.run must be a function (name=${cmd.name})`);
  }
  commands.set(cmd.name, cmd);
}

export function getCommand(name) {
  return commands.get(name);
}

export function listCommands(filter = {}) {
  return [...commands.values()].filter((cmd) => {
    if (filter.category && cmd.category !== filter.category) return false;
    if (filter.userInvocable !== undefined && cmd.userInvocable !== filter.userInvocable) return false;
    if (typeof cmd.isEnabled === "function" && !cmd.isEnabled()) return false;
    return true;
  });
}

// Test-only: reset internal state
export function __resetRegistry() {
  commands.clear();
}
