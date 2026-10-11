/**
 * R12 修复 · D7-a：**"本次操作没有走暂存"的显式记账**
 *
 * ── 为什么必须有这个文件 ───────────────────────────────────────────────────────
 * R11 D7-a 实测（`docs/round11/usability-缺陷.md`）：
 * 用户点了平台的「允许一次（danger-full-access）」之后，`write` 工具写的文件
 * **不在 `manifest.json`、不在 `staged\`，却真实落盘**，而界面与审计**零提示**。
 * 那正是"静默退出暂存"——用户以为"批准一次平台权限"只是让这一步能跑，
 * 实际上这一步的写入既不进暂存、也不进待审、也无法被拒绝。
 *
 * 本模块把这类"绕过暂存"的动作落成**可机读的账**（不是日志、不是注释）：
 *   · 每次绕过都记一条 `{op, path, reason, physical, at, sessionId}`；
 *   · 账本写在与 `review.json` **同一个存储根**（`review-service.publish()` 读它），
 *     因此面板与审计面必然看得到 —— "绝不静默"是结构性的，不靠调用方自觉；
 *   · 有界（超过 `MAX_ENTRIES` 丢最旧的），避免长时间会话把账本撑爆；
 *   · 写失败**绝不抛进 fs 路径**（记账失败不能把一次正常写入变成失败），
 *     但会通过 `onError` 回调让调用方打一条 error 级日志。
 *
 * ── 与"`WINSTAGE_STAGE_OUTSIDE=direct` 逃生口"的关系 ─────────────────────────
 * 那个逃生口是**显式配置**的直写；它不是"绕过"，但用户仍然必须能看见
 * "这一次直接落到真实磁盘了"。因此它也走同一本账，只是 `reason` 不同
 * （`stage-outside-direct` vs `foreign-session-workspace` / `unresolved-target`）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 账本文件名（与 `manifest.json` / `review.json` / `queue.json` 同一存储根） */
export const UNSTAGED_LEDGER_BASENAME = 'unstaged.json'

/** 账本条目上限（只保留最近的；旧的丢弃 —— 审计要的是"最近发生过什么"） */
export const MAX_ENTRIES = 200

/** 绕过暂存的机读原因（面板与断言都按这些字面量判定） */
export const UNSTAGED_REASONS = Object.freeze({
  /** 会话工作区与插件配置的暂存根不同（R11 D7-a 的实测形态） */
  FOREIGN_WORKSPACE: 'foreign-session-workspace',
  /** 目标无法归一成暂存键（`keyOf()` 拿不到 targetKey） */
  UNRESOLVED_TARGET: 'unresolved-target',
  /** 显式逃生口 `WINSTAGE_STAGE_OUTSIDE=direct` */
  STAGE_OUTSIDE_DIRECT: 'stage-outside-direct',
})

/** 账本绝对路径（`storeDir` = `resolveReviewStoreDir()` 的返回，与 review.json 同根） */
export function unstagedLedgerPath(storeDir) {
  return join(String(storeDir), UNSTAGED_LEDGER_BASENAME)
}

/**
 * 读账本。**任何**解析失败都当"空账"（宁可少报一次，也不要拿半个文件当真）。
 * @returns {{version:number, updatedAt?:string, entries:Array<object>}}
 */
export function readUnstagedLedger(storeDir) {
  const empty = { version: 1, entries: [] }
  const file = unstagedLedgerPath(storeDir)
  try {
    if (!existsSync(file)) return empty
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || !Array.isArray(raw.entries)) return empty
    return { version: 1, updatedAt: raw.updatedAt, entries: raw.entries }
  } catch {
    return empty
  }
}

/**
 * 记一条"没有走暂存"的动作。
 *
 * ⚠ **绝不抛**：调用点在每一次写路径上，记账失败不能把一次成功写入变成失败。
 *   失败原因走 `options.onError`（调用方打 error 级日志）。
 *
 * @param {string} storeDir 存储根（与 review.json 同根）
 * @param {object} entry 至少含 `op` 与 `path`
 * @param {{onError?: (message:string)=>void}} [options]
 * @returns {object|undefined} 落账的条目（失败时 undefined）
 */
export function recordUnstaged(storeDir, entry, options = {}) {
  try {
    const dir = String(storeDir ?? '')
    if (dir.length === 0) return undefined
    const record = {
      at: new Date().toISOString(),
      op: String(entry?.op ?? 'unknown'),
      path: String(entry?.path ?? ''),
      reason: String(entry?.reason ?? 'unknown'),
      ...(entry?.physical ? { physical: String(entry.physical) } : {}),
      ...(entry?.sessionId ? { sessionId: String(entry.sessionId) } : {}),
      /** 这一条是否**真的**落在真实磁盘上（`direct` 档为 true；`deny` 档不会走到这里） */
      appliedToDisk: entry?.appliedToDisk === true,
    }
    mkdirSync(dir, { recursive: true })
    const ledger = readUnstagedLedger(dir)
    const entries = [...ledger.entries, record].slice(-MAX_ENTRIES)
    const payload = { version: 1, updatedAt: new Date().toISOString(), entries }
    const file = unstagedLedgerPath(dir)
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload, null, 2))
    renameSync(tmp, file)
    return record
  } catch (error) {
    try {
      options.onError?.(`记账失败（不影响本次操作）：${error?.message ?? error}`)
    } catch {
      /* best effort */
    }
    return undefined
  }
}

/**
 * 账本 → `review.json` 的 `unstaged` 段（快照用；纯读、可机读、无副作用）。
 *
 * 与 `redactions` 段同一口径：**把"哪些动作绕过了暂存"从日志搬进载荷**，
 * 于是面板、审计、复核者都能一眼看到 —— 而不是只有读宿主日志才知道。
 */
export function unstagedSnapshot(storeDir) {
  const ledger = readUnstagedLedger(storeDir)
  const entries = ledger.entries
  const byReason = {}
  for (const entry of entries) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1
  return {
    /** 账本里**有没有**绕过暂存的记录（面板据此显示常驻横幅） */
    any: entries.length > 0,
    count: entries.length,
    /** 真的落在真实磁盘上的条数（`direct` 档） */
    appliedToDisk: entries.filter((e) => e.appliedToDisk === true).length,
    byReason,
    updatedAt: ledger.updatedAt ?? null,
    /** 最近 N 条（面板只需要展示最近发生的；完整账本在 `unstaged.json`） */
    recent: entries.slice(-20),
    ledgerFile: UNSTAGED_LEDGER_BASENAME,
  }
}
