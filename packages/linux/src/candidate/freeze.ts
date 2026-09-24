/**
 * Candidate freezing: turn a staged tree's manifest into an immutable
 * candidate reference. Freezing is the moment a candidate stops being
 * writable; the reference carries the digest an approval and a publication
 * bind to.
 * @module dsh-sandbox-linux/candidate/freeze
 */

import type { CandidateRef, CandidateScope } from '../control/records.ts'
import { digestOf } from '../util/canonical.ts'
import { manifestDigest, type ManifestEntry } from './manifest.ts'

/** The inputs to freezing one candidate. */
export interface FreezeInput {
  /** The sandbox-private directory holding the frozen tree. */
  readonly path: string
  /** The base version the candidate was generated against. */
  readonly baseVersion: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  /** The staged tree's manifest. */
  readonly entries: readonly ManifestEntry[]
  /** Epoch milliseconds of freezing; defaults to `Date.now()`. */
  readonly now?: number
}

/**
 * Freeze a staged tree into a candidate reference. The candidate digest covers
 * the base version, the manifest, and the scope, so a change to any of them
 * produces a different candidate that an old approval cannot authorize.
 * @param input - the freeze inputs.
 * @returns the frozen candidate reference.
 */
export function freezeCandidate(input: FreezeInput): CandidateRef {
  const manifest = manifestDigest(input.entries)
  const digest = digestOf({ baseVersion: input.baseVersion, manifest, scope: input.scope })
  return {
    digest,
    baseVersion: input.baseVersion,
    manifestDigest: manifest,
    entries: input.entries,
    path: input.path,
    scope: input.scope,
    createdAt: input.now ?? Date.now(),
  }
}
