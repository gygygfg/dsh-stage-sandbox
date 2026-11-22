/**
 * D0 补充：shell 失败分类矩阵 + 展示层改写性能预算。
 * 用法：node tests/shell-error-matrix.ts
 */
import { SHELL_FAILURE_CLASSIFICATION, classifyLaneFallback, redactStagedRoot } from '../dsh-plugin/shell-executor.ts'

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

const KNOWN = new Set(['command', 'environment', 'permission', 'network', 'internal', 'policy'])
process.stdout.write('=== shell-error-matrix ===\n')
const entries = Object.entries(SHELL_FAILURE_CLASSIFICATION)
ok(entries.length >= 10, '失败分类表非空', entries.length)
ok(entries.every(([, value]) => value && typeof value.category === 'string' && value.category.length > 0), '每条都有 category', JSON.stringify(entries.slice(0, 3)))
ok(entries.every(([, value]) => KNOWN.has(String(value.category))), 'category 都在已知集合内', JSON.stringify([...new Set(entries.map(([, v]) => v.category))]))
ok(entries.every(([code]) => /^(WINSTAGE_SHELL_[A-Z0-9_]+|CLEARTEXT_[A-Z0-9_]+)$/.test(code)), '错误码命名稳定（WINSTAGE_SHELL_* / CLEARTEXT_*）', entries.map(([k]) => k).slice(0, 5))

const fallbacks = [
  'transparent shim unavailable (probe failed) — fail-closed fallback to the restricted-token mode',
  'AppContainer unavailable: icacls failed',
  'unknown launch failure',
]
ok(fallbacks.every((reason) => Boolean(classifyLaneFallback(reason)?.code)), '回退分类对代表性原因有 code', JSON.stringify(fallbacks.map((r) => classifyLaneFallback(r))))

const started = Date.now()
const staged = 'C:\\Users\\u\\AppData\\Local\\Temp\\winstage-stage\\s\\staged'
const real = 'C:\\Users\\u\\Desktop\\proj'
for (let i = 0; i < 5000; i++) redactStagedRoot(`PWD=${staged}\\sub`, staged, real)
const elapsed = Date.now() - started
ok(elapsed < 500, 'redactStagedRoot 5000 次 < 500ms', `${elapsed}ms`)

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
