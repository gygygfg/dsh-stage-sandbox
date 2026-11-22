/**
 * `ctx.sandbox` 的 NT 实现（K0 档）。
 *
 * 组装关系：
 *   NtSandboxProvider
 *     ├─ NtSession      （策略下发 / 域注册 / launcher argv）
 *     ├─ NtExecutor     （confine → spawn → 分类）
 *     └─ NtStatus       （每次 confine 前重新核对；不允许用过期状态放行）
 *
 * 与 legacy（T0/T1）的关系：provider 名与行为都不同；启用 `enforcement='kernel'`
 * 时才装配本 provider，legacy 路径保持原样（见 docs/nt/README.md §8）。
 *
 * @module winstage-sandbox/nt/provider
 */

import { NtExecutor, type NtSpawn } from './executor.ts'
import { buildLauncherArgv } from './launcher-args.ts'
import { compilePolicy, defaultRulesForDomain, type CompiledPolicy } from './policy.ts'
import { NtSession } from './session.ts'
import { assertKernelReady, writeBarrierFor } from './status.ts'
import {
  NtError,
  defaultJobLimits,
  type NtDomain,
  type NtDriverPort,
  type NtEndpoint,
  type NtNetworkMode,
  type NtPolicySet,
  type NtStatus,
  type NtTokenMode,
} from './types.ts'

export interface NtProviderOptions {
  /** 真实工作区（lower）。 */
  workspaceRoot: string
  /** ProjFS 视图根（upper）。 */
  viewRoot: string
  /** 控制面 store（候选/证据/journal）。 */
  storeRoot: string
  /** launcher 绝对路径。 */
  launcherPath: string
  driver: NtDriverPort
  /** 状态快照或读取器（每次 confine 重新取）。 */
  status: NtStatus | (() => NtStatus)
  /** 缺省令牌模式。 */
  tokenMode?: NtTokenMode
  /** 缺省网络档位（默认 offline）。 */
  network?: NtNetworkMode
  /** `network='allowlist'` 的端点（IP 字面量）。 */
  networkAllow?: NtEndpoint[]
  job?: Partial<NtDomain['job']>
  /** 额外规则（默认规则已包含“工作区写/删/改名 = stage”）。 */
  extraRules?: NtDomain['rules']
  /** AppContainer SID（tokenMode='appcontainer' 必填）。 */
  appContainerSid?: string
  /** 域 id（默认 `dsh-<pid>-<counter>`）。 */
  domainId?: string
  /**
   * 直接使用这份策略（由 supervisor 构造/下发），而不是按选项重建。
   * `domainId` 用于在其中选中域；缺省时取第一个域。
   */
  policy?: NtPolicySet
  /** 采用 supervisor 已下发/注册的域：`init()` 不再 setPolicy。 */
  adoptAppliedPolicy?: boolean
}

export interface NtProviderDomain {
  domain: NtDomain
  policy: NtPolicySet
}

let domainCounter = 0

/** 为一个工作区生成默认域 + 策略（控制面/CLI/测试共用）。 */
export function buildDomainPolicy(input: {
  workspaceRoot: string
  viewRoot: string
  storeRoot: string
  domainId?: string
  tokenMode?: NtTokenMode
  network?: NtNetworkMode
  networkAllow?: NtEndpoint[]
  job?: Partial<NtDomain['job']>
  extraRules?: NtDomain['rules']
  appContainerSid?: string
  generation?: number
}): NtProviderDomain {
  domainCounter += 1
  const id = input.domainId ?? `dsh-${process.pid}-${domainCounter}`
  const tokenMode = input.tokenMode ?? 'restricted'
  const network = input.network ?? 'offline'
  const job = { ...defaultJobLimits(), ...(input.job ?? {}) }

  const domain: NtDomain = {
    id,
    label: `dsh.ai.${id}`,
    workspaceRoot: input.workspaceRoot,
    viewRoot: input.viewRoot,
    storeRoot: input.storeRoot,
    tokenMode,
    ...(input.appContainerSid === undefined ? {} : { appContainerSid: input.appContainerSid }),
    job,
    network: { mode: network, allow: [...(input.networkAllow ?? [])] },
    defaultRead: 'allow',
    rules: [
      ...defaultRulesForDomain({
        workspaceRoot: input.workspaceRoot,
        storeRoot: input.storeRoot,
        viewRoot: input.viewRoot,
      }),
      ...(input.extraRules ?? []),
    ],
  }

  const policy: NtPolicySet = {
    version: 1,
    generation: input.generation ?? 1,
    createdAt: new Date().toISOString(),
    globalMasks: [],
    domains: [domain],
  }
  return { domain, policy }
}

/**
 * NT 沙箱 provider。构造即校验策略（非法直接抛 `NT_POLICY_INVALID`），
 * 但**不**触碰驱动：`init()` 才下发/注册。
 */
