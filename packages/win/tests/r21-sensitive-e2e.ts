// @ts-nocheck —— R21 G4b：`sensitive-content` 端到端脱敏（候选 diff / review 快照 / 面板 / 审计 JSON / 日志）。
/**
 * R21 · G4b —— 敏感内容端到端脱敏
 *
 * ── 为什么必须新增这个套件（红证据）────────────────────────────────────────────
 * R17 报告（`git 历史（旧轮次报告已清理）` 的 R17-P0-02 / R17-P1-05）声称：
 *   「凭据明文进 review.json」已修（内置遮蔽类 ⇒ 内容整份省略），
 *   「值级掩码对 YAML 块标量正文漏明」已修（块标量状态机）。
 * 但 R17 对**块标量**的验收只打到 `maskSensitiveLines()` 的**多行调用**（单测形态），
 * 没有一条断言走 `ReviewService.publish()` 的真实链路。本套件用它自己的真实链路复现出
 * 一个仍然存在的缺陷（R21-G4b-01，见 `.lead/logs/fs-policy/probe-e*.log`）：
 *   `renderChange()` **逐行**调用 `maskSensitiveLines([单行])`，而块标量遮蔽依赖
 *   **跨行状态机**（打开行 `secret: |` 与正文不在同一个数组里）⇒ 块标量正文（真实 YAML
 *   凭据文件的常态：短、可读、不是 16+ 高熵串）**明文进 review.json**，条目却同时写着
 *   `contentMasked: true` —— 与 R17 修掉的「安全声明与实际相反」是同一形态。
 *
 * ── 覆盖（contract §2 G4b）──────────────────────────────────────────────────
 *   · 真实链路：`Workspace.writeFile()` → `freezeCandidate()` → `ReviewService.publish()`
 *     → `review.json` / `candidates/*.json` / 面板路由 payload（`buildPanelPayload`）/
 *     `sandbox-audit.json`（`buildAuditReport` 的真实形状）/ 宿主日志；
 *   · 三类输入：**文件内容**（自定义 mask 的值级脱敏）、**profile 文件**（`.dsh` 下内置
 *     遮蔽类整份省略）、**命令/审计**（shim 审计 JSON 只有路径与计数）；
 *   · 断言：明文凭据不出现、只有 `<REDACTED len=N>`（值级档）或整份省略（danger 档）；
 *   · 误报对照：路径/URI/邮箱/短标量/普通句子不得被过度脱敏。
 *
 * ── 本套件**不**做什么（如实声明，见输出末尾 RESIDUAL）──────────────────────────
 *   · 内置遮蔽类（`MASK_CLASSES` 命中）**不经过** sensitive-content —— R17 起走
 *     「内容整份省略」；本套件把两条链路分开断言，不混同；
 *   · 值级脱敏只在**调用方自定义 mask**（`Workspace.masks` / `ws.extraMasks`）时可达；
 *     其生产接线当前**没有生产者**（`ReviewService` 不传 masks、`getReviewService` 无透传），
 *     本套件按 R17 的设计语义**程序化注入**自定义规则来验证机制本身；
 *   · 非遮蔽路径的正文**不做**值级掩码（路径黑名单式设计）—— 用普通文件的明文做
 *     **阳性对照**，证明"明文不出现"的断言真的能红；
 *   · 不跑真实 shell（`sandbox-audit.json` 用其真实聚合函数 `buildAuditReport` + 真实落点布局；
 *     命令文本本来就不进这些载荷，见 RESIDUAL）。
 *
 * 用法：node tests/r21-sensitive-e2e.ts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createStagingFileSystem } from '../dsh-plugin/staging-fs.ts'
import {
  ReviewService,
  SENSITIVE_MASK_NOTE,
  SENSITIVE_OMIT_NOTE,
  getReviewService,
} from '../dsh-plugin/review-service.ts'
import { PANEL_SNAPSHOT_PATH, buildPanelPayload } from '../dsh-plugin/host-plugin.ts'
import { buildAuditReport } from '../src/audit-report.ts'
import { maskSensitiveLine } from '../dsh-plugin/sensitive-content.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const SCRATCH = join(PKG, '.t', 'fs-policy', 'r21-g4b')

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
// 夹具（marker 全部是构造的，不是真凭据）
// ═══════════════════════════════════════════════════════════════════════════
const MARK = {
  customApiKey: 'R21CUSTOM_APIKEY_9f3c1d7e',
  customPassword: 'R21CUSTOM_PASSWORD_4b8a',
  blockBodyA: 'hunter2-short',
  blockBodyB: 'abc123',
  builtinCredential: 'R21BUILTIN_CREDENTIAL_1a2b3c',
  builtinNpmrc: 'R21BUILTIN_NPMRC_4d5e6f',
  profileKey: 'sk-R21PROFILE0123456789abcdef',
  plain: 'R21PLAIN_MARKER_7g8h',
  command: 'R21COMMANDLINE_SECRET_2k4m6n',
  /** R21-SENS-02（gate-runner 独立探针发现的 URI 内嵌凭据形态） */
  uriToken: 'R21URI_TOKEN_3f9a2b4c',
  uriPassword: 'R21URI_PASSWORD_5c7d8e',
  uriRegistry: 'R21URI_REGISTRY_8e1f9a',
}

