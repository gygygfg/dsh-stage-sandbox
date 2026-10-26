param([Parameter(Mandatory = $true)][string]$ResultPath)

$ErrorActionPreference = 'Stop'
$resultDir = Split-Path -Parent $ResultPath
if (-not [string]::IsNullOrWhiteSpace($resultDir)) { New-Item -ItemType Directory -Force $resultDir | Out-Null }
$out = [ordered]@{
  ok        = $true
  cwd       = (Get-Location).Path
  files     = [ordered]@{}
  sensitive = [ordered]@{}
}
$utf8 = [Text.UTF8Encoding]::new($false)

function Hash-Bytes([byte[]]$bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

try {
  # 1) Text round-trip (UTF-8, CJK, CRLF).
  $textPath = Join-Path $PWD 'e2e-text.txt'
  $text = "Hello 沙箱`r`nline-2`r`n"
  [IO.File]::WriteAllText($textPath, $text, $utf8)
  $out.files.text = [ordered]@{
    path     = 'e2e-text.txt'
    bytes    = (Get-Item -LiteralPath $textPath).Length
    sha256   = (Get-FileHash -LiteralPath $textPath -Algorithm SHA256).Hash.ToLowerInvariant()
    readback = [IO.File]::ReadAllText($textPath, [Text.Encoding]::UTF8)
  }

  # 2) Binary round-trip (all byte values, repeated; NUL is present).
  $binPath = Join-Path $PWD 'e2e-binary.bin'
  $bin = [byte[]]::new(4096)
  for ($i = 0; $i -lt $bin.Length; $i++) { $bin[$i] = [byte]($i % 256) }
  [IO.File]::WriteAllBytes($binPath, $bin)
  $readBin = [IO.File]::ReadAllBytes($binPath)
  $out.files.binary = [ordered]@{
    path    = 'e2e-binary.bin'
    bytes   = $readBin.Length
    sha256  = Hash-Bytes $readBin
    first16 = ([BitConverter]::ToString($readBin[0..15]) -replace '-', '').ToLowerInvariant()
    nulAt0  = ($readBin[0] -eq 0)
  }

  # 3) Fake key material. It is deliberately fake; never a real credential.
  #    The path is a sensitive-mask probe as well: a shell read may be denied,
  #    which is a PASS for masking and is recorded separately from the write.
  $keyPath = Join-Path $PWD 'e2e-key.pem'
  $fakeKey = "-----BEGIN PRIVATE KEY-----`nFAKE-R48-OPENSSH-PRIVATE-KEY-MATERIAL-ONLY`n-----END PRIVATE KEY-----`n"
  $keyBytes = $utf8.GetBytes($fakeKey)
  $key = [ordered]@{
    path   = 'e2e-key.pem'
    bytes  = $keyBytes.Length
    sha256 = Hash-Bytes $keyBytes
  }
  try {
    [IO.File]::WriteAllText($keyPath, $fakeKey, $utf8)
    $key.writeOk = $true
  } catch {
    $key.writeOk = $false
    $key.writeError = $_.Exception.Message
  }
  try {
    $key.readback = [IO.File]::ReadAllText($keyPath, [Text.Encoding]::UTF8)
    $key.readBlocked = $false
  } catch {
    $key.readBlocked = $true
    $key.readError = $_.Exception.Message
  }
  $out.files.key = $key

  # 4) Read the pre-seeded sensitive fixtures (the shell may or may not mask).
  foreach ($rel in @('sensitive/fake.pem', 'sensitive/.ssh/id_ed25519')) {
    $p = Join-Path $PWD $rel
    try {
      if (-not (Test-Path -LiteralPath $p)) {
        $out.sensitive[$rel] = [ordered]@{ exists = $false }
        continue
      }
      $content = [IO.File]::ReadAllText($p)
      $out.sensitive[$rel] = [ordered]@{
        exists       = $true
        bytes        = (Get-Item -LiteralPath $p).Length
        sha256       = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
        contains     = $content.Contains('FAKE-R48')
        readBlocked  = $false
      }
    } catch {
      $out.sensitive[$rel] = [ordered]@{
        exists      = $null
        readBlocked = $true
        readError   = $_.Exception.Message
      }
    }
  }

  [IO.File]::WriteAllText($ResultPath, ($out | ConvertTo-Json -Depth 8), $utf8)
} catch {
  $out.ok = $false
  $out.error = $_.Exception.Message
  [IO.File]::WriteAllText($ResultPath, ($out | ConvertTo-Json -Depth 8), $utf8)
  exit 1
}
