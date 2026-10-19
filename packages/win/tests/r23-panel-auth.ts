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

W('')
W('='.repeat(64))
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${verdict} checks=${assertions} failures=${failures}${PLANT ? ' mode=plant' : ''}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
