param([Parameter(Mandatory = $true)][string]$ResultPath)

$ErrorActionPreference = 'Continue'
$resultDir = Split-Path -Parent $ResultPath
if (-not [string]::IsNullOrWhiteSpace($resultDir)) { New-Item -ItemType Directory -Force $resultDir | Out-Null }
$out = [ordered]@{ ok = $true; repo = (Join-Path $PWD 'git-e2e'); ops = [ordered]@{} }
$utf8 = [Text.UTF8Encoding]::new($false)

function Invoke-Git([string[]]$argv) {
  # Use git.exe explicitly: a PowerShell function named Git would otherwise
  # capture the case-insensitive `git` token and recurse until call-depth overflow.
  $text = (& git.exe @argv 2>&1 | Out-String).Trim()
  return [ordered]@{ code = $LASTEXITCODE; text = $text }
}

try {
  $repo = $out.repo
  if (Test-Path -LiteralPath $repo) { Remove-Item -LiteralPath $repo -Recurse -Force }
  New-Item -ItemType Directory -Force $repo | Out-Null

  $out.ops.init = Invoke-Git @('init', '-b', 'main', $repo)
  $out.ops.configEmail = Invoke-Git @('-C', $repo, 'config', 'user.email', 'e2e@example.invalid')
  $out.ops.configName = Invoke-Git @('-C', $repo, 'config', 'user.name', 'WinStage E2E')
  $out.ops.configAutocrlf = Invoke-Git @('-C', $repo, 'config', 'core.autocrlf', 'false')

  [IO.File]::WriteAllText((Join-Path $repo 'a.txt'), "one`n", $utf8)
  $out.ops.add1 = Invoke-Git @('-C', $repo, 'add', '.')
  $out.ops.commit1 = Invoke-Git @('-C', $repo, 'commit', '-m', 'initial')

  [IO.File]::WriteAllText((Join-Path $repo 'b.txt'), "feature`n", $utf8)
  $out.ops.add2 = Invoke-Git @('-C', $repo, 'add', 'b.txt')
  $out.ops.commit2 = Invoke-Git @('-C', $repo, 'commit', '-m', 'feature file')
  $out.ops.tag = Invoke-Git @('-C', $repo, 'tag', 'v1')
  $out.ops.branchFeature = Invoke-Git @('-C', $repo, 'checkout', '-b', 'feature')

  [IO.File]::WriteAllText((Join-Path $repo 'c.txt'), "feature-two`n", $utf8)
  $out.ops.add3 = Invoke-Git @('-C', $repo, 'add', 'c.txt')
  $out.ops.commit3 = Invoke-Git @('-C', $repo, 'commit', '-m', 'feature two')

  $out.ops.log = Invoke-Git @('-C', $repo, 'log', '--oneline', '--decorate', '--all')
  $out.ops.branch = Invoke-Git @('-C', $repo, 'branch', '-vv')
  $out.ops.status = Invoke-Git @('-C', $repo, 'status', '--short')
  $out.ops.diffStat = Invoke-Git @('-C', $repo, 'diff', '--stat', 'main...feature')

  [IO.File]::AppendAllText((Join-Path $repo 'a.txt'), "working-change`n", $utf8)
  $out.ops.statusDirty = Invoke-Git @('-C', $repo, 'status', '--short')
  $out.ops.stash = Invoke-Git @('-C', $repo, 'stash', 'push', '-m', 'e2e-stash')
  $out.ops.stashList = Invoke-Git @('-C', $repo, 'stash', 'list')
  $out.ops.stashPop = Invoke-Git @('-C', $repo, 'stash', 'pop')

  $out.ops.checkoutMain = Invoke-Git @('-C', $repo, 'checkout', 'main')
  $out.ops.merge = Invoke-Git @('-C', $repo, 'merge', '--no-ff', 'feature', '-m', 'merge feature')
  $out.ops.head = Invoke-Git @('-C', $repo, 'rev-parse', 'HEAD')

  # Local clone (no network): proves git's object/transport path works too.
  $clone = Join-Path $PWD 'git-clone'
  if (Test-Path -LiteralPath $clone) { Remove-Item -LiteralPath $clone -Recurse -Force }
  $out.ops.clone = Invoke-Git @('clone', $repo, $clone)
  $out.ops.cloneLog = Invoke-Git @('-C', $clone, 'log', '--oneline', '-1')

  $out.ops.finalStatus = Invoke-Git @('-C', $repo, 'status', '--short')
  $out.gitDirExists = Test-Path -LiteralPath (Join-Path $repo '.git')
  $out.cloneExists = Test-Path -LiteralPath $clone

  [IO.File]::WriteAllText($ResultPath, ($out | ConvertTo-Json -Depth 10), $utf8)
} catch {
  $out.ok = $false
  $out.error = $_.Exception.Message
  [IO.File]::WriteAllText($ResultPath, ($out | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  exit 1
}
