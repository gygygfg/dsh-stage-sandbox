. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-02/03' 'HKLM write + read-through of real values'
$ev = Join-Path $script:EvDir 'reg02-03.txt'
$o = @()

# elevation context
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
$o += ("CTX user={0} isAdminRole={1}" -f $id.Name, $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
$o += (RRun 'whoami /groups (integrity)' 'whoami /groups | findstr /i "Mandatory Label"').out

# ---------------- REG-02 HKLM ----------------
$K = 'HKLM:\Software\DshRegT02'
$K2 = 'HKLM:\SOFTWARE\DshRegT02b'
foreach ($k in @($K, $K2)) { Remove-Item -LiteralPath $k -Recurse -Force -ErrorAction SilentlyContinue }
$o += "--- REG-02 baseline ---"
$o += ("PS Test-Path {0} = {1}" -f $K, (Test-Path -LiteralPath $K))
$o += (RRun 'reg query HKLM\Software\DshRegT02 (baseline)' 'reg query "HKLM\Software\DshRegT02"').out
$o += ("reg query exit baseline = " + (RRun 'x' 'reg query "HKLM\Software\DshRegT02"').exit)

$err = $null
try { New-Item -Path $K -Force -ErrorAction Stop | Out-Null; $o += "CREATE HKLM key: OK (no error)" }
catch { $err = $_; $o += ("CREATE HKLM key: ERROR -> " + $_.Exception.Message) }
if (-not $err) {
  try { New-ItemProperty -Path $K -Name Sz -Value 'hklm-sz' -PropertyType String -ErrorAction Stop | Out-Null; $o += 'CREATE HKLM value Sz: OK' }
  catch { $o += ('CREATE HKLM value Sz: ERROR -> ' + $_.Exception.Message) }
  try { New-ItemProperty -Path $K -Name Dw -Value 42 -PropertyType DWord -ErrorAction Stop | Out-Null; $o += 'CREATE HKLM value Dw: OK' }
  catch { $o += ('CREATE HKLM value Dw: ERROR -> ' + $_.Exception.Message) }
  try { New-Item -Path $K2 -Force -ErrorAction Stop | Out-Null; $o += 'CREATE HKLM key2: OK' } catch { $o += ('CREATE HKLM key2: ERROR -> ' + $_.Exception.Message) }
}
$c = RCanon $K
$o += ("PS readback {0} canon = {1}" -f $K, $c.text)
$o += ("PS readback {0} SHA256 = {1}" -f $K, $c.sha)
$r = RRun 'reg query HKLM\Software\DshRegT02 /s (child)' 'reg query "HKLM\Software\DshRegT02" /s'
$o += ("reg query exit = " + $r.exit)
$o += $r.out
$o += 'STAGE WAL:'; $o += RWal 'DshRegT02'
$o += 'STAGE candidates:'; $o += RCand 'DshRegT02'
foreach ($l in $o) { Write-Output $l; RLog $l }
Add-Content -LiteralPath $ev -Value (($o -join "`r`n") + "`r`n") -Encoding UTF8
Remove-Item -LiteralPath $K -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $K2 -Recurse -Force -ErrorAction SilentlyContinue
RLog ("cleanup: PS Test-Path K=" + (Test-Path -LiteralPath $K) + " K2=" + (Test-Path -LiteralPath $K2))

# ---------------- REG-03 read-through ----------------
$o = @()
$o += '--- REG-03 read-through of pre-existing real values ---'
$checks = @(
  @{ k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; n = 'ProductName'; q = 'reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ProductName' },
  @{ k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; n = 'CurrentBuild'; q = 'reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v CurrentBuild' },
  @{ k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; n = 'UBR'; q = 'reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v UBR' },
  @{ k = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'; n = 'EditionID'; q = 'reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v EditionID' },
  @{ k = 'HKCU:\Software\7-Zip'; n = 'Path'; q = 'reg query "HKCU\Software\7-Zip" /v Path' },
  @{ k = 'HKLM:\SOFTWARE\Microsoft\WindowsSelfHost\FIDs'; n = 'AllFlights'; q = 'reg query "HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs" /v AllFlights' })
foreach ($c2 in $checks) {
  $psv = '<absent>'
  if (Test-Path -LiteralPath $c2.k) {
    $p = Get-ItemProperty -LiteralPath $c2.k -ErrorAction SilentlyContinue
    if ($p -and ($p.PSObject.Properties.Name -contains $c2.n)) { $psv = [string]$p.($c2.n) }
  }
  $r2 = RRun ('PS/CMD compare ' + $c2.n) $c2.q
  $cmdv = ($r2.out -split "`n" | Where-Object { $_ -match "\s$($c2.n)\s" } | Select-Object -First 1)
  $o += ("CMP {0}\{1}`tPS=[{2}]`tCMD_EXIT={3}`tCMD=[{4}]`tMATCH={5}" -f $c2.k, $c2.n, ($psv -replace '\s+', ' '), $r2.exit, (($cmdv + '') -replace '\s+', ' ').Trim(), ($cmdv -match [regex]::Escape($psv)))
}
$o += ("ENV OSVersion={0}" -f [System.Environment]::OSVersion.VersionString)
foreach ($l in $o) { Write-Output $l; RLog $l }
Add-Content -LiteralPath $ev -Value (($o -join "`r`n") + "`r`n") -Encoding UTF8
RNote 'REG-02/03 done'
