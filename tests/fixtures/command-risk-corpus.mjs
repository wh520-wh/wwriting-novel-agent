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
  "bcdedit /delete {bootmgr}",
  // 旗标拆分 / 家目录变体 / 目标后接分隔符
  "rm -r -f /",
  "rm -f r /",
  "rm -rf ~/",
  "rm -rf $HOME/",
  "rm -rf \"$HOME\"",
  "rm -rf / --no-preserve-root",
  "rm -rf / && echo done",
  "rm -rf / --no-preserve-root && echo done",
  // Windows 系:rd/rmdir、del 盘符根、Remove-Item 短旗标与正斜杠、format 变体
  "rd /s /q C:\\",
  "rmdir /s C:\\",
  "del /f /s /q C:\\*.*",
  "del /s /q C:\\*.*",
  "Remove-Item C:\\ -r -f",
  "Remove-Item C:/ -Recurse -Force",
  "Remove-Item C:\\* -Recurse -Force",
  "Remove-Item \"$HOME\"",
  "Remove-Item $HOME\\*",
  "format C:\\ /Q",
  "format D:",
  "Format-Volume -DriveLetter C -Confirm:$false",
  "Remove-Volume -DriveLetter C",
  // 设备名扩展 / mkfs -t / wipefs 带 -a
  "dd if=/dev/zero of=/dev/vda",
  "dd of=/dev/mmcblk0",
  "mkfs -t ext4 /dev/sda1",
  "mkfs.btrfs -f /dev/sdb1",
  "wipefs -a /dev/sda",
  "wipefs --all /dev/sda1",
  // 剥壳前缀
  "sudo rm -rf /",
  "zsh -c 'rm -rf /'",
  "bash -ec 'rm -rf /'",
  "env X=1 rm -rf /",
  "sudo env X=1 rm -rf /",
  "nohup rm -rf /"
];

export const NORMAL_DESTRUCTIVE_COMMANDS = [
  "Remove-Item -LiteralPath '.\\dist' -Recurse -Force",
  "rm -rf ./node_modules",
  "git clean -fd build",
  "npm install",
  "Move-Item '.\\draft.md' '.\\archive\\draft.md'",
  "Remove-Item -LiteralPath 'D:\\Novels\\demo\\tmp.txt' -Force",
  "Set-Content -LiteralPath '.\\OUTLINE.md' -Value '# Outline'",
  // 项目内相对路径与具体路径绝不误判为 extreme
  "wipefs /dev/sda",
  "wipefs -f /dev/sda",
  "rm -rf /tmp/x",
  "rm -rf build/",
  "rm -rf ~/Projects/mylib",
  "Remove-Item C:\\x -Recurse -Force",
  "Remove-Item $HOME\\Desktop\\foo.txt",
  "rd /s /q .\\dist",
  "del /f /s /q .\\build\\*.*",
  "dd if=file of=file"
];
