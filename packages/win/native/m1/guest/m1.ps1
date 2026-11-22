# dshnt M1 end-to-end harness (guest).
#
# Builds the product driver/launcher/ctl, signs + installs the driver via INF,
# starts the product ProjFS provider, applies a policy, and runs the in-domain
# client + a network probe. Writes RESULT_M1.json to the share.
#
# ASCII only. Run as Administrator from a normal console:
#   copy \\host.lan\Data\m1\m1.ps1 C:\m1.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\m1.ps1

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
# 这台 VM 上 SACL/完整性标签写不进去（直接调用 SetNamedSecurityInfo(LABEL) 返回 0
# 但读回是空 SACL），所以端到端用 medium；low 会在 launcher 里 fail-closed
# （见 --integrity low 的 readback 校验）。
if (-not $env:DSHNT_INTEGRITY) { $env:DSHNT_INTEGRITY = 'medium' }

$Share = '\\host.lan\Data'
$Src = Join-Path $Share 'm1'
$Root = 'C:\m1'
$Log = Join-Path $Share 'm1.log'
$ResultPath = Join-Path $Share 'RESULT_M1.json'

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding utf8 } catch { }
}
function Fail([string]$m, [hashtable]$extra = @{}) {
  Log "FATAL: $m"
  $payload = @{ ok = $false; phase = 'm1'; error = $m; at = (Get-Date).ToString('o') }
  foreach ($k in $extra.Keys) { $payload[$k] = $extra[$k] }
  [IO.File]::WriteAllText($ResultPath, ($payload | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  exit 1
}
function Tail([string]$path, [int]$lines = 60) {
  if (-not (Test-Path $path)) { return '' }
  return ((Get-Content $path -Tail $lines) -join "`n")
}
function HashTree([string]$dir) {
  $map = @{}
  if (-not (Test-Path $dir)) { return $map }
  Get-ChildItem $dir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($dir.Length).TrimStart('\')
    $map[$rel] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  }
  return $map
}
function Find-Tool([string]$name) {
  $roots = @('C:\Program Files (x86)\Windows Kits\10\bin', 'C:\Program Files\Windows Kits\10\bin')
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem $root -Recurse -Filter $name -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Send-ProviderOp([string]$op, [hashtable]$fields = @{}) {
  # ProjFS 视图由 provider 进程持有；控制面必须显式 start/protect。
  # 这里用命名管道发一行 JSON（与 src/nt/provider.ts 的协议一致）。
  $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'dshnt-provider-m1',
    [System.IO.Pipes.PipeDirection]::InOut)
  try {
    $pipe.Connect(5000)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $writer.AutoFlush = $true
    $reader = New-Object System.IO.StreamReader($pipe)
    $payload = @{ id = 1; op = $op }
    foreach ($k in $fields.Keys) { $payload[$k] = $fields[$k] }
    $writer.WriteLine(($payload | ConvertTo-Json -Compress))
    $reply = $reader.ReadLine()
    $writer.Dispose()
    $reader.Dispose()
    return $reply
  } finally {
    $pipe.Dispose()
  }
}

Set-Content -Path $Log -Value "=== dshnt M1 $(Get-Date) ===" -Encoding utf8

# 0. share
$tries = 0
while (-not (Test-Path $Src) -and $tries -lt 60) { Start-Sleep -Seconds 5; $tries++ }
if (-not (Test-Path $Src)) { Fail 'share \\host.lan\Data\m1 not reachable' }
Log "share ok: $Src"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Fail 'not elevated'
}

# 0.5 先杀掉上一轮的 provider：否则 C:\m1\provider 下的 exe/dll 仍被占用，
#     Copy-Item 会静默保留旧文件，随后启动的仍是旧版本（会导致“改了代码没生效”）。
Get-Process dshnt-provider -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 1. copy sources + provider + policy
if (Test-Path (Join-Path $Root 'src')) { Remove-Item (Join-Path $Root 'src') -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force (Join-Path $Root 'src') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $Root 'bin') | Out-Null
Copy-Item -Path (Join-Path $Src 'native\*') -Destination (Join-Path $Root 'src') -Recurse -Force
if (-not (Test-Path (Join-Path $Root 'src\driver\dshnt.vcxproj'))) { Fail 'driver sources missing after copy' }

if (Test-Path (Join-Path $Root 'provider')) { Remove-Item (Join-Path $Root 'provider') -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item -Path (Join-Path $Src 'provider') -Destination (Join-Path $Root 'provider') -Recurse -Force
if (-not (Test-Path (Join-Path $Root 'provider\dshnt-provider.exe'))) { Fail 'provider exe missing' }
Copy-Item -Force (Join-Path $Src 'policy.bin') (Join-Path $Root 'policy.bin')
Copy-Item -Force (Join-Path $Src 'policy2.bin') (Join-Path $Root 'policy2.bin') -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $Src 'policy.json') (Join-Path $Root 'policy.json')
$policyInfo = Get-Content (Join-Path $Root 'policy.json') -Raw | ConvertFrom-Json
Log "policy generation=$($policyInfo.generation) bytes=$($policyInfo.bytes)"
Copy-Item -Force (Join-Path $Src 'guest\m1-client.c') (Join-Path $Root 'm1-client.c')
Copy-Item -Force (Join-Path $Src 'guest\m1-net.c') (Join-Path $Root 'm1-net.c')
Copy-Item -Force (Join-Path $Src 'guest\m1-mitigate.c') (Join-Path $Root 'm1-mitigate.c')

# 2. toolchain
$msbuild = $null
foreach ($p in 'C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe',
               'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe',
               'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe') {
  if (Test-Path $p) { $msbuild = $p; break }
}
if (-not $msbuild) { Fail 'MSBuild not found' }
$vcvars = $null
foreach ($p in 'C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
               'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat') {
  if (Test-Path $p) { $vcvars = $p; break }
}
if (-not $vcvars) { Fail 'vcvars64.bat not found' }
Log "msbuild=$msbuild"

$sdkVersion = (Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Include' -Directory |
  Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } | Sort-Object Name -Descending | Select-Object -First 1).Name
