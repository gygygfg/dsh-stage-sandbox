. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
$ErrorActionPreference = 'Continue'
$S = New-Object System.Collections.ArrayList
function Say([string]$t) { [void]$S.Add($t); Write-Output $t }
RSec 'REG-05c/06/07' 'finish REG-05, overlay state, cross-process visibility'
$R1 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$R2 = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
$ev2 = Join-Path $script:EvDir 'reg05c-06-07-summary.txt'

# --- finish 5.2 cleanup ---
Remove-ItemProperty -Path $R1 -Name DshRegT05Run -ErrorAction SilentlyContinue
Say ("5.2 cleanup: HKCU Run DshRegT05Run present=" + ((Get-Item -LiteralPath $R1).GetValueNames() -contains 'DshRegT05Run'))

# --- 5.3 HKLM Run ---
Say ("5.3 HKLM Run existing values = [" + ((Get-Item -LiteralPath $R2).GetValueNames() -join ', ') + "]")
$e = ''
try { New-ItemProperty -Path $R2 -Name DshRegT05RunHKLM -Value 'cmd /c exit' -PropertyType String -ErrorAction Stop | Out-Null } catch { $e = $_.Exception.Message }
Say ("5.3 ADD HKLM Run DshRegT05RunHKLM = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK (staged)' }))
if (-not $e) { Say ("5.3 PS-readback = [" + ((Get-ItemProperty -LiteralPath $R2).DshRegT05RunHKLM) + "]") }
& cmd.exe /d /c 'reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v DshRegT05RunHKLM' > $null 2>&1
Say ("5.3 reg.exe query exit = " + $LASTEXITCODE + " (nonzero = real hive does not have it)")
Remove-ItemProperty -Path $R2 -Name DshRegT05RunHKLM -ErrorAction SilentlyContinue
Say ("5.3 cleanup: present=" + ((Get-Item -LiteralPath $R2).GetValueNames() -contains 'DshRegT05RunHKLM') + " runKeyValues=[" + ((Get-Item -LiteralPath $R2).GetValueNames() -join ', ') + "]")

# --- 5.4 file association ---
$C1 = 'HKCU:\Software\Classes\.dshtest'
Remove-Item -LiteralPath $C1 -Recurse -Force -ErrorAction SilentlyContinue
$e = ''
try {
  New-Item -Path $C1 -Force -ErrorAction Stop | Out-Null
  New-ItemProperty -Path $C1 -Name '(default)' -Value 'DshRegT05.Assoc' -PropertyType String -ErrorAction Stop | Out-Null
} catch { $e = $_.Exception.Message }
Say ("5.4 CREATE HKCU\Software\Classes\.dshtest = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK' }))
Say ("5.4 PS-readback = [" + (RCanon $C1).text + "]")
& cmd.exe /d /c 'reg query "HKCU\Software\Classes\.dshtest"' > $null 2>&1
Say ("5.4 reg.exe query exit = " + $LASTEXITCODE + " (nonzero = real hive clean)")
Remove-Item -LiteralPath $C1 -Recurse -Force -ErrorAction SilentlyContinue
Say ("5.4 cleanup Test-Path=" + (Test-Path -LiteralPath $C1))

# --- leftovers ---
Say '--- LEFTOVERS ---'
foreach ($p in @('HKCU:\Software\DshRegT01','HKCU:\Software\DshRegT01C','HKLM:\Software\DshRegT02','HKLM:\SYSTEM\CurrentControlSet\Services\DshRegSvcT05','HKCU:\Software\Classes\.dshtest','HKCU:\Software\DshRegT07')) {
  Say ("LEFTOVER {0} exists={1}" -f $p, (Test-Path -LiteralPath $p))
}
Say ("LEFTOVER HKCU Run values=[" + ((Get-Item -LiteralPath $R1).GetValueNames() -join ', ') + "]")
Say ("LEFTOVER HKLM Run values=[" + ((Get-Item -LiteralPath $R2).GetValueNames() -join ', ') + "]")

# --- real hive file mtimes (zero-real-write evidence) ---
foreach ($h in @('C:\Users\Administrator\NTUSER.DAT','C:\Windows\System32\config\SOFTWARE','C:\Windows\System32\config\SYSTEM')) {
  try { $i = Get-Item -LiteralPath $h -Force; Say ("HIVE {0} size={1} mtime={2}" -f $h, $i.Length, $i.LastWriteTime.ToString('o')) } catch { Say ("HIVE $h ERR " + $_.Exception.Message) }
}

# --- REG-06 overlay state ---
Say '--- REG-06 overlay artifacts ---'
foreach ($f in @('overlay.state.json','host-capture.json')) {
  $p = Join-Path $script:Stage ("registry\$f")
  $c = (Get-Content -LiteralPath $p -Raw) -replace "`r?`n", ' '
  Say ("STAGE {0} => {1}" -f $f, $c)
}
$jpi = Get-Item -LiteralPath (Join-Path $script:Stage 'registry\overlay.journal')
Say ("STAGE overlay.journal bytes={0} mtime={1}" -f $jpi.Length, $jpi.LastWriteTime.ToString('o'))
$hives = Get-ChildItem -LiteralPath (Join-Path $script:Stage 'registry') -File | Where-Object Name -like 'overlay.*.hive'
Say ("STAGE per-process hive count={0} ; my pid={1} ownHive={2}" -f $hives.Count, $PID, (Test-Path -LiteralPath (Join-Path $script:Stage ("registry\overlay.{0}.hive" -f $PID))))
$cands = Get-ChildItem -LiteralPath (Join-Path $script:Stage 'candidates') -File | Where-Object Name -like 'cs_*.json'
Say ("STAGE candidate files={0}" -f $cands.Count)
foreach ($l in (RCand 'DshReg' | Select-Object -First 20)) { Say ("RCAND " + $l) }
& cmd.exe /d /c 'findstr /m "shared hive unusable" "C:\Users\Administrator\Desktop\WinStageSandbox\shim.log"' > $null 2>&1
Say ("shim.log shared-hive-unusable match exit=" + $LASTEXITCODE)

# --- REG-07 cross-process visibility (controlled) ---
Say '--- REG-07 cross-process ---'
$T7 = 'HKCU:\Software\DshRegT07'
Remove-Item -LiteralPath $T7 -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path $T7 -Force | Out-Null
New-ItemProperty -Path $T7 -Name V -Value 'written-by-parent' -PropertyType String | Out-Null
Say ("PARENT(pid={0}) wrote HKCU\Software\DshRegT07\V ; parent reads=[" + ((Get-ItemProperty -LiteralPath $T7).V) + "]" -f $PID)
$childOut = & powershell.exe -NoProfile -Command "if (Test-Path 'HKCU:\Software\DshRegT07') { 'CHILD-SEES-T07' } else { 'CHILD-CANNOT-SEE-T07' }; (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsSelfHost\FIDs').AllFlights" 2>&1 | Out-String
Say ("CHILD-POWERSHELL output=[" + (($childOut -replace "`r?`n", ' | ').Trim()) + "]")
& cmd.exe /d /c 'reg query "HKCU\Software\DshRegT07" /v V' > $null 2>&1
Say ("CHILD-REG.EXE query T07 exit=" + $LASTEXITCODE + " (1 = cannot see parent's staged value)")
& cmd.exe /d /c 'reg query "HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs" /v AllFlights' > $null 2>&1
$regAll = & cmd.exe /d /c 'reg query "HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs" /v AllFlights' 2>&1 | Out-String
Say ("CHILD-REG.EXE AllFlights=[" + ((($regAll -split "`r?`n") | Where-Object { $_ -match 'AllFlights' } | Select-Object -First 1) + '').Trim() + "]")
Say ("PARENT-PS AllFlights=[" + ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsSelfHost\FIDs').AllFlights) + "]")
$real = & cmd.exe /d /c 'reg query "HKCU\Software\DshRegT07" /v V' 2>&1 | Out-String
Say ("REAL-HIVE T07 visible via reg.exe = " + ([bool]($real -match 'written-by-parent')))
& cmd.exe /d /c 'reg delete "HKCU\Software\DshRegT07" /f' > $null 2>&1
Remove-Item -LiteralPath $T7 -Recurse -Force -ErrorAction SilentlyContinue
Say ("T07 cleanup Test-Path=" + (Test-Path -LiteralPath $T7))
$S | Set-Content -LiteralPath $ev2 -Encoding UTF8
Say 'DONE'
