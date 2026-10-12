/**
 * The filesystem stager: run one plan against a private copy of the workspace
 * so the real workspace is never written, then freeze the resulting tree as a
 * candidate. This is staged execution — the command really runs, but only its
 * disposable private state changes until a publication applies the frozen
 * candidate under CAS.
 *
 * The private copy is a full copy in this increment; overlay-backed private
 * layers are a later optimization that must not change the candidate contract.
 * @module dsh-sandbox-linux/stage/stager
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeManifest, scanUpper } from '../runtime/overlay.ts'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { freezeCandidate } from '../candidate/freeze.ts'
import { diffManifests } from '../candidate/diff.ts'
import { manifestDigest, scanTree, type ManifestEntry } from '../candidate/manifest.ts'
import type { ImpactModel, ProcessImpact } from '../candidate/impact.ts'
import type { CandidateScope } from '../control/records.ts'
import type { PlanRequest } from '../control/intent.ts'
import type { StageResult, Stager } from '../control/service.ts'
import { CgroupDomain } from '../runtime/cgroup.ts'
import type { OverlaySpec } from '../runtime/profile.ts'
import type { LimitOptions } from '../runtime/options.ts'

/** The outcome of running one staged command. */
export interface CommandResult {
  /** The process exit code, or `null` when signalled. */
  readonly exitCode: number | null
  /** Captured stdout (bounded by the runner). */
  readonly stdout: string
  /** Captured stderr (bounded by the runner). */
  readonly stderr: string
  /** Whether the wall-clock timeout fired. */
  readonly timedOut: boolean
  /** Whether the process was terminated by a signal. */
  readonly signalled: boolean
}

/** How the stager runs the confined argv. */
export interface CommandRunner {
  /**
   * Run one command.
   * @param input - the argv, working directory, environment, and timeout.
   * @returns the command outcome.
   */
  run(input: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly signal?: AbortSignal
    /** Called with the spawned pid so a cgroup domain can adopt the process tree. */
    readonly onSpawn?: (pid: number) => void
  }): Promise<CommandResult>
}

/** The default runner: a real spawn with a wall-clock timeout and captured output. */
export const defaultCommandRunner: CommandRunner = {
  run({ argv, cwd, env, timeoutMs, signal, onSpawn }) {
    return new Promise<CommandResult>((resolve, reject) => {
      const [exe, ...args] = argv
      if (exe === undefined) {
        reject(new Error('stager: empty argv'))
        return
      }
      const child = spawn(exe, args, { cwd, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      if (child.pid !== undefined) onSpawn?.(child.pid)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      const onAbort = (): void => { child.kill('SIGKILL') }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code, sig) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: code, stdout, stderr, timedOut, signalled: sig !== null })
      })
    })
  },
}

/** The stager's construction inputs. */
export interface StagingStagerOptions {
  /** The absolute workspace root to copy for staging. */
  readonly workspaceRoot: string
  /** The directory private candidate trees are created under; defaults to the OS temp dir. */
  readonly candidateParent?: string
  /** The command runner; defaults to a real spawn. */
  readonly runner?: CommandRunner
  /** The confinement wrapper; when present, the staged command runs confined. */
  readonly confine?: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv
  /**
   * The overlay confinement wrapper; when present the command runs against an
   * overlay (lower = real workspace, upper = delta layer) and only the delta is
   * captured. Mutually exclusive with a `projection`.
   */
  readonly confineOverlay?: (argv: readonly string[], policy: SandboxPolicy, overlay: OverlaySpec) => ConfinedArgv
  /** The candidate's declared scope. */
  readonly scope: CandidateScope
  /** The wall-clock timeout for one staged command. */
  readonly timeoutMs?: number
  /** The cgroup resource-domain options; absent disables domains. */
  readonly limits?: LimitOptions
  /** The evidence pointer recorded on impact records. */
  readonly evidenceId?: string
  /**
   * The unified workspace projection the command runs against. When present,
   * the command starts from the current logical version (not the real disk)
   * and its effects are extracted relative to that input version.
   */
  readonly projection?: StagingProjection
}

/** The unified workspace projection a command is staged against. */
export interface StagingProjection {
  /** The digest of the logical version the command starts from. */
  readonly version: string
  /** The logical entries at the input version. */
  entries(): ManifestEntry[]
  /** Copy the current logical view into a destination directory. */
  copyInto(destination: string): void
}

/**
 * The copy-based filesystem stager. It stages a plan in a fresh private copy,
 * runs the confined command with the copy as its workspace root, freezes the
 * result, and diffs it against the base to produce the impact model.
 */
