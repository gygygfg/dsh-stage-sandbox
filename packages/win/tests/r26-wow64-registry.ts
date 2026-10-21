#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R26 新增（离线）。
/**
 * r26-wow64-registry —— R26 / R13：32 位注册表视图（`KEY_WOW64_32KEY`）暂存化。
 *
 * R18 曾把 32 位视图的写/删定为 fail-closed 硬拒（真实 hive 不动但功能缺失）。
 * R26 起：x64 进程里的 32 视图写/删**进覆盖层**，用合成路径段
 * `HKCU\__DSH_WOW64_32__\...` 命名空间化，WAL 的 `reserved` 字段携带视图
 * （0 = 默认/64，1 = WOW64-32）；apply 时去掉合成段、用 `/reg:32` 落到真实 32 视图。
 *
 * 本套件覆盖（离线；真实 hive 的 apply 证据在 `.t/reg-shim/r26.ts`）：
 *   S1 视图路径编解码（合成段、display `[32] ...`、幂等、64 视图不受影响）；
 *   S2 WAL 编解码/符合性（reserved=view、路径标记一致、非法 view/错配判红）；
 *   S3 classify 分流（x64 32KEY 可暂存；64KEY no-op；WOW64 进程仍 fail-closed；读+视图透传）；
 *   S4 facade 暂存（32/64 命名空间隔离、读回、WAL 记录、候选 display/view）；
 *   S5 apply（writer 收到真实路径 + view=1；删除/多值/混合视图；64 视图单元 view=0）；
 *   S6 保留命名空间（64 视图的合成段路径按内部表示处理，不产生 64/32 混淆）。
 *
 * 用法：node tests\r26-wow64-registry.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KEY_WOW64,
  REG_STAGE_FLAGS,
  REG_STAGE_VIEW,
  WOW64_32_VIEW_SEGMENT,
  classifyRegistryOperation,
  createRegistryStage,
  decodeJournalRecords,
  decodeRegistryViewPath,
  encodeJournalRecord,
  isRegistryViewPath,
  journalRecordForOperation,
  registryViewPath,
  validateJournalBuffer,
} from '../src/registry-stage.ts'
import { REG_STATUS, decodeRegistryValue } from '../src/registry-guard.ts'

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

// 假真实 hive：**按视图分开存储**（view0 = 64 位视图，view1 = 32 位视图），
// writer 的 view 选项决定落到哪个视图 —— 这样"apply 32 视图不改 64 视图"可判定。
function createFakeRegistry(seed = []) {
  const views = [new Map(), new Map()]
  const log = { reads: [], writes: [] }
  const ensure = (registryPath, view = 0) => {
    const map = views[view] ?? views[0]
    const fold = registryPath.toLowerCase()
    if (!map.has(fold)) map.set(fold, { path: registryPath, values: new Map() })
    return map.get(fold)
  }
  const parentOf = (registryPath) => {
    const index = registryPath.lastIndexOf('\\')
    return index <= 0 ? undefined : registryPath.slice(0, index)
  }
  const lastSegment = (registryPath) => registryPath.slice(registryPath.lastIndexOf('\\') + 1)
  // seed 项默认同时存在于**两个视图**（测试键在两个视图都存在；个别场景可按需只种一个）。
  for (const [registryPath, name, type, data, onlyView] of seed) {
    const targets = onlyView === undefined ? [0, 1] : [onlyView]
    for (const view of targets) ensure(registryPath, view).values.set(String(name).toLowerCase(), { name, type, data })
  }
  const mapFor = (view) => views[view] ?? views[0]
  return {
    log,
    reader: {
      read(registryPath, options = {}) {
        const view = options?.view === 1 ? 1 : 0
        log.reads.push([registryPath, view])
        const map = mapFor(view)
        const fold = registryPath.toLowerCase()
        const record = map.get(fold)
        if (!record) return { exists: false }
        const subKeys = []
        for (const other of map.values()) {
          const parent = parentOf(other.path)
          if (parent !== undefined && parent.toLowerCase() === fold) subKeys.push(lastSegment(other.path))
        }
        const values = {}
        for (const entry of record.values.values()) values[entry.name] = { type: entry.type, data: entry.data }
        return { exists: true, subKeys, values }
      },
    },
    writer: {
      createKey(registryPath, opts = {}) {
        const view = opts?.view === 1 ? 1 : 0
        log.writes.push(['create-key', registryPath, view, opts?.dwOptions ?? 0])
        ensure(registryPath, view)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      setValue(registryPath, name, type, dataHex, opts = {}) {
        const view = opts?.view === 1 ? 1 : 0
        log.writes.push(['set-value', registryPath, name, view, type, dataHex])
        ensure(registryPath, view).values.set(String(name).toLowerCase(), { name, type, data: decodeRegistryValue(type, dataHex, name) })
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteValue(registryPath, name, opts = {}) {
        const view = opts?.view === 1 ? 1 : 0
        log.writes.push(['delete-value', registryPath, name, view])
        const record = mapFor(view).get(registryPath.toLowerCase())
        if (record) record.values.delete(String(name).toLowerCase())
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteKey(registryPath, opts = {}) {
        const view = opts?.view === 1 ? 1 : 0
        log.writes.push(['delete-key', registryPath, view, opts?.recursive === true])
        const map = mapFor(view)
        const fold = registryPath.toLowerCase()
        map.delete(fold)
        for (const other of [...map.keys()]) if (other.startsWith(`${fold}\\`)) map.delete(other)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
    },
    valueOf(registryPath, name, view = 0) {
      return mapFor(view).get(registryPath.toLowerCase())?.values.get(String(name).toLowerCase())
    },
    exists(registryPath, view = 0) {
      return mapFor(view).has(registryPath.toLowerCase())
    },
  }
}
const workRoot = mkdtempSync(join(tmpdir(), 'dsh-r26-wow64-'))
let seq = 0
function newStage(real, tag) {
  seq += 1
  const stage = createRegistryStage({ sessionDir: join(workRoot, `${tag}-${seq}`), sessionId: `r26-${seq}`, reader: real.reader, writer: real.writer })
  stage.open()
  return stage
}
const KEY = 'HKCU\\Software\\R26View'

try {
  // ─── S1 视图路径编解码 ───────────────────────────────────────────────────
  section('S1 视图路径编解码：合成段 / [32] 展示 / 幂等 / 64 不受影响')
  {
    const encoded = registryViewPath(KEY, REG_STAGE_VIEW.WOW64_32)
    check('S1.1 32 视图路径 = 短 hive 名后插入合成段', encoded === `HKCU\\${WOW64_32_VIEW_SEGMENT}\\Software\\R26View`, encoded)
    check('S1.2 幂等（重复编码不叠加前缀）', registryViewPath(encoded, REG_STAGE_VIEW.WOW64_32) === encoded, registryViewPath(encoded, REG_STAGE_VIEW.WOW64_32))
    check('S1.3 64 视图路径不变', registryViewPath(KEY, REG_STAGE_VIEW.DEFAULT) === KEY, registryViewPath(KEY, REG_STAGE_VIEW.DEFAULT))
    check('S1.4 isRegistryViewPath 只认合成段', isRegistryViewPath(encoded) === true && isRegistryViewPath(KEY) === false && isRegistryViewPath(`HKCU\\${WOW64_32_VIEW_SEGMENT}X\\A`) === false, `${isRegistryViewPath(encoded)}/${isRegistryViewPath(KEY)}`)
    const decoded = decodeRegistryViewPath(encoded)
    check('S1.5 解码：真实路径 + view=1 + display 带 [32]', decoded.path === KEY && decoded.view === REG_STAGE_VIEW.WOW64_32 && decoded.displayPath === `[32] ${KEY}`, JSON.stringify(decoded))
    const decodedRoot = decodeRegistryViewPath(`HKCU\\${WOW64_32_VIEW_SEGMENT}`)
    check('S1.6 合成根（无子键）解码为 hive 根', decodedRoot.path === 'HKCU' && decodedRoot.displayPath === '[32] HKCU', JSON.stringify(decodedRoot))
    const decodedDefault = decodeRegistryViewPath(KEY)
    check('S1.7 默认路径解码：view=0、display 原样', decodedDefault.path === KEY && decodedDefault.view === 0 && decodedDefault.displayPath === KEY, JSON.stringify(decodedDefault))
  }

  // ─── S2 WAL 编解码 / 符合性 ──────────────────────────────────────────────
  section('S2 WAL：reserved=view、路径标记一致、非法视图/错配判红')
  {
    const record32 = journalRecordForOperation({ op: 'set-value', path: KEY, valueName: 'V', type: 'REG_SZ', value: 'x', view: REG_STAGE_VIEW.WOW64_32 })
    check('S2.1 32 视图记录：path 带合成段 + reserved/view=1', record32.reserved === 1 && isRegistryViewPath(record32.path) && record32.view === 1, JSON.stringify({ path: record32.path, reserved: record32.reserved }))
    const buffer = encodeJournalRecord(record32)
    const decoded = decodeJournalRecords(buffer).records[0]
    check('S2.2 编码→解码保留 view/reserved=1 与合成路径', decoded?.reserved === 1 && decoded?.view === 1 && decoded?.path === record32.path, JSON.stringify({ reserved: decoded?.reserved, view: decoded?.view, path: decoded?.path }))
    const verdict = validateJournalBuffer(buffer)
    check('S2.3 符合性校验接受 reserved=1（view）', verdict.ok === true, JSON.stringify((verdict.problems ?? []).slice(0, 3)))
    const record64 = journalRecordForOperation({ op: 'set-value', path: KEY, valueName: 'V', type: 'REG_SZ', value: 'x' })
    check('S2.4 默认视图记录 reserved=0（向后兼容旧记录）', record64.reserved === 0 && !isRegistryViewPath(record64.path), JSON.stringify({ reserved: record64.reserved, path: record64.path }))
    const planted = Buffer.from(buffer)
    planted.writeUInt32LE(7, 28)
    const bad = validateJournalBuffer(planted)
    check('S2.5 reserved=7 仍被判红（RESERVED_NONZERO）', bad.ok === false && (bad.problems ?? []).some((problem) => problem.code === 'RESERVED_NONZERO'), JSON.stringify((bad.problems ?? []).map((problem) => problem.code)))
    const mismatch = Buffer.from(encodeJournalRecord(journalRecordForOperation({ op: 'set-value', path: KEY, valueName: 'V', type: 'REG_SZ', value: 'x' })))
    mismatch.writeUInt32LE(1, 28) // 声明 view=1 但路径没有合成段
    const mismatchVerdict = validateJournalBuffer(mismatch)
    check('S2.6 reserved=1 但路径无合成段 ⇒ VIEW_PATH_MISMATCH', mismatchVerdict.ok === false && (mismatchVerdict.problems ?? []).some((problem) => problem.code === 'VIEW_PATH_MISMATCH'), JSON.stringify((mismatchVerdict.problems ?? []).map((problem) => problem.code)))
  }

  // ─── S3 classify 分流 ───────────────────────────────────────────────────
  section('S3 classify：x64 32KEY 可暂存 / 64KEY no-op / WOW64 进程 fail-closed / 读透传')
  {
    const set32 = classifyRegistryOperation({ api: 'RegSetValueExW', path: KEY, type: 'REG_SZ', samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S3.1 x64 写 + 32KEY ⇒ stageable, view=1, view32 flag', set32.stageable === true && set32.view === 1 && set32.flags?.view32 === true, JSON.stringify({ stageable: set32.stageable, view: set32.view }))
    const del32 = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: KEY, samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S3.2 x64 删 + 32KEY ⇒ stageable, view=1', del32.stageable === true && del32.view === 1, JSON.stringify({ stageable: del32.stageable, view: del32.view }))
    const create32 = classifyRegistryOperation({ api: 'RegCreateKeyExW', path: KEY, samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S3.3 x64 创建 + 32KEY ⇒ stageable, view=1', create32.stageable === true && create32.view === 1, JSON.stringify({ stageable: create32.stageable, view: create32.view }))
    const noop64 = classifyRegistryOperation({ api: 'RegSetValueExW', path: KEY, type: 'REG_SZ', samDesired: KEY_WOW64.KEY_WOW64_64KEY })
    check('S3.4 x64 + 64KEY（文档化 no-op）⇒ 普通暂存 view=0', noop64.stageable === true && noop64.view === 0, JSON.stringify({ stageable: noop64.stageable, view: noop64.view }))
    const conflict = classifyRegistryOperation({
      api: 'RegSetValueExW',
      path: KEY,
      type: 'REG_SZ',
      samDesired: KEY_WOW64.KEY_WOW64_32KEY | KEY_WOW64.KEY_WOW64_64KEY,
    })
    check(
      'S3.4b 32KEY|64KEY 同时出现 ⇒ fail-closed（Windows 返回 87，不能伪装成 32 视图暂存）',
      conflict.stageable === false,
      JSON.stringify({ stageable: conflict.stageable, reason: conflict.reason }),
    )
    const wow32 = classifyRegistryOperation({ api: 'RegSetValueExW', path: KEY, type: 'REG_SZ', samDesired: KEY_WOW64.KEY_WOW64_32KEY, wow64Process: true })
    check('S3.5 WOW64 进程 + 32KEY ⇒ fail-closed 原因码 1（纵深防御）', wow32.stageable === false && wow32.hardDenyReason === 'WOW64_32KEY_WRITE_NOT_STAGEABLE', JSON.stringify(wow32))
    const wow64 = classifyRegistryOperation({ api: 'RegSetValueExW', path: KEY, type: 'REG_SZ', samDesired: KEY_WOW64.KEY_WOW64_64KEY, wow64Process: true })
    check('S3.6 WOW64 进程 + 64KEY ⇒ fail-closed 原因码 2', wow64.stageable === false && wow64.hardDenyReason === 'WOW64_VIEW_IN_WOW64_PROCESS_WRITE_NOT_STAGEABLE', JSON.stringify(wow64))
    const read32 = classifyRegistryOperation({ api: 'RegQueryValueExW', path: KEY, samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S3.7 读 + 32KEY ⇒ unstaged 透传（读不投影 staging）', read32.stageable === false && read32.unstaged === true && read32.status === 0, JSON.stringify(read32))
  }

  // ─── S4 facade 暂存：命名空间隔离 ───────────────────────────────────────
  section('S4 facade：32/64 视图命名空间隔离、读回、WAL、候选展示')
  {
    const real = createFakeRegistry([[KEY, 'Existing', 'REG_SZ', 'base']])
    const stage = newStage(real, 's4')
    const set32 = stage.stageSetValue(KEY, 'ViewValue', 'REG_SZ', 'thirty-two', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S4.1 32 视图写进暂存（路径带合成段）', set32?.net === true && String(set32?.path).startsWith(`HKCU\\${WOW64_32_VIEW_SEGMENT}\\`), set32 ? set32.path : 'no result')
    check('S4.2 WAL 记录 reserved=1', set32?.record?.reserved === 1, JSON.stringify(set32?.record))

    const read32Key = `${KEY}`
    const read32 = stage.readValue(registryViewPath(read32Key, REG_STAGE_VIEW.WOW64_32), 'ViewValue')
    check('S4.4 通过合成视图路径读回 32 视图的暂存值', read32.status === 0 && decodeRegistryValue('REG_SZ', read32.data, 'ViewValue') === 'thirty-two', JSON.stringify(read32))
    const read64 = stage.readValue(read32Key, 'ViewValue')
    check('S4.5 64 视图看不到 32 视图的暂存值（命名空间隔离）', read64.status !== 0, JSON.stringify(read64))
    const set64 = stage.stageSetValue(read32Key, 'ViewValue', 'REG_SZ', 'sixty-four')
    check('S4.6 64 视图写同名值：路径无前缀、WAL reserved=0（与 32 视图记录互不覆盖）', set64?.net === true && set64?.path === read32Key && set64?.record?.reserved === 0, set64 ? `${set64.path} reserved=${set64.record?.reserved}` : 'no result')
    const frozen = stage.freezeCandidate()
    const changes = frozen.candidate?.changes ?? []
    const change32 = changes.find((change) => String(change.path).includes(WOW64_32_VIEW_SEGMENT))
    const change64 = changes.find((change) => change.path === `${read32Key}\\ViewValue`)
    check('S4.7 候选里 32 视图单元 displayPath 带 [32]、registryView=WOW64_32', change32?.registryView === 'WOW64_32' && String(change32?.displayPath).startsWith('[32] '), JSON.stringify(change32 && { displayPath: change32.displayPath, view: change32.registryView }))
    check('S4.8 候选里 64 视图单元 displayPath 原样、registryView=DEFAULT', change64?.registryView === 'DEFAULT' && change64?.displayPath === `${read32Key}\\ViewValue`, JSON.stringify(change64 && { displayPath: change64.displayPath, view: change64.registryView }))
  }

  // ─── S5 apply：只落对应视图 ─────────────────────────────────────────────
  section('S5 apply：writer 收到真实路径 + view；删除/多值/混合视图')
  {
    const real = createFakeRegistry([[KEY, 'Existing', 'REG_SZ', 'base']])
    const stage = newStage(real, 's5')
    stage.stageSetValue(KEY, 'A32', 'REG_SZ', 'a32', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    stage.stageSetValue(KEY, 'B32', 'REG_DWORD', 7, { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    stage.stageSetValue(KEY, 'C64', 'REG_SZ', 'c64')
    stage.stageDeleteValue(KEY, 'Existing', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S5.1 apply 前真实 hive 零写入', real.log.writes.length === 0, `writes=${real.log.writes.length}`)
    const frozen = stage.freezeCandidate()
    const apply = stage.apply()
    check('S5.2 apply 成功（failed=0）', apply.failed.length === 0 && apply.applied.length > 0, JSON.stringify(apply.failed))
    const writes = real.log.writes
    check(
      'S5.3 所有 writer 路径都不含合成段（apply 落真实 hive 路径）',
      writes.length > 0 && writes.every((entry) => !String(entry[1]).includes(WOW64_32_VIEW_SEGMENT)),
      JSON.stringify(writes),
    )
    const viewOf = (op, name) => writes.find((entry) => entry[0] === op && (name === undefined || entry[2] === name))?.[3] ?? writes.find((entry) => entry[0] === op && (name === undefined || entry[2] === name))?.[entry.length - 1]
    check('S5.4 32 视图 setValue 带 view=1（A32/B32）', ['A32', 'B32'].every((name) => writes.some((entry) => entry[0] === 'set-value' && entry[2] === name && entry[3] === 1)), JSON.stringify(writes))
    check('S5.5 64 视图 setValue 带 view=0（C64）', writes.some((entry) => entry[0] === 'set-value' && entry[2] === 'C64' && entry[3] === 0), JSON.stringify(writes))
    check('S5.6 32 视图 deleteValue 带 view=1（Existing）', writes.some((entry) => entry[0] === 'delete-value' && entry[2] === 'Existing' && entry[3] === 1), JSON.stringify(writes))

    // create/delete key 的视图与 recursive
    const real2 = createFakeRegistry([['HKCU\\Software\\R26View\\Del32', 'X', 'REG_SZ', 'x']])
    const stage2 = newStage(real2, 's5b')
    stage2.stageCreateKey('HKCU\\Software\\R26View\\New32', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    stage2.stageDeleteKey('HKCU\\Software\\R26View\\Del32', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    const apply2 = stage2.apply()
    check('S5.7 createKey/deleteKey 的 writer 调用带 view=1', apply2.failed.length === 0 &&
      real2.log.writes.some((entry) => entry[0] === 'create-key' && String(entry[1]).endsWith('New32') && entry[2] === 1) &&
      real2.log.writes.some((entry) => entry[0] === 'delete-key' && String(entry[1]).endsWith('Del32') && entry[2] === 1), JSON.stringify(real2.log.writes))
    check('S5.8 deleteKey writer 收到 recursive=true', real2.log.writes.some((entry) => entry[0] === 'delete-key' && entry[3] === true), JSON.stringify(real2.log.writes))

    // ★ R26-GATE-01：32 视图**真实键已存在**时，写/删也必须带 view=1、显示 [32]。
    // 旧缺陷：reg.exe 走 passthrough 真实句柄（create 或 write-intent open）→ handle
    // 视图丢失 → WAL 落真实别名路径 view=0、候选 DEFAULT、displayPath 无 [32]。
    const real3 = createFakeRegistry([[KEY, 'Existing32', 'REG_SZ', 'base']])
    const stage3 = newStage(real3, 's5c-existing')
    const set3 = stage3.stageSetValue(KEY, 'X32Existing', 'REG_SZ', 'v', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    const del3 = stage3.stageDeleteValue(KEY, 'Existing32', { samDesired: KEY_WOW64.KEY_WOW64_32KEY })
    check('S5.9 已存在 32 视图键的写/删仍进暂存（合成前缀）', set3?.net === true && del3?.net === true && String(set3?.path).includes(`__DSH_WOW64_32__`), `${set3?.path} / ${del3?.path}`)
    const frozen3 = stage3.freezeCandidate()
    const changes3 = frozen3.candidate?.changes ?? []
    const wanted3 = [`${KEY}\\X32Existing`, `${KEY}\\Existing32`]
    check(
      'S5.10 已存在键的候选单元 displayPath=[32] + registryView=WOW64_32（不再回落 DEFAULT/别名路径）',
      wanted3.every((wanted) => changes3.some((change) => String(change.path).includes(`__DSH_WOW64_32__`) && change.registryView === 'WOW64_32' && String(change.displayPath) === `[32] ${wanted}`)) &&
        changes3.every((change) => !String(change.path).includes('WOW6432Node') && !String(change.displayPath).includes('WOW6432Node')),
      JSON.stringify(changes3.map((change) => [change.displayPath, change.registryView])),
    )
    const apply3 = stage3.apply()
    check(
      'S5.11 已存在键 apply：writer 收到真实路径 + view=1（不出现 WOW6432Node/合成段）',
      apply3.failed.length === 0 &&
        real3.log.writes.some((entry) => entry[0] === 'set-value' && entry[2] === 'X32Existing' && entry[3] === 1 && String(entry[1]) === KEY) &&
        real3.log.writes.some((entry) => entry[0] === 'delete-value' && entry[2] === 'Existing32' && entry[3] === 1 && String(entry[1]) === KEY) &&
        real3.log.writes.every((entry) => !String(entry[1]).includes('WOW6432Node') && !String(entry[1]).includes('__DSH_WOW64_32__')),
      JSON.stringify(real3.log.writes),
    )
    check(
      'S5.12 已存在键 apply 后：32 视图有新值/删除旧值，64 视图完全未动',
      real3.valueOf(KEY, 'X32Existing', 1) !== undefined && real3.valueOf(KEY, 'Existing32', 1) === undefined &&
        real3.valueOf(KEY, 'Existing32', 0) !== undefined && real3.valueOf(KEY, 'X32Existing', 0) === undefined,
      JSON.stringify({ v32: real3.valueOf(KEY, 'X32Existing', 1), old32: real3.valueOf(KEY, 'Existing32', 1), old64: real3.valueOf(KEY, 'Existing32', 0), x64: real3.valueOf(KEY, 'X32Existing', 0) }),
    )
  }

  // ─── S6 默认视图不含合成段时的行为 ──────────────────────────────────────
  section('S6 默认视图：不因 32 视图机制改变 64 视图暂存/apply')
  {
    const real = createFakeRegistry([[KEY, 'V', 'REG_SZ', 'old']])
    const stage = newStage(real, 's6')
    stage.stageSetValue(KEY, 'V', 'REG_SZ', 'new')
    const res = stage.readValue(KEY, 'V')
    check('S6.1 64 视图照常读回覆盖层值', res.status === 0 && decodeRegistryValue('REG_SZ', res.data, 'V') === 'new', JSON.stringify(res))
    stage.freezeCandidate()
    const apply = stage.apply()
    const viewOfWrite = (entry) => (entry[0] === 'set-value' || entry[0] === 'delete-value' ? entry[3] : entry[2])
    check('S6.2 64 视图 apply 照常成功且 writer view=0', apply.failed.length === 0 && real.log.writes.length > 0 && real.log.writes.every((entry) => viewOfWrite(entry) === 0), JSON.stringify(real.log.writes))
  }
} finally {
  try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* best effort */ }
}

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
