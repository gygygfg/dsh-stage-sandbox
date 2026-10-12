/**
 * The logical workspace: a private **delta** staging tree plus the base
 * snapshot and explicit deletion markers that define the single logical
 * version every tool reads. It is the namespace behind the file editor, the
 * shell executor, and the Git projection, so they can never disagree about
 * what exists.
 *
 * The staging tree is copy-on-write: only objects a mutation (or an overlay
 * command) touched are materialized there, and every read falls back to the
 * base snapshot. A mutation is recorded in a staged index, so if a staged
 * object is later missing from the staging storage the path is `corrupted` and
 * publication is blocked rather than silently restored from the host.
 * @module dsh-sandbox-linux/workspace/logical
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { diffManifests } from '../candidate/diff.ts'
import type { FsImpact } from '../candidate/impact.ts'
import { manifestDigest, scanTree, type ManifestEntry } from '../candidate/manifest.ts'
import type { CandidateScope } from '../control/records.ts'
import { isWhiteout, mergeManifest } from '../runtime/overlay.ts'
import { digestOf } from '../util/canonical.ts'
import type { CorruptionRecord, LogicalEntry, LogicalRead, LogicalState, WorkspaceIntegrity } from './types.ts'

/** The inputs for one logical workspace. */
export interface LogicalWorkspaceOptions {
  /** The real workspace root the logical view is based on. */
  readonly baseRoot: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  /** The evidence pointer recorded on impact records. */
  readonly evidenceId?: string
  /** Parent directory the private staging tree is created under; defaults to the OS temp dir. */
  readonly stagingParent?: string
  /**
   * Whether the staging tree holds only the delta (copy-on-write). When
   * `false` the base snapshot is copied eagerly and the staging tree is a full
   * private view — the fallback for hosts that cannot mount an overlay.
   * Defaults to `true`.
   */
  readonly copyOnWrite?: boolean
}

/** The result of a mutating operation that has no value to return. */
export type LogicalMutation =
  | { readonly kind: 'ok' }
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'corrupted'; readonly path: string; readonly reason: string }
  | { readonly kind: 'denied'; readonly path: string; readonly reason: string }

/** The kind of a staged object. */
type StagedKind = 'file' | 'directory' | 'symlink'

/** Whether a real path is the root or a descendant of it. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Convert a host path to a POSIX-separated relative path. */
function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join(posix.sep)
}

/** The digest of a file's bytes. */
function digestFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

/**
 * One logical workspace. Mutations land only in the staging delta and its
 * deletion-marker set; reads fall back to the base snapshot for untouched
 * paths. The real workspace changes only when the frozen candidate is
 * published under CAS.
 */
export class LogicalWorkspace {
  /** The real workspace root. */
  readonly baseRoot: string
  /** The private staging delta root. */
  readonly stagingRoot: string
  /** The candidate scope, part of every frozen candidate. */
  readonly scope: CandidateScope
  private readonly evidenceId: string
  private readonly copyOnWrite: boolean
  private baseEntries: ManifestEntry[] | null = null
  private baseIndex: Map<string, ManifestEntry> | null = null
  /** POSIX relative paths explicitly deleted in this logical version. */
  private readonly deletions = new Set<string>()
  /** POSIX relative paths a mutation materialized into the staging delta. */
  private readonly staged = new Map<string, StagedKind>()
  /** A private empty directory for an overlay `work` sibling, created lazily. */
  private overlayWorkDir: string | null = null
  private revision = 0

  /**
   * @param options - the base root, scope, evidence pointer, and staging parent.
   */
  constructor(options: LogicalWorkspaceOptions) {
    this.baseRoot = resolve(options.baseRoot)
    this.stagingRoot = mkdtempSync(join(options.stagingParent ?? tmpdir(), 'dsh-logical-'))
    this.scope = options.scope
    this.evidenceId = options.evidenceId ?? 'evidence:fs'
    this.copyOnWrite = options.copyOnWrite ?? true
  }

