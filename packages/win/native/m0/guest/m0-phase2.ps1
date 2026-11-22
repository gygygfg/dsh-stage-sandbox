# dshnt M0 phase 2 (after reboot, at logon)
# Start the ProjFS provider, load SimRep configured for \m0\ws -> \m0\view,
# run the C probe, verify C:\m0\lower is unchanged, and write RESULT_M0.json.
# Keep this file ASCII-only.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Share = '\\host.lan\Data'
if (-not (Test-Path $Share)) { $Share = 'Z:' }
if (-not (Test-Path $Share)) { $Share = '\\host.lan\shared' }
$Log = Join-Path $Share 'm0-phase2.log'
$Result = Join-Path $Share 'RESULT_M0.json'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}
function SaveJson($obj, [string]$path) {
  $json = $obj | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Tail([string]$path, [int]$lines = 80) {
  if (Test-Path $path) {
    try { return (Get-Content $path -Tail $lines -ErrorAction SilentlyContinue) -join "`n" } catch { return '' }
  }
  return ''
}
function Fail([string]$m, [hashtable]$extra = @{}) {
  Log "FATAL: $m"
  $obj = [ordered]@{
    ok = $false
    phase = 2
    error = $m
    at = (Get-Date).ToString('o')
    share = $Share
    providerLog = Tail 'C:\m0\provider.log'
    loadLog = Tail 'C:\m0\fltmc-load.log'
    clientLog = Tail 'C:\m0\client.log' 120
  }
  foreach ($k in $extra.Keys) { $obj[$k] = $extra[$k] }
  SaveJson $obj $Result
  exit 1
}
function HashTree([string]$root) {
  $map = @{}
  if (-not (Test-Path $root)) { return $map }
  Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    $map[$rel] = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
  }
  return $map
}

Set-Content -Path $Log -Value "=== dshnt M0 phase2 $(Get-Date) ===" -Encoding utf8
Log "share=$Share"

# 1. Wait for share / phase1 (no lock before the share is reachable: a SYSTEM
#    scheduled task must not poison the user's RunOnce attempt).
$tries = 0
while (-not (Test-Path $Share) -and $tries -lt 60) { Start-Sleep -Seconds 5; $tries++ }
if (-not (Test-Path $Share)) { exit 1 }
if (-not (Test-Path (Join-Path $Share 'm0-phase1-done.json'))) {
  Log 'warning: phase1-done.json missing; continuing'
}
if (Test-Path (Join-Path $Share 'RESULT_M0.json')) { Log 'RESULT already exists; exit'; exit 0 }

# 2. Deduplicate scheduled task + RunOnce (per-user temp lock).
$lock = Join-Path $env:TEMP 'dshnt-m0-phase2.lock'
if (Test-Path $lock) { Log 'phase2 already ran; exit'; exit 0 }
Set-Content -Path $lock -Value (Get-Date).ToString('o') -Encoding utf8

# 3. Facts.
$projfs = (Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -ErrorAction SilentlyContinue).State
$bcd = (bcdedit /enum '{current}' 2>&1) -join "`n"
$testSigning = $bcd -match 'testsigning\s+Yes'
Log "projfs=$projfs testsigning=$testSigning"

# 4. Seed lower (the real workspace) and a real empty ws directory (logical path).
if (Test-Path C:\m0\lower) { cmd.exe /c 'rmdir /s /q C:\m0\lower' | Out-Null }
New-Item -ItemType Directory -Force C:\m0\lower\dir | Out-Null
Set-Content -Path C:\m0\lower\a.txt -Value 'hello' -Encoding ASCII
Set-Content -Path C:\m0\lower\b.txt -Value 'v1' -Encoding ASCII
Set-Content -Path C:\m0\lower\dir\c.txt -Value 'c' -Encoding ASCII
Set-Content -Path C:\m0\lower\gone.txt -Value 'gone' -Encoding ASCII
New-Item -ItemType Directory -Force C:\m0\ws | Out-Null
$lowerBefore = HashTree 'C:\m0\lower'
Log "lower before: $($lowerBefore.Count) files"

