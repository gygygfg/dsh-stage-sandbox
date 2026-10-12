$ErrorActionPreference='Continue'
$root='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\pip'
$ev="$root\evidence"; $dl="$root\dl"
New-Item -ItemType Directory -Force -Path $ev,$dl,"$root\mirror-conf" | Out-Null
$L=New-Object System.Collections.Generic.List[string]
function Say($s){ $L.Add($s); Write-Output $s }

Say "### PIP-02 get-pip.py from CN mirrors  ($(Get-Date -Format o)) ###"
$gpUrls=@(
 'https://pypi.tuna.tsinghua.edu.cn/get-pip.py',
 'https://mirrors.aliyun.com/pypi/get-pip.py',
 'https://mirrors.ustc.edu.cn/pypi/get-pip.py',
 'https://mirrors.cloud.tencent.com/pypi/get-pip.py',
 'https://bootstrap.pypa.io/get-pip.py'
)
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
if($got){
  $h=(Get-FileHash "$dl\get-pip.py" -Algorithm SHA256).Hash
  $first=(Get-Content "$dl\get-pip.py" -TotalCount 3) -join ' | '
  Say "SUCCESS get-pip.py from $got"
  Say "SIZE=$((Get-Item "$dl\get-pip.py").Length) SHA256=$h"
  Say "HEAD=$first"
  Say "WRITE-SHA == READBACK-SHA : $($h -eq (Get-FileHash "$dl\get-pip.py" -Algorithm SHA256).Hash)"
} else { Say "FAILED: no get-pip.py mirror reachable" }

Say ""
Say "### PIP-06 integrity: six wheel from TUNA simple index ###"
$idx=(& curl.exe -sS -L --max-time 60 'https://pypi.tuna.tsinghua.edu.cn/simple/six/') 2>&1 | Out-String
$frag=$null; $href=$null
$m=[regex]::Match($idx,'href="([^"]*six-[^"#]*\.whl)#sha256=([0-9a-f]{64})"')
if($m.Success){ $href=$m.Groups[1].Value; $frag=$m.Groups[2].Value }
else {
  $m2=[regex]::Match($idx,'href="([^"]*six-[^"]*\.whl)"')
  if($m2.Success){ $href=$m2.Groups[1].Value }
}
Say "IDX_BYTES=$($idx.Length) HREF=$href IDX_SHA256=$frag"
if(-not $href){ Say "FAILED: could not parse six wheel href from TUNA simple index" }
else {
  if($href -notmatch '^https?://'){ $href=('https://pypi.tuna.tsinghua.edu.cn/simple/six/' + $href) }
  $wh="$dl\six.whl"
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $r=(& curl.exe -sS -L --max-time 90 -o $wh -w "http=%{http_code} size=%{size_download} speed_bps=%{speed_download} url_eff=%{url_effective}" $href) 2>&1 | Out-String
  $sw.Stop()
  $len = if(Test-Path $wh){ (Get-Item $wh).Length } else { -1 }
  Say ("DOWNLOAD exit=$LASTEXITCODE ms=$([int]$sw.ElapsedMilliseconds) len=$len :: " + $r.Trim())
  $whHash=(Get-FileHash $wh -Algorithm SHA256).Hash.ToLower()
  Say "WHEEL_SHA256=$whHash"
  if($frag){ Say "MIRROR_INDEX_SHA256=$frag  MATCH=$($whHash -eq $frag)" }
}
Say ""
Say "### PIP-06b PyPI JSON API digests ###"
foreach($api in @('https://pypi.org/pypi/six/json','https://pypi.tuna.tsinghua.edu.cn/pypi/six/json')){
  $jf="$dl\six_json.txt"
  $r=(& curl.exe -sS -L --max-time 45 -o $jf -w "http=%{http_code} size=%{size_download}" $api) 2>&1 | Out-String
  $jl = if(Test-Path $jf){ (Get-Item $jf).Length } else { -1 }
  Say ("JSON exit=$LASTEXITCODE len=$jl $api :: " + $r.Trim())
  if($jl -gt 100){
    try{
      $j=Get-Content $jf -Raw | ConvertFrom-Json
      Say ("  version=" + $j.info.version)
      foreach($u in $j.urls){ Say ("  file=" + $u.filename + " sha256=" + $u.digests.sha256 + " size=" + $u.size) }
      Set-Content "$dl\six_json_$(if($api -match 'tuna'){'tuna'}else{'org'}).json" -Value (Get-Content $jf -Raw) -Encoding UTF8
    }catch{ Say ("  JSON_PARSE_FAIL: " + $_.Exception.Message) }
  }
}
Say ""
Say "### PIP-04 global CN mirror pip.ini ###"
$iniCfg=@"
[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn
               mirrors.aliyun.com
"@
$appdataIni = Join-Path $env:APPDATA 'pip\pip.ini'
New-Item -ItemType Directory -Force -Path (Split-Path $appdataIni) | Out-Null
Set-Content -Path $appdataIni -Value $iniCfg -Encoding ASCII
$localIni = "$root\mirror-conf\pip.ini"
Set-Content -Path $localIni -Value $iniCfg -Encoding ASCII
foreach($p in @($appdataIni,$localIni)){
  $w=(Get-FileHash $p -Algorithm SHA256).Hash
  $rb=(Get-Content $p -Raw)
  $r=(Get-FileHash $p -Algorithm SHA256).Hash
  Say "INI $p"
  Say "  write_sha256=$w  readback_sha256=$r  WRITE==READBACK=$($w -eq $r)"
  Say "  content: " + ($rb -replace "`r?`n",' / ')
}
Say ("APPDATA=" + $env:APPDATA)
$L -join "`r`n" | Set-Content "$ev\pip02_04_06_raw.txt" -Encoding UTF8
Say ""
Say "### PILOT DONE -> $ev\pip02_04_06_raw.txt ###"
