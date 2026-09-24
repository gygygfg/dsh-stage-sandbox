/**
 * A candidate workspace: a private, disposable logical view of a real
 * workspace root. Reads see the staged version once it is materialized; writes
 * land only in the staging tree. Freezing turns the view into an immutable
 * candidate; publishing applies it to the real root under CAS. The real
 * workspace is never written until publication.
 *
 * This class is the file-level facade over {@link LogicalWorkspace}: it adds
 * the candidate-facing `freeze`/`changes` surface while the logical namespace
 * owns deletion markers, directory merge, and corruption detection.
 * @module dsh-sandbox-linux/candidate/workspace
 */

import { rmSync } from 'node:fs'
import type { CandidateRef, CandidateScope } from '../control/records.ts'
import { LogicalWorkspace } from '../workspace/logical.ts'
import type { CorruptionRecord, LogicalEntry, LogicalRead, LogicalState } from '../workspace/types.ts'
import type { FsImpact } from './impact.ts'
import type { ManifestEntry } from './manifest.ts'
import { freezeCandidate } from './freeze.ts'

/** The inputs for one candidate workspace. */
export interface CandidateWorkspaceOptions {
  /** The real workspace root the overlay is based on. */
  readonly baseRoot: string
  /** Parent directory the private overlay is created under; defaults to the OS temp dir. */
  readonly candidateParent?: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  /** The evidence pointer recorded on impact records. */
  readonly evidenceId?: string
  /** Whether the staging tree is a delta (copy-on-write); defaults to `true`. */
  readonly copyOnWrite?: boolean
}

/**
 * One private logical view of a workspace root. A workspace manager keys
 * instances by branch and workspace; each instance owns one staging directory
 * that is removed on dispose.
 */
export class CandidateWorkspace {
  /** The real workspace root. */
  readonly baseRoot: string
  /** The private staging root (the "overlay"). */
  readonly root: string
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  private readonly logical: LogicalWorkspace

  /**
   * @param options - the base root, overlay parent, scope, and evidence pointer.
   */
  constructor(options: CandidateWorkspaceOptions) {
    this.baseRoot = options.baseRoot
    this.scope = options.scope
    this.logical = new LogicalWorkspace({
      baseRoot: options.baseRoot,
      scope: options.scope,
      ...(options.candidateParent === undefined ? {} : { stagingParent: options.candidateParent }),
      ...(options.evidenceId === undefined ? {} : { evidenceId: options.evidenceId }),
      ...(options.copyOnWrite === undefined ? {} : { copyOnWrite: options.copyOnWrite }),
    })
    this.root = this.logical.stagingRoot
  }

  /** Whether the overlay has been copied from the base. */
  get materialized(): boolean {
    return this.logical.materialized
  }

  /** The monotonic staged revision. */
  get stagedRevision(): number {
    return this.logical.stagedRevision
  }

  /** Whether the staging tree is a delta rather than a full copy. */
  get isCopyOnWrite(): boolean {
    return this.logical.isCopyOnWrite
  }

  /** The base version the logical view was generated against. */
  baseVersion(): string {
    return this.logical.baseVersion()
  }

  /** The base manifest captured at materialization, or `null` before it. */
  get base() {
    return this.logical.base
  }

  /**
   * Copy the base workspace into the staging tree once. After this call every
   * read and write sees the staged view, so it is the single consistent view.
   */
  materialize(): void {
    this.logical.materialize()
  }

  /**
   * The POSIX-relative path of a real path under the base root, or `undefined`
   * when outside. A path already inside the staging tree maps to itself.
   * @param realPath - the real absolute path.
   * @returns the relative path, or `undefined`.
   */
  relativeFor(realPath: string): string | undefined {
    return this.logical.relativeFor(realPath)
  }

  /**
   * Map a real absolute path under the base root to its staging path. The
   * mapping is idempotent: an already-staged path maps to itself.
   * @param realPath - the real absolute path.
   * @returns the staging path, or `undefined` when outside the base root.
   */
  pathFor(realPath: string): string | undefined {
    return this.logical.pathFor(realPath)
  }

  /**
   * Map a staging path back to the real path it represents.
   * @param stagingPath - the staging absolute path.
   * @returns the real path, or `undefined` when outside the staging tree.
   */
  realPathFor(stagingPath: string): string | undefined {
    return this.logical.realPathFor(stagingPath)
  }

  /** The logical state of a path, or `undefined` when outside the workspace. */
  stateOf(realPath: string): LogicalState | undefined {
    return this.logical.stateOf(realPath)
  }

  /** A structured logical read. */
  read(realPath: string): LogicalRead {
    return this.logical.read(realPath)
  }

  /** A directory's logical entries. */
  list(realPath: string): readonly LogicalEntry[] {
    return this.logical.list(realPath)
  }

  /**
   * Read a real file through the logical view. A deleted or corrupted path
   * returns `undefined` rather than falling back to the real disk.
   * @param realPath - the real absolute path.
   * @returns the file text, or `undefined`.
   */
  readText(realPath: string): string | undefined {
    return this.logical.readText(realPath)
  }

