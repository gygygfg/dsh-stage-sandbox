/**
 * 发布（apply）：把视图里的候选**整批**写进真实工作区，带 journal 与 undo。
 *
 * 为什么在控制面而不是驱动里做：
 *   · 真实工作区唯一的写者必须是可信代码；控制面（DSH 宿主）本身就是可信的，
 *     且它是唯一知道“批准了哪些候选、基线哈希是什么”的一方；
 *   · 驱动仍保留 `grantApply`（ABI v2），供 M2 把 apply 放进域内 helper 时使用。
 *
 * 硬约束（与 `src/nt/apply-manifest.ts` 一致）：
 *   · 冲突检查先于任何写：任一 `expectedBase ≠ 当前` ⇒ 整批零写（`NT_APPLY_CONFLICT`）；
 *   · 每个 after blob 的哈希必须与 manifest 一致，否则拒绝（`NT_APPLY_DENIED`）；
 *   · 写入走同目录临时文件 + rename（原子替换），旧内容先备份进 journal；
 *   · 任一步失败 ⇒ 按 journal 回滚到基线，再抛错（`executed` 如实标注）。
 *
 * journal 布局：`<journalRoot>/<candidateId>-<timestamp>.json` + `backups/`。
 *
 * @module winstage-sandbox/nt/apply
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { planApply, validateApplyManifest, type ApplyChange, type ApplyManifest } from './apply-manifest.ts'
import { normalizeRelativeWin32Path } from './paths.ts'
import { NtError } from './types.ts'

export interface NtApplyClientOptions {
  /** 真实工作区（宿主可访问的路径；Windows 上是 `C:\...`）。 */
  workspaceRoot: string
  /** CAS blob 根（只读）。 */
  blobRoot: string
  /** journal 根（必须在工作区之外）。 */
  journalRoot: string
  /** 测试注入：文件哈希。 */
  hashFile?: (absolutePath: string) => Promise<string | undefined>
  /**
   * 可移植/测试缝：把 manifest 里的 Win32 blob 路径映射到宿主可读路径。
   * Windows 生产路径不需要（默认恒等）。
   */
  resolveBlob?: (blobPath: string) => string
  now?: () => Date
}

export interface NtApplyResult {
  journalPath: string
  written: number
  deleted: number
}

interface JournalEntry {
  rel: string
  kind: ApplyChange['kind']
  beforeSha256?: string
  afterSha256?: string
  /** 备份文件（相对 journal 目录）；没有旧内容时为 undefined。 */
  backup?: string
  /** 已写入的目标是否在当时校验过。 */
  verified?: boolean
}

interface JournalFile {
  version: 1
  candidateId: string
  workspaceRoot: string
  status: 'applying' | 'applied' | 'rolled-back' | 'undone'
  startedAt: string
  updatedAt: string
  entries: JournalEntry[]
  error?: string
}

/** 发布客户端。所有方法都 fail-closed：失败时保证“要么全做、要么回到基线”。 */
export class NtApplyClient {
  private readonly options: NtApplyClientOptions
  private readonly hashFile: (absolutePath: string) => Promise<string | undefined>

  constructor(options: NtApplyClientOptions) {
    this.options = options
    this.hashFile = options.hashFile ?? defaultHashFile
  }

