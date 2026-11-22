/**
 * 一个 NT 沙箱会话/域的生命周期：编译策略 → 下发驱动 → 注册域 → 生成 launcher argv。
 *
 * 这一层是 `ctx.sandbox` provider / CLI / `NtStageExecutor` 的共同底座：
 *   · 它不 spawn、不碰 ProjFS、不读写真实文件；
 *   · 它只依赖 `NtDriverPort` 与 `buildLauncherArgv`，因此可在 Linux 上用 Fake 驱动单测；
 *   · 任何不满足内核前置条件的状态都 fail-closed，不返回“看起来能跑”的 argv。
 *
 * @module winstage-sandbox/nt/session
 */

import { buildLauncherArgv, type LauncherArgvInput } from './launcher-args.ts'
import { canonicalPolicyJson, compilePolicy, type CompiledPolicy } from './policy.ts'
import { assertKernelReady } from './status.ts'
import {
  NT_DRIVER_ABI_VERSION,
  NtError,
  type NtAccess,
  type NtDecision,
  type NtDomain,
  type NtDriverPort,
  type NtPolicySet,
  type NtStatus,
} from './types.ts'

/** `confine` 的结果；与 dsh `ConfinedArgv` 的字段对齐。 */
export interface NtConfinedCommand {
  argv: string[]
  domainId: string
  viewRoot: string
  enforcement: 'full' | 'partial'
  denialSignatures: string[]
  runnerFailureRules: Array<{ fatalSignatures: string[]; informationalLines?: string[] }>
}

/** 会话依赖（全部可注入，便于测试）。 */
export interface NtSessionOptions {
  domain: NtDomain
  policy: NtPolicySet
  driver: NtDriverPort
  /** 当前状态快照，或每次判定时重新取（驱动可能被卸载）。 */
  status: NtStatus | (() => NtStatus)
  launcherPath: string
  /** init 时是否要求 apply helper 就绪（默认 false；apply 是发布阶段才需要）。 */
  requireApplyHelper?: boolean
}

/** 驱动返回的 policy generation 与控制面不一致时抛错的细节。 */
export interface NtSessionInitReport {
  domainId: string
  policyGeneration: number
  policyHash: string
  driverGeneration: number
  viewRoot: string
}

/**
 * 会话对象。`init()` 幂等；`dispose()` 幂等且失败不抛（清理路径不应掩盖原始错误）。
 */
export class NtSession {
  private readonly options: NtSessionOptions
  private compiled: CompiledPolicy | undefined
  private initialized = false
  private initReport: NtSessionInitReport | undefined

  constructor(options: NtSessionOptions) {
    this.options = options
  }

  get domainId(): string {
    return this.options.domain.id
  }

  get viewRoot(): string {
    return this.options.domain.viewRoot
  }

  get report(): NtSessionInitReport | undefined {
    return this.initReport
  }

  /**
   * 初始化：状态/策略/驱动握手/下发/注册域。
   *
   * @throws `NT_CAPABILITY_*` / `NT_POLICY_*` / `NT_DOMAIN_*` / `NT_DRIVER_*`
   */
  async init(): Promise<NtSessionInitReport> {
    if (this.initialized && this.initReport !== undefined) return this.initReport

    assertKernelReady(this.currentStatus(), {
      requireApplyHelper: this.options.requireApplyHelper === true,
    })
    const compiled = compilePolicy(this.options.policy)
    if (!compiled.domains.has(this.options.domain.id)) {
      throw new NtError('NT_POLICY_INVALID', { reason: 'domain is not present in policy', domainId: this.options.domain.id })
    }
    const hello = await this.options.driver.hello()
    if (hello.abiVersion !== NT_DRIVER_ABI_VERSION) {
      throw new NtError('NT_DRIVER_VERSION_MISMATCH', {
        expected: NT_DRIVER_ABI_VERSION,
        actual: hello.abiVersion,
        driverVersion: hello.driverVersion,
      })
    }

    const payload = new TextEncoder().encode(canonicalPolicyJson(this.options.policy))
    const applied = await this.options.driver.setPolicy(payload, compiled.hash, compiled.generation)
    await this.options.driver.registerDomain({
      id: this.options.domain.id,
      viewRoot: this.options.domain.viewRoot,
      ...(this.options.domain.appContainerSid === undefined
        ? {}
        : { appContainerSid: this.options.domain.appContainerSid }),
    })

    this.compiled = compiled
    this.initialized = true
    this.initReport = {
      domainId: this.options.domain.id,
      policyGeneration: compiled.generation,
      policyHash: compiled.hash,
      driverGeneration: applied.generation,
      viewRoot: this.options.domain.viewRoot,
    }
    return this.initReport
  }

