/**
 * The `.git` control plane: what may be published, in which order, and when the
 * whole batch has to be refused.
 *
 * Why `.git` is not an ordinary directory
 * ---------------------------------------
 * `.git` is a coupled database: the index and the refs only hold object names,
 * the bytes live under `objects/**`. Publishing a candidate file by file in
 * arbitrary order therefore produces two kinds of corruption:
 *
 *   * **dangling references** — index/refs land before (or without) their
 *     objects, and `git status` fails with `fatal: unable to read <oid>`;
 *   * **half an atomic operation** — `git commit` changes index + refs + logs
 *     together; publishing half of that leaves HEAD, the worktree and the
 *     reflog disagreeing with each other.
 *
 * So the classes are structural, not advisory:
 *
 * | class | paths | publication |
 * |---|---|---|
 * | `object`    | `.git/objects/**` | first (content-addressed, additive, idempotent) |
 * | `pointer`   | index / HEAD / refs / logs / packed-refs / worktrees | last |
 * | `transient` | `*.lock`, `gc.log` | never (a lock is not state) |
 * | `other`     | config / hooks / info / modules / description | never — the batch is refused |
 *
 * The last row is the security boundary. A hook executes on the user's next
 * `commit`; `config` can set `core.hooksPath`/`core.pager` (arbitrary command
 * execution). If either were publishable, "stage → review" would hand the
 * protection back to the payload. The Windows package refuses these at the same
 * layer (`SANDBOX_GIT_INTERNAL`); this module keeps that semantics on Linux.
 *
 * The port is deliberately narrow: it guards *publication*, not the sandboxed
 * command itself. An agent may write anything inside its overlay; what cannot
 * happen is that `.git` internals or an inconsistent reference set reach the
 * real repository.
 * @module dsh-sandbox-linux/publish/git-control
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ManifestEntry } from '../candidate/manifest.ts'

/** The publication class of one `.git` internal path. */
export type GitPathClass = 'object' | 'pointer' | 'transient' | 'other'

/** Fixed-name pointer files (canonical state, not behaviour). */
const POINTER_FILES: ReadonlySet<string> = new Set([
  'index',
  'head',
  'packed-refs',
  'orig_head',
  'merge_head',
  'cherry_pick_head',
  'revert_head',
  'fetch_head',
  'commit_editmsg',
  'merge_msg',
  'auto_merge',
  'shallow',
  'commondir',
])

/** Pointer directories: everything below them is mutable state. */
const POINTER_DIRS: readonly string[] = ['refs/', 'logs/', 'worktrees/']

/** Split a path into non-empty segments, accepting either separator. */
function segmentsOf(path: string): string[] {
  return String(path ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0)
}

/**
 * Index of the **last** `.git` segment that has something after it.
 *
 * Last (not first) so a nested repository (`vendor/lib/.git/index`) is classed
 * by the inner repository. A trailing `.git` (the directory or the worktree
 * file itself) is not an internal path, so it yields `-1`.
 */
function gitSegmentIndex(segments: readonly string[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (String(segments[index]).toLowerCase() === '.git') {
      return index === segments.length - 1 ? -1 : index
    }
  }
  return -1
}

/**
 * Classify a workspace-relative path.
 * @param path - POSIX-relative path (backslashes are normalised).
 * @returns the class, or `undefined` when the path is not inside a `.git`.
 */
export function gitClassOf(path: string): GitPathClass | undefined {
  const segments = segmentsOf(path)
  const at = gitSegmentIndex(segments)
  if (at < 0) return undefined
  const rel = segments.slice(at + 1).map((segment) => segment.toLowerCase())
  if (rel.length === 0) return 'other'
  const first = rel[0] as string
  // Trailing slash on purpose: it lets a *directory* entry (`.git/refs`,
  // `.git/objects`, `.git/hooks`) match the same predicates as its children.
  const joined = `${rel.join('/')}/`
  if (joined.endsWith('.lock/') || joined === 'gc.log/') return 'transient'
  if (rel.length === 1 && POINTER_FILES.has(first)) return 'pointer'
  if (POINTER_DIRS.some((dir) => joined === dir || joined.startsWith(dir))) return 'pointer'
  if (first === 'objects') return 'object'
  return 'other'
}

