/**
 * NT 内核沙箱的共享类型与错误码。
 *
 * 这一层只描述**契约**，不依赖 Windows、不依赖 dsh：
 *   · 策略（domain / object type / rule）是控制面与驱动之间的唯一语言；
 *   · 视图（ProjFS）与驱动（minifilter）通过明确的 status/错误码暴露“此刻边界由谁提供”；
 *   · 任何缺失都必须可归因，不允许把“没装驱动”读成“命令失败”。
 *
 * 命名约定：
 *   · `Nt*` 前缀用于本后端（NT kernel sandbox），避免和既有 WinStage 类型混淆；
 *   · 路径一律用 Windows 形式（`C:\...`），匹配时大小写不敏感；
 *   · 这里**不**包含 Node 的 `fs` / `path` 调用，保证可以在 Linux 上单测。
 *
 * @module winstage-sandbox/nt/types
 */

/** 策略格式版本。驱动/控制面 ABI 不匹配时必须 fail-closed。 */
export const NT_POLICY_VERSION = 1 as const

/** 驱动通信端口 ABI 版本。与 `native/include/dshnt_abi.h` 同名常量必须一致。 */
export const NT_DRIVER_ABI_VERSION = 2 as const

/** 驱动通信端口名（与驱动侧 `\DshNtPort` 一致）。 */
export const NT_DRIVER_PORT_NAME = '\\DshNtPort' as const

/** 一次访问请求的类别。`attribute` 覆盖 chmod/hidden/system/时间戳等元数据修改。 */
export type NtAccess = 'read' | 'write' | 'execute' | 'delete' | 'rename' | 'attribute'

/** 策略动作。`stage` 只对写类访问有意义；`mask` 对读/写都表示“不可见/拒绝”。 */
export type NtAction = 'allow' | 'deny' | 'stage' | 'mask'

/** 路径匹配形状。v1 只支持精确路径与前缀；glob 由控制面展开/拒绝，驱动不解析正则。 */
export type NtPathKind = 'exact' | 'prefix'

/** 一条路径匹配。`path` 必须已经过 `normalizeWin32Path`。 */
export interface NtPathMatch {
  kind: NtPathKind
  path: string
}

/** 一个域（domain）的对象类型规则。 */
export interface NtRule {
  /** 稳定 id；同一策略内唯一。用于审计/解释命中原因。 */
  id: string
  /** 对象类型标签，例如 `workspace` / `system` / `secret` / `store`。 */
  type: string
  /** 匹配的路径（精确或前缀）。 */
  match: NtPathMatch
  /** 这条规则覆盖的访问类别；至少一项。 */
  access: NtAccess[]
  /** 命中后的动作。 */
  action: NtAction
  /** 可选的人类可读说明；不参与安全判定。 */
  note?: string
}

/** 令牌模式。网络白名单/独立 SID 依赖 AppContainer；restricted 仅用于离线/兼容。 */
export type NtTokenMode = 'appcontainer' | 'restricted'

/** 网络档位。`offline` 默认拒绝；`allowlist` 只放行显式端点；`observed` 只记录不拦截。 */
export type NtNetworkMode = 'offline' | 'allowlist' | 'observed'

/** 网络端点白名单项。 */
export interface NtEndpoint {
  host: string
  port: number
  protocol?: 'tcp' | 'udp'
}

/** Job Object 资源域。数值必须为正；`cpuPercent=0` 表示不限制。 */
export interface NtJobLimits {
  memoryMb: number
  activeProcessLimit: number
  cpuPercent: number
  killOnClose: boolean
}

