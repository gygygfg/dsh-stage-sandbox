# dshnt M0 phase 1 (first logon, elevated)
# Enable ProjFS/test signing, install VS Build Tools + WDK + .NET SDK,
# build SimRep and the ProjFS managed sample, sign the driver, schedule phase 2,
# then reboot. All output goes to the Samba share.
# Keep this file ASCII-only: Windows PowerShell 5.1 encoding is fragile.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RunId = 'm0'
$Share = '\\host.lan\Data'
if (-not (Test-Path $Share)) { $Share = 'Z:' }
if (-not (Test-Path $Share)) { $Share = '\\host.lan\shared' }
$Log = Join-Path $Share "m0-phase1.log"
$Result = Join-Path $Share 'RESULT_M0.json'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}
function SaveJson($obj, [string]$path) {
  $json = $obj | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Fail([string]$m) {
  Log "FATAL: $m"
  SaveJson ([ordered]@{ ok = $false; phase = 1; error = $m; at = (Get-Date).ToString('o'); share = $Share }) $Result
  exit 1
}
function Download([string]$url, [string]$out) {
  for ($i = 1; $i -le 3; $i++) {
    try {
      Log "download $url -> $out (try $i)"
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 900
      if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) { return }
    } catch {
      Log "download failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 10
    }
  }
  throw "download failed: $url"
}
function Run([string]$file, $arguments, [string]$label) {
  Log "run $label"
  $p = Start-Process -FilePath $file -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  Log "$label exit=$($p.ExitCode)"
  return $p.ExitCode
}

Set-Content -Path $Log -Value "=== dshnt M0 phase1 $(Get-Date) ===" -Encoding utf8
Log "share=$Share"

# 1. Wait for the share.
$tries = 0
while (-not (Test-Path $Share) -and $tries -lt 60) { Start-Sleep -Seconds 5; $tries++ }
if (-not (Test-Path $Share)) { exit 1 }
Log "share ready after ${tries}x5s"

# 2. Admin?
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'OEM hook is not elevated'
}

# 3. Power: no sleep while installing.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null

# 4. ProjFS + test signing.
$proj = Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -ErrorAction SilentlyContinue
Log "ProjFS before: $($proj.State)"
if ($proj.State -ne 'Enabled') {
  Enable-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -NoRestart -WarningAction SilentlyContinue | Out-Null
}
$projAfter = Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -ErrorAction SilentlyContinue
Log "ProjFS after: $($projAfter.State)"
$bcd = bcdedit /set testsigning on 2>&1
Log "bcdedit testsigning: $bcd"

# 5. Directories.
New-Item -ItemType Directory -Force C:\m0, C:\m0\bin, C:\src | Out-Null

# 6. VS Build Tools (C++ workload). Try with SDK component, retry minimal on failure.
$vs = 'C:\m0\vs_buildtools.exe'
Download 'https://aka.ms/vs/17/release/vs_buildtools.exe' $vs
$vsArgsFull = @(
  '--quiet', '--wait', '--norestart', '--nocache',
  '--installPath', 'C:\BuildTools',
  '--add', 'Microsoft.VisualStudio.Workload.VCTools',
  '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100',
  '--includeRecommended'
)
$vsExit = Run $vs $vsArgsFull 'VS Build Tools (full)'
if (-not (Test-Path 'C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe')) {
  Log 'VS full install path missing; retry minimal'
  $vsArgsMin = @(
    '--quiet', '--wait', '--norestart', '--nocache',
    '--installPath', 'C:\BuildTools',
    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
    '--includeRecommended'
  )
  $vsExit = Run $vs $vsArgsMin 'VS Build Tools (minimal)'
}
if (-not (Test-Path 'C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe')) {
  Fail 'MSBuild.exe not found after VS Build Tools install'
}

# 7. WDK.
$wdk = 'C:\m0\wdksetup.exe'
Download 'https://go.microsoft.com/fwlink/?linkid=2335869' $wdk
$wdkExit = Run $wdk @('/quiet', '/norestart') 'WDK'
# The WDK bootstrapper may return before the payload finishes; wait for the include dir.
$kitsInclude = 'C:\Program Files (x86)\Windows Kits\10\Include'
$deadline = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $deadline) {
  $versions = @()
  if (Test-Path $kitsInclude) {
    $versions = Get-ChildItem $kitsInclude -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
      Sort-Object Name -Descending
  }
  if ($versions.Count -gt 0) { break }
  Start-Sleep -Seconds 20
}
$sdkVersion = $null
if (Test-Path $kitsInclude) {
  $sdkVersion = (Get-ChildItem $kitsInclude -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
    Sort-Object Name -Descending | Select-Object -First 1).Name
}
Log "WDK exit=$wdkExit sdkVersion=$sdkVersion"
if (-not $sdkVersion) { Fail 'WDK/Windows SDK include directory not found' }

# 8. .NET SDK 8 (for the ProjFS managed sample).
$dotnetInstall = 'C:\m0\dotnet-install.ps1'
Download 'https://dot.net/v1/dotnet-install.ps1' $dotnetInstall
$dotnetExit = Run 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dotnetInstall, '-Channel', '10.0', '-InstallDir', 'C:\dotnet') 'dotnet-install'
if (-not (Test-Path 'C:\dotnet\dotnet.exe')) { Fail 'dotnet.exe not found' }
& C:\dotnet\dotnet.exe --info 2>&1 | Out-File -FilePath (Join-Path $Share 'm0-dotnet-info.txt') -Encoding utf8

