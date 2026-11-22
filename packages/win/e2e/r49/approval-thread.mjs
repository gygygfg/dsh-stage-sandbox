#!/usr/bin/env node
/**
 * R49：另开一个 DSH web 线程，验证 A1a（只读 plugin_manager 自动放行）。
 *
 * 复用 R48 的隔离 home/profile（已含 web-app + WinStage），但把 permission 预设改回
 * workspace-write + ask，并显式启用 tool-plugin-manager：
 *   - 旧行为：plugin_manager.list_plugins 在 workspace-write 下会请求 danger-full-access，
 *     弹客户端审批；无 answerer 时 headless/自动路径直接失败。
 *   - 新行为：WinStage 的 approval/request listener（prepend）claim 只读请求，
 *     返回 allowed-once；工具返回 entries，会话不因审批停住。
 *
 * 用法：
 *   node packages/win/e2e/r49/approval-thread.mjs
 *   node ... --home=<isolated home> --profile=on
 *
 * 退出码：PASS/INFO 0；任一 FAIL 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const USER_HOME = os.homedir()
const DEFAULT_HOME = path.join(os.tmpdir(), 'r48-e2e', '20261119-225616', 'home-on')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}
const HOME = opt('--home', DEFAULT_HOME)
const PROFILE = opt('--profile', 'on')
const WORKSPACE = opt('--workspace', path.join(path.dirname(HOME), 'workspace'))
const TIMEOUT_MS = Number(opt('--timeout', '240000'))

const results = []
let seq = 0
function check(id, ok, detail = '') {
  results.push({ id, ok, detail: String(detail).slice(0, 1200) })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 800)}`}\n`)
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function truncate(v, n = 2000) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s == null ? '' : s.length <= n ? s : `${s.slice(0, n)}…`
}

function findDshCommand() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  const found = spawnSync('where.exe', ['dsh'], { encoding: 'utf8' })
  const first = (found.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  if (first && fs.existsSync(first)) return first
  const fallback = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
  if (fs.existsSync(fallback)) return fallback
  throw new Error('cannot locate dsh; set DSH_BIN')
}
function dshPaths() {
  const dshCmd = findDshCommand()
  const resources = path.resolve(path.dirname(dshCmd), '..', '..', '..')
  const electron = path.join(path.resolve(resources, '..'), 'DeepSeek Harness.exe')
  const cli = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (!fs.existsSync(electron)) throw new Error(`DeepSeek Harness.exe not found at ${electron}`)
  if (!fs.existsSync(resources, 'app.asar')) throw new Error('app.asar not found')
  return { electron, cli }
}

export class Server {
  constructor(options = {}) {
    this.home = options.home ?? HOME
    this.profile = options.profile ?? PROFILE
    this.workspace = options.workspace ?? WORKSPACE
    this.shell = options.shell === undefined ? '0' : options.shell
    this.child = null
    this.stdout = ''
    this.stderr = ''
    this.base = null
    this.token = null
    this.cookie = null
  }
  get authenticatedUrl() {
    return `${this.base}/?token=${encodeURIComponent(this.token)}`
  }
  async start() {
    const { electron, cli } = dshPaths()
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: this.home,
      DSH_PROFILE: this.profile,
    }
    if (this.shell === null) delete env.WINSTAGE_SHELL
    else env.WINSTAGE_SHELL = this.shell
    this.child = spawn(electron, ['--expose-internals', cli, '--profile', this.profile, '--no-open', '--port', '0'], {
      cwd: this.workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (c) => { this.stdout += c })
    this.child.stderr.on('data', (c) => { this.stderr += c })
    const started = Date.now()
    while (Date.now() - started < 90000) {
      const m = this.stdout.match(/dsh web:\s+(https?:\/\/\S+)/)
      if (m) {
        const url = new URL(m[1])
        this.base = url.origin
        this.token = url.searchParams.get('token')
        if (this.token) break
      }
      if (this.child.exitCode !== null) throw new Error(`server exited early (${this.child.exitCode}): ${truncate(this.stderr)}`)
      await sleep(200)
    }
    if (!this.base || !this.token) throw new Error(`no tokenized URL: ${truncate(this.stderr)}`)
    await this.connect()
  }
  async connect() {
    const res = await fetch(`${this.base}/connect?token=${encodeURIComponent(this.token)}&interactions=answer`, {
      redirect: 'manual', signal: AbortSignal.timeout(15000),
    })
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie')
    if (!setCookie) throw new Error(`/connect did not set cookie (HTTP ${res.status})`)
    this.cookie = setCookie.split(';')[0]
  }
  async rpc(method, args, { timeoutMs = 45000, retries = 3 } = {}) {
    let last
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.base}/api/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: this.cookie, connection: 'close' },
          body: JSON.stringify({ type: 'client-request', rpcId: `r${++seq}`, method, payload: { args } }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(text, 800)}`)
        const json = JSON.parse(text)
        if (!json?.result?.ok) throw new Error(`${method}: ${truncate(json?.result?.error ?? json, 1200)}`)
        return json.result.value
      } catch (error) {
        last = error
        if (attempt < retries) await sleep(800 + attempt * 500)
      }
    }
    throw last
  }
  async newSession() {
    const value = await this.rpc('session/create', { request: { cwd: WORKSPACE } })
    return value.sessionId
  }
  async prompt(sessionId, text) {
    return this.rpc('session/prompt', {
      request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
    })
  }
  async command(sessionId, line) {
    const value = await this.rpc('commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
    return value.result
  }
  async settingsDescribe() {
    return this.rpc('settings/describe', {})
  }
  async settingsMutate(ns, ops, expectedRevision) {
    return this.rpc('settings/mutate', { ns, ops, expectedRevision })
  }
  async listSessions() {
    const value = await this.rpc('session/list', { _request: {} })
    return value.items || []
  }
  async waitForTurn(sessionId, timeoutMs = TIMEOUT_MS) {
    const start = Date.now()
    await sleep(1200)
    while (Date.now() - start < timeoutMs) {
      const item = (await this.listSessions()).find((x) => x.sessionId === sessionId)
      if (item) {
        // `sessionStats.turns` can lag the persisted turn/end (and `running` can
        // stay true while a projection settles). Poll the event page itself.
        let ended = false
        try {
          const page = await this.readTurn(sessionId)
          ended = page.events.some((rec) => rec.event?.type === 'turn/end')
        } catch {
          /* retry */
        }
        if (ended) {
          if (item.running) {
            try { await this.rpc('session/cancel', { request: { sessionId } }) } catch {}
          }
          return item
        }
      }
      await sleep(1000)
    }
    throw new Error(`session ${sessionId} did not finish within ${timeoutMs}ms`)
  }
  async readTurn(sessionId) {
    const item = (await this.listSessions()).find((x) => x.sessionId === sessionId)
    const throughSeq = item?.projections?.asOfSeq ?? 1
    const page = await this.rpc('session/page', {
      request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 300 },
    })
    const events = page.records || []
    const calls = []
    const results = []
    const assistants = []
    const approvals = []
    const errors = []
    for (const rec of events) {
      const ev = rec.event
      if (!ev) continue
      const data = ev.data || {}
      if (ev.type === 'tool/call') calls.push({ name: data.name, arguments: data.arguments })
      else if (ev.type === 'tool/result') results.push({ text: (data.message?.content || []).map((c) => c.text || '').join('\n'), isError: Boolean(data.message?.isError) })
      else if (ev.type === 'assistant/message') {
        const text = (data.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
        if (text) assistants.push(text)
      } else if (ev.type === 'approval/asked' || ev.type === 'approval/decided') approvals.push({ type: ev.type, data })
      else if (ev.type === 'turn/end' && data.error) errors.push(data.error)
    }
    return { item, events, calls, results, assistants, approvals, errors, throughSeq }
  }
  async stop() {
    if (!this.child) return
    try { spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 20000 }) } catch {}
    await sleep(800)
    this.child = null
  }
}

