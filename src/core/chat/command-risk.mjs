// 命令风险分类：按命令首词识别副作用类别（只读可放行，其余走确认）；
// 高危模式（格式化磁盘、清盘、删除盘符根等）直接标 extreme，即使被
// powershell/cmd/bash/zsh/sudo/env 等包装也能先剥壳再判断。未知/混合命令一律落 control。
import path from "node:path";

const READ_ONLY = /^(rg|grep|findstr|where|which|type|cat|dir|ls|pwd|Get-Content|Get-ChildItem|Select-String|Resolve-Path|Test-Path)(\s|$)/iu;
const GIT_READ = /^git\s+(status|diff|log|show|branch(?:\s+--show-current)?|rev-parse|ls-files)(\s|$)/iu;
const INSTALL = /^(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get)(\s|$)/iu;
const NETWORK = /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod)(\s|$)|https?:\/\//iu;
const PROCESS = /^(Start-Process|npm\s+run|pnpm\s+run|yarn\s+run|node\s+\S+|python\s+\S+)(\s|$)/iu;
const DELETE = /^(Remove-Item|del|erase|rmdir|rd|rm|git\s+clean)(\s|$)/iu;
const WRITE = /^(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|mkdir|md|cp|mv|touch|git\s+(add|commit|checkout|switch|restore|reset|merge|rebase))(\s|$)|(^|[^>])>{1,2}($|[^>])/iu;

// 高危模式：命中即 extreme。删除类目标必须精确到「盘符根 / $HOME / 家目录根」，
// 用前瞻检测而非锚定行尾，避免把项目内路径（如 'D:\Novels\demo\tmp.txt'、'rm -rf /tmp/x'）误判。
const EXTREME = [
  // format：目标为盘符根（可带 \ / 与引号），后跟参数或行尾即可（format C:\ /Q、format D:）
  /(?:^|[;&|]\s*)format\s+["']?[a-z]:[\\/]?["']?(?=\s|$|[;&|])/iu,
  /(?:^|[;&|]\s*)(Clear-Disk|Initialize-Disk|Remove-Partition)\b/iu,
  // dd 写块设备（sd/vd/hd/nvme/mmcblk/loop/mapper/disk-by 等前缀，有无 if= 都算）；
  // mkfs 接受 -t 选项与 mkfs.fs 形式；wipefs 必须带 -a/--all 才算破坏（无参只打印信息）
  /(?:^|[;&|]\s*)(?:dd\s+[^\n;&|]*\bof=\/dev\/(?:[svh]d|nvme\d|mmcblk|loop\d*|mapper\/|disk\/by-|dm-\d|md\d|zram\d*)[^\s;&|]*|mkfs(?:\.\w+)?(?:\s+-[a-z]+\w*(?:\s+\S+)?)*\s+\/dev\/[^\s;&|]+|wipefs\s+(?=[^\n;&|]*(?:-a\b|--all\b))[^\n;&|]*\/dev\/[^\s;&|]+)/iu,
  /(?:^|[;&|]\s*)bcdedit\s+\/delete\s+\{(?:bootmgr|current|default)\}/iu,
  // rm：同时含 r/f 旗标（-rf/-fr/-r -f/-f r 等组合），目标是 /、~、~/、$HOME 等变体
  // （可引号包裹），目标后只允许空白、--no-preserve-root 或分隔符；
  // ~/Projects/mylib、/tmp/x 这类带具体路径的不算
  /(?:^|[;&|]\s*)rm\b(?=[^\n;&|]*\b-?\w*r\w*\b)(?=[^\n;&|]*\b-?\w*f\w*\b)(?:[^\n;&|]*?\s)(?:\/|~\/?|["']?\$HOME["']?\/?)(?=\s*(?:--no-preserve-root\s*)?(?:[;&|]|$))/iu,
  // rd/rmdir：带 /s（或 -s）且目标是盘符根
  /(?:^|[;&|]\s*)(?:rd|rmdir)\b(?=[^\n;&|]*[\\/-]s\b)(?:[^\n;&|]*?\s)["']?[a-z]:\\["']?(?=\s|$|[;&|])/iu,
  // del：带 /s 且目标是盘符根通配（如 C:\*.*）。/s 才是递归清盘旗标，/f 仅强删只读文件，
  // 不作为判定前提：del /s /q C:\*.*（无 /f）同样会静默清空盘符
  /(?:^|[;&|]\s*)del\b(?=[^\n;&|]*[\\/-]s\b)(?:[^\n;&|]*?\s)["']?[a-z]:\\[*?][^\s'";&|]*["']?(?=\s|$|[;&|])/iu,
  // Remove-Item：盘符根（C:\、C:/、C:\*，可引号）需同时带 -Recurse 与 -Force
  // （含 -r/-f 短旗标；-Force:$false 不算）；$HOME 及 $HOME\* 直接算高危
  /(?:^|[;&|]\s*)Remove-Item\b(?=[^\n;&|]*-(?:Recurse|r)\b)(?=[^\n;&|]*-(?:Force|fo(?:rce)?|f)\b(?![:\$]*false\b))(?:[^\n;&|]*?\s)["']?[a-z]:[\\/](?:\*[^\s'";&|]*)?["']?(?=\s|$|[;&|])/iu,
  /(?:^|[;&|]\s*)Remove-Item\b(?:[^\n;&|]*?\s)["']?\$HOME(?:\\[*?][^\s'";&|]*)?["']?(?=\s|$|[;&|])/iu,
  // Format-Volume / Remove-Volume：带 -DriveLetter 盘符参数
  /(?:^|[;&|]\s*)(?:Format-Volume|Remove-Volume)\b[^\n;&|]*-DriveLetter\s+["']?[a-z]:?["']?(?=[\s'";,]|$|[;&|])/iu
];

export function classifyShellCommand({ command, cwd, projectRoot }) {
  const text = unwrapShellWrapper(command);
  // projectRoot 缺省时兜底到进程工作目录，避免缺参直接抛错
  const root = path.resolve(projectRoot || process.cwd());
  const resolvedCwd = path.resolve(cwd || projectRoot || process.cwd());
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
  // 注意 ..foo 是项目内目录名而非越界；只有相对路径为 ".."、以 "..<分隔符>" 开头
  // 或跨盘符（相对路径为绝对路径）才算 outside
  return relative === "" || (!(relative === ".." || relative.startsWith(".." + path.sep)) && !path.isAbsolute(relative));
}

function targetClass(cwd, root) {
  return isWithin(root, cwd) ? "project-root" : path.parse(cwd).root.toLowerCase();
}

// 剥掉 powershell/cmd/bash/zsh/sudo/time/nohup/env 等包装层，让内层命令直接参与分类；
// 循环剥离以应对嵌套（如 bash -c 'sudo rm -rf /'、sudo env X=1 rm -rf /）
function unwrapShellWrapper(command) {
  let text = String(command).trim();
  for (let round = 0; round < 8; round++) {
    const before = text;
    text = text
      .replace(/^\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*?-(?:Command|c)\s+/iu, "")
      .replace(/^\s*cmd(?:\.exe)?\b[^\n]*?\/(?:c|k)\s+/iu, "")
      .replace(/^\s*(?:bash|sh|zsh)\b[^\n]*?-(?:[a-z]*c|lc|e)\s+/iu, "")
      .replace(/^\s*(?:sudo|time|nohup)\s+/iu, "")
      .replace(/^\s*env(?:\s+-i)?(?:\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))*\s+/iu, "")
      .replace(/^['"]|['"]$/gu, "")
      .trim();
    if (text === before) break;
  }
  return text;
}
