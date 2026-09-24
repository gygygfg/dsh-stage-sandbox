/**
 * `StagedShellExecutor`: a dry-run shell executor. Each foreground or
 * background command runs against the workspace candidate overlay instead of
 * the real workspace, so its file effects are staged and the real workspace
 * changes only when the overlay is applied under CAS.
 *
 * When the host can mount a bwrap overlay, the command runs at the real
 * workspace path with the branch's delta as the overlay upper (registered with
 * the provider, so the inherited executor's `ctx.sandbox.confine` call builds
 * the overlay); otherwise the command is redirected into the full-copy staging
 * tree as before. It extends the sandboxing executor, inheriting its
 * confinement, runner-failure classification, and denial reporting.
 * @module dsh-sandbox-linux/shell/staged-shell
 */

import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { Config as SandboxBashConfig } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { restorePaths } from '../util/conceal.ts'
import { SystemdFacade, parseSystemctl } from '../runtime/systemd.ts'
import type { LinuxSandboxProvider } from '../index.ts'
import type {} from '../stage/workspace-service.ts'

/**
 * Plugin config: the sandboxing executor's knobs verbatim. The sandbox default
 * and workspace root come from `ctx.sandboxPolicy`; the overlay comes from
 * `ctx.sandboxWorkspace`.
 */
export type Config = SandboxBashConfig

/**
 * Staged bash executor. Registers as `ctx.shell` in place of the sandboxing
 * executor and redirects each confined command into the workspace overlay.
 */
