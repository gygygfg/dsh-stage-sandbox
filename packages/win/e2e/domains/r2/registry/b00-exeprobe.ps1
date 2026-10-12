$ErrorActionPreference='Continue'
function TryExe([string]$exe,[string[]]$argv){
  $r = New-Object psobject
  $name = $exe
  $p = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    foreach($a in $argv){ [void]$psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $so = $p.StandardOutput.ReadToEnd()
    $se = $p.StandardError.ReadToEnd()
    $p.WaitForExit(60000) | Out-Null
    return "EXE=$exe ARGS=$($argv -join ' ') STARTED=True EXIT=$($p.ExitCode) OUT_LINES=$((($so -split "`n").Count)) ERR=[$($se.Trim())] OUT_HEAD=[$(($so -split "`n" | Select-Object -First 3) -join ' // ')]"
  } catch {
    return "EXE=$exe ARGS=$($argv -join ' ') STARTED=False ERR=$($_.Exception.GetType().Name): $($_.Exception.Message)"
  }
}
$lines=@()
$lines += "### EXE PROBE $(Get-Date -Format o) pid=$PID"
$lines += (TryExe 'C:\Windows\System32\reg.exe' @('query','HKCU\Software'))
$lines += (TryExe 'C:\Windows\System32\whoami.exe' @())
$lines += (TryExe 'C:\Windows\System32\cmd.exe' @('/c','ver'))
$lines += (TryExe 'C:\Windows\System32\where.exe' @('reg.exe'))
$lines += (TryExe 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @('-NoProfile','-Command','"child-ps-ok"'))
$lines += (TryExe 'C:\Windows\System32\hostname.exe' @())
$lines += "### ProcessStartInfo w/ Redirect also blocked?"
$lines += "Environment.UserName = $([System.Environment]::UserName)"
$lines += "Is64BitProcess = $([System.Environment]::Is64BitProcess)"
$lines += "OSVersion = $([System.Environment]::OSVersion.VersionString)"
$lines | Set-Content -Path 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\registry\evidence\reg00b-exeprobe.txt' -Encoding UTF8
$lines | ForEach-Object { Write-Output $_ }
