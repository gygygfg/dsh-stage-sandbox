/**
 * Identity minting for the control plane. Every id is opaque and prefixed so
 * evidence and logs remain readable without parsing.
 * @module dsh-sandbox-linux/control/ids
 */

import { randomUUID } from 'node:crypto'

/**
 * Mint a logical command identity.
 * @returns a fresh `cmd_`-prefixed id.
 */
export function newCommandId(): string {
  return `cmd_${randomUUID()}`
}

/**
 * Mint an execution-attempt identity. A retry mints a new one; the original
 * attempt's evidence is never overwritten.
 * @returns a fresh `attempt_`-prefixed id.
 */
export function newAttemptId(): string {
  return `attempt_${randomUUID()}`
}

/**
 * Mint a stable operation identity for a publication or external effect.
 * @returns a fresh `op_`-prefixed id.
 */
export function newOperationId(): string {
  return `op_${randomUUID()}`
}
