/**
 * Linux process-sandbox provider. It selects the Linux runtime backend through
 * the Platform Abstraction Layer (`SandboxPal`) and delegates confinement to
 * its runner chain (bubblewrap, with the Landlock launcher as the fallback). A
 * host with no usable runner fails closed rather than returning the original
 * argv.
 *
 * The provider also owns the workspace-overlay registry: a workspace's command
 * paths register their delta layer so the generic `ctx.sandbox.confine` call
 * (which the harness shell/subprocess executors make) runs against the overlay.
 * @module dsh-sandbox-linux
 */

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launcherPath as landlockLauncherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPal } from './pal/index.ts'
import type { CapabilityReport, CapabilityStatus, SandboxCapability } from './pal/index.ts'
import {
  cgroupAvailable,
  ensureSeccompFilter,
  networkEnforced,
  probeOverlaySupport,
  seccompAvailable,
  seccompWrapper,
  DEFAULT_MASK_PATHS,
  DEFAULT_PROC_MASK_PATHS,
  DEFAULT_READONLY_PATHS,
  DEFAULT_READONLY_ROOTS,
  DEFAULT_TMPFS_ROOTS,
} from './runtime/index.ts'
import type { OverlaySpec, RuntimeOptions } from './runtime/index.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  DENIAL_SIGNATURES,
  PLATFORM_BACKENDS,
  RUNNER_FAILURE_RULES,
  PlatformBackend,
  backendIdForPlatform,
} from './backends.ts'
import type { BackendDeps, Runner, SandboxInternals } from './backends.ts'
import { bwrapProfileArgs, landlockProfileArgs } from './profiles.ts'

export type { SandboxInternals } from './backends.ts'

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * Override the runner argv; bwrap-compatible profile arguments are appended. A
   * non-empty override asserts full enforcement and skips built-in selection and
   * probing. A runner that starts but refuses its profile must be identifiable by
   * {@link runnerFailureSignatures}. Consumers classify a spawn rejection only after
   * confirming the workdir is usable. `ENOENT` or `EACCES` identifies the runner when
   * `error.path` equals argv[0] and `error.syscall` is `spawn` or `spawn <runner>`, or
   * when `error.path` is absent and `error.syscall` is exactly `spawn <runner>`.
   */
  runnerCommand?: string[]
  /**
   * Case-insensitive stderr substrings emitted when a configured
   * {@link runnerCommand} refuses its profile before executing the wrapped
   * command. Required and non-empty with `runnerCommand`; rejected without
   * it. Each entry is a non-empty, single-line, case-insensitive substring
   * covering the executable runner's own failure dialect.
   */
  runnerFailureSignatures?: string[]
  /** Positive timeout for each functional probe; zero would mean unbounded to Node. */
  probeTimeoutMs?: number
  /**
   * The explicit network mode (v2.3 §9). `OFFLINE` and `CONTROLLED_ONLINE`
   * create a private network namespace (all egress kernel-forced off);
   * `OBSERVED_ONLINE` shares egress and only reports that direct paths are not
   * covered. Defaults to `OBSERVED_ONLINE` so a plain deployment keeps
   * working while honestly advertising the boundary.
   */
  networkMode?: string
  /** Host directories exposed read-only inside the sandbox (minimal whitelist). */
  readonlyRoots?: string[]
  /** Host files/globs exposed read-only inside the sandbox. */
  readonlyPaths?: string[]
  /** Host sensitive paths masked (empty tmpfs for dirs, `/dev/null` for files). */
  maskPaths?: string[]
  /** Roots replaced by a private writable tmpfs under `workspace-write`. */
  tmpfsRoots?: string[]
  /** Dangerous `/proc` entries masked with an empty read-only file. */
  procMaskPaths?: string[]
  /** Whether the seccomp denylist baseline is applied. */
  seccompEnabled?: boolean
  /** An operator-supplied seccomp filter path (else a baseline is generated). */
  seccompFilterPath?: string
  /** When `true`, an unavailable filter refuses confined execution. */
  requireSeccomp?: boolean
  /** Whether cgroup v2 resource domains are created for staged executions. */
  cgroupEnabled?: boolean
  /** Memory cap as a fraction of host total (0..1). */
  memoryRatio?: number
  /** Maximum PIDs in a resource domain. */
  pidsMax?: number
  /** CPU quota as a percent of one core (`0` = unbounded). */
  cpuMax?: number
  /** The cgroup v2 mount root. */
  cgroupBase?: string
}

