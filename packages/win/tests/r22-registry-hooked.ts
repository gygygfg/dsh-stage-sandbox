#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R22 新增（离线）。
/**
 * r22-registry-hooked —— R22 / R15：最后 5 个可 hook 注册表变体的**契约套件**（离线）
 *
 * 存在理由：R15 残余里 `RegConnectRegistryExW/A`、`RegOverridePredefKey`、
 * `RegOpenUserClassesRoot`、`RegOpenCurrentUser`、`RegSetKeySecurity` 长期只在
 * `REG_STAGE_UNHOOKED_APIS` 名单上（"意图声明"），真实结局是直落真实 hive。
 * R22 把它们接进 WS_TARGET 并定义语义：
 *
 *   ① RegConnectRegistryExW/A   ：本机（NULL/本机/"."）读类**透传**；远端 ⇒ fail-closed + WAL(type=7)
 *   ② RegOverridePredefKey      ：预定义 HKEY 重定向是进程级状态 ⇒ fail-closed + WAL(type=5)
 *   ③ RegOpenUserClassesRoot    ：只读打开 ⇒ **透传**（返回句柄的后续写仍由 Reg* /ntdll 钩子管）
 *   ④ RegOpenCurrentUser        ：同上
 *   ⑤ RegSetKeySecurity         ：安全描述符写无暂存表示 ⇒ fail-closed + WAL(type=5)
 *
 * 本套件把"源码 ↔ TS 契约 ↔ WAL 编码"三层钉死（行为证据在 `.t/reg-shim/r22a.ts` 的
 * direct-inject + 生产 TS lane 双通道跑）。防止名单/原因码/语义任何一处漂回假承诺。
 *
 * 用法：node tests\r22-registry-hooked.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REG_STAGE_HARD_DENY_APIS,
  REG_STAGE_HARD_DENY_REASON,
  REG_STAGE_HOOKED_APIS,
  REG_STAGE_KIND,
  REG_STAGE_FLAGS,
  REG_STAGE_PASSTHROUGH_OPEN_APIS,
  REG_STAGE_UNHOOKED_APIS,
  R19_HARD_DENY_REASON_BY_API,
  classifyRegistryOperation,
  decodeJournalRecords,
  encodeJournalRecord,
  journalHardDenyRecord,
} from '../src/registry-stage.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const WS_HOOK = join(REPO, 'shim', 'src', 'ws_hook.c')
const WS_REG = join(REPO, 'shim', 'src', 'ws_reg.c')
const INTERNAL = join(REPO, 'shim', 'src', 'winstage_internal.h')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  return condition
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

const HARD_DENY_NEW = ['RegConnectRegistryExW', 'RegConnectRegistryExA', 'RegOverridePredefKey', 'RegSetKeySecurity']
const PASSTHROUGH_OPEN = ['RegOpenUserClassesRoot', 'RegOpenCurrentUser']
const ALL_NEW = [...HARD_DENY_NEW, ...PASSTHROUGH_OPEN]

for (const [label, file] of [['ws_hook.c', WS_HOOK], ['ws_reg.c', WS_REG], ['winstage_internal.h', INTERNAL]]) {
  if (!existsSync(file)) {
    W(`RESULT: SKIP checks=0 failures=0 reason=missing-${label}`)
    process.exit(0)
  }
}
const hookSrc = readFileSync(WS_HOOK, 'utf8')
const regSrc = readFileSync(WS_REG, 'utf8')
const headerSrc = readFileSync(INTERNAL, 'utf8')

function functionBody(src, name) {
  const start = src.indexOf(`${name}(`)
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

// ─── S1. C 侧拦截面 / 中央契约 ──────────────────────────────────────────────
section('S1 C 侧：6 个符号都进 WS_TARGET + 名字镜像 + 原型 + 原函数捕获')
{
  const targets = [...hookSrc.matchAll(/WS_TARGET\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1])
  const missingTarget = ALL_NEW.filter((api) => !targets.includes(api))
  check('6 个符号全部在 WS_TARGET(...) 名单里', missingTarget.length === 0, missingTarget.join(',') || '(6/6)')
  const missingLiteral = ALL_NEW.filter((api) => !new RegExp(`"${api}"`).test(hookSrc))
  check('g_targetNames 镜像含全部 6 个名字字面量（名单漂移会立刻红）', missingLiteral.length === 0, missingLiteral.join(',') || '(6/6)')
  const missingOrigCapture = ALL_NEW.filter((api) => !new RegExp(`&g_orig\\.${api},\\s*"${api}"`).test(hookSrc))
  check('init map 捕获了 6 个原函数（缺一个都会让透传/降级调用 NULL）', missingOrigCapture.length === 0, missingOrigCapture.join(',') || '(6/6)')
  const missingField = ALL_NEW.filter((api) => !new RegExp(`\\*\\)?${api}\\)`).test(headerSrc) && !headerSrc.includes(`${api})(`))
  check('winstage_internal.h 有 6 个 WsOriginals 字段/原型声明', missingField.length === 0, missingField.join(',') || '(6/6)')
  const missingImpl = ALL_NEW.filter((api) => !new RegExp(`LONG WINAPI ws_${api}\\(`).test(regSrc))
  check('ws_reg.c 有 6 个强实现（不是 weak stub 兜底）', missingImpl.length === 0, missingImpl.join(',') || '(6/6)')
}

// ─── S2. 语义实现（源码级，防"hook 了但语义写反"）───────────────────────────
section('S2 C 侧语义：ConnectEx 本机透传/远端 deny、Open* 透传、Override/SetKeySecurity deny')
{
  const exBody = functionBody(regSrc, 'ws_RegConnectRegistryExW')
  check('RegConnectRegistryExW：本机用 ws_reg_is_local_machine 判定并调用 g_orig（本机透传）', /ws_reg_is_local_machine\(lpMachineName\)/.test(exBody) && /g_orig\.RegConnectRegistryExW/.test(exBody), 'local passthrough')
  check('RegConnectRegistryExW：非本机走 WS_HARD_DENY_REMOTE_HIVE_NOT_STAGEABLE（原因码 7）', /WS_HARD_DENY_REMOTE_HIVE_NOT_STAGEABLE/.test(exBody), 'reason 7')
  const exABody = functionBody(regSrc, 'ws_RegConnectRegistryExA')
  check('RegConnectRegistryExA：转宽字符后委托 ExW（A 变体不另写策略）', /ws_RegConnectRegistryExW\(/.test(exABody), 'alias')
  const overrideBody = functionBody(regSrc, 'ws_RegOverridePredefKey')
  check('RegOverridePredefKey：fail-closed + WAL reason=5（无透传分支）', /WS_HARD_DENY_TREE_OP_NOT_STAGEABLE/.test(overrideBody) && !/g_orig\.RegOverridePredefKey/.test(overrideBody), 'deny reason 5')
  const openBody = functionBody(regSrc, 'ws_RegOpenUserClassesRoot')
  check('RegOpenUserClassesRoot：只读打开透传（调用 g_orig）', /g_orig\.RegOpenUserClassesRoot/.test(openBody), 'passthrough')
  const openCurBody = functionBody(regSrc, 'ws_RegOpenCurrentUser')
  check('RegOpenCurrentUser：只读打开透传（调用 g_orig）', /g_orig\.RegOpenCurrentUser/.test(openCurBody), 'passthrough')
  const secBody = functionBody(regSrc, 'ws_RegSetKeySecurity')
  check('RegSetKeySecurity：fail-closed + WAL reason=5（无透传分支）', /WS_HARD_DENY_TREE_OP_NOT_STAGEABLE/.test(secBody) && !/g_orig\.RegSetKeySecurity/.test(secBody), 'deny reason 5')
}

// ─── S3. TS 契约：HOOKED/UNHOOKED/原因码/分类 ───────────────────────────────
section('S3 TS 契约与 C 侧一致')
{
  check('REG_STAGE_HOOKED_APIS ⊇ 6 个符号', ALL_NEW.every((api) => REG_STAGE_HOOKED_APIS.includes(api)), ALL_NEW.join(','))
  check(
    'REG_STAGE_UNHOOKED_APIS 只剩 NtOpenKey/ZwOpenKey（真残余；不再含任何 Reg* 变体）',
    REG_STAGE_UNHOOKED_APIS.length === 2 && REG_STAGE_UNHOOKED_APIS.every((api) => api === 'NtOpenKey' || api === 'ZwOpenKey'),
    REG_STAGE_UNHOOKED_APIS.join(','),
  )
  check('6 个符号与 UNHOOKED 无交集（补了 hook 必须从盲区删掉）', ALL_NEW.every((api) => !REG_STAGE_UNHOOKED_APIS.includes(api)), 'no overlap')
  check(
    '原因码映射：ConnectRegistryExW/A → REMOTE(7)，OverridePredefKey/SetKeySecurity → TREE(5)',
    ['RegConnectRegistryExW', 'RegConnectRegistryExA'].every((api) => R19_HARD_DENY_REASON_BY_API[api] === 'REMOTE_HIVE_NOT_STAGEABLE') &&
      ['RegOverridePredefKey', 'RegSetKeySecurity'].every((api) => R19_HARD_DENY_REASON_BY_API[api] === 'TREE_OPERATION_NOT_STAGEABLE'),
    JSON.stringify({ ex: R19_HARD_DENY_REASON_BY_API.RegConnectRegistryExW, override: R19_HARD_DENY_REASON_BY_API.RegOverridePredefKey }),
  )
  check(
    'C 侧原因码数值与 TS 一致：REMOTE_HIVE_NOT_STAGEABLE=7、TREE_OPERATION_NOT_STAGEABLE=5',
    REG_STAGE_HARD_DENY_REASON.REMOTE_HIVE_NOT_STAGEABLE === 7 && REG_STAGE_HARD_DENY_REASON.TREE_OPERATION_NOT_STAGEABLE === 5,
    `7=${REG_STAGE_HARD_DENY_REASON.REMOTE_HIVE_NOT_STAGEABLE} 5=${REG_STAGE_HARD_DENY_REASON.TREE_OPERATION_NOT_STAGEABLE}`,
  )
  check(
    'classify：4 个硬拒变体全部 stageable=false + status=5 + 正确原因码',
    HARD_DENY_NEW.every((api) => {
      const verdict = classifyRegistryOperation({ api, path: 'HKCU\\Software\\R22Probe' })
      return verdict.stageable === false && verdict.status === 5 && verdict.hardDenyReason === R19_HARD_DENY_REASON_BY_API[api]
    }),
    HARD_DENY_NEW.join(','),
  )
  check(
    'classify：2 个只读打开变体 ⇒ unstaged:true + status=0（透传，不是 Access denied）',
    PASSTHROUGH_OPEN.every((api) => {
      const verdict = classifyRegistryOperation({ api })
      return verdict.stageable === false && verdict.unstaged === true && verdict.status === 0 && verdict.code === 'REG_STAGE_OPEN_PASSTHROUGH'
    }),
    PASSTHROUGH_OPEN.join(','),
  )
  check(
    'REG_STAGE_PASSTHROUGH_OPEN_APIS 恰为这两个只读打开（不多不少，防把写类误当透传）',
    REG_STAGE_PASSTHROUGH_OPEN_APIS.length === 2 && PASSTHROUGH_OPEN.every((api) => REG_STAGE_PASSTHROUGH_OPEN_APIS.includes(api)),
    REG_STAGE_PASSTHROUGH_OPEN_APIS.join(','),
  )
  check(
    '只读打开变体不在硬拒意图清单里（它们已从"硬拒"语义移出）',
    PASSTHROUGH_OPEN.every((api) => REG_STAGE_HARD_DENY_APIS[api] === undefined),
    PASSTHROUGH_OPEN.map((api) => `${api}:${String(REG_STAGE_HARD_DENY_APIS[api])}`).join(','),
  )
}

// ─── S4. WAL 审计可归因：kind=5/status=5/type=7|5 编解码往返 ──────────────────
section('S4 WAL：HARD_DENY(kind=5,status=5,type=7/5) 编码→解码往返')
{
  const remote = journalHardDenyRecord({ api: 'RegConnectRegistryExW', path: '<remote-hive>', hardDenyReason: 'REMOTE_HIVE_NOT_STAGEABLE' })
  const tree = journalHardDenyRecord({ api: 'RegSetKeySecurity', path: 'HKCU\\Software\\R22Probe', hardDenyReason: 'TREE_OPERATION_NOT_STAGEABLE' })
  const decoded = decodeJournalRecords(Buffer.concat([encodeJournalRecord(remote), encodeJournalRecord(tree)]))
  const [first, second] = decoded.records
  check('远端连接记录：kind=5 / status=5 / type=7 / HARD_DENY flag', first?.kind === REG_STAGE_KIND.HARD_DENY && first?.status === 5 && first?.type === 7 && (first?.flags & REG_STAGE_FLAGS.HARD_DENY) !== 0, JSON.stringify({ kind: first?.kind, status: first?.status, type: first?.type }))
  check('SD/重定向记录：kind=5 / status=5 / type=5', second?.kind === REG_STAGE_KIND.HARD_DENY && second?.status === 5 && second?.type === 5, JSON.stringify({ kind: second?.kind, type: second?.type }))
  check('记录数正确且无解码问题', decoded.records.length === 2 && (decoded.problems ?? []).length === 0, `records=${decoded.records.length} problems=${(decoded.problems ?? []).length}`)
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
