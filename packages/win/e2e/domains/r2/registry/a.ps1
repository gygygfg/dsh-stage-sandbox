$ErrorActionPreference = "Continue"
$L = New-Object System.Collections.ArrayList
function W($s) { [void]$L.Add([string]$s) }
$Q = [char]34

$R = "C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-4c5d9889-7b7f-4132-931b-a26a3c1d924d"
W ("### ANALYZE " + (Get-Date -Format o) + " pid=" + $PID)

# A0 token
try {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  W ("A0 identity=" + $id.Name + " token=" + $id.Token + " isSystem=" + $id.IsSystem)
  $gs = @()
  foreach ($g in $id.Groups) {
    $n = $g.Value
    try { $n = $g.Translate([System.Security.Principal.NTAccount]).Value } catch {}
    $gs += ($n + "[denyOnly=" + $g.IsDenyOnly + "]")
  }
  W ("A0 groups=" + ($gs -join " ; "))
} catch { W ("A0 FAIL " + $_.Exception.Message) }

# A1 header
$rjRaw = Get-Content -LiteralPath "$R\review.json" -Raw
$j = $rjRaw | ConvertFrom-Json
W ("A1 bytes=" + $rjRaw.Length + " generatedAt=" + $j.generatedAt + " candidateId=" + $j.candidateId + " revision=" + $j.revision + " pending=" + $j.pending + " truncated=" + $j.truncated)
W ("A1 counts files=" + $j.counts.files + " listed=" + $j.counts.listed + " totalFiles=" + $j.counts.totalFiles + " additions=" + $j.counts.additions + " deletions=" + $j.counts.deletions + " frozenOnly=" + $j.counts.frozenOnly + " staleBaseline=" + $j.counts.staleBaseline)
W ("A1 riskCounts normal=" + $j.riskCounts.normal + " outside=" + $j.riskCounts.outside + " sensitive=" + $j.riskCounts.sensitive + " danger=" + $j.riskCounts.danger)
W ("A1 alertsCount=" + @($j.alerts).Count)
W ("A1 filesCount=" + @($j.files).Count + " candidatesCount=" + @($j.candidates).Count)
$tk = ($j | Get-Member -MemberType NoteProperty).Name -join ","
W ("A1 topKeys=" + $tk)

# A2 histograms
$fk = @{}; $fr = @{}
foreach ($f in @($j.files)) {
  $k = [string]$f.kind; if (-not $fk.ContainsKey($k)) { $fk[$k] = 0 }; $fk[$k]++
  $rr = [string]$f.risk; if (-not $fr.ContainsKey($rr)) { $fr[$rr] = 0 }; $fr[$rr]++
}
$s1 = ($fk.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Key + "=" + $_.Value }) -join " "
$s2 = ($fr.GetEnumerator() | Sort-Object Name | ForEach-Object { $_.Key + "=" + $_.Value }) -join " "
W ("A2 kindHistogram=" + $s1)
W ("A2 riskHistogram=" + $s2)
$f0k = ($j.files[0] | Get-Member -MemberType NoteProperty).Name -join ","
W ("A2 files0Keys=" + $f0k)
W ("A2 files0=" + ($j.files[0] | ConvertTo-Json -Compress -Depth 3))
$regKind = @($j.files | Where-Object { [string]$_.kind -match "reg" })
W ("A2 filesWithKindRegistry=" + $regKind.Count)
$outFiles = @($j.files | Where-Object { [string]$_.risk -eq "outside" })
W ("A2 filesWithRiskOutside=" + $outFiles.Count)
foreach ($x in ($outFiles | Select-Object -First 5)) { W ("A2   OUTSIDE>" + ($x | ConvertTo-Json -Compress -Depth 3)) }
$sens = @($j.files | Where-Object { [string]$_.risk -eq "sensitive" })
W ("A2 filesWithRiskSensitive=" + $sens.Count)
foreach ($x in ($sens | Select-Object -First 5)) { W ("A2   SENSITIVE>" + ($x | ConvertTo-Json -Compress -Depth 3)) }

# A3 raw markers
foreach ($p in @("registry", "HKCU", "HKLM", "HKEY_", "Software")) {
  W ("A3 count[" + $p + "]=" + ([regex]::Matches($rjRaw, [regex]::Escape($p))).Count)
}
$rxK = $Q + "kind" + $Q + "\s*:\s*" + $Q + "([^" + $Q + "]*)" + $Q
$kd = [regex]::Matches($rjRaw, $rxK)
$kv = ($kd | ForEach-Object { $_.Groups[1].Value } | Group-Object | ForEach-Object { $_.Name + "=" + $_.Count }) -join " "
W ("A3 rawKindValues=" + $kv)
$rxR = $Q + "risk" + $Q + "\s*:\s*" + $Q + "([^" + $Q + "]*)" + $Q
$rk = [regex]::Matches($rjRaw, $rxR)
$rv = ($rk | ForEach-Object { $_.Groups[1].Value } | Group-Object | ForEach-Object { $_.Name + "=" + $_.Count }) -join " "
W ("A3 rawRiskValues=" + $rv)
W ("A3 containsBackslashRegistry=" + $rjRaw.Contains("Software\Microsoft"))

