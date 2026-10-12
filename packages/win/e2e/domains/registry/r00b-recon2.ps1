. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-00b' 'Recon2: PS version, journal dump, shim.log, candidate real keys'

RNote ("PSVersion=" + $PSVersionTable.PSVersion.ToString() + " Edition=" + $PSVersionTable.PSEdition)

# journal as text
$jp = Join-Path $script:Stage 'registry\overlay.journal'
$bytes = [System.IO.File]::ReadAllBytes($jp)
RLog ("journal bytes=" + $bytes.Length)
$txt = [System.Text.Encoding]::UTF8.GetString($bytes)
$printable = -join ($txt.ToCharArray() | ForEach-Object { if ([int]$_ -ge 32 -and [int]$_ -lt 127) { $_ } else { '.' } })
for ($i = 0; $i -lt $printable.Length; $i += 200) {
  $line = $printable.Substring($i, [Math]::Min(200, $printable.Length - $i))
  Write-Output $line; RLog $line
}

# locate shim.log
RLog '--- shim.log candidates'
foreach ($p in @(
  'C:\Users\Administrator\Desktop\WinStageSandbox\shim.log',
  'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\shim.log',
  (Join-Path $script:Stage 'shim.log'),
  (Join-Path $script:Stage 'candidates\shim.log'))) {
  $ex = Test-Path -LiteralPath $p
  RLog ("shimlog? {0} => {1}" -f $p, $ex)
  if ($ex) {
    $i = Get-Item -LiteralPath $p
    RLog ("   size={0} mtime={1}" -f $i.Length, $i.LastWriteTime.ToString('o'))
    $tail = Get-Content -LiteralPath $p -Tail 40
    foreach ($l in $tail) { Write-Output ("SHIM> " + $l); RLog ("SHIM> " + $l) }
  }
}

# staged probe visibility in this process (marker used for injection detection)
RPsl 'PS read of Lead staged key + real keys' {
  $out = @()
  foreach ($k in @(
    'HKCU:\Software\DshSandboxProbe',
    'HKLM:\Software\DshSandboxProbe',
    'HKCU:\Software\7-Zip',
    'HKCU:\Software\Microsoft\Notepad',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run')) {
    $ex = Test-Path -LiteralPath $k
    $line = "PS`t{0}`texists={1}" -f $k, $ex
    if ($ex) {
      try {
        $props = Get-ItemProperty -LiteralPath $k -ErrorAction Stop
        $names = ($props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name }) -join ','
        $line += "`tvalues=" + $names
      } catch { $line += "`tERR=" + $_.Exception.Message }
    }
    $out += $line
  }
  $out
}
RRun 'reg query staged probe + real keys' 'reg query "HKCU\Software\DshSandboxProbe" & reg query "HKLM\Software\DshSandboxProbe" & reg query "HKCU\Software\7-Zip" & reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion" /v ProductName & reg query "HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs" /v AllFlights & echo RC=%errorlevel%'
RNote 'recon2 done'
