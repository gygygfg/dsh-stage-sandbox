/**
 * Leases and fencing tokens for the control plane. Every writer that may
 * publish holds a lease whose fencing token strictly increases per resource;
 * the publisher checks the token at the write, so a stale executor cannot
 * publish after its lease expired even when the scheduler has moved on.
 * @module dsh-sandbox-linux/control/lease
 */

/** One held lease over a resource (a workspace or a publication target). */
export interface Lease {
  /** Stable lease identity. */
  readonly id: string
  /** The resource the lease guards (e.g. `workspace:<root>`). */
  readonly resource: string
  /** The owner holding the lease. */
  readonly owner: string
  /** The monotonic fencing token; a newer lease over the same resource is higher. */
  readonly fencingToken: number
  /** Epoch milliseconds after which the lease is no longer valid. */
  readonly expiresAt: number
}

/** How the registry reports a lease check. */
export type LeaseVerdict = 'valid' | 'expired' | 'stale' | 'unknown'

/** An injectable clock, so lease timing is testable. */
export interface Clock {
  /** The current epoch milliseconds. */
  now(): number
}

/** The default clock backed by `Date.now`. */
export const systemClock: Clock = { now: () => Date.now() }

/**
 * The in-process lease registry. It owns the monotonic fencing counter per
 * resource; a released or expired lease's token is never reused.
 */
export class LeaseRegistry {
  private readonly leases = new Map<string, Lease>()
  private readonly fencing = new Map<string, number>()
  private sequence = 0
  private readonly clock: Clock

  /**
   * @param clock - the clock used for expiry checks.
   */
  constructor(clock: Clock = systemClock) {
    this.clock = clock
  }

  /**
   * Acquire a lease over a resource, issuing the next fencing token.
   * @param resource - the guarded resource identity.
   * @param owner - the acquiring owner.
   * @param ttlMs - the lease lifetime in milliseconds.
   * @returns the new lease.
   */
  acquire(resource: string, owner: string, ttlMs: number): Lease {
    const fencingToken = (this.fencing.get(resource) ?? 0) + 1
    this.fencing.set(resource, fencingToken)
    const lease: Lease = {
      id: `lease_${++this.sequence}`,
      resource,
      owner,
      fencingToken,
      expiresAt: this.clock.now() + ttlMs,
    }
    this.leases.set(lease.id, lease)
    return lease
  }

  /**
   * Check whether a lease still authorizes its owner to write.
   * @param lease - the lease to check.
   * @returns `valid` when live and current; `expired`, `stale`, or `unknown` otherwise.
   */
  check(lease: Lease): LeaseVerdict {
    const held = this.leases.get(lease.id)
    if (held === undefined || held.fencingToken !== lease.fencingToken) return 'unknown'
    if (this.clock.now() >= held.expiresAt) return 'expired'
    if ((this.fencing.get(held.resource) ?? 0) !== held.fencingToken) return 'stale'
    return 'valid'
  }

  /**
   * Release a lease. The fencing token stays consumed.
   * @param lease - the lease to release.
   */
  release(lease: Lease): void {
    this.leases.delete(lease.id)
  }

  /**
   * The current fencing token for a resource.
   * @param resource - the resource identity.
   * @returns the highest issued token, or `0` when none was ever issued.
   */
  currentFencingToken(resource: string): number {
    return this.fencing.get(resource) ?? 0
  }
}
