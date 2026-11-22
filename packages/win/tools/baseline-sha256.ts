#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * tools/baseline-sha256.ts —— **源码基线封印**（provenance seal）
 * ============================================================================
 * 存在理由（为什么"git 干净"不能当证据）：
 *   本仓曾把 `.gitignore` 写成整体忽略 `tests/`，`src/limits.ts` 等源码也从未入版本库，
 *   而 `tools/` 同样是未跟踪目录。于是出现了两种**无法证伪的说法**：
 *     1) "只改了注释、行为一字未动" —— 没有基线，谁也无法复核这句话；
 *     2) "这个文件没被动过" —— 未跟踪文件的静默漂移在 `git status` 里**看不见**。
 *   **整理轮（测试套件入库）已把整个收录面纳入版本库**，但封印不因此作废：
 *   `git status` / `git diff` 只能说明"某个文件被改过"，说不出"这份清单是否仍覆盖
 *   全部收录面、覆盖的那一条是否还是当初封的那一版"。本文件把"哪些源/测试文件、
 *   各自是什么内容"冻成一份**有序哈希清单**：
 *     `docs/源码基线.sha256`（`sha256  <repo 相对路径>`，与 `sha256sum` 同格式）。
 *   它是一份**有意的封印**：改动清单里的任何文件都会让 `--check` 变红，直到有人
 *   **有意识地**重新生成清单 —— 而那次生成产生的 diff 就是"改了什么"的可复核记录。
 *
 * 收录范围（任务书给定，逐项对齐）：
 *   `src/*.mjs`、`tests/*.mjs`、`dsh-plugin/*.mjs`、`tools/*.mjs`
 *   加上根目录四个入口：`autotest.ts`、`verify.cmd`、`run.cmd`、`testservice.cmd`
 *
 * M1 收口追加（治理）：递归收录 src/ 与 tests/ 下的全部 .ts，以及 native/ 的
 *   源码/工程文件（c/h/cpp/cs/ps1/ts/inf/vcxproj/csproj）。此前这些文件落在
 *   “深度 1”收录面之外，改坏了 `git status` 看得见、封印却看不见。
 *   构建产物与 vendor 目录显式排除。
 *
 * R16 追加：`dsh-plugin/*.yml`（即 `dsh-plugin/cordis.patch.yml`）。
 *   理由（R16 实测，独立复核者发现）：该 yml 是**沙箱门控与装配的唯一真源**
 *   （`winstage-fs` / `winstage-shell` / `pwsh-sandbox` 三行的 `disabled` 表达式、
 *   `networkTier` 落点都在这里），但 R16 之前**不在任何封印面内**：
 *   `--check` 全绿 + 118 条**根本不含它**（0 条 `.yml`），`tests/dsh-patch-guard.ts`
 *   管的又是 DSH harness 安装文件、不是本仓这份 yml。⇒ "改门控不会红"是真实缺口。
 *   纳入后条数 118 → 119（见 docs/round16/汇总报告.md 的修复清单）。
 * 排除：清单自身，以及 `.t/`、`node_modules/`、`shim/`、`esc/`、`filemod/`、`retest/`、`.dshstage/`
 *   下的任何东西；`tools/lib`、`tools/toolchain` 这类子目录**不在** `tools/*.mjs` 的深度内
 *   （这是"深度 1"这一给定范围的自然结果，已作为残余写明）。
 *
 * 退出码：0 = 一致 / 1 = 用法错误 / 2 = 清单缺失 / 4 = 漂移
 *
 * 用法：
 *   node tools\baseline-sha256.ts --check     # 校验（漂移即红，并打印逐条修复指令）
 *   node tools\baseline-sha256.ts --write     # 重新生成清单（这是"有意识刷新"的唯一入口）
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_REL = 'docs/源码基线.sha256'
export const MANIFEST_PATH = join(REPO, MANIFEST_REL)

/**
 * 收录面。两种形状：
 *   · `dir/*.ext`       —— 单层目录（历史口径，深度 1）
 *   · `dir/**\/*.ext`   —— 递归（整理轮新增，用于 e2e/ 这类分层测试台）
 * 新增收录面时**改这里**（以及 tests/baseline-integrity.ts 的形状断言）。
 */
