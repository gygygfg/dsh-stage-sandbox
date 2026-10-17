// 从 DSH 自带的 app.asar 里按**依赖闭包**提取 @deepseek-ai 私有包到 `.dsh-vendor/node_modules`。
// 只读 asar + 只写 `.dsh-vendor/`；不改仓库任何源码文件。
//
// 背景：仓库依赖的 `@deepseek-ai/dsh-*` 全部不在公共 registry（实测 npmjs / npmmirror 均 404），
// 而 DSH 安装目录的 `resources/app.asar` 里就带了一份完整的运行时依赖树
// （`dsh/node_modules/@deepseek-ai/` 共 289 个包）。本脚本把它们取出，供 pnpm / tsc / node 解析。
//
// 用法：node scripts/vendor/asar-extract.mjs [--dry]
//   asar 路径可由环境变量 `DSH_APP_ASAR` 指定；否则按下列候选顺序自动探测。
import { openSync, readSync, closeSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DEST = join(ROOT, '.dsh-vendor', 'node_modules')
const DRY = process.argv.includes('--dry')

// ── 0. 定位 DSH 的 app.asar ──────────────────────────────────────────────────
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const CANDIDATES = [
  process.env.DSH_APP_ASAR,
  join(LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  join(LOCALAPPDATA, 'Programs', 'deepseek-harness', 'resources', 'app.asar'),
  join(LOCALAPPDATA, 'deepseek-harness', 'resources', 'app.asar'),
].filter(Boolean)

const ASAR = CANDIDATES.find((p) => existsSync(p))
if (!ASAR) {
  console.error('# 找不到 DSH 的 app.asar。已尝试：\n' + CANDIDATES.map((c) => `  · ${c}`).join('\n'))
  console.error('# 请用环境变量指定：set DSH_APP_ASAR=<...\\resources\\app.asar>')
  process.exit(1)
}
const UNPACKED = `${ASAR}.unpacked`
console.log(`# asar: ${ASAR}`)

// ── 1. 解析 asar 头部 ────────────────────────────────────────────────────────
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(32)
readSync(fd, head, 0, 32, 0)
let header = null
let jsonStartFound = 16
let jsonLenFound = 0
outer: for (const start of [16, 12, 8]) {
  for (const lenIdx of [12, 8]) {
    try {
      const jsonLen = head.readUInt32LE(lenIdx)
      if (!Number.isFinite(jsonLen) || jsonLen < 16 || jsonLen > 64 * 1024 * 1024) continue
      const buf = Buffer.alloc(jsonLen)
      readSync(fd, buf, 0, jsonLen, start)
      const parsed = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''))
      if (parsed?.files) { header = parsed; jsonStartFound = start; jsonLenFound = jsonLen; break outer }
    } catch { /* 试下一组 */ }
  }
}
if (!header) { closeSync(fd); console.error('asar 头部解析失败'); process.exit(1) }

const nm = header.files?.dsh?.files?.node_modules?.files
if (!nm) { closeSync(fd); console.error('asar 里没有 dsh/node_modules'); process.exit(1) }
const scope = nm['@deepseek-ai']?.files ?? {}

// ★ 关键：头部里记的 `offset` 是**相对数据区起点**的，不是相对文件开头。
//   数据区起点 = jsonStart + jsonLen（本 asar 实测 16 + 3392048；见 asar-probe.mjs）。
//   少了这个基址就读到**错位字节**（曾把 cordis/package.json 写成一段注释的片段）。
const BASE = jsonStartFound + jsonLenFound
console.log(`# asar 头部：jsonStart=${jsonStartFound} jsonLen=${jsonLenFound} ⇒ 数据区基址 ${BASE}`)

// ── 2. 读取 asar 内的一个文件（packed）／联动 unpacked 目录 ────────────────────
function readEntry(node, asarPathParts) {
  if (node.files) return null
  if (node.unpacked) {
    // `unpacked:true` ⇒ 实体在 app.asar.unpacked/<同名路径> 下
    const rel = join('dsh', ...asarPathParts)
    return existsSync(join(UNPACKED, rel)) ? 'UNPACKED' : null
  }
  const buf = Buffer.alloc(node.size)
  readSync(fd, buf, 0, node.size, Number(node.offset) + BASE)
  return buf
}

// ── 3. 计算依赖闭包（只在 @deepseek-ai 作用域内做传递闭包）─────────────────────
const ROOTS = [
  // packages/win
  'cordis', 'dsh-commands', 'dsh-fs', 'dsh-fs-local', 'dsh-fs-sandbox', 'dsh-pwsh-sandbox',
  'dsh-sandbox', 'dsh-sandbox-policy', 'dsh-session', 'dsh-shell', 'dsh-storage',
  'dsh-subprocess', 'dsh-subprocess-local', 'dsh-util-values', 'dsh-web', 'schemastery',
  // packages/linux 额外需要的
  'dsh-approval', 'dsh-bash-local', 'dsh-bash-sandbox', 'dsh-brand', 'dsh-llm', 'node-addon-system',
]
const closure = new Set()
const missing = new Set()
const queue = [...ROOTS]
while (queue.length > 0) {
  const name = queue.pop()
  if (closure.has(name) || missing.has(name)) continue
  const node = scope[name]
  if (!node) { missing.add(name); continue }
  closure.add(name)
  const pkgJsonNode = node.files?.['package.json']
  if (!pkgJsonNode) continue
  let pkg
  try { pkg = JSON.parse(readEntry(pkgJsonNode, ['node_modules', '@deepseek-ai', name, 'package.json']).toString('utf8')) }
  catch { continue }
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (dep.startsWith('@deepseek-ai/')) {
      const bare = dep.slice('@deepseek-ai/'.length)
      if (scope[bare] && !closure.has(bare)) queue.push(bare)
    }
  }
}

console.log(`# 闭包大小：${closure.size} 个 @deepseek-ai 包${missing.size ? `；缺失 ${[...missing].join(', ')}` : ''}`)

// ── 4. 抽取 ──────────────────────────────────────────────────────────────────
let bytes = 0
let files = 0
function extractDir(node, destDir, parts) {
  mkdirSync(destDir, { recursive: true })
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const childParts = [...parts, name]
    if (child.files) {
      extractDir(child, join(destDir, name), childParts)
    } else if (child.link) {
      // 符号链接：Windows 上落地为真文件很危险（可能指向 asar 内路径），跳过并记录
      continue
    } else {
      const data = readEntry({ ...child, size: child.size }, ['node_modules', '@deepseek-ai', ...childParts])
      if (data === null) continue
      if (DRY) { bytes += child.size ?? 0; files += 1; continue }
      if (data === 'UNPACKED') continue
      writeFileSync(join(destDir, name), data)
      files += 1
      bytes += data.length
    }
  }
}

for (const name of [...closure].sort()) {
  const dest = join(DEST, '@deepseek-ai', name)
  extractDir(scope[name], dest, [name])
}
closeSync(fd)
console.log(`# ${DRY ? '预计' : '已写'} ${files} 个文件 / ${(bytes / 1024 / 1024).toFixed(1)} MB → ${DEST}`)
console.log(`# 落地的包：\n${[...closure].sort().join('\n')}`)