/** 一个沙箱域。 */
export interface NtDomain {
  /** 全局唯一 id（会话/尝试维度）。 */
  id: string
  /** SELinux 风格的 domain label；仅作为分类/审计标签，不是内核身份本身。 */
  label: string
  /** 真实工作区根（lower），绝对本地盘路径。 */
  workspaceRoot: string
  /** ProjFS 视图根（upper/staging），绝对本地盘路径，必须与 workspace 不重叠。 */
  viewRoot: string
  /** 控制面 store 根（候选/证据/日志），必须与 workspace 不重叠。 */
  storeRoot: string
  tokenMode: NtTokenMode
  /** AppContainer SID；`tokenMode==='appcontainer'` 时必填。 */
  appContainerSid?: string
  job: NtJobLimits
  network: {
    mode: NtNetworkMode
    allow: NtEndpoint[]
  }
  /**
   * 默认读策略。写入/删除/改名/执行默认拒绝；只有显式规则才能放行。
   * 读默认 `allow` 是为了让开发工具能读系统文件；需要更严时设为 `deny`。
   */
  defaultRead: 'allow' | 'deny'
  /** 域内规则。工作区写/删/改名应显式声明为 `stage`。 */
  rules: NtRule[]
}

/** 一份完整策略（可包含多个域）。 */
export interface NtPolicySet {
  version: typeof NT_POLICY_VERSION
  /** 单调递增；驱动只接受比当前更新的 generation（相同则幂等）。 */
  generation: number
  /** 人类可读时间；**不参与**策略哈希。 */
  createdAt: string
  /** 所有域共享的强制遮蔽（凭据/设备/store 等）；命中即 mask/deny。 */
  globalMasks: NtPathMatch[]
  domains: NtDomain[]
}

/** 一次路径访问的判定结果。 */
export interface NtDecision {
  action: NtAction
  /** 命中的规则 id；默认规则用 `default:*` 形式。 */
  ruleId: string
  /** 人类可读原因；供状态卡/证据使用，不参与驱动判定。 */
  reason: string
}

/** 策略校验结果。`errors` 非空时编译/下发必须失败。 */
export interface NtValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/** 驱动/ProjFS/Apply 的组合状态。 */
export type NtEnforcement = 'kernel-projfs-minifilter' | 'legacy' | 'unavailable'

/** 写入屏障分类。只允许“内核”或“明确不是内核”两类，不允许含糊。 */
export type NtWriteBarrier = 'kernel-projfs-minifilter' | 'kernel-restricted-token' | 'user-mode-shim' | 'none'

/** 驱动握手结果。 */
export interface NtDriverHello {
  abiVersion: number
  driverVersion: string
  altitude: string
  supports: string[]
}

/** 驱动统计（用于状态卡/容量门禁）。 */
export interface NtDriverStats {
  domains: number
  rules: number
  redirects: number
  denies: number
  masks: number
  policyGeneration: number
  /** 当前 PID→域映射数量（含继承子进程）。 */
  processCount?: number
  lastError?: string
}

/** 驱动审计事件。不记录文件内容；路径按策略可脱敏。 */
export interface NtDriverEvent {
  type: 'deny' | 'stage' | 'mask' | 'redirect' | 'domain' | 'driver'
  at: string
  domainId?: string
  path?: string
  access?: NtAccess
  action?: NtAction
  pid?: number
  image?: string
  ruleId?: string
  detail?: string
}

/** 驱动通信端口的客户端契约。真实实现见 M1；测试用 Fake。 */
export interface NtDriverPort {
  hello(): Promise<NtDriverHello>
  /**
   * 下发策略。payload 的最终二进制格式在 M1 固化；v1 用 canonical JSON UTF-8。
   * `generation` 必须单调递增；驱动对同 generation 幂等，对更小 generation 拒绝。
   */
  setPolicy(payload: Uint8Array, hash: string, generation: number): Promise<{ generation: number }>
  registerDomain(input: {
    id: string
    viewRoot: string
    /** 策略内的根（用于驱动核对，防止控制面/驱动视图漂移）。 */
    workspaceRoot?: string
    storeRoot?: string
    appContainerSid?: string
  }): Promise<void>
  unregisterDomain(id: string): Promise<void>
  /** 仅对 apply helper 的 PID + image hash 临时授予真实工作区写权。 */
  grantApply(input: { pid: number; imageHash: string; paths: string[] }): Promise<void>
  revokeApply(pid: number): Promise<void>
  queryStats(): Promise<NtDriverStats>
  /**
   * PID → 域（ABI v2）。ROOT 的子进程由驱动继承；TRUSTED 不重定向/不拒绝。
   * 真实驱动必须支持；Fake 仅记录。
   */
  registerProcess?(input: {
    pid: number
    domainId?: string
    flags: { root?: boolean; trusted?: boolean }
  }): Promise<void>
  unregisterProcess?(pid: number): Promise<void>
  /** 轮询审计事件（ABI v2；v1 控制面在设备上按需轮询）。 */
  queryEvents?(): Promise<NtDriverEvent[]>
  onEvent(listener: (event: NtDriverEvent) => void): () => void
}