/**
 * A probe bound must be a positive finite number: Node treats
 * `spawnSync({ timeout: 0 })` as NO timeout, so an unvalidated 0 would
 * silently mean "unbounded" — the opposite of what the field promises.
 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`sandbox-local: ${name} must be a positive finite number`)
  }
}

/** Assemble the resolved runtime options from the schema-defaulted config. */
function buildRuntimeOptions(config: Config): RuntimeOptions {
  const networkMode = config.networkMode as string
  if (networkMode !== 'OFFLINE' && networkMode !== 'CONTROLLED_ONLINE' && networkMode !== 'OBSERVED_ONLINE') {
    throw new Error(`sandbox-local: networkMode must be OFFLINE, CONTROLLED_ONLINE, or OBSERVED_ONLINE (got '${networkMode}')`)
  }
  const filterPath = config.seccompFilterPath as string
  return {
    networkMode,
    readonlyRoots: config.readonlyRoots as string[],
    readonlyPaths: config.readonlyPaths as string[],
    maskPaths: config.maskPaths as string[],
    tmpfsRoots: config.tmpfsRoots as string[],
    procMaskPaths: config.procMaskPaths as string[],
    seccomp: {
      enabled: config.seccompEnabled as boolean,
      ...(filterPath === '' ? {} : { filterPath }),
      require: config.requireSeccomp as boolean,
    },
    limits: {
      enabled: config.cgroupEnabled as boolean,
      memoryRatio: config.memoryRatio as number,
      pidsMax: config.pidsMax as number,
      cpuMax: config.cpuMax as number,
      cgroupBase: config.cgroupBase as string,
    },
  }
}

/**
 * Linux process-sandbox provider. Registers as `ctx.sandbox`. Selects a
 * {@link PlatformBackend} through `SandboxPal`, owns the workspace-overlay
 * registry, and caches the one-time probes for its lifetime.
 */
