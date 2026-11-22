# Build + sign + install dshnt.sys (test signing).
#
#   .\install.ps1 -Configuration Release -Install
#   .\install.ps1 -Configuration Release -Uninstall
#
# Requirements: WDK (WindowsKernelModeDriver10.0 toolset), admin PowerShell,
#               testsigning ON (bcdedit /set testsigning on + reboot).
#
# Why not `sc create`: M0 proved that "sc create + hand-written Instances" is
# not equivalent to an INF install; fltmc load returned 0x80070002 and
# FilterManager logged 0xC0000034. The INF path (pnputil + signed catalog) works.

[CmdletBinding()]
param(
  [string]$Configuration = 'Release',
  [string]$CertificateThumbprint,
  [string]$PfxPath,
  [string]$PfxPassword,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pkg  = Join-Path $Here 'pkg'
$Sys  = Join-Path $Pkg 'dshnt.sys'
$Inf  = Join-Path $Pkg 'dshnt.inf'
$Cat  = Join-Path $Pkg 'dshnt.cat'

function Get-VsWhere {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) { return $vswhere }
  return $null
}

function Find-MSBuild {
  $vswhere = Get-VsWhere
  if ($vswhere) {
    $path = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    if ($path) { return $path }
  }
  foreach ($p in @("C:\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
                   "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
                   "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe")) {
    if (Test-Path $p) { return $p }
  }
  throw 'MSBuild.exe not found (install VS Build Tools + WDK).'
}

function Find-KitTool([string]$name) {
  $root = 'C:\Program Files (x86)\Windows Kits\10\bin'
  $hit = Get-ChildItem $root -Recurse -Filter $name -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $hit) { throw "$name not found under $root" }
  return $hit.FullName
}

if ($Uninstall) {
  Write-Host 'fltmc unload dshnt'
  & fltmc unload dshnt 2>$null
  $oem = & pnputil /enum-drivers | Out-String
  if ($oem -match 'dshnt\.inf') {
    # pnputil 删除：按 INF 名找到 oemXX.inf
    $lines = (& pnputil /enum-drivers) -join "`n"
    $m = [regex]::Matches($lines, 'oem\d+\.inf[\s\S]*?dshnt\.inf')
    foreach ($hit in $m) {
      $oemInf = ($hit.Value -split "`n")[0].Trim()
      if ($oemInf -match '^oem\d+\.inf$') {
        Write-Host "pnputil /delete-driver $oemInf /uninstall"
        & pnputil /delete-driver $oemInf /uninstall /force
      }
    }
  }
  return
}

Write-Host "build $Configuration x64"
$msbuild = Find-MSBuild
& $msbuild (Join-Path $Here 'dshnt.vcxproj') /p:Configuration=$Configuration /p:Platform=x64 /m /v:minimal
if ($LASTEXITCODE -ne 0) { throw "msbuild failed ($LASTEXITCODE)" }

$built = Get-ChildItem $Here -Recurse -Filter dshnt.sys | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) { throw 'dshnt.sys not produced' }

New-Item -ItemType Directory -Force $Pkg | Out-Null
Copy-Item -Force $built.FullName $Sys
Copy-Item -Force (Join-Path $Here 'dshnt.inf') $Inf

# Catalog (inf2cat) is required for pnputil /install to accept the package.
$inf2cat = Find-KitTool 'Inf2Cat.exe'
& $inf2cat /os:10_X64 /driver:$Pkg
if ($LASTEXITCODE -ne 0) { throw "inf2cat failed ($LASTEXITCODE)" }

if (-not $SkipSign) {
  $signtool = Find-KitTool 'signtool.exe'
  if ($PfxPath) {
    & $signtool sign /fd SHA256 /f $PfxPath /p $PfxPassword $Sys $Cat
    if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
  } elseif ($CertificateThumbprint) {
    & $signtool sign /fd SHA256 /sha1 $CertificateThumbprint $Sys $Cat
    if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
  } else {
    throw 'Pass -PfxPath/-PfxPassword or -CertificateThumbprint (or -SkipSign for a lab-only unsigned build).'
  }
}

if ($Install) {
  Write-Host 'pnputil /add-driver dshnt.inf /install'
  & pnputil /add-driver $Inf /install
  if ($LASTEXITCODE -ne 0) { throw "pnputil failed ($LASTEXITCODE)" }
  Write-Host 'fltmc load dshnt'
  & fltmc load dshnt
  if ($LASTEXITCODE -ne 0) { throw "fltmc load failed ($LASTEXITCODE)" }
  & fltmc filters
}