  /**
   * 把目标 argv 包成 launcher 调用。
   *
   * @param argv - 目标进程 argv（程序 + 参数），不是 shell 字符串
   * @param options - 可覆盖 cwd/env
   * @throws `NT_DOMAIN_NOT_REGISTERED`（未 init）、`NT_PATH_*` / `NT_ENV_*` 等
   */
  confine(
    argv: readonly string[],
    options: { cwd?: string; env?: Record<string, string>; allowSensitiveEnv?: boolean } = {},
  ): NtConfinedCommand {
    if (!this.initialized) {
      throw new NtError('NT_DOMAIN_NOT_REGISTERED', { domainId: this.options.domain.id, reason: 'session is not initialized' })
    }
    // 驱动可能在 init 之后被卸载/ProjFS provider 可能退出：每次 confine 重新核对，
    // 绝不用过期状态放行。
    assertKernelReady(this.currentStatus(), { requireApplyHelper: false })
    const input: LauncherArgvInput = {
      launcherPath: this.options.launcherPath,
      domain: this.options.domain.id,
      viewRoot: this.options.domain.viewRoot,
      workspaceRoot: this.options.domain.workspaceRoot,
      policyGeneration: this.options.policy.generation,
      network: this.options.domain.network.mode,
      allow: this.options.domain.network.allow,
      job: this.options.domain.job,
      tokenMode: this.options.domain.tokenMode,
      ...(this.options.domain.appContainerSid === undefined
        ? {}
        : { appContainerSid: this.options.domain.appContainerSid }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.allowSensitiveEnv === true ? { allowSensitiveEnv: true } : {}),
      argv,
    }
    return {
      argv: buildLauncherArgv(input),
      domainId: this.options.domain.id,
      viewRoot: this.options.domain.viewRoot,
      enforcement: 'full',
      denialSignatures: ['Access is denied', '拒绝访问', 'STATUS_ACCESS_DENIED', '0xC0000022'],
      runnerFailureRules: [],
    }
  }

  /** 策略判定（生命周期内复用编译结果）。 */
  decide(path: string, access: NtAccess): NtDecision {
    if (this.compiled === undefined) {
      throw new NtError('NT_DOMAIN_NOT_REGISTERED', { domainId: this.options.domain.id, reason: 'session is not initialized' })
    }
    return this.compiled.decide(this.options.domain.id, path, access)
  }

  /** 注销域；幂等，失败不抛。 */
  async dispose(): Promise<void> {
    if (!this.initialized) return
    this.initialized = false
    try {
      await this.options.driver.unregisterDomain(this.options.domain.id)
    } catch (error) {
      // 清理路径不应掩盖原始错误；但也不能静默：调用方可从 driver 日志/状态卡看到。
      if (!(error instanceof NtError && error.code === 'NT_DOMAIN_NOT_REGISTERED')) {
        // 保留最后一次错误供诊断（不抛）。
        this.lastDisposeError = error
      }
    }
  }

  /** 最近一次 dispose 的非预期错误（诊断用）。 */
  lastDisposeError: unknown

  private currentStatus(): NtStatus {
    return typeof this.options.status === 'function' ? this.options.status() : this.options.status
  }
}
