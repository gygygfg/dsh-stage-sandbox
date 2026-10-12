# e2e/guest/bootstrap.ps1 —— 旅客机内的一次性引导（管理员 PowerShell）。
#
# 由 dockurr/windows 的 /oem/install.bat 在安装结束、首次进入桌面时调用。
# 职责（按顺序）：
#   1. 等 Samba 共享 \\host.lan\Data 可用；
#   2. 建立真实工作区并取「判据3 前读数」（沙箱外）；
#   3. 静默安装 DSH；把插件包 add 进 profile；
#   4. 起 `dsh web`（供宿主 Playwright 取 DOM/截图），把 URL(含 token) 写回共享；
#   5. 等宿主写完 driver-done.txt；
#   6. 取「判据3 后读数」+ lane + 暂存树清点，落 RESULT_<runId>.json。
#
# 所有输出都写回 \\host.lan\Data，因为旅客机磁盘宿主看不到；这就是本流程里
# 「隔离只由沙箱外进程读数判」的那一侧（旅客机自己的、不在 WinStage 沙箱内的 PowerShell）。
#
# 参数通过环境变量注入（install.bat 从共享里的 run.env 读取后 set）：
#   EBK_RUN_ID, EBK_DOMOUNT, EBK_WORKSPACE, EBK_DSH_PORT, EBK_DIST
#
# 纪律：本脚本**不**在 WinStage 沙箱内运行（它是宿主侧读数通道）。

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$RunId    = if ($env:EBK_RUN_ID) { $env:EBK_RUN_ID } else { 'manual' }
$Share    = if ($env:EBK_SHARE) { $env:EBK_SHARE } else { '\\host.lan\Data' }
$Ws       = if ($env:EBK_WORKSPACE) { $env:EBK_WORKSPACE } else { 'C:\winstage-ws' }
$Port     = if ($env:EBK_DSH_PORT) { $env:EBK_DSH_PORT } else { '3085' }
$Result   = Join-Path $Share "RESULT_$RunId.json"
$Log      = Join-Path $Share "bootstrap-$RunId.log"

function Log([string]$m) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