/** The repository-relative `.git` directory prefix for a path (`''` = workspace root). */
export function gitDirPrefixOf(path: string): string | undefined {
  const segments = segmentsOf(path)
  const at = gitSegmentIndex(segments)
  if (at < 0) return undefined
  return segments.slice(0, at + 1).join('/')
}

/** Stable publication rank: objects 0, ordinary files 1, pointers 2. */
export function gitApplyRank(path: string): number {
  const kind = gitClassOf(path)
  if (kind === 'object') return 0
  if (kind === 'pointer') return 2
  return 1
}

/** Refuse-to-publish error; carries the machine-readable reason for the receipt. */
export class GitPublicationRefused extends Error {
  /** The stable reason code (`GIT_INTERNAL` / `GIT_POINTER_DELETE` / `GIT_REFERENTIAL_INTEGRITY` / `GIT_INDEX_CORRUPT`). */
  readonly code: string
  /** The paths that triggered the refusal. */
  readonly paths: readonly string[]

  /**
   * @param code - the reason code.
   * @param message - a one-line explanation (safe for logs, never for the model).
   * @param paths - the offending paths.
   */
  constructor(code: string, message: string, paths: readonly string[]) {
    super(message)
    this.name = 'GitPublicationRefused'
    this.code = code
    this.paths = paths
  }
}

/** Parse an index (v2/v3) and return the blob object names it references. */
export function parseIndexBlobOids(buffer: Buffer, oidLength = 40): { ok: boolean; oids: string[]; code?: string; reason?: string } {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'DIRC') {
    return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: 'index is missing the DIRC header' }
  }
  const version = buffer.readUInt32BE(4)
  if (version === 4) return { ok: false, oids: [], code: 'GIT_INDEX_UNSUPPORTED', reason: 'index v4 (path prefix compression) is not verifiable' }
  if (version !== 2 && version !== 3) return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `unknown index version ${version}` }
  const count = buffer.readUInt32BE(8)
  const oidBytes = oidLength / 2
  const oids: string[] = []
  let position = 12
  for (let entry = 0; entry < count; entry += 1) {
    const start = position
    if (position + 40 + oidBytes + 2 > buffer.length) return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `entry ${entry} is out of bounds` }
    oids.push(buffer.toString('hex', position + 40, position + 40 + oidBytes))
    const flags = buffer.readUInt16BE(position + 40 + oidBytes)
    const extended = version >= 3 && (flags & 0x4000) !== 0
    const cursor = position + 40 + oidBytes + 2 + (extended ? 2 : 0)
    const declared = flags & 0x0fff
    let end: number
    if (declared < 0x0fff) {
      end = cursor + declared + 1
    } else {
      let scan = cursor
      while (scan < buffer.length && buffer[scan] !== 0) scan += 1
      end = scan + 1
    }
    if (end > buffer.length) return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `entry ${entry} path is out of bounds` }
    position = start + Math.ceil((end - start) / 8) * 8
  }
  return { ok: true, oids }
}

/** Read the object names recorded in a pack index (v1 and v2). */
export function readPackIndexOids(file: string, oidLength = 40): Set<string> {
  const out = new Set<string>()
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return out
  }
  const oidBytes = oidLength / 2
  if (buffer.length >= 8 && buffer.toString('latin1', 0, 4) === '\xfftOc') {
    const version = buffer.readUInt32BE(4)
    if (version !== 2) return out
    if (buffer.length < 8 + 256 * 4) return out
    const count = buffer.readUInt32BE(8 + 255 * 4)
    const start = 8 + 256 * 4
    if (start + count * oidBytes > buffer.length) return out
    for (let index = 0; index < count; index += 1) {
      out.add(buffer.toString('hex', start + index * oidBytes, start + (index + 1) * oidBytes))
    }
    return out
  }
  if (buffer.length < 256 * 4) return out
  const count = buffer.readUInt32BE(255 * 4)
  const entryBytes = 4 + oidBytes
  if (256 * 4 + count * entryBytes > buffer.length) return out
  for (let index = 0; index < count; index += 1) {
    const at = 256 * 4 + index * entryBytes + 4
    out.add(buffer.toString('hex', at, at + oidBytes))
  }
  return out
}

