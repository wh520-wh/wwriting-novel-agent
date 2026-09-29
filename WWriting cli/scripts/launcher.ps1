param(
    [string]$Target = '',
    [switch]$DryRun
)

# WWriting 快速启动器：双击 publish and run.bat 后由它接手。
#   1. 检查 Node；
#   2. 把仓库更新到最新（Git 仓库且配了远端就拉取；按声明安装依赖）；
#   3. 弹出文件夹选择框，选中哪个目录就用哪个目录当工作区；
#   4. 在那个目录里打开一个新的命令行窗口并启动工具。
#
# 本文件必须保存为「UTF-8 with BOM」：Windows PowerShell 5.1 在没有 BOM 时按 ANSI 解析脚本，
# 中文会变成乱码或直接语法错误。同理，publish and run.bat 保持纯 ASCII，中文只在这里输出。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot          # scripts\ 的上一级 = 仓库根
$cli = Join-Path $root 'src\cli.mjs'

# 输出一律走 [Console]::WriteLine 而不是 Write-Host：前者是真正的「一行一条」，
# 在控制台、重定向与管道下行为一致（Write-Host 在 PS 5.1 走信息流，重定向时会把几行挤在一起）。
function Write-Note([string]$text) {
    [Console]::WriteLine($text)
}

# 失败也要让信息留在屏幕上：窗口是双击出来的，退出前先停一下。
function Stop-WithMessage([string]$text) {
    $previousColor = [Console]::ForegroundColor
    [Console]::ForegroundColor = [ConsoleColor]::Red
    [Console]::WriteLine($text)
    [Console]::ForegroundColor = $previousColor
    Start-Sleep -Seconds 5
    exit 1
}

# 跑一条原生命令，返回 { Code, Text }。输出（含 stderr）一律并入 Text，退出码决定成败。
# 这一层不是装饰：Windows PowerShell 5.1 在 $ErrorActionPreference='Stop' 下，
# 对原生命令做 stderr 重定向（`git ... 2>$null`）会抛 NativeCommandError——踩过一次，
# 症状是「本地仓库没有远端」被误判成「更新失败」。
function Invoke-Native([string]$program, [string[]]$arguments, [string]$workDir = '') {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $pushed = $false
    try {
        if ($workDir -ne '') {
            Push-Location $workDir
            $pushed = $true
        }
        $output = & $program @arguments 2>&1
        $code = $LASTEXITCODE
        $text = ($output | Out-String).Trim()
        return [pscustomobject]@{ Code = $code; Text = $text }
    } catch {
        return [pscustomobject]@{ Code = 1; Text = [string]$_.Exception.Message }
    } finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $previous
    }
}

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    Stop-WithMessage ("没有找到工具入口：{0}`n请确认 publish and run.bat 与本仓库放在一起。" -f $cli)
}

# —— 1. Node ——
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Stop-WithMessage '没有找到 Node.js。请先安装 Node.js（推荐 24 或更高版本），然后重新双击本脚本。'
}

$nodeReport = Invoke-Native 'node' @('--version')
$nodeVersion = ''
if ($nodeReport.Code -eq 0) { $nodeVersion = $nodeReport.Text }
$nodeMajor = 0
if ($nodeVersion -match '^v(\d+)') {
    $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -gt 0 -and $nodeMajor -lt 24) {
    Write-Note ("提示：本机 Node 是 {0}，项目声明需要 24 或更高。当前版本通常仍能运行，建议择机升级。" -f $nodeVersion)
}

# —— 2. 更新到最新 ——
$updateNote = '没有找到 package.json，跳过更新。'
$commit = ''
$dirty = $false

