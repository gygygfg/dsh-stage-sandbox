/**
 * The evidence store (v2.3 §12). Evidence records what a staged execution
 * observed (filesystem effects, process facts, network attempts, policy and
 * privilege decisions) so a decision can be reviewed or replayed later. Every
 * record is redacted before it is stored: a secret value never reaches the log.
 * @module dsh-sandbox-linux/evidence/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemClock, type Clock } from '../control/lease.ts'

/** The evidence categories. */
export type EvidenceKind = 'fs' | 'process' | 'network' | 'policy' | 'privilege' | 'observe'

/** One redacted evidence record. */
export interface EvidenceRecord {
  /** The record identity. */
  readonly id: string
  /** The category. */
  readonly kind: EvidenceKind
  /** Epoch milliseconds the record was added. */
  readonly at: number
  /** The redacted payload. */
  readonly data: Readonly<Record<string, unknown>>
}

/** Keys whose values are always redacted. */
const SECRET_KEYS = /(?:secret|password|passwd|token|apikey|api_key|authorization|cookie|private|credential|signature)/iu
/** A long high-entropy run that is likely a secret. */
const HIGH_ENTROPY = /[A-Za-z0-9+/=_-]{24,}/u

/** Redact secret-looking fields and high-entropy strings from a payload. */
export function redactEvidence(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]'
  if (typeof value === 'string') return HIGH_ENTROPY.test(value) ? '[redacted]' : value
  if (Array.isArray(value)) return value.map(item => redactEvidence(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactEvidence(item, depth + 1)
    }
    return out
  }
  return value
}

/** The evidence store contract. */
export interface EvidenceStore {
  /**
   * Add one redacted record.
   * @param kind - the category.
   * @param data - the (pre-redaction) payload.
   * @returns the record identity.
   */
  add(kind: EvidenceKind, data: Record<string, unknown>): string
  /**
   * Read one record.
   * @param id - the record identity.
   * @returns the record, or `undefined`.
   */
  get(id: string): EvidenceRecord | undefined
  /**
   * Read a page of records, newest-last.
   * @param offset - the starting index.
   * @param limit - the maximum records.
   * @returns the page.
   */
  page(offset: number, limit: number): EvidenceRecord[]
  /** Every record, for diagnostics. */
  list(): EvidenceRecord[]
}

/** The process-local evidence store. */
export class MemoryEvidenceStore implements EvidenceStore {
  private readonly records: EvidenceRecord[] = []
  private sequence = 0
  private readonly clock: Clock

  /**
   * @param clock - the clock used for record timestamps.
   */
  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  /** @inheritdoc */
  add(kind: EvidenceKind, data: Record<string, unknown>): string {
    const id = `ev_${++this.sequence}`
    this.records.push({ id, kind, at: this.clock.now(), data: redactEvidence(data) as Record<string, unknown> })
    return id
  }

  /** @inheritdoc */
  get(id: string): EvidenceRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /** @inheritdoc */
  page(offset: number, limit: number): EvidenceRecord[] {
    return this.records.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
  }

  /** @inheritdoc */
  list(): EvidenceRecord[] {
    return [...this.records]
  }
}

/** A file-backed evidence store: append-only JSONL under `<root>/evidence.jsonl`. */
export class FileEvidenceStore implements EvidenceStore {
  private readonly records: EvidenceRecord[] = []
  private readonly path: string
  private sequence = 0
  private readonly clock: Clock

  /**
   * @param root - the state directory.
   * @param clock - the clock used for record timestamps.
   */
  constructor(root: string, clock: Clock = systemClock) {
    mkdirSync(root, { recursive: true })
    this.path = join(root, 'evidence.jsonl')
    this.clock = clock
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line) as EvidenceRecord
          this.records.push(record)
          this.sequence += 1
        } catch {
          // a corrupt line is skipped
        }
      }
    }
  }

  /** @inheritdoc */
  add(kind: EvidenceKind, data: Record<string, unknown>): string {
    const id = `ev_${++this.sequence}`
    const record: EvidenceRecord = { id, kind, at: this.clock.now(), data: redactEvidence(data) as Record<string, unknown> }
    this.records.push(record)
    appendFileSync(this.path, `${JSON.stringify(record)}\n`)
    return id
  }

  /** @inheritdoc */
  get(id: string): EvidenceRecord | undefined {
    return this.records.find(record => record.id === id)
  }

  /** @inheritdoc */
  page(offset: number, limit: number): EvidenceRecord[] {
    return this.records.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit))
  }

  /** @inheritdoc */
  list(): EvidenceRecord[] {
    return [...this.records]
  }
}
