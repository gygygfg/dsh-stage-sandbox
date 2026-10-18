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
 *  (b) "覆盖层复现不了这次调用" **不是** "你没有权限"。`KEY_WOW64_32KEY` 指向的是
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

    // ── (b) 32KEY 写/删类 ⇒ fail-closed 硬拒（R18 / KNOWN-01）────────────────────
    section('B. KEY_WOW64_32KEY（覆盖层复现不了的视图）上的写/删 ⇒ fail-closed 硬拒（真实 hive 不变）')
    {
      cleanupRealKey(K32)
      const setup = runNative(REG, ['add', K32, '/v', 'T4W32', '/t', 'REG_SZ', '/d', 'real', '/f'], 'w32-setup')
      const seeded = realKeyExists(K32)
      /**
       * 前置"用**未注入**的 reg.exe 在真实 hive 预建键"需要宿主能写真实 hive。
       * 受限/低完整性会话里这一步必然失败（no-write-up），但它**不是**被测产品的行为：
       * 按纪律 SKIP 该前置（打印原因），后面的"返回码 / WAL HARD_DENY / 无 UNSTAGED"
       * 断言仍然执行 —— 那些才是本门要钉的东西。真机（Medium IL）重跑时该前置会真的跑。
       */
      const canSeedRealHive = setup.status === 0 && seeded.exists === true
      if (canSeedRealHive) {
        check('前置：真实 hive 里先建好这个键（用未注入的 reg.exe）', true, `exit=${setup.status} exists=${seeded.exists}`)
      } else {
        skip(
          '前置：真实 hive 里先建好这个键（用未注入的 reg.exe）',
          `宿主无法写真实 hive（低完整性/受限会话：exit=${setup.status}）⇒ 真机前置未验证，不是 PASS；返回码/WAL 断言仍执行`,
        )
      }

      const res = runInjected(launcher, 'w32-delete', [REG, 'delete', K32, '/reg:32', '/f'])
      check(
        'reg delete /reg:32（RegDeleteKeyExW + KEY_WOW64_32KEY）**返回非 0**（fail-closed 硬拒，不再是 exit=0 的真删）',
        res.status !== 0,
        `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 200))} stderr=${JSON.stringify(res.stderr.slice(0, 200))}`,
      )

      const stillThere = realKeyExists(K32)
      if (canSeedRealHive) {
        check(
          '真实 hive 里的键**仍然存在且值完好**（旧行为：被真删 —— R17 P0；R18 必须不变）',
          stillThere.exists === true && /T4W32/.test(stillThere.stdout) === true,
          `exists=${stillThere.exists}${stillThere.path ? ` at ${stillThere.path}` : ''} stdout=${JSON.stringify(String(stillThere.stdout).slice(0, 160))}`,
        )
      } else {
        skip(
          '真实 hive 里的键**仍然存在且值完好**',
          '前置键本就没建成（宿主不能写真实 hive）⇒ 该真机断言 SKIP（Medium IL 重跑必跑）',
        )
      }

      const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded = journal.length ? decodeJournalRecords(journal) : { records: [] }
      const hardDenied = decoded.records.filter((record) => record.kind === REG_STAGE_KIND.HARD_DENY)
      const forK32 = hardDenied.filter((record) => parseRegistryPathSafe(record.path) === K32)
      if (canSeedRealHive) {
        check(
          `WAL 里有 HARD_DENY 记录且点名了这个键（kind=5，type=${REG_STAGE_HARD_DENY_REASON.WOW64_32KEY_WRITE_NOT_STAGEABLE}=WOW64_32KEY_WRITE_NOT_STAGEABLE，status=${REG_STATUS.ERROR_ACCESS_DENIED}）`,
          forK32.some(
            (record) =>
              record.type === REG_STAGE_HARD_DENY_REASON.WOW64_32KEY_WRITE_NOT_STAGEABLE &&
              record.status === REG_STATUS.ERROR_ACCESS_DENIED &&
              (record.flags & REG_STAGE_FLAGS.HARD_DENY) !== 0,
          ),
          hardDenied.map((record) => `${record.kindName}:${record.path}(type=${record.type},status=${record.status})`).join(' ') || '(none)',
        )
      } else {
        // reg.exe 对"不存在的键"会在**调用 RegDeleteKeyEx 之前**自行报错（前置键没建成）
        // ⇒ 这里没有可归因的 HARD_DENY；创建用例（下一段）已覆盖同一条硬拒路径。
        skip(
          'WAL 里有 HARD_DENY 记录且点名了这个键（delete 用例）',
          '前置键未建成 ⇒ reg.exe 未调用 RegDeleteKeyEx；HARD_DENY 由下一段"创建被拒"断言覆盖',
        )
      }
      check(
        'WAL 里**没有**这个键的 UNSTAGED/DELETE_KEY（旧的行为指纹：透传 + UNSTAGED）',
        !decoded.records.some(
          (record) =>
            parseRegistryPathSafe(record.path) === K32 &&
            (record.kind === REG_STAGE_KIND.UNSTAGED || record.kind === REG_STAGE_KIND.DELETE_KEY),
        ),
        decoded.records.filter((record) => parseRegistryPathSafe(record.path) === K32).map((record) => record.kindName).join(' ') || '(none)',
      )
      check(
        '真实 WAL 字节通过契约校验（含 HARD_DENY 的 type=原因码）',
        validateJournalBuffer(journal).ok === true,
        JSON.stringify(validateJournalBuffer(journal).problems),
      )

      // 32KEY **创建**同族：真实 hive 必须不出现空壳键（R17 P0 的另一半）
      const k32new = `${K32}New`
      cleanupRealKey(k32new)
      const created = runInjected(launcher, 'w32-create', [REG, 'add', `${k32new}\\shell`, '/reg:32', '/f'])
      const createdReal = realKeyExists(k32new)
      check(
        'reg add /reg:32 创建键 ⇒ 返回非 0 且真实 hive 不出现空壳键',
        created.status !== 0 && createdReal.exists === false,
        `exit=${created.status} real=${createdReal.exists}${createdReal.path ? ` at ${createdReal.path}` : ''}`,
      )
      const journal2 = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded2 = decodeJournalRecords(journal2)
      check(
        '创建被拒也有 HARD_DENY(type=1) 审计记录（不是静默失败）',
        decoded2.records.some(
          (record) =>
            record.kind === REG_STAGE_KIND.HARD_DENY &&
            record.type === REG_STAGE_HARD_DENY_REASON.WOW64_32KEY_WRITE_NOT_STAGEABLE &&
            String(record.path).toLowerCase().includes(k32new.toLowerCase()),
        ),
        decoded2.records.filter((record) => String(record.path).toLowerCase().includes(k32new.toLowerCase())).map((record) => `${record.kindName}:${record.type}`).join(' ') || '(none)',
      )
    }

    // ── (c) 32KEY 写类已是硬拒；真正的 UNSTAGED 透传仍不得进候选/应用 ────────────
    section('C. 32KEY 写类=HARD_DENY；UNSTAGED 记录不得进入候选或应用单元')
    {
      // (c1) 真实 WAL：32KEY 写类产生 HARD_DENY（不进状态），K64 的暂存记录仍在
      const journal = fs.readFileSync(JOURNAL)
      const decoded = decodeJournalRecords(journal)
      const replay = replayJournal(decoded.records)
      check(
        '真实 WAL 里 32KEY 只有 HARD_DENY、没有 UNSTAGED（透传已被 fail-closed 取代）',
        !decoded.records.some((record) => record.kind === REG_STAGE_KIND.UNSTAGED) && decoded.records.some((record) => record.kind === REG_STAGE_KIND.HARD_DENY),
        decoded.records.map((record) => record.kindName).join(' '),
      )
      check(
        'replayJournal().hardDenied 带原因码 reasonName=WOW64_32KEY_WRITE_NOT_STAGEABLE',
        replay.hardDenied.some(
          (entry) =>
            entry.reasonCode === REG_STAGE_HARD_DENY_REASON.WOW64_32KEY_WRITE_NOT_STAGEABLE &&
            entry.reasonName === 'WOW64_32KEY_WRITE_NOT_STAGEABLE' &&
            entry.status === HARD_DENY_STATUS,
        ),
        JSON.stringify(replay.hardDenied.slice(0, 3)),
      )
      check(
        '硬拒路径不进 state.ops（覆盖层里什么都没发生）',
        !replay.state.ops.some((entry) => [K32, `${K32}New`].some((key) => String(parseRegistryPathSafe(entry.path) ?? '').startsWith(key))),
        replay.state.ops.map((entry) => `${entry.op}:${entry.path}`).join(' '),
      )
      check(
        '同一个 WAL 里的**暂存**记录仍然正常进状态（K64）',
        replay.state.ops.some((entry) => parseRegistryPathSafe(entry.path) === K64),
        replay.state.ops.map((entry) => `${entry.op}:${entry.path}`).join(' '),
      )
      check(
        'UNSTAGED 原因码清单仍在（1..4：读类透传 + 旧日志解码必须继续可读）',
        Object.values(REG_STAGE_UNSTAGED_REASON).every((code) => Number.isInteger(code) && code >= 1 && code <= 4),
        JSON.stringify(REG_STAGE_UNSTAGED_REASON),
      )
      check(
        'REGISTERED_HARD_DENIALS：sam 非空（WOW64 写类）+ hardDenyReasons 非空 + unstaged 清单非空',
        REGISTERED_HARD_DENIALS.sam.length > 0 &&
          (REGISTERED_HARD_DENIALS.hardDenyReasons?.length ?? 0) >= 3 &&
          REGISTERED_HARD_DENIALS.unstaged.length > 0,
        `sam=${REGISTERED_HARD_DENIALS.sam.length} reasons=${REGISTERED_HARD_DENIALS.hardDenyReasons?.length ?? 0} unstaged=${REGISTERED_HARD_DENIALS.unstaged.length}`,
      )

      // (c2) 纯层：32KEY 写类抛 REG_STAGE_HARD_DENY(status=5)；读类仍是 unstaged 透传
      const pureDir = path.join(STAGE, 'pure')
      const stub = createStubRegistry()
      const stage = createRegistryStage({ sessionDir: pureDir, sessionId: 'a2-pure', reader: stub.reader, writer: stub.writer })
      stage.open()
      stage.stageCreateKey('HKCU\\Software\\PureA')
      const stagedWrite = stage.stageSetValue('HKCU\\Software\\PureA', 'V', 'REG_SZ', 'x')

      const denyVerdict = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: 'HKCU\\Software\\PureB', samDesired: 0x0200 })
      check(
        '经典层：32KEY 写类 ⇒ { stageable:false, status:5, hardDenyReason=WOW64_32KEY_WRITE_NOT_STAGEABLE }',
        denyVerdict.stageable === false && denyVerdict.unstaged === undefined && denyVerdict.status === HARD_DENY_STATUS && denyVerdict.hardDenyReason === 'WOW64_32KEY_WRITE_NOT_STAGEABLE',
        JSON.stringify(denyVerdict),
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
      try {
        stage.stageDeleteKey('HKCU\\Software\\PureB', { samDesired: 0x0200 })
      } catch (error) {
        threw = error
      }
      check(
        'stageDeleteKey(samDesired=32KEY) 抛 REG_STAGE_HARD_DENY 且 status=5（fail-closed 硬拒）',
        threw !== null && threw.code === 'REG_STAGE_HARD_DENY' && threw.status === HARD_DENY_STATUS,
        threw ? `${threw.code}: status=${threw.status}` : 'no throw',
      )
      check(
        '覆盖层状态里没有 PureB（硬拒 ⇒ 覆盖层里什么都不该发生）',
        stage.getState().ops.every((entry) => parseRegistryPathSafe(entry.path) !== 'HKCU\\Software\\PureB'),
        stage.getState().ops.map((entry) => `${entry.op}:${entry.path}`).join(' '),
      )
      check('前置：PureA 的暂存确实进了状态（否则下面的"候选里有 A 没 B"就没有判定力）', stagedWrite.net === true && stage.getState().ops.some((entry) => parseRegistryPathSafe(entry.path)?.startsWith('HKCU\\Software\\PureA')), JSON.stringify(stagedWrite).slice(0, 200))

      const frozen = stage.freezeCandidate({ enqueue: false })
      const changePaths = (frozen.changes ?? []).map((change) => change.path)
      check('候选里没有 PureB（硬拒不进候选）', !changePaths.some((p) => p.includes('PureB')), changePaths.join(' '))
      check('候选里有 PureA（正面判定力）', changePaths.some((p) => p.includes('PureA')), changePaths.join(' '))

      stub.writes.length = 0
      const applied = stage.apply({ force: true })
      check('apply() 的 writer 从未收到 PureB 的单元', !stub.writes.some((entry) => String(entry[1]).includes('PureB')), JSON.stringify(stub.writes))
      check('apply() 也没把 PureB 记成 applied', !applied.applied.some((unit) => unit.path.includes('PureB')), JSON.stringify({ applied: applied.applied, status: applied.status }))

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
