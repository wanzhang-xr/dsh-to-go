# dsh-to-go —— 便携包构建（引导阶段）
#
# 这一步负责「无依赖启动」：目标机器上什么都没有也能跑。
#   1. 下载官方便携 Node（win-x64 zip），并校验 SHA-256
#   2. 解压到 runtime\node
#   3. 把剩下的活交给 tools\install.js（装 dsh 双槽、建目录、写记录）
#
# 参数（cmd 里用 -Name value 形式）：
#   -NodeVersion <vX.Y.Z>   便携 Node 版本（默认 v26.7.0）
#   -VersionA <版本|标签>    活动槽 dsh（默认 0.2.1-alpha.2）
#   -VersionB <版本|标签>    备用槽 dsh（默认 0.2.0-rc.2）
#   -Single                  只装一个槽
#   -Port <端口>             网页端口（默认 3180）
#   -Registry <url>          只用一个 npm 源
#   -Target <目录>           构建到别的目录（默认本仓库）
#   -SkipChecksum            跳过 Node 校验和（不建议）
#   -Cli                     不用图形向导，直接在命令行把两个槽装好（CI/离线批量用）
#   -NoOpen                  只启图形服务、不自动打开浏览器（自动化用）
#
# 需要：Windows 10/11 + 自带 PowerShell 5.1 起（无需预装 Node）

param(
  [string]$NodeVersion = 'v26.7.0',
  [string]$VersionA = '0.2.1-alpha.2',
  [string]$VersionB = '0.2.0-rc.2',
  [switch]$Single,
  [int]$Port = 3180,
  [string]$Registry = '',
  [string]$Target = '',
  [switch]$SkipChecksum,
  [switch]$Cli,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

function Say([string]$m) { Write-Host ('  ' + $m) }
function Fail([string]$m) { Write-Host ''; Write-Host ('  [失败] ' + $m); exit 1 }

if (-not $Target) { $Target = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Target = [IO.Path]::GetFullPath($Target)
$Runtime = Join-Path $Target 'runtime'
$NodeDir = Join-Path $Runtime 'node'

Write-Host ''
Write-Host '  ── dsh-to-go 构建 ──'
Say ("目标目录：$Target")
Say ("便携 Node：$NodeVersion")

# ---- 1. Node 是否已在位 ----
$NodeExe = Join-Path $NodeDir 'node.exe'
if (Test-Path $NodeExe) {
  Say ('已有便携 Node：' + (& $NodeExe -v))
} else {
  # 老系统的 PowerShell 5.1 默认可能只启用 TLS 1.0，先放开
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
  } catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  }

  $zipName = "node-$NodeVersion-win-x64.zip"
  $bases = @("https://nodejs.org/dist/$NodeVersion", "https://npmmirror.com/mirrors/node/$NodeVersion")
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $zip = Join-Path $Runtime $zipName
  $downloaded = $false
  foreach ($b in $bases) {
    try {
      Say ("下载 Node：$b/$zipName")
      (New-Object Net.WebClient).DownloadFile("$b/$zipName", $zip)
      $downloaded = $true
      break
    } catch {
      Say ('该源失败：' + $_.Exception.Message)
    }
  }
  if (-not $downloaded) { Fail '所有源都下载失败。可手动下载 Node 的 win-x64 zip，解压成 runtime\node 后重跑。' }
  $size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
  Say ("下载完成：$size MB")

  # ---- 2. 校验 SHA-256 ----
  if (-not $SkipChecksum) {
    $ok = $false
    foreach ($b in $bases) {
      try {
        $sums = (New-Object Net.WebClient).DownloadString("$b/SHASUMS256.txt")
        $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) + '$' } | Select-Object -First 1)
        if ($line) {
          $want = ($line -split '\s+')[0].ToUpper()
          $got = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToUpper()
          if ($want -eq $got) { Say 'SHA-256 校验通过'; $ok = $true } else { Fail "SHA-256 不匹配（期望 $want，实际 $got）——包可能被替换，已中止。" }
          break
        }
      } catch { }
    }
    if (-not $ok) { Say '⚠ 拿不到官方校验清单，本次跳过校验（可加 -SkipChecksum 消除此提示）' }
  }

  # ---- 3. 解压 ----
  Say '解压中…'
  $tmp = Join-Path $Runtime ('unzip-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $inner) { Fail '解压结果异常：找不到 Node 目录。' }
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item -Path $inner.FullName -Destination $NodeDir
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $NodeExe)) { Fail '解压后仍找不到 node.exe。' }
  Say ('便携 Node 就绪：' + (& $NodeExe -v))
}

# ---- 3.6 启动器：用系统自带 csc.exe 编译 dsh-to-go.exe（失败不影响其它入口）----
$launcherCmd = Join-Path $Target 'tools\launcher\build-launcher.cmd'
if (Test-Path $launcherCmd) {
  Write-Host ''
  Write-Host '  [launcher] building native window entry (dsh-to-go.exe)...'
  & cmd /c "`"$launcherCmd`""
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  [launcher] build failed - dsh-ui.cmd (browser entry) still works.'
  }
}

# ---- 4. 默认交给图形向导；-Cli 才走命令行整套安装 ----
if ($Cli) {
  $install = Join-Path $Target 'tools\install.js'
  if (-not (Test-Path $install)) { Fail "找不到构建脚本：$install" }
  $argv = @($install, '--a', $VersionA, '--port', "$Port")
  if ($Single) { $argv += '--single' } else { $argv += @('--b', $VersionB) }
  if ($Registry) { $argv += @('--registry', $Registry) }

  Say '开始安装 dsh…'
  & $NodeExe @argv
  $rc = $LASTEXITCODE
  if ($rc -ne 0) { Fail "install.js 返回 $rc，构建未完成。" }

  Write-Host ''
  Write-Host '  构建完成。'
  return
}

# 构建器只负责把运行环境准备好（Node）；版本安装、站点与密钥都在网页向导里做，
# 这样用户第一次打开就是完整流程，不需要再去记命令行参数。
$ui = Join-Path $Target 'tools\ui-server.js'
if (-not (Test-Path $ui)) { Fail "找不到图形服务：$ui" }

Say '便携 Node 已就绪，下面打开图形向导（版本安装也在页面里完成）。'
$args2 = @("`"$ui`"")
if ($NoOpen) { $args2 += '--no-open' }
if ($Port -ne 3180) { $args2 += @('--port', "$Port") }
Start-Process -FilePath $NodeExe -ArgumentList $args2 -WorkingDirectory $Target
Start-Sleep -Seconds 3

Write-Host ''
Write-Host '  图形向导已经启动（浏览器里是 127.0.0.1 的本地页面）。'
Write-Host '  流程：设置口令 → 添加站点与密钥 → 选版本安装 → 启动 dsh。'
Write-Host '  也可以随时用 dsh-ui.cmd 重新打开这个页面；命令行维护台是 tools\rescue\dsh-config.cmd。'
Write-Host ''
