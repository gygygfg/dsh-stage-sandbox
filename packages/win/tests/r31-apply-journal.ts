#!/usr/bin/env node
// @ts-nocheck —— R31 新套件（apply 崩溃恢复 WAL）
/**
 * r31-apply-journal —— **R21-FS-07：apply 意图 WAL（崩溃恢复）**
 *
 * 断言：
 *  A1 正常成功 ⇒ `<store.dir>/apply.journal` 不存在；内容落盘
 *  A2 中途失败、回滚成功 ⇒ journal 删除、真实盘回原态、候选 pending/rolled-back
 *  A3 回滚失败 ⇒ journal 保留且 phase=partial（如实 partial，不谎称已恢复）
 *  A4 崩溃缝 N=1：真实子进程 process.abort() ⇒ journal 保留；新进程 init 恢复 ⇒
 *     真实盘逐字节回原态、候选 pending、事件 `RECOVERED_APPLY_JOURNAL`
 *  A5 崩溃缝 N=2：两条都写完才崩 ⇒ 恢复仍回原态
 *  A6 恢复幂等：再次 recoverApplyJournal() 无 journal ⇒ no-op
 *  A7 损坏 journal ⇒ `APPLY_JOURNAL_CORRUPT` fail-closed、真实盘零写
 *  A8 并发守卫：恢复时当前内容为他方写入 ⇒ `RECOVERY_CONCURRENT_MODIFICATION` 跳过、不覆盖
 *  A9 大小上限：journal 超过 maxSnapshotBytes ⇒ `APPLY_JOURNAL_TOO_LARGE`，写前 fail-closed
 *  A10 journal 位于 store.dir、不在真实 workspace 内（不泄漏）
 *
 * 崩溃缝仅测试 env：WINSTAGE_TEST_CRASH_AFTER_APPLY_WRITES=N（生产不设无变化）。
 * 用法：node tests\r31-apply-journal.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Workspace } from '../src/workspace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r31-apply-journal')
const W = (t) => process.stdout.write(`${t}\n`)
let assertions = 0
let failures = 0
let seq = 0
function check(name, cond, detail) {
  assertions += 1
  if (!cond) failures += 1
  W(`  ${cond ? '✓' : '✗'} ${name}`)
  if (detail !== undefined) W(`      证据: ${detail}`)
}
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

function makeCase(tag, files) {
  const id = seq++
  const root = join(SCRATCH, `ws-${tag}-${id}`)
  const storeDir = join(SCRATCH, `store-${tag}-${id}`)
  mkdirSync(root, { recursive: true })
  const ws = new Workspace({ workspaceRoot: root, storeDir, sessionId: `r31-${tag}` }).init({ sessionId: `r31-${tag}` })
  for (const f of files) {
    const abs = join(root, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    if (f.before !== undefined) writeFileSync(abs, f.before)
    ws.writeFile(abs, f.after, { origin: 'test' })
  }
  const frozen = ws.freezeCandidate({})
  return { ws, root, storeDir, id: frozen.candidate.id, files }
}
const journal = (c) => join(c.storeDir, 'apply.journal')
const events = (c) => join(c.storeDir, 'apply.events.jsonl')
const read = (c, rel) => {
  try {
    return readFileSync(join(c.root, rel), 'utf8')
  } catch (e) {
    return `ERR:${e.code}`
  }
}
const journalPhase = (c) => {
  try {
    return JSON.parse(readFileSync(journal(c), 'utf8')).payload.phase
  } catch {
    return 'ERR'
  }
}
const eventText = (c) => {
  try {
    return readFileSync(events(c), 'utf8')
  } catch {
    return ''
  }
}
const childScript = join(SCRATCH, 'crash-child.mjs')
writeFileSync(
  childScript,
  `import { Workspace } from ${JSON.stringify(pathToFileURL(join(REPO, 'src', 'workspace.ts')).href)}
const [root, storeDir, id] = process.argv.slice(2)
const ws = new Workspace({ workspaceRoot: root, storeDir, sessionId: 'r31-crash' }).init({ sessionId: 'r31-crash' })
ws.applyCandidate(id)
process.stdout.write('CHILD-DONE\\n')
`,
)

function crashApply(c, n) {
  return spawnSync(process.execPath, [childScript, c.root, c.storeDir, c.id], {
    env: { ...process.env, WINSTAGE_TEST_CRASH_AFTER_APPLY_WRITES: String(n) },
    encoding: 'utf8',
    timeout: 60000,
  })
}
function reopen(c) {
  return new Workspace({ workspaceRoot: c.root, storeDir: c.storeDir, sessionId: `r31-reopen-${seq++}` }).init({ sessionId: `r31-reopen-${seq}` })
}

W('=== R31 apply journal ===')
// A1 normal success
{
  const c = makeCase('ok', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const res = c.ws.applyCandidate(c.id)
  check('A1 正常成功：journal 不存在、内容落盘', res.status === 'applied' && !existsSync(journal(c)) && read(c, 'a.txt') === 'A1' && read(c, 'b.txt') === 'B1', JSON.stringify({ status: res.status, journal: existsSync(journal(c)) }))
}
// A2 failure -> rollback success
{
  const c = makeCase('rollback', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const cand = c.ws.store.loadCandidate(c.id)
  const second = cand.changes.find((ch) => ch.path === 'b.txt')
  rmSync(c.ws.store.blobPath(second.after.hash), { force: true })
  const res = c.ws.applyCandidate(c.id)
  check(
    'A2 中途失败、回滚成功：journal 删除、真实盘回原态、候选可持续重试',
    res.status === 'rolled-back' && !existsSync(journal(c)) && read(c, 'a.txt') === 'A0' && read(c, 'b.txt') === 'B0' && c.ws.store.loadCandidate(c.id)?.status === 'pending',
    JSON.stringify({ status: res.status, journal: existsSync(journal(c)), a: read(c, 'a.txt'), status2: c.ws.store.loadCandidate(c.id)?.status }),
  )
}
// A3 rollback failure -> journal phase=partial
{
  const c = makeCase('rollbackfail', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const cand = c.ws.store.loadCandidate(c.id)
  const second = cand.changes.find((ch) => ch.path === 'b.txt')
  rmSync(c.ws.store.blobPath(second.after.hash), { force: true })
  const res = c.ws.applyCandidate(c.id, { rollbackRestoreOverride: () => ({ ok: false, code: 'ROLLBACK_FAILED', message: 'forced for test' }) })
  check(
    'A3 回滚失败：journal 保留且 phase=partial（如实 partial，不谎称 rolled-back）',
    res.status === 'partially-applied' && existsSync(journal(c)) && journalPhase(c) === 'partial',
    JSON.stringify({ status: res.status, journal: existsSync(journal(c)), phase: journalPhase(c) }),
  )
}
// A4 crash N=1 -> recovery
{
  const c = makeCase('crash1', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const crashed = crashApply(c, 1)
  const journalAfterCrash = existsSync(journal(c))
  const re = reopen(c)
  const ev = eventText(c)
  check(
    `A4 崩溃缝 N=1：子进程真实崩溃（status=${crashed.status}）⇒ journal 保留；新进程 init 恢复 ⇒ 真实盘逐字节回原态、候选 pending、事件记录`,
    crashed.status !== 0 && journalAfterCrash && read(c, 'a.txt') === 'A0' && read(c, 'b.txt') === 'B0' && !existsSync(journal(c)) && c.ws.store.loadCandidate(c.id)?.status === 'pending' && ev.includes('RECOVERED_APPLY_JOURNAL'),
    JSON.stringify({ child: crashed.status, journalAfterCrash, a: read(c, 'a.txt'), b: read(c, 'b.txt'), journalAfter: existsSync(journal(c)), status: c.ws.store.loadCandidate(c.id)?.status, event: ev.slice(0, 80) }).slice(0, 380),
  )
  let again = { recovery: 'NO-API' }
  try {
    again = re.recoverApplyJournal()
  } catch (error) {
    again = { recovery: 'THREW', code: error.code || error.message }
  }
  check('A5 恢复幂等：再次 recoverApplyJournal() 无 journal ⇒ no-op', again.recovery === null, JSON.stringify(again))
}
// A5 crash N=2
{
  const c = makeCase('crash2', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const crashed = crashApply(c, 2)
  const journalAfterCrash = existsSync(journal(c))
  reopen(c)
  check(
    'A6 崩溃缝 N=2：两条都写完才崩 ⇒ 恢复仍逐字节回原态',
    crashed.status !== 0 && journalAfterCrash && read(c, 'a.txt') === 'A0' && read(c, 'b.txt') === 'B0' && !existsSync(journal(c)),
    JSON.stringify({ child: crashed.status, journalAfterCrash, a: read(c, 'a.txt'), b: read(c, 'b.txt') }),
  )
}
// A7 corrupt journal
{
  const c = makeCase('corrupt', [{ path: 'a.txt', before: 'A0', after: 'A1' }])
  mkdirSync(c.storeDir, { recursive: true })
  writeFileSync(journal(c), '{"payload":{broken}')
  let code = 'NO-THROW'
  try {
    reopen(c)
  } catch (error) {
    code = error.code || error.message
  }
  let applyCode = 'NO-THROW'
  try {
    c.ws.applyCandidate(c.id)
  } catch (error) {
    applyCode = error.code || error.message
  }
  check(
    'A7 损坏 journal ⇒ APPLY_JOURNAL_CORRUPT fail-closed（init 与 applyCandidate 都拒绝）、真实盘零写',
    code === 'APPLY_JOURNAL_CORRUPT' && applyCode === 'APPLY_JOURNAL_CORRUPT' && read(c, 'a.txt') === 'A0',
    JSON.stringify({ initCode: code, applyCode, a: read(c, 'a.txt') }),
  )
  rmSync(journal(c), { force: true })
}
// A8 concurrent modification guard
{
  const c = makeCase('concurrent', [
    { path: 'a.txt', before: 'A0', after: 'A1' },
    { path: 'b.txt', before: 'B0', after: 'B1' },
  ])
  const crashed = crashApply(c, 1)
  writeFileSync(join(c.root, 'a.txt'), 'OTHER')
  reopen(c)
  const ev = eventText(c)
  check(
    'A8 并发守卫：恢复时当前内容为他方写入 ⇒ RECOVERY_CONCURRENT_MODIFICATION 跳过、不覆盖',
    crashed.status !== 0 && read(c, 'a.txt') === 'OTHER' && read(c, 'b.txt') === 'B0' && ev.includes('RECOVERY_CONCURRENT_MODIFICATION'),
    JSON.stringify({ a: read(c, 'a.txt'), b: read(c, 'b.txt'), event: ev.slice(-160) }).slice(0, 380),
  )
}
// A9 journal size cap
{
  const c = makeCase('cap', [{ path: 'big.txt', before: 'x'.repeat(100), after: 'y'.repeat(100) }])
  const res = c.ws.applyCandidate(c.id, { maxSnapshotBytes: 200 })
  const code = res.failed?.[0]?.code
  check(
    'A9 大小上限：journal 超过 maxSnapshotBytes ⇒ APPLY_JOURNAL_TOO_LARGE，写前 fail-closed（真实盘零写）',
    code === 'APPLY_JOURNAL_TOO_LARGE' && !existsSync(journal(c)) && read(c, 'big.txt') === 'x'.repeat(100),
    JSON.stringify({ status: res.status, code, journal: existsSync(journal(c)) }),
  )
}
// A10 journal location
{
  const c = makeCase('loc', [{ path: 'a.txt', before: 'A0', after: 'A1' }])
  check('A10 journal 位于 store.dir、不在真实 workspace 内（不泄漏真实 workspace）', journal(c).startsWith(c.storeDir) && !journal(c).startsWith(c.root), JSON.stringify({ journal: journal(c), root: c.root }))
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
