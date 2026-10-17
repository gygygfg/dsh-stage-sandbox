// 探针（诊断用，不在引导链路上）：确定 asar 文件的绝对偏移公式（不同实现的基址不同）。
// 取一个已知是小文本文件的条目，逐个候选基址试读，哪个输出像 JSON 就是哪个。
//
// 用法：node scripts/vendor/asar-probe.mjs      （asar 路径可用 DSH_APP_ASAR 指定）
import { openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? ''
const CANDIDATES = [
  process.env.DSH_APP_ASAR,
  join(LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  join(LOCALAPPDATA, 'Programs', 'deepseek-harness', 'resources', 'app.asar'),
].filter(Boolean)
const ASAR = CANDIDATES.find((p) => existsSync(p))
if (!ASAR) { console.error('# 找不到 app.asar；用 DSH_APP_ASAR 指定'); process.exit(1) }
console.log(`# asar: ${ASAR}`)

const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(32)
readSync(fd, head, 0, 32, 0)
console.log('前 16 字节的 uint32:', [0, 4, 8, 12].map((i) => `${i}:${head.readUInt32LE(i)}`).join('  '))

let header = null
let jsonLen = 0
let jsonStart = 0
outer: for (const start of [16, 12, 8]) {
  for (const lenIdx of [12, 8]) {
    try {
      const n = head.readUInt32LE(lenIdx)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, start)
      const parsed = JSON.parse(buf.toString('utf8').replace(/\0+$/, ''))
      if (parsed?.files) { header = parsed; jsonLen = n; jsonStart = start; break outer }
    } catch { /* 继续试 */ }
  }
}
const target = header.files.dsh.files.node_modules.files['@deepseek-ai'].files.cordis.files['package.json']
console.log('cordis/package.json:', JSON.stringify({ size: target.size, offset: target.offset, unpacked: !!target.unpacked }))

const bases = {
  '0': 0,
  'jsonStart': jsonStart,
  'jsonStart+jsonLen': jsonStart + jsonLen,
  '8+jsonLen': 8 + jsonLen,
  '16+jsonLen': 16 + jsonLen,
  'jsonLen': jsonLen,
}
for (const [name, base] of Object.entries(bases)) {
  try {
    const pos = Number(target.offset) + base
    const b = Buffer.alloc(Math.min(target.size, 120))
    readSync(fd, b, 0, b.length, pos)
    const text = b.toString('utf8').replace(/[^\x20-\x7e]/g, '.')
    console.log(`  base=${name.padEnd(18)} pos=${pos} → ${JSON.stringify(text.slice(0, 70))}`)
  } catch (e) {
    console.log(`  base=${name.padEnd(18)} → 读取失败 ${e.message}`)
  }
}
closeSync(fd)
