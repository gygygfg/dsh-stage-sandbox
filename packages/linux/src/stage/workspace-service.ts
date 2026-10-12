/**
 * The workspace service: the unified staging surface for the file editor, the
 * shell executor, and the Git projection. It owns one logical workspace per
 * workspace branch, keeps the session-to-branch binding, and exposes the
 * dry-run operations a review UI calls: inspect pending changes, apply under
 * CAS, or discard.
 *
 * A branch is a logical workspace; a session references a branch and is
 * rebound when a new attempt starts. Publication is blocked when the logical
 * view is corrupted, so a missing storage object can never be published as an
 * inferred deletion.
 *
 * A dangerous candidate is frozen and held for confirmation. The held approval
 * is written to a durable store before the process may exit, so reopening the
 * session restores it instead of losing it (v2.3 §13).
 * @module dsh-sandbox-linux/stage/workspace-service
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LinuxSandboxProvider } from '../index.ts'
import { CandidateWorkspace } from '../candidate/workspace.ts'
import { freezeCandidate } from '../candidate/freeze.ts'
import { ResidentSandbox, type ResidentExecResult } from '../runtime/resident.ts'
import { assessDanger, type CommandIntent, type DangerAssessment } from '../candidate/danger.ts'
import type { FsImpact } from '../candidate/impact.ts'
import type { CandidateRef, CandidateScope, PublicationReceipt } from '../control/records.ts'
import { LeaseRegistry } from '../control/lease.ts'
import { GrantRegistry, type GrantOperation, type TaskGrant } from '../control/grant.ts'
import { DirectoryPublicationBackend } from '../publish/directory-backend.ts'
import { Publisher, type PublishOutcome } from '../publish/publisher.ts'
import { FileReceiptStore, MemoryReceiptStore } from '../publish/receipt-store.ts'
import type { PolicyFacts } from '../policy/facts.ts'
import type { CorruptionRecord } from '../workspace/types.ts'
import { FilePendingStore, MemoryPendingStore, type PendingStore, type PersistedPending } from './pending-store.ts'
import type {} from '../policy/plugin.ts'

/** Plugin config for the workspace staging service. */
export interface Config {
  /** Absolute workspace root the overlays are based on. */
  workspaceRoot: string
  /** Parent directory candidate overlays are created under; defaults to the OS temp dir. */
  candidateParent?: string
  /** Publication lease lifetime, in milliseconds. */
  leaseTtlMs?: number
  /** Durable state directory for held approvals; empty string disables durability. */
  stateDir?: string
  /**
   * Whether a session-resident command server backs shell execution: `cd`/
   * `export` and background processes persist across commands. Requires a host
   * that can mount a bwrap overlay; defaults to `false`.
   */
  resident?: boolean
}

/** A frozen candidate held until the user explicitly confirms it. */
export type PendingConfirmation = PersistedPending

/** One workspace branch's staged state, as a review UI reads it. */
export interface StagedState {
  /** The workspace root the candidate is based on. */
  readonly workspaceRoot: string
  /** The branch identity. */
  readonly branchId: string
  /** Whether the overlay has been materialized by a mutation. */
  readonly materialized: boolean
  /** The monotonic staged revision. */
  readonly revision: number
  /** The pending filesystem changes. */
  readonly changes: readonly FsImpact[]
  /** Whether the logical view is corrupted; a corrupted view cannot publish. */
  readonly corrupted: boolean
  /** The danger assessment of the current staged changes (or the held candidate). */
  readonly danger: DangerAssessment
  /** The frozen candidate held for confirmation, when one is pending. */
  readonly pending: PendingConfirmation | null
}

/** The result of applying a workspace's candidate. */
export interface ApplyResult {
  /** The publish outcome kind, the policy refusal, a danger hold, a corruption refusal, or nothing staged. */
  readonly kind: PublishOutcome['kind'] | 'needs-authorization' | 'denied' | 'corrupted' | 'nothing-to-apply'
  /** The publication receipt when published. */
  readonly receipt?: PublicationReceipt
  /** The candidate that was frozen. */
  readonly candidate?: CandidateRef
  /** Reason codes when the policy denied or required confirmation. */
  readonly reasonCodes?: readonly string[]
  /** The corrupted paths when the view is corrupted. */
  readonly corrupted?: readonly CorruptionRecord[]
  /** The danger assessment when the candidate was held for confirmation. */
  readonly danger?: DangerAssessment
}