if (-not $sdkVersion) { Fail 'Windows SDK include not found' }
Log "sdk=$sdkVersion"

# 3. build driver
$driverLog = Join-Path $Share 'm1-build-driver.log'
& $msbuild (Join-Path $Root 'src\driver\dshnt.vcxproj') /p:Configuration=Release /p:Platform=x64 `
  "/p:WindowsTargetPlatformVersion=$sdkVersion" /p:SpectreMitigation=false /m /v:minimal *> $driverLog
Log "driver build exit=$LASTEXITCODE"
$sys = Get-ChildItem (Join-Path $Root 'src\driver') -Recurse -Filter dshnt.sys -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $sys) { Fail 'dshnt.sys not produced' @{ buildLog = Tail $driverLog 80 } }
Log "dshnt.sys = $($sys.FullName)"

# 4. build launcher + ctl
$launcherLog = Join-Path $Share 'm1-build-launcher.log'
& $msbuild (Join-Path $Root 'src\launcher\launcher.vcxproj') /p:Configuration=Release /p:Platform=x64 `
  "/p:WindowsTargetPlatformVersion=$sdkVersion" /m /v:minimal *> $launcherLog
Log "launcher build exit=$LASTEXITCODE"
$ctlLog = Join-Path $Share 'm1-build-ctl.log'
& $msbuild (Join-Path $Root 'src\ctl\ctl.vcxproj') /p:Configuration=Release /p:Platform=x64 `
  "/p:WindowsTargetPlatformVersion=$sdkVersion" /m /v:minimal *> $ctlLog
Log "ctl build exit=$LASTEXITCODE"

$launcher = Get-ChildItem (Join-Path $Root 'src\launcher') -Recurse -Filter dshnt-launch.exe -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$ctl = Get-ChildItem (Join-Path $Root 'src\ctl') -Recurse -Filter dshnt-ctl.exe -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $launcher) { Fail 'dshnt-launch.exe not produced' @{ buildLog = Tail $launcherLog 80 } }
if (-not $ctl) { Fail 'dshnt-ctl.exe not produced' @{ buildLog = Tail $ctlLog 80 } }
Copy-Item -Force $launcher.FullName (Join-Path $Root 'bin\dshnt-launch.exe')
Copy-Item -Force $ctl.FullName (Join-Path $Root 'bin\dshnt-ctl.exe')
Log "launcher=$($launcher.FullName) ctl=$($ctl.FullName)"

# 5. client binaries
$clBat = Join-Path $Root 'cl-build.bat'
@"
@echo off
call "$vcvars" >nul
cd /d $Root
cl /nologo /W3 /Fe:$Root\bin\m1-client.exe m1-client.c ntdll.lib
if errorlevel 1 exit /b 1
cl /nologo /W3 /Fe:$Root\bin\m1-net.exe m1-net.c ws2_32.lib
if errorlevel 1 exit /b 1
cl /nologo /W3 /Fe:$Root\bin\m1-mitigate.exe m1-mitigate.c
"@ | Set-Content -Path $clBat -Encoding ASCII
cmd.exe /c $clBat *> (Join-Path $Share 'm1-build-client.log')
Log "client build exit=$LASTEXITCODE"
if (-not (Test-Path (Join-Path $Root 'bin\m1-client.exe'))) { Fail 'm1-client.exe not produced' @{ buildLog = Tail (Join-Path $Share 'm1-build-client.log') 60 } }
if (-not (Test-Path (Join-Path $Root 'bin\m1-mitigate.exe'))) { Fail 'm1-mitigate.exe not produced' @{ buildLog = Tail (Join-Path $Share 'm1-build-client.log') 40 } }

# 6. signing material
$signtool = Find-Tool 'signtool.exe'
$inf2cat = Find-Tool 'Inf2Cat.exe'
if (-not $inf2cat) {
  # 有些 WDK 安装不带 Inf2Cat；按名字全盘找一次（失败也继续，后面有 makecat 兜底）。
  $hit = Get-ChildItem 'C:\' -Recurse -Filter 'inf2cat.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $inf2cat = $hit.FullName }
  if (-not $inf2cat) { Log 'inf2cat: not found' }
}
Log "signtool=$signtool"
Log "inf2cat=$inf2cat"
if (-not $signtool) { Fail 'signtool not found' }
# 证书：M0 的 pfx 是在 guest 时钟“未来”创建的，重启后时钟回退会让 NotBefore > now，
# signtool 直接报 "signer's certificate is not valid for signing"。这里显式检查有效期，
# 不可用就重签（内核测试签名需要 1.3.6.1.5.5.7.3.5 = kernel-mode code signing）。
$pfx = 'C:\m0\dshnt-m1.pfx'
$pwd = ConvertTo-SecureString 'dshnt' -Force -AsPlainText
$pfxOk = $false
if (Test-Path $pfx) {
  try {
    $existing = Get-PfxCertificate -FilePath $pfx -Password $pwd
    $now = Get-Date
    if ($existing.NotBefore -le $now -and $existing.NotAfter -gt $now) { $pfxOk = $true }
    else { Log "pfx not valid in this clock: $($existing.NotBefore)..$($existing.NotAfter) now=$now" }
  } catch {
    Log "pfx unreadable: $($_.Exception.Message)"
  }
}
if (-not $pfxOk) {
  Remove-Item $pfx -Force -ErrorAction SilentlyContinue
  $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=dshnt-m1' `
    -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable `
    -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(2) `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3,1.3.6.1.5.5.7.3.5')
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd | Out-Null
  Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\Root -Password $pwd | Out-Null
  Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\LocalMachine\TrustedPublisher -Password $pwd | Out-Null
  Log "new signing cert $($cert.Thumbprint) valid $($cert.NotBefore)..$($cert.NotAfter)"
}
Log 'cert ready'