  /** Whether the base snapshot has been captured (the delta is always usable). */
  get materialized(): boolean {
    return this.baseEntries !== null
  }

  /** The base manifest captured at materialization, or `null` before it. */
  get base(): readonly ManifestEntry[] | null {
    return this.baseEntries
  }

  /** The monotonic staged revision; every mutation increments it. */
  get stagedRevision(): number {
    return this.revision
  }

  /** Whether the staging tree is a delta (copy-on-write) rather than a full copy. */
  get isCopyOnWrite(): boolean {
    return this.copyOnWrite
  }

  /**
   * Capture the base snapshot once. The staging delta starts empty; reads fall
   * back to the base snapshot, so nothing is copied eagerly.
   */
  materialize(): void {
    if (this.materialized) return
    this.baseEntries = existsSync(this.baseRoot) ? scanTree(this.baseRoot) : []
    this.baseIndex = new Map(this.baseEntries.map(entry => [entry.path, entry]))
    // The full-copy fallback populates the staging tree once, so redirecting a
    // command into it sees every base file, not just the delta.
    if (!this.copyOnWrite && existsSync(this.baseRoot)) {
      cpSync(this.baseRoot, this.stagingRoot, { recursive: true, force: true, errorOnExist: false })
    }
  }

  /**
   * The POSIX-separated path of a real path relative to the workspace root, or
   * `undefined` when it is outside. A path already inside the staging tree maps
   * to itself, so staging an already-staged path is idempotent.
   * @param realPath - the real absolute path.
   * @returns the relative POSIX path, or `undefined` when outside the workspace.
   */
  relativeFor(realPath: string): string | undefined {
    const absolute = resolve(realPath)
    if (isUnder(this.stagingRoot, absolute)) return toPosixRelative(this.stagingRoot, absolute)
    if (!isUnder(this.baseRoot, absolute)) return undefined
    return toPosixRelative(this.baseRoot, absolute)
  }

  /**
   * Map a real absolute path under the base root to its staging path. A path
   * outside the base root is not stageable and returns `undefined`; a path
   * already under the staging tree returns itself, so the mapping is idempotent.
   * @param realPath - the real absolute path.
   * @returns the staging path, or `undefined` when outside the base root.
   */
  pathFor(realPath: string): string | undefined {
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return undefined
    return this.stagingPathFor(relativePath)
  }

  /**
   * Map a staging path back to the real path it represents.
   * @param stagingPath - the staging absolute path.
   * @returns the real path, or `undefined` when outside the staging tree.
   */
  realPathFor(stagingPath: string): string | undefined {
    const absolute = resolve(stagingPath)
    if (!isUnder(this.stagingRoot, absolute)) return undefined
    const relativePath = toPosixRelative(this.stagingRoot, absolute)
    return this.logicalPathFor(relativePath)
  }

  /**
   * The logical state of one path.
   * @param realPath - the logical (real) absolute path.
   * @returns the state, or `undefined` when the path is outside the workspace.
   */
  stateOf(realPath: string): LogicalState | undefined {
    this.materialize()
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return undefined
    const logicalPath = this.logicalPathFor(relativePath)
    if (this.isDeletedOrUnderDeleted(relativePath)) return { path: logicalPath, relative: relativePath, kind: 'deleted' }
    const staged = this.stagingPathFor(relativePath)
    if (staged !== undefined && existsSync(staged)) {
      const stats = lstatSync(staged)
      const kind: StagedKind = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file'
      // An unchanged base directory that gained a staged child is a baseline
      // object, even though the delta holds a synthesized copy of it.
      if (kind === 'directory' && this.baseIndex?.get(relativePath)?.kind === 'directory') {
        return { path: logicalPath, relative: relativePath, kind: 'baseline' }
      }
      if (kind === 'file') return { path: logicalPath, relative: relativePath, kind: 'staged-file' }
      if (kind === 'directory') return { path: logicalPath, relative: relativePath, kind: 'staged-directory' }
      return { path: logicalPath, relative: relativePath, kind: 'staged-file' }
    }
    if (this.staged.has(relativePath)) {
      return { path: logicalPath, relative: relativePath, kind: 'corrupted', reason: 'staged object is missing from the staging storage' }
    }
    if (this.baseIndex?.has(relativePath) === true) {
      return { path: logicalPath, relative: relativePath, kind: 'baseline' }
    }
    return { path: logicalPath, relative: relativePath, kind: 'absent' }
  }

