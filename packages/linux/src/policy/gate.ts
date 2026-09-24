/**
 * The policy publication gate: build the fact snapshot for a frozen candidate,
 * evaluate the loaded rule packs, and map the aggregate verdict onto the
 * control plane's publication gate. A hard DENY from any rule cannot be
 * overridden by a confirmation.
 * @module dsh-sandbox-linux/policy/gate
 */

import type { CandidateRef, OperationRecord } from '../control/records.ts'
import type { PublicationGate, PublicationGatekeeper } from '../control/service.ts'
import type { PolicyEngine } from './engine.ts'
import type { PolicyFacts, PolicyPhase } from './facts.ts'

/**
 * Build the immutable fact snapshot for one operation and candidate.
 * @param record - the operation record.
 * @param candidate - the frozen candidate.
 * @param phase - the phase being evaluated; defaults to `publication`.
 * @returns the fact snapshot.
 */
export function factsFromRecord(record: OperationRecord, candidate: CandidateRef, phase: PolicyPhase = 'publication'): PolicyFacts {
  return {
    schemaVersion: '2.3',
    phase,
    platform: record.platform,
    identity: { tenant: record.tenant, caller: record.caller },
    envelope: {
      mode: record.request.mode,
      workspaceRoot: record.request.workspaceRoot,
      backendId: record.platform,
      backendVersion: 'unknown',
      exe: record.request.command.exe,
      argv: record.request.command.argv,
      cwd: record.request.command.cwd,
    },
    candidate: {
      digest: candidate.digest,
      baseVersion: candidate.baseVersion,
      manifestDigest: candidate.manifestDigest,
      scope: candidate.scope,
    },
    coverage: { fs: 'partial', process: 'partial', network: 'missing' },
    grants: [],
  }
}

/** A publication gate backed by the policy engine. */
export class PolicyPublicationGate implements PublicationGatekeeper {
  private readonly engine: PolicyEngine

  /**
   * @param engine - the policy engine holding the loaded packs.
   */
  constructor(engine: PolicyEngine) {
    this.engine = engine
  }

  /** @inheritdoc */
  async evaluate(input: { readonly record: OperationRecord; readonly candidate: CandidateRef }): Promise<PublicationGate> {
    const verdict = await this.engine.evaluate(factsFromRecord(input.record, input.candidate))
    if (verdict.decision === 'DENY') return { kind: 'deny', reasonCodes: verdict.reasonCodes }
    if (verdict.decision === 'NEEDS_CONFIRMATION') return { kind: 'needs-authorization' }
    return { kind: 'allow' }
  }
}
