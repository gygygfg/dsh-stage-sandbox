/**
 * Host-operation proposals (v2.3 §14). A T2 command's host effect cannot be
 * published by the file CAS: it is frozen as a proposal, listed for the user,
 * and only replayed on the host after approval. The registry never replays a
 * rejected or unknown proposal, and records the replay result.
 * @module dsh-sandbox-linux/control/hostop
 */

import { systemClock, type Clock } from './lease.ts'

/** One host-operation proposal. */
export interface HostOperation {
  /** The proposal identity. */
  readonly id: string
  /** The exact host command that would run on approval. */
  readonly command: string
  /** A short human-readable summary. */
  readonly summary: string
  /** The proposal danger level (host operations are always L3). */
  readonly level: 'L3'
  /** The lifecycle state. */
  readonly state: 'proposed' | 'applied' | 'rejected'
  /** Epoch milliseconds the proposal was created. */
  readonly at: number
}

/** The result of replaying a proposal. */
export type HostReplayResult =
  | { readonly kind: 'applied'; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'not-found' }

/** Runs an approved host command. */
export type HostReplayRunner = (command: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>

/** The in-memory host-operation registry. */
export class HostOperationRegistry {
  private readonly operations = new Map<string, HostOperation>()
  private sequence = 0
  private readonly clock: Clock

  /**
   * @param clock - the clock used for proposal timestamps.
   */
  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  /**
   * Freeze a host effect as a proposal (no host change).
   * @param input - the host command and a summary.
   * @returns the proposal.
   */
  propose(input: { command: string; summary: string }): HostOperation {
    const operation: HostOperation = {
      id: `hostop_${++this.sequence}`,
      command: input.command,
      summary: input.summary,
      level: 'L3',
      state: 'proposed',
      at: this.clock.now(),
    }
    this.operations.set(operation.id, operation)
    return operation
  }

  /** Every proposal, oldest first. */
  list(): HostOperation[] {
    return [...this.operations.values()]
  }

  /**
   * Reject a proposal; it can never be replayed.
   * @param id - the proposal identity.
   * @returns whether a proposal was rejected.
   */
  reject(id: string): boolean {
    const operation = this.operations.get(id)
    if (operation === undefined || operation.state !== 'proposed') return false
    this.operations.set(id, { ...operation, state: 'rejected' })
    return true
  }

  /**
   * Replay an approved proposal on the host.
   * @param id - the proposal identity.
   * @param run - the host runner.
   * @returns the replay result.
   */
  async replay(id: string, run: HostReplayRunner): Promise<HostReplayResult> {
    const operation = this.operations.get(id)
    if (operation === undefined) return { kind: 'not-found' }
    if (operation.state !== 'proposed') return { kind: 'rejected' }
    const result = await run(operation.command)
    this.operations.set(id, { ...operation, state: 'applied' })
    return { kind: 'applied', ...result }
  }
}