export const INCLUDED_GLOBS = Object.freeze([
  'dsh-plugin/*.ts',
  'plugin/*.ts',
  'dsh-plugin/*.yml',
  'tools/*.ts',
  'e2e/**/*.ts',
  // M1 收口（治理）：NT 控制面与原生数据面此前只在“深度 1”之外，改坏了没有基线可比。
  // 递归收录面按**扩展名**逐类列出（工具只支持 `dir/**/*.ext` 形状），
  // 并排除构建产物/第三方 vendored 源（见 EXCLUDED_DIRS）。
  // 用 `**` 而不是 `dir/nt/*.ts`：工具只支持 `<dir>/*.ext` 与 `<dir>/**/*.ext` 两种形状。
  // 注意 `**` 也包含该目录的第一层文件，因此它**替代**了原来的 `src/*.ts` / `tests/*.ts`
  // （同时保留两者会让每个文件在清单里出现两次）。
  // 形状断言（tests/baseline-integrity.ts）仍只允许 `src/nt/`、`tests/nt/` 这些
  // 显式递归面；若以后出现 `src/<其它子目录>`，收集器会收进来并让形状断言变红。
  'src/**/*.ts',
  'tests/**/*.ts',
  'native/**/*.c',
  'native/**/*.h',
  'native/**/*.cpp',
  'native/**/*.cs',
  'native/**/*.ps1',
  'native/**/*.ts',
  'native/**/*.inf',
  'native/**/*.vcxproj',
  'native/**/*.csproj',
])
/** 收录的根目录单个文件。 */
export const INCLUDED_ROOT_FILES = Object.freeze(['autotest.ts', 'verify.cmd', 'run.cmd', 'testservice.cmd'])
/** 排除的目录名（任意层级都排除；本清单的收录面是深度 1，这里仍做段级过滤以免范围被误改宽）。 */
export const EXCLUDED_DIRS = Object.freeze([
  '.t',
  'node_modules',
  'shim',
  'esc',
  'filemod',
  'retest',
  '.dshstage',
  // 构建产物与第三方 vendored 源：不是本仓维护的代码，不进封印。
  // native/provider/{obj,bin,out} 合计约 190 MB；vendor 是 ProjectedFSLib.Managed。
  'vendor',
  'obj',
  'bin',
  'out',
  'pkg',
  'x64',
])

export const EXIT = Object.freeze({ OK: 0, USAGE: 1, MISSING: 2, DRIFT: 4 })

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * 封印哈希前把文本行尾统一成 LF。
 *
 * 为什么需要：`.gitattributes` 对 `.ps1`/`.cmd` 指定 `eol=crlf`，对 `.ts` 指定
 * `eol=lf`；但工作树里同一份文件可能是 LF（例如刚由工具写入）或 CRLF（fresh
 * checkout）。封印要钉的是**内容**，不是平台换行；否则“换一台机器 checkout”
 * 就会让整个关口变红，而真正的改动反而被噪声淹没。
 *
 * 只对含 CR 的字节做一次 UTF-8 往返；二进制文件不在收录面内。
 */
