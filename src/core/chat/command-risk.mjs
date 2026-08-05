// 命令风险分类：按命令首词识别副作用类别（只读可放行，其余走确认）；
// 高危模式（格式化磁盘、清盘、删除盘符根等）直接标 extreme，即使被
// powershell/cmd/bash 包装也能先剥壳再判断。未知/混合命令一律落 control。
import path from "node:path";

const READ_ONLY = /^(rg|grep|findstr|where|which|type|cat|dir|ls|pwd|Get-Content|Get-ChildItem|Select-String|Resolve-Path|Test-Path)(\s|$)/iu;
const GIT_READ = /^git\s+(status|diff|log|show|branch(?:\s+--show-current)?|rev-parse|ls-files)(\s|$)/iu;
const INSTALL = /^(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get)(\s|$)/iu;
const NETWORK = /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod)(\s|$)|https?:\/\//iu;
const PROCESS = /^(Start-Process|npm\s+run|pnpm\s+run|yarn\s+run|node\s+\S+|python\s+\S+)(\s|$)/iu;
const DELETE = /^(Remove-Item|del|erase|rmdir|rd|rm|git\s+clean)(\s|$)/iu;
const WRITE = /^(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|cp|mv|touch|git\s+(add|commit|checkout|switch|restore|reset|merge|rebase))(\s|$)|(^|[^>])>{1,2}($|[^>])/iu;

// 高危模式：命中即 extreme。删除类目标必须精确到「盘符根 / $HOME / /」，
// 用前瞻检测而非锚定行尾，避免把项目内路径（如 'D:\Novels\demo\tmp.txt'）误判。
const EXTREME = [
  /(?:^|[;&|]\s*)format\s+[a-z]:\s/iu,
  /(?:^|[;&|]\s*)(Clear-Disk|Initialize-Disk|Remove-Partition)\b/iu,
  /(?:^|[;&|]\s*)(dd\s+.*\bof=\/dev\/(sd|nvme|hd)|mkfs(?:\.\w+)?\s+\/dev\/|wipefs\s+.*\/dev\/)/iu,
  /(?:^|[;&|]\s*)bcdedit\s+\/delete\s+\{(?:bootmgr|current|default)\}/iu,
  /(?:^|[;&|]\s*)rm\s+(?=[^\n]*-[^\s]*(?:r[^\s]*f|f[^\s]*r))[^\n]*(?:\s\/\s*$|\s\$HOME\s*$|\s~\s*$)/iu,
  // Remove-Item 需同时带 -Recurse/-Force，且目标为盘符根（可带引号）或 $HOME
  /(?:^|[;&|]\s*)Remove-Item\b(?=[^\n]*-(?:Recurse|r)\b)(?=[^\n]*-(?:Force|fo)\b)(?=[^\n]*(?:['"]?[a-z]:\\['"]?(?=\s|['"]|$)|(?:\s|^)\$HOME(?=\s|$)))/iu
];

export function classifyShellCommand({ command, cwd, projectRoot }) {
  const text = unwrapShellWrapper(String(command).trim());
  const resolvedCwd = path.resolve(cwd || projectRoot);
  const root = path.resolve(projectRoot);
  const scope = isWithin(root, resolvedCwd) ? "project" : "outside";
  const risk = EXTREME.some((pattern) => pattern.test(text)) ? "extreme" : "normal";
  let category = "control";
  if (READ_ONLY.test(text) || GIT_READ.test(text)) category = "read";
  if (WRITE.test(text)) category = "write";
  if (DELETE.test(text)) category = "delete";
  if (NETWORK.test(text)) category = "network";
  if (INSTALL.test(text)) category = "install";
  if (PROCESS.test(text)) category = "process";
  // 出现命令分隔符即混合命令，副作用组合不可精确推断，落 control 走普通确认
  if (/[;&|]/.test(text)) category = "control";
  return {
    category,
    scope,
    risk,
    grant_key: `${category}:${scope}:${targetClass(resolvedCwd, root)}`,
    cwd: resolvedCwd
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function targetClass(cwd, root) {
  return isWithin(root, cwd) ? "project-root" : path.parse(cwd).root.toLowerCase();
}

// 剥掉 powershell/cmd/bash 包装层，让内层命令直接参与分类
function unwrapShellWrapper(command) {
  return command
    .replace(/^\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*?-(?:Command|c)\s+/iu, "")
    .replace(/^\s*cmd(?:\.exe)?\b[^\n]*?\/(?:c|k)\s+/iu, "")
    .replace(/^\s*(?:bash|sh)\b[^\n]*?-(?:lc|c)\s+/iu, "")
    .replace(/^['"]|['"]$/gu, "")
    .trim();
}
