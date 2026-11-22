#!/usr/bin/env node
/**
 * D0：ON vs OFF 的 20 条模型可见探针（确定性字节 diff）。
 *
 * 两个独立 DSH web 进程（R48 isolated homes）：
 *   ON  : WinStage enabled + WINSTAGE_SHELL=1（WinStage 命令面）
 *   OFF : WinStage disabled + WINSTAGE_SHELL=0（平台 shell）
 * 每个进程一个独立 session，真实 Agent 跑同一段 PowerShell 探针脚本；比较
 * 工具结果里的 20 行 key=value。路径/临时目录/文件计数归一化后必须逐行相同。
 *
 * 用法：node packages/win/e2e/r49/stealth-probes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Server } from './approval-thread.mjs'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 1000)}`}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const R48 = path.join(os.tmpdir(), 'r48-e2e', '20261119-225616')
const HOME_ON = path.join(R48, 'home-on')
const HOME_OFF = path.join(R48, 'home-off')
const WS_ON = path.join(R48, 'workspace')
const WS_OFF = path.join(R48, 'workspace-reference')

function copyCredentials() {
  const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  const llm = path.join(os.homedir(), '.dsh', 'llm-deepseek')
  for (const home of [HOME_ON, HOME_OFF]) {
    if (!fs.existsSync(home)) throw new Error(`missing isolated home: ${home}`)
    fs.copyFileSync(cred, path.join(home, '.credentials.yaml'))
    if (fs.existsSync(llm)) fs.cpSync(llm, path.join(home, 'llm-deepseek'), { recursive: true, force: true })
  }
}

const script = [
  '$ErrorActionPreference="SilentlyContinue"',
  '$lines=@()',
  '$lines += "PWD=" + (Get-Location).Path',
  '$lines += "USER=" + $env:USERNAME',
  '$lines += "COMPUTER=" + $env:COMPUTERNAME',
  '$lines += "HOME=" + $env:USERPROFILE',
  '$lines += "NODE=" + (node --version)',
  '$lines += "PY=" + (python --version 2>&1)',
  '$lines += "GIT=" + (git --version)',
  '$lines += "VER=" + ((cmd /c ver) 2>&1)',
  '$lines += "WHO=" + ((whoami) 2>&1)',
  '$lines += "HOST=" + ((hostname) 2>&1)',
  '$lines += "PATHHASWINSTAGE=" + [bool](($env:PATH -split ";") -match "winstage")',
  '$lines += "ENVWINSTAGE=" + ((([Environment]::GetEnvironmentVariables().Keys) | Where-Object { $_ -match "WINSTAGE|DSH_STAGE|DSH_SHIM" }) -join ",")',
  '$lines += "ARTIFACTS=" + ((Get-ChildItem -Force | Where-Object { $_.Name -in @("shim.log","winstage-shim.config.json",".dshstage","fs","wo") }).Name -join ",")',
  '$lines += "TESTPATH=" + (Test-Path ".")',
  '$lines += "CHILD=" + (@(Get-ChildItem -Force).Count)',
  '$lines += "TEMP=" + $env:TEMP',
  '$lines += "TMP=" + $env:TMP',
  '$lines += "PSVER=" + $PSVersionTable.PSVersion.ToString()',
  '$lines += "CULTURE=" + (Get-Culture).Name',
  '$lines += "TZ=" + [TimeZoneInfo]::Local.Id',
  '$lines -join "`n"',
].join('\n')

const prompt = [
  'Call the pwsh tool exactly once with this exact script (do not modify it, do not add commands).',
  'Return its stdout verbatim. Then answer exactly DONE.',
  '```powershell',
  script,
  '```',
].join('\n')

function parseProbe(text) {
  const out = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Z]+)=(.*)$/.exec(line.trim())
    if (match) out.set(match[1], match[2])
  }
  return out
}

function normalize(probe, { workspace, home }) {
  const out = new Map()
  for (const [key, value] of probe) {
    let v = String(value)
    if (workspace) v = v.split(workspace).join('<WS>')
    if (home) v = v.split(home).join('<HOME>')
    if (key === 'PWD') v = '<WS>'
    if (key === 'HOME') v = '<HOME>'
    if (key === 'TEMP' || key === 'TMP') v = '<TMP>'
    if (key === 'CHILD') v = v.replace(/^\d+$/, '<N>')
    out.set(key, v)
  }
  return out
}

async function runOne(server, promptText) {
  const sessionId = await server.newSession()
  await server.prompt(sessionId, promptText)
  await server.waitForTurn(sessionId)
  const turn = await server.readTurn(sessionId)
  // 取最后一条包含 PWD= 的工具结果
  const text = [...turn.results].reverse().map((r) => r.text).find((t) => /(^|\n)PWD=/.test(t)) ?? ''
  return { sessionId, text, turn }
}

async function main() {
  process.stdout.write('=== D0 stealth probes ===\n')
  copyCredentials()
  const on = new Server({ home: HOME_ON, profile: 'on', workspace: WS_ON, shell: '1' })
  const off = new Server({ home: HOME_OFF, profile: 'off', workspace: WS_OFF, shell: null })
  try {
    for (const ws of [WS_ON, WS_OFF]) fs.rmSync(path.join(ws, '.dshstage'), { recursive: true, force: true })
    await Promise.all([on.start(), off.start()])
    process.stdout.write(`on=${on.base}\noff=${off.base}\n`)
    const [onRun, offRun] = await Promise.all([runOne(on, prompt), runOne(off, prompt)])
    const onProbe = parseProbe(onRun.text)
    const offProbe = parseProbe(offRun.text)
    const keys = [
      'PWD','USER','COMPUTER','HOME','NODE','PY','GIT','VER','WHO','HOST',
      'PATHHASWINSTAGE','ENVWINSTAGE','ARTIFACTS','TESTPATH','CHILD','TEMP','TMP','PSVER','CULTURE','TZ',
    ]
    check('PROBE-COUNT', keys.every((k) => onProbe.has(k)) && keys.every((k) => offProbe.has(k)), JSON.stringify({ on: [...onProbe.keys()], off: [...offProbe.keys()] }))
    const onNorm = normalize(onProbe, { workspace: WS_ON, home: HOME_ON })
    const offNorm = normalize(offProbe, { workspace: WS_OFF, home: HOME_OFF })
    const diffs = keys.filter((k) => onNorm.get(k) !== offNorm.get(k)).map((k) => `${k}: on=${onNorm.get(k)} off=${offNorm.get(k)}`)
    check('BYTE-DIFF', diffs.length === 0, diffs.join(' | '))
    check('NO-WINSTAGE-ENV', (onProbe.get('ENVWINSTAGE') ?? '') === '', onProbe.get('ENVWINSTAGE'))
    check('NO-ARTIFACTS', (onProbe.get('ARTIFACTS') ?? '') === '', onProbe.get('ARTIFACTS'))
    check('PATH-CLEAN', onProbe.get('PATHHASWINSTAGE') === 'False', onProbe.get('PATHHASWINSTAGE'))
    const onValues = [...onProbe.values()].join('\n')
    check('NO-FINGERPRINT-TEXT', !/winstage|\.dshstage|shim\.log/i.test(onValues), onValues.slice(0, 800))
    check('NO-TURN-ERROR', onRun.turn.errors.length === 0 && offRun.turn.errors.length === 0, JSON.stringify({ on: onRun.turn.errors, off: offRun.turn.errors }))
  } finally {
    await Promise.allSettled([on.stop(), off.stop()])
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failures=${failed}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`\nFATAL: ${error?.stack ?? error}\n`)
  process.exit(1)
})
