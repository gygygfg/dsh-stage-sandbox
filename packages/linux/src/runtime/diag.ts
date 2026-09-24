/**
 * Diagnostics: fault injection and timing (v2.3 §16). Fault points let a test
 * force a failure at a named seam (capture, freeze, publish, persist) to prove
 * the recovery path; the benchmark helper reports the wall-clock cost of a
 * hot path without changing behavior.
 * @module dsh-sandbox-linux/runtime/diag
 */

/** The named fault seams the sandbox can fail at. */
export type FaultPoint = 'probe' | 'materialize' | 'capture' | 'freeze' | 'publish' | 'persist' | 'cleanup'

/** Thrown when a fault point that was armed is hit. */
export class FaultInjected extends Error {
  /** The fault point that fired. */
  readonly point: FaultPoint

  /**
   * @param point - the fault point that fired.
   */
  constructor(point: FaultPoint) {
    super(`fault injected at '${point}'`)
    this.name = 'FaultInjected'
    this.point = point
  }
}

/** One benchmark sample. */
export interface BenchSample {
  /** The label. */
  readonly label: string
  /** The elapsed milliseconds. */
  readonly ms: number
}

/**
 * The fault injector. `arm` schedules a fault for the next `times` hits at a
 * point; `hit` throws when one is due and otherwise returns.
 */
export class FaultInjector {
  private readonly armed = new Map<FaultPoint, number>()

  /**
   * Arm a fault point.
   * @param point - the seam to fail at.
   * @param times - how many hits fire before disarming; defaults to 1.
   */
  arm(point: FaultPoint, times = 1): void {
    this.armed.set(point, Math.max(0, times))
  }

  /**
   * Whether a fault point would fire on the next hit.
   * @param point - the seam to check.
   * @returns `true` when armed.
   */
  isArmed(point: FaultPoint): boolean {
    return (this.armed.get(point) ?? 0) > 0
  }

  /**
   * Hit a fault point. Throws when armed and decrements the count.
   * @param point - the seam being hit.
   */
  hit(point: FaultPoint): void {
    const remaining = this.armed.get(point) ?? 0
    if (remaining <= 0) return
    if (remaining === 1) this.armed.delete(point)
    else this.armed.set(point, remaining - 1)
    throw new FaultInjected(point)
  }

  /** Disarm every fault point. */
  reset(): void {
    this.armed.clear()
  }
}

/**
 * Time a synchronous operation.
 * @param label - the sample label.
 * @param fn - the operation.
 * @returns the operation's value and the elapsed sample.
 */
export function timeSync<T>(label: string, fn: () => T): { value: T; sample: BenchSample } {
  const start = performance.now()
  const value = fn()
  return { value, sample: { label, ms: performance.now() - start } }
}
