// 命令风险分类语料：高危正例必须是「磁盘级/系统级破坏」，日常反例是项目内正常操作。
// 语义约定：EXTREME_COMMANDS 每一条都必须被分类为 risk === "extreme"，
// NORMAL_DESTRUCTIVE_COMMANDS 每一条都绝不能是 "extreme"。
export const EXTREME_COMMANDS = [
  "format C: /FS:NTFS /Q",
  "Clear-Disk -Number 0 -RemoveData -Confirm:$false",
  "powershell.exe -NoProfile -Command \"Clear-Disk -Number 0 -RemoveData -Confirm:$false\"",
  "cmd.exe /d /c format C: /Q",
  "Get-Disk 0 | Clear-Disk -RemoveData -Confirm:$false",
  "Remove-Item -LiteralPath 'C:\\' -Recurse -Force",
  "rm -rf /",
  "rm -rf $HOME",
  "dd if=/dev/zero of=/dev/sda bs=4M",
  "mkfs.ext4 /dev/sda1",
  "bcdedit /delete {bootmgr}"
];

export const NORMAL_DESTRUCTIVE_COMMANDS = [
  "Remove-Item -LiteralPath '.\\dist' -Recurse -Force",
  "rm -rf ./node_modules",
  "git clean -fd build",
  "npm install",
  "Move-Item '.\\draft.md' '.\\archive\\draft.md'",
  "Remove-Item -LiteralPath 'D:\\Novels\\demo\\tmp.txt' -Force",
  "Set-Content -LiteralPath '.\\OUTLINE.md' -Value '# Outline'"
];
