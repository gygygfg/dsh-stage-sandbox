// @ts-nocheck —— 辅助模块（`_` 前缀：不进 suite 注册表，供多个套件共用）。
/**
 * tests/_app-control.ts —— **环境能力探测**：本机是否由 OS Application Control 阻止
 * “运行时新生成的未签名 exe”。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 2026-10-22 本机启用 Smart App Control 强制态后，**运行时现场编译**的探针 exe 一律被
 * OS 拒绝：
 *
 *     CreateProcessW → Win32 4551 = "An Application Control policy has blocked this file"
 *
 * 受影响的是 5 个在套件内用 csc/zig 现编探针的套件（r20/r21/r22/r23/r27）。它们原来的
 * 判据把“探针跑不起来”读成产品失败（红），但**同一条 exe 在仓库外直接执行也被拒**，
 * 因此那是环境失败，不是被测代码的回归。
 *
 * 本模块只做一件事：把“环境是否阻止现场探针”变成**显式、可复现**的判定，让套件输出
 * `RESULT: SKIP … reason=smart-app-control-blocks-fresh-probes`（退出码 0），而不是
 * 伪装成 PASS，也不是把红留在关口里让人误以为产品坏了。
 *
 * 判定依据（只读）：
 *   `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`
 *   `VerifiedAndReputablePolicyState` = 1 （Smart App Control **强制**）
 *   = 0 关闭 / 2 评估；只有 1 会拦截。
 * 读不到（没有 reg.exe / 权限 / 非 Windows）⇒ **不跳过**（fail-open 到“照常跑”，
 * 因为无法证明环境受限；套件自己的判据仍然说了算）。
 *
 * 证据分层：本模块的 `[实测]` 只表示“在本机读到了该注册表值”；策略对某个具体 exe 的
 * 效果仍由套件在失败时打印的 Win32 4551 作为直接证据。
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCapturedToFiles } from '../src/executor.ts'

/** 读一次 Smart App Control 状态（纯环境探测；不写任何文件，除 fd 重定向临时文件）。 */
export function smartAppControlState() {
  if (process.platform !== 'win32') return { value: undefined, enforced: false, detected: false, detail: 'non-win32' }
  try {
    const result = runCapturedToFiles(
      'reg.exe',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
      { captureDir: join(tmpdir(), 'winstage-sac-probe'), timeoutMs: 15000 },
    )
    const text = `${result?.out ?? ''}\n${result?.err ?? ''}`
    const matched = /VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(text)
    if (!matched) return { value: undefined, enforced: false, detected: false, detail: text.slice(0, 160) }
    const value = Number.parseInt(matched[1], 16)
    return { value, enforced: value === 1, detected: true, detail: `VerifiedAndReputablePolicyState=${value}` }
  } catch (error) {
    return { value: undefined, enforced: false, detected: false, detail: `probe failed: ${error?.message ?? error}` }
  }
}

/**
 * 若本机 SAC 处于强制态，打印可机检的 SKIP 结论并返回 `true`；调用方应立即 `process.exit(0)`。
 * 返回 `false` 时调用方照常跑（非 Windows / SAC 未强制 / 状态读不到）。
 */
export function skipSuiteWhenAppControlBlocks(W, suiteName) {
  const state = smartAppControlState()
  if (!state.enforced) return false
  W('')
  W(`  ⊘ SKIP ${suiteName}：本机 Smart App Control 处于强制态（VerifiedAndReputablePolicyState=1）。`)
  W('    运行时现场编译的未签名探针 exe 会被 OS 拒绝：CreateProcessW → Win32 4551')
  W('    “An Application Control policy has blocked this file”。')
  W('    这不是产品回归（同一 exe 在仓库外直接执行同样被拒）。复跑条件：关闭 SAC，')
  W('    或对测试产物做受控签名 / 应用控制策略豁免（管理员）。')
  W('RESULT: SKIP checks=0 failures=0 skips=1 reason=smart-app-control-blocks-fresh-probes')
  return true
}
