$ErrorActionPreference='Continue'
$root='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\pip'
$ev="$root\evidence"
New-Item -ItemType Directory -Force -Path $ev | Out-Null
$L=New-Object System.Collections.Generic.List[string]
function Say($s){ $L.Add([string]$s); Write-Output $s }
$S8='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-8b4a07b9-2dc4-412f-9714-cad55c37708f'
$S1='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'

Say "### A. top-level layout of both sessions ###"
foreach($s in @($S1,$S8)){
  Say "--- $s"
  $names = (& cmd /v:on /c "dir /b `"$s`" 2>&1") 2>&1
  Say ("  entries: " + (($names | Out-String).Trim() -replace "`r?`n",' | '))
  foreach($sub in @('registry','staged','candidates','blobs','review.json','manifest.json','session.json')){
    $p=Join-Path $s $sub
    Say ("  $sub exists=" + (Test-Path $p))
  }
}

Say ""
Say "### B. %ALLUSERSPROFILE% literal dir forensics (STAGE) ###"
$lit = Join-Path $S8 'staged\fs\%ALLUSERSPROFILE%'
Say "literal_path=$lit exists=$(Test-Path $lit)"
if(Test-Path $lit){
  $raw = (& cmd /v:on /c "dir /s /b `"$lit`" 2>&1") 2>&1
  $arr=@($raw | Where-Object { $_ -and $_ -notmatch '^File Not Found' })
  Say "TOTAL_FILES=$($arr.Count)"
  $arr | ForEach-Object { Say ("  P " + $_) }
  Say "--- sizes+times ---"
  $raw2 = (& cmd /v:on /c "dir /s /-c `"$lit`" 2>&1") 2>&1
  ($raw2 | Select-Object -First 60) | ForEach-Object { Say ("  " + $_) }
} else { Say "literal dir NOT present" }
$lit1 = Join-Path $S1 'staged\fs\%ALLUSERSPROFILE%'
Say "same literal in eb7c901d exists=$(Test-Path $lit1)"

Say ""
Say "### C. does S8 staged tree touch the shared workspace / pip area? ###"
$ws8 = Join-Path $S8 'staged\fs\C\Users\Administrator\Desktop\WinStageSandbox'
Say "S8 workspace staged exists=$(Test-Path $ws8)"
if(Test-Path $ws8){
  $o=(& cmd /v:on /c "dir /s /b `"$ws8`" 2>&1") 2>&1
  $a=@($o | Where-Object { $_ -and $_ -notmatch '^File Not Found' })
  Say "S8_WORKSPACE_FILES=$($a.Count)"
  $a | Select-Object -First 40 | ForEach-Object { Say ("  " + $_) }
}

Say ""
Say "### D. WER / CrashDumps metadata (real disk, read-only, metadata only) ###"
foreach($d in @('C:\Users\Administrator\AppData\Local\CrashDumps','C:\ProgramData\Microsoft\Windows\WER\ReportArchive','C:\ProgramData\Microsoft\Windows\WER\ReportQueue','C:\ProgramData\Microsoft\Windows\WER\Temp')){
  Say "--- $d exists=$(Test-Path $d)"
  if(Test-Path $d){
    Get-ChildItem $d -Force -ErrorAction SilentlyContinue | Select-Object -First 25 | ForEach-Object {
      Say ("  " + $_.Mode + " " + $_.LastWriteTime.ToString('o') + " " + $_.Length + " " + $_.Name)
    }
  }
}

Say ""
Say "### E. staged-side WER in S8 (metadata only) ###"
$st8 = Join-Path $S8 'staged\fs\C\ProgramData\Microsoft\Windows\WER'
Say "staged WER exists=$(Test-Path $st8)"
if(Test-Path $st8){
  $o=(& cmd /v:on /c "dir /s /b `"$st8`" 2>&1") 2>&1
  @($o | Where-Object { $_ -and $_ -notmatch '^File Not Found' }) | ForEach-Object { Say ("  " + $_) }
}

Say ""
Say "### F. pip.ini presence in both staged trees ###"
foreach($s in @($S1,$S8)){
  foreach($rel in @('staged\fs\C\Users\Administrator\AppData\Roaming\pip\pip.ini','staged\fs\%APPDATA%\pip\pip.ini')){
    $p=Join-Path $s $rel
    Say "  $rel in $(Split-Path $s -Leaf) exists=$(Test-Path $p)"
  }
}
$L -join "`r`n" | Set-Content "$ev\stage_forensics_raw.txt" -Encoding UTF8
Say "### FORENSICS DONE ###"
