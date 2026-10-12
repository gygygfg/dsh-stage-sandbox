$sr=$env:DSH_REGSTAGE_ROOT
$m='C:\sp-marker'; $stm="$sr\staged\fs\C\sp-marker"
$rep=@()
Remove-Item -Recurse -Force $m -ErrorAction SilentlyContinue
$env:WINSTAGE_SHIM_DISABLE='1'
$code = "New-Item -ItemType Directory -Force -Path '$m' | Out-Null; Set-Content -LiteralPath '$m\sp.txt' -Value 'REAL' -Force"
Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command',$code) -Wait -WindowStyle Hidden
Remove-Item Env:\WINSTAGE_SHIM_DISABLE -ErrorAction SilentlyContinue
$rep += "StartProcess+disable: real=" + (Test-Path "$m\sp.txt") + " staged=" + (Test-Path "$stm\sp.txt")
$rep += "edge-instance-count=" + ((Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | Measure-Object).Count)
$rep | Out-File 'C:\sp-report.txt' -Encoding utf8
$rep -join "`n"
