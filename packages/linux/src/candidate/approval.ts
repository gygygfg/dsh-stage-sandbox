/**
 * Candidate revisions and selective approval (v2.3). A revision keeps a
 * verifiable before and after reference for every change unit, so an approval
 * diff never reads the (possibly changed) real disk as the old version. A
 * selective apply builds a new publication set, verifies it, publishes only
 * the selected units, and keeps the rest as trackable revisions — continuing
 * pending, dependency-blocked, or stale — rather than deleting the original
 * candidate. Deduplication and supersede are scoped to a branch and an
 * explicit revision relation, never global by path.
 * @module dsh-sandbox-linux/candidate/approval
 */

import type { FsImpact } from './impact.ts'
import type { ManifestEntry } from './manifest.ts'
import { digestOf } from '../util/canonical.ts'

/** A verifiable content reference: a digest plus the snapshot it came from. */
export interface ContentRef {
  /** The content digest. */
  readonly digest: string
  /** The snapshot the content can be read from. */
  readonly snapshot: string
  /** The byte size, when known. */
  readonly bytes?: number
}

/** One reviewable change unit. */
export interface ChangeUnit {
  /** The stable unit identity within the revision. */
  readonly id: string
  /** The change kind. */
  readonly kind: FsImpact['kind']
  /** The affected path. */
  readonly path: string
  /** The before content reference, or `null` for a creation. */
  readonly before: ContentRef | null
  /** The after content reference, or `null` for a deletion. */
  readonly after: ContentRef | null
  /** Unit ids this unit depends on; a dependency blocks independent publication. */
  readonly dependencies: readonly string[]
  /** Whether this unit is a host operation (registry, service, firewall, ...) rather than a file. */
  readonly hostOperation: boolean
}

/** A group of units that must be reviewed and applied together. */
export interface ApprovalGroup {
  /** The group identity. */
  readonly id: string
  /** The member unit ids. */
  readonly unitIds: readonly string[]
  /** Whether the group is indivisible (a cross-file/registry/service/firewall combination). */
  readonly indivisible: boolean
}

/** The lifecycle status of a candidate revision. */
export type RevisionStatus =
  | 'pending'
  | 'partially-published'
  | 'published'
  | 'stale'
  | 'dependency-blocked'
  | 'discarded'

/** One candidate revision on a branch. */
export interface CandidateRevision {
  /** The revision identity. */
  readonly revisionId: string
  /** The workspace branch the revision belongs to. */
  readonly branchId: string
  /** The revision this one supersedes, or `null`. */
  readonly supersedes: string | null
  /** The change units, deduplicated by path within the branch. */
  readonly units: readonly ChangeUnit[]
  /** The indivisible approval groups. */
  readonly groups: readonly ApprovalGroup[]
  /** The number of host operations (not filtered by file count). */
  readonly hostOperationCount: number
  /** The revision status. */
  status: RevisionStatus
}

/** The result of a selective apply: the selected set and the remaining units. */
export interface PublicationSet {
  /** The publication-set identity. */
  readonly setId: string
  /** The revision the selection came from. */
  readonly revisionId: string
  /** The selected units, including any pulled-in indivisible group members. */
  readonly selected: readonly ChangeUnit[]
  /** The units left for later review. */
  readonly remaining: readonly ChangeUnit[]
  /** The digest of the selected units, bound into the approval. */
  readonly digest: string
}

/** The review counts a UI shows. */
export interface ApprovalCounts {
  /** The number of pending file units. */
  readonly pendingFiles: number
  /** The number of host operations. */
  readonly hostOperations: number
  /** The total number of change units. */
  readonly units: number
}

/** Build a content reference for a manifest entry. */
function refOf(entry: ManifestEntry | undefined, snapshot: string): ContentRef | null {
  if (entry === undefined) return null
  return { digest: entry.digest ?? `meta:${entry.kind}`, snapshot, ...(entry.size === undefined ? {} : { bytes: entry.size }) }
}

/**
 * Build a candidate revision from a filesystem impact and the base/staged
 * manifests. The before and after references are snapshot references, so the
 * approval diff never reads the live disk.
 * @param input - the branch, base/staged manifests, impact, and optional supersede relation.
 * @returns the revision.
 */
