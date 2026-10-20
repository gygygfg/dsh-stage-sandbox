#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * tests/registry-unstaged-wow64.ts —— A2 段真实产物门（registry layer，契约 v1.4）
 *
 * 它钉的是**两条曾被写错、且都在真实负载上炸过**的规则：
 *
 *  (a) `KEY_WOW64_64KEY` 在 64 位进程里是 winreg.h **文档化的 no-op**。
 *      `RegCreateKeyExW` + `KEY_WOW64_64KEY` 去创建一个**还不存在**的键，必须
 *      **成功并正常暂存**（覆盖层拿到 CREATE_KEY/SET_VALUE，真实 hive 不动）。
 *      旧行为：`ws_create_key()` 拿**原始掩码**判"受限" ⇒ 返回 `ERROR_ACCESS_DENIED(5)`
 *      ⇒ CLR `0x80070005` / node `WSAStartup 10107`。
 *
 *  (b) R26 起 `KEY_WOW64_32KEY`（x64 进程）**可暂存**（合成前缀 + WAL view）；本套件的
 *      历史 fail-closed 断言已按 R26 更新（WOW64 进程内仍 fail-closed）。
 *      另一个 hive 位置（32 位视图），app hive 没有视图概念 ⇒ **透传真实 API**，
 *      并留下一条 `UNSTAGED`（kind 6）审计记录。旧行为：硬拒 5。
 *      本门用 `reg delete <key> /reg:32` 做这件事：整次调用**只有一步**（不经过
 *      "先拿真实句柄、再写值" 的分裂路径），因此"真实 hive 真的变了"可以被
 *      **字节级**验证（键在运行前存在、运行后消失）。
 *
 *  (c) `UNSTAGED` 记录**绝不能被重放**：它描述的调用**已经到达真实系统**，
 *      把它当覆盖层操作重放就是双重写入。因此候选（diff）与应用单元里都不许有它。
 *      这条同时用**真实 WAL 字节**（上一段跑出来的 overlay.journal）和**纯层**
 *      （`createRegistryStage` + 假 reader/writer）两边验证。
 *
 * 运行：
 *   $env:WINSTAGE_SHIM_OUT='esc\par\a2'; node tests\registry-unstaged-wow64.ts
 *
 * 产物缺失 ⇒ **显式 SKIP**（打印"未验证"，绝不算通过；与 registry-conformance 同一纪律）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  OVERLAY_JOURNAL_NAME,
  REGISTERED_HARD_DENIALS,
  REG_STAGE_FLAGS,
  REG_STAGE_HARD_DENY_REASON,
  REG_STAGE_KIND,
  REG_STAGE_UNSTAGED_REASON,
  HARD_DENY_STATUS,
  classifyRegistryOperation,
  createRegistryStage,
  decodeJournalRecords,
  encodeJournalRecord,
  journalRecordForOperation,
  journalUnstagedRecord,
  replayJournal,
  validateJournalBuffer,
} from '../src/registry-stage.ts'
import { REG_STATUS, diffSnapshots, normalizeSnapshot, parseRegistryPath } from '../src/registry-guard.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const OUT = process.env.WINSTAGE_SHIM_OUT ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : path.join(REPO, 'shim', 'out')
const SYS = process.env.SystemRoot || 'C:\\Windows'
const REG = path.join(SYS, 'System32', 'reg.exe')

const RUN_ID = crypto.randomBytes(4).toString('hex')
const STAGE = path.join(REPO, 'shim', '.stage', `a2-unstaged-${RUN_ID}`)
const EV = path.join(STAGE, 'evidence')
const JOURNAL = path.join(STAGE, 'registry', OVERLAY_JOURNAL_NAME)
const K64 = 'HKCU\\Software\\WinStageA2W64Probe'
const K32 = 'HKCU\\Software\\WinStageA2W32Gone'

let assertions = 0
let failures = 0
let skips = 0

