# e2e/guest/verify.ps1 —— 单独的 5 判据验收（管理员 PowerShell，可在 bootstrap 之外手动跑）。
#
# 用法（guest 内）：powershell -ExecutionPolicy Bypass -File Z:\verify.ps1 -RunId r1
#
# 判据取自 docs/round16/00-测试协议.md。与 bootstrap.ps1 的区别：本脚本**只验收**，
# 不负责安装/启动；适合在已起好的环境上复跑读数。
param(
  [string]$RunId = 'manual',
  [string]$Share = '\\host.lan\Data',
  [string]$Workspace = 'C:\winstage-ws'
)
$ErrorActionPreference = 'Continue'
$out = Join-Path $Share "verify-$RunId.txt"
function W([string]$m) { "$((Get-Date -Format 'HH:mm:ss')) $m" | Tee-Object -FilePath $out -Append }

W "=== verify $RunId ==="
W "判据3 真实工作区: $Workspace"
$items = Get-ChildItem -Recurse -Force $Workspace -ErrorAction SilentlyContinue |
  Select-Object FullName, Length, @{n='sha256';e={ if (-not $_.PSIsContainer) { (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }}
W "  条目数=$(@($items).Count)"

W "判据4 lane（必须 degraded=false 且 tierEffective=TS）"
$lanes = Get-ChildItem -Recurse -Filter 'sandbox-lane.json' -Path (Join-Path $env:LOCALAPPDATA 'Temp\winstage-stage') -ErrorAction SilentlyContinue
if ($lanes) {
  foreach ($l in $lanes) {
    try { $j = Get-Content $l.FullName -Raw | ConvertFrom-Json; W "  $($l.FullName): degraded=$($j.degraded) tier=$($j.tierEffective) LANE_OK=$([bool]($j.degraded -eq $false -and $j.tierEffective -eq 'TS'))" }
    catch { W "  $($l.FullName): PARSE-ERROR" }
  }
} else { W "  lane: NOT-FOUND" }

W "判据2 暂存面"
$stageRoot = $env:WINSTAGE_STAGE_ROOT
if (-not $stageRoot) { $stageRoot = (Get-ChildItem -Directory (Join-Path $env:LOCALAPPDATA 'Temp\winstage-stage') -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
if ($stageRoot -and (Test-Path $stageRoot)) {
  $staged = Get-ChildItem -Recurse -Force $stageRoot -ErrorAction SilentlyContinue
  W "  stage=$stageRoot 条目=$(@($staged).Count)"
  W "  candidates=$(@(Get-ChildItem -Recurse -Filter 'cs_*.json' -Path $stageRoot -ErrorAction SilentlyContinue).Count)"
} else { W "  stage: NOT-FOUND" }

W "判据1 loader 告警（web 日志末 20 行）"
$webLog = Join-Path $Share "dsh-web-$RunId.log"
if (Test-Path $webLog) { Get-Content $webLog -Tail 20 | ForEach-Object { W "  $_" } } else { W "  web log: NOT-FOUND" }

W "=== done: $out ==="