export class LinuxSandboxProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    runnerCommand: z.array(z.string()).default([]),
    runnerFailureSignatures: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
    networkMode: z.string().default('OBSERVED_ONLINE'),
    readonlyRoots: z.array(z.string()).default([...DEFAULT_READONLY_ROOTS]),
    readonlyPaths: z.array(z.string()).default([...DEFAULT_READONLY_PATHS]),
    maskPaths: z.array(z.string()).default([...DEFAULT_MASK_PATHS]),
    tmpfsRoots: z.array(z.string()).default([...DEFAULT_TMPFS_ROOTS]),
    procMaskPaths: z.array(z.string()).default([...DEFAULT_PROC_MASK_PATHS]),
    seccompEnabled: z.boolean().default(true),
    seccompFilterPath: z.string().default(''),
    requireSeccomp: z.boolean().default(false),
    cgroupEnabled: z.boolean().default(true),
    memoryRatio: z.number().default(0.75),
    pidsMax: z.natural().default(8_192),
    cpuMax: z.natural().default(0),
    cgroupBase: z.string().default('/sys/fs/cgroup'),
  })

  /** Test hook (mirrors the bash executors' `internals`). */
  internals: SandboxInternals = {}

  /** The resolved runtime isolation options (read-only). */
  get runtimeOptions(): RuntimeOptions {
    return this.runtime
  }

  private readonly runnerCommand: string[] | undefined
  private readonly configuredRunnerFailureSignatures: string[]
  private readonly probeTimeoutMs: number
  /** The resolved runtime isolation options (minimal root, masking, network, seccomp, limits). */
  private readonly runtime: RuntimeOptions
  /** The directory generated seccomp baselines are written under. */
  private readonly seccompDir: string
  /** Lazily built PAL registry; undefined until the first confined wrap needs it. */
  private pal: SandboxPal<PlatformBackend> | undefined
  /** Cached overlay-support verdict (bwrap overlays are a per-host fact). */
  private overlaySupport: boolean | undefined
  /**
   * Overlay layers registered per canonical workspace root. A workspace's
   * command paths register their delta layer here so the generic
   * `ctx.sandbox.confine` call (which the harness shell/subprocess executors
   * make) runs against the overlay without the executor needing to know.
   */
  private readonly overlays = new Map<string, OverlaySpec>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const runner = config.runnerCommand as string[]
    const runnerFailureSignatures = config.runnerFailureSignatures as string[]
    if (runner.length === 0 && runnerFailureSignatures.length > 0) {
      throw new Error('sandbox-local: runnerFailureSignatures requires runnerCommand')
    }
    if (runner.length > 0 && runnerFailureSignatures.length === 0) {
      throw new Error('sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry')
    }
    if (runnerFailureSignatures.some(signature => signature.trim().length === 0 || /[\r\n]/u.test(signature))) {
      throw new Error('sandbox-local: runnerFailureSignatures entries must be non-empty single-line strings')
    }
    this.runnerCommand = runner.length > 0 ? runner : undefined
    this.configuredRunnerFailureSignatures = runnerFailureSignatures
    this.probeTimeoutMs = config.probeTimeoutMs as number
    assertPositiveFinite('probeTimeoutMs', this.probeTimeoutMs)
    this.runtime = buildRuntimeOptions(config)
    this.seccompDir = join(tmpdir(), 'dsh-seccomp')
    ctx.effect(() => () => {
      this.overlays.clear()
    })
  }

  /**
   * Wrap `argv` for `policy` — the configured `runnerCommand` when present
   * (the operator's assertion, no probe), else the backend selected by host
   * platform, which wraps with its own runner dialect.
   *
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the wrapped argv plus the selected backend's enforcement completeness, denial
   *   signatures, and structured runner-failure rules; throws the fail-closed
   *   `SANDBOX_UNAVAILABLE` error when the platform has no usable backend.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (this.runnerCommand !== undefined) {
      const backendId = backendIdForPlatform(this.internals.platform ?? process.platform)
      return {
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy, this.runtime), '--', ...argv],
        ...(backendId === undefined ? {} : { backendId }),
        enforcement: 'full',
        denialSignatures: DENIAL_SIGNATURES.runnerCommand,
        runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }],
      }
    }
    const backend = this.palOf().backendFor(this.internals.platform ?? process.platform)
    if (backend === undefined) throw new SandboxUnavailableError(policy.mode)
    // The PAL probe is the availability gate; `confine` re-checks the same
    // cached verdict so a direct caller of the backend still fails closed.
    if (backend.probe() === 'unusable') throw new SandboxUnavailableError(policy.mode)
    return backend.confine(argv, policy)
  }

  /**
   * Wrap `argv` so the workspace root is an overlay (lower = the real root,
   * upper = the private delta layer). Only the Linux `bwrap` rung can express
   * this; a Landlock fallback and the configured `runnerCommand` fall back to
   * the plain {@link confine}. Callers check {@link overlaySupported} first so
   * the fallback and the chosen path stay consistent.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @param overlay - the writable upper and work directories.
   * @returns the wrapped argv plus the selected backend's enforcement and dialect.
   */
  confineOverlay(argv: readonly string[], policy: SandboxPolicy, overlay: OverlaySpec): ConfinedArgv {
    const platform = this.internals.platform ?? process.platform
    const backend = this.palOf().backendFor(platform)
    if (backend === undefined) throw new SandboxUnavailableError(policy.mode)
    if (backend.probe() === 'unusable') throw new SandboxUnavailableError(policy.mode)
    const selected = backend.selected()
    if (this.runnerCommand !== undefined || selected === 'unusable' || selected.runner !== 'bwrap') {
      return this.confine(argv, policy)
    }
    return {
      argv: [...this.bwrapRunnerArgv(policy, overlay), '--', ...argv],
      backendId: backend.id,
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES.bwrap,
      runnerFailureRules: RUNNER_FAILURE_RULES.bwrap,
    }
  }

  /**
   * Whether this host can execute commands through a bwrap overlay (the bwrap
   * rung with working overlayfs). The verdict is cached for the provider
   * lifetime; a false verdict means callers must use the copy-based fallback.
   * @returns `true` when overlays are usable here.
   */
  overlaySupported(): boolean {
    if ((this.internals.platform ?? process.platform) !== 'linux') return false
    if (this.runnerCommand !== undefined) return false
    return this.overlaySupport ??= probeOverlaySupport(this.probeTimeoutMs)
  }

  /**
   * Register the overlay layer for one workspace root. Every subsequent
   * `confine` call whose policy root matches runs the workspace root as an
   * overlay, so a shell/subprocess executor keeps calling `ctx.sandbox.confine`
   * while actually writing to the delta layer. Idempotent per root.
   * @param workspaceRoot - the real workspace root.
   * @param overlay - the writable upper and work directories.
   */
  registerOverlay(workspaceRoot: string, overlay: OverlaySpec): void {
    this.overlays.set(resolve(workspaceRoot), overlay)
  }

  /**
   * Forget a workspace root's overlay (a disposed branch's delta is gone).
   * @param workspaceRoot - the real workspace root.
   */
  unregisterOverlay(workspaceRoot: string): void {
    this.overlays.delete(resolve(workspaceRoot))
  }

  /**
   * The overlay for a policy, or `undefined` when none is registered, the mode
   * cannot overlay, or the registered layer no longer exists (a stale entry is
   * ignored rather than failing the command).
   */
  private overlayFor(policy: SandboxPolicy): OverlaySpec | undefined {
    if (policy.mode !== 'workspace-write') return undefined
    const overlay = this.overlays.get(resolve(policy.workspaceRoot))
    if (overlay === undefined) return undefined
    if (!existsSync(overlay.upper) || !existsSync(overlay.work)) return undefined
    return overlay
  }

  /**
   * Probe the backend that serves a host platform, for the control plane's
   * capability gate. This is a per-host fact; the underlying PAL verdict is
   * cached for the provider's lifetime.
   * @param hostPlatform - a `process.platform` value (`linux`).
   * @returns the capability report, or `unusable` when no backend can confine here.
   */
  reportForHostPlatform(hostPlatform: string): CapabilityReport | 'unusable' {
    const backend = this.palOf().backendFor(hostPlatform)
    if (backend === undefined) return 'unusable'
    return backend.probe()
  }

  /**
   * Build the PAL registry once, after `internals` is final: the provider
   * assigns `internals` after plugin load, so the registry and its backends
   * read the live object through {@link BackendDeps.internals} at call time.
   */
  private palOf(): SandboxPal<PlatformBackend> {
    if (this.pal !== undefined) return this.pal
    const deps: BackendDeps = {
      internals: () => this.internals,
      probeTimeoutMs: this.probeTimeoutMs,
      landlockLauncher: () => this.landlockLauncher(),
      runnerArgv: (runner, policy) => this.runnerArgv(runner, policy),
      runtimeCapabilities: () => this.runtimeCapabilities(),
    }
    const pal = new SandboxPal<PlatformBackend>()
    for (const { id, platform } of PLATFORM_BACKENDS) pal.register(new PlatformBackend(id, platform, deps))
    this.pal = pal
    return pal
  }

  /** The selected rung's runner invocation (program + profile arguments) for one policy. */
  private runnerArgv(runner: Runner, policy: SandboxPolicy): string[] {
    switch (runner) {
      case 'bwrap': return this.bwrapRunnerArgv(policy, this.overlayFor(policy))
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      default: return assertNever(runner)
    }
  }

  /**
   * The bwrap runner argv for one policy: the hardened profile plus, when the
   * seccomp baseline is enabled, a bash wrapper that opens the filter on fd 9
   * and execs `bwrap --seccomp 9`. A required-but-unavailable filter throws so
   * the execution fails closed rather than running without the baseline. When
   * `overlay` is given the workspace root is mounted as an overlay.
   */
  private bwrapRunnerArgv(policy: SandboxPolicy, overlay?: OverlaySpec): string[] {
    const profile = bwrapProfileArgs(policy, this.runtime, overlay)
    const seccomp = this.resolveSeccomp()
    if (seccomp === undefined) return ['bwrap', ...profile]
    return seccompWrapper(seccomp, ['bwrap', ...profile, '--seccomp', '9'])
  }

  /**
   * Resolve the seccomp filter path, or `undefined` when disabled/degraded.
   * Throws when the baseline is required but cannot be provided.
   */
  private resolveSeccomp(): string | undefined {
    if (!this.runtime.seccomp.enabled) return undefined
    const resolution = ensureSeccompFilter(this.runtime.seccomp, this.seccompDir)
    if (resolution.ok) return resolution.path
    if (this.runtime.seccomp.require) throw new Error(`sandbox-local: ${resolution.reason}`)
    return undefined
  }

  /**
   * Capability overrides the configured runtime actually provides, merged into
   * the bwrap capability report. Honest about the limits: `resourceLimits` is
   * `partial` because domains are applied by the staged executor, not by every
   * `confine` call.
   */
  private runtimeCapabilities(): Partial<Record<SandboxCapability, CapabilityStatus>> {
    const syscallPolicy: CapabilityStatus = this.runtime.seccomp.enabled
      && seccompAvailable(this.runtime.seccomp, this.seccompDir)
      ? 'enforced'
      : 'absent'
    return {
      networkControl: networkEnforced(this.runtime.networkMode) ? 'enforced' : 'partial',
      syscallPolicy,
      resourceLimits: cgroupAvailable(this.runtime.limits.cgroupBase) ? 'partial' : 'absent',
    }
  }

  /** The Landlock launcher to probe and exec (test hook over the resolved one). */
  private landlockLauncher(): string {
    return this.internals.landlockLauncher ?? landlockLauncherPath()
  }
}

export default LinuxSandboxProvider
