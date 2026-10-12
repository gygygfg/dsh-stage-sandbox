. ([scriptblock]::Create((Get-Content -LiteralPath 'C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\registry\lib.ps1' -Raw)))
RSec 'REG-00c' 'Injection scope: is THIS pwsh injected? are its children injected?'

function ShowMods($proc, $tag) {
  try {
    $m = $proc.Modules | Where-Object { $_.ModuleName -like '*winstage*' -or $_.ModuleName -like '*shim*' }
    if ($m) { foreach ($x in $m) { $l = "MOD`t$tag`t$($proc.Id)`t$($x.ModuleName)`t$($x.FileName)"; Write-Output $l; RLog $l } }
    else { $l = "MOD`t$tag`t$($proc.Id)`t<none>"; Write-Output $l; RLog $l }
  } catch { $l = "MOD`t$tag`t$($proc.Id)`tERR $($_.Exception.Message)"; Write-Output $l; RLog $l }
}

$meP = Get-Process -Id $PID
ShowMods $meP 'self-pwsh'

RLog '--- env markers in this process'
Get-ChildItem env: | Where-Object { $_.Name -match 'WINSTAGE|DSH|STAGE|SHIM' } | ForEach-Object {
  $l = "ENV`t$($_.Name)=$($_.Value)"; Write-Output $l; RLog $l
}

# spawn a child that lives ~6s, then inspect its modules and whether it got its own overlay hive
$regdir = Join-Path $script:Stage 'registry'
$before = (Get-ChildItem -LiteralPath $regdir -File | Where-Object Name -like 'overlay.*.hive').Count
$child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'ping -n 7 127.0.0.1 >nul' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 900
$child.Refresh()
ShowMods $child 'child-cmd'
$after = Get-ChildItem -LiteralPath $regdir -File | Where-Object Name -like 'overlay.*.hive'
$own = $after | Where-Object Name -eq ("overlay.{0}.hive" -f $child.Id)
RNote ("overlay hives before={0} after={1} childOwnHive={2}" -f $before, $after.Count, [bool]$own)
$child.WaitForExit()
RNote ("child-cmd exit=" + $child.ExitCode)

# also: does a child powershell get a hive? (this is how the harness runs me)
$before2 = (Get-ChildItem -LiteralPath $regdir -File | Where-Object Name -like 'overlay.*.hive').Count
$ps = Start-Process -FilePath 'pwsh.exe' -ArgumentList '-NoProfile', '-Command', 'Start-Sleep -Seconds 4' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1200
$ps.Refresh()
ShowMods $ps 'child-pwsh'
$hives2 = Get-ChildItem -LiteralPath $regdir -File | Where-Object Name -like 'overlay.*.hive'
$own2 = $hives2 | Where-Object Name -eq ("overlay.{0}.hive" -f $ps.Id)
RNote ("child-pwsh ownHive={0}" -f [bool]$own2)
$ps.WaitForExit()
RNote ("child-pwsh exit=" + $ps.ExitCode)

# journal readability with explicit share mode
$jp = Join-Path $regdir 'overlay.journal'
try {
  $fs = [System.IO.File]::Open($jp, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  $buf = New-Object byte[] $fs.Length
  [void]$fs.Read($buf, 0, $buf.Length)
  $fs.Close()
  RLog ("journal read OK bytes=" + $buf.Length)
  $t = [System.Text.Encoding]::UTF8.GetString($buf)
  $pr = -join ($t.ToCharArray() | ForEach-Object { if ([int]$_ -ge 32 -and [int]$_ -lt 127) { $_ } else { '.' } })
  for ($i = 0; $i -lt $pr.Length; $i += 180) { $l = $pr.Substring($i, [Math]::Min(180, $pr.Length - $i)); Write-Output ("JRN> " + $l); RLog ("JRN> " + $l) }
} catch { RNote ("journal read FAILED: " + $_.Exception.Message) }
RNote 'injection scope recon done'
