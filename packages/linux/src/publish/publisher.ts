/**
 * The CAS publisher: publish a frozen candidate only when the target's current
 * version still equals the candidate's `expectedBase`. The publisher checks the
 * lease's fencing token at the write, records a queryable receipt, and is
 * idempotent by `operationId`, so a restart returns the same published result
 * instead of publishing twice.
 * @module dsh-sandbox-linux/publish/publisher
 */

import type { CandidateRef, PublicationReceipt } from '../control/records.ts'
import type { Lease, LeaseRegistry, LeaseVerdict } from '../control/lease.ts'
import { systemClock, type Clock } from '../control/lease.ts'
import { MemoryReceiptStore, type ReceiptStore } from './receipt-store.ts'

/** A target the publisher can read a version from and apply a candidate to. */
export interface PublicationBackend {
  /**
   * The target's current version digest.
   * @param target - the target identity.
   * @returns the current version digest.
   */
  currentVersion(target: string): Promise<string>
  /**
   * Apply a candidate to the target. The implementation must verify that the
   * target still equals `expectedBase` immediately before writing and refuse
   * with a conflict otherwise.
   * @param input - the target, candidate, and expected base.
   * @returns the new version digest.
   * @throws PublicationConflictError when the target moved.
   */
  apply(input: { readonly target: string; readonly candidate: CandidateRef; readonly expectedBase: string }): Promise<{ newVersion: string }>
}

/** Thrown by a {@link PublicationBackend} when the target moved since the base. */
export class PublicationConflictError extends Error {
  /** The version actually observed. */
  readonly currentVersion: string

  /**
   * @param currentVersion - the version actually observed.
   */
  constructor(currentVersion: string) {
    super(`publication baseline conflict: target is at ${currentVersion}`)
    this.name = 'PublicationConflictError'
    this.currentVersion = currentVersion
  }
}

/** One publication request. */
export interface PublishRequest {
  /** The stable operation identity; the idempotency key for publication. */
  readonly operationId: string
  /** The frozen candidate. */
  readonly candidate: CandidateRef
  /** The base version the candidate expects. */
  readonly expectedBase: string
  /** The publication target identity. */
  readonly target: string
  /** The lease whose fencing token the write checks. */
  readonly lease: Lease
}

/** The publisher's verdict for one request. */
export type PublishOutcome =
  | { readonly kind: 'published'; readonly receipt: PublicationReceipt }
  | { readonly kind: 'conflict'; readonly currentVersion: string }
  | { readonly kind: 'stale-lease'; readonly verdict: LeaseVerdict }

/**
 * The publisher. It owns the receipt log keyed by operation id, so a repeated
 * publish of the same operation is a no-op returning the original receipt.
 */
export class Publisher {
  private readonly receipts: ReceiptStore
  private readonly backend: PublicationBackend
  private readonly leases: LeaseRegistry
  private readonly clock: Clock

  /**
   * @param backend - the target backend.
   * @param leases - the lease registry the fencing check reads.
   * @param clock - the clock used for receipt timestamps.
   * @param receipts - the receipt log; defaults to process-local. Pass a
   *   durable store so publication stays idempotent across a restart.
   */
  constructor(
    backend: PublicationBackend,
    leases: LeaseRegistry,
    clock: Clock = systemClock,
    receipts: ReceiptStore = new MemoryReceiptStore(),
  ) {
    this.backend = backend
    this.leases = leases
    this.clock = clock
    this.receipts = receipts
  }

  /**
   * Publish a candidate under CAS.
   * @param request - the publication request.
   * @returns the outcome: published with a receipt, conflict, or stale lease.
   */
  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const existing = this.receipts.get(request.operationId)
    if (existing !== undefined) return { kind: 'published', receipt: existing }
    const verdict = this.leases.check(request.lease)
    if (verdict !== 'valid') return { kind: 'stale-lease', verdict }
    let newVersion: string
    try {
      const result = await this.backend.apply({ target: request.target, candidate: request.candidate, expectedBase: request.expectedBase })
      newVersion = result.newVersion
    } catch (error) {
      if (error instanceof PublicationConflictError) return { kind: 'conflict', currentVersion: error.currentVersion }
      throw error
    }
    const receipt: PublicationReceipt = {
      operationId: request.operationId,
      candidateDigest: request.candidate.digest,
      oldVersion: request.expectedBase,
      newVersion,
      fencingToken: request.lease.fencingToken,
      target: request.target,
      at: this.clock.now(),
    }
    this.receipts.put(receipt)
    return { kind: 'published', receipt }
  }

  /**
   * The recorded receipt for an operation, for reconciliation after a crash.
   * @param operationId - the operation identity.
   * @returns the receipt, or `undefined` when the operation never published.
   */
  receiptFor(operationId: string): PublicationReceipt | undefined {
    return this.receipts.get(operationId)
  }
}