# 5. Start ProjFS provider (backing=lower, view=view).
$providerDir = 'C:\m0\projfs-provider'
$providerExe = Join-Path $providerDir 'SimpleProviderManaged.exe'
if (-not (Test-Path $providerExe)) { Fail "provider missing: $providerExe" }
Get-Process SimpleProviderManaged -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path C:\m0\view) { cmd.exe /c 'rmdir /s /q C:\m0\view' | Out-Null }
New-Item -ItemType Directory -Force C:\m0\view | Out-Null
Remove-Item C:\m0\provider.log -Force -ErrorAction SilentlyContinue
$providerCmd = "`"$providerExe`" --SourceRoot=C:\m0\lower --VirtRoot=C:\m0\view > `"C:\m0\provider.log`" 2>&1"
$provider = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $providerCmd -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddMinutes(2)
while ((Get-Date) -lt $deadline) {
  if (Test-Path C:\m0\view\a.txt) { break }
  Start-Sleep -Seconds 2
}
$providerRunning = [bool](Get-Process SimpleProviderManaged -ErrorAction SilentlyContinue)
Log "provider running=$providerRunning viewA=$(Test-Path C:\m0\view\a.txt)"
if (-not (Test-Path C:\m0\view\a.txt)) {
  Fail 'ProjFS view did not become available' @{ providerRunning = $providerRunning }
}

# 6. Build the C probe.
$clientSrc = 'C:\m0\m0-client.c'
if (-not (Test-Path $clientSrc)) { Copy-Item -Force (Join-Path $Share 'm0-client.c') $clientSrc }
$buildBat = 'C:\m0\build-client.bat'
Set-Content -Path $buildBat -Encoding ASCII -Value @(
  '@echo off',
  'call "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"',
  'cl /nologo /W3 /EHsc /Fe:C:\m0\bin\m0-client.exe C:\m0\m0-client.c ntdll.lib'
)
Remove-Item C:\m0\client-build.log -Force -ErrorAction SilentlyContinue
cmd.exe /c $buildBat *> C:\m0\client-build.log
$buildExit = $LASTEXITCODE
Log "client build exit=$buildExit"
if (-not (Test-Path C:\m0\bin\m0-client.exe)) {
  Fail 'm0-client.exe not built' @{ buildLog = Tail 'C:\m0\client-build.log' 120 }
}

# 7. Load SimRep with the \m0\ws -> \m0\view mapping.
sc.exe stop SimRep 2>$null | Out-Null
sc.exe delete SimRep 2>$null | Out-Null
Start-Sleep -Seconds 2
sc.exe create SimRep type= filesys start= demand error= normal binPath= C:\m0\bin\simrep.sys depend= FltMgr 2>&1 | Out-Null
$params = 'HKLM\SYSTEM\CurrentControlSet\Services\SimRep\Parameters'
$instances = "$params\Instances"
reg.exe add $params /v SupportedFeatures /t REG_DWORD /d 3 /f 2>&1 | Out-Null
reg.exe add $params /v OldMapping /t REG_SZ /d '\m0\ws' /f 2>&1 | Out-Null
reg.exe add $params /v NewMapping /t REG_SZ /d '\m0\view' /f 2>&1 | Out-Null
reg.exe add $params /v DebugLevel /t REG_DWORD /d 0x1F /f 2>&1 | Out-Null
reg.exe add $instances /v DefaultInstance /t REG_SZ /d SimRep /f 2>&1 | Out-Null
reg.exe add "$instances\SimRep" /v Altitude /t REG_SZ /d 371100 /f 2>&1 | Out-Null
reg.exe add "$instances\SimRep" /v Flags /t REG_DWORD /d 0 /f 2>&1 | Out-Null
Remove-Item C:\m0\fltmc-load.log -Force -ErrorAction SilentlyContinue
fltmc load SimRep *> C:\m0\fltmc-load.log
$loadExit = $LASTEXITCODE
$filters = (fltmc filters 2>&1) -join "`n"
$driverLoaded = $filters -match 'SimRep'
Log "fltmc load exit=$loadExit driverLoaded=$driverLoaded"
if (-not $driverLoaded) {
  Fail 'SimRep did not load' @{ loadExit = $loadExit; loadLog = Tail 'C:\m0\fltmc-load.log' 120; filters = $filters }
}