  /**
   * Read one path through the unified namespace. A deleted path is absent, and
   * a path whose staged storage object is missing is corrupted — never the real
   * file's inferred deletion.
   * @param realPath - the logical (real) absolute path.
   * @returns the structured read result.
   */
  read(realPath: string): LogicalRead {
    const state = this.stateOf(realPath)
    if (state === undefined) return { kind: 'absent', state: { path: resolve(realPath), relative: '', kind: 'absent' } }
    switch (state.kind) {
      case 'deleted':
      case 'absent':
        return { kind: 'absent', state }
      case 'corrupted':
        return { kind: 'corrupted', state, reason: state.reason ?? 'corrupted' }
      case 'baseline': {
        const base = this.sourcePathFor(state.relative)
        if (base === undefined) {
          return { kind: 'corrupted', state: { ...state, kind: 'corrupted', reason: 'base snapshot object is missing' }, reason: 'base snapshot object is missing' }
        }
        const stats = lstatSync(base)
        if (stats.isDirectory()) return { kind: 'directory', state, entries: this.listEntries(state.relative) }
        return { kind: 'file', state, content: readFileSync(base, 'utf8'), digest: digestFile(base) }
      }
      case 'staged-file': {
        const staged = this.stagingPathFor(state.relative)
        if (staged === undefined || !existsSync(staged)) {
          return { kind: 'corrupted', state: { ...state, kind: 'corrupted', reason: 'file storage object is missing' }, reason: 'file storage object is missing' }
        }
        return { kind: 'file', state, content: readFileSync(staged, 'utf8'), digest: digestFile(staged) }
      }
      case 'staged-directory':
        return { kind: 'directory', state, entries: this.listEntries(state.relative) }
    }
  }

  /**
   * List a directory's logical entries: base children and staged children are
   * merged, and explicit deletion markers remove entries.
   * @param realPath - the logical (real) absolute path.
   * @returns the entries, or an empty list when the path is not a live directory.
   */
  list(realPath: string): readonly LogicalEntry[] {
    const state = this.stateOf(realPath)
    if (state === undefined || state.kind === 'deleted' || state.kind === 'absent' || state.kind === 'corrupted') return []
    const base = this.baseIndex?.get(state.relative)
    const staged = this.stagingPathFor(state.relative)
    const stagedDir = staged !== undefined && existsSync(staged) && statSync(staged).isDirectory()
    if (base?.kind !== 'directory' && !stagedDir) return []
    return this.listEntries(state.relative)
  }

  /**
   * Read a file's text, or `undefined` when it is absent or corrupted. Callers
   * that must distinguish those cases use {@link read}.
   * @param realPath - the logical (real) absolute path.
   * @returns the file text, or `undefined`.
   */
  readText(realPath: string): string | undefined {
    const result = this.read(realPath)
    return result.kind === 'file' ? result.content : undefined
  }

  /**
   * Whether a live object exists at a path (a directory counts).
   * @param realPath - the logical (real) absolute path.
   * @returns `true` when the path exists in the logical view.
   */
  exists(realPath: string): boolean {
    const state = this.stateOf(realPath)
    return state !== undefined && (state.kind === 'baseline' || state.kind === 'staged-file' || state.kind === 'staged-directory')
  }

