/**
 * The publication receipt log. A receipt makes publication idempotent by
 * operation id: after a crash the publisher returns the recorded result instead
 * of applying the candidate twice. The default is process-local; a durable
 * implementation survives a restart so a replayed operation reconciles against
 * what was actually written.
 * @module dsh-sandbox-linux/publish/receipt-store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicationReceipt } from '../control/records.ts'

/** The receipt log contract the publisher depends on. */
export interface ReceiptStore {
  /**
   * Read a recorded receipt.
   * @param operationId - the publication operation identity.
   * @returns the receipt, or `undefined`.
   */
  get(operationId: string): PublicationReceipt | undefined
  /**
   * Record (or replace) a receipt.
   * @param receipt - the receipt to store.
   */
  put(receipt: PublicationReceipt): void
  /**
   * Every recorded receipt, for diagnostics.
   * @returns a snapshot array.
   */
  list(): PublicationReceipt[]
}

/** The process-local receipt log; the default. */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, PublicationReceipt>()

  /** @inheritdoc */
  get(operationId: string): PublicationReceipt | undefined {
    return this.receipts.get(operationId)
  }

  /** @inheritdoc */
  put(receipt: PublicationReceipt): void {
    this.receipts.set(receipt.operationId, receipt)
  }

  /** @inheritdoc */
  list(): PublicationReceipt[] {
    return [...this.receipts.values()]
  }
}

/**
 * A file-backed receipt log. Each receipt is one JSON file under
 * `<root>/receipts/`; writes are atomic (temp file + rename) so a crash never
 * leaves a half-written receipt. A corrupt file is skipped rather than
 * failing the whole load.
 */
export class FileReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, PublicationReceipt>()
  private readonly dir: string

  /**
   * @param root - the state directory.
   */
  constructor(root: string) {
    this.dir = join(root, 'receipts')
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  /** @inheritdoc */
  get(operationId: string): PublicationReceipt | undefined {
    return this.receipts.get(operationId)
  }

  /** @inheritdoc */
  put(receipt: PublicationReceipt): void {
    this.receipts.set(receipt.operationId, receipt)
    const name = createHash('sha256').update(receipt.operationId).digest('hex')
    const path = join(this.dir, `${name}.json`)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, JSON.stringify(receipt, null, 2))
    renameSync(temporary, path)
  }

  /** @inheritdoc */
  list(): PublicationReceipt[] {
    return [...this.receipts.values()]
  }

  /** Load every persisted receipt into memory. */
  private load(): void {
    if (!existsSync(this.dir)) return
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const receipt = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as PublicationReceipt
        this.receipts.set(receipt.operationId, receipt)
      } catch {
        // a corrupt receipt is ignored; the operation simply reconciles from disk
      }
    }
  }
}