if (Test-Path -LiteralPath (Join-Path $root '.git')) {
    $gitCommand = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $gitCommand) {
        $updateNote = '没有找到 git，跳过更新，直接用当前代码。'
    } else {
        $headReport = Invoke-Native 'git' @('rev-parse', '--short', 'HEAD') $root
        if ($headReport.Code -eq 0) {
            $commit = $headReport.Text
            $porcelainReport = Invoke-Native 'git' @('status', '--porcelain') $root
            $dirty = ($porcelainReport.Code -eq 0) -and ($porcelainReport.Text -ne '')

            # 只有配了上游分支才拉取；否则「更新」就是当前这份代码（加 --ff-only 不做合并提交）。
            $upstreamReport = Invoke-Native 'git' @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') $root
            if ($upstreamReport.Code -eq 0 -and $upstreamReport.Text -ne '') {
                Write-Note '正在拉取最新代码……'
                $before = $commit
                $pullReport = Invoke-Native 'git' @('pull', '--ff-only', '--quiet') $root
                $afterReport = Invoke-Native 'git' @('rev-parse', '--short', 'HEAD') $root
                if ($afterReport.Code -eq 0) { $commit = $afterReport.Text }
                if ($pullReport.Code -ne 0) {
                    $updateNote = '拉取失败，继续用当前代码。'
                } elseif ($before -eq $commit) {
                    $updateNote = ("已是最新（{0}）" -f $commit)
                } else {
                    $updateNote = ("已更新：{0} → {1}" -f $before, $commit)
                }
            } else {
                $updateNote = ("本地仓库（{0}），没有配置远端，直接用当前代码。" -f $commit)
            }
        } else {
            $updateNote = '读不到 Git 状态，跳过更新，直接用当前代码。'
        }
    }
}

# 依赖：只有 package.json 里真的声明了 dependencies 且 node_modules 缺失时才装。
$packageJson = Join-Path $root 'package.json'
if (Test-Path -LiteralPath $packageJson) {
    $hasDependencies = $false
    try {
        $manifest = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $manifest.PSObject.Properties['dependencies']) { $hasDependencies = $true }
    } catch {
        $hasDependencies = $false
    }
    if ($hasDependencies -and -not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
        if ($null -ne $npmCommand) {
            Write-Note '正在安装依赖……'
            $installReport = Invoke-Native 'npm' @('install', '--no-audit', '--no-fund') $root
            if ($installReport.Code -ne 0) {
                Write-Note '依赖安装失败，继续尝试启动。'
            }
        }
    }
}

# —— 版本号：走 CLI 自己的 --version，保证启动器显示的就是工具真正加载的那份 ——
$versionReport = Invoke-Native 'node' @($cli, '--version')
$versionText = 'WWriting（版本未知）'
if ($versionReport.Code -eq 0 -and $versionReport.Text -ne '') {
    $versionText = $versionReport.Text
}

# —— 3. 选择工作目录 ——

# 上次用的目录：双击启动的人不该每次都从头找一遍。
# 存在应用私有目录（%APPDATA%\WWriting\launcher.json）——创作目录里只放作品，不放这种状态。
function Get-SettingsPath {
    if (-not $env:APPDATA) { return '' }
    return (Join-Path (Join-Path $env:APPDATA 'WWriting') 'launcher.json')
}

function Read-LastTarget {
    $path = Get-SettingsPath
    if ($path -eq '' -or -not (Test-Path -LiteralPath $path)) { return '' }
    try {
        $data = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $last = [string]$data.last_target
        # 目录可能已经被删掉/改名：那样就当没有记忆，别让用户对着一个不存在的路径发懵。
        if ($last -ne '' -and (Test-Path -LiteralPath $last -PathType Container)) { return $last }
    } catch {
        # 记忆文件坏了不影响启动，最多这次重新选。
    }
    return ''
}

function Save-LastTarget([string]$path) {
    $settings = Get-SettingsPath
    if ($settings -eq '') { return }
    try {
        $dir = Split-Path -Parent $settings
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Set-Content -LiteralPath $settings -Value (@{ last_target = $path } | ConvertTo-Json) -Encoding UTF8
    } catch {
        # 记不住也不算错：下次重新选一遍而已。
    }
}

