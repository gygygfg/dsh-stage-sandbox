#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R25 新登记套件。
/**
 * r25-t1s —— **R25-A：T1S（受限令牌 + shim）可选档的离线回归套件**
 *
 * 存在理由（R19-FSREG-04 / R20②）：T1 = 受限令牌、无 shim ⇒ 拒绝可归因? **不可**；
 * TS = shim 暂存但无令牌。R25-A 新增 **opt-in** `WINSTAGE_T1_SHIM=1` 的 T1S：
 * 受限令牌（T1 的 AclSandbox.init + ensureStageGrant）+ shim 注入（暂存 + WAL 归因）。
 * 默认 T1 语义**逐字不变**；显式 opt-in 但装配失败 ⇒ `T1S_UNAVAILABLE` fail-closed，
 * 绝不静默降回 T1。
 *
 * 本套件在**无真实 Win32 令牌**的离线环境里跑（纯函数 + 源码静态守卫）：
 *   S1 `resolveT1ShimOptIn`：unset/''/'0' 不 opt-in；'1' opt-in；其它非空值 invalid
 *      （显式意图但无法解释 ⇒ 调用方必须 fail-closed，不能读成"没开"）。
 *   S2 `planT1ShimMode`：T1+opt-in+shim 可用 ⇒ T1S；shim 不可用/未探测 ⇒ fail-closed
 *      T1S_UNAVAILABLE；非 T1 档（TS/auto/T0）⇒ 开关不参与；默认 ⇒ T1 不变。
 *   S3 默认档位不变：`selectLaunchMode('T1', …)` 仍是 restricted-token/T1（opt-in 不看探测
 *      结果自动生效，也不允许"探测通过就偷偷换档"）。
 *   S4 `registryAttributionFor('shim+restricted-token')` ⇒ attributable=true + WAL expected +
 *      mechanism 含两条腿 + residual 明确包含 raw syscall；T1（默认）仍不可归因。
 *   S5 T1S 的 stagingWrite 判据 = T1 的"暂存根可写" + TS 的"区外写进暂存/真盘不变"
 *      两条腿，缺一条判 unmeasured（不能拿半条腿冒充通过）。
 *   S6 源码静态守卫：opt-in 环境名/错误码、fail-closed 先于任何"降回 T1"的路径、
 *      启动走受限 launcher（注入器 argv --dll/--report + job）、装配包含 shim 环境契约
 *      （stage root / WAL 会话目录 / read-mask / audit）、run() 有 T1S 分支、
 *      tier drift 不把"T1→T1S 的显式增强"误报成漂移。
 *
 * 跳过条件：无（纯函数/静态；不依赖 shim 产物、不启动进程、不改系统状态）。
 * 用法：node tests\r25-t1s.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SANDBOX_STAGING_WRITE_CHECKS,
  SHIM_STAGING_WRITE_CHECKS,
  T1_SHIM_OPT_IN_ENV,
  T1S_INJECTION_FAILED,
  T1S_LAUNCH_MODE,
  T1S_STAGING_WRITE_CHECKS,
  T1S_TIER,
  T1S_UNAVAILABLE,
  WindowsStageExecutor,
  planT1ShimMode,
  registryAttributionFor,
  resolveT1ShimOptIn,
  selectLaunchMode,
} from '../src/executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}
const json = (value) => JSON.stringify(value)
const opt = (value) => resolveT1ShimOptIn(value === undefined ? {} : { [T1_SHIM_OPT_IN_ENV]: value })

/* ── S1 opt-in 解析（env 解析） ─────────────────────────────────────────────── */
section('S1 WINSTAGE_T1_SHIM 解析（默认 T1 不变的入口）')
{
  const unset = opt(undefined)
  check('S1.1 未设置 ⇒ 不 opt-in、不是 invalid（默认 T1 逐字不变）', unset.requested === false && unset.enabled === false && unset.invalid === false && unset.value === undefined, json(unset))
  const empty = opt('')
  check('S1.2 空字符串 ⇒ 不 opt-in', empty.requested === false && empty.enabled === false && empty.invalid === false, json(empty))
  const zero = opt('0')
  check('S1.3 "0" ⇒ 显式关闭（不是 invalid）', zero.requested === false && zero.enabled === false && zero.invalid === false && zero.value === '0', json(zero))
  const one = opt('1')
  check('S1.4 "1" ⇒ opt-in', one.requested === true && one.enabled === true && one.invalid === false, json(one))
  const padded = opt(' 1 ')
  check('S1.5 两侧空白会被 trim（" 1 " 仍是 opt-in）', padded.enabled === true, json(padded))
  for (const weird of ['true', 'yes', 'on', '00', '2', 'T1S']) {
    const parsed = opt(weird)
    check(
      `S1.6 ${JSON.stringify(weird)} ⇒ invalid（显式意图但无法解释，调用方必须 fail-closed）`,
      parsed.requested === true && parsed.invalid === true && parsed.enabled === false,
      json(parsed),
    )
  }
}

