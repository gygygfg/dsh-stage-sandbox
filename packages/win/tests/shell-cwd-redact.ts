/**
 * D0/C3 辅助套件：模型可见输出里的暂存根改写。
 * 用法：node tests/shell-cwd-redact.ts
 */
import { redactStagedRoot } from '../dsh-plugin/shell-executor.ts'

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

const staged = 'C:\\Users\\u\\AppData\\Local\\Temp\\winstage-stage\\session-1\\staged'
const real = 'C:\\Users\\u\\Desktop\\proj'
process.stdout.write('=== shell-cwd-redact ===\n')
ok(redactStagedRoot(`PWD=${staged}`, staged, real) === `PWD=${real}`, '精确根替换')
ok(redactStagedRoot(`PWD=${staged}\r\n`, staged, real) === `PWD=${real}\r\n`, '保留 CRLF')
ok(redactStagedRoot(`x=${staged}\\sub\\a.txt`, staged, real) === `x=${real}\\sub\\a.txt`, '子路径替换')
ok(redactStagedRoot(`C:\\USERS\\U\\APPDATA\\LOCAL\\TEMP\\WINSTAGE-STAGE\\SESSION-1\\STAGED`, staged, real) === real, '大小写不敏感')
ok(redactStagedRoot('no staged path', staged, real) === 'no staged path', '无命中不改')
ok(redactStagedRoot(undefined, staged, real) === undefined, '非字符串原样返回')
ok(redactStagedRoot('x', '', real) === 'x' && redactStagedRoot('x', staged, '') === 'x', '缺根不猜')

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
