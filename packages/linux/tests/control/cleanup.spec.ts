import { describe, expect, it } from 'vitest'
import { runCleanup, type CleanupOps, type CleanupRecord, type CleanupTarget } from '../../src/control/cleanup.ts'

const target: CleanupTarget = { id: 'res-1', owner: 'session-1', path: '/tmp/res-1', owned: true }

function ops(overrides: Partial<CleanupOps> = {}): { ops: CleanupOps; records: CleanupRecord[] } {
  const records: CleanupRecord[] = []
  const base: CleanupOps = {
    dereference: () => {},
    stopWriters: () => [],
    releaseHandles: () => {},
    verifyOwnership: () => true,
    delete: () => {},
    record: record => { records.push(record) },
  }
  return { ops: { ...base, ...overrides }, records }
}

describe('cleanup closure', () => {
  it('reclaims in the fixed stage order', () => {
    const { ops: operations, records } = ops()
    const record = runCleanup(target, operations)
    expect(record.reclaimed).toBe(true)
    expect(record.results.map(result => result.stage)).toEqual(['dereference', 'stop-writers', 'release-handles', 'verify-ownership', 'delete', 'record'])
    expect(records).toHaveLength(1)
  })

  it('does not delete when a writer cannot converge', () => {
    let deleted = false
    const { ops: operations } = ops({ stopWriters: () => ['writer-a'], delete: () => { deleted = true } })
    const record = runCleanup(target, operations)
    expect(record.reclaimed).toBe(false)
    expect(record.retryable).toBe(true)
    expect(record.residual).toBe('/tmp/res-1')
    expect(deleted).toBe(false)
  })

  it('refuses deletion when ownership cannot be verified', () => {
    let deleted = false
    const { ops: operations } = ops({ verifyOwnership: () => false, delete: () => { deleted = true } })
    const record = runCleanup(target, operations)
    expect(record.reclaimed).toBe(false)
    expect(record.retryable).toBe(false)
    expect(deleted).toBe(false)
  })

  it('records the residual and reason when deletion fails', () => {
    const { ops: operations } = ops({ delete: () => { throw new Error('permission 0000') } })
    const record = runCleanup(target, operations)
    expect(record.reclaimed).toBe(false)
    expect(record.reason).toBe('permission 0000')
    expect(record.residual).toBe('/tmp/res-1')
  })
})