  /** 把 manifest 应用到真实工作区。 */
  async apply(manifest: ApplyManifest): Promise<NtApplyResult> {
    if (isInside(this.options.workspaceRoot, this.options.journalRoot) ||
        isInside(this.options.journalRoot, this.options.workspaceRoot)) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'journalRoot must not overlap workspaceRoot' })
    }

    // 1. 结构校验（不写盘）。
    const validated = validateApplyManifest(manifest, { blobRoot: this.options.blobRoot })

    // 2. 异步哈希：先算当前基线，再核对每个 CAS blob。
    const current = new Map<string, string | undefined>()
    for (const change of validated.changes) {
      const actual = await this.hashFile(this.abs(change.rel))
      current.set(change.rel, actual)
      if (change.kind !== 'deleted') {
        if (change.afterBlob === undefined || change.afterSha256 === undefined) {
          throw new NtError('NT_APPLY_DENIED', { reason: 'created/modified needs afterBlob + afterSha256', rel: change.rel })
        }
        const blobHash = await this.hashFile(this.blobPath(change.afterBlob))
        if (blobHash !== change.afterSha256.toLowerCase()) {
          throw new NtError('NT_APPLY_DENIED', {
            reason: 'CAS blob hash mismatch',
            rel: change.rel,
            expected: change.afterSha256,
            actual: blobHash,
          })
        }
      }
    }

    // 3. 冲突检查 + 顺序规划（任一 expectedBase 不匹配 ⇒ 整批零写）。
    const plan = planApply(validated, (rel) => current.get(rel), { blobRoot: this.options.blobRoot })

    // 3. journal（先写意图，再动盘）。
    const stamp = (this.options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
    await fs.mkdir(this.options.journalRoot, { recursive: true })
    const journalDir = join(this.options.journalRoot, `${manifest.candidateId}-${stamp}`)
    const backupsDir = join(journalDir, 'backups')
    await fs.mkdir(backupsDir, { recursive: true })
    const journalPath = join(journalDir, 'journal.json')

    const journal: JournalFile = {
      version: 1,
      candidateId: manifest.candidateId,
      workspaceRoot: manifest.workspaceRoot,
      status: 'applying',
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      updatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      entries: plan.manifest.changes.map((change) => ({
        rel: change.rel,
        kind: change.kind,
        ...(change.beforeSha256 === undefined ? {} : { beforeSha256: change.beforeSha256 }),
        ...(change.afterSha256 === undefined ? {} : { afterSha256: change.afterSha256 }),
      })),
    }
    await writeJournal(journalPath, journal)

    let written = 0
    let deleted = 0

    try {
      // 4. 写入（父目录浅的先写）。
      for (const change of plan.writes) {
        const abs = this.abs(change.rel)
        await fs.mkdir(dirname(abs), { recursive: true })

        const beforeSha = current.get(change.rel)
        if (beforeSha !== undefined) {
          const backupRel = join('backups', `${written}-${safeName(change.rel)}`)
          await copyFile(abs, join(journalDir, backupRel))
          const entry = journal.entries.find((item) => item.rel === change.rel)
          if (entry !== undefined) entry.backup = backupRel
          await writeJournal(journalPath, journal)
        }

        const tmp = `${abs}.dshnt-${randomBytes(6).toString('hex')}.tmp`
        const data = await fs.readFile(this.blobPath(change.afterBlob as string))
        const handle = await fs.open(tmp, 'w')
        try {
          await handle.writeFile(data)
          await handle.sync()
        } finally {
          await handle.close()
        }
        const tmpHash = sha256(data)
        if (tmpHash !== change.afterSha256?.toLowerCase()) {
          await fs.rm(tmp, { force: true })
          throw new NtError('NT_APPLY_DENIED', { reason: 'written temp hash mismatch', rel: change.rel })
        }
        await fs.rename(tmp, abs)

        const entry = journal.entries.find((item) => item.rel === change.rel)
        if (entry !== undefined) {
          entry.verified = true
          await writeJournal(journalPath, journal)
        }
        written++
      }

      // 5. 删除（子路径深的先删；删前备份以便 undo）。
      for (const change of plan.deletes) {
        const abs = this.abs(change.rel)
        const backupRel = join('backups', `deleted-${deleted}-${safeName(change.rel)}`)
        await copyFile(abs, join(journalDir, backupRel))
        const entry = journal.entries.find((item) => item.rel === change.rel)
        if (entry !== undefined) {
          entry.backup = backupRel
          await writeJournal(journalPath, journal)
        }
        await fs.unlink(abs)
        deleted++
      }

      // 6. 后置校验：写入的哈希必须等于 afterSha256。
      for (const change of plan.writes) {
        const actual = await this.hashFile(this.abs(change.rel))
        if (actual !== change.afterSha256?.toLowerCase()) {
          throw new NtError('NT_INTERNAL', {
            reason: 'post-apply hash mismatch',
            rel: change.rel,
            expected: change.afterSha256,
            actual,
          })
        }
      }

      journal.status = 'applied'
      journal.updatedAt = (this.options.now ?? (() => new Date()))().toISOString()
      await writeJournal(journalPath, journal)
      return { journalPath, written, deleted }
    } catch (error) {
      journal.status = 'rolled-back'
      journal.error = error instanceof Error ? error.message : String(error)
      journal.updatedAt = (this.options.now ?? (() => new Date()))().toISOString()
      await writeJournal(journalPath, journal)
      const rollbackOk = await this.rollback(journalDir, journal)
      if (error instanceof NtError) {
        throw new NtError(error.code, {
          ...(error.details ?? {}),
          rollback: rollbackOk ? 'ok' : 'failed',
          journalPath,
        }, { executed: rollbackOk ? false : error.executed, cause: error })
      }
      throw new NtError('NT_INTERNAL', {
        reason: 'apply failed',
        rollback: rollbackOk ? 'ok' : 'failed',
        journalPath,
      }, { executed: rollbackOk ? false : undefined, cause: error })
    }
  }

  /** 按 journal 撤销一次已成功的发布。 */
  async undo(journalPath: string): Promise<void> {
    const raw = await fs.readFile(journalPath, 'utf8')
    const journal = JSON.parse(raw) as JournalFile
    if (journal.status !== 'applied') {
      throw new NtError('NT_APPLY_DENIED', { reason: `journal status is ${journal.status}`, journalPath })
    }
    const journalDir = dirname(journalPath)
    const ok = await this.rollback(journalDir, journal)
    if (!ok) {
      throw new NtError('NT_INTERNAL', { reason: 'undo failed', journalPath, executed: undefined })
    }
    journal.status = 'undone'
    journal.updatedAt = (this.options.now ?? (() => new Date()))().toISOString()
    await writeJournal(journalPath, journal)
  }

  /**
   * 回滚：撤销/恢复每一条。
   * 反向顺序：先恢复删除，再恢复覆盖，最后删除新建。
   */
  private async rollback(journalDir: string, journal: JournalFile): Promise<boolean> {
    let ok = true
    const entries = [...journal.entries].reverse()
    for (const entry of entries) {
      const abs = this.abs(entry.rel)
      try {
        if (entry.backup !== undefined) {
          await fs.mkdir(dirname(abs), { recursive: true })
          await copyFile(join(journalDir, entry.backup), abs)
        } else if (entry.kind === 'created') {
          await fs.rm(abs, { force: true })
        }
      } catch {
        ok = false
      }
    }
    return ok
  }

  private blobPath(blob: string): string {
    return this.options.resolveBlob === undefined ? blob : this.options.resolveBlob(blob)
  }

  private abs(rel: string): string {
    const normalized = normalizeRelativeWin32Path(rel)
    if (normalized.length === 0) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'empty relative path' })
    }
    return join(this.options.workspaceRoot, ...normalized.split('\\'))
  }
}

async function defaultHashFile(absolutePath: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(absolutePath)
    return sha256(data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

async function copyFile(from: string, to: string): Promise<void> {
  await fs.mkdir(dirname(to), { recursive: true })
  await fs.copyFile(from, to)
}

async function writeJournal(path: string, journal: JournalFile): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
}

function safeName(rel: string): string {
  return rel.replace(/[\\/:*?"<>|]/g, '_')
}

function isInside(child: string, parent: string): boolean {
  const normalize = (value: string) => value.replace(/\//g, sep).replace(/[\\/]+$/, '').toLowerCase()
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(`${p}${sep}`) || c.startsWith(`${p}\\`)
}