function Select-WorkFolder([string]$title) {
    # 优先用 Shell 的目录选择框（有「新建文件夹」，且能直接跳到常用位置）；
    # COM 不可用时退回 WinForms 的 FolderBrowserDialog。
    try {
        $shell = New-Object -ComObject Shell.Application
        $browseOptions = 0x0041   # BIF_RETURNONLYFSDIRS + BIF_NEWDIALOGSTYLE
        $picked = $shell.BrowseForFolder(0, $title, $browseOptions, 0)
        if ($null -eq $picked) { return '' }
        return [string]$picked.Self.Path
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = $title
            $dialog.ShowNewFolderButton = $true
            if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                return [string]$dialog.SelectedPath
            }
            return ''
        } catch {
            return ''
        }
    }
}

# 记得上次用哪个目录，就问一句要不要沿用；回车就用，省掉一次翻文件夹。
# 只有真的在交互（双击出来的窗口）时才问——-DryRun 或没有记忆时直接走选择框。
function Resolve-TargetFromMemory {
    $last = Read-LastTarget
    if ($last -eq '') { return '' }
    if ($DryRun) {
        Write-Note ("上次的创作目录：{0}（演练模式：直接沿用）" -f $last)
        return $last
    }
    Write-Note ("上次的创作目录：{0}" -f $last)
    $answer = ''
    try {
        $answer = Read-Host '回车 = 就用它 · 输入 1 = 换一个目录（也可以直接粘贴一个目录路径）'
    } catch {
        # 拿不到输入（管道关了等）：当成「沿用上次」。
        $answer = ''
    }
    $answer = ([string]$answer).Trim()
    if ($answer -eq '') { return $last }
    if (Test-Path -LiteralPath $answer -PathType Container) { return (Resolve-Path -LiteralPath $answer).Path }
    return ''
}

if ($Target -eq '' -and $env:WWRITING_TARGET) {
    $Target = [string]$env:WWRITING_TARGET
}

if ($Target -ne '') {
    if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
        Stop-WithMessage ("指定的目录不存在：{0}" -f $Target)
    }
    $Target = (Resolve-Path -LiteralPath $Target).Path
} else {
    $remembered = Resolve-TargetFromMemory
    if ($remembered -ne '') {
        $Target = $remembered
    } else {
        $Target = Select-WorkFolder '选择创作目录（WWriting 会在这个目录里工作）'
        if ($Target -eq '' -or -not (Test-Path -LiteralPath $Target -PathType Container)) {
            Write-Note '已取消：没有选择目录。'
            Start-Sleep -Seconds 2
            exit 0
        }
        $Target = (Resolve-Path -LiteralPath $Target).Path
        Save-LastTarget $Target
    }
}

# —— 4. 汇报 + 在该目录打开命令行并启动 ——
# 启动命令经环境变量传给子 cmd：这样从 PowerShell 传给 cmd 的参数里不带引号，
# 规避 PS 5.1 对含空格路径的引号转义问题（仓库路径往往带空格）。
# 工作目录给两遍：新窗口的起始目录（=「在这个文件夹里打开命令行」）+ --cwd（工具自己认的那个）。
$env:WWRITING_LAUNCH = 'node "' + $cli + '" --cwd "' + $Target + '"'

Write-Note ''
Write-Note ("{0}" -f $versionText)
Write-Note ("更新：{0}" -f $updateNote)
if ($commit -ne '' -and $dirty) {
    Write-Note '注意：仓库里有未提交的改动，本次运行的就是这份改动。'
}
Write-Note ("工作目录：{0}" -f $Target)

if ($DryRun) {
    Write-Note ''
    Write-Note '（演练模式：只显示将要执行的命令，不打开新窗口）'
    Write-Note ("  命令行窗口：cmd /k {0}" -f $env:WWRITING_LAUNCH)
    Write-Note ("  起始目录：{0}" -f $Target)
    exit 0
}

Write-Note '正在打开新的命令行窗口……'

$cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
try {
    Start-Process -FilePath $cmdExe -ArgumentList '/k', '%WWRITING_LAUNCH%' -WorkingDirectory $Target
} catch {
    Stop-WithMessage ("无法打开命令行窗口：{0}" -f $_.Exception.Message)
}

# 本窗口留着两秒让上面的信息可读，然后关闭；工具跑在新窗口里。
Start-Sleep -Seconds 2
exit 0
