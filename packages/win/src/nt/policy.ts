/**
 * NT 沙箱策略：校验、规范化、编译与判定。
 *
 * 这是“SELinux 风格”的域/类型/允许模型在控制面的唯一实现：
 *   · domain = 沙箱域（会话/尝试）
 *   · type   = 规则里的对象类型标签（workspace/system/secret/store/...）
 *   · rule   = 某域对某类路径的某组访问允许/拒绝/暂存/遮蔽
 *
 * 判定优先级（必须稳定、可解释）：
 *   1. `globalMasks` 命中 ⇒ `mask`（读不可见，写拒绝）；
 *   2. 域规则按“特异性”降序：exact > 更长 prefix；同特异性
 *      deny > mask > stage > allow；再按 rule.id 稳定排序；
 *   3. 没有命中 ⇒ 读用 `defaultRead`，写/删/改名/执行/属性一律 `deny`。
 *
 * 安全不变量：
 *   · 工作区内的写/删/改名**只能** `stage`；出现 `allow` 直接判策略非法
 *     （否则会绕过 ProjFS 视图直接写真实盘）；
 *   · `viewRoot` / `storeRoot` 必须与工作区不重叠，且不同域之间不重叠；
 *   · `stage` 规则必须落在工作区内；
 *   · 策略只接受 absolute local Win32 path；设备/UNC/ADS/通配符一律拒绝。
 *
 * @module winstage-sandbox/nt/policy
 */

import { createHash } from 'node:crypto'
import {
  isPathInside,
  matchPath,
  matchSpecificity,
  normalizeWin32Path,
  type NormalizePathOptions,
} from './paths.ts'
import {
  NT_POLICY_VERSION,
  NtError,
  type NtAccess,
  type NtAction,
  type NtDecision,
  type NtDomain,
  type NtPathMatch,
  type NtPolicySet,
  type NtRule,
  type NtValidationResult,
} from './types.ts'

const ACCESS_VALUES: ReadonlySet<NtAccess> = new Set(['read', 'write', 'execute', 'delete', 'rename', 'attribute'])
const ACTION_VALUES: ReadonlySet<NtAction> = new Set(['allow', 'deny', 'stage', 'mask'])
const ACTION_PRECEDENCE: Readonly<Record<NtAction, number>> = { deny: 0, mask: 1, stage: 2, allow: 3 }

/** 校验选项。 */
export interface ValidatePolicyOptions {
  /** 是否要求 appcontainer 域必须带 SID（默认 true）。 */
  requireAppContainerSid?: boolean
  /** 是否允许 `network.mode='observed'`（默认 true；状态卡会标注未强制）。 */
  allowObservedNetwork?: boolean
  /** 路径规范化选项（默认拒绝 UNC/ADS/通配符）。 */
  pathOptions?: NormalizePathOptions
}

/** 编译后的策略。 */
export interface CompiledPolicy {
  readonly policy: NtPolicySet
  readonly generation: number
  readonly hash: string
  readonly domains: ReadonlyMap<string, CompiledDomain>
  readonly globalMasks: readonly NtPathMatch[]
  /** 判定一次访问。纯函数，不抛异常（非法路径返回 deny）。 */
  decide(domainId: string, path: string, access: NtAccess): NtDecision
  /** 人类可读的解释（状态卡/证据用）。 */
  explain(domainId: string, path: string, access: NtAccess): string
}

/** 编译后的域。 */
export interface CompiledDomain {
  readonly domain: NtDomain
  readonly rules: readonly NtRule[]
  readonly workspaceRoot: string
  readonly viewRoot: string
  readonly storeRoot: string
}

/**
 * 校验策略并返回全部错误/警告（不抛异常，便于设置页展示）。
 *
 * @param policy - 待校验策略
 * @param options - 校验选项
 */
