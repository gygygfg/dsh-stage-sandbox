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
 * ── R40 修复（命令面的"看得见的谎"）────────────────────────────────────────────
 *   1. **分页**：`snapshot()` 默认只列 `limits.maxFiles`（40）行，而命令面的
 *      "应用全部 / 丢弃全部"按 `units()` 干活 ⇒ 旧实现只处理前 40 条却报"已应用 N 个文件"，
 *      第 41 条起既不显示也不写入（R40 实测 `.t/r40/snapshot/probe1.ts` C3 段：
 *      快照 `totalFiles=50 / truncated=true`，适配器只看到 2 个单位）。现在 `units()` /
 *      `discard()` 显式请求一个大页（`MAX_UNITS`）。
 *   2. **`frozenOnly` 行不可批准**：这类行在快照里是"仅存档、只显示"，旧适配器把它们
 *      当成普通待审单元 ⇒ 命令面显示为可批准、`--file` 选中还会真的调 `approve()`。
 *      现在 `units()` 过滤掉 `frozenOnly === true`（`discard()` 仍带上它们 —— 退回是
 *      "把存档也清掉"的显式意图）。
 *   3. **成功清单不再把失败项算成成功**：`review-service.approve()` 的 `failed` 是
 *      **对象数组**（`{path, op, code, message}`）。旧实现 `applied = paths.slice(0, approved)`，
 *      在"部分失败"时会把**失败的那条**也算进成功（R40 实测 `.t/r40/snapshot/probe1.ts`
 *      C2 段：approved=1、failed=[a] ⇒ applied=['a'] —— 同一路径既成功又失败）。现在按
 *      失败项的 `path` 反推 applied。
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
  /** `review-service` 的"仅存档"行：只显示、**不可批准**（D1 契约）。 */
  frozenOnly?: boolean
}

/** `snapshot()` 的一页（`limits` 是 `review-service` 已支持的入参）。 */
export interface SnapshotPage {
  files?: SnapshotFile[]
  counts?: { totalFiles?: number; listed?: number; pageSize?: number; truncated?: boolean }
  truncated?: boolean
}

/** 审阅服务的最小结构（避免硬依赖 DSH / 具体类）。 */
export interface ReviewServiceLike {
  snapshot(options?: { limits?: Record<string, number> }): SnapshotPage
  approve(paths?: readonly string[], options?: Record<string, unknown>): { approved?: number; failed?: unknown[] }
  reject(paths?: readonly string[]): unknown
}

/** 命令面单次可见的单元上界（`review-service` 的默认页是 40，命令面必须看全量）。 */
const MAX_UNITS = 100_000

/** NeoAI 对齐的审批单位数量上界（快照条目即单位）。 */
const DEFAULT_UNIT_REVIEW = REVIEW.PENDING
const DEFAULT_UNIT_APPLY = APPLY.NOT_REQUESTED

/**
 * 读一页"全量"快照（不缓存：审批面是本轮净变更）。
 * `limits.maxFiles` 覆盖只放宽**列表页**；单条 diff 仍受 `maxLinesPerFile` 约束。
 */
function snapshotPage(service: ReviewServiceLike): SnapshotPage {
  const page = service.snapshot({ limits: { maxFiles: MAX_UNITS } })
  return page && typeof page === 'object' ? page : { files: [] }
}

/** 命令面可见的待审行：剔除 `frozenOnly`（仅存档行不可批准）。 */
function commandFiles(service: ReviewServiceLike): SnapshotFile[] {
  const files = snapshotPage(service).files
  if (!Array.isArray(files)) return []
  return files.filter((file) => file && typeof file.path === 'string' && file.path.length > 0 && file.frozenOnly !== true)
}

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
      return commandFiles(service).map(unitOf)
    },
    riskOf(unit: ChangeUnit): RiskFacts {
      const file = commandFiles(service).find((f) => f.path === unit.paths[0])
      return file === undefined ? { effect: 'filesystem' } : riskFactsOf(file)
    },
    apply(units: readonly ChangeUnit[]) {
      const paths = [...new Set(units.flatMap((u) => u.paths))]
      // R40：空 units 是"没有选择"，不是"批准全部"；也不要让 `approve([])` 变成错误。
      if (paths.length === 0) return { applied: [], failed: [] }
      const result = service.approve(paths)
      /** 失败项里点名的路径 —— 用来把"失败"从成功清单里剔掉（R40-3）。 */
      const failedPaths = new Set<string>()
      const failed = Array.isArray(result.failed)
        ? result.failed.map((failure) => {
            if (typeof failure === 'string') return failure
            if (!failure || typeof failure !== 'object') return String(failure)
            const record = failure as { path?: unknown; code?: unknown; message?: unknown; error?: unknown }
            if (typeof record.path === 'string' && record.path.length > 0) failedPaths.add(record.path)
            const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : typeof record.error === 'string' && record.error.length > 0 ? record.error : 'ERROR'
            const path = typeof record.path === 'string' && record.path.length > 0 ? `${record.path}: ` : ''
            const message = typeof record.message === 'string' && record.message.length > 0 ? record.message : ''
            return `${path}${code}${message ? ` — ${message}` : ''}`
          })
        : []
      const approved = typeof result.approved === 'number' && result.approved >= 0 ? result.approved : paths.length
      /** 成功 = 未被失败项点名的路径（再按 `approved` 收口，与下层计数一致）。 */
      const applied = paths.filter((path) => !failedPaths.has(path)).slice(0, approved)
      return { applied, failed }
    },
    discard() {
      const files = snapshotPage(service).files
      const paths = (Array.isArray(files) ? files : [])
        .map((file) => file?.path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
      service.reject([...new Set(paths)])
    },
  }
}
