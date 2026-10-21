/**
 * 对齐 NeoAI 的命令面 —— `/winstage-review`、`/winstage-apply`、`/winstage-discard`。
 *
 * ── 为什么单独一层（而不是塞进旧 `host-plugin.ts`）────────────────────────────
 * 旧命令面（`/winstage list|diff|approve|reject|rebase|refresh`）已经能看/批/拒，
 * 但它**没有** NeoAI 的"分级审批 + 风险定级 + 双状态线"语义。本模块把这两件事分开：
 *   · 逻辑 = 纯函数（`renderReview`/`applyWithGuard`/`discardAll`），可用假依赖单测；
 *   · 装配 = `registerAlignedCommands(ctx, deps)`，在真实 DSH 里挂到 `ctx.commands`。
 * 这样"对齐语义"不依赖 DSH 就能验证（见 `tests/plugin-approval-align.ts` 的同源断言），
 * 真实接线只在阶段 4 的 Windows 会话里跑一次即可。
 *
 * ── 与旧命令的关系 ────────────────────────────────────────────────────────────
 * 旧的 `/winstage approve|reject` **保留**（兼容别名）；本模块新增的三个命令是
 * "对齐 NeoAI"的入口，二者共用同一个审阅服务（通过 `deps`）。**不删旧命令**。
 *
 * @module winstage-sandbox/plugin/commands
 */

import { assess, decide, type RiskFacts } from './risk.ts'
import { APPLY, REVIEW, selectForApply, type ChangeUnit } from './review-state.ts'

/** 命令逻辑所需的依赖（纯函数层只读这些）。 */
export interface AlignedCommandDeps {
  /** 当前全部变更单元。 */
  units(): readonly ChangeUnit[]
  /** 把单元映射为风险事实（路径/密钥/危险命令等）。 */
  riskOf(unit: ChangeUnit): RiskFacts
  /** 应用被选中的单元；返回结果。 */
  apply(units: readonly ChangeUnit[]): { applied: string[]; failed: string[] }
  /** 丢弃全部暂存。 */
  discard(): void
  /**
   * 可选：**已应用过的路径账本**（R18 · KNOWN-08d 的幂等判据之一）。
   *
   * 真实接线若拿得到"曾经成功 apply 过哪些路径"（审阅服务的 `unstaged`/清单状态、
   * 或会话级最近成功清单），实现它即可让"重复 apply 同一候选"明确返回
   * `already-applied`，而不是落到"没有可应用的暂存改动"或让下层碰巧返回 0。
   * 不实现也不影响其它语义：命令层还会用 `applyState === APPLIED` 兜底判定。
   */
  appliedPaths?(): readonly string[]
}

/** 命令返回值（与 DSH 的 `{ kind, text }` 同形；R18 起带可选结构化字段）。 */
export interface CommandResult {
  kind: 'success' | 'error'
  text: string
  /**
   * 结构化结果码（R18 · KNOWN-08d）：
   *   · `'already-applied'` —— 重复 apply；**没有再次写盘**，成功语义；
   *   · `'nothing-to-apply'` —— 既没有可应用项、也没有已应用记录（旧行为，error）；
   *   · `'applied-with-failures'` —— 调用了下层且有失败项（error）。
   * 不写盘的结论必须能从返回值直接读出来，而不是靠打印文本猜。
   */
  code?: 'already-applied' | 'nothing-to-apply' | 'applied-with-failures'
  /** 重复 apply（链路上没有任何写盘动作）时为 true。 */
  alreadyApplied?: boolean
  /** 本次真正应用（写盘）的条数；`already-applied` 恒为 0。 */
  appliedCount?: number
}

/** 单行渲染一个单元的风险档。 */
function renderUnit(unit: ChangeUnit, verdict: ReturnType<typeof assess>): string {
  const paths = unit.paths.join(', ')
  return `  ${verdict.levelName} ${verdict.action.padEnd(6)} ${paths}  [${unit.reviewState}/${unit.applyState}]`
}

/**
 * `/winstage-review`：列出待审单元、各自风险档与建议动作。
 * @param deps - 依赖
 */
export function renderReview(deps: AlignedCommandDeps): CommandResult {
  const units = deps.units().filter((u) => u.reviewState === REVIEW.PENDING || u.reviewState === REVIEW.APPROVED)
  if (units.length === 0) return { kind: 'success', text: '暂存区没有待审改动。' }
  const lines = units.map((u) => renderUnit(u, assess(deps.riskOf(u))))
  const header = `待审改动（${units.length}）：`
  const hard = units.filter((u) => assess(deps.riskOf(u)).hardDeny).length
  const footer = hard > 0 ? `\n其中 ${hard} 项为硬拒绝（不可确认覆盖）。` : ''
  return { kind: hard > 0 ? 'error' : 'success', text: `${header}\n${lines.join('\n')}${footer}` }
}

