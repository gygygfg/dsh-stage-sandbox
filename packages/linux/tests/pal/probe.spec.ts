import { describe, expect, it } from 'vitest'
import { environmentFingerprint, fingerprintKey, ProbeCache, validateExecution, type ExecutionProbe } from '../../src/pal/probe.ts'

describe('actual-execution capability probe', () => {
  it('exercises every required operation against the deployment', () => {
    const validation = validateExecution()
    const operations = validation.operations.map(entry => entry.operation)
    expect(operations).toEqual(['create', 'read', 'modify', 'directory-change', 'candidate-capture', 'delete', 'cleanup'])
    expect(validation.ok).toBe(true)
  })

  it('records a failed operation instead of aborting the whole validation', () => {
    const failing: ExecutionProbe = {
      create: () => { throw new Error('create denied') },
      read: () => '',
      modify: () => {},
      remove: () => {},
      directoryChange: () => {},
      capture: () => 'x',
      cleanup: () => {},
    }
    const validation = validateExecution({ probe: failing })
    expect(validation.ok).toBe(false)
    const create = validation.operations.find(entry => entry.operation === 'create')
    expect(create).toMatchObject({ ok: false, detail: 'create denied' })
    // The remaining operations were still attempted.
    expect(validation.operations.some(entry => entry.operation === 'cleanup')).toBe(true)
  })

  it('keys the cache by environment fingerprint', () => {
    const environment = environmentFingerprint({ fsType: 'testfs' })
    const key = fingerprintKey(environment)
    const cache = new ProbeCache()
    const validation = validateExecution({ environment })
    cache.set(key, validation)
    expect(cache.get(key)).toBe(validation)
    expect(cache.get(fingerprintKey(environmentFingerprint({ fsType: 'otherfs' })))).toBeUndefined()
    cache.clear()
    expect(cache.get(key)).toBeUndefined()
  })
})
