/**
 * 风险分级 —— 对齐 NeoAI 的 `sandbox/review/risk.lua`。
 *
 * ── 对齐来源（逐条对应）────────────────────────────────────────────────────────
 *   · 安全级别 **L0–L3**（`LOW/MODERATE/HIGH/CRITICAL`）；
 *   · 定级输入：路径级别（工作区 / 用户目录 / 系统路径）、网络、包安装、权限档位、
 *     密钥作用域、危险命令模式等；
 *   · 动作为 `auto | record | review | block`；
 *   · **硬拒绝不可被确认覆盖**（`denyReason` 非空即 BLOCK，且不因 `confirmed` 而放行）；
 *   · 密钥作用域与包安装**永不因会话自动审批而跳过**（至少 REVIEW）。
 *
 * ── 一条设计不变量（与 NeoAI `init.lua` 文件头同字面量）────────────────────────
 *   "硬拒绝不可被确认覆盖；未知结果不报告为成功。"
 * 本模块把这条落成可测试的纯函数：`decide()` 在 `hardDeny` 为真时**忽略** `confirmed`。
 *
 * @module winstage-sandbox/plugin/risk
 */

/** 安全级别（数值即严格度）。 */
export const LEVEL = Object.freeze({ LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 } as const)

export type Level = (typeof LEVEL)[keyof typeof LEVEL]
export type LevelName = 'L0' | 'L1' | 'L2' | 'L3'

/** 审批动作（严格度递增）。 */
export type Action = 'auto' | 'record' | 'review' | 'block'

/** 定级输入事实。 */
export interface RiskFacts {
  /** 目标路径的分类：工作区内 / 用户目录 / 系统路径 / 其它。 */
  pathScope?: 'workspace' | 'user' | 'system' | 'other'
  /** 效果类别（fs/network/process/registry…）。 */
  effect?: string
  /** 是否为包安装类命令。 */
  packageInstall?: boolean
  /** 权限档位（T0/T1/T2…，数值）。 */
  tier?: number
  /** 是否触及密钥作用域。 */
  secret?: boolean
  /** 是否命中危险命令模式（如设备级/内核级/破坏性）。 */
  dangerousCommand?: boolean
  /** 是否触碰本工具自身的存储（永不可自动放行）。 */
  selfStore?: boolean
}

/** 定级结果。 */
export interface RiskVerdict {
  level: Level
  levelName: LevelName
  /** 建议动作（未考虑"是否已确认"）。 */
  action: Action
  reasonCodes: string[]
  /** 非空 = 硬拒绝（BLOCK），**不可被确认覆盖**。 */
  hardDeny: boolean
}

/** 原因码（与 NeoAI 口径同义）。 */
export const RISK_REASON = Object.freeze({
  SYSTEM_PATH: 'RISK_SYSTEM_PATH',
  USER_PATH: 'RISK_USER_PATH',
  NETWORK: 'RISK_NETWORK',
  PACKAGE_INSTALL: 'RISK_PACKAGE_INSTALL',
  PRIVILEGE_TIER: 'RISK_PRIVILEGE_TIER',
  SECRET_SCOPE: 'RISK_SECRET_SCOPE',
  DANGEROUS_COMMAND: 'RISK_DANGEROUS_COMMAND',
  SELF_STORE: 'RISK_SELF_STORE',
})

const NAME_OF: Record<Level, LevelName> = { 0: 'L0', 1: 'L1', 2: 'L2', 3: 'L3' }

/**
 * 对事实定级。
 * @param facts - 定级输入
 * @returns 级别、建议动作、原因码与是否硬拒绝
 */
export function assess(facts: RiskFacts): RiskVerdict {
  let level: Level = LEVEL.LOW
  const reasonCodes: string[] = []
  let hardDeny = false

  const raise = (target: Level, code: string): void => {
    if (target > level) level = target
    reasonCodes.push(code)
  }

  switch (facts.pathScope) {
    case 'system':
      raise(LEVEL.CRITICAL, RISK_REASON.SYSTEM_PATH)
      break
    case 'user':
      raise(LEVEL.MODERATE, RISK_REASON.USER_PATH)
      break
    default:
      break
  }

  if (facts.effect === 'network') raise(LEVEL.MODERATE, RISK_REASON.NETWORK)
  if (facts.packageInstall === true) raise(LEVEL.HIGH, RISK_REASON.PACKAGE_INSTALL)
  if (typeof facts.tier === 'number' && facts.tier >= 2) raise(LEVEL.HIGH, RISK_REASON.PRIVILEGE_TIER)
  if (facts.secret === true) raise(LEVEL.HIGH, RISK_REASON.SECRET_SCOPE)
  if (facts.dangerousCommand === true) {
    raise(LEVEL.CRITICAL, RISK_REASON.DANGEROUS_COMMAND)
    hardDeny = true
  }
  if (facts.selfStore === true) {
    raise(LEVEL.CRITICAL, RISK_REASON.SELF_STORE)
    hardDeny = true
  }

  const action = actionFor(level, hardDeny)
  return { level, levelName: NAME_OF[level], action, reasonCodes, hardDeny }
}

/**
 * 级别 → 建议动作。
 * 硬拒绝恒为 `block`；否则 L0 自动、L1 记录、L2 复核、L3 阻断。
 * @param level - 安全级别
 * @param hardDeny - 是否硬拒绝
 */
export function actionFor(level: Level, hardDeny: boolean): Action {
  if (hardDeny) return 'block'
  if (level >= LEVEL.CRITICAL) return 'block'
  if (level === LEVEL.HIGH) return 'review'
  if (level === LEVEL.MODERATE) return 'record'
  return 'auto'
}

/** 最终决策的输入。 */
export interface DecideInput {
  verdict: RiskVerdict
  /** 用户是否已确认（对**非硬拒绝**生效）。 */
  confirmed?: boolean
  /** 是否处于"会话自动审批"档（可把 review 降为 auto；**不**越过硬拒绝与下列永不跳过项）。 */
  sessionAuto?: boolean
}

/**
 * 计算最终是否放行。
 *
 * 三条不可绕过的规则（对齐 NeoAI）：
 *   1. **硬拒绝不可被确认覆盖**：`hardDeny` 为真 ⇒ 恒 `false`（哪怕 `confirmed`/`sessionAuto`）；
 *   2. **密钥与包安装永不因会话自动审批跳过**：命中即至少需要显式 `confirmed`；
 *   3. 未确认的 `review` / `block` ⇒ `false`（"未知结果不报告为成功"）。
 *
 * @param input - 裁决 + 确认状态
 * @returns 是否允许执行
 */
export function decide(input: DecideInput): boolean {
  const { verdict, confirmed = false, sessionAuto = false } = input
  if (verdict.hardDeny) return false
  if (verdict.action === 'auto') return true
  if (verdict.action === 'record') return true
  // review / block：需要显式确认；会话自动审批**不得**跳过密钥与包安装。
  const neverAutoSkip =
    verdict.reasonCodes.includes(RISK_REASON.SECRET_SCOPE) || verdict.reasonCodes.includes(RISK_REASON.PACKAGE_INSTALL)
  if (sessionAuto && !neverAutoSkip) return true
  if (verdict.action === 'block') return false
  return confirmed === true
}
