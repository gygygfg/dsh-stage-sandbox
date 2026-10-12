import { describe, expect, it } from 'vitest'
import { LeaseRegistry, type Clock } from '../../src/control/lease.ts'

class TestClock implements Clock {
  private value = 0
  now(): number { return this.value }
  advance(ms: number): void { this.value += ms }
}

describe('lease registry and fencing', () => {
  it('issues strictly increasing fencing tokens per resource', () => {
    const registry = new LeaseRegistry(new TestClock())
    const first = registry.acquire('workspace:/w', 'a', 1000)
    const second = registry.acquire('workspace:/w', 'b', 1000)
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
    expect(registry.currentFencingToken('workspace:/w')).toBe(second.fencingToken)
  })

  it('invalidates an older token when a newer lease is issued', () => {
    const registry = new LeaseRegistry(new TestClock())
    const first = registry.acquire('workspace:/w', 'a', 1000)
    expect(registry.check(first)).toBe('valid')
    registry.acquire('workspace:/w', 'b', 1000)
    expect(registry.check(first)).toBe('stale')
  })

  it('reports expiry once the clock passes the deadline', () => {
    const clock = new TestClock()
    const registry = new LeaseRegistry(clock)
    const lease = registry.acquire('workspace:/w', 'a', 100)
    clock.advance(100)
    expect(registry.check(lease)).toBe('expired')
  })

  it('reports unknown for a released or forged lease', () => {
    const registry = new LeaseRegistry(new TestClock())
    const lease = registry.acquire('workspace:/w', 'a', 1000)
    registry.release(lease)
    expect(registry.check(lease)).toBe('unknown')
    expect(registry.check({ ...lease, fencingToken: 999 })).toBe('unknown')
  })
})