const W = (text) => process.stdout.write(`${text}\n`)
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// ───────────────────────── 产物与启动器 ─────────────────────────
//
// 为什么要把 injector + DLL **复制到 %TEMP% 再跑**（不是洁癖，是判定力问题）：
// Windows 让新进程的完整性级别取**父进程令牌**与**映像文件强制标签**的较低者。
// 仓库目录 `...\Desktop\WinStageSandbox` 带 Low 强制标签（S-1-16-4096），因此仓库里
// 构建出来的 exe 也是 Low ⇒ 载体一启动就是 Low IL ⇒ **内核的 no-write-up 会拒绝
// 任何真实 hive 写入**，于是 (b) 的"真实 hive 真的变了"永远观测不到（而且失败原因
// 与本次改动无关）。`%TEMP%` 是**无标签**目录，复制过去跑出来的载体是 Medium/High。
// `tools/build-shim.ts` 现在也会把产物标签修回 Medium，但本门不依赖那个步骤。

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

function prepareLauncher() {
  const srcDll = path.join(OUT, 'winstage-shim.dll')
  const srcInjector = path.join(OUT, 'winstage-inject.exe')
  if (!fs.existsSync(srcDll) || !fs.existsSync(srcInjector)) {
    return null
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `winstage-a2-unstaged-${RUN_ID}-`))
  const dll = path.join(dir, 'winstage-shim.dll')
  const injector = path.join(dir, 'winstage-inject.exe')
  fs.copyFileSync(srcDll, dll)
  fs.copyFileSync(srcInjector, injector)
  return { dir, dll, injector, srcDll, srcInjector }
}

function runNative(exe, args, tag) {
  fs.mkdirSync(EV, { recursive: true })
  const out = path.join(EV, `${tag}.out.txt`)
  const err = path.join(EV, `${tag}.err.txt`)
  const o = fs.openSync(out, 'w')
  const e = fs.openSync(err, 'w')
  let res
  try {
    // 环境规则：绝不通过 PowerShell 管道捕获原生进程输出 —— 用 fd 落盘再读。
    res = spawnSync(exe, args, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 120000 })
  } finally {
    fs.closeSync(o)
    fs.closeSync(e)
  }
  return { status: res.status, stdout: readIfExists(out), stderr: readIfExists(err), outFile: out, errFile: err }
}

function runInjected(launcher, tag, childArgs, extraEnv = {}) {
  return runNative(launcher.injector, [
    '--dll', launcher.dll,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    ...Object.entries(extraEnv).flatMap(([key, value]) => ['--set-env', `${key}=${value}`]),
    '--report', path.join(EV, `${tag}.inject.json`),
    '--timeout-ms', '60000', '--child-timeout-ms', '120000',
    '--', ...childArgs,
  ], tag)
}

/** 32 位视图对 `HKCU\Software\X` 是否重定向到 `WOW6432Node` 由系统决定 ⇒ 两处都查。 */
function realKeyExists(keyPath) {
  const candidates = [keyPath, keyPath.replace('\\Software\\', '\\Software\\WOW6432Node\\')]
  for (const candidate of candidates) {
    const res = runNative(REG, ['query', candidate], `query-${candidate.replace(/[^A-Za-z0-9]/g, '_')}`)
    if (res.status === 0) return { exists: true, path: candidate, stdout: res.stdout }
  }
  return { exists: false, path: null, stdout: '' }
}

function cleanupRealKey(keyPath) {
  for (const candidate of [keyPath, keyPath.replace('\\Software\\', '\\Software\\WOW6432Node\\')]) {
    runNative(REG, ['delete', candidate, '/f'], `cleanup-${candidate.replace(/[^A-Za-z0-9]/g, '_')}`)
  }
}

// ───────────────────────── 纯层替身（候选/应用面）─────────────────────────

