/**
 * Sandboxed subprocess runtime (v2.3). It replaces the plain local subprocess
 * provider so every process-based tool — filesystem search (ripgrep), background
 * jobs, persistent shells, terminals, and extension tools — runs through the
 * sandbox and reads the unified logical workspace instead of the real disk.
 *
 * A spawn is workspace-scoped when its working directory or an absolute path
 * argument falls under the policy workspace root. Workspace-scoped spawns are
 * redirected into the branch's staging tree and wrapped with `ctx.sandbox`;
 * everything else (language servers, MCP transports, harness internals) passes
 * through unchanged, so confinement never breaks an unrelated subsystem.
 *
 * A spawn whose policy root is already a staging tree, or whose argv is already
 * a confinement runner invocation, is passed through to avoid double wrapping.
 * @module dsh-sandbox-linux/subprocess/sandboxed-subprocess
 */

import { basename, isAbsolute, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LAUNCHER_BIN } from '@deepseek-ai/node-addon-system/landlock-run'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { planContainerCommand } from '../runtime/container.ts'
import type { LinuxSandboxProvider } from '../index.ts'
import type { CandidateWorkspace } from '../candidate/workspace.ts'
import type {} from '../stage/workspace-service.ts'

/** The workspace facts the redirect planner needs, kept minimal for testing. */
export interface RedirectWorkspace {
  /** The private staging root. */
  readonly root: string
  /** The POSIX-relative path of a real path, or `undefined` when outside. */
  relativeFor(path: string): string | undefined
  /** The staging path for a real path, or `undefined` when outside. */
  pathFor(path: string): string | undefined
  /** Populate the staging tree from the base snapshot. */
  materialize(): void
}

/** The inputs for planning a workspace redirect. */
export interface RedirectPlanInput {
  /** The requested argv. */
  readonly argv: readonly string[]
  /** The requested working directory. */
  readonly cwd: string
  /** The policy workspace root the spawn was resolved against. */
  readonly requestedRoot: string
  /** The resolved sandbox mode. */
  readonly mode: SandboxMode
  /** Whether a path is already inside a staging tree. */
  readonly isStagingPath: (path: string) => boolean
  /** The logical workspace for the policy root. */
  readonly workspace: RedirectWorkspace
  /** Wrap argv for the staged policy. */
  readonly confine: (argv: readonly string[], policy: SandboxPolicy) => { argv: readonly string[] }
  /**
   * Whether the caller already registered an overlay for the real workspace
   * root. When `true` the spawn runs at the real path (the provider's
   * `confine` builds the overlay) instead of being redirected into the staging
   * tree.
   */
  readonly overlay?: boolean
}

/**
 * Whether an argv is already a confinement runner invocation. The provider
 * wraps as `[runner, ...profile, '--', ...argv]`; a caller that pre-confined
 * (the terminal backend, the shell executor) must be unwrapped and re-confined
 * against the staged workspace rather than nested.
 * @param argv - the argv to inspect.
 * @returns `true` when argv[0] is a known runner.
 */
export function isConfinementRunner(argv: readonly string[]): boolean {
  const first = basename(argv[0] ?? '')
  if (first === 'bwrap') return true
  return first === basename(LAUNCHER_BIN)
}

/** The caller argv inside a confinement wrapper, or the argv unchanged. */
function innerArgv(argv: readonly string[]): readonly string[] {
  const separator = argv.indexOf('--')
  return separator === -1 ? argv : argv.slice(separator + 1)
}

/**
 * Plan the redirected argv and working directory for a workspace-scoped spawn,
 * or `undefined` when the spawn must pass through unchanged. The logic is pure
 * so it is testable without spawning a real process.
 * @param input - the requested spawn and its workspace facts.
 * @returns the redirected spawn inputs, or `undefined`.
 */
