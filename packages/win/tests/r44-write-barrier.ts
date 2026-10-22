// @ts-nocheck —— R44：把"只读豁免"从静态文本判定改为**内核/运行时写屏障**判定。
/**
 * r44-write-barrier —— 对标 NeoAI 2026-10-22 第 6 条核心不变量的边界回归
 *
 * ── 被修的缺陷（先红后绿）──────────────────────────────────────────────────────
 * `WindowsStageExecutor.assertStagingWriteEnforceable()` 在暂存写判定未通过
 * （`verdict !== 'pass'`：自检瞬时失败 / 暂存根此刻不可写 / TS 档）时，只要
 * `classifyCommandRisk()` 把命令判成 `READ_ONLY`，就 `bypassed:'read-only'` **放行**。
 *
 * 这等于让**字符串判定**成为安全边界：文本只描述命令"长什么样"，不描述进程"实际做了
 * 什么"。本文件头的历史注释（R17/R19）已记录过多次"文本漏判 ⇒ 真实盘被写"的现场；
 * `shim/src/ws_hook.c` 也自述 TS 的 IAT 钩子不覆盖直达 ntdll / raw syscall。
 * 对标上游（NeoAI 2026-10-22，`52c8de4f`）刚刚用 6 个提交把同类"文本硬拒"整段删除，
 * 并确立第 6 条不变量：**安全边界只能由内核/运行时强制提供**；文本匹配最多抬升风险等级
 * 或要求人工复核，**不得**成为放行/拒绝的根据。
 *
 * ── 本套件钉住的新语义（R44）──────────────────────────────────────────────────
 * 闸门判定只看 `launchMode` 派生的**结构性写屏障**（纯函数 `writeBarrierFor()`）：
 *   · `restricted-token`（T1）/ `shim+restricted-token`（T1S）⇒ `kernel-restricted-token`
 *   · `appcontainer`（T0）                                  ⇒ `kernel-appcontainer`
 *   · `shim`（TS，纯用户态 IAT 钩子）                        ⇒ `user-mode-shim`（**不是边界**）
 *   · 未初始化/未知                                          ⇒ `none`
 *
 *   1. `verdict === 'pass'` ⇒ 放行（与屏障无关）；
 *   2. `verdict !== 'pass'` + 文本判只读 + **内核屏障** ⇒ 放行，但决策记录 action 必须是
 *      `allowed-kernel-write-barrier`（不再是 `allowed-read-only-bypass`），并标
 *      `readOnlyAdvisoryOnly:true`（文本只作提示）；
 *   3. `verdict !== 'pass'` + 文本判只读 + **用户态/无屏障** ⇒ **拒绝**
 *      （`STAGING_WRITE_UNVERIFIED_NO_BARRIER`），且错误里带 `writeBarrier/launchMode`；
 *   4. `verdict !== 'pass'` + 文本判有写/判不出来 ⇒ 仍按原文拒绝（fail-closed 不变）。
 *
 * 全部用例为**离线纯判定**：不创建沙箱、不跑子进程、不依赖受限令牌。
 *
 * 用法：node tests/r44-write-barrier.ts
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_RISK,
  STAGING_WRITE_UNVERIFIED_NO_BARRIER,
  T1S_LAUNCH_MODE,
  WRITE_BARRIERS,
  WindowsStageExecutor,
  isKernelWriteBarrier,
  writeBarrierFor,
} from '../src/executor.ts'
import { summarizeLane } from '../dsh-plugin/shell-executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '..', '.t', 'r44-write-barrier')

let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}
const section = (title) => process.stdout.write(`\n=== ${title} ===\n`)

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const staged = join(SCRATCH, 'staged')
mkdirSync(staged, { recursive: true })

/** 构造一个"暂存写判定失败"的执行器；launchMode 直接写字段（本套件不跑 init）。 */
function makeExecutor({ launchMode, verdict = 'fail', commandRisk } = {}) {
  const executor = new WindowsStageExecutor({
    stagingRoot: staged,
    mode: 'workspace-write',
    tier: 'T1',
    stagingWriteCheck: {
      evaluate: () => ({
        verdict,
        lane: 'sandbox',
        enforcement: verdict === 'pass' ? 'measured' : 'degraded',
        failedChecks: [],
        missingChecks: verdict === 'pass' ? [] : ['forced-by-r44-test'],
        reason: `forced verdict=${verdict} by r44-write-barrier`,
      }),
    },
    ...(commandRisk ? { commandRisk } : {}),
  })
  if (launchMode !== undefined) executor.launchMode = launchMode
  return executor
}

const READ_ONLY_CMD = { command: 'cmd.exe', args: ['/c', 'echo', 'READONLY-OK'] }
const WRITE_CMD = { command: 'cmd.exe', args: ['/c', 'echo', 'X', '>', join(staged, 'x.txt')] }
const INDETERMINATE_CMD = { command: 'node', args: ['build.js'] }

const runGate = (executor, context) => {
  try {
    return { result: executor.assertStagingWriteEnforceable(context), error: undefined }
  } catch (error) {
    return { result: undefined, error }
  }
}

