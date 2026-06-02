// 声明式 slash 命令注册表
// 单一职责:存储命令 + 广播变更,无业务逻辑
const commands = new Map();
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("onCommandsChanged listener threw:", e);
    }
  }
}

function validateCommand(cmd) {
  if (!cmd || typeof cmd !== "object") {
    throw new CommandValidationError("command must be an object");
  }
  if (!cmd.name || typeof cmd.name !== "string") {
    throw new CommandValidationError("command.name must be a non-empty string");
  }
  if (typeof cmd.run !== "function") {
    throw new CommandValidationError(`command.run must be a function (name=${cmd.name})`);
  }
}

export function registerCommand(cmd) {
  validateCommand(cmd);
  const existed = commands.has(cmd.name);
  const wrapped = withPermissionCheck(cmd);
  commands.set(cmd.name, wrapped);
  if (!existed) notify();
}

export function unregisterCommand(name) {
  if (commands.delete(name)) notify();
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

export function onCommandsChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Wrap a command's run with canUse enforcement
function withPermissionCheck(cmd) {
  if (typeof cmd.canUse !== "function") return cmd;
  const originalRun = cmd.run;
  return {
    ...cmd,
    run: async (input, ctx) => {
      if (!cmd.canUse(ctx)) {
        throw new CommandNotAllowed(`command "${cmd.name}" not allowed in current context`);
      }
      return originalRun(input, ctx);
    },
  };
}

export class CommandValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandValidationError";
  }
}

export class CommandNotAllowed extends Error {
  constructor(message) {
    super(message);
    this.name = "CommandNotAllowed";
  }
}

// Test-only: reset internal state
export function __resetRegistry() {
  commands.clear();
  listeners.clear();
}
