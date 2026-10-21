// @ts-nocheck —— R24-A：生产接线 e2e（`WINSTAGE_READ_POLICY` 三态 + host config.masks 值级脱敏）。
/**
 * R24-A · 生产接线 e2e（R21-FS-R1 / R21-SENS-R1 的收口套件）
 *
 * ── 为什么必须新增 ──────────────────────────────────────────────────────────────
 * R21 findings 登记的两条残余都来自同一个形态：**功能实现了、生产通道没有**：
 *   · `readPolicy:'block'` 只能程序化构造（`fs-entry.ts` 没读 env）⇒ 生产不可达；
 *   · `sensitive-content` 的值级掩码只在"调用方自定义 mask"时可达，而
 *     `ReviewService` 从不传 `masks`、host 行 config 也没有该字段 ⇒ 生产恒不可达；
 * R21/R23 的 e2e 只证明了"程序化构造时行为正确"，**证明不了生产接线存在**。
 * 本套件把两条通道按**真实装配链**钉死：
 *   A1 `WINSTAGE_READ_POLICY` → **真实 `fs-entry.ts` 子进程** → `staging-fs` 归一；
 *   A2 host config `masks: string[]` → `plugin/index.ts::normalizeConfig` →
 *      `host-plugin.apply`（编译 + fail-closed）→ `getReviewService` → `ReviewService`
 *      → `Workspace.masks` → `renderChange()` 值级掩码 → `review.json`。
 *
 * ── 覆盖 ────────────────────────────────────────────────────────────────────────
 *   · A1 三态：未设 = record（默认不变）；block = block；**其它非空 = fail-safe block + warn**；
 *   · A2：config 正则字符串 → 值级 `<REDACTED len=N>`（review.json 无明文）；
 *   · A2 默认不变：`masks` 缺省 / 显式 `[]` ⇒ 与"没有该字段"逐字节一致（投影对比）；
 *     内置危险类仍走 R17 的**整份省略**（`diff=[] + SENSITIVE_OMIT_NOTE`），不回退；
 *   · 非法正则 ⇒ 装配期 **fail-closed**（`WINSTAGE_CONFIG_MASKS_INVALID`，logError + 无命令注册）；
 *   · 既有审阅服务（fs 面 prewarm 先建）后补 masks ⇒ 规则补到既有实例（R24-A2 缓存语义）。
 *
 * ── 本套件不做什么 ──────────────────────────────────────────────────────────────
 *   · 不跑真实 DSH profile（那由 gate-runner 在隔离实例上复核）；
 *   · 不读真实 `~/.npmrc`：所有敏感夹具都是工作区里构造的 marker；
 *   · 不证明"黑名单是边界"（`readPolicy` 仍是显式开关；默认 record = 只记不拦）。
 *
 * 用法：node tests/r24-fs-config.ts
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createStagingFileSystem, normalizeReadPolicy } from '../dsh-plugin/staging-fs.ts'
import { apply, compileConfiguredMasks } from '../dsh-plugin/host-plugin.ts'
import { disposeReviewServices, getReviewService, SENSITIVE_OMIT_NOTE } from '../dsh-plugin/review-service.ts'
import { normalizeConfig } from '../plugin/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SCRATCH = join(PKG, '.t', 'fs-policy', 'r24-fs-config')

let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}
const section = (title) => process.stdout.write(`\n=== ${title} ===\n`)

const savedEnv = { stageRoot: process.env.WINSTAGE_STAGE_ROOT, readPolicy: process.env.WINSTAGE_READ_POLICY }
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

/**
 * A1 子进程夹具（**套件自生成**，R25-B 修复）。
 *
 * 为什么内联：套件必须在**干净 checkout/CI** 上可跑 —— 早先版本引用
 * `.t/fs-policy/r24-readpolicy-child.ts`（未跟踪、`.t` 被 ignore），
 * 清 scratch 后变成 `Cannot find module`（gate-runner 在 final dist 树上实测 68/14）。
 * 现在每次运行把源码写到本套件自己的 `SCRATCH` 下（路径随套件清理），
 * 相对 import 用 `../../../dsh-plugin/fs-entry.ts`（SCRATCH = `.t/fs-policy/r24-fs-config`）。
 * 内容只用单引号字符串，避免嵌入模板字符串时的插值/转义问题。
 */