/** 组合状态。所有字段都使用“事实”而不是“推断”。 */
export interface NtStatus {
  enforcement: NtEnforcement
  driver: {
    loaded: boolean
    abiVersion?: number
    version?: string
    altitude?: string
    error?: string
  }
  projfs: {
    enabled: boolean
    providerRunning: boolean
    viewRoot?: string
    error?: string
  }
  policy: {
    valid: boolean
    generation?: number
    hash?: string
    error?: string
  }
  domains: number
  network: {
    mode: NtNetworkMode
    /** 是否有**已安装并回读**的全局闸门（初始化阶段通常为 false）。 */
    enforced: boolean
    /**
     * 强制点是否**按子进程**安装（launcher 持有 WFP DYNAMIC 会话，失败即拒绝启动）。
     * 为 true 时，初始化阶段没有全局闸门也算“就绪”；真实强制发生在每次启动。
     */
    perChild?: boolean
    error?: string
  }
  apply: {
    helperReady: boolean
    error?: string
  }
  writeBarrier: NtWriteBarrier
  notes: string[]
}

/** 错误码。每个码都必须有可操作的修复文案。 */
export type NtErrorCode =
  | 'NT_DRIVER_UNAVAILABLE'
  | 'NT_DRIVER_VERSION_MISMATCH'
  | 'NT_DRIVER_PORT_DENIED'
  | 'NT_PROJFS_UNAVAILABLE'
  | 'NT_PROJFS_NOT_ENABLED'
  | 'NT_PROJFS_PROVIDER_DOWN'
  | 'NT_VIEW_UNAVAILABLE'
  | 'NT_VIEW_ROOT_INVALID'
  | 'NT_POLICY_INVALID'
  | 'NT_POLICY_GENERATION_MISMATCH'
  | 'NT_DOMAIN_NOT_REGISTERED'
  | 'NT_DOMAIN_DUPLICATE'
  | 'NT_NETWORK_UNENFORCED'
  | 'NT_NETWORK_UNSUPPORTED'
  | 'NT_ENV_REJECTED'
  | 'NT_APPLY_HELPER_UNAVAILABLE'
  | 'NT_APPLY_CONFLICT'
  | 'NT_APPLY_DENIED'
  | 'NT_PATH_ESCAPE'
  | 'NT_UNSUPPORTED_PATH'
  | 'NT_CAPABILITY_MISSING'
  | 'NT_ACCESS_DENIED'
  | 'NT_STAGING_QUOTA_EXCEEDED'
  | 'NT_INTERNAL'

