import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectoryPublicationBackend, applyRank } from '../../src/publish/directory-backend.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { scanTree } from '../../src/candidate/manifest.ts'
import type { CandidateScope } from '../../src/control/records.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }
const roots: string[] = []
const temp = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('git atomic apply ordering', () => {
  it('ranks objects before normal files before pointers', () => {
    expect(applyRank('.git/objects/ab/cdef')).toBe(0)
    expect(applyRank('src/a.txt')).toBe(1)
    expect(applyRank('.git/config')).toBe(1)
    expect(applyRank('.git/index')).toBe(2)
    expect(applyRank('.git/HEAD')).toBe(2)
    expect(applyRank('.git/refs/heads/main')).toBe(2)
  })

  it('publishes git objects and pointers together', async () => {
    const target = temp('dsh-git-target-')
    const candidatePath = temp('dsh-git-cand-')
    mkdirSync(join(candidatePath, '.git', 'objects', 'ab'), { recursive: true })
    mkdirSync(join(candidatePath, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(candidatePath, '.git', 'objects', 'ab', 'cdef'), 'blob')
    writeFileSync(join(candidatePath, '.git', 'index'), 'index')
    writeFileSync(join(candidatePath, '.git', 'refs', 'heads', 'main'), 'cdef')

    const backend = new DirectoryPublicationBackend()
    const candidate = freezeCandidate({ path: candidatePath, baseVersion: await backend.currentVersion(target), scope: SCOPE, entries: scanTree(candidatePath) })
    await backend.apply({ target, candidate, expectedBase: candidate.baseVersion })

    expect(readFileSync(join(target, '.git', 'objects', 'ab', 'cdef'), 'utf8')).toBe('blob')
    expect(existsSync(join(target, '.git', 'index'))).toBe(true)
    expect(readFileSync(join(target, '.git', 'refs', 'heads', 'main'), 'utf8')).toBe('cdef')
  })
})
