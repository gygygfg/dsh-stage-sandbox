# dshnt M0 recovery: the original phase1 hung in dotnet-install.
# VS Build Tools + WDK are already installed. Build/sign SimRep, install the
# prebuilt ProjFS provider from the share, schedule phase2, and reboot.
# ASCII only.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Share = '\\host.lan\Data'
if (-not (Test-Path $Share)) { $Share = 'Z:' }
$Log = Join-Path $Share 'recover.log'
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}
function Fail([string]$m) {
  Log "FATAL: $m"
  [IO.File]::WriteAllText((Join-Path $Share 'RESULT_M0.json'), (@{ ok = $false; phase = 'recover'; error = $m } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  exit 1
}

Set-Content -Path $Log -Value "=== dshnt M0 recover $(Get-Date) ===" -Encoding utf8
$tries = 0
while (-not (Test-Path $Share) -and $tries -lt 60) { Start-Sleep -Seconds 5; $tries++ }
if (-not (Test-Path $Share)) { exit 1 }
Log "share=$Share"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not elevated' }

$msbuild = 'C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
if (-not (Test-Path $msbuild)) { Fail 'MSBuild missing' }
$include = 'C:\Program Files (x86)\Windows Kits\10\Include'
$sdkVersion = (Get-ChildItem $include -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } | Sort-Object Name -Descending | Select-Object -First 1).Name
if (-not $sdkVersion) { Fail 'SDK include missing' }
Log "sdkVersion=$sdkVersion"

# SimRep source from the share.
if (Test-Path C:\m0\simrep) { Remove-Item C:\m0\simrep -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item -Path (Join-Path $Share 'simrep') -Destination C:\m0\simrep -Recurse -Force
$simrepProj = 'C:\m0\simrep\simrep.vcxproj'
if (-not (Test-Path $simrepProj)) { Fail 'simrep.vcxproj missing' }
$buildLog = Join-Path $Share 'recover-build-simrep.log'
Log 'build SimRep'
& $msbuild $simrepProj /p:Configuration=Debug /p:Platform=x64 "/p:WindowsTargetPlatformVersion=$sdkVersion" /p:SpectreMitigation=false /m /v:minimal *> $buildLog
$buildExit = $LASTEXITCODE
Log "simrep build exit=$buildExit"
$simrepSys = Get-ChildItem C:\m0\simrep -Recurse -Filter simrep.sys -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $simrepSys) {
  Get-Content $buildLog -Tail 120 | ForEach-Object { Log "simrep: $_" }
  Fail 'simrep.sys not produced'
}

# Test certificate + sign.
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=dshnt-m0' -CertStoreLocation Cert:\LocalMachine\My -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2)
$pwd = ConvertTo-SecureString 'dshnt' -Force -AsPlainText
$pfx = 'C:\m0\dshnt-m0.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\Root -Password $pwd | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\TrustedPublisher -Password $pwd | Out-Null
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { Fail 'signtool missing' }
& $signtool.FullName sign /fd SHA256 /f $pfx /p dshnt $simrepSys.FullName *> (Join-Path $Share 'recover-sign.log')
Log "sign exit=$LASTEXITCODE"

New-Item -ItemType Directory -Force C:\m0\bin | Out-Null
Copy-Item -Force $simrepSys.FullName C:\m0\bin\simrep.sys

# Install via INF (the reliable path). sc create + manual registry was not enough:
# fltmc load returned 0x80070002 / FilterManager 0xC0000034.
$pkg = 'C:\m0\simrep\x64\Debug\simrep'
if (-not (Test-Path (Join-Path $pkg 'simrep.inf'))) { $pkg = $simrepSys.Directory.FullName }
$cat = Join-Path $pkg 'simrep.cat'
if (Test-Path $cat) {
  & $signtool.FullName sign /fd SHA256 /f $pfx /p dshnt $cat *> (Join-Path $Share 'recover-sign-cat.log')
  Log "sign cat exit=$LASTEXITCODE"
}
sc.exe stop SimRep 2>$null | Out-Null
sc.exe delete SimRep 2>$null | Out-Null
Start-Sleep -Seconds 1
pnputil /add-driver (Join-Path $pkg 'simrep.inf') /install *> (Join-Path $Share 'recover-pnputil.log')
Log "pnputil exit=$LASTEXITCODE"
$params = 'HKLM\SYSTEM\CurrentControlSet\Services\SimRep\Parameters'
$instances = "$params\Instances"
reg.exe add $params /v SupportedFeatures /t REG_DWORD /d 3 /f 2>&1 | Out-Null
reg.exe add $params /v OldMapping /t REG_SZ /d '\m0\ws' /f 2>&1 | Out-Null
reg.exe add $params /v NewMapping /t REG_SZ /d '\m0\view' /f 2>&1 | Out-Null
reg.exe add $params /v RemapRenamesAndLinks /t REG_DWORD /d 1 /f 2>&1 | Out-Null
reg.exe add $params /v DebugLevel /t REG_DWORD /d 0x1F /f 2>&1 | Out-Null
reg.exe add $instances /v DefaultInstance /t REG_SZ /d SimRep /f 2>&1 | Out-Null
reg.exe add "$instances\SimRep" /v Altitude /t REG_SZ /d 371100 /f 2>&1 | Out-Null
reg.exe add "$instances\SimRep" /v Flags /t REG_DWORD /d 0 /f 2>&1 | Out-Null
fltmc load SimRep *> (Join-Path $Share 'recover-fltmc-load.log')
Log "fltmc load exit=$LASTEXITCODE"
fltmc attach SimRep C: *> (Join-Path $Share 'recover-fltmc-attach.log')
Log "fltmc attach exit=$LASTEXITCODE"

# Prebuilt ProjFS provider (self-contained) from the share.
$providerSrc = Join-Path $Share 'projfs-provider'
if (-not (Test-Path $providerSrc)) { Fail 'projfs-provider missing on share' }
if (Test-Path C:\m0\projfs-provider) { Remove-Item C:\m0\projfs-provider -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item -Path $providerSrc -Destination C:\m0\projfs-provider -Recurse -Force
if (-not (Test-Path 'C:\m0\projfs-provider\SimpleProviderManaged.exe')) { Fail 'SimpleProviderManaged.exe missing after copy' }

Copy-Item -Force (Join-Path $Share 'm0-phase2.ps1') C:\m0\phase2.ps1
Copy-Item -Force (Join-Path $Share 'm0-client.c') C:\m0\m0-client.c

# Schedule phase2 + RunOnce backup.
$task = 'DshntM0Phase2'
schtasks /Delete /TN $task /F 2>$null | Out-Null
$tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\m0\phase2.ps1'
$sch = schtasks /Create /TN $task /SC ONLOGON /RL HIGHEST /RU "$env:USERDOMAIN\$env:USERNAME" /TR $tr /F 2>&1
Log "schtasks: $sch"
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce' -Name DshntM0Phase2 -Value $tr
Log 'recover complete; rebooting in 20s'
shutdown.exe /r /t 20 /c 'dshnt M0 recover complete'
exit 0
