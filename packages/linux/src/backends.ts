/**
 * The Linux runtime backend for the local sandbox provider. It owns the
 * functionally probed runner chain (bubblewrap first, the Landlock launcher as
 * the unprivileged fallback) and reports the capability set the PAL contract
 * exposes. A host with no usable rung fails closed rather than returning the
 * original argv.
 * @module dsh-sandbox-linux/backends
 */

import { spawnSync } from 'node:child_process'
import { release } from 'node:os'
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  probe as defaultProbeLandlock,
} from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { CapabilityReport, CapabilityStatus, EnvironmentFingerprint, ExecutionValidation, RuntimeBackend, RuntimeBackendId, SandboxCapability } from './pal/index.ts'
import { environmentFingerprint, validateExecution } from './pal/probe.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The backend implementation's own version, bound into execution intents. */
const BACKEND_VERSION = '1'

/** One confinement runner the Linux chain can select. */
export type Runner = 'bwrap' | 'landlock'

/** The chain's verdict: which runner confines, and how completely it enforces. */
export type SelectedRunner = { runner: Runner; enforcement: SandboxEnforcement }

/**
 * Test hook: inject probe verdicts, a fake launcher, a platform, a chain, or
 * an execution validation without real runners. The provider owns the object;
 * a backend reads it through {@link BackendDeps.internals} at call time so an
 * assignment after plugin load is observed.
 */
export interface SandboxInternals {
  /** Replaces `process.platform` for chain selection (exercise the Linux chain from any host). */
  platform?: string
  /** Replaces the platform's chain wholesale. */
  chain?: readonly Runner[]
  /** Replaces the functional `bwrap` probe (the chain's first rung). */
  probeBwrap?: () => boolean
  /** Replaces the functional Landlock launcher probe (the chain's second rung). */
  probeLandlock?: (launcher: string) => SandboxEnforcement | 'unusable'
  /** Replaces the resolved `landlock-run` launcher path (a fake launcher script). */
  landlockLauncher?: string
  /** Replaces the actual-execution validation (create/read/modify/delete/dir/capture/cleanup). */
  probeExecution?: () => ExecutionValidation
  /** Replaces the measured environment fingerprint. */
  environment?: () => EnvironmentFingerprint
}

/**
 * The runner chain. Linux prefers `bwrap` (its mount profile is closest to the
 * mode vocabulary) over the Landlock launcher. The chain has two rungs, so it
 * is probed in order: the first usable rung confines.
 */
export const PLATFORM_CHAINS: Record<string, readonly Runner[]> = {
  linux: ['bwrap', 'landlock'],
}

/**
 * Enforcement completeness a rung claims when selected WITHOUT a probe. Both
 * govern every promised file effect by construction; the Landlock launcher is
 * only ever selected through its probe, whose report distinguishes full from
 * per-ABI-partial.
 */
export const STATIC_ENFORCEMENT: Record<Runner, SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
}

/**
 * The denial dialect each runner's kernel speaks — the case-insensitive stderr
 * substrings a denied file effect produces under it, carried on every wrap (the
 * seam's `ConfinedArgv.denialSignatures`).
 */
export const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<Runner | 'runnerCommand', readonly string[]>

/**
 * Runner-owned fatal diagnostics. Landlock has a versioned exit-125 plus
 * fatal-line launcher-failure contract; bubblewrap's current fatal paths exit 1
 * but its public contract does not reserve that status, so bwrap remains
 * signature-only. Keep the Landlock tuple aligned with the assembled snapshot
 * fixture.
 */
export const RUNNER_FAILURE_RULES = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  }],
} as const satisfies Record<Runner, readonly RunnerFailureRule[]>

/** Every capability absent — the base a runner profile overlays. */
const NO_CAPABILITIES: Record<SandboxCapability, CapabilityStatus> = {
  fileEffectPolicy: 'absent',
  isolation: 'absent',
  resourceLimits: 'absent',
  syscallPolicy: 'absent',
  fileTransactions: 'absent',
  fileIdentity: 'absent',
  reparsePoints: 'absent',
  networkControl: 'absent',
  integrity: 'absent',
  privilegeReduction: 'absent',
}

/**
 * What each runner can enforce, as the PAL capability report. Both govern the
 * mode's file effects; bwrap is the only one that adds namespace isolation.
 */
export const RUNNER_CAPABILITIES: Record<Runner, Record<SandboxCapability, CapabilityStatus>> = {
  bwrap: { ...NO_CAPABILITIES, fileEffectPolicy: 'enforced', isolation: 'partial', privilegeReduction: 'partial' },
  landlock: { ...NO_CAPABILITIES, fileEffectPolicy: 'enforced', privilegeReduction: 'partial' },
}

/** The host platform the Linux backend serves. */
export const PLATFORM_BACKENDS: readonly { id: RuntimeBackendId; platform: string }[] = [
  { id: 'linux', platform: 'linux' },
]

/**
 * The backend id that serves a `process.platform` value, for the operator
 * `runnerCommand` path that skips platform selection.
 * @param platform - a `process.platform` value.
 * @returns the backend id, or `undefined` when no backend serves the platform.
 */
export function backendIdForPlatform(platform: string): RuntimeBackendId | undefined {
  return PLATFORM_BACKENDS.find(entry => entry.platform === platform)?.id
}