# 7. package + sign + install driver
#
# 实测结论（M1）：
#   · FltRegisterFilter 从 Services\<name>\Instances 读取高度；只写
#     Parameters\Instances 会以 0xC0000034 失败（INF 示例的那份写法不够）。
#   · WDK 的 Inf2Cat 在这台机器上缺 x86\InfVerif.dll，无法生成 catalog；
#     因此 v1 的安装走“签名 sys + sc create + 双 Instances”，并用 fltmc load 验证。
$pkg = Join-Path $Root 'pkg'
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force $pkg | Out-Null
Copy-Item -Force $sys.FullName (Join-Path $pkg 'dshnt.sys')
Copy-Item -Force (Join-Path $Root 'src\driver\dshnt.inf') (Join-Path $pkg 'dshnt.inf')

$builtCat = Get-ChildItem (Join-Path $Root 'src\driver') -Recurse -Filter dshnt.cat -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($builtCat) {
  Copy-Item -Force $builtCat.FullName (Join-Path $pkg 'dshnt.cat')
  Log "catalog from build: $($builtCat.FullName)"
}
if (-not (Test-Path (Join-Path $pkg 'dshnt.cat')) -and $inf2cat) {
  & $inf2cat "/driver:$pkg" /os:10_X64 *> (Join-Path $Share 'm1-inf2cat.log')
  Log "inf2cat exit=$LASTEXITCODE"
}

$svcKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\dshnt'
$svcReg = 'HKLM\SYSTEM\CurrentControlSet\Services\dshnt'

& fltmc unload dshnt 2>$null | Out-Null
Start-Sleep -Milliseconds 500

$installed = $false
if (Test-Path (Join-Path $pkg 'dshnt.cat')) {
  & $signtool sign /fd SHA256 /f $pfx /p dshnt (Join-Path $pkg 'dshnt.sys') (Join-Path $pkg 'dshnt.cat') *> (Join-Path $Share 'm1-sign.log')
  Log "sign exit=$LASTEXITCODE"
  if ($LASTEXITCODE -eq 0) {
    & pnputil /add-driver (Join-Path $pkg 'dshnt.inf') /install *> (Join-Path $Share 'm1-pnputil.log')
    Log "pnputil exit=$LASTEXITCODE"
    $installed = Test-Path $svcKey
  }
}

if (-not $installed) {
  # 无 catalog 路径：签名后的 sys + 服务键 + Filter Manager 需要的 Instances。
  & $signtool sign /fd SHA256 /f $pfx /p dshnt (Join-Path $pkg 'dshnt.sys') *> (Join-Path $Share 'm1-sign.log')
  $signExit = $LASTEXITCODE
  Log "sign(sys) exit=$signExit"
  if ($signExit -ne 0) { Fail 'signing dshnt.sys failed' @{ log = Tail (Join-Path $Share 'm1-sign.log') 30 } }
  Copy-Item -Force (Join-Path $pkg 'dshnt.sys') 'C:\Windows\System32\drivers\dshnt.sys'

  if (-not (Test-Path $svcKey)) {
    & sc.exe create dshnt type= filesys start= demand error= normal binPath= '\SystemRoot\System32\drivers\dshnt.sys' depend= FltMgr *> (Join-Path $Share 'm1-sc-create.log')
  }
  & sc.exe config dshnt group= 'FSFilter Activity Monitor' *>> (Join-Path $Share 'm1-sc-create.log')
  reg.exe add $svcReg /v DisplayName /t REG_SZ /d dshnt /f | Out-Null
  reg.exe add "$svcReg\Parameters" /v SupportedFeatures /t REG_DWORD /d 3 /f | Out-Null
  foreach ($base in @($svcReg, "$svcReg\Parameters")) {
    reg.exe add "$base\Instances" /v DefaultInstance /t REG_SZ /d dshnt /f | Out-Null
    reg.exe add "$base\Instances\dshnt" /v Altitude /t REG_SZ /d 371100 /f | Out-Null
    reg.exe add "$base\Instances\dshnt" /v Flags /t REG_DWORD /d 0 /f | Out-Null
  }
  $installed = Test-Path $svcKey
  Log "sc/registry install: service exists=$installed"
}

& fltmc load dshnt *> (Join-Path $Share 'm1-fltmc-load.log')
Log "fltmc load exit=$LASTEXITCODE"
$filters = (& fltmc filters) -join "`n"
if ($filters -notmatch 'dshnt') { Fail 'dshnt filter not loaded' @{ filters = $filters; load = Tail (Join-Path $Share 'm1-fltmc-load.log') 20; pnputil = Tail (Join-Path $Share 'm1-pnputil.log') 20; sc = Tail (Join-Path $Share 'm1-sc-create.log') 20 } }

