/**
 * R41-UX · 外壳启动噪声过滤（run-capture 捕获面 + shell 候选/审计面）。
 *
 * ── 它钉住的是什么 ────────────────────────────────────────────────────────────
 * 真机 E2E 实测：PowerShell 每次启动会写 `StartupProfileData-*`（PS 性能缓存）与
 * `%TEMP%\dsh-stage-temp\<id>\__PSScriptPolicyTest_*`（AppLocker 探针）。它们经 shim 落进
 * 暂存树、被 `captureAfterExecution()` 反解成**工作区外**候选条目，还进 `sandbox-audit.json`
 * 的写计数 ⇒ 一次命令给面板塞 6 条"用户没干过"的待审项。
 *
 * 本套件用**假 Store/Workspace + 假 changes/paths** 验证（不需要沙箱、不起子进程）：
 *   1. 判据窄到只认"文件名 + 固定目录"的合取；
 *   2. 默认捕获面/候选面/审计面都不再出现这些条目；
 *   3. **用户内容照样保留**（`%TEMP%` 自有文件、`dsh-stage-temp` 下的用户文件、近似路径）；
 *   4. 过滤不静默：`skipped.reason = shell-internal-artifact`、`noiseFiltered` 计数可机读；
 *   5. 逃生口 `WINSTAGE_CAPTURE_NOISE=0` 恢复旧行为（端到端排查用）。
 *
 * 为什么放在 `KNOWN_UNREGISTERED`：关口列表（`src/testrunner.ts` / `verify.cmd`）属于 Lead
 * 统一接线面，本轮不动；本文件已具备**登记即用**的形态（纯离线、无 spawn、退出码 0/1）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = '') {
  checks.push({ name, ok, detail })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : `\n      证据: ${detail}`}\n`)
}

const { sha256Buffer } = (await import('../src/store.ts')) as any
const runCaptureMod: any = await import('../dsh-plugin/run-capture.ts')
const { createRunCapture, isShellInternalArtifactPath, shellNoiseFilterEnabled, SHELL_INTERNAL_ARTIFACT_REASON } = runCaptureMod
const shellMod: any = await import('../dsh-plugin/shell-executor.ts')
const { createWinStageShellExecutor, partitionShellInternalArtifactChanges, dropShellInternalArtifactRows } = shellMod

const NOISE_PS_STARTUP = 'C:\\Users\\12075\\AppData\\Local\\Microsoft\\Windows\\PowerShell\\StartupProfileData-NonInteractive'
const NOISE_PS_STARTUP_INTERACTIVE = 'C:\\Users\\12075\\AppData\\Local\\Microsoft\\Windows\\PowerShell\\StartupProfileData-Interactive'
const NOISE_PS_POLICY = 'C:\\Users\\12075\\AppData\\Local\\Temp\\dsh-stage-temp\\7f3a9c21\\__PSScriptPolicyTest_k3j4h5.tmp.ps1'
const GENUINE_OUTSIDE = 'C:\\Users\\12075\\Documents\\report-final.txt'
const GENUINE_TEMP_USER_FILE = 'C:\\Users\\12075\\AppData\\Local\\Temp\\my-own-output.txt'
const GENUINE_STAGE_TEMP_CONTENT = 'C:\\Users\\12075\\AppData\\Local\\Temp\\dsh-stage-temp\\7f3a9c21\\notes-for-user.txt'
const NEAR_PS_DIR_OTHER = 'C:\\Users\\12075\\Documents\\PowerShell\\StartupProfileData-NonInteractive'
const NEAR_POLICY_NO_STAGE_TEMP = 'C:\\Users\\12075\\AppData\\Local\\Temp\\__PSScriptPolicyTest_k3j4h5.tmp.ps1'

const scratch = join(import.meta.dirname ?? process.cwd(), 'work-test')
mkdirSync(scratch, { recursive: true })

const makeStore = (dir: string) => ({
  dir,
  putBlob: (buffer: Buffer) => sha256Buffer(buffer),
  materializeBlob: () => {},
  stagedPath: (key: string) => join(dir, 'staged', key.replace(/[:\\/]/g, '_')),
})
const makeWorkspace = (root: string) => ({
  root,
  writeFile: () => {},
  diffEntries: () => [],
  keyOf: (abs: string) => ({ key: abs.toLowerCase().startsWith(root.toLowerCase()) ? abs.slice(root.length).replace(/^[\\/]/, '') : abs }),
  absolute: (p: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(String(p)) ? String(p) : join(root, String(p))),
  entryOf: () => undefined,
  init: () => {},
})

process.stdout.write('='.repeat(72) + '\nR41 UX · 外壳启动噪声过滤\n' + '='.repeat(72) + '\n')
process.stdout.write('\n[1] 判据矩阵：只认"文件名 + 固定目录"的合取\n')
{
  check('isShellInternalArtifactPath 已导出（唯一判据来源）', typeof isShellInternalArtifactPath === 'function')
  const rows: Array<[string, boolean]> = [
    [NOISE_PS_STARTUP, true],
    [NOISE_PS_STARTUP_INTERACTIVE, true],
    [NOISE_PS_POLICY, true],
    [GENUINE_OUTSIDE, false],
    [GENUINE_TEMP_USER_FILE, false],
    [GENUINE_STAGE_TEMP_CONTENT, false],
    [NEAR_PS_DIR_OTHER, false],
    [NEAR_POLICY_NO_STAGE_TEMP, false],
    ['notes.txt', false],
    ['', false],
  ]
  for (const [path, expected] of rows) {
    check(`判据 ${expected ? '命中' : '不命中'}: ${path.length > 60 ? `${path.slice(0, 30)}…${path.slice(-24)}` : path || '(空)'}`, isShellInternalArtifactPath(path) === expected)
  }
  check('判据不把"工作区外"当噪声（真实外部写入保留）', isShellInternalArtifactPath(GENUINE_OUTSIDE) === false)
}

process.stdout.write('\n[2] run-capture 捕获面：默认不纳入噪声，但记录 skip 理由\n')
{
  const base = mkdtempSync(join(scratch, 'capture-'))
  try {
    const root = join(base, 'localappdata')
    const psDir = join(root, 'Microsoft', 'Windows', 'PowerShell')
    const stageTempDir = join(root, 'Temp', 'dsh-stage-temp', '7f3a9c21')
    mkdirSync(psDir, { recursive: true })
    mkdirSync(stageTempDir, { recursive: true })
    mkdirSync(join(root, 'Documents'), { recursive: true })
    writeFileSync(join(psDir, 'StartupProfileData-NonInteractive'), 'ps-cache')
    writeFileSync(join(psDir, 'StartupProfileData-Interactive'), 'ps-cache-2')
    writeFileSync(join(stageTempDir, '__PSScriptPolicyTest_k3j4h5.tmp.ps1'), 'policy-probe')
    writeFileSync(join(stageTempDir, 'notes-for-user.txt'), 'user content in stage temp')
    writeFileSync(join(root, 'Documents', 'report-final.txt'), 'genuine user file')
    const storeDir = join(base, 'store')
    mkdirSync(storeDir, { recursive: true })
    const run = async (noiseFilter?: boolean) => {
      const cap = createRunCapture({
        workspaceRoot: root,
        store: makeStore(storeDir),
        workspace: makeWorkspace(root),
        roots: [root],
        ...(noiseFilter === undefined ? {} : { noiseFilter }),
      })
      return cap.prime()
    }
    const filtered = await run()
    const disabled = await run(false)
    check('默认捕获 2 个文件（3 条噪声被摘掉，2 条真实内容保留）', filtered.files === 2, `files=${filtered.files}`)
    const noiseSkips = (filtered.skipped ?? []).filter((s: any) => s.reason === SHELL_INTERNAL_ARTIFACT_REASON)
    check('3 条噪声各留一条 skip（reason=shell-internal-artifact，不静默）', noiseSkips.length === 3, JSON.stringify(noiseSkips.map((s: any) => s.path.split(/[\\/]/).pop())))
    const capturedNames = [...(filtered.before?.keys?.() ?? [])].map((p: string) => String(p).split(/[\\/]/).pop())
    check('用户内容仍在捕获面：notes-for-user.txt / report-final.txt', capturedNames.includes('notes-for-user.txt') && capturedNames.includes('report-final.txt'), JSON.stringify(capturedNames))
    check('逃生口 noiseFilter:false ⇒ 5 个文件（旧行为可复现）', disabled.files === 5, `files=${disabled.files}`)
    check('noiseFilter 生效状态可从实例读出', createRunCapture({ workspaceRoot: root, store: makeStore(storeDir), workspace: makeWorkspace(root), roots: [root] }).noiseFilter === true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

process.stdout.write('\n[3] shell 候选面：噪声不进 ingest / 候选\n')
{
  const base = mkdtempSync(join(scratch, 'cand-'))
  try {
    const wsRoot = join(base, 'ws')
    const storeDir = join(base, 'store')
    mkdirSync(wsRoot, { recursive: true })
    mkdirSync(storeDir, { recursive: true })
    const Cls = createWinStageShellExecutor({ base: class {} })
    const inst: any = new Cls({}, {})
    const makeFakeWorkspace = () => {
      const ingested: any[] = []
      const ws: any = {
        ...makeWorkspace(wsRoot),
        captureAfterExecution: () => [
          { path: 'notes.txt', hash: 'h1', previous: 'absent', created: true },
          { path: NOISE_PS_STARTUP, hash: 'h2', previous: 'absent', created: true },
          { path: NOISE_PS_POLICY, hash: 'h3', previous: 'absent', created: true },
          { path: NOISE_PS_STARTUP, hash: 'absent', previous: 'h4', deleted: true },
        ],
        ingestCapturedChanges: (list: any[]) => { ingested.push(...list); return { ingested: list.length, deletions: 0, skipped: [] } },
        freezeIfNeeded: () => ({ frozen: false, reason: 'no-representation' }),
      }
      return { ws, ingested }
    }
    const first = makeFakeWorkspace()
    const report = inst.captureStagedChanges(first.ws, new Map(), () => {})
    check('捕获 4 条（含 1 条噪声删除）但只 ingest 1 条真实改动', first.ingested.length === 1 && first.ingested[0].path === 'notes.txt', JSON.stringify(first.ingested.map((c) => c.path)))
    check('report.noiseFiltered = 3 且 captured 仍如实报 4（原始读数不篡改）', report.noiseFiltered === 3 && report.captured === 4, JSON.stringify({ noiseFiltered: report.noiseFiltered, captured: report.captured }))
    check('没有任何噪声路径出现在 ingest 清单', !first.ingested.some((c) => isShellInternalArtifactPath(c.path)))

    const previous = process.env.WINSTAGE_CAPTURE_NOISE
    process.env.WINSTAGE_CAPTURE_NOISE = '0'
    try {
      check('shellNoiseFilterEnabled() 识别逃生口', shellNoiseFilterEnabled() === false)
      const second = makeFakeWorkspace()
      const disabledReport = inst.captureStagedChanges(second.ws, new Map(), () => {})
      check('WINSTAGE_CAPTURE_NOISE=0 ⇒ 旧行为（4 条全部 ingest、noiseFiltered=0）', second.ingested.length === 4 && disabledReport.noiseFiltered === 0, JSON.stringify({ ingested: second.ingested.length, noiseFiltered: disabledReport.noiseFiltered }))
    } finally {
      if (previous === undefined) delete process.env.WINSTAGE_CAPTURE_NOISE
      else process.env.WINSTAGE_CAPTURE_NOISE = previous
    }

    // 纯函数：partition 的 toAbsolute 映射（真实 Workspace 的 key 可能是相对路径）
    const partitioned = partitionShellInternalArtifactChanges(
      [{ path: 'Temp\\dsh-stage-temp\\id\\__PSScriptPolicyTest_x.ps1' }, { path: 'src/a.txt' }],
      (rel: string) => join('C:\\Users\\u\\AppData\\Local', rel),
    )
    check('partition 用 toAbsolute 映射后仍能认出噪声', partitioned.dropped.length === 1 && partitioned.kept.length === 1, JSON.stringify(partitioned.dropped))
    const threw = partitionShellInternalArtifactChanges([{ path: 'src/a.txt' }], () => { throw new Error('boom') })
    check('toAbsolute 抛错时不误杀（保持可见）', threw.kept.length === 1 && threw.dropped.length === 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

process.stdout.write('\n[4] 审计面：计数重算 + 真实写入保留\n')
{
  const base = mkdtempSync(join(scratch, 'audit-'))
  try {
    const wsRoot = join(base, 'ws')
    const storeDir = join(base, 'store')
    mkdirSync(wsRoot, { recursive: true })
    mkdirSync(storeDir, { recursive: true })
    const auditPath = join(base, 'audit.jsonl')
    const line = (op: string, path: string, mode?: string) => `[winstage-audit][1][1] ${JSON.stringify({ op, ...(mode ? { mode } : {}), path })}`
    const moveLine = `[winstage-audit][1][1] ${JSON.stringify({ op: 'file.move', from: NOISE_PS_POLICY, to: GENUINE_OUTSIDE })}`
    writeFileSync(auditPath, [
      line('file.open', NOISE_PS_STARTUP, 'write'),
      line('file.open', NOISE_PS_POLICY, 'write'),
      line('file.open', NOISE_PS_STARTUP, 'read'),
      moveLine,
      line('file.open', join(wsRoot, 'notes.txt'), 'write'),
      line('file.open', GENUINE_OUTSIDE, 'write'),
      line('file.open', GENUINE_OUTSIDE, 'read'),
    ].join('\n'))
    const Cls = createWinStageShellExecutor({ base: class {} })
    const inst: any = new Cls({}, {})
    const result = inst.captureAudit({ auditPath }, { root: wsRoot, store: { dir: storeDir } }, () => {})
    const report = JSON.parse(readFileSync(join(storeDir, 'sandbox-audit.json'), 'utf8'))
    const writtenNames = (report.files.written ?? []).map((r: any) => String(r.path).split(/[\\/]/).pop())
    const readNames = (report.files.read ?? []).map((r: any) => String(r.path).split(/[\\/]/).pop())
    check('审计 written 只剩真实写入（notes.txt + report-final.txt）', writtenNames.length === 2 && writtenNames.includes('notes.txt') && writtenNames.includes('report-final.txt'), JSON.stringify(writtenNames))
    check('审计 read 只剩真实读取（report-final.txt）', readNames.length === 1 && readNames[0] === 'report-final.txt', JSON.stringify(readNames))
    check('summary 与过滤后的行**同源重算**', report.summary.filesWritten === 2 && report.summary.filesRead === 1 && report.summary.filesWrittenInWorkspace === 1 && report.summary.filesWrittenOutside === 1, JSON.stringify(report.summary))
    check('审计产物标明 noiseFiltered=4（不静默少报）', report.noiseFiltered === 4 && result.noiseFiltered === 4, JSON.stringify({ product: report.noiseFiltered, returned: result.noiseFiltered }))
    check('审计文本明说"已忽略 N 条"（人工侧可见）', result.text.includes('已忽略 4'), result.text)

    // 纯函数：moved 行的两端都要判；registry 行不受影响
    const pure = dropShellInternalArtifactRows({
      files: { read: [], written: [{ path: GENUINE_OUTSIDE, count: 1, scope: 'outside' }, { path: NOISE_PS_STARTUP, count: 2, scope: 'outside' }], deleted: [], moved: [{ from: NOISE_PS_POLICY, to: 'C:\\Users\\12075\\Documents\\ok.txt', scope: 'workspace' }] },
      registry: { read: [{ path: 'HKCU\\Software\\X', count: 1 }], written: [] },
      summary: { filesRead: 0, filesWritten: 2, filesDeleted: 0, filesMoved: 1, filesWrittenInWorkspace: 0, filesWrittenOutside: 2, filesDeletedInWorkspace: 0 },
    })
    check('moved 行只要任一端是噪声就算丢弃（1 行）', pure.dropped === 2 && pure.report.files.moved.length === 0, JSON.stringify({ dropped: pure.dropped, moved: pure.report.files.moved }))
    check('注册表行不受文件噪声判据影响', pure.report.registry.read.length === 1)
    check('重算后的 summary 与行数一致', pure.report.summary.filesWritten === 1 && pure.report.summary.filesWrittenOutside === 1 && pure.report.summary.filesMoved === 0, JSON.stringify(pure.report.summary))

    const previous = process.env.WINSTAGE_CAPTURE_NOISE
    process.env.WINSTAGE_CAPTURE_NOISE = '0'
    try {
      const escaped = inst.captureAudit({ auditPath }, { root: wsRoot, store: { dir: storeDir } }, () => {})
      const escapedReport = JSON.parse(readFileSync(join(storeDir, 'sandbox-audit.json'), 'utf8'))
      check('逃生口 WINSTAGE_CAPTURE_NOISE=0 ⇒ 审计恢复旧计数（写到 4/读 2）', escapedReport.summary.filesWritten === 4 && escapedReport.summary.filesRead === 2 && escaped.noiseFiltered === 0, JSON.stringify(escapedReport.summary))
    } finally {
      if (previous === undefined) delete process.env.WINSTAGE_CAPTURE_NOISE
      else process.env.WINSTAGE_CAPTURE_NOISE = previous
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

process.stdout.write('\n[5] 反向证明：过滤不会掩盖用户意图\n')
{
  const visible = [GENUINE_OUTSIDE, GENUINE_TEMP_USER_FILE, GENUINE_STAGE_TEMP_CONTENT, NEAR_PS_DIR_OTHER, NEAR_POLICY_NO_STAGE_TEMP]
  check('5 条"看起来像噪声"的用户路径全部不被过滤', visible.every((p) => isShellInternalArtifactPath(p) === false))
  check('判据不按目录类别过滤（不能拿"在 Temp 下"当理由）', isShellInternalArtifactPath('C:\\Users\\12075\\AppData\\Local\\Temp\\anything.txt') === false)
  const source = readFileSync(join(import.meta.dirname ?? process.cwd(), '..', 'dsh-plugin', 'run-capture.ts'), 'utf8')
  check('判据注释里写明"为什么不能掩盖用户意图"', /为什么不会掩盖用户意图|不能掩盖用户意图/.test(source) || /为什么.*掩盖用户意图/.test(source))
}

const failed = checks.filter((c) => !c.ok).length
process.stdout.write(`\n${'='.repeat(72)}\nR41 UX 外壳启动噪声过滤：断言 ${checks.length} 项，失败 ${failed} 项\n`)
process.stdout.write(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} checks=${checks.length} failures=${failed}\n`)
process.exit(failed === 0 ? 0 : 1)