/** Reconstruct a danger assessment from a held pending record. */
function assessmentOf(pending: PendingConfirmation): DangerAssessment {
  return {
    dangerous: pending.level !== 'none',
    level: pending.level,
    marker: pending.marker,
    confirmationsRequired: pending.confirmationsRequired,
    consequences: pending.consequences,
    reasons: pending.reasons,
  }
}

/** The empty assessment. */
const NO_DANGER: DangerAssessment = { dangerous: false, level: 'none', marker: null, confirmationsRequired: 0, consequences: [], reasons: [] }

/**
 * The workspace service. It owns the per-branch logical workspaces and the
 * publisher; a mutation materializes the branch, and `apply` freezes and
 * publishes it under CAS.
 */
export class WorkspaceStagingService extends Service {
  static inject = ['sandboxPolicyEngine']

  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    workspaceRoot: z.string(),
    candidateParent: z.string().default(''),
    leaseTtlMs: z.natural().default(30_000),
    stateDir: z.string().default(''),
    resident: z.boolean().default(false),
  })

  private readonly branches = new Map<string, CandidateWorkspace>()
  private readonly sessionBranches = new Map<string, string>()
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly commands = new Map<string, CommandIntent[]>()
  private readonly leases = new LeaseRegistry()
  /** Narrow task grants that let a sanctioned task auto-apply. */
  private readonly grants = new GrantRegistry()
  private readonly publisher: Publisher
  private readonly store: PendingStore
  private readonly fileStore: FilePendingStore | undefined
  private readonly candidateParent: string | undefined
  private readonly leaseTtlMs: number
  /**
   * Whether branches stage copy-on-write. Enabled when the host can mount a
   * bwrap overlay, so command paths can run against the delta at the real path;
   * otherwise the full-copy fallback is used and the staging tree is complete.
   */
  private readonly copyOnWrite: boolean
  /** Whether the resident command server is available (opt-in + overlay). */
  readonly residentEnabled: boolean
  /** Live resident servers keyed by workspace root, with their materialize inbox. */
  private readonly residents = new Map<string, { resident: ResidentSandbox; inbox: string; start: Promise<void> }>()

  /**
   * @param ctx - the plugin context.
   * @param config - the workspace root, timing knobs, and durable state directory.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxWorkspace')
    this.candidateParent = config.candidateParent === '' ? undefined : config.candidateParent
    this.leaseTtlMs = config.leaseTtlMs as number
    const provider = ctx.get('sandbox', false) as LinuxSandboxProvider | undefined
    this.copyOnWrite = provider?.overlaySupported?.() ?? false
    this.residentEnabled = this.copyOnWrite && config.resident === true
    const stateDir = config.stateDir === undefined || config.stateDir === '' ? undefined : config.stateDir
    if (stateDir === undefined) {
      this.store = new MemoryPendingStore()
      this.fileStore = undefined
    } else {
      const fileStore = new FilePendingStore(stateDir)
      this.store = fileStore
      this.fileStore = fileStore
    }
    // A durable receipt log makes workspace publication idempotent across a
    // restart (the operation id is derived from the branch and candidate).
    this.publisher = new Publisher(
      new DirectoryPublicationBackend(),
      this.leases,
      undefined,
      stateDir === undefined ? new MemoryReceiptStore() : new FileReceiptStore(stateDir),
    )
    this.restorePending()
    ctx.effect(() => () => {
      for (const entry of this.residents.values()) {
        entry.resident.stop()
        rmSync(entry.inbox, { recursive: true, force: true })
      }
      this.residents.clear()
      for (const workspace of this.branches.values()) workspace.dispose()
      this.branches.clear()
      this.sessionBranches.clear()
      this.commands.clear()
    })
  }

  /** Restore held approvals persisted by a previous process. */
  private restorePending(): void {
    for (const record of this.store.load()) {
      this.pending.set(branchKey(record.workspaceRoot, record.branchId), record)
    }
  }

  /**
   * The logical workspace for a branch of a workspace, created on first use.
   * @param workspaceRoot - the real workspace root.
   * @param branchId - the branch identity; defaults to the workspace's `main` branch.
   * @returns the branch's logical workspace.
   */
  branchFor(workspaceRoot: string, branchId = 'main'): CandidateWorkspace {
    const key = branchKey(workspaceRoot, branchId)
    const existing = this.branches.get(key)
    if (existing !== undefined) return existing
    const scope: CandidateScope = { categories: ['filesystem'], writableRoots: [workspaceRoot] }
    const workspace = new CandidateWorkspace({
      baseRoot: workspaceRoot,
      ...(this.candidateParent === undefined ? {} : { candidateParent: this.candidateParent }),
      scope,
      evidenceId: `evidence:fs:${workspaceRoot}:${branchId}`,
      copyOnWrite: this.copyOnWrite,
    })
    this.branches.set(key, workspace)
    return workspace
  }

  /**
   * The default (`main`) branch's logical workspace, created on first use.
   * @param workspaceRoot - the real workspace root.
   * @returns the logical workspace.
   */
  workspaceFor(workspaceRoot: string): CandidateWorkspace {
    return this.branchFor(workspaceRoot, 'main')
  }

  /**
   * Run one shell command through the session-resident server for a workspace:
   * the current tool-edit delta is pushed into the instance from inside its
   * namespace, the command runs in the persistent shell, and the overlay's
   * whiteouts are reconciled. Only valid when {@link residentEnabled}.
   * @param input - the workspace root, command, workdir, environment, timeout, and signal.
   * @returns the command result.
   */
  async runResident(input: {
    readonly workspaceRoot: string
    readonly command: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }): Promise<ResidentExecResult> {
    const entry = await this.ensureResident(input.workspaceRoot)
    const workspace = this.workspaceFor(input.workspaceRoot)
    const deletions = workspace.exportDelta(entry.inbox)
    await entry.resident.materialize({ inbox: '/dsh-inbox', workspace: input.workspaceRoot, deletions })
    const result = await entry.resident.exec(input.command, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    workspace.reconcileOverlay()
    return result
  }

  /** Create and start a resident server for a workspace root on first use. */
  private async ensureResident(workspaceRoot: string): Promise<{ resident: ResidentSandbox; inbox: string; start: Promise<void> }> {
    const existing = this.residents.get(workspaceRoot)
    if (existing !== undefined) {
      await existing.start
      return existing
    }
    const provider = this.ctx.get('sandbox', false) as LinuxSandboxProvider | undefined
    if (provider?.overlaySupported?.() !== true) throw new Error('resident: overlay is unavailable on this host')
    const workspace = this.workspaceFor(workspaceRoot)
    const inbox = mkdtempSync(join(this.candidateParent ?? tmpdir(), 'dsh-resident-inbox-'))
    const overlay = { ...workspace.overlaySpec(), binds: [{ src: inbox, dest: '/dsh-inbox' }] }
    const resident = new ResidentSandbox()
    const start = resident.start({
      confine: argv => provider.confineOverlay(argv, { mode: 'workspace-write', workspaceRoot }, overlay).argv,
      cwd: workspaceRoot,
      env: { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    })
    const entry = { resident, inbox, start }
    this.residents.set(workspaceRoot, entry)
    try {
      await start
    } catch (error) {
      this.residents.delete(workspaceRoot)
      rmSync(inbox, { recursive: true, force: true })
      throw error
    }
    return entry
  }

  /** Stop and forget a workspace's resident server. */
  private stopResident(workspaceRoot: string): void {
    const entry = this.residents.get(workspaceRoot)
    if (entry === undefined) return
    this.residents.delete(workspaceRoot)
    entry.resident.stop()
    rmSync(entry.inbox, { recursive: true, force: true })
  }

  /**
   * Whether a path is inside one of the service's private staging trees. A
   * caller that already holds a staging path must not redirect it again.
   * @param path - the absolute path to test.
   * @returns `true` when the path is a staging path.
   */
  isStagingPath(path: string): boolean {
    for (const workspace of this.branches.values()) {
      if (isUnder(workspace.root, path)) return true
    }
    return false
  }

  /**
   * The branch whose private staging tree contains a path, for restoring
   * staging paths to real ones in command output.
   * @param path - the absolute path to look up.
   * @returns the workspace, or `undefined`.
   */
  workspaceContaining(path: string): CandidateWorkspace | undefined {
    for (const workspace of this.branches.values()) {
      if (isUnder(workspace.root, path)) return workspace
    }
    return undefined
  }

  /**
   * Bind a session to a workspace branch. A later attempt on the session reads
   * the same branch's logical version.
   * @param sessionId - the session identity.
   * @param workspaceRoot - the real workspace root.
   * @param branchId - the branch identity.
   */
  bindSession(sessionId: string, workspaceRoot: string, branchId = 'main'): void {
    this.sessionBranches.set(sessionId, branchKey(workspaceRoot, branchId))
  }

  /**
   * The branch a session is bound to, if any.
   * @param sessionId - the session identity.
   * @returns the workspace root and branch, or `undefined`.
   */
  branchOfSession(sessionId: string): { workspaceRoot: string; branchId: string } | undefined {
    const key = this.sessionBranches.get(sessionId)
    return key === undefined ? undefined : splitBranchKey(key)
  }

  /**
   * The pending staged state for a branch.
   * @param workspaceRoot - the real workspace root.
   * @param branchId - the branch identity; defaults to `main`.
   * @returns the staged state.
   */
  state(workspaceRoot: string, branchId = 'main'): StagedState {
    const key = branchKey(workspaceRoot, branchId)
    const workspace = this.branches.get(key)
    const integrity = workspace?.integrity()
    const changes = workspace?.changes() ?? []
    const pending = this.pending.get(key) ?? null
    const danger = changes.length > 0 || (this.commands.get(key)?.length ?? 0) > 0
      ? this.assess(workspaceRoot, key, changes, workspace)
      : pending !== null ? assessmentOf(pending) : NO_DANGER
    return {
      workspaceRoot,
      branchId,
      materialized: workspace?.materialized ?? false,
      revision: workspace?.stagedRevision ?? 0,
      changes,
      corrupted: integrity?.ok === false,
      danger,
      pending,
    }
  }

  /**
   * Record a command the staged execution ran, so its danger level can account
   * for package installs, downloads, and system modifications that leave no
   * file change.
   * @param workspaceRoot - the real workspace root.
   * @param command - the command line.
   * @param branchId - the branch identity; defaults to `main`.
   */
  recordCommand(workspaceRoot: string, command: CommandIntent, branchId = 'main'): void {
    const key = branchKey(workspaceRoot, branchId)
    const list = this.commands.get(key) ?? []
    list.push(command)
    this.commands.set(key, list)
  }

  /**
   * Freeze and publish a branch's candidate under CAS. A dangerous candidate is
   * frozen and held until the user gives `confirmationsRequired` confirmations
   * (two for L3); the held approval is persisted so a restart restores it. A
   * corrupted logical view is refused before freezing, and a policy `DENY` is
   * never overridden.
   * @param workspaceRoot - the real workspace root.
   * @param options - `force` confirms a policy NEEDS_CONFIRMATION; `confirm`
   *   acknowledges a dangerous change. Either increments the confirmation count.
   * @returns the apply result.
   */
  async apply(workspaceRoot: string, options: { force?: boolean; confirm?: boolean; branchId?: string; files?: readonly string[] } = {}): Promise<ApplyResult> {
    const branchId = options.branchId ?? 'main'
    const key = branchKey(workspaceRoot, branchId)
    const confirming = options.confirm === true || options.force === true
    const workspace = this.branches.get(key)
    const pending = this.pending.get(key)
    const subset = options.files !== undefined && options.files.length > 0 ? options.files : undefined

    // A branch whose content changed since the hold supersedes the old candidate.
    let current: { candidate: CandidateRef; impact: FsImpact[]; files?: readonly string[] } | undefined
    if (workspace !== undefined) {
      const integrity = workspace.integrity()
      if (!integrity.ok) {
        const { candidate } = workspace.freeze()
        return { kind: 'corrupted', candidate, corrupted: integrity.corrupted }
      }
      if (subset === undefined) {
        current = workspace.freeze()
      } else {
        // Selective publication: only the chosen paths are in the candidate.
        const relative = new Set(subset.map(path => workspace.relativeFor(path) ?? path))
        const entries = workspace.subsetEntries(subset)
        const candidate = freezeCandidate({
          path: workspace.root,
          baseVersion: workspace.baseVersion(),
          scope: workspace.scope,
          entries,
        })
        current = { candidate, impact: workspace.changes().filter(change => relative.has(change.path)), files: subset }
      }
    }
    if (pending !== undefined && current !== undefined && pending.candidate.digest !== current.candidate.digest) {
      this.clearPending(key, pending)
    }

    // A held candidate is the artifact the user reviewed; operate on it.
    const held = this.pending.get(key)
    if (held !== undefined) {
      const received = Math.min(held.confirmationsReceived + (confirming ? 1 : 0), held.confirmationsRequired)
      if (received < held.confirmationsRequired) {
        this.persist({ ...held, confirmationsReceived: received }, key)
        return { kind: 'needs-authorization', candidate: held.candidate, reasonCodes: held.reasons.map(reason => reason.code), danger: assessmentOf(held) }
      }
      return this.publishHeld(workspaceRoot, branchId, key, held.candidate, assessmentOf(held), options.force === true, held.files)
    }

    if (current === undefined) return { kind: 'nothing-to-apply' }
    // A covering narrow grant lets a pre-sanctioned task auto-apply: it removes
    // the confirmation requirement (never a policy DENY) inside its scope and
    // consumes its file budget.
    const covered = !confirming
      ? this.grants.findCovering({ root: workspaceRoot, operation: 'apply', fileCount: current.impact.length })
      : undefined
    if (covered !== undefined) this.grants.consume(covered.id, current.impact.length)
    const effectiveForce = options.force === true || covered !== undefined
    const danger = this.assess(workspaceRoot, key, current.impact, workspace)
    if (danger.dangerous && covered === undefined) {
      const received = Math.min(confirming ? 1 : 0, danger.confirmationsRequired)
      if (received < danger.confirmationsRequired) {
        const record = this.hold(workspaceRoot, branchId, current.candidate, danger, received, current.files)
        this.persist(record, key)
        return { kind: 'needs-authorization', candidate: record.candidate, reasonCodes: danger.reasons.map(reason => reason.code), danger }
      }
    }
    return this.publishHeld(workspaceRoot, branchId, key, current.candidate, danger, effectiveForce, current.files)
  }

  /**
   * Issue a narrow task grant that lets a sanctioned task auto-apply inside its
   * declared scope, operations, file budget, and TTL.
   * @param input - the task, roots, operations, optional budget, and TTL.
   * @returns the created grant.
   */
  issueGrant(input: { taskId: string; roots: readonly string[]; operations: readonly GrantOperation[]; fileBudget?: number | null; ttlMs: number }): TaskGrant {
    return this.grants.issue(input)
  }

  /**
   * Revoke a task grant.
   * @param id - the grant identity.
   */
  revokeGrant(id: string): void {
    this.grants.revoke(id)
  }

  /** The live task grants, for diagnostics. */
  listGrants(): TaskGrant[] {
    return this.grants.list()
  }

  /**
   * Revert one staged file to the base (reject it), leaving the rest pending.
   * Any held candidate is superseded because the frozen content changed.
   * @param workspaceRoot - the real workspace root.
   * @param path - the real path to revert.
   * @param branchId - the branch identity; defaults to `main`.
   * @returns whether a staged change was reverted.
   */
  rejectFile(workspaceRoot: string, path: string, branchId = 'main'): boolean {
    const key = branchKey(workspaceRoot, branchId)
    const workspace = this.branches.get(key)
    if (workspace === undefined || workspace.relativeFor(path) === undefined) return false
    workspace.revert(path)
    this.clearPending(key, this.pending.get(key))
    return true
  }

  /** Classify a branch's danger, scanning commands against the logical view. */
  private assess(workspaceRoot: string, key: string, changes: readonly FsImpact[], workspace: CandidateWorkspace | undefined): DangerAssessment {
    const commands = this.commands.get(key) ?? []
    return assessDanger({
      workspaceRoot,
      changes,
      commands,
      cwd: workspaceRoot,
      ...(workspace === undefined ? {} : { readFile: (path: string) => workspace.readText(path) }),
    })
  }

  /** Run the policy gate and publish one candidate (whole or a file subset). */
  private async publishHeld(workspaceRoot: string, branchId: string, key: string, candidate: CandidateRef, danger: DangerAssessment, force: boolean, files?: readonly string[]): Promise<ApplyResult> {
    const verdict = await this.ctx.sandboxPolicyEngine.evaluate(this.factsFor(workspaceRoot, branchId, candidate))
    if (verdict.decision === 'DENY') return { kind: 'denied', candidate, reasonCodes: verdict.reasonCodes }
    if (verdict.decision === 'NEEDS_CONFIRMATION' && !force) {
      return { kind: 'needs-authorization', candidate, reasonCodes: verdict.reasonCodes, danger }
    }
    const lease = this.leases.acquire(`workspace:${workspaceRoot}`, 'workspace-staging', this.leaseTtlMs)
    const outcome = await this.publisher.publish({ operationId: `apply_${branchId}_${candidate.digest}`, candidate, expectedBase: candidate.baseVersion, target: workspaceRoot, lease })
    this.leases.release(lease)
    if (outcome.kind === 'published') {
      if (files !== undefined) {
        // Selective publication: re-base and keep the remaining changes pending.
        this.branches.get(key)?.reBase(files)
        this.clearPending(key, this.pending.get(key))
        return { kind: 'published', receipt: outcome.receipt, candidate }
      }
      const branch = this.branches.get(key)
      branch?.dispose()
      this.branches.delete(key)
      this.commands.delete(key)
      this.clearPending(key, this.pending.get(key))
      this.stopResident(workspaceRoot)
      return { kind: 'published', receipt: outcome.receipt, candidate }
    }
    return { kind: outcome.kind, candidate }
  }

  /** Freeze a candidate into a durable held record. */
  private hold(workspaceRoot: string, branchId: string, candidate: CandidateRef, danger: DangerAssessment, received: number, files?: readonly string[]): PendingConfirmation {
    const durable = this.fileStore === undefined ? candidate : { ...candidate, path: this.fileStore.snapshotCandidate(candidate.digest, candidate.path) }
    return {
      workspaceRoot,
      branchId,
      candidate: durable,
      ...(files === undefined ? {} : { files }),
      level: danger.level,
      marker: danger.marker,
      confirmationsRequired: danger.confirmationsRequired,
      confirmationsReceived: received,
      consequences: danger.consequences,
      reasons: danger.reasons,
      frozenAt: Date.now(),
    }
  }

  /** Persist one pending record and hold it in memory. */
  private persist(record: PendingConfirmation, key: string): void {
    this.pending.set(key, record)
    this.store.put(record)
  }

  /** Remove a pending record and its durable candidate tree. */
  private clearPending(key: string, record: PendingConfirmation | undefined): void {
    this.pending.delete(key)
    if (record === undefined) return
    this.store.remove(record.workspaceRoot, record.branchId)
    this.fileStore?.dropCandidate(record.candidate.digest)
  }

  /** Build the publication fact snapshot for one branch candidate. */
  private factsFor(workspaceRoot: string, branchId: string, candidate: CandidateRef): PolicyFacts {
    return {
      schemaVersion: '2.3',
      phase: 'publication',
      platform: 'linux',
      identity: { tenant: 'local', caller: 'workspace-staging' },
      envelope: { mode: 'workspace-write', workspaceRoot, backendId: 'linux', backendVersion: 'unknown', exe: '', argv: [], cwd: workspaceRoot },
      candidate: { digest: candidate.digest, baseVersion: candidate.baseVersion, manifestDigest: candidate.manifestDigest, scope: candidate.scope },
      coverage: { fs: 'partial', process: 'missing', network: 'missing' },
      grants: [],
    }
  }

  /**
   * Discard a branch's logical workspace and any held approval.
   * @param workspaceRoot - the real workspace root.
   * @param branchId - the branch identity; defaults to `main`.
   */
  discard(workspaceRoot: string, branchId = 'main'): void {
    const key = branchKey(workspaceRoot, branchId)
    this.clearPending(key, this.pending.get(key))
    this.commands.delete(key)
    if (branchId === 'main') this.stopResident(workspaceRoot)
    const workspace = this.branches.get(key)
    if (workspace === undefined) return
    workspace.dispose()
    this.branches.delete(key)
  }
}

/** The default durable state directory for held approvals. */
export function defaultStateDir(): string {
  return join(homedir(), '.dsh', 'sandbox-state')
}

/** The map key for one workspace branch. */
function branchKey(workspaceRoot: string, branchId: string): string {
  return JSON.stringify([workspaceRoot, branchId])
}

/** Whether a path is the root or a descendant of it. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Split a branch map key back into its parts. */
function splitBranchKey(key: string): { workspaceRoot: string; branchId: string } {
  const [workspaceRoot, branchId] = JSON.parse(key) as [string, string]
  return { workspaceRoot, branchId }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxWorkspace: WorkspaceStagingService
  }
}

export default WorkspaceStagingService
