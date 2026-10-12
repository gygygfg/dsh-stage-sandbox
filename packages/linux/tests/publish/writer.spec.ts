import { describe, expect, it } from 'vitest'
import { isPermissionError, writeFileWithEscalation, type WriterDeps } from '../../src/publish/writer.ts'

const request = { path: '/etc/hosts', content: Buffer.from('x') }

describe('publication writer', () => {
  it('writes directly when allowed', () => {
    let written = 0
    const deps: WriterDeps = { write: () => { written += 1 } }
    expect(writeFileWithEscalation(request, { allowRoot: false }, deps)).toEqual({ kind: 'written' })
    expect(written).toBe(1)
  })

  it('reports needs-root on a permission error without approval', () => {
    const deps: WriterDeps = { write: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }) } }
    expect(writeFileWithEscalation(request, { allowRoot: false }, deps).kind).toBe('needs-root')
  })

  it('escalates to the privileged writer only when approved', () => {
    let root = 0
    const deps: WriterDeps = {
      write: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }) },
      rootWrite: () => { root += 1 },
    }
    expect(writeFileWithEscalation(request, { allowRoot: true }, deps)).toEqual({ kind: 'written' })
    expect(root).toBe(1)
    expect(writeFileWithEscalation(request, { allowRoot: false }, deps).kind).toBe('needs-root')
  })

  it('does not retry a non-permission failure', () => {
    let root = 0
    const deps: WriterDeps = {
      write: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
      rootWrite: () => { root += 1 },
    }
    expect(writeFileWithEscalation(request, { allowRoot: true }, deps).kind).toBe('failed')
    expect(root).toBe(0)
  })

  it('recognises permission error codes', () => {
    expect(isPermissionError(Object.assign(new Error(), { code: 'EROFS' }))).toBe(true)
    expect(isPermissionError(Object.assign(new Error(), { code: 'ENOENT' }))).toBe(false)
  })
})
