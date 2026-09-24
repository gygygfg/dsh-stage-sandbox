import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CandidateWorkspace } from '../../src/candidate/workspace.ts'
import type { CandidateScope } from '../../src/control/records.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

describe('candidate workspace overlay', () => {
  let base: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'dsh-base-'))
    mkdirSync(join(base, 'src'))
    writeFileSync(join(base, 'src', 'a.txt'), 'original')
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('does not touch the real workspace until frozen and applied', () => {
    const workspace = new CandidateWorkspace({ baseRoot: base, scope: SCOPE })
    workspace.materialize()
    workspace.writeText(join(base, 'src', 'a.txt'), 'staged')
    workspace.writeText(join(base, 'src', 'b.txt'), 'new')

    expect(readFileSync(join(base, 'src', 'a.txt'), 'utf8')).toBe('original')
    expect(existsSync(join(base, 'src', 'b.txt'))).toBe(false)
    expect(workspace.readText(join(base, 'src', 'a.txt'))).toBe('staged')
    expect(workspace.changes().map(change => `${change.kind}:${change.path}`).sort()).toEqual(['create:src/b.txt', 'write:src/a.txt'])
    workspace.dispose()
  })

  it('freezes a candidate whose base version matches the untouched workspace', () => {
    const workspace = new CandidateWorkspace({ baseRoot: base, scope: SCOPE })
    workspace.materialize()
    workspace.writeText(join(base, 'src', 'a.txt'), 'staged')
    const { candidate, impact } = workspace.freeze()
    expect(candidate.digest).toMatch(/^sha256:/)
    expect(candidate.baseVersion).toMatch(/^sha256:/)
    expect(impact).toHaveLength(1)
    workspace.dispose()
  })

  it('maps paths outside the base root to undefined', () => {
    const workspace = new CandidateWorkspace({ baseRoot: base, scope: SCOPE })
    expect(workspace.pathFor('/etc/passwd')).toBeUndefined()
    expect(workspace.pathFor(join(base, 'src', 'a.txt'))).toBe(join(workspace.root, 'src', 'a.txt'))
    workspace.dispose()
  })
})