const CHILD_SOURCE = [
  "import { Context } from '@deepseek-ai/cordis'",
  '',
  'const workspaceRoot = process.argv[2]',
  "if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {",
  "  console.error('usage: node r24-readpolicy-child.ts <workspaceRoot>')",
  '  process.exit(2)',
  '}',
  '',
  'const captured = []',
  'const ctx = new Context()',
  'try {',
  '  ctx.logger.exporter({',
  '    levels: { default: 3 },',
  '    export: ({ type, args }) => captured.push(type + ": " + args.map((arg) => String(arg)).join(" ")),',
  '  })',
  '} catch (error) {',
  '  captured.push("exporter-failed: " + (error && error.message ? error.message : String(error)))',
  '}',
  "ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' })",
  '',
  "const module = await import('../../../dsh-plugin/fs-entry.ts')",
  'const StagingFileSystem = module.default',
  'const instance = new StagingFileSystem(ctx, { cwd: workspaceRoot, diffBasisMaxBytes: 1024 * 1024 })',
  '',
  'process.stdout.write(JSON.stringify({',
  '  env: process.env.WINSTAGE_READ_POLICY ?? null,',
  '  policy: instance.readPolicy,',
  '  raw: instance.readPolicyRaw ?? null,',
  '  source: instance.readPolicySource,',
  '  invalidWarnings: captured.filter((line) => /读策略配置非法|fail-safe/.test(line)),',
  '  capturedCount: captured.length,',
  '}) + "\\n")',
  '',
].join('\n')

