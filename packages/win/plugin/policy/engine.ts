/**
 * 策略引擎 —— 对齐 NeoAI 的 `sandbox/review/policy.lua`。
 *
 * ── 对齐来源（逐条对应）────────────────────────────────────────────────────────
 * NeoAI `policy.lua` 的语义：
 *   · 规则输入是**控制面验证过的不可变事实**（facts），规则本身在受限环境执行；
 *   · 聚合顺序 **DENY > NEEDS_CONFIRMATION > ALLOW**；
 *   · 约束取**更严格**的交集：数值取 min、列表取交集；
 *   · 规则异常 / 超时 / 结构错误统一产生 **DENY**（`POLICY_EVALUATION_FAILED`）；
 *   · 单条规则结果非法（decision 不是三者之一）⇒ **DENY**（`POLICY_INVALID_DECISION`）。
 *
 * ── 与 Lua 版的一处**如实差异**（不可照搬，故在此声明）──────────────────────────
 * Lua 版用 `setfenv` + `debug.sethook` 把规则关进白名单全局环境并施加**指令/墙钟预算**
 * （`POLICY_INSTRUCTION_BUDGET_EXCEEDED` / `POLICY_TIME_BUDGET_EXCEEDED`）。
 * JavaScript **没有**等价的"受限全局 + 指令计数钩子"原语：`Function`/闭包无法回收
 * 词法可达的全局，`vm` 模块不在本插件的可用面内。因此本实现**只保留**：
 *   · try/catch 把规则抛错归一为 `POLICY_EVALUATION_FAILED`（= DENY，fail-closed）；
 *   · 结果结构校验。
 * 并**不声称**具备"规则无法读文件/发网络"的隔离保证 —— 规则作者须是可信代码。
 * 这条差异与本仓既有的"残余边界"纪律一致：**未提供的保证必须在代码与文档里点名**。
 *
 * @module winstage-sandbox/plugin/policy/engine
 */

/** 三值裁决（枚举顺序即严格度：DENY 最强）。 */
export type Decision = 'ALLOW' | 'NEEDS_CONFIRMATION' | 'DENY'

/** 规则/引擎产出的规范化裁决。 */
export interface PolicyResult {
  decision: Decision
  reasonCodes: string[]
  /** 约束：数值取交集的最小值，列表取交集（更严格）。 */
  constraints: Record<string, unknown>
  /** 需要用户授予的窄权限标识。 */
  requiredGrants: string[]
}

/** 单条控制面事实（可扩展；引擎只读，不改）。 */
export interface Facts {
  tool?: string
  effect?: string
  args?: Record<string, unknown>
  /** 权限档位事实；`tier` 超过配置上限即硬拒绝。 */
  privilege?: { tier?: number }
  [key: string]: unknown
}

/** 一条策略规则：纯函数，输入事实、返回部分或完整裁决。 */
export type PolicyRule = (facts: Facts) => Partial<PolicyResult> | undefined

/** 引擎配置（对齐 NeoAI `tools.sandbox.policy`）。 */
export interface PolicyConfig {
  /** 硬拒绝的工具名清单（不可被确认覆盖）。 */
  denyTools?: string[]
  /** 显式离线：`effect === 'network'` 一律 DENY。 */
  offline?: boolean
  /** 允许的最高权限档位；超过即 DENY。 */
  maxTier?: number
  /** 用户规则。 */
  rules?: PolicyRule[]
}

/** 非法结果/求值失败的原因码（与 Lua 版同字面量）。 */
export const REASON = Object.freeze({
  TOOL_HARD_DENIED: 'TOOL_HARD_DENIED',
  NETWORK_OFFLINE: 'NETWORK_OFFLINE',
  PROCESS_UNAVAILABLE: 'PROCESS_UNAVAILABLE',
  PRIVILEGE_TIER_EXCEEDS_MAX: 'PRIVILEGE_TIER_EXCEEDS_MAX',
  POLICY_EVALUATION_FAILED: 'POLICY_EVALUATION_FAILED',
  POLICY_INVALID_RESULT: 'POLICY_INVALID_RESULT',
  POLICY_INVALID_DECISION: 'POLICY_INVALID_DECISION',
})

const DECISIONS: ReadonlySet<string> = new Set(['ALLOW', 'NEEDS_CONFIRMATION', 'DENY'])

/**
 * 归一化单条规则结果。
 * 非对象 ⇒ `POLICY_INVALID_RESULT`；decision 非法 ⇒ `POLICY_INVALID_DECISION`；两者都是 DENY。
 * @param res - 规则返回值
 */