  /**
   * Write a file's text into the logical view, synthesizing parent
   * directories and clearing any deletion marker on the path and its ancestors.
   * @param realPath - the logical (real) absolute path.
   * @param content - the text content.
   * @returns the mutation result.
   */
  writeText(realPath: string, content: string): LogicalMutation {
    this.materialize()
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    const staged = this.stagingPathFor(relativePath)
    if (staged === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    if (existsSync(staged) && statSync(staged).isDirectory()) rmSync(staged, { recursive: true, force: true })
    this.clearDeletions(relativePath)
    mkdirSync(dirname(staged), { recursive: true })
    writeFileSync(staged, content)
    this.recordStaged(relativePath, 'file')
    this.revision++
    return { kind: 'ok' }
  }

  /**
   * Create a directory in the logical view, synthesizing parents.
   * @param realPath - the logical (real) absolute path.
   * @returns the mutation result.
   */
  mkdir(realPath: string): LogicalMutation {
    this.materialize()
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    const staged = this.stagingPathFor(relativePath)
    if (staged === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    if (existsSync(staged) && !statSync(staged).isDirectory()) rmSync(staged, { force: true })
    this.clearDeletions(relativePath)
    mkdirSync(staged, { recursive: true })
    this.recordStaged(relativePath, 'directory')
    this.revision++
    return { kind: 'ok' }
  }

  /**
   * Remove a path from the logical view. The deletion is recorded as a
   * persistent marker before the staging object is removed, so no read can
   * resurrect it from the base snapshot.
   * @param realPath - the logical (real) absolute path.
   * @param options - `recursive` removes a non-empty directory.
   * @returns the mutation result.
   */
  remove(realPath: string, options: { recursive?: boolean } = {}): LogicalMutation {
    this.materialize()
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    if (relativePath === '') return { kind: 'denied', path: this.baseRoot, reason: 'cannot delete the workspace root' }
    const state = this.stateOf(realPath)
    if (state === undefined || state.kind === 'deleted' || state.kind === 'absent') return { kind: 'not-found', path: this.logicalPathFor(relativePath) }
    if (state.kind === 'corrupted') return { kind: 'corrupted', path: this.logicalPathFor(relativePath), reason: state.reason ?? 'corrupted' }
    if (options.recursive !== true && this.logicalIsDirectory(relativePath) && this.listEntries(relativePath).length > 0) {
      return { kind: 'denied', path: this.logicalPathFor(relativePath), reason: 'directory is not empty' }
    }
    this.markDeleted(relativePath)
    const staged = this.stagingPathFor(relativePath)
    if (staged !== undefined && existsSync(staged)) rmSync(staged, { recursive: true, force: true })
    this.forgetStagedSubtree(relativePath)
    this.revision++
    return { kind: 'ok' }
  }

  /**
   * Rename a path in the logical view. A baseline source is copied up first,
   * then recorded as deleted and the destination synthesized, so a base file
   * cannot reappear at the source.
   * @param from - the logical source path.
   * @param to - the logical destination path.
   * @returns the mutation result.
   */
  rename(from: string, to: string): LogicalMutation {
    this.materialize()
    const fromRelative = this.relativeFor(from)
    const toRelative = this.relativeFor(to)
    if (fromRelative === undefined || toRelative === undefined) return { kind: 'denied', path: resolve(from), reason: 'path is outside the workspace root' }
    const sourceState = this.stateOf(from)
    if (sourceState === undefined || sourceState.kind === 'deleted' || sourceState.kind === 'absent') return { kind: 'not-found', path: this.logicalPathFor(fromRelative) }
    if (sourceState.kind === 'corrupted') return { kind: 'corrupted', path: this.logicalPathFor(fromRelative), reason: sourceState.reason ?? 'corrupted' }
    const source = this.stagingPathFor(fromRelative)
    const destination = this.stagingPathFor(toRelative)
    if (source === undefined || destination === undefined) return { kind: 'denied', path: resolve(from), reason: 'path is outside the workspace root' }
    this.copyUp(fromRelative)
    this.markDeleted(fromRelative)
    this.clearDeletions(toRelative)
    mkdirSync(dirname(destination), { recursive: true })
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
    renameSync(source, destination)
    this.moveStaged(fromRelative, toRelative)
    this.revision++
    return { kind: 'ok' }
  }

  /**
   * Replace a path's object type (file ↔ directory), removing the old object.
   * @param realPath - the logical (real) absolute path.
   * @param kind - the target type.
   * @returns the mutation result.
   */
  replaceType(realPath: string, kind: 'file' | 'directory'): LogicalMutation {
    this.materialize()
    const relativePath = this.relativeFor(realPath)
    if (relativePath === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    const staged = this.stagingPathFor(relativePath)
    if (staged === undefined) return { kind: 'denied', path: resolve(realPath), reason: 'path is outside the workspace root' }
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true })
    this.clearDeletions(relativePath)
    if (kind === 'directory') mkdirSync(staged, { recursive: true })
    else {
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, '')
    }
    this.recordStaged(relativePath, kind)
    this.revision++
    return { kind: 'ok' }
  }

