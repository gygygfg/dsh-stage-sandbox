/**
 * Narrow task grants (v2.3 §15). A grant authorizes a bounded set of
 * operations — an explicit root scope, a set of operation kinds, a file
 * budget, and an expiry — so a task the user has already sanctioned can
 * auto-apply instead of stopping for confirmation. A grant never overrides a
 * policy `DENY`; it only removes the confirmation requirement inside its
 * declared scope.
 * @module dsh-sandbox-linux/control/grant
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { systemClock, type Clock } from './lease.ts'

/** The operation kinds a grant can authorize. */
export type GrantOperation = 'apply' | 'reject'

/** One issued grant. */
export interface TaskGrant {
  /** The grant identity. */
  readonly id: string
  /** The task the grant belongs to. */
  readonly taskId: string
  /** The absolute roots the grant covers. */
  readonly roots: readonly string[]
  /** The operations the grant authorizes. */
  readonly operations: readonly GrantOperation[]
  /** The maximum number of files the grant may apply, or `null` for unbounded. */
  readonly fileBudget: number | null
  /** How many files have been consumed. */
  readonly filesConsumed: number
  /** Epoch milliseconds the grant expires. */
  readonly expiresAt: number
}

/** The query a covering-grant lookup answers. */
export interface GrantQuery {
  /** The absolute target root. */
  readonly root: string
  /** The operation being attempted. */
  readonly operation: GrantOperation
  /** How many files the operation would apply. */
  readonly fileCount: number
}

/** Whether a root is the grant root or a descendant of it. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The in-memory grant registry. */
export class GrantRegistry {
  private readonly grants = new Map<string, TaskGrant>()
  private sequence = 0
  private readonly clock: Clock

  /**
   * @param clock - the clock used for expiry and issuance timestamps.
   */
  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  /**
   * Issue a grant.
   * @param input - the task, roots, operations, optional file budget, and TTL.
   * @returns the created grant.
   */
  issue(input: { taskId: string; roots: readonly string[]; operations: readonly GrantOperation[]; fileBudget?: number | null; ttlMs: number }): TaskGrant {
    const grant: TaskGrant = {
      id: `grant_${++this.sequence}`,
      taskId: input.taskId,
      roots: input.roots.map(root => resolve(root)),
      operations: input.operations,
      fileBudget: input.fileBudget ?? null,
      filesConsumed: 0,
      expiresAt: this.clock.now() + input.ttlMs,
    }
    this.grants.set(grant.id, grant)
    return grant
  }

  /**
   * The most recently issued grant that covers a query, or `undefined`.
   * @param query - the root, operation, and file count.
   * @returns the covering grant.
   */
  findCovering(query: GrantQuery): TaskGrant | undefined {
    const root = resolve(query.root)
    for (const grant of [...this.grants.values()].reverse()) {
      if (this.clock.now() >= grant.expiresAt) continue
      if (!grant.operations.includes(query.operation)) continue
      if (!grant.roots.some(candidate => isUnder(candidate, root))) continue
      if (grant.fileBudget !== null && grant.filesConsumed + query.fileCount > grant.fileBudget) continue
      return grant
    }
    return undefined
  }

  /**
   * Consume file budget from a grant.
   * @param id - the grant identity.
   * @param files - the number of files consumed.
   */
  consume(id: string, files: number): void {
    const grant = this.grants.get(id)
    if (grant === undefined) return
    this.grants.set(id, { ...grant, filesConsumed: grant.filesConsumed + files })
  }

  /**
   * Revoke a grant.
   * @param id - the grant identity.
   */
  revoke(id: string): void {
    this.grants.delete(id)
  }

  /** Every live grant, for diagnostics. */
  list(): TaskGrant[] {
    return [...this.grants.values()]
  }
}