/**
 * Probe whether `bwrap` can create the profile — including the seccomp wrapper
 * when enabled, so a host that cannot load the filter is reported unusable
 * rather than silently degrading. The provider's `runnerArgv` owns the flag
 * dialect, keeping the probe and real runs in lockstep.
 */
function defaultProbeBwrap(runnerArgv: (runner: Runner, policy: SandboxPolicy) => string[], timeoutMs: number): boolean {
  const [program, ...args] = [...runnerArgv('bwrap', { mode: 'read-only', workspaceRoot: '/' }), '--', 'true']
  if (program === undefined) return false
  const probe = spawnSync(program, args, { timeout: timeoutMs, stdio: 'ignore' })
  return probe.status === 0
}

/**
 * The provider-owned hooks a backend needs: the test-internals accessor, the
 * probe timeout, the resolved Landlock launcher, the runner argv builder, and
 * the runtime capability overrides.
 */
export interface BackendDeps {
  /** The provider's current test internals, read at call time. */
  internals(): SandboxInternals
  /** Positive probe timeout in milliseconds. */
  probeTimeoutMs: number
  /** The Landlock launcher to probe and exec (test hook over the resolved one). */
  landlockLauncher(): string
  /** The full runner argv for one policy. */
  runnerArgv(runner: Runner, policy: SandboxPolicy): string[]
  /**
   * Capability overrides the configured runtime actually provides (network
   * control, syscall policy, resource limits). The provider computes these
   * from its config and probes.
   */
  runtimeCapabilities(): Partial<Record<SandboxCapability, CapabilityStatus>>
}

/**
 * The Linux sandbox backend. `selected()` walks and caches the runner chain
 * once for the backend's lifetime; `probe()` projects that verdict into a PAL
 * capability report; `confine()` wraps argv with the selected runner's dialect.
 */
export class PlatformBackend implements RuntimeBackend {
  readonly id: RuntimeBackendId
  readonly platforms: readonly string[]
  /** The platform this backend's chain is looked up under. */
  private readonly platform: string
  /** Cached chain verdict; undefined until the first selection needs it. */
  private verdict: SelectedRunner | 'unusable' | undefined
  /** Cached actual-execution validation, keyed by the backend's lifetime. */
  private validation: ExecutionValidation | undefined
  /** Cached measured environment fingerprint. */
  private environment: EnvironmentFingerprint | undefined
  private readonly deps: BackendDeps

  constructor(id: RuntimeBackendId, platform: string, deps: BackendDeps) {
    this.id = id
    this.platforms = [platform]
    this.platform = platform
    this.deps = deps
  }

  /**
   * The platform's cached chain verdict.
   * @returns the selected runner and its enforcement, or `unusable`.
   */
  selected(): SelectedRunner | 'unusable' {
    return this.verdict ??= this.chainVerdict()
  }

  /**
   * Probe this host and report what the backend can enforce. The report
   * includes the measured environment fingerprint and the actual-execution
   * validation, so a capability verdict is bound to the deployment it was
   * measured in.
   * @returns the capability report, or `unusable` when no chain rung is usable.
   */
  probe(): CapabilityReport | 'unusable' {
    const selected = this.selected()
    if (selected === 'unusable') return 'unusable'
    const environment = this.environment ??= (this.deps.internals().environment ?? (() => environmentFingerprint()))()
    const validation = this.validation ??= (this.deps.internals().probeExecution ?? (() => validateExecution({ environment })))()
    const base = RUNNER_CAPABILITIES[selected.runner]
    const capabilities = selected.runner === 'bwrap'
      ? { ...base, ...this.deps.runtimeCapabilities() }
      : base
    return {
      backendId: this.id,
      backendVersion: BACKEND_VERSION,
      kernelVersion: release(),
      capabilities,
      environment,
      validation,
    }
  }

  /**
   * Wrap `argv` in the selected runner's invocation for `policy`.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the wrapped argv plus the selected runner's enforcement and dialect.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const selected = this.selected()
    if (selected === 'unusable') throw new SandboxUnavailableError(policy.mode)
    return {
      argv: [...this.deps.runnerArgv(selected.runner, policy), '--', ...argv],
      backendId: this.id,
      enforcement: selected.enforcement,
      denialSignatures: DENIAL_SIGNATURES[selected.runner],
      runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
    }
  }

  /** Walk this platform's chain in preference order; none usable → unavailable. */
  private chainVerdict(): SelectedRunner | 'unusable' {
    const chain = this.deps.internals().chain ?? PLATFORM_CHAINS[this.platform] ?? []
    for (const runner of chain) {
      const enforcement = this.probeRunner(runner)
      if (enforcement !== 'unusable') return { runner, enforcement }
    }
    return 'unusable'
  }

  /** One rung's functional probe (each at most once, via the chain walk). */
  private probeRunner(runner: Runner): SandboxEnforcement | 'unusable' {
    const internals = this.deps.internals()
    switch (runner) {
      case 'bwrap': {
        const probe = internals.probeBwrap ?? (() => defaultProbeBwrap(this.deps.runnerArgv, this.deps.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
      }
      case 'landlock': {
        const launcher = this.deps.landlockLauncher()
        const probe = internals.probeLandlock ?? (path => defaultProbeLandlock(path, { timeoutMs: this.deps.probeTimeoutMs }))
        return probe(launcher)
      }
      default: return assertNever(runner)
    }
  }
}
