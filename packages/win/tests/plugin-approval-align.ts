/**
 * 审批/策略对齐套件 —— 覆盖阶段 3 新增的四个模块：
 *   `plugin/policy/engine.ts`（聚合裁决）、`plugin/risk.ts`（L0–L3）、
 *   `plugin/approval-hub.ts`（多页分流）、`plugin/review-state.ts`（双状态线）。
 *
 * 零子进程、零注册表、零网络 ⇒ 离线档，任意会话可跑。
 * 用法：node --import tsx tests/plugin-approval-align.ts
 */
import { evaluate, intersectConstraints, normalizeResult, REASON } from '../plugin/policy/engine.ts'
import type { Facts } from '../plugin/policy/engine.ts'
import { LEVEL, RISK_REASON, actionFor, assess, decide } from '../plugin/risk.ts'
import type { RiskFacts } from '../plugin/risk.ts'
import { PAGES, createApprovalHub } from '../plugin/approval-hub.ts'
import {
  APPLY,
  REVIEW,
  canTransitionApply,
  canTransitionReview,
  hasNetChange,
  resolveCurrent,
  selectForApply,
  supersedeByPaths,
} from '../plugin/review-state.ts'
import type { ChangeUnit } from '../plugin/review-state.ts'
import { applyWithGuard, parseApplyArgs, registerAlignedCommands, renderReview } from '../plugin/commands.ts'
import { buildAlignedDeps, riskFactsOf } from '../plugin/wire.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (condition) process.stdout.write(`  ✓ ${label}\n`)
  else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}\n`)
  }
}

process.stdout.write('=== plugin-approval-align ===\n')

// ── 1. 策略引擎：聚合顺序 ────────────────────────────────────────────────────
process.stdout.write('\n[1] policy/engine 聚合\n')
{
  const facts: Facts = { tool: 'read_file', effect: 'filesystem' }
  ok(evaluate(facts, {}).decision === 'ALLOW', '无规则无内置命中 ⇒ ALLOW')

  const deny = evaluate(facts, { denyTools: ['read_file'] })
  ok(deny.decision === 'DENY' && deny.reasonCodes.includes(REASON.TOOL_HARD_DENIED), 'denyTools 命中 ⇒ DENY')

  const net = evaluate({ effect: 'network' }, { offline: true })
  ok(net.decision === 'DENY' && net.reasonCodes.includes(REASON.NETWORK_OFFLINE), '离线 + 网络 ⇒ DENY')

  const tier = evaluate({ privilege: { tier: 3 } }, { maxTier: 1 })
  ok(tier.decision === 'DENY' && tier.reasonCodes.includes(REASON.PRIVILEGE_TIER_EXCEEDS_MAX), '档位超上限 ⇒ DENY')

  // DENY 压过 NEEDS_CONFIRMATION，再压过 ALLOW
  const agg = evaluate(facts, {
    rules: [
      () => ({ decision: 'ALLOW' }),
      () => ({ decision: 'NEEDS_CONFIRMATION', requiredGrants: ['g1'] }),
      () => ({ decision: 'DENY', reasonCodes: ['X'] }),
    ],
  })
  ok(agg.decision === 'DENY', 'DENY 压过 NEEDS_CONFIRMATION 与 ALLOW')

  const confirmOnly = evaluate(facts, { rules: [() => ({ decision: 'NEEDS_CONFIRMATION' })] })
  ok(confirmOnly.decision === 'NEEDS_CONFIRMATION', 'NEEDS_CONFIRMATION 压过 ALLOW')

  const grants = evaluate(facts, { rules: [() => ({ decision: 'ALLOW', requiredGrants: ['g'] })] })
  ok(grants.decision === 'NEEDS_CONFIRMATION', 'requiredGrants 非空 ⇒ 升为 NEEDS_CONFIRMATION')

  // 规则抛错 ⇒ fail-closed DENY
  const thrown = evaluate(facts, { rules: [() => { throw new Error('boom') }] })
  ok(thrown.decision === 'DENY' && thrown.reasonCodes.includes(REASON.POLICY_EVALUATION_FAILED), '规则抛错 ⇒ DENY(POLICY_EVALUATION_FAILED)')

  // 结果结构非法 ⇒ DENY
  ok(normalizeResult(null).decision === 'DENY' && normalizeResult(null).reasonCodes[0] === REASON.POLICY_INVALID_RESULT, '非对象结果 ⇒ DENY(POLICY_INVALID_RESULT)')
  ok(normalizeResult({ decision: 'MAYBE' }).reasonCodes[0] === REASON.POLICY_INVALID_DECISION, '非法 decision ⇒ DENY(POLICY_INVALID_DECISION)')
}

// ── 2. 约束交集：更严格优先 ──────────────────────────────────────────────────
process.stdout.write('\n[2] 约束取交集\n')
{
  const merged = intersectConstraints([
    { maxBytes: 100, allow: ['a', 'b', 'c'] },
    { maxBytes: 50, allow: ['b', 'c', 'd'] },
  ])
  ok(merged.maxBytes === 50, '数值取 min（100,50 → 50）')
  ok(Array.isArray(merged.allow) && merged.allow.length === 2 && merged.allow.includes('b') && merged.allow.includes('c'), '列表取交集（保留 b,c）')
}

// ── 3. 风险分级 L0–L3 与硬拒绝 ───────────────────────────────────────────────
process.stdout.write('\n[3] risk 分级与硬拒绝\n')
{
  ok(assess({}).level === LEVEL.LOW, '无事实 ⇒ L0')
  ok(assess({ pathScope: 'user' }).levelName === 'L1', '用户目录 ⇒ L1')
  ok(assess({ pathScope: 'system' }).levelName === 'L3', '系统路径 ⇒ L3')
  ok(assess({ packageInstall: true }).levelName === 'L2', '包安装 ⇒ L2')

  const danger = assess({ dangerousCommand: true })
  ok(danger.hardDeny === true && danger.action === 'block', '危险命令 ⇒ 硬拒绝/BLOCK')

  ok(actionFor(LEVEL.MODERATE, false) === 'record', 'L1 ⇒ record')
  ok(actionFor(LEVEL.HIGH, false) === 'review', 'L2 ⇒ review')

  // 硬拒绝不可被确认覆盖
  ok(decide({ verdict: danger, confirmed: true, sessionAuto: true }) === false, '硬拒绝：confirmed 与 sessionAuto 都不能放行')

  // 密钥/包安装不被会话自动审批跳过
  const secret = assess({ secret: true })
  ok(secret.reasonCodes.includes(RISK_REASON.SECRET_SCOPE), '密钥作用域有原因码')
  ok(decide({ verdict: secret, sessionAuto: true }) === false, '密钥：会话自动审批不得跳过')
  ok(decide({ verdict: secret, confirmed: true }) === true, '密钥：显式确认后放行')

  const pkg = assess({ packageInstall: true })
  ok(decide({ verdict: pkg, sessionAuto: true }) === false, '包安装：会话自动审批不得跳过')

  // 普通 review 可被会话自动审批放行
  const plain = assess({ pathScope: 'system' })
  ok(plain.hardDeny === false, '系统路径不是硬拒绝（只是 L3/block）')
  ok(decide({ verdict: assess({ effect: 'network' }), sessionAuto: true }) === true, '普通 record 项：会话自动审批放行')
}

// ── 4. 审批中心：多页分流、幂等 ──────────────────────────────────────────────
process.stdout.write('\n[4] approval-hub 分页与幂等\n')
{
  ok(PAGES.length === 5, '五个页面（files/behavior/resource/network/anomaly）')
  const hub = createApprovalHub()
  const decided: unknown[] = []
  const id1 = hub.submit('network', { title: 'n1', onDecision: (v) => decided.push(v) })
  hub.submit('files', { title: 'f1' })
  ok(hub.pendingCount() === 2, 'pendingCount 合计 2')
  ok(hub.pendingCount('network') === 1, 'network 页计数 1')
  ok(hub.list('network').length === 1 && hub.list('network')[0].id === id1, 'list 按页返回')

  ok(hub.resolve(id1, 'allow_once') === true, 'resolve 命中')
  ok(hub.resolve(id1, 'deny') === false, 'resolve 幂等：二次为 false')
  ok(decided.length === 1 && decided[0] === 'allow_once', '决策回调只触发一次')

  ok(hub.clear(hub.list('files')[0].id) === true, 'clear 命中')
  ok(hub.pendingCount() === 0, 'clear 后计数归零')

  let threw = false
  try {
    hub.submit('bogus' as never, {})
  } catch {
    threw = true
  }
  ok(threw, '未知页面 submit 抛错')

  hub.registerProvider('anomaly', () => [{ k: 1 }])
  ok(hub.observe('anomaly').length === 1, '观测类 provider 生效')
  hub.registerProvider('anomaly', () => {
    throw new Error('x')
  })
  ok(hub.observe('anomaly').length === 0, 'provider 抛错 ⇒ 空数组（不炸）')
}

// ── 5. 双状态线：迁移、取代、链解析 ──────────────────────────────────────────
process.stdout.write('\n[5] review-state 状态机\n')
{
  ok(canTransitionReview(REVIEW.PENDING, REVIEW.APPROVED), 'PENDING→APPROVED 合法')
  ok(canTransitionReview(REVIEW.PENDING, REVIEW.SUPERSEDED), 'PENDING→SUPERSEDED 合法')
  ok(!canTransitionReview(REVIEW.REJECTED, REVIEW.APPROVED), 'REJECTED→APPROVED 非法（终态）')
  ok(canTransitionApply(APPLY.NOT_REQUESTED, APPLY.APPLYING), 'NOT_REQUESTED→APPLYING 合法')
  ok(canTransitionApply(APPLY.APPLYING, APPLY.CONFLICT), 'APPLYING→CONFLICT 合法')
  ok(!canTransitionApply(APPLY.NOT_REQUESTED, APPLY.APPLIED), 'NOT_REQUESTED→APPLIED 非法（必须经 APPLYING）')

  const mk = (id: string, paths: string[], extra: Partial<ChangeUnit> = {}): ChangeUnit => ({
    id,
    reviewState: REVIEW.PENDING,
    applyState: APPLY.NOT_REQUESTED,
    paths,
    createdAt: 0,
    ...extra,
  })

  const units = new Map<string, ChangeUnit>()
  const u1 = mk('cs_1', ['a.txt'])
  units.set(u1.id, u1)
  const u2 = mk('cs_2', ['a.txt', 'b.txt'])
  units.set(u2.id, u2)
  const superseded = supersedeByPaths(units, u2)
  ok(superseded.includes('cs_1'), '同路径旧 PENDING 被取代')
  ok(u1.reviewState === REVIEW.SUPERSEDED && u1.supersededBy === 'cs_2', '取代建立链 cs_1→cs_2')

  ok(resolveCurrent(units, 'cs_1')?.id === 'cs_2', '陈旧引用重定向到链尾')

  // 环路保护：构造 cs_a→cs_b→cs_a
  const cyc = new Map<string, ChangeUnit>()
  const a = mk('a', ['x']);
  const b = mk('b', ['x'])
  a.supersededBy = 'b'
  b.supersededBy = 'a'
  cyc.set('a', a)
  cyc.set('b', b)
  const resolved = resolveCurrent(cyc, 'a')
  ok(resolved !== undefined, '环路下 resolveCurrent 不无限循环（返回某节点）')

  // 选择性应用：部分应用不丢其余
  const list = [mk('p1', ['a.txt']), mk('p2', ['b.txt']), mk('p3', ['c.txt'])]
  const sel = selectForApply(list, ['a.txt'])
  ok(sel.selected.length === 1 && sel.selected[0].id === 'p1', '按路径选中 1 项')
  ok(sel.remaining.length === 2, '其余 2 项保留（不丢）')

  // 仅未请求应用的项可应用
  const applied = mk('p4', ['d.txt'], { applyState: APPLY.APPLIED })
  ok(selectForApply([applied]).selected.length === 0, '已应用的项不再进入可应用集')

  ok(hasNetChange(undefined, 'h1') === true, '新增 ⇒ 有净变化')
  ok(hasNetChange('h1', 'h1') === false, '同内容 ⇒ 无净变化')
  ok(hasNetChange('h1', undefined) === true, '删除 ⇒ 有净变化')
}

// ── 6. 命令面（假依赖，纯逻辑）───────────────────────────────────────────────
process.stdout.write('\n[6] commands 分级确认\n')
{
  const units: ChangeUnit[] = [
    { id: 'c1', reviewState: REVIEW.PENDING, applyState: APPLY.NOT_REQUESTED, paths: ['src/a.txt'], createdAt: 0 },
    { id: 'c2', reviewState: REVIEW.PENDING, applyState: APPLY.NOT_REQUESTED, paths: ['src/b.txt'], createdAt: 0 },
  ]
  const makeDeps = (riskMap: Record<string, RiskFacts>, applied: string[] = []) => ({
    units: () => units,
    riskOf: (u: ChangeUnit): RiskFacts => riskMap[u.id] ?? {},
    apply: (sel: readonly ChangeUnit[]) => {
      for (const u of sel) applied.push(u.id)
      return { applied: sel.map((u) => u.id), failed: [] }
    },
    discard: () => {
      applied.push('discard')
    },
  })

  // 全低风险 ⇒ review 可读；apply 直接放行
  const lowDeps = makeDeps({ c1: {}, c2: {} })
  ok(renderReview(lowDeps).kind === 'success', 'renderReview 低风险 ⇒ success')
  const applied: string[] = []
  const lowApply = applyWithGuard(makeDeps({ c1: {}, c2: {} }, applied))
  ok(lowApply.kind === 'success' && applied.length === 2, '低风险：无需确认即应用全部')

  // 硬拒绝 ⇒ 即使 force 也拒绝
  const hardRes = applyWithGuard(makeDeps({ c1: { dangerousCommand: true }, c2: {} }), { force: true })
  ok(hardRes.kind === 'error' && hardRes.text.includes('硬拒绝'), '硬拒绝：--force 也被拒')

  // 需确认（L3 block，非硬拒绝）：无 force 报需确认，有 force 放行
  const sysRisk = makeDeps({ c1: { pathScope: 'system' }, c2: { pathScope: 'system' } })
  ok(applyWithGuard(sysRisk, {}).kind === 'error', 'L3(系统路径)：未确认 ⇒ error')
  const forced = applyWithGuard(sysRisk, { force: true })
  ok(forced.kind === 'error', 'L3(系统路径)：action=block，force 仍不放行（block 语义）')

  // 密钥项 sessionAuto 不得跳过，显式 force 才放行
  const secretDeps = makeDeps({ c1: { secret: true }, c2: { secret: true } })
  ok(applyWithGuard(secretDeps, { sessionAuto: true }).kind === 'error', '密钥：sessionAuto 不得跳过')

  // 路径选择：只应用 a.txt，保留 b（部分应用不丢其余）
  const selApplied: string[] = []
  const selRes = applyWithGuard(makeDeps({ c1: {}, c2: {} }, selApplied), { paths: ['src/a.txt'] })
  ok(selRes.kind === 'success' && selApplied.length === 1 && selApplied[0] === 'c1', '按路径应用 1 项，其余保留')
  ok(selRes.text.includes('保留'), '结果文本含保留项计数')

  // parseApplyArgs
  ok(parseApplyArgs('/winstage-apply --force').force === true, 'parseApplyArgs 识别 --force')
  ok(parseApplyArgs('--file src/x').paths?.[0] === 'src/x', 'parseApplyArgs 识别 --file <path>')

  // registerAlignedCommands：无 commands 作用域时静默
  let registered = 0
  const fakeCtx = { commands: { register: () => { registered += 1 } } }
  registerAlignedCommands(fakeCtx, lowDeps)
  ok(registered === 3, 'registerAlignedCommands 注册 3 条命令')
  registerAlignedCommands({}, lowDeps)
  ok(true, '无 commands 作用域时不抛错')
}

// ── 7. 接线层：快照 → 命令依赖 ──────────────────────────────────────────────
process.stdout.write('\n[7] wire 快照→依赖\n')
{
  const calls: string[] = []
  const fakeService = {
    snapshot: () => ({
      files: [
        { path: 'src/a.txt', op: 'modify', kind: 'file', risk: 'normal' },
        { path: 'C:\\Windows\\x', op: 'create', kind: 'file', risk: 'sensitive', safety: 'danger' },
        { path: 'C:\\out\\y', op: 'create', kind: 'file', risk: 'outside' },
      ],
    }),
    approve: (paths: readonly string[]) => {
      calls.push(`approve:${paths.join(',')}`)
      return { approved: paths.length, failed: [] }
    },
    reject: (paths: readonly string[]) => {
      calls.push(`reject:${paths.join(',')}`)
    },
  }
  const deps = buildAlignedDeps(fakeService)
  ok(deps.units().length === 3, 'units() 从快照文件构建 3 个单位')

  const sensitive = deps.riskOf(deps.units()[1])
  ok(sensitive.secret === true, 'sensitive 条目 ⇒ secret 事实')
  const outside = deps.riskOf(deps.units()[2])
  ok(outside.pathScope === 'other', 'outside 条目 ⇒ pathScope=other')

  ok(riskFactsOf({ path: 'x', kind: 'registry' }).effect === 'registry', 'registry 条目 ⇒ effect=registry')

  const res = deps.apply(deps.units().slice(0, 1))
  ok(res.applied.length === 1 && calls.some((c) => c.startsWith('approve:src/a.txt')), 'apply 委派到 service.approve')

  deps.discard()
  ok(calls.some((c) => c.startsWith('reject:')), 'discard 委派到 service.reject')
}

const failed = failures > 0
process.stdout.write(`\n断言 ${checks} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'} checks=${checks} failures=${failures} mode=normal\n`)
process.exit(failed ? 1 : 0)