$instances = (& fltmc instances -f dshnt) -join "`n"
if ($instances -notmatch 'C:') {
  & fltmc attach dshnt C: *> (Join-Path $Share 'm1-fltmc-attach.log')
  Log "fltmc attach exit=$LASTEXITCODE"
}
Log ((& fltmc instances -f dshnt) -join ' | ')

# 8. seed workspace / store / view
Get-Process dshnt-provider -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path C:\m1\ws) { cmd.exe /c 'rmdir /s /q C:\m1\ws' | Out-Null }
if (Test-Path C:\m1\view) { cmd.exe /c 'rmdir /s /q C:\m1\view' | Out-Null }
if (Test-Path C:\m1\store) { cmd.exe /c 'rmdir /s /q C:\m1\store' | Out-Null }
New-Item -ItemType Directory -Force C:\m1\ws\dir | Out-Null
New-Item -ItemType Directory -Force C:\m1\ws\secret | Out-Null
New-Item -ItemType Directory -Force C:\m1\view | Out-Null
New-Item -ItemType Directory -Force C:\m1\store | Out-Null
Set-Content -Path C:\m1\ws\a.txt -Value 'hello' -Encoding ASCII
Set-Content -Path C:\m1\ws\b.txt -Value 'v1' -Encoding ASCII
Set-Content -Path C:\m1\ws\dir\c.txt -Value 'c' -Encoding ASCII
Set-Content -Path C:\m1\ws\gone.txt -Value 'gone' -Encoding ASCII
Set-Content -Path C:\m1\ws\secret\k.txt -Value 'secret' -Encoding ASCII
Set-Content -Path C:\m1\ws\masked.txt -Value 'masked' -Encoding ASCII
Set-Content -Path C:\m1\store\secret.txt -Value 'store-secret' -Encoding ASCII
$lowerBefore = HashTree 'C:\m1\ws'
Log "lower before: $($lowerBefore.Count) files"

# 9. provider
$providerLog = 'C:\m1\provider.log'
Remove-Item $providerLog -Force -ErrorAction SilentlyContinue
$providerExe = Join-Path $Root 'provider\dshnt-provider.exe'
$proc = Start-Process -FilePath $providerExe -ArgumentList '--pipe', 'dshnt-provider-m1', '--log', $providerLog `
  -WindowStyle Hidden -PassThru
Log "provider pid=$($proc.Id)"
Start-Sleep -Seconds 3
if ($proc.HasExited) { Fail 'provider exited' @{ providerLog = Tail $providerLog 40 } }

$startReply = $null
$protectReply = $null
try {
  $startReply = Send-ProviderOp 'start' @{ domain = $policyInfo.domainId; workspace = 'C:\m1\ws'; view = 'C:\m1\view' }
  Log "provider start: $startReply"
  $protectReply = Send-ProviderOp 'protect' @{ value = $true }
  Log "provider protect: $protectReply"
} catch {
  Fail "provider control failed: $($_.Exception.Message)" @{ providerLog = Tail $providerLog 40 }
}
if ($startReply -notmatch '"ok":true') { Fail "provider start failed: $startReply" @{ providerLog = Tail $providerLog 40 } }

# 10. control plane: policy + domain
$ctlBin = Join-Path $Root 'bin\dshnt-ctl.exe'
& $ctlBin hello *> (Join-Path $Share 'm1-ctl-hello.log')
Log "ctl hello exit=${LASTEXITCODE}: $(Tail (Join-Path $Share 'm1-ctl-hello.log') 3)"
& $ctlBin policy (Join-Path $Root 'policy.bin') *> (Join-Path $Share 'm1-ctl-policy.log')
Log "ctl policy exit=${LASTEXITCODE}: $(Tail (Join-Path $Share 'm1-ctl-policy.log') 3)"
& $ctlBin register-domain $policyInfo.domainId 'C:\m1\ws' 'C:\m1\view' 'C:\m1\store' *> (Join-Path $Share 'm1-ctl-domain.log')
Log "ctl register-domain exit=$LASTEXITCODE"
& $ctlBin stats *> (Join-Path $Share 'm1-ctl-stats.log')
Log "ctl stats: $(Tail (Join-Path $Share 'm1-ctl-stats.log') 3)"

# 11. run the in-domain client
$launchArgs = @(
  '--domain', $policyInfo.domainId,
  '--view', 'C:\m1\view',
  '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)",
  '--network', 'observed',
  '--token', 'restricted',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--cwd', 'C:\m1\view',
  '--job-memory-mb', '2048',
  '--job-active-processes', '32',
  '--job-cpu-percent', '80',
  '--job-kill-on-close', '1',
  '--env-allow', 'PATH=C:\Windows\System32',
  '--',
  'C:\m1\bin\m1-client.exe'
)
$launcherBin = Join-Path $Root 'bin\dshnt-launch.exe'
& $launcherBin @launchArgs *> (Join-Path $Share 'm1-client-console.log')
$clientExit = $LASTEXITCODE
Log "client launcher exit=$clientExit"
$clientConsole = Tail (Join-Path $Share 'm1-client-console.log') 80
Log "client console tail:`n$clientConsole"

