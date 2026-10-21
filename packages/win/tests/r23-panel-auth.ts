#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R23 新登记套件。
/**
 * r23-panel-auth —— **面板路由鉴权回归**（离线、确定性、零管理员）
 *
 * 存在理由（R21-LC-01，R23-A 修复）：
 *   `/winstage-panel/*` 是 **命名前缀路由**，在 `dsh-host-webserver` 里先于前端静态兜底被匹配；
 *   而宿主的 BrowserAuth（`Connection.authorizeIndex()`）只在**兜底**里调用
 *   （`dsh-host-frontend-static/lib/index.js:95`）⇒ 修复前本机任意进程无 token/cookie 即可
 *   读到审阅快照（路径 / diff 统计 / 可信性卡；敏感值仍掩码）。这是本机信息面缺口，不是远端。
 *
 * 本套件用**行为**钉住修复：
 *   1. `createPanelHandler({authorize})` 必须在 `buildPanelPayload()` **之前**调用 authorize；
 *      授权方返回 false（已写完 401）或抛错 ⇒ 不构建 payload、不写 200/503 业务体；
 *   2. authorize 抛错 ⇒ fail-closed 503 `{code:'auth-unavailable'}`（不泄快照）；
 *   3. 未传 authorize ⇒ 兼容旧行为（离线单测/旧装配显式选择；生产接线有静态守卫强制传）；
 *   4. 静态守卫：`host-plugin.ts::apply()` 必须 `ctx.inject(['webServer','connection'])`、必须把
 *      `connection.authorizeIndex(req,res,secureListener)` 作为 `authorize` 传给 createPanelHandler，
 *      且 connection 缺失时 fail-closed **不注册**无鉴权路由。
 *
 * 用法：`node tests\r23-panel-auth.ts`；`--plant` 变异体（只扰动测试侧输入）应当见红。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPanelHandler } from '../dsh-plugin/host-plugin.ts'

const PLANT = process.argv.includes('--plant')
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

/** 最小 node:http 响应替身：记录 status/headers/body，并支持"授权方已自行写完"。 */
function makeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.ended = true
      if (body !== undefined) this.body = String(body)
    },
  }
}
const req = (url) => ({ url, method: 'GET', headers: { host: '127.0.0.1:1234' } })
const call = async (handler, url) => {
  const res = makeRes()
  await handler(req(url), res)
  return res
}

rmSyncSafe()

function rmSyncSafe() {
  /* 本套件不写任何文件（纯 handler + 静态读），无需清理。 */
}

section('A. 授权必须先于 payload 构建（R21-LC-01 核心判据）')

{
  // A1：授权方返回 false 并自行写 401 ⇒ handler 不构建 payload（sessionOf/isEnabled 不得被调用）
  let sessionCalled = false
  let isEnabledCalled = false
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    isEnabled: () => {
      isEnabledCalled = true
      return true
    },
    sessionOf: () => {
      sessionCalled = true
      return undefined
    },
    authorize: (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.')
      return false
    },
  })
  const res = await call(handler, '/winstage-panel/snapshot?session=x')
  check('A1.1 未授权 ⇒ 401（授权方撰写），handler 不再写业务响应', res.status === 401 && res.ended, `status=${res.status} body=${String(res.body).slice(0, 60)}`)
  check(
    'A1.2 未授权 ⇒ 零 payload 构建（sessionOf / isEnabled 均未被调用 = 未读盘）',
    sessionCalled === false && isEnabledCalled === false,
    `sessionCalled=${sessionCalled} isEnabledCalled=${isEnabledCalled}`,
  )
}

{
  // A2：授权方返回 false 但**不写响应**（异常装配）⇒ handler 也不得写 200/503 业务体
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    authorize: () => false,
  })
  const res = await call(handler, '/winstage-panel/snapshot?session=x')
  check('A2.1 authorize=false 且未写响应 ⇒ handler 保持静默（不泄 payload）', res.status === undefined && res.ended === false, `status=${res.status} ended=${res.ended}`)
}

