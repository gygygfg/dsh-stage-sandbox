// @ts-nocheck —— 与既有测试脚本一致：纯 node 断言，不参与 tsc 严格检查。
/**
 * `.git` 引用完整性闸门（真实仓库 + 真实 index/pack）。
 *
 * 为什么要用真实仓库：index 的二进制布局、pack 的 fanout 表、packed-refs 的格式
 * 都不是凭文档能写对的；用 `git init` + `commit` + `repack -ad` 造出真数据，
 * 才能证明闸门「在真实对象库上不误报、在悬空引用上不放过」。
 *
 * 覆盖：
 *   · 健康仓库（HEAD + refs + index 全部可解析）→ 放行；
 *   · 对象被打包（repack -ad）后仍能通过 pack 索引找到 → 放行；
 *   · HEAD 指向不存在的对象 → GIT_REFERENTIAL_INTEGRITY；
 *   · index 里的 blob 被改成不存在的 OID → GIT_REFERENTIAL_INTEGRITY；
 *   · 候选里带 `.git/config` / `.git/hooks/*` / `.git/index.lock` → SANDBOX_GIT_INTERNAL；
 *   · 候选里的对象（`.git/objects/xx/yy`）即使还不在盘上也算存在 → 放行；
 *   · 非 `.git` 候选 → 直接放行（不由本闸门管辖）。
 *
 * 用法：`node tests/git-integrity.ts`（需要 PATH 里有 git）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkGitIntegrity,
  createObjectStore,
  parseIndexBlobOids,
  parsePackedRefs,
} from '../src/git-integrity.ts'

let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
}

// `git` 不存在时如实 SKIP（不是 PASS）：这两套件断言的是 git 语义，缺工具就没有证据。
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  process.stdout.write('SKIP：PATH 里没有 git，无法验证 git 语义\n')
  process.exit(0)
}

const sandbox = mkdtempSync(join(tmpdir(), 'winstage-gitint-'))
const repo = join(sandbox, 'repo')
mkdirSync(repo, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
const init = () => {
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=e@example.com', '-c', 'user.name=E', 'commit', '-q', '--allow-empty', '-m', 'root')
  writeFileSync(join(repo, 'a.txt'), 'alpha\n')
  writeFileSync(join(repo, 'b.txt'), 'beta\n')
  git('add', 'a.txt', 'b.txt')
  git('-c', 'user.email=e@example.com', '-c', 'user.name=E', 'commit', '-q', '-m', 'two files')
}
init()

/** 默认读取器：候选里的路径用覆盖内容，其余读真实盘。 */
const reader = (overrides = new Map()) => (logical) => {
  const key = logical.replaceAll('\\', '/')
  if (overrides.has(key)) return overrides.get(key)
  try {
    return readFileSync(logical)
  } catch {
    return undefined
  }
}
const repoPath = (rel) => join(repo, rel)

