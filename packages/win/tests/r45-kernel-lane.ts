// @ts-nocheck —— R45：显式内核边界档（tier=T1S）+ 默认 TS 边界的诚实可见性。
/**
 * r45-kernel-lane —— "我要内核写边界"必须是一个**显式、可验证、fail-closed** 的入口
 *
 * ── 背景（R44 的遗留，来自对标 NeoAI 第 6 条不变量）────────────────────────────
 * R44 把"只读豁免"从文本判定改成内核写屏障判定后，暴露了两个仍然存在的缺口：
 *
 *   1. **默认 lane 仍是 TS（用户态 IAT 钩子）**：插件 `tier` 默认 `'auto'`，探测通过即
 *      选 TS。用户没有任何"我要内核边界"的简单入口 —— T1S（受限令牌 + shim）此前只能
 *      通过 `WINSTAGE_T1_SHIM=1` + `tier:'T1'` 组合进入，而 T1S 恰恰是同时满足
 *      "暂存/WAL 可用"与"内核兜底写面"的档位。
 *   2. **T1S 被状态面板误报成"沙箱未生效/已降级"**：`summarizeLane()` 只把
 *      `launchMode === 'shim'` 判为 active，T1S 的 `launchMode` 是
 *      `shim+restricted-token`，于是落到 degraded 分支；lane 产物里的
 *      `degraded: effectiveLane !== 'shim'` 同样把 T1S 算成降级。
 *
 * ── R45 的改动（本套件钉住）──────────────────────────────────────────────────
 *   · `tier:'T1S'` 成为显式内核边界档：`planT1ShimMode()` 直接进入 T1S 判定；
 *     shim 不可用/未探测 ⇒ `T1S_UNAVAILABLE` fail-closed（不静默降回 T1）；
 *   · 探测条件收敛到纯函数 `transparencyProbeNeeded()`（T1S 也在其中）；
 *   · `summarizeLane()` 把 T1S 判为 active，并给出 `boundaryText`；
 *     TS 的结论明确写出"写边界=用户态 IAT 钩子（不是内核边界）"与升级到 T1S/T0 的路径；
 *   · lane 产物的 `degraded` 不再把 T1S 算成降级。
 *
 * 全部离线（纯函数 + 状态文案），不需要 ACL/shim/受限令牌。
 *
 * 用法：node tests/r45-kernel-lane.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  T1S_LAUNCH_MODE,
  T1S_TIER,
  T1S_UNAVAILABLE,
  WRITE_BARRIERS,
  planT1ShimMode,
  selectLaunchMode,
  transparencyProbeNeeded,
  writeBarrierFor,
} from '../src/executor.ts'
import { summarizeLane } from '../dsh-plugin/shell-executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}
const section = (title) => process.stdout.write(`\n=== ${title} ===\n`)
const json = (value) => JSON.stringify(value)

const opt = (envValue) => {
  if (envValue === undefined) return { value: undefined, requested: false, enabled: false, invalid: false }
  if (envValue === '1') return { value: '1', requested: true, enabled: true, invalid: false }
  return { value: envValue, requested: true, enabled: false, invalid: true }
}
const probeOk = { available: true, reason: 'probe ok' }
const probeBad = { available: false, reason: 'injector missing' }

try {
  section('1. 探测条件：TS/auto/T1S 必须探测；T1 只在显式 opt-in 时探测')
  check('TS ⇒ 探测', transparencyProbeNeeded('TS', opt(undefined)) === true)
  check('auto ⇒ 探测', transparencyProbeNeeded('auto', opt(undefined)) === true)
  check('T1S ⇒ 探测（R45 新增；否则会静默按 T1 装配）', transparencyProbeNeeded('T1S', opt(undefined)) === true)
  check('T1 + 未 opt-in ⇒ 不探测（默认 T1 逐字不变）', transparencyProbeNeeded('T1', opt(undefined)) === false)
  check('T1 + opt-in ⇒ 探测', transparencyProbeNeeded('T1', opt('1')) === true)
  check('T0 ⇒ 不探测（AppContainer 装配自成一路）', transparencyProbeNeeded('T0', opt(undefined)) === false)
  check('未知 tier ⇒ 不探测（不猜）', transparencyProbeNeeded('T7', opt(undefined)) === false)

  section('2. 显式 tier=T1S：不依赖环境变量，shim 可用即 T1S，不可用即 fail-closed')
  {
    const explicit = planT1ShimMode({ requested: 'T1S', optIn: opt(undefined), shimProbe: probeOk })
    check('T1S + shim 可用 ⇒ use=true / mode=T1S / tier=T1S', explicit.use === true && explicit.mode === T1S_LAUNCH_MODE && explicit.tierEffective === T1S_TIER && explicit.failClosed === false, json(explicit))
    check('T1S 的 reason 明说内核写屏障', /kernel write barrier/i.test(explicit.reason), explicit.reason)
    const unavailable = planT1ShimMode({ requested: 'T1S', optIn: opt(undefined), shimProbe: probeBad })
    check('T1S + shim 不可用 ⇒ fail-closed（T1S_UNAVAILABLE）', unavailable.failClosed === true && unavailable.code === T1S_UNAVAILABLE, json(unavailable))
    check('T1S + 未探测 ⇒ fail-closed（"没测"不许当"可用"）', planT1ShimMode({ requested: 'T1S', shimProbe: undefined }).failClosed === true)
    check('T1S 显式请求不被 WINSTAGE_T1_SHIM=0 否决（显式 tier 更强）', planT1ShimMode({ requested: 'T1S', optIn: opt('0'), shimProbe: probeOk }).use === true, json(planT1ShimMode({ requested: 'T1S', optIn: opt('0'), shimProbe: probeOk })))
  }

  section('3. 回归：默认 T1 与既有 opt-in 语义不变')
  {
    const plain = planT1ShimMode({ requested: 'T1', optIn: opt(undefined), shimProbe: probeOk })
    check('T1 + 未 opt-in ⇒ 仍是 restricted-token / T1', plain.use === false && plain.mode === 'restricted-token' && plain.tierEffective === 'T1', json(plain))
    const t1s = planT1ShimMode({ requested: 'T1', optIn: opt('1'), shimProbe: probeOk })
    check('T1 + opt-in ⇒ 仍是 T1S（旧入口不回归）', t1s.use === true && t1s.mode === T1S_LAUNCH_MODE, json(t1s))
    for (const tier of ['TS', 'auto', 'T0']) {
      const ignored = planT1ShimMode({ requested: tier, optIn: opt('1'), shimProbe: probeOk })
      check(`显式 ${tier} 时 opt-in 不参与决定`, ignored.use === false && ignored.ignored === true && ignored.failClosed === false, json(ignored))
    }
    const routed = selectLaunchMode('T1S', probeOk)
    check('selectLaunchMode(T1S) 路由到 restricted-token（再由 T1S 装配升级）', routed.mode === 'restricted-token' && routed.tierEffective === 'T1S', json(routed))
  }

  section('4. 写屏障：T1S 是内核屏障，TS 不是（与 R44 同一口径）')
  check('T1S ⇒ kernel-restricted-token', writeBarrierFor(T1S_LAUNCH_MODE, T1S_TIER) === WRITE_BARRIERS.RESTRICTED_TOKEN)
  check('TS ⇒ user-mode-shim', writeBarrierFor('shim', 'TS') === WRITE_BARRIERS.SHIM)
  check('T1S 屏障满足 isKernelWriteBarrier（可支撑文本只读放行）', writeBarrierFor(T1S_LAUNCH_MODE, T1S_TIER) === WRITE_BARRIERS.RESTRICTED_TOKEN)

  section('5. 状态面板：T1S 不得被报成“降级”；TS 必须写明用户态边界')
  {
    const ts = summarizeLane({ launchMode: 'shim', tierEffective: 'TS', winStageEnabled: true, at: new Date().toISOString() })
    check('TS：status=active / degraded=false', ts.status === 'active' && ts.degraded === false, json({ status: ts.status, degraded: ts.degraded }))
    check('TS：writeBarrier=user-mode-shim + boundaryText 含“用户态”', ts.writeBarrier === WRITE_BARRIERS.SHIM && /用户态/.test(ts.boundaryText), json({ barrier: ts.writeBarrier, text: ts.boundaryText }))
    check('TS：结论写明“不是内核边界”并给出 T1S/T0 升级路径', /不是内核边界/.test(ts.conclusion) && /T1S/.test(ts.conclusion) && /T0/.test(ts.conclusion), ts.conclusion)
    check('TS：结论提到 raw syscall 残余', /raw syscall/.test(ts.conclusion), ts.conclusion)

    const t1s = summarizeLane({ launchMode: T1S_LAUNCH_MODE, tierEffective: T1S_TIER, winStageEnabled: true, at: new Date().toISOString() })
    check('T1S：status=active（旧实现会误报 degraded）', t1s.status === 'active' && t1s.degraded === false, json({ status: t1s.status, degraded: t1s.degraded }))
    check('T1S：writeBarrier=kernel-restricted-token + boundaryText 含“内核”', t1s.writeBarrier === WRITE_BARRIERS.RESTRICTED_TOKEN && /内核/.test(t1s.boundaryText), json({ barrier: t1s.writeBarrier, text: t1s.boundaryText }))
    check('T1S：结论明说暂存/WAL 可归因', /WAL/.test(t1s.conclusion), t1s.conclusion)
    check('T1S：lane 记录的 degraded 字段不得为 true', summarizeLane({ launchMode: T1S_LAUNCH_MODE, tierEffective: T1S_TIER, winStageEnabled: true }).degraded === false)

    const t1 = summarizeLane({ launchMode: 'restricted-token', tierEffective: 'T1', winStageEnabled: true })
    check('T1（无 shim）：仍按原语义报 degraded（不夸大能力）', t1.status === 'degraded' && t1.degraded === true, json({ status: t1.status, degraded: t1.degraded }))
  }

  section('6. 源码接线：init() 必须走纯函数探测；lane 产物不得把 T1S 算降级')
  {
    const executorSource = readFileSync(join(HERE, '..', 'src', 'executor.ts'), 'utf8')
    const shellSource = readFileSync(join(HERE, '..', 'dsh-plugin', 'shell-executor.ts'), 'utf8')
    check('init() 调用 transparencyProbeNeeded(requested, …)', /transparencyProbeNeeded\(requested, this\.t1ShimOptIn\)/.test(executorSource))
    check('planT1ShimMode 有显式 T1S 分支', /const explicitlyRequested = want === 'T1S'/.test(executorSource))
    check('lane 产物 degraded 同时排除 shim 与 T1S', /degraded: effectiveLane !== 'shim' && effectiveLane !== T1S_LAUNCH_MODE/.test(shellSource))
    check('summarizeLane 的 active 分支同时接受 T1S', /launchMode === 'shim' \|\| launchMode === T1S_LAUNCH_MODE/.test(shellSource))
  }
} finally {
  /* 纯函数，无临时文件 */
}

process.stdout.write('\n========================================================================\n')
process.stdout.write(`R45 显式内核边界档：断言 ${assertions} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n`)
process.exitCode = failures === 0 ? 0 : 1
