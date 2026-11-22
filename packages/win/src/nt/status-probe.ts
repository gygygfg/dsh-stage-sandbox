/**
 * 状态探测：把“机器事实”翻译成 `NtStatus`。
 *
 * 纯函数部分（`assessNtStatus` / `parse*`）可在 Linux 上单测；
 * `collectNtFacts()` 需要真实 Windows（fltmc / PowerShell / 命名管道），
 * 命令执行器是注入的，便于用固定输出做回归。
 *
 * 设计原则：**没有任何“猜”**。拿不到的事实标 unknown，assess 结果就是不可用，
 * 而不是默认可用。
 *
 * @module winstage-sandbox/nt/status-probe
 */

import { createNtStatus } from './status.ts'
import { NT_DRIVER_ABI_VERSION, type NtStatus } from './types.ts'

/** 从机器上采到的原始事实。 */
export interface NtRawFacts {
  /** `fltmc filters` 是否列出 dshnt，以及高度。 */
  filter?: { loaded: boolean; altitude?: string; instances?: number }
  /** 驱动服务状态（`sc query dshnt`）。 */
  service?: 'running' | 'stopped' | 'missing' | 'unknown'
  /** `Client-ProjFS` 可选功能。 */
  projfs?: 'enabled' | 'disabled' | 'unknown'
  /** provider 进程（`dshnt-provider`）是否存活。 */
  providerAlive?: boolean
  /** provider 已注册的视图根。 */
  providerViews?: string[]
  /** 策略 generation/hash（控制面最后一次成功下发）。 */
  policy?: { generation: number; hash: string; valid: boolean; error?: string }
  /** 网络闸门是否回读为已安装。 */
  network?: { mode: 'offline' | 'allowlist' | 'observed'; enforced: boolean; error?: string }
  /** apply 通道是否就绪。 */
  applyReady?: boolean
  /** 驱动 hello 返回的 ABI。 */
  abiVersion?: number
  notes?: string[]
}

/**
 * 事实 → `NtStatus`。
 *
 * - enforcement 只有四项全真才是 `kernel-projfs-minifilter`；
 * - 否则 `unavailable`（绝不因为“配置是 kernel”就报 kernel）；
 * - 网络 `observed` 不算强制（`enforced` 必须来自回读）。
 */
export function assessNtStatus(facts: NtRawFacts, now: () => string = () => new Date().toISOString()): NtStatus {
  const notes = [...(facts.notes ?? [])]
  const driverLoaded = facts.filter?.loaded === true || facts.service === 'running'
  const abiOk = facts.abiVersion === undefined || facts.abiVersion === NT_DRIVER_ABI_VERSION
  const projfsEnabled = facts.projfs === 'enabled'
  const providerRunning = facts.providerAlive === true
  const policyValid = facts.policy?.valid === true
  const networkEnforced = facts.network?.enforced === true

  if (facts.abiVersion !== undefined && !abiOk) {
    notes.push(`driver ABI ${facts.abiVersion} != control plane ${NT_DRIVER_ABI_VERSION}`)
  }
  if (facts.filter?.loaded === true && (facts.filter.instances ?? 0) === 0) {
    notes.push('filter is loaded but has no instances attached (volume not attached?)')
  }
  if (facts.network !== undefined && facts.network.mode !== 'observed' && !networkEnforced) {
    notes.push(`network mode ${facts.network.mode} is not enforced`)
  }

  const enforcement =
    driverLoaded && projfsEnabled && providerRunning && policyValid && abiOk
      ? 'kernel-projfs-minifilter'
      : 'unavailable'

  return createNtStatus({
    enforcement,
    driver: {
      loaded: driverLoaded,
      ...(facts.abiVersion === undefined ? {} : { abiVersion: facts.abiVersion }),
      ...(facts.filter?.altitude === undefined ? {} : { altitude: facts.filter.altitude }),
      ...(facts.service === 'missing' ? { error: 'driver service dshnt is not installed' } : {}),
    },
    projfs: {
      enabled: projfsEnabled,
      providerRunning,
      ...(facts.providerViews?.[0] === undefined ? {} : { viewRoot: facts.providerViews[0] }),
    },
    policy: {
      valid: policyValid,
      ...(facts.policy?.generation === undefined ? {} : { generation: facts.policy.generation }),
      ...(facts.policy?.hash === undefined ? {} : { hash: facts.policy.hash }),
      ...(facts.policy?.error === undefined ? {} : { error: facts.policy.error }),
    },
    domains: facts.providerViews?.length ?? 0,
    network: {
      mode: facts.network?.mode ?? 'offline',
      enforced: networkEnforced,
      ...(facts.network?.error === undefined ? {} : { error: facts.network.error }),
    },
    apply: {
      helperReady: facts.applyReady === true,
    },
    notes: [...notes, `probed at ${now()}`],
  })
}