export function normalizeResult(res: unknown): PolicyResult {
  if (res === null || typeof res !== 'object') {
    return { decision: 'DENY', reasonCodes: [REASON.POLICY_INVALID_RESULT], constraints: {}, requiredGrants: [] }
  }
  const record = res as Partial<PolicyResult>
  if (typeof record.decision !== 'string' || !DECISIONS.has(record.decision)) {
    return { decision: 'DENY', reasonCodes: [REASON.POLICY_INVALID_DECISION], constraints: {}, requiredGrants: [] }
  }
  return {
    decision: record.decision as Decision,
    reasonCodes: Array.isArray(record.reasonCodes) ? record.reasonCodes.map(String) : [],
    constraints: record.constraints && typeof record.constraints === 'object' ? (record.constraints as Record<string, unknown>) : {},
    requiredGrants: Array.isArray(record.requiredGrants) ? record.requiredGrants.slice() : [],
  }
}

/**
 * 合并约束：**更严格**优先 —— 数值取 min，数组取交集，其余取后者覆盖。
 * @param list - 各条裁决携带的约束
 */
export function intersectConstraints(list: Array<Record<string, unknown>>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined
  for (const c of list) {
    if (c === null || typeof c !== 'object') continue
    if (out === undefined) {
      out = { ...c }
      continue
    }
    for (const [key, value] of Object.entries(c)) {
      const prev = out[key]
      if (typeof value === 'number' && typeof prev === 'number') {
        out[key] = Math.min(prev, value)
      } else if (Array.isArray(value) && Array.isArray(prev)) {
        const allow = new Set(value)
        out[key] = prev.filter((item) => allow.has(item))
      } else {
        out[key] = value
      }
    }
  }
  return out ?? {}
}

/**
 * 内置硬拒绝规则（对齐 Lua 版第 1 段）。硬拒绝**不可被人工确认覆盖**。
 * @param facts - 控制面事实
 * @param config - 引擎配置
 * @returns 命中的裁决数组（可能为空）
 */
export function builtinRules(facts: Facts, config: PolicyConfig): PolicyResult[] {
  const out: PolicyResult[] = []
  const denyTools = Array.isArray(config.denyTools) ? config.denyTools : []
  if (typeof facts.tool === 'string' && denyTools.includes(facts.tool)) {
    out.push({ decision: 'DENY', reasonCodes: [REASON.TOOL_HARD_DENIED], constraints: {}, requiredGrants: [] })
  }
  if (facts.effect === 'network' && config.offline === true) {
    out.push({ decision: 'DENY', reasonCodes: [REASON.NETWORK_OFFLINE], constraints: {}, requiredGrants: [] })
  }
  const tier = typeof facts.privilege?.tier === 'number' ? facts.privilege.tier : 0
  const maxTier = typeof config.maxTier === 'number' ? config.maxTier : 0
  if (facts.privilege !== undefined && tier > maxTier) {
    out.push({ decision: 'DENY', reasonCodes: [REASON.PRIVILEGE_TIER_EXCEEDS_MAX], constraints: {}, requiredGrants: [] })
  }
  return out
}

/**
 * 求值并聚合。
 *
 * @param facts - 控制面验证过的不可变事实
 * @param config - 引擎配置（可选）
 * @returns 聚合后的裁决：DENY > NEEDS_CONFIRMATION > ALLOW，约束取更严格交集
 */
export function evaluate(facts: Facts, config: PolicyConfig = {}): PolicyResult {
  const results: PolicyResult[] = builtinRules(facts, config)

  const rules = Array.isArray(config.rules) ? config.rules : []
  for (const rule of rules) {
    if (typeof rule !== 'function') continue
    try {
      // 见模块头：JS 无等价受限环境，规则作者须为可信代码；抛错一律 fail-closed 为 DENY。
      results.push(normalizeResult(rule(facts)))
    } catch {
      results.push({ decision: 'DENY', reasonCodes: [REASON.POLICY_EVALUATION_FAILED], constraints: {}, requiredGrants: [] })
    }
  }

  // 聚合：DENY > NEEDS_CONFIRMATION > ALLOW；约束取更严格交集。
  const constraintsList: Array<Record<string, unknown>> = []
  const reasonCodes: string[] = []
  const requiredGrants: string[] = []
  let hardDeny = false
  let needsConfirmation = false
  for (const r of results) {
    if (r.constraints !== undefined && Object.keys(r.constraints).length > 0) constraintsList.push(r.constraints)
    for (const g of r.requiredGrants) requiredGrants.push(g)
    if (r.decision === 'DENY') {
      hardDeny = true
      for (const c of r.reasonCodes) reasonCodes.push(c)
    } else if (r.decision === 'NEEDS_CONFIRMATION') {
      needsConfirmation = true
      for (const c of r.reasonCodes) reasonCodes.push(c)
    }
  }
  const constraints = intersectConstraints(constraintsList)
  if (hardDeny) return { decision: 'DENY', reasonCodes, constraints, requiredGrants }
  if (needsConfirmation || requiredGrants.length > 0) {
    return { decision: 'NEEDS_CONFIRMATION', reasonCodes, constraints, requiredGrants }
  }
  return { decision: 'ALLOW', reasonCodes, constraints, requiredGrants }
}
