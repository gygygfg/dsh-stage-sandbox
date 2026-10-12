/**
 * Overlay capture helpers. A command runs against an overlay whose lower is
 * the real workspace and whose upper is a private writable layer; afterwards
 * only the upper is walked, so the candidate is the delta the command produced
 * rather than a full copy. Deletions appear in the upper as overlay
 * whiteouts — character devices with `rdev === 0` — which are translated into
 * deletion markers, not manifest entries.
 * @module dsh-sandbox-linux/runtime/overlay
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative, sep } from 'node:path'
import { digestFile, type ManifestEntry } from '../candidate/manifest.ts'

/** Whether an overlay upper entry is a whiteout (a deleted path marker). */
export function isWhiteout(stats: { isCharacterDevice(): boolean; rdev: number }): boolean {
  return stats.isCharacterDevice() && stats.rdev === 0
}

/**
 * Probe whether this host can mount a bwrap overlay at all, by overlaying a
 * temporary lower and reading a file back through the overlay. Used to decide
 * whether command execution can use the delta (overlay) path instead of a
 * full-copy fallback.
 * @param timeoutMs - the probe timeout.
 * @returns `true` when an overlay mount succeeds and reflects the lower.
 */
export function probeOverlaySupport(timeoutMs = 5_000): boolean {
  const root = mkdtempSync(join(tmpdir(), 'dsh-overlay-probe-'))
  try {
    const lower = join(root, 'lower')
    const upper = join(root, 'upper')
    const work = join(root, 'work')
    const dest = join(root, 'mnt')
    mkdirSync(lower)
    mkdirSync(upper)
    mkdirSync(work)
    mkdirSync(dest)
    writeFileSync(join(lower, 'probe.txt'), 'overlay-ok')
    const probe = spawnSync('bwrap', [
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--overlay-src', lower, '--overlay', upper, work, dest,
      '--', '/bin/cat', join(dest, 'probe.txt'),
    ], { timeout: timeoutMs, encoding: 'utf8' })
    return probe.status === 0 && probe.stdout === 'overlay-ok'
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The captured contents of an overlay upper layer. */
export interface OverlayCapture {
  /** The entries created or modified by the command. */
  readonly entries: ManifestEntry[]
  /** The POSIX-relative paths the command deleted (whiteouts). */
  readonly deletions: string[]
}

/**
 * Walk an overlay upper and classify its entries. Whiteouts are reported as
 * deletions; symlinks are recorded as links and never followed; special files
 * that are not whiteouts are skipped (the manifest vocabulary has no place for
 * them, and following them is unsafe).
 * @param upper - the overlay upper directory.
 * @returns the captured entries and deletions.
 */
export function scanUpper(upper: string): OverlayCapture {
  const entries: ManifestEntry[] = []
  const deletions: string[] = []
  if (!existsSync(upper)) return { entries, deletions }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stats = lstatSync(path)
      const path_ = relative(upper, path).split(sep).join(posix.sep)
      if (isWhiteout(stats)) {
        deletions.push(path_)
        continue
      }
      if (stats.isSymbolicLink()) {
        entries.push({ path: path_, kind: 'symlink', linkTarget: readlinkSync(path) })
        continue
      }
      if (stats.isDirectory()) {
        entries.push({ path: path_, kind: 'directory', mode: stats.mode & 0o7777 })
        walk(path)
        continue
      }
      if (stats.isFile()) {
        entries.push({ path: path_, kind: 'file', mode: stats.mode & 0o7777, size: stats.size, digest: digestFile(path) })
      }
    }
  }
  walk(upper)
  return { entries, deletions }
}

/**
 * Merge an overlay capture onto a base manifest: start from the base, drop
 * deletion-marked paths (and their descendants), then overlay the changed
 * entries, removing base descendants shadowed by a changed non-directory.
 * @param base - the input manifest.
 * @param changed - the entries the command created or modified.
 * @param deletions - the paths the command deleted.
 * @returns the merged, path-sorted manifest.
 */
export function mergeManifest(
  base: readonly ManifestEntry[],
  changed: readonly ManifestEntry[],
  deletions: readonly string[],
): ManifestEntry[] {
  const deleted = new Set(deletions)
  const isDeleted = (path: string): boolean => {
    if (deleted.has(path)) return true
    let current = path
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'))
      if (deleted.has(current)) return true
    }
    return false
  }
  const merged = new Map<string, ManifestEntry>()
  for (const entry of base) if (!isDeleted(entry.path)) merged.set(entry.path, entry)
  const live = changed.filter(entry => !isDeleted(entry.path))
  for (const entry of live) merged.set(entry.path, entry)
  for (const entry of live) {
    if (entry.kind === 'directory') continue
    const prefix = `${entry.path}/`
    for (const key of [...merged.keys()]) if (key.startsWith(prefix)) merged.delete(key)
  }
  return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