# 9. Samples (zip; no git dependency).
$samplesZip = 'C:\m0\wdk-samples.zip'
Download 'https://github.com/microsoft/Windows-driver-samples/archive/refs/heads/main.zip' $samplesZip
Log 'extract Windows-driver-samples'
Expand-Archive -Path $samplesZip -DestinationPath C:\src -Force
$projfsZip = 'C:\m0\projfs.zip'
Download 'https://github.com/microsoft/ProjFS-Managed-API/archive/refs/heads/main.zip' $projfsZip
Log 'extract ProjFS-Managed-API'
Expand-Archive -Path $projfsZip -DestinationPath C:\src -Force

# 10. Build SimRep.
$msbuild = 'C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
$simrepProj = Get-ChildItem -Path C:\src -Recurse -Filter simrep.vcxproj -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $simrepProj) { Fail 'simrep.vcxproj not found' }
$simrepLog = Join-Path $Share 'm0-build-simrep.log'
Log "build $($simrepProj.FullName)"
& $msbuild $simrepProj.FullName /p:Configuration=Debug /p:Platform=x64 "/p:WindowsTargetPlatformVersion=$sdkVersion" /m /v:minimal *> $simrepLog
$simrepExit = $LASTEXITCODE
Log "simrep build exit=$simrepExit"
$simrepSys = Get-ChildItem -Path C:\src -Recurse -Filter simrep.sys -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $simrepSys) {
  Get-Content $simrepLog -Tail 120 | ForEach-Object { Log "simrep: $_" }
  Fail 'simrep.sys not produced'
}

# 11. Build ProjFS managed SimpleProvider.
$projfsSln = Get-ChildItem -Path C:\src -Recurse -Filter 'ProjectedFSLib.Managed.slnx' -ErrorAction SilentlyContinue | Select-Object -First 1
$projfsLog = Join-Path $Share 'm0-build-projfs.log'
if ($projfsSln) {
  Log "build $($projfsSln.FullName)"
  & C:\dotnet\dotnet.exe build $projfsSln.FullName -c Debug *> $projfsLog
} else {
  $proj = Get-ChildItem -Path C:\src -Recurse -Filter 'simpleProviderManaged.csproj' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proj) { Fail 'ProjFS SimpleProvider project not found' }
  Log "build $($proj.FullName)"
  & C:\dotnet\dotnet.exe build $proj.FullName -c Debug *> $projfsLog
}
$projfsExit = $LASTEXITCODE
Log "projfs build exit=$projfsExit"
$providerExe = Get-ChildItem -Path C:\src -Recurse -Filter SimpleProviderManaged.exe -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $providerExe) {
  Get-Content $projfsLog -Tail 120 | ForEach-Object { Log "projfs: $_" }
  Fail 'SimpleProviderManaged.exe not produced'
}

# 12. Sign the driver with a test certificate.
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=dshnt-m0' -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2)
$pwd = ConvertTo-SecureString 'dshnt' -Force -AsPlainText
$pfx = 'C:\m0\dshnt-m0.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\Root -Password $pwd | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\TrustedPublisher -Password $pwd | Out-Null
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { Fail 'signtool.exe not found' }
Log "sign $($simrepSys.FullName)"
& $signtool.FullName sign /fd SHA256 /f $pfx /p dshnt $simrepSys.FullName *> (Join-Path $Share 'm0-sign.log')
Log "sign exit=$LASTEXITCODE"

# 13. Stage binaries and phase 2.
Copy-Item -Force $simrepSys.FullName C:\m0\bin\simrep.sys
New-Item -ItemType Directory -Force C:\m0\projfs-provider | Out-Null
Copy-Item -Path (Join-Path $providerExe.Directory.FullName '*') -Destination C:\m0\projfs-provider -Recurse -Force
Copy-Item -Force $providerExe.FullName C:\m0\bin\SimpleProviderManaged.exe
Copy-Item -Force (Join-Path $Share 'm0-phase2.ps1') C:\m0\phase2.ps1 -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $Share 'm0-client.c') C:\m0\m0-client.c -ErrorAction SilentlyContinue

$task = 'DshntM0Phase2'
schtasks /Delete /TN $task /F 2>$null | Out-Null
$tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\m0\phase2.ps1'
$sch = schtasks /Create /TN $task /SC ONLOGON /RL HIGHEST /RU "$env:USERDOMAIN\$env:USERNAME" /TR $tr /F 2>&1
Log "schtasks: $sch"
if ($LASTEXITCODE -ne 0) {
  Log 'schtasks failed; using RunOnce fallback'
}
# Always install a RunOnce backup; phase2 has a lock file, so a double start is harmless.
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name DshntM0Phase2 -Value $tr
Log 'RunOnce backup installed'

SaveJson ([ordered]@{
  ok = $true
  phase = 1
  at = (Get-Date).ToString('o')
  sdkVersion = $sdkVersion
  msbuild = $msbuild
  simrep = $simrepSys.FullName
  provider = $providerExe.FullName
  signTool = $signtool.FullName
  reboot = $true
}) (Join-Path $Share 'm0-phase1-done.json')

Log 'phase1 complete; rebooting in 20s'
shutdown.exe /r /t 20 /c 'dshnt M0 phase1 complete'
exit 0
