$ws='C:\Users\Administrator\Desktop\WinStageSandbox'
$st="$ws\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361\staged"
$o="$ws\_sandbox-tests\_lead\bg-realdisk-observer.txt"
"" | Set-Content $o
"pid=$PID" | Add-Content $o
"shim-env=" + [bool]$env:DSH_REGSTAGE_ROOT | Add-Content $o
"staging-env=" + $env:DSH_STAGING | Add-Content $o
"--- real-disk existence (absolute, this process) ---"
$targets = @(
  "$ws\_sandbox-tests\pip\evidence\write-tool-marker.txt",
  "$ws\_sandbox-tests\_lead\hardlink-alias.txt",
  "$ws\_sandbox-tests\PROTOCOL.md",
  "$ws\_sandbox-tests\pip\results.json",
  "$st\fs\C\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\pip\evidence\write-tool-marker.txt",
  "$st\fs\C\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\PROTOCOL.md"
)
foreach($t in $targets){
  $exists = [System.IO.File]::Exists($t)
  $len = if($exists){ [System.IO.FileInfo]::new($t).Length } else { -1 }
  "$exists`t$len`t$t" | Add-Content $o
}
"--- loaded modules containing winstage (is this process shimmed?) ---"
$mods = [System.Diagnostics.Process]::GetCurrentProcess().Modules | Where-Object { $_.ModuleName -like '*winstage*' } | ForEach-Object { $_.ModuleName }
"winstage-mods=" + ($mods -join ',') | Add-Content $o
"--- delete the real hardlink from this process ---"
try { [System.IO.File]::Delete("$ws\_sandbox-tests\_lead\hardlink-alias.txt"); "delete-called=OK" | Add-Content $o } catch { "delete-error=" + $_.Exception.Message | Add-Content $o }
"hardlink-alias-exists-after=" + [System.IO.File]::Exists("$ws\_sandbox-tests\_lead\hardlink-alias.txt") | Add-Content $o
Get-Content $o -Raw
