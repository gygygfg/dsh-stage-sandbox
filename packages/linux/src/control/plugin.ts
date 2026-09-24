/**
 * The Cordis service wrapper around the sandbox control plane. It registers as
 * `ctx.sandboxControl`, injects the `ctx.sandbox` provider for confinement,
 * and owns the stager, publisher, and lease registry. The pure orchestrator
 * lives in `./service.ts`; this module is only the composition and the
 * `ctx`-facing method surface.
 * @module dsh-sandbox-linux/control/plugin
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { tmpdir } from 'node:os'
import type { LinuxSandboxProvider } from '../index.ts'
import type {} from '../policy/plugin.ts'
import { DirectoryPublicationBackend } from '../publish/directory-backend.ts'
import { Publisher } from '../publish/publisher.ts'
import { LeaseRegistry } from './lease.ts'
import type { OperationRecord } from './records.ts'
import { SandboxControl, hostPlatform, type BackendSelector } from './service.ts'
import type { PlanRequest } from './intent.ts'
import { StagingStager } from '../stage/stager.ts'
import { FileControlStore } from './store.ts'
import { FileReceiptStore, MemoryReceiptStore } from '../publish/receipt-store.ts'

/** Plugin config for the control plane. */
export interface Config {
  /** Absolute workspace root the stager copies and the publisher targets. */
  workspaceRoot: string
  /** Directory private candidate trees are created under; defaults to the OS temp dir. */
  candidateParent?: string
  /** Wall-clock timeout for one staged command, in milliseconds. */
  timeoutMs?: number
  /** Publication lease lifetime, in milliseconds. */
  leaseTtlMs?: number
  /**
   * Durable state directory for operation records and publication receipts;
   * empty string keeps them process-local.
   */
  stateDir?: string
}

/**
 * The sandbox control service. It exposes the dry-run/commit operations over
 * one workspace; a caller submits a plan, stages it, and publishes the frozen
 * candidate, and the real workspace changes only at publication.
 */
export class SandboxControlService extends Service {
  static inject = ['sandbox', 'sandboxPolicyEngine']

  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    workspaceRoot: z.string(),
    candidateParent: z.string().default(''),
    timeoutMs: z.natural().default(60_000),
    leaseTtlMs: z.natural().default(30_000),
    stateDir: z.string().default(''),
  })

  /** The pure orchestrator. */
  private readonly control: SandboxControl

  /**
   * @param ctx - the plugin context; `ctx.sandbox` must be mounted.
   * @param config - the workspace root and timing knobs.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxControl')
    const provider = ctx.sandbox as LinuxSandboxProvider
    const backends: BackendSelector = {
      report: platform => provider.reportForHostPlatform(hostPlatform(platform)),
    }
    const candidateParent = config.candidateParent === '' ? undefined : config.candidateParent
    // The overlay path avoids the full workspace copy; it is only enabled when
    // the host can actually mount a bwrap overlay, so the copy fallback and the
    // chosen path can never disagree.
    const overlayOk = provider.overlaySupported()
    const stager = new StagingStager({
      workspaceRoot: config.workspaceRoot,
      ...(candidateParent === undefined ? {} : { candidateParent }),
      confine: (argv, policy) => ctx.sandbox.confine(argv, policy),
      ...(overlayOk ? { confineOverlay: (argv, policy, overlay) => provider.confineOverlay(argv, policy, overlay) } : {}),
      scope: { categories: ['filesystem'], writableRoots: [config.workspaceRoot] },
      timeoutMs: config.timeoutMs as number,
      limits: provider.runtimeOptions.limits,
    })
    const leases = new LeaseRegistry()
    const stateDir = config.stateDir === undefined || config.stateDir === '' ? undefined : config.stateDir
    const receipts = stateDir === undefined ? new MemoryReceiptStore() : new FileReceiptStore(stateDir)
    const publisher = new Publisher(new DirectoryPublicationBackend(), leases, undefined, receipts)
    this.control = new SandboxControl({
      backends,
      stager,
      publisher,
      leases,
      gate: ctx.sandboxPolicyEngine.gate,
      ...(stateDir === undefined ? {} : { store: new FileControlStore(stateDir) }),
    })
    ctx.logger.info(`sandbox-control: staging under ${candidateParent ?? tmpdir()}, workspace ${config.workspaceRoot}`)
  }

  /**
   * Submit a plan.
   * @param request - the plan request.
   * @returns the created or replayed operation record.
   */
  submit(request: PlanRequest): OperationRecord {
    return this.control.submit(request)
  }

  /**
   * Read an operation record.
   * @param commandId - the operation identity.
   * @returns the record.
   */
  status(commandId: string): OperationRecord {
    return this.control.status(commandId)
  }

  /**
   * Grant execution authorization.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  authorizeExecution(commandId: string): OperationRecord {
    return this.control.authorizeExecution(commandId)
  }

  /**
   * Stage an authorized plan and freeze its candidate.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  stage(commandId: string): Promise<OperationRecord> {
    return this.control.stage(commandId)
  }

  /**
   * Grant publication authorization.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  authorizePublication(commandId: string): OperationRecord {
    return this.control.authorizePublication(commandId)
  }

  /**
   * Publish a frozen candidate under CAS.
   * @param commandId - the operation identity.
   * @param target - the publication target.
   * @param expectedBase - the base version the candidate expects.
   * @returns the updated record.
   */
  publish(commandId: string, target: string, expectedBase: string): Promise<OperationRecord> {
    return this.control.publish(commandId, target, expectedBase)
  }

  /**
   * Reconcile an operation whose publication outcome was unknown.
   * @param commandId - the operation identity.
   * @returns the updated record.
   */
  reconcile(commandId: string): OperationRecord {
    return this.control.reconcile(commandId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxControl: SandboxControlService
  }
}

export default SandboxControlService
