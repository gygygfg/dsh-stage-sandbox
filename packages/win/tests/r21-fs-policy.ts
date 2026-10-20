// @ts-nocheck —— R21 G4a：`readPolicy` 双档（record / block）**行为级** e2e。
/**
 * R21 · G4a —— 读侧策略 `readPolicy:'record' | 'block'` 双档端到端
 *
 * ── 为什么必须新增这个套件（红证据，先红后绿）──────────────────────────────
 * R19 报告（`docs/round19/R19-独立测试与边界修复报告.md:155-157`）自认：
 *   「`block` 档对 readText/readBytes/readByteRange/listDir/stat/lstat 的守卫已
 *    **代码核对**，但**未做双档 e2e**。」
 * 全仓 `tests/**` 在此之前只有 `crosscheck-boundaries.ts:131-145` 的**静态源码 grep**
 * （函数体里出现 `guardMaskedRead(` 即绿）—— 那只能证明"代码里写了这个调用"，
 * 证明不了任何行为。本套件用**真实 `StagingFileSystem`（真实 `LocalFileSystem` 基类）+
 * 真实 Cordis `Context` + 独立 `WINSTAGE_STAGE_ROOT`** 把两档行为钉死。
 *
 * ── 覆盖（contract §2 G4）────────────────────────────────────────────────────
 *   · record（默认）：六个读入口（readText/readBytes/readByteRange/listDir/stat/lstat）
 *     都返回真实内容；命中遮蔽表的读产生**会话级去重**可见性记录（maskId+maskKey），
 *     并随 `review.json.readVisibility` 发布；真实盘零写。
 *   · block：六个入口全部结构化失败（`FS_READ_DENIED` + `readPolicy:'block'` + `maskId`），
 *     `listDir` 过滤掉被遮蔽子项，任何返回/错误里无凭据明文；真实盘零写。
 *   · 关态 / 异工作区回归（本轮修的 P2）：`lstat` 曾在两个早退分支绕过守卫与登记 ——
 *     block 档会泄漏 type/size，record 档面板看不到这次读。这里用行为断言钉死。
 *
 * ── 本套件**不**做什么（如实声明）──────────────────────────────────────────────
 *   · 不读真实 `~/.npmrc`/`~/.ssh`：所有"敏感文件"都是本套件在工作区里**构造的夹具**
 *     （内容只含 marker，不是真凭据）；
 *   · 不证明"黑名单是边界"：`readPolicy` 是**黑名单式**策略（换个文件名就绕过），
 *     产品默认 `record`（R19 报告 §5 的产品决策），本套件只钉两档的**实现行为**；
 *   · 不覆盖生产装配可达性：见输出末尾 `RESIDUAL` 段（`fs-entry.ts` 未透传 readPolicy）。
 *
 * 用法：
 *   node tests/r21-fs-policy.ts            # 正常：全绿
 *   node tests/r21-fs-policy.ts --plant    # 把守卫改成 no-op，断言必须变红（证明断言有判定力）
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import { createStagingFileSystem } from '../dsh-plugin/staging-fs.ts'
import { getReviewService, readVisibilitySnapshot } from '../dsh-plugin/review-service.ts'

const PLANT = process.argv.includes('--plant')
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SCRATCH = join(PKG, '.t', 'fs-policy', 'r21-g4a')

let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}
const section = (title) => process.stdout.write(`\n=== ${title} ===\n`)
const residual = (line) => process.stdout.write(`  ~ RESIDUAL ${line}\n`)

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：真实文件系统布局（所有"敏感文件"都是构造的 marker，不是真凭据）
// ═══════════════════════════════════════════════════════════════════════════
const MARKERS = {
  npmrc: 'R21G4A_NPMRC_SECRET_5f1c9b',
  ssh: 'R21G4A_SSH_SECRET_2d7e4a',
  aws: 'R21G4A_AWS_SECRET_8c3f6d',
}
const FILES = {
  '.npmrc': `//registry.example/:_authToken=${MARKERS.npmrc}\n`,
  '.ssh/id_rsa': `-----BEGIN KEY-----\n${MARKERS.ssh}\n-----END KEY-----\n`,
  '.aws/credentials': `[default]\naws_access_key_id = ${MARKERS.aws}\n`,
  'notes.txt': 'plain-note-line\nsecond-line\n',
  'src/app.js': 'export const answer = 42\n',
}

const writeFixture = (wsRoot) => {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(wsRoot, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** 真实盘快照（内容 sha256 + size + mtimeMs；**不含 atime** —— 读会改 atime，不是写） */
const snapshotTree = (root) => {
  const out = {}
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const info = statSync(abs)
      if (info.isDirectory()) {
        out[relative(root, abs)] = 'dir'
        walk(abs)
      } else {
        const digest = createHash('sha256').update(readFileSync(abs)).digest('hex')
        out[relative(root, abs)] = `${info.size}:${digest}:${Math.trunc(info.mtimeMs)}`
      }
    }
  }
  walk(root)
  return out
}

