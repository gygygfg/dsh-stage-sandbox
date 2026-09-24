/**
 * The sandbox dry-run/commit state machine. One state and one event map to at
 * most one next state; an unlisted pair is illegal and returns `undefined`,
 * which the control plane refuses rather than silently ignoring.
 * @module dsh-sandbox-linux/control/machine
 */

import type { SandboxOperationEvent, SandboxOperationState } from './types.ts'

/**
 * The transition table. Each state lists only its legal events; a state with
 * no entry for an event is a refusal. The table is total over the state
 * vocabulary by construction of the exhaustive object below.
 */
const TRANSITIONS: Record<SandboxOperationState, Partial<Record<SandboxOperationEvent, SandboxOperationState>>> = {
  RECEIVED: { parsed: 'PARSED', invalid: 'REJECTED' },
  PARSED: {
    'preflight-passed': 'PREFLIGHTED',
    'hard-deny': 'BLOCKED',
    'require-execution-auth': 'AWAITING_EXECUTION_AUTH',
    invalid: 'REJECTED',
  },
  PREFLIGHTED: { 'resources-ready': 'STAGING' },
  AWAITING_EXECUTION_AUTH: {
    'execution-authorized': 'PREFLIGHTED',
    cancelled: 'CANCELLED',
    expired: 'EXPIRED',
  },
  STAGING: {
    staged: 'CANDIDATE_READY',
    'stage-failed': 'FAILED',
    cancelled: 'CANCELLED',
  },
  CANDIDATE_READY: {
    'read-only-complete': 'COMPLETED_READ_ONLY',
    'require-publication-auth': 'AWAITING_PUBLICATION_AUTH',
    'candidate-valid': 'READY_TO_PUBLISH',
    'candidate-invalid': 'FAILED',
  },
  COMPLETED_READ_ONLY: {},
  AWAITING_PUBLICATION_AUTH: {
    'publication-authorized': 'READY_TO_PUBLISH',
    cancelled: 'CANCELLED',
    expired: 'EXPIRED',
  },
  READY_TO_PUBLISH: { 'publish-intent': 'PUBLISHING' },
  PUBLISHING: {
    'baseline-conflict': 'CONFLICT',
    'publish-receipt': 'VERIFYING',
    'reconcile-unknown': 'RECONCILING',
  },
  VERIFYING: {
    'verify-passed': 'COMMITTED',
    'needs-recovery': 'RECOVERING',
    'reconcile-unknown': 'RECONCILING',
  },
  COMMITTED: {},
  CONFLICT: {},
  RECONCILING: {
    'reconcile-published': 'VERIFYING',
    'reconcile-unpublished': 'READY_TO_PUBLISH',
    'reconcile-unknown': 'OUTCOME_UNKNOWN',
  },
  RECOVERING: {
    'recovery-succeeded': 'ROLLED_BACK',
    'recovery-target-changed': 'RECOVERY_REQUIRED',
    'recovery-failed': 'ROLLBACK_FAILED',
  },
  ROLLED_BACK: {},
  RECOVERY_REQUIRED: {},
  ROLLBACK_FAILED: {},
  OUTCOME_UNKNOWN: {},
  REJECTED: {},
  BLOCKED: {},
  FAILED: {},
  CANCELLED: {},
  EXPIRED: {},
}

/** States from which no event transitions further. */
export const TERMINAL_STATES: ReadonlySet<SandboxOperationState> = new Set(
  (Object.keys(TRANSITIONS) as SandboxOperationState[]).filter(state => Object.keys(TRANSITIONS[state]).length === 0),
)

/**
 * Apply one event to one state.
 * @param state - the current lifecycle state.
 * @param event - the event being applied.
 * @returns the next state, or `undefined` when the pair is not a legal transition.
 */
export function transition(state: SandboxOperationState, event: SandboxOperationEvent): SandboxOperationState | undefined {
  return TRANSITIONS[state][event]
}

/**
 * Whether a state accepts no further event.
 * @param state - the lifecycle state to test.
 * @returns `true` for a terminal state.
 */
export function isTerminal(state: SandboxOperationState): boolean {
  return TERMINAL_STATES.has(state)
}
