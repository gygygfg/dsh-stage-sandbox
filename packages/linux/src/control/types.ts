/**
 * Platform-independent state vocabulary for the sandbox dry-run/commit
 * lifecycle. States and events are the control plane's transition alphabet;
 * the machine in `./machine.ts` maps one state and one event to the next
 * state, and nothing here depends on a host platform.
 * @module dsh-sandbox-linux/control/types
 */

/**
 * The lifecycle state of one execution attempt. The names are the control
 * plane's; `RECEIVED` is the entry state and every other value is reached
 * through {@link import('./machine.ts').transition}.
 */
export type SandboxOperationState =
  | 'RECEIVED'
  | 'PARSED'
  | 'PREFLIGHTED'
  | 'AWAITING_EXECUTION_AUTH'
  | 'STAGING'
  | 'CANDIDATE_READY'
  | 'COMPLETED_READ_ONLY'
  | 'AWAITING_PUBLICATION_AUTH'
  | 'READY_TO_PUBLISH'
  | 'PUBLISHING'
  | 'VERIFYING'
  | 'COMMITTED'
  | 'CONFLICT'
  | 'RECONCILING'
  | 'RECOVERING'
  | 'ROLLED_BACK'
  | 'RECOVERY_REQUIRED'
  | 'ROLLBACK_FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'REJECTED'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'

/**
 * One transition event. The control plane records the event and the resulting
 * state; the machine is the only authority on whether the pair is legal.
 */
export type SandboxOperationEvent =
  | 'parsed'
  | 'invalid'
  | 'preflight-passed'
  | 'hard-deny'
  | 'require-execution-auth'
  | 'execution-authorized'
  | 'resources-ready'
  | 'staged'
  | 'stage-failed'
  | 'cancelled'
  | 'read-only-complete'
  | 'candidate-valid'
  | 'candidate-invalid'
  | 'require-publication-auth'
  | 'publication-authorized'
  | 'publish-intent'
  | 'baseline-conflict'
  | 'publish-receipt'
  | 'verify-passed'
  | 'needs-recovery'
  | 'reconcile-published'
  | 'reconcile-unpublished'
  | 'reconcile-unknown'
  | 'recovery-succeeded'
  | 'recovery-target-changed'
  | 'recovery-failed'
  | 'expired'