/** 错误码 → 固定文案（中文；调用方可追加 details，但不得改写码本身）。 */
export const NT_ERROR_MESSAGES: Readonly<Record<NtErrorCode, string>> = Object.freeze({
  NT_DRIVER_UNAVAILABLE: 'NT 内核沙箱驱动未加载；本次操作没有执行。请安装/加载 dshnt 驱动后重试。',
  NT_DRIVER_VERSION_MISMATCH: 'NT 驱动与控制面 ABI 不匹配；本次操作没有执行。请升级到同一版本。',
  NT_DRIVER_PORT_DENIED: '无法打开 NT 驱动通信端口（权限或 ACL 拒绝）；本次操作没有执行。',
  NT_PROJFS_UNAVAILABLE: '本机没有可用的 ProjFS；本次操作没有执行。请启用 Client-ProjFS 后重试。',
  NT_PROJFS_NOT_ENABLED: 'ProjFS 可选功能未启用；本次操作没有执行。请以管理员运行 Enable-WindowsOptionalFeature -FeatureName Client-ProjFS。',
  NT_PROJFS_PROVIDER_DOWN: 'ProjFS provider 未运行或已退出；本次操作没有执行。请运行 /winstage doctor 查看原因。',
  NT_VIEW_UNAVAILABLE: '暂存视图根不可访问；本次操作没有执行。请检查 storeRoot/viewRoot 的 ACL 与磁盘。',
  NT_VIEW_ROOT_INVALID: '视图根配置非法（与工作区重叠/不是绝对本地路径）；本次操作没有执行。',
  NT_POLICY_INVALID: 'NT 策略非法；本次操作没有执行。请运行 /winstage policy 查看校验错误。',
  NT_POLICY_GENERATION_MISMATCH: '驱动策略 generation 与控制面不一致；本次操作没有执行。请重新下发策略。',
  NT_DOMAIN_NOT_REGISTERED: '沙箱域未注册；本次操作没有执行。请重新启动域或运行 /winstage doctor。',
  NT_DOMAIN_DUPLICATE: '沙箱域 id 重复；本次操作没有执行。请为每个会话/尝试使用唯一 id。',
  NT_NETWORK_UNENFORCED: '网络策略未实际生效（过滤器未安装/未回读）；本次操作没有执行。',
  NT_NETWORK_UNSUPPORTED: '当前令牌模式不支持请求的网络档位；本次操作没有执行。',
  NT_ENV_REJECTED: '环境变量包含凭据类键或非法名称；本次操作没有执行。请从环境白名单移除敏感变量。',
  NT_APPLY_HELPER_UNAVAILABLE: 'apply helper 不可用；本次操作没有执行，真实工作区未被写入。',
  NT_APPLY_CONFLICT: '发布冲突：目标文件在基线之后被外部修改；本次整批零写，未覆盖任何文件。',
  NT_APPLY_DENIED: 'apply helper 拒绝了本次发布（路径/哈希/权限校验失败）；真实工作区未被写入。',
  NT_PATH_ESCAPE: '路径越界（不在允许的根内或包含 .. 逃逸）；本次操作没有执行。',
  NT_UNSUPPORTED_PATH: '路径形态暂不支持（设备/UNC/ADS/glob 等）；本次操作没有执行。',
  NT_CAPABILITY_MISSING: '本机缺少 NT 沙箱所需能力；本次操作没有执行。请运行 /winstage doctor。',
  NT_ACCESS_DENIED: '访问被 NT 沙箱策略拒绝。',
  NT_STAGING_QUOTA_EXCEEDED: '暂存配额已用完；本次写入被拒绝，真实工作区未被写入。',
  NT_INTERNAL: 'NT 沙箱内部错误；本次操作结果未知，请查看日志与 /winstage doctor。',
})

/** 带机读码的错误。`executed` 只在有证据时使用：false=确定未执行，true=确定执行过，undefined=未知。 */
export class NtError extends Error {
  readonly code: NtErrorCode
  readonly details?: Record<string, unknown>
  readonly executed?: boolean

  constructor(code: NtErrorCode, details?: Record<string, unknown>, options?: { executed?: boolean; cause?: unknown }) {
    const message = NT_ERROR_MESSAGES[code]
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'NtError'
    this.code = code
    this.details = details
    this.executed = options?.executed
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      executed: this.executed,
    }
  }
}

/** 判断一个值是否是 NtError（跨模块边界时不依赖 instanceof）。 */
export function isNtError(value: unknown): value is NtError {
  return (
    value instanceof NtError ||
    (value !== null &&
      typeof value === 'object' &&
      (value as { name?: unknown }).name === 'NtError' &&
      typeof (value as { code?: unknown }).code === 'string')
  )
}

/** 创建默认 Job 限制（保守但可用；调用方可覆盖）。 */
export function defaultJobLimits(): NtJobLimits {
  return {
    memoryMb: 4096,
    activeProcessLimit: 256,
    cpuPercent: 80,
    killOnClose: true,
  }
}
