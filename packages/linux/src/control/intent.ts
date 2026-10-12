/**
 * Execution and publication intent: the structured request the control plane
 * accepts and the hashes it binds authorizations and candidates to. The
 * execution-intent hash includes the runtime backend identity and capability
 * fingerprint, so a command under a different backend or capability set is a
 * different intent and can never reuse an authorization or a candidate.
 * @module dsh-sandbox-linux/control/intent
 */

import type { CapabilityReport } from '../pal/index.ts'
import { digestOf } from '../util/canonical.ts'

/** The runtime platform this plugin supports. */
export type Platform = 'linux'

/** The file-effect mode a plan runs under; `danger-full-access` never reaches here. */
export type PlanMode = 'read-only' | 'workspace-write'

/**
 * A structured plan request. The control plane normalizes and hashes it; a
 * caller never supplies a precomputed hash.
 */
export interface PlanRequest {
  /** Tenant scope for idempotency and authorization. */
  readonly tenant: string
  /** Calling principal within the tenant. */
  readonly caller: string
  /** Runtime platform the plan targets. */
  readonly platform: Platform
  /** The file-effect mode the staged execution runs under. */
  readonly mode: PlanMode
  /** The exact program, arguments, working directory, and environment. */
  readonly command: {
    readonly exe: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
  }
  /** Absolute workspace root the plan may write under. */
  readonly workspaceRoot: string
  /** Digests of the input snapshot the plan was computed against. */
  readonly inputDigests: readonly string[]
  /** Submission deduplication key, scoped to tenant and caller. */
  readonly clientIdempotencyKey: string
}

/**
 * The execution intent bound into an authorization. The backend identity,
 * version, and capability fingerprint make otherwise identical commands under
 * different backends distinct intents.
 */
export interface ExecutionIntent {
  /** The exact program. */
  readonly exe: string
  /** The exact arguments. */
  readonly argv: readonly string[]
  /** The working directory. */
  readonly cwd: string
  /** The environment allow-list actually provided. */
  readonly env: Readonly<Record<string, string>>
  /** Digests of the inputs. */
  readonly inputDigests: readonly string[]
  /** The selected runtime backend id (`linux`). */
  readonly backendId: string
  /** The backend implementation version. */
  readonly backendVersion: string
  /** A digest of the backend's probed capability statuses. */
  readonly capabilityFingerprint: string
  /** A digest of the policy and permission envelope. */
  readonly policyEnvelope: string
}

/**
 * The publication intent bound into a publish authorization: everything an
 * approval is for, fixed at the moment the user approves.
 */
export interface PublicationIntent {
  /** The execution intent that produced the candidate. */
  readonly executionIntentHash: string
  /** The frozen candidate digest. */
  readonly candidateDigest: string
  /** The base version the candidate was generated against. */
  readonly expectedBase: string
  /** The publication target identity. */
  readonly target: string
  /** The digest of the complete approval manifest. */
  readonly manifestDigest: string
  /** The publication policy identity. */
  readonly publicationPolicy: string
}

/**
 * A fingerprint of a backend's probed capabilities, so a capability change is
 * visible as an intent change even when the backend version string is stable.
 * @param report - the backend capability report.
 * @returns the digest of the capability statuses.
 */
export function capabilityFingerprint(report: CapabilityReport): string {
  return digestOf({
    backendId: report.backendId,
    capabilities: report.capabilities,
    ...(report.environment === undefined ? {} : { environment: report.environment }),
    ...(report.validation === undefined ? {} : { validation: report.validation.fingerprint, validationOk: report.validation.ok }),
  })
}

/**
 * The hash of a normalized plan request's content. The idempotency key is
 * excluded: it is the deduplication handle, while this hash is what a second
 * submission under the same key must match.
 * @param request - the plan request.
 * @returns the request hash.
 */
export function requestHash(request: PlanRequest): string {
  return digestOf({
    tenant: request.tenant,
    caller: request.caller,
    platform: request.platform,
    mode: request.mode,
    command: request.command,
    workspaceRoot: request.workspaceRoot,
    inputDigests: request.inputDigests,
  })
}

/**
 * The hash of an execution intent.
 * @param intent - the execution intent.
 * @returns the execution-intent hash.
 */
export function executionIntentHash(intent: ExecutionIntent): string {
  return digestOf(intent)
}

/**
 * The hash of a publication intent.
 * @param intent - the publication intent.
 * @returns the publication-intent hash.
 */
export function publicationIntentHash(intent: PublicationIntent): string {
  return digestOf(intent)
}
