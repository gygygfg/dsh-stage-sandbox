import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileEvidenceStore, MemoryEvidenceStore, redactEvidence } from '../../src/evidence/store.ts'

describe('evidence redaction', () => {
  it('masks secret keys and high-entropy strings', () => {
    const redacted = redactEvidence({ token: 'abc', nested: { password: 'p' }, note: 'hello' }) as Record<string, unknown>
    expect(redacted.token).toBe('[redacted]')
    expect((redacted.nested as Record<string, unknown>).password).toBe('[redacted]')
    expect(redacted.note).toBe('hello')
    expect(redactEvidence('AKIAIOSFODNN7EXAMPLE0123456789')).toBe('[redacted]')
  })
})

describe('evidence stores', () => {
  it('stores and pages records in memory', () => {
    const store = new MemoryEvidenceStore()
    const first = store.add('fs', { path: 'a.txt', action: 'write' })
    store.add('process', { exitCode: 0 })
    expect(store.get(first)?.kind).toBe('fs')
    expect(store.page(1, 10)).toHaveLength(1)
    expect(store.list()).toHaveLength(2)
  })

  it('persists records across a file-store restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-evidence-'))
    try {
      const first = new FileEvidenceStore(dir)
      const id = first.add('policy', { decision: 'ALLOW', token: 'secret-value' })
      const reloaded = new FileEvidenceStore(dir)
      const record = reloaded.get(id)
      expect(record?.kind).toBe('policy')
      expect(record?.data.decision).toBe('ALLOW')
      expect(record?.data.token).toBe('[redacted]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