/** `fltmc filters` 的解析（本地化列名不重要：只抓“dshnt + 高度 + 实例数”）。 */
export function parseFltmcFilters(output: string): { loaded: boolean; altitude?: string; instances?: number } {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*dshnt\s+(\d+)\s+(\d+)\s+/i.exec(line)
    if (match !== null) {
      return { loaded: true, instances: Number(match[1]), altitude: match[2] }
    }
    // 部分版本把实例数与高度用不同顺序/宽度打印，退回宽松匹配（必须后跟空白）。
    if (/^\s*dshnt\s/i.test(line)) {
      const numbers = line.match(/\d+/g) ?? []
      return { loaded: true, instances: numbers[0] === undefined ? undefined : Number(numbers[0]), altitude: numbers[1] }
    }
  }
  return { loaded: false }
}

/** `fltmc instances -f dshnt` → 挂载的卷（例如 `C:`）。 */
export function parseFltmcInstances(output: string): string[] {
  const volumes: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]:)(?:\\|\s|$)/.exec(line)
    if (match !== null) volumes.push(match[1])
  }
  return volumes
}

/** `Get-WindowsOptionalFeature` 的文本输出（本地化）→ 三态。 */
export function parseProjfsFeature(output: string): 'enabled' | 'disabled' | 'unknown' {
  if (/Enabled|已启用/i.test(output)) return 'enabled'
  if (/Disabled|已禁用/i.test(output)) return 'disabled'
  return 'unknown'
}

/** provider 的 `stats` 回复 → 视图根列表（JSON 容忍缺字段）。 */
export function parseProviderStats(output: string): { views: string[]; alive: boolean } {
  try {
    const parsed = JSON.parse(output) as { ok?: boolean; stats?: { views?: Array<{ view?: string }> } }
    const views = (parsed.stats?.views ?? [])
      .map((view) => view.view)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    return { views, alive: parsed.ok === true }
  } catch {
    return { views: [], alive: false }
  }
}

export interface CollectOptions {
  /** 执行命令并返回 stdout（注入；Windows 上用 PowerShell）。 */
  run: (command: string) => Promise<string>
  /** provider 控制管道名（默认 dshnt-provider）。 */
  providerPipe?: string
  policy?: NtRawFacts['policy']
  network?: NtRawFacts['network']
  applyReady?: boolean
}

/**
 * 采集真实事实。任何命令失败都降级为 unknown，而不是抛错（状态卡必须能显示）。
 */
export async function collectNtFacts(options: CollectOptions): Promise<NtRawFacts> {
  const facts: NtRawFacts = { notes: [] }
  const errors: string[] = []

  const attempt = async (command: string): Promise<string | undefined> => {
    try {
      return await options.run(command)
    } catch {
      return undefined
    }
  }

  const filters = await attempt('fltmc filters')
  if (filters === undefined) {
    facts.filter = { loaded: false }
    errors.push('fltmc filters failed')
  } else {
    facts.filter = parseFltmcFilters(filters)
  }

  const service = await attempt('sc query dshnt')
  if (service === undefined) {
    facts.service = 'unknown'
  } else if (/RUNNING|正在运行/i.test(service)) {
    facts.service = 'running'
  } else if (/STOPPED|已停止/i.test(service)) {
    facts.service = 'stopped'
  } else if (/does not exist|指定的服务|1060/i.test(service)) {
    facts.service = 'missing'
  } else {
    facts.service = 'unknown'
  }

  const feature = await attempt(
    "powershell -NoProfile -Command \"(Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS).State\"",
  )
  facts.projfs = feature === undefined ? 'unknown' : parseProjfsFeature(feature)
  if (feature === undefined) errors.push('Client-ProjFS probe failed')
  if (facts.service === 'unknown') errors.push('sc query dshnt returned an unrecognized state')

  facts.policy = options.policy
  facts.network = options.network
  facts.applyReady = options.applyReady === true
  if (errors.length > 0) facts.notes?.push(...errors)
  return facts
}
