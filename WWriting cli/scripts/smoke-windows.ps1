# WWriting Windows 冒烟脚本（首发平台的验收证据）
#
# 做五件事，全部在临时目录里、绝不接真实网络：
#   1. 参数帮助：wwriting --help 不启动 Agent、不落任何数据；
#   2. 非 TTY 错误：没有可交互终端时给出一条中文事实 + 非零退出码；
#   3. 锁竞争：另一个写入者占着会话时，第二个写入者只能拿到一条等待提示；
#   4. 跨进程重启：起两个真实 node 进程，进程 A 真写入 → 真退出 → 进程 B 读回历史，
#      并确认进程 A 退出后写锁真的释放（同进程内第二次调用覆盖不到这条路径）；
#   5. 测试模式主路径：跑 tests/acceptance/main-path.test.mjs（临时 APPDATA + 临时工作区 +
#      本地假 DeepSeek HTTP 服务），覆盖打开目录 → 确认写入 → 落盘 → 双进程重启 -c 读历史。
#
# 结束后检查数据边界：创作目录只出现被确认写入的文件，事件/配置/锁只出现在临时 APPDATA。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts/smoke-windows.ps1 [-KeepArtifacts]
#Requires -Version 5.1
[CmdletBinding()]
param(
  # 保留临时目录（默认跑完就删），便于人工查看产物。
  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

# 让 PowerShell 用 UTF-8 解码子进程（node）的 stdout/stderr，并把发往子进程的管道也设成 UTF-8。
# 否则在中文 Windows 的 GB2312（CP936）控制台下，node 写出的 UTF-8 中文会被按 ANSI 解读成乱码，
# 于是所有「输出里有中文」的断言都会失败。脚本自身是 UTF-8 with BOM，字面量不受影响。
$originalConsoleEncoding = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$originalOutputEncoding = $OutputEncoding
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repoRoot 'src\cli.mjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source

$root = Join-Path $env:TEMP ('wwriting-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
# 主路径用（验收测试复用这两个目录，脚本最后检查它们）：必须保持干净，只由验收测试写入。
$appData = Join-Path $root 'appdata'
$novel = Join-Path $root 'novel'
# 参数帮助 / 非 TTY / 锁竞争用的独立草稿目录：它们会真的开始会话，不能污染上面那对。
$scratchApp = Join-Path $root 'scratch-appdata'
$scratchNovel = Join-Path $root 'scratch-novel'
New-Item -ItemType Directory -Force -Path $appData, $novel, $scratchApp, $scratchNovel | Out-Null

$originalAppData = $env:APPDATA
$originalNoColor = $env:NO_COLOR
$originalSmokeRoot = $env:WWRITING_SMOKE_ROOT

# 应用私有数据全部改道到临时 APPDATA；关掉颜色，断言只关心文案。
$env:APPDATA = $appData
$env:NO_COLOR = '1'

function Step([string]$name) { Write-Host "`n== $name" -ForegroundColor Cyan }
function Pass([string]$message) { Write-Host "   ok   $message" -ForegroundColor Green }
function Fail([string]$message) { Write-Host "   FAIL $message" -ForegroundColor Red; throw $message }
function AssertThat($condition, [string]$message) {
  if (-not $condition) { Fail $message }
  Pass $message
}

# 创作目录 / 私有目录里的文件清单（相对路径，正斜杠），用于数据边界断言。
# 前置逗号阻止 PowerShell 把「单元素数组」拆成标量字符串（否则 $files[0] 会变成首字符）。
function ListFiles([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return ,@() }
  $prefix = $path.TrimEnd('\') + '\'
  return ,@(Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($prefix.Length).Replace('\', '/') })
}

# 直接用 .NET 起子进程，绕开 Windows PowerShell 5.1 的两个坑：
#   1) $ErrorActionPreference='Stop' 时，子进程往 stderr 写中文会被当成终止错误抛出，
#      而且 `2>$file` 重定向此时拿不到内容（错误记录先于重定向被消费）；
#   2) 本仓库路径含空格（d:\WWriting cli），经 & 或 Start-Process 传参会被拆成两个参数。
# 做法：每个参数手工加引号，stdout/stderr 用 UTF-8 原样读回，不做任何装饰。
function Quote-Arg([string]$value) {
  if ($value -match '^[A-Za-z0-9_\-\\.:/=]+$') { return $value }
  # 双引号包裹；闭合引号前的连续反斜杠需要翻倍（我们的参数里没有，仅为正确性保留）。
  return '"' + ($value -replace '(\\+)$', '$1$1') + '"'
}

function Start-NodeProcess([string[]]$nodeArguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodePath
  $psi.WorkingDirectory = $repoRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = (New-Object System.Text.UTF8Encoding($false))
  $psi.StandardErrorEncoding = (New-Object System.Text.UTF8Encoding($false))
  $psi.Arguments = (@($nodeArguments | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  return $proc
}

# 跑一次 node src/cli.mjs：stdin 走管道（非 TTY），stdout/stderr 分开按 UTF-8 收集。
function RunCli([string[]]$cliArguments, [string]$stdinText) {
  $proc = Start-NodeProcess (@($cliPath) + $cliArguments)
  if ($stdinText) { $proc.StandardInput.Write($stdinText) }
  $proc.StandardInput.Close()
  # stderr 异步读，避免两个管道同时写满时互相阻塞。
  $errTask = $proc.StandardError.ReadToEndAsync()
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $errTask.Result
  $proc.WaitForExit()
  $code = $proc.ExitCode
  $proc.Dispose()
  return [pscustomobject]@{ Code = $code; Out = [string]$out; Err = [string]$err }
}

# 持锁进程：用真实模块打开工作区最近会话并一直占着写锁，直到被外部结束。
$lockHolderSource = @'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [repoRoot, appDataRoot, workspace, readyPath] = process.argv.slice(2);
const { createWorkspaceStore } = await import(pathToFileURL(repoRoot + '/src/storage/workspace-store.mjs').href);
const { createSessionManager } = await import(pathToFileURL(repoRoot + '/src/session/session-manager.mjs').href);

const workspaceStore = createWorkspaceStore({ appDataRoot });
const manager = createSessionManager({ workspaceStore });
const handle = await manager.openLatest(workspace);
writeFileSync(readyPath, handle.sessionId, 'utf8');
setInterval(() => {}, 1 << 30);
'@

$exitCode = 0
try {
  Push-Location $repoRoot

  Step '参数帮助：wwriting --help'
  $help = RunCli @('--help') ''
  AssertThat ($help.Code -eq 0) "退出码为 0（实际 $($help.Code)）"
  AssertThat ($help.Out -match '启动形式') '输出里有「启动形式」'
  foreach ($flag in @('--cwd', '--resume', '--continue')) {
    AssertThat ($help.Out.Contains($flag)) "输出里列出 $flag"
  }
  # -c 不吃值，所以不进上面那个「需要一个值」的循环；但它与一条消息互斥（P23）：
  # 「给消息」= 开全新会话，「接着上次」= 显式 -c，两者同时给是用法错误（退出码 2）。
  $conflict = RunCli @('--cwd', $scratchNovel, '-c', '写第一章') ''
  AssertThat ($conflict.Code -eq 2) "同时给出 -c 和消息以退出码 2 失败（实际 $($conflict.Code)）"
  AssertThat ($conflict.Err -match '[\u4e00-\u9fff]') '互斥错误是一条中文事实'
  AssertThat ((ListFiles $scratchNovel).Count -eq 0) '用法错误不往创作目录写东西'
  AssertThat ([string]::IsNullOrEmpty($help.Err)) 'stderr 干净'
  AssertThat ($help.Out -match 'WWriting \d+\.\d+\.\d+') '输出第一行带版本号'
  AssertThat ((ListFiles $novel).Count -eq 0) '帮助不往创作目录写东西'
  AssertThat ((ListFiles (Join-Path $appData 'WWriting')).Count -eq 0) '帮助不往应用私有目录写东西'

  Step '版本号：wwriting --version'
  $version = RunCli @('--version') ''
  AssertThat ($version.Code -eq 0) "退出码为 0（实际 $($version.Code)）"
  AssertThat ($version.Out -match '^WWriting \d+\.\d+\.\d+') '输出是「名称 版本」一行'
  AssertThat ([string]::IsNullOrEmpty($version.Err)) 'stderr 干净'
  AssertThat ((ListFiles $novel).Count -eq 0) '版本不往创作目录写东西'
  AssertThat ((ListFiles (Join-Path $appData 'WWriting')).Count -eq 0) '版本不往应用私有目录写东西'

  Step '非 TTY 错误：没有可交互终端'
  # 用草稿目录：这一步会真的开始一个会话并落事件，不能弄脏验收测试要检查的主路径目录。
  $env:APPDATA = $scratchApp
  $nonTty = RunCli @('--cwd', $scratchNovel) ''
  AssertThat ($nonTty.Code -ne 0) "返回非零退出码（实际 $($nonTty.Code)）"
  AssertThat ($nonTty.Code -ne 2) '不是参数错误（2 只留给用法错误）'
  AssertThat ([string]::IsNullOrEmpty($nonTty.Out.Trim())) 'stdout 保持干净'
  AssertThat ($nonTty.Err -match '[\u4e00-\u9fff]') 'stderr 给出一条中文事实'
  AssertThat ($nonTty.Err -notmatch '(?m)^\s+at ') 'stderr 不含堆栈'
  AssertThat ($nonTty.Err -match '终端') '说清是需要可交互的终端'
  AssertThat ((ListFiles $scratchNovel).Count -eq 0) '非交互错误不往创作目录写东西'

  $scratchPrivateFiles = ListFiles (Join-Path $scratchApp 'WWriting')
  AssertThat (($scratchPrivateFiles -join ' ') -match 'sessions/.+/events\.jsonl') '会话事件只出现在临时 APPDATA'

  Step '锁竞争：同一会话的第二个写入者'
  $holderPath = Join-Path $root 'hold-lock.mjs'
  $readyPath = Join-Path $root 'lock-ready.txt'
  Set-Content -LiteralPath $holderPath -Value $lockHolderSource -Encoding UTF8
  $holder = Start-NodeProcess @($holderPath, $repoRoot, $scratchApp, $scratchNovel, $readyPath)
  $holder.StandardInput.Close()
  try {
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path -LiteralPath $readyPath)) {
      if ((Get-Date) -gt $deadline) { Fail '持锁进程没能在 15 秒内就绪' }
      Start-Sleep -Milliseconds 100
    }
    $heldSession = (Get-Content -LiteralPath $readyPath -Raw).Trim()
    Pass "另一个写入者已持有会话 $heldSession 的写锁"

    # 用 -c 才会去开那个已被占用的最近会话；裸启动现在开的是全新会话，锁根本不冲突（P23）。
    $busy = RunCli @('--cwd', $scratchNovel, '-c') ''
    AssertThat ($busy.Code -ne 0) "第二个写入者拿到非零退出码（实际 $($busy.Code)）"
    AssertThat ($busy.Err -match '[\u4e00-\u9fff]') '提示是一条中文事实'
    AssertThat ($busy.Err -match '会话') '提示说清是会话被占用'
    AssertThat ($busy.Err -notmatch '(?m)^\s+at ') '提示不含堆栈'
    AssertThat ((ListFiles $scratchNovel).Count -eq 0) '等待期间不往创作目录写东西'
  } finally {
    if ($null -ne $holder) {
      Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
      $holder.WaitForExit(5000) | Out-Null
      $holder.Dispose()
    }
  }

  Step '跨进程重启：进程 A 真写入 → 真退出 → 进程 B 读回历史'
  # 用驱动脚本起**两个真实 node 进程**各跑一次真实会话读写（openLatest 就是 --continue 的选会话语义）。
  # 覆盖同进程内第二次调用覆盖不到的东西：跨进程会话锁、退出清理、日志落盘后由另一个进程读回。
  # 这一步不需要模型服务，所以用 driver 的 session 模式（验收测试里另有跑真实 main() 的双进程用例）。
  $restartApp = Join-Path $root 'restart-appdata'
  $restartNovel = Join-Path $root 'restart-novel'
  New-Item -ItemType Directory -Force -Path $restartApp, $restartNovel | Out-Null
  $env:APPDATA = $restartApp
  $driverPath = Join-Path $repoRoot 'tests\acceptance\helpers\run-cli-once.mjs'
  $specA = Join-Path $root 'restart-a.json'
  $specB = Join-Path $root 'restart-b.json'
  # PS 5.1 的 Set-Content -Encoding UTF8 会带 BOM，JSON.parse 前得剥掉；直接写无 BOM 的 UTF-8 最省事。
  $noBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($specA, (@{ mode = 'session'; appDataRoot = $restartApp; cwd = $restartNovel; write = '写第一章' } | ConvertTo-Json -Compress), $noBom)
  [System.IO.File]::WriteAllText($specB, (@{ mode = 'session'; appDataRoot = $restartApp; cwd = $restartNovel } | ConvertTo-Json -Compress), $noBom)

  $procA = Start-NodeProcess @($driverPath, $specA)
  $procA.StandardInput.Close()
  $errATask = $procA.StandardError.ReadToEndAsync()
  $outA = $procA.StandardOutput.ReadToEnd()
  $errA = $errATask.Result
  $procA.WaitForExit()
  $codeA = $procA.ExitCode
  $procA.Dispose()
  AssertThat ($codeA -eq 0) "进程 A 退出码为 0（实际 $codeA；stderr=$errA）"
  $resultA = (($outA.Trim() -split "`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1) | ConvertFrom-Json)
  AssertThat (-not [string]::IsNullOrEmpty($resultA.sessionId)) '进程 A 报告了它写入的会话 ID'
  AssertThat (($resultA.inputs -join ',') -eq '写第一章') '进程 A 的输入已经落进事件日志'

  # 进程 A 已经退出：写锁必须真的释放，私有目录里不该再留下任何锁标记（顺带验证退出清理路径）。
  AssertThat (-not (((ListFiles $restartApp) -join ' ') -match 'locks/.+')) '进程 A 退出后没有残留会话锁'

  $procB = Start-NodeProcess @($driverPath, $specB)
  $procB.StandardInput.Close()
  $errBTask = $procB.StandardError.ReadToEndAsync()
  $outB = $procB.StandardOutput.ReadToEnd()
  $errB = $errBTask.Result
  $procB.WaitForExit()
  $codeB = $procB.ExitCode
  $procB.Dispose()
  AssertThat ($codeB -eq 0) "进程 B 退出码为 0（实际 $codeB；stderr=$errB）"
  $resultB = (($outB.Trim() -split "`n" | Where-Object { $_ -ne '' } | Select-Object -Last 1) | ConvertFrom-Json)
  AssertThat ($resultB.sessionId -eq $resultA.sessionId) '进程 B 读回的是同一个会话'
  AssertThat (($resultB.inputs -join ',') -eq '写第一章') '进程 B 读回了进程 A 写入的历史'
  AssertThat ($resultB.pid -ne $resultA.pid) '确实跨了两个真实进程'

  Step '测试模式主路径：验收测试（临时 APPDATA + 本地假 DeepSeek 服务）'
  # 验收测试通过 WWRITING_SMOKE_ROOT 复用主路径目录（$appData / $novel），它自己会写 APPDATA。
  $env:APPDATA = $appData
  $env:WWRITING_SMOKE_ROOT = $root
  $testProc = Start-NodeProcess @('--test', '--test-reporter=spec', (Join-Path $repoRoot 'tests\acceptance\main-path.test.mjs'))
  $testProc.StandardInput.Close()
  $testErrTask = $testProc.StandardError.ReadToEndAsync()
  $testOut = $testProc.StandardOutput.ReadToEnd()
  $testErr = $testErrTask.Result
  $testProc.WaitForExit()
  $testCode = $testProc.ExitCode
  $testProc.Dispose()
  Remove-Item Env:\WWRITING_SMOKE_ROOT -ErrorAction SilentlyContinue
  $testText = ($testOut + "`n" + $testErr)
  AssertThat ($testCode -eq 0) "验收测试退出码为 0（实际 $testCode）"
  AssertThat (-not ($testText -match '✖')) '验收测试没有失败用例'
  AssertThat ($testText -match '主路径') '主路径用例真的跑过'
  AssertThat ($testText -match '重启后 -c：跨真实进程读回同一个会话与历史') '双进程重启用例真的跑过'
  AssertThat ($testText -match '重启后 -c：上一轮对话被重演到屏幕上') '屏幕重演用例真的跑过'
  AssertThat ($testText -match '裸启动是全新会话') '裸启动语义用例真的跑过'
  AssertThat ($testText -match '会话被另一个进程占用') '锁竞争用例真的跑过'
  # 会话连续性：同一会话跨进程之后，模型确实拿到了前面的对话。
  # 这条要防的是「用例被静默跳过」——只在断言名字出现时才算数。
  AssertThat ($testText -match '跨进程恢复：第二条请求确实带上了第一条的内容') '历史回放用例真的跑过'
  AssertThat ($testText -match '历史超预算时屏幕上说明省略了多少轮') '历史截断可见性用例真的跑过'

  Step '数据边界：创作目录 vs 应用私有目录'
  $novelFiles = ListFiles $novel
  AssertThat ($novelFiles.Count -eq 1) "创作目录只有一个文件（实际：$($novelFiles -join ', ')）"
  AssertThat ($novelFiles[0] -eq '第一章.md') '创作目录里是模型按确认写入的 第一章.md'
  AssertThat (-not (Test-Path -LiteralPath (Join-Path $novel 'WWRITING.md'))) '没有私自生成 WWRITING.md'

  $privateRoot = Join-Path $appData 'WWriting'
  AssertThat (Test-Path -LiteralPath (Join-Path $privateRoot 'config.json')) '配置文件在临时 APPDATA'
  $privateFiles = ListFiles $privateRoot
  AssertThat (($privateFiles -join ' ') -match 'sessions/.+/events\.jsonl') '事件日志只在临时 APPDATA'
  AssertThat (($privateFiles -join ' ') -match 'sessions/.+/state\.json') '投影缓存只在临时 APPDATA'
  # 会话锁目录按工作区建在私有目录下；锁文件用完即删，所以检查目录而不是文件。
  $lockDir = Get-ChildItem -LiteralPath (Join-Path $privateRoot 'workspaces') -Recurse -Force -Directory -Filter 'locks' -ErrorAction SilentlyContinue | Select-Object -First 1
  AssertThat ($null -ne $lockDir) '会话锁目录只在临时 APPDATA'
  AssertThat (-not (($novelFiles -join ' ') -match 'events\.jsonl|state\.json|config\.json')) '创作目录里没有任何私有数据'

  Write-Host "`n全部通过。" -ForegroundColor Green
} catch {
  $exitCode = 1
  Write-Host "`n冒烟失败：$($_.Exception.Message)" -ForegroundColor Red
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  if ($null -ne $originalAppData) { $env:APPDATA = $originalAppData } else { Remove-Item Env:\APPDATA -ErrorAction SilentlyContinue }
  if ($null -ne $originalNoColor) { $env:NO_COLOR = $originalNoColor } else { Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue }
  if ($null -ne $originalSmokeRoot) { $env:WWRITING_SMOKE_ROOT = $originalSmokeRoot } else { Remove-Item Env:\WWRITING_SMOKE_ROOT -ErrorAction SilentlyContinue }
  try { [Console]::OutputEncoding = $originalConsoleEncoding } catch { }
  $OutputEncoding = $originalOutputEncoding
  if ($KeepArtifacts) {
    Write-Host "临时目录（保留）：$root" -ForegroundColor Yellow
  } else {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

exit $exitCode

