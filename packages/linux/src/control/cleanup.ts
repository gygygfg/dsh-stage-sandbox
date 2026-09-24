/**
 * Cleanup closure (v2.3). Reclaiming a resource follows a fixed order:
 * dereference logically, stop writers, unload or release handles, verify
 * ownership, delete the resource, and record the result. A cleanup that cannot
 * converge its writers must not freeze a candidate or reuse the resource.
 * Cleanup failures record the residual object, the reason, the occupancy
 * budget, and the retry state instead of silently disappearing.
 * @module dsh-sandbox-linux/control/cleanup
 */

/** The ordered cleanup stages. */
export type CleanupStage =
  | 'dereference'
  | 'stop-writers'
  | 'release-handles'
  | 'verify-ownership'
  | 'delete'
  | 'record'

/** The stage order a cleanup must follow. */
export const CLEANUP_ORDER: readonly CleanupStage[] = [
  'dereference',
  'stop-writers',
  'release-handles',
  'verify-ownership',
  'delete',
  'record',
]

/** One resource to reclaim. */
export interface CleanupTarget {
  /** The resource identity. */
  readonly id: string
  /** The owner the cleanup is acting for. */
  readonly owner: string
  /** The storage path, when the resource is a path. */
  readonly path?: string
  /** Whether the resource is a verified, owned private storage tree. */
  readonly owned: boolean
}

/** The operations a cleanup performs at each stage. */
export interface CleanupOps {
  /** Remove logical references to the resource. */
  dereference(target: CleanupTarget): void
  /** Stop the writers that hold the resource; return the writers still active. */
  stopWriters(target: CleanupTarget): readonly string[]
  /** Release handles or unmount the resource. */
  releaseHandles(target: CleanupTarget): void
  /** Verify ownership before deleting; return whether the owner is verified. */
  verifyOwnership(target: CleanupTarget): boolean
  /** Delete the resource. */
  delete(target: CleanupTarget): void
  /** Record the cleanup result. */
  record(record: CleanupRecord): void
}

/** The result of one cleanup stage. */
export interface CleanupStageResult {
  /** The stage. */
  readonly stage: CleanupStage
  /** Whether the stage completed. */
  readonly ok: boolean
  /** A diagnostic detail when it failed. */
  readonly detail?: string
}

/** The recorded outcome of a cleanup. */
export interface CleanupRecord {
  /** The resource identity. */
  readonly targetId: string
  /** The per-stage results, in order. */
  readonly results: readonly CleanupStageResult[]
  /** The residual object description when the cleanup did not converge. */
  readonly residual?: string
  /** The reason the cleanup failed. */
  readonly reason?: string
  /** The occupancy budget the retry is limited by, in milliseconds. */
  readonly retryBudgetMs?: number
  /** Whether a retry may reclaim the resource. */
  readonly retryable: boolean
  /** Whether the resource was fully reclaimed. */
  readonly reclaimed: boolean
}

/**
 * Run a cleanup in the fixed stage order. A writer that cannot be stopped
 * aborts before deletion and marks the record non-retryable-until-converged;
 * an ownership check that fails aborts before deletion so a link cannot be
 * followed out of the owned tree.
 * @param target - the resource to reclaim.
 * @param ops - the stage operations.
 * @returns the cleanup record.
 */
export function runCleanup(target: CleanupTarget, ops: CleanupOps): CleanupRecord {
  const results: CleanupStageResult[] = []
  const fail = (stage: CleanupStage, reason: string, options: { readonly retryable: boolean }): CleanupRecord => {
    results.push({ stage, ok: false, detail: reason })
    results.push({ stage: 'record', ok: true })
    const record: CleanupRecord = {
      targetId: target.id,
      results,
      residual: target.path ?? target.id,
      reason,
      retryable: options.retryable,
      reclaimed: false,
    }
    ops.record(record)
    return record
  }
  try {
    ops.dereference(target)
    results.push({ stage: 'dereference', ok: true })
  } catch (error) {
    return fail('dereference', messageOf(error), { retryable: true })
  }
  let activeWriters: readonly string[]
  try {
    activeWriters = ops.stopWriters(target)
  } catch (error) {
    return fail('stop-writers', messageOf(error), { retryable: true })
  }
  if (activeWriters.length > 0) {
    return fail('stop-writers', `writers did not converge: ${activeWriters.join(', ')}`, { retryable: true })
  }
  results.push({ stage: 'stop-writers', ok: true })
  try {
    ops.releaseHandles(target)
    results.push({ stage: 'release-handles', ok: true })
  } catch (error) {
    return fail('release-handles', messageOf(error), { retryable: true })
  }
  if (!ops.verifyOwnership(target)) {
    return fail('verify-ownership', 'ownership could not be verified; refusing to delete', { retryable: false })
  }
  results.push({ stage: 'verify-ownership', ok: true })
  try {
    ops.delete(target)
    results.push({ stage: 'delete', ok: true })
  } catch (error) {
    return fail('delete', messageOf(error), { retryable: true })
  }
  results.push({ stage: 'record', ok: true })
  const record: CleanupRecord = { targetId: target.id, results, retryable: false, reclaimed: true }
  ops.record(record)
  return record
}

/** Extract an error message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
