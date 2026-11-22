// @ts-nocheck —— 与 host-plugin.ts 同一过渡策略。
/**
 * 异步审批队列（A2）：只追加的 JSONL 账本。
 *
 * 位置：`<workspaceRoot>/.dshstage/async-approvals.jsonl`（与 review store 同一层；
 * `.dshstage` 已被暂存/枚举面隐藏，不进入模型可见的工作区文件视图）。
 *
 * 记录模型（event-sourced）：
 *   `{type:'request', id, createdAt, sessionId, toolName, action, args, reason}`
 *   `{type:'decision', id, at, outcome:'approved'|'rejected'|'failed', by, result?}`
 * 读取时按 id 折叠；同一 id 只认第一条 decision（幂等）。
 *
 * 并发：单行 append 用 O_APPEND + fsync；队列是低频操作，单写者模型（宿主主实例）。
 * 多宿主写同一队列时，后写者仍按 id 折叠，不会覆盖已有 request。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const APPROVAL_QUEUE_BASENAME = 'async-approvals.jsonl'
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 30000

/** 创建一个绑定到 workspaceRoot 的队列（每次调用返回新对象；文件格式是唯一状态）。 */
export function createApprovalQueue(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('createApprovalQueue requires a workspaceRoot')
  }
  const dir = join(workspaceRoot, '.dshstage')
  const file = join(dir, APPROVAL_QUEUE_BASENAME)
  const lockFile = `${file}.lock`

  const ensureDir = () => mkdirSync(dir, { recursive: true })

  /**
   * 跨进程排他锁（B3）：O_EXCL 创建 `.lock`；超时/陈旧锁按 fail-closed 处理。
   * 队列是低频写入，10ms 退避足够；主线程不用 Atomics.wait。
   */
  const acquireLock = () => {
    ensureDir()
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let wait = 5
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx')
        try {
          writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
        } catch {
          /* 锁内容只是诊断 */
        }
        return fd
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(lockFile)
        } catch {
          /* 锁刚好消失/被替换；继续重试 */
        }
        if (Date.now() >= deadline) {
          const timeout = new Error('审批队列锁等待超时（APPROVAL_QUEUE_LOCK_TIMEOUT）')
          timeout.code = 'APPROVAL_QUEUE_LOCK_TIMEOUT'
          throw timeout
        }
        const until = Date.now() + wait
        while (Date.now() < until) { /* 短自旋；队列写入是低频操作 */ }
        wait = Math.min(wait * 2, 40)
      }
    }
  }

  const releaseLock = (fd) => {
    try {
      closeSync(fd)
    } catch {
      /* best effort */
    }
    try {
      unlinkSync(lockFile)
    } catch {
      /* best effort */
    }
  }

  const append = (record) => {
    ensureDir()
    const lock = acquireLock()
    try {
      const fd = openSync(file, 'a')
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`)
        try {
          fsyncSync(fd)
        } catch {
          /* fsync 不是所有文件系统都支持；写入本身已经发生 */
        }
      } finally {
        closeSync(fd)
      }
    } finally {
      releaseLock(lock)
    }
  }

  const readAll = () => {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const record = JSON.parse(line)
        if (record && typeof record === 'object' && typeof record.type === 'string') out.push(record)
      } catch {
        /* 损坏行跳过；不影响后续行 */
      }
    }
    return out
  }

  const fold = () => {
    const map = new Map()
    for (const record of readAll()) {
      if (record.type === 'request' && typeof record.id === 'string') {
        map.set(record.id, { ...record, decision: null })
      } else if (record.type === 'decision' && typeof record.id === 'string') {
        const current = map.get(record.id)
        if (current && current.decision === null) current.decision = record
      }
    }
    return map
  }

  /**
   * 入队一条审批请求。
   * @param {{sessionId?:string, toolName:string, action:string, args?:object, reason?:string}} request
   * @returns {object} request record（含 id）
   */
  const enqueue = (request) => {
    const id = `ap_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const record = {
      type: 'request',
      id,
      createdAt: new Date().toISOString(),
      sessionId: typeof request?.sessionId === 'string' ? request.sessionId : '',
      toolName: String(request?.toolName ?? 'unknown'),
      action: String(request?.action ?? 'unknown'),
      args: request?.args && typeof request.args === 'object' ? request.args : {},
      reason: typeof request?.reason === 'string' ? request.reason : '',
    }
    append(record)
    return { ...record, decision: null }
  }

  const listAll = () => [...fold().values()]
  const listPending = () => listAll().filter((item) => item.decision === null)
  const get = (id) => fold().get(String(id ?? '')) ?? null

  /**
   * 记录决策；同一 id 已决策时幂等返回旧记录。
   * @param {string} id
   * @param {'approved'|'rejected'|'failed'} outcome
   * @param {{by?:string, result?:unknown}} [extra]
   */
  const decide = (id, outcome, extra = {}) => {
    const item = get(id)
    if (!item) return { ok: false, reason: 'not-found', id: String(id ?? '') }
    if (item.decision !== null) return { ok: true, idempotent: true, id: item.id, decision: item.decision }
    const decision = {
      type: 'decision',
      id: item.id,
      at: new Date().toISOString(),
      outcome: String(outcome),
      by: typeof extra?.by === 'string' ? extra.by : 'user',
      ...(extra?.result === undefined ? {} : { result: extra.result }),
    }
    append(decision)
    return { ok: true, idempotent: false, id: item.id, decision }
  }

  return { file, enqueue, listAll, listPending, get, decide }
}