/** `applyWithGuard` 的输入。 */
export interface ApplyInput {
  paths?: readonly string[]
  /** 用户确认（`--force`）。 */
  force?: boolean
  /** 会话自动审批档。 */
  sessionAuto?: boolean
  /**
   * 参数解析失败（缺值/未知开关/引号未闭合）。
   *
   * ⚠ 这是**安全字段**：`--file` 缺值绝不能退化成"没有 paths = 应用全部"。
   * `applyWithGuard()` 见到它一律返回 error 且不调用 `deps.apply()`。
   */
  invalid?: string
}

/**
 * `/winstage-apply`：按风险分级确认后应用（含 **R18 · KNOWN-08d 重复 apply 显式幂等**）。
 *
 * 规则（对齐 NeoAI，逐条可测）：
 *   · 所选单元若有任一**硬拒绝** ⇒ 直接 `error`（`--force` 也不能覆盖）；
 *   · `review`/`block` 档需要 `force`（或允许的 `sessionAuto`）；密钥/包安装**永不**被 `sessionAuto` 跳过；
 *   · 未确认 ⇒ `error` 并给出需再次确认的提示（"未知结果不报告为成功"）；
 *   · **重复 apply**：所选路径已经是 `APPLIED`（单元状态）或已在 `deps.appliedPaths()` 账本里，
 *     且当前**没有可应用项** ⇒ 返回结构化 `{kind:'success', code:'already-applied',
 *     alreadyApplied:true, appliedCount:0}`，**不调用** `deps.apply`（不写盘），
 *     文本明说"未再次写盘"；不再落到"没有可应用的暂存改动"的歧义 error；
 *   · 下层报"应用 0 项且无失败"同样视为已无净变化 ⇒ `already-applied` 成功语义
 *     （绝不把"什么都没做"印成"已应用 0 个文件"的模糊成功）；
 *   · 通过后调用 `deps.apply(selected)`，如实回报成功/失败清单。
 *
 * ⚠ 本函数**只做调用层幂等判定**：不改 `workspace.applyCandidate` / 审阅服务的
 *   CAS/事务语义（重复写盘的最终防线仍在下层；本层只保证"明确重复"时不发起写盘）。
 *
 * @param deps - 依赖
 * @param input - 路径/确认
 */
