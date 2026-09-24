/**
 * The control plane's durable store contract and an in-memory implementation.
 * Every state update is an optimistic-concurrency commit keyed on
 * `stateVersion`; the store is the only place a transition is appended, so the
 * event log and the state can never diverge. A deployment swaps in a
 * persistent implementation behind the same contract.
 * @module dsh-sandbox-linux/control/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from './lease.ts'
import { systemClock } from './lease.ts'
import type { OperationEventRecord, OperationRecord } from './records.ts'
import type { SandboxOperationEvent, SandboxOperationState } from './types.ts'

/** The mutable fields a commit may set alongside the transition. */
export type OperationPatch = Partial<Pick<OperationRecord, 'executionIntentHash' | 'publicationIntentHash' | 'candidate' | 'receipt'>>

/** Thrown when a commit's expected `stateVersion` no longer matches. */
export class StateConflictError extends Error {
  /** The operation whose version changed. */
  readonly commandId: string
  /** The version the caller expected. */
  readonly expected: number
  /** The current version. */
  readonly actual: number

  /**
   * @param commandId - the operation whose version changed.
   * @param expected - the version the caller expected.
   * @param actual - the current version.
   */
  constructor(commandId: string, expected: number, actual: number) {
    super(`operation '${commandId}' state version conflict: expected ${expected}, found ${actual}`)
    this.name = 'StateConflictError'
    this.commandId = commandId
    this.expected = expected
    this.actual = actual
  }
}

/** The store contract the control plane depends on. */
export interface ControlStore {
  /**
   * Insert a new operation record.
   * @param record - the record to insert; its `commandId` must be unused.
   */
  create(record: OperationRecord): void
  /**
   * Read one operation record.
   * @param commandId - the operation identity.
   * @returns the record, or `undefined`.
   */
  get(commandId: string): OperationRecord | undefined
  /**
   * Look up an operation by its submission deduplication key.
   * @param tenant - the tenant scope.
   * @param caller - the calling principal.
   * @param key - the idempotency key.
   * @returns the existing record, or `undefined`.
   */
  findByIdempotencyKey(tenant: string, caller: string, key: string): OperationRecord | undefined
  /**
   * Apply one transition under optimistic concurrency and append the event.
   * @param commandId - the operation identity.
   * @param expectedVersion - the caller's expected `stateVersion`.
   * @param event - the transition event.
   * @param nextState - the resulting state from the machine.
   * @param patch - optional mutable fields to set with the transition.
   * @returns the updated record.
   * @throws StateConflictError when the version moved.
   */
  commit(commandId: string, expectedVersion: number, event: SandboxOperationEvent, nextState: SandboxOperationState, patch?: OperationPatch): OperationRecord
  /**
   * All operation records, for diagnostics and recovery sweeps.
   * @returns a snapshot array.
   */
  list(): OperationRecord[]
}

/** The process-local store; the default when no persistent backend is configured. */
export class MemoryControlStore implements ControlStore {
  private readonly records = new Map<string, OperationRecord>()
  private readonly clock: Clock

  /**
   * @param clock - the clock used for event timestamps.
   */
  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  /** @inheritdoc */
  create(record: OperationRecord): void {
    if (this.records.has(record.commandId)) throw new Error(`operation '${record.commandId}' already exists`)
    this.records.set(record.commandId, record)
  }

  /** @inheritdoc */
  get(commandId: string): OperationRecord | undefined {
    return this.records.get(commandId)
  }

  /** @inheritdoc */
  findByIdempotencyKey(tenant: string, caller: string, key: string): OperationRecord | undefined {
    for (const record of this.records.values()) {
      if (record.tenant === tenant && record.caller === caller && record.clientIdempotencyKey === key) return record
    }
    return undefined
  }

