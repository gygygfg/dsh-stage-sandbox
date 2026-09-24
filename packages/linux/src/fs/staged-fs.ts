/**
 * `StagedFileSystem`: a dry-run filesystem. Reads resolve through the session
 * workspace's candidate overlay once a mutation has materialized it; writes and
 * edits land only in the overlay. The real workspace changes only when the
 * workspace candidate is applied under CAS.
 *
 * The overlay is keyed by the per-call policy's workspace root. A write under
 * `read-only` is refused; `danger-full-access` bypasses staging entirely.
 * @module dsh-sandbox-linux/fs/staged-fs
 */

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '../stage/workspace-service.ts'

/**
 * Plugin config: the local backend's knobs verbatim. The sandbox default and
 * the workspace root are resolved per call from `ctx.sandboxPolicy`.
 */
export type Config = LocalConfig

/**
 * Staged filesystem provider. Registers as `ctx.fs` in place of the local
 * backend, injects `ctx.sandboxPolicy` and `ctx.sandboxWorkspace`, and routes
 * every mutation into the workspace candidate overlay.
 */
export class StagedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy', 'sandboxWorkspace']

  private readonly defaultMode: SandboxMode

  /**
   * @param ctx - the plugin context.
   * @param config - the local backend config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** The deployment default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Resolve a path, mapping workspace paths to the candidate overlay once it is
   * materialized so reads see the staged view. The displayed path stays the
   * real one.
   * @param path - the path to resolve.
   * @param opts - optional cwd and abort signal.
   * @returns the resolved target.
   */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const real = await super.resolve(path, opts)
    const workspace = this.ctx.sandboxWorkspace.workspaceFor(this.ctx.sandboxPolicy.resolve().workspaceRoot)
    if (!workspace.materialized) return real
    const overlayPath = workspace.pathFor(String(real.targetKey))
    if (overlayPath === undefined) return real
    // Once materialized, a workspace path always resolves to the logical view,
    // even when the staged object is absent or corrupted: a deleted path must
    // fail rather than fall back to the real file.
    const overlay = await super.resolve(overlayPath)
    return { targetKey: overlay.targetKey, displayPath: real.displayPath }
  }

  /** @inheritdoc */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return super.writeText(target, content, expected, signal)
    this.assertWritable(target, policy)
    const workspace = this.ctx.sandboxWorkspace.workspaceFor(policy.workspaceRoot)
    const wasMaterialized = workspace.materialized
    const staged = await this.stageTarget(target, policy, wasMaterialized ? undefined : expected)
    // After the first materialization the write is a conditional update on the
    // staged version, so concurrent edits cannot silently overwrite each other.
    return super.writeText(staged, content, wasMaterialized ? expected : undefined, signal)
  }

  /** @inheritdoc */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return super.editText(target, edit, expected, signal)
    this.assertWritable(target, policy)
    const workspace = this.ctx.sandboxWorkspace.workspaceFor(policy.workspaceRoot)
    const wasMaterialized = workspace.materialized
    const staged = await this.stageTarget(target, policy, wasMaterialized ? undefined : expected)
    return super.editText(staged, edit, wasMaterialized ? expected : undefined, signal)
  }

  /** Refuse a mutation the policy does not allow. */
  private assertWritable(target: FsTarget, policy: SandboxExecutionPolicy): void {
    if (policy.mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
  }

  /**
   * Materialize the overlay (validating any guard against the real file first)
   * and return the overlay target the mutation delegates to.
   */
  private async stageTarget(target: FsTarget, policy: SandboxExecutionPolicy, expected?: FsWriteIntent | { version: FsVersion }): Promise<FsTarget> {
    const workspace = this.ctx.sandboxWorkspace.workspaceFor(policy.workspaceRoot)
    const realPath = workspace.realPathFor(String(target.targetKey)) ?? String(target.targetKey)
    const overlayPath = workspace.pathFor(realPath)
    if (overlayPath === undefined) {
      throw new FsError(`cannot write "${target.displayPath}": path is outside the workspace root`, 'FS_SANDBOX_DENIED')
    }
    if (!workspace.materialized) {
      if (expected !== undefined) await this.assertGuard(realPath, expected)
      workspace.materialize()
    }
    const overlay = await super.resolve(overlayPath)
    return { targetKey: overlay.targetKey, displayPath: target.displayPath }
  }

  /** Validate a write/edit guard against the real file before the overlay copy. */
  private async assertGuard(realPath: string, expected: FsWriteIntent | { version: FsVersion }): Promise<void> {
    const real = await super.resolve(realPath)
    const info = await super.stat(real)
    if ('kind' in expected && expected.kind === 'createIfAbsent') {
      if (info !== undefined) throw new FsError(`cannot create "${realPath}": file already exists`, 'FS_NOT_OBSERVED')
      return
    }
    const version = 'kind' in expected ? expected.version : expected.version
    if (info === undefined || info.version !== version) {
      throw new FsError(`cannot write "${realPath}": file changed since it was observed`, 'FS_STALE_VERSION')
    }
  }
}

export default StagedFileSystem
