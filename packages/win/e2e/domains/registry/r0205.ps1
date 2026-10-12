. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
$ErrorActionPreference = 'Continue'
RSec 'REG-02..05' 'HKLM write, read-through, real-value modify, high-risk probes'
$ev = Join-Path $script:EvDir 'reg02-05-summary.txt'
$S = New-Object System.Collections.ArrayList
function Say([string]$t) { [void]$S.Add($t); Write-Output $t; RLog $t }

# compact cmd runner: returns exit code + first non-empty line of output
function Cmd2([string]$label, [string]$cmd) {
  $o = & cmd.exe /d /c $cmd 2>&1 | Out-String
  $code = $LASTEXITCODE
  $first = (($o -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  Say ("CMD  {0}`texit={1}`tfirst=[{2}]" -f $label, $code, (($first + '') -replace '\s+', ' ').Trim())
  return @{ exit = $code; out = $o }
}
function CandLine([string]$filter) {
  $c = RCand $filter
  if (-not $c) { Say ("CAND {0}`t<none>" -f $filter); return }
  foreach ($l in $c) { Say ("CAND " + $l) }
}

# ---------------- REG-02 HKLM ----------------
Say '--- REG-02 HKLM write ---'
$K = 'HKLM:\Software\DshRegT02'
Remove-Item -LiteralPath $K -Recurse -Force -ErrorAction SilentlyContinue
Say ("PS-Test-Path-before=" + (Test-Path -LiteralPath $K))
$err2 = ''
try { New-Item -Path $K -Force -ErrorAction Stop | Out-Null } catch { $err2 = $_.Exception.Message }
Say ("PS-CREATE-HKLM-key=" + $(if ($err2) { 'ERROR: ' + $err2 } else { 'OK' }))
$err3 = ''
try { New-ItemProperty -Path $K -Name Sz -Value 'hklm-sz' -PropertyType String -ErrorAction Stop | Out-Null } catch { $err3 = $_.Exception.Message }
Say ("PS-CREATE-HKLM-value-Sz=" + $(if ($err3) { 'ERROR: ' + $err3 } else { 'OK' }))
Say ("PS-readback-canon=" + (RCanon $K).text + " sha=" + (RCanon $K).sha)
Cmd2 'reg query HKLM\Software\DshRegT02 /s' 'reg query "HKLM\Software\DshRegT02" /s'
CandLine 'DshRegT02'
Remove-Item -LiteralPath $K -Recurse -Force -ErrorAction SilentlyContinue
Say ("cleanup HKLM: Test-Path=" + (Test-Path -LiteralPath $K))

# ---------------- REG-03 read-through ----------------
Say '--- REG-03 read-through (PS vs reg.exe vs real) ---'
$pairs = @(
  @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'ProductName', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion'),
  @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'CurrentBuild', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion'),
  @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'UBR', 'HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion'),
  @('HKCU:\Software\7-Zip', 'Path', 'HKCU\Software\7-Zip'),
  @('HKLM:\SOFTWARE\Microsoft\WindowsSelfHost\FIDs', 'AllFlights', 'HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs'))
foreach ($p in $pairs) {
  $psv = '<absent>'
  try { $pp = Get-ItemProperty -LiteralPath $p[0] -ErrorAction Stop; if ($pp.PSObject.Properties.Name -contains $p[1]) { $psv = [string]$pp.($p[1]) } } catch {}
  $r = & cmd.exe /d /c ('reg query "{0}" /v "{1}"' -f $p[2], $p[1]) 2>&1 | Out-String
  $rl = (($r -split "`r?`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($p[1]) + '\s') } | Select-Object -First 1)
  $cmdv = (($rl + '') -replace '\s+', ' ').Trim()
  $match = ($psv -ne '<absent>') -and ($cmdv -like ('*' + $psv + '*'))
  Say ("CMP-{0}`tPS=[{1}]`tCMD=[{2}]`tMATCH={3}" -f $p[1], $psv, $cmdv, $match)
}
Say ("ENV-OSVersion=" + [System.Environment]::OSVersion.VersionString)

# ---------------- REG-04 modify a REAL existing value ----------------
Say '--- REG-04 modify real existing value HKCU\Software\Microsoft\Notepad\searchString ---'
$N = 'HKCU:\Software\Microsoft\Notepad'
$orig = $null; $origExists = $false
try { $np = Get-ItemProperty -LiteralPath $N -ErrorAction Stop; if ($np.PSObject.Properties.Name -contains 'searchString') { $origExists = $true; $orig = [string]$np.searchString } } catch {}
Say ("ORIGINAL searchString exists={0} type={1} value=[{2}]" -f $origExists, $(if ($origExists) { (Get-Item -LiteralPath $N).GetValueKind('searchString') } else { '-' }), $orig)
$rr = & cmd.exe /d /c 'reg query "HKCU\Software\Microsoft\Notepad" /v searchString' 2>&1 | Out-String
Say ("ORIGINAL reg.exe = [" + ((($rr -split "`r?`n") | Where-Object { $_ -match '\ssearchString\s' } | Select-Object -First 1) + '').Trim() + "]")
Set-ItemProperty -LiteralPath $N -Name searchString -Value 'DshRegT04-marker' -ErrorAction SilentlyContinue
$after = (Get-ItemProperty -LiteralPath $N).searchString
Say ("MODIFIED: PS reads = [" + $after + "]")
$rr2 = & cmd.exe /d /c 'reg query "HKCU\Software\Microsoft\Notepad" /v searchString' 2>&1 | Out-String
Say ("MODIFIED: reg.exe reads = [" + ((($rr2 -split "`r?`n") | Where-Object { $_ -match '\ssearchString\s' } | Select-Object -First 1) + '').Trim() + "]  (must still be the ORIGINAL = real hive untouched)")
CandLine 'Notepad'
# restore
if ($origExists) { Set-ItemProperty -LiteralPath $N -Name searchString -Value $orig -ErrorAction SilentlyContinue } else { Remove-ItemProperty -LiteralPath $N -Name searchString -ErrorAction SilentlyContinue }
Say ("RESTORED: PS reads = [" + (Get-ItemProperty -LiteralPath $N).searchString + "] (original=[" + $orig + "])")

# ---------------- REG-05 high-risk probes ----------------
Say '--- REG-05 high-risk locations ---'
# 5.1 HKLM SYSTEM services
$S1 = 'HKLM:\SYSTEM\CurrentControlSet\Services\DshRegSvcT05'
Remove-Item -LiteralPath $S1 -Recurse -Force -ErrorAction SilentlyContinue
$e = ''
try { New-Item -Path $S1 -Force -ErrorAction Stop | Out-Null } catch { $e = $_.Exception.Message }
Say ("5.1 CREATE HKLM\SYSTEM\...\Services\DshRegSvcT05 = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK' }))
if (-not $e) { try { New-ItemProperty -Path $S1 -Name ImagePath -Value 'cmd /c exit' -PropertyType ExpandString -ErrorAction Stop | Out-Null; Say '5.1 SET ImagePath = OK' } catch { Say ('5.1 SET ImagePath = ERROR: ' + $_.Exception.Message) } }
Say ("5.1 PS-readback = [" + (RCanon $S1).text + "]")
Cmd2 '5.1 reg query services key' 'reg query "HKLM\SYSTEM\CurrentControlSet\Services\DshRegSvcT05" /s'
CandLine 'DshRegSvcT05'
Remove-Item -LiteralPath $S1 -Recurse -Force -ErrorAction SilentlyContinue
Say ("5.1 cleanup Test-Path=" + (Test-Path -LiteralPath $S1))

# 5.2 HKCU Run
$R1 = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Say ("5.2 HKCU Run existing values = [" + ((Get-Item -LiteralPath $R1).GetValueNames() -join ', ') + "]")
Cmd2 '5.2 reg query HKCU Run' 'reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"'
$e = ''
try { New-ItemProperty -Path $R1 -Name DshRegT05Run -Value 'cmd /c exit' -PropertyType String -ErrorAction Stop | Out-Null } catch { $e = $_.Exception.Message }
Say ("5.2 ADD Run value DshRegT05Run = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK' }))
Say ("5.2 PS-readback = [" + ((Get-ItemProperty -LiteralPath $R1).DshRegT05Run) + "]")
Cmd2 '5.2 reg query Run /v DshRegT05Run (child)' 'reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v DshRegT05Run'
CandLine 'DshRegT05Run'
Remove-ItemProperty -Path $R1 -Name DshRegT05Run -ErrorAction SilentlyContinue
Say ("5.2 cleanup: value present=" + ((Get-Item -LiteralPath $R1).GetValueNames() -contains 'DshRegT05Run'))

# 5.3 HKLM Run
$R2 = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
Say ("5.3 HKLM Run existing values = [" + ((Get-Item -LiteralPath $R2).GetValueNames() -join ', ') + "]")
$e = ''
try { New-ItemProperty -Path $R2 -Name DshRegT05RunHKLM -Value 'cmd /c exit' -PropertyType String -ErrorAction Stop | Out-Null } catch { $e = $_.Exception.Message }
Say ("5.3 ADD HKLM Run value = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK' }))
if (-not $e) { Say ("5.3 PS-readback = [" + ((Get-ItemProperty -LiteralPath $R2).DshRegT05RunHKLM) + "]") }
Cmd2 '5.3 reg query HKLM Run /v DshRegT05RunHKLM' 'reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v DshRegT05RunHKLM'
CandLine 'DshRegT05RunHKLM'
Remove-ItemProperty -Path $R2 -Name DshRegT05RunHKLM -ErrorAction SilentlyContinue
Say ("5.3 cleanup: value present=" + ((Get-Item -LiteralPath $R2).GetValueNames() -contains 'DshRegT05RunHKLM'))

# 5.4 file association
$C1 = 'HKCU:\Software\Classes\.dshtest'
Remove-Item -LiteralPath $C1 -Recurse -Force -ErrorAction SilentlyContinue
$e = ''
try { New-Item -Path $C1 -Force -ErrorAction Stop | Out-Null; New-ItemProperty -Path $C1 -Name '(default)' -Value 'DshRegT05.Assoc' -PropertyType String -ErrorAction Stop | Out-Null } catch { $e = $_.Exception.Message }
Say ("5.4 CREATE HKCU\Software\Classes\.dshtest = " + $(if ($e) { 'ERROR: ' + $e } else { 'OK' }))
Say ("5.4 PS-readback = [" + (RCanon $C1).text + "]")
Cmd2 '5.4 reg query .dshtest' 'reg query "HKCU\Software\Classes\.dshtest"'
CandLine 'dshtest'
Remove-Item -LiteralPath $C1 -Recurse -Force -ErrorAction SilentlyContinue
Say ("5.4 cleanup Test-Path=" + (Test-Path -LiteralPath $C1))

Say '--- leftovers ---'
foreach ($p in @('HKCU:\Software\DshRegT01', 'HKCU:\Software\DshRegT01C', 'HKLM:\Software\DshRegT02', 'HKLM:\SYSTEM\CurrentControlSet\Services\DshRegSvcT05', 'HKCU:\Software\Classes\.dshtest')) {
  Say ("LEFTOVER {0} exists={1}" -f $p, (Test-Path -LiteralPath $p))
}
Say ("LEFTOVER HKCU Run DshRegT05Run=" + ((Get-Item -LiteralPath $R1).GetValueNames() -contains 'DshRegT05Run'))
Say ("LEFTOVER HKLM Run DshRegT05RunHKLM=" + ((Get-Item -LiteralPath $R2).GetValueNames() -contains 'DshRegT05RunHKLM'))

Set-Content -LiteralPath $ev -Value ($S -join "`r`n") -Encoding UTF8
Say 'REG-02..05 done'