  /** @inheritdoc */
  commit(commandId: string, expectedVersion: number, event: SandboxOperationEvent, nextState: SandboxOperationState, patch: OperationPatch = {}): OperationRecord {
    const record = this.records.get(commandId)
    if (record === undefined) throw new Error(`operation '${commandId}' does not exist`)
    if (record.stateVersion !== expectedVersion) throw new StateConflictError(commandId, expectedVersion, record.stateVersion)
    record.state = nextState
    record.stateVersion = expectedVersion + 1
    if (patch.executionIntentHash !== undefined) record.executionIntentHash = patch.executionIntentHash
    if (patch.publicationIntentHash !== undefined) record.publicationIntentHash = patch.publicationIntentHash
    if (patch.candidate !== undefined) record.candidate = patch.candidate
    if (patch.receipt !== undefined) record.receipt = patch.receipt
    const entry: OperationEventRecord = { seq: record.events.length, event, state: nextState, at: this.clock.now() }
    record.events.push(entry)
    return record
  }

  /** @inheritdoc */
  list(): OperationRecord[] {
    return [...this.records.values()]
  }
}

/** The stable filename for one operation id. */
function operationFile(commandId: string): string {
  return `${createHash('sha256').update(commandId).digest('hex')}.json`
}

/**
 * A file-backed control store. Each operation is one JSON file under
 * `<root>/operations/`; records are loaded once at construction and every
 * mutation is written atomically (temp file + rename). This is what makes the
 * control plane survive a restart: a replayed `submit` finds the same record
 * and a `stage`/`publish` resumes from the persisted state.
 */
export class FileControlStore implements ControlStore {
  private readonly records = new Map<string, OperationRecord>()
  private readonly dir: string
  private readonly clock: Clock

  /**
   * @param root - the state directory.
   * @param clock - the clock used for event timestamps.
   */
  constructor(root: string, clock: Clock = systemClock) {
    this.dir = join(root, 'operations')
    mkdirSync(this.dir, { recursive: true })
    this.clock = clock
    this.load()
  }

  /** @inheritdoc */
  create(record: OperationRecord): void {
    if (this.records.has(record.commandId)) throw new Error(`operation '${record.commandId}' already exists`)
    this.records.set(record.commandId, record)
    this.persist(record)
  }

  /** @inheritdoc */
  get(commandId: string): OperationRecord | undefined {
    return this.records.get(commandId)
  }

  /** @inheritdoc */
  findByIdempotencyKey(tenant: string, caller: string, key: string): OperationRecord | undefined {
    for (const record of this.records.values()) {
      if (record.tenant === tenant && record.caller === caller && record.clientIdempotencyKey === key) return record
    }
    return undefined
  }

  /** @inheritdoc */
  commit(commandId: string, expectedVersion: number, event: SandboxOperationEvent, nextState: SandboxOperationState, patch: OperationPatch = {}): OperationRecord {
    const record = this.records.get(commandId)
    if (record === undefined) throw new Error(`operation '${commandId}' does not exist`)
    if (record.stateVersion !== expectedVersion) throw new StateConflictError(commandId, expectedVersion, record.stateVersion)
    record.state = nextState
    record.stateVersion = expectedVersion + 1
    if (patch.executionIntentHash !== undefined) record.executionIntentHash = patch.executionIntentHash
    if (patch.publicationIntentHash !== undefined) record.publicationIntentHash = patch.publicationIntentHash
    if (patch.candidate !== undefined) record.candidate = patch.candidate
    if (patch.receipt !== undefined) record.receipt = patch.receipt
    const entry: OperationEventRecord = { seq: record.events.length, event, state: nextState, at: this.clock.now() }
    record.events.push(entry)
    this.persist(record)
    return record
  }

  /** @inheritdoc */
  list(): OperationRecord[] {
    return [...this.records.values()]
  }

  /** Write one record atomically. */
  private persist(record: OperationRecord): void {
    const path = join(this.dir, operationFile(record.commandId))
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(record, null, 2))
    renameSync(temporary, path)
  }

  /** Load every persisted record into memory. */
  private load(): void {
    if (!existsSync(this.dir)) return
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as OperationRecord
        this.records.set(record.commandId, record)
      } catch {
        // a corrupt record is skipped; the operation is simply unknown
      }
    }
  }
}
