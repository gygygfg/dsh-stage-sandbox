/**
 * Platform runtime backends for the local sandbox provider. Each backend owns
 * one host platform's functionally probed runner chain and reports the
 * capability set the PAL contract exposes. A backend is selected by
 * `process.platform` through {@link SandboxPal}; the provider never branches on
 * an operating-system name.
 * @module dsh-sandbox-plugin/backends
 */

import { spawnSync } from 'node:child_process'
import { release, tmpdir } from 'node:os'
import {
  LAUNCHER_BIN,
  LAUNCHER_FAILURE_EXIT,
  probe as defaultProbeLandlock,
} from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { CapabilityReport, CapabilityStatus, RuntimeBackend, RuntimeBackendId, SandboxCapability } from '@deepseek-ai/dsh-sandbox-pal'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { bwrapProfileArgs, seatbeltProfileArgs } from './profiles.ts'

/** The backend implementation's own version, bound into execution intents. */
const BACKEND_VERSION = '1'

/** One confinement runner a platform chain can select. */
export type Runner = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'

/** The chain's verdict: which runner confines, and how completely it enforces. */
export type SelectedRunner = { runner: Runner; enforcement: SandboxEnforcement }

/**
 * Test hook: inject probe verdicts, a fake launcher, a platform, or a chain
 * without real runners. The provider owns the object; a backend reads it
 * through {@link BackendDeps.internals} at call time so an assignment after
 * plugin load is observed.
 */
export interface SandboxInternals {
  /** Replaces `process.platform` for chain selection (exercise any platform's chain from any host). */
  platform?: string
  /** Replaces the platform's chain wholesale (walk mechanics — e.g. probing a rung the product chains only reach unprobed). */
  chain?: readonly Runner[]
  /** Replaces the functional `bwrap` probe (the Linux chain's first rung). */
  probeBwrap?: () => boolean
  /** Replaces the functional Landlock launcher probe (the Linux chain's second rung). */
  probeLandlock?: (launcher: string) => SandboxEnforcement | 'unusable'
  /** Replaces the functional Seatbelt probe (the darwin chain's sole rung — only consulted if that chain ever grows). */
  probeSeatbelt?: (seatbeltExec: string) => boolean
  /** Replaces the resolved `landlock-run` launcher path (a fake launcher script). */
  landlockLauncher?: string
  /** Replaces the `sandbox-exec` executable the probe and wraps invoke (a fake script). */
  seatbeltExec?: string
  /** Replaces the resolved windows-acl runner argv prefix (a fake runner). */
  windowsAclRunnerArgs?: string[]
  /** Replaces the resolved windows-acl runner built entry path (a fake lib/runner.js location). */
  windowsAclRunnerEntry?: string
  /** Replaces the functional windows-acl probe (the win32 chain's sole rung — only consulted if that chain ever grows). */
  probeWindowsAcl?: () => boolean
  /** Replaces the private-temp-directory removal at provider dispose (a throwing fake exercises the cleanup-failure path). */
  rmTempDir?: (path: string) => void
}

/**
 * The runner chain per platform — selection is BY PLATFORM first, probes
 * second: a platform's chain is probed in preference order only when it has
 * MORE than one candidate (probing arbitrates; it does not re-validate a
 * choice that has no alternative). A platform with no chain fails closed at
 * `confine()`. Linux prefers `bwrap` (its mount profile is closest to the
 * mode vocabulary) over the Landlock launcher; darwin has exactly one
 * candidate, selected without any probe.
 */
export const PLATFORM_CHAINS: Record<string, readonly Runner[]> = {
  linux: ['bwrap', 'landlock'],
  darwin: ['seatbelt'],
  // The Windows restricted-token runner (@deepseek-ai/dsh-sandbox-windows-acl):
  // a sole candidate, selected without a probe — its execution-time refusal
  // fails closed through its stderr signature (windows-acl-run:) and exit 127.
  win32: ['windows-acl'],
}

/**
 * Enforcement completeness a rung claims when selected WITHOUT a probe (a
 * chain of one). `bwrap` and Seatbelt govern every promised file effect by
 * construction, so the claim is a profile fact; `landlock` is listed for the
 * table's totality but is unreachable without a probe (the Linux chain has
 * two rungs, so it is only ever selected through its probe, whose report is
 * what distinguishes full from per-ABI-partial — and the launcher additionally
 * self-reports partial enforcement on stderr at every confined run).
 */
export const STATIC_ENFORCEMENT: Record<Runner, SandboxEnforcement> = {
  bwrap: 'full',
  landlock: 'full',
  seatbelt: 'full',
  // WRITE_RESTRICTED needs Everyone in both restricting lists for process
  // initialization. An external object that grants Everyone write access
  // therefore remains writable, and NTFS hard links can alias a granted
  // workspace file to a path outside it. The backend enforces the remaining
  // ACL-addressable surface but must not advertise the absolute promise.
  'windows-acl': 'partial',
}