function SaveJson($obj, [string]$path) {
  # 无 BOM 的 UTF-8：Set-Content -Encoding utf8 在 PS5.1 会写 BOM，宿主 JSON.parse 会炸。
  $json = $obj | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Set-Content -Path $Log -Value "=== bootstrap $RunId $(Get-Date) ===" -Encoding utf8
Log "share=$Share ws=$Ws port=$Port"

# ── 1. 等共享 ────────────────────────────────────────────────────────────────
$tries = 0
while (-not (Test-Path $Share) -and $tries -lt 60) { Start-Sleep -Seconds 5; $tries++ }
if (-not (Test-Path $Share)) { Log "FATAL share not reachable"; exit 1 }
Log "share ready after ${tries}x5s"

# ── 2. 真实工作区 + 前读数 ───────────────────────────────────────────────────
New-Item -ItemType Directory -Force $Ws | Out-Null
Set-Content -Path (Join-Path $Ws 'seed.txt') -Value 'SEED' -Encoding utf8
$before = Get-ChildItem -Recurse -Force $Ws -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, @{n='sha256';e={ if (-not $_.PSIsContainer) { (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }}
SaveJson @{ items = @($before) } (Join-Path $Share "ws-before-$RunId.json")
Log "workspace before: $(@($before).Count) entries"

# ── 3. 装 DSH ───────────────────────────────────────────────────────────────
$installer = Join-Path $Share 'dsh-latest-windows-x64.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
if (-not (Test-Path $installDir)) {
  if (Test-Path $installer) {
    Log "installing DSH (silent) ..."
    Start-Process -FilePath $installer -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 8
  } else {
    Log "WARN installer not found: $installer"
  }
} else {
  Log "DSH already installed at $installDir"
}

$dshCmd = Join-Path $installDir 'resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $dshCmd)) {
  $found = Get-ChildItem -Recurse -Filter 'dsh.cmd' -Path $installDir -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $dshCmd = $found.FullName }
}
Log "dshCmd=$dshCmd exists=$(Test-Path $dshCmd)"
Set-Content -Path (Join-Path $Share "dsh-cmd-path-$RunId.txt") -Value $dshCmd -Encoding utf8

# ── 4. add 插件（幂等） ─────────────────────────────────────────────────────
$pkg = Join-Path $Share 'dsh-winstage-sandbox.tgz'
if ((Test-Path $dshCmd) -and (Test-Path $pkg)) {
  $local = 'C:\winstage-sandbox.tgz'
  Copy-Item -Force $pkg $local
  Log "dsh plugin add (web profile) ..."
  & $dshCmd plugin --profile web add $local 2>&1 | Tee-Object -FilePath (Join-Path $Share "plugin-add-$RunId.log") -Append
  Log "plugin add exit=$LASTEXITCODE"
} else {
  Log "WARN skip plugin add (dshCmd or pkg missing)"
}

# ── 5. 起 dsh web（供宿主取 DOM） ───────────────────────────────────────────
# 关掉继承身份；钉独立暂存根，避免与其它 WinStage 宿主争用 dsh-host 守卫。
$env:WINSTAGE_SHELL = '1'
$env:DSH_SESSION_ID = ''
$env:WINSTAGE_STAGE_ROOT = Join-Path $env:LOCALAPPDATA ("Temp\winstage-stage\ebk-" + $RunId)
Set-Content -Path (Join-Path $Share "stage-root-path-$RunId.txt") -Value $env:WINSTAGE_STAGE_ROOT -Encoding utf8
New-Item -ItemType Directory -Force $env:WINSTAGE_STAGE_ROOT | Out-Null

$webLog = Join-Path $Share "dsh-web-$RunId.log"
$webUrlFile = Join-Path $Share "dsh-web-url-$RunId.txt"
Remove-Item -Force $webUrlFile -ErrorAction SilentlyContinue
if (Test-Path $dshCmd) {
  Log "starting dsh web --port $Port ..."
  # 用生成的 .cmd 承载重定向，绕开 PowerShell Start-Process 的嵌套引号地狱。
  # cmd 支持把 stdout 重定向到 UNC 路径（只有"UNC 作为当前目录"才被禁）。
  $webCmd = Join-Path $Share "dshweb-$RunId.cmd"
  Set-Content -Path $webCmd -Encoding ascii -Value @(
    '@echo off',
    "`"$dshCmd`" --profile web web --port $Port --no-open > `"$webLog`" 2>&1"
  )
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$webCmd`"" -WindowStyle Hidden
  # 等 URL 出现
  $deadline = (Get-Date).AddSeconds(180)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $webLog) {
      $m = Select-String -Path $webLog -Pattern 'http://127\.0\.0\.1:[0-9]+/\?token=([A-Za-z0-9]+)' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { Set-Content -Path $webUrlFile -Value $m.Line -Encoding utf8; Log "web url: $($m.Line)"; break }
    }
    Start-Sleep -Seconds 3
  }
  if (-not (Test-Path $webUrlFile)) { Log "WARN web url not detected within 180s" }
} else {
  Log "FATAL dshCmd missing; cannot start web"
}

# ── 6. 等宿主驱动完成 ────────────────────────────────────────────────────────
$doneMarker = Join-Path $Share "driver-done-$RunId.txt"
$w = 0
while (-not (Test-Path $doneMarker) -and $w -lt 240) { Start-Sleep -Seconds 5; $w++ }
Log "driver done after ${w}x5s (present=$(Test-Path $doneMarker))"

# ── 7. 后读数 + lane + 暂存树 + RESULT ──────────────────────────────────────
$after = Get-ChildItem -Recurse -Force $Ws -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, @{n='sha256';e={ if (-not $_.PSIsContainer) { (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }}
SaveJson @{ items = @($after) } (Join-Path $Share "ws-after-$RunId.json")

$lane = $null
$lanePath = $null
$laneFiles = Get-ChildItem -Recurse -Filter 'sandbox-lane.json' -Path (Join-Path $env:LOCALAPPDATA 'Temp\winstage-stage') -ErrorAction SilentlyContinue
if ($laneFiles) { $lanePath = $laneFiles[0].FullName; try { $lane = Get-Content $lanePath -Raw | ConvertFrom-Json } catch {} }
SaveJson $lane (Join-Path $Share "lane-$RunId.json")

$stageInv = @()
if (Test-Path $env:WINSTAGE_STAGE_ROOT) {
  $stageInv = Get-ChildItem -Recurse -Force $env:WINSTAGE_STAGE_ROOT -ErrorAction SilentlyContinue | Select-Object FullName, Length
}
SaveJson @{ items = @($stageInv) } (Join-Path $Share "stage-root-inventory-$RunId.json")

$added = @($after | Where-Object { $_.FullName -notin $before.FullName })
$result = [ordered]@{
  runId          = $RunId
  ws             = $Ws
  ws_before      = @($before).Count
  ws_after       = @($after).Count
  ws_new_paths   = @($added | ForEach-Object { $_.FullName })
  ws_polluted    = ($added.Count -gt 0)                 # 判据3：真实工作区零污染
  lane_degraded  = ($lane -and $lane.degraded)
  lane_tier      = ($lane -and $lane.tierEffective)
  lane_ok        = [bool]($lane -and ($lane.degraded -eq $false) -and ($lane.tierEffective -eq 'TS'))
  lane_path      = $lanePath
  stage_root     = $env:WINSTAGE_STAGE_ROOT
  stage_entries  = @($stageInv).Count
  dsh_web_url    = if (Test-Path $webUrlFile) { (Get-Content $webUrlFile -Raw).Trim() } else { $null }
  verdict        = 'recorded'
}
SaveJson $result $Result
Log "RESULT written: $Result"
Log "ws_new_paths=$($result.ws_new_paths -join ',')"
Log "lane_ok=$($result.lane_ok) tier=$($result.lane_tier) degraded=$($result.lane_degraded)"