try {
  section('1. 写屏障分类：纯函数真值表（未知一律 none，绝不乐观）')
  check('restricted-token（T1）⇒ kernel-restricted-token', writeBarrierFor('restricted-token') === WRITE_BARRIERS.RESTRICTED_TOKEN, writeBarrierFor('restricted-token'))
  check('shim+restricted-token（T1S）⇒ kernel-restricted-token', writeBarrierFor(T1S_LAUNCH_MODE) === WRITE_BARRIERS.RESTRICTED_TOKEN, T1S_LAUNCH_MODE)
  check('appcontainer（T0）⇒ kernel-appcontainer', writeBarrierFor('appcontainer') === WRITE_BARRIERS.APPCONTAINER, writeBarrierFor('appcontainer'))
  check('shim（TS）⇒ user-mode-shim（明确不是内核边界）', writeBarrierFor('shim') === WRITE_BARRIERS.SHIM, writeBarrierFor('shim'))
  check('未初始化/未知 ⇒ none', writeBarrierFor(undefined) === WRITE_BARRIERS.NONE && writeBarrierFor('T7') === WRITE_BARRIERS.NONE && writeBarrierFor(null) === WRITE_BARRIERS.NONE)
  check('T2（acl-only）不报内核屏障（执行器无独立 T2 装配）', writeBarrierFor('restricted-token', 'T2') === WRITE_BARRIERS.NONE, writeBarrierFor('restricted-token', 'T2'))
  check('T3（none）不报内核屏障', writeBarrierFor('restricted-token', 'T3') === WRITE_BARRIERS.NONE, writeBarrierFor('restricted-token', 'T3'))
  check('T1 显式 tier 仍报内核屏障', writeBarrierFor('restricted-token', 'T1') === WRITE_BARRIERS.RESTRICTED_TOKEN)
  check('isKernelWriteBarrier 只认 restricted-token / appcontainer', isKernelWriteBarrier(WRITE_BARRIERS.RESTRICTED_TOKEN) && isKernelWriteBarrier(WRITE_BARRIERS.APPCONTAINER) && !isKernelWriteBarrier(WRITE_BARRIERS.SHIM) && !isKernelWriteBarrier(WRITE_BARRIERS.NONE))

  section('2. 内核屏障 + 文本判只读 ⇒ 放行，但动作是 kernel-write-barrier（不是文本豁免）')
  {
    const executor = makeExecutor({ launchMode: 'restricted-token' })
    const { result, error } = runGate(executor, READ_ONLY_CMD)
    check('T1：只读命令被放行', error === undefined && result?.allowed === true, error?.code ?? `allowed=${result?.allowed}`)
    check('T1：bypassed 必须是 kernel-write-barrier（旧值 read-only 不得复活）', result?.bypassed === 'kernel-write-barrier', result?.bypassed)
    check('T1：决策记录 action=allowed-kernel-write-barrier', executor.stagingWriteGate.lastDecision?.action === 'allowed-kernel-write-barrier', executor.stagingWriteGate.lastDecision?.action)
    check('T1：决策记录带 writeBarrier=kernel-restricted-token', executor.stagingWriteGate.lastDecision?.writeBarrier === WRITE_BARRIERS.RESTRICTED_TOKEN, executor.stagingWriteGate.lastDecision?.writeBarrier)
    check('T1：文本判定被显式标为 advisory only', executor.stagingWriteGate.lastDecision?.readOnlyAdvisoryOnly === true)
    check('T1：trips 里同样有该动作（可审计）', (executor.stagingWriteGate.trips ?? []).some((t) => t.action === 'allowed-kernel-write-barrier'))
    executor.dispose?.()
  }

  section('3. 用户态 shim / 无屏障 + 文本判只读 ⇒ 必须拒绝（文本不是边界）')
  for (const [label, launchMode] of [['TS（shim）', 'shim'], ['未初始化', undefined]]) {
    const executor = makeExecutor({ launchMode })
    const { result, error } = runGate(executor, READ_ONLY_CMD)
    check(`${label}：只读命令被拒绝`, error !== undefined && result === undefined, error?.code ?? 'NOT REFUSED')
    check(`${label}：错误码是 STAGING_WRITE_UNVERIFIED_NO_BARRIER`, error?.code === STAGING_WRITE_UNVERIFIED_NO_BARRIER, error?.code)
    check(`${label}：错误带 writeBarrier/launchMode（可归因）`, error?.writeBarrier === (launchMode === 'shim' ? WRITE_BARRIERS.SHIM : WRITE_BARRIERS.NONE) && error?.launchMode === (launchMode ?? null), JSON.stringify({ barrier: error?.writeBarrier, launchMode: error?.launchMode }))
    check(`${label}：humanChannel 明说 text classification 不是边界`, error?.humanChannel?.readOnlyAdvisoryOnly === true && /advisory|literal/i.test(String(error?.remediation?.join(' ') ?? '')), JSON.stringify(error?.humanChannel?.remediation ?? null))
    check(`${label}：拒绝被记账（trips.action=refused）`, (executor.stagingWriteGate.trips ?? []).some((t) => t.action === 'refused' && t.code === STAGING_WRITE_UNVERIFIED_NO_BARRIER))
    executor.dispose?.()
  }

  section('4. 写类 / 判不出来：内核屏障在场也仍然拒绝（fail-closed 方向不变）')
  {
    const executor = makeExecutor({ launchMode: 'restricted-token' })
    const write = runGate(executor, WRITE_CMD)
    check('T1 + 写类命令 ⇒ STAGING_WRITE_UNVERIFIED', write.error?.code === 'STAGING_WRITE_UNVERIFIED', write.error?.code)
    check('T1 + 写类命令 ⇒ 错误里也带 writeBarrier', write.error?.writeBarrier === WRITE_BARRIERS.RESTRICTED_TOKEN, write.error?.writeBarrier)
    const indeterminate = runGate(executor, INDETERMINATE_CMD)
    check('T1 + 判不出来 ⇒ STAGING_WRITE_UNVERIFIED_INDETERMINATE', indeterminate.error?.code === 'STAGING_WRITE_UNVERIFIED_INDETERMINATE', indeterminate.error?.code)
    executor.dispose?.()
  }

  section('5. verdict=pass ⇒ 放行与屏障无关（TS 也不该被拦）')
  {
    const executor = makeExecutor({ launchMode: 'shim', verdict: 'pass' })
    const { result, error } = runGate(executor, READ_ONLY_CMD)
    check('TS + pass：只读命令放行', error === undefined && result?.allowed === true, error?.code ?? `allowed=${result?.allowed}`)
    check('TS + pass：没有 bypass 标记（走的是正常 pass 通道）', result?.bypassed === undefined, String(result?.bypassed))
    executor.dispose?.()
  }

  section('6. T0 / T1S 与 T1 同一判定：文本只读 + 内核屏障 ⇒ 放行')
  for (const [label, launchMode, expected] of [
    ['T0', 'appcontainer', WRITE_BARRIERS.APPCONTAINER],
    ['T1S', T1S_LAUNCH_MODE, WRITE_BARRIERS.RESTRICTED_TOKEN],
  ]) {
    const executor = makeExecutor({ launchMode })
    const { result, error } = runGate(executor, READ_ONLY_CMD)
    check(`${label}：只读命令放行且屏障=${expected}`, error === undefined && result?.writeBarrier === expected, error?.code ?? result?.writeBarrier)
    executor.dispose?.()
  }

  section('7. lane 产物：writeBarrier 必须可被用户看见（/winstage status 读同一份）')
  {
    const summary = summarizeLane({ launchMode: 'shim', tierEffective: 'TS', winStageEnabled: true, at: new Date().toISOString() })
    check('summarizeLane 报出 writeBarrier=user-mode-shim', summary.writeBarrier === WRITE_BARRIERS.SHIM, summary.writeBarrier)
    const summaryKernel = summarizeLane({ launchMode: 'restricted-token', tierEffective: 'T1', winStageEnabled: true })
    check('summarizeLane 报出 writeBarrier=kernel-restricted-token', summaryKernel.writeBarrier === WRITE_BARRIERS.RESTRICTED_TOKEN, summaryKernel.writeBarrier)
    const shellSource = readFileSync(join(HERE, '..', 'dsh-plugin', 'shell-executor.ts'), 'utf8')
    check('shell-executor 落盘 lane 时写 writeBarrier（同一纯函数 + tier）', /writeBarrier:\s*writeBarrierFor\(effectiveLane,\s*executor\.tierEffective\)/.test(shellSource), 'source-check')
  }

  section('8. 源码不变量：文本豁免不得复活（NeoAI 第 6 条不变量）')
  {
    const source = readFileSync(join(HERE, '..', 'src', 'executor.ts'), 'utf8')
    check('旧动作名 allowed-read-only-bypass 已从源码消失', !source.includes('allowed-read-only-bypass'))
    check('新动作名 allowed-kernel-write-barrier 存在', source.includes('allowed-kernel-write-barrier'))
    check('只读放行分支必须经过 isKernelWriteBarrier()', /if \(isKernelWriteBarrier\(writeBarrier\)\)/.test(source))
    check('新错误码 STAGING_WRITE_UNVERIFIED_NO_BARRIER 已导出', source.includes('export const STAGING_WRITE_UNVERIFIED_NO_BARRIER'))
    check('决策记录显式标注 readOnlyAdvisoryOnly', source.includes('readOnlyAdvisoryOnly: true'))
    // 反向证明：把 isKernelWriteBarrier(writeBarrier) 替换成恒真后，旧语义会回来 ⇒
    // 这条断言证明第 7/8 条检查不是"看字符串存在就算过"的空断言。
    const mutated = source.replace('if (isKernelWriteBarrier(writeBarrier)) {', 'if (true) {')
    check('变异体（恒真屏障）与源码不同 ⇒ 判据有判定力', mutated !== source)
  }
} finally {
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
    /* 清理尽力而为 */
  }
}

process.stdout.write('\n========================================================================\n')
process.stdout.write(`R44 写屏障判定：断言 ${assertions} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n`)
process.exitCode = failures === 0 ? 0 : 1