const writeFile = (root, rel, content) => {
  const abs = join(root, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}
const readReview = (storeDir) => JSON.parse(readFileSync(join(storeDir, 'review.json'), 'utf8'))

try {
  // ═════════════════════════════════════════════════════════════════════════
  // 0. 缺口事实（这两条是 R21 findings 的残余，也是本套件的存在理由）
  // ═════════════════════════════════════════════════════════════════════════
  section('0. 缺口事实：env 只由 fs-entry 读取；masks 缺省时值级档不可达')
  {
    // 0.1 在生产入口之前，staging-fs 本身**不读** env：只有 fs-entry 那一层接线能让 env 生效
    const wsRoot = join(SCRATCH, 'gap-ws')
    const storeDir = join(SCRATCH, 'gap-store')
    mkdirSync(wsRoot, { recursive: true })
    process.env.WINSTAGE_STAGE_ROOT = storeDir
    process.env.WINSTAGE_READ_POLICY = 'block'
    const ctx = new Context()
    const Cls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, sessionId: 'r24-gap' })
    const direct = new Cls(ctx, { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    check(
      '直接构造 provider（不经 fs-entry）时 env 不生效 ⇒ env 的接线点唯一在 fs-entry.ts（缺口形态）',
      direct.readPolicy === 'record' && direct.readPolicySource === 'default',
      JSON.stringify({ env: process.env.WINSTAGE_READ_POLICY, policy: direct.readPolicy, source: direct.readPolicySource }),
    )
    delete process.env.WINSTAGE_READ_POLICY

    // 0.2 masks 缺省 ⇒ Workspace.extraMasks=[]：值级掩码分支不可达（R21-SENS-R1 的事实）
    const svc = getReviewService({ workspaceRoot: wsRoot, sessionId: 'r24-gap', storeDir })
    check('masks 缺省 ⇒ Workspace.extraMasks=[]（值级掩码分支生产不可达，R21-SENS-R1 的事实）', Array.isArray(svc.workspace.extraMasks) && svc.workspace.extraMasks.length === 0, JSON.stringify(svc.workspace.extraMasks))
    // 只写**暂存**（不预写真实盘：预写同内容会变成"无净变化"，review 里就没有这一行）
    svc.workspace.writeFile(join(wsRoot, 'config', 'custom.secret'), `api_key: R24GAP_PLAINTEXT_MARKER\n`, { origin: 'test' })
    svc.workspace.freezeCandidate({ source: 'test' })
    svc.publish()
    const gapReview = readFileSync(join(storeDir, 'review.json'), 'utf8')
    check(
      '缺口形态：普通路径正文不做值级掩码（默认行为 —— 路径黑名单式设计，不是本套件要改的语义）',
      gapReview.includes('R24GAP_PLAINTEXT_MARKER') && JSON.parse(gapReview).redactions?.masked === false,
      '明文可见 + redactions.masked=false = 默认不变；值级档要显式 config.masks 才开启（注意 review.json 的 policies 字段恒含 <REDACTED 字样，不能拿它当"已掩码"判据）',
    )
    disposeReviewServices()
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 1. readPolicy 归一表（三态 + fail-safe）
  // ═════════════════════════════════════════════════════════════════════════
  section('1. readPolicy 归一：未设=record / block=block / 其它非空=fail-safe block')
  {
    const expectPolicy = (raw, policy, source) => normalizeReadPolicy(raw)
    const defaults = [undefined, null, '', '   '].map((raw) => expectPolicy(raw))
    check(
      '未设/空/纯空白 ⇒ record（默认不变，source=default）',
      defaults.every((entry) => entry.policy === 'record' && entry.source === 'default' && entry.raw === undefined),
      JSON.stringify(defaults),
    )
    const record = expectPolicy('record')
    check("显式 'record' ⇒ record（source=explicit）", record.policy === 'record' && record.source === 'explicit', JSON.stringify(record))
    const block = expectPolicy('block')
    check("显式 'block' ⇒ block（source=explicit）", block.policy === 'block' && block.source === 'explicit', JSON.stringify(block))
    const spaced = expectPolicy('  block  ')
    check('首尾空白被忽略', spaced.policy === 'block' && spaced.source === 'explicit', JSON.stringify(spaced))
    const typos = ['bloock', 'blocked', 'stage', 'deny', 'BLOCK', 'true'].map((raw) => ({ raw, ...expectPolicy(raw) }))
    check(
      '其它非空值（拼错/旧值/大小写不符）⇒ **fail-safe 到 block** + source=invalid-fail-safe（不得静默退回只记不拦）',
      typos.every((entry) => entry.policy === 'block' && entry.source === 'invalid-fail-safe' && entry.raw === entry.raw.trim()),
      JSON.stringify(typos),
    )
    const nonString = expectPolicy(42)
    check('非字符串内部误用 ⇒ 同样 fail-safe 到 block（不做隐式第三条路）', nonString.policy === 'block' && nonString.source === 'invalid-fail-safe', JSON.stringify(nonString))
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. A1：**真实 fs-entry.ts** 子进程的 env 三态（含 warn 日志捕获）
  // ═════════════════════════════════════════════════════════════════════════
  section('2. A1 生产入口：WINSTAGE_READ_POLICY → 真实 fs-entry.ts（每个变体独立子进程）')
  {
    // 夹具由套件自生成到 SCRATCH（干净树/CI 可跑；见 CHILD_SOURCE 注释）
    const child = join(SCRATCH, 'r24-readpolicy-child.ts')
    writeFileSync(child, CHILD_SOURCE)
    const wsRoot = join(SCRATCH, 'entry-ws')
    mkdirSync(wsRoot, { recursive: true })
    check(
      'A1 前置：子进程夹具由套件自生成（不依赖未跟踪的 .t 文件；干净 checkout 可跑）',
      existsSync(child) && readFileSync(child, 'utf8') === CHILD_SOURCE,
      child,
    )
    const cases = [
      { id: 'unset', env: undefined, policy: 'record', source: 'default', warn: false },
      { id: 'record', env: 'record', policy: 'record', source: 'explicit', warn: false },
      { id: 'block', env: 'block', policy: 'block', source: 'explicit', warn: false },
      { id: 'spaces', env: '   ', policy: 'record', source: 'default', warn: false },
      { id: 'typo-bloock', env: 'bloock', policy: 'block', source: 'invalid-fail-safe', warn: true },
      { id: 'old-stage-value', env: 'stage', policy: 'block', source: 'invalid-fail-safe', warn: true },
    ]
    for (const item of cases) {
      const env = { ...process.env }
      delete env.WINSTAGE_READ_POLICY
      delete env.WINSTAGE_SKIP_ENV_GATE
      if (item.env !== undefined) env.WINSTAGE_READ_POLICY = item.env
      env.WINSTAGE_STAGE_ROOT = join(SCRATCH, 'entry-stage', item.id)
      const run = spawnSync(process.execPath, [child, wsRoot], {
        cwd: PKG,
        env,
        encoding: 'utf8',
        windowsHide: true,
        // 不捕获管道之外的任何输出：child 只写一行 JSON
        timeout: 120000,
      })
      let parsed
      try {
        parsed = JSON.parse(String(run.stdout ?? '').trim().split(/\r?\n/).pop() ?? '')
      } catch {
        parsed = undefined
      }
      check(
        `A1 env=${item.id}：fs-entry 装配成功（exit=0，child 真实 import 了生产入口）`,
        run.status === 0 && parsed !== undefined && parsed.capturedCount >= 1,
        `status=${run.status} stderr=${String(run.stderr ?? '').slice(0, 160)}`,
      )
      check(
        `A1 env=${item.id}：readPolicy=${item.policy} / source=${item.source}`,
        parsed?.policy === item.policy && parsed?.source === item.source && (parsed?.env ?? null) === (item.env === undefined ? null : item.env),
        JSON.stringify(parsed),
      )
      const warned = Array.isArray(parsed?.invalidWarnings) && parsed.invalidWarnings.length > 0
      check(
        `A1 env=${item.id}：${item.warn ? '有 warn（fail-safe 必须响）' : '无 warn（合法/缺省不噪声）'}`,
        warned === item.warn,
        JSON.stringify(parsed?.invalidWarnings ?? []),
      )
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. A2：config.masks 编译/校验（fail-closed 单一入口）
  // ═════════════════════════════════════════════════════════════════════════
  section('3. A2 编译：正则字符串 → 规则对象；非法配置 ⇒ fail-closed（抛错 + logError）')
  {
    check('缺省/[] ⇒ 空规则（不改变任何行为）', compileConfiguredMasks(undefined).length === 0 && compileConfiguredMasks([]).length === 0, '0 rules')
    const sourceRule = compileConfiguredMasks(['\\\\config\\\\custom\\.secret$'])[0]
    check(
      '源码串写法 ⇒ {id, pattern, hard:false}（hard:false = 值级档，不是 danger 整份省略）',
      sourceRule?.id === 'config-mask-1' && sourceRule?.pattern instanceof RegExp && sourceRule.pattern.source === '\\\\config\\\\custom\\.secret$' && sourceRule.hard === false,
      JSON.stringify({ id: sourceRule?.id, source: sourceRule?.pattern?.source, hard: sourceRule?.hard }),
    )
    const literalRule = compileConfiguredMasks(['/app\\.secrets$/i'])[0]
    check('字面量写法 `/pattern/flags` ⇒ flags 生效', literalRule?.pattern.source === 'app\\.secrets$' && literalRule.pattern.flags.includes('i'), JSON.stringify({ source: literalRule?.pattern?.source, flags: literalRule?.pattern?.flags }))
    const regExpRule = compileConfiguredMasks([/raw-regExp$/])[0]
    check('程序化调用可直接传 RegExp（自测/未来 API）', regExpRule?.pattern.source === 'raw-regExp$', JSON.stringify(regExpRule?.pattern?.source))
    const multi = compileConfiguredMasks(['a$', 'b$'])
    check('多条规则按 index 保序编号', multi.length === 2 && multi[0].id === 'config-mask-1' && multi[1].id === 'config-mask-2', JSON.stringify(multi.map((r) => r.id)))

    const errorLogs = []
    const expectFail = (label, raw, code) => {
      let thrown
      try {
        compileConfiguredMasks(raw, { logError: (message) => errorLogs.push(String(message)) })
      } catch (error) {
        thrown = error
      }
      check(
        `fail-closed：${label} ⇒ 抛 ${code}（先 logError，不静默忽略）`,
        thrown?.code === code && errorLogs.length > 0 && Array.isArray(thrown.problems) && thrown.problems.length > 0,
        JSON.stringify({ code: thrown?.code, problems: thrown?.problems, logs: errorLogs.slice(-1) }),
      )
    }
    expectFail("非法正则 '('", ['('], 'WINSTAGE_CONFIG_MASKS_INVALID')
    expectFail('空字符串条目', [''], 'WINSTAGE_CONFIG_MASKS_INVALID')
    expectFail('非字符串条目 42', [42], 'WINSTAGE_CONFIG_MASKS_INVALID')
    expectFail('非数组（string）', 'x', 'WINSTAGE_CONFIG_MASKS_INVALID')
    // 全有或全无：一条坏 ⇒ 整份拒（不保留"好的一半"）
    let allOrNothing
    try {
      compileConfiguredMasks(['ok$', '('])
    } catch (error) {
      allOrNothing = error
    }
    check('全有或全无：多条里一条非法 ⇒ 整份拒绝（不保留好的一半）', allOrNothing?.code === 'WINSTAGE_CONFIG_MASKS_INVALID' && allOrNothing.problems.length === 1, JSON.stringify(allOrNothing?.problems))
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. A2：config.masks → ReviewService → Workspace → review.json（值级脱敏）
  // ═════════════════════════════════════════════════════════════════════════
  section('4. A2 链路：config.masks 命中 ⇒ 值级 <REDACTED>；默认/[] 行为不变；内置仍整份省略')
  {
    const MASK_RULE = '\\\\config\\\\custom\\.secret$'
    const CUSTOM_CONTENT = `api_key: R24CUSTOM_SECRET_MARKER\npassword: R24CUSTOM_PASSWORD_MARKER\n`
    const NPMRC_CONTENT = `//registry.example/:_authToken=R24BUILTIN_NPM_MARKER\n`
    const DSH_CONTENT = `secret: R24BUILTIN_DSH_MARKER\n`

    const setup = (sessionId, storeName, masks) => {
      const wsRoot = join(SCRATCH, `ws-${sessionId}`)
      const storeDir = join(SCRATCH, storeName)
      mkdirSync(wsRoot, { recursive: true })
      process.env.WINSTAGE_STAGE_ROOT = storeDir
      const svc = getReviewService({ workspaceRoot: wsRoot, sessionId, storeDir, ...(masks === undefined ? {} : { masks }) })
      // 只写暂存（预写真实盘同内容会让净 diff 为空 ⇒ review 里没有行）
      svc.workspace.writeFile(join(wsRoot, 'config', 'custom.secret'), CUSTOM_CONTENT, { origin: 'test' })
      svc.workspace.writeFile(join(wsRoot, '.npmrc'), NPMRC_CONTENT, { origin: 'test' })
      svc.workspace.writeFile(join(wsRoot, '.dsh', '.credentials.yaml'), DSH_CONTENT, { origin: 'test' })
      svc.workspace.freezeCandidate({ source: 'test' })
      svc.publish()
      return { svc, wsRoot, storeDir, review: readReview(storeDir), text: readFileSync(join(storeDir, 'review.json'), 'utf8') }
    }

    const rules = compileConfiguredMasks([MASK_RULE])
    const masked = setup('r24-with-masks', 'store-with-masks', rules)
    const customRow = masked.review.files.find((row) => row.path.includes('custom.secret')) ?? null
    check('Rule 生效：Workspace.extraMasks 收到 1 条编译规则', masked.svc.workspace.extraMasks.length === 1 && masked.svc.workspace.extraMasks[0].pattern.source === '\\\\config\\\\custom\\.secret$', JSON.stringify(masked.svc.workspace.extraMasks.map((r) => r.pattern.source)))
    check('value-level：自定义 mask 条目被判成 sensitive/risk 且 contentMasked', customRow?.risk === 'sensitive' && customRow?.safety === 'risk' && customRow?.contentMasked === true, JSON.stringify({ risk: customRow?.risk, safety: customRow?.safety, contentMasked: customRow?.contentMasked }))
    check(
      'value-level：review.json 里没有凭据明文，只有 <REDACTED len=N>',
      !masked.text.includes('R24CUSTOM_SECRET_MARKER') && !masked.text.includes('R24CUSTOM_PASSWORD_MARKER') && masked.text.includes('<REDACTED len='),
      JSON.stringify(masked.review.redactions?.items),
    )
    check(
      'value-level：redactions 机读段给出 masked 理由',
      (masked.review.redactions?.items ?? []).some((item) => item.path.includes('custom.secret') && item.reason === 'masked'),
      JSON.stringify(masked.review.redactions?.items),
    )
    const builtinRows = masked.review.files.filter((row) => String(row.path).includes('.npmrc') || String(row.path).includes('.credentials.yaml'))
    check(
      '内置危险类**不回退**：仍走 R17 的整份省略（diff=[] + SENSITIVE_OMIT_NOTE）',
      builtinRows.length === 2 && builtinRows.every((row) => row.safety === 'danger' && Array.isArray(row.diff) && row.diff.length === 0 && row.note === SENSITIVE_OMIT_NOTE),
      JSON.stringify(builtinRows.map((row) => ({ path: row.path, safety: row.safety, diff: row.diff?.length }))),
    )
    check(
      '内置危险类：即使配了自定义 mask，其明文也不出现',
      !masked.text.includes('R24BUILTIN_NPM_MARKER') && !masked.text.includes('R24BUILTIN_DSH_MARKER'),
      JSON.stringify({ npm: masked.text.includes('R24BUILTIN_NPM_MARKER'), dsh: masked.text.includes('R24BUILTIN_DSH_MARKER') }),
    )

    // 默认（不传 masks）与显式 [] 必须与"没有该字段"一致
    const defaulted = setup('r24-default-masks', 'store-default-masks', undefined)
    const emptyArray = setup('r24-empty-masks', 'store-empty-masks', [])
    check('默认不变：不传 masks ⇒ extraMasks=[] 且无 contentMasked 行', defaulted.svc.workspace.extraMasks.length === 0 && (defaulted.review.files ?? []).every((row) => row.contentMasked !== true), JSON.stringify((defaulted.review.files ?? []).map((row) => row.contentMasked ?? null)))
    check('默认不变：普通路径正文的明文仍可见（路径黑名单式设计，R24 不改变它）', defaulted.text.includes('R24CUSTOM_SECRET_MARKER'), '设计边界')
    check('默认不变：内置危险类仍整份省略', (defaulted.review.files ?? []).filter((row) => row.safety === 'danger').every((row) => row.diff?.length === 0 && row.note === SENSITIVE_OMIT_NOTE), 'R17 不回退')
    const projection = (review) => JSON.stringify({ files: review.files, redactions: review.redactions, counts: review.counts, riskCounts: review.riskCounts })
    check(
      '默认行为逐字段一致：`masks` 缺省 与 显式 `[]` 的 {files, redactions, counts, riskCounts} 完全相同',
      projection(defaulted.review) === projection(emptyArray.review),
      'deep equal（这是"默认行为不变"的机读证据）',
    )

    // 既有服务后补 masks（fs 面 prewarm 先建、host 后到）
    const lateWs = join(SCRATCH, 'ws-late')
    const lateStore = join(SCRATCH, 'store-late')
    mkdirSync(lateWs, { recursive: true })
    process.env.WINSTAGE_STAGE_ROOT = lateStore
    const early = getReviewService({ workspaceRoot: lateWs, sessionId: 'r24-late', storeDir: lateStore })
    check('缓存语义前置：先建的服务 extraMasks=[]', early.workspace.extraMasks.length === 0, '0 rules')
    const late = getReviewService({ workspaceRoot: lateWs, sessionId: 'r24-late', storeDir: lateStore, masks: rules })
    check('缓存语义：后到的 config.masks 补到**既有**服务实例（不会因先创建而永久不可达）', late === early && late.workspace.extraMasks.length === 1, JSON.stringify({ same: late === early, rules: late.workspace.extraMasks.length }))
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. A2：host-plugin.apply 真实接线（fake cordis ctx；命令面触发 serviceFor）
  // ═════════════════════════════════════════════════════════════════════════
  section('5. A2 装配：apply(config.masks) → 命令 serviceFor → getReviewService（值级脱敏真实链路）')
  {
    const makeFakeCtx = (rows = []) => {
      const logs = { info: [], warn: [], error: [] }
      const commands = []
      const disposers = []
      const ctx = {
        logger: {
          info: (message) => logs.info.push(String(message)),
          warn: (message) => logs.warn.push(String(message)),
          error: (message) => logs.error.push(String(message)),
        },
        fiber: { entry: { parent: { data: rows } } },
        get: () => undefined,
        effect: (fn) => {
          const dispose = typeof fn === 'function' ? fn() : undefined
          if (typeof dispose === 'function') disposers.push(dispose)
          return dispose
        },
        inject: (names, callback) => {
          if (Array.isArray(names) && names.includes('commands')) {
            callback({
              commands: {
                register: (definition) => {
                  commands.push(definition)
                  return () => {
                    const index = commands.indexOf(definition)
                    if (index >= 0) commands.splice(index, 1)
                  }
                },
              },
            })
          }
          // webServer/connection 不注入 = headless 装配（apply 的注释明确这是正常形态）
        },
      }
      return { ctx, logs, commands, disposers }
    }
    const disposeAll = (harness) => {
      for (const dispose of harness.disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* best effect */
        }
      }
    }
    const findBySub = (commands) =>
      commands.find((definition) => definition.definitionId === 'winstage-sandbox/winstage') ??
      commands.find((definition) => /refresh$/.test(definition.definitionId))

    // 5.1 合法 config.masks：装配成功、命令注册、经命令解析出的服务带规则
    {
      const wsRoot = join(SCRATCH, 'ws-apply')
      const storeDir = join(SCRATCH, 'store-apply')
      mkdirSync(wsRoot, { recursive: true })
      process.env.WINSTAGE_STAGE_ROOT = storeDir
      const harness = makeFakeCtx()
      let applyError
      try {
        apply(harness.ctx, {
          enabled: true,
          workspaceRoot: wsRoot,
          probeOnStart: false,
          verboseLog: false,
          masks: ['\\\\config\\\\apply\\.secret$'],
        })
      } catch (error) {
        applyError = error
      }
      check('装配：合法 masks ⇒ apply 不抛错', applyError === undefined, String(applyError?.message ?? 'ok'))
      check('装配：命令面仍注册 7 条（与 R21 一致）', harness.commands.length === 7, String(harness.commands.length))
      const handler = findBySub(harness.commands)
      const invitation = { rawInput: 'list', agent: { session: { id: 'r24-apply-session' } } }
      let result
      try {
        result = handler?.handler(invitation)
      } catch (error) {
        result = { kind: 'threw', text: String(error?.message ?? error) }
      }
      const service = getReviewService({ workspaceRoot: wsRoot, sessionId: 'r24-apply-session' })
      check('装配：命令 serviceFor 解析出的审阅服务带 config.masks 规则', service.workspace.extraMasks.length === 1 && service.workspace.extraMasks[0].pattern.source === '\\\\config\\\\apply\\.secret$', JSON.stringify(service.workspace.extraMasks.map((r) => r.pattern.source)))
      check('装配：命令本身可执行（不是靠旁路构造证明接线）', result?.kind === 'success' || result?.kind === 'error', JSON.stringify({ kind: result?.kind, text: String(result?.text ?? '').slice(0, 120) }))

      // 真实链路末端：用该服务写自定义路径 → 冻结 → publish → review.json 无明文
      service.workspace.writeFile(join(wsRoot, 'config', 'apply.secret'), `api_key: R24APPLY_SECRET_MARKER\n`, { origin: 'test' })
      service.workspace.freezeCandidate({ source: 'test' })
      service.publish()
      const text = readFileSync(join(storeDir, 'review.json'), 'utf8')
      check(
        '装配链路末端：config.masks → review.json 值级脱敏（无明文 + <REDACTED>）',
        !text.includes('R24APPLY_SECRET_MARKER') && text.includes('<REDACTED len='),
        'apply → serviceFor → ReviewService → Workspace → renderChange',
      )
      disposeAll(harness)
      disposeReviewServices()
    }

    // 5.2 非法 masks：装配期 fail-closed（抛错 + logError + 零命令注册）
    {
      const harness = makeFakeCtx()
      let applyError
      try {
        apply(harness.ctx, { enabled: true, workspaceRoot: join(SCRATCH, 'ws-apply-bad'), probeOnStart: false, verboseLog: false, masks: ['('] })
      } catch (error) {
        applyError = error
      }
      check('fail-closed：非法正则 ⇒ apply 抛错（host 行不装配）', applyError?.code === 'WINSTAGE_CONFIG_MASKS_INVALID', String(applyError?.code ?? applyError?.message))
      check('fail-closed：抛错前已 logError（不是静默）', harness.logs.error.some((line) => /masks 非法|fail-closed/.test(line)), JSON.stringify(harness.logs.error.slice(-1)))
      check('fail-closed：零命令注册（错误发生在所有注册之前）', harness.commands.length === 0, String(harness.commands.length))
      const nonArray = makeFakeCtx()
      let nonArrayError
      try {
        apply(nonArray.ctx, { enabled: true, workspaceRoot: join(SCRATCH, 'ws-apply-bad2'), probeOnStart: false, verboseLog: false, masks: 'not-an-array' })
      } catch (error) {
        nonArrayError = error
      }
      check('fail-closed：masks 非数组 ⇒ 同样抛错', nonArrayError?.code === 'WINSTAGE_CONFIG_MASKS_INVALID', String(nonArrayError?.code ?? nonArrayError?.message))
    }

    // 5.3 默认：apply 不带 masks ⇒ 服务 extraMasks 为空，内置危险类仍 OMIT（默认行为不变）
    {
      const wsRoot = join(SCRATCH, 'ws-apply-default')
      const storeDir = join(SCRATCH, 'store-apply-default')
      mkdirSync(wsRoot, { recursive: true })
      process.env.WINSTAGE_STAGE_ROOT = storeDir
      const harness = makeFakeCtx()
      apply(harness.ctx, { enabled: true, workspaceRoot: wsRoot, probeOnStart: false, verboseLog: false })
      const handler = findBySub(harness.commands)
      try {
        handler?.handler({ rawInput: 'list', agent: { session: { id: 'r24-apply-default' } } })
      } catch {
        /* 命令结果不影响本断言 */
      }
      const service = getReviewService({ workspaceRoot: wsRoot, sessionId: 'r24-apply-default' })
      check('默认不变：apply 无 masks ⇒ 服务 extraMasks=[]', service.workspace.extraMasks.length === 0, JSON.stringify(service.workspace.extraMasks))
      service.workspace.writeFile(join(wsRoot, '.npmrc'), `//registry/:_authToken=R24APPLYDEFAULT_MARKER\n`, { origin: 'test' })
      service.workspace.freezeCandidate({ source: 'test' })
      service.publish()
      const review = readReview(storeDir)
      const row = (review.files ?? []).find((entry) => String(entry.path).includes('.npmrc'))
      check('默认不变：内置危险类仍整份省略（R17 不回退）', row?.safety === 'danger' && row?.diff?.length === 0 && row?.note === SENSITIVE_OMIT_NOTE, JSON.stringify(row))
      check('默认不变：review.json 无明文', !readFileSync(join(storeDir, 'review.json'), 'utf8').includes('R24APPLYDEFAULT_MARKER'), 'OMIT')
      disposeAll(harness)
      disposeReviewServices()
    }

    // 5.3b R34b-G-04：workspaceRoot 缺失/不存在 ⇒ 装配期 fail-closed，不回退插件目录
    {
      const empty = makeFakeCtx()
      let emptyError
      try {
        apply(empty.ctx, { enabled: true, workspaceRoot: '', probeOnStart: false, verboseLog: false })
      } catch (error) {
        emptyError = error
      }
      check(
        '空 workspaceRoot ⇒ WINSTAGE_WORKSPACE_ROOT_MISSING（不装配）',
        emptyError?.code === 'WINSTAGE_WORKSPACE_ROOT_MISSING',
        JSON.stringify({ code: emptyError?.code }),
      )
      const missing = makeFakeCtx()
      let missingError
      try {
        apply(missing.ctx, {
          enabled: true,
          workspaceRoot: join(SCRATCH, 'ws-does-not-exist'),
          probeOnStart: false,
          verboseLog: false,
        })
      } catch (error) {
        missingError = error
      }
      check(
        '不存在的 workspaceRoot ⇒ WINSTAGE_WORKSPACE_ROOT_NOT_FOUND（不装配、不回退）',
        missingError?.code === 'WINSTAGE_WORKSPACE_ROOT_NOT_FOUND',
        JSON.stringify({ code: missingError?.code }),
      )
      const disabled = makeFakeCtx()
      let disabledError
      try {
        apply(disabled.ctx, { enabled: false, workspaceRoot: '', probeOnStart: false, verboseLog: false })
      } catch (error) {
        disabledError = error
      }
      check(
        '关闭态 + 空 workspaceRoot ⇒ 不抛错（关闭必须对原 harness 零影响）',
        disabledError === undefined,
        String(disabledError?.message ?? 'ok'),
      )
    }

    // 5.4 schema 层：masks 字段被真 schemastery 接受，缺省水合为 []
    {
      const { Config } = await import('../plugin/index.ts')
      // 真 schemastery 对 `meta.volatile` 字段输出 Volatile 引用对象 ⇒ 用生产同一个
      // `normalizeConfig()` 看"交付给 apply 的形状"（与宿主投影路径一致）。
      const validated = normalizeConfig(Config['~standard'].validate({}).value)
      check('schema：masks 缺省水合为 []（生产 host 行不写该键也合法）', Array.isArray(validated.masks) && validated.masks.length === 0, JSON.stringify(validated.masks))
      const withMasks = normalizeConfig(Config['~standard'].validate({ masks: ['\\\\config\\\\x$'] }).value)
      check('schema：masks: string[] 校验通过（经 normalizeConfig 解 Volatile）', Array.isArray(withMasks.masks) && withMasks.masks[0] === '\\\\config\\\\x$', JSON.stringify(withMasks.masks))
      const badType = Config['~standard'].validate({ masks: 'nope' })
      check('schema：masks 非数组 ⇒ 校验 issue（真 schemastery 先挡一层）', Array.isArray(badType.issues) && badType.issues.length > 0, JSON.stringify(badType.issues))
      const normalized = normalizeConfig({ masks: ['a$'] })
      check('normalizeConfig：masks 透传到 ConfigShape（apply 能收到）', Array.isArray(normalized.masks) && normalized.masks[0] === 'a$', JSON.stringify(normalized.masks))

      // 两侧 schema 声明一致（生产 = plugin/config.ts；手写 = dsh-plugin/schema.ts）
      const { FIELD_NAMES: prodFields } = await import('../plugin/config.ts')
      const { FIELD_NAMES: handFields, Config: handConfig } = await import('../dsh-plugin/schema.ts')
      check(
        'schema 声明一致：两侧 FIELD_NAMES 都含 masks（生产 5 字段 / 手写 5 字段）',
        prodFields.includes('masks') && handFields.includes('masks') && prodFields.length === 5 && handFields.length === 5,
        JSON.stringify({ prod: prodFields, hand: handFields }),
      )
      // 手写 schema 的数组字段必须能被 schemastery 水合（R24 修：`list`→`inner` 文档形状）
      const { default: z } = await import('@deepseek-ai/schemastery')
      let hydrated
      let hydratedField
      let hydrationError
      try {
        hydrated = new z(handConfig.toJSON())
        hydratedField = new z(handConfig.dict.masks.toJSON())
      } catch (error) {
        hydrationError = error
      }
      check(
        '手写 schema：根文档与 masks 字段文档都能被 schemastery 水合（设置页 plainSchema 路径不炸）',
        hydrationError === undefined && hydrated?.type === 'object' && hydratedField?.type === 'array',
        String(hydrationError?.message ?? JSON.stringify({ root: hydrated?.type, field: hydratedField?.type })),
      )
      const handValidated = handConfig['~standard'].validate({ masks: ['a', 'b'] })
      check(
        '手写 schema：masks: string[] 校验通过、元素类型不符给 issue',
        Array.isArray(handValidated.value?.masks) && handValidated.value.masks.length === 2 && Array.isArray(handConfig['~standard'].validate({ masks: [42] }).issues),
        JSON.stringify(handValidated.value?.masks),
      )
    }
  }
} finally {
  if (savedEnv.stageRoot === undefined) delete process.env.WINSTAGE_STAGE_ROOT
  else process.env.WINSTAGE_STAGE_ROOT = savedEnv.stageRoot
  if (savedEnv.readPolicy === undefined) delete process.env.WINSTAGE_READ_POLICY
  else process.env.WINSTAGE_READ_POLICY = savedEnv.readPolicy
  try {
    disposeReviewServices()
  } catch {
    /* best effort */
  }
}

if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
process.stdout.write(
  `\n${'='.repeat(72)}\n` +
    `R24-A 生产接线（readPolicy env 三态 + config.masks 值级脱敏）：断言 ${assertions} 项，失败 ${failures} 项\n` +
    `RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n` +
    `${'='.repeat(72)}\n`,
)
process.exit(failures === 0 ? 0 : 1)
