import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectoryPublicationBackend } from '../../src/publish/directory-backend.ts'
import { Publisher } from '../../src/publish/publisher.ts'
import { FileReceiptStore } from '../../src/publish/receipt-store.ts'
import { LeaseRegistry } from '../../src/control/lease.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { scanTree } from '../../src/candidate/manifest.ts'
import type { CandidateScope } from '../../src/control/records.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

describe('durable publication receipts', () => {
  let root: string
  let stateDir: string
  let backend: DirectoryPublicationBackend

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-receipt-'))
    stateDir = join(root, 'state')
    backend = new DirectoryPublicationBackend()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('stays idempotent by operation id across a publisher restart', async () => {
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'a.txt'), 'old')
    const base = await backend.currentVersion(target)
    const candidatePath = mkdtempSync(join(tmpdir(), 'dsh-receipt-cand-'))
    writeFileSync(join(candidatePath, 'a.txt'), 'new')
    const candidate = freezeCandidate({ path: candidatePath, baseVersion: base, scope: SCOPE, entries: scanTree(candidatePath), now: 1 })

    const leases = new LeaseRegistry()
    const first = new Publisher(backend, leases, undefined, new FileReceiptStore(stateDir))
    const lease = leases.acquire(`workspace:${target}`, 'op1', 1000)
    const published = await first.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })
    expect(published.kind).toBe('published')

    // A fresh publisher over the same state directory must return the recorded
    // receipt instead of re-applying (the target no longer matches the base).
    writeFileSync(join(target, 'a.txt'), 'post-publish edit')
    const second = new Publisher(backend, leases, undefined, new FileReceiptStore(stateDir))
    const replay = await second.publish({ operationId: 'op1', candidate, expectedBase: base, target, lease })
    expect(replay.kind).toBe('published')
    if (published.kind === 'published' && replay.kind === 'published') {
      expect(replay.receipt).toEqual(published.receipt)
    }
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('post-publish edit')
  })
})
