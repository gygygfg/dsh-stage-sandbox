# risk.ps1 - tolerant per-path risk lookup from review.json (retries: review.json is rewritten concurrently)
param([string]$Pattern = '.', [int]$Max = 12)
$S = 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'
$r = $null
for ($i = 1; $i -le 8; $i++) {
  try {
    $r = Get-Content "$S\review.json" -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($r -and $r.files) { break }
  } catch { Start-Sleep -Milliseconds 250; $r = $null }
}
if (-not $r) { Write-Output "REVIEW-PARSE-FAILED after 8 attempts"; exit 0 }
Write-Output ("revision={0} pending={1} truncated={2} filesListed={3} riskCounts(normal={4},outside={5},sensitive={6},danger={7}) alerts={8}" -f `
  $r.revision, $r.pending, $r.truncated, $r.files.Count, $r.riskCounts.normal, $r.riskCounts.outside, $r.riskCounts.sensitive, $r.riskCounts.danger, ($r.alerts -join ';'))
$hit = @($r.files | Where-Object { $_.path -match $Pattern })
if ($hit.Count -eq 0) { Write-Output "NO-MATCH-IN-review.files(40) pattern=$Pattern" }
$hit | Select-Object -First $Max | ForEach-Object { Write-Output ("{0} | op={1} | risk={2} | safety={3} | reason={4} | external={5}" -f $_.path, $_.op, $_.risk, $_.safety, $_.riskReason, $_.external) }
