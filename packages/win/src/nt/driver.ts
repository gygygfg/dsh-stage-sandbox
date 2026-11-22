/**
 * 驱动通信端口的客户端契约与假实现。
 *
 * 真实实现（M1）会通过 koffi/FFI 或原生 addon 调 `FilterConnectCommunicationPort`；
 * 在 Linux/CI 上则使用 `FakeDriverPort` 验证控制面逻辑。这样策略、状态、失败语义
 * 都可以在**没有 Windows 驱动**的环境里单测，而不是把“没测”藏进 Windows-only 脚本。
 *
 * 安全约束：
 *   · 端口只接受控制面/launcher 的注册请求；沙箱进程不得持有端口句柄；
 *   · `setPolicy` 必须带 64 位十六进制 SHA-256；驱动按 generation 原子切换；
 *   · `grantApply` 只对 apply helper 的 PID + image hash 临时授权，退出即撤销。
 *
 * @module winstage-sandbox/nt/driver
 */

import {
  NT_DRIVER_ABI_VERSION,
  NtError,
  type NtDriverEvent,
  type NtDriverHello,
  type NtDriverPort,
  type NtDriverStats,
} from './types.ts'

/** 假端口选项（测试用）。 */
export interface FakeDriverOptions {
  hello?: Partial<NtDriverHello>
  failHello?: boolean
  failSetPolicy?: boolean
  failRegisterDomain?: boolean
}

/** 内存假驱动：行为与真实契约对齐，但不触碰内核。 */
export class FakeDriverPort implements NtDriverPort {
  private readonly helloValue: NtDriverHello
  private readonly failHello: boolean
  private readonly failSetPolicy: boolean
  private readonly failRegisterDomain: boolean
  private readonly domains = new Map<string, { id: string; viewRoot: string; appContainerSid?: string }>()
  private readonly applies = new Map<number, { pid: number; imageHash: string; paths: string[] }>()
  private readonly listeners = new Set<(event: NtDriverEvent) => void>()
  private currentPolicyHash: string | undefined
  private currentPayload: Uint8Array | undefined
  private stats: NtDriverStats = {
    domains: 0,
    rules: 0,
    redirects: 0,
    denies: 0,
    masks: 0,
    policyGeneration: 0,
  }

  constructor(options: FakeDriverOptions = {}) {
    this.helloValue = {
      abiVersion: NT_DRIVER_ABI_VERSION,
      driverVersion: 'fake-0.1.0',
      altitude: '0',
      supports: ['policy', 'domain', 'apply', 'events'],
      ...(options.hello ?? {}),
    }
    this.failHello = options.failHello === true
    this.failSetPolicy = options.failSetPolicy === true
    this.failRegisterDomain = options.failRegisterDomain === true
  }