export class StagingStager implements Stager {
  private readonly runner: CommandRunner
  private readonly timeoutMs: number
  private readonly evidenceId: string
  private readonly options: StagingStagerOptions

  /**
   * @param options - the workspace root, candidate parent, runner, confine hook, scope, and timeout.
   */
  constructor(options: StagingStagerOptions) {
    this.options = options
    this.runner = options.runner ?? defaultCommandRunner
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.evidenceId = options.evidenceId ?? 'evidence:staging'
  }

  /** @inheritdoc */
  async stage(input: { request: PlanRequest; executionIntentHash: string; commandId: string; attemptId: string }): Promise<StageResult> {
    const { request } = input
    const projection = this.options.projection
    const base = projection !== undefined
      ? projection.entries()
      : (existsSync(this.options.workspaceRoot) ? scanTree(this.options.workspaceRoot) : [])
    const inputVersion = projection !== undefined ? projection.version : manifestDigest(base)
    const rawArgv = [request.command.exe, ...request.command.argv]
    // The delta (overlay) path runs the command against the real workspace as
    // the overlay lower with a private upper: no full copy, and the workspace
    // path inside the sandbox stays the real one. It requires a confineOverlay
    // hook (Linux bwrap) and no in-memory projection to reconcile.
    const useOverlay = this.options.confineOverlay !== undefined && projection === undefined
    let candidatePath: string
    let cwd: string
    let argv: readonly string[]
    if (useOverlay) {
      const overlayRoot = mkdtempSync(join(this.options.candidateParent ?? tmpdir(), 'dsh-overlay-'))
      const upper = join(overlayRoot, 'upper')
      const work = join(overlayRoot, 'work')
      mkdirSync(upper)
      mkdirSync(work)
      const overlayPolicy: SandboxPolicy = { mode: request.mode, workspaceRoot: this.options.workspaceRoot }
      argv = this.options.confineOverlay!(rawArgv, overlayPolicy, { upper, work }).argv
      candidatePath = upper
      cwd = this.options.workspaceRoot
    } else {
      candidatePath = mkdtempSync(join(this.options.candidateParent ?? tmpdir(), 'dsh-candidate-'))
      if (projection !== undefined) {
        // The command starts from the current logical version, so its staged
        // changes are visible to it without publishing.
        projection.copyInto(candidatePath)
      } else if (existsSync(this.options.workspaceRoot)) {
        cpSync(this.options.workspaceRoot, candidatePath, { recursive: true, force: true, errorOnExist: false })
      }
      const policy: SandboxPolicy = { mode: request.mode, workspaceRoot: candidatePath }
      argv = this.options.confine === undefined ? rawArgv : this.options.confine(rawArgv, policy).argv
      cwd = candidatePath
    }
    // A cgroup v2 resource domain confines the whole process tree for the
    // command's lifetime; when the host cannot provide one it is skipped and
    // the capability report says so.
    const domain = this.options.limits === undefined
      ? undefined
      : CgroupDomain.create(input.attemptId, this.options.limits)
    const oomBase = domain?.oomBaseline()
    const result = await this.runner.run({
      argv,
      cwd,
      env: request.command.env,
      timeoutMs: this.timeoutMs,
      ...(domain === undefined ? {} : { onSpawn: (pid: number) => domain.addProcess(pid) }),
    })
    if (domain !== undefined && (result.timedOut || result.signalled)) domain.kill()
    const oom = domain !== undefined && oomBase !== undefined ? domain.oomAttribution(oomBase) : undefined
    domain?.release()
    // Overlay captures only the delta; the full desired manifest is the base
    // with the captured changes merged and deletions applied.
    const after = useOverlay
      ? (() => {
          const capture = scanUpper(candidatePath)
          return mergeManifest(base, capture.entries, capture.deletions)
        })()
      : scanTree(candidatePath)
    const candidate = freezeCandidate({
      path: candidatePath,
      baseVersion: inputVersion,
      scope: this.options.scope,
      entries: after,
    })
    const fs = diffManifests(base, after, this.evidenceId)
    const process: ProcessImpact = {
      peakPids: null,
      exitCode: result.exitCode,
      signalled: result.signalled,
      ...(oom === undefined ? {} : { oom }),
      evidenceId: this.evidenceId,
    }
    const impact: ImpactModel = { fs, process: [process], network: [] }
    return { candidate, impact, readOnly: fs.length === 0, evidenceIds: [this.evidenceId] }
  }
}
