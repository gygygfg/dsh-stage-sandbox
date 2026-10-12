$ErrorActionPreference='Continue'
$root='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\pip'
$ev="$root\evidence"; $dl="$root\dl"
New-Item -ItemType Directory -Force -Path $ev,$dl,"$root\mirror-conf" | Out-Null
$LOG="$ev\runall.log"
Add-Content $LOG -Value "===== RUN $(Get-Date -Format o) =====" -Encoding UTF8
function Say($s){ Add-Content -Path $LOG -Value ([string]$s) -Encoding UTF8; Write-Output $s }

Say "### PIP-01b interpreter inventory (recheck) ###"
foreach($t in @('python.exe','python3.exe','py.exe','pip.exe','pip3.exe')){ $c=Get-Command $t -ErrorAction SilentlyContinue; Say ("{0} -> {1}" -f $t, $(if($c){$c.Source}else{'NOT FOUND'})) }
foreach($p in @('C:\Users\Administrator\AppData\Local\Programs\Python','C:\Python39','C:\Python310','C:\Python311','C:\Python312','C:\Python313','C:\ProgramData\Anaconda3','C:\ProgramData\miniconda3')){ Say ("  path $p exists=" + (Test-Path $p)) }
$o=(& cmd /v:on /c "python --version 2>&1 & echo __EXIT=!errorlevel!") 2>&1; Say ("  python --version :: " + (($o|Out-String).Trim() -replace "`r?`n",' / '))
$stub='C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe'
if(Test-Path $stub){ Say ("  stub python.exe length=" + (Get-Item $stub).Length + " attrs=" + (Get-Item $stub).Attributes) }

Say ""
Say "### PIP-02 get-pip.py from CN mirrors ###"
$gpUrls=@('https://pypi.tuna.tsinghua.edu.cn/get-pip.py','https://mirrors.aliyun.com/pypi/get-pip.py','https://mirrors.ustc.edu.cn/pypi/get-pip.py','https://bootstrap.pypa.io/get-pip.py')
$got=$null
foreach($u in $gpUrls){
  $f="$dl\get-pip.py"
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $r=(& curl.exe -sS -L --max-time 60 -o $f -w "http=%{http_code} size=%{size_download} speed_bps=%{speed_download} ct=%{content_type}" $u) 2>&1 | Out-String
  $sw.Stop(); $code=$LASTEXITCODE
  $len = if(Test-Path $f){ (Get-Item $f).Length } else { -1 }
  Say ("ATTEMPT exit=$code ms=$([int]$sw.ElapsedMilliseconds) len=$len url=$u :: " + $r.Trim())
  if($code -eq 0 -and $len -gt 1000){ $got=$u; break }
}
if($got){ $h=(Get-FileHash "$dl\get-pip.py" -Algorithm SHA256).Hash
  Say "SUCCESS url=$got size=$((Get-Item "$dl\get-pip.py").Length) sha256=$h"
  Say ("HEAD=" + ((Get-Content "$dl\get-pip.py" -TotalCount 2) -join ' | ')) } else { Say "FAIL: no get-pip.py mirror reachable" }

Say ""
Say "### PIP-06 six wheel from TUNA simple index + hash compare ###"
$idx=(& curl.exe -sS -L --max-time 60 'https://pypi.tuna.tsinghua.edu.cn/simple/six/') 2>&1 | Out-String
$m=[regex]::Match($idx,'href="([^"]*six-[^"#]*\.whl)#sha256=([0-9a-f]{64})"')
Say ("IDX_BYTES=" + $idx.Length)
if($m.Success){
  $href=$m.Groups[1].Value; $frag=$m.Groups[2].Value
  if($href -notmatch '^https?://'){ $href=('https://pypi.tuna.tsinghua.edu.cn/simple/six/' + $href) }
  Say "HREF=$href"; Say "MIRROR_INDEX_SHA256=$frag"
  $wh="$dl\six.whl"; $sw=[Diagnostics.Stopwatch]::StartNew()
  $r=(& curl.exe -sS -L --max-time 90 -o $wh -w "http=%{http_code} size=%{size_download} speed_bps=%{speed_download}" $href) 2>&1 | Out-String
  $sw.Stop()
  Say ("DL exit=$LASTEXITCODE ms=$([int]$sw.ElapsedMilliseconds) len=$((Get-Item $wh).Length) :: " + $r.Trim())
  $whh=(Get-FileHash $wh -Algorithm SHA256).Hash.ToLower()
  Say "DOWNLOADED_SHA256=$whh"
  Say "HASH_MATCH_MIRROR_INDEX=$($whh -eq $frag)"
} else { Say "FAIL: could not parse six wheel href (idx preview: " + $idx.Substring(0,[Math]::Min(300,$idx.Length)) + ")" }
Say "--- PyPI JSON API digests ---"
foreach($api in @('https://pypi.org/pypi/six/json','https://pypi.tuna.tsinghua.edu.cn/pypi/six/json')){
  $jf="$dl\six_json_$([regex]::Replace($api,'[^a-zA-Z0-9]','_')).json"
  $r=(& curl.exe -sS -L --max-time 45 -o $jf -w "http=%{http_code} size=%{size_download}" $api) 2>&1 | Out-String
  Say ("JSON exit=$LASTEXITCODE file=$([IO.Path]::GetFileName($jf)) $api :: " + $r.Trim())
  if((Test-Path $jf) -and (Get-Item $jf).Length -gt 100){
    try{ $j=Get-Content $jf -Raw|ConvertFrom-Json; Say ("  version=" + $j.info.version)
      foreach($u in $j.urls){ Say ("  file=" + $u.filename + " sha256=" + $u.digests.sha256 + " size=" + $u.size) } }catch{ Say ("  PARSE_FAIL " + $_.Exception.Message) }
  }
}

