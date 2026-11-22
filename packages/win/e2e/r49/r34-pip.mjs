#!/usr/bin/env node
/**
 * R34-P1 E2E：在 WinStage shell（T0/AppContainer）里让 pip 读 CA 并拉一个 wheel。
 * 目的：验证 toolchainReadRoots() 的 Python 目录 RX 授权确实让 pip 不再 EACCES。
 *
 * 用法：node packages/win/e2e/r49/r34-pip.mjs
 */
import path from 'node:path'
import os from 'node:os'
import { Server } from './approval-thread.mjs'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 1200)}`}\n`)
}
const R48 = path.join(os.tmpdir(), 'r48-e2e', '20261119-225616')
const HOME = path.join(R48, 'home-on')
const WS = path.join(R48, 'workspace')

const script = [
  '$ErrorActionPreference="Continue"',
  'python -m pip --version',
  'python -c "import ssl; print(ssl.get_default_verify_paths())"',
  'python -c "p=r\'C:\\Users\\12075\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\site-packages\\pip\\_vendor\\certifi\\cacert.pem\'; import os; print(\'CERT-SIZE\', os.path.getsize(p)); print(open(p,\'rb\').read(1))"',
  'python -m pip download --no-deps --dest .\\r34-pip certifi==2024.8.30',
  'if (Test-Path .\\r34-pip\\certifi-*.whl) { "R34-PIP-OK" } else { "R34-PIP-MISSING" }',
].join('\n')
const prompt = [
  'Call the pwsh tool exactly once with this exact script (do not modify it).',
  'Return its stdout/stderr verbatim. Then answer exactly DONE.',
  '```powershell',
  script,
  '```',
].join('\n')

async function main() {
  process.stdout.write('=== R34 pip E2E ===\n')
  const server = new Server({ home: HOME, profile: 'on', workspace: WS, shell: '1' })
  try {
    await server.start()
    process.stdout.write(`server=${server.base}\n`)
    const sessionId = await server.newSession()
    await server.prompt(sessionId, prompt)
    await server.waitForTurn(sessionId, 360000)
    const turn = await server.readTurn(sessionId)
    try {
      const status = await server.command(sessionId, '/winstage status')
      process.stdout.write(`STATUS=${JSON.stringify(status).slice(0, 2500)}\n`)
    } catch (error) {
      process.stdout.write(`STATUS-ERR=${String(error?.message ?? error)}\n`)
    }
    const toolResults = turn.results.filter((r) => /R34-PIP|pip |certifi|Permission|SSL|CERTIFICATE/i.test(r.text))
    process.stdout.write(`META=${JSON.stringify(turn.results.map((r) => ({ name: r.name, isError: r.isError, meta: r.meta }))).slice(0, 4000)}\n`)
    const text = toolResults.map((r) => r.text).join('\n')
    process.stdout.write(`${text.slice(-3000)}\n`)
    check('PIP-OK', /R34-PIP-OK/.test(text), text.slice(-1200))
    check('NO-PERMISSION-ERROR', !/PermissionError|Errno 13|Access is denied|EACCES/i.test(text), text.slice(-1200))
    check('NO-CERT-ERROR', !/CERTIFICATE_VERIFY_FAILED|SSLError|self-signed certificate/i.test(text), text.slice(-1200))
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
