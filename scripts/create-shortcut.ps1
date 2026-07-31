$WshShell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "WWriting.lnk"
$shortcut = $WshShell.CreateShortcut($shortcutPath)
# 用打包目录的绝对路径替换下面的占位符
$targetExe = "你的绝对路径\dist-desktop\win-unpacked\WWriting Novel Agent.exe"
$shortcut.TargetPath = $targetExe
$shortcut.WorkingDirectory = Split-Path $targetExe
$shortcut.Description = "WWriting Novel Agent"
$shortcut.Save()
Write-Output "Desktop shortcut created: $shortcutPath"
