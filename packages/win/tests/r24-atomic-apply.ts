#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R24 新登记套件。
/**
 * r24-atomic-apply —— **R24-B：R14 收窄，批量 apply 原子性（全有或全无 + 回滚）**
 *
 * 现状（R24 前）：`applyCandidate` 中途失败只记 `partially-applied`，**已落盘条目不回滚**
 * ⇒ 真实工作区停在混合状态（例如 a 已改、b 因 BLOB_MISSING 没落盘）。
 * 目标：应用前为本批所有将写路径建回滚快照；中途失败 ⇒ 逐条回滚（恢复原 bytes/mode、
 * 删除本批新建的文件/目录），返回 `rolled-back` + failed；回滚本身失败 ⇒ 如实
 * `partially-applied` + 逐条回滚结果（绝不谎称已回滚）。
 *
 * 断言分组：
 *   A 修前红主样本：修改 a 成功、b BLOB_MISSING ⇒ 真实 a/b 都恢复原内容、状态 rolled-back；候选保持可重试。
 *   B 删除回滚：delete d + 改 e（e 失败）⇒ d 被恢复（内容/mode）。
 *   C 新建回滚：create n + 改 f（f 失败）⇒ n 被删除。
 *   D 建目录回滚：mkdir 深层目录/文件 + 改 g（失败）⇒ 新建目录树被删除。
 *   E 只读文件：成功路径保留只读位；回滚同样保留原 mode（0o444）。
 *   F 幂等：全部成功后二次 apply ⇒ ALREADY_APPLIED；rolled-back 候选可重试且成功后 APPLIED。
 *   G 诚实回滚失败：rollbackRestoreOverride 注入"恢复失败"⇒ status partially-applied + 逐条 rollback 结果，
 *     **不得**报 rolled-back；未被破坏的条目仍恢复。
 *   H 快照上限 fail-closed：`maxSnapshotBytes` 太小 ⇒ 应用前拒绝写真实盘（不静默放弃回滚）。
 *   I 基线 stale 预检仍整批零写（既有行为不退化）。
 *
 * 红/绿：R24 修前（当前 workspace.ts）A–D/G/H 失败（真实盘停在混合态/无 rolled-back 字段）；
 * 修后全绿。SKIP 如实记录。
 *
 * 用法：node tests\r24-atomic-apply.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../src/workspace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = mkdtempSync(join(REPO, '.t', 'r24-atomic-apply-'))
const W = (t) => process.stdout.write(`${t}\n`)
let assertions = 0
let failures = 0
function check(name, cond, detail) {
  assertions += 1
  if (!cond) failures += 1
  W(`  ${cond ? '✓' : '✗'} ${name}`)
  if (detail !== undefined) W(`      证据: ${detail}`)
}
function section(t) {
  W('')
  W(`=== ${t} ===`)
}
mkdirSync(SCRATCH, { recursive: true })

let seq = 0
function makeWs(tag) {
  const root = join(SCRATCH, `ws-${tag}-${seq++}`)
  mkdirSync(root, { recursive: true })
  const storeDir = join(SCRATCH, `store-${tag}-${seq}`)
  return { ws: new Workspace({ workspaceRoot: root, storeDir, sessionId: `r24-${tag}` }).init({ sessionId: `r24-${tag}` }), root }
}
const content = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    return `ERR:${e.code}`
  }
}
const mode = (p) => {
  try {
    return statSync(p).mode & 0o777
  } catch {
    return null
  }
}
function dropBlob(ws, candidateId, pathSuffix) {
  const candidate = ws.store.loadCandidate(candidateId)
  const change = candidate.changes.find((c) => c.path.endsWith(pathSuffix))
  if (!change) throw new Error(`change ${pathSuffix} not found`)
  rmSync(ws.store.blobPath(change.after.hash), { force: true })
  return change
}

section('A. 修改类中途失败 ⇒ 逐字节回滚（修前红主样本）')
{
  const { ws, root } = makeWs('a')
  writeFileSync(join(root, 'a.txt'), 'A0\n')
  writeFileSync(join(root, 'b.txt'), 'B0\n')
  ws.writeFile(join(root, 'a.txt'), 'A1\n', { origin: 'test' })
  ws.writeFile(join(root, 'b.txt'), 'B1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  dropBlob(ws, frozen.candidate.id, 'b.txt')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'A1 第 2 条失败 ⇒ status=rolled-back，applied=[]，failed 含 b:BLOB_MISSING',
    result.status === 'rolled-back' && (result.applied || []).length === 0 && (result.failed || []).some((f) => f.path === 'b.txt' && f.code === 'BLOB_MISSING'),
    JSON.stringify({ status: result.status, applied: result.applied, failed: result.failed }).slice(0, 320),
  )
  check(
    'A2 真实工作区逐字节恢复：a.txt=A0、b.txt=B0（修前会停在 a=A1/b=B0 混合态）',
    content(join(root, 'a.txt')) === 'A0\n' && content(join(root, 'b.txt')) === 'B0\n',
    `a=${JSON.stringify(content(join(root, 'a.txt')))} b=${JSON.stringify(content(join(root, 'b.txt')))}`,
  )
  check(
    'A3 回滚明细如实：rolledBack=true 且 rollback 覆盖已写路径',
    result.rolledBack === true && Array.isArray(result.rollback) && result.rollback.length >= 1,
    JSON.stringify({ rolledBack: result.rolledBack, rollback: result.rollback }).slice(0, 240),
  )
  const queue = ws.store.loadQueue()
  const retryCandidate = ws.store.loadCandidate(frozen.candidate.id)
  check(
    'A4 候选保持可重试（status 仍 pending、可追踪、未记 appliedPaths）',
    retryCandidate.status === 'pending' && queue.candidates[frozen.candidate.id]?.status === 'pending' && (retryCandidate.appliedPaths || []).length === 0,
    JSON.stringify({ status: retryCandidate.status, queue: queue.candidates[frozen.candidate.id]?.status, appliedPaths: retryCandidate.appliedPaths }),
  )
}

section('B. 删除条目回滚 ⇒ 原文件恢复')
{
  const { ws, root } = makeWs('del')
  writeFileSync(join(root, 'd.txt'), 'D0\n')
  writeFileSync(join(root, 'e.txt'), 'E0\n')
  ws.remove(join(root, 'd.txt'), { origin: 'test' })
  ws.writeFile(join(root, 'e.txt'), 'E1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  dropBlob(ws, frozen.candidate.id, 'e.txt')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'B1 delete 已落盘后失败 ⇒ 回滚把 d.txt 原内容恢复（不是留下白障/缺失）',
    result.status === 'rolled-back' && content(join(root, 'd.txt')) === 'D0\n',
    `status=${result.status} d=${JSON.stringify(content(join(root, 'd.txt')))}`,
  )
}

section('C. 新建条目回滚 ⇒ 新文件删除')
{
  const { ws, root } = makeWs('new')
  writeFileSync(join(root, 'f.txt'), 'F0\n')
  ws.writeFile(join(root, 'n.txt'), 'N-NEW\n', { origin: 'test' })
  ws.writeFile(join(root, 'f.txt'), 'F1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  dropBlob(ws, frozen.candidate.id, 'f.txt')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'C1 create 已落盘后失败 ⇒ 回滚删除新建文件 n.txt（真实盘不存在）',
    result.status === 'rolled-back' && !existsSync(join(root, 'n.txt')) && content(join(root, 'f.txt')) === 'F0\n',
    `status=${result.status} nExists=${existsSync(join(root, 'n.txt'))} f=${JSON.stringify(content(join(root, 'f.txt')))}`,
  )
}

section('D. 新建目录树回滚 ⇒ 目录删除')
{
  const { ws, root } = makeWs('mkdir')
  writeFileSync(join(root, 'g.txt'), 'G0\n')
  ws.writeFile(join(root, 'newdir', 'sub', 'x.txt'), 'X\n', { origin: 'test' })
  ws.writeFile(join(root, 'g.txt'), 'G1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  dropBlob(ws, frozen.candidate.id, 'g.txt')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'D1 mkdir 深层目录已落盘后失败 ⇒ 回滚删除本批新建目录树（newdir 不存在）',
    result.status === 'rolled-back' && !existsSync(join(root, 'newdir')) && content(join(root, 'g.txt')) === 'G0\n',
    `status=${result.status} newdir=${existsSync(join(root, 'newdir'))} g=${JSON.stringify(content(join(root, 'g.txt')))}`,
  )
}

section('E. 只读位：成功路径与回滚都保留原 mode')
{
  const { ws, root } = makeWs('mode')
  const ro = join(root, 'ro.txt')
  writeFileSync(ro, 'RO0\n')
  chmodSync(ro, 0o444)
  const before = mode(ro)
  ws.writeFile(ro, 'RO1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const ok = ws.applyCandidate(frozen.candidate.id)
  const after = mode(ro)
  check(
    'E1 成功路径：内容更新且只读位保留（mode 0o444→0o444，与 R21 行为一致）',
    ok.status === 'applied' && content(ro) === 'RO1\n' && before === 0o444 && after === 0o444,
    `status=${ok.status} content=${JSON.stringify(content(ro))} mode=${before?.toString(8)}->${after?.toString(8)}`,
  )
  chmodSync(ro, 0o666)

  const { ws: ws2, root: root2 } = makeWs('mode2')
  const ro2 = join(root2, 'ro2.txt')
  writeFileSync(ro2, 'R0\n')
  chmodSync(ro2, 0o444)
  writeFileSync(join(root2, 'z.txt'), 'Z0\n')
  ws2.writeFile(ro2, 'R1\n', { origin: 'test' })
  ws2.writeFile(join(root2, 'z.txt'), 'Z1\n', { origin: 'test' })
  const frozen2 = ws2.freezeCandidate({})
  dropBlob(ws2, frozen2.candidate.id, 'z.txt')
  const rb = ws2.applyCandidate(frozen2.candidate.id)
  check(
    'E2 回滚路径：只读文件恢复到原内容且只读位保留（mode 0o444）',
    rb.status === 'rolled-back' && content(ro2) === 'R0\n' && mode(ro2) === 0o444,
    `status=${rb.status} content=${JSON.stringify(content(ro2))} mode=${mode(ro2)?.toString(8)}`,
  )
  chmodSync(ro2, 0o666)
}

section('F. 幂等/重试语义')
{
  const { ws, root } = makeWs('retry')
  writeFileSync(join(root, 'h.txt'), 'H0\n')
  writeFileSync(join(root, 'i.txt'), 'I0\n')
  ws.writeFile(join(root, 'h.txt'), 'H1\n', { origin: 'test' })
  ws.writeFile(join(root, 'i.txt'), 'I1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const failingChange = dropBlob(ws, frozen.candidate.id, 'i.txt')
  const first = ws.applyCandidate(frozen.candidate.id)
  // 恢复 blob（用暂存内容重建），再次 apply 应成功（rolled-back 候选可重试）
  writeFileSync(ws.store.blobPath(failingChange.after.hash), 'I1\n')
  const second = ws.applyCandidate(frozen.candidate.id)
  const third = ws.applyCandidate(frozen.candidate.id)
  check(
    'F1 回滚后可重试：恢复 blob 再 apply ⇒ applied，内容 H1/I1；二次 apply ⇒ ALREADY_APPLIED',
    first.status === 'rolled-back' && second.status === 'applied' && content(join(root, 'h.txt')) === 'H1\n' && content(join(root, 'i.txt')) === 'I1\n' && third.idempotent === 'ALREADY_APPLIED',
    JSON.stringify({ first: first.status, second: second.status, third: third.idempotent }).slice(0, 240),
  )
}

section('G. 回滚本身失败 ⇒ 如实 partially-applied（绝不谎称已回滚）')
{
  const { ws, root } = makeWs('rollfail')
  writeFileSync(join(root, 'p.txt'), 'P0\n')
  writeFileSync(join(root, 'q.txt'), 'Q0\n')
  ws.writeFile(join(root, 'p.txt'), 'P1\n', { origin: 'test' })
  ws.writeFile(join(root, 'q.txt'), 'Q1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  dropBlob(ws, frozen.candidate.id, 'q.txt')
  const pAbs = join(root, 'p.txt')
  const result = ws.applyCandidate(frozen.candidate.id, {
    // 测试注入缝：模拟"回滚 p.txt 时外部锁导致恢复失败"
    rollbackRestoreOverride: (snap) => (snap.abs === pAbs ? { ok: false, code: 'ROLLBACK_EPERM' } : null),
  })
  check(
    'G1 回滚失败 ⇒ status=partially-applied（不是 rolled-back），rollback 明细含失败条目，真实 p 保留新内容',
    result.status === 'partially-applied' && result.rolledBack === false && (result.rollback || []).some((r) => r.path === 'p.txt' && r.ok === false) && content(pAbs) === 'P1\n',
    JSON.stringify({ status: result.status, rolledBack: result.rolledBack, rollback: result.rollback, p: content(pAbs) }).slice(0, 420),
  )
}

section('H. 快照上限 ⇒ 应用前 fail-closed（不静默放弃回滚）')
{
  const { ws, root } = makeWs('limit')
  writeFileSync(join(root, 'big.txt'), 'B'.repeat(4096))
  ws.writeFile(join(root, 'big.txt'), 'B2\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const before = content(join(root, 'big.txt'))
  const result = ws.applyCandidate(frozen.candidate.id, { maxSnapshotBytes: 1024 })
  check(
    'H1 快照超过 maxSnapshotBytes ⇒ 应用前拒绝（failed code=ROLLBACK_SNAPSHOT_UNAVAILABLE/TOO_LARGE），真实盘一字节未写',
    (result.failed || []).some((f) => /ROLLBACK_SNAPSHOT/.test(f.code || '')) && content(join(root, 'big.txt')) === before && result.status !== 'applied',
    JSON.stringify({ status: result.status, failed: result.failed, contentSame: content(join(root, 'big.txt')) === before }).slice(0, 320),
  )
}

section('I. 基线 stale 预检：整批零写（既有行为不退化）')
{
  const { ws, root } = makeWs('stale')
  writeFileSync(join(root, 's.txt'), 'S0\n')
  ws.writeFile(join(root, 's.txt'), 'S1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  writeFileSync(join(root, 's.txt'), 'S-EXTERNAL\n')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'I1 外部改写后 apply ⇒ conflicts 非空、真实盘保持外部内容（整批拒绝，零写）',
    (result.conflicts || []).length > 0 && content(join(root, 's.txt')) === 'S-EXTERNAL\n' && (result.applied || []).length === 0,
    JSON.stringify({ conflicts: (result.conflicts || []).length, content: content(join(root, 's.txt')), applied: result.applied }).slice(0, 240),
  )
}

section('J. R34：同一候选分两批应用后，累计状态必须收敛为 applied（不是永远 partial）')
{
  const { ws, root } = makeWs('two-batch')
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), `${name} BASE\n`)
  for (const name of ['a.txt', 'b.txt', 'c.txt']) ws.writeFile(join(root, name), `${name} NEW\n`, { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const first = ws.applyCandidate(frozen.candidate.id, { paths: ['a.txt'] })
  check(
    'J1 第一批（a）⇒ partially-applied，remaining 只含尚未应用的 b/c',
    first.status === 'partially-applied' && first.remaining.length === 2,
    JSON.stringify({ status: first.status, remaining: first.remaining }),
  )
  const second = ws.applyCandidate(frozen.candidate.id, { paths: ['b.txt', 'c.txt'] })
  check(
    'J2 第二批（b/c）⇒ 累计已全量应用 ⇒ status=applied、remaining=[]（旧实现会永远 partial）',
    second.status === 'applied' && (second.remaining || []).length === 0,
    JSON.stringify({ status: second.status, remaining: second.remaining, applied: second.applied }),
  )
  check(
    'J3 全量应用后该候选不再挂在待审面（listReviews 为空）',
    ws.listReviews().length === 0,
    JSON.stringify({ pending: ws.listReviews().map((c) => c.id) }),
  )
  check(
    'J4 真实盘三份内容都是最终版本',
    content(join(root, 'a.txt')) === 'a.txt NEW\n' && content(join(root, 'b.txt')) === 'b.txt NEW\n' && content(join(root, 'c.txt')) === 'c.txt NEW\n',
    JSON.stringify({ a: content(join(root, 'a.txt')), b: content(join(root, 'b.txt')), c: content(join(root, 'c.txt')) }),
  )
}

section('K. R34d：显式 paths 为空/未知 ⇒ NO_MATCHING_PATHS，候选与真实盘零变化')
{
  const { ws, root } = makeWs('no-match')
  const abs = join(root, 'n.txt')
  writeFileSync(abs, 'N0\n')
  ws.writeFile(abs, 'N1\n', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const before = content(abs)
  const beforeStatus = ws.listReviews().find((candidate) => candidate.id === frozen.candidate.id)?.status
  let emptyError
  try {
    ws.applyCandidate(frozen.candidate.id, { paths: [] })
  } catch (error) {
    emptyError = error
  }
  let unknownError
  try {
    ws.applyCandidate(frozen.candidate.id, { paths: ['nope.txt'] })
  } catch (error) {
    unknownError = error
  }
  const after = ws.listReviews().find((candidate) => candidate.id === frozen.candidate.id)
  check(
    'K1 空选择/未知路径 ⇒ NO_MATCHING_PATHS（不是 partial 假成功）',
    emptyError?.code === 'NO_MATCHING_PATHS' && unknownError?.code === 'NO_MATCHING_PATHS',
    JSON.stringify({ empty: emptyError?.code, unknown: unknownError?.code }),
  )
  check(
    'K2 失败没有改写候选状态、没有写真实盘',
    after?.status === beforeStatus && content(abs) === before,
    JSON.stringify({ beforeStatus, afterStatus: after?.status, content: content(abs) }),
  )
  let mixedError
  try {
    ws.applyCandidate(frozen.candidate.id, { paths: ['n.txt', 'nope.txt'] })
  } catch (error) {
    mixedError = error
  }
  check(
    'K2b 已知 + 未知混合路径 ⇒ 整批 NO_MATCHING_PATHS，已知项也不写',
    mixedError?.code === 'NO_MATCHING_PATHS' && content(abs) === before,
    JSON.stringify({ code: mixedError?.code, content: content(abs) }),
  )
  const { ReviewService } = await import('../dsh-plugin/review-service.ts')
  const svcRoot = join(SCRATCH, `ws-k-svc-${Date.now()}`)
  mkdirSync(svcRoot, { recursive: true })
  const svc = new ReviewService({ workspaceRoot: svcRoot, sessionId: 'r24-k-svc', storeDir: join(SCRATCH, `store-k-svc-${Date.now()}`) })
  svc.workspace.writeFile(join(svcRoot, 's.txt'), 'S1\n', { origin: 'test' })
  svc.workspace.freezeCandidate({ source: 'test' })
  svc.publish()
  const svcResult = svc.approve(['nope.txt'])
  check(
    'K3 ReviewService.approve(未知路径) ⇒ ok:false + NO_MATCHING_PATHS（不是 ok:true/approved:0）',
    svcResult.ok === false && (svcResult.failed || []).some((failure) => failure.code === 'NO_MATCHING_PATHS'),
    JSON.stringify({ ok: svcResult.ok, approved: svcResult.approved, failed: svcResult.failed }),
  )
  const rejectUnknown = svc.reject(['nope.txt'])
  const rejectEmpty = svc.reject([])
  const rebaseUnknown = svc.rebase(['nope.txt'])
  const rebaseEmpty = svc.rebase([])
  check(
    'K4 reject/rebase 的未知路径与显式空数组 ⇒ ok:false（空数组不得被当成"全部拒绝/全部 rebase"）',
    rejectUnknown.ok === false &&
      rejectEmpty.ok === false &&
      rebaseUnknown.ok === false &&
      rebaseEmpty.ok === false &&
      (rejectUnknown.failures || []).some((failure) => failure.code === 'NO_MATCHING_PATHS'),
    JSON.stringify({
      rejectUnknown: rejectUnknown.ok,
      rejectEmpty: rejectEmpty.ok,
      rebaseUnknown: rebaseUnknown.ok,
      rebaseEmpty: rebaseEmpty.ok,
    }),
  )
  check(
    'K5 上述失败没有清掉待审内容（reject([]) 未拒绝全部）',
    svc.snapshot().counts.net > 0,
    JSON.stringify({ net: svc.snapshot().counts.net }),
  )
}

section('L. R40-SNAP-07：totals 全量计数不受 4000 行展示上限封顶')
{
  const { countCandidateDiff } = await import('../src/tools.ts')
  const { ws, root } = makeWs('count-all')
  const lineCount = 4500
  const baseText = `${Array.from({ length: lineCount }, (_, i) => `old-${i}`).join('\n')}\n`
  const nextText = `${Array.from({ length: lineCount }, (_, i) => `new-${i}`).join('\n')}\n`
  writeFileSync(join(root, 'big.txt'), baseText)
  ws.writeFile(join(root, 'big.txt'), nextText, { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const counts = countCandidateDiff(ws.store, frozen.candidate.changes[0])
  check(
    'L1 4500 行全改 ⇒ added=4500 / removed=4500（不被 countLines=4000 截断）',
    counts.added === lineCount && counts.removed === lineCount,
    JSON.stringify(counts),
  )
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
