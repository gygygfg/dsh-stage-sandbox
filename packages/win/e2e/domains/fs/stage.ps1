# stage.ps1 - STAGE channel helpers: manifest lookup + staged mirror enumeration
# Usage: stage.ps1 -ManifestMatches 'fs01|fs03' [-StagedGlob ...]
param([string]$ManifestMatches = 'a^', [string]$StagedUnder = '')
$S = 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361'
$m = Get-Content "$S\manifest.json" -Raw | ConvertFrom-Json
Write-Output "manifest entries total=$($m.entries.PSObject.Properties.Count) hostOperations=$($m.hostOperations.Count)"
$m.entries.PSObject.Properties | Where-Object { $_.Name -match $ManifestMatches } | ForEach-Object {
  $v = $_.Value
  Write-Output ("STAGE-ENTRY {0} | state={1} | baseHash={2} | stagedHash={3} | symlink={4} | size={5} | origin={6}" -f $_.Name, $v.state, $v.baseHash, $v.stagedHash, $v.symlink, $v.size, $v.origin)
}
if ($StagedUnder) {
  Write-Output "--- staged listing under [$StagedUnder] ---"
  Get-ChildItem "$S\staged\fs\$StagedUnder" -Force -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("{0} {1}" -f $_.Mode, $_.FullName) }
}
