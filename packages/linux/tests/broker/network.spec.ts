import { describe, expect, it } from 'vitest'
import { NetworkGateway } from '../../src/broker/network.ts'
import type { Clock } from '../../src/control/lease.ts'

class TestClock implements Clock {
  private value = 0
  now(): number { return this.value }
  advance(ms: number): void { this.value += ms }
}

const endpoint = { host: 'api.example.com', port: 443, protocol: 'tcp' as const, direction: 'egress' as const }

describe('network gateway', () => {
  it('denies by default', () => {
    const gateway = new NetworkGateway()
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
  })

  it('allows a granted endpoint and meters bytes', () => {
    const gateway = new NetworkGateway()
    const grant = gateway.grant({ endpoints: [endpoint], txBudgetBytes: 100, rxBudgetBytes: 100, ttlMs: 1000 })
    expect(gateway.authorize({ endpoint, txBytes: 10, rxBytes: 10 })).toEqual({ kind: 'allow', grantId: grant.id })
    const accounting = gateway.account(grant.id, 10, 10)
    expect(accounting.txRemaining).toBe(90)
  })

  it('denies when the transmit budget would be exceeded', () => {
    const gateway = new NetworkGateway()
    const grant = gateway.grant({ endpoints: [endpoint], txBudgetBytes: 50, ttlMs: 1000 })
    gateway.account(grant.id, 50, 0)
    expect(gateway.authorize({ endpoint, txBytes: 1, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
  })

  it('denies after expiry and after revocation', () => {
    const clock = new TestClock()
    const gateway = new NetworkGateway(clock)
    const expired = gateway.grant({ endpoints: [endpoint], ttlMs: 10 })
    clock.advance(10)
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })

    const live = gateway.grant({ endpoints: [endpoint], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toEqual({ kind: 'allow', grantId: live.id })
    gateway.revoke(live.id)
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
    expect(expired.id).not.toBe(live.id)
  })

  it('does not match a different port or protocol', () => {
    const gateway = new NetworkGateway()
    gateway.grant({ endpoints: [endpoint], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint: { ...endpoint, port: 80 }, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
    expect(gateway.authorize({ endpoint: { ...endpoint, protocol: 'udp' }, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
  })

  it('OFFLINE blocks egress even with a matching grant', () => {
    const gateway = new NetworkGateway('OFFLINE')
    gateway.grant({ endpoints: [endpoint], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
    expect(gateway.guarantee().forcesEgress).toBe(true)
  })

  it('CONTROLLED_ONLINE rejects prohibited local and metadata targets', () => {
    const gateway = new NetworkGateway('CONTROLLED_ONLINE')
    gateway.grant({ endpoints: [{ host: '169.254.169.254', port: 80, protocol: 'tcp', direction: 'egress' }], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint: { host: '169.254.169.254', port: 80, protocol: 'tcp', direction: 'egress' }, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'deny' })
  })

  it('OBSERVED_ONLINE refuses a task that requires forced blocking', () => {
    const gateway = new NetworkGateway('OBSERVED_ONLINE')
    gateway.grant({ endpoints: [endpoint], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0, requiresForcedBlock: true })).toMatchObject({ kind: 'deny' })
    expect(gateway.guarantee().forcesEgress).toBe(false)
  })

  it('revocation closes existing connections', () => {
    const gateway = new NetworkGateway()
    const grant = gateway.grant({ endpoints: [endpoint], ttlMs: 1000 })
    expect(gateway.authorize({ endpoint, txBytes: 0, rxBytes: 0 })).toMatchObject({ kind: 'allow' })
    const closed = gateway.revoke(grant.id)
    expect(closed).toHaveLength(1)
    expect(closed[0]?.grantId).toBe(grant.id)
  })
})
