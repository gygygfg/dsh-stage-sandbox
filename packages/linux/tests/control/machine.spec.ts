import { describe, expect, it } from 'vitest'
import { TERMINAL_STATES, isTerminal, transition } from '../../src/control/machine.ts'
import type { SandboxOperationState } from '../../src/control/types.ts'

const ALL_STATES: SandboxOperationState[] = [
  'RECEIVED', 'PARSED', 'PREFLIGHTED', 'AWAITING_EXECUTION_AUTH', 'STAGING', 'CANDIDATE_READY',
  'COMPLETED_READ_ONLY', 'AWAITING_PUBLICATION_AUTH', 'READY_TO_PUBLISH', 'PUBLISHING', 'VERIFYING',
  'COMMITTED', 'CONFLICT', 'RECONCILING', 'RECOVERING', 'ROLLED_BACK', 'RECOVERY_REQUIRED',
  'ROLLBACK_FAILED', 'OUTCOME_UNKNOWN', 'REJECTED', 'BLOCKED', 'FAILED', 'CANCELLED', 'EXPIRED',
]

describe('sandbox operation state machine', () => {
  it('walks the happy path from RECEIVED to COMMITTED', () => {
    const steps: [SandboxOperationState, Parameters<typeof transition>[1]][] = [
      ['RECEIVED', 'parsed'],
      ['PARSED', 'preflight-passed'],
      ['PREFLIGHTED', 'resources-ready'],
      ['STAGING', 'staged'],
      ['CANDIDATE_READY', 'candidate-valid'],
      ['READY_TO_PUBLISH', 'publish-intent'],
      ['PUBLISHING', 'publish-receipt'],
      ['VERIFYING', 'verify-passed'],
    ]
    let state: SandboxOperationState = 'RECEIVED'
    for (const [expected, event] of steps) {
      expect(state).toBe(expected)
      const next = transition(state, event)
      expect(next).toBeDefined()
      state = next as SandboxOperationState
    }
    expect(state).toBe('COMMITTED')
    expect(isTerminal(state)).toBe(true)
  })

  it('refuses an event that is not legal in the current state', () => {
    expect(transition('RECEIVED', 'publish-intent')).toBeUndefined()
    expect(transition('COMMITTED', 'parsed')).toBeUndefined()
    expect(transition('AWAITING_EXECUTION_AUTH', 'resources-ready')).toBeUndefined()
  })

  it('treats every state with no outgoing transition as terminal', () => {
    for (const state of ALL_STATES) {
      const hasOutgoing = (['parsed', 'invalid', 'preflight-passed', 'hard-deny', 'require-execution-auth', 'execution-authorized', 'resources-ready', 'staged', 'stage-failed', 'cancelled', 'read-only-complete', 'candidate-valid', 'candidate-invalid', 'require-publication-auth', 'publication-authorized', 'publish-intent', 'baseline-conflict', 'publish-receipt', 'verify-passed', 'needs-recovery', 'reconcile-published', 'reconcile-unpublished', 'reconcile-unknown', 'recovery-succeeded', 'recovery-target-changed', 'recovery-failed', 'expired'] as const)
        .some(event => transition(state, event) !== undefined)
      expect(isTerminal(state)).toBe(!hasOutgoing)
    }
  })

  it('lists the expected terminal states', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ['BLOCKED', 'CANCELLED', 'COMMITTED', 'COMPLETED_READ_ONLY', 'CONFLICT', 'EXPIRED', 'FAILED', 'OUTCOME_UNKNOWN', 'RECOVERY_REQUIRED', 'REJECTED', 'ROLLBACK_FAILED', 'ROLLED_BACK'].sort(),
    )
  })
})