/* ── S2 档位判定（档位选择） ────────────────────────────────────────────────── */
section('S2 planT1ShimMode：opt-in ⇒ T1S / 失败 ⇒ T1S_UNAVAILABLE fail-closed / 默认不变')
{
  const probeOk = { available: true, reason: 'probe ok', artifacts: { dllPath: 'x', injectorPath: 'y' } }
  const probeBad = { available: false, reason: 'carrier-init-failed: canary died' }

  const plain = planT1ShimMode({ requested: 'T1', optIn: opt(undefined), shimProbe: probeOk })
  check('S2.1 默认（未 opt-in）：不启用 T1S，T1 不变', plain.use === false && plain.failClosed === false && plain.mode === 'restricted-token' && plain.tierEffective === 'T1', json(plain))

  const t1s = planT1ShimMode({ requested: 'T1', optIn: opt('1'), shimProbe: probeOk })
  check(
    'S2.2 T1 + opt-in + shim 可用 ⇒ T1S（mode=tierEffective=shim+restricted-token/T1S）',
    t1s.use === true && t1s.failClosed === false && t1s.mode === T1S_LAUNCH_MODE && t1s.tierEffective === T1S_TIER,
    json(t1s),
  )
  check('S2.3 T1S 判定常量与文档一致', T1S_LAUNCH_MODE === 'shim+restricted-token' && T1S_TIER === 'T1S', `mode=${T1S_LAUNCH_MODE} tier=${T1S_TIER}`)

  const unavailable = planT1ShimMode({ requested: 'T1', optIn: opt('1'), shimProbe: probeBad })
  check(
    'S2.4 T1 + opt-in + shim 不可用 ⇒ fail-closed T1S_UNAVAILABLE（不静默降回 T1）',
    unavailable.failClosed === true && unavailable.code === T1S_UNAVAILABLE && unavailable.mode === undefined,
    json(unavailable),
  )
  const notProbed = planT1ShimMode({ requested: 'T1', optIn: opt('1'), shimProbe: undefined })
  check('S2.5 T1 + opt-in + 未探测 ⇒ 也 fail-closed（"没测"不许当"可用"）', notProbed.failClosed === true && notProbed.code === T1S_UNAVAILABLE, json(notProbed))

  const invalid = planT1ShimMode({ requested: 'T1', optIn: opt('true'), shimProbe: probeOk })
  check('S2.6 非法 opt-in 值 ⇒ fail-closed（不能读成"没开"）', invalid.failClosed === true && invalid.code === T1S_UNAVAILABLE, json(invalid))

  for (const tier of ['TS', 'auto', 'T0']) {
    const ignored = planT1ShimMode({ requested: tier, optIn: opt('1'), shimProbe: probeOk })
    check(`S2.7 显式请求 ${tier} 时该开关不参与决定（不失败、不改档）`, ignored.failClosed === false && ignored.use === false && ignored.ignored === true, json(ignored))
  }
}

/* ── S3 默认 T1 语义不变（selectLaunchMode 与 opt-in 无关） ──────────────────── */
section('S3 默认 T1 语义逐字不变')
{
  const probeOk = { available: true, reason: 'probe ok' }
  const t1 = selectLaunchMode('T1', probeOk)
  check('S3.1 请求 T1 仍是 restricted-token/T1（探测通过也不会自动换档）', t1.mode === 'restricted-token' && t1.tierEffective === 'T1', json(t1))
  const ts = selectLaunchMode('TS', probeOk)
  check('S3.2 请求 TS 仍是 shim/TS（TS 行为不变）', ts.mode === 'shim' && ts.tierEffective === 'TS', json(ts))
  const autoFallback = selectLaunchMode('auto', { available: false, reason: 'x' })
  check('S3.3 auto 探测失败仍回退 restricted-token/T1（既有 fail-closed 回退不变）', autoFallback.mode === 'restricted-token', json(autoFallback))
}

