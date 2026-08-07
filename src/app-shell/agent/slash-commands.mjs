export const SLASH_COMMANDS = Object.freeze([
  { command: "/init", label: "初始化" },
  { command: "/write", label: "写作" },
  { command: "/model", label: "模型", localSection: "model" },
  { command: "/settings", label: "设置", localSection: "settings" }
]);

export function matchSlashCommands(value) {
  const query = String(value ?? "").trimStart().toLowerCase();
  if (!query.startsWith("/") || /\s/u.test(query)) return [];
  return SLASH_COMMANDS.filter((item) => item.command.startsWith(query));
}

export function localSlashSection(value) {
  const command = String(value ?? "").trim().toLowerCase();
  return SLASH_COMMANDS.find((item) => item.command === command)?.localSection ?? null;
}
