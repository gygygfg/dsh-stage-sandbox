#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R21 新登记套件。
/**
 * build-shim-help —— **工具链回归**：`node tools/build-shim.ts --help` 必须是**纯 usage 路径**。
 *
 * 存在理由（R19 证据缺口 → R21 收口）：
 *   旧实现把未知参数（包括 `--help`）放进 `args` Set 后忽略，于是"只是想看用法"会直接进入
 *   main() 的完整构建路径，把 canonical `shim/out` 三件套重建/覆盖。实测（R21 修复前）：
 *   `node tools/build-shim.ts --help` 打印 build 日志并改写 `shim/out/winstage-shim.dll` 的
 *   mtime/字节（canonical hash 漂移）。这违反"问用法不得改动交付物"。
 *
 * 本套件用**行为**钉住修复（不采信源码文本）：
 *   A. `--help` / `-h` 退出码 0，输出含 usage 与 exit codes，且**不打印任何 build 日志**；
 *   B. 运行前后 canonical `shim/out` 的文件清单/大小/mtime 逐项不变（含产物缺失时不得被创建）；
 *   C. 静态守卫：help 分支必须在 main()/toolchain 解析之前（`--help` 出现在 `function main(` 之前）。
 *
 * 依赖：node 可执行、仓库内 `tools/build-shim.ts`；不需要 zig 工具链（help 路径不应触碰它）。
 *
 * 用法：`node tests\build-shim-help.ts`；`--plant` 变异体（只扰动测试侧判定）应当见红。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLANT = process.argv.includes('--plant')
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const OUT = join(REPO, 'shim', 'out')
const BUILD = join(REPO, 'tools', 'build-shim.ts')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}\n      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}
const short = (value, n = 260) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/** canonical 产物树快照：相对路径 -> "size|mtimeMs"。目录不存在 = 空快照。 */
function snapshotOut() {
  const map = {}
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const st = statSync(full)
      map[relative(OUT, full).replaceAll('\\', '/')] = `${st.size}|${Math.trunc(st.mtimeMs)}`
    }
  }
  walk(OUT)
  return map
}

function diffSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(`${key}: ${before[key] ?? '(missing)'} -> ${after[key] ?? '(missing)'}`)
  }
  return changed
}

function runHelp(arg) {
  const result = spawnSync(process.execPath, [BUILD, arg], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

section('A. 行为：--help / -h 是纯 usage 路径（不构建、不改 canonical）')
if (!existsSync(BUILD)) {
  skip('build-shim.ts 存在', `缺少 ${BUILD}`)
} else {
  const before = snapshotOut()
  check('A.1 前置：canonical shim/out 快照可取（可为空 = 尚未构建）', typeof before === 'object', `files=${Object.keys(before).length}`)

  const help = PLANT ? { status: 1, stdout: '', stderr: 'planted' } : runHelp('--help')
  check(
    'A.2 `--help` 退出码 0（help 不是 usage error；2 保留给坏参数）',
    help.status === 0,
    `status=${help.status} stderr=${short(help.stderr, 120)}`,
  )
  check(
    'A.3 `--help` 输出 usage 与 exit codes（不是构建日志）',
    /usage: node tools\/build-shim\.ts/.test(help.stdout) &&
      /--out-dir/.test(help.stdout) &&
      /exit codes: 0 = ok/i.test(help.stdout) &&
      /\[build-shim\] building/.test(help.stdout) === false,
    short(help.stdout, 300),
  )

  const afterHelp = snapshotOut()
  const changedHelp = diffSnapshots(before, afterHelp)
  if (PLANT) changedHelp.push('(planted) canonical must appear changed')
  check(
    'A.4 `--help` 前后 canonical shim/out 字节面逐项不变（mtime/大小/清单）',
    changedHelp.length === 0,
    changedHelp.join(' | ') || `files=${Object.keys(afterHelp).length}`,
  )

  const shortHelp = PLANT ? { status: 1, stdout: '', stderr: 'planted' } : runHelp('-h')
  const afterShort = snapshotOut()
  const changedShort = diffSnapshots(before, afterShort)
  check(
    'A.5 `-h` 同样退出 0、输出 usage、canonical 不变',
    shortHelp.status === 0 && /usage: node tools\/build-shim\.ts/.test(shortHelp.stdout) && changedShort.length === 0,
    `status=${shortHelp.status} changed=${changedShort.join('|') || '(none)'}`,
  )
}

section('B. 静态守卫：help 分支在构建/toolchain 之前')
{
  const source = existsSync(BUILD) ? readFileSync(BUILD, 'utf8') : ''
  const helpAt = source.indexOf("args.has('--help')")
  const mainAt = source.indexOf('function main()')
  const zigAt = source.indexOf('function resolveZig()')
  check('B.1 源码里存在 help 分支（`--help`/`-h`）', helpAt >= 0, `helpAt=${helpAt}`)
  check(
    'B.2 help 分支在 main()/resolveZig() 之前（否则仍可能先构建）',
    helpAt >= 0 && mainAt > 0 && zigAt > 0 && helpAt < mainAt && helpAt < zigAt,
    `helpAt=${helpAt} mainAt=${mainAt} resolveZigAt=${zigAt}`,
  )
  check(
    'B.3 help 分支调用 process.exit(0) 且在分支内不出现 buildOne/resolveZig 调用',
    helpAt >= 0 &&
      (() => {
        const branch = source.slice(helpAt, source.indexOf('\n}', helpAt) + 2)
        return /process\.exit\(0\)/.test(branch) && !/buildOne\(/.test(branch) && !/resolveZig\(/.test(branch)
      })(),
    'branch-inspection',
  )
}

W('')
W('='.repeat(64))
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${verdict} checks=${assertions} failures=${failures} skips=${skips}${PLANT ? ' mode=plant' : ''}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
