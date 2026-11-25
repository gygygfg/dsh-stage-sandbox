// @ts-nocheck —— 与既有测试脚本一致：纯 node 断言，不参与 tsc 严格检查。
/**
 * `.git` 路径分类 / 发布顺序 / 危险子命令守卫（纯函数）。
 *
 * 这套断言的作用不是「覆盖代码」，而是把**安全语义**钉死：
 *   · config / hooks / info 必须永远不可发布（否则钩子与 core.hooksPath 就是后门）；
 *   · 锁与 gc 日志必须不可发布（它们不是状态）；
 *   · 发布顺序必须「对象 → 普通 → 指针」（否则会产生悬空引用）；
 *   · `git gc/prune/repack` 必须被拒绝（会删真实对象，暂存层无法回滚）。
 *
 * 用法：`node tests/git-path.ts`；`--plant` 会故意破坏一条规则并断言测试变红。
 */
import {
  findDestructiveGitCommand,
  gitApplyRank,
  gitPathClass,
  gitRepoRootOf,
  isGitControlPath,
  isGitPublishable,
  orderForApply,
} from '../src/git-path.ts'

const PLANT = process.argv.includes('--plant')
let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
}

process.stdout.write('# .git 路径分类\n')
const table = [
  ['.git/objects/ab/cdef', 'object'],
  ['.git/objects', 'object'],
  ['.git/index', 'pointer'],
  ['.git/HEAD', 'pointer'],
  ['.git/head', 'pointer'],
  ['.git/refs/heads/main', 'pointer'],
  ['.git/logs/HEAD', 'pointer'],
  ['.git/packed-refs', 'pointer'],
  ['.git/shallow', 'pointer'],
  ['.git/commondir', 'pointer'],
  ['.git/worktrees/wt/HEAD', 'pointer'],
  ['.git/index.lock', 'transient'],
  ['.git/gc.log', 'transient'],
  ['.git/config', 'other'],
  ['.git/config.worktree', 'other'],
  ['.git/hooks/pre-commit', 'other'],
  ['.git/hooks/post-commit', 'other'],
  ['.git/info/exclude', 'other'],
  ['.git/modules/sub/config', 'other'],
  ['.git/description', 'other'],
  ['.git', undefined],
  ['src/app.js', undefined],
  ['src/.gitignore', undefined],
  ['C:\\\\repo\\\\.git\\\\hooks\\\\pre-commit', 'other'],
  ['C:/repo/.git/objects/ab/cdef', 'object'],
  ['vendor/lib/.git/index', 'pointer'],
]
for (const [path, expected] of table) {
  const actual = gitPathClass(path)
  check(`${path} → ${String(expected)}`, actual === expected, `实际 ${String(actual)}`)
}

if (PLANT) {
  // 植入断言：把 hooks **当成可发布**；代码正确时它必然变红（证明本测试能发现回归）。
  check('plant: hooks 必须不可发布（正确实现下这条应当失败）', isGitPublishable('.git/hooks/pre-commit') === true)
}

process.stdout.write('\n# 可发布性\n')
check('objects 可发布', isGitPublishable('.git/objects/aa/bb') === true)
check('index 可发布', isGitPublishable('.git/index') === true)
check('config 不可发布', isGitPublishable('.git/config') === false)
check('hooks 不可发布', isGitPublishable('.git/hooks/pre-push') === false)
check('普通文件不受限', isGitPublishable('src/app.js') === true)
check('isGitControlPath(.git/index)', isGitControlPath('.git/index') === true)
check('isGitControlPath(src/a)', isGitControlPath('src/a') === false)

process.stdout.write('\n# 发布顺序\n')
check('对象 rank 0', gitApplyRank('.git/objects/aa/bb') === 0)
check('普通 rank 1', gitApplyRank('src/a.js') === 1)
check('指针 rank 2', gitApplyRank('.git/index') === 2)
check('config rank -1（禁止）', gitApplyRank('.git/config') === -1)

const ordered = orderForApply([
  { path: '.git/refs/heads/main' },
  { path: 'src/a.js' },
  { path: '.git/objects/aa/bb' },
  { path: '.git/index' },
])
check(
  '排序为 对象 → 普通 → 指针(index) → 指针(refs)',
  ordered.map((c) => c.path).join('|') ===
    ['.git/objects/aa/bb', 'src/a.js', '.git/index', '.git/refs/heads/main'].join('|'),
  ordered.map((c) => c.path).join('|'),
)

process.stdout.write('\n# 仓库根\n')
check('工作区根仓库', gitRepoRootOf('.git/index') === '')
check('嵌套仓库', gitRepoRootOf('vendor/lib/.git/index') === 'vendor/lib')
check('绝对路径', gitRepoRootOf('C:/repo/.git/HEAD') === 'C:/repo')
check('非 git 路径', gitRepoRootOf('src/a.js') === undefined)

process.stdout.write('\n# 危险 git 子命令\n')
const deny = [
  ['git gc', 'gc'],
  ['git prune', 'prune'],
  ['git repack -ad', 'repack'],
  ['git prune-packed', 'prune-packed'],
  ['git maintenance run', 'maintenance'],
  ['git filter-branch --all', 'filter-branch'],
  ['git.exe gc --prune=now', 'gc'],
  ['git -C repo gc', 'gc'],
  ['git -c core.x=1 repack -a', 'repack'],
  ['cmd /c "git gc"', 'gc'],
  ['powershell -Command "git prune"', 'prune'],
  ['C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe gc', 'gc'],
]
for (const [line, expected] of deny) {
  const hit = findDestructiveGitCommand(line)
  check(`拒绝：${line}`, hit !== undefined && hit.subcommand === expected, JSON.stringify(hit))
}
const allow = [
  'git status',
  'git log --oneline',
  'git diff HEAD~1',
  'git add -A',
  'git commit -m x',
  'git checkout -- a.js',
  'git -C repo status',
  'git stash list',
  'git worktree list',
  'git clone https://example.com/x',
  'git init',
  'gitleaks detect',
  'npm run git-gc-check',
  'echo "git gc"',
]
for (const line of allow) {
  const hit = findDestructiveGitCommand(line)
  check(`放行：${line}`, hit === undefined, JSON.stringify(hit))
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${assertions - failures}/${assertions} 条断言通过\n`)
process.exit(failures === 0 ? 0 : 1)
