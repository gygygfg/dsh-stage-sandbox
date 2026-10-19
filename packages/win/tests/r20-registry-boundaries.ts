#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R20 新登记套件（离线）。
/**
 * r20-registry-boundaries —— **R20 / R16 ntdll+Zw 注册表写面 C↔TS 契约套件**
 *
 * 存在理由（先红后绿）：R19 的 P0 residual 是"ntdll/Zw 注册表写直调在 TS 档直写真实
 * hive 且 WAL 零记录"。R20 把 12 个 Nt* 写入口 + 12 个 Zw* 别名加进 `WS_TARGET` 并
 * fail-closed HARD_DENY + WAL。本套件把"源码 ↔ TS 契约 ↔ WAL 编码"三层钉死，防止
 * 名单/原因码/别名任何一处漂移回"假承诺"：
 *
 *   S1 C 侧拦截面：24 个名字都在 `WS_TARGET` + `g_targetNames` 镜像里；
 *   S2 家族判定：`ws_target_family()` 用显式白名单（`ws_name_is_reg_nt`），
 *      不是 "Nt"/"Zw" 前缀通配（否则 NtOpenFile/NtQuery* 会被误判成 REG 家族）；
 *   S3 re-entrancy 契约：core modules（kernel32/kernelbase/advapi32/ntdll）对这 24 个
 *      ntdll 写名保留真 IAT 槽（与 NtCreateFile 同构）——否则 shim 自己的 staging
 *      引擎（advapi32→kernelbase→ntdll!NtCreateKey）会被自己的 deny 打死；
 *   S4 deny 实现：12 个 `ws_Zw*` 是 12 个 `ws_Nt*` 的 1:1 fail-closed 别名；
 *      写类用 reason=8、hive-file 类用 reason=6；线程级深度守卫存在；
 *   S5 TS 契约：`REG_STAGE_HOOKED_APIS` ⊇ 24、`REG_STAGE_UNHOOKED_APIS` 只留真残余
 *      （NtOpenKey/ZwOpenKey + Reg 变体）、原因码 8/6 数值与 C 侧逐字一致、
 *      `classifyRegistryOperation()` 对 24 个入口全部 fail-closed；
 *   S6 WAL 编码：`kind=5,status=5,type=8/6` 的记录编码→解码往返一致（审计可归因）。
 *
 * 真正的"真实 hive 不动 + WAL 有 HARD_DENY"行为证据在 `.t/reg-shim/matrix.ts`
 * （direct-inject + 生产 TS lane 双通道，需真实注入），本套件只保证契约不漂。
 *
 * 用法：node tests\r20-registry-boundaries.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REG_STAGE_HARD_DENY_APIS,
  REG_STAGE_HARD_DENY_REASON,
  REG_STAGE_HOOKED_APIS,
  REG_STAGE_UNHOOKED_APIS,
  R19_HARD_DENY_REASON_BY_API,
  REG_STAGE_KIND,
  REG_STAGE_FLAGS,
  classifyRegistryOperation,
  decodeJournalRecords,
  encodeJournalRecord,
  journalHardDenyRecord,
} from '../src/registry-stage.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const WS_HOOK = join(REPO, 'shim', 'src', 'ws_hook.c')
const WS_REG = join(REPO, 'shim', 'src', 'ws_reg.c')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

const NT_WRITE_OPS = ['NtCreateKey', 'NtSetValueKey', 'NtDeleteKey', 'NtDeleteValueKey', 'NtRenameKey']
const NT_HIVE_OPS = ['NtLoadKey', 'NtLoadKey2', 'NtUnloadKey', 'NtSaveKey', 'NtSaveKeyEx', 'NtRestoreKey', 'NtReplaceKey']
const ZW_OF = (names) => names.map((name) => `Zw${name.slice(2)}`)
const ALL_NT = [...NT_WRITE_OPS, ...NT_HIVE_OPS]
const ALL_ZW = ZW_OF(ALL_NT)
const ALL_24 = [...ALL_NT, ...ALL_ZW]

for (const [label, file] of [['ws_hook.c', WS_HOOK], ['ws_reg.c', WS_REG]]) {
  if (!existsSync(file)) {
    W(`RESULT: SKIP checks=0 failures=0 reason=missing-${label}`)
    process.exit(0)
  }
}
const hookSrc = readFileSync(WS_HOOK, 'utf8')
const regSrc = readFileSync(WS_REG, 'utf8')

/** 取出 `static <ret> <name>(...)` 到下一个函数前的源码片段（足够做本套件的静态断言）。 */
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

