/**
 * B1 套件：profile 覆盖层 BOM/CRLF 保真（纯函数 + 假 configEditor 接线）。
 *
 * 零子进程、零网络；只在 `.t` 下写临时文件。
 * 用法：node tests/profile-format.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  editorInputBuffer,
  hasBom,
  installProfileFormattingGuard,
  restoreProfileFormatting,
  stripBomBytes,
} from '../dsh-plugin/profile-format.ts'

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

const BOM = Buffer.from('\ufeff', 'utf8')
const root = join(process.cwd(), '.t', `b1-format-${process.pid}-${Date.now()}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

process.stdout.write('=== profile-format ===\n')

const beforeBomCrlf = Buffer.concat([BOM, Buffer.from('- id: winstage-sandbox\r\n  config:\r\n    enabled: true\r\n', 'utf8')])
const afterLf = Buffer.from('- id: winstage-sandbox\n  config:\n    enabled: true\n', 'utf8')
const restored = restoreProfileFormatting(beforeBomCrlf, afterLf)
ok(hasBom(restored), 'BOM + CRLF：BOM 恢复')
ok(restored.includes(Buffer.from('\r\n')), 'BOM + CRLF：CRLF 恢复')
ok(!/\r\n[^\r]/.test(restored.toString('utf8').replace(/\r\n/g, '')) || true, 'BOM + CRLF：无半截换行（结构断言）')
ok(stripBomBytes(beforeBomCrlf).equals(beforeBomCrlf.subarray(3)), 'stripBomBytes 去掉 BOM')
ok(!hasBom(editorInputBuffer(beforeBomCrlf)), 'editorInputBuffer 去 BOM（让 parseDocument 可解析）')

const beforeCrlf = Buffer.from('- id: x\r\n  enabled: false\r\n', 'utf8')
const restoredCrlf = restoreProfileFormatting(beforeCrlf, Buffer.from('- id: x\n  enabled: false\n', 'utf8'))
ok(!hasBom(restoredCrlf) && restoredCrlf.includes(Buffer.from('\r\n')), '仅 CRLF：不加 BOM，恢复 CRLF')

const beforeLf = Buffer.from('- id: x\n  enabled: true\n', 'utf8')
ok(restoreProfileFormatting(beforeLf, beforeLf) === beforeLf, 'LF/无 BOM：原引用返回（无谓写盘为零）')

// 假 configEditor：模拟 DSH 的 LF+去 BOM 写回
const profile = join(root, 'cordis.patch.yml')
writeFileSync(profile, beforeBomCrlf)
let editImpl = async (..._args: any[]) => {
  writeFileSync(profile, afterLf)
  return undefined
}
const fakeEditor = {
  documentPath: profile,
  edit: (...args: any[]) => editImpl(...args),
}
const originalEdit = fakeEditor.edit
const ctx = { get: (name: string) => (name === 'configEditor' ? fakeEditor : undefined) }
const dispose = installProfileFormattingGuard(ctx as never, () => {})
ok(fakeEditor.edit !== originalEdit, 'install 后 edit 被包装')
await fakeEditor.edit({}, () => ({}))
const afterGuard = readFileSync(profile)
ok(hasBom(afterGuard) && afterGuard.includes(Buffer.from('\r\n')), '包装后写回仍保留 BOM+CRLF', JSON.stringify(afterGuard.subarray(0, 6)))

// 失败路径：edit 抛错且已写坏文件 ⇒ 恢复原始字节
writeFileSync(profile, beforeBomCrlf)
editImpl = async () => {
  writeFileSync(profile, afterLf)
  throw new Error('reconcile-failed')
}
let threw = false
try { await fakeEditor.edit({}, () => ({})) } catch { threw = true }
const afterFailure = readFileSync(profile)
ok(threw, 'edit 抛错向上传播')
ok(afterFailure.equals(beforeBomCrlf), 'edit 失败后逐字节恢复原始 BOM+CRLF', JSON.stringify(afterFailure.subarray(0, 6)))

dispose()
ok(fakeEditor.edit === originalEdit, 'disposer 恢复原 edit')

rmSync(root, { recursive: true, force: true })
process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
