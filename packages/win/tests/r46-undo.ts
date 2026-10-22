// @ts-nocheck —— R46：撤销已保存的 apply（文件面，冲突整批零写）
/**
 * r46-undo —— 对标 NeoAI review 的「已保存可撤销」：本仓此前写死“cannot be undone”
 *
 * ── 现状（R46 前）────────────────────────────────────────────────────────────
 * `applyCandidate` 成功后就删掉 apply.journal；面板确认文案逐字写
 * "Approving writes ... and cannot be undone."。用户误点批准后只能手工回退，
 * 而且原内容已经被真实盘覆盖（没有可恢复的快照保留）。
 *
 * ── 本套件钉住的新语义（R46）─────────────────────────────────────────────────
 *   1. apply 成功且确有真实写入 ⇒ 在 `<store>/undo/` 持久化一份**撤销记录**
 *      （复用 apply 前已建立的回滚快照 + 本批 after hash；带 sha256 checksum）。
 *      记录写失败**不**回滚已成功的 apply，只如实报 `undo.available=false` + 原因。
 *   2. `undoApply()` 撤销前做**整批并发预检**：任一文件保存后被外部改过 ⇒
 *      `status='conflict'`、`nothingWritten=true`、真实盘一个字节都不动。
 *   3. 撤销成功 ⇒ 文件回到 apply 前（修改恢复内容/mode；新建被删除；删除被恢复），
 *      记录归档到 `undo/undone/`，不再出现在 `listUndoable()`。
 *   4. 幂等：已回到 apply 前状态 ⇒ `already-undone`；记录损坏 ⇒ `corrupt` 且拒绝覆盖。
 *   5. 只覆盖文件面；注册表候选不在本链（文案与文档如实声明）。
 *
 * 与 R44/R45 无关：本套件不建立沙箱、不跑子进程、不需要受限令牌。
 *
 * 用法：node tests/r46-undo.ts
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Workspace } from '../src/workspace.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = mkdtempSync(join(REPO, '.t', 'r46-undo-'))
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`  ${ok ? '✓' : '✗'} ${name}`)
  if (detail !== undefined) W(`      证据: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const section = (title) => {
  W('')
  W(`=== ${title} ===`)
}
const content = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return `ERR:${error.code}`
  }
}
const fileMode = (path) => {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

mkdirSync(SCRATCH, { recursive: true })
let seq = 0
function makeWs(tag) {
  const root = join(SCRATCH, `ws-${tag}-${seq++}`)
  mkdirSync(root, { recursive: true })
  const storeDir = join(SCRATCH, `store-${tag}-${seq}`)
  const sessionId = `r46-${tag}`
  const ws = new Workspace({ workspaceRoot: root, storeDir, sessionId }).init({ sessionId })
  return { ws, root, storeDir, sessionId }
}

try {
  section('A. 修改两个文件 → 批准 → 撤销：逐字节回到 apply 前')
  {
    const { ws, root } = makeWs('a')
    writeFileSync(join(root, 'a.txt'), 'A0\n')
    writeFileSync(join(root, 'b.txt'), 'B0\n')
    ws.writeFile(join(root, 'a.txt'), 'A1\n', { origin: 'test' })
    ws.writeFile(join(root, 'b.txt'), 'B1\n', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    check('A1 apply 成功且两条都写入', applied.applied.length === 2 && content(join(root, 'a.txt')) === 'A1\n' && content(join(root, 'b.txt')) === 'B1\n', applied.status)
    check('A2 apply 返回 undo.available=true 且 id 可寻址', applied.undo?.available === true && typeof applied.undo.id === 'string', applied.undo)
    check('A3 撤销记录落在 <store>/undo/ 且带撤销清单', existsSync(applied.undo.path) && readdirSync(join(ws.store.dir, 'undo')).some((n) => n.endsWith('.json')), applied.undo.path)
    const listed = ws.listUndoable()
    check('A4 listUndoable 能列出这份记录（files=2）', listed.some((r) => r.ok && r.id === applied.undo.id && r.files === 2), listed)
    const undone = ws.undoApply(applied.undo.id)
    check('A5 undoApply ⇒ status=undone / 恢复 2 个文件', undone.status === 'undone' && undone.restored.length === 2, undone)
    check('A6 真实盘逐字节回到 A0/B0', content(join(root, 'a.txt')) === 'A0\n' && content(join(root, 'b.txt')) === 'B0\n', { a: content(join(root, 'a.txt')), b: content(join(root, 'b.txt')) })
    check('A6b 逻辑视图也回到 A0（暂存条目已清，不读旧 staged）', ws.readText(join(root, 'a.txt')) === 'A0\n', ws.readText(join(root, 'a.txt')))
    check('A6c manifest 里两条暂存条目已被清除', ws.manifest.entries['a.txt'] === undefined && ws.manifest.entries['b.txt'] === undefined, Object.keys(ws.manifest.entries || {}))
    check('A7 记录已归档：listUndoable 不再列出', ws.listUndoable().length === 0, ws.listUndoable())
    const again = ws.undoApply(applied.undo.id)
    check('A8 再次撤销同一 id ⇒ not-found（归档后不可重复使用）', again.status === 'not-found', again)
  }

  section('B. 冲突：保存后外部改过文件 ⇒ 整批零写、如实报 conflict')
  {
    const { ws, root } = makeWs('b')
    writeFileSync(join(root, 'a.txt'), 'A0\n')
    writeFileSync(join(root, 'b.txt'), 'B0\n')
    ws.writeFile(join(root, 'a.txt'), 'A1\n', { origin: 'test' })
    ws.writeFile(join(root, 'b.txt'), 'B1\n', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    writeFileSync(join(root, 'a.txt'), 'EXTERNAL\n')
    const result = ws.undoApply(applied.undo.id)
    check('B1 status=conflict 且 nothingWritten=true', result.status === 'conflict' && result.nothingWritten === true, result)
    check('B2 冲突清单点名 a.txt 与原因码', result.conflicts.some((c) => /a\.txt/.test(c.path) && c.code === 'UNDO_CONCURRENT_MODIFICATION'), result.conflicts)
    check('B3 外部改动原样保留（未被覆盖）', content(join(root, 'a.txt')) === 'EXTERNAL\n', content(join(root, 'a.txt')))
    check('B4 未冲突文件也没有被提前恢复（整批零写）', content(join(root, 'b.txt')) === 'B1\n', content(join(root, 'b.txt')))
    check('B5 冲突后记录仍在可撤销列表里', ws.listUndoable().some((r) => r.id === applied.undo.id), ws.listUndoable())
  }

  section('C. 新建文件 → 撤销 = 删除它；新建父目录一起回收')
  {
    const { ws, root } = makeWs('c')
    ws.writeFile(join(root, 'nested', 'new.txt'), 'NEW\n', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    check('C1 apply 后真实文件存在', existsSync(join(root, 'nested', 'new.txt')), joinedPath(root, 'nested/new.txt'))
    const undone = ws.undoApply(applied.undo.id)
    check('C2 撤销后真实文件不存在', undone.status === 'undone' && !existsSync(join(root, 'nested', 'new.txt')), undone)
    check('C3 本批新建的空父目录也被回收', !existsSync(join(root, 'nested')), existsSync(join(root, 'nested')))
  }

  section('D. 删除文件 → 撤销 = 恢复原内容与权限位')
  {
    const { ws, root } = makeWs('d')
    const target = join(root, 'd.txt')
    writeFileSync(target, 'D0\n')
    // 0o444：只读位必须被快照/恢复（与 apply 回滚同一口径）
    try {
      chmodSync(target, 0o444)
    } catch {}
    ws.remove(target, { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    check('D1 apply 后真实文件不存在（删除已落盘）', applied.applied.length === 1 && !existsSync(target), applied.status)
    const undone = ws.undoApply(applied.undo.id)
    check('D2 撤销后内容恢复为 D0', undone.status === 'undone' && content(target) === 'D0\n', undone)
    check(
      'D2b 逻辑视图读回 D0（不是 DELETED 标记）',
      (() => {
        try {
          return ws.readText(target) === 'D0\n'
        } catch {
          return false
        }
      })(),
      (() => {
        try {
          return ws.readText(target)
        } catch (error) {
          return error.code
        }
      })(),
    )
    check('D3 权限位恢复为 0444（不是默认 0666）', fileMode(target) === 0o444, fileMode(target))
    // 复原可写，便于 scratch 清理
    try {
      chmodSync(target, 0o666)
    } catch {}
  }

  section('E. 幂等与损坏：already-undone / corrupt 都不得覆盖真实文件')
  {
    const { ws, root } = makeWs('e')
    writeFileSync(join(root, 'a.txt'), 'A0\n')
    ws.writeFile(join(root, 'a.txt'), 'A1\n', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    // 手工把文件还原到 apply 前
    writeFileSync(join(root, 'a.txt'), 'A0\n')
    const idempotent = ws.undoApply(applied.undo.id)
    check('E1 已回到 apply 前 ⇒ already-undone（幂等，不重复写）', idempotent.status === 'already-undone' && content(join(root, 'a.txt')) === 'A0\n', idempotent)

    const { ws: ws2, root: root2 } = makeWs('e2')
    writeFileSync(join(root2, 'x.txt'), 'X0\n')
    ws2.writeFile(join(root2, 'x.txt'), 'X1\n', { origin: 'test' })
    const frozen2 = ws2.freezeCandidate({})
    ws2.applyCandidate(frozen2.candidate.id)
    const undoDir = join(ws2.store.dir, 'undo')
    const recordName = readdirSync(undoDir).find((n) => n.endsWith('.json'))
    writeFileSync(join(undoDir, recordName), '{"payload":{"version":1,"kind":"winstage-undo"')
    const corrupt = ws2.undoApply(recordName.replace(/\.json$/, ''))
    check('E2 损坏记录 ⇒ corrupt 且 nothingWritten=true', corrupt.status === 'corrupt' && corrupt.nothingWritten === true, corrupt)
    check('E3 损坏记录不得覆盖真实文件', content(join(root2, 'x.txt')) === 'X1\n', content(join(root2, 'x.txt')))
    check('E4 listUndoable 如实标出损坏条目', ws2.listUndoable().some((r) => r.ok === false && r.error), ws2.listUndoable())
  }

  section('F. 会话绑定与记录面：跨会话拒绝；命令面接线可查')
  {
    const { ws, root } = makeWs('f')
    writeFileSync(join(root, 'a.txt'), 'A0\n')
    ws.writeFile(join(root, 'a.txt'), 'A1\n', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const applied = ws.applyCandidate(frozen.candidate.id)
    ws.manifest.sessionId = 'another-session'
    const mismatch = ws.undoApply(applied.undo.id)
    check('F1 记录 session 与当前会话不符 ⇒ session-mismatch 且零写', mismatch.status === 'session-mismatch' && content(join(root, 'a.txt')) === 'A1\n', mismatch)
  }
  {
    const hostSource = readFileSync(join(HERE, '..', 'dsh-plugin', 'host-plugin.ts'), 'utf8')
    check('F2 命令面注册了 undo 子命令（伞形 /winstage undo）', /undo\(\{ args, service \}\)/.test(hostSource) && /list、status、diff、approve、reject、rebase、refresh、undo/.test(hostSource))
    check('F3 命令面文案如实声明“注册表候选不在此列”', /注册表候选不在此列/.test(hostSource))
    const workspaceSource = readFileSync(join(HERE, '..', 'src', 'workspace.ts'), 'utf8')
    check('F4 apply 成功路径会写撤销记录（undo.available 字段）', /_writeUndoRecord\(candidate, applied, snapshots, snapshotBudget, status\)/.test(workspaceSource) && workspaceSource.includes('undo.available'))
    check('F5 undo 记录带 sha256 checksum（与 apply.journal 同口径）', /kind: 'winstage-undo'/.test(workspaceSource) && workspaceSource.includes("checksum: { algo: 'sha256'"))
  }
} finally {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    /* 清理尽力而为 */
  }
}

function joinedPath(...parts) {
  return parts.join(' | ')
}

W('')
W('========================================================================')
W(`R46 已保存撤销：断言 ${assertions} 项，失败 ${failures} 项`)
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal`)
process.exitCode = failures === 0 ? 0 : 1