/* ── S4 归因能力声明 ───────────────────────────────────────────────────────── */
section('S4 registryAttributionFor：T1S 可归因（WAL），T1 默认仍不可归因')
{
  const t1s = registryAttributionFor(T1S_LAUNCH_MODE)
  check('S4.1 T1S ⇒ attributable=true 且 code=WAL 归因', t1s.attributable === true && t1s.code === 'REGISTRY_DENIALS_ATTRIBUTABLE_VIA_WAL', json(t1s))
  check('S4.2 T1S ⇒ wal=expected', t1s.wal === 'expected', `wal=${t1s.wal}`)
  check(
    'S4.3 T1S ⇒ mechanism 同时声明两条腿（shim + 受限令牌）',
    t1s.mechanism === 'winstage-shim-iat+windows-acl-restricted-token',
    t1s.mechanism,
  )
  check(
    'S4.4 T1S ⇒ residual 明确包含 raw syscall（不得宣称覆盖 raw syscall）',
    t1s.residual.some((entry) => /raw syscall/i.test(entry)),
    json(t1s.residual),
  )
  const t1 = registryAttributionFor('restricted-token')
  check('S4.5 默认 T1 ⇒ 仍 attributable=false、code=NO_SHIM（不被 T1S 的存在改写成已归因）', t1.attributable === false && t1.code === 'REGISTRY_DENIALS_NOT_ATTRIBUTABLE_NO_SHIM', json(t1))
  const ts = registryAttributionFor('shim')
  check('S4.6 TS ⇒ 行为不变（attributable=true / mechanism=winstage-shim-iat）', ts.attributable === true && ts.mechanism === 'winstage-shim-iat', ts.mechanism)
}

/* ── S5 T1S 的 staging-write 判据（两条腿） ────────────────────────────────── */
section('S5 T1S staging-write 判据 = T1 的暂存根可写 + TS 的区外写进暂存')
{
  const expected = [...SANDBOX_STAGING_WRITE_CHECKS, ...SHIM_STAGING_WRITE_CHECKS]
  check('S5.1 T1S 判据集合 = 两条通道判据的并集（无重复）', T1S_STAGING_WRITE_CHECKS.length === expected.length && expected.every((name) => T1S_STAGING_WRITE_CHECKS.includes(name)), json(T1S_STAGING_WRITE_CHECKS))
  check('S5.2 判据同时包含 inside-staging-write-allowed（T1 腿）', T1S_STAGING_WRITE_CHECKS.includes('inside-staging-write-allowed'), json(T1S_STAGING_WRITE_CHECKS))
  check('S5.3 判据同时包含 outside-write-staged-not-real（shim 腿）', T1S_STAGING_WRITE_CHECKS.includes('outside-write-staged-not-real'), json(T1S_STAGING_WRITE_CHECKS))

  const all = T1S_STAGING_WRITE_CHECKS.map((name) => ({ name, status: 'pass', detail: 'synthetic' }))
  const pass = WindowsStageExecutor.stagingWriteEnforceability({ checks: all, enforcement: 'shim-user-mode+acl-restricted-token' }, { lane: 't1s' })
  check('S5.4 四类判据都测到且通过 ⇒ verdict=pass', pass.verdict === 'pass', json(pass))
  const onlyShim = WindowsStageExecutor.stagingWriteEnforceability(
    { checks: SHIM_STAGING_WRITE_CHECKS.map((name) => ({ name, status: 'pass', detail: 'synthetic' })), enforcement: 'shim-user-mode' },
    { lane: 't1s' },
  )
  check('S5.5 只有 shim 腿（缺 inside-staging-write-allowed）⇒ unmeasured，不冒充通过', onlyShim.verdict === 'unmeasured', json(onlyShim))
  const onlyT1 = WindowsStageExecutor.stagingWriteEnforceability(
    { checks: SANDBOX_STAGING_WRITE_CHECKS.map((name) => ({ name, status: 'pass', detail: 'synthetic' })), enforcement: 'partial' },
    { lane: 't1s' },
  )
  check('S5.6 只有 T1 腿（缺 shim 判据）⇒ unmeasured', onlyT1.verdict === 'unmeasured', json(onlyT1))
  const failed = WindowsStageExecutor.stagingWriteEnforceability(
    { checks: all.map((entry) => (entry.name === 'outside-write-staged-not-real' ? { ...entry, status: 'fail' } : entry)), enforcement: 'x' },
    { lane: 't1s' },
  )
  check('S5.7 任一判据 fail ⇒ verdict=fail', failed.verdict === 'fail', json(failed))
}

