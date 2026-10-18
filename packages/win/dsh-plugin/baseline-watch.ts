// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * 基线漂移**只读轮询复核**（缺陷② F5b：过期基线不可见的触发点补全）。
 *
 * ── 根因（为什么"发布"不够）──────────────────────────────────────────────────
 * `review.json` 只在**变更/命令**时发布：`staging-fs` 的写盘后钩子（`afterMutation`）、
 * 每条 `/winstage*` 命令、shell 命令的 `publishWorkspaceSnapshot()`。而 `pwsh` 工具
 * **绕过 `ctx.fs` 直接写真实磁盘**，不产生上述任何一个事件 ⇒ 快照的 `generatedAt`
 * 会一直冻在上一次发布。实测（`docs/DSH沙箱边界-实例侧实测.md` §3.4 F5b）：
 * 90 秒内一次都没重发布，`staleBaseline = 0`、`alerts = []`、UI 无任何徽标 ——
 * 面板上那条"新增 f5b-stale.txt"看起来毫无异常 —— 直到点「批准所选」把真实盘
 * 上的 `SHELL-VERSION` 静默覆盖成 `STAGED-VERSION`。
 *
 * ── 本模块做什么 / 不做什么 ─────────────────────────────────────────────────
 * 做：按**轮询节拍**（默认 1500 ms，与 Client 读快照的轮询对齐）调用每个会话服务的
 * `reviewDrift()`。那个方法是**纯读**的：先用"清单 mtime + 每条净 diff 两侧 hash +
 * 漂移形状"组成指纹，指纹没变就立刻返回，**不写盘、不改状态**；只有事实真的变了
 * 才 `publish()` 一版新快照。因此外部写入会在一个节拍内出现在面板上，
 * 而"什么都没动"时这里是零 IO（不是忙等）。
 *
 * 同时把新出现的漂移送上**人工侧**诊断通道（`service.logError` → 宿主 logger /
 * 宿主 stderr）。⚠ 契约（`shell-executor.ts:1319-1335` 的分离纪律）：
 * **绝不**写模型可见的 stdout/stderr，也绝不进任何命令的 `text` 返回值。
 *
 * 不做：不对准基线、不 discard 候选、不冻结候选、不写任何暂存状态。
 * 也就是说，"轮询"永远不会成为那个把外部内容盖掉的动作 —— 那是缺陷②的另一半。
 *
 * ── 生命周期（R18 · KNOWN-08a 修复：运行期开关闸门）────────────────────────────
 * R17 的缺陷：轮询在 `apply()` 期按当时开关**装配一次**，运行中把开关关掉后定时器
 * **继续跑**（只读扫描 + 必要时 publish），与"关闭 = 对原 harness 无影响"不符；而
 * 关闭态启动时又完全不装配 ⇒ 重新打开后轮询不恢复（要重启）。
 *
 * 现在把启动/停止挂到**现读开关真值**（`options.isEnabled`，生产上传入
 * `host-plugin.ts` 的 `isEnabled` —— 它每次现读 loader 行表，与 fs 面同一真值）：
 *   · 开关**开**：正常节拍轮询（`setInterval`）；
 *   · 开关**关**：`clearInterval` 停掉轮询并释放它（**零 IO**，不再 `listReviewServices`
 *     也不再读盘）；同时挂一个同节拍的**轻量恢复检查**（`setTimeout`，只做一次布尔判定，
 *     不碰文件系统）—— 开关重新打开后自动恢复轮询，**不需要重启宿主**；
 *   · 恢复检查同样由 `ctx.effect`/`stop()` 持有：卸载时两个定时器一起清掉（dispose 对称）；
 *   · 判不出来（`isEnabled` 抛错）⇒ **继续轮询**（fail-safe：宁可多读一次，也不要
 *     静默停掉一个安全相关的可见性复核）；`intervalMs <= 0` 仍表示"关闭复核"（自测档）。
 *
 * 可注入依赖：`options.timers`（setInterval/clearInterval/setTimeout/clearTimeout）与
 * `options.tick` 是**离线自测缝**，生产不传（用 Node 全局定时器与真实 tick）。
 *
 * ── 为什么不用 `fs.watch` ────────────────────────────────────────────────────
 * 真实工作区里会被外部改的是**任意**文件，而 `fs.watch` 在 Windows 上只给"某个目录下
 * 发生了什么"、还要为每个暂存键的父目录挂一棵递归监听树（工作区外键更是挂不动）。
 * 指纹轮询的代价是"读几个 mtime + 对漂移路径各算一次 hash"，条数被暂存条数界住，
 * 比一棵监听树可预测得多。
 */

import { listReviewServices } from './review-service.ts'

/** 默认节拍：与 Client 读 `review.json` 的 1500 ms 轮询同一档（不多打一拍） */
export const WATCH_INTERVAL_MS = 1500

/** 定时器依赖（生产用 Node 全局；自测注入假定时器，零真实等待）。 */
const DEFAULT_TIMERS = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

/** 从环境读节拍（自测用）。非法/非正数 ⇒ undefined（调用方退回默认/关闭） */
export function watchIntervalFromEnv(env = process.env) {
  const raw = env?.WINSTAGE_WATCH_MS
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return value
}