/**
 * The denial dialect each runner's kernel speaks — the case-insensitive stderr substrings a
 * denied file effect produces under it, carried on every wrap (the seam's
 * `ConfinedArgv.denialSignatures`).
 */
export const DENIAL_SIGNATURES = {
  bwrap: ['read-only file system'],
  landlock: ['permission denied'],
  seatbelt: ['operation not permitted'],
  // pwsh/.NET: "Access to the path '...' is denied."; cmd: "Access is denied.";
  // node EACCES: "permission denied".
  'windows-acl': ['access is denied', 'access to the path', 'permission denied'],
  runnerCommand: ['read-only file system', 'permission denied'],
} as const satisfies Record<Runner | 'runnerCommand', readonly string[]>

/**
 * Runner-owned fatal diagnostics. Landlock has a versioned exit-125 plus
 * fatal-line launcher-failure contract. Bubblewrap's current fatal paths exit
 * 1 but its public contract does not reserve that status, while sandbox-exec
 * publishes no launcher-failure status; those backends remain signature-only.
 * The windows-acl runner prints `windows-acl-run: <detail>` on every
 * runner-side failure and exits 127 — the rule is exit-gated on that status
 * so a confined command that merely PRINTS the signature (or a runner
 * cleanup failure reported on a non-zero child exit) is never misclassified
 * as "the command did not run". Keep the Landlock tuple aligned with the
 * assembled snapshot fixture at
 * `packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts`.
 */