  /**
   * Write a real file through the staging tree.
   * @param realPath - the real absolute path.
   * @param content - the text content.
   */
  writeText(realPath: string, content: string): void {
    const result = this.logical.writeText(realPath, content)
    if (result.kind !== 'ok') throw new Error(`candidate workspace: cannot write '${realPath}': ${result.kind}`)
  }

  /** Create a directory in the logical view. */
  mkdir(realPath: string): void {
    const result = this.logical.mkdir(realPath)
    if (result.kind !== 'ok') throw new Error(`candidate workspace: cannot create directory '${realPath}': ${result.kind}`)
  }

  /** Remove a path in the logical view, recording a persistent deletion marker. */
  remove(realPath: string, options: { recursive?: boolean } = {}): void {
    const result = this.logical.remove(realPath, options)
    if (result.kind !== 'ok') throw new Error(`candidate workspace: cannot remove '${realPath}': ${result.kind}`)
  }

  /** Rename a path in the logical view. */
  rename(from: string, to: string): void {
    const result = this.logical.rename(from, to)
    if (result.kind !== 'ok') throw new Error(`candidate workspace: cannot rename '${from}' to '${to}': ${result.kind}`)
  }

  /** Replace a path's object type. */
  replaceType(realPath: string, kind: 'file' | 'directory'): void {
    const result = this.logical.replaceType(realPath, kind)
    if (result.kind !== 'ok') throw new Error(`candidate workspace: cannot replace type of '${realPath}': ${result.kind}`)
  }

  /** Whether a live object exists in the logical view. */
  exists(realPath: string): boolean {
    return this.logical.exists(realPath)
  }

  /**
   * Whether the logical view currently has a distinct version of a real path.
   * @param realPath - the real absolute path.
   * @returns `true` when the path is staged.
   */
  hasOverlay(realPath: string): boolean {
    const state = this.logical.stateOf(realPath)
    return state?.kind === 'staged-file' || state?.kind === 'staged-directory'
  }

  /** The integrity check: corrupted paths block publication. */
  integrity(): { readonly ok: boolean; readonly corrupted: readonly CorruptionRecord[] } {
    return this.logical.integrity()
  }

  /**
   * The overlay writable layer for command execution: the staging delta is the
   * overlay upper, so command writes and tool edits share one store. The
   * workspace's base root is the overlay lower.
   * @returns the overlay upper (the staging root) and an empty work directory.
   */
  overlaySpec(): { upper: string; work: string } {
    return this.logical.overlaySpec()
  }

  /**
   * Reconcile an overlay command's effects (whiteouts) into deletion markers.
   */
  reconcileOverlay(): void {
    this.logical.reconcileOverlay()
  }

  /**
   * Mirror the staging delta into a directory (a resident instance's inbox) and
   * return the deleted paths.
   * @param destination - the host directory to populate.
   * @returns the POSIX-relative deleted paths.
   */
  exportDelta(destination: string): string[] {
    return this.logical.exportDelta(destination)
  }

  /** The impact of the logical view relative to the base manifest. */
  changes(): FsImpact[] {
    return this.logical.changes()
  }

  /**
   * Freeze the logical view into a candidate. The caller must check
   * {@link integrity} first; a corrupted view must not be frozen for publish.
   * @returns the candidate reference and its filesystem impact.
   */
  freeze(): { candidate: CandidateRef; impact: FsImpact[] } {
    this.logical.materialize()
    const entries = this.logical.entries()
    const impact = this.logical.changes()
    const candidate = freezeCandidate({
      path: this.root,
      baseVersion: this.logical.baseVersion(),
      scope: this.scope,
      entries,
    })
    return { candidate, impact }
  }

  /**
   * The manifest for selectively publishing only the given real paths, with
   * the rest of the staged changes left pending.
   * @param realPaths - the real absolute paths to apply.
   * @returns the subset manifest.
   */
  subsetEntries(realPaths: readonly string[]): ManifestEntry[] {
    return this.logical.subsetEntries(realPaths.map(path => this.logical.relativeFor(path) ?? path))
  }

  /**
   * Revert one path's staged change to the base (a rejected file).
   * @param realPath - the real absolute path.
   */
  revert(realPath: string): void {
    const relative = this.logical.relativeFor(realPath)
    if (relative === undefined) throw new Error(`candidate workspace: cannot revert '${realPath}': outside the workspace`)
    this.logical.revertPath(relative)
  }

  /**
   * Re-base the logical view after a selective publication.
   * @param realPaths - the real absolute paths that were published.
   */
  reBase(realPaths: readonly string[]): void {
    this.logical.reBase(realPaths.map(path => this.logical.relativeFor(path) ?? path))
  }

  /** Remove the staging directory. */
  dispose(): void {
    this.logical.dispose()
  }
}

/**
 * Remove a path that may be a symlink, a file, or a directory without
 * following a link.
 * @param path - the path to remove.
 */
export function removeStagedPath(path: string): void {
  rmSync(path, { recursive: true, force: true })
}
