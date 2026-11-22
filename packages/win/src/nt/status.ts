/**
 * NT 沙箱状态、写入屏障与失败语义。
 *
 * 目标只有一个：**让“此刻边界由谁提供”变成可查询的事实**，而不是日志里的一句话。
 *   · `assertKernelReady()` 在驱动/ProjFS/策略/网络/apply 任一缺失时 fail-closed；
 *   · `writeBarrierFor()` 只返回 `kernel-*` 或明确不是内核的档位；
 *   · `classifyNtFailure()` 区分“确定未执行”“命令失败”“未知”，禁止把环境故障
 *     写成“命令没有执行”（反之亦然）。
 *
 * @module winstage-sandbox/nt/status
 */

import {
  NT_DRIVER_ABI_VERSION,
  NtError,
  type NtEnforcement,
  type NtErrorCode,
  type NtStatus,
  type NtWriteBarrier,
} from './types.ts'

/** 创建状态对象；未提供的字段使用“未就绪”的安全默认值。 */
export function createNtStatus(input: Partial<NtStatus> = {}): NtStatus {
  const driver = {
    loaded: false,
    ...(input.driver ?? {}),
  }
  const projfs = {
    enabled: false,
    providerRunning: false,
    ...(input.projfs ?? {}),
  }
  const policy = {
    valid: false,
    ...(input.policy ?? {}),
  }
  const network = {
    mode: 'offline' as const,
    enforced: false,
    ...(input.network ?? {}),
  }
  const apply = {
    helperReady: false,
    ...(input.apply ?? {}),
  }
  const enforcement: NtEnforcement = input.enforcement ?? 'unavailable'
  const kernelReady =
    enforcement === 'kernel-projfs-minifilter' && driver.loaded && projfs.enabled && projfs.providerRunning && policy.valid
  const writeBarrier: NtWriteBarrier =
    input.writeBarrier ?? (kernelReady ? 'kernel-projfs-minifilter' : enforcement === 'legacy' ? 'none' : 'none')
  return {
    enforcement,
    driver,
    projfs,
    policy,
    domains: input.domains ?? 0,
    network,
    apply,
    writeBarrier,
    notes: input.notes ?? [],
  }
}

/**
 * 断言内核路径就绪。任何一项不满足都抛出带机读码的 `NtError`，并把全部缺失项放进 details。
 *
 * @param status - 当前状态
 * @param options - `requireApplyHelper`（默认 false：v1 的 apply 在可信控制面执行，不需要内核 helper）；
 *                  `requireNetwork`（默认按 status.network.mode 判断；`network.perChild` 也算就绪）
 */
export function assertKernelReady(
  status: NtStatus,
  options: { requireApplyHelper?: boolean; requireNetwork?: boolean } = {},
): void {
  // v1 的 apply 由可信控制面完成（journal/undo），内核 apply helper 只在 M2 使用；
  // 需要 helper 的调用方必须显式 `requireApplyHelper: true`，不能用默认值把沙箱误判成未就绪。
  const requireApply = options.requireApplyHelper === true
  const requireNetwork = options.requireNetwork ?? status.network.mode !== 'observed'
  const missing: string[] = []
  let code: NtErrorCode = 'NT_CAPABILITY_MISSING'

  if (status.enforcement !== 'kernel-projfs-minifilter') {
    missing.push(`enforcement=${status.enforcement}`)
  }
  if (!status.driver.loaded) {
    missing.push('driver.loaded=false')
    code = 'NT_DRIVER_UNAVAILABLE'
  } else if (typeof status.driver.abiVersion === 'number' && status.driver.abiVersion !== NT_DRIVER_ABI_VERSION) {
    missing.push(`driver.abiVersion=${status.driver.abiVersion} (expected ${NT_DRIVER_ABI_VERSION})`)
    code = 'NT_DRIVER_VERSION_MISMATCH'
  }
  if (!status.projfs.enabled) {
    missing.push('projfs.enabled=false')
    if (code === 'NT_CAPABILITY_MISSING') code = 'NT_PROJFS_NOT_ENABLED'
  } else if (!status.projfs.providerRunning) {
    missing.push('projfs.providerRunning=false')
    if (code === 'NT_CAPABILITY_MISSING') code = 'NT_PROJFS_PROVIDER_DOWN'
  }
  if (!status.policy.valid) {
    missing.push('policy.valid=false')
    if (code === 'NT_CAPABILITY_MISSING') code = 'NT_POLICY_INVALID'
  }
  if (requireNetwork && !status.network.enforced && status.network.perChild !== true) {
    missing.push(`network.enforced=false (mode=${status.network.mode})`)
    if (code === 'NT_CAPABILITY_MISSING') code = 'NT_NETWORK_UNENFORCED'
  }
  if (requireApply && !status.apply.helperReady) {
    missing.push('apply.helperReady=false')
    if (code === 'NT_CAPABILITY_MISSING') code = 'NT_APPLY_HELPER_UNAVAILABLE'
  }

  if (missing.length > 0) {
    throw new NtError(code, {
      missing,
      driver: status.driver,
      projfs: status.projfs,
      policy: status.policy,
      network: status.network,
      apply: status.apply,
    })
  }
}