export function planWorkspaceRedirect(input: RedirectPlanInput): { argv: string[]; cwd: string } | undefined {
  if (input.mode === 'danger-full-access') return undefined
  if (input.isStagingPath(input.cwd)) return undefined
  if (input.isStagingPath(input.requestedRoot)) return undefined
  const workspace = input.workspace
  const effectiveArgv = isConfinementRunner(input.argv) ? innerArgv(input.argv) : input.argv
  const cwdInside = workspace.relativeFor(input.cwd) !== undefined
  const argvInside = effectiveArgv.some(argument => isAbsolute(argument) && workspace.relativeFor(argument) !== undefined)
  if (!cwdInside && !argvInside) return undefined
  workspace.materialize()
  if (input.overlay === true) {
    // Run at the real path; the registered overlay makes the provider mount it.
    const confined = input.confine(effectiveArgv, { mode: input.mode, workspaceRoot: input.requestedRoot })
    return { argv: [...confined.argv], cwd: input.cwd }
  }
  const stagedCwd = workspace.pathFor(input.cwd) ?? input.cwd
  const stagedArgv = effectiveArgv.map(argument => {
    if (!isAbsolute(argument)) return argument
    const staged = workspace.pathFor(argument)
    if (staged === undefined) return argument
    // Prefer a path relative to the staged cwd so tool output stays
    // workspace-relative rather than exposing the private staging root.
    const rel = relative(stagedCwd, staged)
    return rel === '' ? '.' : rel
  })
  const confined = input.confine(stagedArgv, { mode: input.mode, workspaceRoot: workspace.root })
  return { argv: [...confined.argv], cwd: stagedCwd }
}

/**
 * The sandbox-aware subprocess runtime. It extends the local runtime and only
 * changes the argv and working directory of workspace-scoped spawns.
 */
export class SandboxedSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['sandbox', 'sandboxPolicy', 'sandboxWorkspace']

  /**
   * @param ctx - the plugin context; `ctx.sandbox`, `ctx.sandboxPolicy`, and
   *   `ctx.sandboxWorkspace` must be mounted.
   */
  constructor(ctx: Context) {
    super(ctx)
  }

  /** @inheritdoc */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // Keep an AI-invoked container in the sandbox namespaces (podman/nerdctl).
    const argv = planContainerCommand(spec.argv)?.argv ?? spec.argv
    const redirect = this.redirect(argv, spec.cwd)
    if (redirect === undefined) return super.spawn(argv === spec.argv ? spec : { ...spec, argv: [...argv] })
    const handle = super.spawn({ ...spec, argv: redirect.argv, cwd: redirect.cwd })
    if (redirect.overlayUsed) void scheduleReconcile(handle.done, redirect.workspace)
    return handle
  }

  /** @inheritdoc */
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const argv = planContainerCommand(spec.argv)?.argv ?? spec.argv
    const redirect = this.redirect(argv, spec.cwd)
    if (redirect === undefined) return super.spawnTerminal(argv === spec.argv ? spec : { ...spec, argv: [...argv] })
    const terminal = super.spawnTerminal({ ...spec, argv: redirect.argv, cwd: redirect.cwd })
    if (redirect.overlayUsed) void terminal.then(handle => scheduleReconcile(handle.done, redirect.workspace))
    return terminal
  }

  /**
   * Compute the redirected argv and working directory for a workspace-scoped
   * spawn, or `undefined` when it must pass through unchanged.
   * @param argv - the requested argv.
   * @param cwd - the requested working directory.
   * @returns the redirected spawn inputs plus the workspace, or `undefined`.
   */
  private redirect(argv: readonly string[], cwd: string): { argv: string[]; cwd: string; workspace: CandidateWorkspace; overlayUsed: boolean } | undefined {
    const policy = this.ctx.sandboxPolicy.resolve()
    const workspace = this.ctx.sandboxWorkspace.branchFor(policy.workspaceRoot)
    const provider = this.ctx.get('sandbox', false) as LinuxSandboxProvider | undefined
    const overlayUsed = workspace.isCopyOnWrite && provider?.overlaySupported() === true
    if (overlayUsed) provider?.registerOverlay(policy.workspaceRoot, workspace.overlaySpec())
    const plan = planWorkspaceRedirect({
      argv,
      cwd,
      requestedRoot: policy.workspaceRoot,
      mode: policy.mode,
      isStagingPath: path => this.ctx.sandboxWorkspace.isStagingPath(path),
      workspace,
      confine: (confinedArgv, stagedPolicy) => this.ctx.sandbox.confine(confinedArgv, stagedPolicy),
      ...(overlayUsed ? { overlay: true } : {}),
    })
    return plan === undefined ? undefined : { ...plan, workspace, overlayUsed }
  }
}

/** Reconcile a finished overlay spawn's whiteouts into the logical view. */
function scheduleReconcile(done: Promise<unknown>, workspace: { reconcileOverlay(): void }): Promise<void> {
  return done.catch(() => {}).then(() => workspace.reconcileOverlay())
}

export default SandboxedSubprocessRuntime
