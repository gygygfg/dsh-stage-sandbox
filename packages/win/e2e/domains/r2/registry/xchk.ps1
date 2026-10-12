param([string]$OutFile = 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\registry\evidence\zz-out.txt')
$ErrorActionPreference='Continue'
$L = New-Object System.Collections.ArrayList
function W($s){ [void]$L.Add([string]$s) }
function Cap([string]$exe,[string]$argline){
  try{
    $so = & $exe $argline 2>&1 | Out-String
    $ec = $LASTEXITCODE
    return "EXIT=$ec`n$so"
  }catch{ return "EXIT=THROW $($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
W "### XCHK $(Get-Date -Format o) pid=$PID"
W "hostname=$([System.Environment]::MachineName) user=$([System.Environment]::UserName) is64=$([System.Environment]::Is64BitProcess)"
W ""
W "=== X1 safe parent-key subkey WRITE (HKCU\Software\WinStageR2Test) ==="
foreach($k in @('HKCU:\Software\WinStageR2Test','HKCU:\Software\WinStageR2Test\Sub')){
  try{ New-Item -Path $k -Force -ErrorAction Stop | Out-Null; W "  WRITE-OK   $k" }
  catch{ W "  WRITE-FAIL $k :: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
W ""
W "=== X2 safe parent-key VALUE write ==="
try{
  New-ItemProperty -Path 'HKCU:\Software\WinStageR2Test' -Name 'Smoke' -Value 'r2-smoke' -PropertyType String -Force -ErrorAction Stop | Out-Null
  $v=(Get-ItemProperty 'HKCU:\Software\WinStageR2Test').Smoke
  W "  VALUE-WRITE-OK readback='$v'"
}catch{ W "  VALUE-WRITE-FAIL :: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
W ""
W "=== X3 READ-only ground truth via PS provider ==="
foreach($k in @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion','HKCU:\Software','HKLM:\SOFTWARE\WinStageR2Test','HKCU:\Software\WinStageR2Test')){
  try{ if(Test-Path $k){ W "  READ-OK   $k" } else { W "  READ-MISS $k" } }
  catch{ W "  READ-FAIL $k :: $($_.Exception.GetType().Name): $($_.Exception.Message)" }
}
try{ $pn=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop).ProductName; W "  ProductName = $pn" }catch{ W "  ProductName FAIL: $($_.Exception.Message)" }
W ""
W "=== X4 child process: cmd.exe /c reg query (plain, shim-enabled ctx) ==="
W (Cap 'cmd.exe' '/c reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ProductName & echo RC=%errorlevel%')
W ""
W "=== X5 child process: cmd.exe /c reg ADD (write via reg.exe) ==="
W (Cap 'cmd.exe' '/c reg add "HKCU\Software\WinStageR2Test" /v CmdSz /t REG_SZ /d cmd-written /f & echo RC=%errorlevel%')
W ""
W "=== X6 child process: same cmd.exe, reg QUERY the key just added ==="
W (Cap 'cmd.exe' '/c reg query "HKCU\Software\WinStageR2Test" /v CmdSz & echo RC=%errorlevel%')
W ""
W "=== X7 child process: WINSTAGE_SHIM_DISABLE=1 -> HOST truth ==="
$env:WINSTAGE_SHIM_DISABLE='1'
W (Cap 'cmd.exe' '/c reg query "HKCU\Software\WinStageR2Test" /v CmdSz & echo RC=%errorlevel%')
W (Cap 'cmd.exe' '/c reg query "HKCU\Software\WinStageR2Test" & echo RC=%errorlevel%')
Remove-Item Env:\WINSTAGE_SHIM_DISABLE -ErrorAction SilentlyContinue
W ""
W "=== X8 overlay hive census ==="
$rd='C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-4c5d9889-7b7f-4132-931b-a26a3c1d924d\registry'
$all=@(Get-ChildItem $rd -Filter 'overlay.*.hive' -Force -ErrorAction SilentlyContinue)
$pp=@($all|Where-Object{$_.Name -match '^overlay\.\d+\.hive$'})
W "  overlay.*.hive total=$($all.Count) per-pid=$($pp.Count)"
W "  journal size=$((Get-Item "$rd\overlay.journal" -ErrorAction SilentlyContinue).Length)"
W "  shared overlay.hive mtime=$((Get-Item "$rd\overlay.hive" -ErrorAction SilentlyContinue).LastWriteTime.ToString('o'))"
$L -join "`n" | Set-Content -Path $OutFile -Encoding UTF8
$L -join "`n" | Write-Output