/** 是否所有硬条件都满足（不抛异常，供 UI/状态卡使用）。 */
export function isKernelReady(status: NtStatus): boolean {
  try {
    assertKernelReady(status)
    return true
  } catch {
    return false
  }
}

/**
 * 写入屏障分类：
 *   · 内核 ProjFS+minifilter 就绪 ⇒ `kernel-projfs-minifilter`
 *   · 否则原样返回 status.writeBarrier（调用方必须显式设置；默认 `none`）
 */
export function writeBarrierFor(status: NtStatus): NtWriteBarrier {
  if (
    status.enforcement === 'kernel-projfs-minifilter' &&
    status.driver.loaded &&
    status.projfs.enabled &&
    status.projfs.providerRunning
  ) {
    return 'kernel-projfs-minifilter'
  }
  return status.writeBarrier
}

/** 是否有任何内核写屏障（不是用户态 shim）。 */
export function hasKernelWriteBarrier(status: NtStatus): boolean {
  const barrier = writeBarrierFor(status)
  return barrier === 'kernel-projfs-minifilter' || barrier === 'kernel-restricted-token'
}

/** 渲染用户侧状态卡（中文；不写模型可见通道）。 */
export function renderStatusCard(status: NtStatus): string {
  const lines: string[] = []
  const ready = isKernelReady(status)
  lines.push(`NT 沙箱：${ready ? '内核路径就绪' : '未就绪（将 fail-closed）'}`)
  lines.push(`  执行档位: ${status.enforcement}`)
  lines.push(`  写屏障: ${writeBarrierFor(status)}`)
  lines.push(
    `  驱动: ${status.driver.loaded ? '已加载' : '未加载'}` +
      (status.driver.version ? ` v${status.driver.version}` : '') +
      (status.driver.abiVersion !== undefined ? ` abi=${status.driver.abiVersion}` : '') +
      (status.driver.altitude ? ` altitude=${status.driver.altitude}` : '') +
      (status.driver.error ? `（${status.driver.error}）` : ''),
  )
  lines.push(
    `  ProjFS: enabled=${status.projfs.enabled} provider=${status.projfs.providerRunning ? 'running' : 'down'}` +
      (status.projfs.viewRoot ? ` view=${status.projfs.viewRoot}` : '') +
      (status.projfs.error ? `（${status.projfs.error}）` : ''),
  )
  lines.push(
    `  策略: ${status.policy.valid ? 'valid' : 'invalid'}` +
      (status.policy.generation !== undefined ? ` generation=${status.policy.generation}` : '') +
      (status.policy.hash ? ` hash=${status.policy.hash.slice(0, 12)}…` : '') +
      (status.policy.error ? `（${status.policy.error}）` : ''),
  )
  lines.push(`  域: ${status.domains}`)
  lines.push(
    `  网络: ${status.network.mode} enforced=${status.network.enforced}` +
      (status.network.perChild === true ? '（按子进程安装）' : '') +
      (status.network.error ? `（${status.network.error}）` : ''),
  )
  lines.push(
    `  Apply: ${status.apply.helperReady ? 'ready' : 'unavailable'}` + (status.apply.error ? `（${status.apply.error}）` : ''),
  )
  for (const note of status.notes) lines.push(`  注: ${note}`)
  return lines.join('\n')
}