// ── 环境：暂存根必须独立（`WINSTAGE_STAGE_ROOT` 是 `resolveStageRoot()` 的第二优先级）──
const savedStageRoot = process.env.WINSTAGE_STAGE_ROOT
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const TARGETS = {
  npmrc: (wsRoot) => ({ targetKey: join(wsRoot, '.npmrc'), displayPath: join(wsRoot, '.npmrc') }),
  ssh: (wsRoot) => ({ targetKey: join(wsRoot, '.ssh', 'id_rsa'), displayPath: join(wsRoot, '.ssh', 'id_rsa') }),
  aws: (wsRoot) => ({ targetKey: join(wsRoot, '.aws', 'credentials'), displayPath: join(wsRoot, '.aws', 'credentials') }),
  notes: (wsRoot) => ({ targetKey: join(wsRoot, 'notes.txt'), displayPath: join(wsRoot, 'notes.txt') }),
  root: (wsRoot) => ({ targetKey: wsRoot, displayPath: wsRoot }),
}

/**
 * 造一个**真实** StagingFileSystem 实例。
 * 基类 = 真实的 `LocalFileSystem`（不是替身）；Context 是真的 cordis `Context`；
 * `enabled`/`sessionId` 是自测注入缝（生产由 loader 行/会话身份提供）。
 * 日志在构造后**从实例上覆写**，保证 block 档的 error 级日志也能被断言捕获。
 */
const makeHarness = ({ tag, readPolicy, wsRoot, storeDir, enabled = true, agents }) => {
  process.env.WINSTAGE_STAGE_ROOT = storeDir
  const ctx = new Context()
  if (agents) ctx.provide('agents', agents)
  const Cls = createStagingFileSystem({
    base: LocalFileSystem,
    enabled: () => enabled,
    sessionId: tag,
    ...(readPolicy === undefined ? {} : { readPolicy }),
  })
  const fs = new Cls(ctx, { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
  const logs = { info: [], warn: [], error: [] }
  fs.log = (message) => logs.info.push(String(message))
  fs.logError = (message) => logs.error.push(String(message))
  if (PLANT) {
    // --plant：把守卫改成 no-op（模拟"守卫没接上"的旧/损坏实现）⇒ 断言必须变红
    fs.guardMaskedRead = () => undefined
    fs.filterMaskedChildren = (_dirAbs, entries) => entries
  }
  return { fs, ctx, logs }
}

const capture = async (fn) => {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error }
  }
}

const errorShape = (error) => ({
  code: error?.code,
  readPolicy: error?.readPolicy,
  maskId: error?.maskId,
  isFsError: error instanceof FsError,
  message: String(error?.message ?? error),
})