  async hello(): Promise<NtDriverHello> {
    if (this.failHello) throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'fake hello failure' })
    return { ...this.helloValue, supports: [...this.helloValue.supports] }
  }

  async setPolicy(payload: Uint8Array, hash: string, generation: number): Promise<{ generation: number }> {
    if (this.failSetPolicy) throw new NtError('NT_POLICY_INVALID', { reason: 'fake setPolicy failure' })
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
      throw new NtError('NT_POLICY_INVALID', { reason: 'empty policy payload' })
    }
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new NtError('NT_POLICY_INVALID', { reason: 'policy hash must be 64 lowercase hex chars' })
    }
    if (!Number.isInteger(generation) || generation <= 0) {
      throw new NtError('NT_POLICY_INVALID', { reason: 'policy generation must be a positive integer' })
    }
    if (generation < this.stats.policyGeneration) {
      throw new NtError('NT_POLICY_GENERATION_MISMATCH', {
        current: this.stats.policyGeneration,
        requested: generation,
      })
    }
    if (generation === this.stats.policyGeneration) {
      // 幂等：同 generation 不重复切换。
      return { generation }
    }
    this.currentPayload = payload.slice()
    this.currentPolicyHash = hash
    this.stats = { ...this.stats, policyGeneration: generation }
    this.emit({ type: 'driver', at: new Date().toISOString(), detail: `policy generation ${this.stats.policyGeneration}` })
    return { generation }
  }

  async registerDomain(input: { id: string; viewRoot: string; appContainerSid?: string }): Promise<void> {
    if (this.failRegisterDomain) {
      throw new NtError('NT_DOMAIN_NOT_REGISTERED', { reason: 'fake registerDomain failure' })
    }
    if (typeof input.id !== 'string' || input.id.length === 0) {
      throw new NtError('NT_DOMAIN_NOT_REGISTERED', { reason: 'empty domain id' })
    }
    if (typeof input.viewRoot !== 'string' || input.viewRoot.length === 0) {
      throw new NtError('NT_VIEW_ROOT_INVALID', { reason: 'empty viewRoot' })
    }
    if (this.domains.has(input.id)) {
      throw new NtError('NT_DOMAIN_DUPLICATE', { id: input.id })
    }
    this.domains.set(input.id, { ...input })
    this.stats = { ...this.stats, domains: this.domains.size }
    this.emit({ type: 'domain', at: new Date().toISOString(), domainId: input.id, detail: 'registered' })
  }

  async unregisterDomain(id: string): Promise<void> {
    if (!this.domains.delete(id)) {
      throw new NtError('NT_DOMAIN_NOT_REGISTERED', { id })
    }
    this.stats = { ...this.stats, domains: this.domains.size }
    this.emit({ type: 'domain', at: new Date().toISOString(), domainId: id, detail: 'unregistered' })
  }

  async grantApply(input: { pid: number; imageHash: string; paths: string[] }): Promise<void> {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'invalid pid' })
    }
    if (!/^[0-9a-f]{64}$/.test(input.imageHash)) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'imageHash must be 64 lowercase hex chars' })
    }
    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'paths must be a non-empty array' })
    }
    this.applies.set(input.pid, { pid: input.pid, imageHash: input.imageHash, paths: [...input.paths] })
  }

  async revokeApply(pid: number): Promise<void> {
    this.applies.delete(pid)
  }

  async queryStats(): Promise<NtDriverStats> {
    return { ...this.stats }
  }

  onEvent(listener: (event: NtDriverEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 测试用：查看当前策略哈希（真实驱动不暴露给普通调用方）。 */
  get policyHash(): string | undefined {
    return this.currentPolicyHash
  }

  /** 测试用：查看当前策略 payload。 */
  get policyPayload(): Uint8Array | undefined {
    return this.currentPayload === undefined ? undefined : this.currentPayload.slice()
  }

  /** 测试用：触发一条事件。 */
  emit(event: NtDriverEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** 真实驱动不可用时的占位实现：每个调用都 fail-closed，`onEvent` 返回 noop。 */
export class UnavailableDriverPort implements NtDriverPort {
  private readonly reason: string

  constructor(reason: string = 'driver port not implemented') {
    this.reason = reason
  }

  async hello(): Promise<NtDriverHello> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async setPolicy(_payload: Uint8Array, _hash: string, _generation: number): Promise<{ generation: number }> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async registerDomain(_input: { id: string; viewRoot: string; appContainerSid?: string }): Promise<void> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async unregisterDomain(_id: string): Promise<void> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async grantApply(_input: { pid: number; imageHash: string; paths: string[] }): Promise<void> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async revokeApply(_pid: number): Promise<void> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  async queryStats(): Promise<NtDriverStats> {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: this.reason })
  }

  onEvent(): () => void {
    return () => {}
  }
}

/**
 * 创建驱动端口。
 *
 * 当前（M0/M1 之间）真实 FFI 尚未接线：默认返回 `UnavailableDriverPort`，
 * 只有显式 `fake: true` 或 `DSH_NT_FAKE_DRIVER=1` 才返回假端口。
 * 这样任何生产路径在驱动未实现/未加载时都会 fail-closed，而不是“看起来成功”。
 */
export function createDriverPort(options: { fake?: boolean; port?: NtDriverPort } = {}): NtDriverPort {
  if (options.port !== undefined) return options.port
  if (options.fake === true || process.env.DSH_NT_FAKE_DRIVER === '1') return new FakeDriverPort()
  return new UnavailableDriverPort('real FilterConnectCommunicationPort client is not wired yet')
}