export function applyWithGuard(deps: AlignedCommandDeps, input: ApplyInput = {}): CommandResult {
  // 参数解析失败 ⇒ 什么都不做。绝不能因为 `paths` 缺失而退化成"应用全部"。
  if (typeof input.invalid === 'string' && input.invalid.length > 0) {
    return { kind: 'error', text: `参数错误：${input.invalid}（本次未应用任何文件）` }
  }
  const allUnits = deps.units()
  const { selected, remaining } = selectForApply(allUnits, input.paths)

  /**
   * ── R34-11：批量路径必须"全命中或不做" ──────────────────────────────────────
   * 旧实现只按交集选：`paths: ['src/a.txt','src/nope.txt']` 会应用 a.txt 并对
   * nope.txt **一声不响** —— 典型的静默半批应用。审批是一次决定，含未命中路径时
   * 拒绝整批并点名，而不是照写命中的那部分。
   */
  if (selected.length > 0 && input.paths !== undefined) {
    const known = new Set(allUnits.flatMap((unit) => unit.paths))
    const unmatched = [...new Set(input.paths)].filter((path) => !known.has(path))
    if (unmatched.length > 0) {
      return {
        kind: 'error',
        text: `没有匹配的待审路径：${unmatched.join(', ')}；为防止半批应用，本次未应用任何文件（其余 ${selected.length} 项也未写入）。`,
      }
    }
  }

  /**
   * 路径匹配：给了 `paths` 就按交集；没给 = "全部"（与 `selectForApply` 同口径）。
   * @param unit - 变更单元
   */
  const matchesRequest = (unit: ChangeUnit): boolean =>
    input.paths === undefined ? true : unit.paths.some((path) => input.paths!.includes(path))

  /** 构造 `already-applied` 结果（成功语义、零写盘、文本给出可判定结论）。 */
  const alreadyApplied = (paths: readonly string[], source: 'unit-state' | 'applied-ledger' | 'lower-layer-noop'): CommandResult => {
    const list = [...new Set(paths)]
    const shown = list.length > 0 ? list.join(', ') : '（所选路径）'
    const why =
      source === 'unit-state'
        ? '这些单元已是 APPLIED 状态'
        : source === 'applied-ledger'
          ? '这些路径已有成功应用记录'
          : '下层报告应用 0 项且无失败（已无净变化）'
    return {
      kind: 'success',
      code: 'already-applied',
      alreadyApplied: true,
      appliedCount: 0,
      text: `already-applied：${why}；本次**未再次写盘**（真实工作区未改动）：${shown}`,
    }
  }

  if (selected.length === 0) {
    // ① 单元状态线：目标路径已经 APPLIED（被 selectForApply 排除，但仍是"重复 apply"）
    const appliedUnits = allUnits.filter((unit) => matchesRequest(unit) && unit.applyState === APPLY.APPLIED)
    if (appliedUnits.length > 0) return alreadyApplied(appliedUnits.flatMap((unit) => unit.paths), 'unit-state')

    // ② 调用方提供的"已应用账本"（可选能力）
    let ledger: readonly string[] = []
    try {
      ledger = typeof deps.appliedPaths === 'function' ? deps.appliedPaths() : []
    } catch {
      ledger = [] // 账本读失败绝不影响其它语义（只退回旧 error 分支）
    }
    if (ledger.length > 0) {
      const hit = input.paths === undefined ? ledger : ledger.filter((path) => input.paths!.includes(path))
      if (hit.length > 0) return alreadyApplied(hit, 'applied-ledger')
    }

    // ③ 真正的"没有可应用项"
    return { kind: 'error', code: 'nothing-to-apply', text: '没有可应用的暂存改动（或所选路径不存在）。' }
  }

  // 硬拒绝：不可覆盖
  const hardDenied = selected.filter((u) => assess(deps.riskOf(u)).hardDeny)
  if (hardDenied.length > 0) {
    const paths = hardDenied.flatMap((u) => u.paths).join(', ')
    return { kind: 'error', text: `拒绝应用：以下改动为硬拒绝（不可被确认覆盖）：${paths}` }
  }

  // 需要确认的项
  const needsConfirm = selected.filter((u) => {
    const verdict = assess(deps.riskOf(u))
    return !decide({ verdict, confirmed: input.force === true, sessionAuto: input.sessionAuto === true })
  })
  if (needsConfirm.length > 0) {
    const paths = needsConfirm.flatMap((u) => u.paths).join(', ')
    return {
      kind: 'error',
      text: `需要确认：${paths}\n再次执行 /winstage-apply --force 以确认。`,
    }
  }

  const result = deps.apply(selected)
  // ④ 下层 no-op：0 应用、0 失败 ⇒ 已无净变化（重复 apply / 被后来的写入取代），
  //    不把"什么都没做"印成模糊成功；结构化表明"未再次写盘"。
  if (result.applied.length === 0 && result.failed.length === 0) {
    return alreadyApplied(selected.flatMap((unit) => unit.paths), 'lower-layer-noop')
  }
  const kept = remaining.length
  const text =
    `已应用 ${result.applied.length} 个文件` +
    (result.failed.length > 0 ? `，失败 ${result.failed.length}：${result.failed.join(', ')}` : '') +
    (kept > 0 ? `；保留 ${kept} 个未选中项。` : '。')
  return {
    kind: result.failed.length > 0 ? 'error' : 'success',
    ...(result.failed.length > 0 ? { code: 'applied-with-failures' as const } : {}),
    appliedCount: result.applied.length,
    text,
  }
}

/** `/winstage-discard`：丢弃全部暂存（有状态操作）。 */
export function discardAll(deps: AlignedCommandDeps): CommandResult {
  deps.discard()
  return { kind: 'success', text: '已丢弃暂存改动（真实工作区未改动）。' }
}

/** `ctx.commands` 的最小结构（避免硬依赖 DSH 类型）。 */
export interface CommandsScope {
  commands?: {
    register(spec: {
      name: string
      description: string
      input?: { hint?: string }
      handler: (invocation: { rawInput?: string }) => CommandResult | Promise<CommandResult>
    }): unknown
  }
  effect?: (fn: () => unknown, label?: string) => unknown
  logger?: { error?: (message: string) => void }
}