  /**
   * Check that every object a mutation materialized into the staging delta is
   * still present. A missing staged object is corruption; publication must be
   * blocked rather than falling back to the base.
   * @returns the integrity result.
   */
  integrity(): WorkspaceIntegrity {
    this.materialize()
    const corrupted: CorruptionRecord[] = []
    if (!this.copyOnWrite) {
      // In the full-copy fallback every base object must still be in staging.
      for (const entry of this.baseEntries ?? []) {
        if (this.isDeletedOrUnderDeleted(entry.path)) continue
        const staged = this.stagingPathFor(entry.path)
        if (staged === undefined || !existsSync(staged)) {
          corrupted.push({ relative: entry.path, path: this.logicalPathFor(entry.path), reason: 'base object is missing from the staging storage' })
        }
      }
      return { ok: corrupted.length === 0, corrupted }
    }
    for (const relativePath of this.staged.keys()) {
      if (this.isDeletedOrUnderDeleted(relativePath)) continue
      const staged = this.stagingPathFor(relativePath)
      if (staged === undefined || !existsSync(staged)) {
        corrupted.push({ relative: relativePath, path: this.logicalPathFor(relativePath), reason: 'staged object is missing from the staging storage' })
      }
    }
    return { ok: corrupted.length === 0, corrupted }
  }

