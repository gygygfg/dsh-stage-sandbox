#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R21 新增（离线）。
/**
 * r21-registry-apply —— R21 / G2：注册表 **apply 正确性对抗样本**（离线）
 *
 * 存在理由：R20 的 `registry-guard`（394 断言）覆盖快照/diff/回滚，但**缺 apply 端到端
 * 对抗样本**。本套件用 `createRegistryStage` + 可观测的**假真实 hive/写入器**（只在 writer
 * 被调用时才改变内容）钉住以下边界：
 *
 *   S1 大值：128 KiB REG_BINARY / 96 KiB REG_SZ 的暂存→读回→WAL→apply 逐字节一致；
 *   S2 默认值（空值名 ""）：`RegSetValueExW(name="")` 的单元路径是 `\@`，apply 用空名写；
 *   S3 非空键删除：有子键 ⇒ `REG_STAGE_KEY_HAS_CHILDREN`（真实 API 同样拒绝）；仅有值 ⇒
 *      可暂存且 apply 真删；`recursive:true` ⇒ apply 传 recursive 并删子树（设计边界，见 findings）；
 *   S4 符号链接键 / REG_LINK：`REG_OPTION_CREATE_LINK`/`OPEN_LINK`/`BACKUP_RESTORE` 与
 *      `REG_LINK` 值类型必须 fail-closed（REG_STAGE_HARD_DENY，status=5），零写入；
 *   S5 volatile：`REG_OPTION_VOLATILE` 必须一路保留到 writer.createKey({dwOptions})；
 *   S6 32 位视图：写类带 `KEY_WOW64_32KEY` ⇒ fail-closed（不是静默写另一个视图）；
 *   S7 重名值/类型冲突：同一值单元在 WAL 里有**多条**操作时，apply 必须按 WAL 顺序重放
 *      并到达覆盖层终态（R21 实测 BUG：旧实现把同路径第二条单元当 `already-applied` 跳过，
 *      结果真实 hive 停在**第一条**的值 ⇒ 与覆盖层终态分叉。本套件先红后绿）。
 *
 * 用法：node tests\r21-registry-apply.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_VALUE_SUFFIX,
  KEY_WOW64,
  REG_APPLY_LOCK_NAME,
  REG_OPTIONS,
  REG_STAGE_FLAGS,
  createRegistryStage,
  decodeJournalRecords,
  encodeJournalRecord,
  journalRecordForOperation,
  readRegistryJournal,
  resolveRegistryApplyLockPath,
} from '../src/registry-stage.ts'
import { REG_STATUS, decodeRegistryValue, encodeRegistryValue, parseRegistryPath } from '../src/registry-guard.ts'

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  return condition
}
function checkThrows(name, fn, code) {
  try {
    fn()
    check(name, false, '没有抛错')
  } catch (error) {
    check(name, code === undefined || error.code === code, `code=${error.code} status=${error.status} message=${String(error.message).slice(0, 120)}`)
    return error
  }
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// ─────────────────────── 假真实 hive + 可观测 writer ───────────────────────
function createFakeRegistry(seed = []) {
  const keys = new Map() // fold(path) → { path, values: Map(foldName → { name, type, data }) }
  const log = { reads: 0, writes: [] }
  const ensure = (registryPath) => {
    const fold = registryPath.toLowerCase()
    if (!keys.has(fold)) keys.set(fold, { path: registryPath, values: new Map() })
    return keys.get(fold)
  }
  const parentOf = (registryPath) => {
    const index = registryPath.lastIndexOf('\\')
    return index <= 0 ? undefined : registryPath.slice(0, index)
  }
  const lastSegment = (registryPath) => registryPath.slice(registryPath.lastIndexOf('\\') + 1)
  for (const [registryPath, name, type, data] of seed) ensure(registryPath).values.set(String(name).toLowerCase(), { name, type, data })

  const deleteTree = (canonical) => {
    const fold = canonical.toLowerCase()
    keys.delete(fold)
    for (const other of [...keys.keys()]) if (other.startsWith(`${fold}\\`)) keys.delete(other)
  }

  return {
    keys,
    log,
    reader: {
      read(registryPath) {
        log.reads += 1
        const { canonical } = parseRegistryPath(registryPath)
        const fold = canonical.toLowerCase()
        const record = keys.get(fold)
        if (!record) return { exists: false }
        const subKeys = []
        for (const other of keys.values()) {
          const parent = parentOf(other.path)
          if (parent !== undefined && parent.toLowerCase() === fold) subKeys.push(lastSegment(other.path))
        }
        const values = {}
        for (const entry of record.values.values()) values[entry.name] = { type: entry.type, data: entry.data }
        return { exists: true, subKeys, values }
      },
    },
    writer: {
      createKey(registryPath, options = {}) {
        log.writes.push(['create-key', registryPath, options?.dwOptions ?? 0, options?.view ?? 0])
        ensure(registryPath)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      setValue(registryPath, name, type, dataHex, options = {}) {
        log.writes.push(['set-value', registryPath, name, type, dataHex, options?.view ?? 0])
        ensure(registryPath).values.set(String(name).toLowerCase(), { name, type, data: decodeRegistryValue(type, dataHex, name) })
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteValue(registryPath, name, options = {}) {
        log.writes.push(['delete-value', registryPath, name, options?.view ?? 0])
        const record = keys.get(registryPath.toLowerCase())
        if (record) record.values.delete(String(name).toLowerCase())
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteKey(registryPath, options = {}) {
        log.writes.push(['delete-key', registryPath, options?.recursive === true, options?.view ?? 0])
        deleteTree(registryPath)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
    },
    /** 外部程序直接改真实 hive（用于 stale 判定的对照） */
    mutate(registryPath, name, type, data) {
      ensure(registryPath).values.set(String(name).toLowerCase(), { name, type, data })
    },
    valueOf(registryPath, name) {
      const record = keys.get(registryPath.toLowerCase())
      return record?.values.get(String(name).toLowerCase())
    },
    exists(registryPath) {
      return keys.has(registryPath.toLowerCase())
    },
  }
}

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-r21-apply-'))
let sessionSeq = 0
function newStage(real, tag) {
  sessionSeq += 1
  const sessionDir = join(workRoot, `${tag}-${sessionSeq}`)
  const stage = createRegistryStage({ sessionDir, sessionId: `r21-${sessionSeq}`, reader: real.reader, writer: real.writer })
  stage.open()
  return stage
}

