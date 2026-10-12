/**
 * Durable pending-approval storage (v2.3 §13). A frozen candidate that is
 * waiting for user confirmation is written to disk before the process may
 * exit, so reopening the session restores the approval instead of losing it.
 * The frozen tree is content-addressed by the candidate digest, so a restored
 * record can always be reviewed and published without the original staging
 * directory.
 * @module dsh-sandbox-linux/stage/pending-store
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CandidateRef } from '../control/records.ts'
import type { DangerLevel, DangerMarker, DangerReason } from '../candidate/danger.ts'

/** One serializable pending confirmation. */
export interface PersistedPending {
  /** The workspace root the candidate targets. */
  readonly workspaceRoot: string
  /** The branch the candidate belongs to. */
  readonly branchId: string
  /** The frozen candidate (its `path` is the durable content-addressed tree). */
  readonly candidate: CandidateRef
  /**
   * When present, a selective publication: only these real paths are applied
   * and the rest of the staged changes stay pending.
   */
  readonly files?: readonly string[]
  /** The danger level. */
  readonly level: DangerLevel | 'none'
  /** The approval-window marker color. */
  readonly marker: DangerMarker | null
  /** How many confirmations the level requires. */
  readonly confirmationsRequired: number
  /** How many confirmations the user has given. */
  readonly confirmationsReceived: number
  /** The consequences the user must be shown. */
  readonly consequences: readonly string[]
  /** Why the candidate is dangerous. */
  readonly reasons: readonly DangerReason[]
  /** Epoch milliseconds the candidate was frozen. */
  readonly frozenAt: number
}

/** The durable pending-approval store contract. */
export interface PendingStore {
  /**
   * Load every persisted pending record.
   * @returns the records still present on disk.
   */
  load(): PersistedPending[]
  /**
   * Persist (or replace) one pending record.
   * @param record - the record to persist.
   */
  put(record: PersistedPending): void
  /**
   * Remove one pending record.
   * @param workspaceRoot - the target workspace root.
   * @param branchId - the branch identity.
   */
  remove(workspaceRoot: string, branchId: string): void
}

/** A stable filename-safe key for one branch. */
function fileKey(workspaceRoot: string, branchId: string): string {
  return createHash('sha256').update(`${workspaceRoot}\0${branchId}`).digest('hex')
}

/** The process-local store; the default when no durable directory is configured. */
export class MemoryPendingStore implements PendingStore {
  private readonly records = new Map<string, PersistedPending>()

  /** @inheritdoc */
  load(): PersistedPending[] {
    return [...this.records.values()]
  }

  /** @inheritdoc */
  put(record: PersistedPending): void {
    this.records.set(fileKey(record.workspaceRoot, record.branchId), record)
  }

  /** @inheritdoc */
  remove(workspaceRoot: string, branchId: string): void {
    this.records.delete(fileKey(workspaceRoot, branchId))
  }
}

/**
 * A file-backed pending store. Each record is one JSON file under
 * `<dir>/pending/`; the frozen candidate trees live under
 * `<dir>/candidates/<digest>/`. Writes are atomic (temp file + rename), so a
 * crash never leaves a half-written record.
 */
export class FilePendingStore implements PendingStore {
  private readonly root: string
  private readonly pendingDir: string
  private readonly candidateDir: string

  /**
   * @param root - the state directory.
   */
  constructor(root: string) {
    this.root = root
    this.pendingDir = join(root, 'pending')
    this.candidateDir = join(root, 'candidates')
    mkdirSync(this.pendingDir, { recursive: true })
    mkdirSync(this.candidateDir, { recursive: true })
  }

  /** @inheritdoc */
  load(): PersistedPending[] {
    const records: PersistedPending[] = []
    for (const name of readdirSync(this.pendingDir)) {
      if (!name.endsWith('.json')) continue
      const path = join(this.pendingDir, name)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedPending
        // A record whose frozen tree is gone cannot be reviewed; drop it.
        if (!existsSync(parsed.candidate.path)) {
          rmSync(path, { force: true })
          continue
        }
        records.push(parsed)
      } catch {
        rmSync(path, { force: true })
      }
    }
    return records
  }

  /** @inheritdoc */
  put(record: PersistedPending): void {
    const path = join(this.pendingDir, `${fileKey(record.workspaceRoot, record.branchId)}.json`)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record, null, 2))
    renameSync(temporary, path)
  }

  /** @inheritdoc */
  remove(workspaceRoot: string, branchId: string): void {
    rmSync(join(this.pendingDir, `${fileKey(workspaceRoot, branchId)}.json`), { force: true })
  }

  /**
   * Copy a frozen tree into the content-addressed candidate store and return
   * the durable path.
   * @param digest - the candidate digest.
   * @param sourcePath - the staging tree to snapshot.
   * @returns the durable candidate path.
   */
  snapshotCandidate(digest: string, sourcePath: string): string {
    const safe = digest.replace(/[^A-Za-z0-9._-]/gu, '_')
    const destination = join(this.candidateDir, safe)
    if (!existsSync(destination)) cpSync(sourcePath, destination, { recursive: true, force: true, errorOnExist: false })
    return destination
  }

  /**
   * Remove a candidate's durable tree.
   * @param digest - the candidate digest.
   */
  dropCandidate(digest: string): void {
    const safe = digest.replace(/[^A-Za-z0-9._-]/gu, '_')
    rmSync(join(this.candidateDir, safe), { recursive: true, force: true })
  }

  /** The state directory this store owns. */
  get directory(): string {
    return this.root
  }
}
