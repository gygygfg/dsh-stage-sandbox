$ErrorActionPreference='Continue'
$R='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-4c5d9889-7b7f-4132-931b-a26a3c1d924d'
$lines=New-Object System.Collections.ArrayList
function W($s){ [void]$lines.Add([string]$s) }
function Dump($t){ Write-Output "=== $t ===" }

W "### ANALYZE $(Get-Date -Format o) pid=$PID"

Dump 'A1 review.json header'
$rjRaw = Get-Content "$R\review.json" -Raw
$j = $rjRaw | ConvertFrom-Json
W "fileBytes=$($rjRaw.Length)"
W "generatedAt=$($j.generatedAt) candidateId=$($j.candidateId) revision=$($j.revision) pending=$($j.pending) truncated=$($j.truncated)"
W "counts: files=$($j.counts.files) listed=$($j.counts.listed) totalFiles=$($j.counts.totalFiles) additions=$($j.counts.additions) deletions=$($j.counts.deletions) frozenOnly=$($j.counts.frozenOnly) staleBaseline=$($j.counts.staleBaseline)"
W "riskCounts: normal=$($j.riskCounts.normal) outside=$($j.riskCounts.outside) sensitive=$($j.riskCounts.sensitive) danger=$($j.riskCounts.danger)"
W "alerts.count=$(@($j.alerts).Count) alerts=[$(($j.alerts) -join ' | ')]"
W "files.count=$(@($j.files).Count) candidates.count=$(@($j.candidates).Count)"
W "topLevelKeys=[$((($j | Get-Member -MemberType NoteProperty).Name) -join ',')]"

Dump 'A2 files[] kind/risk histogram'
$fk=@{}; $fr=@{}
foreach($f in @($j.files)){
  $k=[string]$f.kind; if(-not $fk.ContainsKey($k)){$fk[$k]=0}; $fk[$k]++
  $r=[string]$f.risk; if(-not $fr.ContainsKey($r)){$fr[$r]=0}; $fr[$r]++
}
W "kind: $(($fk.GetEnumerator()|Sort-Object Name|ForEach-Object{"$($_.Key)=$($_.Value)"}) -join ' ')"
W "risk: $(($fr.GetEnumerator()|Sort-Object Name|ForEach-Object{"$($_.Key)=$($_.Value)"}) -join ' ')"
W "file obj keys = [$((($j.files[0] | Get-Member -MemberType NoteProperty).Name) -join ',')]"
W "sample file[0] = $($j.files[0] | ConvertTo-Json -Compress -Depth 4)"
$regRows = @($j.files | Where-Object { [string]$_.kind -match 'reg' })
W "files[] with kind matching 'reg' = $($regRows.Count)"
$noteRows = @($j.files | Where-Object { [string]$_.note -match '注册表|registry' })
W "files[] with note matching 注册表/registry = $($noteRows.Count)"

