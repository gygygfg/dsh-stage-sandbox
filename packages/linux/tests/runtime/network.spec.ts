import { describe, expect, it } from 'vitest'
import { networkArgs, networkEnforced, networkIsolated } from '../../src/runtime/network.ts'

describe('network mode mapping', () => {
  it('isolates egress only for OFFLINE and CONTROLLED_ONLINE', () => {
    expect(networkIsolated('OFFLINE')).toBe(true)
    expect(networkIsolated('CONTROLLED_ONLINE')).toBe(true)
    expect(networkIsolated('OBSERVED_ONLINE')).toBe(false)
  })

  it('emits --unshare-net exactly when isolated', () => {
    expect(networkArgs('OFFLINE')).toEqual(['--unshare-net'])
    expect(networkArgs('CONTROLLED_ONLINE')).toEqual(['--unshare-net'])
    expect(networkArgs('OBSERVED_ONLINE')).toEqual([])
  })

  it('reports kernel enforcement only when isolated', () => {
    expect(networkEnforced('OFFLINE')).toBe(true)
    expect(networkEnforced('CONTROLLED_ONLINE')).toBe(true)
    expect(networkEnforced('OBSERVED_ONLINE')).toBe(false)
  })
})
