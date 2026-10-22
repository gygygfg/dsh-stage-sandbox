// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * WinStageSandbox — DeepSeek Harness 主机插件（命令与审阅面）
 *
 * 职责分工（本包装了两个 loader 行，各自一个模块）：
 *   - 本文件（行 `winstage-sandbox`）：设置开关、启动探测、`/winstage` 命令面；
 *   - `fs-entry.ts`（行 `winstage-fs`）：`ctx.fs` 的暂存实现（见 `staging-fs.ts`）。
 * 两行通过 `review-service.ts` 的进程内单例共享**同一份**暂存清单。
 *
 * ── 面板的数据从哪来（一个必须如实说明的机制约束）─────────────────────────────
 * Client 的 `ctx.remote.<命名空间>` 选集是**构建时固定**的：第三方插件无法在运行时
 * 新增 Remote 命名空间或转发事件（`@deepseek-ai/dsh-api-remotes` 的 README 逐字如此）。
 * 因此本插件用三条**已有**通道：
 *   1. 读（WP3-B 起）：本文件注册一条同源只读路由 `/winstage-panel/{snapshot,trust}`，
 *      **存储根由宿主侧 `resolveReviewStoreDir()` 解析**（Phase 1 起在 Windows 缓存），
 *      客户端只拿逻辑标识（路由名 + 会话 id），不再自己拼旧布局路径；
 *   2. 写：Client 用 `ctx.remote.commands.execute` 调 `/winstage approve|reject`，
 *      命令**不产生模型消息**（`dsh-commands` 的既定语义）；
 *   3. 兼容：路由不可用时（宿主没装 webServer / 未重启）`client.js` 仍可用旧的
 *      `ctx.remote.workspaceFiles.read` 读**升级前**布局的快照 —— 那是**兜底**，
 *      绝不是首选，且只有一条被注释说明的分支。
 *
 * ── WP3：用户侧可信性状态卡（AI 侧零注入）────────────────────────────────────
 * `/winstage status` 输出六个面（档位 / 首次掉档 / 失根 / 未结算审批 / 未确认写入 /
 * 读侧可见性），面板通过 `/winstage-panel/trust` 拿同一份 `buildTrustCard()`。
 * **这些文本只走用户侧通道**：命令自身的 stdout/stderr 与工具输出逐字节不变，
 * 卡片里的暂存路径一律被剥掉（只有逻辑标签 + 存储短哈希）。
 *
 * ── 一个必须如实说明的限制（手册第 0 章证据分层）────────────────────────────
 * `[实测]` WinStageSandbox 的**受限令牌**无法在已被沙箱化的会话里再创建
 * （缺 `TOKEN_ADJUST_DEFAULT` / `TOKEN_ADJUST_SESSIONID`，见 docs/实测证据记录.md
 * 残余边界 R6）。但**暂存不需要受限令牌**：它只要求"变更落暂存树、读取走投影"，
 * 这由 `ctx.fs` 提供方在可信代码里完成。因此本插件不假装 `init()` 成功：
 * `probeRuntime()` 只如实报告"能否建立受限令牌"，而暂存面与它无关、照常工作。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from './schema.ts'
import { evaluateEnvironment, environmentFailureMessage } from './environment-gate.ts'
import { probeWin32Abi } from '../src/capability.ts'
import { WindowsStageExecutor, resolveDshModuleRoot } from '../src/executor.ts'
import { canonical, compareKey, maskSessionId } from '../src/paths.ts'
import { renderCandidateDiff } from '../src/tools.ts'
import { verifyStageRootAlive } from '../src/stage-guard.ts'
import { REVIEW_BASENAME, getReviewService, resolveReviewStoreDir, disposeReviewServices } from './review-service.ts'
import { installBaselineWatch } from './baseline-watch.ts'
import { createAuditMirror } from './audit-mirror.ts'
import { createRunCapture } from './run-capture.ts'
// ★ BUG-B：档位（lane）判定的**同一份**分类与结论口径。只 import 纯函数/常量，
//   不 import 执行器类；`shell-executor.ts` 反过来**不**依赖本模块（无环）。
// ★ WP3：在同一份产物上补"历史"（首次掉档 / 是否曾掉档 / 失根次数）——
//   `history` 由 `persistLane()` 写、由这里的读侧解释，**不另造第二份状态**。
import {
  LANE_JOURNAL_BASENAME,
  noteStageRootLoss,
  readLaneJournalFile,
  summarizeLane,
  summarizeLaneHistory,
} from './shell-executor.ts'

export { Config }

export const name = 'winstage-sandbox'

/** Host 服务依赖：`commands` 可选（用 `ctx.inject` 惰性注册，缺失时不影响加载） */
export const inject = []

function makeLog(ctx) {
  const logger = ctx?.logger
  if (logger && typeof logger.info === 'function') {
    return {
      info: (msg) => logger.info(msg),
      warn: (msg) => (typeof logger.warn === 'function' ? logger.warn(msg) : logger.info(msg)),
    }
  }
  // 没有 logger 时退回 console —— 安装结果才是权威，但至少别静默
  return {
    info: (msg) => console.log(`[winstage-sandbox] ${msg}`),
    warn: (msg) => console.warn(`[winstage-sandbox] ${msg}`),
  }
}

/**
 * 真实能力探测（同步、不创建沙箱）。
 *
 * 只回答一个问题：**本会话能不能建立受限令牌与 ACL 授予**。
 * 这只影响"沙箱内跑命令"（`WindowsStageExecutor`），**不影响暂存面**。
 */
export function probeRuntime() {
  const result = {
    tokenRights: undefined,
    canMintRestrictedToken: false,
    missingRights: [],
    moduleRoots: [],
    ready: false,
    detail: '',
  }
  try {
    result.moduleRoots = resolveDshModuleRoot()
  } catch (error) {
    result.detail = `无法解析依赖位置: ${error.message}`
    return result
  }
  try {
    const caps = WindowsStageExecutor.capabilities()
    if (!caps.aclAvailable) {
      result.detail = `ACL 后端不可加载: ${caps.aclError ?? 'unknown'}`
      return result
    }
    const abi = probeWin32Abi()
    const rights = abi?.checks?.tokenRights?.granted ?? {}
    result.tokenRights = rights
    result.missingRights = Object.entries(rights)
      .filter(([, granted]) => !granted)
      .map(([right]) => right)
    result.canMintRestrictedToken = abi?.checks?.createRestrictedTokenViable?.status === 'pass'
    result.ready = result.canMintRestrictedToken
    result.detail = result.ready
      ? '本会话可以建立受限令牌，WinStageSandbox 的沙箱执行面可用'
      : `本会话无法建立受限令牌（缺少 ${result.missingRights.join(', ')}）。` +
        '这只影响"沙箱内跑命令"，暂存面不受影响。'
  } catch (error) {
    result.detail = `探测抛错: ${error.message}`
  }
  return result
}

// ==================== 命令面 ====================

/**
 * 按空白切分命令行参数，**支持双引号**（路径里的空格必须能表达）。
 *
 * `rawInput` 的契约是"命令名之后的每一个字节，包括分隔空白"，所以调用方
 * 必须先 trim 再切分。引号处理不是装饰：真实路径经常含空格，切不开就会把
 * 一个路径拆成两个不存在的参数。
 */
