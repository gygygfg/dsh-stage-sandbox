#!/usr/bin/env node
// @ts-nocheck —— 与其它测试同策略：机械落地、类型待补。
/**
 * R50 守护收养套件 —— 设置开关"写入被回滚"的根因回归
 * ============================================================================
 * 用户报障（2026-11-22，逐字）：
 *   「设置内快速关闭沙箱时：设置值未生效：已保留原值（本行被更高优先级层覆盖或被环境变量强制）」
 *   「本次开关未写入：设置通道拒绝了这次修改」
 *
 * 真实链路（本机证据）：
 *   1. 插件行在设置事务里被重建：`configEditor.edit` → `reconcileProfilePatches`
 *      → `EntryGroup.update()` 重新创建 `winstage-fs` 行；
 *   2. 新的一代 `Store` 走 `acquireStageGuard()`；如果它拿到的是"空的进程内表"
 *      （新模块实例）就会**再起一个守护**；
 *   3. 上一代守护仍以 `FILE_SHARE_READ` 持有哨兵 ⇒ 覆写失败
 *      ⇒ `sentinel-held-by-live-guard` ⇒ fs 行激活失败
 *      ⇒ `reconcileProfilePatches(requiredIds)` 抛错 ⇒ 设置层**写后回滚**
 *      （profile patch 的 mtime 变了、内容逐字没变 —— 正是用户看到的现象）
 *      ⇒ 客户端拿到 `ok:false` ⇒ 两句"未写入/未生效"。
 *   4. 另一个独立缺陷：守护在**退化轮询**路径只看父 pid。宿主退出后 pid 被复用，
 *      守护就永久钉住根（实测：18:02 起的守护到 18:22 仍活着，持有哨兵）。
 *
 * 本套件的判据（都是可复现的机器事实）：
 *   A. 只收养**本进程**派生的守护；别人的根一律 fail-closed（不静默接管）。
 *   B. "进程内表丢了"（模拟新模块实例）后再次 acquire ⇒ **收养同一个守护**
 *      （keeperPid 不变），绝不再起一个、也绝不抛 `sentinel-held-by-live-guard`。
 *   C. 引用计数：还有使用者时 release 只是让出名额（守护仍活、根仍在）；
 *      最后一个使用者释放才真正收尾。
 *   D. keeper 脚本钉住父进程身份校验（`ParentStart`），防 pid 复用导致的永久钉根。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  STAGE_GUARD_UNAVAILABLE,
  __internal,
  acquireStageGuard,
  releaseStageGuard,
  stageMarkerPath,
  verifyStageRootAlive,
} from '../src/stage-guard.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'winstage-guard-adopt-'))
const ROOT = join(SCRATCH, 'stage')

let assertions = 0
let failures = 0
function check(name, ok, detail) {
  assertions += 1
  if (ok) return
  failures += 1
  process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}
function readMarker() {
  try {
    return JSON.parse(readFileSync(stageMarkerPath(ROOT), 'utf8'))
  } catch {
    return undefined
  }
}

process.stdout.write('R50 stage guard 收养/引用计数（设置开关回滚根因）\n')

try {
  mkdirSync(ROOT, { recursive: true })

  // ── A. 没有守护时不得"收养" ───────────────────────────────────────────────
  check('A1 无守护的根不收养', __internal.adoptSameProcessGuard(ROOT) === undefined)
  check('A2 判定给出原因', __internal.adoptDecision(ROOT).reason === 'marker-missing', JSON.stringify(__internal.adoptDecision(ROOT)))

  if (process.platform !== 'win32') {
    process.stdout.write('  ⊘ SKIP 真实守护断言：非 win32（本机无 keeper 子进程）\n')
  } else {
    // ── B. 真实守护 + 模拟"新模块实例" ─────────────────────────────────────
    const first = acquireStageGuard(ROOT)
    const marker = readMarker()
    check('B1 守护已建立', Number(first.keeperPid) > 0, `keeperPid=${first.keeperPid}`)
    check('B2 标记 parentPid = 本进程', Number(marker?.parentPid) === process.pid, `marker.parentPid=${marker?.parentPid}`)
    check('B3 根被判活', verifyStageRootAlive(ROOT).alive === true, JSON.stringify(verifyStageRootAlive(ROOT)))
    check('B4 同进程可收养', __internal.adoptDecision(ROOT).adopt === true, JSON.stringify(__internal.adoptDecision(ROOT)))

    // 模拟新模块实例：进程内表清空（真实场景是 loader 用新 URL 重新 import 本模块）
    __internal.liveGuards.delete(ROOT)
    let second
    let threw
    try {
      second = acquireStageGuard(ROOT)
    } catch (error) {
      threw = error
    }
    check('B5 表丢失后再次 acquire 不抛', threw === undefined, threw === undefined ? '' : String(threw?.message))
    check('B6 收养同一个守护（keeperPid 不变）', second !== undefined && second.keeperPid === first.keeperPid,
      `before=${first.keeperPid} after=${second?.keeperPid}`)
    check('B7 收养不覆盖哨兵（根仍活）', verifyStageRootAlive(ROOT).alive === true)

    // ── A3. 别人的守护不收养（fail-closed） ────────────────────────────────
    const forge = { ...marker, parentPid: Number(process.pid) + 1 }
    writeFileSync(stageMarkerPath(ROOT), JSON.stringify(forge))
    const decision = __internal.adoptDecision(ROOT)
    check('A3 非本进程派生的守护不收养', decision.adopt === false && decision.reason === 'foreign-parent', JSON.stringify(decision))
    writeFileSync(stageMarkerPath(ROOT), JSON.stringify(marker))
    __internal.liveGuards.delete(ROOT)

    // ── C. 引用计数 ────────────────────────────────────────────────────────
    const g1 = acquireStageGuard(ROOT)
    const g2 = acquireStageGuard(ROOT)
    check('C1 同一根共享同一个 guard', g1 === g2)
    check('C2 两个使用者 ⇒ refCount=2', g1.refCount === 2, `refCount=${g1.refCount}`)
    const partial = releaseStageGuard(ROOT)
    check('C3 仍有使用者时 release 只让出名额', partial?.pending === true, JSON.stringify(partial))
    check('C4 让出后守护仍活', verifyStageRootAlive(ROOT).alive === true)
    const last = releaseStageGuard(ROOT)
    check('C5 最后一个使用者释放才收尾', last?.pending !== true, JSON.stringify(last))

    // ── D. keeper 脚本的父进程身份校验（静态钉住） ───────────────────────────
    const script = __internal.keeperScript({
      root: ROOT, sentinel: 's', marker: 'm', ready: 'r', errorFile: 'e', releaseFile: 'l', parentPid: process.pid, token: 't',
    })
    check('D1 keeper 记录父进程启动时间', script.includes('$ParentStart'))
    check('D2 轮询里比较启动时间（pid 复用即退出）', /\$p\.StartTime\s+-ne\s+\$ParentStart/.test(script))
  }
} finally {
  try { releaseStageGuard(ROOT, { force: true }) } catch { /* 尽力而为 */ }
  try { rmSync(SCRATCH, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
}

process.stdout.write('\n========================================================================\n')
process.stdout.write(`R50 守护收养/引用计数：断言 ${assertions} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n`)
process.exitCode = failures === 0 ? 0 : 1
