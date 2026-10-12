. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-01b' 'post-run candidate state + accurate reg.exe exit codes'

RLog '--- INTEGRITY lines from REG-01 (from log)'
Get-Content -LiteralPath $script:LogPath | Select-String -Pattern 'INTENDED|READBACK SHA256|INTEGRITY' | Select-Object -Last 6 | ForEach-Object { Write-Output ("LOG> " + $_.Line); RLog ("LOG> " + $_.Line) }

RLog '--- newest registry candidates (post-run)'
$out = RCand 'DshRegT0'
foreach ($l in $out) { Write-Output $l; RLog $l }
RLog '--- candidates mentioning DshRegT01C'
foreach ($l in (RCand 'DshRegT01C')) { Write-Output $l; RLog $l }

RLog '--- accurate single-command exit codes (reg query last)'
foreach ($c in @(
  'reg query "HKCU\Software\DshRegT01" /s',
  'reg query "HKCU\Software\DshRegT01C" /s',
  'reg query "HKCU\Software\7-Zip" /v Path')) {
  $r = RRun ('exitcode probe: ' + $c) $c
  RLog ("EXITCODE`t{0}`t{1}" -f $r.exit, $c)
}

RLog '--- session review.json summary'
$rp = Join-Path $script:Stage 'review.json'
$j = [System.IO.File]::ReadAllText($rp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$l = ("review: pending={0} truncated={1} counts.files={2} riskCounts(normal={3},outside={4},sensitive={5},danger={6}) alerts={7} candidates={8}" -f $j.pending, $j.truncated, $j.counts.files, $j.riskCounts.normal, $j.riskCounts.outside, $j.riskCounts.sensitive, $j.riskCounts.danger, (@($j.alerts) -join ';'), $j.candidates.Count)
Write-Output $l; RLog $l
foreach ($c in $j.candidates) {
  $l2 = ("  review-cand {0} status={1} paths={2}" -f $c.id, $c.status, (@($c.paths).Count))
  Write-Output $l2; RLog $l2
}
RNote 'REG-01b done'
