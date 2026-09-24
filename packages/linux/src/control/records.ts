/**
 * Durable record vocabulary for the control plane: the operation record, the
 * frozen candidate reference, the publication receipt, and the candidate
 * scope. These are the values persistence stores and the service returns.
 * @module dsh-sandbox-linux/control/records
 */

import type { ManifestEntry } from '../candidate/manifest.ts'
import type { PlanRequest, Platform } from './intent.ts'
import type { SandboxOperationEvent, SandboxOperationState } from './types.ts'

/**
 * The fact categories a candidate covers. A category outside the scope must
 * not be silently ignored: a write in it is refused, not folded into a file
 * diff.
 */
export type ImpactCategory = 'filesystem'

/** The declared coverage of a candidate. */
export interface CandidateScope {
  /** The impact categories this candidate expresses. */
  readonly categories: readonly ImpactCategory[]
  /** The absolute roots the candidate may contain writes under. */
  readonly writableRoots: readonly string[]
}

/**
 * A frozen candidate: an immutable snapshot of the effects a staged execution
 * produced, held in sandbox-private storage the sandbox cannot write after
 * freezing.
 */
export interface CandidateRef {
  /** The candidate content digest. */
  readonly digest: string
  /** The base version the candidate was generated against. */
  readonly baseVersion: string
  /** The digest of the complete approval manifest. */
  readonly manifestDigest: string
  /**
   * The complete logical manifest the candidate stands for. When present the
   * publisher applies exactly these entries, reading content only for entries
   * whose target differs — so `path` may hold a delta (changed files only).
   * Absent on bare references (e.g. a policy fact snapshot), where the
   * publisher falls back to scanning `path`.
   */
  readonly entries?: readonly ManifestEntry[]
  /** Sandbox-private storage location the candidate was frozen into. */
  readonly path: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  /** Epoch milliseconds the candidate was frozen. */
  readonly createdAt: number
}

/** A queryable publication receipt, stable across control-plane restarts. */
export interface PublicationReceipt {
  /** The stable operation identity. */
  readonly operationId: string
  /** The published candidate digest. */
  readonly candidateDigest: string
  /** The version before publication. */
  readonly oldVersion: string
  /** The version after publication. */
  readonly newVersion: string
  /** The fencing token the publisher checked. */
  readonly fencingToken: number
  /** The publication target identity. */
  readonly target: string
  /** Epoch milliseconds the receipt was written. */
  readonly at: number
}

/** One recorded state transition. */
export interface OperationEventRecord {
  /** Monotonic sequence within the operation. */
  readonly seq: number
  /** The transition event. */
  readonly event: SandboxOperationEvent
  /** The resulting state. */
  readonly state: SandboxOperationState
  /** Epoch milliseconds the transition was recorded. */
  readonly at: number
}

/** One execution attempt's durable record. */
export interface OperationRecord {
  /** The control-plane-issued logical command identity. */
  readonly commandId: string
  /** The current attempt identity; a retry creates a new one. */
  readonly attemptId: string
  /** The tenant scope. */
  readonly tenant: string
  /** The calling principal. */
  readonly caller: string
  /** The submission deduplication key. */
  readonly clientIdempotencyKey: string
  /** The normalized request content hash. */
  readonly requestHash: string
  /** The runtime platform. */
  readonly platform: Platform
  /** The normalized plan request, persisted as the run spec staging replays. */
  readonly request: PlanRequest
  /** The current lifecycle state. */
  state: SandboxOperationState
  /** The optimistic-concurrency version; every commit increments it. */
  stateVersion: number
  /** The execution intent hash, once computed. */
  executionIntentHash?: string
  /** The publication intent hash, once computed. */
  publicationIntentHash?: string
  /** The frozen candidate, once staging completed. */
  candidate?: CandidateRef
  /** The publication receipt, once published. */
  receipt?: PublicationReceipt
  /** The recorded transition history. */
  readonly events: OperationEventRecord[]
}