export function normalizeSealBuffer(buffer) {
  if (!buffer.includes(0x0d)) return buffer
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

/** 仓库相对路径一律用 `/`，保证清单与平台无关、可比对。 */
const toPosix = (path) => path.split('\\').join('/')

/**
 * 枚举当前磁盘上的受封印文件。
 * @returns {Array<{path:string, sha256:string, bytes:number}>} 按路径**字典序**排序
 */
export function collectEntries() {
  const entries = []
  for (const glob of INCLUDED_GLOBS) {
    const recursive = glob.includes('/**/')
    let dir, pattern
    if (recursive) {
      dir = glob.slice(0, glob.indexOf('/**/'))
      pattern = glob.slice(glob.indexOf('/**/') + 4) // 去掉 '<dir>/**/'
    } else {
      ;[dir, pattern] = glob.split('/')
    }
    // 收录面是"目录 + 固定后缀"；只支持 `*.` 形状，遇到别的形状直接抛（不静默漏收）。
    if (!pattern.startsWith('*.')) throw new Error(`不支持的收录形状: ${glob}`)
    const suffix = pattern.slice(1)
    const absolute = join(REPO, dir)
    if (!existsSync(absolute)) continue
    const names = recursive ? walkFiles(absolute) : readdirSync(absolute)
    for (const rel of names) {
      const name = recursive ? rel : rel
      if (!name.endsWith(suffix)) continue
      const relPath = recursive ? `${dir}/${rel}` : `${dir}/${name}`
      if (isExcluded(relPath)) continue
      const full = recursive ? join(absolute, rel) : join(absolute, name)
      if (!statSync(full).isFile()) continue
      const buffer = readFileSync(full)
      entries.push({ path: relPath, sha256: sha256(normalizeSealBuffer(buffer)), bytes: buffer.length })
    }
  }
  for (const name of INCLUDED_ROOT_FILES) {
    const rel = name
    if (isExcluded(rel)) continue
    const full = join(REPO, name)
    if (!existsSync(full) || !statSync(full).isFile()) continue
    const buffer = readFileSync(full)
    entries.push({ path: rel, sha256: sha256(normalizeSealBuffer(buffer)), bytes: buffer.length })
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return entries
}

/** 递归列出目录下所有文件的**相对路径**（相对给定 dir，使用 `/`）。 */
function walkFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue
      out.push(...walkFiles(join(dir, entry.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

/** 段级排除（清单自身也排除）。 */
export function isExcluded(relPath) {
  const posix = toPosix(relPath)
  if (posix === MANIFEST_REL) return true
  return posix.split('/').some((segment) => EXCLUDED_DIRS.includes(segment))
}

/**
 * 渲染清单文本（LF、UTF-8、无 BOM，与 `sha256sum` 同格式：`<hash>  <path>`）。
 * @param {Array<{path:string, sha256:string}>} entries
 */
export function renderManifest(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`
}

/**
 * 解析清单文本。
 * 格式错误（不是 `<64 位十六进制><两个空格><路径>`）**不静默忽略**：收进 malformed 里由调用方判红。
 * @returns {{map:Map<string,string>, malformed:string[]}}
 */
export function parseManifest(text) {
  const map = new Map()
  const malformed = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(raw)
    if (match === null) {
      malformed.push(raw)
      continue
    }
    map.set(toPosix(match[2]), match[1])
  }
  return { map, malformed }
}

/**
 * 比对"磁盘现状"与"清单记录"。
 * @param {Array<{path:string,sha256:string}>} entries 磁盘现状
 * @param {string} manifestText 清单文本
 * @returns {{ok:boolean, changed:string[], added:string[], removed:string[], malformed:string[]}}
 */
export function diffManifest(entries, manifestText) {
  const { map, malformed } = parseManifest(manifestText)
  // 只翻一位的扰动（`--plant` 的常态）用前 12 位看不出来，因此尾巴也标出来。
  const brief = (hash) => `${hash.slice(0, 12)}…${hash.slice(-4)}`
  const changed = []
  const added = []
  const removed = []
  for (const entry of entries) {
    const recorded = map.get(entry.path)
    if (recorded === undefined) added.push(entry.path)
    else if (recorded !== entry.sha256) changed.push(`${entry.path}（清单 ${brief(recorded)} / 磁盘 ${brief(entry.sha256)}）`)
  }
  const onDisk = new Set(entries.map((entry) => entry.path))
  for (const path of map.keys()) if (!onDisk.has(path)) removed.push(path)
  return { ok: changed.length === 0 && added.length === 0 && removed.length === 0 && malformed.length === 0, changed, added, removed, malformed }
}

/** 读清单文本；不存在返回 undefined（调用方决定"跳过"还是"报错"）。 */
export function readManifestText() {
  return existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : undefined
}

export function remediation() {
  return [
    '修复步骤（有意识刷新，清单 diff 就是复核记录）：',
    '  1) node tools\\baseline-sha256.ts --write',
    '  2) 复核 docs\\源码基线.sha256 的 diff —— 每一行变化都应能对应到一次你**确实想做**的源码/测试改动',
    '  3) 再跑 node tools\\baseline-sha256.ts --check（以及整仓关口 verify.cmd）',
  ].join('\n')
}

function reportAndExit() {
  const entries = collectEntries()
  const text = readManifestText()
  if (text === undefined) {
    process.stderr.write(`[基线缺失] 找不到 ${MANIFEST_REL}；这是"未封印"，不是"通过"。\n  修复: node tools\\baseline-sha256.ts --write\n`)
    return EXIT.MISSING
  }
  const diff = diffManifest(entries, text)
  if (diff.ok) {
    process.stdout.write(`基线一致：${entries.length} 个受封印文件与 ${MANIFEST_REL} 逐条相符\n`)
    return EXIT.OK
  }
  process.stdout.write('✗ 源码基线漂移（受封印文件与清单不符）：\n')
  for (const line of diff.changed) process.stdout.write(`  ~ 内容变化 ${line}\n`)
  for (const line of diff.added) process.stdout.write(`  + 清单缺失 ${line}\n`)
  for (const line of diff.removed) process.stdout.write(`  - 已不存在 ${line}\n`)
  for (const line of diff.malformed) process.stdout.write(`  ! 清单格式非法 ${JSON.stringify(line)}\n`)
  process.stdout.write(`\n${remediation()}\n`)
  return EXIT.DRIFT
}

function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('用法: node tools\\baseline-sha256.ts [--check|--write]\n退出码: 0 一致 / 1 用法 / 2 清单缺失 / 4 漂移\n')
    return EXIT.OK
  }
  if (args.includes('--write')) {
    const entries = collectEntries()
    writeFileSync(MANIFEST_PATH, renderManifest(entries), 'utf8')
    process.stdout.write(`已写入 ${MANIFEST_REL}：${entries.length} 条（LF/UTF-8/无 BOM；格式与 sha256sum 一致）\n`)
    return EXIT.OK
  }
  if (args.includes('--check') || args.length === 0) return reportAndExit()
  process.stderr.write(`未知参数: ${args.join(' ')}\n用法: node tools\\baseline-sha256.ts [--check|--write]\n`)
  return EXIT.USAGE
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = main(process.argv)
