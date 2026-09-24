import { describe, expect, it } from 'vitest'
import {
  applyPublicationSet,
  approvalCounts,
  buildRevision,
  discardRevision,
  isEmptyFileCandidate,
  selectUnits,
  verifyPublicationSet,
} from '../../src/candidate/approval.ts'
import type { FsImpact } from '../../src/candidate/impact.ts'
import type { ManifestEntry } from '../../src/candidate/manifest.ts'

const entry = (path: string, digest: string): ManifestEntry => ({ path, kind: 'file', digest })

const impact = (kind: FsImpact['kind'], path: string, before: string | null, after: string | null): FsImpact => ({
  kind,
  path,
  beforeHash: before,
  afterHash: after,
  source: 'observed',
  coverage: 'complete',
  evidenceId: 'evidence:test',
})

describe('candidate revisions and selective approval', () => {
  const base = [entry('a.txt', 'sha256:old-a'), entry('keep.txt', 'sha256:keep')]
  const staged = [entry('a.txt', 'sha256:new-a'), entry('keep.txt', 'sha256:keep'), entry('b.txt', 'sha256:new-b')]
  const changes = [impact('write', 'a.txt', 'sha256:old-a', 'sha256:new-a'), impact('create', 'b.txt', null, 'sha256:new-b')]

  it('builds verifiable before/after references from snapshots', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'snap:base', stagedSnapshot: 'snap:staged' })
    const unit = revision.units.find(candidate => candidate.path === 'a.txt')
    expect(unit?.before).toMatchObject({ digest: 'sha256:old-a', snapshot: 'snap:base' })
    expect(unit?.after).toMatchObject({ digest: 'sha256:new-a', snapshot: 'snap:staged' })
    expect(unit?.before?.digest).not.toBe(unit?.after?.digest)
  })

  it('counts pending files and host operations independently', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's', hostOperationCount: 2 })
    expect(approvalCounts(revision)).toEqual({ pendingFiles: 2, hostOperations: 2, units: 2 })
    expect(isEmptyFileCandidate(revision)).toBe(false)
  })

  it('does not enqueue a pure file candidate with no net change', () => {
    const revision = buildRevision({ branchId: 'main', base, staged: base, impact: [], baseSnapshot: 'b', stagedSnapshot: 's' })
    expect(isEmptyFileCandidate(revision)).toBe(true)
  })

  it('pulls indivisible group members into a selection', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's' })
    const grouped = { ...revision, groups: [{ id: 'group:x', unitIds: ['unit:write:a.txt', 'unit:create:b.txt'], indivisible: true }] }
    const set = selectUnits(grouped, ['unit:write:a.txt'])
    expect(set.selected.map(unit => unit.id).sort()).toEqual(['unit:create:b.txt', 'unit:write:a.txt'])
    expect(set.remaining).toHaveLength(0)
  })

  it('keeps unselected units trackable after a partial publish', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's' })
    const set = selectUnits(revision, ['unit:write:a.txt'])
    const after = applyPublicationSet(revision, set)
    expect(after.status).toBe('partially-published')
    expect(after.units).toHaveLength(2)
  })

  it('marks remaining units stale when the base moved', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's' })
    const set = selectUnits(revision, ['unit:write:a.txt'])
    expect(applyPublicationSet(revision, set, { baseMoved: true }).status).toBe('stale')
  })

  it('detects a stale publication set before publishing', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's' })
    const set = selectUnits(revision, ['unit:write:a.txt'])
    const moved = new Map([['a.txt', entry('a.txt', 'sha256:changed-by-someone-else')]])
    expect(verifyPublicationSet(set, moved)).toMatchObject({ ok: false, stalePaths: ['a.txt'] })
    const unchanged = new Map(base.map(item => [item.path, item]))
    expect(verifyPublicationSet(set, unchanged)).toEqual({ ok: true })
  })

  it('records a discard state before reclaiming storage', () => {
    const revision = buildRevision({ branchId: 'main', base, staged, impact: changes, baseSnapshot: 'b', stagedSnapshot: 's' })
    expect(discardRevision(revision).status).toBe('discarded')
  })
})
