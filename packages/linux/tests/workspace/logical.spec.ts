import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogicalWorkspace } from '../../src/workspace/logical.ts'
import type { CandidateScope } from '../../src/control/records.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

describe('unified logical workspace', () => {
  let base: string
  let logical: LogicalWorkspace

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'dsh-logical-base-'))
    mkdirSync(join(base, 'src'))
    writeFileSync(join(base, 'src', 'a.txt'), 'original')
    writeFileSync(join(base, 'src', 'keep.txt'), 'keep')
    logical = new LogicalWorkspace({ baseRoot: base, scope: SCOPE })
  })

  afterEach(() => {
    logical.dispose()
    rmSync(base, { recursive: true, force: true })
  })

  it('does not resurrect a deleted file from the real disk', () => {
    logical.materialize()
    logical.remove(join(base, 'src', 'a.txt'))
    expect(readFileSync(join(base, 'src', 'a.txt'), 'utf8')).toBe('original')
    expect(logical.readText(join(base, 'src', 'a.txt'))).toBeUndefined()
    expect(logical.stateOf(join(base, 'src', 'a.txt'))?.kind).toBe('deleted')
    const read = logical.read(join(base, 'src', 'a.txt'))
    expect(read.kind).toBe('absent')
  })

  it('reports corruption when a staged object is missing from staging storage', () => {
    logical.materialize()
    logical.writeText(join(base, 'src', 'a.txt'), 'staged')
    // Simulate a lost staged object without a deletion marker.
    rmSync(join(logical.stagingRoot, 'src', 'a.txt'))
    const state = logical.stateOf(join(base, 'src', 'a.txt'))
    expect(state?.kind).toBe('corrupted')
    const read = logical.read(join(base, 'src', 'a.txt'))
    expect(read.kind).toBe('corrupted')
    const integrity = logical.integrity()
    expect(integrity.ok).toBe(false)
    expect(integrity.corrupted.map(record => record.relative)).toContain('src/a.txt')
  })

  it('reads untouched base files through the base fallback without staging them', () => {
    logical.materialize()
    expect(logical.readText(join(base, 'src', 'keep.txt'))).toBe('keep')
    expect(existsSync(join(logical.stagingRoot, 'src', 'keep.txt'))).toBe(false)
    // The full manifest still lists the base files.
    expect(logical.entries().map(entry => entry.path)).toContain('src/keep.txt')
  })

  it('merges baseline and staged directory children', () => {
    logical.materialize()
    logical.writeText(join(base, 'src', 'b.txt'), 'new')
    const names = logical.list(join(base, 'src')).map(entry => entry.name)
    expect(names).toEqual(['a.txt', 'b.txt', 'keep.txt'])
    logical.remove(join(base, 'src', 'keep.txt'))
    expect(logical.list(join(base, 'src')).map(entry => entry.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('supports directory creation, recursive delete, and rename', () => {
    logical.materialize()
    logical.mkdir(join(base, 'src', 'nested', 'deep'))
    expect(logical.stateOf(join(base, 'src', 'nested', 'deep'))?.kind).toBe('staged-directory')

    logical.writeText(join(base, 'src', 'nested', 'deep', 'x.txt'), 'x')
    logical.rename(join(base, 'src', 'nested'), join(base, 'src', 'moved'))
    expect(logical.readText(join(base, 'src', 'moved', 'deep', 'x.txt'))).toBe('x')
    expect(logical.stateOf(join(base, 'src', 'nested'))?.kind).toBe('deleted')

    logical.remove(join(base, 'src', 'moved'), { recursive: true })
    expect(logical.readText(join(base, 'src', 'moved', 'deep', 'x.txt'))).toBeUndefined()
  })

  it('replaces a file with a directory and back without ghost objects', () => {
    logical.materialize()
    logical.replaceType(join(base, 'src', 'a.txt'), 'directory')
    expect(logical.stateOf(join(base, 'src', 'a.txt'))?.kind).toBe('staged-directory')
    logical.replaceType(join(base, 'src', 'a.txt'), 'file')
    expect(logical.stateOf(join(base, 'src', 'a.txt'))?.kind).toBe('staged-file')
    expect(logical.readText(join(base, 'src', 'a.txt'))).toBe('')
  })

  it('maps an already-staged path to itself (idempotent)', () => {
    logical.materialize()
    const staged = logical.pathFor(join(base, 'src', 'a.txt'))
    expect(staged).toBeDefined()
    expect(logical.pathFor(staged as string)).toBe(staged)
    expect(logical.realPathFor(staged as string)).toBe(join(base, 'src', 'a.txt'))
  })

  it('revision digest changes only when the logical view changes', () => {
    logical.materialize()
    const initial = logical.revisionDigest()
    expect(logical.revisionDigest()).toBe(initial)
    logical.writeText(join(base, 'src', 'a.txt'), 'changed')
    expect(logical.revisionDigest()).not.toBe(initial)
  })

  it('reports distinct results for empty directory, missing object, and no match', () => {
    logical.materialize()
    logical.mkdir(join(base, 'empty'))
    const listing = logical.read(join(base, 'empty'))
    expect(listing.kind).toBe('directory')
    if (listing.kind === 'directory') expect(listing.entries).toEqual([])
    expect(logical.read(join(base, 'nope.txt')).kind).toBe('absent')
  })

  it('mirrors the staging delta and deletions for a materialize inbox', () => {
    logical.materialize()
    logical.writeText(join(base, 'src', 'b.txt'), 'new')
    const inbox = mkdtempSync(join(tmpdir(), 'dsh-inbox-'))
    try {
      expect(logical.exportDelta(inbox)).toEqual([])
      expect(readFileSync(join(inbox, 'src', 'b.txt'), 'utf8')).toBe('new')
      logical.remove(join(base, 'src', 'a.txt'))
      expect(logical.exportDelta(inbox)).toContain('src/a.txt')
      expect(existsSync(join(inbox, 'src', 'a.txt'))).toBe(false)
    } finally {
      rmSync(inbox, { recursive: true, force: true })
    }
  })

  it('keeps a symlink from being followed into the manifest', () => {
    const external = join(base, '..', `dsh-outside-${Date.now()}.txt`)
    writeFileSync(external, 'secret')
    try {
      symlinkSync(external, join(base, 'src', 'link'))
      const entries = logical.entries()
      const link = entries.find(entry => entry.path === 'src/link')
      expect(link?.kind).toBe('symlink')
      expect(link?.digest).toBeUndefined()
    } finally {
      rmSync(external, { force: true })
    }
  })
})