/** 切分 `rawInput`：空白分隔，双引号包住的内容算一个 token（引号本身不进入路径）。 */
export function splitApplyTokens(rawInput: string | undefined): { tokens: string[]; unterminated: boolean } {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quoted = false
  for (const ch of String(rawInput ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (quoted) return { tokens: [], unterminated: true }
  if (started) tokens.push(current)
  return { tokens, unterminated: false }
}

/**
 * 解析 `/winstage-apply` 的输入。
 *
 * 语法（与命令 `input.hint` 一致）：
 *   `/winstage-apply`                          → 应用全部待审单元（无 force）
 *   `/winstage-apply --force`                  → 应用全部并确认需要确认的项
 *   `/winstage-apply --file <路径>`            → 只应用该路径（含空格用双引号）
 *   `/winstage-apply --file=<路径>`            → 等号写法
 *   `/winstage-apply "<路径>" [<路径>…]`       → 裸路径同样按路径选择（不再静默忽略）
 *
 * 失败（缺值/未知开关/引号未闭合/空路径）**不抛异常**，而是返回 `invalid`：
 * 旧实现对这些输入一律退回"没有 paths ⇒ 应用全部"，正是最危险的静默误批。
 */
export function parseApplyArgs(rawInput: string | undefined): ApplyInput {
  const { tokens, unterminated } = splitApplyTokens(rawInput)
  if (unterminated) {
    return { force: false, invalid: '双引号未闭合（路径含空格时请成对使用双引号，例如 --file "a b.txt"）' }
  }
  let force = false
  const paths: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--force') {
      force = true
      continue
    }
    let value: string | undefined
    if (token === '--file' || token === '--path') {
      value = tokens[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { force, invalid: `${token} 缺少路径值（含空格的路径请用双引号包住）` }
      }
      i += 1
    } else if (token.startsWith('--file=')) {
      value = token.slice('--file='.length)
      if (value === '') return { force, invalid: '--file= 缺少路径值（含空格的路径请用双引号包住）' }
    } else if (token.startsWith('--')) {
      return { force, invalid: `未知开关 ${token}；可用：--force、--file <路径>` }
    } else if (token === '') {
      return { force, invalid: '路径不能为空' }
    } else {
      value = token
    }
    paths.push(value)
  }
  return { force, ...(paths.length > 0 ? { paths } : {}) }
}

/**
 * 在真实 DSH 里注册三个对齐命令（`ctx.commands` 缺失时静默跳过，不影响加载）。
 *
 * 注册包在 try/catch 里 + error 级日志：这族命令若因 API 形状不符而消失，
 * 本仓曾因"静默不注册"排查过一整个回合（见 `docs/DSH集成.md` §3.4 B）。
 *
 * @param ctx - 插件上下文（含 `commands` 与 `logger`）
 * @param deps - 命令逻辑依赖
 */
export function registerAlignedCommands(ctx: CommandsScope, deps: AlignedCommandDeps): void {
  const commands = ctx.commands
  if (commands === undefined) return
  const specs: Array<{ name: string; description: string; handler: (rawInput?: string) => CommandResult }> = [
    { name: 'winstage-review', description: 'WinStage 暂存：列出待审改动与风险档（对齐 NeoAI 分级）', handler: () => renderReview(deps) },
    {
      name: 'winstage-apply',
      description: 'WinStage 暂存：按分级确认应用（--force 确认；--file <路径> 只应用该路径；硬拒绝不可覆盖）',
      // R34-12：旧实现丢弃 `invocation.rawInput`（handler 是零参箭头函数）⇒
      // `/winstage-apply --file <路径>` 会**应用全部单元**（授权边界被静默放宽），
      // 且 `--force` 永远被隐式打开。现在按真实输入解析；无 --force 时必须走分级确认。
      handler: (rawInput) => applyWithGuard(deps, parseApplyArgs(rawInput)),
    },
    { name: 'winstage-discard', description: 'WinStage 暂存：丢弃全部暂存（真实工作区不改）', handler: () => discardAll(deps) },
  ]
  try {
    for (const spec of specs) {
      const registration = (): unknown =>
        commands.register({
          name: spec.name,
          description: spec.description,
          input: { hint: '可选：--force 确认 / --file <路径>（含空格用双引号）' },
          handler: (invocation) => spec.handler(invocation?.rawInput),
        })
      if (typeof ctx.effect === 'function') ctx.effect(registration, `winstage-sandbox: command ${spec.name}`)
      else registration()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`WinStage 对齐命令注册失败：${message}`)
  }
}