try {
  // ═════════════════════════════════════════════════════════════════════════
  // 1. 缺口（红）与夹具自检
  // ═════════════════════════════════════════════════════════════════════════
  section('1. 缺口证据：本轮之前没有任何 readPolicy 行为套件')
  {
    const testsDir = join(PKG, 'tests')
    /** 去掉注释后再搜：既有套件里出现过 `readPolicy:'block'` 的**注释**（crosscheck-boundaries.ts:120），
     *  那不是覆盖，不能算"已有行为套件"。 */
    const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
    const others = readdirSync(testsDir)
      .filter((name) => name.endsWith('.ts') && !['r21-fs-policy.ts', 'r21-sensitive-e2e.ts'].includes(name))
      .map((name) => ({ name, text: stripComments(readFileSync(join(testsDir, name), 'utf8')) }))
    const withPolicy = others.filter((entry) => /readPolicy\s*:\s*['"]/.test(entry.text)).map((entry) => entry.name)
    const withVisibility = others.filter((entry) => /readVisibilitySnapshot|recordReadVisibility/.test(entry.text)).map((entry) => entry.name)
    check(
      '本轮之前没有任何 tests 套件构造 readPolicy（R19 报告 §5 自认未做双档 e2e）',
      withPolicy.length === 0,
      withPolicy.length ? `已有: ${withPolicy.join(', ')}` : `${others.length} 个既有套件均无 readPolicy 构造`,
    )
    check(
      '既有套件也没有调用会话级可见性登记（只有 crosscheck 的静态源码 grep）',
      withVisibility.length === 0,
      withVisibility.length ? `已有: ${withVisibility.join(', ')}` : '0 个既有套件调用 readVisibilitySnapshot/recordReadVisibility',
    )
    // 夹具自检：真实暂存根由 provider 构造后落盘（不是内存替身）
    const selfWs = join(SCRATCH, 'selfcheck-ws')
    mkdirSync(selfWs, { recursive: true })
    writeFixture(selfWs)
    const selfStore = join(SCRATCH, 'selfcheck-store')
    const { fs } = makeHarness({ tag: 'r21-g4a-selfcheck', readPolicy: 'record', wsRoot: selfWs, storeDir: selfStore })
    check('基类是真实的 LocalFileSystem（不是离线替身）', fs instanceof LocalFileSystem, Object.getPrototypeOf(fs).constructor?.name)
    check('实例确实是本插件的 StagingFileSystem（覆写层生效）', typeof fs.guardMaskedRead === 'function' && fs.readPolicy === 'record', `readPolicy=${fs.readPolicy}`)
    check(
      '独立暂存根由真实 provider 建出整套布局（manifest.json 存在）',
      readdirSync(selfStore).includes('manifest.json'),
      JSON.stringify(readdirSync(selfStore).sort()),
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. record 档：返回内容 + 会话级去重可见性记录 + 真实盘零写
  // ═════════════════════════════════════════════════════════════════════════
  section("2. record 档（默认）：六个读入口返回内容、只记不拦、去重登记")
  {
    const wsRoot = join(SCRATCH, 'ws-record')
    const storeDir = join(SCRATCH, 'store-record')
    const tag = 'r21-g4a-record'
    mkdirSync(wsRoot, { recursive: true })
    writeFixture(wsRoot)
    const before = snapshotTree(wsRoot)
    const { fs } = makeHarness({ tag, readPolicy: 'record', wsRoot, storeDir })

    const text = await fs.readText(TARGETS.npmrc(wsRoot))
    check('record：readText 返回真实内容（命中遮蔽也不改读结果）', text === FILES['.npmrc'], JSON.stringify(text))

    const bytes = await fs.readBytes(TARGETS.npmrc(wsRoot))
    check(
      'record：readBytes 返回完整字节（与 readText 同源）',
      bytes instanceof Uint8Array && Buffer.from(bytes).equals(Buffer.from(FILES['.npmrc'])),
      `bytes=${bytes?.length}`,
    )

    const range = await fs.readByteRange(TARGETS.npmrc(wsRoot), { offset: 0, length: 10 })
    check(
      'record：readByteRange 返回请求区间',
      Buffer.from(range).toString('utf8') === FILES['.npmrc'].slice(0, 10),
      JSON.stringify(Buffer.from(range).toString('utf8')),
    )

    // 第二次 readText：证明"同一个对象读 N 次只累计计数，不新增条目"
    await fs.readText(TARGETS.npmrc(wsRoot))

    const stat = await fs.stat(TARGETS.npmrc(wsRoot))
    check(
      'record：stat 返回存在性/类型/大小（record 档不拦元数据读取）',
      stat !== undefined && stat.type === 'file' && stat.size === Buffer.byteLength(FILES['.npmrc']),
      JSON.stringify(stat),
    )
    const lstat = await fs.lstat(join(wsRoot, '.npmrc'))
    check('record：lstat 返回元数据（六入口之一）', lstat !== undefined && lstat.type === 'file', JSON.stringify(lstat))

    const snap = readVisibilitySnapshot(tag)
    check(
      'record：会话级可见性 = **一条**去重条目（去重键 maskId+maskKey）',
      snap.objects === 1 && snap.items.length === 1,
      JSON.stringify({ objects: snap.objects, items: snap.items.length }),
    )
    const item = snap.items[0] ?? {}
    check(
      'record：该条目累计 6 次读（含重复 readText）而非 6 条记录',
      item.reads === 6,
      JSON.stringify({ reads: item.reads }),
    )
    check(
      'record：条目记录 maskId/maskKey/op 集合（六个读入口都能被面板看见）',
      item.maskId === 'npmrc' &&
        item.path?.toLowerCase().endsWith('\\.npmrc') &&
        ['readText', 'readBytes', 'readByteRange', 'stat', 'lstat'].every((op) => item.ops?.includes(op)),
      JSON.stringify({ maskId: item.maskId, ops: item.ops }),
    )
    check('record：策略如实登记为 record（快照据此说话）', snap.policy === 'record' && typeof snap.note === 'string' && snap.note.includes('不是读边界'), JSON.stringify({ policy: snap.policy }))

    const plain = await fs.readText(TARGETS.notes(wsRoot))
    check('record：对照——普通文件照常读出（策略没有误伤非敏感路径）', plain === FILES['notes.txt'], JSON.stringify(plain))

    const entries = await fs.listDir(TARGETS.root(wsRoot))
    const names = entries.map((entry) => entry.name).sort()
    check(
      'record：listDir **不过滤**被遮蔽子项（只记不拦）',
      ['.aws', '.npmrc', '.ssh', 'notes.txt', 'src'].every((name) => names.includes(name)),
      JSON.stringify(names),
    )
    const afterList = readVisibilitySnapshot(tag)
    check(
      'record：listDir 的子项面也被登记（.ssh/.aws 目录自身 + .npmrc）',
      afterList.objects === 3 && ['npmrc', 'ssh', 'aws'].every((maskId) => (afterList.byMaskId[maskId] ?? 0) >= 1),
      JSON.stringify({ objects: afterList.objects, byMaskId: afterList.byMaskId }),
    )
    // 读一个更深的对象（.ssh/id_rsa）：去重键 = maskId+maskKey ⇒ 新增一条；**再读一次不新增**
    await fs.readText(TARGETS.ssh(wsRoot))
    const afterSsh = readVisibilitySnapshot(tag)
    await fs.readText(TARGETS.ssh(wsRoot))
    const afterSshAgain = readVisibilitySnapshot(tag)
    check(
      'record：新对象新增一条、重复读同一对象只累计计数（去重语义）',
      afterSsh.objects === 4 && afterSshAgain.objects === 4 && JSON.stringify(afterSsh.byMaskId) === JSON.stringify(afterSshAgain.byMaskId),
      JSON.stringify({ first: afterSsh.byMaskId, again: afterSshAgain.byMaskId }),
    )

    const leakTargets = ['review.json', 'manifest.json', 'unstaged.json']
    const svc = getReviewService({ workspaceRoot: wsRoot, sessionId: tag })
    check('record：staging provider 与 review service 指向同一个存储根', svc.storeDir === storeDir, `${svc.storeDir} vs ${storeDir}`)
    svc.publish()
    const published = readFileSync(join(storeDir, 'review.json'), 'utf8')
    const snapJson = JSON.parse(published)
    check(
      'record：review.json.readVisibility 发布同一份去重记录（对象 4、策略 record）',
      snapJson.readVisibility?.policy === 'record' && snapJson.readVisibility?.objects === 4,
      JSON.stringify({ policy: snapJson.readVisibility?.policy, objects: snapJson.readVisibility?.objects }),
    )
    check(
      'record：review.json 里没有任何凭据明文（可见性记录只带路径）',
      Object.values(MARKERS).every((marker) => !published.includes(marker)),
      JSON.stringify(Object.values(MARKERS).filter((marker) => published.includes(marker))),
    )
    void leakTargets

    const after = snapshotTree(wsRoot)
    check(
      'record：真实盘**零写**（内容 sha256/size/mtime 全部不变）',
      JSON.stringify(before) === JSON.stringify(after),
      diffTree(before, after),
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. block 档：结构化失败 + listDir 过滤 + 无明文 + 真实盘零写
  // ═════════════════════════════════════════════════════════════════════════
  section('3. block 档（显式开关）：六个读入口结构化拒绝，listDir 过滤子项')
  {
    const wsRoot = join(SCRATCH, 'ws-block')
    const storeDir = join(SCRATCH, 'store-block')
    const tag = 'r21-g4a-block'
    mkdirSync(wsRoot, { recursive: true })
    writeFixture(wsRoot)
    const before = snapshotTree(wsRoot)
    const { fs, logs } = makeHarness({ tag, readPolicy: 'block', wsRoot, storeDir })

    const expectDenied = async (label, fn, expectedMaskId) => {
      const result = await capture(fn)
      const shape = result.ok ? { code: 'NO-THROW', valueType: typeof result.value } : errorShape(result.error)
      check(
        `block：${label} 抛结构化 FS_READ_DENIED（readPolicy=block / maskId=${expectedMaskId}）`,
        !result.ok && shape.code === 'FS_READ_DENIED' && shape.readPolicy === 'block' && shape.maskId === expectedMaskId && shape.isFsError,
        JSON.stringify(shape),
      )
      if (!result.ok) {
        check(
          `block：${label} 的错误里无凭据明文（消息只含 displayPath）`,
          Object.values(MARKERS).every((marker) => !shape.message.includes(marker)) &&
            !/staging|staged|overlay|暂存/i.test(shape.message),
          shape.message,
        )
      }
      return shape
    }

    await expectDenied('readText(.npmrc)', () => fs.readText(TARGETS.npmrc(wsRoot)), 'npmrc')
    await expectDenied('readBytes(.npmrc)', () => fs.readBytes(TARGETS.npmrc(wsRoot)), 'npmrc')
    await expectDenied('readByteRange(.npmrc)', () => fs.readByteRange(TARGETS.npmrc(wsRoot), { offset: 0, length: 8 }), 'npmrc')
    await expectDenied('stat(.npmrc)', () => fs.stat(TARGETS.npmrc(wsRoot)), 'npmrc')
    await expectDenied('lstat(.npmrc)', () => fs.lstat(join(wsRoot, '.npmrc')), 'npmrc')
    await expectDenied('readText(.ssh/id_rsa)', () => fs.readText(TARGETS.ssh(wsRoot)), 'ssh')
    await expectDenied('stat(.aws/credentials)', () => fs.stat(TARGETS.aws(wsRoot)), 'aws')

    const listResult = await capture(() => fs.listDir(TARGETS.root(wsRoot)))
    const names = listResult.ok ? listResult.value.map((entry) => entry.name).sort() : []
    check(
      'block：listDir 过滤掉被遮蔽子项（.npmrc/.ssh/.aws 不出现）',
      listResult.ok && JSON.stringify(names) === JSON.stringify(['notes.txt', 'src']),
      JSON.stringify(names),
    )
    check(
      'block：listDir 返回的结构里没有明文（也没有被过滤项的 target 泄漏）',
      listResult.ok &&
        Object.values(MARKERS).every((marker) => !JSON.stringify(listResult.value).includes(marker)) &&
        !JSON.stringify(listResult.value).includes('.npmrc'),
      JSON.stringify(listResult.value.map((entry) => entry.name)),
    )
    // 被遮蔽**目录自身**也是读入口：block 档 listDir(.ssh) 必须拒绝
    await expectDenied('listDir(.ssh)', () => fs.listDir({ targetKey: join(wsRoot, '.ssh'), displayPath: join(wsRoot, '.ssh') }), 'ssh')

    const plain = await fs.readText(TARGETS.notes(wsRoot))
    check('block：对照——普通文件照常读出（策略没有误杀）', plain === FILES['notes.txt'], JSON.stringify(plain))
    const plainStat = await fs.stat(TARGETS.notes(wsRoot))
    check('block：对照——普通文件 stat 正常', plainStat?.type === 'file', JSON.stringify(plainStat))

    const snap = readVisibilitySnapshot(tag)
    check('block：策略如实登记为 block', snap.policy === 'block', JSON.stringify({ policy: snap.policy }))
    check(
      'block：被拒绝的读也留下可见性记录（面板能看到"被策略拦了几次"）',
      snap.objects >= 4 && snap.reads >= 8,
      JSON.stringify({ objects: snap.objects, reads: snap.reads, byMaskId: snap.byMaskId }),
    )
    const npmrcItem = snap.items.find((entry) => entry.maskId === 'npmrc') ?? {}
    check(
      'block：六入口在被拒时都登记了 op（readText/readBytes/readByteRange/stat/lstat）',
      ['readText', 'readBytes', 'readByteRange', 'stat', 'lstat'].every((op) => npmrcItem.ops?.includes(op)),
      JSON.stringify(npmrcItem.ops),
    )
    check('block：拒绝路径有 error 级日志（"失败必须响"），且日志里无明文', logs.error.length > 0 && Object.values(MARKERS).every((marker) => !logs.error.join('\n').includes(marker)), JSON.stringify(logs.error.slice(0, 2)))

    const svc = getReviewService({ workspaceRoot: wsRoot, sessionId: tag })
    svc.publish()
    const published = readFileSync(join(storeDir, 'review.json'), 'utf8')
    const snapJson = JSON.parse(published)
    check('block：review.json.readVisibility.policy = block', snapJson.readVisibility?.policy === 'block', JSON.stringify({ policy: snapJson.readVisibility?.policy }))
    check(
      'block：review.json 里没有任何被遮蔽文件的明文',
      Object.values(MARKERS).every((marker) => !published.includes(marker)),
      JSON.stringify(Object.values(MARKERS).filter((marker) => published.includes(marker))),
    )
    const after = snapshotTree(wsRoot)
    check(
      'block：真实盘**零写**（内容 sha256/size/mtime 全部不变）',
      JSON.stringify(before) === JSON.stringify(after),
      diffTree(before, after),
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. 关态 / 异工作区（本轮 P2 修复的回归钉）
  // ═════════════════════════════════════════════════════════════════════════
  section('4. 关态 / 异工作区分支：lstat 不得绕过守卫与登记（R21 P2 修复）')
  {
    // 4a. block + 关态：stat 与 lstat 都必须拒绝（修复前 lstat 返回 type/size）
    const wsOff = join(SCRATCH, 'ws-off-block')
    mkdirSync(wsOff, { recursive: true })
    writeFixture(wsOff)
    const tagOff = 'r21-g4a-off-block'
    const { fs: fsOff } = makeHarness({ tag: tagOff, readPolicy: 'block', wsRoot: wsOff, storeDir: join(SCRATCH, 'store-off-block'), enabled: false })
    const offStat = await capture(() => fsOff.stat(TARGETS.npmrc(wsOff)))
    const offLstat = await capture(() => fsOff.lstat(join(wsOff, '.npmrc')))
    check(
      '关态+block：stat 拒绝（既有行为）',
      !offStat.ok && offStat.error?.code === 'FS_READ_DENIED',
      JSON.stringify(errorShape(offStat.error)),
    )
    check(
      '关态+block：lstat **同样拒绝**（修复前：返回 type/size 的旁路；红证据 .lead/logs/fs-policy/probe-b-red.log）',
      !offLstat.ok && offLstat.error?.code === 'FS_READ_DENIED' && offLstat.error?.readPolicy === 'block',
      JSON.stringify(offLstat.ok ? { code: 'NO-THROW', value: offLstat.value } : errorShape(offLstat.error)),
    )
    const offSnap = readVisibilitySnapshot(tagOff)
    const offItem = offSnap.items.find((entry) => entry.maskId === 'npmrc') ?? {}
    check(
      '关态+block：stat 与 lstat 两次拒绝都进了可见性记录（修复前 lstat 不登记）',
      offItem.ops?.includes('stat') && offItem.ops?.includes('lstat'),
      JSON.stringify(offItem.ops),
    )

    // 4b. record + 关态：lstat 返回内容元数据，且**必须**产生可见性记录（修复前 visibility=[]）
    const wsOffRec = join(SCRATCH, 'ws-off-record')
    mkdirSync(wsOffRec, { recursive: true })
    writeFixture(wsOffRec)
    const tagOffRec = 'r21-g4a-off-record'
    const { fs: fsOffRec } = makeHarness({ tag: tagOffRec, readPolicy: 'record', wsRoot: wsOffRec, storeDir: join(SCRATCH, 'store-off-record'), enabled: false })
    const recLstat = await capture(() => fsOffRec.lstat(join(wsOffRec, '.npmrc')))
    check('关态+record：lstat 照旧返回元数据（只记不拦不改读结果）', recLstat.ok && recLstat.value?.type === 'file', JSON.stringify(recLstat.ok ? recLstat.value : errorShape(recLstat.error)))
    const recSnap = readVisibilitySnapshot(tagOffRec)
    check(
      '关态+record：这次 lstat **产生**一条可见性记录（修复前 visibility=[]，面板盲区）',
      recSnap.objects === 1 && recSnap.items[0]?.maskId === 'npmrc' && recSnap.items[0]?.ops?.includes('lstat'),
      JSON.stringify(recSnap.items),
    )

    // 4c. block + 异工作区（会话 cwd 与配置暂存根不同 ⇒ inConfiguredWorkspace() 为假）
    const wsForeign = join(SCRATCH, 'ws-foreign')
    const otherCwd = join(SCRATCH, 'other-session-cwd')
    mkdirSync(wsForeign, { recursive: true })
    mkdirSync(otherCwd, { recursive: true })
    writeFixture(wsForeign)
    const tagForeign = 'r21-g4a-foreign-block'
    const agents = { currentInitiator: () => ({ session: { header: { cwd: otherCwd } } }) }
    const { fs: fsForeign } = makeHarness({ tag: tagForeign, readPolicy: 'block', wsRoot: wsForeign, storeDir: join(SCRATCH, 'store-foreign-block'), agents })
    const foreignStat = await capture(() => fsForeign.stat(TARGETS.npmrc(wsForeign)))
    const foreignLstat = await capture(() => fsForeign.lstat(join(wsForeign, '.npmrc')))
    check('异工作区+block：stat 拒绝（既有行为）', !foreignStat.ok && foreignStat.error?.code === 'FS_READ_DENIED', JSON.stringify(errorShape(foreignStat.error)))
    check(
      '异工作区+block：lstat **同样拒绝**（修复前旁路）',
      !foreignLstat.ok && foreignLstat.error?.code === 'FS_READ_DENIED',
      JSON.stringify(foreignLstat.ok ? { code: 'NO-THROW', value: foreignLstat.value } : errorShape(foreignLstat.error)),
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. 策略归一（R24-A1 起：未设=record；block=block；其它非空=fail-safe block + warn）
  // ═════════════════════════════════════════════════════════════════════════
  section('5. 策略归一与生产接线（R24-A1：WINSTAGE_READ_POLICY 已接线）')
  {
    const wsNorm = join(SCRATCH, 'ws-normalize')
    mkdirSync(wsNorm, { recursive: true })
    writeFixture(wsNorm)
    const def = makeHarness({ tag: 'r21-g4a-default', wsRoot: wsNorm, storeDir: join(SCRATCH, 'store-default') }).fs
    const bogus = makeHarness({ tag: 'r21-g4a-bogus', readPolicy: 'deny', wsRoot: wsNorm, storeDir: join(SCRATCH, 'store-bogus') }).fs
    const blocked = makeHarness({ tag: 'r21-g4a-blocked', readPolicy: 'block', wsRoot: wsNorm, storeDir: join(SCRATCH, 'store-blocked') }).fs
    check('未传 readPolicy ⇒ 默认 record（产品决策：只记不拦）', def.readPolicy === 'record' && def.readPolicySource === 'default', JSON.stringify({ policy: def.readPolicy, source: def.readPolicySource }))
    check(
      "未知取值 readPolicy='deny' ⇒ **fail-safe 到 block**（R24-A1 语义：显式配置了却拼错，不得静默退回只记不拦）",
      bogus.readPolicy === 'block' && bogus.readPolicySource === 'invalid-fail-safe',
      JSON.stringify({ policy: bogus.readPolicy, source: bogus.readPolicySource, raw: bogus.readPolicyRaw }),
    )
    check('显式 readPolicy=\'block\' ⇒ 生效', blocked.readPolicy === 'block', blocked.readPolicy)
    const entryText = readFileSync(join(PKG, 'dsh-plugin', 'fs-entry.ts'), 'utf8')
    residual('R21-FS-R1 已由 R24-A1 修复：生产入口 fs-entry.ts 读 `WINSTAGE_READ_POLICY` 并透传给 createStagingFileSystem；归一/日志在 staging-fs.ts::normalizeReadPolicy()。')
    check(
      '（R24-A1 接线为机器可读断言）fs-entry.ts 出现 WINSTAGE_READ_POLICY / readPolicy 透传',
      /WINSTAGE_READ_POLICY/.test(entryText) && /readPolicy/.test(entryText),
      '若接线被移除，此断言会变红 ⇒ 提醒同步 findings/套件',
    )
  }
} finally {
  if (savedStageRoot === undefined) delete process.env.WINSTAGE_STAGE_ROOT
  else process.env.WINSTAGE_STAGE_ROOT = savedStageRoot
}

function diffTree(before, after) {
  const changed = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(`${key}: ${before[key] ?? '(absent)'} -> ${after[key] ?? '(absent)'}`)
  }
  return changed.length ? changed.slice(0, 6).join(' | ') : 'no change'
}

if (!PLANT && failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
const failed = PLANT ? failures === 0 : failures > 0
process.stdout.write(
  `\n${'='.repeat(72)}\n` +
    (PLANT
      ? `R21 G4a readPolicy 双档 e2e（--plant，应当变红）：断言 ${assertions} 项，失败 ${failures} 项（期望 > 0）\n`
      : `R21 G4a readPolicy 双档 e2e：断言 ${assertions} 项，失败 ${failures} 项\n`) +
    `RESULT: ${failed ? 'FAIL' : 'PASS'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}\n` +
    `${'='.repeat(72)}\n`,
)
process.exit(failed ? 1 : 0)