# 8. Wait for \m0\ws -> \m0\view redirection.
$deadline = (Get-Date).AddSeconds(60)
$redirectOk = $false
while ((Get-Date) -lt $deadline) {
  try {
    $probe = Get-Content C:\m0\ws\a.txt -Raw -ErrorAction Stop
    if ($probe -match 'hello') { $redirectOk = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
Log "redirectOk=$redirectOk"
if (-not $redirectOk) {
  Fail 'C:\m0\ws was not redirected to the ProjFS view' @{ filters = $filters; providerLog = Tail 'C:\m0\provider.log' }
}

# 9. Run the probe.
Remove-Item C:\m0\client.log -Force -ErrorAction SilentlyContinue
& C:\m0\bin\m0-client.exe *> C:\m0\client.log
$clientExit = $LASTEXITCODE
$clientLog = Tail 'C:\m0\client.log' 200
Log "client exit=$clientExit"

# 10. Verify lower is unchanged and view has the staged changes.
$lowerAfter = HashTree 'C:\m0\lower'
$diff = @()
foreach ($k in $lowerBefore.Keys) {
  if (-not $lowerAfter.ContainsKey($k) -or $lowerAfter[$k] -ne $lowerBefore[$k]) { $diff += $k }
}
foreach ($k in $lowerAfter.Keys) {
  if (-not $lowerBefore.ContainsKey($k)) { $diff += $k }
}
$lowerUnchanged = $diff.Count -eq 0

$viewB = ''
try { $viewB = (Get-Content C:\m0\view\b.txt -Raw -ErrorAction Stop).Trim() } catch { }
$lowerB = ''
try { $lowerB = (Get-Content C:\m0\lower\b.txt -Raw -ErrorAction Stop).Trim() } catch { }
$viewChild = ''
try { $viewChild = (Get-Content C:\m0\view\child.txt -Raw -ErrorAction Stop).Trim() } catch { }
$viewRaw = ''
try { $viewRaw = (Get-Content C:\m0\view\raw.txt -Raw -ErrorAction Stop).Trim() } catch { }

$checks = [ordered]@{
  projfsEnabled = ($projfs -eq 'Enabled')
  testSigning = $testSigning
  providerRunning = $providerRunning
  driverLoaded = $driverLoaded
  redirectOk = $redirectOk
  lowerUnchanged = $lowerUnchanged
  lowerDiff = $diff
  clientExit = $clientExit
  viewB = $viewB
  lowerB = $lowerB
  viewGoneAbsent = -not (Test-Path C:\m0\view\gone.txt)
  lowerGonePresent = (Test-Path C:\m0\lower\gone.txt)
  viewChild = $viewChild
  lowerChildAbsent = -not (Test-Path C:\m0\lower\child.txt)
  viewRaw = $viewRaw
  lowerRawAbsent = -not (Test-Path C:\m0\lower\raw.txt)
  viewDirD = (Test-Path C:\m0\view\dir\d.txt)
  lowerDirC = (Test-Path C:\m0\lower\dir\c.txt)
}
$ok = $checks.projfsEnabled -and $checks.testSigning -and $checks.providerRunning -and $checks.driverLoaded -and
  $checks.redirectOk -and $checks.lowerUnchanged -and ($clientExit -eq 0) -and
  ($viewB -eq 'v2') -and ($lowerB -eq 'v1') -and $checks.viewGoneAbsent -and $checks.lowerGonePresent -and
  ($viewChild -eq 'child') -and $checks.lowerChildAbsent -and ($viewRaw -eq 'raw') -and $checks.lowerRawAbsent -and
  $checks.viewDirD -and $checks.lowerDirC

$result = [ordered]@{
  ok = $ok
  phase = 2
  at = (Get-Date).ToString('o')
  checks = $checks
  filters = $filters
  clientLog = $clientLog
  providerLog = Tail 'C:\m0\provider.log' 80
}
SaveJson $result $Result
Log "RESULT ok=$ok file=$Result"
if ($ok) { exit 0 } else { exit 1 }