export class StagedShellExecutor extends SandboxBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'sandboxWorkspace']

  /** In-session systemd facade state (units started/stopped/enabled). */
  private readonly facade = new SystemdFacade()

  /**
   * @param ctx - the plugin context.
   * @param config - the inherited local executor config.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
  }

  /** @inheritdoc */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return super.resolve(request)
  }

  /** @inheritdoc */
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const staged = this.stagedSpec(spec)
    // A standalone systemctl/journalctl is answered by the facade: the sandbox
    // has no real systemd/D-Bus, so the facade synthesizes output and state.
    const invocation = parseSystemctl(staged.command)
    if (invocation !== undefined) return this.systemdResult(spec, staged, invocation)
    if (this.shouldUseResident(spec, staged)) return this.runResident(spec, staged)
    const result = await super.run(staged)
    this.reconcile(staged)
    return this.restore(staged, result)
  }

  /** Answer a systemctl/journalctl invocation from the in-session facade. */
  private systemdResult(spec: ShellExecSpec, staged: ShellExecSpec, invocation: ReturnType<typeof parseSystemctl>): ShellRunResult {
    const result = this.facade.exec(invocation as NonNullable<typeof invocation>)
    const policy = staged.sandboxPolicy
    return {
      exitCode: result.code,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: result.stdout, truncated: false },
      stderr: { text: result.stderr, truncated: false },
      ...(policy === undefined ? {} : { sandbox: { mode: policy.mode, denied: false, enforcement: 'full' } }),
    }
  }

  /**
   * Rewrite staging paths in the command output to the real workspace paths, so
   * the model never sees the sandbox-internal tree.
   */
  private restore(staged: ShellExecSpec, result: ShellRunResult): ShellRunResult {
    const policy = staged.sandboxPolicy
    if (policy === undefined) return result
    const workspace = this.ctx.sandboxWorkspace.workspaceContaining(policy.workspaceRoot)
    if (workspace === undefined) return result
    const rewrite = (output: ShellRunResult['stdout']): ShellRunResult['stdout'] =>
      output.text.includes(workspace.root)
        ? { ...output, text: restorePaths(output.text, [{ from: workspace.root, to: workspace.baseRoot }]) }
        : output
    return { ...result, stdout: rewrite(result.stdout), stderr: rewrite(result.stderr) }
  }

  /** Whether a foreground command can go through the resident server. */
  private shouldUseResident(spec: ShellExecSpec, staged: ShellExecSpec): boolean {
    if (spec.stdin !== undefined) return false
    const policy = staged.sandboxPolicy
    if (policy === undefined || policy.mode === 'danger-full-access') return false
    if (!this.ctx.sandboxWorkspace.residentEnabled) return false
    return this.provider()?.overlaySupported() === true
  }

  /** Run a foreground command in the persistent resident server. */
  private async runResident(spec: ShellExecSpec, staged: ShellExecSpec): Promise<ShellRunResult> {
    const policy = staged.sandboxPolicy as SandboxExecutionPolicy
    const result = await this.ctx.sandboxWorkspace.runResident({
      workspaceRoot: policy.workspaceRoot,
      command: staged.command,
      cwd: staged.workdir,
      env: { ...(spec.env ?? {}) },
      timeoutMs: spec.timeoutMs,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
    const stdout = result.stdout
    const stderr = result.stderr
    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: result.timedOut,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: stdout, truncated: false },
      stderr: { text: stderr, truncated: false },
      sandbox: { mode: policy.mode, denied: false, enforcement: 'full' },
    }
  }

  /** @inheritdoc */
  override start(spec: ShellExecSpec): ShellProcess {
    const staged = this.stagedSpec(spec)
    const process = super.start(staged)
    const root = this.overlayRoot(staged)
    if (root !== undefined) {
      const workspace = this.ctx.sandboxWorkspace.workspaceFor(root)
      void process.done.finally(() => workspace.reconcileOverlay())
    }
    return process
  }

  /**
   * Redirect a confined spec into the workspace overlay. `danger-full-access`
   * and specs without a policy run unchanged.
   * @param spec - the resolved spec.
   * @returns the spec whose workdir and workspace root point at the overlay.
   */
  protected stagedSpec(spec: ShellExecSpec): ShellExecSpec {
    const policy = spec.sandboxPolicy
    if (policy === undefined || policy.mode === 'danger-full-access') return spec
    const workspace = this.ctx.sandboxWorkspace.workspaceFor(policy.workspaceRoot)
    workspace.materialize()
    // Record the command so its danger level accounts for package installs,
    // downloads, and system modifications that leave no file change.
    this.ctx.sandboxWorkspace.recordCommand(policy.workspaceRoot, { command: spec.command })
    // Overlay path: run at the real root and let `ctx.sandbox.confine` build
    // the overlay from the registered layer.
    if (workspace.isCopyOnWrite && this.provider()?.overlaySupported() === true) {
      this.provider()?.registerOverlay(policy.workspaceRoot, workspace.overlaySpec())
      return { ...spec, sandboxPolicy: policy }
    }
    // Fallback: the staging tree is a full private copy, so redirect into it.
    const workdir = workspace.pathFor(spec.workdir) ?? spec.workdir
    const stagedPolicy: SandboxExecutionPolicy = { ...policy, workspaceRoot: workspace.root }
    return { ...spec, workdir, sandboxPolicy: stagedPolicy }
  }

  /** Reconcile a foreground command's overlay effects into the logical view. */
  private reconcile(spec: ShellExecSpec): void {
    const root = this.overlayRoot(spec)
    if (root !== undefined) this.ctx.sandboxWorkspace.workspaceFor(root).reconcileOverlay()
  }

  /** The real workspace root when this spec ran through an overlay, else `undefined`. */
  private overlayRoot(spec: ShellExecSpec): string | undefined {
    const policy = spec.sandboxPolicy
    if (policy === undefined || policy.mode === 'danger-full-access') return undefined
    if (this.provider()?.overlaySupported() !== true) return undefined
    // The fallback redirects into the staging tree, whose policy root IS a
    // staging path — that is not an overlay.
    if (this.ctx.sandboxWorkspace.isStagingPath(policy.workspaceRoot)) return undefined
    return policy.workspaceRoot
  }

  /** The sandbox provider, when mounted. */
  private provider(): LinuxSandboxProvider | undefined {
    return this.ctx.get('sandbox', false) as LinuxSandboxProvider | undefined
  }
}

export default StagedShellExecutor
