# SEN-02: harmless probe write into clearly-sensitive locations. Records result only.
# Cleanup is performed by a separate step AFTER the real-disk check.
$ErrorActionPreference = 'Continue'
$probes = @(
  'C:\Users\Administrator\.ssh\dsh-sensitive-probe.txt',
  'C:\Users\Administrator\Documents\dsh-sensitive-probe.txt',
  'C:\Users\Administrator\.dsh\dsh-sensitive-probe.txt',
  'C:\Users\Administrator\AppData\Local\Microsoft\Credentials\dsh-sensitive-probe.txt'
)
Write-Output "TARGET|MKDIR|WRITE|EXISTS_AFTER|SIZE|SHA256"
foreach ($p in $probes) {
  $dir = Split-Path -Parent $p
  $mk = 'n/a'
  try { New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null; $mk = 'ok' }
  catch { $mk = 'ERR:' + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ') }
  $wr = ''
  try { Set-Content -LiteralPath $p -Value 'probe' -NoNewline -Encoding ascii -ErrorAction Stop; $wr = 'WRITE_OK' }
  catch { $wr = 'WRITE_ERR:' + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ') }
  $ex = Test-Path -LiteralPath $p
  $sz = ''; $h = ''
  if ($ex) {
    try { $sz = (Get-Item -LiteralPath $p -Force).Length } catch { $sz = 'ERR' }
    try { $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } catch { $h = 'ERR' }
  }
  Write-Output "$p|$mk|$wr|$ex|$sz|$h"
}
