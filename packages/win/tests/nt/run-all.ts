/**
 * 运行全部 `tests/nt/*.ts` 控制面单测（每个套件独立子进程，避免 harness 计数串味）。
 *
 * 用法：`node tests/nt/run-all.ts`（Linux/Windows 均可；不需要 Windows 驱动）。
 *
 * @module winstage-sandbox/tests/nt/run-all
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKIP = new Set(['harness.ts', 'run-all.ts'])
const suites = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts') && !SKIP.has(name) && !name.startsWith('_'))
  .sort()

let failed = 0
for (const suite of suites) {
  process.stdout.write(`\n########## ${suite} ##########\n`)
  const result = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' })
  if (result.error !== undefined) {
    failed += 1
    process.stdout.write(`  ✗ 无法启动 ${suite}: ${String(result.error)}\n`)
  } else if (result.status !== 0) {
    failed += 1
  }
}

process.stdout.write(`\n${'='.repeat(72)}\n`)
process.stdout.write(`nt 控制面套件：${suites.length} 个，失败 ${failed} 个\n`)
process.stdout.write(`RESULT: ${failed === 0 ? 'ALL PASS' : 'FAIL'}\n`)
process.exitCode = failed === 0 ? 0 : 1