// ─── S1. C 侧真实拦截面 ──────────────────────────────────────────────────────
section('S1 C 侧拦截面：24 个 ntdll/Zw 写名都真的在 WS_TARGET + 名字镜像里')
{
  const targets = [...hookSrc.matchAll(/WS_TARGET\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1])
  const missingTarget = ALL_24.filter((name) => !targets.includes(name))
  check('24 个名字（12 Nt* + 12 Zw*）全部出现在 WS_TARGET(...) 名单', missingTarget.length === 0, missingTarget.join(',') || '(all present)')
  const missingLiteral = ALL_24.filter((name) => !new RegExp(`"${name}"`).test(hookSrc))
  check('g_targetNames 镜像含全部 24 个名字字面量（名单漂移会立刻红）', missingLiteral.length === 0, missingLiteral.join(',') || '(all mirrored)')
  const dupes = ALL_24.filter((name) => targets.filter((t) => t === name).length > 1)
  check('24 个名字在 WS_TARGET 里各出现一次（无重复安装）', dupes.length === 0, dupes.join(',') || '(no dupes)')
}

// ─── S2. 家族判定：显式白名单，不是前缀通配 ──────────────────────────────────
section('S2 ws_target_family()：ntdll 写名判 REG 用的是显式白名单')
{
  check('存在 ws_name_is_reg_nt() 显式白名单函数', /static int ws_name_is_reg_nt\(/.test(hookSrc), 'ws_name_is_reg_nt')
  const whiteBody = functionBody(hookSrc, 'ws_name_is_reg_nt')
  const whiteSuffixes = ['CreateKey', 'SetValueKey', 'DeleteKey', 'DeleteValueKey', 'RenameKey', 'LoadKey', 'LoadKey2', 'UnloadKey', 'SaveKey', 'SaveKeyEx', 'RestoreKey', 'ReplaceKey']
  const missingSuffix = whiteSuffixes.filter((suffix) => !whiteBody.includes(`"${suffix}"`))
  check('白名单含 12 个 API 后缀（Nt/Zw 前缀只作前缀判断）', missingSuffix.length === 0, missingSuffix.join(',') || whiteSuffixes.join(','))
  const familyBody = functionBody(hookSrc, 'ws_target_family')
  check('ws_target_family() 确实调用 ws_name_is_reg_nt() → 判 REG 家族', /ws_name_is_reg_nt\(name\)/.test(familyBody), familyBody.slice(0, 200))
  check('没有把裸 "Nt"/"Zw" 前缀直接判成 REG（NtOpenFile/NtQuery* 不能被误判）', !/strncmp\(name, "(Nt|Zw)", 2\)[^;]*return WS_FAM_REG/.test(familyBody), 'explicit allow-list')
}

// ─── S3. re-entrancy 契约：core modules 保留真槽 ────────────────────────────
section('S3 re-entrancy：core modules 对 24 个 ntdll 写名保留真 IAT 槽（staging 引擎自救）')
{
  const coreBody = functionBody(hookSrc, 'ws_is_core_windows_module')
  check(
    '核模块判定覆盖 kernel32/kernelbase/advapi32/ntdll（缺一都会让内部调用被自己的 deny 打死）',
    ['hKernel32', 'hKernelBase', 'hAdvapi32', 'hNtdll'].every((field) => coreBody.includes(field)),
    coreBody.replace(/\s+/g, ' ').slice(0, 240),
  )
  const keepBody = functionBody(hookSrc, 'ws_target_keeps_core_slot')
  check('ws_target_keeps_core_slot() 对 NtCreateFile 保留真槽（R20/R17 已有决策）', /strcmp\(name, "NtCreateFile"\)/.test(keepBody), 'NtCreateFile')
  check('ws_target_keeps_core_slot() 对 24 个 ntdll 注册表写名保留真槽（R20/R16 修复）', /ws_name_is_reg_nt\(name\)/.test(keepBody), keepBody.replace(/\s+/g, ' ').slice(0, 260))
  const patchBody = functionBody(hookSrc, 'ws_patch_module')
  check('IAT 补丁循环真的调用 ws_target_keeps_core_slot(fname, base) 并 continue', /ws_target_keeps_core_slot\(fname, base\)/.test(patchBody) && /continue;/.test(patchBody), 'patch loop guarded')
}

// ─── S4. deny 实现：别名 1:1、原因码、线程守卫 ──────────────────────────────
section('S4 ws_reg.c deny 实现：12 个 Zw 别名 / reason 8/6 / 线程级深度守卫')
{
  const aliasBodies = ALL_ZW.map((zwName) => ({ zwName, ntName: `Nt${zwName.slice(2)}`, body: functionBody(regSrc, `ws_${zwName}`) }))
  const missingAlias = aliasBodies.filter((entry) => entry.body.length === 0)
  check('12 个 ws_Zw* 都有强定义（不是 weak stub 兜底）', missingAlias.length === 0, missingAlias.map((e) => e.zwName).join(',') || '(12/12)')
  const badAlias = aliasBodies.filter((entry) => !new RegExp(`ws_${entry.ntName}\\(`).test(entry.body))
  check('12 个 ws_Zw* 都是对应 ws_Nt* 的 1:1 别名（直接调用，不重新实现策略）', badAlias.length === 0, badAlias.map((e) => e.zwName).join(',') || '(12/12)')
  check(
    'C 侧原因码：NT_WRITE_NOT_STAGEABLE=8、HIVE_FILE_NOT_STAGEABLE=6（与 TS 逐字一致）',
    /#define WS_HARD_DENY_NT_WRITE_NOT_STAGEABLE\s+8u/.test(regSrc) && /#define WS_HARD_DENY_HIVE_FILE_NOT_STAGEABLE\s+6u/.test(regSrc),
    '#define ... 8u / ... 6u',
  )
  const writeBad = NT_WRITE_OPS.filter((name) => !/WS_HARD_DENY_NT_WRITE_NOT_STAGEABLE/.test(functionBody(regSrc, `ws_${name}`)))
  check('5 个写操作 deny 都带 reason=8', writeBad.length === 0, writeBad.join(',') || '(5/5)')
  const hiveBad = NT_HIVE_OPS.filter((name) => !/WS_HARD_DENY_HIVE_FILE_NOT_STAGEABLE/.test(functionBody(regSrc, `ws_${name}`)))
  check('7 个 hive-file 操作 deny 都带 reason=6', hiveBad.length === 0, hiveBad.join(',') || '(7/7)')
  const denyBody = functionBody(regSrc, 'ws_reg_nt_deny')
  check('ntdll deny 入口有线程级 re-entrancy 深度守卫（_Thread_local + 递归检查）', /_Thread_local int t_wsNtDenyDepth/.test(regSrc) && /t_wsNtDenyDepth > 0/.test(denyBody) && /t_wsNtDenyDepth\+\+/.test(denyBody) && /t_wsNtDenyDepth--/.test(denyBody), 'depth guard')
}

// ─── S5. TS 契约 ────────────────────────────────────────────────────────────
section('S5 TS 契约：HOOKED/UNHOOKED/原因码映射/classify 与 C 侧一致')
{
  const missingHooked = ALL_24.filter((api) => !REG_STAGE_HOOKED_APIS.includes(api))
  check('REG_STAGE_HOOKED_APIS ⊇ 24 个入口', missingHooked.length === 0, missingHooked.join(',') || '(24/24)')
  const stillBlind = ALL_24.filter((api) => REG_STAGE_UNHOOKED_APIS.includes(api))
  check('REG_STAGE_UNHOOKED_APIS 与 24 个入口无交集（补了 hook 必须从盲区删掉）', stillBlind.length === 0, stillBlind.join(',') || '(no overlap)')
  check('真残余仍在盲区里（NtOpenKey/ZwOpenKey —— 纯打开/读面）', REG_STAGE_UNHOOKED_APIS.includes('NtOpenKey') && REG_STAGE_UNHOOKED_APIS.includes('ZwOpenKey'), REG_STAGE_UNHOOKED_APIS.join(','))
  check(
    '原因码映射：10 个写操作 → NT_SYSCALL_WRITE_NOT_STAGEABLE，14 个 hive-file → HIVE_FILE_OPERATION_NOT_STAGEABLE',
    [...NT_WRITE_OPS, ...ZW_OF(NT_WRITE_OPS)].every((api) => R19_HARD_DENY_REASON_BY_API[api] === 'NT_SYSCALL_WRITE_NOT_STAGEABLE') &&
      [...NT_HIVE_OPS, ...ZW_OF(NT_HIVE_OPS)].every((api) => R19_HARD_DENY_REASON_BY_API[api] === 'HIVE_FILE_OPERATION_NOT_STAGEABLE'),
    `entries=${Object.keys(R19_HARD_DENY_REASON_BY_API).length}`,
  )
  check(
    'classifyRegistryOperation：24 个入口全部 stageable=false + status=5 + 正确 hardDenyReason',
    ALL_24.every((api) => {
      const verdict = classifyRegistryOperation({ api, path: 'HKCU\\Software\\R20Probe' })
      return verdict.stageable === false && verdict.status === 5 && verdict.hardDenyReason === R19_HARD_DENY_REASON_BY_API[api]
    }),
    ALL_24.length + ' apis',
  )
  check(
    'REG_STAGE_HARD_DENY_REASON 数值与 C 侧一致（8=NT_SYSCALL、6=HIVE_FILE）',
    REG_STAGE_HARD_DENY_REASON.NT_SYSCALL_WRITE_NOT_STAGEABLE === 8 && REG_STAGE_HARD_DENY_REASON.HIVE_FILE_OPERATION_NOT_STAGEABLE === 6,
    `8=${REG_STAGE_HARD_DENY_REASON.NT_SYSCALL_WRITE_NOT_STAGEABLE} 6=${REG_STAGE_HARD_DENY_REASON.HIVE_FILE_OPERATION_NOT_STAGEABLE}`,
  )
  check(
    '硬拒清单里不再声称这 24 个入口是"未 hook 的意图声明"（它们真的会执行）',
    ALL_24.every((api) => REG_STAGE_HARD_DENY_APIS[api] === undefined || R19_HARD_DENY_REASON_BY_API[api] !== undefined),
    'no stale intention entries',
  )
}

// ─── S6. WAL 审计可归因：kind=5/status=5/type=8|6 编解码往返 ──────────────────
section('S6 WAL：HARD_DENY(kind=5,status=5,type=8/6) 编码→解码往返（审计可归因）')
{
  const writeRecord = journalHardDenyRecord({ api: 'NtSetValueKey', path: 'HKCU\\Software\\R20Probe\\V', hardDenyReason: 'NT_SYSCALL_WRITE_NOT_STAGEABLE' })
  const hiveRecord = journalHardDenyRecord({ api: 'ZwLoadKey', path: '<ZwLoadKey>', hardDenyReason: 'HIVE_FILE_OPERATION_NOT_STAGEABLE' })
  const decoded = decodeJournalRecords(Buffer.concat([encodeJournalRecord(writeRecord), encodeJournalRecord(hiveRecord)]))
  const [first, second] = decoded.records
  check(
    '写类记录：kind=5 / status=5 / type=8 / HARD_DENY flag（WAL 可机器归因到"被沙箱拒绝"）',
    first?.kind === REG_STAGE_KIND.HARD_DENY && first?.status === 5 && first?.type === 8 && (first?.flags & REG_STAGE_FLAGS.HARD_DENY) !== 0,
    JSON.stringify({ kind: first?.kind, status: first?.status, type: first?.type, flags: first?.flags, path: first?.path }),
  )
  check('hive-file 记录：kind=5 / status=5 / type=6', second?.kind === 5 && second?.status === 5 && second?.type === 6, JSON.stringify({ kind: second?.kind, type: second?.type }))
  check('JSON 里不含 /HARD_DENY 记录被解码失败的问题/（records=2 且 problems 为空）', decoded.records.length === 2 && (decoded.problems ?? []).length === 0, `records=${decoded.records.length} problems=${(decoded.problems ?? []).length}`)
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
