$ErrorActionPreference='Continue'
$R='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\registry\evidence'
$K='HKCU:\Software\WinStageR2Test'
$P='C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\registry'
$hash="$P\_hash.ps1"
@'
param([string]$Path)
if(Test-Path -LiteralPath $Path){
  $i=Get-Item -LiteralPath $Path
  $names=@($i.GetValueNames()|Sort-Object)
  $lines=@()
  foreach($n in $names){
    try{$k=$i.GetValueKind($n)}catch{$k='?'}
    $v=$i.GetValue($n,'','DoNotExpandEnvironmentNames')
    if($v -is [byte[]]){$v='HEX:'+(($v|ForEach-Object{$_.ToString('x2')}) -join '')}
    elseif($v -is [array]){$v='ARR:['+($v -join '|')+']'}
    else{$v='STR:'+[string]$v}
    $lines+="$n|$k|$v"
  }
  $payload=($lines -join "`n")
  $sha=[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))).Replace('-','')
  Write-Output "READ|$Path|exists=True|sha256=$sha|n=$($names.Count)"
  $lines|ForEach-Object{Write-Output "  $_"}
}else{Write-Output "READ|$Path|exists=False"}
'@ | Set-Content -Path $hash -Encoding UTF8

function Log($t){ Write-Output $t; Add-Content -Path "$R\..\executions.log" -Value $t -Encoding UTF8 }

Log "### A01-A04 ----- $(Get-Date -Format o) pid=$PID -----"
Log "A-PS-PARENT-PID=$PID"

Log "`n--- A01: HKCU PS provider write + readback ---"
if(Test-Path $K){Remove-Item $K -Recurse -Force}
New-Item -Path $K -Force | Out-Null
Log "A01 cmd: New-Item -Path '$K' -Force  -> Test-Path=$(Test-Path $K)"
New-ItemProperty -Path $K -Name 'Sz'    -Value 'winstage-r2'  -PropertyType String       -Force | Out-Null
New-ItemProperty -Path $K -Name 'Dw'    -Value 20261003       -PropertyType DWord        -Force | Out-Null
New-ItemProperty -Path $K -Name 'Qw'    -Value 9007199254740993 -PropertyType QWord      -Force | Out-Null
New-ItemProperty -Path $K -Name 'Bin'   -Value ([byte[]](0x01,0x02,0xFE,0xFF)) -PropertyType Binary -Force | Out-Null
New-ItemProperty -Path $K -Name 'Multi' -Value ([string[]]@('r2-a','r2-b','')) -PropertyType MultiString -Force | Out-Null
New-ItemProperty -Path $K -Name 'Exp'   -Value '%SystemRoot%\r2exp' -PropertyType ExpandString -Force | Out-Null
Log "A01 cmd: 6x New-ItemProperty (Sz/Dw/Qw/Bin/Multi/Exp)"
Log "A01 PS provider readback (Get-ItemProperty):"
$props = Get-ItemProperty -Path $K
foreach($n in @('Sz','Dw','Qw','Bin','Multi','Exp')){
  $v=$props.$n
  if($v -is [byte[]]){$v='HEX:'+(($v|ForEach-Object{$_.ToString('x2')}) -join '')}
  elseif($v -is [array]){$v='ARR:['+($v -join '|')+']'}
  Log "  PS  $n = $v  (type=$($v.GetType().Name))"
}
Log "A01 Get-Item GetValueKind map:"
$gi = Get-Item $K
foreach($n in @('Sz','Dw','Qw','Bin','Multi','Exp')){ Log "  kind($n) = $($gi.GetValueKind($n))" }
Log "A01 PASSTHRU-hash of full key (canonical):"
& pwsh -NoProfile -File $hash -Path "HKCU\Software\WinStageR2Test" 2>&1 | ForEach-Object { Log $_ }

Log "`n--- A02/A03 CTX: reg.exe exit codes in current ctx ---"
$r1 = & reg.exe query 'HKCU\Software\WinStageR2Test' 2>&1; $c1=$LASTEXITCODE
Log "A02 cmd: reg.exe query HKCU\Software\WinStageR2Test -> exit=$c1"
$r1 | ForEach-Object { Log "  reg> $_" }
$r2 = & reg.exe query 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion' /v ProductName 2>&1; $c2=$LASTEXITCODE
Log "A02b cmd: reg.exe query HKLM\...\CurrentVersion /v ProductName -> exit=$c2"
$r2 | ForEach-Object { Log "  reg> $_" }

Log "`n--- A04: CHILD pwsh -Command READS parent-written key (same ctx, shim enabled) ---"
$c1out = & pwsh -NoProfile -Command "if(Test-Path 'HKCU:\Software\WinStageR2Test'){'CHILD-PS-SEES-'+(Get-ItemProperty 'HKCU:\Software\WinStageR2Test').Sz}else{'CHILD-PS-CANNOT-SEE'}" 2>&1
Log "A04 cmd: pwsh -NoProfile -Command Test-Path HKCU:\Software\WinStageR2Test -> exit=$LASTEXITCODE"
$c1out | ForEach-Object { Log "  child-ps> $_" }
$c2out = & cmd.exe /c 'reg query HKCU\Software\WinStageR2Test & echo RC=%errorlevel%' 2>&1
Log "A04b cmd: cmd /c reg query HKCU\Software\WinStageR2Test -> exit=$LASTEXITCODE"
$c2out | ForEach-Object { Log "  child-cmd> $_" }

Log "`n--- A04c: count of per-process overlay hives in this session ---"
$regdir = Join-Path $env:DSH_REGSTAGE_ROOT 'registry'
$hives = @(Get-ChildItem $regdir -Filter 'overlay.*.hive' -Force -ErrorAction SilentlyContinue)
$plain = @($hives | Where-Object { $_.Name -match '^overlay\.\d+\.hive$' })
Log "STAGE cmd: (gci $regdir -Filter overlay.*.hive).Count -> all=$($hives.Count) per-pid=$($plain.Count)"
Log "  sample: $(($plain | Select-Object -First 5 | ForEach-Object{$_.Name}) -join ', ')"
$jr = Get-Item (Join-Path $regdir 'overlay.journal') -ErrorAction SilentlyContinue
Log "  overlay.journal size=$($jr.Length) mtime=$($jr.LastWriteTime.ToString('o'))"
$sh = Get-Item (Join-Path $regdir 'overlay.hive') -ErrorAction SilentlyContinue
Log "  overlay.hive (shared) size=$($sh.Length) mtime=$($sh.LastWriteTime.ToString('o'))"
Log "A-PS-PARENT-PID-END=$PID"
