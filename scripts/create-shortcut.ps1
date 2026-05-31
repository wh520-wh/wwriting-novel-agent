$WshShell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "WWriting.lnk"
$shortcut = $WshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "D:\WWriting\dist-desktop\win-unpacked\WWriting Novel Agent.exe"
$shortcut.WorkingDirectory = "D:\WWriting\dist-desktop\win-unpacked"
$shortcut.Description = "WWriting Novel Agent"
$shortcut.Save()
Write-Output "Desktop shortcut created: $shortcutPath"
