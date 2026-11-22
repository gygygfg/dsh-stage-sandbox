# dshnt M0 follow-up probe (runs after the perf run, VM rebooted).
#
# 1. Why did the guest shut down?  Look for bugchecks and FilterManager events.
# 2. Is the per-file metadata cost (view\flat5000 FileInfo = 16.7 s in the
#    perf run) repeatable, or was it one-time placeholder population?
#    - same view dir, provider restarted
#    - brand-new ProjFS instance over the same lower
#
# ASCII only. Writes probe2.json + probe2.log to \\host.lan\Data.

$ErrorActionPreference = 'Continue'
$Share = '\\host.lan\Data'
if (-not (Test-Path $Share)) { $Share = 'Z:' }
$Log = Join-Path $Share 'probe2.log'
$Json = Join-Path $Share 'probe2.json'

function L([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}
Set-Content -Path $Log -Value "=== dshnt probe2 $(Get-Date) ===" -Encoding utf8

$rows = New-Object System.Collections.ArrayList
function Stat([string]$path, [string]$label) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $files = [IO.Directory]::GetFiles($path)
  $sum = 0L
  foreach ($f in $files) { $fi = New-Object IO.FileInfo($f); $sum += $fi.Length }
  $sw.Stop()
  $ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  $null = $rows.Add([pscustomobject]@{ label = $label; ms = $ms; files = $files.Length })
  L ("{0,-24} {1,10:N1} ms  ({2} files)" -f $label, $ms, $files.Length)
}
function Stop-Provider {
  Get-Process SimpleProviderManaged -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
}
function Start-Provider([string]$virt, [int]$waitSec) {
  Start-Process -FilePath 'C:\m0\projfs-provider\SimpleProviderManaged.exe' `
    -ArgumentList '--SourceRoot=C:\m0\lower', "--VirtRoot=$virt" `
    -RedirectStandardOutput "C:\m0\prov-$(Split-Path $virt -Leaf).log" `
    -RedirectStandardError "C:\m0\prov-$(Split-Path $virt -Leaf).err" -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds($waitSec)
  while ((Get-Date) -lt $deadline) {
    try { if ([IO.Directory]::GetFiles("$virt\warm").Length -ge 1) { return } } catch { }
    Start-Sleep -Milliseconds 500
  }
  L "WARN provider not serving $virt"
}

$events = @()
try {
  L "os=$((Get-CimInstance Win32_OperatingSystem).Caption) projfs=$((Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS).State)"
  $bcd = (bcdedit /enum '{current}' 2>&1) -join "`n"
  L "testsigning=$($bcd -match 'testsigning\s+Yes')"

  # --- 1. shutdown forensics ------------------------------------------------
  $bug = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1001 } -MaxEvents 5 -ErrorAction SilentlyContinue
  if ($bug) {
    foreach ($e in $bug) { L ("BUGCHECK {0}: {1}" -f $e.TimeCreated, ($e.Message -replace "`r?`n", ' ')) }
  } else { L 'BUGCHECK none' }
  $fm = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-FilterManager' } -MaxEvents 10 -ErrorAction SilentlyContinue
  if ($fm) {
    foreach ($e in $fm) { L ("FILTERMGR {0} id={1}: {2}" -f $e.TimeCreated, $e.Id, ($e.Message -replace "`r?`n", ' ')) }
  } else { L 'FILTERMGR none' }
  $kp = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 1074, 6008 } -MaxEvents 8 -ErrorAction SilentlyContinue
  if ($kp) {
    foreach ($e in $kp) { L ("POWER {0} id={1}: {2}" -f $e.TimeCreated, $e.Id, ($e.Message -replace "`r?`n", ' ')) }
  } else { L 'POWER none' }

  # --- 2. driver + provider state ------------------------------------------
  Stop-Provider
  sc.exe stop SimRep 2>$null | Out-Null
  fltmc unload SimRep 2>$null | Out-Null
  Start-Sleep -Seconds 1
  $params = 'HKLM\SYSTEM\CurrentControlSet\Services\SimRep\Parameters'
  reg.exe add $params /v OldMapping /t REG_SZ /d '\m0\ws' /f | Out-Null
  reg.exe add $params /v NewMapping /t REG_SZ /d '\m0\view' /f | Out-Null
  reg.exe add $params /v RemapRenamesAndLinks /t REG_DWORD /d 1 /f | Out-Null
  fltmc load SimRep *> C:\m0\p2-load.log
  L "fltmc load exit=$LASTEXITCODE"
  fltmc attach SimRep C: *> C:\m0\p2-attach.log
  L "fltmc attach exit=$LASTEXITCODE"

  Start-Provider 'C:\m0\view' 90
  L "view-a=$([bool](Test-Path C:\m0\view\a.txt)) ws-a=$([bool](Test-Path C:\m0\ws\a.txt))"

  # metadata cost: after a provider restart, existing placeholders
  Stat 'C:\m0\view\flat5000' 'view-restart-1'
  Stat 'C:\m0\view\flat5000' 'view-restart-2'
  Stat 'C:\m0\ws\flat5000'   'ws-restart-1'
  Stat 'C:\m0\ws\flat5000'   'ws-restart-2'
  Stat 'C:\m0\view\tree\d1'  'view-tree-1'
  Stat 'C:\m0\view\tree\d1'  'view-tree-2'

  # metadata cost: brand-new instance (placeholders created from scratch)
  Stop-Provider
  if (Test-Path C:\m0\view2) { cmd.exe /c 'rmdir /s /q C:\m0\view2' | Out-Null }
  New-Item -ItemType Directory -Force C:\m0\view2 | Out-Null
  Start-Provider 'C:\m0\view2' 90
  Stat 'C:\m0\view2\flat5000' 'view2-cold-1'
  Stat 'C:\m0\view2\flat5000' 'view2-cold-2'
  Stat 'C:\m0\view2\flat5000' 'view2-cold-3'
  Stat 'C:\m0\view2\flat20000' 'view2-20k-cold-1'
  Stat 'C:\m0\view2\flat20000' 'view2-20k-cold-2'
  Stat 'C:\m0\view2\tree\d1'   'view2-tree-1'
  Stat 'C:\m0\view2\tree\d1'   'view2-tree-2'

  $payload = [ordered]@{ ok = $true; at = (Get-Date).ToString('o'); rows = $rows }
  [IO.File]::WriteAllText($Json, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  L 'PROBE2 DONE'
}
catch {
  L "FATAL: $($_.Exception.Message)"
  $payload = [ordered]@{ ok = $false; error = "$($_.Exception.Message)"; at = (Get-Date).ToString('o'); rows = $rows }
  [IO.File]::WriteAllText($Json, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  exit 1
}
