# dshnt M0 follow-up: isolate the per-file metadata (stat) cost.
# perf.ps1 showed view\flat5000 FileInfo at ~16.7 s vs ~0.5 s on NTFS.
# Questions: is that one-time metadata population, does it recur after a
# provider restart, and what does a brand-new ProjFS instance cost?
# ASCII only.

$ErrorActionPreference = 'Stop'
$Share = '\\host.lan\Data'
$Log = Join-Path $Share 'stat.log'
Set-Content -Path $Log -Value "=== dshnt stat probe $(Get-Date) ===" -Encoding utf8
function L([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}
function Stat([string]$path, [string]$label) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $files = [IO.Directory]::GetFiles($path)
  $sum = 0L
  foreach ($f in $files) { $fi = New-Object IO.FileInfo($f); $sum += $fi.Length }
  $sw.Stop()
  L ("{0,-26} {1,10:N1} ms  ({2} files)" -f $label, $sw.Elapsed.TotalMilliseconds, $files.Length)
}
function Stop-Provider {
  Get-Process SimpleProviderManaged -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1000
}

try {
  L "projfs=$((Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS).State)"
  L "view-a=$([bool](Test-Path C:\m0\view\a.txt)) ws-a=$([bool](Test-Path C:\m0\ws\a.txt))"

  # 1. warm state, provider running since perf.ps1
  Stat 'C:\m0\view\flat5000' 'view-warm-1'
  Stat 'C:\m0\view\flat5000' 'view-warm-2'
  Stat 'C:\m0\ws\flat5000'   'ws-warm-1'
  Stat 'C:\m0\ws\flat5000'   'ws-warm-2'

  # 2. restart provider over the existing (already populated) view dir
  Stop-Provider
  Start-Process -FilePath 'C:\m0\projfs-provider\SimpleProviderManaged.exe' `
    -ArgumentList '--SourceRoot=C:\m0\lower', '--VirtRoot=C:\m0\view' `
    -RedirectStandardOutput C:\m0\sp.log -RedirectStandardError C:\m0\sp.err -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 5
  Stat 'C:\m0\view\flat5000' 'view-restart-1'
  Stat 'C:\m0\view\flat5000' 'view-restart-2'
  Stat 'C:\m0\ws\flat5000'   'ws-restart-1'
  Stat 'C:\m0\view\tree\d1'  'view-tree-restart-1'
  Stat 'C:\m0\view\tree\d1'  'view-tree-restart-2'

  # 3. brand-new ProjFS instance on the same layer (cold metadata from scratch)
  Stop-Provider
  if (Test-Path C:\m0\view2) { cmd.exe /c 'rmdir /s /q C:\m0\view2' | Out-Null }
  New-Item -ItemType Directory -Force C:\m0\view2 | Out-Null
  Start-Process -FilePath 'C:\m0\projfs-provider\SimpleProviderManaged.exe' `
    -ArgumentList '--SourceRoot=C:\m0\lower', '--VirtRoot=C:\m0\view2' `
    -RedirectStandardOutput C:\m0\sp2.log -RedirectStandardError C:\m0\sp2.err -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 5
  Stat 'C:\m0\view2\flat5000' 'view2-cold-1'
  Stat 'C:\m0\view2\flat5000' 'view2-cold-2'
  Stat 'C:\m0\view2\flat5000' 'view2-cold-3'
  Stat 'C:\m0\view2\tree\d1'  'view2-tree-1'
  Stat 'C:\m0\view2\tree\d1'  'view2-tree-2'
  L 'STAT DONE'
}
catch {
  L "FATAL: $($_.Exception.Message)"
  exit 1
}