$clientJson = $null
if (Test-Path 'C:\m1\view\client-result.json') {
  $clientJson = Get-Content 'C:\m1\view\client-result.json' -Raw | ConvertFrom-Json
  Log "client result: checks=$($clientJson.checks) failures=$($clientJson.failures)"
} else {
  Log 'client-result.json missing'
}

# 12. network gate: restricted+offline 必须 fail-closed
$netArgs = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'offline', '--token', 'restricted',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @netArgs *> (Join-Path $Share 'm1-net-restricted-offline.log')
$restrictedOfflineExit = $LASTEXITCODE
Log "restricted+offline launcher exit=$restrictedOfflineExit (expect non-zero: fail-closed)"

# 13. appcontainer + offline（真正按包 SID 过滤）
$netArgs2 = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'offline', '--token', 'appcontainer',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @netArgs2 *> (Join-Path $Share 'm1-net-appcontainer-offline.log')
$acOfflineExit = $LASTEXITCODE
$acOfflineOut = Tail (Join-Path $Share 'm1-net-appcontainer-offline.log') 10
Log "appcontainer+offline exit=$acOfflineExit out=$acOfflineOut"

# 14. appcontainer + observed（对照组：应当能连上）
$netArgs3 = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'observed', '--token', 'appcontainer',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @netArgs3 *> (Join-Path $Share 'm1-net-appcontainer-observed.log')
$acObservedExit = $LASTEXITCODE
$acObservedOut = Tail (Join-Path $Share 'm1-net-appcontainer-observed.log') 10
Log "appcontainer+observed exit=$acObservedExit out=$acObservedOut"

# 15. appcontainer + allowlist：只放行显式端点
#     15a 端点端口不对 ⇒ 仍被阻断（证明 allow 不是“一键放行”）
$allowArgs = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'allowlist', '--token', 'appcontainer',
  '--allow', '172.30.112.1:446',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @allowArgs *> (Join-Path $Share 'm1-net-allowlist-blocked.log')
$allowBlockedExit = $LASTEXITCODE
$allowBlockedOut = Tail (Join-Path $Share 'm1-net-allowlist-blocked.log') 10
Log "allowlist(wrong port) exit=$allowBlockedExit out=$allowBlockedOut"

#     15b 端点命中 ⇒ 连接成功（证明 allow 条件真的生效）
$allowArgs2 = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'allowlist', '--token', 'appcontainer',
  '--allow', '172.30.112.1:445',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @allowArgs2 *> (Join-Path $Share 'm1-net-allowlist-allowed.log')
$allowAllowedExit = $LASTEXITCODE
$allowAllowedOut = Tail (Join-Path $Share 'm1-net-allowlist-allowed.log') 10
Log "allowlist(matching) exit=$allowAllowedExit out=$allowAllowedOut"