{
  // A3：authorize 抛错 ⇒ fail-closed 503 auth-unavailable，不构建 payload
  let isEnabledCalled = false
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    isEnabled: () => {
      isEnabledCalled = true
      return true
    },
    authorize: () => {
      throw new Error('auth backend unavailable')
    },
  })
  const res = await call(handler, '/winstage-panel/trust?session=x')
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = undefined
  }
  check('A3.1 authorize 抛错 ⇒ fail-closed 503 {code:auth-unavailable}', res.status === 503 && body?.ok === false && body?.code === 'auth-unavailable', `${res.status} ${String(res.body).slice(0, 80)}`)
  check('A3.2 授权异常 ⇒ 仍未构建 payload', isEnabledCalled === false, `isEnabledCalled=${isEnabledCalled}`)
  check('A3.3 授权异常响应体不含 snapshot/trust 业务字段', !/snapshot|"card"/.test(String(res.body)), String(res.body).slice(0, 120))
}

section('B. 授权通过后行为不变（与 R19 D2 关态语义一致）')

{
  // B1：authorize 通过 + 关态 ⇒ 503 disabled（原有业务响应仍由 buildPanelPayload 产出）
  let authCalls = 0
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    isEnabled: () => false,
    authorize: () => {
      authCalls += 1
      return true
    },
  })
  const res = await call(handler, '/winstage-panel/snapshot?session=x')
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = undefined
  }
  check('B1.1 已授权 + 关态 ⇒ 503 disabled（与 R19 D2 一致）', res.status === 503 && body?.code === 'disabled', `${res.status} ${String(res.body).slice(0, 100)}`)
  check(
    'B1.2 关态 503 不泄 snapshot/files（只允许 code/route/staging 等结构性字段）',
    body?.snapshot === undefined && body?.files === undefined && body?.counts === undefined,
    String(res.body).slice(0, 140),
  )
  check('B1.3 authorize 恰好被调用一次（不重复/不漏）', authCalls === 1, `authCalls=${authCalls}`)
}

{
  // B2：authorize 通过 + 开态 ⇒ 业务 payload 正常产出（本夹具无 review 会话 ⇒ 业务分支
  // `no-snapshot` 404；关键是"授权通过后确实走到了 buildPanelPayload"，而不是被鉴权拦截）。
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    isEnabled: () => true,
    authorize: () => true,
  })
  const res = await call(handler, '/winstage-panel/snapshot?session=r23-no-such-session')
  let body
  try {
    body = JSON.parse(res.body)
  } catch {
    body = undefined
  }
  check(
    'B2.1 已授权 + 开态 ⇒ 走到业务 payload（200 有快照 / 404 no-snapshot 均可，但不得是 auth-unavailable）',
    (res.status === 200 || res.status === 404) && body?.ok !== undefined && body?.code !== 'auth-unavailable',
    `${res.status} ${String(res.body).slice(0, 120)}`,
  )
  check(
    'B2.2 业务响应保留 store/route 数据面（修复不得改变业务输出形状）',
    body?.store !== undefined && typeof body?.ok === 'boolean',
    `keys=${Object.keys(body ?? {}).join(',')}`,
  )
  check(
    'B2.3 正常响应 cache-control=no-store（授权/快照均不得被缓存）',
    res.headers?.['cache-control'] === 'no-store',
    String(res.headers?.['cache-control']),
  )
}

section('C. 兼容路径：未传 authorize 时保持旧行为（生产由静态守卫强制传）')

{
  const handler = createPanelHandler({
    workspaceRoot: join(REPO, '.t', 'r23-panel-auth', 'never-read'),
    isEnabled: () => false,
  })
  const res = await call(handler, '/winstage-panel/snapshot?session=x')
  check('C1 未传 authorize ⇒ 仍按既有业务路径响应（离线单测/旧装配兼容）', res.status === 503, `status=${res.status}`)
}

section('D. 静态守卫：生产接线必须注入 connection 并把 authorizeIndex 交给面板 handler')

