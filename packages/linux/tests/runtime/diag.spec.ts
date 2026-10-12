import { describe, expect, it } from 'vitest'
import { FaultInjected, FaultInjector, timeSync } from '../../src/runtime/diag.ts'

describe('fault injection', () => {
  it('fires an armed point the requested number of times', () => {
    const injector = new FaultInjector()
    injector.arm('publish', 2)
    expect(injector.isArmed('publish')).toBe(true)
    expect(() => injector.hit('publish')).toThrow(FaultInjected)
    expect(() => injector.hit('publish')).toThrow(FaultInjected)
    expect(() => injector.hit('publish')).not.toThrow()
    expect(injector.isArmed('publish')).toBe(false)
  })

  it('does nothing for an unarmed point and resets', () => {
    const injector = new FaultInjector()
    expect(() => injector.hit('capture')).not.toThrow()
    injector.arm('capture')
    injector.reset()
    expect(() => injector.hit('capture')).not.toThrow()
  })
})

describe('benchmarking', () => {
  it('reports the value and a non-negative elapsed time', () => {
    const { value, sample } = timeSync('add', () => 1 + 1)
    expect(value).toBe(2)
    expect(sample.label).toBe('add')
    expect(sample.ms).toBeGreaterThanOrEqual(0)
  })
})