process.stdout.write('# 健康仓库\n')
check('健康仓库放行', checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/index', op: 'write' }], readPost: reader() }).ok === true)

process.stdout.write('\n# pack 对象库\n')
git('repack', '-ad', '-q')
const headOid = git('rev-parse', 'HEAD').trim()
check('repack 后 HEAD 对象仍可查到（pack 索引）', createObjectStore(repoPath('.git')).has(headOid) === true)
check('repack 后闸门仍放行', checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/index', op: 'write' }], readPost: reader() }).ok === true)
check('不存在的对象查不到', createObjectStore(repoPath('.git')).has('0'.repeat(40)) === false)

process.stdout.write('\n# 悬空引用\n')
{
  const head = readFileSync(repoPath('.git/HEAD'), 'utf8').trim()
  const ref = head.replace(/^ref:\s*/, '')
  const overrides = new Map([[repoPath(`.git/${ref}`).replaceAll('\\', '/'), Buffer.from(`${'1'.repeat(40)}\n`)]])
  const result = checkGitIntegrity({ repoRoot: repo, changes: [{ path: `.git/${ref}`, op: 'write' }], readPost: reader(overrides) })
  check('refs 指向不存在对象 ⇒ GIT_REFERENTIAL_INTEGRITY', result.ok === false && result.code === 'GIT_REFERENTIAL_INTEGRITY', JSON.stringify(result))
}
{
  const index = Buffer.from(readFileSync(repoPath('.git/index')))
  // 第 1 条 entry 的 OID 在 offset 12 + 40，是 **20 字节原始二进制**；改成不存在的 OID。
  Buffer.alloc(20, 0xff).copy(index, 12 + 40)
  const overrides = new Map([[repoPath('.git/index').replaceAll('\\', '/'), index]])
  const result = checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/index', op: 'write' }], readPost: reader(overrides) })
  check('index blob 悬空 ⇒ GIT_REFERENTIAL_INTEGRITY', result.ok === false && result.code === 'GIT_REFERENTIAL_INTEGRITY', JSON.stringify(result))
}
{
  const overrides = new Map([[repoPath('.git/HEAD').replaceAll('\\', '/'), Buffer.from('ref: refs/heads/main\n')]])
  const dirty = Buffer.from(readFileSync(repoPath('.git/index')))
  Buffer.alloc(20, 0xee).copy(dirty, 12 + 40)
  overrides.set(repoPath('.git/index').replaceAll('\\', '/'), dirty)
  const result = checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/index', op: 'write' }], readPost: reader(overrides) })
  check('同一批里 HEAD 正常、index 悬空 ⇒ 仍拒绝', result.ok === false && result.code === 'GIT_REFERENTIAL_INTEGRITY')
}

process.stdout.write('\n# 永不发布的类别\n')
for (const path of ['.git/config', '.git/hooks/post-commit', '.git/info/exclude', '.git/index.lock', '.git/gc.log', '.git/description']) {
  const result = checkGitIntegrity({ repoRoot: repo, changes: [{ path, op: 'write' }], readPost: reader() })
  check(`${path} ⇒ SANDBOX_GIT_INTERNAL`, result.ok === false && result.code === 'SANDBOX_GIT_INTERNAL', JSON.stringify(result))
}

process.stdout.write('\n# 结构与穿越\n')
{
  const del = checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/HEAD', op: 'delete' }], readPost: reader() })
  check('删除 HEAD ⇒ SANDBOX_GIT_INTERNAL', del.ok === false && del.code === 'SANDBOX_GIT_INTERNAL', JSON.stringify(del))
  const traverse = checkGitIntegrity({ repoRoot: repo, changes: [{ path: '.git/../../etc/passwd', op: 'write' }], readPost: reader() })
  check('.. 穿越 ⇒ SANDBOX_GIT_INTERNAL', traverse.ok === false && traverse.code === 'SANDBOX_GIT_INTERNAL', JSON.stringify(traverse))
}

process.stdout.write('\n# 候选里的对象\n')
{
  // 一个不存在于盘上的对象，但出现在候选里 ⇒ 视为存在（发布顺序会先写它）。
  const fake = 'ab'.repeat(20)
  const result = checkGitIntegrity({
    repoRoot: repo,
    changes: [
      { path: `.git/objects/${fake.slice(0, 2)}/${fake.slice(2)}`, op: 'create' },
      { path: '.git/refs/heads/other', op: 'create' },
    ],
    readPost: (logical) => {
      const key = logical.replaceAll('\\', '/')
      if (key.endsWith(`.git/objects/${fake.slice(0, 2)}/${fake.slice(2)}`)) return Buffer.from('x')
      if (key.endsWith('.git/refs/heads/other')) return Buffer.from(`${fake}\n`)
      try {
        return readFileSync(logical)
      } catch {
        return undefined
      }
    },
  })
  check('候选对象先写 ⇒ 指针引用它合法', result.ok === true, JSON.stringify(result))
}
{
  const result = checkGitIntegrity({
    repoRoot: repo,
    changes: [{ path: '.git/refs/heads/other', op: 'create' }],
    readPost: (logical) => {
      const key = logical.replaceAll('\\', '/')
      if (key.endsWith('.git/refs/heads/other')) return Buffer.from(`${'b'.repeat(40)}\n`)
      try {
        return readFileSync(logical)
      } catch {
        return undefined
      }
    },
  })
  check('指针引用既不在盘也不在候选 ⇒ 拒绝', result.ok === false && result.code === 'GIT_REFERENTIAL_INTEGRITY')
}

process.stdout.write('\n# 非 git 候选\n')
check('普通文件直接放行', checkGitIntegrity({ repoRoot: repo, changes: [{ path: 'src/a.js', op: 'write' }], readPost: reader() }).ok === true)

process.stdout.write('\n# index 解析边界\n')
{
  const parsed = parseIndexBlobOids(readFileSync(repoPath('.git/index')))
  check('真实 index 解析出 2 条 blob', parsed.ok === true && parsed.oids.length === 2, JSON.stringify(parsed).slice(0, 200))
  const bad = parseIndexBlobOids(Buffer.from('nope'))
  check('坏 index ⇒ GIT_INDEX_CORRUPT', bad.ok === false && bad.code === 'GIT_INDEX_CORRUPT')
  const v4 = Buffer.from(readFileSync(repoPath('.git/index')))
  v4.writeUInt32BE(4, 4)
  const unsupported = parseIndexBlobOids(v4)
  check('index v4 ⇒ GIT_INDEX_UNSUPPORTED', unsupported.ok === false && unsupported.code === 'GIT_INDEX_UNSUPPORTED')
}

process.stdout.write('\n# packed-refs\n')
{
  const parsed = parsePackedRefs(`# pack-refs with: peeled fully-peeled sorted\n${'a'.repeat(40)} refs/heads/main\n^${'b'.repeat(40)}\n`)
  check('解析 packed-refs 并跳过 peeled 行', parsed.get('refs/heads/main') === 'a'.repeat(40) && parsed.size === 1)
}

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${assertions - failures}/${assertions} 条断言通过\n`)
process.exit(failures === 0 ? 0 : 1)