#     15c 空 allowlist ⇒ launcher 必须拒绝启动（不得静默当 offline）
$allowArgs3 = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'allowlist', '--token', 'appcontainer',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--', 'C:\m1\bin\m1-net.exe'
)
& $launcherBin @allowArgs3 *> (Join-Path $Share 'm1-net-allowlist-empty.log')
$allowEmptyExit = $LASTEXITCODE
Log "allowlist(empty) launcher exit=$allowEmptyExit (expect non-zero: fail-closed)"

# 16. mitigation / Job 回读（不是 launcher 自述，而是内核视角的事实）
$mitArgs = @(
  '--domain', $policyInfo.domainId, '--view', 'C:\m1\view', '--workspace', 'C:\m1\ws',
  '--policy-generation', "$($policyInfo.generation)", '--network', 'offline', '--token', 'appcontainer',
  '--integrity', $env:DSHNT_INTEGRITY,
  '--job-memory-mb', '1024', '--job-active-processes', '16', '--job-cpu-percent', '50', '--job-kill-on-close', '1',
  '--', 'C:\m1\bin\m1-mitigate.exe'
)
& $launcherBin @mitArgs *> (Join-Path $Share 'm1-mitigate.log')
$mitigateExit = $LASTEXITCODE
$mitigateOut = Tail (Join-Path $Share 'm1-mitigate.log') 20
Log "mitigate/job probe exit=$mitigateExit out=$mitigateOut"

# 17. 生命周期（supervisor 的关键路径）：注销 → 重新下发 generation+1 → 再注册
#     supervisor.down() 依赖 unregister 真的清域；up() 依赖 generation 单调递增。
& $ctlBin unregister-domain $policyInfo.domainId *> (Join-Path $Share 'm1-ctl-unregister.log')
$lcUnregisterExit = $LASTEXITCODE
& $ctlBin register-domain $policyInfo.domainId 'C:\m1\ws' 'C:\m1\view' 'C:\m1\store' *> (Join-Path $Share 'm1-ctl-reregister.log')
$lcRegisterWithoutPolicyExit = $LASTEXITCODE
& $ctlBin policy (Join-Path $Root 'policy2.bin') *> (Join-Path $Share 'm1-ctl-policy2.log')
$lcPolicy2Exit = $LASTEXITCODE
& $ctlBin register-domain $policyInfo.domainId 'C:\m1\ws' 'C:\m1\view' 'C:\m1\store' *> (Join-Path $Share 'm1-ctl-reregister2.log')
$lcRegister2Exit = $LASTEXITCODE
$lcStats = ((& $ctlBin stats) -join ' ').Trim()
$lcGeneration = 0
if ($lcStats -match 'generation=(\d+)') { $lcGeneration = [int]$Matches[1] }
$lcDomains = -1
if ($lcStats -match 'domains=(\d+)') { $lcDomains = [int]$Matches[1] }
Log "lifecycle unregister=$lcUnregisterExit registerWithoutPolicy=$lcRegisterWithoutPolicyExit policy2=$lcPolicy2Exit register2=$lcRegister2Exit stats=$lcStats"

# 18. verify lower unchanged + view state
$lowerAfter = HashTree 'C:\m1\ws'
$lowerDiff = @()
foreach ($k in $lowerBefore.Keys) {
  if (-not $lowerAfter.ContainsKey($k)) { $lowerDiff += "missing:$k" }
  elseif ($lowerAfter[$k] -ne $lowerBefore[$k]) { $lowerDiff += "changed:$k" }
}
foreach ($k in $lowerAfter.Keys) {
  if (-not $lowerBefore.ContainsKey($k)) { $lowerDiff += "added:$k" }
}
$viewB = $null
if (Test-Path 'C:\m1\view\b.txt') { $viewB = (Get-Content 'C:\m1\view\b.txt' -Raw).Trim() }
$lowerB = (Get-Content 'C:\m1\ws\b.txt' -Raw).Trim()
$viewA = Test-Path 'C:\m1\view\a.txt'
$viewChild = Test-Path 'C:\m1\view\child.txt'
$viewNew = Test-Path 'C:\m1\view\new.txt'
$viewMasked = Test-Path 'C:\m1\view\masked.txt'
$stats = Tail (Join-Path $Share 'm1-ctl-stats.log') 3

