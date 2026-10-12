import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryPublicationBackend } from '../../src/publish/directory-backend.ts'
import { Publisher } from '../../src/publish/publisher.ts'
import { LeaseRegistry, type Clock } from '../../src/control/lease.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { scanTree } from '../../src/candidate/manifest.ts'
import type { CandidateRef, CandidateScope } from '../../src/control/records.ts'

class TestClock implements Clock {
  private value = 0
  now(): number { return this.value }
  advance(ms: number): void { this.value += ms }
}

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

describe('CAS publisher', () => {
  let root: string
  let backend: DirectoryPublicationBackend

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-pub-'))
    backend = new DirectoryPublicationBackend()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function stageTree(files: Record<string, string>): { path: string; candidate: CandidateRef } {
    const path = mkdtempSync(join(tmpdir(), 'dsh-cand-'))
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(path, name, '..'), { recursive: true })
      writeFileSync(join(path, name), content)
    }
    const candidate = freezeCandidate({ path, baseVersion: 'base', scope: SCOPE, entries: scanTree(path), now: 1 })
    return { path, candidate }
  }

  it('publishes a candidate when the base still matches and writes the content', async () => {
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'old')
    const base = await backend.currentVersion(target)
    const { candidate } = stageTree({ 'a.txt': 'new', 'b.txt': 'added' })

    const leases = new LeaseRegistry(new TestClock())
    const publisher = new Publisher(backend, leases, new TestClock())
    const lease = leases.acquire(`workspace:${target}`, 'op1', 1000)
    const outcome = await publisher.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })

    expect(outcome.kind).toBe('published')
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('new')
    expect(readFileSync(join(target, 'b.txt'), 'utf8')).toBe('added')
    if (outcome.kind === 'published') {
      expect(outcome.receipt.candidateDigest).toBe(candidate.digest)
      expect(outcome.receipt.oldVersion).toBe(base)
    }
  })

  it('refuses with a conflict when the target moved past the expected base', async () => {
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'old')
    const base = await backend.currentVersion(target)
    writeFileSync(join(target, 'a.txt'), 'someone else changed this')
    const { candidate } = stageTree({ 'a.txt': 'new' })

    const leases = new LeaseRegistry(new TestClock())
    const publisher = new Publisher(backend, leases, new TestClock())
    const lease = leases.acquire(`workspace:${target}`, 'op1', 1000)
    const outcome = await publisher.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })

    expect(outcome.kind).toBe('conflict')
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('someone else changed this')
  })

  it('is idempotent by operation id', async () => {
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'old')
    const base = await backend.currentVersion(target)
    const { candidate } = stageTree({ 'a.txt': 'new' })

    const leases = new LeaseRegistry(new TestClock())
    const publisher = new Publisher(backend, leases, new TestClock())
    const lease = leases.acquire(`workspace:${target}`, 'op1', 1000)
    const first = await publisher.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })
    // Mutate the target; a replay must not re-apply and must not conflict.
    writeFileSync(join(target, 'a.txt'), 'post-publish edit')
    const second = await publisher.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })

    expect(first.kind).toBe('published')
    expect(second.kind).toBe('published')
    if (first.kind === 'published' && second.kind === 'published') {
      expect(second.receipt).toEqual(first.receipt)
    }
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('post-publish edit')
  })

  it('refuses to publish under a stale lease', async () => {
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'unchanged')
    const base = await backend.currentVersion(target)
    const { candidate } = stageTree({ 'a.txt': 'new' })

    const clock = new TestClock()
    const leases = new LeaseRegistry(clock)
    const publisher = new Publisher(backend, leases, clock)
    const lease = leases.acquire(`workspace:${target}`, 'op1', 10)
    clock.advance(10)
    const outcome = await publisher.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })

    expect(outcome.kind).toBe('stale-lease')
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('unchanged')
  })
})