function createStubRegistry() {
  const keys = new Map()
  const writes = []
  const ensure = (p) => {
    const fold = p.toLowerCase()
    if (!keys.has(fold)) keys.set(fold, { path: p, values: new Map() })
    return keys.get(fold)
  }
  return {
    writes,
    reader: {
      read(p) {
        const { canonical } = parseRegistryPath(p)
        const record = keys.get(canonical.toLowerCase())
        if (!record) return { exists: false }
        const subKeys = []
        for (const other of keys.values()) {
          const parent = other.path.slice(0, other.path.lastIndexOf('\\'))
          if (parent.toLowerCase() === canonical.toLowerCase()) subKeys.push(other.path.slice(other.path.lastIndexOf('\\') + 1))
        }
        const values = {}
        for (const entry of record.values.values()) values[entry.name] = { type: entry.type, data: entry.data }
        return { exists: true, subKeys, values }
      },
    },
    writer: {
      createKey(p) {
        writes.push(['create-key', p])
        ensure(p)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      setValue(p, name, type, dataHex) {
        writes.push(['set-value', p, name, type, dataHex])
        ensure(p).values.set(String(name).toLowerCase(), { name, type, data: dataHex })
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteValue(p, name) {
        writes.push(['delete-value', p, name])
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteKey(p) {
        writes.push(['delete-key', p])
        keys.delete(p.toLowerCase())
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
    },
  }
}

// ─────────────────────────────── 主流程 ───────────────────────────────

function main() {
  fs.mkdirSync(EV, { recursive: true })

  const launcher = prepareLauncher()
  if (!launcher) {
    W(`registry-unstaged-wow64: 产物缺失（${OUT}）`)
    skip('A2 真实产物门（注册表 unstaged/WOW64）', `缺少 ${path.join(OUT, 'winstage-shim.dll')} 或 winstage-inject.exe：先运行 node tools\\build-shim.ts（或设置 WINSTAGE_SHIM_OUT）`)
    W('')
    W('='.repeat(72))
    W(`registry-unstaged-wow64 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项 —— **未验证**（产物缺失）`)
    W('='.repeat(72))
    process.exit(0)
  }

  let cleanExit = false
  try {
    // ── (a) 64KEY 是 no-op：新键必须能建、且进覆盖层 ──────────────────────────
    section('A. KEY_WOW64_64KEY 在 64 位进程里是 no-op：新建键必须成功并暂存（不再 ACCESS_DENIED）')
    {
      cleanupRealKey(K64)
      const before = realKeyExists(K64)
      check('前置：目标键在真实 hive 里不存在（否则测不到"创建"这条路径）', before.exists === false, `exists=${before.exists}`)

      const res = runInjected(launcher, 'w64-add', [REG, 'add', K64, '/v', 'T4W64', '/t', 'REG_SZ', '/d', 'staged', '/reg:64', '/f'])
      check('reg add /reg:64（RegCreateKeyExW + KEY_WOW64_64KEY）返回 0', res.status === 0, `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 200))} stderr=${JSON.stringify(res.stderr.slice(0, 200))}`)
      check(
        '输出里没有"拒绝访问 / Access is denied"（旧缺陷的签名）',
        !/拒绝访问|Access is denied/i.test(`${res.stdout}${res.stderr}`),
        JSON.stringify(`${res.stdout}${res.stderr}`.slice(0, 200)),
      )

      const after = realKeyExists(K64)
      check('真实 hive 仍然没有这个键（暂存 ≠ 真写）', after.exists === false, `exists=${after.exists}${after.path ? ` at ${after.path}` : ''}`)

      const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded = journal.length ? decodeJournalRecords(journal) : { records: [] }
      const staged = decoded.records.filter((record) => parseRegistryPathSafe(record.path) === K64)
      check(
        'WAL 里有这个键的 CREATE_KEY + SET_VALUE（"暂存成功"必须有记录）',
        staged.some((record) => record.kind === REG_STAGE_KIND.CREATE_KEY) && staged.some((record) => record.kind === REG_STAGE_KIND.SET_VALUE && record.valueName === 'T4W64'),
        decoded.records.map((record) => `${record.kindName}:${record.path}`).join(' ') || '(journal empty)',
      )
      check(
        'WAL 里**没有**这个键的 UNSTAGED/HARD_DENY 记录（no-op 视图位不该走透传，更不该被拒）',
        !staged.some((record) => record.kind === REG_STAGE_KIND.UNSTAGED || record.kind === REG_STAGE_KIND.HARD_DENY),
        staged.map((record) => record.kindName).join(' ') || '(none)',
      )
    }

    // ── (b) 32KEY 写/删类 ⇒ R26 起暂存化（x64 进程；apply 前真实 hive 不变）──────
    section('B. KEY_WOW64_32KEY 写/删 ⇒ 暂存化（x64 视图；apply 前真实 hive 不变）')
    {
      cleanupRealKey(K32)
      // 前置：用**未注入**的 reg.exe 在真实 32 视图预建键（HKCU\Software 本身两视图共享，
      // 但本套件只依赖"真实键存在"这一前置；apply 的视图隔离由 r26 套件在重定向区验证）。
      const setup = runNative(REG, ['add', K32, '/v', 'T4W32', '/t', 'REG_SZ', '/d', 'real', '/f', '/reg:32'], 'w32-setup')
      const seeded = realKeyExists(K32)
      const canSeedRealHive = setup.status === 0 && seeded.exists === true
      if (canSeedRealHive) {
        check('前置：真实 hive 里先建好这个键（未注入 reg.exe /reg:32）', true, `exit=${setup.status} exists=${seeded.exists}`)
      } else {
        skip(
          '前置：真实 hive 里先建好这个键（未注入的 reg.exe）',
          `宿主无法写真实 hive（低完整性/受限会话：exit=${setup.status}）⇒ 真机前置未验证，不是 PASS；WAL 断言仍执行`,
        )
      }

      const res = runInjected(launcher, 'w32-delete', [REG, 'delete', K32, '/reg:32', '/f'])
      check(
        'R26：reg delete /reg:32 **暂存成功**（exit=0，不再是 fail-closed 硬拒）',
        res.status === 0,
        `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 200))} stderr=${JSON.stringify(res.stderr.slice(0, 200))}`,
      )

      const stillThere = realKeyExists(K32)
      if (canSeedRealHive) {
        check(
          'apply 前真实 hive 的键**仍然存在且值完好**（暂存不写真实 hive）',
          stillThere.exists === true && /T4W32/.test(stillThere.stdout) === true,
          `exists=${stillThere.exists}${stillThere.path ? ` at ${stillThere.path}` : ''} stdout=${JSON.stringify(String(stillThere.stdout).slice(0, 160))}`,
        )
      } else {
        skip('apply 前真实 hive 的键**仍然存在且值完好**', '前置键本就没建成 ⇒ 该真机断言 SKIP')
      }

      const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded = decodeJournalRecords(journal)
      const stagedK32 = decoded.records.filter((record) => String(record.path).includes('__DSH_WOW64_32__') && String(record.path).toLowerCase().includes(K32.toLowerCase()) === false)
      const deleteK32 = decoded.records.filter(
        (record) => record.kind === REG_STAGE_KIND.DELETE_KEY && String(record.path).includes('__DSH_WOW64_32__'),
      )
      check(
        `WAL 里有 32 视图的暂存记录（DELETE_KEY，合成前缀 + reserved=1；type=${REG_STAGE_HARD_DENY_REASON.WOW64_32KEY_WRITE_NOT_STAGEABLE} 的 HARD_DENY 不再出现）`,
        deleteK32.length > 0 && deleteK32.every((record) => record.reserved === 1 && record.view === 1) &&
          !decoded.records.some((record) => record.kind === REG_STAGE_KIND.HARD_DENY && String(record.path).toLowerCase().includes(K32.toLowerCase())),
        decoded.records.map((record) => `${record.kindName}:${record.path}(view=${record.view})`).join(' ') || '(journal empty)',
      )
      check('真实 WAL 字节通过契约校验（含 reserved=1 视图字段）', validateJournalBuffer(journal).ok === true, JSON.stringify(validateJournalBuffer(journal).problems))

      // 32KEY **创建**同族：暂存而非真建空壳键
      const k32new = `${K32}New`
      cleanupRealKey(k32new)
      const created = runInjected(launcher, 'w32-create', [REG, 'add', `${k32new}\\shell`, '/reg:32', '/f'])
      const createdReal = realKeyExists(k32new)
      check(
        'R26：reg add /reg:32 创建键 ⇒ 暂存成功（exit=0）且真实 hive 不出现空壳键',
        created.status === 0 && createdReal.exists === false,
        `exit=${created.status} real=${createdReal.exists}${createdReal.path ? ` at ${createdReal.path}` : ''}`,
      )
      const journal2 = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded2 = decodeJournalRecords(journal2)
      check(
        '创建也留下 32 视图的 CREATE_KEY 暂存记录（合成前缀 + view=1，不是 HARD_DENY）',
        decoded2.records.some(
          (record) =>
            record.kind === REG_STAGE_KIND.CREATE_KEY &&
            String(record.path).includes('__DSH_WOW64_32__') &&
            String(record.path).toLowerCase().includes('winstagea2w32gonenew') &&
            record.reserved === 1,
        ),
        decoded2.records.filter((record) => String(record.path).toLowerCase().includes(k32new.toLowerCase())).map((record) => `${record.kindName}:${record.path}(view=${record.view})`).join(' ') || '(none)',
      )
    }

    // ── (c) 32KEY 写类已是硬拒；真正的 UNSTAGED 透传仍不得进候选/应用 ────────────
    section('C. 32KEY 写类=HARD_DENY；UNSTAGED 记录不得进入候选或应用单元')
    {
      // (c1) 真实 WAL（R26）：32KEY 记录是**暂存**（合成前缀 + view=1），不是 HARD_DENY
      const journal = fs.readFileSync(JOURNAL)
      const decoded = decodeJournalRecords(journal)
      const replay = replayJournal(decoded.records)
      check(
        '真实 WAL 里 32KEY 只有暂存记录（无 UNSTAGED、无 HARD_DENY；R18 的 fail-closed 已被 R26 取代）',
        !decoded.records.some((record) => record.kind === REG_STAGE_KIND.UNSTAGED) &&
          !decoded.records.some((record) => record.kind === REG_STAGE_KIND.HARD_DENY),
        decoded.records.map((record) => record.kindName).join(' '),
      )
      check(
        'replayJournal().hardDenied 为空（R26：32 视图不再硬拒）',
        replay.hardDenied.length === 0,
        JSON.stringify(replay.hardDenied.slice(0, 3)),
      )
      check(
        '32 视图暂存路径进 state.ops（合成前缀），64 视图不受影响',
        replay.state.ops.some((entry) => String(entry.path).includes('__DSH_WOW64_32__')) &&
          replay.state.ops.some((entry) => parseRegistryPathSafe(entry.path) === K64),
        replay.state.ops.map((entry) => `${entry.op}:${entry.path}`).join(' '),
      )
      check(
        'UNSTAGED 原因码清单仍在（1..4：读类透传 + 旧日志解码必须继续可读）',
        Object.values(REG_STAGE_UNSTAGED_REASON).every((code) => Number.isInteger(code) && code >= 1 && code <= 4),
        JSON.stringify(REG_STAGE_UNSTAGED_REASON),
      )
      check(
        'REGISTERED_HARD_DENIALS：sam 非空（WOW64 进程 fail-closed）+ hardDenyReasons 非空 + unstaged 清单非空',
        REGISTERED_HARD_DENIALS.sam.length > 0 &&
          (REGISTERED_HARD_DENIALS.hardDenyReasons?.length ?? 0) >= 3 &&
          REGISTERED_HARD_DENIALS.unstaged.length > 0,
        `sam=${REGISTERED_HARD_DENIALS.sam.length} reasons=${REGISTERED_HARD_DENIALS.hardDenyReasons?.length ?? 0} unstaged=${REGISTERED_HARD_DENIALS.unstaged.length}`,
      )

      // (c2) 纯层（R26 / R13 更新）：x64 进程里的 32KEY 写/删**可暂存**（合成前缀 + WAL view）；
      // WOW64 进程内仍 fail-closed；读类仍 unstaged 透传（staging 不投影读）。
      const pureDir = path.join(STAGE, 'pure')
      const stub = createStubRegistry()
      const stage = createRegistryStage({ sessionDir: pureDir, sessionId: 'a2-pure', reader: stub.reader, writer: stub.writer })
      stage.open()
      stage.stageCreateKey('HKCU\\Software\\PureA')
      const stagedWrite = stage.stageSetValue('HKCU\\Software\\PureA', 'V', 'REG_SZ', 'x')

      const viewVerdict = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: 'HKCU\\Software\\PureB', samDesired: 0x0200 })
      check(
        'R26：x64 进程里 32KEY 写类 ⇒ { stageable:true, view:1 }（不再是硬拒）',
        viewVerdict.stageable === true && viewVerdict.view === 1 && viewVerdict.flags?.view32 === true,
        JSON.stringify(viewVerdict),
      )
      const wowProcVerdict = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: 'HKCU\\Software\\PureB', samDesired: 0x0200, wow64Process: true })
      check(
        'R26：WOW64 进程内 32KEY 写类 ⇒ 仍 fail-closed（原因码 1，纵深防御）',
        wowProcVerdict.stageable === false && wowProcVerdict.hardDenyReason === 'WOW64_32KEY_WRITE_NOT_STAGEABLE',
        JSON.stringify(wowProcVerdict),
      )
      const readVerdict = classifyRegistryOperation({ api: 'RegQueryValueExW', path: 'HKCU\\Software\\PureB', samDesired: 0x0200 })
      check(
        '经典层：32KEY **读类** ⇒ 仍 unstaged 透传（无副作用）',
        readVerdict.stageable === false && readVerdict.unstaged === true && readVerdict.status === 0,
        JSON.stringify(readVerdict),
      )
      const noopVerdict = classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKCU\\Software\\PureC', samDesired: 0x0100 })
      check(
        'classifyRegistryOperation：64KEY（64 位进程）⇒ 可暂存（no-op，不是拒绝）',
        noopVerdict.stageable === true && noopVerdict.unstaged === undefined,
        JSON.stringify(noopVerdict),
      )

      let threw = null
      let del32 = null
      try {
        stage.stageCreateKey('HKCU\\Software\\PureB', { samDesired: 0x0200 })
        del32 = stage.stageDeleteKey('HKCU\\Software\\PureB', { samDesired: 0x0200 })
      } catch (error) {
        threw = error
      }
      check(
        'stageDeleteKey(samDesired=32KEY) 进暂存（R26；不再抛 REG_STAGE_HARD_DENY）',
        threw === null && del32 !== null && del32.net === true && del32.path === 'HKCU\\__DSH_WOW64_32__\\Software\\PureB',
        threw ? `throw=${threw.code}` : JSON.stringify(del32),
      )
      check(
        '覆盖层状态里的 PureB 只以**合成前缀**出现（64 视图里没有裸 PureB）',
        stage.getState().ops.every((entry) => !/^HKCU\\Software\\PureB/.test(entry.path)) &&
          stage.getState().ops.some((entry) => entry.path.includes('__DSH_WOW64_32__\\Software\\PureB')),
        stage.getState().ops.map((entry) => `${entry.op}:${entry.path}`).join(' '),
      )
      check('前置：PureA 的暂存确实进了状态（否则下面的"候选里没有 64 视图 PureB"就没有判定力）', stagedWrite.net === true && stage.getState().ops.some((entry) => parseRegistryPathSafe(entry.path)?.startsWith('HKCU\\Software\\PureA')), JSON.stringify(stagedWrite).slice(0, 200))

      const frozen = stage.freezeCandidate({ enqueue: false })
      const changePaths = (frozen.changes ?? []).map((change) => change.path)
      check('候选里没有 64 视图裸 PureB（32 视图状态只以合成路径存在）', !changePaths.some((p) => /^HKCU\\Software\\PureB/.test(p)), changePaths.join(' '))
      check('候选里有 PureA（正面判定力）', changePaths.some((p) => p.includes('PureA')), changePaths.join(' '))

      stub.writes.length = 0
      const applied = stage.apply({ force: true })
      check('apply() 的 writer 从未收到 64 视图裸 PureB 的单元（视图隔离）', !stub.writes.some((entry) => /^HKCU\\Software\\PureB$/i.test(String(entry[1]))), JSON.stringify(stub.writes))
      check('apply() 状态字段可用（applied/failed 数组）', Array.isArray(applied.applied) && Array.isArray(applied.failed), JSON.stringify({ status: applied.status }))

      // (c3) 真正的 UNSTAGED（路径不可派生 ⇒ 透传）仍不得进候选/应用；其路径下的
      //      overlay 值必须 appliable:false（R18 KNOWN-02，由候选一致性保证）。
      const handDir = path.join(STAGE, 'handwal')
      const handJournal = path.join(handDir, 'registry', OVERLAY_JOURNAL_NAME)
      fs.mkdirSync(path.dirname(handJournal), { recursive: true })
      const handRecords = [
        journalUnstagedRecord({ api: 'RegCreateKeyExW', path: 'HKCU\\Software\\Wsa', unstagedReason: 'UNRESOLVABLE_BASE_HANDLE' }),
        journalRecordForOperation({ op: 'create-key', path: 'HKCU\\Software\\Wsa' }),
        journalRecordForOperation({ op: 'set-value', path: 'HKCU\\Software\\Wsa', valueName: 'V', type: 'REG_SZ', value: 'x' }),
      ]
      const handBuffer = Buffer.concat(handRecords.map((record) => encodeJournalRecord(record)))
      fs.writeFileSync(handJournal, handBuffer)
      const handStage = createRegistryStage({ sessionDir: handDir, sessionId: 'a2-hand', reader: stub.reader, writer: stub.writer })
      handStage.open()
      const handFrozen = handStage.freezeCandidate({ enqueue: false })
      const handPaths = (handFrozen.candidate?.changes ?? []).map((change) => change.path)
      check(
        '手工 WAL：UNSTAGED 路径下的 overlay 值进候选但标 appliable:false（KNOWN-02 fail-closed）',
        handPaths.some((p) => /Wsa\\V$/i.test(p)) &&
          (handFrozen.candidate?.changes ?? []).find((change) => /Wsa\\V$/i.test(change.path))?.appliable === false,
        JSON.stringify(handPaths),
      )
      check('手工 WAL 通过契约校验', validateJournalBuffer(handBuffer).ok === true, JSON.stringify(validateJournalBuffer(handBuffer).problems))

      // 单条 UNSTAGED 记录的编解码必须自洽，且**混进一份日志后不得进状态**。
      const lone = journalUnstagedRecord({ api: 'RegSetValueExW', path: 'HKLM\\Software\\X', reason: 'test', unstagedReason: 'UNRESOLVABLE_BASE_HANDLE' })
      check(
        'journalUnstagedRecord 的形状：kind=6 / UNSTAGED 位 / type=原因码 / status=0 / 无 payload',
        lone.kind === REG_STAGE_KIND.UNSTAGED &&
          lone.flags === REG_STAGE_FLAGS.UNSTAGED &&
          lone.type === REG_STAGE_UNSTAGED_REASON.UNRESOLVABLE_BASE_HANDLE &&
          lone.status === 0 &&
          lone.valueName === null &&
          lone.data === null,
        JSON.stringify({ kind: lone.kind, flags: lone.flags, type: lone.type, status: lone.status }),
      )
      const loneBuffer = encodeJournalRecord(lone)
      const loneRound = decodeJournalRecords(loneBuffer)
      const loneReplay = replayJournal(loneRound.records)
      check(
        '单条 UNSTAGED 记录可编解码，replay 后 state.ops 为空、unstaged[] 有 1 条',
        loneRound.records.length === 1 &&
          loneRound.records[0].kindName === 'UNSTAGED' &&
          loneRound.records[0].type === REG_STAGE_UNSTAGED_REASON.UNRESOLVABLE_BASE_HANDLE &&
          loneReplay.state.ops.length === 0 &&
          loneReplay.unstaged.length === 1,
        JSON.stringify({ records: loneRound.records.length, ops: loneReplay.state.ops.length, unstaged: loneReplay.unstaged.length }),
      )
      check('单条 UNSTAGED 记录也通过契约校验', validateJournalBuffer(loneBuffer).ok === true, JSON.stringify(validateJournalBuffer(loneBuffer).problems))
      check(
        '契约校验有判定力：UNSTAGED 记录改成 status=5（伪装成硬拒）必须判红',
        (() => {
          const broken = Buffer.from(loneBuffer)
          broken.writeUInt32LE(5, 24 /* REG_STAGE_RECORD_OFFSETS.status */)
          const verdict = validateJournalBuffer(broken)
          return verdict.ok === false && verdict.problems.some((problem) => problem.code === 'UNSTAGED_STATUS_NONZERO')
        })(),
        'mutation: status 0 -> 5',
      )
      check(
        '契约校验有判定力：HARD_DENY 的 type 塞一个不存在的原因码必须判红',
        (() => {
          const bad = Buffer.from(encodeJournalRecord({ ...journalRecordForOperation({ op: 'create-key', path: 'HKLM\\X' }), kind: REG_STAGE_KIND.HARD_DENY, flags: REG_STAGE_FLAGS.HARD_DENY, type: 999, status: 5, valueName: null, data: null }))
          const verdict = validateJournalBuffer(bad)
          return verdict.ok === false && verdict.problems.some((problem) => problem.code === 'HARD_DENY_BAD_REASON')
        })(),
        'mutation: hard-deny type -> 999',
      )
      const diff = diffSnapshots(normalizeSnapshot({ root: 'HKLM\\Software\\X', exists: false }), normalizeSnapshot({ root: 'HKLM\\Software\\X', exists: false }))
      check('（自检）空 diff 为空 —— 证明上面的"候选里没有 B"不是靠 diff 恒空', diff.changes.length === 0, JSON.stringify(diff.summary))
    }

    cleanExit = true
  } finally {
    // 不留悬挂注入进程、不留临时键、不留临时目录。
    cleanupRealKey(K64)
    cleanupRealKey(K32)
    fs.rmSync(launcher.dir, { recursive: true, force: true })
    try {
      fs.rmSync(STAGE, { recursive: true, force: true })
    } catch {
      /* 证据目录可能被占用；保留不影响判定（下面会打印路径） */
    }
  }

  W('')
  W('='.repeat(72))
  W(`registry-unstaged-wow64 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`)
  W(`产物: ${OUT}  启动器: 临时目录（%TEMP%，无强制标签）  会话: shim\\.stage\\a2-unstaged-${RUN_ID}`)
  W('='.repeat(72))
  process.exit(failures ? 1 : cleanExit ? 0 : 1)
}

function parseRegistryPathSafe(p) {
  try {
    return parseRegistryPath(p).canonical
  } catch {
    return null
  }
}

try {
  main()
} catch (error) {
  console.error(`[registry-unstaged-wow64] FAILED: ${error.stack ?? error.message}`)
  process.exit(2)
}
