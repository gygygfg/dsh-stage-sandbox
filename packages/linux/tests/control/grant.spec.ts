import { describe, expect, it } from 'vitest'
import { GrantRegistry } from '../../src/control/grant.ts'
import type { Clock } from '../../src/control/lease.ts'

class TestClock implements Clock {
  private value = 0
  now(): number { return this.value }
  advance(ms: number): void { this.value += ms }
}

describe('narrow task grants', () => {
  it('covers an operation inside its scope and consumes the file budget', () => {
    const grants = new GrantRegistry()
    const grant = grants.issue({ taskId: 't', roots: ['/ws'], operations: ['apply'], fileBudget: 2, ttlMs: 1000 })
    const first = grants.findCovering({ root: '/ws/src', operation: 'apply', fileCount: 1 })
    expect(first?.id).toBe(grant.id)
    grants.consume(grant.id, 2)
    expect(grants.findCovering({ root: '/ws', operation: 'apply', fileCount: 1 })).toBeUndefined()
  })

  it('respects operation, scope, and expiry', () => {
    const clock = new TestClock()
    const grants = new GrantRegistry(clock)
    const grant = grants.issue({ taskId: 't', roots: ['/ws'], operations: ['apply'], ttlMs: 10 })
    expect(grants.findCovering({ root: '/ws', operation: 'reject', fileCount: 1 })).toBeUndefined()
    expect(grants.findCovering({ root: '/elsewhere', operation: 'apply', fileCount: 1 })).toBeUndefined()
    clock.advance(10)
    expect(grants.findCovering({ root: '/ws', operation: 'apply', fileCount: 1 })).toBeUndefined()
    expect(grants.list()).toHaveLength(1)
    grants.revoke(grant.id)
    expect(grants.list()).toHaveLength(0)
  })
})
