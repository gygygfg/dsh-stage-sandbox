. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-01' 'HKCU write/overwrite/delete: key + 5 value types, PS readback + reg.exe cross + STAGE'
$ev = Join-Path $script:EvDir 'reg01.txt'
$B = 'HKCU:\Software\DshRegT01'

function Step([string]$name) {
  $o = @()
  $o += "===== $name ====="
  $o += ("PS Test-Path {0} = {1}" -f $B, (Test-Path -LiteralPath $B))
  $c = RCanon $B
  $o += ("PS canon = " + $c.text)
  $o += ("PS canon SHA256 = " + $c.sha)
  $o += (RRun ("$name : reg.exe query child") ('reg query "HKCU\Software\DshRegT01" /s')).out
  $o += 'STAGE WAL:'
  $o += RWal 'DshRegT01'
  $o += 'STAGE candidates:'
  $o += RCand 'DshRegT01'
  foreach ($l in $o) { Write-Output $l; RLog $l }
  Add-Content -LiteralPath $ev -Value ($o -join "`r`n") -Encoding UTF8
}

# --- 1a: create key (empty key) then immediately write a value (empty-key reopen regression) ---
RSec 'REG-01.1a' 'create key'
RLog (RRun 'cleanup before create' 'reg query "HKCU\Software\DshRegT01" >nul 2>&1 & echo cleaned').out
Remove-Item -LiteralPath $B -Recurse -Force -ErrorAction SilentlyContinue
$r = New-Item -Path $B -Force -ErrorAction Stop
RLog ("CRT New-Item rc ok, path=" + $r.Name)
Step '1a create key'
$r2 = New-ItemProperty -Path $B -Name First -Value 'v' -PropertyType String -ErrorAction Stop
RLog ("CRT New-ItemProperty on fresh empty key ok, name=" + $r2.PSObject.Properties['First'].Value)
Remove-ItemProperty -Path $B -Name First -ErrorAction SilentlyContinue

# --- 1b: five value types ---
RSec 'REG-01.1b' 'five value types'
New-ItemProperty -Path $B -Name Sz  -Value 'hello-sz'        -PropertyType String      -ErrorAction Stop | Out-Null
New-ItemProperty -Path $B -Name Dw  -Value 1234              -PropertyType DWord       -ErrorAction Stop | Out-Null
New-ItemProperty -Path $B -Name Qw  -Value 1234567890123     -PropertyType QWord       -ErrorAction Stop | Out-Null
New-ItemProperty -Path $B -Name Msz -Value @('a','b','c')    -PropertyType MultiString -ErrorAction Stop | Out-Null
New-ItemProperty -Path $B -Name Bin -Value ([byte[]](0xDE,0xAD,0xBE,0xEF)) -PropertyType Binary -ErrorAction Stop | Out-Null
# integrity: hash of the value we intended vs hash of the value read back
$intended = 'Bin:Binary=deadbeef; Dw:DWord=1234; Msz:MultiString=a|b|c; Qw:QWord=1234567890123; Sz:String=hello-sz'
$intendedSha = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($intended))).Replace('-', '')
$back = RCanon $B
RLog ("INTENDED = " + $intended)
RLog ("INTENDED SHA256 = " + $intendedSha)
RLog ("READBACK SHA256 = " + $back.sha)
RLog ("INTEGRITY(写入 SHA256 == 回读 SHA256) = " + ($intendedSha -eq $back.sha))
Step '1b five value types'

# --- 1c: overwrite existing value ---
RSec 'REG-01.1c' 'overwrite Sz'
Set-ItemProperty -Path $B -Name Sz -Value 'hello-sz-v2' -ErrorAction Stop
RLog 'OVERWRITE Sz -> hello-sz-v2 (PS Set-ItemProperty, type preserved)'
Step '1c overwrite value'

# --- 1d: delete a value ---
RSec 'REG-01.1d' 'delete value Dw'
Remove-ItemProperty -Path $B -Name Dw -ErrorAction Stop
RLog 'DELETE value Dw'
Step '1d delete value'

# --- 1e: delete key (recurse) ---
RSec 'REG-01.1e' 'delete key'
Remove-Item -LiteralPath $B -Recurse -Force -ErrorAction Stop
RLog 'DELETE key DshRegT01 (recurse)'
Step '1e delete key'

# --- 1f: CMD channel write then read (cross-process) ---
RSec 'REG-01.1f' 'reg.exe write+read asymmetry'
$o = @()
$o += (RRun 'cmd: reg add then reg query in SAME cmd line' 'reg add "HKCU\Software\DshRegT01C" /v Cv /t REG_SZ /d cmdval /f & echo ADD-RC=%errorlevel% & reg query "HKCU\Software\DshRegT01C" /s & echo QUERY-RC=%errorlevel%').out
$o += (RRun 'cmd: second, separate cmd process queries again' 'reg query "HKCU\Software\DshRegT01C" /s & echo QUERY2-RC=%errorlevel%').out
$o += 'STAGE WAL:'; $o += RWal 'DshRegT01C'
$o += 'STAGE candidates:'; $o += RCand 'DshRegT01C'
foreach ($l in $o) { Write-Output $l; RLog $l }
Add-Content -LiteralPath $ev -Value ($o -join "`r`n") -Encoding UTF8
# cleanup via cmd channel (harmless if it only lands in a dead child's hive) and via PS
RLog (RRun 'cmd cleanup reg delete' 'reg delete "HKCU\Software\DshRegT01C" /f & echo DEL-RC=%errorlevel%').out
Remove-Item -LiteralPath 'HKCU:\Software\DshRegT01C' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKCU:\Software\DshRegT01' -Name First -ErrorAction SilentlyContinue
RNote 'REG-01 done'
