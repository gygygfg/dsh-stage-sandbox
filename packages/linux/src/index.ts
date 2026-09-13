/**
 * Local sandbox provider. It selects a platform runtime backend through the
 * Platform Abstraction Layer (`SandboxPal`) and delegates confinement to it.
 * Each backend owns one platform's functionally probed runner chain and
 * reports the capability set the PAL contract exposes; a host with no backend,
 * or a backend whose chain has no usable rung, fails closed rather than
 * returning the original argv.
 *
 * The windows-acl backend's write grants are provider-owned: the write SID is
 * the per-WORKSPACE identity derived from the canonical workspace path
 * (`workspaceWriteSid`), while every live session receives a RANDOM private
 * temp directory and its own derived capability (`tempWriteSid`). The
 * workspace-root ACE materializes once per workspace per server lifetime
 * and STANDS (the cross-session reuse cache — the exact-ACE skip makes
 * every later provision O(1) instead of re-propagating the tree per
 * session); the private-temp ACEs are revoked on dispose. The runner
 * receives both SIDs (their presence marks the seam-managed contract) and
 * stops managing DACLs itself. The rung reports partial enforcement because
 * WRITE_RESTRICTED must retain Everyone in its
 * restricting list and NTFS hard links alias one file object across paths.
 * @module dsh-sandbox-plugin
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launcherPath as landlockLauncherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPal } from '@deepseek-ai/dsh-sandbox-pal'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AclWriteGrant, assertTempRootOutsideWorkspace, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  DENIAL_SIGNATURES,
  PLATFORM_BACKENDS,
  PlatformBackend,
  backendIdForPlatform,
} from './backends.ts'
import type { BackendDeps, Runner, SandboxInternals } from './backends.ts'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from './profiles.ts'

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
}

/** One live session/workspace pair's private temp directory and capability. */
interface AclTempCapability {
  dir: string
  writeSid: string
  grant: AclWriteGrant
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

/**
 * Local process-sandbox provider. Registers as `ctx.sandbox`. Selects a
 * {@link PlatformBackend} through `SandboxPal` and caches, on the windows-acl
 * backend, the write grants ({@link AclWriteGrant}: the standing
 * workspace-root grant per workspace and the revocable private-temp grant per
 * live session/workspace pair, the latter revoked on provider dispose); the
 * one-time probes spawn nothing else.
 */
export class CrossPlatformSandboxProvider extends SandboxProvider {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    runnerCommand: z.array(z.string()).default([]),
    runnerFailureSignatures: z.array(z.string()).default([]),
    probeTimeoutMs: z.natural().default(5_000),
  })

  /** Test hook (mirrors the bash executors' `internals`). */
  internals: SandboxInternals = {}

  private readonly runnerCommand: string[] | undefined
  private readonly configuredRunnerFailureSignatures: string[]
  private readonly probeTimeoutMs: number
  /** Lazily built PAL registry; undefined until the first confined wrap needs it. */
  private pal: SandboxPal<PlatformBackend> | undefined
  /**
   * Server-lifetime write grants (windows-acl rung): the STANDING
   * workspace-root grant per workspace (its ACE is the cross-session reuse
   * cache and outlives the provider — never revoked) and the REVOCABLE
   * private-temp grant per live session/workspace pair (revoked on provider
   * dispose).
   */
  private readonly workspaceGrants = new Map<string, AclWriteGrant>()
  private readonly tempCapabilities = new Map<string, AclTempCapability>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // The schema (static Config) defaults every field — the casts record
    // those runtime facts. An empty runnerCommand means "not configured":
    // use the platform chain.
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
    // The temp grants are revoked with the provider: a clean server
    // shutdown leaves no temp ACEs behind (workspace ACEs stand by design —
    // the reuse cache; an unclean shutdown leaves them for the next
    // provision's exact-ACE skip).
    ctx.effect(() => () => {
      this.revokeAclGrants()
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
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
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
   * Build the PAL registry once, after `internals` is final: the provider
   * assigns `internals` after plugin load, so the registry and its backends
   * read the live object through {@link BackendDeps.internals} at call time.
   */
  private palOf(): SandboxPal<PlatformBackend> {
    if (this.pal !== undefined) return this.pal
    const deps: BackendDeps = {
      internals: () => this.internals,
      probeTimeoutMs: this.probeTimeoutMs,
      seatbeltExec: () => this.seatbeltExec(),
      landlockLauncher: () => this.landlockLauncher(),
      windowsAclRunnerInvocation: () => this.windowsAclRunnerInvocation(),
      runnerArgv: (runner, policy) => this.runnerArgv(runner, policy),
    }
    const pal = new SandboxPal<PlatformBackend>()
    for (const { id, platform } of PLATFORM_BACKENDS) pal.register(new PlatformBackend(id, platform, deps))
    this.pal = pal
    return pal
  }

  /** The selected rung's runner invocation (program + profile arguments) for one policy. */
  private runnerArgv(runner: Runner, policy: SandboxPolicy): string[] {
    switch (runner) {
      case 'bwrap': return ['bwrap', ...bwrapProfileArgs(policy)]
      case 'landlock': return [this.landlockLauncher(), ...landlockProfileArgs(policy)]
      case 'seatbelt': return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)]
      case 'windows-acl': return this.windowsAclRunnerArgv(policy)
      default: return assertNever(runner)
    }
  }

  /**
   * The windows-acl runner argv for one policy. With a calling session (the
   * policy's `sessionId`) under workspace-write, the grants are materialized
   * once per provider lifetime — the standing workspace-root grant per
   * workspace and a revocable, RANDOM private-temp capability per live
   * session/workspace pair. The runner receives `--write-sid` plus
   * `--temp-write-sid` and grants nothing itself. Agentless workspace-write
   * calls pass the ambient temp ROOT and no SID flags: the runner creates and
   * removes a random private child directory for that one invocation.
   * @param policy - the resolved per-call policy.
   * @returns the runner invocation.
   */
  private windowsAclRunnerArgv(policy: SandboxPolicy): string[] {
    const sessionId = policy.sessionId
    if (sessionId === undefined || policy.mode === 'read-only') {
      return [
        ...this.windowsAclRunnerInvocation(),
        '--workspace', policy.workspaceRoot,
        '--temp', tmpdir(),
        '--mode', policy.mode,
      ]
    }
    const temp = this.materializeAclGrant(sessionId, policy.workspaceRoot)
    return [
      ...this.windowsAclRunnerInvocation(),
      '--workspace', policy.workspaceRoot,
      '--temp', temp.dir,
      '--mode', policy.mode,
      '--write-sid', workspaceWriteSid(policy.workspaceRoot),
      '--temp-write-sid', temp.writeSid,
    ]
  }

  /**
   * Materialize one workspace-write policy's ACEs once per provider
   * lifetime. The workspace SID and standing root grant are shared by the
   * workspace. The temp directory is random and carries a distinct SID, so
   * another session on the same workspace cannot use the shared workspace
   * SID to enter it. A fresh provider always chooses a new path; crash
   * residue therefore cannot collide with or authorize a resumed session.
   * Fail-closed: a half-materialized temp grant is revoked and its directory
   * removed before the error propagates.
   * @param sessionId - the policy's calling-session identity.
   * @param workspaceRoot - the resolved policy root.
   * @returns the pair's private temp directory and write capability.
   */
  private materializeAclGrant(sessionId: SessionId, workspaceRoot: string): AclTempCapability {
    assertTempRootOutsideWorkspace(workspaceRoot, tmpdir())
    const writeSid = workspaceWriteSid(workspaceRoot)
    if (!this.workspaceGrants.has(workspaceRoot)) {
      const grant = AclWriteGrant.create(writeSid)
      try {
        grant.add(workspaceRoot, true)
      } catch (error) {
        // Free the SID; a standing ACE (if the apply succeeded before a
        // post-apply throw) is the intended end state, not an error
        // artifact — nothing to revoke.
        try {
          grant.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'sandbox-local windows-acl workspace grant failed and its cleanup also failed')
        }
        throw error
      }
      this.workspaceGrants.set(workspaceRoot, grant)
    }
    const key = JSON.stringify([String(sessionId), workspaceRoot])
    const existing = this.tempCapabilities.get(key)
    if (existing !== undefined) return existing
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))
    const tempSid = tempWriteSid(tempDir)
    let grant: AclWriteGrant | undefined
    try {
      grant = AclWriteGrant.create(tempSid)
      grant.add(tempDir)
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (grant !== undefined) {
        try {
          grant.dispose()
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError)
        }
      }
      try {
        this.removeTempDir(tempDir)
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'sandbox-local windows-acl temp grant materialization failed and its cleanup also failed')
      }
      throw error
    }
    const capability = { dir: tempDir, writeSid: tempSid, grant }
    this.tempCapabilities.set(key, capability)
    return capability
  }

  /**
   * Dispose every write grant (provider dispose): the revocable temp ACEs
   * are revoked, the private temp directories this provider created are
   * removed, and every SID allocation is freed; the standing workspace ACEs
   * stay (the reuse cache). Cleanup failures are reported, not thrown:
   * cordis teardown must not be aborted by grant cleanup. A crash skips all
   * of it, but a new provider never reuses the residue's random path or SID;
   * OS temp hygiene (or manual removal) eventually reclaims it.
   */
  private revokeAclGrants(): void {
    if (this.workspaceGrants.size === 0 && this.tempCapabilities.size === 0) return
    const failures: unknown[] = []
    for (const grant of [...this.workspaceGrants.values(), ...[...this.tempCapabilities.values()].map(capability => capability.grant)]) {
      try {
        grant.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    for (const { dir } of this.tempCapabilities.values()) {
      try {
        this.removeTempDir(dir)
      } catch (error) {
        failures.push(error)
      }
    }
    this.workspaceGrants.clear()
    this.tempCapabilities.clear()
    if (failures.length > 0) {
      this.ctx.logger.warn(`sandbox-local: windows-acl grant cleanup completed with ${failures.length} failure(s)`)
      for (const error of failures) this.ctx.logger.warn(error)
    }
  }

  /** Remove one provider-owned private temp directory (injectable for cleanup tests). */
  private removeTempDir(dir: string): void {
    const remove = this.internals.rmTempDir ?? ((path: string) => { rmSync(path, { recursive: true, force: true }) })
    remove(dir)
  }

  /** The Landlock launcher to probe and exec (test hook over the resolved one). */
  private landlockLauncher(): string {
    return this.internals.landlockLauncher ?? landlockLauncherPath()
  }

  /** The `sandbox-exec` executable to probe and exec (test hook over the system one). */
  private seatbeltExec(): string {
    return this.internals.seatbeltExec ?? 'sandbox-exec'
  }

  /**
   * The windows-acl runner argv prefix: the built lib/runner.js entry when
   * present (production), else the package source through tsx (development).
   * The prefix stays `[node, runner, ...]` — a future native-exe runner keeps
   * the same argv contract and only swaps these entries.
   */
  private windowsAclRunnerInvocation(): string[] {
    const override = this.internals.windowsAclRunnerArgs
    if (override !== undefined) return override
    const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
    if (existsSync(builtEntry)) return [process.execPath, builtEntry]
    const sourceEntry = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts'))
    return [process.execPath, '--import', 'tsx/esm', sourceEntry]
  }
}

export default CrossPlatformSandboxProvider