  /** The current logical entries: base ∪ staged delta, minus deletions. */
  entries(): ManifestEntry[] {
    this.materialize()
    if (!this.copyOnWrite) {
      const entries = scanTree(this.stagingRoot)
      return this.deletions.size === 0 ? entries : entries.filter(entry => !this.isDeletedOrUnderDeleted(entry.path))
    }
    const merged = new Map<string, ManifestEntry>()
    for (const entry of this.baseEntries ?? []) {
      if (!this.isDeletedOrUnderDeleted(entry.path)) merged.set(entry.path, entry)
    }
    const stagedEntries = scanTree(this.stagingRoot)
    for (const entry of stagedEntries) {
      if (this.isDeletedOrUnderDeleted(entry.path)) continue
      merged.set(entry.path, entry)
    }
    for (const entry of stagedEntries) {
      if (entry.kind === 'directory') continue
      const prefix = `${entry.path}/`
      for (const key of [...merged.keys()]) if (key.startsWith(prefix)) merged.delete(key)
    }
    return [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /**
   * The manifest that results from applying only the selected changes to the
   * base: the selected paths take their current logical entry, and a selected
   * path that is absent in the current view is a deletion. Used for selective
   * publication — the unselected changes stay pending.
   * @param paths - the POSIX-relative paths to apply.
   * @returns the subset manifest.
   */
  subsetEntries(paths: readonly string[]): ManifestEntry[] {
    this.materialize()
    const current = new Map(this.entries().map(entry => [entry.path, entry]))
    const changed: ManifestEntry[] = []
    const deletions: string[] = []
    for (const path of paths) {
      const entry = current.get(path)
      if (entry === undefined) deletions.push(path)
      else changed.push(entry)
    }
    return mergeManifest(this.baseEntries ?? [], changed, deletions)
  }

  /**
   * Revert one path's staged change so the logical view shows the base again
   * (a rejected file). A staged object is removed, its staged records forgotten,
   * and any deletion marker cleared.
   * @param relativePath - the POSIX-relative path to revert.
   */
  revertPath(relativePath: string): void {
    this.materialize()
    const staged = this.stagingPathFor(relativePath)
    if (staged !== undefined && existsSync(staged)) rmSync(staged, { recursive: true, force: true })
    // In the full-copy fallback the base must be restored into the staging tree
    // (removing it there would read as a deletion); in the delta it simply falls
    // back to the base once the staged object and any marker are gone.
    if (!this.copyOnWrite && staged !== undefined) {
      const base = this.sourcePathFor(relativePath)
      if (base !== undefined) {
        mkdirSync(dirname(staged), { recursive: true })
        cpSync(base, staged, { recursive: true, force: true, errorOnExist: false })
      }
    }
    this.forgetStagedSubtree(relativePath)
    this.clearDeletions(relativePath)
    this.revision++
  }

  /**
   * Re-base the logical view after a selective publication: the real root now
   * holds the applied changes, so the base snapshot is re-read (the delta is
   * kept — an applied path now matches the new base, so it no longer diffs).
   * @param appliedPaths - the POSIX-relative paths that were published.
   */
  reBase(appliedPaths: readonly string[]): void {
    for (const path of appliedPaths) this.clearDeletions(path)
    this.baseEntries = existsSync(this.baseRoot) ? scanTree(this.baseRoot) : []
    this.baseIndex = new Map(this.baseEntries.map(entry => [entry.path, entry]))
    this.revision++
  }

  /** The digest of the current logical version. */
  revisionDigest(): string {
    return manifestDigest(this.entries())
  }

  /** The digest of the current logical version, for the stager projection. */
  get version(): string {
    return this.revisionDigest()
  }

  /** The impact of the logical view relative to the base snapshot. */
  changes(): FsImpact[] {
    this.materialize()
    return diffManifests(this.baseEntries ?? [], this.entries(), this.evidenceId)
  }

  /** The base version the logical view was generated against. */
  baseVersion(): string {
    return manifestDigest(this.baseEntries ?? [])
  }

  /**
   * The overlay writable layer for command execution: the staging delta is the
   * overlay upper, so a command's writes land exactly where tool edits land,
   * and the command sees the logical view at the real workspace path (the
   * overlay lower). The `work` sibling is created lazily and removed on
   * {@link dispose}.
   * @returns the overlay upper (the staging root) and an empty work directory.
   */
  overlaySpec(): { upper: string; work: string } {
    this.materialize()
    if (this.overlayWorkDir === null) this.overlayWorkDir = mkdtempSync(join(dirname(this.stagingRoot), 'dsh-overlay-work-'))
    return { upper: this.stagingRoot, work: this.overlayWorkDir }
  }

  /**
   * Reconcile an overlay command's effects: translate the whiteouts it left in
   * the staging delta into deletion markers and remove the marker devices, so
   * the logical view reflects the command's deletions. Opaque-directory
   * markers are not yet interpreted.
   */
  reconcileOverlay(): void {
    this.materialize()
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        const stats = lstatSync(path)
        if (isWhiteout(stats)) {
          const relativePath = toPosixRelative(this.stagingRoot, path)
          this.markDeleted(relativePath)
          this.forgetStagedSubtree(relativePath)
          unlinkSync(path)
          continue
        }
        if (stats.isDirectory()) walk(path)
      }
    }
    walk(this.stagingRoot)
    if (this.deletions.size > 0) this.revision++
  }