export function splitArgs(rawInput) {
  const out = []
  let current = ''
  let quoted = false
  for (const ch of String(rawInput ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * 解析**伞形**命令 `/winstage <子命令> [参数…]`。
 *
 * 注意：单用途命令（`/winstage-approve <路径…>`）**不能**用这个函数 ——
 * 它的第一个词就是路径，不是子命令。早期版本对两者用同一个解析器，
 * 结果 `/winstage approve src/a.ts` 的 `args` 为空 → **批准了全部待审文件**。
 * 这是自测抓到的真实缺陷，修复方式是把"子命令归属"写进命令规格。
 */
export function parseInvocation(rawInput) {
  const parts = splitArgs(rawInput)
  if (parts.length === 0) return { subcommand: 'list', args: [] }
  return { subcommand: parts[0].toLowerCase(), args: parts.slice(1) }
}

/** 把一个参数匹配到待审路径（精确相对路径，或"不含分隔符 → 匹配 basename"） */
/**
 * R34（CLI-hunter U-02）：路径匹配的**严格版**。
 *
 * 旧实现允许"裸 basename 回退"，且**任意一个**命中就采纳 —— `approve b.txt` 会同时
 * 批准根下的 `b.txt` 与 `dir/b.txt`（用户只授权了一个名字）。新语义：
 *   · 有**精确相对路径**命中 ⇒ 只取精确命中（`b.txt` 指的就是根下那个）；
 *   · 否则才做 basename 回退；回退命中**多于一个** ⇒ 记为歧义，调用方必须整批拒绝；
 *   · 多个参数命中同一路径 ⇒ 去重。
 * `matchPaths()` 保留旧签名（返回 matches）供 diff 渲染使用；授权路径必须用 detailed。
 */
export function matchPathsDetailed(changes, args) {
  const ambiguous = []
  const matches = []
  const seen = new Set()
  for (const arg of args || []) {
    const want = compareKey(String(arg).replace(/^\.?[\\/]/, ''))
    if (want.length === 0) continue
    let hit = changes.filter((change) => compareKey(change.path) === want)
    if (hit.length === 0 && want.indexOf('\\') < 0 && want.indexOf('/') < 0) {
      hit = changes.filter((change) => compareKey(change.path).split(/[\\/]/).pop() === want)
      if (hit.length > 1) {
        ambiguous.push({ arg: String(arg), paths: hit.map((change) => change.path) })
        continue
      }
    }
    for (const change of hit) {
      if (seen.has(change.path)) continue
      seen.add(change.path)
      matches.push(change)
    }
  }
  return { matches, ambiguous }
}

export function matchPaths(changes, args) {
  return matchPathsDetailed(changes, args).matches
}

/**
 * R34（CLI-hunter U-01）：`--` 之后一律当路径（POSIX 惯例）。
 * 没有它，名为 `--force` 的文件永远无法被单独批准；更糟的是旧实现把所有
 * `--xxx` 都当开关，`approve --force` = "批准全部"（用户想批一个文件却批了全部）。
 * 未知开关仍然报错；`--` 本身不出现在 flags/names 里。
 */
export function splitCommandFlags(args, allowedFlags) {  const flags = new Set()
  const names = []
  const unknown = []
  let endOfFlags = false
  for (const arg of args || []) {
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && String(arg).startsWith('--')) {
      if (allowedFlags.has(arg)) flags.add(arg)
      else unknown.push(String(arg))
      continue
    }
    names.push(String(arg))
  }
  return { flags, names, unknown }
}

/**
 * 漂移形状 → 命令面里的短标签（与 `review-service.ts` 的 `driftReasonOf()` 同字面量）。
 *
 * 缺陷②（F5b）：`baseline-appeared` 是"基线 = absent（新增）而真实文件在暂存之后出现"
 * 这一档 —— 它过去**完全不可见**，批准会静默覆盖磁盘上那份内容。命令面必须把形状
 * 说出来，用户才知道"先看 before/after 再决定"而不是直接点批准。
 */
export function staleShapeText(code) {
  if (code === 'baseline-appeared') return '· 真实文件在暂存后出现'
  if (code === 'baseline-deleted') return '· 真实文件被外部删除'
  if (code === 'baseline-drifted') return '· 真实文件被外部改写'
  return ''
}

/**
 * @param service 审阅服务
 * @param [snapshot] 已构建的快照（**可选**）。`/winstage status` 一次调用要同时渲染
 *   清单与状态卡，两处都用同一份快照 —— 否则 `publish()` 会被跑两遍，快照的
 *   `generatedAt` 还会差一版（清单与卡片各说一个时间戳）。
 */
export function formatList(service, snapshot) {
  const snap = snapshot ?? service.snapshot()
  if (!snap.pending) return 'WinStage 暂存区没有待审改动（改了文件之后会自动出现在这里）'
  const lines = [
    `WinStage 暂存待审  ${snap.counts.files} 个文件  +${snap.counts.additions} / −${snap.counts.deletions}`,
  ]
  if (snap.counts.frozenOnly > 0) {
    // D1：冻结存档行也要出现在 CLI 清单里，并**逐行标明不可批准** —— 否则
    // "N 个文件"与"能批准几个"会对不上，读的人会以为勾了就能写。
    lines.push(`  其中 ${snap.counts.frozenOnly} 个已不在当前净 diff（仅存档，不可批准）`)
  }
  if ((snap.counts.staleBaseline ?? 0) > 0) {
    // "多轮修改后视图不一致"：真实文件在暂存之后被外部改过，直接批准会被拒绝。
    // 清单里必须**说出来**，否则用户只会看到一条必然失败的"批准"。
    // ★ 缺陷②（F5b）：还要说**形状**（`baseline-appeared` = 磁盘上多出一份内容、
    //   基线本为"不存在"）。这条形状过去没有任何可见性，批准会把它静默覆盖。
    const lossy = snap.counts.staleBaselineLossy ?? 0
    lines.push(
      `  其中 ${snap.counts.staleBaseline} 项基线已过期（真实文件在暂存之后被外部改动过）：` +
        '直接批准会被拒绝；用 /winstage rebase [路径…] 以真实文件为基线重新暂存。',
    )
    if (lossy > 0) {
      lines.push(
        `  ⚠ 其中 ${lossy} 项会覆盖真实磁盘上**已存在**的内容（真实文件不是空基线）：` +
          '批准已按 STALE_BASELINE 拒绝，先 rebase 看清 before/after 再决定，或 /winstage reject 丢弃这份暂存。',
      )
    }
  }
  for (const file of snap.files) {
    const frozen = file.frozenOnly === true ? '   [已不在净 diff · 不可批准]' : ''
    const stale = file.baselineStale === true ? `   [基线已过期${staleShapeText(file.baselineStaleCode)} · 先 rebase]` : ''
    lines.push(`  ${file.op.padEnd(7)} ${file.path}   +${file.totals.added} / −${file.totals.removed}${frozen}${stale}`)
  }
  if (snap.truncated) {
    // 只写"列表已截断"不够：用户看到 40 行却不知道**到底还有多少**。
    // `counts.files` 现在是**截断前全量**、`counts.listed` 是实际列出行数，
    // 两者相减即被隐藏的条数（这正是"审批不显示"修复后新增的可见性）。
    const total = snap.counts.files
    const shown = snap.counts.listed ?? snap.files.length
    const hidden = Math.max(0, total - shown)
    lines.push(hidden > 0
      ? `  …（列表已截断：共 ${total} 项，已显示 ${shown} 项，**还有 ${hidden} 项未显示**；用 /winstage diff <路径> 或按路径批准）`
      : '  …（列表已截断）')
  }
  lines.push(`候选 ${snap.candidateId ?? '(未冻结)'} · 工作区 ${snap.workspaceRoot}`)
  lines.push(
    '用 /winstage diff <路径> 看改动；/winstage approve [路径…] 写入真实工作区；' +
      '/winstage rebase [路径…] 以真实文件为基线重新暂存（基线过期时）；/winstage reject [路径…] 退回真实磁盘',
  )
  return lines.join('\n')
}

export function formatDiff(service, args) {
  const ws = service.reload()
  const changes = ws.diffEntries()
  if (changes.length === 0) return 'WinStage 暂存区没有待审改动'
  const wanted = args && args.length > 0 ? matchPaths(changes, args) : changes
  if (wanted.length === 0) return `没有匹配的待审路径：${args.join(' ')}`
  const lines = []
  for (const change of wanted) {
    lines.push(`--- ${change.op} ${change.path}`)
    for (const line of renderCandidateDiff(ws.store, { changes: [change] }, { maxLines: 120 })) {
      if (line.type === 'add') lines.push(`+ ${line.text}`)
      else if (line.type === 'remove') lines.push(`- ${line.text}`)
      else if (line.type === 'note') lines.push(`  (${line.text})`)
    }
  }
  return lines.join('\n')
}

/**
 * ── BUG-B：`/winstage status` 必须回答"沙箱到底生效了没有" ────────────────────
 *
 * 事故形态（已确证）：`tier:'auto'` 的透明垫片探测不过 ⇒ `selectLaunchMode()`
 * fail-closed 回退受限令牌档 ⇒ **没有 shim** ⇒ 写入只剩内核硬拒、子进程 stdio 被掐断。
 * 而会话内表现与"一切正常"**一模一样**（`WINSTAGE_STAGE_ROOT` 为空、`node -v` 静默空输出），
 * 用户与模型都看不出沙箱已经退化 —— 本仓库最忌讳的静默失败。
 *
 * 因此这里读执行器落下的**结构化产物**（`<会话存储根>/sandbox-lane.json`，
 * 由 `shell-executor.ts` 的 `persistLane()` 写），并把结论**明说**一句。
 * ⚠ 本段只出现在 `/winstage status` 的命令文本里（人工/命令通道），
 * 绝不进命令自身的 stdout/stderr —— 零痕迹契约不变。
 */
export function readLaneJournal(service) {
  const dir = service?.workspace?.store?.dir
  if (typeof dir !== 'string' || dir.length === 0) {
    return { available: false, reason: 'no-store-dir', file: undefined }
  }
  // WP3：读法只有**一处**（`shell-executor.ts::readLaneJournalFile()`）——
  // 与执行器的写入侧同一份实现，读侧不再自己拼文件名/自己 JSON.parse。
  return readLaneJournalFile(dir)
}

// ═══════════════════════════════════════════════════════════════════════════
// WP3：用户侧**可信性状态卡**（六个面，机读 + 人读两用）
// ═══════════════════════════════════════════════════════════════════════════
//
// ── owner 已定的模型（照做，不得偏离）────────────────────────────────────────
//   · **AI 侧必须意识不到沙箱**：本文件产出的这些文本**只走用户侧通道**
//     （`/winstage status` 的命令文本、面板）。**绝不**进命令自身的 stdout/stderr、
//     也绝不进任何工具可见载荷 —— 零痕迹契约不破。
//   · 沙箱信息只在用户侧；不做 `stage where`，不向用户暴露暂存文件清单。
//   · 卡片里**不出现任何暂存绝对路径**（连产物文件路径也不出现）：机读侧用
//     `storeHash`（存储根路径的短哈希）做关联，人读侧只给"会话工作根"这类**逻辑**标签。
//     这一条是硬要求：命令文本会进会话日志，路径一旦写进去就再也收不回来。
//
// 六个面：①档位 ②首次掉档 ③失根 ④未结算审批 ⑤未确认写入 ⑥读侧可见性。
// 前两个面的**真值来源**是 `sandbox-lane.json`（`persistLane` 写、`summary`/`history`），
// 这里只做解释与呈现，**不重造**判据（`summarizeLane` / `summarizeLaneHistory` 同一份实现）。

/** 存储根路径的**短哈希**：让机读侧能关联"是哪一份存储"而不泄漏路径本身（FNV-1a 32 位） */
export function storeHash(dir) {
  const text = typeof dir === 'string' ? dir : ''
  if (text.length === 0) return null
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 面 ④：**未结算审批** —— 会话日志里 `approval/asked` 没有配对的 `approval/decided`。
 *
 * 为什么读会话事件而不是自己记账：审计对（`audit-mirror.ts`）本来就写进**会话日志**
 * （与原生审批同一对事件名、同一套 id）。从同一份真相上读，"未结算"就与原生审批的
 * 孤儿检测同一口径；自己再存一份必然漂移。
 *
 * 本轮实测形态：会话卡在"问过但没人答"上，用户在命令面与面板上**都看不出**这件事。
 *
 * 纯函数（只调 `session.eventAt()`），读不到会话时如实返回 `available:false`。
 * @returns {{available: boolean, scanned: number, unsettledCount: number, unsettled: Array<object>, reason?: string}}
 */
export function summarizeUnsettledApprovals(session) {
  const empty = { available: false, scanned: 0, unsettledCount: 0, unsettled: [] }
  if (!session || typeof session.eventAt !== 'function') {
    return { ...empty, reason: 'no-session' }
  }
  const seq = Number(session.seq)
  if (!Number.isFinite(seq) || seq <= 0) return { ...empty, available: true, reason: 'no-events' }
  const open = new Map()
  let scanned = 0
  for (let i = 0; i < seq; i += 1) {
    let event
    try {
      event = session.eventAt(i)
    } catch {
      break
    }
    if (!event || typeof event !== 'object') continue
    scanned += 1
    const id = event?.data?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (event.type === 'approval/asked') {
      if (!open.has(id)) open.set(id, { id, reason: event?.data?.reason ?? null, toolName: event?.data?.toolName ?? null, seq: i })
    } else if (event.type === 'approval/decided') {
      open.delete(id)
    }
  }
  const unsettled = [...open.values()].sort((a, b) => a.seq - b.seq)
  return { available: true, scanned, unsettledCount: unsettled.length, unsettled }
}

/**
 * 面 ⑤：**未确认写入**（WP2 面，`staging_write_not_persisted`）。
 *
 * 真值来源是**清单条目**：`staging-fs.ts::verifyPersistedWrite()` 回读闸门失败时把
 * `entry.persistenceFailure = { at, hash, stagedPath, problems }` 记进清单并 `touch()` 落盘。
 * 这里只**读**那份记账 —— 不重造判据、不碰 `staging-fs.ts`。
 *
 * ⚠ `stagedPath` **不进卡片**（它是暂存落点）：这里只取 `at` / `hash` / `problems` / 条目键。
 * ⚠ 诚实声明：清单条目被后续成功写入取代时该记账会随之消失 ⇒ 本面是"**最近一次已知**"，
 *   不是"历史上发生过几次"的审计（机读字段 `note` 如实写明）。
 *
 * @param {string|undefined} manifestPath 清单文件绝对路径（`store.manifestPath`）
 */
export function summarizeUnpersistedWrites(manifestPath) {
  const empty = { available: false, count: 0, items: [], last: null }
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    return { ...empty, reason: 'no-manifest-path' }
  }
  if (!existsSync(manifestPath)) return { ...empty, available: true, reason: 'no-manifest' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ...empty, reason: `manifest-unreadable: ${error?.message ?? error}` }
  }
  const entries = manifest?.entries && typeof manifest.entries === 'object' ? manifest.entries : {}
  const items = []
  for (const [key, entry] of Object.entries(entries)) {
    const failure = entry?.persistenceFailure
    if (!failure || typeof failure !== 'object') continue
    items.push({
      path: key,
      at: failure.at ?? null,
      hash: failure.hash ?? null,
      // `problems` 是**结构化检查项**（例如 `manifest-not-persisted`），不含路径片段
      problems: Array.isArray(failure.problems)
        ? failure.problems.map((p) => ({ check: p?.check ?? 'unknown', detail: p?.detail ?? null }))
        : [],
    })
  }
  items.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  return {
    available: true,
    count: items.length,
    items,
    last: items.length > 0 ? items[items.length - 1] : null,
    note: '只反映**清单里仍然留着**的未确认写入（被后续成功写入取代后该记账会消失）；不构成历史审计。',
  }
}

/** 面 ⑥：读侧可见性摘要（WP4 面）—— 从快照的 `readVisibility` 段收敛成一行+机读字段 */
export function summarizeReadVisibility(readVisibility) {
  const rv = readVisibility && typeof readVisibility === 'object' ? readVisibility : undefined
  if (!rv) return { available: false, policy: null, objects: 0, reads: 0, truncated: false, topMaskIds: [], note: null }
  const byMaskId = rv.byMaskId && typeof rv.byMaskId === 'object' ? rv.byMaskId : {}
  const topMaskIds = Object.entries(byMaskId)
    .map(([maskId, count]) => ({ maskId, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || (a.maskId < b.maskId ? -1 : 1))
  return {
    available: true,
    policy: rv.policy ?? null,
    objects: Number(rv.objects) || 0,
    reads: Number(rv.reads) || 0,
    truncated: rv.truncated === true,
    topMaskIds,
    note: typeof rv.note === 'string' ? rv.note : null,
  }
}

/**
 * 组装**可信性状态卡**（机读对象；人读渲染见 `formatTrustCard()`）。
 *
 * 六个面全部**总是有键**（拿不到就 `available:false` + `reason`），因为这张卡是
 * "机读 + 人读两用"：机读侧不许出现"字段偶尔消失"的形态。
 *
 * @param {{service?: object, session?: object, snapshot?: object, env?: object, now?: string}} options
 *   `service` = 审阅服务（取存储根/清单）；`session` = 会话句柄（面④读事件）；
 *   `snapshot` = 已发布的快照（面⑥读 `readVisibility`；不传就如实标 `available:false`）；
 *   `recordLoss` = 是否把本次观测写进 lane journal（面板 `/trust` 传 false：**刷新面板
 *   不应增加"失根次数"**；`/winstage status` 命令仍是显式观测，默认 true）
 */
export function buildTrustCard(options = {}) {
  const service = options.service
  const store = service?.workspace?.store
  /** R41-UX-02：纯查看面不记账（见 doc 注释）；默认 true 保持命令面语义不变。 */
  const recordLoss = options.recordLoss !== false
  const dir =
    typeof store?.dir === 'string' && store.dir.length > 0
      ? store.dir
      : typeof options.storeDir === 'string' && options.storeDir.length > 0
        ? options.storeDir
        : undefined

  // ── 面 ①②：档位 + 首次掉档（真值来源 = `sandbox-lane.json`，判据与执行器同一份）──
  const journal = readLaneJournalFile(dir)
  const record = journal.available ? journal.record ?? {} : undefined
  const lane = summarizeLane(record ?? {})
  const history = summarizeLaneHistory(record)
  const tier = {
    /** 产物是否存在（= 有没有命令真的经过本执行器） */
    recorded: journal.available,
    recordedReason: journal.reason,
    at: record?.at ?? null,
    launchMode: lane.launchMode,
    tierEffective: lane.tierEffective,
    requestedTier: lane.requestedTier,
    winStageEnabled: lane.winStageEnabled,
    fallbackClass: lane.fallback,
    fallbackText: lane.fallbackText,
    fallbackReasonRaw: record?.fallbackReason ?? null,
    status: lane.status,
    degraded: lane.degraded,
    conclusion: lane.conclusion,
  }
  const firstDegrade = {
    everDegraded: history.everDegraded,
    at: history.firstDegrade?.at ?? null,
    seq: history.firstDegrade?.seq ?? null,
    launchMode: history.firstDegrade?.launchMode ?? null,
    tierEffective: history.firstDegrade?.tierEffective ?? null,
    fallbackClass: history.firstDegrade?.fallbackClass ?? null,
    fallbackReason: history.firstDegrade?.fallbackReason ?? null,
    degradeCount: history.degradeCount,
    shimCount: history.shimCount,
    commandSeq: history.commandSeq,
  }

  // ── 面 ③：失根（**活体查询** + 观测历史）───────────────────────────────────
  let live
  if (store && typeof store.stageStatus === 'function') {
    try {
      live = store.stageStatus()
    } catch (error) {
      live = { alive: false, reason: `status-threw: ${error?.message ?? error}` }
    }
  } else if (dir !== undefined) {
    live = verifyStageRootAlive(dir)
  }
  const checked = live !== undefined
  const aliveNow = checked ? live.alive === true : null
  /**
   * ★ **"还没建根" 与 "根丢了" 是两件事**（本卡最容易误报的一处）。
   *
   * 会话还没跑过任何命令时，存储根本来就**不存在** —— 那时 `verifyStageRootAlive()`
   * 答 `root-missing`。把它当成"失根"会对着一个"一切正常、只是还没用过"的会话报警，
   * 而误报的告警与静默失败一样有害（用户学会忽略它）。
   *
   * 判据：根**曾经存在过**（有档位产物 ⇒ 至少跑过一次；或活体查询给出的不是
   * `root-missing`/`root-not-directory`）才算"丢"。
   */
  const rootMissing = checked && live.alive !== true && (live.reason === 'root-missing' || live.reason === 'root-not-directory')
  const everCreated = journal.available || (checked && !rootMissing)
  const lossRelevant = checked && aliveNow !== true && everCreated
  let rootLoss = history.rootLoss
  if (lossRelevant) {
    if (recordLoss) {
      // 观测点②：用户查看状态也是一次观测（与命令执行前同一个记账函数）
      const entry = noteStageRootLoss(dir, { reason: live.reason ?? 'not-alive', phase: 'status' })
      if (entry) {
        rootLoss = {
          everLost: true,
          count: entry.count,
          lastReason: entry.lastReason,
          lastAt: entry.lastAt,
          lastPhase: entry.lastPhase,
          lastSeq: entry.lastSeq,
          observedAt: entry.observedAt,
        }
      }
    } else {
      /**
       * R41-UX-02：面板 `/trust` 是**纯查看**，不写 lane journal。旧行为每次刷新都会
       * `count+1`，把"我点了几次刷新"伪装成"失根次数"，用户无法据此判断真实故障。
       * 当前这次丢失仍由面③ `stageRoot.alive=false/reason` 如实显示；这里只保留
       * **历史**计数，不新增观测。
       */
      const prior = history.rootLoss ?? {}
      rootLoss = {
        everLost: true,
        count: prior.count ?? 0,
        lastReason: live.reason ?? 'not-alive',
        lastAt: prior.lastAt ?? null,
        lastPhase: prior.lastPhase ?? null,
        lastSeq: prior.lastSeq ?? null,
        observedAt: Array.isArray(prior.observedAt) ? [...prior.observedAt] : [],
      }
    }
  }
  const stageRoot = {
    checked,
    alive: aliveNow,
    reason: live?.reason ?? null,
    /** `never-created` = 根还没建（不是故障）；其余取值即 `verifyStageRootAlive()` 的 reason */
    reasonCode: rootMissing && !everCreated ? 'never-created' : live?.reason ?? null,
    guarded: live?.guarded ?? null,
    everCreated,
    lossRelevant,
    everLost: rootLoss?.everLost === true,
    lossCount: rootLoss?.count ?? 0,
    lastLossAt: rootLoss?.lastAt ?? null,
    lastLossReason: rootLoss?.lastReason ?? null,
    lastLossPhase: rootLoss?.lastPhase ?? null,
    lastLossSeq: rootLoss?.lastSeq ?? null,
    observedAt: Array.isArray(rootLoss?.observedAt) ? [...rootLoss.observedAt] : [],
    note: '失根次数是**被观测到**的次数（观测点：命令执行前 / 显式 /winstage status；面板刷新不计数），不是完整审计；"根还没建"不算失根。',
  }

  // ── 面 ④⑤⑥ ────────────────────────────────────────────────────────────────
  const approvals = summarizeUnsettledApprovals(options.session)
  const manifestPath =
    typeof store?.manifestPath === 'string' && store.manifestPath.length > 0 ? store.manifestPath : dir ? join(dir, 'manifest.json') : undefined
  const writes = summarizeUnpersistedWrites(manifestPath)
  const readVisibility = summarizeReadVisibility(options.snapshot?.readVisibility)

  // ── 一句话结论（严重度顺序：失根 > 掉档 > 写入未确认 > 档位未知 > 关闭 > 有事项 > 可信）──
  const blockers = []
  let level
  if (stageRoot.lossRelevant) {
    level = 'lost'
    blockers.push({ code: 'stage-root-lost', detail: stageRoot.reason })
  } else if (tier.winStageEnabled !== false && tier.status === 'degraded') {
    level = 'degraded'
    blockers.push({ code: 'lane-degraded', detail: tier.fallbackClass })
  } else if (writes.count > 0) {
    level = 'write-unconfirmed'
    blockers.push({ code: 'unpersisted-write', detail: writes.last?.path ?? null })
  // ★ `off` 必须**先于** `unknown`：开关被显式关掉时，"没有档位记录"是**预期形态**而不是告警
  //   （owner 模型：关态属预期；BUG-B 的原始设计也是"关态不静默、也不谎报告警"）。
  //   反例（改前）：关态 + 无记录 ⇒ 落到 `unknown` ⇒ `ok=false` ⇒ kind=error，用户会被假告警误导。
  } else if (tier.winStageEnabled === false) {
    level = 'off'
    blockers.push({ code: 'sandbox-off', detail: null })
  } else if (tier.status === 'unknown') {
    level = 'unknown'
    blockers.push({ code: tier.recorded ? 'lane-unknown' : 'lane-unrecorded', detail: tier.recordedReason })
  } else if (approvals.unsettledCount > 0 || readVisibility.reads > 0) {
    level = 'attention'
    if (approvals.unsettledCount > 0) blockers.push({ code: 'unsettled-approval', detail: approvals.unsettledCount })
    if (readVisibility.reads > 0) blockers.push({ code: 'sensitive-reads', detail: readVisibility.reads })
  } else {
    level = 'trusted'
  }
  const ok = level === 'trusted' || level === 'off' || level === 'attention'
  const conclusion =
    level === 'lost'
      ? `沙箱此刻**不可信**：会话工作根已不可用（${stageRoot.reason ?? '原因未知'}）——写入会以 STAGE_ROOT_LOST 失败，不会静默改写真实文件。`
      : level === 'degraded'
        ? `沙箱此刻**不可信**：档位回退到 ${tier.launchMode ?? '(未报出)'}，没有去令牌化通道 —— 写入只剩内核硬拒、命令产出不进暂存。`
        : level === 'write-unconfirmed'
          ? `沙箱档位正常，但有 ${writes.count} 次写入**没有确认落盘**（最近一次：${writes.last?.path ?? '未知'}）——那次写入不应当成已完成。`
          : level === 'unknown'
            ? '沙箱档位**未知**：本会话还没有一次档位判定经过本执行器 —— 按"未证实已生效"对待。'
            : level === 'off'
              ? `沙箱**关闭**（属预期）：档位=${tier.launchMode ?? '(未报出)'}，本执行器不接管暂存面，此形态仅作记录。`
              : level === 'attention'
                ? `沙箱档位正常（已生效），但有 ${blockers.length} 类**待处理事项**：${blockers.map((b) => b.code).join('、')}。`
                : '沙箱此刻**可信**：命令走去令牌化通道，文件/注册表写入先落暂存、批准后才写真实磁盘。'

  return {
    kind: 'winstage-trust-card',
    version: 1,
    at: typeof options.now === 'string' ? options.now : new Date().toISOString(),
    /** 存储根的**短哈希**（关联用；**不是**路径 —— 路径绝不进卡片） */
    storeHash: storeHash(dir),
    storeLabel: dir ? '会话工作根（Windows 缓存）' : '（无会话存储根）',
    tier,
    firstDegrade,
    stageRoot,
    approvals,
    writes,
    readVisibility,
    trust: { level, ok, blockers },
    conclusion,
  }
}

/** 面 ①②的人读渲染（`formatLaneSection()` 与状态卡共用同一份，不写第二份文案） */
function formatTierLines(card) {
  const { tier, firstDegrade } = card
  const lines = ['【沙箱档位与降级告警】']
  if (!tier.recorded) {
    lines.push(`  · 没有档位判定记录（${tier.recordedReason}）`)
    lines.push(
      '  · 结论：**尚未证实沙箱真的生效**（档位判定只在命令执行时产生）。' +
        '跑一条 pwsh 命令（例如 `node -v`）后再看这里；若那时仍无记录，说明命令没有经过 WinStage 执行器。',
    )
    return lines
  }
  lines.push(`  · 最近一次判定：${tier.at ?? '（无时间戳）'}`)
  lines.push(
    `  · lane（launchMode）= ${tier.launchMode ?? '（未报出）'}；tierEffective = ${tier.tierEffective ?? '（未报出）'}；` +
      `请求档位 = ${tier.requestedTier ?? '（未报出）'}；WinStage 开关 = ${tier.winStageEnabled ? '开' : '关'}`,
  )
  lines.push(`  · 回退分类 = ${tier.fallbackClass}${tier.fallbackText ? ` — ${tier.fallbackText}` : ''}`)
  lines.push(`  · 原始 fallbackReason = ${tier.fallbackReasonRaw ?? '（无）'}`)
  lines.push(`  · 结论：${tier.conclusion}`)
  // ★ WP3 新增的第 2 个面：**首次掉档**（"是否曾掉档"只有历史答得了）
  lines.push(
    firstDegrade.everDegraded
      ? `  · 首次掉档：${firstDegrade.at ?? '（无时间戳）'}（第 ${firstDegrade.seq ?? '?'} 条命令）` +
        `，launchMode=${firstDegrade.launchMode ?? '?'}，分类=${firstDegrade.fallbackClass ?? '?'}` +
        `；本会话累计掉档 ${firstDegrade.degradeCount} 次 / 正常 ${firstDegrade.shimCount} 次` +
        `（共 ${firstDegrade.commandSeq ?? '?'} 次判定）`
      : `  · 首次掉档：**没有掉过档**（本会话 ${firstDegrade.commandSeq ?? '?'} 次判定全部走 shim 通道）`,
  )
  if (tier.status === 'degraded') {
    lines.push(
      '  · 处置：① 查 shim 产物是否齐备（DLL / winstage-inject.exe / winstage-probe.exe）；' +
        '② 查探测证据（暂存根下的 shim.log 与能力探测输出）；' +
        '③ 在修好之前，本窗口的写入结果按"可能只剩内核硬拒"对待，**不要**当成沙箱内成功。',
    )
  }
  return lines
}

/**
 * 渲染"沙箱档位与降级告警"一段（**保留导出**：既有调用方/文档用它，语义不变 ——
 * 最危险的形态（`launchMode !== 'shim'` 且开关为开）返回 `kind:'error'`，命令文本要显眼）。
 *
 * WP3 起它是状态卡的①②两个面的**同一份**渲染（`formatTierLines`），不再自己读产物。
 *
 * @returns {{kind: 'success'|'error', text: string}}
 */
export function formatLaneSection(service) {
  const card = buildTrustCard({ service })
  const status = card.tier.status
  return {
    kind: status === 'degraded' ? 'error' : 'success',
    text: formatTierLines(card).join('\n'),
  }
}

/** 状态卡 → **人读文本**（机读对象见 `buildTrustCard()`；两者同一份数据，不各算一次） */
export function formatTrustCard(card) {
  const { tier, firstDegrade, stageRoot, approvals, writes, readVisibility, trust } = card
  const lines = [`【WinStage 可信性状态卡】 生成于 ${card.at}`]
  lines.push(`  结论：${card.conclusion}`)
  lines.push(
    `  机读：level=${trust.level} ok=${trust.ok} …` +
      `store=${card.storeHash ?? '(none)'} markers=${trust.blockers.map((b) => b.code).join(',') || '(none)'}`,
  )
  lines.push('')
  lines.push('① 档位')
  for (const line of formatTierLines(card).slice(1)) lines.push(line)
  lines.push('')
  lines.push('② 首次掉档 / 是否曾掉档')
  lines.push(
    `  · 是否曾掉档 = ${firstDegrade.everDegraded ? '是' : '否'}；首次 = ${firstDegrade.at ?? '（无）'}` +
      `；命令序号 = ${firstDegrade.seq ?? '（无）'}；原因分类 = ${firstDegrade.fallbackClass ?? '（无）'}`,
  )
  lines.push(`  · 计数：掉档 ${firstDegrade.degradeCount} 次 / 走 shim ${firstDegrade.shimCount} 次（判定总数 ${firstDegrade.commandSeq ?? 0}）`)
  if (firstDegrade.fallbackReason) lines.push(`  · 首次原因原文 = ${firstDegrade.fallbackReason}`)
  lines.push('')
  lines.push('③ 失根')
  lines.push(
    `  · 此刻 = ${
      !stageRoot.checked
        ? '（未检查：没有会话存储根）'
        : stageRoot.alive
          ? '存活'
          : stageRoot.reasonCode === 'never-created'
            ? '尚未建立（本会话还没有过暂存写入 —— **不是**故障）'
            : `**不可用**（${stageRoot.reason}）`
    }；是否发生过 = ${stageRoot.everLost ? '是' : '否'}；次数 = ${stageRoot.lossCount}`,
  )
  if (stageRoot.everLost) {
    lines.push(`  · 最近一次：${stageRoot.lastLossAt ?? '（无时间戳）'}（${stageRoot.lastLossReason ?? '原因未知'}，观测点=${stageRoot.lastLossPhase ?? '?'}，命令序号=${stageRoot.lastLossSeq ?? '?'}）`)
  }
  lines.push(`  · 口径：${stageRoot.note}`)
  lines.push('')
  lines.push('④ 未结算审批')
  lines.push(
    approvals.available
      ? `  · 有 ${approvals.unsettledCount} 项 \`approval/asked\` 没有应答（扫过 ${approvals.scanned} 条会话事件）` +
        `${approvals.unsettledCount > 0 ? '：会话可能正卡在等待决策上' : ''}`
      : `  · 读不到会话事件（${approvals.reason ?? 'unknown'}）——这一面**未知**，不是"没有"。`,
  )
  for (const item of approvals.unsettled.slice(0, 5)) {
    lines.push(`    · ${item.id}${item.reason ? ` — ${item.reason}` : ''}`)
  }
  lines.push('')
  lines.push('⑤ 未确认写入（staging_write_not_persisted）')
  lines.push(
    writes.available
      ? `  · 清单里还留着 ${writes.count} 条未确认写入` +
        `${writes.last ? `：最近 ${writes.last.at ?? '（无时间戳）'} 的 ${writes.last.path}` : ''}`
      : `  · 读不到清单（${writes.reason ?? 'unknown'}）——这一面**未知**，不是"没有"。`,
  )
  if (writes.last?.problems?.length) {
    lines.push(`    · 检查项：${writes.last.problems.map((p) => p.check).join('、')}`)
  }
  if (writes.available) lines.push(`  · 口径：${writes.note}`)
  lines.push('')
  lines.push('⑥ 读侧可见性')
  lines.push(
    readVisibility.available
      ? `  · 策略=${readVisibility.policy ?? '?'}；去重对象 ${readVisibility.objects} 个；读取 ${readVisibility.reads} 次` +
        `${readVisibility.truncated ? '（已达条目上限，计数只累计不再新增）' : ''}` +
        `${readVisibility.topMaskIds.length > 0 ? `；按类：${readVisibility.topMaskIds.map((x) => `${x.maskId}×${x.count}`).join('、')}` : ''}`
      : '  · 还没有已发布的快照，这一面暂无数据（**不是**"没有敏感读"）。',
  )
  lines.push('')
  lines.push('  说明：本卡片只走**用户侧**通道（/winstage status 文本、面板）；命令自身的 stdout/stderr 与工具输出**逐字节不变**，不含本卡任何内容。')
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// WP3-B：面板**读侧路径对齐**（宿主侧解析 + 逻辑标识，客户端不再拼旧布局）
// ═══════════════════════════════════════════════════════════════════════════
//
// 缺口（实测）：存储根已迁到 Windows 缓存（`resolveStageRoot()`），而 `client.js` 仍按
// **旧布局**拼 `<workspaceRoot>/.dshstage/sessions/<键>/review.json` ⇒ 面板永远读不到
// 新根里的快照（读到的是"没有待审"，或者更糟：升级前遗留的**旧**快照）。
//
// 修法：把"存储根在哪"这一判断**收回宿主侧**，且只有一条解析路径
// （`review-service.ts::resolveReviewStoreDir()`，签名不改）。客户端只拿**逻辑标识**
// （路由名 + 会话 id），**不接触任何暂存路径** —— `PANEL_STORE_LABEL` 是给人看的逻辑标签，
// `storeHash` 是给机器关联的短哈希，两者都不含路径。

export const PANEL_ROUTE_PREFIX = '/winstage-panel'
export const PANEL_SNAPSHOT_PATH = `${PANEL_ROUTE_PREFIX}/snapshot`
export const PANEL_TRUST_PATH = `${PANEL_ROUTE_PREFIX}/trust`

/** 面板读到的存储的**逻辑**标识（不含路径）；机读 `hash` 由 `storeHash()` 给 */
export function panelStoreIdentity(dir, sessionId) {
  const scope = typeof sessionId === 'string' && sessionId.trim().length > 0 ? 'session' : 'shared'
  return { scope, label: scope === 'session' ? '会话工作根（Windows 缓存）' : '共享工作根（Windows 缓存）', hash: storeHash(dir) }
}

/**
 * 宿主侧解析某会话的存储根 —— **唯一**入口是 `resolveReviewStoreDir()`。
 *
 * 为什么不在客户端解析：缓存根的基目录来自宿主进程的 `%LOCALAPPDATA%`，浏览器里没有这个
 * 事实；客户端自己拼只能拼出旧布局（这正是本次缺口）。**纯函数、无副作用、不建目录**。
 */
export function panelStoreDir({ workspaceRoot, sessionId, env } = {}) {
  return resolveReviewStoreDir({ workspaceRoot, sessionId, env })
}

/**
 * 读**已发布**的快照（只读：不实例化审阅服务 ⇒ 不建目录、不触发认领/自愈）。
 * @returns {{ok: boolean, code?: string, dir?: string, snapshot?: object, detail?: string}}
 */
export function readPublishedSnapshot({ workspaceRoot, sessionId, env } = {}) {
  const dir = panelStoreDir({ workspaceRoot, sessionId, env })
  const file = join(dir, REVIEW_BASENAME)
  if (!existsSync(file)) return { ok: false, code: 'no-snapshot', dir }
  try {
    /**
     * R40-SNAP-08（P3）：`review.json` 是**磁盘上的普通文件**，可能被手写/旧版本/半截写入
     * 污染。旧实现直接把 `JSON.parse()` 的结果原样返回，于是 `files:"nope"`、根为数组、
     * `version:999`、20000 行等都能 200 通过，客户端再自己 `files.map` 就炸。
     * 这里做**最小形状校验 + 硬上限**：不是快照形状 ⇒ `snapshot-invalid`，不渲染。
     */
    const size = statSync(file).size
    if (!Number.isFinite(size) || size > 16 * 1024 * 1024) {
      return { ok: false, code: 'snapshot-too-large', dir, detail: `size=${size}` }
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, code: 'snapshot-invalid', dir, detail: 'root-not-object' }
    }
    if (parsed.files !== undefined && (!Array.isArray(parsed.files) || parsed.files.length > 100_000)) {
      return { ok: false, code: 'snapshot-invalid', dir, detail: 'files-not-array-or-too-many' }
    }
    if (Array.isArray(parsed.files)) {
      const bad = parsed.files.find((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.path !== 'string' || entry.path.length === 0)
      if (bad !== undefined) return { ok: false, code: 'snapshot-invalid', dir, detail: 'file-entry-invalid' }
    }
    if (parsed.version !== undefined && (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version))) {
      return { ok: false, code: 'snapshot-invalid', dir, detail: 'version-invalid' }
    }
    if (parsed.staging !== undefined && (!parsed.staging || typeof parsed.staging !== 'object' || Array.isArray(parsed.staging))) {
      return { ok: false, code: 'snapshot-invalid', dir, detail: 'staging-invalid' }
    }
    const snapshot = parsed
    /**
     * R34-SEC-05（P3）：快照里的 `workspaceRoot` 用来给客户端做"没串台"自校验
     * （S9）；但它只是**文件内容**，可以被手写/旧版本篡改。路由侧既然已经知道
     * 自己服务的是哪个工作区，就在返回前比一次：不一致 ⇒ 不把这份快照当成
     * "当前工作区的待审内容"返回（fail-closed，不渲染别的工作区的 diff）。
     * 两侧都做 canonical + compareKey，大小写/短名/尾分隔符的同一工作区不受影响。
     */
    const declared = snapshot?.workspaceRoot
    if (typeof declared === 'string' && declared.length > 0) {
      let mismatched = false
      try {
        mismatched = compareKey(canonical(declared)) !== compareKey(canonical(workspaceRoot))
      } catch {
        mismatched = true
      }
      if (mismatched) {
        return { ok: false, code: 'snapshot-workspace-mismatch', dir, detail: `declared=${declared}` }
      }
    }
    return { ok: true, dir, snapshot }
  } catch (error) {
    return { ok: false, code: 'snapshot-unreadable', dir, detail: String(error?.message ?? error) }
  }
}

/**
 * R13 修复 · D7-b/D7-d：把**两张脸**分开如实报告。
 *
 * 实测（R13 GUI 复核，`.t\r13/gui/logs/snapshot-phase2.txt`）：profile `enabled:false`
 * + 进程级 `WINSTAGE_SHELL=1` 时，**文件面（fs 暂存/候选）确实关着**、
 * 而**命令面（pwsh）确实被 shim 接管**（`stage-root\staged\...` 有产物、真实盘没有）。
 * 旧实现只有一句 `503 {"code":"disabled"}`，界面两件事都看不到 ⇒ 用户既不知道为什么没有面板，
 * 也看不出"命令面正在被环境变量强制接管"。
 *
 * 本次修复**不改语义**（`WINSTAGE_SHELL` 仍然只管命令面、不去翻 fs 面的配置值），
 * 只把两条事实分别报出来：`faces.file`（fs 面）与 `faces.shell`（命令面）。
 *
 * @param {{configEnabled?: boolean, env?: object, snapshot?: object}} options
 * @returns {{effective: boolean, configValue: boolean, source: string,
 *            shellOverride: ({value: string, forced: boolean, text: string}|null),
 *            mismatch: (object|null),
 *            faces: {file: 'on'|'off', shell: 'win-stage'|'platform', shellForcedByEnv: boolean}}}
 */
export function panelStagingFaces({ configEnabled, env = process.env, snapshot } = {}) {
  const snap = snapshot && typeof snapshot.staging === 'object' && snapshot.staging !== null ? snapshot.staging : null
  const configValue = configEnabled === true
  const effective = snap && typeof snap.effective === 'boolean' ? snap.effective : configValue
  const raw = env && env.WINSTAGE_SHELL !== undefined && env.WINSTAGE_SHELL !== null ? String(env.WINSTAGE_SHELL) : null
  const forced = raw === '1' || raw === '0'
  const shellOverride = raw === null
    ? null
    : {
        value: raw,
        forced,
        text: raw === '1' ? 'WINSTAGE_SHELL=1（强制 WinStage 接管）' : raw === '0' ? 'WINSTAGE_SHELL=0（强制交还平台 shell）' : `WINSTAGE_SHELL=${raw}`,
      }
  const shellFace = forced ? (raw === '1' ? 'win-stage' : 'platform') : configValue ? 'win-stage' : 'platform'
  return {
    effective,
    configValue,
    source: snap && typeof snap.source === 'string' ? snap.source : 'config',
    shellOverride,
    mismatch: snap && snap.mismatch && typeof snap.mismatch === 'object' ? snap.mismatch : null,
    faces: {
      file: effective === true ? 'on' : 'off',
      shell: shellFace,
      shellForcedByEnv: forced,
    },
  }
}

/**
 * 面板路由的**纯**核心：`(pathname, query) → {status, body}`（可离线断言，不起 HTTP）。
 *
 * 两条路由：
 *   · `PANEL_SNAPSHOT_PATH` → 已发布快照 + **逻辑**存储标识（路径字段一律剥掉）；
 *   · `PANEL_TRUST_PATH`    → 可信性状态卡（与 `/winstage status` 同一份 `buildTrustCard()`）。
 *
 * ⚠ 关闭态返回 `503 disabled`：面板在关闭时本来就不该看到任何暂存内容（`client.js` 的
 *   开关闸门是同一语义；这里再挡一道，免得"关掉了却仍在审批"从路由侧回来）。
 */
export function buildPanelPayload({ pathname, query, workspaceRoot, sessionId, env, isEnabled = () => true, session, now } = {}) {
  const read = (key) => {
    if (query instanceof Map) return query.get(key) ?? undefined
    if (query && typeof query.get === 'function') return query.get(key) ?? undefined
    return undefined
  }
  if (pathname !== PANEL_SNAPSHOT_PATH && pathname !== PANEL_TRUST_PATH) {
    return { status: 404, body: { ok: false, code: 'unknown-route', route: pathname } }
  }
  /**
   * ★ R12 修复 · D7-b（**R13 更正**）：路由闸门只看 `config.enabled`。
   *
   * R12 曾以为 `WINSTAGE_SHELL=1` 能让 fs 暂存面也在跑，于是加了一条"读已发布快照的
   * `staging.effective` 就放行"的分支。R13 GUI 复核实测（`.t\r13/gui/logs/snapshot-phase2.txt`）：
   * 那个前提**不成立** —— `staging-fs.stagingEnabledRaw()` 只读 loader 行 `config.enabled`，
   * 全仓只有 `cordis.patch.yml` 的 **shell 行**读 `WINSTAGE_SHELL`。因此
   * `staging.effective` 在 `enabled:false` 时恒为 false，那条"或"分支**不可达**。
   *
   * 所以闸门**保持只看配置值**（fs 面确实关着，面板就不该显示任何暂存内容——这是对的），
   * 但 503 的响应体要带上**两张脸**的状态，让界面能说清"文件面关着、命令面被环境变量接管"。
   */
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    // 根缺失是**更具体**的失败，先判它：否则"配置关 + 无根"会被报成 disabled
    if (!isEnabled()) {
      return {
        status: 503,
        body: { ok: false, code: 'disabled', route: pathname, staging: panelStagingFaces({ configEnabled: false, env }) },
      }
    }
    return { status: 500, body: { ok: false, code: 'no-workspace-root', route: pathname } }
  }
  const sid = read('session')
  /**
   * ★ R19 修复（P1·关态零影响）：**关态不得读已发布快照，更不得被它翻成开态**。
   *
   * 旧实现（R12 的 D7-b 兜底）在 `isEnabled() === false` 时先
   * `readPublishedSnapshot(...)` 探一次，只要那份**已发布**快照写着
   * `staging.effective === true` 就把 `enabled` 翻成 true ⇒ 路由返回 **200 + 上一版待审**。
   * 两个后果，都与"关闭 = 对原 harness 零影响"冲突：
   *   1. **关态仍读盘**：GUI 每轮轮询（1.5s）都会让宿主读一次 `review.json`；
   *   2. **关态仍接管面板**：上一版快照是"开关还开着时"发布的；R18 又把关态轮询改成
   *      零 IO（不再重发布）⇒ 那份 `effective:true` 的快照会**长期不更新**，于是关闭态
   *      每次都能把面板顶起来（而 `/winstage approve` 此刻是拒绝执行的 ⇒ 用户看到
   *      "关掉了却仍在审批"，按钮还必然失败）。文档承诺的是"面板路由即时 503 disabled"
   *      （`docs/插件启动-环境监测与开关保证.md` §2）。
   * R13 的结论本来就写着那条"或"分支**不可达**（fs 面的 `staging.effective` 只由
   * `config.enabled` 决定）——唯一能让它变真的是**陈旧快照**，因此这里整段删除。
   * 判据：`.t/r19-cordis/offstate-diff.ts` B1-B4（关态 503 / 不泄快照 / 有无关文件同 payload /
   * trust 同样 503）。
   */
  if (!isEnabled()) {
    // 注意：503 响应体**仍给两张脸**（R13 的信息量保留），但不读快照 ⇒ faces.file 恒 off，
    // 这正是关闭态的真实事实；命令面是否被 WINSTAGE_SHELL 强制只看 env。
    return {
      status: 503,
      body: {
        ok: false,
        code: 'disabled',
        route: pathname,
        staging: panelStagingFaces({ configEnabled: false, env }),
      },
    }
  }
  const published = readPublishedSnapshot({ workspaceRoot, sessionId: sid, env })
  const store = panelStoreIdentity(published.dir, sid)
  if (pathname === PANEL_SNAPSHOT_PATH) {
    if (!published.ok) {
      // `no-snapshot` 是**正常**的"当前没有待审"，与"读不到"必须分开
      return { status: published.code === 'no-snapshot' ? 404 : 500, body: { ok: false, code: published.code, store, detail: published.detail } }
    }
    return { status: 200, body: { ok: true, store, snapshot: published.snapshot, source: 'host-route' } }
  }
  const card = buildTrustCard({
    service: undefined,
    // 面板侧**不实例化审阅服务**（那会建目录、触发认领/自愈），所以把宿主解析出的
    // 存储根**显式**交给状态卡：①②③⑤ 四个面照样齐 —— 面板看到的与 `/winstage status`
    // 是同一份判据、同一份数据。
    storeDir: published.dir,
    session,
    // 面⑥要靠已发布快照（这里**不**写盘）
    snapshot: published.ok ? published.snapshot : undefined,
    // R41-UX-02：刷新面板不是"一次失根观测"；只读历史计数，不写 lane journal。
    recordLoss: false,
    now,
  })
  return { status: 200, body: { ok: true, store, card, source: 'host-route' } }
}

/**
 * ★ R41-SEC04：把面板查询里的 `?session=` **绑定到宿主侧真实会话**（只读校验，零文件 IO）。
 *
 * 缺陷（R34-SEC/§14 残余）：`authorizeIndex()` 只证明"这是一个持有本机浏览器签名 cookie 的
 * 页面"，**cookie 载荷里没有会话身份**（`{version,authority,issuedAt,expiresAt}`，见
 * `dsh-client-connection` 的 `BrowserAuth.authenticate()`），而快照存储根却由 query 的
 * `session` 解析。于是同源脚本/页面只要换一个 id，就能读到**另一个会话**的暂存快照。
 *
 * 最强可行绑定（不引入客户端可伪造的新凭据）：
 *   · 宿主有 `sessionQuery`（`@deepseek-ai/dsh-session-query`，`dsh-base` 提供）时，
 *     `observeSession(id)` 覆盖**实时 + 已持久化**会话（不是只有 live `sessions.get()`），
 *     返回的 `header.cwd` 是创建时校验过的绝对路径；
 *   · 要求 `canonical(header.cwd) === canonical(workspaceRoot)`：拒绝不存在的 id、
 *     拒绝别的会话/别的工作区的 id（这正是"跨工作区串台"那条）；
 *   · 服务缺失 / 没传 session id 时才退回**显式未校验**（`checked:false`）并交调用方记日志：
 *     这是宿主能力边界，不能假装已校验。
 *
 * 为什么是 async：`observeSession()` 可能读持久化后端；本函数在 `buildPanelPayload()` 之前
 * 调用（未通过校验**零快照读盘**），与 authorize 的顺序纪律一致。
 *
 * @param {{sessionQuery?: object, sessions?: object, sessionId?: string, workspaceRoot?: string}} options
 *   `sessionQuery` = 宿主会话查询服务（duck-typed：`observeSession(id)`）；
 *   `sessions` = 退回的实时会话注册表（`sessions.get(id)`），仅当没有 `sessionQuery` 时用；
 *   `sessionId` = 请求 query 里的会话 id；`workspaceRoot` = 插件配置/解析出的工作区根。
 * @returns {Promise<{ok: boolean, checked: boolean, code?: string, reason?: string, cwd?: string, source?: string}>}
 *   `ok:false` 且 `code:'session-check-unavailable'` ⇒ 调用方答 503；
 *   `ok:false` 其余 ⇒ 调用方答 403（`session-not-authorized`），且**不得**构建 payload。
 */
export async function authorizePanelSession(options = {}) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : ''
  if (sessionId.length === 0) return { ok: true, checked: false, reason: 'no-session-id', source: 'none' }
  const workspaceRoot = options.workspaceRoot
  const query = options.sessionQuery
  const sessions = options.sessions
  let cwd
  let source
  if (query && typeof query.observeSession === 'function') {
    source = 'sessionQuery'
    let observation
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'none' })
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        return { ok: false, checked: true, code: 'session-not-authorized', reason: 'session-not-found', source }
      }
      return {
        ok: false,
        checked: true,
        code: 'session-check-unavailable',
        reason: `observe-failed: ${error?.code ?? error?.name ?? error}`,
        source,
      }
    }
    cwd = observation?.header?.cwd
  } else if (sessions && typeof sessions.get === 'function') {
    source = 'sessions'
    let live
    try {
      live = sessions.get(sessionId)
    } catch (error) {
      return {
        ok: false,
        checked: true,
        code: 'session-check-unavailable',
        reason: `live-get-failed: ${error?.code ?? error?.name ?? error}`,
        source,
      }
    }
    if (!live) return { ok: false, checked: true, code: 'session-not-authorized', reason: 'session-not-found', source }
    cwd = live?.header?.cwd ?? live?.session?.header?.cwd
  } else {
    // 宿主没有会话查询能力：如实标记"未校验"，由调用方决定兼容策略（不得静默伪称已校验）
    return { ok: true, checked: false, reason: 'no-session-service', source: 'none' }
  }
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    return { ok: false, checked: true, code: 'session-not-authorized', reason: 'session-workspace-unknown', source }
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    return { ok: false, checked: true, code: 'session-not-authorized', reason: 'panel-workspace-unknown', source }
  }
  let same
  try {
    same = compareKey(canonical(cwd)) === compareKey(canonical(workspaceRoot))
  } catch (error) {
    return {
      ok: false,
      checked: true,
      code: 'session-check-unavailable',
      reason: `canonical-failed: ${error?.code ?? error?.name ?? error}`,
      source,
    }
  }
  if (!same) {
    return { ok: false, checked: true, code: 'session-not-authorized', reason: 'session-workspace-mismatch', cwd, source }
  }
  return { ok: true, checked: true, cwd, source }
}

