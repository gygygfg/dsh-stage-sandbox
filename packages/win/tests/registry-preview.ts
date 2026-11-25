// @ts-nocheck —— 与既有测试脚本一致：纯 node 断言，不参与 tsc 严格检查。
/**
 * 注册表值预览（`src/registry-preview.ts`）。
 *
 * 修复的缺陷：审阅行此前只有键名/值名/操作，没有**值数据**。于是
 * `HKCU\...\Run\EvalWinsec = cmd /c calc` 在审阅面上与"改了某个普通值"无法区分，
 * "批准"是在不知道会运行什么的情况下做出的。预览只用于展示；apply 仍重放冻结的
 * journal 字节，展示文本永不参与落盘。
 *
 * 用法：`node tests/registry-preview.ts`
 */
import { encodeRegistryValue } from '../src/registry-guard.ts'
import { previewRegistryValue } from '../src/registry-preview.ts'

let failures = 0
let assertions = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
}

process.stdout.write('=== 可解码类型 ===\n')
{
  const sz = encodeRegistryValue('REG_SZ', 'cmd /c calc')
  const preview = previewRegistryValue('REG_SZ', sz)
  check('REG_SZ 显示原字符串', preview.text === 'cmd /c calc', JSON.stringify(preview))

  const dword = encodeRegistryValue('REG_DWORD', 1)
  const d = previewRegistryValue('REG_DWORD', dword)
  check('REG_DWORD 显示数字', d.text === '1', JSON.stringify(d))

  const qword = encodeRegistryValue('REG_QWORD', 123456789n)
  const q = previewRegistryValue('REG_QWORD', qword)
  check('REG_QWORD 显示大整数', q.text === '123456789', JSON.stringify(q))

  const multi = encodeRegistryValue('REG_MULTI_SZ', ['a', 'b'])
  const m = previewRegistryValue('REG_MULTI_SZ', multi)
  check('REG_MULTI_SZ 用分号连接', m.text === 'a; b', JSON.stringify(m))

  const bin = encodeRegistryValue('REG_BINARY', Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  const b = previewRegistryValue('REG_BINARY', bin)
  check('REG_BINARY 显示十六进制', b.text === 'deadbeef', JSON.stringify(b))
  check('字节数按原始数据算', b.bytes === 4, JSON.stringify(b))
}

process.stdout.write('\n=== 敏感与截断 ===\n')
{
  const secret = previewRegistryValue('REG_SZ', encodeRegistryValue('REG_SZ', 'hunter2'), { sensitive: true })
  check('敏感值名只给长度', secret.redacted === true && secret.text === '[redacted len=16]', JSON.stringify(secret))

  const long = 'A'.repeat(500)
  const truncated = previewRegistryValue('REG_SZ', encodeRegistryValue('REG_SZ', long), { maxChars: 40 })
  check('超长值被截断并标注', truncated.text.includes('…') && truncated.note === 'truncated', JSON.stringify(truncated))

  const empty = previewRegistryValue('REG_SZ', '')
  check('空值显示 (empty)', empty.text === '(empty)', JSON.stringify(empty))

  const weird = previewRegistryValue('REG_UNKNOWN', '00112233')
  check('未知类型回退为 hex 并标注 undecodable', weird.note === 'undecodable' && weird.text === '00112233', JSON.stringify(weird))
}

process.stdout.write(`\n${assertions} 项断言，失败 ${failures} 项\n`)
process.exit(failures === 0 ? 0 : 1)