async function main() {
  process.stdout.write(`=== R49 approval thread ===\nhome=${HOME}\nprofile=${PROFILE}\nworkspace=${WORKSPACE}\n`)
  if (!fs.existsSync(HOME)) throw new Error(`home not found: ${HOME}`)
  if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true })
  const server = new Server()
  try {
    await server.start()
    process.stdout.write(`server=${server.base}\n`)
    if (argv.includes('--probe-settings')) {
      const described = await server.settingsDescribe()
      const ns = (described?.namespaces ?? []).find((item) => item.ns === 'winstage-sandbox')
      process.stdout.write(`settings namespace=${JSON.stringify(ns ? { ns: ns.ns, revision: ns.revision, writable: ns.writable, value: ns.value } : null)}\n`)
      if (!ns) throw new Error('winstage-sandbox namespace not found in settings/describe')
      const off = await server.settingsMutate('winstage-sandbox', [{ op: 'set', path: ['enabled'], value: false }], ns.revision)
      process.stdout.write(`mutate-off=${JSON.stringify(off).slice(0, 800)}\n`)
      const afterOff = await server.settingsDescribe()
      const offNs = (afterOff?.namespaces ?? []).find((item) => item.ns === 'winstage-sandbox')
      process.stdout.write(`after-off=${JSON.stringify(offNs ? { revision: offNs.revision, value: offNs.value } : null)}\n`)
      const on = await server.settingsMutate('winstage-sandbox', [{ op: 'set', path: ['enabled'], value: true }], offNs?.revision)
      process.stdout.write(`mutate-on=${JSON.stringify(on).slice(0, 800)}\n`)
      return
    }
    const sessionId = await server.newSession()
    await server.prompt(sessionId, 'Call the plugin_manager tool exactly once with action list_plugins and limit 3. Do not call any other tool. Then answer exactly DONE.')
    let item
    try {
      item = await server.waitForTurn(sessionId)
    } catch (error) {
      // 超时也要留下现场：取消、读事件、打印 tool/approval，再抛。
      try { await server.rpc('session/cancel', { request: { sessionId } }) } catch {}
      await sleep(1000)
      const stuck = await server.readTurn(sessionId).catch(() => null)
      if (stuck) {
        process.stdout.write(`\nSTUCK calls=${truncate(stuck.calls, 1200)}\n`)
        process.stdout.write(`STUCK results=${truncate(stuck.results, 1200)}\n`)
        process.stdout.write(`STUCK approvals=${truncate(stuck.approvals, 1200)}\n`)
        process.stdout.write(`STUCK errors=${truncate(stuck.errors, 1200)}\n`)
        process.stdout.write(`STUCK assistants=${truncate(stuck.assistants, 800)}\n`)
        const tail = stuck.events.slice(-12).map((r) => r.event?.type).filter(Boolean)
        process.stdout.write(`STUCK tail=${tail.join(',')}\n`)
      }
      throw error
    }
    const turn = await server.readTurn(sessionId)
    const managers = turn.calls.filter((c) => c.name === 'plugin_manager')
    check('TOOL-CALL', managers.length === 1, JSON.stringify(managers))
    const result = turn.results.find((r) => !r.isError && /entries|total/.test(r.text))
    check('TOOL-RESULT', Boolean(result), turn.results.map((r) => `${r.isError ? 'ERR' : 'OK'}:${truncate(r.text, 300)}`).join(' | '))
    check('NO-APPROVAL-ERROR', !turn.results.some((r) => /SANDBOX_ESCALATION|APPROVAL_UNAVAILABLE|rejected escalating/i.test(r.text)), turn.results.filter((r) => r.isError).map((r) => truncate(r.text, 300)).join(' | '))
    const decided = turn.approvals.find((a) => a.type === 'approval/decided')
    check('APPROVAL-ALLOWED-ONCE', !decided || decided.data?.outcome === 'allowed-once', decided ? JSON.stringify(decided.data) : 'no approval events')
    check('ASSISTANT-DONE', turn.assistants.some((t) => /DONE/i.test(t)), turn.assistants.map((t) => truncate(t, 200)).join(' | '))
    check('NO-TURN-ERROR', turn.errors.length === 0, JSON.stringify(turn.errors))
    check('SESSION-ITEM', Boolean(item?.sessionId), JSON.stringify(item?.projections?.values?.sessionStats ?? {}))

    // ── A3：写 action 不应进入审批，而应入队并立即返回回执 ──────────────────────
    const session2 = await server.newSession()
    await server.prompt(session2, 'Call the plugin_manager tool exactly once with action set_plugin, target "__r49_does_not_exist__", enabled false. Do not call any other tool. Then answer exactly QUEUED.')
    const item2 = await server.waitForTurn(session2)
    const turn2 = await server.readTurn(session2)
    const mutatingCall = turn2.calls.filter((c) => c.name === 'plugin_manager')
    check('A3-TOOL-CALL', mutatingCall.length === 1, JSON.stringify(mutatingCall))
    const queuedReceipt = turn2.results.find((r) => /已提交，等待确认|queued/i.test(r.text))
    check('A3-QUEUED-RECEIPT', Boolean(queuedReceipt), turn2.results.map((r) => `${r.isError ? 'ERR' : 'OK'}:${truncate(r.text, 300)}`).join(' | '))
    check('A3-NO-TOOL-ERROR', !turn2.results.some((r) => r.isError), turn2.results.filter((r) => r.isError).map((r) => truncate(r.text, 300)).join(' | '))
    check('A3-NO-APPROVAL-ASKED', !turn2.approvals.some((a) => a.type === 'approval/asked'), JSON.stringify(turn2.approvals.map((a) => a.type)))
    check('A3-ASSISTANT-QUEUED', turn2.assistants.some((t) => /QUEUED/i.test(t)), turn2.assistants.map((t) => truncate(t, 200)).join(' | '))
    const approvalId = (turn2.results.map((r) => r.text).join('\n').match(/ap_[a-z0-9_]+/i) ?? [])[0] ?? ''
    check('A3-QUEUE-ID', Boolean(approvalId), approvalId)
    if (approvalId) {
      const listed = await server.command(session2, '/winstage approvals')
      check('A5-COMMAND-APPROVALS', JSON.stringify(listed).includes(approvalId), truncate(JSON.stringify(listed), 800))
      const rejected = await server.command(session2, `/winstage approval-reject ${approvalId}`)
      check('A5-COMMAND-REJECT', JSON.stringify(rejected).includes('已拒绝') || JSON.stringify(rejected).includes('success'), truncate(JSON.stringify(rejected), 800))
      const after = await server.command(session2, '/winstage approvals')
      check('A5-COMMAND-REJECTED-GONE', !JSON.stringify(after).includes(approvalId), truncate(JSON.stringify(after), 800))
    }
    check('A3-SESSION-ITEM', Boolean(item2?.sessionId), JSON.stringify(item2?.projections?.values?.sessionStats ?? {}))
  } finally {
    await server.stop()
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failures=${failed}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`\nFATAL: ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}