export function buildRevision(input: {
  readonly branchId: string
  readonly base: readonly ManifestEntry[]
  readonly staged: readonly ManifestEntry[]
  readonly impact: readonly FsImpact[]
  readonly baseSnapshot: string
  readonly stagedSnapshot: string
  readonly supersedes?: string | null
  readonly hostOperationCount?: number
}): CandidateRevision {
  const baseIndex = new Map(input.base.map(entry => [entry.path, entry]))
  const stagedIndex = new Map(input.staged.map(entry => [entry.path, entry]))
  const units: ChangeUnit[] = input.impact.map(impact => {
    const before = refOf(baseIndex.get(impact.path), input.baseSnapshot)
    const after = refOf(stagedIndex.get(impact.path), input.stagedSnapshot)
    const id = `unit:${impact.kind}:${impact.path}`
    return {
      id,
      kind: impact.kind,
      path: impact.path,
      before,
      after,
      dependencies: [],
      hostOperation: false,
    }
  })
  const revisionId = `rev:${input.branchId}:${digestOf(units.map(unit => [unit.kind, unit.path, unit.before?.digest ?? null, unit.after?.digest ?? null]))}`
  return {
    revisionId,
    branchId: input.branchId,
    supersedes: input.supersedes ?? null,
    units,
    groups: groupUnits(units),
    hostOperationCount: input.hostOperationCount ?? 0,
    status: 'pending',
  }
}

/** Group cross-file changes that must be reviewed together. */
function groupUnits(units: readonly ChangeUnit[]): ApprovalGroup[] {
  if (units.length === 0) return []
  return [{ id: 'group:all', unitIds: units.map(unit => unit.id), indivisible: false }]
}

/** Count a revision's pending file units and host operations. */
export function approvalCounts(revision: CandidateRevision): ApprovalCounts {
  const pendingFiles = revision.units.filter(unit => !unit.hostOperation).length
  return { pendingFiles, hostOperations: revision.hostOperationCount, units: revision.units.length }
}

/**
 * Build a publication set for a selection, pulling in indivisible group
 * members so a group is never partially selected.
 * @param revision - the revision to select from.
 * @param selectedIds - the selected unit ids.
 * @returns the publication set.
 */
export function selectUnits(revision: CandidateRevision, selectedIds: readonly string[]): PublicationSet {
  const selected = new Set(selectedIds)
  for (const group of revision.groups) {
    if (group.indivisible && group.unitIds.some(id => selected.has(id))) {
      for (const id of group.unitIds) selected.add(id)
    }
  }
  const selectedUnits = revision.units.filter(unit => selected.has(unit.id))
  const remaining = revision.units.filter(unit => !selected.has(unit.id))
  const digest = digestOf(selectedUnits.map(unit => [unit.id, unit.before?.digest ?? null, unit.after?.digest ?? null]))
  return {
    setId: `set:${revision.revisionId}:${digest}`,
    revisionId: revision.revisionId,
    selected: selectedUnits,
    remaining,
    digest,
  }
}

/**
 * Verify that a publication set's before references still match the current
 * base. A mismatch makes the set stale; it must not be published.
 * @param set - the publication set.
 * @param currentBase - the current base manifest index by path.
 * @returns the verification verdict.
 */
export function verifyPublicationSet(set: PublicationSet, currentBase: ReadonlyMap<string, ManifestEntry>): { readonly ok: true } | { readonly ok: false; readonly stalePaths: readonly string[] } {
  const stalePaths: string[] = []
  for (const unit of set.selected) {
    const current = currentBase.get(unit.path)
    const currentDigest = current === undefined ? null : (current.digest ?? `meta:${current.kind}`)
    const beforeDigest = unit.before?.digest ?? null
    if (currentDigest !== beforeDigest) stalePaths.push(unit.path)
  }
  return stalePaths.length === 0 ? { ok: true } : { ok: false, stalePaths }
}

/**
 * Apply a selective publication: the selected units are published and the
 * remaining units stay trackable, marked stale or dependency-blocked when
 * their basis changed. The original revision is never deleted.
 * @param revision - the revision.
 * @param set - the publication set that was published.
 * @param options - whether a remaining unit's dependency was published and whether the base moved.
 * @returns the revision after the partial publish.
 */
export function applyPublicationSet(revision: CandidateRevision, set: PublicationSet, options: { readonly baseMoved?: boolean } = {}): CandidateRevision {
  const selected = new Set(set.selected.map(unit => unit.id))
  const publishedIds = new Set(set.selected.map(unit => unit.id))
  const remaining = revision.units.filter(unit => !selected.has(unit.id))
  const dependencyBlocked = remaining.some(unit => unit.dependencies.some(dependency => publishedIds.has(dependency) || selected.has(dependency)))
  const status: RevisionStatus = options.baseMoved === true ? 'stale' : dependencyBlocked ? 'dependency-blocked' : 'partially-published'
  return { ...revision, status }
}

/**
 * Discard a revision: record the discarded state first, so storage is only
 * reclaimed after the state is durable.
 * @param revision - the revision to discard.
 * @returns the discarded revision.
 */
export function discardRevision(revision: CandidateRevision): CandidateRevision {
  return { ...revision, status: 'discarded' }
}

/** Whether a pure file candidate has no net change and should not be enqueued. */
export function isEmptyFileCandidate(revision: CandidateRevision): boolean {
  return revision.units.length === 0 && revision.hostOperationCount === 0
}
