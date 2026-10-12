/**
 * Manifest diffing: turn two candidate manifests into the filesystem impact
 * records the control plane reports and the policy layer evaluates. Every
 * record cites the observation as `observed` with complete coverage for the
 * file category; a category the backend could not observe is reported
 * separately as missing rather than as an empty list.
 * @module dsh-sandbox-linux/candidate/diff
 */

import type { ManifestEntry } from './manifest.ts'
import type { FsImpact } from './impact.ts'

/** A stable identity for a manifest entry used for equality. */
function fingerprint(entry: ManifestEntry): string {
  return [entry.kind, entry.digest ?? '', entry.linkTarget ?? '', String(entry.mode ?? '')].join('|')
}

/**
 * Diff a base manifest against a staged manifest.
 * @param base - the manifest of the workspace before staging.
 * @param after - the manifest of the frozen candidate.
 * @param evidenceId - the evidence pointer recorded on every impact.
 * @returns the filesystem impact records, sorted by path.
 */
export function diffManifests(base: readonly ManifestEntry[], after: readonly ManifestEntry[], evidenceId: string): FsImpact[] {
  const before = new Map(base.map(entry => [entry.path, entry]))
  const now = new Map(after.map(entry => [entry.path, entry]))
  const impacts: FsImpact[] = []
  for (const [path, entry] of now) {
    const previous = before.get(path)
    if (previous === undefined) {
      impacts.push(impact('create', path, null, entry.digest ?? null, evidenceId))
      continue
    }
    if (fingerprint(previous) !== fingerprint(entry)) {
      const kind = (previous.digest ?? null) !== (entry.digest ?? null) ? 'write' : 'metadata'
      impacts.push(impact(kind, path, previous.digest ?? null, entry.digest ?? null, evidenceId))
    }
  }
  for (const [path, entry] of before) {
    if (!now.has(path)) impacts.push(impact('delete', path, entry.digest ?? null, null, evidenceId))
  }
  return impacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Build one observed filesystem impact. */
function impact(kind: FsImpact['kind'], path: string, beforeHash: string | null, afterHash: string | null, evidenceId: string): FsImpact {
  return { kind, path, beforeHash, afterHash, source: 'observed', coverage: 'complete', evidenceId }
}