const CUSTOM_RULE = {
  id: 'r21-custom-secrets',
  // `hard:false` 是值级掩码档的必要条件：`maskReason()` 对 extraMasks 默认 `hard:true`，
  // 而 `classifyChange()` 会把 hard 自定义规则抬进 danger 档（⇒ 整份省略、不走 sensitive-content）。
  hard: false,
  pattern: /\\config\\(app\.secrets|endpoints\.env)$/i,
  reason: 'R21 e2e 自定义遮蔽规则（值级掩码链路）',
}

const CUSTOM_CONTENT = [
  `api_key: ${MARK.customApiKey}`,
  `password: ${MARK.customPassword}`,
  'token: |',
  `  ${MARK.blockBodyA}`,
  'secret: |',
  `  ${MARK.blockBodyB}`,
  'path: C:\\Users\\someone\\Desktop\\project\\file.txt',
  'note: the quick brown fox jumps over the lazy dog',
].join('\n')

/**
 * R21-SENS-02：URI 内嵌凭据（gate-runner 独立探针 C5 的四条复现形态）。
 * 这些值以 `scheme://` 开头，但**里面嵌的是凭据**，不是"位置" ⇒ 必须段级遮蔽，
 * 且必须保留 user/host/path 结构（面板还要看得懂这一行是什么）。
 */
const ENDPOINTS_CONTENT = [
  `webhook=https://hooks.example/x?access_token=${MARK.uriToken}`,
  `url=https://user:${MARK.uriPassword}@host.example/path`,
  `registry=https://registry.ind/:_authToken=${MARK.uriRegistry}`,
].join('\n')


const BUILTIN_FILES = {
  '.dsh/.credentials.yaml': `secret: ${MARK.builtinCredential}\n`,
  '.npmrc': `//registry.example/:_authToken=${MARK.builtinNpmrc}\n`,
  '.dsh/profiles/desktop/cordis.patch.yml': `plugins:\n  deepseek:\n    apiKey: ${MARK.profileKey}\n`,
}
const PLAIN_CONTENT = `plain note line\n${MARK.plain}\n`

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
const savedStageRoot = process.env.WINSTAGE_STAGE_ROOT

/** 捕获日志（info/warn/error 三级）——真实宿主里它们分别走 ctx.logger 与 stderr */
const makeLogSink = () => {
  const entries = []
  return {
    entries,
    push: (level) => (message) => entries.push({ level, message: String(message) }),
    text: () => entries.map((entry) => entry.message).join('\n'),
  }
}

const makeService = ({ wsRoot, storeDir, sessionId, masks }) => {
  process.env.WINSTAGE_STAGE_ROOT = storeDir
  const sink = makeLogSink()
  const svc = new ReviewService({
    workspaceRoot: wsRoot,
    sessionId,
    storeDir,
    ...(masks === undefined ? {} : { masks }),
    log: sink.push('info'),
    logger: { info: sink.push('info'), warn: sink.push('warn'), error: sink.push('error') },
  })
  // 构造后再挂一次同样口径的日志（覆盖 ctor 之后的调用点）
  svc.log = sink.push('info')
  svc.logger = { info: sink.push('info'), warn: sink.push('warn'), error: sink.push('error') }
  return { svc, sink }
}

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