{
  const src = readFileSync(join(REPO, 'dsh-plugin', 'host-plugin.ts'), 'utf8')
  const effective = PLANT
    ? src
        .replace(/ctx\.inject\(\['webServer', 'connection'\]/g, "ctx.inject(['webServer']")
        .replace(/authorize:\s*\(req,\s*res\)\s*=>\s*connection\.authorizeIndex\(req,\s*res,\s*secureListener\)/, 'authorize: undefined')
        .replace(/if \(typeof options\.authorize === 'function'\) \{/, 'if (false) {')
    : src
  check(
    'D1 apply() 必须同时注入 webServer + connection（缺 connection 就没有宿主 BrowserAuth 入口）',
    /ctx\.inject\(\['webServer',\s*'connection'\]/.test(effective),
    'ctx.inject([\'webServer\', \'connection\'])',
  )
  check(
    'D2 connection.authorizeIndex 必须作为面板 handler 的 authorize 传入',
    /authorize:\s*\(req,\s*res\)\s*=>\s*connection\.authorizeIndex\(req,\s*res,\s*secureListener\)/.test(effective),
    'authorize: (req,res) => connection.authorizeIndex(req,res,secureListener)',
  )
  check(
    'D3 connection 缺失必须 fail-closed 不注册无鉴权路由（不得静默继续）',
    /typeof connection\?\.authorizeIndex !== 'function'[\s\S]{0,400}?拒绝注册无鉴权路由[\s\S]{0,400}?return/.test(effective),
    'connection?.authorizeIndex check + return',
  )
  const handlerBlock = effective.slice(effective.indexOf('export function createPanelHandler'), effective.indexOf('export function createPanelHandler') + 6000)
  const authAt = handlerBlock.indexOf('options.authorize')
  const payloadAt = handlerBlock.indexOf('buildPanelPayload(')
  check(
    'D4 createPanelHandler 里 authorize 出现在 buildPanelPayload 之前（未授权零构建）',
    authAt >= 0 && payloadAt > 0 && authAt < payloadAt,
    `authorizeAt=${authAt} buildPanelPayloadAt=${payloadAt}`,
  )
  check(
    'D5 未传 authorize 的兼容分支被显式注释/标注（生产必须传）',
    /生产必须传|生产接线在 apply\(\)[\s\S]{0,200}强制传入/.test(handlerBlock),
    'createPanelHandler doc/comment',
  )
}

section('E. R41-SEC04：?session= 必须绑定到宿主真实会话（存在 + cwd==workspaceRoot）')

{
  /** 假 sessionQuery（真实形状：observeSession(id) → {header:{id,cwd}}；NOT_FOUND 用稳定 code） */
  const fakeQuery = (mode) => {
    const calls = []
    return {
      calls,
      async observeSession(id) {
        calls.push(id)
        if (mode === 'not-found') {
          const error = new Error(`session "${id}" not found`)
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
          throw error
        }
        if (mode === 'throw') throw new Error('session backend down')
        if (mode === 'foreign') return { header: { id, cwd: join(REPO, 'some-other-workspace') } }
        if (mode === 'no-cwd') return { header: { id } }
        return { header: { id, cwd: WS_ROOT } }
      },
    }
  }
  const WS_ROOT = join(REPO, '.t', 'r23-panel-auth', 'panel-ws')
  const makeHandler = ({ mode, isEnabled = () => true, authorize = () => true, withService = true } = {}) => {
    const query = fakeQuery(mode)
    let enabledCalls = 0
    const handler = createPanelHandler({
      workspaceRoot: WS_ROOT,
      env: { LOCALAPPDATA: join(REPO, '.t', 'r23-panel-auth', 'localappdata') },
      isEnabled: () => { enabledCalls += 1; return isEnabled() },
      authorize,
      ...(withService ? { sessionQueryOf: () => query } : {}),
    })
    return { handler, query, enabledCalls: () => enabledCalls }
  }
  const snap = async (handler, sid) => {
    const res = makeRes()
    await handler(req(`/winstage-panel/snapshot?session=${encodeURIComponent(sid)}`), res)
    let body
    try { body = JSON.parse(res.body) } catch { body = undefined }
    return { res, body }
  }

  {
    const { handler, query } = makeHandler({ mode: 'not-found' })
    const { res, body } = await snap(handler, 'ghost-session')
    check('E1 不存在的会话 id ⇒ 403 session-not-authorized（不泄任何快照）', res.status === 403 && body?.code === 'session-not-authorized' && body?.snapshot === undefined && body?.files === undefined, `status=${res.status} body=${String(res.body).slice(0, 120)}`)
    check('E1.2 会话校验确实调用了宿主 sessionQuery（不是走本地猜测）', query.calls.length === 1 && query.calls[0] === 'ghost-session', `calls=${JSON.stringify(query.calls)}`)
  }
  {
    const { handler } = makeHandler({ mode: 'foreign' })
    const { res, body } = await snap(handler, 'victim-in-other-workspace')
    check('E2 会话 cwd 属于别的工作区 ⇒ 403 session-workspace-mismatch', res.status === 403 && body?.reason === 'session-workspace-mismatch' && body?.snapshot === undefined, `status=${res.status} reason=${body?.reason}`)
  }
  {
    const { handler } = makeHandler({ mode: 'match' })
    const { res, body } = await snap(handler, 'own-session')
    check('E3 会话存在且 cwd==workspaceRoot ⇒ 放行到既有业务路径（200/404 均可，且不是 session-*）', (res.status === 200 || res.status === 404) && String(body?.code ?? '').startsWith('session-') === false, `status=${res.status} code=${body?.code}`)
  }
  {
    const { handler } = makeHandler({ mode: 'throw' })
    const { res, body } = await snap(handler, 'own-session')
    check('E4 sessionQuery 后端异常 ⇒ 503 session-check-unavailable（fail-closed）', res.status === 503 && body?.code === 'session-check-unavailable' && body?.snapshot === undefined, `status=${res.status} code=${body?.code}`)
  }
  {
    const { handler } = makeHandler({ mode: 'no-cwd' })
    const { res, body } = await snap(handler, 'own-session')
    check('E5 会话 header 无 cwd（无法证明工作区）⇒ 403 fail-closed', res.status === 403 && body?.reason === 'session-workspace-unknown', `status=${res.status} reason=${body?.reason}`)
  }
  {
    const { handler } = makeHandler({ withService: false })
    const { res } = await snap(handler, 'any-session')
    check('E6 宿主没有 sessionQuery（老宿主/离线装配）⇒ 兼容旧行为并显式降级（不伪称已校验）', res.status === 404 || res.status === 200, `status=${res.status}`)
  }
  {
    const { handler, query } = makeHandler({ mode: 'foreign', authorize: (_q, r) => { r.writeHead(401, {}); r.end('auth required'); return false } })
    const { res } = await snap(handler, 'own-session')
    check('E7 未授权 ⇒ 401 且零会话查询（authorize 仍先于 session 校验）', res.status === 401 && query.calls.length === 0, `status=${res.status} calls=${query.calls.length}`)
  }
  {
    const { handler, query } = makeHandler({ mode: 'foreign', isEnabled: () => false })
    const { res, body } = await snap(handler, 'own-session')
    check('E8 关态 + 别的会话 ⇒ 仍回 503 disabled（关态语义不被会话校验改写），且不读快照', body?.code === 'disabled' && body?.snapshot === undefined, `status=${res.status} code=${body?.code}`)
    check('E8.2 关态也要先完成会话校验再决定响应（拒绝路径仍被走到）', query.calls.length === 1, `calls=${query.calls.length}`)
  }
  {
    const { handler, query } = makeHandler({ mode: 'match' })
    const res = makeRes()
    await handler(req('/winstage-panel/snapshot?session='), res)
    check('E9 空 session id（无会话身份的共享存储）不触发会话校验（兼容路径不变）', query.calls.length === 0, `calls=${query.calls.length}`)
  }
  {
    const src = readFileSync(join(REPO, 'dsh-plugin', 'host-plugin.ts'), 'utf8')
    const handlerAt = src.indexOf('export function createPanelHandler')
    const block = src.slice(handlerAt, handlerAt + 12000)
    const sessionAt = block.indexOf('authorizePanelSession(')
    const payloadAt = block.indexOf('buildPanelPayload(')
    check('E10 静态守卫：createPanelHandler 里会话校验出现在 buildPanelPayload 之前（未校验零构建）', sessionAt >= 0 && payloadAt > 0 && sessionAt < payloadAt, `sessionAt=${sessionAt} payloadAt=${payloadAt}`)
    check('E11 静态守卫：apply() 把 sessionQueryOf/sessionsOf 交给面板 handler（生产接线，非仅单测）', /sessionQueryOf:\s*\(\)\s*=>/.test(src) && /sessionsOf:\s*\(\)\s*=>/.test(src), 'sessionQueryOf/sessionsOf in apply()')
    check('E12 静态守卫：会话校验用宿主 sessionQuery.observeSession 与 canonical(header.cwd) 对比，而不是信任 query', /observeSession\(/.test(src) && /compareKey\(canonical\(cwd\)\)\s*===\s*compareKey\(canonical\(workspaceRoot\)\)/.test(src), 'observeSession + canonical compare')
  }
}

W('')
W('='.repeat(64))
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${verdict} checks=${assertions} failures=${failures}${PLANT ? ' mode=plant' : ''}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
