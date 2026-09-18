<#
  每日答题任务包装脚本（供 Windows 任务计划程序调用）

  职责：
    1) 把当天运行输出写入 logs\daily-quiz-yyyy-MM-dd.log（按天分文件，当天的多次运行追加到同一文件）
    2) 每次运行写入开始/结束标记、退出码与耗时
    3) 自动清理超过 -KeepDays 天的历史日志（默认 30 天）
    4) 把 node 的退出码原样返回给任务计划程序（便于"失败重启"生效）

  用法（任务计划程序的"操作"里）：
    程序或脚本 : powershell.exe
    添加参数   : -NoProfile -ExecutionPolicy Bypass -File "D:\testCode\demo\daily-quiz\run-daily.ps1"
    起始于     : D:\testCode\demo\daily-quiz

  也可以手动跑：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\run-daily.ps1
    指定 node 绝对路径（任务环境里 PATH 找不到 node 时用）：
    .\run-daily.ps1 -NodeExe "D:\MySoft\mise\mise-data\installs\node\24.19.0\node.exe"
#>
[CmdletBinding()]
param(
  # 工作目录，默认脚本所在目录
  [string]$WorkDir = $PSScriptRoot,
  # node 可执行文件路径；留空则自动从 PATH 探测
  [string]$NodeExe = '',
  # 历史日志保留天数
  [int]$KeepDays = 30
)

$ErrorActionPreference = 'Continue'

# 让 PowerShell 按 UTF-8 解码子进程输出，避免中文变乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $WorkDir) { $WorkDir = (Get-Location).Path }
$logDir = Join-Path $WorkDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ('daily-quiz-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Head([string]$Text) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $logFile -Value ("[{0}] {1}" -f $stamp, $Text) -Encoding UTF8
}

if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
}

Write-Head '==================== 运行开始 ===================='
Write-Head ("日志文件 : {0}" -f $logFile)
Write-Head ("工作目录 : {0}" -f $WorkDir)
Write-Head ("node     : {0}" -f $NodeExe)

if (-not $NodeExe) {
  Write-Head '找不到 node：请在任务参数里追加 -NodeExe "<node 绝对路径>"'
  exit 2
}

Set-Location $WorkDir
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$output = & $NodeExe --import tsx src\fetch-exam-data.ts 2>&1
$code = $LASTEXITCODE
$stopwatch.Stop()

if ($output) {
  # 同时写日志文件与当前控制台（Add-Content 与头部写入方式保持一致）
  $output | Add-Content -Path $logFile -Encoding UTF8
  $output | Out-Host
}

Write-Head ("==================== 运行结束：退出码 {0}，耗时 {1:N1}s ====================" -f $code, $stopwatch.Elapsed.TotalSeconds)

# 清理过期日志
try {
  Get-ChildItem -Path $logDir -Filter 'daily-quiz-*.log' -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

exit $code
