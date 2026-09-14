export const SLASH_COMMANDS = Object.freeze([
  { command: "/init", label: "初始化" },
  { command: "/write", label: "写作" },
  // Task 12 Step 4：/compact 只是补全候选；识别由 runtime 的严格全等比较完成，
  // 前端绝不使用 /compact 前缀匹配决定压缩。
  { command: "/compact", label: "压缩当前上下文" },
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