const KEY = 'HKCU\\Software\\R21Apply'

function seedRegistry() {
  const real = createFakeRegistry([
    ['HKCU\\Software\\R21Apply', 'Seed', 'REG_SZ', 'seed'],
    [`${KEY}\\WithChild`, 'C', 'REG_SZ', 'child-key-value'],
    [`${KEY}\\WithChild\\Child`, 'G', 'REG_SZ', 'grandchild'],
    [`${KEY}\\WithValues`, 'V', 'REG_SZ', 'orig'],
    [`${KEY}\\Dup`, 'V', 'REG_SZ', 'orig'],
    [`${KEY}\\Seq`, 'W', 'REG_SZ', 'orig'],
    [`${KEY}\\LinkBase`, 'L', 'REG_SZ', 'link-base'],
  ])
  return real
}

try {
  // ═══════════════════════ S1 大值 ═══════════════════════
  section('S1 大值：128 KiB REG_BINARY / 96 KiB REG_SZ 的暂存→WAL→apply')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's1')
    const bigBinary = Buffer.alloc(128 * 1024)
    for (let i = 0; i < bigBinary.length; i += 1) bigBinary[i] = (i * 31 + 7) & 0xff
    const bigBinaryHex = bigBinary.toString('hex')
    const bigString = 'x'.repeat(96 * 1024)
    let staged = true
    try {
      stage.stageSetValue(KEY, 'BigBin', 'REG_BINARY', bigBinary)
      stage.stageSetValue(KEY, 'BigStr', 'REG_SZ', bigString)
    } catch (error) {
      staged = false
      check('S1.1 大值可以被暂存（不因大小被拒）', false, `code=${error.code} message=${String(error.message).slice(0, 160)}`)
    }
    if (staged) {
      check('S1.1 大值可以被暂存（不因大小被拒）', true, 'REG_BINARY 128KiB + REG_SZ 96KiB')
      const readBin = stage.readValue(KEY, 'BigBin')
      const readStr = stage.readValue(KEY, 'BigStr')
      check('S1.2 读回大 REG_BINARY 与写入逐字节一致', readBin.status === 0 && readBin.data === bigBinaryHex, `status=${readBin.status} bytes=${readBin.data?.length}`)
      check('S1.3 读回大 REG_SZ 与写入逐字符一致', readStr.status === 0 && decodeRegistryValue('REG_SZ', readStr.data, 'BigStr') === bigString, `status=${readStr.status} chars=${decodeRegistryValue('REG_SZ', readStr.data, 'BigStr')?.length}`)
      const frozen = stage.freezeCandidate()
      check('S1.4 冻结候选包含两个大值单元', frozen.candidate !== undefined && (frozen.candidate.changes ?? []).filter((change) => change.path.endsWith('BigBin') || change.path.endsWith('BigStr')).length === 2, `changes=${(frozen.candidate?.changes ?? []).length}`)
      // WAL 记录也必须是完整负载（dataBytes 精确）
      const journal = readRegistryJournal(join(workRoot, `s1-${sessionSeq}`, 'registry', 'overlay.journal'))
      const binRecord = journal.records.find((record) => record.kindName === 'SET_VALUE' && record.valueName === 'BigBin')
      check('S1.5 WAL 里大二进制记录 dataBytes=131072（未被截断）', binRecord !== undefined && binRecord.data === bigBinaryHex, `dataLen=${binRecord?.data?.length} status=${binRecord?.status}`)
      const apply = stage.apply()
      check('S1.6 apply 成功（applied=2, failed=0）', apply.failed.length === 0 && apply.applied.length >= 2, JSON.stringify({ applied: apply.applied.length, failed: apply.failed, skipped: apply.skipped.map((s) => s.reason) }))
      const storedBin = real.valueOf(KEY, 'BigBin')
      const storedStr = real.valueOf(KEY, 'BigStr')
      check('S1.7 apply 后真实 hive 的 REG_BINARY 与写入逐字节一致', storedBin !== undefined && encodeRegistryValue('REG_BINARY', storedBin.data) === bigBinaryHex, `type=${storedBin?.type}`)
      check('S1.8 apply 后真实 hive 的 REG_SZ 与写入逐字符一致', storedStr !== undefined && encodeRegistryValue('REG_SZ', storedStr.data) === encodeRegistryValue('REG_SZ', bigString), `chars=${String(storedStr?.data).length}`)
    }
  }

  // ═══════════════════════ S2 默认值（空值名 ""） ═══════════════════════
  section('S2 默认值（空值名 ""）：单元路径 \\@、WAL、apply 均使用空名')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's2')
    stage.stageSetValue(KEY, '', 'REG_SZ', 'default-value')
    const read = stage.readValue(KEY, '')
    check('S2.1 默认值可暂存并按空名读回', read.status === 0 && decodeRegistryValue('REG_SZ', read.data, '') === 'default-value', `status=${read.status}`)
    const record = journalRecordForOperation({ op: 'set-value', path: KEY, valueName: '', type: 'REG_SZ', value: 'default-value' })
    const roundTrip = decodeJournalRecords(encodeJournalRecord(record)).records[0]
    check('S2.2 默认值 WAL 记录 valueName 为空串（不是 null/丢失）', roundTrip !== undefined && roundTrip.valueName === '', JSON.stringify({ valueName: roundTrip?.valueName, flags: roundTrip?.flags }))
    const frozen = stage.freezeCandidate()
    const unit = (frozen.candidate?.changes ?? []).find((change) => change.path === `${KEY}${DEFAULT_VALUE_SUFFIX}`)
    check('S2.3 冻结候选的默认值单元路径以 \\@ 结尾（与文件侧约定一致）', unit !== undefined, JSON.stringify((frozen.candidate?.changes ?? []).map((change) => change.path)))
    const apply = stage.apply()
    const write = real.log.writes.find((entry) => entry[0] === 'set-value' && entry[1] === KEY && entry[2] === '')
    check('S2.4 apply 用空值名写入真实 hive', apply.failed.length === 0 && write !== undefined, JSON.stringify(real.log.writes))
    check('S2.5 apply 后真实 hive 默认值存在且内容一致', encodeRegistryValue('REG_SZ', real.valueOf(KEY, '').data) === encodeRegistryValue('REG_SZ', 'default-value'), JSON.stringify(real.valueOf(KEY, '')))

    // 默认值删除
    const realDel = seedRegistry()
    realDel.mutate(KEY, '', 'REG_SZ', 'to-delete')
    const stageDel = newStage(realDel, 's2del')
    stageDel.stageDeleteValue(KEY, '')
    const applyDel = stageDel.apply()
    check('S2.6 默认值可暂存删除并 apply 用空名删除', applyDel.failed.length === 0 && realDel.valueOf(KEY, '') === undefined, JSON.stringify(realDel.log.writes))
  }

  // ═══════════════════════ S3 非空键删除 ═══════════════════════
  section('S3 非空键删除：有子键 ⇒ KEY_HAS_CHILDREN；仅值 ⇒ 真删；recursive 边界')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's3')
    const childErr = checkThrows('S3.1 有子键时非递归删除抛 REG_STAGE_KEY_HAS_CHILDREN（真实 API 同判）', () => stage.stageDeleteKey(`${KEY}\\WithChild`), 'REG_STAGE_KEY_HAS_CHILDREN')
    check('S3.2 抛错带原始 LSTATUS ERROR_KEY_HAS_CHILDREN(1020)', childErr?.status === REG_STATUS.ERROR_KEY_HAS_CHILDREN, `status=${childErr?.status}`)
    check('S3.3 被拒的删除没有产生任何候选/写入', stage.freezeCandidate().enqueued === false && real.log.writes.length === 0, `writes=${real.log.writes.length}`)

    // 仅有值（无子键）⇒ 允许删除，apply 真删
    const real2 = seedRegistry()
    const stage2 = newStage(real2, 's3b')
    stage2.stageDeleteKey(`${KEY}\\WithValues`)
    const apply2 = stage2.apply()
    check('S3.4 仅含值的键可以暂存删除并 apply 成功', apply2.failed.length === 0 && apply2.applied.some((unit) => unit.op === 'delete-key'), JSON.stringify(apply2))
    check('S3.5 apply 后真实 hive 的键（含其值）真的被删', real2.exists(`${KEY}\\WithValues`) === false, `writes=${JSON.stringify(real2.log.writes)}`)

    // recursive:true ⇒ 允许；apply 向 writer 传 recursive（设计边界，如实记录）
    const real3 = seedRegistry()
    const stage3 = newStage(real3, 's3c')
    stage3.stageDeleteKey(`${KEY}\\WithChild`, { recursive: true })
    const apply3 = stage3.apply()
    const recursiveWrite = real3.log.writes.find((entry) => entry[0] === 'delete-key' && entry[1] === `${KEY}\\WithChild`)
    check('S3.6 recursive:true 的删除可暂存且 apply 传 recursive=true', apply3.failed.length === 0 && recursiveWrite?.[2] === true, JSON.stringify(real3.log.writes))
    check('S3.7 apply 后整棵子树被删（设计边界：子键未单独审批也随父键删除）', !real3.exists(`${KEY}\\WithChild`) && !real3.exists(`${KEY}\\WithChild\\Child`), `writes=${JSON.stringify(real3.log.writes)}`)
  }

  // ═══════════════════════ S4 符号链接键 / REG_LINK ═══════════════════════
  section('S4 符号链接键 / REG_LINK：全部 fail-closed，零写入')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's4')
    const linkErr = checkThrows('S4.1 REG_OPTION_CREATE_LINK fail-closed（REG_STAGE_HARD_DENY, status=5）', () => stage.stageCreateKey(`${KEY}\\LinkNew`, { dwOptions: REG_OPTIONS.REG_OPTION_CREATE_LINK }), 'REG_STAGE_HARD_DENY')
    check('S4.2 CREATE_LINK 的 status=5', linkErr?.status === REG_STATUS.ERROR_ACCESS_DENIED, `status=${linkErr?.status}`)
    checkThrows('S4.3 REG_OPTION_OPEN_LINK fail-closed', () => stage.stageCreateKey(`${KEY}\\LinkNew`, { dwOptions: REG_OPTIONS.REG_OPTION_OPEN_LINK }), 'REG_STAGE_HARD_DENY')
    checkThrows('S4.4 REG_OPTION_BACKUP_RESTORE fail-closed', () => stage.stageCreateKey(`${KEY}\\LinkNew`, { dwOptions: REG_OPTIONS.REG_OPTION_BACKUP_RESTORE }), 'REG_STAGE_HARD_DENY')
    const linkValueErr = checkThrows('S4.5 REG_LINK 值类型 fail-closed（无编解码器）', () => stage.stageSetValue(`${KEY}\\LinkBase`, 'L2', 'REG_LINK', '\\Registry\\Machine\\X'), 'REG_STAGE_HARD_DENY')
    check('S4.6 REG_LINK 的 status=5', linkValueErr?.status === REG_STATUS.ERROR_ACCESS_DENIED, `status=${linkValueErr?.status}`)
    check('S4.7 所有链接类拒绝都零真实写入、零候选', real.log.writes.length === 0 && stage.freezeCandidate().enqueued === false, `writes=${real.log.writes.length}`)
  }

  // ═══════════════════════ S5 volatile ═══════════════════════
  section('S5 volatile：REG_OPTION_VOLATILE 一路保留到 writer.createKey')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's5')
    stage.stageCreateKey(`${KEY}\\VolatileKey`, { dwOptions: REG_OPTIONS.REG_OPTION_VOLATILE })
    const record = journalRecordForOperation({ op: 'create-key', path: `${KEY}\\VolatileKey`, dwOptions: REG_OPTIONS.REG_OPTION_VOLATILE })
    check('S5.1 WAL 记录带 VOLATILE 标志位', (record.flags & REG_STAGE_FLAGS.VOLATILE) !== 0, `flags=0x${record.flags.toString(16)}`)
    const frozen = stage.freezeCandidate()
    check('S5.2 候选创建了 volatile 键', frozen.candidate !== undefined && (frozen.candidate.changes ?? []).some((change) => change.path === `${KEY}\\VolatileKey`), JSON.stringify((frozen.candidate?.changes ?? []).map((c) => [c.path, c.op])))
    const apply = stage.apply()
    const write = real.log.writes.find((entry) => entry[0] === 'create-key' && entry[1] === `${KEY}\\VolatileKey`)
    check('S5.3 apply 向 writer.createKey 传 dwOptions=REG_OPTION_VOLATILE', apply.failed.length === 0 && write !== undefined && write[2] === REG_OPTIONS.REG_OPTION_VOLATILE, JSON.stringify(real.log.writes))
  }

  // ═══════════════════════ S6 32 位视图（R26 起改为暂存化） ═══════════════════════
  section('S6 32 位视图：写/删进暂存（合成前缀+WAL view），apply 只落 32 视图')
  {
    const real = seedRegistry()
    const stage = newStage(real, 's6')
    const setRes = stage.stageSetValue(KEY, 'V32', 'REG_SZ', 'x', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check(
      'S6.1 stageSetValue + KEY_WOW64_32KEY 进暂存（合成前缀，不再硬拒）',
      setRes?.net === true && String(setRes?.path).startsWith('HKCU\\__DSH_WOW64_32__\\'),
      setRes ? setRes.path : 'no result',
    )
    check('S6.2 WAL 记录 reserved=1（视图字段）', setRes?.record?.reserved === 1, JSON.stringify(setRes?.record))
    check('S6.3 64 视图看不到 32 视图的暂存值（命名空间隔离）', stage.readValue(KEY, 'V32').status !== 0, JSON.stringify(stage.readValue(KEY, 'V32')))
    const delRes = stage.stageDeleteKey(`${KEY}\\WithValues`, { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S6.4 stageDeleteKey + KEY_WOW64_32KEY 进暂存（仅 32 视图）', delRes?.net === true, delRes ? delRes.path : 'no result')
    const createRes = stage.stageCreateKey(`${KEY}\\WowNew`, { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S6.5 stageCreateKey + KEY_WOW64_32KEY 进暂存（仅 32 视图）', createRes?.net === true, createRes ? createRes.path : 'no result')
    check('S6.6 apply 前真实 hive 零写入', real.log.writes.length === 0, `writes=${real.log.writes.length}`)
    const frozen = stage.freezeCandidate()
    const viewChanges = (frozen.candidate?.changes ?? []).filter((change) => String(change.path).includes('__DSH_WOW64_32__'))
    const wantedViewPaths = [`${KEY}\\WowNew`, `${KEY}\\WithValues`, `${KEY}\\V32`]
    check(
      'S6.7 候选能区分视图：3 个目标单元 displayPath 带 [32] 且 registryView=WOW64_32',
      wantedViewPaths.every((wanted) =>
        viewChanges.some(
          (change) => change.registryView === 'WOW64_32' && String(change.displayPath) === `[32] ${wanted}`,
        ),
      ) && viewChanges.every((change) => change.registryView === 'WOW64_32' && String(change.displayPath).startsWith('[32] ')),
      JSON.stringify(viewChanges.map((change) => [change.displayPath, change.registryView])),
    )
    const apply = stage.apply()
    const writes = real.log.writes
    check('S6.8 apply 成功（applied>0, failed=0）', apply.failed.length === 0 && apply.applied.length > 0, JSON.stringify(apply.failed))
    check(
      'S6.9 apply 的 writer 调用带 view=1 且路径是**真实路径**（无合成段）',
      writes.length > 0 && writes.every((entry) => !String(entry[1]).includes('__DSH_WOW64_32__') && entry[entry.length - 1] === 1),
      JSON.stringify(writes),
    )
  }

  // ═══════════════════════ S7 重名值 / 类型冲突（R21 修复） ═══════════════════════
  section('S7 重名值/类型冲突：apply 必须按 WAL 顺序重放到覆盖层终态')
  {
    // 7a：同一值连续两次不同值（类型也变）⇒ 真实 hive 必须是**最后一次**
    const real = seedRegistry()
    const stage = newStage(real, 's7a')
    stage.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_SZ', 'first')
    stage.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_DWORD', 42)
    const read = stage.readValue(`${KEY}\\Dup`, 'V')
    check('S7.1 覆盖层终态读回是最后一次写入（REG_DWORD 42）', read.status === 0 && read.type === 'REG_DWORD' && decodeRegistryValue('REG_DWORD', read.data) === 42, JSON.stringify(read))
    const apply = stage.apply()
    const stored = real.valueOf(`${KEY}\\Dup`, 'V')
    check(
      'S7.2 apply 后真实 hive 的值 = 覆盖层终态（旧实现会停在第一条 "first"）',
      stored !== undefined && stored.type === 'REG_DWORD' && stored.data === 42,
      JSON.stringify({ stored, writes: real.log.writes, applied: apply.applied, skipped: apply.skipped }),
    )
    check('S7.3 apply 不把同路径第二条单元误报为 already-applied 而丢写', apply.failed.length === 0 && apply.status === 'applied', JSON.stringify({ status: apply.status, skipped: apply.skipped.map((s) => s.reason), remaining: apply.remaining }))

    // 7b：写值后删除 ⇒ 真实 hive 必须是"已删除"
    const real2 = seedRegistry()
    const stage2 = newStage(real2, 's7b')
    stage2.stageSetValue(`${KEY}\\Seq`, 'W', 'REG_SZ', 'changed')
    stage2.stageDeleteValue(`${KEY}\\Seq`, 'W')
    const frozen2 = stage2.freezeCandidate()
    check('S7.4 set→delete 的净变化是删除（不是 set-value）', (frozen2.candidate?.changes ?? []).some((change) => change.path === `${KEY}\\Seq\\W` && (change.op === 'delete' || change.op === 'delete-value')), JSON.stringify((frozen2.candidate?.changes ?? []).map((c) => [c.path, c.op])))
    const apply2 = stage2.apply()
    check(
      'S7.5 apply 后真实 hive 的值真的被删（旧实现会留下 "changed"）',
      real2.valueOf(`${KEY}\\Seq`, 'W') === undefined,
      JSON.stringify({ stored: real2.valueOf(`${KEY}\\Seq`, 'W'), writes: real2.log.writes, applied: apply2.applied, skipped: apply2.skipped }),
    )
    check('S7.6 set→delete 单元全部应用、无 failed', apply2.failed.length === 0 && apply2.status === 'applied', JSON.stringify({ status: apply2.status, failed: apply2.failed }))

    // 7c：类型变化（REG_SZ → REG_QWORD 大数）也必须按最后类型落盘
    const real3 = seedRegistry()
    const stage3 = newStage(real3, 's7c')
    stage3.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_SZ', 'text')
    stage3.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_QWORD', 18446744073709551615n)
    stage3.freezeCandidate()
    const apply3 = stage3.apply()
    const stored3 = real3.valueOf(`${KEY}\\Dup`, 'V')
    check('S7.7 REG_SZ→REG_QWORD 类型变化 apply 后类型与值都正确', apply3.failed.length === 0 && stored3?.type === 'REG_QWORD' && stored3?.data === 18446744073709551615n, `stored=${stored3?.type}/${String(stored3?.data)} failed=${JSON.stringify(apply3.failed)}`)

    // 7d：跨 apply 调用仍然幂等（第二次 apply 不再写）
    const second = stage3.apply()
    check('S7.8 二次 apply 幂等（applied=0，无重复写入）', second.applied.length === 0, JSON.stringify({ applied: second.applied, skipped: second.skipped.map((s) => s.reason) }))
  }

  // ═══════════════════════ S8 跨进程 apply 锁（R41 / REG-06） ═══════════════════════
  section('S8 跨进程 apply 锁：忙时 fail-closed、串行化后不重放、陈旧锁回收')
  {
    // 8a：第一个 apply 持锁期间，第二个实例 apply ⇒ REG_APPLY_BUSY（零写入、锁路径/持有者可读）
    const real = seedRegistry()
    const sessionDir = join(workRoot, 's8-lock')
    const lockPath = resolveRegistryApplyLockPath(sessionDir)
    const a = createRegistryStage({ sessionDir, sessionId: 's8a', reader: real.reader, writer: real.writer })
    const b = createRegistryStage({ sessionDir, sessionId: 's8b', reader: real.reader, writer: real.writer })
    a.open()
    b.open()
    check('S8.1 锁路径 = <sessionDir>/registry/apply.lock', lockPath === join(sessionDir, 'registry', REG_APPLY_LOCK_NAME), lockPath)
    a.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_SZ', 'locked')
    b.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_SZ', 'locked')
    a.freezeCandidate()
    b.freezeCandidate()
    let busyError = null
    let lockHeldDuring = null
    let writesDuringBusy = 0
    let firstCall = true
    const hookedWriter = {
      ...real.writer,
      setValue(registryPath, name, type, dataHex, options = {}) {
        if (firstCall) {
          firstCall = false
          lockHeldDuring = existsSync(lockPath)
          const before = real.log.writes.length
          try {
            b.apply({ applyLockTimeoutMs: 0 })
          } catch (error) {
            busyError = error
          }
          writesDuringBusy = real.log.writes.length - before
        }
        return real.writer.setValue(registryPath, name, type, dataHex, options)
      },
    }
    const applyA = a.apply({ writer: hookedWriter })
    check('S8.2 第一个 apply 持锁（写入窗口内锁文件存在）', lockHeldDuring === true && applyA.failed.length === 0, JSON.stringify({ lockHeldDuring, failed: applyA.failed }))
    check('S8.3 持锁期间第二个 apply ⇒ fail-closed REG_APPLY_BUSY（status=5）', busyError?.code === 'REG_APPLY_BUSY' && busyError?.status === REG_STATUS.ERROR_ACCESS_DENIED, busyError ? `${busyError.code}/${busyError.status}` : 'no throw')
    check('S8.4 REG_APPLY_BUSY 消息带锁路径与持有者 pid（可诊断，不静默）', typeof busyError?.message === 'string' && busyError.message.includes('apply.lock') && /pid/i.test(busyError.message), busyError ? busyError.message.slice(0, 160) : 'no throw')
    check('S8.5 忙时第二个 apply 零写入；锁在第一个 apply 结束后释放', writesDuringBusy === 0 && existsSync(lockPath) === false, JSON.stringify({ writesDuringBusy, lockAfter: existsSync(lockPath) }))

    // 8b：串行化后第二个实例重读已解决状态 ⇒ already-applied，不重复 replay
    const applyB = b.apply()
    check('S8.6 串行化后的第二个 apply 无失败、applied=0（already-applied 而非重复写入）', applyB.failed.length === 0 && applyB.applied.length === 0, JSON.stringify({ applied: applyB.applied, failed: applyB.failed, skipped: applyB.skipped.map((s) => s.reason) }))
    check('S8.7 真实 hive 只收到一次该写入（无重复 replay）', real.log.writes.filter((entry) => entry[0] === 'set-value' && entry[2] === 'V').length === 1, JSON.stringify(real.log.writes))

    // 8c：陈旧锁（持锁进程已被强杀 ⇒ pid 不存在）必须被回收，而不是把整批挡死
    const real2 = seedRegistry()
    const staleDir = join(workRoot, 's8-stale')
    const staleStage = createRegistryStage({ sessionDir: staleDir, sessionId: 's8-stale', reader: real2.reader, writer: real2.writer })
    staleStage.open()
    staleStage.stageSetValue(`${KEY}\\Dup`, 'V', 'REG_SZ', 'after-stale')
    staleStage.freezeCandidate()
    mkdirSync(join(staleDir, 'registry'), { recursive: true })
    writeFileSync(resolveRegistryApplyLockPath(staleDir), JSON.stringify({ pid: 999999, at: new Date().toISOString(), scope: 'registry-apply' }))
    const staleApply = staleStage.apply()
    check('S8.8 死 pid 的陈旧锁被回收，apply 正常完成且锁已清理', staleApply.failed.length === 0 && !existsSync(resolveRegistryApplyLockPath(staleDir)), JSON.stringify({ failed: staleApply.failed, lock: existsSync(resolveRegistryApplyLockPath(staleDir)) }))
  }
} finally {
  try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
