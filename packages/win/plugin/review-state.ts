/**
 * 变更单元双状态线 —— 对齐 NeoAI 的 `sandbox/review/review.lua`。
 *
 * ── 对齐来源（逐条对应）────────────────────────────────────────────────────────
 * NeoAI 的三条状态线（work/review/apply）中，本模块持有后两条：
 *   · `review_state`: `PENDING | APPROVED | REJECTED | EXPIRED | SUPERSEDED`
 *   · `apply_state` : `NOT_REQUESTED | APPLYING | APPLIED | REVERTED | CONFLICT | FAILED | RECONCILING | NEEDS_ROOT`
 *
 * 语义要点（Lua 版逐条）：
 *   · **取代限定在同一分支与修订关系内**：同路径的新修订把旧 `PENDING` 取代为 `SUPERSEDED`；
 *   · **无净变化不入队**：`freezeCandidate()` 提前返回；
 *   · **部分应用不丢其余**：选择性应用后保留 `remaining`；
 *   · **丢弃是有状态操作**：先落状态、后回收；
 *   · **陈旧引用重定向 + 幂等**：沿 `supersededBy` 链解析，带环路保护。
 *
 * 本模块是**纯状态机**（无 IO），因此可在任意会话离线验证。
 *
 * @module winstage-sandbox/plugin/review-state
 */

/** 审批状态。 */
export const REVIEW = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  SUPERSEDED: 'SUPERSEDED',
} as const)

/** 应用状态。 */
export const APPLY = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  APPLYING: 'APPLYING',
  APPLIED: 'APPLIED',
  REVERTED: 'REVERTED',
  CONFLICT: 'CONFLICT',
  FAILED: 'FAILED',
  RECONCILING: 'RECONCILING',
  NEEDS_ROOT: 'NEEDS_ROOT',
} as const)

export type ReviewState = (typeof REVIEW)[keyof typeof REVIEW]
export type ApplyState = (typeof APPLY)[keyof typeof APPLY]

/** 一个变更单元。 */
export interface ChangeUnit {
  id: string
  /** 单条状态线。 */
  reviewState: ReviewState
  applyState: ApplyState
  /** 涉及的路径（用于同路径取代）。 */
  paths: string[]
  /** 被本单元取代的前驱 id。 */
  supersedes?: string
  /** 指向取代本单元的后继 id（陈旧引用沿此链重定向）。 */
  supersededBy?: string
  createdAt: number
}

/** 允许的 review_state 迁移（含幂等自环）。 */
const REVIEW_TRANSITIONS: Record<ReviewState, ReadonlySet<ReviewState>> = {
  PENDING: new Set([REVIEW.APPROVED, REVIEW.REJECTED, REVIEW.EXPIRED, REVIEW.SUPERSEDED]),
  APPROVED: new Set([REVIEW.SUPERSEDED]),
  REJECTED: new Set([]),
  EXPIRED: new Set([]),
  SUPERSEDED: new Set([]),
}

/** 允许的 apply_state 迁移。 */
const APPLY_TRANSITIONS: Record<ApplyState, ReadonlySet<ApplyState>> = {
  NOT_REQUESTED: new Set([APPLY.APPLYING, APPLY.NEEDS_ROOT]),
  NEEDS_ROOT: new Set([APPLY.APPLYING, APPLY.FAILED]),
  APPLYING: new Set([APPLY.APPLIED, APPLY.CONFLICT, APPLY.FAILED, APPLY.RECONCILING]),
  RECONCILING: new Set([APPLY.APPLIED, APPLY.FAILED]),
  APPLIED: new Set([APPLY.REVERTED]),
  REVERTED: new Set([APPLY.APPLYING]),
  CONFLICT: new Set([APPLY.APPLYING, APPLY.RECONCILING]),
  FAILED: new Set([APPLY.APPLYING, APPLY.RECONCILING]),
}

