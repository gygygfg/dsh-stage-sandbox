$ErrorActionPreference='Continue'
$root='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\pip'
$ev="$root\evidence"; $dl="$root\dl"
$LOG="$ev\runall2.log"
Add-Content $LOG -Value "===== RUN2 $(Get-Date -Format o) =====" -Encoding UTF8
function Say($s){ Add-Content -Path $LOG -Value ([string]$s) -Encoding UTF8; Write-Output $s }

Say "### PIP-06c integrity vs PyPI JSON for the CURRENT six version ###"
$jf="$dl\pypi_six.json"
& curl.exe -sS -L --max-time 45 -o $jf 'https://pypi.org/pypi/six/json' | Out-Null
$j=Get-Content $jf -Raw | ConvertFrom-Json
$ver=$j.info.version; Say "PYPI_LATEST=$ver"
$targets=@{}
foreach($u in $j.urls){ $targets[$u.filename]=$u.digests.sha256 }
$idx=(& curl.exe -sS -L --max-time 60 'https://pypi.tuna.tsinghua.edu.cn/simple/six/') 2>&1 | Out-String
Say ("TUNA_INDEX_BYTES=" + $idx.Length)
foreach($fn in $targets.Keys){
  $esc=[regex]::Escape($fn)
  $m=[regex]::Match($idx,('href="([^"]*' + $esc + ')#sha256=([0-9a-f]{64})"'))
  if(-not $m.Success){ Say "  $fn :: NOT FOUND in TUNA index"; continue }
  $href=$m.Groups[1].Value; $frag=$m.Groups[2].Value
  if($href -notmatch '^https?://'){ $href=('https://pypi.tuna.tsinghua.edu.cn/simple/six/' + $href) }
  $dest="$dl\six_$fn"
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $r=(& curl.exe -sS -L --max-time 90 -o $dest -w "http=%{http_code} size=%{size_download} speed_bps=%{speed_download}" $href) 2>&1 | Out-String
  $sw.Stop()
  $h=(Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  Say "  FILE=$fn"
  Say ("    downexit=$LASTEXITCODE ms=$([int]$sw.ElapsedMilliseconds) len=$((Get-Item $dest).Length) :: " + $r.Trim())
  Say "    DL_SHA256=$h"
  Say "    PYPI_JSON_SHA256=$($targets[$fn])  MATCH=$($h -eq $targets[$fn])"
  Say "    TUNA_INDEX_SHA256=$frag  MATCH=$($h -eq $frag)"
  Say "    HOST_OF_DOWNLOAD=$([Uri]::new($href).Host)"
}

Say ""
Say "### PIP-07b review.json / candidates: is pip.ini a candidate, and at what risk? ###"
$S1='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'
$rv="$S1\review.json"
Say ("review.json size=" + (Get-Item $rv).Length + " mtime=" + (Get-Item $rv).LastWriteTime.ToString('o'))
$rvj=Get-Content $rv -Raw | ConvertFrom-Json
Say ("top-level props: " + (($rvj | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name) -join ', '))
foreach($p in ($rvj | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name)){
  $v=$rvj.$p
  if($v -is [Array]){ Say ("  $p : array count=" + $v.Count) } elseif($v -is [string] -or $v -is [ValueType]){ Say ("  $p : " + $v) }
}
Say "--- candidates whose JSON mentions pip ---"
$hits=0
foreach($f in (Get-ChildItem "$S1\candidates" -Filter '*.json' -ErrorAction SilentlyContinue)){
  $t=Get-Content $f.FullName -Raw
  if($t -match 'pip'){ $hits++; Say ("  CAND " + $f.Name); Say ("    " + ($t -replace '\s+',' ').Substring(0,[Math]::Min(600,$t.Length))) }
}
Say "PIP_MENTIONING_CANDIDATES=$hits"
Say "--- explicit pip.ini paths in review.json raw ---"
$rvRaw=Get-Content $rv -Raw
$mm=[regex]::Matches($rvRaw,'[^"]*pip[^"]*')
Say ("PIP_PATH_MATCHES=" + $mm.Count)
$mm | Select-Object -First 10 | ForEach-Object { Say ("  M " + $_.Value) }

Say ""
Say "### PIP-07c real-disk vs staged ground truth ###"
$realIni='C:\Users\Administrator\AppData\Roaming\pip\pip.ini'
Say "REAL_DISK pip.ini exists(PS)=" + (Test-Path $realIni)
Say "REAL_DISK pip dir exists(PS)=" + (Test-Path 'C:\Users\Administrator\AppData\Roaming\pip')
Say "REAL_DISK _sandbox-tests\pip\mirror-conf\pip.ini exists(PS)=" + (Test-Path "$root\mirror-conf\pip.ini")
$gp='C:\Users\Administrator\AppData\Local\Programs\Python'
Say "REAL_DISK $gp exists=" + (Test-Path $gp)

Say ""
Say "### PIP-07d crash timeline alignment ###"
Say ("NOW=" + (Get-Date -Format o))
foreach($p in @(
 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-8b4a07b9-2dc4-412f-9714-cad55c37708f\staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive',
 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361\staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive'
)){ Say ("DIR $p exists=" + (Test-Path $p))
   if(Test-Path $p){ Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object { Say ("  " + $_.LastWriteTime.ToString('o') + " " + $_.Name) } } }
Say "--- real-disk ReportArchive: any Critical_powershell? ---"
$ra='C:\ProgramData\Microsoft\Windows\WER\ReportArchive'
$all=Get-ChildItem $ra -Force -ErrorAction SilentlyContinue
Say ("TOTAL_REAL_REPORT_ARCHIVE=" + $all.Count)
Say ("PREFIX_COUNTS:")
$all | Group-Object { ($_.Name -split '_')[0..1] -join '_' } | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object { Say ("  " + $_.Count + " " + $_.Name) }
Say ("REAL_CRITICAL_POWERSHELL=" + (@($all | Where-Object Name -match 'Critical_powershell')).Count)

Say ""
Say "### PIP-05 readiness probe: does TUNA serve a real wheel for a small pkg (build/rpds-py/six)? ###"
foreach($pkg in @('six','packaging','idna')){
  $r=(& curl.exe -sS -L --max-time 30 -o NUL -w "http=%{http_code} size=%{size_download} time=%{time_total}" "https://pypi.tuna.tsinghua.edu.cn/simple/$pkg/") 2>&1 | Out-String
  Say ("  simple/$pkg :: " + $r.Trim())
}
Say ""
Say "### RUN2 COMPLETE ###"