/* ── S6 源码静态守卫（接线/防降级） ───────────────────────────────────────── */
section('S6 源码静态守卫：opt-in 门 / fail-closed 先于降级 / 受限注入器 / shim 环境契约')
{
  const src = readFileSync(join(REPO, 'src', 'executor.ts'), 'utf8')
  check('S6.1 opt-in 环境名与错误码已定义', src.includes(`T1_SHIM_OPT_IN_ENV = 'WINSTAGE_T1_SHIM'`) && src.includes(`T1S_UNAVAILABLE = 'T1S_UNAVAILABLE'`) && src.includes(`T1S_INJECTION_FAILED = 'T1S_INJECTION_FAILED'`), 'constants present')
  const failClosedAt = src.indexOf('this.t1ShimPlan.failClosed')
  const useAt = src.indexOf('const t1s = this.t1ShimPlan.use === true')
  check('S6.2 fail-closed 判定出现在任何 T1S 使用之前（先判死再装配）', failClosedAt > 0 && useAt > failClosedAt, `failClosedAt=${failClosedAt} useAt=${useAt}`)
  check(
    'S6.3 装配/探测失败 → 抛 T1S_UNAVAILABLE 且文案明确"不降回 T1"',
    src.includes('Refusing to fall back to plain T1') && (src.match(/T1S_UNAVAILABLE/g) ?? []).length >= 3,
    `T1S_UNAVAILABLE occurrences=${(src.match(/T1S_UNAVAILABLE/g) ?? []).length}`,
  )
  check('S6.4 只有 opt-in 时才探测 shim（默认 T1 不付探测成本、不换档）', /const wantsT1Shim =\s*!wantsTransparent[\s\S]{0,120}this\.t1ShimOptIn\.requested/.test(src), 'wantsT1Shim guard present')
  check('S6.5 T1S 启动走受限 launcher（注入器 --dll/--report + job 归属）', /launchT1S\([\s\S]{0,1200}this\.launcher\.launch\([\s\S]{0,200}job: this\.job/.test(src) && /const injectorArgv = \['--dll', launch\.artifacts\.dllPath, '--report', reportPath, '--', command, \.\.\.args\]/.test(src), 'restricted injector argv present')
  check('S6.6 T1S 启动用 R22-C 三件套握手（judgeInjectorInit）', /async launchT1S\([\s\S]{0,6000}judgeInjectorInit\(report\)/.test(src), 'judgeInjectorInit present')
  check('S6.7 装配保留 shim 环境契约（stage root / WAL 会话目录 / read-mask / audit）', ['WINSTAGE_STAGE_ROOT', 'WINSTAGE_REGSTAGE_SESSION_DIR', 'read-deny.mask.json', 'WINSTAGE_AUDIT_LOG'].every((name) => src.includes(name)) && /initializeT1S\([\s\S]{0,6000}writeShimConfig\(/.test(src), 'shim env contract present')
  check('S6.8 装配对 shim 运行目录做受限身份实测写（不只看 ACE）', /initializeT1S\([\s\S]{0,3000}verifyT1sAuxDirs\(/.test(src) && src.includes('t1s-aux-dirs-writable'), 'verifyT1sAuxDirs present')
  check('S6.9 run() 有 T1S 分支（不是复用 T1 直启）', src.includes('const t1s = this.launchMode === T1S_LAUNCH_MODE') && src.includes('} else if (t1s) {'), 'run() t1s branch present')
  check('S6.10 结果面如实区分两条腿（enforcement/backend 含 acl-restricted-token）', src.includes(`'shim-user-mode+acl-restricted-token'`) && src.includes(`'winstage-shim-iat+windows-acl-restricted-token'`), 'result projections present')
  check('S6.11 initReport 暴露 t1Shim 装配读数（含 residual）', /t1Shim: t1s\s*\n\s*\? \{/.test(src) && /t1Shim:[\s\S]{0,1200}residual: registryAttributionFor\(this\.launchMode\)\.residual/.test(src), 'initReport t1Shim present')
  check('S6.12 T1→T1S 的显式增强不被误报成档位漂移', src.includes('tierUpgradeToT1s') && /tierDrift[\s\S]{0,400}tierUpgrade/.test(src), 'tierUpgrade suppression present')
}

/* ── 结果 ─────────────────────────────────────────────────────────────────── */
W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