/**
 * 迁移 review_state。
 * @param from - 当前状态
 * @param to - 目标状态
 * @returns 是否合法（非法迁移应被拒绝，而不是静默接受）
 */
export function canTransitionReview(from: ReviewState, to: ReviewState): boolean {
  return from === to || REVIEW_TRANSITIONS[from].has(to)
}

/** 迁移 apply_state。 */
export function canTransitionApply(from: ApplyState, to: ApplyState): boolean {
  return from === to || APPLY_TRANSITIONS[from].has(to)
}

/** 仅为**未请求应用**的已批准单元才可选择性应用（对齐 `_rehydrate_pending` 的 keep 集合）。 */
export function isApplicable(unit: ChangeUnit): boolean {
  return (
    (unit.reviewState === REVIEW.PENDING || unit.reviewState === REVIEW.APPROVED) &&
    (unit.applyState === APPLY.NOT_REQUESTED || unit.applyState === APPLY.NEEDS_ROOT)
  )
}

/** 结果：过滤 + 保留未应用项（"部分应用不丢其余"）。 */
export interface ApplySelection {
  selected: ChangeUnit[]
  remaining: ChangeUnit[]
}

/**
 * 选择性应用：按路径挑选，返回被选中项与**保留**项。
 * @param units - 全部单元
 * @param paths - 要应用的路径（省略 = 全部可应用项）
 */
export function selectForApply(units: readonly ChangeUnit[], paths?: readonly string[]): ApplySelection {
  const wanted = paths === undefined ? undefined : new Set(paths)
  const selected: ChangeUnit[] = []
  const remaining: ChangeUnit[] = []
  for (const unit of units) {
    const applicable = isApplicable(unit)
    const matches = wanted === undefined ? true : unit.paths.some((p) => wanted.has(p))
    if (applicable && matches) selected.push(unit)
    else remaining.push(unit)
  }
  return { selected, remaining }
}

/**
 * 陈旧引用的**幂等重定向**：沿 `supersededBy` 链走到链尾，带环路保护。
 * @param units - 全部单元（按 id 索引）
 * @param id - 起始 id
 * @returns 链尾单元；找不到起始则返回 `undefined`
 */
export function resolveCurrent(units: Map<string, ChangeUnit>, id: string): ChangeUnit | undefined {
  const seen = new Set<string>()
  let current = units.get(id)
  while (current !== undefined && current.supersededBy !== undefined) {
    if (seen.has(current.id)) break // 环：停在此处（不无限循环）
    seen.add(current.id)
    const next = units.get(current.supersededBy)
    if (next === undefined) break
    current = next
  }
  return current
}

/**
 * 同路径取代（对齐"取代限定在同一分支与修订关系内"）：
 * 新单元把**仍是 PENDING** 的、路径相交的旧单元标为 SUPERSEDED，并建立链。
 * @param units - 全部单元（原地修改）
 * @param next - 新到的变更单元（其 `paths` 已归一）
 * @returns 被取代的旧单元 id
 */
export function supersedeByPaths(units: Map<string, ChangeUnit>, next: ChangeUnit): string[] {
  const superseded: string[] = []
  const nextPaths = new Set(next.paths)
  for (const unit of units.values()) {
    if (unit.id === next.id) continue
    if (unit.reviewState !== REVIEW.PENDING) continue
    if (!unit.paths.some((p) => nextPaths.has(p))) continue
    unit.reviewState = REVIEW.SUPERSEDED
    unit.supersededBy = next.id
    superseded.push(unit.id)
  }
  return superseded
}

/**
 * 无净变化不入队（对齐 `freezeCandidate()` 的提前返回）。
 * @param before - 冻结前内容哈希（`undefined` = 不存在）
 * @param after - 冻结后内容哈希（`undefined` = 删除）
 * @returns 是否存在净变化
 */
export function hasNetChange(before: string | undefined, after: string | undefined): boolean {
  return before !== after
}
