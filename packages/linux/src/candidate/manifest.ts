/**
 * Candidate manifests: the content-addressed listing of a staged workspace
 * tree. The manifest is what a candidate digest covers, so an approval binds
 * to exact file contents, not to a path list that could be mutated later.
 * @module dsh-sandbox-linux/candidate/manifest
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync, type Stats } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { digestOf } from '../util/canonical.ts'

/** One entry in a candidate manifest. */
export interface ManifestEntry {
  /** POSIX-separated path relative to the manifest root. */
  readonly path: string
  /** The entry kind. */
  readonly kind: 'file' | 'directory' | 'symlink'
  /** The file's permission bits (`mode & 0o7777`), for regular files and directories. */
  readonly mode?: number
  /** The regular file's byte size. */
  readonly size?: number
  /** The regular file's content digest. */
  readonly digest?: string
  /** The symlink target, verbatim. */
  readonly linkTarget?: string
}

/** A digest of a file's bytes. */
export function digestFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/** Convert a host path to a POSIX-separated manifest path. */
function toManifestPath(root: string, path: string): string {
  return relative(root, path).split(sep).join(posix.sep)
}

function entryFor(root: string, path: string, stats: Stats): ManifestEntry {
  const manifestPath = toManifestPath(root, path)
  if (stats.isSymbolicLink()) return { path: manifestPath, kind: 'symlink', linkTarget: readlinkSync(path) }
  if (stats.isDirectory()) return { path: manifestPath, kind: 'directory', mode: stats.mode & 0o7777 }
  return { path: manifestPath, kind: 'file', mode: stats.mode & 0o7777, size: stats.size, digest: digestFile(path) }
}

/**
 * Recursively scan a directory into a sorted manifest. Symbolic links are
 * recorded as links and never followed, so a link cannot pull content from
 * outside the staged tree into the manifest.
 * @param root - the absolute directory to scan.
 * @returns the manifest entries, sorted by path.
 */
export function scanTree(root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = []
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort()
    for (const name of names) {
      const path = join(dir, name)
      const stats = lstatSync(path)
      entries.push(entryFor(root, path, stats))
      if (stats.isDirectory() && !stats.isSymbolicLink()) walk(path)
    }
  }
  walk(root)
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The digest of a manifest. Two trees with the same content, permissions, and
 * links produce the same digest regardless of scan order.
 * @param entries - the manifest entries.
 * @returns the manifest digest.
 */
export function manifestDigest(entries: readonly ManifestEntry[]): string {
  return digestOf(entries)
}
