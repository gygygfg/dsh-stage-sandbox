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

  const beforeEmpty = calls.length
  const emptyRes = deps.apply([])
  ok(
    emptyRes.applied.length === 0 && emptyRes.failed.length === 0 && calls.length === beforeEmpty,
    '空 units ⇒ 零应用、零失败、不调用 service.approve（不是"批准全部"）',
  )

  const failureDeps = buildAlignedDeps({
    snapshot: () => ({ files: [{ path: 'src/a.txt', op: 'modify', kind: 'file', risk: 'normal' }] }),
    approve: () => ({ approved: 0, failed: [{ path: 'src/a.txt', code: 'NO_MATCHING_PATHS', message: 'nope' }] }),
    reject: () => {},
  })
  const failureRes = failureDeps.apply(failureDeps.units())
  ok(
    failureRes.failed.length === 1 && failureRes.failed[0].includes('NO_MATCHING_PATHS') && failureRes.failed[0].includes('src/a.txt') && !failureRes.failed[0].includes('[object Object]'),
    '结构化 failed ⇒ 可读字符串（含 code/path，不是 [object Object]）',
  )

  deps.discard()
  ok(calls.some((c) => c.startsWith('reject:')), 'discard 委派到 service.reject')
}

// ── 8. R17 安全审计回归：敏感遮蔽 / review payload 泄露（P0） ─────────────────
//
// 为什么放在本套件：`tests/paths-masks.ts` 归 T2 管（避让），`crosscheck-*` 不在
// T3 的写范围；本套件已经是"面板/审批事实"的离线集合，加一节纯函数 + 端到端断言
// 不需要新增套件接线（`OFFLINE_SUITES` / `verify.cmd` 都不用动）。
process.stdout.write('\n[8] R17 敏感遮蔽 / review payload 泄露\n')
{
  const { mkdtempSync, mkdirSync: mkdir, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { maskSensitiveLine, maskSensitiveLines } = await import('../dsh-plugin/sensitive-content.ts')
  const { ReviewService, DANGER_MASK_IDS, SENSITIVE_OMIT_NOTE, classifyChange } = await import('../dsh-plugin/review-service.ts')

  // 8.1 值级掩码：R17 独立复现过漏明的五类形态（缩进/列表/JSON/注释/同段第二凭据）
  for (const [line, marker] of [
    ['  password: R17INDENT01', 'R17INDENT01'],
    ['- token: R17LIST01', 'R17LIST01'],
    ['{"token":"R17JSON01"}', 'R17JSON01'],
    ['db_user: admin # password: R17COMMENT01', 'R17COMMENT01'],
    ['api_key: sk-R17FIRST01abc password: R17SECOND01', 'R17SECOND01'],
  ]) {
    const r = maskSensitiveLine(line)
    ok(r.masked === true && !r.text.includes(marker), `值级掩码必须遮住：${line}`, r.text)
  }
  // 8.2 块标量（`secret: |` 的后续缩进行）由跨行状态机遮蔽
  {
    const r = maskSensitiveLines([
      { type: 'add', line: 1, text: 'secret: |' },
      { type: 'add', line: 2, text: '  R17BLOCK01' },
    ])
    ok(!r.lines.map((l) => l.text).join('\n').includes('R17BLOCK01'), '块标量正文必须遮蔽', JSON.stringify(r.lines))
    ok(r.reasons.includes('block-scalar'), '块标量遮蔽必须给出机读理由 block-scalar', r.reasons)
  }
  // 8.3 反向对照：路径/URI/短标量不得被遮蔽（否则掩码退化成"看不见改了什么"）
  for (const line of ['path: C:\\Users\\x\\a.txt', 'url: https://example.com/a', 'enabled: true']) {
    ok(maskSensitiveLine(line).masked === false, `对照：不该遮蔽的仍不遮蔽：${line}`)
  }

  // 8.4 判级：`.dsh/.credentials.yaml` 必须进 danger 档（旧清单漏了窄规则 dsh-credentials）
  ok(DANGER_MASK_IDS.includes('dsh-credentials'), 'DANGER_MASK_IDS 必须包含 dsh-credentials')
  {
    const root = mkdtempSync(join(tmpdir(), 'r17-sec-classify-'))
    try {
      const v = classifyChange({ path: join(root, '.dsh', '.credentials.yaml') }, { workspaceRoot: root })
      ok(v.risk === 'sensitive' && v.safety === 'danger', '凭据文件判级 = sensitive/danger', JSON.stringify(v))
      ok(v.maskId === 'dsh-credentials', '判级保留命中 id（供 renderChange 区分内置/自定义）', v.maskId)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // 8.5 端到端：review.json 一个明文 marker 都不能有；凭据条目内容整份省略；
  //     非敏感文件仍是正常可见（负例：不得把普通文件也省略掉）
  {
    const base = mkdtempSync(join(tmpdir(), 'r17-sec-review-'))
    try {
      const wsRoot = join(base, 'ws')
      const storeDir = join(base, 'store')
      mkdir(wsRoot, { recursive: true })
      const svc = new ReviewService({ workspaceRoot: wsRoot, sessionId: 'r17-sec-review', storeDir })
      // `ReviewService` 的实现文件是 @ts-nocheck（JS→TS 过渡），类体没有 workspace 字段声明；
      // 这里只做端到端取用，按运行时真实形状显式放宽类型，不改产品源码的类型面。
      const ws: any = (svc as any).workspace
      const SECRETS = [
        'DEEPSEEK_API_KEY: sk-R17LIVE01abcdefghij',
        '  password: R17INDENT02',
        '- token: R17LIST02',
        '{"token":"R17JSON02"}',
        'db_user: admin # password: R17COMMENT02',
        'api_key: sk-R17MIX01abcdef password: R17SECOND02',
        'secret: |',
        '  R17BLOCK02',
      ].join('\n')
      ws.writeFile(join(wsRoot, '.dsh', '.credentials.yaml'), SECRETS, { origin: 'test' })
      ws.writeFile(join(wsRoot, 'notes.txt'), 'plain-project-note\n', { origin: 'test' })
      ws.freezeCandidate({ source: 'test' })
      svc.publish()
      const reviewText = readFileSync(join(storeDir, 'review.json'), 'utf8')
      const markers = ['R17LIVE01', 'R17INDENT02', 'R17LIST02', 'R17JSON02', 'R17COMMENT02', 'R17SECOND02', 'R17BLOCK02']
      const leaked = markers.filter((marker) => reviewText.includes(marker))
      ok(leaked.length === 0, 'review.json 里不得出现任何敏感明文 marker', JSON.stringify(leaked))
      const snap = JSON.parse(reviewText)
      const credRow = (snap.files ?? []).find((f) => String(f.path ?? '').includes('.credentials.yaml')) ?? null
      ok(
        credRow !== null && Array.isArray(credRow.diff) && credRow.diff.length === 0 && credRow.note === SENSITIVE_OMIT_NOTE,
        '凭据条目内容整份省略（fail-closed），不是部分遮蔽',
        JSON.stringify({ diff: credRow?.diff?.length, note: credRow?.note, safety: credRow?.safety }),
      )
      const plainRow = (snap.files ?? []).find((f) => String(f.path ?? '').includes('notes.txt')) ?? null
      ok(
        plainRow !== null && plainRow.risk === 'normal' && Array.isArray(plainRow.diff) && plainRow.diff.length > 0,
        '负例：非敏感文件仍是正常可见（未被误省略）',
        JSON.stringify({ risk: plainRow?.risk, diff: plainRow?.diff?.length }),
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
}

// ── 9. 重复 apply 显式幂等（R18 · KNOWN-08d）────────────────────────────────────
// 缺陷：重复提交同一候选时，旧实现靠下层碰巧返回 0/丢候选，命令层不是"没有可应用项"
// 的歧义 error 就是"已应用 0 个文件"的模糊 success；既没有结构化结论，也无法从返回值
// 判断"到底有没有再次写盘"。本节把三条判据钉死：
//   ① 已 APPLIED 的单元 ⇒ `already-applied`（success / 零写盘 / 不调 deps.apply）；
//   ② 调用方的"已应用账本" ⇒ 同样是 `already-applied`；
//   ③ 下层 no-op（applied=0 且 failed=0）⇒ `already-applied`，不再印"已应用 0 个文件"。
process.stdout.write('\n[9] 重复 apply 显式幂等（R18 KNOWN-08d）\n')
{
  const unit = (id: string, paths: string[], applyState: string = APPLY.NOT_REQUESTED): ChangeUnit => ({
    id,
    reviewState: REVIEW.PENDING,
    applyState: applyState as ChangeUnit['applyState'],
    paths,
    createdAt: 0,
  })
  const makeDeps = (units: readonly ChangeUnit[], options: { appliedPaths?: () => readonly string[]; applyResult?: { applied: string[]; failed: string[] } } = {}) => {
    const calls: string[][] = []
    return {
      calls,
      deps: {
        units: () => units,
        riskOf: (): RiskFacts => ({}),
        apply: (sel: readonly ChangeUnit[]) => {
          calls.push(sel.map((u) => u.id))
          return options.applyResult ?? { applied: sel.map((u) => u.id), failed: [] }
        },
        discard: () => {},
        ...(options.appliedPaths === undefined ? {} : { appliedPaths: options.appliedPaths }),
      },
    }
  }

  // ① 已 APPLIED 单元：selectForApply 不会选中它们（既有断言），命令层必须显式认成重复
  {
    const { deps, calls } = makeDeps([unit('applied-1', ['src/a.txt'], APPLY.APPLIED)])
    let res
    try {
      res = applyWithGuard(deps, { paths: ['src/a.txt'] })
    } catch (error) {
      res = { kind: 'error', text: `THREW ${String(error)}` } as any
    }
    ok(res.kind === 'success', '①已 APPLIED 再 apply ⇒ success（不是歧义 error）', res.text)
    ok(res.code === 'already-applied' && res.alreadyApplied === true, '①结构化 code=already-applied / alreadyApplied=true', JSON.stringify({ code: res.code, alreadyApplied: res.alreadyApplied }))
    ok(res.appliedCount === 0 && calls.length === 0, '①未再次写盘：appliedCount=0 且 deps.apply 一次都没调', JSON.stringify({ appliedCount: res.appliedCount, calls }))
    ok(String(res.text).includes('already-applied') && String(res.text).includes('未再次写盘'), '①文本明说 already-applied 且未再次写盘', res.text)
    ok(!/已应用 0 个文件/.test(String(res.text)), '①不出现"已应用 0 个文件"的模糊成功文案')
  }

  // 不带 paths = 全部：只有已 APPLIED 单元时同样认成重复
  {
    const { deps, calls } = makeDeps([unit('applied-all', ['src/a.txt'], APPLY.APPLIED)])
    const res = applyWithGuard(deps)
    ok(res.code === 'already-applied' && calls.length === 0, '①无 paths（全部）时也走 already-applied 且零写盘')
  }

  // ② 调用方账本（快照已空、单元列表已无该候选）：账本命中 ⇒ already-applied
  {
    const { deps, calls } = makeDeps([], { appliedPaths: () => ['src/a.txt', 'src/b.txt'] })
    const res = applyWithGuard(deps, { paths: ['src/a.txt'] })
    ok(res.kind === 'success' && res.code === 'already-applied', '②账本命中 ⇒ already-applied', JSON.stringify({ code: res.code, text: res.text }))
    ok(res.appliedCount === 0 && calls.length === 0, '②账本命中时零写盘')
  }
  // 账本里没有请求的路径 ⇒ 仍是 nothing-to-apply（不能把"没做过"说成"已应用"）
  {
    const { deps } = makeDeps([], { appliedPaths: () => ['src/other.txt'] })
    const res = applyWithGuard(deps, { paths: ['src/a.txt'] })
    ok(res.kind === 'error' && res.code === 'nothing-to-apply', '②账本不命中 ⇒ nothing-to-apply（不误报重复）', JSON.stringify({ kind: res.kind, code: res.code }))
  }
  // 账本读取抛错 ⇒ 不得变成未捕获异常
  {
    const { deps } = makeDeps([], {
      appliedPaths: () => {
        throw new Error('ledger-boom')
      },
    })
    let res
    try {
      res = applyWithGuard(deps, { paths: ['src/a.txt'] })
    } catch (error) {
      res = { kind: 'threw', code: 'threw', text: String(error) } as any
    }
    ok(res.kind === 'error' && res.code === 'nothing-to-apply', '②账本抛错 ⇒ 降级为 nothing-to-apply（不抛栈）', res.text)
  }

  // ③ 下层 no-op（applied=0 且 failed=0）：已无净变化 ⇒ already-applied，而不是"已应用 0 个文件"
  {
    const { deps, calls } = makeDeps([unit('race-1', ['src/a.txt'])], { applyResult: { applied: [], failed: [] } })
    const res = applyWithGuard(deps, { paths: ['src/a.txt'] })
    ok(res.kind === 'success' && res.code === 'already-applied' && res.appliedCount === 0, '③下层 no-op ⇒ already-applied（success/零计数）', JSON.stringify({ code: res.code, appliedCount: res.appliedCount }))
    ok(calls.length === 1, '③下层确实被调用一次（本层不吞调用，只把 no-op 解释清楚）', String(calls.length))
    ok(!/已应用 0 个文件/.test(res.text), '③不再出现"已应用 0 个文件"')
  }

  // 正常路径回归：真实应用必须保持原语义（不因幂等守卫改变成功路径）
  {
    const { deps } = makeDeps([unit('ok-1', ['src/a.txt']), unit('ok-2', ['src/b.txt'])])
    const res = applyWithGuard(deps)
    ok(res.kind === 'success' && res.appliedCount === 2 && res.code === undefined, '正常 apply 仍报 appliedCount=2（不误判成 already-applied）', JSON.stringify({ code: res.code, appliedCount: res.appliedCount }))
    ok(res.text.includes('已应用 2 个文件'), '正常 apply 文本仍是"已应用 N 个文件"')
  }
  // 失败路径回归：有失败项 ⇒ error + applied-with-failures（不冒充成功）
  {
    const { deps } = makeDeps([unit('bad-1', ['src/a.txt'])], { applyResult: { applied: [], failed: ['STALE_BASELINE'] } })
    const res = applyWithGuard(deps)
    ok(res.kind === 'error' && res.code === 'applied-with-failures', '失败项 ⇒ error + applied-with-failures', JSON.stringify({ kind: res.kind, code: res.code }))
  }
}

const failed = failures > 0
process.stdout.write(`\n断言 ${checks} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'} checks=${checks} failures=${failures} mode=normal\n`)
process.exit(failed ? 1 : 0)