export class NtSandboxProvider {
  readonly name = 'dshnt'
  readonly domain: NtDomain
  readonly policy: NtPolicySet
  readonly session: NtSession
  private readonly options: NtProviderOptions
  private readonly compiled: CompiledPolicy
  private readonly executors = new Set<NtExecutor>()
  private disposed = false

  constructor(options: NtProviderOptions) {
    this.options = options
    const built =
      options.policy === undefined
        ? buildDomainPolicy({
            workspaceRoot: options.workspaceRoot,
            viewRoot: options.viewRoot,
            storeRoot: options.storeRoot,
            ...(options.domainId === undefined ? {} : { domainId: options.domainId }),
            ...(options.tokenMode === undefined ? {} : { tokenMode: options.tokenMode }),
            ...(options.network === undefined ? {} : { network: options.network }),
            ...(options.networkAllow === undefined ? {} : { networkAllow: options.networkAllow }),
            ...(options.job === undefined ? {} : { job: options.job }),
            ...(options.extraRules === undefined ? {} : { extraRules: options.extraRules }),
            ...(options.appContainerSid === undefined ? {} : { appContainerSid: options.appContainerSid }),
          })
        : (() => {
            const domain =
              options.domainId === undefined
                ? options.policy.domains[0]
                : options.policy.domains.find((candidate) => candidate.id === options.domainId)
            if (domain === undefined) {
              throw new NtError('NT_POLICY_INVALID', {
                reason: 'provided policy does not contain the requested domain',
                domainId: options.domainId,
              })
            }
            return { domain, policy: options.policy }
          })()
    this.domain = built.domain
    this.policy = built.policy
    this.compiled = compilePolicy(this.policy)
    this.session = new NtSession({
      domain: this.domain,
      policy: this.policy,
      driver: options.driver,
      status: options.status,
      launcherPath: options.launcherPath,
      ...(options.adoptAppliedPolicy === true ? { adoptAppliedPolicy: true } : {}),
    })
  }

  /** 当前状态（每次都重新取，驱动可能刚被卸载）。 */
  status(): NtStatus {
    return typeof this.options.status === 'function' ? this.options.status() : this.options.status
  }

  /** 写屏障分类（状态卡用）。 */
  writeBarrier(): string {
    return writeBarrierFor(this.status())
  }

  /** 下发策略 + 注册域。 */
  async init(): Promise<void> {
    await this.session.init()
  }

  /**
   * 装配 K0 执行器（同一个域）。
   *
   * 每次调用返回**新**执行器：spawn/超时/输出上限属于调用点，缓存会让第二次调用
   * 静默复用一个不该复用的 spawn（自测里正是这样抓到“失败分类消失”）。
   */
  executorFor(
    spawn: NtSpawn,
    extras: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
  ): NtExecutor {
    const executor = new NtExecutor({
      session: this.session,
      status: () => this.status(),
      spawn,
      ...(extras.cwd === undefined ? {} : { cwd: extras.cwd }),
      ...(extras.env === undefined ? {} : { env: extras.env }),
      ...(extras.timeoutMs === undefined ? {} : { timeoutMs: extras.timeoutMs }),
      ...(extras.maxOutputBytes === undefined ? {} : { maxOutputBytes: extras.maxOutputBytes }),
    })
    this.executors.add(executor)
    return executor
  }

  /** 只构造 argv（不启动）；工具层预览/审计用。 */
  confine(argv: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): string[] {
    assertKernelReady(this.status(), { requireApplyHelper: false })
    return buildLauncherArgv({
      launcherPath: this.options.launcherPath,
      domain: this.domain.id,
      viewRoot: this.domain.viewRoot,
      workspaceRoot: this.domain.workspaceRoot,
      policyGeneration: this.policy.generation,
      network: this.domain.network.mode,
      allow: this.domain.network.allow,
      job: this.domain.job,
      tokenMode: this.domain.tokenMode,
      ...(this.domain.appContainerSid === undefined ? {} : { appContainerSid: this.domain.appContainerSid }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      argv,
    })
  }

  /** 判定一次路径访问（控制面自检/面板解释用）。 */
  decide(path: string, access: Parameters<CompiledPolicy['decide']>[2]) {
    return this.compiled.decide(this.domain.id, path, access)
  }

  /** 注销域并释放执行器。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const executor of this.executors) {
      await executor.dispose()
    }
    this.executors.clear()
    await this.session.dispose()
  }
}

/** 便捷构造：没有驱动/状态时 fail-closed（不返回“看起来能跑”的 provider）。 */
export function createNtProvider(options: NtProviderOptions): NtSandboxProvider {
  const status = typeof options.status === 'function' ? options.status() : options.status
  if (status.enforcement !== 'kernel-projfs-minifilter') {
    throw new NtError('NT_CAPABILITY_MISSING', {
      reason: 'kernel enforcement is not available',
      enforcement: status.enforcement,
    })
  }
  return new NtSandboxProvider(options)
}