# 16. result
$checks = [ordered]@{
  providerRunning    = -not $proc.HasExited
  driverLoaded       = ($filters -match 'dshnt')
  policyGeneration   = $policyInfo.generation
  clientExit         = $clientExit
  clientChecks       = $(if ($clientJson) { $clientJson.checks } else { 0 })
  clientFailures     = $(if ($clientJson) { $clientJson.failures } else { -1 })
  viewB              = $viewB
  lowerB             = $lowerB
  stagedWrite        = ($viewB -eq 'v2' -and $lowerB -eq 'v1')
  viewHasChild       = $viewChild
  viewHasNew         = $viewNew
  viewHasMasked      = $viewMasked
  deletedAFromView   = -not $viewA
  lowerUnchanged     = ($lowerDiff.Count -eq 0)
  lowerDiff          = $lowerDiff
  restrictedOfflineExit = $restrictedOfflineExit
  restrictedOfflineFailClosed = ($restrictedOfflineExit -ne 0)
  appContainerOfflineExit = $acOfflineExit
  appContainerOfflineOutput = $acOfflineOut
  appContainerObservedExit = $acObservedExit
  appContainerObservedOutput = $acObservedOut
  allowlistBlockedExit = $allowBlockedExit
  allowlistBlockedOutput = $allowBlockedOut
  allowlistAllowedExit = $allowAllowedExit
  allowlistAllowedOutput = $allowAllowedOut
  allowlistEmptyExit = $allowEmptyExit
  mitigateExit = $mitigateExit
  mitigateOutput = $mitigateOut
  lifecycleUnregisterExit = $lcUnregisterExit
  lifecycleRegisterWithoutPolicyExit = $lcRegisterWithoutPolicyExit
  lifecyclePolicy2Exit = $lcPolicy2Exit
  lifecycleRegister2Exit = $lcRegister2Exit
  lifecycleGeneration = $lcGeneration
  lifecycleDomains = $lcDomains
  lifecycleStats = $lcStats
  # m1-net.exe: 0 = 连接被阻断（期望），1 = 连接成功（对照组）。
  # allowlist：错端口被阻断、命中端点放行、空列表 launcher 拒绝启动。
  networkGateWorks = ($acOfflineExit -eq 0 -and $acObservedExit -eq 1 -and
                      $allowBlockedExit -eq 0 -and $allowAllowedExit -eq 1 -and $allowEmptyExit -ne 0)
  stats              = $stats
  providerStart      = $startReply
  providerProtect    = $protectReply
  providerLog        = Tail $providerLog 30
  clientConsole      = $clientConsole
}

$networkOk = ($acOfflineExit -eq 0 -and $acObservedExit -eq 1 -and
              $allowBlockedExit -eq 0 -and $allowAllowedExit -eq 1 -and $allowEmptyExit -ne 0)
$mitigationOk = ($mitigateExit -eq 0)
# 注销后未下发新策略时 register 必须失败；下发 generation=2 后必须成功且 domains=1。
$lifecycleOk = ($lcUnregisterExit -eq 0) -and ($lcRegisterWithoutPolicyExit -ne 0) -and
               ($lcPolicy2Exit -eq 0) -and ($lcRegister2Exit -eq 0) -and
               ($lcGeneration -eq 2) -and ($lcDomains -eq 1)
$ok = ($clientExit -eq 0) -and ($lowerDiff.Count -eq 0) -and ($viewB -eq 'v2') -and ($lowerB -eq 'v1') -and
      ($null -ne $clientJson -and $clientJson.failures -eq 0) -and (-not $viewA) -and $viewChild -and $networkOk -and $mitigationOk -and $lifecycleOk
$payload = [ordered]@{
  ok = [bool]$ok
  phase = 'm1'
  at = (Get-Date).ToString('o')
  checks = $checks
}
[IO.File]::WriteAllText($ResultPath, ($payload | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
Log "RESULT ok=$ok -> $ResultPath"
exit $(if ($ok) { 0 } else { 1 })
