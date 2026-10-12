/**
 * The immutable fact schema rules evaluate against. Rules never read the host,
 * the network, or the clock; every input they see is one of these
 * control-plane-validated values.
 * @module dsh-sandbox-linux/policy/facts
 */

import type { ImpactCoverage, ImpactStats } from '../candidate/impact.ts'
import type { CandidateScope } from '../control/records.ts'
import type { Platform, PlanMode } from '../control/intent.ts'

/** The lifecycle phase a rule is evaluating. */
export type PolicyPhase = 'preflight' | 'candidate' | 'publication'

/** The candidate facts, present once a candidate exists. */
export interface FactCandidate {
  /** The candidate content digest. */
  readonly digest: string
  /** The base version the candidate was generated against. */
  readonly baseVersion: string
  /** The manifest digest. */
  readonly manifestDigest: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
}

/** How completely each impact category was observed. */
export interface FactCoverage {
  /** Filesystem coverage. */
  readonly fs: ImpactCoverage
  /** Process coverage. */
  readonly process: ImpactCoverage
  /** Network coverage. */
  readonly network: ImpactCoverage
}

/**
 * The complete fact snapshot one rule evaluation sees. A rule returns a verdict
 * over these facts; it never mutates them (the executor deep-freezes them).
 */
export interface PolicyFacts {
  /** The fact schema version. */
  readonly schemaVersion: '2.3'
  /** The phase being evaluated. */
  readonly phase: PolicyPhase
  /** The runtime platform. */
  readonly platform: Platform
  /** The calling identity. */
  readonly identity: {
    readonly tenant: string
    readonly caller: string
    readonly sessionId?: string
  }
  /** The execution envelope. */
  readonly envelope: {
    readonly mode: PlanMode
    readonly workspaceRoot: string
    readonly backendId: string
    readonly backendVersion: string
    readonly exe: string
    readonly argv: readonly string[]
    readonly cwd: string
  }
  /** The candidate facts, when the phase has one. */
  readonly candidate?: FactCandidate
  /** The counted impact, when the phase has one. */
  readonly impact?: ImpactStats
  /** Observation coverage per category. */
  readonly coverage: FactCoverage
  /** Grants already held for this operation. */
  readonly grants: readonly string[]
}
