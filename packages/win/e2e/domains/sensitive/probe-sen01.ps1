# SEN-01 metadata-only probe. NEVER prints file contents; only existence / size / mtime / open-ability.
$ErrorActionPreference = 'SilentlyContinue'
$U = 'C:\Users\Administrator'
$LA = Join-Path $U 'AppData\Local'
$RA = Join-Path $U 'AppData\Roaming'
$targets = @(
  @{ p = "$U\.ssh"; k = 'dir' },
  @{ p = "$U\.ssh\id_rsa"; k = 'file' },
  @{ p = "$U\.ssh\id_ed25519"; k = 'file' },
  @{ p = "$U\.ssh\known_hosts"; k = 'file' },
  @{ p = "$U\.aws"; k = 'dir' },
  @{ p = "$U\.aws\credentials"; k = 'file' },
  @{ p = "$U\.azure"; k = 'dir' },
  @{ p = "$U\.azure\azureProfile.json"; k = 'file' },
  @{ p = "$U\.config\gcloud"; k = 'dir' },
  @{ p = "$U\.config\gcloud\credentials.db"; k = 'file' },
  @{ p = "$U\.dsh"; k = 'dir' },
  @{ p = "$U\.dsh\.credentials.yaml"; k = 'file' },
  @{ p = "$U\.dsh\profiles"; k = 'dir' },
  @{ p = "$LA\Google\Chrome\User Data\Default\Login Data"; k = 'file' },
  @{ p = "$LA\Google\Chrome\User Data\Default\Cookies"; k = 'file' },
  @{ p = "$LA\Google\Chrome\User Data\Default\Web Data"; k = 'file' },
  @{ p = "$RA\Microsoft\Credentials"; k = 'dir' },
  @{ p = "$LA\Microsoft\Credentials"; k = 'dir' },
  @{ p = "$RA\Microsoft\Protect"; k = 'dir' },
  @{ p = "$U\Documents"; k = 'dir' },
  @{ p = "$U\Desktop"; k = 'dir' },
  @{ p = "$U\Downloads"; k = 'dir' },
  @{ p = "$U\.git-credentials"; k = 'file' },
  @{ p = "$U\.npmrc"; k = 'file' },
  @{ p = "$RA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"; k = 'file' },
  @{ p = "$U\NTUSER.DAT"; k = 'file' }
)
Write-Output "PATH|EXISTS|TYPE|SIZE|MTIME|LIST_OR_READ|WRITE_OPEN|ACL_SID"
foreach ($t in $targets) {
  $p = $t.p
  $exists = Test-Path -LiteralPath $p
  if (-not $exists) { Write-Output "$p|False|||||"; continue }
  $type = '?'; $size = ''; $mtime = ''
  $item = $null
  try {
    $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    $type = if ($item.PSIsContainer) { 'dir' } else { 'file' }
    if (-not $item.PSIsContainer) { $size = $item.Length }
    $mtime = $item.LastWriteTime.ToString('s')
  } catch {
    $type = "ITEM_ERR:" + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ')
  }
  $rd = ''; $wr = ''
  if ($item -and -not $item.PSIsContainer) {
    try {
      $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
      $rd = "READ_OK:$($fs.Length)"
      $fs.Dispose()
    } catch { $rd = "READ_ERR:" + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ') }
    try {
      $fs = [System.IO.File]::Open($p, 'Open', 'Write', 'ReadWrite')
      $fs.Dispose()
      $wr = 'WRITEOPEN_OK(no bytes written)'
    } catch { $wr = "WRITEOPEN_ERR:" + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ') }
  } elseif ($item -and $item.PSIsContainer) {
    try { $n = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop).Count; $rd = "LIST_OK:$n" }
    catch { $rd = "LIST_ERR:" + $_.Exception.GetType().Name + ':' + ($_.Exception.Message -replace '\s+', ' ') }
  }
  $acl = ''
  try {
    $a = Get-Acl -LiteralPath $p -ErrorAction Stop
    $acl = (($a.Access | ForEach-Object { "$($_.IdentityReference.Value)=$($_.FileSystemRights)/$($_.AccessControlType)" }) -join ';')
    if ($acl.Length -gt 300) { $acl = $acl.Substring(0, 300) }
  } catch { $acl = 'ACL_ERR' }
  Write-Output "$p|$exists|$type|$size|$mtime|$rd|$wr|$acl"
}