/**
 * 造面板路由处理器（`ctx.webServer.register({kind:'prefix', path: PANEL_ROUTE_PREFIX, handler})`）。
 *
 * @param {{workspaceRoot: string, isEnabled?: Function, env?: object, sessionOf?: Function, log?: Function, authorize?: Function, sessionQueryOf?: Function, sessionsOf?: Function}} options
 *   `sessionOf(invocation)`：本路由没有 command invocation，面④需要调用方给一个"当前会话"
 *   的取法；拿不到就如实标"未知"，**不猜**。
 *   `authorize(req, res)`：**R23-A 鉴权钩子**（生产必须传）。命名前缀路由先于宿主前端静态兜底，
 *   宿主的 `Connection.authorizeIndex()` 只在兜底里执行 ⇒ 不在这里显式鉴权，本机任意进程可无
 *   token/cookie 读审阅快照。调用发生在 `buildPanelPayload()` **之前**（未鉴权零读盘）；
 *   返回 false 表示授权方已自行写完响应（401/403），本函数直接返回。
 *   `sessionQueryOf()` / `sessionsOf()`：**R41-SEC04** 每请求现读宿主会话服务（apply 期服务
 *   可能尚未 provide，故必须惰性取）。见 `authorizePanelSession()`。
 */
export function createPanelHandler(options = {}) {
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  const log = typeof options.log === 'function' ? options.log : () => {}
  return async function winStagePanelHandler(req, res) {
    /* ★ R23-A（R21-LC-01）：鉴权必须先于 payload 构建。失败/异常都 fail-closed（不构建、不泄任何
     * 快照数据）；`authorize` 缺省 = 兼容离线单测/旧装配，**生产接线在 apply() 里强制传入**
     * （tests/r23-panel-auth.ts 有静态守卫）。 */
    if (typeof options.authorize === 'function') {
      let allowed
      try {
        allowed = await options.authorize(req, res)
      } catch (error) {
        log(`面板路由鉴权失败（fail-closed，不构建 payload）：${error?.message ?? error}`)
        try {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, code: 'auth-unavailable' }))
        } catch {
          /* 响应已被授权方部分写入时不再二次写 */
        }
        return
      }
      if (!allowed) return /* 授权方已写完 401/403 响应 */
    }
    let url
    try {
      url = new URL(String(req?.url ?? '/'), 'http://localhost')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'bad-url' }))
      return
    }
    /**
     * ★ R41-SEC04：`?session=` 必须能对上宿主里的真实会话，且该会话的 cwd == 本面板工作区。
     *
     * 为什么放在 authorize 之后、payload 之前：
     *   · authorize 证明"这是本机已认证页面"；本步证明"这个 id 不是别的会话/别的工作区"；
     *   · 未通过 ⇒ **零快照读盘、零 payload 构建**（与 R23-A 同一条纪律）。
     * 关态优先：`enabled:false` 时仍回既有 `503 disabled`，不因为会话校验把语义改成 403。
     * 服务缺失（老宿主/离线单测）⇒ `checked:false` 放行 + 日志，属于宿主能力边界（文档记录）。
     */
    const requestedSessionId = url.searchParams.get('session') ?? undefined
    if (
      typeof requestedSessionId === 'string' &&
      requestedSessionId.length > 0 &&
      typeof options.workspaceRoot === 'string' &&
      options.workspaceRoot.length > 0
    ) {
      let verdict
      try {
        const sessionQuery = typeof options.sessionQueryOf === 'function' ? options.sessionQueryOf() : undefined
        const liveSessions = typeof options.sessionsOf === 'function' ? options.sessionsOf() : undefined
        verdict = await authorizePanelSession({
          sessionQuery,
          sessions: liveSessions,
          sessionId: requestedSessionId,
          workspaceRoot: options.workspaceRoot,
        })
      } catch (error) {
        verdict = { ok: false, checked: true, code: 'session-check-unavailable', reason: `session-check-threw: ${error?.message ?? error}` }
      }
      if (verdict.ok === false) {
        let enabled = true
        try {
          enabled = isEnabled() !== false
        } catch {
          enabled = true
        }
        if (enabled) {
          const status = verdict.code === 'session-check-unavailable' ? 503 : 403
          log(`面板会话校验拒绝（${verdict.reason ?? verdict.code}）：session=${maskSessionId(requestedSessionId) || '(none)'} route=${url.pathname}`)
          try {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: false, code: verdict.code ?? 'session-not-authorized', reason: verdict.reason, route: url.pathname }))
          } catch {
            /* 响应已被写者占用时不再二次写 */
          }
          return
        }
      }
    }
    let session
    try {
      session = typeof options.sessionOf === 'function' ? options.sessionOf() : undefined
    } catch {
      session = undefined
    }
    const payload = buildPanelPayload({
      pathname: url.pathname,
      query: url.searchParams,
      workspaceRoot: options.workspaceRoot,
      sessionId: url.searchParams.get('session') ?? undefined,
      env: options.env,
      isEnabled,
      session,
    })
    try {
      res.writeHead(payload.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload.body))
    } catch (error) {
      log(`面板路由写响应失败：${error?.message ?? error}`)
    }
  }
}