  /**
   * Copy the current logical view into a destination directory, for the
   * copy-based command path: the command sees the staged workspace, not the
   * real one. This materializes the full view and is the slow fallback when an
   * overlay is unavailable.
   * @param destination - the directory to populate.
   */
  copyInto(destination: string): void {
    this.materialize()
    mkdirSync(destination, { recursive: true })
    if (existsSync(this.baseRoot)) cpSync(this.baseRoot, destination, { recursive: true, force: true, errorOnExist: false })
    for (const entry of scanTree(this.stagingRoot)) {
      if (this.isDeletedOrUnderDeleted(entry.path)) continue
      const dest = join(destination, ...entry.path.split(posix.sep))
      if (entry.kind === 'directory') {
        mkdirSync(dest, { recursive: true })
        continue
      }
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      if (entry.kind === 'symlink') symlinkSync(entry.linkTarget ?? '', dest)
      else cpSync(join(this.stagingRoot, ...entry.path.split(posix.sep)), dest)
    }
    for (const relativePath of this.deletions) {
      rmSync(join(destination, ...relativePath.split(posix.sep)), { recursive: true, force: true })
    }
  }

  /**
   * Mirror the current staging delta into a destination directory and return
   * the deleted paths. Used to push tool edits into a resident instance from
   * inside its namespace (the destination is bind-mounted as an inbox), which
   * avoids the overlayfs dentry-cache blind spot of writing the upper on the
   * host. The destination is replaced, so each call is a fresh delta mirror.
   * @param destination - the host directory to populate.
   * @returns the POSIX-relative paths that are deleted in this logical version.
   */
  exportDelta(destination: string): string[] {
    this.materialize()
    // Clear the CONTENTS, never the directory itself: a resident instance holds
    // it bind-mounted, so replacing the inode would break the mount.
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(destination)) rmSync(join(destination, name), { recursive: true, force: true })
    for (const entry of scanTree(this.stagingRoot)) {
      if (this.isDeletedOrUnderDeleted(entry.path)) continue
      const dest = join(destination, ...entry.path.split(posix.sep))
      if (entry.kind === 'directory') {
        mkdirSync(dest, { recursive: true })
        continue
      }
      mkdirSync(dirname(dest), { recursive: true })
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      if (entry.kind === 'symlink') symlinkSync(entry.linkTarget ?? '', dest)
      else cpSync(join(this.stagingRoot, ...entry.path.split(posix.sep)), dest)
    }
    return [...this.deletions]
  }

  /** Remove the staging delta and its overlay work directory. */
  dispose(): void {
    rmSync(this.stagingRoot, { recursive: true, force: true })
    if (this.overlayWorkDir !== null) {
      rmSync(this.overlayWorkDir, { recursive: true, force: true })
      this.overlayWorkDir = null
    }
  }

  /** The logical (real) path for a relative POSIX path. */
  private logicalPathFor(relativePath: string): string {
    return relativePath === '' ? this.baseRoot : join(this.baseRoot, ...relativePath.split(posix.sep))
  }

  /** The staging path for a relative POSIX path. */
  private stagingPathFor(relativePath: string): string | undefined {
    if (relativePath.split(posix.sep).some(part => part === '..')) return undefined
    return relativePath === '' ? this.stagingRoot : join(this.stagingRoot, ...relativePath.split(posix.sep))
  }

  /** The base snapshot path for a relative POSIX path. */
  private sourcePathFor(relativePath: string): string | undefined {
    const path = this.logicalPathFor(relativePath)
    return existsSync(path) ? path : undefined
  }

  /** List the entries of one relative directory, merging base and staged. */
  private listEntries(relativePath: string): LogicalEntry[] {
    const entries = new Map<string, LogicalEntry>()
    const prefix = relativePath === '' ? '' : `${relativePath}/`
    for (const [path, entry] of this.baseIndex ?? []) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      if (rest === '' || rest.includes('/')) continue
      if (this.isDeletedOrUnderDeleted(path)) continue
      entries.set(rest, { name: rest, path: this.logicalPathFor(path), relative: path, kind: entry.kind })
    }
    const staged = this.stagingPathFor(relativePath)
    if (staged !== undefined && existsSync(staged) && statSync(staged).isDirectory()) {
      for (const name of readdirSync(staged).sort()) {
        const childRelative = relativePath === '' ? name : `${relativePath}/${name}`
        if (this.isDeletedOrUnderDeleted(childRelative)) continue
        const child = join(staged, name)
        const stats = lstatSync(child)
        if (isWhiteout(stats)) continue
        const kind = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file'
        entries.set(name, { name, path: this.logicalPathFor(childRelative), relative: childRelative, kind })
      }
    }
    return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** Whether the logical view reports a directory at a relative path. */
  private logicalIsDirectory(relativePath: string): boolean {
    const base = this.baseIndex?.get(relativePath)
    if (base?.kind === 'directory') return true
    const staged = this.stagingPathFor(relativePath)
    return staged !== undefined && existsSync(staged) && statSync(staged).isDirectory()
  }

  /** Materialize a baseline object into the staging delta so it can be renamed. */
  private copyUp(relativePath: string): void {
    const staged = this.stagingPathFor(relativePath)
    if (staged === undefined || existsSync(staged)) return
    const source = this.sourcePathFor(relativePath)
    if (source === undefined) return
    mkdirSync(dirname(staged), { recursive: true })
    cpSync(source, staged, { recursive: true, force: true, errorOnExist: false })
  }

  /** Record a materialized staged object (and its synthesized ancestors). */
  private recordStaged(relativePath: string, kind: StagedKind): void {
    this.staged.set(relativePath, kind)
    let current = relativePath
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'))
      if (!this.staged.has(current)) this.staged.set(current, 'directory')
    }
  }

  /** Drop staged records at or under a relative path. */
  private forgetStagedSubtree(relativePath: string): void {
    const prefix = relativePath === '' ? '' : `${relativePath}/`
    for (const key of [...this.staged.keys()]) {
      if (key === relativePath || key.startsWith(prefix)) this.staged.delete(key)
    }
  }

  /** Move staged records from one relative path to another. */
  private moveStaged(fromRelative: string, toRelative: string): void {
    const moved = new Map<string, StagedKind>()
    const prefix = `${fromRelative}/`
    for (const [key, kind] of this.staged) {
      if (key === fromRelative) moved.set(toRelative, kind)
      else if (key.startsWith(prefix)) moved.set(`${toRelative}/${key.slice(prefix.length)}`, kind)
    }
    this.forgetStagedSubtree(fromRelative)
    for (const [key, kind] of moved) this.recordStaged(key, kind)
  }

  /** Record a deletion marker for a path. */
  private markDeleted(relativePath: string): void {
    this.deletions.add(relativePath)
  }

  /** Remove deletion markers on a path and all of its ancestors. */
  private clearDeletions(relativePath: string): void {
    this.deletions.delete(relativePath)
    let current = relativePath
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'))
      this.deletions.delete(current)
    }
  }

  /** Whether a path is deleted, or is a descendant of a deleted directory. */
  private isDeletedOrUnderDeleted(relativePath: string): boolean {
    if (this.deletions.has(relativePath)) return true
    let current = relativePath
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'))
      if (this.deletions.has(current)) return true
    }
    return false
  }
}

/** The digest of a logical path list, used for idempotency checks. */
export function logicalPathDigest(paths: readonly string[]): string {
  return digestOf([...paths].sort())
}
