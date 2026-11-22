#!/usr/bin/env node
/**
 * R34 npm 只读探针：在 WinStage shell 里读 npm 版本/CA/缓存配置，不写缓存、不联网。
 * 用法：node packages/win/e2e/r49/r34-npm.mjs
 */
import path from 'node:path'
import os from 'node:os'
import { Server } from './approval-thread.mjs'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 1000)}`}\n`)
}
const R48 = path.join(os.tmpdir(), 'r48-e2e', '20261119-225616')
const HOME = path.join(R48, 'home-on')
const WS = path.join(R48, 'workspace')
const script = [
  '$ErrorActionPreference="Continue"',
  'npm --version',
  'npm config get cafile',
  'npm config get cache',
  'if ($LASTEXITCODE -eq 0) { "R34-NPM-OK" } else { "R34-NPM-FAIL" }',
].join('\n')
const prompt = [
  'Call the pwsh tool exactly once with this exact script (do not modify it).',
  'Return its stdout/stderr verbatim. Then answer exactly DONE.',
  '```powershell',
  script,
  '```',
].join('\n')

async function main() {
  process.stdout.write('=== R34 npm E2E ===\n')
  const server = new Server({ home: HOME, profile: 'on', workspace: WS, shell: '1' })
  try {
    await server.start()
    process.stdout.write(`server=${server.base}\n`)
    const sessionId = await server.newSession()
    await server.prompt(sessionId, prompt)
    await server.waitForTurn(sessionId, 240000)
    const turn = await server.readTurn(sessionId)
    const text = turn.results.map((r) => r.text).join('\n')
    process.stdout.write(`${text.slice(-2000)}\n`)
    check('NPM-OK', /R34-NPM-OK/.test(text), text.slice(-1200))
    check('NO-PERMISSION-ERROR', !/PermissionError|Errno 13|Access is denied|EACCES/i.test(text), text.slice(-1200))
    check('NO-TURN-ERROR', turn.errors.length === 0, JSON.stringify(turn.errors))
  } finally {
    await server.stop()
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failures=${failed}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`\nFATAL: ${error?.stack ?? error}\n`)
  process.exit(1)
})