try {
  // ═════════════════════════════════════════════════════════════════════════
  // 0. 根因复现（不依赖修复）：块标量需**跨行**状态机，逐行调用必然漏
  // ═════════════════════════════════════════════════════════════════════════
  section('0. 根因复现：块标量遮蔽依赖跨行状态机（renderChange 逐行调用 ⇒ 漏）')
  {
    const { maskSensitiveLines } = await import('../dsh-plugin/sensitive-content.ts')
    const lines = CUSTOM_CONTENT.split('\n').map((text, index) => ({ type: 'add', line: index + 1, text }))
    const multi = maskSensitiveLines(lines)
    const multiText = multi.lines.map((line) => line.text).join('\n')
    check(
      '多行调用（模块设计入口）：块标量正文被遮 + 机读理由 block-scalar',
      !multiText.includes(MARK.blockBodyA) && !multiText.includes(MARK.blockBodyB) && multi.reasons.includes('block-scalar'),
      JSON.stringify({ reasons: multi.reasons, bodyA: multiText.includes(MARK.blockBodyA), bodyB: multiText.includes(MARK.blockBodyB) }),
    )
    // 旧 renderChange 的形态：一次只喂一行
    const perLine = lines.map((line) => maskSensitiveLines([line]).lines[0]?.text ?? '').join('\n')
    check(
      '逐行调用（R21 修复前的 renderChange 形态）：块标量**正文漏明**（根因）',
      perLine.includes(MARK.blockBodyA) && perLine.includes(MARK.blockBodyB),
      JSON.stringify({ bodyA: perLine.includes(MARK.blockBodyA), bodyB: perLine.includes(MARK.blockBodyB) }),
    )
    const others = readdirSync(join(PKG, 'tests'))
      // `r24-fs-config.ts` 是 R24 新增的生产接线套件（它会打自定义 mask 进链路是**预期**的）
      .filter((name) => name.endsWith('.ts') && !['r21-fs-policy.ts', 'r21-sensitive-e2e.ts', 'r24-fs-config.ts'].includes(name))
      .map((name) => readFileSync(join(PKG, 'tests', name), 'utf8'))
    const chainSuites = others.filter((text) => /extraMasks|sensitiveMasked|redactions/.test(text)).length
    check(
      'R21 轮之前没有任何 tests 套件把自定义 mask 打进 ReviewService.publish() 的真实链路（R24 由 r24-fs-config.ts 正式覆盖）',
      chainSuites === 0,
      chainSuites ? `已有 ${chainSuites} 个 R21 既有套件提到相关符号` : '0 个 R21 既有套件覆盖该链路（R17 只覆盖 maskSensitiveLines 多行单测）',
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 1. 自定义 mask 真实链路：候选 → review.json → 面板（值级脱敏）
  // ═════════════════════════════════════════════════════════════════════════
  section('1. 自定义 mask 真实链路（文件内容）：review.json 只有 <REDACTED>，没有明文')
  {
    const wsRoot = join(SCRATCH, 'ws-custom')
    const storeDir = join(SCRATCH, 'store-custom')
    const sessionId = 'r21-g4b-custom'
    mkdirSync(wsRoot, { recursive: true })
    process.env.WINSTAGE_STAGE_ROOT = storeDir

    // 真实 StagingFileSystem（record 档）只用于读侧：给 review.json 产 readVisibility 段
    const stageCtx = new Context()
    const StageCls = createStagingFileSystem({ base: LocalFileSystem, enabled: () => true, readPolicy: 'record', sessionId })
    const stageFs = new StageCls(stageCtx, { cwd: wsRoot, diffBasisMaxBytes: 1024 * 1024 })
    const stageSink = makeLogSink()
    stageFs.log = stageSink.push('info')
    stageFs.logError = stageSink.push('error')

    const { svc, sink } = makeService({ wsRoot, storeDir, sessionId })
    check('未注入自定义规则时 Workspace.masks 为空（决定值级档是否可达的开关）', Array.isArray(svc.workspace.extraMasks) && svc.workspace.extraMasks.length === 0, JSON.stringify(svc.workspace.extraMasks))
    svc.workspace.extraMasks = [CUSTOM_RULE]

    svc.workspace.writeFile(join(wsRoot, 'config', 'app.secrets'), CUSTOM_CONTENT, { origin: 'test' })
    svc.workspace.writeFile(join(wsRoot, 'config', 'endpoints.env'), ENDPOINTS_CONTENT, { origin: 'test' })
    for (const [rel, content] of Object.entries(BUILTIN_FILES)) svc.workspace.writeFile(join(wsRoot, ...rel.split('/')), content, { origin: 'test' })
    svc.workspace.writeFile(join(wsRoot, 'notes.txt'), PLAIN_CONTENT, { origin: 'test' })
    const frozen = svc.workspace.freezeCandidate({ source: 'test' })
    check('真实链路：候选已冻结（包含 6 条净变更）', frozen?.changes?.length === 6, JSON.stringify({ changes: frozen?.changes?.map((c) => c.path) }))

    // 读侧：经真实 StagingFileSystem 读 `.npmrc`（record 档登记 + 日志）
    const npmrcTarget = { targetKey: join(wsRoot, '.npmrc'), displayPath: join(wsRoot, '.npmrc') }
    const npmrcText = await stageFs.readText(npmrcTarget)
    check('读侧链路：record 档照常返回暂存内容（读侧与内容脱敏是两条链路）', typeof npmrcText === 'string' && npmrcText.includes(MARK.builtinNpmrc), JSON.stringify(npmrcText))

    // 审计 JSON：真实聚合函数 + 真实落点布局（captureAudit 的输出形状）
    const auditJsonl = join(storeDir, 'audit.jsonl')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(
      auditJsonl,
      [
        `[winstage-audit][4242][4242] ${JSON.stringify({ op: 'file.open', mode: 'read', path: join(wsRoot, '.npmrc') })}`,
        `[winstage-audit][4242][4242] ${JSON.stringify({ op: 'file.open', mode: 'write', path: join(wsRoot, 'config', 'app.secrets') })}`,
        `[winstage-audit][4242][4242] ${JSON.stringify({ op: 'file.open', mode: 'write', path: join(wsRoot, 'notes.txt') })}`,
        // 命令行/环境类凭据：shim 审计不含命令文本，这里塞一个未知字段证明聚合器不会把它带进载荷
        `[winstage-audit][4242][4242] ${JSON.stringify({ op: 'process.spawn', command: `cmd /c set TOKEN=${MARK.command}` })}`,
      ].join('\n'),
    )
    const auditReport = buildAuditReport(readFileSync(auditJsonl, 'utf8').split(/\r?\n/), { root: wsRoot, audits: [auditJsonl] })
    writeFileSync(join(storeDir, 'sandbox-audit.json'), `${JSON.stringify(auditReport, null, 2)}\n`)
    check('审计链路：真实聚合产物已按同一布局落盘（sandbox-audit.json）', readdirSync(storeDir).includes('sandbox-audit.json'), JSON.stringify(readdirSync(storeDir).sort()))

    svc.publish()
    const reviewText = readFileSync(join(storeDir, 'review.json'), 'utf8')
    const review = JSON.parse(reviewText)
    const customRow = review.files.find((row) => row.path.includes('app.secrets')) ?? null
    const customDiff = (customRow?.diff ?? []).map((line) => String(line.text ?? '')).join('\n')

    check('自定义 mask 条目被判成 sensitive/risk（⇒ 走值级掩码，而不是 danger 整份省略）', customRow?.risk === 'sensitive' && customRow?.safety === 'risk', JSON.stringify({ risk: customRow?.risk, safety: customRow?.safety }))
    check('自定义 mask 条目声明 contentMasked + masked 策略 note', customRow?.contentMasked === true && customRow?.note === SENSITIVE_MASK_NOTE, JSON.stringify({ contentMasked: customRow?.contentMasked, note: customRow?.note }))
    check(
      'R21-G4b-01（红→绿）：块标量正文不得进 review.json（修复前 hunter2-short / abc123 明文出现）',
      !reviewText.includes(MARK.blockBodyA) && !reviewText.includes(MARK.blockBodyB),
      JSON.stringify({ bodyA: reviewText.includes(MARK.blockBodyA), bodyB: reviewText.includes(MARK.blockBodyB) }),
    )
    check(
      '自定义 mask：行内凭据值不得进 review.json（只有 <REDACTED len=N>）',
      !reviewText.includes(MARK.customApiKey) && !reviewText.includes(MARK.customPassword),
      JSON.stringify({ apiKey: reviewText.includes(MARK.customApiKey), password: reviewText.includes(MARK.customPassword) }),
    )
    check(
      '自定义 mask：键名/结构保留（面板仍能说"改的是哪个键"）',
      ['api_key:', 'password:', 'token:', 'secret:'].every((key) => customDiff.includes(key)),
      customDiff.slice(0, 200),
    )
    const redactedCount = (customDiff.match(/<REDACTED len=\d+>/g) ?? []).length
    check(
      '自定义 mask：diff 里出现 ≥6 段 <REDACTED len=N>（4 个值 + 2 行块标量正文）',
      redactedCount >= 6,
      `redacted=${redactedCount}`,
    )
    check(
      '误报对照（同一文件内）：普通路径与普通句子**不得**被脱敏',
      customDiff.includes('path: C:\\Users\\someone\\Desktop\\project\\file.txt') &&
        customDiff.includes('note: the quick brown fox jumps over the lazy dog'),
      JSON.stringify(customDiff.split('\n').slice(-2)),
    )
    check(
      'redactions 段：masked=true、segments≥6、理由含 block-scalar（机读，不静默）',
      review.redactions?.masked === true &&
        review.redactions?.fields >= 4 &&
        review.redactions?.segments >= 6 &&
        (review.redactions?.items ?? []).some((item) => item.path.includes('app.secrets') && item.reason === 'masked' && item.maskReasons.includes('block-scalar')),
      JSON.stringify({ masked: review.redactions?.masked, fields: review.redactions?.fields, segments: review.redactions?.segments, items: review.redactions?.items }),
    )
    check(
      'redactions.policies / token 是契约字面量（面板可据此说"这里没有原文"）',
      review.redactions?.policies?.masked === SENSITIVE_MASK_NOTE &&
        review.redactions?.policies?.omitted === SENSITIVE_OMIT_NOTE &&
        review.redactions?.token === '<REDACTED len=…>',
      JSON.stringify(review.redactions?.policies),
    )

    // ── R21-SENS-02（gate-runner 独立探针发现）：URI 内嵌凭据必须段级遮蔽 ──────────
    const endpointRow = review.files.find((row) => row.path.includes('endpoints.env')) ?? null
    const endpointDiff = (endpointRow?.diff ?? []).map((line) => String(line.text ?? '')).join('\n')
    check('URI 内嵌凭据：endpoints.env 也被判成 sensitive/risk（同一条自定义规则）', endpointRow?.risk === 'sensitive' && endpointRow?.safety === 'risk' && endpointRow?.contentMasked === true, JSON.stringify({ risk: endpointRow?.risk, safety: endpointRow?.safety, contentMasked: endpointRow?.contentMasked }))
    check(
      'R21-SENS-02（红→绿）：URI 内嵌凭据明文不得进 review.json（userinfo 密码 / query token / :_authToken 段）',
      ![MARK.uriToken, MARK.uriPassword, MARK.uriRegistry].some((marker) => reviewText.includes(marker)),
      JSON.stringify([MARK.uriToken, MARK.uriPassword, MARK.uriRegistry].filter((marker) => reviewText.includes(marker))),
    )
    check(
      'URI 内嵌凭据：**段级**遮蔽且保留 URL 结构（host/path/参数名仍可读）',
      endpointDiff.includes('webhook=https://hooks.example/x?access_token=<REDACTED len=') &&
        endpointDiff.includes('url=https://user:<REDACTED len=') &&
        endpointDiff.includes('@host.example/path') &&
        endpointDiff.includes('registry=https://registry.ind/:_authToken=<REDACTED len='),
      JSON.stringify(endpointDiff.split('\n')),
    )
    check(
      'URI 内嵌凭据：redactions 段机读理由含 uri-credential（不静默）',
      (review.redactions?.items ?? []).some((item) => item.path.includes('endpoints.env') && item.reason === 'masked' && item.maskReasons.includes('uri-credential')),
      JSON.stringify((review.redactions?.items ?? []).find((item) => item.path.includes('endpoints.env'))),
    )

    // 内置遮蔽类（danger）：整份省略，**不经过** sensitive-content
    const builtinRows = review.files.filter((row) => ['.dsh\\.credentials.yaml', '.npmrc', 'cordis.patch.yml'].some((needle) => String(row.path).includes(needle)))
    check('内置遮蔽类：三行都判成 sensitive/danger', builtinRows.length === 3 && builtinRows.every((row) => row.risk === 'sensitive' && row.safety === 'danger'), JSON.stringify(builtinRows.map((row) => ({ path: row.path, safety: row.safety }))))
    check(
      '内置遮蔽类：内容整份省略（diff=[] + omit note），不是值级 <REDACTED>',
      builtinRows.every((row) => Array.isArray(row.diff) && row.diff.length === 0 && row.note === SENSITIVE_OMIT_NOTE),
      JSON.stringify(builtinRows.map((row) => ({ path: row.path, diff: row.diff?.length, note: row.note }))),
    )
    check(
      '内置遮蔽类：review.json 里没有其明文（凭据/npmrc/profile 三个 marker 全 0 命中）',
      !reviewText.includes(MARK.builtinCredential) && !reviewText.includes(MARK.builtinNpmrc) && !reviewText.includes(MARK.profileKey),
      JSON.stringify([MARK.builtinCredential, MARK.builtinNpmrc, MARK.profileKey].filter((marker) => reviewText.includes(marker))),
    )

    // 阳性对照：非遮蔽路径的正文**不做**值级掩码（路径黑名单式设计）⇒ 明文可见
    const plainRow = review.files.find((row) => row.path === 'notes.txt') ?? null
    check(
      '阳性对照：普通文件正文里的 marker **确实出现在** review.json（证明"明文不出现"断言能红；设计边界见 RESIDUAL）',
      plainRow !== null && plainRow.risk === 'normal' && reviewText.includes(MARK.plain),
      JSON.stringify({ risk: plainRow?.risk, markerPresent: reviewText.includes(MARK.plain) }),
    )

    // 候选 diff（candidates/*.json）：内容寻址，只有哈希/字节数 —— 掩码不参与哈希
    const candidateFiles = readdirSync(join(storeDir, 'candidates'))
    const candidateText = candidateFiles.map((name) => readFileSync(join(storeDir, 'candidates', name), 'utf8')).join('\n')
    check('候选 diff：candidates/*.json 里没有任何明文 marker', ![MARK.customApiKey, MARK.blockBodyA, MARK.builtinCredential, MARK.plain, MARK.uriToken, MARK.uriPassword, MARK.uriRegistry].some((marker) => candidateText.includes(marker)), JSON.stringify(candidateFiles))
    const customChange = (() => {
      for (const name of candidateFiles) {
        const parsed = JSON.parse(readFileSync(join(storeDir, 'candidates', name), 'utf8'))
        const found = (parsed.changes ?? []).find((change) => change.path.includes('app.secrets'))
        if (found) return found
      }
      return undefined
    })()
    check(
      '掩码只影响展示：候选 after.hash 仍等于**真实内容**的 sha256（哈希语义不变）',
      customChange?.after?.hash === sha256(CUSTOM_CONTENT) && customChange?.after?.bytes === Buffer.byteLength(CUSTOM_CONTENT, 'utf8'),
      JSON.stringify({ expected: sha256(CUSTOM_CONTENT), actual: customChange?.after?.hash, bytes: customChange?.after?.bytes }),
    )

    // 面板 payload：已发布快照的宿主侧路由
    const panel = buildPanelPayload({
      pathname: PANEL_SNAPSHOT_PATH,
      query: new URLSearchParams(`session=${sessionId}`),
      workspaceRoot: wsRoot,
      env: { WINSTAGE_STAGE_ROOT: storeDir },
      isEnabled: () => true,
    })
    const panelText = JSON.stringify(panel.body)
    check('面板链路：200 + 已发布快照（宿主侧解析存储根）', panel.status === 200 && panel.body?.ok === true && panel.body?.snapshot !== undefined, `status=${panel.status}`)
    check('面板链路：payload 与 review.json 是同一份快照（宿主路由不二次加工）', JSON.stringify(panel.body?.snapshot) === JSON.stringify(review), 'deep equal')
    check(
      '面板链路：明文不出现、<REDACTED…> 出现（自定义 mask 行 + URI 内嵌凭据行）',
      ![MARK.customApiKey, MARK.customPassword, MARK.blockBodyA, MARK.blockBodyB, MARK.uriToken, MARK.uriPassword, MARK.uriRegistry].some((marker) => panelText.includes(marker)) &&
        panelText.includes('<REDACTED len='),
      JSON.stringify({ apiKey: panelText.includes(MARK.customApiKey), bodyA: panelText.includes(MARK.blockBodyA), uriToken: panelText.includes(MARK.uriToken) }),
    )
    check(
      '面板链路：内置遮蔽类条目在 payload 里仍无内容（diff=[] + omit note）',
      (panel.body?.snapshot?.files ?? []).filter((row) => row.safety === 'danger').every((row) => row.diff?.length === 0 && row.note === SENSITIVE_OMIT_NOTE) &&
        !panelText.includes(MARK.builtinCredential) &&
        !panelText.includes(MARK.profileKey),
      'danger 行 diff 全空',
    )

    // 审计 JSON（Method A）：只有路径/计数，没有内容 ⇒ 不经过 sensitive-content，也不做路径脱敏
    const auditText = JSON.stringify(review.audit)
    check('审计链路：review.audit 段存在且是 bounded 形状（summary + 每类 ≤50 行）', review.audit?.summary !== undefined && typeof review.audit?.note === 'string' && review.audit.note.includes('bounded'), JSON.stringify({ keys: Object.keys(review.audit ?? {}), note: review.audit?.note }))
    check(
      '审计链路：审计载荷里没有文件内容 / 命令行文本（两类 marker 都不出现）',
      ![MARK.customApiKey, MARK.customPassword, MARK.builtinCredential, MARK.plain, MARK.command, MARK.uriToken, MARK.uriPassword].some((marker) => auditText.includes(marker)),
      JSON.stringify([MARK.plain, MARK.command].filter((marker) => auditText.includes(marker))),
    )
    check(
      '审计链路：只有路径字段（被遮蔽路径也照常出现 ⇒ 证明审计不做路径脱敏、也不承载内容）',
      auditText.includes('.npmrc') && !auditText.includes('"text"') && !auditText.includes('"content"') && !auditText.includes('"command"'),
      JSON.stringify({ hasNpmrc: auditText.includes('.npmrc'), rows: review.audit?.files?.read?.length }),
    )
    check(
      '日志链路：真实运行日志（宿主 log/logger + fs 日志）非空，且**不含任何内容明文**',
      sink.text().length + stageSink.text().length > 0 &&
        ![MARK.customApiKey, MARK.customPassword, MARK.blockBodyA, MARK.builtinCredential, MARK.plain, MARK.uriToken, MARK.uriPassword].some((marker) => `${sink.text()}\n${stageSink.text()}`.includes(marker)),
      JSON.stringify({ hostLogs: sink.entries.length, fsLogs: stageSink.entries.length }),
    )
    const combinedLogText = `${sink.text()}\n${stageSink.text()}`
    check(
      '日志链路：日志里**保留**被遮蔽路径（路径不是秘密，不做过度的日志脱敏）',
      combinedLogText.includes('.npmrc') || combinedLogText.includes('.dsh'),
      JSON.stringify(combinedLogText.slice(-200)),
    )
    check(
      '读侧可见性：review.json.readVisibility 段来自真实 StagingFileSystem 的读（record 档）',
      review.readVisibility?.policy === 'record' && review.readVisibility?.objects >= 1,
      JSON.stringify({ policy: review.readVisibility?.policy, objects: review.readVisibility?.objects }),
    )
    check(
      '读侧可见性：该段也没有明文（只带 maskId/路径/计数）',
      !JSON.stringify(review.readVisibility).includes(MARK.builtinNpmrc) && !JSON.stringify(review.readVisibility).includes(MARK.plain),
      '无 marker',
    )

    // 面板里也带上审计预览：同样无内容
    check('面板链路：audit 预览同样无内容明文（与 review.json 同源）', !JSON.stringify(panel.body?.snapshot?.audit ?? {}).includes(MARK.plain) && JSON.stringify(panel.body?.snapshot?.audit ?? {}).includes('.npmrc'), 'audit paths only')
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. 生产默认装配（不注入任何 mask）：内置凭据必须整份省略
  // ═════════════════════════════════════════════════════════════════════════
  section('2. 生产默认装配链路（无自定义 mask）：内置凭据整份省略、面板无明文')
  {
    const wsRoot = join(SCRATCH, 'ws-default')
    const storeDir = join(SCRATCH, 'store-default')
    const sessionId = 'r21-g4b-default'
    mkdirSync(wsRoot, { recursive: true })
    const { svc } = makeService({ wsRoot, storeDir, sessionId })
    for (const [rel, content] of Object.entries(BUILTIN_FILES)) svc.workspace.writeFile(join(wsRoot, ...rel.split('/')), content, { origin: 'test' })
    svc.workspace.writeFile(join(wsRoot, 'notes.txt'), 'plain-default-line\n', { origin: 'test' })
    svc.workspace.freezeCandidate({ source: 'test' })
    svc.publish()
    const reviewText = readFileSync(join(storeDir, 'review.json'), 'utf8')
    const review = JSON.parse(reviewText)
    check(
      '生产默认装配：凭据明文不落 review.json（R17-P0-02 的修复保持有效；不依赖任何注入）',
      ![MARK.builtinCredential, MARK.builtinNpmrc, MARK.profileKey].some((marker) => reviewText.includes(marker)),
      JSON.stringify([MARK.builtinCredential, MARK.builtinNpmrc, MARK.profileKey].filter((marker) => reviewText.includes(marker))),
    )
    check(
      '生产默认装配：三条内置条目全部 diff=[] + omit note（不是值级掩码）',
      (review.files ?? []).filter((row) => row.safety === 'danger').length === 3 &&
        (review.files ?? []).filter((row) => row.safety === 'danger').every((row) => row.diff?.length === 0 && row.note === SENSITIVE_OMIT_NOTE),
      JSON.stringify((review.files ?? []).map((row) => ({ path: row.path, safety: row.safety, diff: row.diff?.length }))),
    )
    check(
      '生产默认装配：没有自定义 mask ⇒ 没有任何 contentMasked 条目（值级档不可达，如实反映当前装配）',
      (review.files ?? []).every((row) => row.contentMasked !== true),
      JSON.stringify((review.files ?? []).map((row) => row.contentMasked ?? null)),
    )
    const panel = buildPanelPayload({
      pathname: PANEL_SNAPSHOT_PATH,
      query: new URLSearchParams(`session=${sessionId}`),
      workspaceRoot: wsRoot,
      env: { WINSTAGE_STAGE_ROOT: storeDir },
      isEnabled: () => true,
    })
    const panelText = JSON.stringify(panel.body)
    check(
      '生产默认装配：面板 payload 同样无明文（危险行只有 note，没有内容）',
      panel.status === 200 && ![MARK.builtinCredential, MARK.builtinNpmrc, MARK.profileKey].some((marker) => panelText.includes(marker)),
      `status=${panel.status}`,
    )
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. 误报对照（纯函数）：路径/URI/邮箱/短标量/普通句子不得被过度脱敏
  // ═════════════════════════════════════════════════════════════════════════
  section('3. 误报对照：普通路径/URI/短标量/句子不得被过度脱敏')
  {
    const MUST_KEEP = [
      ['path: C:\\Users\\someone\\Desktop\\project\\file.txt', 'Windows 绝对路径不是秘密'],
      ['unc: \\\\server\\share\\folder\\file.txt', 'UNC 路径不是秘密'],
      ['rel: packages/win/src/workspace.ts', '相对路径不是秘密'],
      ['url: https://example.com/a/b/c?x=1', 'URI 不是秘密'],
      ['email: someone@example.com', '邮箱不是秘密'],
      ['port: localhost:8080', 'host:port 不是秘密'],
      ['enabled: true', '短标量不是秘密'],
      ['name: normal-file-ok', '可读短串不是秘密'],
      ['note: the quick brown fox jumps over the lazy dog', '普通句子（字符多样性足够）不是秘密'],
      ['mode: production', '普通枚举值不是秘密'],
    ]
    const overMasked = MUST_KEEP.filter(([line]) => maskSensitiveLine(line).masked !== false).map(([line]) => line)
    check(
      `误报对照：${MUST_KEEP.length} 类普通输入不得被脱敏`,
      overMasked.length === 0,
      overMasked.length ? `被误遮: ${overMasked.join(' | ')}` : '全部未命中（掩码没有退化成"看不见改了什么"）',
    )
    // 设计口径（如实登记，不作为失败）：无分隔符的**长**普通串走 fail-closed 一侧
    const conservative = [
      ['slug: content-location-header-value-for-proxy-caching', '47 字符 kebab-case 普通串'],
      ['hex: 3f786850e387550fdab836ed7e6dc881de23001b', '40 字符 git hash'],
    ]
    const overMaskedConservative = conservative.filter(([line]) => maskSensitiveLine(line).masked === true)
    residual(
      `保守误报（设计口径，R17 已知取舍：未知形状按秘密处理）：${overMaskedConservative.length}/${conservative.length} 类普通长串会被遮蔽 ` +
        `(${overMaskedConservative.map(([line]) => line.split(':')[0]).join(', ')})。这不是本轮缺陷，登记为残余口径。`,
    )
    check(
      '误报对照的判定力：同一函数对**真凭据**必须遮（否则上面的"不遮"没有意义）',
      maskSensitiveLine(`api_key: ${MARK.customApiKey}`).masked === true &&
        maskSensitiveLine(`token: |`).masked === true &&
        maskSensitiveLine(`  ${MARK.blockBodyA}`).masked === false, // 短正文单行判据本身遮不住 ⇒ 正是跨行状态机存在的原因
      '真凭据被遮 / 短块标量正文单行不可判（根因自证）',
    )

    // ── R21-SENS-02：gate-runner 独立探针的四条 URI 复现 + 两条已绿对照 ────────────
    // 形态来自 `.lead/logs/gate-runner-r21/g4-independent-findings.md`（C5）：
    // URI 以 `scheme://` 开头 ≠ "位置" —— 里面嵌的 userinfo 密码 / query token /
    // `:_authToken=` 段仍是凭据，`isLocationLike()/isPathForm()` 的整值豁免必须让位于它。
    const URI_MUST_MASK = [
      ['url-userinfo', `url=https://user:${MARK.uriPassword}Long@host.example/path`, `${MARK.uriPassword}Long`],
      ['webhook-query-token', `webhook=https://hooks.example/x?access_token=${MARK.uriToken}`, MARK.uriToken],
      ['registry-uri-authToken', `registry=https://registry.ind/:_authToken=${MARK.uriRegistry}`, MARK.uriRegistry],
      ['proxy-userinfo', `proxy=http://user:${MARK.uriPassword}Long@proxy:8080`, `${MARK.uriPassword}Long`],
    ]
    const uriMisses = URI_MUST_MASK.filter(([, line, secret]) => {
      const result = maskSensitiveLine(line)
      return result.masked !== true || result.text.includes(secret)
    }).map(([id]) => id)
    check(
      `URI 内嵌凭据：gate-runner 的 ${URI_MUST_MASK.length} 条复现全部段级遮蔽（userinfo 密码 / query token / :_authToken）`,
      uriMisses.length === 0,
      uriMisses.length ? `未遮: ${uriMisses.join(', ')}` : URI_MUST_MASK.map(([, line]) => maskSensitiveLine(line).text).join(' | '),
    )
    check(
      'URI 内嵌凭据：保留 URL 结构（scheme/host/path/参数名仍可读，只遮凭据段）',
      maskSensitiveLine(URI_MUST_MASK[0][1]).text.includes('url=https://user:<REDACTED len=') &&
        maskSensitiveLine(URI_MUST_MASK[0][1]).text.includes('@host.example/path') &&
        maskSensitiveLine(URI_MUST_MASK[1][1]).text.includes('webhook=https://hooks.example/x?access_token=<REDACTED len=') &&
        maskSensitiveLine(URI_MUST_MASK[2][1]).text.includes('registry=https://registry.ind/:_authToken=<REDACTED len='),
      URI_MUST_MASK.map(([, line]) => maskSensitiveLine(line).text).join(' | '),
    )
    // 已绿对照（修复前就必须保持）：npmrc 标准形态 / 普通路径 / 无凭据普通 URL
    const URI_KEEP = [
      ['npmrc 标准形态（bare token 判据已遮，但**值**不得残留）', `//registry.ind/:_authToken=${MARK.uriRegistry}`, 'secret'],
      ['普通 Windows 路径', 'path: C:\\Users\\someone\\Desktop\\project\\file.txt', 'unchanged'],
      ['普通 URL（query 无凭据键）', 'url: https://example.com/a/b/c?x=1&page=2', 'unchanged'],
      ['URL 只带 host:port', 'endpoint: http://localhost:8080/v1/health', 'unchanged'],
    ]
    const keepProblems = URI_KEEP.filter(([, line, mode]) => {
      const result = maskSensitiveLine(line)
      return mode === 'unchanged' ? result.masked !== false : result.text.includes(MARK.uriRegistry)
    }).map(([id]) => id)
    check(
      `URI 误报对照：${URI_KEEP.length} 条（npmrc 已绿形态 + 普通路径/URL）保持正确`,
      keepProblems.length === 0,
      keepProblems.length ? `问题: ${keepProblems.join(', ')}` : URI_KEEP.map(([, line]) => maskSensitiveLine(line).text).join(' | '),
    )
    residual('URI 判据口径（R21-SENS-02）：只对**含凭据**的 URI 做段级遮蔽 —— userinfo 的 `user:<pass>@`（遮密码）、'
      + 'userinfo 是 token 形状（整段遮）、query/fragment 键名命中 `isCredentialKey()` 或 AWS/SAS 签名参数（遮值）、'
      + '`: _authToken=`/`:_auth=`/`:_password=` 段（遮值）；其余 URL（含普通 query）逐字保持原样。')
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. 生产接线（R21-SENS-R1 已由 R24-A2 修复；这里钉住接线点仍存在）
  // ═════════════════════════════════════════════════════════════════════════
  section('4. 生产接线（R24-A2：host config.masks → Workspace.masks 透传已接线）')
  {
    const wsRoot = join(SCRATCH, 'ws-probe')
    mkdirSync(wsRoot, { recursive: true })
    const probe = makeService({ wsRoot, storeDir: join(SCRATCH, 'store-probe'), sessionId: 'r21-g4b-probe', masks: [CUSTOM_RULE] })
    check(
      '（R24-A2 接线）给 ReviewService 传 options.masks ⇒ 透传到 Workspace.extraMasks',
      probe.svc.workspace.extraMasks.length === 1 && probe.svc.workspace.extraMasks[0].id === CUSTOM_RULE.id,
      `extraMasks=${JSON.stringify(probe.svc.workspace.extraMasks.map((rule) => rule.id))}`,
    )
    const sourceTexts = {
      review: readFileSync(join(PKG, 'dsh-plugin', 'review-service.ts'), 'utf8'),
      host: readFileSync(join(PKG, 'dsh-plugin', 'host-plugin.ts'), 'utf8'),
      config: readFileSync(join(PKG, 'plugin', 'config.ts'), 'utf8'),
    }
    check(
      '（R24-A2 接线为机器可读断言）review-service 构造 Workspace 时传 masks；host-plugin 有 compileConfiguredMasks + masks 透传；config schema 声明 masks: string[]',
      /new Workspace\(/.test(sourceTexts.review) &&
        /masks:\s*options\.masks/.test(sourceTexts.review) &&
        /compileConfiguredMasks/.test(sourceTexts.host) &&
        /masks:\s*configuredMasks/.test(sourceTexts.host) &&
        /masks:\s*z\s*\.array\(z\.string\(\)\)/.test(sourceTexts.config),
      JSON.stringify({
        reviewMasks: /masks:\s*options\.masks/.test(sourceTexts.review),
        compile: /compileConfiguredMasks/.test(sourceTexts.host),
        hostPass: /masks:\s*configuredMasks/.test(sourceTexts.host),
        schema: /masks:\s*z\s*\.array\(z\.string\(\)\)/.test(sourceTexts.config),
      }),
    )
    residual('R21-SENS-R1 已由 R24-A2 修复：host 行 config 新增 `masks: string[]`（默认 []），apply 期编译 + 非法正则 fail-closed，经 ReviewService 透传到 Workspace；默认空行为不变（内置危险类仍整份省略）。')
    residual('R21-FS-R1 已由 R24-A1 修复：`WINSTAGE_READ_POLICY` 显式通道（未设=record；block=block；其它非空=fail-safe block + warn）。')
    residual('命令文本（shell 命令行/环境变量）不经过 sensitive-content，也不进 review.json / sandbox-audit.json；命令的 stdout/stderr 由 shell-executor 逐字节原样交给模型（设计），不在本套件脱敏链路内。')
    residual('非遮蔽路径的正文不做值级掩码（路径黑名单式设计）：普通文件里的凭据会出现在 review.json（本套件用阳性对照钉住该事实）。')
    void probe
  }
} finally {
  if (savedStageRoot === undefined) delete process.env.WINSTAGE_STAGE_ROOT
  else process.env.WINSTAGE_STAGE_ROOT = savedStageRoot
}

if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
process.stdout.write(
  `\n${'='.repeat(72)}\n` +
    `R21 G4b sensitive-content 端到端脱敏：断言 ${assertions} 项，失败 ${failures} 项\n` +
    `RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=normal\n` +
    `${'='.repeat(72)}\n`,
)
process.exit(failures === 0 ? 0 : 1)
