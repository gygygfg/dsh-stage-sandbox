/**
 * The sandbox control plane. It owns the state transitions, idempotency,
 * intent binding, lease acquisition, and the publication gate; staging and
 * publication are injected so the orchestrator stays platform- and
 * filesystem-independent. Every state change goes through the store's
 * optimistic-concurrency commit, and every publish checks a fencing token at
 * the write.
 * @module dsh-sandbox-linux/control/service
 */

import type { CapabilityReport, CapabilityRequirement } from '../pal/index.ts'
import { capabilityGaps } from '../pal/index.ts'
import type { ImpactModel } from '../candidate/impact.ts'
import type { CandidateRef, OperationRecord } from './records.ts'
import { LeaseRegistry, systemClock, type Clock, type Lease } from './lease.ts'
import { MemoryControlStore, StateConflictError, type ControlStore } from './store.ts'
import type { Platform, PlanRequest } from './intent.ts'
import { capabilityFingerprint, executionIntentHash, publicationIntentHash, requestHash, type ExecutionIntent, type PublicationIntent } from './intent.ts'
import { newAttemptId, newCommandId } from './ids.ts'
import { transition } from './machine.ts'
import type { SandboxOperationEvent, SandboxOperationState } from './types.ts'
import type { Publisher, PublishOutcome } from '../publish/publisher.ts'

/** Failure codes of the control plane. */
export type ControlErrorCode =
  | 'IDEMPOTENCY_MISMATCH'
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_READY'
  | 'CAPABILITY_MISSING'
  | 'STAGING_FAILED'
  | 'PUBLISH_CONFLICT'

/** Thrown for a control-plane refusal. */
export class ControlError extends Error {
  /** The failure code. */
  readonly code: ControlErrorCode

  /**
   * @param code - the failure code.
   * @param message - the human-readable text.
   */
  constructor(code: ControlErrorCode, message: string) {
    super(message)
    this.name = 'ControlError'
    this.code = code
  }
}

/** A backend report lookup, satisfied by the PAL registry adapter. */
export interface BackendSelector {
  /**
   * The probed capability report for a platform.
   * @param platform - the plan's platform.
   * @returns the report, or `unusable`.
   */
  report(platform: Platform): CapabilityReport | 'unusable'
}

/** The result of staging one command. */
export interface StageResult {
  /** The frozen candidate. */
  readonly candidate: CandidateRef
  /** The observed impact model. */
  readonly impact: ImpactModel
  /** Whether the command produced no publishable product. */
  readonly readOnly: boolean
  /** Evidence pointers the impact records cite. */
  readonly evidenceIds: readonly string[]
}

/** A stager executes one plan in a private, disposable space and freezes the result. */
export interface Stager {
  /**
   * Stage one command.
   * @param input - the request, the bound execution-intent hash, and the ids.
   * @returns the frozen candidate and observed impact.
   */
  stage(input: {
    readonly request: PlanRequest
    readonly executionIntentHash: string
    readonly commandId: string
    readonly attemptId: string
  }): Promise<StageResult>
}

/** The publication gate's verdict for a candidate. */
export type PublicationGate =
  | { readonly kind: 'allow' }
  | { readonly kind: 'needs-authorization' }
  | { readonly kind: 'deny'; readonly reasonCodes: readonly string[] }

/** A publication gate decides whether a candidate may publish or needs human authorization. */
export interface PublicationGatekeeper {
  /**
   * Evaluate a candidate for publication.
   * @param input - the record and its candidate.
   * @returns the gate verdict.
   */
  evaluate(input: { readonly record: OperationRecord; readonly candidate: CandidateRef }): Promise<PublicationGate>
}

/** The capabilities every confined plan requires of its backend. */
const BASE_REQUIREMENTS: readonly CapabilityRequirement[] = [{ capability: 'fileEffectPolicy', minimum: 'partial' }]

/** The PAL platform name for a plan platform. */
export function hostPlatform(platform: Platform): string {
  return platform
}

/**
 * The pure control-plane orchestrator. It is deliberately not a Cordis
 * service: the plugin wraps it, so the state logic is unit-testable without a
 * context.
 */