/** An object-name lookup over the loose store and any pack indexes. */
export function createObjectStore(gitDir: string, oidLength = 40): { has: (oid: string) => boolean } {
  const objectsDir = join(gitDir, 'objects')
  let packs: Set<string> | undefined
  const loadPacks = (): Set<string> => {
    if (packs !== undefined) return packs
    packs = new Set()
    let names: string[] = []
    try {
      names = readdirSync(join(objectsDir, 'pack'))
    } catch {
      return packs
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.idx')) continue
      for (const oid of readPackIndexOids(join(objectsDir, 'pack', name), oidLength)) packs.add(oid)
    }
    return packs
  }
  return {
    has(oid: string): boolean {
      const normalized = oid.toLowerCase()
      if (normalized.length >= 3) {
        try {
          if (statSync(join(objectsDir, normalized.slice(0, 2), normalized.slice(2))).isFile()) return true
        } catch {
          /* not loose; check the packs */
        }
      }
      return loadPacks().has(normalized)
    },
  }
}

/** The outcome of planning a publication against the `.git` rules. */
export interface GitPublicationPlan {
  /** The entries the publisher may write (`.git` internals removed). */
  readonly entries: readonly ManifestEntry[]
  /** `.git` entries deliberately not published (locks). */
  readonly dropped: readonly { readonly path: string; readonly reason: string }[]
}

/** Parse `packed-refs` into `ref -> oid`. */
function parsePackedRefs(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue
    const [oid, name] = line.split(/\s+/u)
    if (oid === undefined || name === undefined) continue
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(oid)) out.set(name, oid.toLowerCase())
  }
  return out
}

/** Whether a ref file's content is a direct object name (not `ref: …`). */
function oidOfRefContent(buffer: Buffer | undefined): string | undefined {
  if (buffer === undefined) return undefined
  const text = buffer.toString('utf8').trim()
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(text) ? text.toLowerCase() : undefined
}

/** Whether two manifest entries describe the same content and mode. */
function entryEqual(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind !== right.kind) return false
  if (left.size !== right.size || left.digest !== right.digest) return false
  if (left.linkTarget !== right.linkTarget) return false
  if (left.mode !== undefined && right.mode !== undefined && left.mode !== right.mode) return false
  return true
}

/**
 * Plan one publication: classify every **changed** `.git` entry, refuse the
 * internals, refuse pointer deletions, and verify that every ref/index entry
 * the batch would leave behind resolves to a real object.
 *
 * Only changed entries are considered: an unchanged `.git/config` is part of
 * the manifest of every candidate, and refusing it would block every
 * publication in a repository. Refusal is all-or-nothing and happens **before**
 * anything is written, so a refused batch leaves the repository byte-identical.
 * @param input - the target root, desired entries, current entries, and a
 *   reader for the post-state (candidate content first, then the target).
 * @returns the publishable entries plus what was dropped.
 * @throws GitPublicationRefused when the batch would corrupt or configure `.git`.
 */
export function planGitPublication(input: {
  readonly root: string
  readonly desired: readonly ManifestEntry[]
  readonly current: readonly ManifestEntry[]
  readonly read: (relPath: string) => Buffer | undefined
}): GitPublicationPlan {
  const currentByPath = new Map(input.current.map((entry) => [entry.path, entry]))
  const desiredPaths = new Set(input.desired.map((entry) => entry.path))
  const changed = input.desired.filter((entry) => !entryEqual(currentByPath.get(entry.path), entry))
  const deleted = input.current.filter((entry) => !desiredPaths.has(entry.path))

  const changedGit = changed.filter((entry) => gitClassOf(entry.path) !== undefined)
  const deletedGit = deleted.filter((entry) => gitClassOf(entry.path) !== undefined)
  if (changedGit.length === 0 && deletedGit.length === 0) return { entries: input.desired, dropped: [] }

  // 1. Internals are never published; the batch is refused instead.
  const internals = [
    ...changedGit.filter((entry) => gitClassOf(entry.path) === 'other'),
    ...deletedGit.filter((entry) => gitClassOf(entry.path) === 'other'),
  ]
  if (internals.length > 0) {
    throw new GitPublicationRefused(
      'GIT_INTERNAL',
      `refusing to change .git internals: ${internals.map((entry) => entry.path).join(', ')}`,
      internals.map((entry) => entry.path),
    )
  }

  // 2. A pointer that disappears is a broken repository, not a change.
  const pointerDeletes = deletedGit.filter((entry) => gitClassOf(entry.path) === 'pointer')
  if (pointerDeletes.length > 0) {
    throw new GitPublicationRefused(
      'GIT_POINTER_DELETE',
      `refusing to delete .git pointers: ${pointerDeletes.map((entry) => entry.path).join(', ')}`,
      pointerDeletes.map((entry) => entry.path),
    )
  }

  // 3. Locks and gc logs are not state: drop them, keep the rest.
  const dropped = changedGit
    .filter((entry) => gitClassOf(entry.path) === 'transient')
    .map((entry) => ({ path: entry.path, reason: 'GIT_TRANSIENT' }))
  const droppedPaths = new Set(dropped.map((item) => item.path))
  const entries = input.desired.filter((entry) => !droppedPaths.has(entry.path))

  // 4. Referential integrity over the post-state of every repository in play.
  const gitDirs = new Set<string>()
  for (const entry of [...changedGit, ...deletedGit]) {
    const prefix = gitDirPrefixOf(entry.path)
    if (prefix !== undefined) gitDirs.add(prefix)
  }
  for (const prefix of gitDirs) {
    // No `existsSync` guard: a candidate may be *creating* the repository, and
    // the post-state reader already covers that case (objects come from the
    // candidate, packs from the target when it has any).
    verifyRepository({ gitDir: join(input.root, prefix), prefix, read: input.read, post: entries.map((entry) => entry.path) })
  }

  return { entries, dropped }
}

