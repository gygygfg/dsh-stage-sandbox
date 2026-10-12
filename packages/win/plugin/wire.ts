/**
 * 接线层 —— 把真实的审阅服务（`dsh-plugin/review-service.ts`）适配成对齐命令层
 * （`plugin/commands.ts`）所需的 `AlignedCommandDeps`。
 *
 * ── 为什么要一层适配（而不是让命令直接调 service）──────────────────────────────
 *   1. `commands.ts` 的逻辑是**纯函数**、可用假依赖离线单测；真实 DSH 只在阶段 4 跑一次。
 *   2. 快照条目（`path/op/kind/risk/safety/riskReason`）→ `RiskFacts` 的**推导**是
 *      对齐 NeoAI 分级的关键映射，必须只有一处实现、可单测。
 *
 * ── 映射口径（与 `review-service` 的 `classify` 同源，不另造第二套）──────────────
 *   `risk` 字段取值：`normal | outside | sensitive`；`safety`：`danger | risk | null`。
 *   本适配器**只做翻译**，不改判定：`sensitive`（含 `danger`）⇒ `secret:true`（最高优先，
 *   归 NeoAI 的密钥作用域）；`outside` ⇒ `pathScope:'other'`；`kind:'registry'` ⇒
 *   `effect:'registry'`、`pathScope:'system'`。
 *
 * @module winstage-sandbox/plugin/wire
 */

import type { AlignedCommandDeps } from './commands.ts'
import type { RiskFacts } from './risk.ts'
import { APPLY, REVIEW, type ChangeUnit } from './review-state.ts'

/** 快照里的单条变更（结构裁剪自 `review-service.snapshot().files[]`）。 */
export interface SnapshotFile {
  path: string
  op?: string
  kind?: string
  risk?: string
  safety?: string | null
  riskReason?: string | null
  external?: boolean
}

/** 审阅服务的最小结构（避免硬依赖 DSH / 具体类）。 */
export interface ReviewServiceLike {
  snapshot(): { files?: SnapshotFile[] }
  approve(paths?: readonly string[], options?: Record<string, unknown>): { approved?: number; failed?: unknown[] }
  reject(paths?: readonly string[]): unknown
}

/** NeoAI 对齐的审批单位数量上界（快照条目即单位）。 */
const DEFAULT_UNIT_REVIEW = REVIEW.PENDING
const DEFAULT_UNIT_APPLY = APPLY.NOT_REQUESTED

/**
 * 快照条目 → 风险事实（严格翻译，不新增判定）。
 * @param file - 快照里的单条变更
 */
export function riskFactsOf(file: SnapshotFile): RiskFacts {
  const facts: RiskFacts = { effect: 'filesystem' }
  if (file.kind === 'registry') {
    facts.effect = 'registry'
    facts.pathScope = 'system'
  }
  if (file.risk === 'sensitive') facts.secret = true
  else if (file.risk === 'outside') facts.pathScope = 'other'
  if (file.safety === 'danger') facts.selfStore = false // danger 只影响展示；密钥语义已由 secret 表达
  return facts
}

/**
 * 从快照条目构造变更单元。
 * @param file - 快照里的单条变更
 */
export function unitOf(file: SnapshotFile): ChangeUnit {
  return {
    id: file.path,
    reviewState: DEFAULT_UNIT_REVIEW,
    applyState: DEFAULT_UNIT_APPLY,
    paths: [file.path],
    createdAt: 0,
  }
}

/**
 * 用真实审阅服务构建 `AlignedCommandDeps`。
 *
 * `units()` 每次现读快照（审批面是本轮净变更，见 `review-service.snapshot()` 的说明），
 * 因此适配器**不缓存**状态，避免与"快照是实时比对结果"这一设计冲突。
 *
 * @param service - 审阅服务
 */
export function buildAlignedDeps(service: ReviewServiceLike): AlignedCommandDeps {
  return {
    units(): readonly ChangeUnit[] {
      const files = service.snapshot().files ?? []
      return files.map(unitOf)
    },
    riskOf(unit: ChangeUnit): RiskFacts {
      const files = service.snapshot().files ?? []
      const file = files.find((f) => f.path === unit.paths[0])
      return file === undefined ? { effect: 'filesystem' } : riskFactsOf(file)
    },
    apply(units: readonly ChangeUnit[]) {
      const paths = units.flatMap((u) => u.paths)
      const result = service.approve(paths)
      const applied = paths.slice(0, typeof result.approved === 'number' ? result.approved : paths.length)
      const failed = Array.isArray(result.failed) ? result.failed.map(String) : []
      return { applied, failed }
    },
    discard() {
      const files = service.snapshot().files ?? []
      service.reject(files.map((f) => f.path))
    },
  }
}