# A4 candidates
$ci = 0
foreach ($c in @($j.candidates)) {
  $ci++
  $ps = @($c.paths)
  $rp = @($ps | Where-Object { $_ -match "^(HKCU|HKLM|HKCR|HKU|HKEY_)" })
  W ("A4 cand" + $ci + " id=" + $c.id + " status=" + $c.status + " paths=" + $ps.Count + " regPaths=" + $rp.Count + " applied=" + @($c.appliedPaths).Count)
  $n = 0
  foreach ($x in $rp) { $n++; if ($n -le 6) { W ("A4   REG>" + $x) } }
}

# A5 residue
foreach ($f in @("$R\review.json", "$R\queue.json", "$R\manifest.json")) {
  $t = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
  if ($null -eq $t) { W ("A5 " + $f + " MISSING"); continue }
  W ("A5 " + (Split-Path $f -Leaf) + " bytes=" + $t.Length + " hasWinStageR2=" + $t.Contains("WinStageR2") + " hasDshReg=" + $t.Contains("DshReg"))
}

# A6 candidates dir
$cf = @(Get-ChildItem -LiteralPath "$R\candidates" -Force -ErrorAction SilentlyContinue)
W ("A6 candidateFiles=" + $cf.Count)
foreach ($x in ($cf | Sort-Object LastWriteTime | Select-Object -Last 8)) { W ("A6 " + $x.Name + " " + $x.Length + "B " + $x.LastWriteTime.ToString("o")) }

# A7 overlays
$rd = "$R\registry"
$all = @(Get-ChildItem -LiteralPath $rd -Filter "overlay.*.hive" -Force -ErrorAction SilentlyContinue)
$pp = @($all | Where-Object { $_.Name -match "^overlay\.[0-9]+\.hive$" })
W ("A7 hivesTotal=" + $all.Count + " hivesPerPid=" + $pp.Count)
$sz = ($all | Group-Object Length | ForEach-Object { $_.Name + "B x" + $_.Count }) -join " "
W ("A7 sizes=" + $sz)
$jrn = Get-Item -LiteralPath "$rd\overlay.journal" -ErrorAction SilentlyContinue
$shr = Get-Item -LiteralPath "$rd\overlay.hive" -ErrorAction SilentlyContinue
W ("A7 journalSize=" + $jrn.Length + " journalMtime=" + $jrn.LastWriteTime.ToString("o"))
W ("A7 sharedHiveSize=" + $shr.Length + " sharedHiveMtime=" + $shr.LastWriteTime.ToString("o"))
$pids = @()
foreach ($x in $pp) { $pids += [int]($x.Name -replace "overlay\.", "" -replace "\.hive", "") }
W ("A7 pidRange=" + (($pids | Sort-Object) -join ","))

# A8 hive + journal content scan
$hit = 0
foreach ($h in $all) {
  $b = [System.IO.File]::ReadAllBytes($h.FullName)
  $u = [System.Text.Encoding]::Unicode.GetString($b)
  $a = [System.Text.Encoding]::ASCII.GetString($b)
  $m = ([regex]::Matches($u, "HKCU|HKLM|Software|WinStageR2")).Count + ([regex]::Matches($a, "HKCU|HKLM|Software|WinStageR2")).Count
  if ($m -gt 0) { $hit++; W ("A8 HIVE-HIT " + $h.Name + " matches=" + $m) }
}
W ("A8 hivesWithPathStrings=" + $hit + " of " + $all.Count)
$jb = [System.IO.File]::ReadAllBytes("$rd\overlay.journal")
$ju = [System.Text.Encoding]::Unicode.GetString($jb)
$ja = [System.Text.Encoding]::ASCII.GetString($jb)
foreach ($p in @("WinStageR2", "HKCU", "HKLM", "Python", "DshReg")) {
  $c1 = ([regex]::Matches($ju, [regex]::Escape($p))).Count
  $c2 = ([regex]::Matches($ja, [regex]::Escape($p))).Count
  W ("A8 journal[" + $p + "] utf16=" + $c1 + " ascii=" + $c2)
}

$L -join "`n" | Write-Output
