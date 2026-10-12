/**
 * 审批分流中心 —— 对齐 NeoAI 的 `sandbox/review/approval_hub.lua`。
 *
 * ── 对齐来源（逐条对应）────────────────────────────────────────────────────────
 * 汇聚所有"需用户批准/需用户关注"的请求与观测，按**页面（page）**分类：
 *
 * | page       | 含义                     | 阻塞 | 数据来源 |
 * | ---        | ---                      | ---  | --- |
 * | `files`    | 待修改（文件变更单元）   | 否   | 变更单元队列 + 已保存 |
 * | `behavior` | 工具调用同意行为         | 是   | 工具审批队列（非遮蔽原因） |
 * | `resource` | 访问资源（遮蔽目录等）   | 是   | 工具审批队列（解除遮蔽） |
 * | `network`  | 网络请求（出沙箱访问）   | 是   | 网络同意服务 |
 * | `anomaly`  | 越界 / 异常行为（观测）  | 否   | 越界留痕 + 审计异常 |
 *
 * 阻塞类由来源模块 `submit()` 提交、由窗口/来源 `resolve()` 决策（**幂等**）；
 * 观测类由 provider 函数按需列举。本模块**无 UI 依赖**：headless 下仅保留条目不渲染。
 *
 * @module winstage-sandbox/plugin/approval-hub
 */

/** 页面定义（顺序即页面切换顺序）。 */
export const PAGES = Object.freeze([
  { id: 'files', label: '待修改', kind: 'review' },
  { id: 'behavior', label: '工具行为', kind: 'blocking' },
  { id: 'resource', label: '资源访问', kind: 'blocking' },
  { id: 'network', label: '网络请求', kind: 'blocking' },
  { id: 'anomaly', label: '越界/异常', kind: 'observe' },
] as const)

export type PageId = (typeof PAGES)[number]['id']

const PAGE_IDS: ReadonlySet<string> = new Set(PAGES.map((p) => p.id))

/** 一条阻塞类审批请求。 */
export interface ApprovalEntry {
  id?: string
  title?: string
  detail?: string[]
  /** 可选决策项（缺省由 UI 给 allow_once/allow_session/deny）。 */
  decisions?: Array<{ key: string; label: string; value: unknown }>
  /** 幂等决策回调。 */
  onDecision?: (value: unknown) => void
  meta?: Record<string, unknown>
}

interface StoredEntry extends ApprovalEntry {
  id: string
  page: PageId
  seq: number
  title: string
  detail: string[]
  createdAt: number
}

/** 观测类页面 provider：返回条目数组。 */
export type ObserveProvider = () => unknown[]

/** 审批中心实例。 */
export interface ApprovalHub {
  submit(page: PageId, entry: ApprovalEntry): string
  resolve(id: string, value: unknown): boolean
  clear(id: string): boolean
  get(id: string): StoredEntry | undefined
  list(page: PageId): StoredEntry[]
  registerProvider(page: PageId, fn: ObserveProvider | undefined): void
  observe(page: PageId): unknown[]
  pendingCount(page?: PageId): number
  reset(): void
}

/**
 * 创建一个审批中心。仿 Lua 版的进程内单例用法，但**显式工厂**便于测试与多实例。
 * @param onChange - 任一页发生变化时的通知（可选）
 */
export function createApprovalHub(onChange?: (page: PageId) => void): ApprovalHub {
  let seq = 0
  const entries = new Map<string, StoredEntry>()
  const order: string[] = []
  const providers = new Map<PageId, ObserveProvider>()

  const emit = (page: PageId): void => {
    if (typeof onChange === 'function') {
      try {
        onChange(page)
      } catch {
        /* 通知失败不影响数据面 */
      }
    }
  }

  return {
    submit(page, entry) {
      if (!PAGE_IDS.has(page)) throw new Error(`approval-hub: unknown page ${String(page)}`)
      seq += 1
      const id = entry?.id ?? `ah_${seq}_${Date.now()}`
      const record: StoredEntry = {
        id,
        page,
        seq,
        title: String(entry?.title ?? ''),
        detail: Array.isArray(entry?.detail) ? entry.detail : [],
        decisions: entry?.decisions,
        onDecision: entry?.onDecision,
        meta: entry?.meta,
        createdAt: Date.now(),
      }
      if (!entries.has(id)) order.push(id)
      entries.set(id, record)
      emit(page)
      return id
    },

    resolve(id, value) {
      const record = entries.get(id)
      if (record === undefined) return false
      entries.delete(id)
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
      if (typeof record.onDecision === 'function') {
        try {
          record.onDecision(value)
        } catch {
          /* 决策回调失败：条目已移除（幂等），不影响后续 */
        }
      }
      emit(record.page)
      return true
    },

    clear(id) {
      const record = entries.get(id)
      if (record === undefined) return false
      entries.delete(id)
      const at = order.indexOf(id)
      if (at >= 0) order.splice(at, 1)
      emit(record.page)
      return true
    },

    get(id) {
      return entries.get(id)
    },

    list(page) {
      const out: StoredEntry[] = []
      for (const id of order) {
        const record = entries.get(id)
        if (record !== undefined && record.page === page) out.push(record)
      }
      return out
    },

    registerProvider(page, fn) {
      if (fn === undefined) providers.delete(page)
      else providers.set(page, fn)
    },

    observe(page) {
      const fn = providers.get(page)
      if (typeof fn !== 'function') return []
      try {
        const items = fn()
        return Array.isArray(items) ? items : []
      } catch {
        return []
      }
    },

    pendingCount(page) {
      let n = 0
      for (const record of entries.values()) {
        if (page === undefined || record.page === page) n += 1
      }
      return n
    },

    reset() {
      seq = 0
      entries.clear()
      order.length = 0
      providers.clear()
    },
  }
}