Say ""
Say "### PIP-04 global CN mirror pip.ini ###"
$iniCfg="[global]`r`nindex-url = https://pypi.tuna.tsinghua.edu.cn/simple`r`ntrusted-host = pypi.tuna.tsinghua.edu.cn`r`n               mirrors.aliyun.com`r`n"
$appdataIni=Join-Path $env:APPDATA 'pip\pip.ini'
New-Item -ItemType Directory -Force -Path (Split-Path $appdataIni) | Out-Null
Set-Content -Path $appdataIni -Value $iniCfg -Encoding ASCII
$localIni="$root\mirror-conf\pip.ini"; Set-Content -Path $localIni -Value $iniCfg -Encoding ASCII
Say "APPDATA=$env:APPDATA"
foreach($p in @($appdataIni,$localIni)){
  $w=(Get-FileHash $p -Algorithm SHA256).Hash; $rb=Get-Content $p -Raw; $rbh=(Get-FileHash $p -Algorithm SHA256).Hash
  Say "INI $p"
  Say "  WRITE_SHA256=$w"; Say "  READBACK_SHA256=$rbh"; Say "  WRITE_EQ_READBACK=$($w -eq $rbh)"
  Say ("  CONTENT=" + ($rb -replace "`r?`n",' / '))
}
Say ""
Say "### PIP-04b pip config list / debug (expected: interpreter missing) ###"
foreach($c in @('pip config list','pip config debug','python -m pip config list','python -m pip debug --verbose')){
  $o=(& cmd /v:on /c "$c 2>&1 & echo __EXIT=!errorlevel!") 2>&1
  Say ("CMD: $c :: " + (($o|Out-String).Trim() -replace "`r?`n",' / '))
}

Say ""
Say "### PIP-07 STAGE forensics ###"
$S8='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-8b4a07b9-2dc4-412f-9714-cad55c37708f'
$S1='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'
foreach($s in @($S1,$S8)){
  Say "--- session $(Split-Path $s -Leaf)"
  foreach($sub in @('registry','staged','candidates','blobs','review.json','manifest.json')){ Say ("  $sub exists=" + (Test-Path (Join-Path $s $sub))) }
}
$lit=Join-Path $S8 'staged\fs\%ALLUSERSPROFILE%'
Say "LITERAL_DIR=$lit exists=$(Test-Path $lit)"
if(Test-Path $lit){
  $arr=@(Get-ChildItem -LiteralPath $lit -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName + ' len=' + $_.Length + ' mtime=' + $_.LastWriteTime.ToString('o') })
  Say "LITERAL_DIR_FILE_COUNT=$($arr.Count)"
  $arr|ForEach-Object{ Say ("  F " + $_) }
} else { Say "literal dir NOT present" }
Say ("same literal in EB7 exists=" + (Test-Path (Join-Path $S1 'staged\fs\%ALLUSERSPROFILE%')))
Say "--- expand-check: does shim expand %ProgramData% but not %ALLUSERSPROFILE%? ---"
Say ("  S8 staged C\ProgramData\Microsoft\Windows\WER exists=" + (Test-Path (Join-Path $S8 'staged\fs\C\ProgramData\Microsoft\Windows\WER')))
$pdt=Join-Path $S8 'staged\fs\C\ProgramData\Microsoft\Windows\WER'
if(Test-Path $pdt){ ((& cmd /v:on /c "dir /s /b `"$pdt`" 2>&1") 2>&1|Where-Object{$_ -and $_ -notmatch '^File Not Found'})|ForEach-Object{ Say ("  PD " + $_) } }
Say "--- pip.ini in staged trees ---"
foreach($s in @($S1,$S8)){ foreach($rel in @('staged\fs\C\Users\Administrator\AppData\Roaming\pip\pip.ini','staged\fs\%APPDATA%\pip\pip.ini')){
  $p=Join-Path $s $rel; Say ("  $(Split-Path $s -Leaf) :: $rel exists=" + (Test-Path $p)) } }
Say "--- CrashDumps / WER metadata (real disk, read-only) ---"
foreach($d in @('C:\Users\Administrator\AppData\Local\CrashDumps','C:\ProgramData\Microsoft\Windows\WER\ReportArchive','C:\ProgramData\Microsoft\Windows\WER\ReportQueue')){
  Say ("DIR $d exists=" + (Test-Path $d))
  if(Test-Path $d){ Get-ChildItem $d -Force -ErrorAction SilentlyContinue|Select-Object -First 20|ForEach-Object{ Say ("  " + $_.Mode + " " + $_.LastWriteTime.ToString('o') + " len=" + $_.Length + " " + $_.Name) } }
}
Say ""
Say "### RUNALL COMPLETE $(Get-Date -Format o) ###"