/**
 * 注册 `/winstage` 命令族。
 *
 * 命令处理器**不产生模型消息**，且在接收 agent 的会话日志里留下 `command/run` /
 * `command/done` 这对审计事件（`dsh-commands` 的既定行为），因此"谁在什么时候批准了
 * 哪些文件"是可回溯的。
 */
/**
 * @param scope 命令注册作用域
 * @param {object | ((invocation: object) => object)} serviceOrResolver
 *   审阅服务对象，或"按本次调用解析服务"的函数 —— 生产用后者（**审批内容按会话隔离**）。
 */
export function registerCommands(scope, serviceOrResolver, log, options = {}) {
  /**
   * 命令面与开关**解耦**：命令始终注册（关掉再打开时 apply 不会重跑，只有"始终
   * 注册 + 执行时现读"才能让命令面回来），但每次执行都按当前开关决定是否放行。
   */
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  /** 服务解析：老调用方传对象（自测），生产传 `(invocation) => service` */
  const serviceOf = typeof serviceOrResolver === 'function' ? serviceOrResolver : () => serviceOrResolver
  const DISABLED_TEXT =
    'WinStage 沙箱已在设置中关闭：暂存与审阅面未接管（写入走平台沙箱/审批模式），命令不会执行。'
  /**
   * R34-E2E-02（P2）：`/winstage` 命令面此前把 `StageGuardUnavailableError` 的原始
   * message 直接回显（`the protected session directory could not be established
   * (root-not-creatable:EPERM)`）—— 违反"用户可见文本不暴露机制/不可行动"的透明性约束。
   * 统一成一句可行动的普通说明；细节只进 `log.warn`。写入/读取的 FsError 已有
   * `mapStageFailure()` 的普通文案，这里只兜住命令面直接抛出的两个 stage 错误码。
   */
  const STAGE_UNAVAILABLE_TEXT =
    'WinStage 暂存不可用：本宿主无法建立暂存根（受限会话或权限不足），本次命令未执行，真实工作区未被改动。请在未受限的宿主里使用，或在设置中关闭 WinStage 后改用平台沙箱/审批。'
  const commandFailureText = (prefix, error) => {
    const code = error?.code
    if (code === 'STAGE_GUARD_UNAVAILABLE' || code === 'STAGE_ROOT_LOST') return `${prefix}${STAGE_UNAVAILABLE_TEXT}`
    return `${prefix}${error?.message ?? error}`
  }

  const handlers = {
    list({ service }) {
      return { kind: 'success', text: formatList(service) }
    },
    /**
     * `/winstage undo [--list] [recordId]` —— **R46：撤销最近一次已保存的 apply**。
     *
     * 只覆盖文件面（注册表候选不在这条链上，如实写在文案里）。撤销前做整批并发预检：
     * 任一文件在保存后被外部改过 ⇒ `conflict` + **零写**；全部成功才把记录归档。
     */
    undo({ args, service }) {
      const { flags, names, unknown } = splitCommandFlags(args, new Set(['--list']))
      if (unknown.length > 0) return { kind: 'error', text: `undo 不接受开关：${unknown.join(' ')}` }
      if (flags.has('--list')) {
        const records = service.workspace.listUndoable()
        if (records.length === 0) {
          return { kind: 'success', text: '没有可撤销的已保存记录（撤销只覆盖文件面；注册表候选不在此列）。' }
        }
        const lines = [`可撤销的已保存记录  ${records.length} 份（新→旧）：`]
        for (const record of records) {
          lines.push(
            record.ok
              ? `  · ${record.id}  ${record.createdAt ?? '?'}  文件 ${record.files ?? '?'} 个  candidate=${record.candidateId ?? '?'}`
              : `  · ${record.id}  ⚠ 记录损坏（${record.error}）—— 不会用于撤销`,
          )
        }
        lines.push('用法：/winstage undo [recordId]（省略 id = 最近一份）')
        return { kind: 'success', text: lines.join('\n') }
      }
      const requested = names.length > 0 ? names[0] : undefined
      const result = service.workspace.undoApply(requested, {})
      const status = result?.status
      if (status === 'undone') {
        const lines = [`已撤销保存 ${result.id}（candidate=${result.candidateId ?? '?'}）：恢复 ${result.restored.length} 个文件。`]
        for (const item of result.restored) lines.push(`  ↺ ${item.path}（${item.action}）`)
        lines.push('真实工作区已回到保存前；该记录已归档（不再出现在 --list 的可撤销项里）。')
        return { kind: 'success', text: lines.join('\n') }
      }
      if (status === 'already-undone') {
        return { kind: 'success', text: `无需撤销 ${result.id}：这些文件已经是保存前状态（幂等）。` }
      }
      if (status === 'conflict') {
        const lines = [
          `拒绝撤销 ${result.id}：有 ${result.conflicts.length} 个文件在保存后被改过，**一个字节都没有写**。`,
          '冲突明细：',
        ]
        for (const conflict of result.conflicts) lines.push(`  · ${conflict.path}: ${conflict.code} — ${conflict.message}`)
        lines.push('下一步：先备份/处理这些文件，或手工恢复；本功能绝不覆盖保存后的新改动。')
        return { kind: 'error', text: lines.join('\n') }
      }
      if (status === 'partial') {
        const lines = [`撤销 ${result.id} 只完成一部分（${result.restored.length} 成功 / ${result.failed.length} 失败）：`]
        for (const item of result.failed) lines.push(`  · ${item.path}: ${item.code} — ${item.message}`)
        lines.push('记录保留在可撤销列表里；失败项未恢复，请按上面原因处理。')
        return { kind: 'error', text: lines.join('\n') }
      }
      if (status === 'locked') {
        return { kind: 'error', text: `撤销暂时不可用：另一笔应用/撤销正在进行（${result.failed?.[0]?.code ?? 'APPLY_LOCK_BUSY'}），请稍后重试。` }
      }
      if (status === 'not-found') {
        return { kind: 'error', text: `找不到可撤销记录 ${requested ?? '（最近一份）'}；用 /winstage undo --list 查看。` }
      }
      if (status === 'corrupt') {
        return { kind: 'error', text: `撤销记录损坏（${result.error}）；拒绝用不可信快照覆盖真实文件。` }
      }
      if (status === 'session-mismatch') {
        return { kind: 'error', text: `撤销记录属于另一个会话（record=${result.recordSession}，current=${result.currentSession}），拒绝跨会话恢复。` }
      }
      return { kind: 'error', text: `撤销失败：未知状态 ${status ?? '(none)'}` }
    },
    /**
     * `/winstage status`（含 `winstage-status`）：暂存清单 + **WP3 可信性状态卡**。
     *
     * 状态卡把六个面合并成一张（档位 / 首次掉档 / 失根 / 未结算审批 / 未确认写入 /
     * 读侧可见性），机读字段与人读结论同源。**只在用户侧**：命令文本 + 面板路由；
     * 命令自身的 stdout/stderr 与工具输出一个字节都不变（下面的 `text` 只回到命令面）。
     */
    status(context) {
      const service = context?.service
      // 一次构建、两处复用：清单与卡片共用**同一份**快照（避免 publish 跑两遍、时间戳分叉）
      let snapshot
      if (service && typeof service.snapshot === 'function') {
        try {
          snapshot = service.snapshot()
        } catch (error) {
          log.warn(`/winstage 快照读取失败：${error?.message ?? error}`)
          return { kind: 'error', text: commandFailureText('读取暂存快照失败：', error) }
        }
      }
      const listed = snapshot
        ? { kind: 'success', text: formatList(service, snapshot) }
        : handlers.list(context)
      const card = buildTrustCard({
        service,
        // 面④要读会话事件（`approval/asked` 有没有配对）。命令面拿得到 agent/session，
        // 拿不到就如实标"未知"——**不猜**。
        session: context?.invocation?.agent?.session,
        snapshot,
      })
      // 最危险的档位（掉档/失根）必须显眼：命令面用 error 级
      const alarming = card.trust.level === 'lost' || card.trust.level === 'degraded'
      return {
        kind: alarming ? 'error' : listed.kind,
        text: `${listed.text}\n\n${formatTrustCard(card)}`,
      }
    },
    refresh({ service }) {
      const snapshot = service.publish()
      return { kind: 'success', text: `已刷新审阅快照：${snapshot.counts.files} 个待审文件` }
    },
    rebase({ args, service }) {
      // R34（CLI-hunter U-03）：未知路径不得静默 success。先按与 approve 同一套
      // "精确 / 唯一 basename / 歧义"匹配，再交给 service.rebase（拿到的都是确定路径）。
      const { names, unknown } = splitCommandFlags(args, new Set())
      if (unknown.length > 0) return { kind: 'error', text: `rebase 不接受开关：${unknown.join(' ')}` }
      let requested
      if (names.length > 0) {
        const changes = service.reload().diffEntries()
        const matched = matchPathsDetailed(changes, names)
        if (matched.ambiguous.length > 0) {
          return {
            kind: 'error',
            text:
              '路径有歧义，整批未 rebase（请写成相对工作区的完整路径）：\n' +
              matched.ambiguous.map((item) => `  · ${item.arg} ⇒ ${item.paths.join(' | ')}`).join('\n'),
          }
        }
        if (matched.matches.length === 0) {
          return { kind: 'error', text: `没有匹配的待审路径：${names.join(' ')}（rebase 只对齐当前净 diff 中的条目）` }
        }
        requested = matched.matches.map((change) => change.path)
      }
      const result = service.rebase(requested)
      const lines = [result.message]
      for (const path of result.rebased) lines.push(`  ↻ ${path}`)
      if (result.rebased.length > 0) lines.push(`  现在可批准 ${result.remaining} 项（/winstage list 查看）`)
      // S13/S14：rebase 也走候选对账 ⇒ 没清干净必须响（不能再"success 但其实没清掉"）
      const failures = Array.isArray(result.failures) ? result.failures : []
      if (failures.length > 0) {
        lines.push(`  ⚠ 有 ${failures.length} 项清理失败（没清干净）：`)
        for (const failure of failures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
        return { kind: 'error', text: lines.join('\n') }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
    diff({ args, service }) {
      return { kind: 'success', text: formatDiff(service, args) }
    },
    approve({ args, service }) {
      // 开关：`--rebase` = 先把基线过期的条目对齐到真实文件再批准；
      //       `--force`  = 跳过 #12.1 的基线检查直接覆盖（更危险，两者可并用）。
      // R34：`--` 之后一律当路径；未知开关报错（不再把 `--force` 文件名当开关）。
      const { flags, names, unknown } = splitCommandFlags(args, new Set(['--rebase', '--force', '--confirm-mask']))
      if (unknown.length > 0) {
        return { kind: 'error', text: `未知开关：${unknown.join(' ')}；可用：--rebase、--force、--confirm-mask（名为 --xxx 的文件请写成：/winstage approve -- --xxx）` }
      }
      const ws = service.reload()
      const changes = ws.diffEntries()
      if (changes.length === 0) {
        // S9（§7.3）：净 diff 为空、但队列里还有候选，**不是**"没有待审文件" ——
        // 用户按下唯一的按钮却拿到 success + 什么都没有，这正是"点了没反应"。
        const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
        const frozen = live.reduce((n, c) => n + (c.changes || []).length, 0)
        if (live.length > 0) {
          return {
            kind: 'error',
            text: `没有可批准的净变化：队列里还有 ${live.length} 份候选（共 ${frozen} 条冻结路径）已不在净 diff，属"仅存档、不可批准"。用 /winstage reject 清除它们，或 /winstage rebase 重新对齐基线。`,
          }
        }
        return { kind: 'success', text: '没有待审文件' }
      }
      const matched = matchPathsDetailed(changes, names)
      if (matched.ambiguous.length > 0) {
        return {
          kind: 'error',
          text:
            '路径有歧义，整批未批准（请写成相对工作区的完整路径）：\n' +
            matched.ambiguous.map((item) => `  · ${item.arg} ⇒ ${item.paths.join(' | ')}`).join('\n'),
        }
      }
      const paths = names.length > 0 ? matched.matches.map((c) => c.path) : undefined
      if (names.length > 0 && paths.length === 0) {
        return { kind: 'error', text: `没有匹配的待审路径：${names.join(' ')}` }
      }
      const result = service.approve(paths, {
        rebase: flags.has('--rebase'),
        force: flags.has('--force'),
        // `--confirm-mask` = 用户已经看到过后果并确认。给了路径就确认这些路径；
        // "批准全部"没给路径 ⇒ `true`（确认本次全部遮蔽项）。
        ...(flags.has('--confirm-mask') ? { confirmedMasks: paths && paths.length > 0 ? paths : true } : {}),
      })
      const lines = [result.message]
      if (result.rebased?.length) lines.push(`  已先以真实文件为基线重新暂存：${result.rebased.join(', ')}`)
      // S13/S14：`approve --rebase` 的候选对账失败也必须响
      const clearFailures = Array.isArray(result.failures) ? result.failures : []
      if (clearFailures.length > 0) {
        lines.push(`  ⚠ 有 ${clearFailures.length} 项清理失败（没清干净）：`)
        for (const failure of clearFailures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
      }
      for (const failure of result.failed) {
        lines.push(`  ✗ ${failure.path}: ${failure.code} — ${failure.message}`)
      }
      if (result.remaining?.length) lines.push(`  仍在待审：${result.remaining.join(', ')}`)
      if (result.failed.some((f) => f.code === 'STALE_BASELINE')) {
        lines.push('  说明：真实文件在暂存之后被外部改动过，因此默认拒绝覆盖（手册 #12.1）。')
        // ★ 缺陷②（F5b）：把**形状**说清。`baseline-appeared`（基线本为"不存在"、
        //   真实文件在暂存之后出现）是实测那条"点批准就静默丢掉磁盘内容"的形状；
        //   光说"基线已过期"用户不知道磁盘上已经有东西了。
        const shapes = [...new Set(result.failed.filter((f) => f.code === 'STALE_BASELINE').map((f) => staleShapeText(f.baselineStaleCode ?? f.driftReason)))]
          .filter((text) => text.length > 0)
        if (shapes.length > 0) lines.push(`  形状：${shapes.join('；')}。真实磁盘上的那份内容**没有被覆盖**。`)
        lines.push('  处理：/winstage rebase [路径…] 以真实文件为基线重新暂存（之后面板会显示 before/after，你确认的就是将要替换的内容）；或 /winstage approve --rebase [路径…] 一步完成；不想要这份暂存就 /winstage reject [路径…]。')
      }
      // "批准了 0 项、也没失败"同样是**静默无效**（面板上看就是"点了没反应"）：
      // 显式回报成 error，让 UI 把原因显示出来。
      if (result.approved === 0 && result.failed.length === 0) {
        lines.push('  没有条目被应用：选中的路径不在最新候选里（可能已被后来的写入取代）。')
        lines.push('  处理：/winstage refresh 重新发布快照后重试。')
        return { kind: 'error', text: lines.join('\n') }
      }
      if (clearFailures.length > 0) return { kind: 'error', text: lines.join('\n') }
      const needConfirm = result.failed.filter((f) => f.code === 'SANDBOX_PATH_MASKED_CONFIRM')
      if (needConfirm.length > 0) {
        // **不是硬拒**：说清后果，确认后即可落盘（面板上是一次弹窗确认）
        lines.push('  需要二次确认（本次**未**写入）：以下路径命中敏感策略，批准会把暂存内容写到真实磁盘且不可撤销。')
        for (const failure of needConfirm) {
          lines.push(`    · ${failure.path} — ${failure.message}${failure.hard ? '［沙箱自身存储·强警告］' : ''}`)
        }
        lines.push(
          `  确认后重发：/winstage approve --confirm-mask ${needConfirm.map((f) => `"${f.path}"`).join(' ')}`,
        )
      }
      return { kind: result.ok ? 'success' : 'error', text: lines.join('\n') }
    },
    reject({ args, service }) {
      const ws = service.reload()
      const changes = ws.diffEntries()
      // ★ P0-2：**不能**因净 diff 为空就早退。队列里可能只剩"仅存档 / 空壳"候选，而
      //   「拒绝全部」是用户唯一能清掉它们的出口（`review-service.reject()` 的清理分支
      //   已经能在净 diff 为空时终结它们）。早退的实测后果：
      //   「拒绝全部」返回 success 而 `review.json` 的 `pending` 仍为 true ⇒ 条目永久留存。
      const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
      if (changes.length === 0 && live.length === 0) return { kind: 'success', text: '没有待审文件' }
      // R34：与 approve 同一套严格路径解析（`--` 转义、basename 歧义整批拒绝）。
      const { names, unknown } = splitCommandFlags(args, new Set())
      if (unknown.length > 0) return { kind: 'error', text: `reject 不接受开关：${unknown.join(' ')}` }
      const matched = matchPathsDetailed(changes, names)
      if (matched.ambiguous.length > 0) {
        return {
          kind: 'error',
          text:
            '路径有歧义，整批未拒绝（请写成相对工作区的完整路径）：\n' +
            matched.ambiguous.map((item) => `  · ${item.arg} ⇒ ${item.paths.join(' | ')}`).join('\n'),
        }
      }
      const paths = names.length > 0 ? matched.matches.map((c) => c.path) : undefined
      if (names.length > 0 && paths.length === 0) {
        return {
          kind: 'error',
          text: `没有匹配的待审路径：${names.join(' ')}（若它只是"仅存档行"，请用不带路径的 /winstage reject 清除）`,
        }
      }
      const result = service.reject(paths)
      const discarded = Array.isArray(result.discarded) ? result.discarded : []
      const clearFailures = Array.isArray(result.failures) ? result.failures : []
      // S13/S14：清除路径上的失败必须响 —— 不许"返回 success 但其实什么都没清掉"
      if (result.rejected === 0 && discarded.length === 0 && clearFailures.length === 0) {
        return {
          kind: 'error',
          text: `没有任何条目被清掉：${result.message ?? '所选路径既不在净 diff、也没有对应的活候选。'}`,
        }
      }
      const lines = [
        `已退回 ${result.rejected} 个文件：${result.paths.join(', ') || '（无净 diff 条目）'}` +
          `${discarded.length > 0 ? `；已终结 ${discarded.length} 个候选` : ''}（真实工作区未被改动）`,
      ]
      if (clearFailures.length > 0) {
        lines.push(`  ⚠ 有 ${clearFailures.length} 项清理失败（没清干净）：`)
        for (const failure of clearFailures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
        return { kind: 'error', text: lines.join('\n') }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  const registered = []
  // 命令规格：`sub === null` 表示伞形命令（第一个词是子命令），
  // 其余命令把整个 rawInput 当作参数列表。
  const SPECS = [
    { name: 'winstage', sub: null, description: '查看 WinStage 暂存待审文件（/winstage list|diff|approve|reject|rebase|refresh|undo）' },
    { name: 'winstage-status', sub: 'status', description: 'WinStage 暂存：查看待审清单' },
    { name: 'winstage-refresh', sub: 'refresh', description: 'WinStage 暂存：重新发布审阅快照' },
    { name: 'winstage-rebase', sub: 'rebase', description: 'WinStage 暂存：以真实文件为基线重新暂存（基线过期时）' },
    { name: 'winstage-diff', sub: 'diff', description: 'WinStage 暂存：显示改动（可给路径，空格用引号包住）' },
    { name: 'winstage-approve', sub: 'approve', description: 'WinStage 暂存：把改动写入真实工作区（可给路径）' },
    { name: 'winstage-reject', sub: 'reject', description: 'WinStage 暂存：把改动退回真实磁盘（可给路径）' },
  ]

  for (const spec of SPECS) {
    // ★ Cordis 卸载协议：`scope.commands.register()` 的**返回值就是 disposer**，
    //   旧实现把它 push 进 `registered` 后只取 `.length` 就丢弃（host-plugin 调用处），
    //   于是"卸载后 7 条命令仍在"没有归 cordis 持有的清理路径。这里显式交给 `scope.effect()`
    //   （同仓 `plugin/commands.ts:173` 已经是这个写法，两条注册路径口径此前不一致）。
    const registerOnce = () =>
      scope.commands.register({
        definitionId: `winstage-sandbox/${spec.name}`,
        name: spec.name,
        description: spec.description,
        // ⚠ 字段名必须是 `hint`，不能用 `placeholder`：
        // `dsh-commands/lib/index.js:154-163 normalizeDefinition()` 在 `input` 存在时
        // 要求 `"hint" in input && typeof input.hint === "string"`，否则抛
        // `TypeError: command "<name>" input hint must be a string`。
        // 该异常会让整个 `ctx.inject(['commands'], …)` 回调失败 ⇒ **线上 0 条命令注册**，
        // 而进程内直接调 `registerCommands()`（绕过该校验）会「看起来注册了 6 条」。
        input: { hint: '文件路径（可省略；含空格时用双引号）' },
        handler: (invocation) => {
          try {
            if (!isEnabled()) return { kind: 'error', text: DISABLED_TEXT }
            // **按会话解析**：命令在哪条会话里点的，就只动那条会话的暂存
            const service = serviceOf(invocation)
            const raw = String(invocation?.rawInput ?? '')
            let sub
            let args
            if (spec.sub === null) {
              const parsed = parseInvocation(raw)
              sub = parsed.subcommand
              args = parsed.args
            } else {
              sub = spec.sub
              args = splitArgs(raw)
            }
            const handler = handlers[sub]
            if (!handler) {
              return {
                kind: 'error',
                text: `未知子命令 "${sub}"；可用：list、status、diff、approve、reject、rebase、refresh、undo`,
              }
            }
            return handler({ args, invocation, raw, service })
          } catch (error) {
            log.warn(`/${spec.name} 失败：${error?.message ?? error}`)
            return { kind: 'error', text: commandFailureText(`/${spec.name} 失败：`, error) }
          }
        },
      })
    const disposer = registerOnce()
    if (typeof scope?.effect === 'function') {
      scope.effect(
        () => (typeof disposer === 'function' ? disposer : () => {}),
        `winstage-sandbox: command ${spec.name}`,
      )
    }
    registered.push(disposer)
  }
  return registered
}

// ==================== 运行后捕获（post-run capture） ====================

/**
 * 装配"运行后捕获" —— **默认关闭**，靠环境变量显式打开。
 *
 * ── 为什么走环境变量而不是 Config 字段 ──────────────────────────────────────
 * `schema.js` 的字段清单被既有断言钉死为 4 个
 * （`.t/dsh2/fix-asserts/p06-config-projection.ts:56`），且设置页投影对 volatile
 * 嵌套极其敏感（P0-6 曾整份投影失败）。**加字段是一次独立的契约变更**，要连断言一起改，
 * 不该混进本增量。仓库已有先例：`fs-entry.ts` 的 `WINSTAGE_STAGE_OUTSIDE`。
 *
 * ── 它补的是哪一段空白 ──────────────────────────────────────────────────────
 * `bash` / `pwsh` 的写入不经过 `ctx.fs`（`staging-fs.ts` 文件头第 30 行自认），
 * 因此过去**直接落真实主机、不进暂存**：命令改了宿主，审阅面板却空着。这里用 DSH 的一等
 * 钩子把这段接进来（出处：`dsh-tools/lib/index.js:3225` / `:3504`）：
 *
 *   `tools/pre-execute`  → 执行前在真实主机上取**内容镜像**（before 的唯一权威来源）
 *   `tools/post-execute` → 执行后比对、落暂存、冻结候选、**把主机还原成执行前**
 *
 * 于是"写入在沙箱内成功"（工具调用成功、主机不动）与"改动进待审"同时成立。
 *
 * ── 失败必须响（C2）────────────────────────────────────────────────────────
 * 取镜像失败、落暂存失败、还原失败一律走 **error 级**日志；绝不假装成功、绝不吞异常。
 * `capture()` 自己也不抛（失败进 `failures`），这里的 try/catch 是第二道兜底。
 *
 * @param {object} ctx cordis 上下文（需要 `ctx.on`）
 * @param {{workspaceRoot: string, serviceFor: Function, log?: Function, logError?: Function, env?: object}} options
 * @returns {{enabled: boolean, tools: string[], restore?: boolean, reason?: string}}
 */
export function installRunCapture(ctx, options = {}) {
  const { workspaceRoot, serviceFor, log = () => {}, logError = () => {}, env = process.env } = options

  if (env.WINSTAGE_CAPTURE !== '1') {
    log('运行后捕获：未启用（设 WINSTAGE_CAPTURE=1 打开）。')
    return { enabled: false, tools: [] }
  }
  if (typeof ctx?.on !== 'function') {
    // 没有事件总线 = 钩子挂不上。**必须响**，不能"看起来装上了其实没装"。
    logError('运行后捕获：本 ctx 没有事件总线（ctx.on 缺失），捕获面**未**装配。')
    return { enabled: false, tools: [], reason: 'no-event-bus' }
  }

  const tools = new Set(
    String(env.WINSTAGE_CAPTURE_TOOLS || 'pwsh,bash')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
  const restore = env.WINSTAGE_CAPTURE_RESTORE !== '0'
  const exclude = String(env.WINSTAGE_CAPTURE_EXCLUDE || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const maxFileBytes = Number(env.WINSTAGE_CAPTURE_MAX_BYTES || '') || undefined
  const maxFiles = Number(env.WINSTAGE_CAPTURE_MAX_FILES || '') || undefined

  /** 未结算的执行前快照：key → {before, name}。只在 pre 与 post 之间存活。 */
  const pending = new Map()
  const callKey = (exec) =>
    (typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : `${exec?.name}@${exec?.agent?.session?.id ?? 'nosession'}`)

  /**
   * 本次调用所属会话的捕获实例。
   *
   * 为什么每次都新建：`ReviewService.reload()` 会把 `service.workspace` **换成新对象**
   * （`review-service.ts` 的 `reloaded()` 就是 `service.reload(); return service.workspace`），
   * 缓存旧实例会让捕获写进一个已经被替换掉的 Workspace。
   */
  const captureFor = (exec) => {
    const service = serviceFor?.({ agent: exec?.agent })
    if (!service) {
      logError(`运行后捕获：按会话解析暂存服务失败（tool=${exec?.name}），本次不捕获。`)
      return undefined
    }
    try {
      service.reload?.()
    } catch (error) {
      logError(`运行后捕获：reload 暂存清单失败（${error?.message ?? error}），仍按当前实例继续。`)
    }
    const workspace = service.workspace
    if (!workspace?.store) {
      logError(`运行后捕获：暂存服务没有 Workspace/Store（tool=${exec?.name}），本次不捕获。`)
      return undefined
    }
    return createRunCapture({
      workspaceRoot,
      store: workspace.store,
      workspace,
      log: (message, level) => (level === 'error' ? logError(message) : log(message)),
      ...(exclude.length > 0 ? { exclude } : {}),
      ...(maxFileBytes ? { maxFileBytes } : {}),
      ...(maxFiles ? { maxFiles } : {}),
    })
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    // 被拒 / 等审批 ⇒ 工具体不会跑，没有可捕获的东西（也就不能留下悬空的 before）
    if (decision?.kind !== 'allow') return decision
    if (!tools.has(exec?.name)) return decision
    const key = callKey(exec)
    try {
      const cap = captureFor(exec)
      if (cap) {
        // ⚠ 必须是 `prime()`，**不是** `snapshot()`。
        // `snapshot()` 只走元数据（`run-capture.ts:426-436`）：不读内容、不落 before blob、
        // 不写 `capture-mirror.json`。用它取"执行前镜像"，执行后每条变化都会命中
        // "该路径不在执行前镜像里，无法还原（未调用 materializeBlob）" ⇒ **主机根本回滚不了**，
        // 整个"写入在沙箱内成功"的前提落空。
        // 这条不是推理：`.t/wiring-selftest.ts` 的 W1/W2 就是这么红的，改回 prime() 才转绿。
        const primed = await cap.prime()
        pending.set(key, {
          before: primed?.before,
          name: exec.name,
          // prime 阶段**读失败**的路径 = "执行前是什么"未知。把它交给 capture()，
          // 让那些路径**不参与**删除式还原（否则"读不到"会被当成"执行前不存在"而删掉真文件）。
          unknownPaths: (Array.isArray(primed?.skipped) ? primed.skipped : [])
            .map((entry) => entry?.path)
            .filter(Boolean),
        })
        log(`运行后捕获：已取执行前镜像（${exec.name}，${primed?.files ?? 0} 个文件 / ${primed?.bytes ?? 0} 字节）。`)
      }
    } catch (error) {
      logError(`运行后捕获：执行前取镜像失败（${exec?.name}）：${error?.message ?? error}`)
    }
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const key = callKey(exec)
    const record = pending.get(key)
    if (!record) return decision
    pending.delete(key)
    /** 需要"响"到模型/用户面前的失败（不只是日志） */
    const surfaced = []
    try {
      const cap = captureFor(exec)
      if (!cap) return decision
      const report = await cap.capture(record.before, { restore, unknownPaths: record.unknownPaths })
      const failures = Array.isArray(report?.failures) ? report.failures : []
      const staged = report?.staged ?? 0
      if (staged > 0 || failures.length > 0) {
        log(
          `运行后捕获：${record.name} 净变化 ${report?.changes?.length ?? 0} 条、` +
            `落暂存 ${staged} 条、还原 ${report?.restored ?? 0} 条、失败 ${failures.length} 条。`,
        )
      }
      for (const failure of failures) {
        const line = `运行后捕获失败[${failure?.phase ?? '?'}] ${failure?.path ?? '?'}：${failure?.message ?? '（无消息）'}`
        logError(line)
        surfaced.push(`- ${line}`)
      }
    } catch (error) {
      const line = `运行后捕获：执行后捕获抛错（${exec?.name}）：${error?.message ?? error}`
      logError(line)
      surfaced.push(`- ${line}`)
    }
    if (surfaced.length === 0) return decision
    // ── 失败必须**响** ──────────────────────────────────────────────────────
    // 光有 error 级日志不够：本仓库反复栽在"静默失效"上，而"主机其实没回滚"这件事
    // 恰恰是**用户最需要当场知道**的。所以除了日志，还要把它随**工具结果**回给模型。
    // 契约（`dsh-tools/lib/types/index.d.ts:465-479`）：`accept` 可以带 `content`。
    // `content` 与 `value` 互斥，且我们**不替换**下游内容、只追加一块，避免弄坏别人的输出。
    if (decision?.kind === 'accept' && Array.isArray(decision.content)) {
      return {
        ...decision,
        content: [
          ...decision.content,
          {
            type: 'text',
            text:
              `[WinStage 运行后捕获] ${record.name}：有 ${surfaced.length} 处**没有**按预期处理完，` +
              '真实主机上可能仍保留着命令写入的内容。\n' +
              `${surfaced.join('\n')}\n` +
              '请不要把未列出的部分当成已被回滚；已捕获的改动仍可以在 WinStage 面板上批准。',
          },
        ],
      }
    }
    logError(
      '运行后捕获：该工具的返回不是 content 形态（`accept.value` 与 `content` 互斥），' +
        '失败明细只能留在 error 级日志里，无法随结果回给模型。',
    )
    return decision
  })

  log(`运行后捕获：已启用；工具=${[...tools].join(',')}；还原=${restore ? '开' : '关'}。`)
  return { enabled: true, tools: [...tools], restore }
}

// ==================== 插件入口 ====================

/**
 * 从 **loader 行表**读设置开关（`id: winstage-sandbox` 行的 `config.enabled`）。
 *
 * 这是本插件"开关唯一真源"的**行表读法**，与 `staging-fs.ts::stagingEnabledRaw()` 逐条同义
 * （那边读 `rootEntry.parent.data`）：
 *   · 行表是 patch 组合后的那份（bundle 默认 + profile 覆盖层）；设置页改动经
 *     configEditor → reconcileProfilePatches → `EntryGroup.update()` **把整份 data 换新**
 *     （group 对象不变）⇒ 每次现读都能看到最新值；
 *   · 找不到该行/没有 config ⇒ `true`（维持历史"接管"行为，与 fs 面一致）；
 *   · 传入的 rows 不是数组（离线自测 / 非 cordis ctx）⇒ `undefined`，调用方回退到 apply 参数。
 *
 * 为什么不能读 apply 参数：部署入口 `plugin/index.ts` 的 `normalizeConfig()` 把 volatile
 * 引用解成普通布尔**快照一次**，而 cordis 的 volatile 更新只原地刷新引用、不重跑 apply
 * ⇒ 闭包里的布尔永远是启动值（R17 审计实测，见 `apply()` 内 `isEnabled` 的注释）。
 *
 * @param {unknown} rows `ctx.fiber.entry.parent.data`
 * @returns {boolean|undefined}
 */
export function switchEnabledFromRows(rows) {
  if (!Array.isArray(rows)) return undefined
  const row = rows.find((item) => item && item.id === 'winstage-sandbox')
  if (!row) return undefined
  if (!row.config || typeof row.config !== 'object') return true
  return row.config.enabled !== false
}

/**
 * host 行 config `masks: string[]` → `Workspace.masks`（`extraMasks`）规则对象（R24-A2）。
 *
 * ── 语义 ────────────────────────────────────────────────────────────────────
 *   · 默认/`undefined`/`[]` ⇒ `[]`（**不改变任何行为**：值级档仍不可达，内置危险类仍走
 *     R17 的"整份省略"）；
 *   · 每一项是**正则字符串**：既支持 `new RegExp` 源码串（如 `\\\\.npmrc$`），
 *     也支持字面量写法 `/\\\\.npmrc$/i`；编译为 `{id, pattern, reason, hard:false}`。
 *     `hard:false` 是刻意的：config mask 属于"调用方责任的窄规则"，走 **sensitive/risk**
 *     （值级 `<REDACTED len=N>`），不能被抬成 danger 档的"整份省略"；
 *   · **非法配置 ⇒ fail-closed**：空串/非字符串/非法正则全部收集后**抛错**
 *     （`code = WINSTAGE_CONFIG_MASKS_INVALID`），并在抛之前先 `logError` 一条。
 *
 * ── 取舍：为什么是"apply 抛错使 host 行不装配"而不是"跳过坏条目继续跑" ──────────
 *   · 静默跳过 = 用户显式配了规则却实际没生效，而面板上"没有掩码"读起来像"没有敏感内容"；
 *   · 只跳过坏条目、保留好条目 = 半套规则生效，用户无法从界面判断哪几条在跑；
 *   · 抛错 = 启动期就失败、错误文案里逐条点名哪一项非法（含 index），配置可修。
 *   与 R19 环境门同一条纪律："显式配置了却不可用时，宁可拒绝启动，也不静默降级"。
 *
 * @param {unknown} raw config.masks
 * @param {{logError?: (msg: string) => void}} [options] 抛错前的 error 级日志通道
 * @returns {Array<{id:string, pattern:RegExp, reason:string, hard:boolean}>}
 */
export function compileConfiguredMasks(raw, options = {}) {
  const logError = typeof options.logError === 'function' ? options.logError : () => {}
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    const message = `WinStage 配置 masks 非法（fail-closed，拒绝装配）：应为正则字符串数组，实际是 ${typeof raw}`
    try {
      logError(message)
    } catch {
      /* best effort */
    }
    const error = new Error(message)
    error.code = 'WINSTAGE_CONFIG_MASKS_INVALID'
    error.problems = [message]
    throw error
  }
  const rules = []
  const problems = []
  raw.forEach((entry, index) => {
    if (entry instanceof RegExp) {
      // 自测/程序化调用可直接给 RegExp；生产 config 走字符串分支。
      rules.push({ id: `config-mask-${index + 1}`, pattern: entry, reason: `host config masks[${index}]`, hard: false })
      return
    }
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      problems.push(`#${index + 1}: 不是非空正则字符串（实际 ${JSON.stringify(entry)}）`)
      return
    }
    const text = entry.trim()
    let pattern
    try {
      // `/pattern/flags` 字面量写法（允许 flags：i / m / s / u / g）
      const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(text)
      pattern = literal ? new RegExp(literal[1], literal[2]) : new RegExp(text)
    } catch (error) {
      problems.push(`#${index + 1}: 非法正则 ${JSON.stringify(text)}（${error?.message ?? error}）`)
      return
    }
    rules.push({
      id: `config-mask-${index + 1}`,
      pattern,
      reason: `host config masks[${index}]（调用方责任的自定义窄规则）`,
      hard: false,
    })
  })
  if (problems.length > 0) {
    const message = `WinStage 配置 masks 非法（fail-closed，拒绝装配）：${problems.join('；')}`
    try {
      logError(message)
    } catch {
      /* best effort */
    }
    const error = new Error(message)
    error.code = 'WINSTAGE_CONFIG_MASKS_INVALID'
    error.problems = problems
    throw error
  }
  return rules
}

export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  /**
   * error 级日志通道（"失败必须响"）。
   *
   * ★ 必须是**具名绑定**，不能只在下面 `installRunCapture({ logError: … })` 的
   *   options 里内联一份：`serviceFor()` 构造审计镜像时要把它传出去
   *   （`createAuditMirror({ sessionOf, log, logError })`）。
   *
   * 2026-09-30 用户报障：那里引用的是裸标识符 `logError`，而 apply 作用域里从来没有这个
   * 名字 ⇒ 任何 `/winstage*` 命令一到"按会话解析暂存服务"就抛
   * `ReferenceError: logError is not defined`，用户看到的是
   * 「`/winstage 失败：logError is not defined`」，整族命令（含 reject/approve）不可用。
   * 回归门：`.t/host-command-selftest.ts`（把 host 半真的 apply 跑起来逐个调 handler）。
   *
   * 语义：错误只走 error 级日志（`ctx.logger.error`，无则 warn），**绝不进命令文本 /
   * 工具输出** —— 与 `review-service.ts` 的 `logError` 同一契约。
   */
  const logError = (message) => {
    const logger = ctx?.logger
    if (logger && typeof logger.error === 'function') logger.error(message)
    else log.warn(message)
  }
  const configuredWorkspaceRoot = typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : ''

  /**
   * ★ R24-A2：把 host 行 config 的 `masks` **编译并 fail-closed 校验**（规则对象 → Workspace）。
   *
   * 放在所有注册/探测之前：非法正则必须在**装配期**就炸（`WINSTAGE_CONFIG_MASKS_INVALID`，
   * 先 logError 一条再 throw），而不是等到第一次 publish 才在某个条目上静默失效。
   * 默认 `[]` ⇒ 不传 `masks`，`Workspace.extraMasks` 仍是 `[]`，
   * review 输出与 R21 逐字节一致（内置危险类仍走 R17 的整份省略）。
   * 编译后的规则经 `serviceFor()` 传给 `getReviewService({ …, masks })`。
   */
  const configuredMasks = compileConfiguredMasks(config.masks, { logError })

  /**
   * 开关的**唯一读法**：每次现读，绝不在这里冻结成常量。
   * 行表 `winstage-sandbox.config.enabled` 是唯一真源，apply 参数只作离线下回退。
   * （详细依据见下方 `stagingEnabledRaw` 同源说明与 R17 审计记录。）
   */
  const isEnabled = () => {
    const fromRows = switchEnabledFromRows(ctx?.fiber?.entry?.parent?.data)
    return typeof fromRows === 'boolean' ? fromRows : config.enabled !== false
  }
  const enabledNow = isEnabled()

  /**
   * R34b-G-04：`workspaceRoot` 未配置 / 指向不存在的目录时 **fail-closed**。
   *
   * 旧实现回退到 `new URL('..', import.meta.url)` = 包目录本身：用户没配根时，
   * 暂存/快照会落到插件安装目录（甚至 asar 内路径），既不是用户工作区，也没有任何提示。
   * 现在要求 profile 配置 host 行（bundle 里留空；R41-G04 单源，fs/shell 未显式写根时
   * 从这里派生，跨机器安装见 README "只配置 host 行的根"），否则在装配期抛结构化错误，
   * 宿主日志里能直接看到原因。
   */
  if (enabledNow) {
    if (configuredWorkspaceRoot.length === 0) {
      const error = new Error(
        'WinStage workspaceRoot 未配置：拒绝装配。请在 profile 覆盖层设置 winstage-sandbox.config.workspaceRoot（R41-G04 单源）；' +
          'fs/shell 未显式写根时会自动派生它，不需要再重述三处。',
      )
      error.code = 'WINSTAGE_WORKSPACE_ROOT_MISSING'
      logError(error.message)
      throw error
    }
    if (!existsSync(canonical(configuredWorkspaceRoot))) {
      const resolved = canonical(configuredWorkspaceRoot)
      const error = new Error(
        `WinStage workspaceRoot 指向的目录不存在：${resolved}。请修正 profile 覆盖层里的 host 行根（R41-G04 单源；` +
          'fs/shell 未显式写根时自动派生，显式值冲突仍会 fail-closed）；本插件不会自动创建用户工作区，也不会回退到插件安装目录。',
      )
      error.code = 'WINSTAGE_WORKSPACE_ROOT_NOT_FOUND'
      logError(error.message)
      throw error
    }
  }
  /**
   * 关态**不校验根**：关闭 = 对原 harness 零影响，缺根/根不存在也不能阻止插件装载
   * （命令面仍注册但如实拒绝、面板路由 503 disabled）。此时给一个只用于日志/挂载的
   * 占位路径，绝不建 store、绝不写盘。
   */
  const workspaceRoot = canonical(configuredWorkspaceRoot || process.cwd())

  /**
   * 开关的**唯一读法**：每次现读，绝不在这里冻结成常量。
   *
   * ── R17 审计修复（P1）：为什么不能只读 `config.enabled` ──────────────────────
   * 部署入口是 `plugin/index.ts`（→ `dist/index.mjs`），它的 `apply()` 先
   * `normalizeConfig(config)` 再委托到本文件。真 schemastery 对 volatile 字段的校验输出是
   * **Volatile 引用对象**（`schemastery/src/index.ts:480-482` 的 `.volatile()` 只是
   * `.extra('volatile', true)`；`:521` 在 `meta.volatile` 时一律 `createVolatile()` 包装），
   * 而 `normalizeConfig()` 用 `boolOf()` 把它们**解成普通布尔快照一次**。
   * ⇒ 设置页把开关关掉时，cordis 的 volatile 通道只 `updateVolatile()` 原地刷新引用，
   * **不会重跑 apply**；于是本文件闭包里的 `config` 是启动那一刻的快照，永远看不到热写。
   * 实测（干净进程 + 真 Cordis Loader；`.lead/logs/cordis-auditor/cordis-audit.log` C 段）：
   *   · 行表 `config.enabled` → false（组合层权威值已换新）；
   *   · `fiber.config.enabled.get()` → false（框架的引用是活的）；
   *   · 但 apply 收到的普通布尔快照仍是 true，且 apply 不会被重跑。
   * 后果：运行中关掉开关后 `/winstage*` 仍执行、面板路由仍放行、关闭态启动后打开也不恢复
   * （直到重启宿主）—— 与 "命令面始终注册 + 执行时现读" 的承诺不符。
   *
   * 所以开关的唯一真源改为**loader 行表里 `winstage-sandbox` 行的 `config.enabled`**
   * （与 `staging-fs.ts::stagingEnabledRaw()` **同一处真值**、同一读法），apply 参数只作
   * 拿不到行表时（离线自测/桩 ctx）的回退。
   * 行表在 `EntryGroup.update()` 里被**换整份**（`parent.data = config`），group 对象不变
   * ⇒ 每次现读都能看到新值，不需要重挂行。
   */
  if (isEnabled()) {
    log.info(`已启用；工作区根 = ${workspaceRoot}`)
  } else {
    log.info('设置里当前为关闭：暂存面已交回平台沙箱（原审批模式）；/winstage* 命令仍可见但会如实拒绝执行。')
  }

  /**
   * ★ 环境监测（fail-closed）：**不通过 ⇒ 插件拒绝启动**（apply 抛错，行不激活）。
   *
   * 为什么放在所有注册之前：只有早抛才能保证"一个命令面、一条路由、一个后台轮询都没有装起来"。
   * 逃生口必须**显式**写出（`probeOnStart:false` 或 `WINSTAGE_SKIP_ENV_GATE=1`），
   * 绝不被顺手触发；默认（开关开）判红。检查项与判定在 `environment-gate.ts`（纯函数）。
   *
   * 探测只跑一次：这里的结果被后面第 3 步复用，不再重复 probe。
   */
  const skipEnvGate = process.env.WINSTAGE_SKIP_ENV_GATE === '1' || config.probeOnStart === false
  let startupProbe
  if (isEnabled() && !skipEnvGate) {
    startupProbe = probeRuntime()
    const report = evaluateEnvironment({ enabled: true, platform: process.platform, probeResult: startupProbe, skip: false })
    if (!report.ok) {
      const message = environmentFailureMessage(report)
      const error = new Error(message)
      error.code = report.code
      error.winstage = { code: report.code, checks: report.checks, failures: report.failures }
      logError(`环境监测未通过，WinStage 插件拒绝启动：${message}`)
      throw error
    }
    if (config.verboseLog) log.info(environmentFailureMessage(report))
  }

  // 1) 审阅面：**每个会话各有自己的暂存清单与快照**，因此不再在启动时预热全局实例；
  //    服务在命令调用时按 `invocation.agent` 现场解析（见 serviceFor）。
  /**
   * 本次命令调用所属会话的审阅服务 —— **审批内容按会话隔离**的入口。
   *
   * `CommandInvocation.agent` 由 dsh-commands 明确给出（"Exact agent whose UI received the
   * command"，dsh-commands/lib/types/index.d.ts:22-24），所以命令面天然知道"是谁点的"。
   * 拿不到会话（agentless 调用 / 自测）时退回**共享**存储（`.dshstage/` 根），与升级前一致。
   */
  const serviceFor = (invocation) => {
    const sessionId = invocation?.agent?.session?.id
    /**
     * ★ 方向 3 接线：把 WinStage 的暂存审批**镜像进会话审计面**。
     *
     * 根因（本轮定因）：`dsh-plugin/**` 里 `session.append` **0 命中** ⇒ 暂存审批只写
     * 自己的 `review.json`，而原生审批写会话日志（`approval/asked`→`approval/decided`）。
     * 两套"真相"不在一个地方 ⇒ 没有共享 id、没有共同清除路径 ⇒ 用户报的"两套审批互相冲突"。
     *
     * 这里用**与原生同一对事件名与同一套载荷语义**写审计对（id = `winstage:<candidateId>`），
     * 于是重放/对账/孤儿检测都能走同一套 invariant。实现在 `audit-mirror.ts`：
     *   - 照抄原生 `hasOpenTurn`（回合外不写，避免造出"崩溃尾巴"式垃圾事件）；
     *   - 任何 append 失败一律吞掉 + error 级日志（**审计绝不影响审批**）。
     *
     * `sessionOf` 必须是**每次现读**：`getReviewService` 是按 `root#sessionKey` 缓存的，
     * 而服务跨命令存活；把 session 钉死在构造期会在会话切换后写错地方。
     */
    const sessionOf = () => invocation?.agent?.session
    const audit = createAuditMirror({ sessionOf, log, logError })
    const service = getReviewService({
      workspaceRoot,
      ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
      // T3d：**必须在这里就把开关传进去**。`getReviewService()` 内部自己也会认领一次
      // （`review-service.ts:1143`），只在下面那行加判断是**无效**的 —— 认领在函数里就已经发生了。
      claimShared: isEnabled(),
      log: (message) => log.info(message),
      audit,
      // R24-A2：编译后的 config.masks（空数组 = 不传，行为与 R21 一致）
      ...(configuredMasks.length > 0 ? { masks: configuredMasks } : {}),
    })
    // 自愈：共享存储里可能积着"上一段拿不到会话身份"的条目（旧进程/agentless 调用）
    //
    // T3d：**这只在沙箱接管时做**。关闭沙箱 = 纯模式开关 —— 关闭态绝不认领别处（其他会话 /
    // 无会话身份）的暂存内容，否则那些内容会变成"我会话里可批准"的条目，一次批准就把别人的
    // 暂存写进真实磁盘。关闭态下共享条目留在原处，由 `/winstage`（无会话身份）自己负责。
    if (isEnabled()) service.absorbSharedStore?.()
    return service
  }

  /**
   * 1.5) ★ Cordis 卸载协议：**进程内单例的清理**。
   *
   * `review-service.ts` 的 `SERVICES` / `EFFECTIVE_STAGING` / `READ_VISIBILITY` 都是
   * **模块级** Map，而 DSH loader 按模块 URL 缓存 ⇒ 行被卸载时模块不会重新求值，
   * 这些 Map 会带着 Workspace / Store / 会话 session 闭包常驻（**卸载即残留**）。
   * 这里把它们交给 cordis：卸载/重挂时一并清空。
   *
   * ⚠ 只清内存，**不删盘**：磁盘上的会话存储根由 `src/stage-guard.ts` 在宿主进程退出时
   *   回收；卸载插件时删掉用户尚未批准的暂存内容是数据丢失，不是清理。
   */
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => {
      return () => {
        try {
          const counts = disposeReviewServices()
          log.info(
            `已卸载：清空进程内审阅服务 ${counts.services} 个 / 生效态缓存 ${counts.effectiveStaging} 条 / ` +
              `读侧可见性 ${counts.readVisibility} 条（磁盘上的会话存储根保留，不随卸载删除）。`,
          )
        } catch (error) {
          logError(`卸载清理失败（已忽略）：${error?.message ?? error}`)
        }
      }
    }, 'winstage-sandbox: dispose review services')
  }

  // 2) 命令面（可选服务：没有 commands 就不注册，绝不让加载失败）
  ctx.inject(['commands'], (scope) => {
    // 注册失败必须**响**：这个回调一旦抛错，`/winstage*` 会整族消失却毫无提示
    // （T5-B 实测就是这样静默失效的）。这里把失败降级为 error 日志 + 不抛出，
    // 让"命令面不可用"这件事在日志里可见，同时不影响插件其余部分加载。
    try {
      const registered = registerCommands(scope, serviceFor, log, { isEnabled })
      log.info(`已注册 ${registered.length} 个 /winstage* 命令（暂存与快照按会话隔离）`)
    } catch (error) {
      const logger = ctx?.logger
      const message = `命令注册失败：${error?.message ?? error}（/winstage* 将不可用）`
      if (logger && typeof logger.error === 'function') logger.error(message)
      log.warn(message)
    }
  })

  // 2.1) ★ WP3-B：面板**读侧路由**（存储根在宿主侧解析，客户端只拿逻辑标识）。
  //
  // 为什么需要一条宿主路由：Client 只被允许用**已有**的 Remote（`workspaceFiles.read`
  // 要一个**路径**），而存储根自 Phase 1 起在 Windows 缓存里 —— 浏览器里没有
  // `%LOCALAPPDATA%` 这个事实，客户端自己拼只能拼出旧布局（这就是本次实测的缺口）。
  // 所以宿主把"根在哪"这件事收回自己这边，用 `resolveReviewStoreDir()` 解析，
  // 通过一条同源只读路由把**快照/状态卡**给客户端；客户端拿到的只有**逻辑标识**
  // （路由名 + 会话 id + 存储短哈希），**没有任何暂存路径**。
  //
  // 失败必须响（error 级日志）但**不影响**插件其余部分：拿不到 webServer 时命令面照常工作，
  // 面板则退回"兼容旧布局"的读法（`client.js` 里那条**唯一**的兼容分支）。
  ctx.inject(['webServer', 'connection'], (webScope) => {
    // **本装配没有 webServer**（headless / ACP / 自测桩）不是故障：面板那时会走
    // `client.js` 那条被注释说明的兼容读法。这里用 info 级如实说明 —— 把正常形态
    // 记成 error 级会让"失败必须响"变成噪声，真正的失败（register 抛错）才进 error。
    if (!webScope?.webServer || typeof webScope.webServer.register !== 'function') {
      log.info('本装配没有 webServer：面板读侧路由未注册；面板将退回兼容旧布局的读法（命令面不受影响）。')
      return
    }
    /* ★ R23-A（R21-LC-01）：命名前缀路由**先于**宿主前端静态兜底被匹配，而宿主的
     * BrowserAuth 只在兜底里调用 `Connection.authorizeIndex()` ⇒ 不在这里显式鉴权，
     * 本机任意进程无 token/cookie 即可读审阅快照（路径/diff 统计/可信性卡）。
     * `connection` 是宿主提供的认证服务（`inject = ['webServer','connection']` 与
     * dsh-host-frontend-static 同源）；拿不到就 **fail-closed 不注册路由**，绝不退化成
     * "无鉴权的面板路由"（宁可面板不可用，也不静默暴露快照）。 */
    const connection = webScope.connection
    if (typeof connection?.authorizeIndex !== 'function') {
      const message = '面板路由缺少宿主 connection.authorizeIndex（本装配无认证服务）：拒绝注册无鉴权路由（fail-closed）'
      logError(message)
      log.warn(message)
      return
    }
    // 与 dsh-host-frontend-static 同口径：Cookie 的 Secure 语义只由本监听器协议决定。
    const secureListener = webScope.webServer.protocol === 'https:'
    try {
      const handler = createPanelHandler({
        workspaceRoot,
        isEnabled,
        log: (message) => log.warn(message),
        // R23-A：把宿主 BrowserAuth 的会话校验搬进命名路由（401 响应由授权方拥有）。
        authorize: (req, res) => connection.authorizeIndex(req, res, secureListener),
        /**
         * ★ R41-SEC04：`?session=` 的服务端绑定源。
         * 必须**每请求现读**：本注入回调可能在 `sessionQuery`/`sessions` 被 provide 之前执行，
         * 捕获一次会永久拿到 undefined。`get()` 在服务缺失时返回 undefined（不抛），
         * 因此这里不改变"没有会话服务 ⇒ 兼容旧行为"的降级路径。
         */
        sessionQueryOf: () => {
          try {
            return webScope.get?.('sessionQuery') ?? ctx.get?.('sessionQuery')
          } catch {
            return undefined
          }
        },
        sessionsOf: () => {
          try {
            return webScope.get?.('sessions') ?? ctx.get?.('sessions')
          } catch {
            return undefined
          }
        },
        // 面④（未结算审批）需要"当前会话"的事件流。本路由没有 command invocation，
        // 拿不到就如实标"未知" —— 绝不用"最近一次命令的会话"冒充当前会话。
      })
      const route = { kind: 'prefix', path: PANEL_ROUTE_PREFIX, handler }
      if (typeof webScope.effect === 'function') {
        // ★ Cordis 卸载协议 + "失败必须响"：`register()` **是否返回 disposer 在本仓没有任何
        //   证据**。旧实现把它直接当清理函数交给 `effect()` —— 若返回 undefined，`ctx.effect`
        //   会静默接受（不报错、不清理）⇒ **卸载后 `/winstage-panel` 路由仍然可达**。
        //   这里显式判定：拿不到函数就记 error 级日志，并在有 `unregister` 时退回它。
        webScope.effect(() => {
          const disposer = webScope.webServer.register(route)
          if (typeof disposer === 'function') return disposer
          logError(
            `webServer.register() 未返回 disposer（返回 ${typeof disposer}）：面板路由无法在卸载时注销，` +
              '若宿主提供 webServer.unregister 则退回它，否则本路由会残留到进程结束。',
          )
          if (typeof webScope.webServer.unregister === 'function') {
            return () => webScope.webServer.unregister(route)
          }
          return () => {}
        }, 'winstage-sandbox: panel routes')
      } else {
        webScope.webServer.register(route)
      }
      log.info(`面板读侧路由已注册：${PANEL_ROUTE_PREFIX}（存储根在宿主侧解析；客户端不再拼旧布局）`)
    } catch (error) {
      const message = `面板读侧路由注册失败：${error?.message ?? error}（面板会退回兼容读法）`
      const logger = ctx?.logger
      if (logger && typeof logger.error === 'function') logger.error(message)
      log.warn(message)
    }
  })

  // 2.5) 运行后捕获（默认关；WINSTAGE_CAPTURE=1 打开）
  //      放在启动探测**之前**：`probeOnStart=false` 会在下一步 return，
  //      若把它写在后面，关掉探测就会连带把捕获面一起关掉（静默失效）。
  installRunCapture(ctx, {
    workspaceRoot,
    serviceFor,
    log: (message) => log.info(message),
    // 复用 apply 作用域里那个具名 logError（`serviceFor` 也要用同一个，别再内联一份）
    logError,
  })

  // 2.6) ★ 缺陷②（F5b）：基线漂移的**只读轮询复核**。
  //
  //      为什么必须有它：`review.json` 只在变更/命令时发布，而 `pwsh` 直接写真实磁盘
  //      不产生这两种事件 ⇒ 快照的 `generatedAt` 会一直冻在上一版，面板对"外部改动"
  //      完全不可见（F5b 实测 90 s、`staleBaseline=0`），随后点「批准所选」还会静默覆盖。
  //      本定时器按 Client 的轮询节拍（1500 ms）跑 `ReviewService.reviewDrift()` —— 那是
  //      **纯读**：指纹没变立刻返回、不写盘；只有事实变了才重发布 review.json。
  //
  // ★ R18 · KNOWN-08a：**装配不再由 apply 期的开关决定**（旧实现只在开态装配 ⇒ ①运行中
  //   关掉开关后定时器继续只读扫描；②关闭态启动后再打开永远不恢复，直到重启宿主）。
  //   现在恒装配，把 `isEnabled`（每次现读 loader 行表的同一真值）交给 watcher：
  //   开 ⇒ 正常轮询；关 ⇒ `clearInterval` 停轮询（零 IO）并挂轻量恢复检查；重新打开
  //   ⇒ 自动恢复轮询。两个定时器都由 `ctx.effect` 持有（卸载对称清理）。
  installBaselineWatch(ctx, {
    workspaceRoot,
    // 与命令面/面板/fs 面**同一个真值**（现读 loader 行表；apply 参数只作回退）
    isEnabled,
    log: (message) => log.info(message),
    // 漂移诊断走**人工侧**通道（error 级日志），绝不进模型可见的 stdout/stderr
    logError,
  })
  log.info(
    isEnabled()
      ? '基线漂移复核已装配（只读轮询；外部写入会在一个节拍内出现在面板上）。'
      : '基线漂移复核已装配：设置里当前为关闭 ⇒ 不轮询、零 IO，只保留开关恢复检查（重新打开后自动恢复）。',
  )

  // 3) 启动探测（如实报告受限令牌能力；与暂存面无关）
  if (config.probeOnStart === false) {
    log.info('probeOnStart=false，跳过启动探测。')
    return
  }
  /**
   * ★ R19 修复（P1·关态零影响）：**关闭态必须零探测**。
   *
   * `probeRuntime()` 不是纯查询：`WindowsStageExecutor.capabilities()` 要加载
   * ACL/win32 模块，`probeWin32Abi()`（`src/capability.ts:111`）会在
   *   · `dirname(tmpdir())` 下 `mkdir`+`write`+`rm` 一个 `dsh-probe-outside-*` 目录
   *     （`capability.ts:218-227`）；
   *   · 尝试写 `C:\Windows\dsh-probe-write.txt` 再删掉（`capability.ts:229-236`）；
   *   · 派生 `ping.exe` / `node -e setTimeout(...)` 子进程并建 Job Object 验证可指派
   *     （`capability.ts:340-367`），随后 TerminateProcess；
   *   · `stat` `C:\Windows\System32\config\SAM`、`C:\Windows\win.ini`（`capability.ts:239-246`）。
   * 也就是说它是**真实写盘 + 建进程**。而设置里 `enabled:false` 的语义是
   * "关闭后本插件不做任何检查"（`plugin/config.ts` 的 `enabled` 描述逐字如此），
   * 与"关态对原 harness 零影响"直接冲突：旧实现只判 `probeOnStart`，于是
   * **关态 + 默认 `probeOnStart:true` 的宿主每次启动都会跑这套探测**。
   * 先红后绿：`.t/r19-cordis/repro-offstate-probe.ts`（关态 probeRuntimeCalls 1 → 0）。
   *
   * 这里用与命令面/面板/轮询**同一个** `isEnabled()`（每次现读 loader 行真值），
   * 所以它不会把 apply 快照当成开关（R17 修掉的旧缺陷），且运行中热关开关不改变
   * "启动期已过"这一事实——本段只在 apply 期求值一次。
   */
  if (!isEnabled()) {
    log.info('设置里当前为关闭：跳过启动能力探测（关态零 IO，不调用 probeRuntime）。')
    return
  }
  const probe = startupProbe ?? probeRuntime()
  if (probe.ready) {
    log.info(`能力探测通过：${probe.detail}`)
  } else {
    log.warn(`能力探测未通过：${probe.detail}`)
  }
}
