/**
 * A filesystem publication backend: it applies a frozen candidate tree to a
 * target directory under CAS. The backend re-reads the target's manifest
 * immediately before writing and refuses when it no longer equals the expected
 * base, so a concurrently modified workspace is never overwritten.
 *
 * The apply is a per-entry synchronization, not a whole-tree atomic swap; the
 * control plane reports that honestly rather than claiming tree atomicity.
 * @module dsh-sandbox-linux/publish/directory-backend
 */

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CandidateRef } from '../control/records.ts'
import { digestFile, manifestDigest, scanTree, type ManifestEntry } from '../candidate/manifest.ts'
import { PublicationConflictError, type PublicationBackend } from './publisher.ts'
import { gitApplyRank, planGitPublication } from './git-control.ts'

/** Whether a path exists without following a final symlink. */
function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Remove a path that may be a symlink, a file, or a directory. A link is
 * unlinked (never followed); a directory is removed recursively.
 * @param path - the path to remove.
 */
function removePath(path: string): void {
  const stats = lstatSync(path)
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    for (const name of readdirSync(path)) removePath(join(path, name))
    // `rm` treats "is a directory" as an error (EISDIR) even when empty; a
    // directory has to be removed with rmdir once its children are gone.
    rmdirSync(path)
    return
  }
  unlinkSync(path)
}

/** The digest of a directory's manifest, or of the empty manifest when absent. */
function versionOf(root: string): string {
  return manifestDigest(existsSync(root) ? scanTree(root) : [])
}

/**
 * The order a desired entry is written in. Git's `.git` store is a coupled
 * database: an index/ref (a POINTER) references blobs in `objects/`, so
 * objects must exist first or a reader sees a dangling reference.
 * @param path - the POSIX-relative entry path.
 * @returns the apply rank (objects 0, ordinary 1, pointers 2).
 */
export function applyRank(path: string): number {
  return gitApplyRank(path)
}

/** Whether the target already satisfies one desired entry (content and mode). */
function entrySatisfied(target: string, entry: ManifestEntry): boolean {
  let stats
  try {
    stats = lstatSync(target)
  } catch {
    return false
  }
  if (entry.kind === 'directory') return stats.isDirectory()
  if (entry.kind === 'symlink') return stats.isSymbolicLink() && readlinkSync(target) === (entry.linkTarget ?? '')
  if (!stats.isFile()) return false
  if (entry.size !== undefined && stats.size !== entry.size) return false
  if (entry.digest !== undefined && digestFile(target) !== entry.digest) return false
  return true
}

/**
 * Synchronize `root` so its manifest equals `desired`, reading content from
 * `sourceRoot` only for entries the target does not already satisfy. This lets
 * `sourceRoot` be a delta (changed files only, as an overlay upper is): an
 * unchanged entry needs no content because the CAS base check proved the
 * target still matches the base it was diffed from.
 * @param root - the target directory.
 * @param sourceRoot - the frozen candidate content (full tree or delta).
 * @param desired - the desired manifest entries.
 * @param current - the target's manifest immediately before the sync.
 */
function syncTree(root: string, sourceRoot: string, desired: readonly ManifestEntry[], current: readonly ManifestEntry[]): void {
  mkdirSync(root, { recursive: true })
  const wanted = new Map(desired.map(entry => [entry.path, entry]))
  // Remove target entries not present in the desired manifest, deepest first.
  for (const entry of [...current].sort((a, b) => b.path.length - a.path.length)) {
    if (!wanted.has(entry.path)) removePath(join(root, entry.path))
  }
  // Write git objects before git pointers so a ref never dangles.
  const ordered = desired
    .map((entry, index) => ({ entry, index, rank: applyRank(entry.path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(item => item.entry)
  for (const entry of ordered) {
    const target = join(root, entry.path)
    if (entry.kind === 'directory') {
      if (lexists(target) && !lstatSync(target).isDirectory()) removePath(target)
      mkdirSync(target, { recursive: true })
      if (entry.mode !== undefined) chmodSync(target, entry.mode)
      continue
    }
    if (entry.kind === 'symlink') {
      if (entrySatisfied(target, entry)) continue
      if (lexists(target)) removePath(target)
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(entry.linkTarget ?? '', target)
      continue
    }
    if (entrySatisfied(target, entry)) {
      if (entry.mode !== undefined) chmodSync(target, entry.mode)
      continue
    }
    const source = join(sourceRoot, entry.path)
    if (!existsSync(source)) {
      throw new Error(`publication: candidate content for '${entry.path}' is missing from ${sourceRoot}`)
    }
    if (lexists(target)) removePath(target)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    if (entry.mode !== undefined) chmodSync(target, entry.mode)
  }
}

/**
 * The directory publication backend. The candidate's `path` is the frozen
 * source tree; the target is synchronized to it after the base check.
 */
export class DirectoryPublicationBackend implements PublicationBackend {
  /** @inheritdoc */
  async currentVersion(target: string): Promise<string> {
    return versionOf(target)
  }

  /** @inheritdoc */
  async apply(input: { target: string; candidate: CandidateRef; expectedBase: string }): Promise<{ newVersion: string }> {
    const currentEntries = existsSync(input.target) ? scanTree(input.target) : []
    const current = manifestDigest(currentEntries)
    if (current !== input.expectedBase) throw new PublicationConflictError(current)
    // The candidate carries the complete desired manifest; `path` may hold only
    // the changed content (a delta), which is sufficient because the base check
    // above proved every unchanged entry still matches.
    const desired = input.candidate.entries ?? scanTree(input.candidate.path)
    /**
     * `.git` is not an ordinary subtree: an index/ref only holds object names,
     * so publishing half of a `git commit` (or a hook that runs on the user's
     * next commit) must be refused *before* the first byte is written. The plan
     * is computed against the post-state of every repository in the candidate.
     */
    const read = (relPath: string): Buffer | undefined => {
      for (const base of [input.candidate.path, input.target]) {
        try {
          return readFileSync(join(base, relPath))
        } catch {
          /* try the next root */
        }
      }
      return undefined
    }
    const plan = planGitPublication({ root: input.target, desired, current: currentEntries, read })
    syncTree(input.target, input.candidate.path, plan.entries, currentEntries)
    const newVersion = versionOf(input.target)
    if (newVersion !== manifestDigest(plan.entries)) {
      throw new Error(`publication verification failed: target ${input.target} does not match the frozen candidate`)
    }
    return { newVersion }
  }
}

/**
 * Write a text file, used by the in-process fs fence and tests.
 * @param path - the absolute path.
 * @param content - the text content.
 */
export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