/**
 * 装配只读复核（**一个实例 = 一个轮询器**；调用方只应调一次）。
 *
 * @param {object} ctx cordis 上下文（可选 `effect`；没有也能跑）
 * @param {{workspaceRoot: string, isEnabled?: () => boolean,
 *          log?: (message: string) => void, logError?: (message: string) => void,
 *          intervalMs?: number, env?: object, timers?: object, tick?: () => number}} options
 *   `isEnabled`：**每次判定现读**的开关真值（缺省恒 true）。生产传 host-plugin 的
 *   `isEnabled`（现读 loader 行表）；自测可传可变的假函数来驱动启停。
 * @returns {{stop: () => void, tick: () => number, intervalMs: number,
 *            isPolling: () => boolean, resumeScheduled: () => boolean, disposed: () => boolean}}
 *   `tick()` 是可离线调用的一拍（返回本拍处理的服务数）；`stop()` 是**终止性**清理
 *   （清两个定时器并禁止任何后续恢复；对应用 `ctx.effect` 的 disposer）。
 */
export function installBaselineWatch(ctx, options = {}) {
  const {
    workspaceRoot,
    isEnabled = () => true,
    log = () => {},
    logError = () => {},
    env = process.env,
    timers = DEFAULT_TIMERS,
    tick: tickOverride,
  } = options
  if (!workspaceRoot) throw new Error('installBaselineWatch: workspaceRoot is required')

  const envInterval = watchIntervalFromEnv(env)
  const intervalMs = options.intervalMs !== undefined ? options.intervalMs : envInterval !== undefined ? envInterval : WATCH_INTERVAL_MS

  /**
   * 一拍：
   *   1. 找当前工作区的所有活着的会话服务（没建过的会话不在册，零成本）；
   *   2. 每个服务跑一次 `reviewDrift()`（纯读 + 指纹短路）；
   *   3. 把**新出现**的漂移写进人工侧诊断通道（`emitDriftDiagnostics` 自己去重）。
   * 任何单个服务的异常都吞掉并记 error ⇒ 复核面永不拖垮插件。
   */
  const realTick = () => {
    let services = []
    try {
      services = listReviewServices(workspaceRoot)
    } catch (error) {
      logError(`基线复核：枚举会话服务失败（已忽略）：${error?.message ?? error}`)
      return 0
    }
    for (const service of services) {
      try {
        const result = service.reviewDrift()
        if (result.changed === true && result.stale.length > 0) {
          log(`基线复核：外部改动使 ${result.stale.length} 项基线过期，已重新发布快照。`)
        }
        if (typeof service.emitDriftDiagnostics === 'function') service.emitDriftDiagnostics(result.stale)
      } catch (error) {
        logError(`基线复核失败（已忽略，不影响审批）：${error?.message ?? error}`)
      }
    }
    return services.length
  }
  const tick = typeof tickOverride === 'function' ? tickOverride : realTick

  // 非正数/0 ⇒ 关闭（自测的"关掉复核"档）；`undefined` 已被上面的默认值吃掉
  if (!(intervalMs > 0)) {
    return { stop: () => {}, tick, intervalMs: 0, isPolling: () => false, resumeScheduled: () => false, disposed: () => false }
  }

  const unref = (handle) => {
    // 不让复核/恢复定时器成为"进程退不出去"的原因（Node 特有；其他环境没有这个方法）
    if (handle && typeof handle.unref === 'function') handle.unref()
  }
  /**
   * 现读开关真值；**判不出 ⇒ 继续轮询**（fail-safe 方向固定：宁可多一次只读复核，
   * 也不静默停掉一个安全相关的可见性面）。
   */
  const enabledNow = () => {
    try {
      return isEnabled() !== false
    } catch {
      return true
    }
  }

  let pollTimer
  let resumeTimer
  let stopped = false

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      timers.clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
  const cancelResume = () => {
    if (resumeTimer !== undefined) {
      timers.clearTimeout(resumeTimer)
      resumeTimer = undefined
    }
  }
  /** 灯开着才轮询；灯关着挂一个"只判开关、不碰文件"的轻量恢复检查（同节拍）。 */
  const scheduleResume = () => {
    if (stopped || resumeTimer !== undefined || pollTimer !== undefined) return
    resumeTimer = timers.setTimeout(() => {
      resumeTimer = undefined
      if (stopped) return
      if (enabledNow()) startPolling()
      else scheduleResume()
    }, intervalMs)
    unref(resumeTimer)
  }
  const startPolling = () => {
    if (stopped || pollTimer !== undefined) return
    cancelResume()
    pollTimer = timers.setInterval(guardedTick, intervalMs)
    unref(pollTimer)
  }
  /**
   * 被节拍调用的一拍：开关关掉 ⇒ **立刻停轮询**（clearInterval）并转恢复检查，
   * 这一拍不做任何服务枚举/磁盘读取。
   */
  const guardedTick = () => {
    if (stopped) return 0
    if (!enabledNow()) {
      stopPolling()
      scheduleResume()
      return 0
    }
    return tick()
  }

  const stop = () => {
    stopped = true
    stopPolling()
    cancelResume()
  }

  if (ctx && typeof ctx.effect === 'function') {
    // cordis 卸载协议：effect 返回清理函数，行被卸载/重挂时轮询与恢复检查一起消失
    ctx.effect(() => {
      if (enabledNow()) startPolling()
      else scheduleResume()
      return stop
    }, 'winstage-sandbox: baseline watch')
  } else {
    // ★ "失败必须响"：没有 `ctx.effect` 时定时器**不会随插件卸载停止**（`unref()` 只是
    //   不把进程钉住，不是清理）。这条路径只应在自测桩里出现；真出现了必须看得见。
    logError('基线漂移复核：本 ctx 没有 effect（非 cordis 上下文），定时器**不会**随插件卸载停止。')
    if (enabledNow()) startPolling()
    else scheduleResume()
  }

  return {
    stop,
    tick,
    intervalMs,
    isPolling: () => pollTimer !== undefined,
    resumeScheduled: () => resumeTimer !== undefined,
    disposed: () => stopped,
  }
}
