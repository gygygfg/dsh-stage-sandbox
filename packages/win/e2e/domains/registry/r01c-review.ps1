. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-01c' 'review.json registry-row visibility'
$rp = Join-Path $script:Stage 'review.json'
$t = [System.IO.File]::ReadAllText($rp, [System.Text.Encoding]::UTF8)
$j = $t | ConvertFrom-Json
RLog ("review.json bytes=" + $t.Length)
RLog ("contains literal `"registry`": " + $t.Contains('"registry"'))
RLog ("contains riskReason: " + $t.Contains('riskReason'))
RLog ("files[].kind groups = " + ((($j.files | Group-Object kind | ForEach-Object { $_.Name + ':' + $_.Count })) -join ', '))
RLog ("files[].risk groups = " + ((($j.files | Group-Object risk | ForEach-Object { $_.Name + ':' + $_.Count })) -join ', '))
RLog ("files[].external groups = " + ((($j.files | Group-Object external | ForEach-Object { $_.Name + ':' + $_.Count })) -join ', '))
RLog ("top-level riskCounts = " + ($j.riskCounts | ConvertTo-Json -Compress))
RLog ("counts = " + ($j.counts | ConvertTo-Json -Compress))
RLog ("counts has 'listed' key = " + [bool]($j.counts.PSObject.Properties.Name -contains 'listed'))
RLog ("counts has 'totalFiles' key = " + [bool]($j.counts.PSObject.Properties.Name -contains 'totalFiles'))
foreach ($c in $j.candidates) {
  RLog ("review-cand {0} status={1} nPaths={2}" -f $c.id, $c.status, (@($c.paths).Count))
  $regPaths = @($c.paths | Where-Object { $_ -match '^HK' })
  if ($regPaths.Count -gt 0) { RLog ("   registry paths in this candidate: " + ($regPaths -join ' | ')) }
}
RLog '--- first 3 files[] entries (path/kind/risk) ---'
$j.files | Select-Object -First 3 | ForEach-Object { RLog ("   {0} kind={1} risk={2} external={3}" -f $_.path, $_.kind, $_.risk, $_.external) }
Write-Output 'see executions.log'
