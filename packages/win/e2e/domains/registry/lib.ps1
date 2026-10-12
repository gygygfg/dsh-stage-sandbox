# registry-tester shared helpers. All output is appended to executions.log (raw, with exit codes).
$ErrorActionPreference = 'Continue'
$script:Area  = 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry'
$script:EvDir = Join-Path $script:Area 'evidence'
$script:LogPath = Join-Path $script:Area 'executions.log'
$script:Stage = 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'
if (-not (Test-Path -LiteralPath $script:EvDir)) { New-Item -ItemType Directory -Force -Path $script:EvDir | Out-Null }

function RLog([string]$text) { Add-Content -LiteralPath $script:LogPath -Value $text -Encoding UTF8 }
function RSec([string]$id, [string]$title) {
  RLog ''
  RLog ('#' * 78)
  RLog ("# [{0}] {1}   @ {2}" -f $id, $title, (Get-Date).ToString('o'))
  RLog ("# pwshPid={0} user={1}" -f $PID, $env:USERNAME)
  RLog ('#' * 78)
}
# Run a cmd.exe command line (CMD channel), log raw output + exit code, return object.
function RRun([string]$label, [string]$command) {
  Write-Output "--- $label"
  Write-Output "CMD> $command"
  RLog ("--- {0}" -f $label)
  RLog ("CMD> {0}" -f $command)
  $out = & cmd.exe /d /c $command 2>&1 | Out-String
  $code = $LASTEXITCODE
  $outT = $out.TrimEnd()
  Write-Output "EXIT> $code"
  if ($outT) { Write-Output $outT }
  RLog ("EXIT> {0}" -f $code)
  if ($outT) { RLog $outT }
  [pscustomobject]@{ label = $label; command = $command; exit = $code; out = $outT }
}
# Run a PowerShell scriptblock (PS channel), log a serialized rendering + errors.
function RPsl([string]$label, [scriptblock]$sb) {
  Write-Output "--- $label"
  RLog ("--- {0}" -f $label)
  $errs = @()
  try { $out = & $sb 2>&1 | Out-String } catch { $errs += $_.ToString(); $out = '' }
  $outT = ($out + ($errs -join "`n")).TrimEnd()
  if ($outT) { Write-Output $outT }
  RLog $outT
  [pscustomobject]@{ label = $label; out = $outT }
}
function RNote([string]$text) { Write-Output "NOTE> $text"; RLog ("NOTE> {0}" -f $text) }
# Snapshot of registry overlay artifacts (STAGE channel: ground truth, no hook).
# Canonical serialization of a registry key's values + SHA256 (PS channel readback).
function RCanon([string]$key) {
  if (-not (Test-Path -LiteralPath $key)) { return @{ text = "<ABSENT>"; sha = '' } }
  $k = Get-Item -LiteralPath $key
  $parts = @()
  foreach ($n in ($k.GetValueNames() | Sort-Object)) {
    $kind = $k.GetValueKind($n)
    $v = $k.GetValue($n)
    $s = ''
    switch ("$kind") {
      'Binary' { $s = (($v | ForEach-Object { $_.ToString('x2') }) -join '') }
      'MultiString' { $s = ($v -join '|') }
      default { $s = [string]$v }
    }
    $parts += ("{0}:{1}={2}" -f $n, $kind, $s)
  }
  $text = ($parts -join '; ')
  $sha = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '')
  return @{ text = $text; sha = $sha }
}
# Decoded WAL journal summary, filtered (STAGE channel, no hook).
function RWal([string]$filter) {
  $jp = Join-Path $script:Stage 'registry\overlay.journal'
  try { $i = Get-Item -LiteralPath $jp; $size = $i.Length; $mt = $i.LastWriteTime.ToString('o') } catch { return "journal stat failed: $($_.Exception.Message)" }
  $lines = @("journal bytes=$size mtime=$mt")
  try {
    $fs = [System.IO.File]::Open($jp, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $buf = New-Object byte[] $fs.Length
    [void]$fs.Read($buf, 0, $buf.Length); $fs.Close()
    $u = [System.Text.Encoding]::Unicode.GetString($buf)
    $hits = [regex]::Matches($u, '[\x20-\x7E]{6,}') | ForEach-Object { $_.Value }
    $sel = $hits | Where-Object { $_ -match $filter }
    $lines += ("decoded runs matching '{0}': {1}" -f $filter, @($sel).Count)
    foreach ($s in $sel) { $lines += ("  WAL> " + ($s -replace '\s+', ' ')) }
    $lines += ("DSRG magic count=" + ([regex]::Matches($u, 'DSRG')).Count)
  } catch { $lines += ("journal decode failed: " + $_.Exception.Message) }
  return $lines
}
# Registry candidates whose changes match a path filter (STAGE channel).
function RCand([string]$filter) {
  $out = @()
  $dir = Join-Path $script:Stage 'candidates'
  foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter 'cs_*.json' -File | Sort-Object Name)) {
    $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    if ($txt -notmatch 'HKCU|HKLM|HKU\\\\') { continue }
    try { $j = $txt | ConvertFrom-Json } catch { $out += ("{0}`tUNPARSEABLE" -f $f.Name); continue }
    $ch = @($j.changes | Where-Object { $_.kind -eq 'registry' -and ($_.path -match $filter -or $_.registryPath -match $filter) })
    if ($ch.Count -eq 0) { continue }
    $out += ("{0}`tstatus={1}`tcreated={2}`tchanges={3}" -f $f.Name, $j.status, $j.createdAt, $ch.Count)
    foreach ($c in $ch) {
      $extra = ''
      if ($c.before) { $extra += ' before=' + $c.before.type + ':' + ($c.before.data -replace '\s', '') }
      if ($c.after)  { $extra += ' after=' + $c.after.type + ':' + ($c.after.data -replace '\s', '') }
      $out += ("    {0} | op={1} diff={2} ext={3} path={4} value={5} risk={6} safety={7}{8}" -f $c.hive, $c.op, $c.diffKind, $c.external, $c.path, $c.valueName, $c.risk, $c.safety, $extra)
    }
  }
  return $out
}
# Field-level file candidate info for the given path substring.
function RCandFiles([string]$filter) {
  $out = @()
  $dir = Join-Path $script:Stage 'candidates'
  foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter 'cs_*.json' -File | Sort-Object Name)) {
    $txt = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    try { $j = $txt | ConvertFrom-Json } catch { continue }
    $fs = @($j.files | Where-Object { $_.path -match $filter })
    if ($fs.Count -eq 0) { continue }
    foreach ($x in $fs) { $out += ("{0}`t{1}`trisk={2}`tsafety={3}`triskReason={4}`texternal={5}" -f $f.Name, $x.path, $x.risk, $x.safety, $x.riskReason, $x.external) }
  }
  return $out
}
function RStageSnap([string]$tag) {
  RLog ("--- STAGE snapshot {0}" -f $tag)
  Get-ChildItem -LiteralPath (Join-Path $script:Stage 'registry') -File |
    Sort-Object Name | ForEach-Object {
      $line = "{0}`t{1}`t{2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString('o')
      Write-Output $line; RLog $line
    }
  foreach ($f in @('overlay.state.json', 'host-capture.json')) {
    $p = Join-Path $script:Stage ("registry\$f")
    if (Test-Path -LiteralPath $p) {
      $c = (Get-Content -LiteralPath $p -Raw) -replace "`r?`n", ' '
      Write-Output ("{0} => {1}" -f $f, $c); RLog ("{0} => {1}" -f $f, $c)
    }
  }
}
