. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-00' 'Recon: process, real hive files, existing overlay artifacts'
RNote ("pwsh pid=" + $PID + " user=" + $env:USERNAME + " cwd=" + (Get-Location).Path)

# 1) Real hive file metadata (STAGE-ish: direct filesystem stat on the host hives, no reg API)
RLog '--- real hive file stats (host hives, direct FS stat)'
foreach ($h in @('C:\Users\Administrator\NTUSER.DAT','C:\Windows\System32\config\SOFTWARE','C:\Windows\System32\config\SYSTEM')) {
  if (Test-Path -LiteralPath $h) {
    try {
      $i = Get-Item -LiteralPath $h -Force
      $line = ("HIVE`t{0}`tsize={1}`tmtime={2}" -f $h, $i.Length, $i.LastWriteTime.ToString('o'))
    } catch { $line = "HIVE`t$h`tERR $($_.Exception.Message)" }
  } else { $line = "HIVE`t$h`tMISSING" }
  Write-Output $line; RLog $line
}

# 2) workspace-root review.json (protocol's review.json)
$rootReview = 'C:\Users\Administrator\Desktop\WinStageSandbox\review.json'
RNote ("root review.json exists=" + (Test-Path -LiteralPath $rootReview))
if (Test-Path -LiteralPath $rootReview) {
  $c = Get-Content -LiteralPath $rootReview -Raw
  RLog ("root review.json length=" + $c.Length)
  RLog ($c.Substring(0, [Math]::Min(1200, $c.Length)))
}

# 3) candidates that mention registry paths
RLog '--- candidates mentioning registry paths'
$hit = 0
Get-ChildItem -LiteralPath (Join-Path $script:Stage 'candidates') -Filter 'cs_*.json' -File | Sort-Object Name | ForEach-Object {
  $t = Get-Content -LiteralPath $_.FullName -Raw
  if ($t -match 'HKCU|HKLM|HKEY_') {
    $hit++
    $line = "CAND-REG`t" + $_.Name + "`t" + ($t -replace "`r?`n", ' ').Substring(0, [Math]::Min(400, $t.Length))
    Write-Output $line; RLog $line
  }
}
RNote ("candidates with registry refs = " + $hit)

# 4) overlay hive inventory
$ov = Get-ChildItem -LiteralPath (Join-Path $script:Stage 'registry') -File | Where-Object Name -like 'overlay*.hive'
RLog ("overlay hive count = " + $ov.Count)
RLog ("overlay hive names = " + (($ov | Select-Object -ExpandProperty Name) -join ', '))
$mine = Join-Path $script:Stage ("registry\overlay.{0}.hive" -f $PID)
RLog ("current pid {0} own overlay hive exists = {1}" -f $PID, (Test-Path -LiteralPath $mine))

RStageSnap 'initial'
RNote 'recon done'