export class SandboxControl {
  /** The store backing every record. */
  readonly store: ControlStore
  private readonly clock: Clock
  private readonly deps: {
    readonly backends: BackendSelector
    readonly stager: Stager
    readonly publisher: Publisher
    readonly leases?: LeaseRegistry
    readonly store?: ControlStore
    readonly clock?: Clock
    readonly gate?: PublicationGatekeeper
  }

  /**
   * @param deps - the backend selector, stager, publisher, lease registry, and optional store/clock.
   */
  constructor(deps: {
    readonly backends: BackendSelector
    readonly stager: Stager
    readonly publisher: Publisher
    readonly leases?: LeaseRegistry
    readonly store?: ControlStore
    readonly clock?: Clock
    readonly gate?: PublicationGatekeeper
  }) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.store = deps.store ?? new MemoryControlStore(this.clock)
    this.leases = deps.leases ?? new LeaseRegistry(this.clock)
  }

  /** The lease registry. */
  readonly leases: LeaseRegistry

  /**
   * Submit a plan. A replay under the same idempotency key with the same
   * request content returns the original command; a different request under
   * the same key is refused.
   * @param request - the plan request.
   * @returns the created (or replayed) operation record.
   */
  submit(request: PlanRequest): OperationRecord {
    const hash = requestHash(request)
    const existing = this.store.findByIdempotencyKey(request.tenant, request.caller, request.clientIdempotencyKey)
    if (existing !== undefined) {
      if (existing.requestHash !== hash) {
        throw new ControlError('IDEMPOTENCY_MISMATCH', `idempotency key '${request.clientIdempotencyKey}' was used with different request content`)
      }
      return existing
    }
    const commandId = newCommandId()
    this.store.create({
      commandId,
      attemptId: newAttemptId(),
      tenant: request.tenant,
      caller: request.caller,
      clientIdempotencyKey: request.clientIdempotencyKey,
      requestHash: hash,
      platform: request.platform,
      request,
      state: 'RECEIVED',
      stateVersion: 0,
      events: [],
    })
    this.advance(commandId, 'parsed')

    const report = this.deps.backends.report(request.platform)
    if (report === 'unusable') {
      return this.advance(commandId, 'invalid')
    }
    // A cached probe success is not enough: the report must cover the actual
    // operations this deployment can perform.
    if (report.validation !== undefined && !report.validation.ok) {
      return this.advance(commandId, 'invalid')
    }
    const gaps = capabilityGaps(report, BASE_REQUIREMENTS)
    if (gaps.length > 0) {
      return this.advance(commandId, 'invalid')
    }
    this.advance(commandId, 'preflight-passed')
    const intent = this.buildExecutionIntent(request, report)
    const record = this.store.get(commandId)
    if (record === undefined) throw new ControlError('NOT_FOUND', commandId)
    this.store.commit(commandId, record.stateVersion, 'require-execution-auth', 'AWAITING_EXECUTION_AUTH', { executionIntentHash: executionIntentHash(intent) })
    return this.require(commandId)
  }

  /**
   * Grant execution authorization for a plan awaiting it.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  authorizeExecution(commandId: string): OperationRecord {
    return this.advance(commandId, 'execution-authorized')
  }

  /**
   * Stage an authorized plan and freeze its candidate.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  async stage(commandId: string): Promise<OperationRecord> {
    const record = this.require(commandId)
    if (record.state !== 'PREFLIGHTED') {
      throw new ControlError('NOT_READY', `operation '${commandId}' is in ${record.state}, not PREFLIGHTED`)
    }
    this.advance(commandId, 'resources-ready')
    let result: StageResult
    try {
      result = await this.deps.stager.stage({
        request: this.requestOf(record),
        executionIntentHash: record.executionIntentHash ?? '',
        commandId: record.commandId,
        attemptId: record.attemptId,
      })
    } catch (error) {
      this.advance(commandId, 'stage-failed')
      throw error
    }
    this.advance(commandId, 'staged', { candidate: result.candidate })
    if (result.readOnly) {
      return this.advance(commandId, 'read-only-complete')
    }
    const gate = this.deps.gate === undefined ? { kind: 'allow' as const } : await this.deps.gate.evaluate({ record: this.require(commandId), candidate: result.candidate })
    if (gate.kind === 'needs-authorization') {
      return this.advance(commandId, 'require-publication-auth')
    }
    if (gate.kind === 'deny') {
      return this.advance(commandId, 'candidate-invalid')
    }
    return this.advance(commandId, 'candidate-valid')
  }

  /**
   * Grant publication authorization for a candidate awaiting it.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  authorizePublication(commandId: string): OperationRecord {
    return this.advance(commandId, 'publication-authorized')
  }

  /**
   * Publish the frozen candidate under CAS.
   * @param commandId - the operation identity.
   * @param target - the publication target identity.
   * @param expectedBase - the base version the candidate expects.
   * @param leaseTtlMs - the publication lease lifetime.
   * @returns the updated record.
   */
  async publish(commandId: string, target: string, expectedBase: string, leaseTtlMs = 30_000): Promise<OperationRecord> {
    const record = this.require(commandId)
    if (record.state !== 'READY_TO_PUBLISH') {
      throw new ControlError('NOT_READY', `operation '${commandId}' is in ${record.state}, not READY_TO_PUBLISH`)
    }
    if (record.candidate === undefined) throw new ControlError('NOT_READY', `operation '${commandId}' has no candidate`)
    const lease = this.leases.acquire(`workspace:${target}`, commandId, leaseTtlMs)
    const publicationIntent: PublicationIntent = {
      executionIntentHash: record.executionIntentHash ?? '',
      candidateDigest: record.candidate.digest,
      expectedBase,
      target,
      manifestDigest: record.candidate.manifestDigest,
      publicationPolicy: 'default',
    }
    const publicationHash = publicationIntentHash(publicationIntent)
    this.advance(commandId, 'publish-intent', { publicationIntentHash: publicationHash })
    const outcome: PublishOutcome = await this.deps.publisher.publish({
      operationId: commandId,
      candidate: record.candidate,
      expectedBase,
      target,
      lease,
    })
    this.leases.release(lease)
    if (outcome.kind === 'conflict') {
      return this.advance(commandId, 'baseline-conflict')
    }
    if (outcome.kind === 'stale-lease') {
      return this.advance(commandId, 'reconcile-unknown')
    }
    this.advance(commandId, 'publish-receipt', { receipt: outcome.receipt })
    return this.advance(commandId, 'verify-passed')
  }

  /**
   * Reconcile an operation whose publication outcome was unknown.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  reconcile(commandId: string): OperationRecord {
    const record = this.require(commandId)
    if (record.state !== 'RECONCILING') {
      throw new ControlError('NOT_READY', `operation '${commandId}' is in ${record.state}, not RECONCILING`)
    }
    const receipt = this.deps.publisher.receiptFor(commandId)
    return receipt === undefined ? this.advance(commandId, 'reconcile-unpublished') : this.advance(commandId, 'reconcile-published')
  }

  /**
   * Read an operation record.
   * @param commandId - the operation identity.
   * @returns the record.
   * @throws ControlError NOT_FOUND when unknown.
   */
  status(commandId: string): OperationRecord {
    return this.require(commandId)
  }

  /** Read a record or throw. */
  private require(commandId: string): OperationRecord {
    const record = this.store.get(commandId)
    if (record === undefined) throw new ControlError('NOT_FOUND', `operation '${commandId}' does not exist`)
    return record
  }

  /** Apply one event to a record through the machine, or throw on an illegal pair. */
  private advance(commandId: string, event: SandboxOperationEvent, patch?: Parameters<ControlStore['commit']>[4]): OperationRecord {
    const record = this.require(commandId)
    const next = transition(record.state, event)
    if (next === undefined) {
      throw new ControlError('ILLEGAL_TRANSITION', `event '${event}' is not legal in state ${record.state}`)
    }
    return this.store.commit(commandId, record.stateVersion, event, next, patch)
  }

  /** Build the execution intent for a preflighted request. */
  private buildExecutionIntent(request: PlanRequest, report: CapabilityReport): ExecutionIntent {
    return {
      exe: request.command.exe,
      argv: request.command.argv,
      cwd: request.command.cwd,
      env: request.command.env,
      inputDigests: request.inputDigests,
      backendId: report.backendId,
      backendVersion: report.backendVersion,
      capabilityFingerprint: capabilityFingerprint(report),
      policyEnvelope: request.mode,
    }
  }

  /** Reconstruct the request content a record was created from. */
  private requestOf(record: OperationRecord): PlanRequest {
    return record.request
  }
}

export { StateConflictError, MemoryControlStore }
