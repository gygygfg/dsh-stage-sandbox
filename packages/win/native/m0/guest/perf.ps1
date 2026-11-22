# dshnt M0 performance probe.
#
# Measures the ProjFS + SimRep path against a plain NTFS baseline:
#   - flat enumeration 1k / 5k / 20k (cold and warm)
#   - metadata storm (5000 FileInfo, like a build tool scan)
#   - first read (hydration) vs warm read
#   - first write to a placeholder (copy-up) vs subsequent write
#   - 1000 small file creates, 500 deletes, 100 renames
#
# Cold = provider restarted right before the measurement (new ProjFS
# virtualization instance). The NTFS page cache cannot be flushed from
# PowerShell, so "cold" is a lower bound; the report says so.
#
# ASCII only. Writes perf.json + perf.log to \\host.lan\Data.

$ErrorActionPreference = 'Stop'
$Share = '\\host.lan\Data'
if (-not (Test-Path $Share)) { $Share = 'Z:' }
$Log = Join-Path $Share 'perf.log'
$Json = Join-Path $Share 'perf.json'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}

Set-Content -Path $Log -Value "=== dshnt M0 perf $(Get-Date) ===" -Encoding utf8

$rows = New-Object System.Collections.ArrayList
function Record([string]$group, [string]$name, [double]$ms, [string]$note) {
  $null = $rows.Add([pscustomobject]@{ group = $group; name = $name; ms = [math]::Round($ms, 1); note = $note })
  Log ("{0,-6} {1,-34} {2,10:N1} ms  {3}" -f $group, $name, $ms, $note)
}
function TimeIt([string]$group, [string]$name, [scriptblock]$block, [string]$note) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $block
  $sw.Stop()
  Record $group $name $sw.Elapsed.TotalMilliseconds $note
}

