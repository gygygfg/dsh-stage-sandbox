# WinStage r2 - HOST-side (real system) baseline snapshot.
# Run with WINSTAGE_SHIM_DISABLE=1 so every read/write here hits the REAL disk/registry.
param([Parameter(Mandatory=$true)][string]$OutDir)
$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Snap-Files($root, $depth, $name) {
  $out = Join-Path $OutDir "$name.txt"
  "ROOT=$root DEPTH=$depth" | Set-Content -LiteralPath $out -Encoding UTF8
  if (-not (Test-Path -LiteralPath $root)) { "MISSING" | Add-Content -LiteralPath $out; return }
  $lines = Get-ChildItem -LiteralPath $root -Force -Recurse -Depth $depth -ErrorAction SilentlyContinue |
    ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.FullName, $(if($_.PSIsContainer){'D'}else{'F'}), $_.Length, $_.LastWriteTimeUtc.ToString('o') }
  $lines | Sort-Object | Add-Content -LiteralPath $out -Encoding UTF8
  "COUNT=" + (@($lines).Count) | Add-Content -LiteralPath $out
}

$ws = 'C:\Users\Administrator\Desktop\WinStageSandbox'
Snap-Files 'C:\Windows\Temp' 0 'files-windows-temp'
Snap-Files 'C:\ProgramData' 0 'files-programdata'
Snap-Files 'C:\Users\Administrator' 0 'files-userprofile-top'
Snap-Files $ws 0 'files-workspace-top'
Snap-Files "$ws\_sandbox-tests" 3 'files-sandbox-tests'
Snap-Files 'D:\' 0 'files-d-root'
Snap-Files 'C:\Users\Administrator\.config' 3 'files-config-bh'
Snap-Files 'C:\eprof' 0 'files-eprof'

# Real registry export
& reg.exe export 'HKCU' (Join-Path $OutDir 'reg-HKCU.reg') /y | Out-Null
& reg.exe export 'HKLM\SOFTWARE' (Join-Path $OutDir 'reg-HKLM-SOFTWARE.reg') /y | Out-Null
foreach ($k in 'HKCU\Software\WinStageR2Test','HKLM\SOFTWARE\WinStageR2Test','HKCU\Software\Microsoft\Windows\CurrentVersion\Run','HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run') {
  $f = Join-Path $OutDir ('regq-' + ($k -replace '[\\:]','_') + '.txt')
  "KEY=$k" | Set-Content -LiteralPath $f -Encoding UTF8
  (& reg.exe query $k /s) 2>&1 | Add-Content -LiteralPath $f -Encoding UTF8
}

# Listeners + processes
"netstat -ano" | Set-Content -LiteralPath (Join-Path $OutDir 'netstat.txt') -Encoding UTF8
(& netstat.exe -ano) 2>&1 | Add-Content -LiteralPath (Join-Path $OutDir 'netstat.txt') -Encoding UTF8
(& Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | Format-Table -AutoSize | Out-String -Width 400) |
  Set-Content -LiteralPath (Join-Path $OutDir 'processes.txt') -Encoding UTF8

# Hash the snapshot artifacts so the end-state diff is tamper-evident
Get-ChildItem -LiteralPath $OutDir -File | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Name
} | Sort-Object | Set-Content -LiteralPath (Join-Path $OutDir '_manifest.sha256.txt') -Encoding UTF8
"OK $OutDir" 