export const RUNNER_FAILURE_RULES = {
  bwrap: [{ fatalSignatures: ['bwrap: '] }],
  landlock: [{
    allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
    fatalSignatures: [`${LAUNCHER_BIN}: `],
    informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`],
  }],
  seatbelt: [{ fatalSignatures: ['sandbox-exec: '] }],
  'windows-acl': [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
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
 * What each runner can enforce, as the PAL capability report. `bwrap` and the
 * file-effect runners govern the mode's file effects (enforced, except the
 * Windows ACL runner's documented Everyone and hard-link boundaries) but none
 * provides the resource, syscall, transaction, identity, reparse, or network
 * dimensions; bwrap is the only one that adds namespace isolation.
 */
export const RUNNER_CAPABILITIES: Record<Runner, Record<SandboxCapability, CapabilityStatus>> = {
  bwrap: { ...NO_CAPABILITIES, fileEffectPolicy: 'enforced', isolation: 'partial', privilegeReduction: 'partial' },
  landlock: { ...NO_CAPABILITIES, fileEffectPolicy: 'enforced', privilegeReduction: 'partial' },
  seatbelt: { ...NO_CAPABILITIES, fileEffectPolicy: 'enforced' },
  'windows-acl': {
    ...NO_CAPABILITIES,
    fileEffectPolicy: 'partial',
    isolation: 'partial',
    integrity: 'partial',
    privilegeReduction: 'partial',
  },
}

/**
 * The host platforms a backend serves, keyed by backend id. `process.platform`
 * is `win32`, while the backend id is `windows`.
 */
export const PLATFORM_BACKENDS: readonly { id: RuntimeBackendId; platform: string }[] = [
  { id: 'linux', platform: 'linux' },
  { id: 'darwin', platform: 'darwin' },
  { id: 'windows', platform: 'win32' },
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

/** Probe whether `bwrap` can create the profile; the backend caches the bounded result. */
function defaultProbeBwrap(timeoutMs: number): boolean {
  const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Functional Seatbelt probe: apply the real `read-only` profile through
 * `sandbox-exec -p` and run `true` under it — exit 0 means the kernel
 * accepted and enforced the profile (`sandbox-exec` exits non-zero when
 * `sandbox_init` refuses it). A missing `sandbox-exec` (every non-macOS
 * host) fails the spawn and probes `unusable`, exactly like the other
 * rungs' absent binaries. Apple marks the CLI deprecated but ships it on
 * every macOS; if it ever disappears, this probe is what fails closed.
 */
function defaultProbeSeatbelt(seatbeltExec: string, timeoutMs: number): boolean {
  const probe = spawnSync(seatbeltExec, [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * Functional windows-acl probe: run the runner in read-only mode (zero grants,
 * no ACL mutation) around `cmd /c exit 0` — exit 0 means the runner created
 * the restricted token and spawned the child under it. The win32 chain is a
 * sole candidate, so the product never probes; the probe exists for override
 * chains and mirrors the other rungs' shape.
 */
function defaultProbeWindowsAcl(runnerInvocation: string[], timeoutMs: number): boolean {
  const program = runnerInvocation[0]
  if (program === undefined) return false
  const probe = spawnSync(program, [
    ...runnerInvocation.slice(1),
    '--workspace', tmpdir(), '--temp', tmpdir(), '--mode', 'read-only',
    '--', 'cmd', '/c', 'exit', '0',
  ], {
    timeout: timeoutMs,
    stdio: 'ignore',
  })
  return probe.status === 0
}

/**
 * The provider-owned hooks a backend needs: the test-internals accessor, the
 * probe timeout, the resolved runner executables, and the provider's runner
 * argv builder (which owns the per-session Windows ACL grants).
 */
export interface BackendDeps {
  /** The provider's current test internals, read at call time. */
  internals(): SandboxInternals
  /** Positive probe timeout in milliseconds. */
  probeTimeoutMs: number
  /** The `sandbox-exec` executable to probe (test hook over the resolved one). */
  seatbeltExec(): string
  /** The Landlock launcher to probe and exec (test hook over the resolved one). */
  landlockLauncher(): string
  /** The windows-acl runner argv prefix (test hook over the resolved one). */
  windowsAclRunnerInvocation(): string[]
  /** The full runner argv for one policy, including the Windows ACL grant flags. */
  runnerArgv(runner: Runner, policy: SandboxPolicy): string[]
}

/**
 * One host platform's sandbox backend. `selected()` walks and caches the
 * platform's runner chain once for the backend's lifetime; `probe()` projects
 * that verdict into a PAL capability report; `confine()` wraps argv with the
 * selected runner's dialect. A platform with no chain fails closed.
 */
export class PlatformBackend implements RuntimeBackend {
  readonly id: RuntimeBackendId
  readonly platforms: readonly string[]
  /** The platform this backend's chain is looked up under. */
  private readonly platform: string
  /** Cached chain verdict; undefined until the first selection needs it. */
  private verdict: SelectedRunner | 'unusable' | undefined

  constructor(id: RuntimeBackendId, platform: string, private readonly deps: BackendDeps) {
    this.id = id
    this.platforms = [platform]
    this.platform = platform
  }

  /**
   * The platform's cached chain verdict.
   * @returns the selected runner and its enforcement, or `unusable`.
   */
  selected(): SelectedRunner | 'unusable' {
    return this.verdict ??= this.chainVerdict()
  }

  /**
   * Probe this host and report what the backend can enforce.
   * @returns the capability report, or `unusable` when no chain rung is usable.
   */
  probe(): CapabilityReport | 'unusable' {
    const selected = this.selected()
    if (selected === 'unusable') return 'unusable'
    return {
      backendId: this.id,
      backendVersion: BACKEND_VERSION,
      kernelVersion: release(),
      capabilities: RUNNER_CAPABILITIES[selected.runner],
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

  /** Walk this platform's chain: sole candidate unprobed, several probed in order, none usable → unavailable. */
  private chainVerdict(): SelectedRunner | 'unusable' {
    const chain = this.deps.internals().chain ?? PLATFORM_CHAINS[this.platform] ?? []
    const [first, ...rest] = chain
    if (first === undefined) return 'unusable'
    // A sole candidate needs no arbitration; its execution-time refusal still fails closed.
    if (rest.length === 0) return { runner: first, enforcement: STATIC_ENFORCEMENT[first] }
    for (const runner of chain) {
      const enforcement = this.probeRunner(runner)
      if (enforcement !== 'unusable') return { runner, enforcement }
    }
    return 'unusable'
  }

  /** One rung's functional probe (each at most once, via the chain walk). */
  private probeRunner(runner: Runner): SandboxEnforcement | 'unusable' {
    const internals = this.deps.internals()
    // bwrap's mount profile and Seatbelt's deny-file-write* profile govern
    // every promised file effect by construction, so their passing probes
    // are always full enforcement; the Landlock launcher's probe report
    // distinguishes full from per-ABI-partial, while windows-acl is always
    // partial for its documented Everyone and hard-link boundaries.
    switch (runner) {
      case 'bwrap': {
        const probe = internals.probeBwrap ?? (() => defaultProbeBwrap(this.deps.probeTimeoutMs))
        return probe() ? 'full' : 'unusable'
      }
      case 'landlock': {
        const launcher = this.deps.landlockLauncher()
        const probe = internals.probeLandlock ?? (path => defaultProbeLandlock(path, { timeoutMs: this.deps.probeTimeoutMs }))
        return probe(launcher)
      }
      case 'seatbelt': {
        const exec = this.deps.seatbeltExec()
        const probe = internals.probeSeatbelt ?? (path => defaultProbeSeatbelt(path, this.deps.probeTimeoutMs))
        return probe(exec) ? 'full' : 'unusable'
      }
      case 'windows-acl': {
        const probe = internals.probeWindowsAcl
          ?? (() => defaultProbeWindowsAcl(this.deps.windowsAclRunnerInvocation(), this.deps.probeTimeoutMs))
        return probe() ? 'partial' : 'unusable'
      }
      default: return assertNever(runner)
    }
  }
}
