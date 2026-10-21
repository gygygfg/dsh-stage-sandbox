// @ts-nocheck —— R34：守卫不可用时的**只读**回退（暂存一致性 / 鲁棒性回归）。
/**
 * R34 · `STAGE_GUARD_UNAVAILABLE` 的只读回退边界
 *
 * ── 复现的缺陷（先红）──────────────────────────────────────────────────────────
 * 当 WinStage 被装进一个**已经受限**的宿主（DSH 自己的 workspace-write 沙箱、
 * 二级受限令牌、或存储根不可创建）时，`acquireStageGuard()` 会失败
 * （`STAGE_GUARD_UNAVAILABLE` / `root-not-creatable:EPERM|ENOTDIR`）。
 *
 * 旧实现里 `stat` / `lstat` / `readText` / `readBytes` / `readByteRange` / `listDir`
 * **全部**先走 `stagingFor()`（构造 `ReviewService` → `Store.ensureLayout()`），
 * 于是一个纯读动作（典型：DSH 会话启动时解析 `cwd`）就抛
 * `ENV_FAULT_RETRYABLE`，整个 Turn 起不来；真实磁盘其实完全可读。
 *
 * 期望语义（本套件钉住）：
 *   1. 没有既有暂存状态（无 manifest 条目）⇒ 只读回退**真实磁盘**，日志只响一次；
 *   2. 有既有暂存状态 ⇒ **绝不回退**（不能把未批准内容藏起来），仍报环境类失败；
 *   3. 写入**永不走回退** ⇒ 仍 fail-closed，且真实磁盘零写；
 *   4. 存储根建不出来时，原始 `ENOTDIR`/`EPERM` 必须被归一为
 *      `STAGE_GUARD_UNAVAILABLE`（不得把裸 errno 甩给会话层）。
 *
 * 判定用真实 `LocalFileSystem` + 真实 cordis `Context`，不依赖受限令牌；
 * "根不可创建"用"父路径是文件"确定性地制造（ENOTDIR），任何账号/CI 都可重跑。
 *
 * 用法：node tests/r34-guard-unavailable-read.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createStagingFileSystem } from '../dsh-plugin/staging-fs.ts'
import { disposeReviewServices, getReviewService } from '../dsh-plugin/review-service.ts'
import { acquireStageGuard } from '../src/stage-guard.ts'
import { Store } from '../src/store.ts'
import { hashAbsent } from '../src/store.ts'
import { renderCandidateDiff } from '../src/tools.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '..', '.t', 'r34-guard-unavailable')

let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}
const section = (title) => process.stdout.write(`\n=== ${title} ===\n`)

const savedEnv = process.env.WINSTAGE_STAGE_ROOT
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const wsRoot = join(SCRATCH, 'ws')
mkdirSync(wsRoot, { recursive: true })
writeFileSync(join(wsRoot, 'real.txt'), 'REAL-CONTENT')
const blocker = join(SCRATCH, 'blocker')
writeFileSync(blocker, 'not a directory')
process.env.WINSTAGE_STAGE_ROOT = join(blocker, 'stage')

const target = (name) => ({ targetKey: join(wsRoot, name), displayPath: join(wsRoot, name) })
const codeOf = (error) => error?.code ?? error?.technicalCode

try {
  section('1. 存储根不可创建时，错误必须归一为 STAGE_GUARD_UNAVAILABLE（不是裸 ENOTDIR）')
  {
    let guardError
    try {
      acquireStageGuard(join(blocker, 'stage'))
    } catch (error) {
      guardError = error
    }
    check(
      'acquireStageGuard：父路径是文件 ⇒ STAGE_GUARD_UNAVAILABLE（带 reason）',
      guardError?.code === 'STAGE_GUARD_UNAVAILABLE' && String(guardError?.reason).startsWith('root-not-creatable:'),
      JSON.stringify({ code: guardError?.code, reason: guardError?.reason }),
    )

    let storeError
    try {
      new Store(join(SCRATCH, 'store-ws'), { stageRoot: join(blocker, 'stage') }).ensureLayout()
    } catch (error) {
      storeError = error
    }
    check(
      'Store.ensureLayout：显式 stageRoot 不可创建 ⇒ 同样归一为 STAGE_GUARD_UNAVAILABLE（R34 修复点）',
      storeError?.code === 'STAGE_GUARD_UNAVAILABLE' && String(storeError?.reason).startsWith('root-not-creatable:'),
      JSON.stringify({ code: storeError?.code, reason: storeError?.reason, raw: storeError?.cause?.code }),
    )

    let serviceError
    try {
      getReviewService({ workspaceRoot: wsRoot, sessionId: 'r34-guard', claimShared: false })
    } catch (error) {
      serviceError = error
    }
    check(
      'getReviewService：构造期失败码归一（会话层不会看到裸 errno）',
      serviceError?.code === 'STAGE_GUARD_UNAVAILABLE',
      JSON.stringify({ code: serviceError?.code, reason: serviceError?.reason }),
    )
  }

  section('2. 无既有暂存状态 ⇒ 只读回退真实磁盘；写入仍 fail-closed')
  {
    const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r34-guard' })
    const fs = new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    const logs = []
    fs.log = (message) => logs.push(String(message))
    fs.logError = (message) => logs.push(String(message))

    const stat = await fs.stat(target('real.txt')).catch((error) => ({ error }))
    check('stat 回退真实磁盘', stat?.type === 'file' && stat?.size === 12, JSON.stringify(stat))
    const lstat = await fs.lstat(join(wsRoot, 'real.txt')).catch((error) => ({ error }))
    check('lstat 回退真实磁盘', lstat?.type === 'file' && lstat?.size === 12, JSON.stringify(lstat))
    const text = await fs.readText(target('real.txt')).catch((error) => ({ error }))
    check('readText 回退真实磁盘', text === 'REAL-CONTENT', JSON.stringify(text))
    const bytes = await fs.readBytes(target('real.txt')).catch((error) => ({ error }))
    check(
      'readBytes 回退真实磁盘',
      bytes instanceof Uint8Array && Buffer.from(bytes).toString('utf8') === 'REAL-CONTENT',
      JSON.stringify(bytes),
    )
    const range = await fs.readByteRange(target('real.txt'), { offset: 5, length: 7 }).catch((error) => ({ error }))
    check(
      'readByteRange 回退真实磁盘',
      range instanceof Uint8Array && Buffer.from(range).toString('utf8') === 'CONTENT',
      JSON.stringify(range),
    )
    const listed = await fs.listDir(target('')).catch((error) => ({ error }))
    check(
      'listDir 回退真实磁盘',
      Array.isArray(listed) && listed.some((entry) => entry.name === 'real.txt'),
      JSON.stringify(listed?.map?.((entry) => entry.name)),
    )
    check(
      '只读回退只记一条 error 日志（不刷屏）',
      logs.filter((line) => line.includes('只读操作回退真实磁盘')).length === 1,
      JSON.stringify(logs.filter((line) => line.includes('只读操作回退真实磁盘'))),
    )

    let writeError
    try {
      await fs.writeText(target('new.txt'), 'SHOULD-NOT-LAND', undefined, undefined, undefined)
    } catch (error) {
      writeError = error
    }
    check(
      'writeText 不回退：仍报 ENV_FAULT_RETRYABLE',
      writeError?.code === 'ENV_FAULT_RETRYABLE' && writeError?.technicalCode === 'STAGE_GUARD_UNAVAILABLE',
      JSON.stringify({ code: writeError?.code, technicalCode: writeError?.technicalCode }),
    )
    check(
      'writeText 的模型可见文案是普通失败（无机制字样）',
      (() => {
        // 路径本身由调用方提供，可能恰好含 "stage"（本仓目录就叫 dsh-stage-sandbox）；
        // 透明性检查只针对**模板部分**，路径引号内逐字回显是允许的。
        const template = String(writeError?.message).replace(/"[^"]*"/g, '"<path>"')
        return template.includes('temporarily unavailable') && !/stage|staging|overlay/i.test(template)
      })(),
      String(writeError?.message),
    )
    check('writeText 没有在真实磁盘留下文件', !existsSync(join(wsRoot, 'new.txt')))
    check('真实文件内容一位未变', readFileSync(join(wsRoot, 'real.txt'), 'utf8') === 'REAL-CONTENT')
  }

  section('3. 有既有暂存状态 ⇒ 读不回退（绝不藏起未批准内容）')
  {
    mkdirSync(join(wsRoot, '.dshstage'), { recursive: true })
    writeFileSync(
      join(wsRoot, '.dshstage', 'manifest.json'),
      JSON.stringify({ entries: { 'staged.txt': { stagedHash: 'deadbeef' } } }),
    )
    const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r34-guard' })
    const fs = new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    fs.log = () => {}
    fs.logError = () => {}
    let hidden
    let readError
    try {
      hidden = await fs.readText(target('real.txt'))
    } catch (error) {
      readError = error
    }
    check(
      '有 manifest 条目 ⇒ readText 不回退，报环境类失败（不返回真实内容）',
      hidden === undefined && readError?.code === 'ENV_FAULT_RETRYABLE' && readError?.technicalCode === 'STAGE_GUARD_UNAVAILABLE',
      JSON.stringify({ hidden, code: readError?.code, technicalCode: readError?.technicalCode }),
    )
    let statError
    try {
      await fs.stat(target('real.txt'))
    } catch (error) {
      statError = error
    }
    check(
      '有 manifest 条目 ⇒ stat 同样不回退',
      statError?.code === 'ENV_FAULT_RETRYABLE',
      JSON.stringify({ code: statError?.code, technicalCode: statError?.technicalCode }),
    )
    rmSync(join(wsRoot, '.dshstage'), { recursive: true, force: true })
    const after = await fs.readText(target('real.txt')).catch((error) => ({ error }))
    check('清掉暂存状态后，只读回退恢复', after === 'REAL-CONTENT', JSON.stringify(after))
  }
  section('4. 存储状态机路径守卫：尾随空格/点与 8.3 短名不得绕过')
  {
    mkdirSync(join(wsRoot, '.dshstage'), { recursive: true })
    writeFileSync(join(wsRoot, '.dshstage', 'review.json'), '{"pending":false}')
    const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r34-guard' })
    const fs = new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    fs.log = () => {}
    fs.logError = () => {}
    const attempts = [
      ['.dshstage/review.json', 'plain'],
      ['.dshstage/review.json ', 'trailing-space'],
      ['.dshstage/review.json.', 'trailing-dot'],
      ['.dshstage/REVIEW~1.JSON', '8.3-short-name'],
      ['.dshstage/manifest.json.', 'manifest-trailing-dot'],
      ['.dshstage/queue.json ', 'queue-trailing-space'],
    ]
    for (const [rel, label] of attempts) {
      let denied
      try {
        await fs.writeText(target(rel), 'TAMPERED', undefined, undefined, undefined)
      } catch (error) {
        denied = error
      }
      check(
        `写 ${label} ⇒ FS_SANDBOX_DENIED（状态机保护不可词法绕过）`,
        denied?.code === 'FS_SANDBOX_DENIED',
        JSON.stringify({ rel, code: denied?.code, message: denied?.message }),
      )
    }
    // 对照：`.dshstage` 下的普通文件（不是状态机）保持既有行为，不被误伤。
    let plainError
    try {
      await fs.writeText(target('.dshstage/confirm-probe.txt'), 'OK', undefined, undefined, undefined)
    } catch (error) {
      plainError = error
    }
    check(
      '对照：`.dshstage` 下普通文件不被状态机守卫误伤（过了守卫，才在存储根上失败）',
      plainError?.code === 'ENV_FAULT_RETRYABLE',
      JSON.stringify({ code: plainError?.code }),
    )
  }

  section('4b. 真实 Phase-1 存储根（无 .dshstage 段）同样受写保护（R40-FS-04）')
  {
    const realStore = join(SCRATCH, 'real-phase1-store')
    mkdirSync(realStore, { recursive: true })
    const previous = process.env.WINSTAGE_STAGE_ROOT
    process.env.WINSTAGE_STAGE_ROOT = realStore
    disposeReviewServices()
    try {
      const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r34-real-store' })
      const fs = new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
      fs.log = () => {}
      fs.logError = () => {}
      const attempts = ['manifest.json', 'review.json', 'queue.json', 'blobs/x.bin', 'candidates/c.json', 'staged/a.txt']
      for (const rel of attempts) {
        const abs = join(realStore, rel)
        let denied
        try {
          await fs.writeText({ targetKey: abs, displayPath: abs }, 'TAMPER', undefined, undefined, undefined)
        } catch (error) {
          denied = error
        }
        check(
          `真实存储根写 ${rel} ⇒ FS_SANDBOX_DENIED（不再只认 .dshstage）`,
          denied?.code === 'FS_SANDBOX_DENIED',
          JSON.stringify({ rel, code: denied?.code }),
        )
      }
    } finally {
      if (previous === undefined) delete process.env.WINSTAGE_STAGE_ROOT
      else process.env.WINSTAGE_STAGE_ROOT = previous
      disposeReviewServices()
    }
  }
  section('5. 已发布快照的 workspaceRoot 自校验（不渲染别的工作区）')
  {
    const { readPublishedSnapshot } = await import('../dsh-plugin/host-plugin.ts')
    const storeDir = join(SCRATCH, 'panel-store')
    mkdirSync(storeDir, { recursive: true })
    const env = { ...process.env, WINSTAGE_STAGE_ROOT: storeDir }
    writeFileSync(
      join(storeDir, 'review.json'),
      JSON.stringify({ version: 1, workspaceRoot: 'C:\\SOMEWHERE-ELSE', pending: true, files: [] }),
    )
    const forged = readPublishedSnapshot({ workspaceRoot: wsRoot, sessionId: 'r34-panel', env })
    check(
      '快照声明别的工作区 ⇒ 不返回该快照（snapshot-workspace-mismatch）',
      forged.ok === false && forged.code === 'snapshot-workspace-mismatch',
      JSON.stringify({ ok: forged.ok, code: forged.code, detail: forged.detail }),
    )
    writeFileSync(
      join(storeDir, 'review.json'),
      JSON.stringify({ version: 1, workspaceRoot: wsRoot, pending: true, files: [] }),
    )
    const genuine = readPublishedSnapshot({ workspaceRoot: wsRoot, sessionId: 'r34-panel', env })
    check(
      '快照声明当前工作区（含大小写/尾分隔符差异）⇒ 正常返回',
      genuine.ok === true && genuine.snapshot?.workspaceRoot === wsRoot,
      JSON.stringify({ ok: genuine.ok, code: genuine.code }),
    )
    const malformed = [
      ['files-not-array', { version: 1, workspaceRoot: wsRoot, files: 'nope' }],
      ['root-array', []],
      ['version-not-number', { version: '1', workspaceRoot: wsRoot, files: [] }],
      ['file-entry-missing-path', { version: 1, workspaceRoot: wsRoot, files: [{ op: 'modify' }] }],
      ['staging-not-object', { version: 1, workspaceRoot: wsRoot, files: [], staging: 'on' }],
    ]
    for (const [id, payload] of malformed) {
      writeFileSync(join(storeDir, 'review.json'), JSON.stringify(payload))
      const result = readPublishedSnapshot({ workspaceRoot: wsRoot, sessionId: 'r34-panel', env })
      check(
        `畸形快照 ${id} ⇒ snapshot-invalid（不把不可解析形状交给客户端）`,
        result.ok === false && result.code === 'snapshot-invalid',
        JSON.stringify({ id, ok: result.ok, code: result.code, detail: result.detail }),
      )
    }
  }
  section('6. WINSTAGE_STAGE_OUTSIDE 三态（direct 是直写真实盘的逃生口，必须有边界断言）')
  {
    const outsideRoot = join(SCRATCH, 'outside')
    mkdirSync(outsideRoot, { recursive: true })
    const outsideStore = join(SCRATCH, 'outside-store')
    mkdirSync(outsideStore, { recursive: true })
    const previous = process.env.WINSTAGE_STAGE_ROOT
    process.env.WINSTAGE_STAGE_ROOT = outsideStore
    disposeReviewServices()
    const make = (stageOutside, tag) => {
      const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: `r34-out-${tag}`, stageOutside })
      return new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    }
    const outsideFile = join(outsideRoot, 'escape.txt')
    try {
      const denyFs = make('deny', 'deny')
      let denyError
      try {
        await denyFs.writeText({ targetKey: outsideFile, displayPath: outsideFile }, 'DENY', undefined, undefined, undefined)
      } catch (error) {
        denyError = error
      }
      check('stageOutside=deny ⇒ 工作区外写入被拒（FS_SANDBOX_DENIED）且真实盘未写', denyError?.code === 'FS_SANDBOX_DENIED' && !existsSync(outsideFile), JSON.stringify({ code: denyError?.code, exists: existsSync(outsideFile) }))

      const stageFs = make('stage', 'stage')
      let stageError
      try {
        await stageFs.writeText({ targetKey: outsideFile, displayPath: outsideFile }, 'STAGE', undefined, undefined, undefined)
      } catch (error) {
        stageError = error
      }
      const stagedEntries = Object.keys(getReviewService({ workspaceRoot: wsRoot, sessionId: 'r34-out-stage', claimShared: false }).workspace.manifest.entries)
      check(
        'stageOutside=stage（默认）⇒ 写入成功、真实盘未写、清单里有外部条目',
        stageError === undefined && !existsSync(outsideFile) && stagedEntries.some((key) => key.toLowerCase() === outsideFile.toLowerCase()),
        JSON.stringify({ error: stageError?.code, exists: existsSync(outsideFile), entries: stagedEntries.slice(0, 4) }),
      )

      const directFs = make('direct', 'direct')
      let directError
      try {
        await directFs.writeText({ targetKey: outsideFile, displayPath: outsideFile }, 'DIRECT', undefined, undefined, undefined)
      } catch (error) {
        directError = error
      }
      check(
        'stageOutside=direct（显式逃生口）⇒ 真实盘立即写入',
        directError === undefined && existsSync(outsideFile) && readFileSync(outsideFile, 'utf8') === 'DIRECT',
        JSON.stringify({ error: directError?.code, exists: existsSync(outsideFile) }),
      )
    } finally {
      if (previous === undefined) delete process.env.WINSTAGE_STAGE_ROOT
      else process.env.WINSTAGE_STAGE_ROOT = previous
      disposeReviewServices()
    }
  }

  section('7. 配置漂移 fail-closed：给了 workspaceRoot 却没有 cwd（profile 整体替换陷阱）')
  {
    const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => false })
    let missingCwd
    try {
      new Cls(new Context(), { workspaceRoot: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    } catch (error) {
      missingCwd = error
    }
    check(
      '只有 workspaceRoot、没有 cwd ⇒ FS_STAGE_ROOT_DRIFT（不得回退宿主 cwd）',
      missingCwd?.code === 'FS_STAGE_ROOT_DRIFT',
      JSON.stringify({ code: missingCwd?.code, message: missingCwd?.message }),
    )
    let mismatched
    try {
      new Cls(new Context(), { cwd: wsRoot, workspaceRoot: join(SCRATCH, 'another-root'), diffBasisMaxBytes: 1024 * 1024 })
    } catch (error) {
      mismatched = error
    }
    check(
      'cwd 与 workspaceRoot 不一致 ⇒ FS_STAGE_ROOT_DRIFT（既有行为不退化）',
      mismatched?.code === 'FS_STAGE_ROOT_DRIFT',
      JSON.stringify({ code: mismatched?.code }),
    )
    let notFound
    try {
      new Cls(new Context(), { cwd: join(SCRATCH, 'does-not-exist'), diffBasisMaxBytes: 1024 * 1024 })
    } catch (error) {
      notFound = error
    }
    check(
      '配置的根目录不存在 ⇒ FS_STAGE_ROOT_NOT_FOUND（不回退宿主 cwd）',
      notFound?.code === 'FS_STAGE_ROOT_NOT_FOUND',
      JSON.stringify({ code: notFound?.code, root: notFound?.root }),
    )
  }

  section('8. R40 回归：editText CRLF 归一 / 二进制 stat 真实大小')
  {
    const store = join(SCRATCH, 'edit-store')
    mkdirSync(store, { recursive: true })
    const previous = process.env.WINSTAGE_STAGE_ROOT
    process.env.WINSTAGE_STAGE_ROOT = store
    disposeReviewServices()
    try {
      const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r34-edit' })
      const fs = new Cls(new Context(), { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
      fs.log = () => {}
      fs.logError = () => {}
      writeFileSync(join(wsRoot, 'crlf.txt'), 'alpha\r\nbeta\r\n')
      let editError
      try {
        await fs.editText(
          { targetKey: join(wsRoot, 'crlf.txt'), displayPath: join(wsRoot, 'crlf.txt') },
          { oldString: 'alpha\r\nbeta', newString: 'alpha\r\nBETA' },
          undefined,
          undefined,
          undefined,
        )
      } catch (error) {
        editError = error
      }
      const after = await fs.readText({ targetKey: join(wsRoot, 'crlf.txt'), displayPath: join(wsRoot, 'crlf.txt') })
      check(
        'editText：带 CRLF 的 oldString/newString 正确归一，不产生 \\r\\r\\n',
        editError === undefined && after === 'alpha\r\nBETA\r\n' && !after.includes('\r\r\n'),
        JSON.stringify({ code: editError?.code, after }),
      )

      const binTarget = { targetKey: join(wsRoot, 'bin.dat'), displayPath: join(wsRoot, 'bin.dat') }
      const writeOutcome = await fs.writeText(binTarget, 'a\0b', undefined, undefined, undefined)
      check(
        'writeText 成功回执的可见键只有 operation/version/before/after（不得含 logicalPath）',
        Object.keys(writeOutcome).every((key) => ['operation', 'version', 'before', 'after'].includes(key)) && !('logicalPath' in writeOutcome),
        JSON.stringify({ keys: Object.keys(writeOutcome) }),
      )
      const stat = await fs.stat(binTarget)
      check('二进制/NUL 内容的 stat.size = 真实字节数（不是 0）', stat?.size === 3, JSON.stringify({ size: stat?.size }))
    } finally {
      if (previous === undefined) delete process.env.WINSTAGE_STAGE_ROOT
      else process.env.WINSTAGE_STAGE_ROOT = previous
      disposeReviewServices()
    }
  }

  section('9. R40-SNAP-06：diff 文本不得把 ESC/NUL 原样交给终端')
  {
    const fakeStore = {
      hasBlob: () => true,
      readBlob: () => Buffer.from('safe\n\x1b[31mred\x1b[0m\n\0nul', 'utf8'),
    }
    const candidate = {
      changes: [
        {
          path: 'bad\x1bname.txt',
          op: 'create',
          kind: 'file',
          before: { hash: hashAbsent() },
          after: { hash: 'h' },
        },
      ],
    }
    const lines = renderCandidateDiff(fakeStore, candidate, { maxLines: 10 })
    const joined = lines.map((line) => `${line.path ?? ''}${line.text ?? ''}`).join('|')
    check(
      '渲染后的 diff 不含原始 ESC/NUL，控制字符显示为 \\xNN',
      !joined.includes('\x1b') && !joined.includes('\0') && joined.includes('\\x1b') && joined.includes('\\x00'),
      JSON.stringify({ joined }),
    )
  }
} finally {
  disposeReviewServices()
  if (savedEnv === undefined) delete process.env.WINSTAGE_STAGE_ROOT
  else process.env.WINSTAGE_STAGE_ROOT = savedEnv
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    /* 清理尽力而为 */
  }
}

process.stdout.write('\n========================================================================\n')
process.stdout.write(`R34 守卫不可用只读回退：断言 ${assertions} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n`)
process.exitCode = failures === 0 ? 0 : 1
