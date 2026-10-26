param([Parameter(Mandatory = $true)][string]$ResultPath)

$ErrorActionPreference = 'Continue'
$resultDir = Split-Path -Parent $ResultPath
if (-not [string]::IsNullOrWhiteSpace($resultDir)) { New-Item -ItemType Directory -Force $resultDir | Out-Null }
$out = [ordered]@{
  ok       = $true
  cwd      = (Get-Location).Path
  env      = [ordered]@{}
  envKeys  = @()
  commands = [ordered]@{}
  probes   = [ordered]@{}
}

function Capture([scriptblock]$block) {
  try {
    $text = (& $block 2>&1 | Out-String).Trim()
    return [ordered]@{ ok = $true; text = $text }
  } catch {
    return [ordered]@{ ok = $false; text = $_.Exception.Message }
  }
}

# Stable, non-secret environment values. TEMP/TMP are intentionally captured
# separately because a sandbox is allowed to rewrite them.
foreach ($name in @(
    'USERNAME', 'USERPROFILE', 'USERDOMAIN', 'COMPUTERNAME', 'SystemRoot',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
    'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'PATH'
  )) {
  $out.env[$name] = [Environment]::GetEnvironmentVariable($name)
}
$out.envKeys = @([Environment]::GetEnvironmentVariables().Keys | Sort-Object)
$out.winstageEnv = @($out.envKeys | Where-Object { $_ -match 'WINSTAGE' })

$out.commands.whoami  = Capture { whoami }
$out.commands.hostname = Capture { hostname }
$out.commands.ver     = Capture { cmd /c ver }
$out.commands.git     = Capture { git --version }
$out.commands.node    = Capture { node --version }
$out.commands.pwsh    = Capture { $PSVersionTable.PSVersion.ToString() }
$out.commands.gitPath = Capture { (Get-Command git).Source }
$out.commands.cwdList = Capture { Get-ChildItem -Force | Select-Object -ExpandProperty Name }

# Safe, ordinary operations used by a developer every day.
$out.probes.writeRead = Capture {
  $p = Join-Path $PWD 'e2e-shell.txt'
  Set-Content -LiteralPath $p -Value 'shell-ok' -Encoding utf8
  Get-Content -LiteralPath $p -Raw
}
$out.probes.pipeline = Capture { 1..5 | ForEach-Object { $_ * 2 } | Measure-Object -Sum | Select-Object -ExpandProperty Sum }
$out.probes.getDate  = Capture { (Get-Date).GetType().Name }
$out.probes.json     = Capture { @{ a = 1; b = 'two' } | ConvertTo-Json -Compress }

[IO.File]::WriteAllText($ResultPath, ($out | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