/** 失败分类（用于工具结果/错误文案；不猜测执行状态）。 */
export type NtFailureKind = 'denied' | 'env-fault' | 'apply-conflict' | 'command-failed' | 'unknown'

export interface NtFailure {
  kind: NtFailureKind
  code: string
  message: string
  /** 只在有证据时设置：false=确定未执行，true=确定执行过，undefined=未知。 */
  executed?: boolean
  details?: Record<string, unknown>
}

const DENIED_CODES: ReadonlySet<NtErrorCode> = new Set([
  'NT_ACCESS_DENIED',
  'NT_PATH_ESCAPE',
  'NT_UNSUPPORTED_PATH',
  'NT_APPLY_DENIED',
  'NT_STAGING_QUOTA_EXCEEDED',
])

const ENV_FAULT_CODES: ReadonlySet<NtErrorCode> = new Set([
  'NT_DRIVER_UNAVAILABLE',
  'NT_DRIVER_VERSION_MISMATCH',
  'NT_DRIVER_PORT_DENIED',
  'NT_PROJFS_UNAVAILABLE',
  'NT_PROJFS_NOT_ENABLED',
  'NT_PROJFS_PROVIDER_DOWN',
  'NT_VIEW_UNAVAILABLE',
  'NT_VIEW_ROOT_INVALID',
  'NT_POLICY_INVALID',
  'NT_POLICY_GENERATION_MISMATCH',
  'NT_DOMAIN_NOT_REGISTERED',
  'NT_DOMAIN_DUPLICATE',
  'NT_NETWORK_UNENFORCED',
  'NT_NETWORK_UNSUPPORTED',
  'NT_APPLY_HELPER_UNAVAILABLE',
  'NT_CAPABILITY_MISSING',
])

/**
 * 把任意错误分类成可操作语义。
 *
 * ⚠ 只有 `NtError.executed === false` 才允许说“未执行”；命令自身返回非零、
 * 输出截断、超时等都必须走 `command-failed`/`unknown`，不得冒充环境失败。
 */
export function classifyNtFailure(error: unknown): NtFailure {
  if (error instanceof NtError) {
    if (DENIED_CODES.has(error.code)) {
      return {
        kind: 'denied',
        code: error.code,
        message: error.message,
        executed: error.executed ?? false,
        details: error.details,
      }
    }
    if (error.code === 'NT_APPLY_CONFLICT') {
      return { kind: 'apply-conflict', code: error.code, message: error.message, executed: false, details: error.details }
    }
    if (ENV_FAULT_CODES.has(error.code)) {
      return {
        kind: 'env-fault',
        code: error.code,
        message: error.message,
        executed: error.executed ?? false,
        details: error.details,
      }
    }
    if (error.code === 'NT_INTERNAL') {
      return { kind: 'unknown', code: error.code, message: error.message, executed: error.executed, details: error.details }
    }
    return { kind: 'unknown', code: error.code, message: error.message, executed: error.executed, details: error.details }
  }
  if (error instanceof Error) {
    return { kind: 'unknown', code: error.name || 'ERROR', message: error.message }
  }
  return { kind: 'unknown', code: 'UNKNOWN', message: String(error) }
}

/** 一句话结论（用户侧/状态卡）。 */
export function summarizeStatus(status: NtStatus): string {
  if (isKernelReady(status)) {
    return `内核视图隔离已生效（ProjFS + minifilter；网络=${status.network.mode}；策略 generation=${status.policy.generation ?? '?'}）。`
  }
  const missing: string[] = []
  if (!status.driver.loaded) missing.push('驱动')
  if (!status.projfs.enabled) missing.push('ProjFS')
  else if (!status.projfs.providerRunning) missing.push('ProjFS provider')
  if (!status.policy.valid) missing.push('策略')
  if (status.network.mode !== 'observed' && !status.network.enforced && status.network.perChild !== true) missing.push('网络强制')
  return `内核视图隔离未就绪：缺少 ${missing.join('、') || '未知能力'}；命令将 fail-closed。`
}