/** Verify refs and the index of one repository resolve against its object store. */
function verifyRepository(input: {
  readonly gitDir: string
  readonly prefix: string
  readonly read: (relPath: string) => Buffer | undefined
  readonly post: readonly string[]
}): void {
  /**
   * Everything is checked against the **post-state**, not the disk: a commit
   * candidate carries its new blobs in the same batch that moves the ref, so
   * reading the real store (or listing the real refs directory) would refuse
   * every legitimate commit and miss every newly added ref. `read()` already
   * prefers the candidate and falls back to the target; packs are only
   * enumerated on the target (a candidate that adds a pack would be refused —
   * acceptable, because rewriting packs is exactly what the command guard
   * forbids).
   */
  const packs = new Set<string>()
  try {
    for (const name of readdirSync(join(input.gitDir, 'objects', 'pack'))) {
      if (!name.toLowerCase().endsWith('.idx')) continue
      for (const oid of readPackIndexOids(join(input.gitDir, 'objects', 'pack', name))) packs.add(oid)
    }
  } catch {
    /* no packs */
  }
  const hasObject = (oid: string): boolean => {
    const normalized = oid.toLowerCase()
    if (normalized.length >= 3 && input.read(`${input.prefix}/objects/${normalized.slice(0, 2)}/${normalized.slice(2)}`) !== undefined) return true
    return packs.has(normalized)
  }
  const readInRepo = (rel: string): Buffer | undefined => input.read(`${input.prefix}/${rel}`)

  const dangling: string[] = []
  const checkRef = (refRel: string, buffer: Buffer | undefined): void => {
    const oid = oidOfRefContent(buffer)
    if (oid !== undefined && !hasObject(oid)) dangling.push(`${input.prefix}/${refRel}`)
  }

  const prefixWithSlash = `${input.prefix}/`
  for (const path of input.post) {
    if (!path.startsWith(`${prefixWithSlash}refs/`)) continue
    checkRef(path.slice(prefixWithSlash.length), input.read(path))
  }
  checkRef('HEAD', readInRepo('HEAD'))

  const packed = readInRepo('packed-refs')
  if (packed !== undefined) {
    for (const [name, oid] of parsePackedRefs(packed.toString('utf8'))) {
      if (!hasObject(oid)) dangling.push(`${input.prefix}/${name}`)
    }
  }

  const index = readInRepo('index')
  if (index !== undefined && index.length > 0) {
    const parsed = parseIndexBlobOids(index)
    if (!parsed.ok) {
      throw new GitPublicationRefused(parsed.code ?? 'GIT_INDEX_CORRUPT', parsed.reason ?? 'index is not verifiable', [])
    }
    for (const oid of parsed.oids) {
      if (!hasObject(oid)) dangling.push(`${input.prefix}/index -> ${oid}`)
    }
  }

  if (dangling.length > 0) {
    throw new GitPublicationRefused(
      'GIT_REFERENTIAL_INTEGRITY',
      `refusing to publish a dangling reference: ${dangling.slice(0, 5).join(', ')}`,
      dangling,
    )
  }
}