export function validatePolicy(policy: NtPolicySet, options: ValidatePolicyOptions = {}): NtValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const pathOptions = options.pathOptions ?? {}
  const requireSid = options.requireAppContainerSid !== false
  const allowObserved = options.allowObservedNetwork !== false

  if (policy === null || typeof policy !== 'object') {
    return { ok: false, errors: ['policy 必须是对象'], warnings }
  }
  if (policy.version !== NT_POLICY_VERSION) {
    errors.push(`policy.version 必须是 ${NT_POLICY_VERSION}（实际 ${String(policy.version)}）`)
  }
  if (!Number.isInteger(policy.generation) || policy.generation <= 0) {
    errors.push('policy.generation 必须是正整数')
  }
  if (typeof policy.createdAt !== 'string' || policy.createdAt.length === 0) {
    errors.push('policy.createdAt 必须是非空字符串')
  }
  if (!Array.isArray(policy.domains) || policy.domains.length === 0) {
    errors.push('policy.domains 必须是非空数组')
  }

  const masks = Array.isArray(policy.globalMasks) ? policy.globalMasks : []
  validateMasks(masks, 'globalMasks', errors, pathOptions)

  const domainIds = new Set<string>()
  const viewRoots = new Map<string, string>()
  const storeRoots = new Map<string, string>()
  const appContainerSids = new Map<string, string>()
  const normalizedDomains: Array<{ domain: NtDomain; workspaceRoot: string; viewRoot: string; storeRoot: string }> = []

  for (const [index, domain] of (Array.isArray(policy.domains) ? policy.domains : []).entries()) {
    const where = `domains[${index}]`
    if (domain === null || typeof domain !== 'object') {
      errors.push(`${where} 必须是对象`)
      continue
    }
    if (typeof domain.id !== 'string' || domain.id.trim().length === 0) {
      errors.push(`${where}.id 必须是非空字符串`)
    } else if (domainIds.has(domain.id)) {
      errors.push(`${where}.id 重复: ${domain.id}`)
    } else {
      domainIds.add(domain.id)
    }
    if (typeof domain.label !== 'string' || domain.label.trim().length === 0) {
      errors.push(`${where}.label 必须是非空字符串`)
    }

    const workspaceRoot = normalizeOrError(domain.workspaceRoot, `${where}.workspaceRoot`, errors, pathOptions)
    const viewRoot = normalizeOrError(domain.viewRoot, `${where}.viewRoot`, errors, pathOptions)
    const storeRoot = normalizeOrError(domain.storeRoot, `${where}.storeRoot`, errors, pathOptions)

    if (workspaceRoot !== undefined && viewRoot !== undefined) {
      if (isPathInside(viewRoot, workspaceRoot) || isPathInside(workspaceRoot, viewRoot)) {
        errors.push(`${where}.viewRoot 不能与 workspaceRoot 重叠（view=${viewRoot}, workspace=${workspaceRoot}）`)
      }
    }
    if (workspaceRoot !== undefined && storeRoot !== undefined) {
      if (isPathInside(storeRoot, workspaceRoot) || isPathInside(workspaceRoot, storeRoot)) {
        errors.push(`${where}.storeRoot 不能与 workspaceRoot 重叠（store=${storeRoot}, workspace=${workspaceRoot}）`)
      }
    }
    if (viewRoot !== undefined && storeRoot !== undefined) {
      if (isPathInside(viewRoot, storeRoot) || isPathInside(storeRoot, viewRoot)) {
        errors.push(`${where}.viewRoot 不能与 storeRoot 重叠（view=${viewRoot}, store=${storeRoot}）`)
      }
    }
    if (viewRoot !== undefined) {
      const previous = viewRoots.get(viewRoot)
      if (previous !== undefined) errors.push(`${where}.viewRoot 与 ${previous} 重复: ${viewRoot}`)
      else viewRoots.set(viewRoot, where)
    }
    if (storeRoot !== undefined) {
      const previous = storeRoots.get(storeRoot)
      if (previous !== undefined) errors.push(`${where}.storeRoot 与 ${previous} 重复: ${storeRoot}`)
      else storeRoots.set(storeRoot, where)
    }

    if (domain.tokenMode !== 'appcontainer' && domain.tokenMode !== 'restricted') {
      errors.push(`${where}.tokenMode 必须是 appcontainer 或 restricted`)
    }
    if (domain.tokenMode === 'appcontainer') {
      if (requireSid && (typeof domain.appContainerSid !== 'string' || !isSid(domain.appContainerSid))) {
        errors.push(`${where}.appContainerSid 在 appcontainer 模式下必须是合法 SID`)
      }
      if (typeof domain.appContainerSid === 'string' && domain.appContainerSid.length > 0) {
        const previous = appContainerSids.get(domain.appContainerSid)
        if (previous !== undefined) {
          errors.push(`${where}.appContainerSid 与 ${previous} 重复；每个域必须有独立 SID（WFP 按 SID 过滤）`)
        } else {
          appContainerSids.set(domain.appContainerSid, where)
        }
      }
    }

    validateJob(domain, where, errors)
    validateNetwork(domain, where, errors, warnings, allowObserved)
    if (domain.defaultRead !== 'allow' && domain.defaultRead !== 'deny') {
      errors.push(`${where}.defaultRead 必须是 allow 或 deny`)
    }

    const rules = Array.isArray(domain.rules) ? domain.rules : []
    const ruleIds = new Set<string>()
    for (const [ruleIndex, rule] of rules.entries()) {
      validateRule(rule, `${where}.rules[${ruleIndex}]`, errors, warnings, ruleIds, workspaceRoot, viewRoot, storeRoot, pathOptions)
    }
    if (workspaceRoot !== undefined && viewRoot !== undefined && storeRoot !== undefined) {
      normalizedDomains.push({ domain, workspaceRoot, viewRoot, storeRoot })
    }
  }

  // 跨域重叠：视图/store 不能落在别的域工作区里，也不能互相嵌套。
  for (let i = 0; i < normalizedDomains.length; i += 1) {
    for (let j = 0; j < normalizedDomains.length; j += 1) {
      if (i === j) continue
      const a = normalizedDomains[i]
      const b = normalizedDomains[j]
      for (const [label, root] of [
        ['viewRoot', a.viewRoot],
        ['storeRoot', a.storeRoot],
      ] as const) {
        if (isPathInside(root, b.workspaceRoot)) {
          errors.push(`domains[${i}].${label} 落在 domains[${j}].workspaceRoot 内（${root} ⊆ ${b.workspaceRoot}）`)
        }
        if (isPathInside(b.workspaceRoot, root)) {
          errors.push(`domains[${j}].workspaceRoot 落在 domains[${i}].${label} 内（${b.workspaceRoot} ⊆ ${root}）`)
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 校验失败即抛 `NT_POLICY_INVALID`。 */
export function assertValidPolicy(policy: NtPolicySet, options?: ValidatePolicyOptions): void {
  const result = validatePolicy(policy, options)
  if (!result.ok) {
    throw new NtError('NT_POLICY_INVALID', { errors: result.errors, warnings: result.warnings })
  }
}

/**
 * 编译策略。先校验，再按域生成稳定排序的规则表。
 *
 * @param policy - 已校验/待校验策略
 * @param options - 校验选项
 * @returns 可直接用于控制面判定/下发的编译结果
 */
export function compilePolicy(policy: NtPolicySet, options?: ValidatePolicyOptions): CompiledPolicy {
  assertValidPolicy(policy, options)
  const pathOptions = options?.pathOptions ?? {}
  const domains = new Map<string, CompiledDomain>()
  for (const domain of policy.domains) {
    const normalizedRules = domain.rules
      .map((rule) => normalizeRule(rule, pathOptions))
      .sort(compareRules)
    domains.set(domain.id, {
      domain,
      rules: normalizedRules,
      workspaceRoot: normalizeWin32Path(domain.workspaceRoot, pathOptions),
      viewRoot: normalizeWin32Path(domain.viewRoot, pathOptions),
      storeRoot: normalizeWin32Path(domain.storeRoot, pathOptions),
    })
  }
  const globalMasks = (policy.globalMasks ?? [])
    .map((mask) => normalizeMatch(mask, pathOptions))
    .sort(compareMasks)

  const compiled: CompiledPolicy = {
    policy,
    generation: policy.generation,
    hash: policyHash(policy),
    domains,
    globalMasks,
    decide(domainId: string, path: string, access: NtAccess): NtDecision {
      let normalized: string
      try {
        normalized = normalizeWin32Path(path, pathOptions)
      } catch (error) {
        return {
          action: 'deny',
          ruleId: 'invalid-path',
          reason: error instanceof NtError ? `${error.code}: ${error.message}` : 'invalid-path',
        }
      }
      for (const mask of globalMasks) {
        if (matchPath(mask, normalized)) {
          return { action: 'mask', ruleId: 'global-mask', reason: `global mask ${mask.kind}:${mask.path}` }
        }
      }
      const domain = domains.get(domainId)
      if (domain === undefined) {
        return { action: 'deny', ruleId: 'domain-missing', reason: `domain not found: ${domainId}` }
      }
      for (const rule of domain.rules) {
        if (!rule.access.includes(access)) continue
        if (!matchPath(rule.match, normalized)) continue
        return { action: rule.action, ruleId: rule.id, reason: `${rule.type}/${rule.action} via ${rule.match.kind}:${rule.match.path}` }
      }
      if (access === 'read') {
        return {
          action: domain.domain.defaultRead,
          ruleId: 'default:read',
          reason: `default read policy = ${domain.domain.defaultRead}`,
        }
      }
      return { action: 'deny', ruleId: `default:${access}`, reason: `default deny for ${access}` }
    },
    explain(domainId: string, path: string, access: NtAccess): string {
      const decision = compiled.decide(domainId, path, access)
      return `${access} ${path} -> ${decision.action} (${decision.ruleId}: ${decision.reason})`
    },
  }
  return compiled
}

/**
 * 规范化策略为稳定 JSON（键排序、域/规则排序、排除 createdAt）。
 * 用于策略哈希与“同一策略”比较。
 */
export function canonicalPolicyJson(policy: NtPolicySet): string {
  const pathOptions: NormalizePathOptions = {}
  const normalized = {
    version: policy.version,
    generation: policy.generation,
    globalMasks: (policy.globalMasks ?? [])
      .map((mask) => normalizeMatch(mask, pathOptions))
      .sort(compareMasks)
      .map((mask) => ({ kind: mask.kind, path: mask.path })),
    domains: [...policy.domains]
      .map((domain) => ({
        id: domain.id,
        label: domain.label,
        workspaceRoot: normalizeWin32Path(domain.workspaceRoot, pathOptions),
        viewRoot: normalizeWin32Path(domain.viewRoot, pathOptions),
        storeRoot: normalizeWin32Path(domain.storeRoot, pathOptions),
        tokenMode: domain.tokenMode,
        appContainerSid: domain.appContainerSid ?? null,
        job: {
          memoryMb: domain.job.memoryMb,
          activeProcessLimit: domain.job.activeProcessLimit,
          cpuPercent: domain.job.cpuPercent,
          killOnClose: domain.job.killOnClose,
        },
        network: {
          mode: domain.network.mode,
          allow: [...domain.network.allow]
            .map((endpoint) => ({
              host: endpoint.host.toLowerCase(),
              port: endpoint.port,
              protocol: endpoint.protocol ?? 'tcp',
            }))
            .sort((a, b) => (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1)),
        },
        defaultRead: domain.defaultRead,
        rules: [...domain.rules]
          .map((rule) => ({
            id: rule.id,
            type: rule.type,
            match: { kind: rule.match.kind, path: normalizeWin32Path(rule.match.path, pathOptions) },
            access: [...new Set(rule.access)].sort(),
            action: rule.action,
            note: rule.note ?? null,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
  return JSON.stringify(normalized)
}

/** 策略 SHA-256（canonical JSON，UTF-8）。 */
export function policyHash(policy: NtPolicySet): string {
  return createHash('sha256').update(canonicalPolicyJson(policy), 'utf8').digest('hex')
}

/**
 * 构造一个保守的默认域规则集：
 *   · 工作区读/执行允许，写/删/改名/属性 stage；
 *   · view/store 直接访问一律拒绝（重定向路径由驱动标记，不靠规则放行）；
 *   · Windows / Program Files 读/执行允许，写拒绝；
 *   · 其余默认拒绝。
 */
export function defaultRulesForDomain(input: {
  workspaceRoot: string
  viewRoot: string
  storeRoot: string
  systemRoots?: string[]
}): NtRule[] {
  const rules: NtRule[] = [
    {
      id: 'workspace-read',
      type: 'workspace',
      match: { kind: 'prefix', path: input.workspaceRoot },
      access: ['read', 'execute'],
      action: 'allow',
      note: '工作区读取与执行走真实 lower/ProjFS 视图',
    },
    {
      id: 'workspace-stage',
      type: 'workspace',
      match: { kind: 'prefix', path: input.workspaceRoot },
      access: ['write', 'delete', 'rename', 'attribute'],
      action: 'stage',
      note: '工作区写/删除/改名/属性只进 ProjFS 视图',
    },
    {
      id: 'view-deny',
      type: 'store',
      match: { kind: 'prefix', path: input.viewRoot },
      access: ['read', 'write', 'execute', 'delete', 'rename', 'attribute'],
      action: 'deny',
      note: '禁止绕过重定向直接访问视图根',
    },
    {
      id: 'store-deny',
      type: 'store',
      match: { kind: 'prefix', path: input.storeRoot },
      access: ['read', 'write', 'execute', 'delete', 'rename', 'attribute'],
      action: 'deny',
      note: '禁止访问候选/证据/凭据存储',
    },
  ]
  for (const [index, root] of (input.systemRoots ?? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']).entries()) {
    rules.push({
      id: `system-${index}`,
      type: 'system',
      match: { kind: 'prefix', path: root },
      access: ['read', 'execute'],
      action: 'allow',
      note: '系统目录只读/执行',
    })
    rules.push({
      id: `system-deny-write-${index}`,
      type: 'system',
      match: { kind: 'prefix', path: root },
      access: ['write', 'delete', 'rename', 'attribute'],
      action: 'deny',
      note: '系统目录禁止写/删/改名/属性',
    })
  }
  return rules
}

/** 生成凭据遮蔽前缀（globalMasks）。调用方传入用户 home；不在此处读环境。 */
export function defaultCredentialMasks(homeDir: string): NtPathMatch[] {
  const home = normalizeWin32Path(homeDir)
  const names = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.git-credentials',
    '.netrc',
    '.npmrc',
    '.config\\gh',
    'AppData\\Roaming\\Microsoft\\Crypto',
    'AppData\\Roaming\\Microsoft\\Protect',
    'AppData\\Local\\Microsoft\\Credentials',
  ]
  return names.map((name) => ({ kind: 'prefix' as const, path: normalizeWin32Path(`${home}\\${name}`) }))
}

function validateMasks(
  masks: readonly NtPathMatch[],
  where: string,
  errors: string[],
  pathOptions: NormalizePathOptions,
): void {
  const seen = new Set<string>()
  for (const [index, mask] of masks.entries()) {
    const at = `${where}[${index}]`
    if (mask === null || typeof mask !== 'object' || (mask.kind !== 'exact' && mask.kind !== 'prefix')) {
      errors.push(`${at} 必须是 {kind:'exact'|'prefix', path:string}`)
      continue
    }
    try {
      const normalized = normalizeWin32Path(mask.path, pathOptions)
      const key = `${mask.kind}:${normalized}`
      if (seen.has(key)) errors.push(`${at} 重复: ${key}`)
      seen.add(key)
    } catch (error) {
      errors.push(`${at}.path 非法: ${errorMessage(error)}`)
    }
  }
}

function validateJob(domain: NtDomain, where: string, errors: string[]): void {
  const job = domain.job
  if (job === null || typeof job !== 'object') {
    errors.push(`${where}.job 必须是对象`)
    return
  }
  if (!Number.isFinite(job.memoryMb) || job.memoryMb <= 0) errors.push(`${where}.job.memoryMb 必须是正数`)
  if (!Number.isInteger(job.activeProcessLimit) || job.activeProcessLimit <= 0) {
    errors.push(`${where}.job.activeProcessLimit 必须是正整数`)
  }
  if (!Number.isInteger(job.cpuPercent) || job.cpuPercent < 0 || job.cpuPercent > 100) {
    errors.push(`${where}.job.cpuPercent 必须是 0..100 的整数`)
  }
  if (typeof job.killOnClose !== 'boolean') errors.push(`${where}.job.killOnClose 必须是布尔值`)
}

function validateNetwork(
  domain: NtDomain,
  where: string,
  errors: string[],
  warnings: string[],
  allowObserved: boolean,
): void {
  const network = domain.network
  if (network === null || typeof network !== 'object') {
    errors.push(`${where}.network 必须是对象`)
    return
  }
  if (network.mode !== 'offline' && network.mode !== 'allowlist' && network.mode !== 'observed') {
    errors.push(`${where}.network.mode 必须是 offline/allowlist/observed`)
  }
  if (network.mode === 'observed') {
    if (!allowObserved) errors.push(`${where}.network.mode='observed' 被策略禁止`)
    else warnings.push(`${where}.network.mode='observed' 只记录不拦截，不得当作隔离边界`)
  }
  if (network.mode === 'allowlist' && domain.tokenMode !== 'appcontainer') {
    errors.push(`${where}.network.mode='allowlist' 需要 tokenMode='appcontainer'（WFP 按 AppContainer SID 过滤）`)
  }
  if (!Array.isArray(network.allow)) {
    errors.push(`${where}.network.allow 必须是数组`)
    return
  }
  for (const [index, endpoint] of network.allow.entries()) {
    const at = `${where}.network.allow[${index}]`
    if (endpoint === null || typeof endpoint !== 'object') {
      errors.push(`${at} 必须是对象`)
      continue
    }
    if (typeof endpoint.host !== 'string' || endpoint.host.trim().length === 0 || /\s/.test(endpoint.host)) {
      errors.push(`${at}.host 必须是非空且不含空白的字符串`)
    }
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      errors.push(`${at}.port 必须是 1..65535 的整数`)
    }
    if (endpoint.protocol !== undefined && endpoint.protocol !== 'tcp' && endpoint.protocol !== 'udp') {
      errors.push(`${at}.protocol 只能是 tcp 或 udp`)
    }
  }
}

function validateRule(
  rule: NtRule,
  where: string,
  errors: string[],
  warnings: string[],
  ruleIds: Set<string>,
  workspaceRoot: string | undefined,
  viewRoot: string | undefined,
  storeRoot: string | undefined,
  pathOptions: NormalizePathOptions,
): void {
  if (rule === null || typeof rule !== 'object') {
    errors.push(`${where} 必须是对象`)
    return
  }
  if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
    errors.push(`${where}.id 必须是非空字符串`)
  } else if (ruleIds.has(rule.id)) {
    errors.push(`${where}.id 重复: ${rule.id}`)
  } else {
    ruleIds.add(rule.id)
  }
  if (typeof rule.type !== 'string' || rule.type.trim().length === 0) {
    errors.push(`${where}.type 必须是非空字符串`)
  }
  if (rule.match === null || typeof rule.match !== 'object' || (rule.match.kind !== 'exact' && rule.match.kind !== 'prefix')) {
    errors.push(`${where}.match 必须是 {kind:'exact'|'prefix', path:string}`)
  }
  let matchPathValue: string | undefined
  if (rule.match !== null && typeof rule.match === 'object') {
    try {
      matchPathValue = normalizeWin32Path(rule.match.path, pathOptions)
    } catch (error) {
      errors.push(`${where}.match.path 非法: ${errorMessage(error)}`)
    }
  }
  if (!Array.isArray(rule.access) || rule.access.length === 0) {
    errors.push(`${where}.access 必须是非空数组`)
  } else {
    const seen = new Set<string>()
    for (const access of rule.access) {
      if (!ACCESS_VALUES.has(access)) errors.push(`${where}.access 含非法值: ${String(access)}`)
      if (seen.has(access)) errors.push(`${where}.access 重复: ${String(access)}`)
      seen.add(access)
    }
  }
  if (!ACTION_VALUES.has(rule.action)) {
    errors.push(`${where}.action 非法: ${String(rule.action)}`)
  }
  if (rule.action === 'stage') {
    const allowed = new Set<NtAccess>(['write', 'delete', 'rename', 'attribute'])
    if (Array.isArray(rule.access) && rule.access.some((access) => !allowed.has(access))) {
      errors.push(`${where}: stage 只能用于 write/delete/rename/attribute（不能 stage read/execute）`)
    }
    if (workspaceRoot !== undefined && matchPathValue !== undefined) {
      if (!isPathInside(matchPathValue, workspaceRoot)) {
        errors.push(`${where}: stage 规则必须落在 workspaceRoot 内（${matchPathValue} ⊄ ${workspaceRoot}）`)
      }
    }
  }
  if (rule.action === 'allow' && Array.isArray(rule.access) && workspaceRoot !== undefined && matchPathValue !== undefined) {
    const bypass = rule.access.filter((access) => access === 'write' || access === 'delete' || access === 'rename' || access === 'attribute')
    if (bypass.length > 0 && isPathInside(matchPathValue, workspaceRoot)) {
      errors.push(
        `${where}: 工作区内不能 allow ${bypass.join('/')}（会绕过 ProjFS 暂存直接写真实盘）；请改用 action='stage'`,
      )
    }
  }
  if (matchPathValue !== undefined) {
    for (const [label, root] of [
      ['viewRoot', viewRoot],
      ['storeRoot', storeRoot],
    ] as const) {
      if (root !== undefined && rule.action !== 'deny' && rule.action !== 'mask' && isPathInside(matchPathValue, root)) {
        warnings.push(`${where}: 规则位于 ${label} 内但不是 deny/mask；直接访问 store 应保持拒绝`)
      }
    }
  }
}

function normalizeOrError(
  value: unknown,
  where: string,
  errors: string[],
  pathOptions: NormalizePathOptions,
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${where} 必须是字符串`)
    return undefined
  }
  try {
    return normalizeWin32Path(value, pathOptions)
  } catch (error) {
    errors.push(`${where} 非法: ${errorMessage(error)}`)
    return undefined
  }
}

function normalizeRule(rule: NtRule, pathOptions: NormalizePathOptions): NtRule {
  return {
    ...rule,
    match: normalizeMatch(rule.match, pathOptions),
    access: [...new Set(rule.access)],
  }
}

function normalizeMatch(match: NtPathMatch, pathOptions: NormalizePathOptions): NtPathMatch {
  return { kind: match.kind, path: normalizeWin32Path(match.path, pathOptions) }
}

function compareRules(a: NtRule, b: NtRule): number {
  const specificity = matchSpecificity(b.match) - matchSpecificity(a.match)
  if (specificity !== 0) return specificity
  const action = ACTION_PRECEDENCE[a.action] - ACTION_PRECEDENCE[b.action]
  if (action !== 0) return action
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareMasks(a: NtPathMatch, b: NtPathMatch): number {
  const specificity = matchSpecificity(b) - matchSpecificity(a)
  if (specificity !== 0) return specificity
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function isSid(value: string): boolean {
  return /^S-1-\d+(-\d+)+$/i.test(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof NtError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
