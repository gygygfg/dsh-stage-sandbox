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
}

/** 命令返回值（与 DSH 的 `{ kind, text }` 同形）。 */
export interface CommandResult {
  kind: 'success' | 'error'
  text: string
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
}

/**
 * `/winstage-apply`：按风险分级确认后应用。
 *
 * 规则（对齐 NeoAI，逐条可测）：
 *   · 所选单元若有任一**硬拒绝** ⇒ 直接 `error`（`--force` 也不能覆盖）；
 *   · `review`/`block` 档需要 `force`（或允许的 `sessionAuto`）；密钥/包安装**永不**被 `sessionAuto` 跳过；
 *   · 未确认 ⇒ `error` 并给出需再次确认的提示（"未知结果不报告为成功"）；
 *   · 通过后调用 `deps.apply(selected)`，如实回报成功/失败清单。
 *
 * @param deps - 依赖
 * @param input - 路径/确认
 */
export function applyWithGuard(deps: AlignedCommandDeps, input: ApplyInput = {}): CommandResult {
  const { selected, remaining } = selectForApply(deps.units(), input.paths)
  if (selected.length === 0) return { kind: 'error', text: '没有可应用的暂存改动（或所选路径不存在）。' }

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
  const kept = remaining.length
  const text =
    `已应用 ${result.applied.length} 个文件` +
    (result.failed.length > 0 ? `，失败 ${result.failed.length}：${result.failed.join(', ')}` : '') +
    (kept > 0 ? `；保留 ${kept} 个未选中项。` : '。')
  return { kind: result.failed.length > 0 ? 'error' : 'success', text }
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

/** 解析 `--force` 与 `--file <path>`（可选 `--file=<path>`）。 */
export function parseApplyArgs(rawInput: string | undefined): ApplyInput {
  const raw = String(rawInput ?? '')
  const force = /(^|\s)--force(\s|$)/.test(raw)
  const fileMatch = /--file(?:=|\s+)(\S+)/.exec(raw)
  const paths = fileMatch?.[1] !== undefined ? [fileMatch[1]] : undefined
  return { force, ...(paths === undefined ? {} : { paths }) }
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
  const specs: Array<{ name: string; description: string; handler: () => CommandResult }> = [
    { name: 'winstage-review', description: 'WinStage 暂存：列出待审改动与风险档（对齐 NeoAI 分级）', handler: () => renderReview(deps) },
    {
      name: 'winstage-apply',
      description: 'WinStage 暂存：按分级确认应用（--force 确认；硬拒绝不可覆盖）',
      handler: () => applyWithGuard(deps, { force: true }),
    },
    { name: 'winstage-discard', description: 'WinStage 暂存：丢弃全部暂存（真实工作区不改）', handler: () => discardAll(deps) },
  ]
  try {
    for (const spec of specs) {
      const registration = (): unknown =>
        commands.register({
          name: spec.name,
          description: spec.description,
          input: { hint: '可选：--force 确认 / --file <路径>' },
          handler: () => spec.handler(),
        })
      if (typeof ctx.effect === 'function') ctx.effect(registration, `winstage-sandbox: command ${spec.name}`)
      else registration()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`WinStage 对齐命令注册失败：${message}`)
  }
}