function Stop-Provider {
  Get-Process SimpleProviderManaged -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
function Start-Provider([int]$waitSec) {
  $exe = 'C:\m0\projfs-provider\SimpleProviderManaged.exe'
  if (-not (Test-Path $exe)) { throw "provider missing: $exe" }
  Remove-Item C:\m0\provider.log, C:\m0\provider.err -Force -ErrorAction SilentlyContinue
  # Do NOT go through cmd /c: its quote stripping mangles "exe" + args + "> log".
  Start-Process -FilePath $exe `
    -ArgumentList '--SourceRoot=C:\m0\lower', '--VirtRoot=C:\m0\view' `
    -RedirectStandardOutput C:\m0\provider.log -RedirectStandardError C:\m0\provider.err `
    -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds($waitSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path C:\m0\view\__probe.txt) { break }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path C:\m0\view\__probe.txt)) {
    throw "ProjFS view did not come up; provider said: $(Provider-Output)"
  }
  Wait-View 30
}
function Provider-Output {
  $out = ''
  foreach ($f in 'C:\m0\provider.log', 'C:\m0\provider.err') {
    if (Test-Path $f) { $out += (Get-Content $f -Raw) }
  }
  return $out
}
# Right after the instance is created ProjFS can still answer
# ERROR_CLOUD_FILE_PROVIDER_... ("provider temporarily unavailable").
# Use a dedicated warm-up dir so the measured dirs stay cold.
function Wait-View([int]$sec) {
  $deadline = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $deadline) {
    try {
      if ([IO.Directory]::GetFiles('C:\m0\view\warm').Length -ge 1) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  throw "ProjFS provider not serving after $sec s: $(Provider-Output)"
}
function Measure-Cold([string]$group, [string]$label, [scriptblock]$block, [string]$note) {
  Stop-Provider
  Start-Provider 120
  TimeIt $group "$label-cold" $block $note
}
function Measure-Warm([string]$group, [string]$label, [scriptblock]$block, [string]$note) {
  TimeIt $group "$label-warm" $block $note
}

try {
  # --- 0. environment -------------------------------------------------------
  $os = (Get-CimInstance Win32_OperatingSystem).Caption
  $projfs = (Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS).State
  $bcd = (bcdedit /enum '{current}' 2>&1) -join "`n"
  $testSigning = $bcd -match 'testsigning\s+Yes'
  Log "os=$os projfs=$projfs testsigning=$testSigning"

  # --- 1. deterministic driver state ---------------------------------------
  Stop-Provider
  sc.exe stop SimRep 2>$null | Out-Null
  fltmc unload SimRep 2>$null | Out-Null
  sc.exe stop SimRep 2>$null | Out-Null
  Start-Sleep -Seconds 1
  $params = 'HKLM\SYSTEM\CurrentControlSet\Services\SimRep\Parameters'
  $instances = "$params\Instances"
  reg.exe add $params /v SupportedFeatures /t REG_DWORD /d 3 /f | Out-Null
  reg.exe add $params /v OldMapping /t REG_SZ /d '\m0\ws' /f | Out-Null
  reg.exe add $params /v NewMapping /t REG_SZ /d '\m0\view' /f | Out-Null
  reg.exe add $params /v RemapRenamesAndLinks /t REG_DWORD /d 1 /f | Out-Null
  reg.exe add $instances /v DefaultInstance /t REG_SZ /d SimRep /f | Out-Null
  reg.exe add "$instances\SimRep" /v Altitude /t REG_SZ /d 371100 /f | Out-Null
  reg.exe add "$instances\SimRep" /v Flags /t REG_DWORD /d 0 /f | Out-Null

  # --- 2. seed lower --------------------------------------------------------
  if (Test-Path C:\m0\lower) { cmd.exe /c 'rmdir /s /q C:\m0\lower' | Out-Null }
  if (Test-Path C:\m0\view) { cmd.exe /c 'rmdir /s /q C:\m0\view' | Out-Null }
  if (Test-Path C:\m0\ws) { cmd.exe /c 'rmdir /s /q C:\m0\ws' | Out-Null }
  New-Item -ItemType Directory -Force C:\m0\lower | Out-Null
  New-Item -ItemType Directory -Force C:\m0\view | Out-Null
  New-Item -ItemType Directory -Force C:\m0\ws | Out-Null
  Set-Content -Path C:\m0\lower\__probe.txt -Value 'probe' -Encoding ASCII
  Set-Content -Path C:\m0\lower\a.txt -Value 'hello' -Encoding ASCII

  $oneK = New-Object byte[] 1024
  for ($i = 0; $i -lt 1024; $i++) { $oneK[$i] = 65 + ($i % 26) }
  foreach ($n in 1000, 5000, 20000) {
    $dir = "C:\m0\lower\flat$n"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $sw = [Diagnostics.Stopwatch]::StartNew()
    for ($i = 0; $i -lt $n; $i++) {
      [IO.File]::WriteAllBytes((Join-Path $dir ("f{0:d5}.txt" -f $i)), $oneK)
    }
    $sw.Stop()
    Record 'seed' "lower-flat$n-create" $sw.Elapsed.TotalMilliseconds "$n x 1KiB"
  }
  # Dedicated warm-up dir (never measured): used to detect provider readiness.
  New-Item -ItemType Directory -Force C:\m0\lower\warm | Out-Null
  foreach ($i in 1..5) { [IO.File]::WriteAllBytes("C:\m0\lower\warm\w$i.txt", $oneK) }

  # A small tree for nested enumeration/stat/deletes.
  $tree = 'C:\m0\lower\tree'
  New-Item -ItemType Directory -Force $tree | Out-Null
  foreach ($d in 1..10) {
    $sub = Join-Path $tree "d$d"
    New-Item -ItemType Directory -Force $sub | Out-Null
    foreach ($f in 1..100) {
      [IO.File]::WriteAllBytes((Join-Path $sub "f$f.txt"), $oneK)
    }
  }

  $baseline = @{}
  foreach ($rel in 'a.txt', 'flat1000\f00000.txt', 'flat5000\f00000.txt', 'flat20000\f00000.txt') {
    $baseline[$rel] = (Get-FileHash (Join-Path 'C:\m0\lower' $rel) -Algorithm SHA256).Hash
  }


  # --- 3. NTFS baseline -----------------------------------------------------
  foreach ($n in 1000, 5000, 20000) {
    $p = "C:\m0\lower\flat$n"
    TimeIt 'lower' "enum-flat$n" { [IO.Directory]::GetFiles($p).Length } 'GetFiles'
  }
  TimeIt 'lower' 'enum-tree-recursive' { [IO.Directory]::GetFiles('C:\m0\lower\tree', '*', 'AllDirectories').Length } '1000 files / 10 dirs'
  TimeIt 'lower' 'stat-5000' {
    $files = [IO.Directory]::GetFiles('C:\m0\lower\flat5000')
    $sum = 0L
    foreach ($f in $files) { $fi = New-Object IO.FileInfo($f); $sum += $fi.Length }
  } '5000 FileInfo'
  TimeIt 'lower' 'read-1k-first' { $b = [IO.File]::ReadAllBytes('C:\m0\lower\flat1000\f00000.txt'); $b.Length } '1 KiB'
  TimeIt 'lower' 'read-1k-warm'  { $b = [IO.File]::ReadAllBytes('C:\m0\lower\flat1000\f00000.txt'); $b.Length } '1 KiB'
  $wdir = 'C:\m0\lower\w'
  New-Item -ItemType Directory -Force $wdir | Out-Null
  TimeIt 'lower' 'create-1000' {
    for ($i = 0; $i -lt 1000; $i++) { [IO.File]::WriteAllBytes((Join-Path $wdir ("w{0:d4}.txt" -f $i)), $oneK) }
  } '1000 x 1 KiB'
  TimeIt 'lower' 'rename-100' {
    for ($i = 0; $i -lt 100; $i++) {
      $a = Join-Path $wdir ("w{0:d4}.txt" -f $i)
      $b = Join-Path $wdir ("r{0:d4}.txt" -f $i)
      [IO.File]::Move($a, $b)
    }
  } '100 renames'
  TimeIt 'lower' 'delete-500' {
    $files = [IO.Directory]::GetFiles($wdir)
    for ($i = 0; $i -lt 500 -and $i -lt $files.Length; $i++) { [IO.File]::Delete($files[$i]) }
  } '500 deletes'

  # --- 4. ProjFS view (direct) ---------------------------------------------
  Start-Provider 120
  foreach ($n in 1000, 5000, 20000) {
    $p = "C:\m0\view\flat$n"
    Measure-Cold 'view' "enum-flat$n" { [IO.Directory]::GetFiles($p).Length } 'first enumeration'
    Measure-Warm 'view' "enum-flat$n" { [IO.Directory]::GetFiles($p).Length } 'second enumeration'
  }
  Measure-Cold 'view' 'enum-tree-recursive' { [IO.Directory]::GetFiles('C:\m0\view\tree', '*', 'AllDirectories').Length } '1000 files'
  Measure-Warm 'view' 'enum-tree-recursive' { [IO.Directory]::GetFiles('C:\m0\view\tree', '*', 'AllDirectories').Length } '1000 files'
  Measure-Cold 'view' 'stat-5000' {
    $files = [IO.Directory]::GetFiles('C:\m0\view\flat5000')
    $sum = 0L
    foreach ($f in $files) { $fi = New-Object IO.FileInfo($f); $sum += $fi.Length }
  } '5000 FileInfo'
  Measure-Cold 'view' 'read-1k-first' { $b = [IO.File]::ReadAllBytes('C:\m0\view\flat1000\f00000.txt'); $b.Length } 'hydration'
  Measure-Warm 'view' 'read-1k-warm'  { $b = [IO.File]::ReadAllBytes('C:\m0\view\flat1000\f00000.txt'); $b.Length } 'Hydrated'

  # --- 5. ws (same path, SimRep redirect) ----------------------------------
  fltmc load SimRep *> C:\m0\perf-fltmc-load.log
  Log "fltmc load exit=$LASTEXITCODE"
  fltmc attach SimRep C: *> C:\m0\perf-fltmc-attach.log
  Log "fltmc attach exit=$LASTEXITCODE"
  if (-not (Test-Path C:\m0\ws\__probe.txt)) { throw 'ws is not redirected to the view' }

  foreach ($n in 1000, 5000, 20000) {
    $p = "C:\m0\ws\flat$n"
    Measure-Cold 'ws' "enum-flat$n" { [IO.Directory]::GetFiles($p).Length } 'same-path first enumeration'
    Measure-Warm 'ws' "enum-flat$n" { [IO.Directory]::GetFiles($p).Length } 'same-path second enumeration'
  }
  Measure-Cold 'ws' 'enum-tree-recursive' { [IO.Directory]::GetFiles('C:\m0\ws\tree', '*', 'AllDirectories').Length } '1000 files'
  Measure-Warm 'ws' 'enum-tree-recursive' { [IO.Directory]::GetFiles('C:\m0\ws\tree', '*', 'AllDirectories').Length } '1000 files'
  Measure-Cold 'ws' 'stat-5000' {
    $files = [IO.Directory]::GetFiles('C:\m0\ws\flat5000')
    $sum = 0L
    foreach ($f in $files) { $fi = New-Object IO.FileInfo($f); $sum += $fi.Length }
  } '5000 FileInfo'
  Measure-Cold 'ws' 'read-1k-first' { $b = [IO.File]::ReadAllBytes('C:\m0\ws\flat1000\f00000.txt'); $b.Length } 'hydration via redirect'
  Measure-Warm 'ws' 'read-1k-warm'  { $b = [IO.File]::ReadAllBytes('C:\m0\ws\flat1000\f00000.txt'); $b.Length } 'hydrated'
  Measure-Cold 'ws' 'copyup-write' { [IO.File]::AppendAllText('C:\m0\ws\a.txt', 'x') } 'first write to existing placeholder'
  Measure-Warm 'ws' 'copyup-write-again' { [IO.File]::AppendAllText('C:\m0\ws\a.txt', 'x') } 'second write'
  $wdir2 = 'C:\m0\ws\w'
  New-Item -ItemType Directory -Force $wdir2 | Out-Null
  Measure-Warm 'ws' 'create-1000' {
    for ($i = 0; $i -lt 1000; $i++) { [IO.File]::WriteAllBytes((Join-Path $wdir2 ("w{0:d4}.txt" -f $i)), $oneK) }
  } '1000 x 1 KiB'
  Measure-Warm 'ws' 'rename-100' {
    for ($i = 0; $i -lt 100; $i++) {
      $a = Join-Path $wdir2 ("w{0:d4}.txt" -f $i)
      $b = Join-Path $wdir2 ("r{0:d4}.txt" -f $i)
      [IO.File]::Move($a, $b)
    }
  } '100 renames'
  Measure-Warm 'ws' 'delete-500' {
    $files = [IO.Directory]::GetFiles($wdir2)
    for ($i = 0; $i -lt 500 -and $i -lt $files.Length; $i++) { [IO.File]::Delete($files[$i]) }
  } '500 deletes'

  # --- 6. integrity --------------------------------------------------------
  $unchanged = $true
  foreach ($rel in $baseline.Keys) {
    $now = (Get-FileHash (Join-Path 'C:\m0\lower' $rel) -Algorithm SHA256).Hash
    if ($now -ne $baseline[$rel]) { $unchanged = $false; Log "LOWER CHANGED: $rel" }
  }
  Log "lowerUnchanged=$unchanged"
  Log "ws-a-sha256=$(if (Test-Path C:\m0\ws\a.txt) { (Get-FileHash C:\m0\ws\a.txt -Algorithm SHA256).Hash } else { 'missing' })"

  # git, if present.
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    TimeIt 'tool' 'git-status-flat5000' { & git -C C:\m0\lower status --porcelain | Out-Null } 'real repo n/a; plain dir'
  } else {
    Log 'git: n/a (not installed in guest)'
  }

  $payload = [ordered]@{
    ok = $true
    at = (Get-Date).ToString('o')
    os = $os
    projfs = "$projfs"
    testSigning = $testSigning
    lowerUnchanged = $unchanged
    rows = $rows
    notes = @(
      'cold = provider restarted before measurement; NTFS page cache is not flushed, so cold is a lower bound',
      'warm = immediately after the cold run',
      'files are 1 KiB, flat directories, 100 files per dir in tree'
    )
  }
  [IO.File]::WriteAllText($Json, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Log 'PERF DONE'
}
catch {
  Log "FATAL: $($_.Exception.Message)"
  $payload = [ordered]@{ ok = $false; error = "$($_.Exception.Message)"; at = (Get-Date).ToString('o'); rows = $rows }
  [IO.File]::WriteAllText($Json, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  exit 1
}
