# dshnt product-provider performance probe (M1 gate).
#
#   C:\> powershell -NoProfile -ExecutionPolicy Bypass -File \\host.lan\Data\m1\perf-m1.ps1
#
# Measures the *product* provider (Dshnt.Provider) through ProjFS:
#   · cold first touch  : fresh view, every file enumerated + stat'ed once
#   · warm               : same view immediately after
#   · provider restart   : placeholders already on disk, provider restarted
#
# Gate (docs/nt/M0-PERF.md §3): first touch ≤ 0.2 ms/file, 20k ≤ 5 s.
# Writes C:\m1p\perf.json to the share and prints PERF lines to the log.

$ErrorActionPreference = 'Continue'
$Share = '\\host.lan\Data'
$Root = 'C:\m1p'
$Ws = Join-Path $Root 'ws'
$View = Join-Path $Root 'view'
$Log = Join-Path $Share 'm1-perf.log'
$ProviderPipe = 'dshnt-provider-perf'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

function Send-ProviderOp([string]$op, [hashtable]$fields = @{}) {
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $ProviderPipe,
    [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $writer.AutoFlush = $true
    $reader = New-Object System.IO.StreamReader($pipe)
    $payload = @{ id = 1; op = $op }
    foreach ($k in $fields.Keys) { $payload[$k] = $fields[$k] }
    $writer.WriteLine(($payload | ConvertTo-Json -Compress))
    $reply = $reader.ReadLine()
    $writer.Dispose(); $reader.Dispose()
    return $reply
  } finally {
    $pipe.Dispose()
  }
}

function Start-Provider([string]$providerLog) {
  Get-Process dshnt-provider -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
  $exe = 'C:\m1\provider\dshnt-provider.exe'
  $proc = Start-Process -FilePath $exe -ArgumentList '--pipe', $ProviderPipe, '--log', $providerLog -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $reply = $null
    try { $reply = Send-ProviderOp 'ping' } catch { }
    if ($reply -match '"ok":true') { return $proc }
  }
  throw 'provider did not become ready'
}

function Start-View() {
  $reply = Send-ProviderOp 'start' @{ domain = 'perf'; workspace = $Ws; view = $View }
  if ($reply -notmatch '"ok":true') { throw "provider start failed: $reply" }
  $null = Send-ProviderOp 'protect' @{ value = $true }
}

function Measure-Once([string]$dir, [string]$label, [switch]$Recurse) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $files = if ($Recurse) {
    [IO.Directory]::GetFiles($dir, '*', [IO.SearchOption]::AllDirectories)
  } else {
    [IO.Directory]::GetFiles($dir)
  }
  $enumMs = $sw.Elapsed.TotalMilliseconds
  $sw.Restart()
  $bytes = 0L
  foreach ($f in $files) {
    $info = New-Object IO.FileInfo($f)
    $bytes += $info.Length
  }
  $statMs = $sw.Elapsed.TotalMilliseconds
  $sw.Stop()
  $n = [Math]::Max($files.Count, 1)
  $result = [ordered]@{
    label = $label
    files = $files.Count
    enumMs = [Math]::Round($enumMs, 1)
    statMs = [Math]::Round($statMs, 1)
    totalMs = [Math]::Round($enumMs + $statMs, 1)
    perFileMs = [Math]::Round(($enumMs + $statMs) / $n, 3)
    bytes = $bytes
  }
  Log ("PERF {0}: files={1} enum={2}ms stat={3}ms total={4}ms per-file={5}ms" -f `
    $label, $result.files, $result.enumMs, $result.statMs, $result.totalMs, $result.perFileMs)
  return $result
}

Set-Content -Path $Log -Value "=== dshnt M1 perf $(Get-Date) ===" -Encoding utf8

# 0. prerequisites: provider binary must already be staged by m1.ps1
if (-not (Test-Path 'C:\m1\provider\dshnt-provider.exe')) {
  Log 'FATAL: C:\m1\provider\dshnt-provider.exe missing (run m1.ps1 once first)'
  exit 1
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Log 'FATAL: not elevated'
  exit 1
}

# 1. fixture
if (Test-Path $Root) { cmd.exe /c "rmdir /s /q $Root" | Out-Null }
New-Item -ItemType Directory -Force $Ws | Out-Null
New-Item -ItemType Directory -Force $View | Out-Null

$payload = New-Object byte[] 1024
for ($i = 0; $i -lt 1024; $i++) { $payload[$i] = [byte](65 + ($i % 26)) }

function New-Flat([string]$dir, [int]$count) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt $count; $i++) {
    [IO.File]::WriteAllBytes((Join-Path $dir ("f{0:d5}.dat" -f $i)), $payload)
  }
  Log ("fixture {0}: {1} files in {2:n1}s" -f $dir, $count, $sw.Elapsed.TotalSeconds)
}

New-Flat (Join-Path $Ws 'flat5k') 5000
New-Flat (Join-Path $Ws 'flat20k') 20000
New-Item -ItemType Directory -Force (Join-Path $Ws 'tree') | Out-Null
for ($d = 0; $d -lt 10; $d++) {
  $sub = Join-Path (Join-Path $Ws 'tree') ("d{0:d2}" -f $d)
  New-Item -ItemType Directory -Force $sub | Out-Null
  for ($i = 0; $i -lt 100; $i++) {
    [IO.File]::WriteAllBytes((Join-Path $sub ("f{0:d4}.dat" -f $i)), $payload)
  }
}
Log 'fixture ready'

$results = [ordered]@{}

# 2. cold: fresh view + fresh provider
$providerLog = 'C:\m1p\provider.log'
$proc = Start-Provider $providerLog
Start-View
$results.cold5k = Measure-Once (Join-Path $View 'flat5k') 'cold-5k'
$results.cold20k = Measure-Once (Join-Path $View 'flat20k') 'cold-20k'

# 3. warm: same view/provider
$results.warm5k = Measure-Once (Join-Path $View 'flat5k') 'warm-5k'
$results.warm20k = Measure-Once (Join-Path $View 'flat20k') 'warm-20k'
$results.tree = Measure-Once (Join-Path $View 'tree') 'warm-tree' -Recurse

# 4. provider restart (placeholders exist on disk)
$proc = Start-Provider $providerLog
Start-View
$results.restart5k = Measure-Once (Join-Path $View 'flat5k') 'restart-5k'
$results.restart20k = Measure-Once (Join-Path $View 'flat20k') 'restart-20k'

# 5. gate
$gate200 = 0.2
$coldPerFile = [double]$results.cold20k.perFileMs
$restartPerFile = [double]$results.restart20k.perFileMs
$coldTotalMs = [double]$results.cold20k.totalMs
$ok = ($coldPerFile -le $gate200) -and ($coldTotalMs -le 5000) -and ($restartPerFile -le $gate200)

$payloadJson = [ordered]@{
  ok = [bool]$ok
  at = (Get-Date).ToString('o')
  gate = @{ perFileMs = $gate200; totalMs = 5000 }
  results = $results
  providerLog = (Get-Content $providerLog -Tail 12 -ErrorAction SilentlyContinue) -join "`n"
}
[IO.File]::WriteAllText((Join-Path $Share 'PERF_M1.json'), ($payloadJson | ConvertTo-Json -Depth 8),
  (New-Object Text.UTF8Encoding($false)))
Log ("GATE ok={0} cold20k={1}ms/{2}ms-per-file restart20k={3}ms-per-file" -f `
  $ok, $coldTotalMs, $coldPerFile, $restartPerFile)

Get-Process dshnt-provider -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
exit $(if ($ok) { 0 } else { 1 })
