#!/usr/bin/env node
/**
 * B3/C2：运行中改 profile 开关 → `/winstage status` 必须明确报 pending-restart。
 * 用法：node packages/win/e2e/r49/pending-restart.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Server } from './approval-thread.mjs'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 900)}`}\n`)
}
const R48 = path.join(os.tmpdir(), 'r48-e2e', '20261119-225616')
const HOME = path.join(R48, 'home-on')
const WS = path.join(R48, 'workspace')
const PROFILE = path.join(HOME, 'profiles', 'on', 'cordis.patch.yml')

async function main() {
  process.stdout.write('=== B3 pending-restart ===\n')
  const original = fs.readFileSync(PROFILE, 'utf8')
  const server = new Server({ home: HOME, profile: 'on', workspace: WS, shell: '0' })
  try {
    await server.start()
    const sessionId = await server.newSession()
    const before = await server.command(sessionId, '/winstage status')
    check('BEFORE-NO-PENDING', !/配置漂移/.test(before?.text ?? ''), String(before?.text ?? '').slice(0, 600))
    const changed = original.replace(/(- id:\s*winstage-sandbox[\s\S]*?enabled:\s*)true/, '$1false')
    if (changed === original) throw new Error('profile did not contain winstage-sandbox enabled:true')
    fs.writeFileSync(PROFILE, changed)
    await new Promise((r) => setTimeout(r, 3500))
    const after = await server.command(sessionId, '/winstage status')
    const text = after?.text ?? ''
    check('AFTER-PENDING', /配置漂移/.test(text), text.slice(0, 1200))
    check('AFTER-EFFECTIVE', /当前 shell 提供方=winstage/.test(text), text.slice(0, 1200))
    check('AFTER-RESTART-HINT', /重启宿主/.test(text), text.slice(0, 1200))
  } finally {
    try { fs.writeFileSync(PROFILE, original) } catch {}
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