Dump 'A3 raw-text registry markers inside review.json'
foreach($pat in @('"registry"','registry','HKCU','HKLM','HKEY_','"kind"','注册表')){
  $c=([regex]::Matches($rjRaw,[regex]::Escape($pat))).Count
  W "  occurrences of [$pat] = $c"
}
$kinds = [regex]::Matches($rjRaw,'"kind"\s*:\s*"([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Group-Object | ForEach-Object { "$($_.Name)=$($_.Count)" }
W "  all kind values in raw text: $($kinds -join ' ')"
$risks = [regex]::Matches($rjRaw,'"risk"\s*:\s*"([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Group-Object | ForEach-Object { "$($_.Name)=$($_.Count)" }
W "  all risk values in raw text: $($risks -join ' ')"
W "  contains substring 'registry' = $($rjRaw.Contains('registry'))"
W "  contains substring '\registry\' = $($rjRaw.Contains('\registry\'))"

Dump 'A4 candidates[] with registry-only paths'
$ci=0
foreach($c in @($j.candidates)){
  $ci++
  $ps=@($c.paths)
  $regp=@($ps | Where-Object { $_ -match '^(HKCU|HKLM|HKCR|HKU|HKEY_)' })
  W "  cand[$ci] id=$($c.id) status=$($c.status) paths=$($ps.Count) registryPaths=$($regp.Count) appliedPaths=$(@($c.appliedPaths).Count)"
  if($regp.Count -gt 0){ $regp | Select-Object -First 8 | ForEach-Object { W "      REG> $_" } }
}
Dump 'A5 self-test residue check: did any WinStageR2Test land anywhere?'
foreach($f in @("$R\review.json","$R\queue.json","$R\manifest.json")){
  $t = Get-Content $f -Raw -ErrorAction SilentlyContinue
  W "  $([System.IO.Path]::GetFileName($f)): WinStageR2Test=$($t -match 'WinStageR2Test') WinStageR2Probe=$($t -match 'WinStageR2Probe') registryKey=$($t.Contains('WinStageR2'))"
}
Dump 'A6 candidates dir listing (names only)'
$cd="$R\candidates"
if(Test-Path $cd){
  $cf=@(Get-ChildItem $cd -Force -ErrorAction SilentlyContinue)
  W "  candidate files = $($cf.Count)"
  $cf | Sort-Object LastWriteTime | Select-Object -Last 12 | ForEach-Object { W "   $($_.Name) $($_.Length)B $($_.LastWriteTime.ToString('o'))" }
} else { W "  candidates dir MISSING" }

Dump 'A7 registry overlay census + hive content scan'
$rd="$R\registry"
$all=@(Get-ChildItem $rd -Filter 'overlay.*.hive' -Force -ErrorAction SilentlyContinue)
$pp=@($all | Where-Object { $_.Name -match '^overlay\.\d+\.hive$' })
W "  overlay.*.hive total=$($all.Count) per-pid=$($pp.Count)"
W "  distinct sizes: $(($all | Group-Object Length | ForEach-Object{"$($_.Name)B x$($_.Count)"}) -join ' ')"
$jrn=Get-Item "$rd\overlay.journal" -ErrorAction SilentlyContinue
W "  overlay.journal size=$($jrn.Length) mtime=$($jrn.LastWriteTime.ToString('o'))"
$shr=Get-Item "$rd\overlay.hive" -ErrorAction SilentlyContinue
W "  shared overlay.hive size=$($shr.Length) mtime=$($shr.LastWriteTime.ToString('o'))"
W "  --- searching all overlay hives for registry path strings ---"
$hit=0; $tot=0
foreach($h in $all){
  $tot++
  $b=[System.IO.File]::ReadAllBytes($h.FullName)
  $s=[System.Text.Encoding]::Unicode.GetString($b)
  $s2=[System.Text.Encoding]::ASCII.GetString($b)
  $m = ([regex]::Matches($s,'HKCU|HKLM|Software|WinStageR2')).Count + ([regex]::Matches($s2,'HKCU|HKLM|Software|WinStageR2')).Count
  if($m -gt 0){ $hit++; W "   HIT $($h.Name) matches=$m" }
}
W "  hives scanned=$tot hives containing reg-path strings=$hit"
W "  --- journal content scan (binary read) ---"
$jb=[System.IO.File]::ReadAllBytes("$rd\overlay.journal")
$js=[System.Text.Encoding]::Unicode.GetString($jb)
$ja=[System.Text.Encoding]::ASCII.GetString($jb)
foreach($pat in @('WinStageR2','HKCU','HKLM','Software','DshReg')){
  $n1=([regex]::Matches($js,[regex]::Escape($pat))).Count
  $n2=([regex]::Matches($ja,[regex]::Escape($pat))).Count
  W "   journal [$pat] utf16=$n1 ascii=$n2"
}
$lines -join "`n" | Write-Output
