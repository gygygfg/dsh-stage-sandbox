#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * dsh-stage — Windows 暂存—候选—选择性提交沙箱 CLI
 *
 * 使用方式（本机受限令牌会话下必须经 cmd 启动 node，见 run.cmd 说明）：
 *   run.cmd src\cli.ts init    --workspace <dir>
 *   run.cmd src\cli.ts status  --workspace <dir>
 *   run.cmd src\cli.ts exec    --workspace <dir> -- pwsh -c "ni new.txt"
 *   run.cmd src\cli.ts review  --workspace <dir>
 *   run.cmd src\cli.ts diff    --workspace <dir> [--candidate <id>]
 *   run.cmd src\cli.ts apply   --workspace <dir> [--candidate <id>] [--paths a,b]
 *   run.cmd src\cli.ts discard --workspace <dir> --candidate <id>
 *   run.cmd src\cli.ts probe   [--workspace <dir>]
 *   run.cmd src\cli.ts audit   --workspace <dir>
 *   run.cmd src\cli.ts gc      --workspace <dir> [--apply]
 *
 * 退出码：
 *   0 成功
 *   1 一般失败
 *   2 用法错误
 *   3 fail-closed 拒绝（SANDBOX_UNAVAILABLE / 能力不足）
 *   4 候选陈旧（STALE_BASELINE）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolveStageRoot } from './stage-guard.ts'
import { SandboxError, Workspace } from './workspace.ts'
import { ToolSurface, renderCandidateDiff } from './tools.ts'
import { COMMAND_RISK, WindowsStageExecutor, classifyCommandRisk } from './executor.ts'
import { formatReport, probe } from './capability.ts'
import { canonical, compareKey } from './paths.ts'

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, FAIL_CLOSED: 3, STALE: 4 }

const COMMAND_HELP = Object.freeze({
  init: '初始化暂存区（幂等），打印能力探测与实例检查',
  status: '显示暂存状态、待审计数、损坏项',
  probe: '仅运行能力探测（不创建暂存区）',
  exec: '在 Windows 受限令牌沙箱内执行命令，执行后提取变化',
  review: '列出待审候选（按文件数计）',
  diff: '展示候选 diff（before/after 均取自候选冻结内容）',
  apply: '选择性应用候选',
  discard: '丢弃候选（持久化状态，非删文件）',
  gc: '垃圾回收无引用 blob',
  audit: '从沙箱内部发起真实攻击探针并输出证据',
})

const USAGE = `dsh-stage — Windows 暂存—候选—选择性提交沙箱

命令：
${Object.entries(COMMAND_HELP)
  .map(([name, text]) => `  ${name.padEnd(8)} ${text}`)
  .join('\n')}

通用参数：
  --workspace <dir>   工作区根（默认当前目录；必须已存在）
  --json              机器可读输出
  --session <id>      会话标识（默认取自暂存清单）
  --help              打印帮助并退出（退出码 0；也可用 <命令> --help 看该命令的参数）
`

/** 每个子命令的真实参数（U16-5：帮助必须覆盖代码实际支持的开关，不能只给通用参数）。 */
const COMMAND_USAGE = Object.freeze({
  init: `用法: run.cmd src\\cli.ts init [--workspace <dir>] [--session <id>] [--use-cache] [--json]
  --use-cache         允许复用能力探测缓存
  （probe 的 --no-cache 同样适用：init 走的是同一条能力探测）`,
  status: `用法: run.cmd src\\cli.ts status [--workspace <dir>] [--session <id>] [--json]
  打印解析后的暂存存储根；--workspace 不存在或与该 store 的 manifest 不一致时 fail-fast（非 0 退出）`,
  probe: `用法: run.cmd src\\cli.ts probe [--workspace <dir>] [--no-cache] [--use-cache] [--json]
  --no-cache          禁用能力探测缓存
  --use-cache         允许复用能力探测缓存`,
  exec: `用法: run.cmd src\\cli.ts exec [--workspace <dir>] [--tier <T0|T1|T2|auto>] [--read-only] [--timeout <ms>] [--json] -- <命令...>
  --tier <tier>       指定执行档位；缺省由 selectTier() 依据真实 Win32 探测决定
  --read-only         **真正只读**：先判命令风险，写/判不出来直接拒绝（executed=false）；
                      只执行正向证明无副作用的命令，且执行后用一次性暂存根 ⇒ 不并入清单、不冻结候选
  --timeout <ms>      执行超时毫秒数
  命令与参数必须放在 -- 之后，例如: exec -- pwsh -c "ni a.txt"`,
  review: `用法: run.cmd src\\cli.ts review [--workspace <dir>] [--session <id>] [--json]`,
  diff: `用法: run.cmd src\\cli.ts diff [--workspace <dir>] [--candidate <id>] [--max-lines <n>] [--json]
  --candidate <id>    指定候选；缺省用最新一份待审候选
  --max-lines <n>     diff 最大行数（默认 40）`,
  apply: `用法: run.cmd src\\cli.ts apply [--workspace <dir>] [--candidate <id>] [--paths a,b,c] [--force] [--json]
  --candidate <id>    指定候选；缺省用最新一份待审候选
  --paths a,b,c       只应用这些工作区相对路径（选择性应用）
  --force             越过遮蔽确认（仍然 fail-closed 的项不会被越过）`,
  discard: `用法: run.cmd src\\cli.ts discard --candidate <id> [--reason <text>] [--workspace <dir>] [--json]
  --candidate <id>    要丢弃的候选 id（必填）
  --reason <text>     丢弃原因（写入持久化记录）`,
  gc: `用法: run.cmd src\\cli.ts gc [--apply] [--workspace <dir>] [--json]
  --apply             真的回收无引用 blob（缺省只报告，不删）`,
  audit: `用法: run.cmd src\\cli.ts audit [--workspace <dir>] [--json]`,
})

/** 帮助文本：`<命令> --help` 给该命令的真实参数，否则给全局用法。 */
export function usageFor(command) {
  const base = command && Object.prototype.hasOwnProperty.call(COMMAND_USAGE, command) ? `${command}: ${COMMAND_HELP[command]}\n\n${COMMAND_USAGE[command]}` : USAGE.trimEnd()
  return `${base}\n`
}

/**
 * ── R34-01：参数表的**唯一权威** ─────────────────────────────────────────────
 *
 * 旧 `parseArgv()` 有两个静默失效面，实测都会造成"用户以为选了一个路径/工作区，
 * 实际作用于别处（或全部）"：
 *   · `--paths --force`（缺值）把 `paths` 记成 `true` ⇒ `paths===undefined`
 *     ⇒ **把整份候选全部应用**；
 *   · `--paths=a.txt` / `--workspace=<dir>`（等号形式）根本不被识别 ⇒ 同样退回
 *     "全部 / 当前目录"，且没有任何提示。
 * 因此这里显式区分"必须取值"与"布尔"参数：缺值/空值/未知参数都进 `problems`，
 * 由 `main()` 统一按**用法错误（退出码 2）**拒绝，绝不退化成默认行为。
 */
const VALUE_FLAGS = new Set(['workspace', 'session', 'candidate', 'paths', 'max-lines', 'tier', 'timeout', 'reason'])
const BOOLEAN_FLAGS = new Set(['help', 'json', 'force', 'apply', 'use-cache', 'no-cache', 'read-only'])

function parseArgv(argv) {
  const positional = []
  const flags = {}
  const problems = []
  let passthrough
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      passthrough = argv.slice(i + 1)
      break
    }
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const name = eq >= 0 ? body.slice(0, eq) : body
      let value = eq >= 0 ? body.slice(eq + 1) : undefined
      if (BOOLEAN_FLAGS.has(name)) {
        if (value !== undefined) problems.push(`--${name} 是开关，不接受取值（收到 "${value}"）`)
        else flags[name] = true
        continue
      }
      if (!VALUE_FLAGS.has(name)) {
        problems.push(`未知参数 --${name}`)
        continue
      }
      if (value === undefined) {
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          problems.push(`参数 --${name} 需要一个值`)
          continue
        }
        value = next
        i += 1
      }
      if (value === '') problems.push(`参数 --${name} 的值不能为空`)
      else flags[name] = value
    } else {
      positional.push(token)
    }
  }
  return { positional, flags, passthrough, problems }
}

/** 只接受工作区相对路径列表的子命令（位置参数一律拒绝：`apply a.txt` 误批全部是实测缺陷）。 */
const NO_POSITIONAL_COMMANDS = new Set(['init', 'status', 'probe', 'review', 'diff', 'apply', 'discard', 'gc', 'audit'])

/** 用法错误统一出口：退出码 2（与文件头的退出码表一致），错误只写 stderr。 */
function usageError(problems, command) {
  process.stderr.write(`USAGE: ${problems.join('；')}\n\n${usageFor(command)}`)
  process.exit(EXIT.USAGE)
}

function out(value, flags) {
  if (flags.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

/**
 * U16-8：exec 文本模式必须给出"这次到底跑在哪一档"。
 * 档位来自 `executor.init()` 的 sandboxInit（`tierEffective`/`tier` + `launchMode`），
 * 与插件面 `sandbox-lane.json` 的 `tierEffective` 同源；此前只有 `--json` 里能看到。
 */
export function formatExecTierLine(sandboxInit) {
  const tier = sandboxInit?.tierEffective ?? sandboxInit?.tier
  if (!tier) return ''
  const mode = sandboxInit?.launchMode ? `(${sandboxInit.launchMode})` : ''
  return `档位=${tier}${mode}\n`
}

/**
 * ── R18-KNOWN-05a：`exec --read-only` 的**真正只读**语义 ─────────────────────────
 *
 * 旧行为（R17 实测）：`--read-only` 只把执行器 `mode` 设为 `'read-only'`，但
 * **仍然** materialize → run → captureAfterExecution → ingestCapturedChanges →
 * freezeIfNeeded ⇒ 沙箱内的写入照样进暂存树并**冻结出候选**，"只读"名不副实。
 *
 * 新语义（本函数是唯一判据入口，纯函数、离线可测）：
 *   1. 执行前用 `classifyCommandRisk()` 判这条命令：`write-capable`/`indeterminate`
 *      ⇒ **直接拒绝**（码 `READ_ONLY_COMMAND_REFUSED`，`executed:false`，不 spawn）；
 *   2. 只有**正向证明只读**的命令才执行；
 *   3. 执行使用**一次性 scratch 暂存根**（`mkdtemp`）：shim 若仍产生任何暂存副作用
 *      （写/白障/注册表 overlay），全部落在这本一次性根里，执行完整体删除 ⇒
 *      **不并入清单、不冻结候选、store 与真实盘都不变**。
 */
export const READ_ONLY_EXEC_REFUSED_CODE = 'READ_ONLY_COMMAND_REFUSED'

export function readOnlyExecVerdict(command, args = []) {
  const risk = classifyCommandRisk(command, Array.isArray(args) ? args : [])
  return {
    allowed: risk.risk === COMMAND_RISK.READ_ONLY,
    risk: risk.risk,
    reasons: Array.isArray(risk.reasons) ? risk.reasons : [],
  }
}

/**
 * `--read-only` 的**一次性暂存根**（纯路径逻辑，便于离线断言）。
 * 返回 `{stagingRoot, registryStageDir}`：两者都在同一临时目录下，随执行销毁。
 */
export function readOnlyScratchLayout(scratchRoot) {
  return {
    stagingRoot: scratchRoot,
    registryStageDir: join(scratchRoot, 'session'),
  }
}

/**
 * 把当前工作区的**已暂存覆盖层**物化进一次性暂存根的 shim 布局（`fs\<盘>\…`），
 * 让只读命令仍能看到"待审但未应用"的暂存版本（overlay 语义），同时绝不写回 store。
 *
 * 失败项如实返回（不静默）；真实盘只被**读**。
 */
export function materializeOverlayInto(workspace, destRoot) {
  const report = { copied: 0, skipped: 0, failed: [] }
  const entries = workspace?.manifest?.entries && typeof workspace.manifest.entries === 'object' ? workspace.manifest.entries : {}
  for (const [rel, entry] of Object.entries(entries)) {
    if (!entry || entry.state === 'deleted') continue
    let abs
    try {
      abs = workspace.absolute(rel)
    } catch (error) {
      report.failed.push({ path: rel, message: error.message })
      continue
    }
    // UNC/设备路径不映射（shim 用 `_unc` 段表示，形状不同；只读模式不为此冒险）
    if (!/^[A-Za-z]:[\\/]/.test(abs)) {
      report.skipped += 1
      continue
    }
    const target = join(destRoot, 'fs', abs[0], abs.slice(3))
    try {
      if (entry.kind === 'dir') {
        mkdirSync(target, { recursive: true })
        report.copied += 1
        continue
      }
      const content =
        typeof entry.stagedHash === 'string' && workspace.store.hasBlob(entry.stagedHash)
          ? workspace.store.readBlob(entry.stagedHash)
          : readFileSync(abs)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      report.copied += 1
    } catch (error) {
      report.failed.push({ path: rel, message: error.message })
    }
  }
  return report
}

function fail(code, message, extra = {}) {
  // R34-02：领域错误消息常自带 `CODE:` 前缀（executor 的 SANDBOX_UNAVAILABLE 等），
  // 旧实现会打印 `SANDBOX_UNAVAILABLE: SANDBOX_UNAVAILABLE: ...`。这里只去掉**同码**前缀。
  const text = typeof message === 'string' && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message
  process.stderr.write(`${code}: ${text}\n`)
  if (Object.keys(extra).length) process.stderr.write(`${JSON.stringify(extra, null, 2)}\n`)
  // 退出码表（文件头）：2 = 用法错误。旧实现把 USAGE 也映射到 1，与文档不一致。
  process.exit(code === 'SANDBOX_UNAVAILABLE' ? EXIT.FAIL_CLOSED : code === 'USAGE' ? EXIT.USAGE : EXIT.FAIL)
}

async function main() {
  const { positional, flags, passthrough, problems } = parseArgv(process.argv.slice(2))
  const command = positional[0]
  // U16-5：`--help` 是**成功**路径（退出码 0），不是用法错误；`<命令> --help` 给该命令
  // 的真实参数（含 --paths/--force/--candidate/--tier/--max-lines/--timeout/--read-only/
  // --no-cache/--use-cache/--reason/--apply）。`help <命令>` 等价。
  if (flags.help || command === 'help') {
    process.stdout.write(usageFor(command === 'help' ? positional[1] : command))
    process.exit(EXIT.OK)
  }
  if (!command) {
    process.stderr.write(USAGE)
    process.exit(EXIT.USAGE)
  }
  /**
   * ── R34-03：位置参数 / 未知开关 = 用法错误，绝不静默忽略 ──────────────────────
   * 实测缺陷：`apply --workspace <ws> a.txt` 的 `a.txt` 被忽略 ⇒ **整份候选全部写入**
   * （用户只授权了一个文件）；`status <ws>` 也静默忽略。路径必须走 `--paths`。
   */
  if (NO_POSITIONAL_COMMANDS.has(command) && positional.length > 1) {
    problems.push(
      `多余的参数: ${positional.slice(1).join(' ')}（本命令不接受位置参数；路径请用 --paths <a,b>，工作区请用 --workspace <dir>）`,
    )
  }
  if (command !== 'exec' && passthrough !== undefined) {
    problems.push('只有 exec 支持 `--` 之后的命令参数')
  }
  if (problems.length > 0) usageError(problems, command)

  const workspaceFlag = flags.workspace
  const workspaceRoot = canonical(resolve(typeof workspaceFlag === 'string' ? workspaceFlag : process.cwd()))
  // U16-7：`--workspace` 指到不存在的目录时不得"原样回显 + 静默读别的 store"。
  // probe 只做能力探测（不建暂存区），保持原有宽容；其余命令必须落在真实工作区上。
  // R34-04：存在但不**是目录**（普通文件/设备）此前会被当成工作区根并给出 exit 0 的读数；
  // 工作区只可能是目录，因此显式 fail-fast。
  if (command !== 'probe') {
    if (!existsSync(workspaceRoot)) {
      fail('WORKSPACE_NOT_FOUND', `工作区目录不存在: ${workspaceRoot}（--workspace 必须指向已存在的目录；本工具不会为你创建它）`)
    }
    let isDirectory = false
    try {
      isDirectory = statSync(workspaceRoot).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      fail(
        'WORKSPACE_NOT_A_DIRECTORY',
        `--workspace 指向的不是目录: ${workspaceRoot}（当前是文件或设备）。` +
          `本工具只在目录形式的工作区上读写；请改传它所在的目录，或不传 --workspace 使用当前目录。`,
      )
    }
  }

  /**
   * R34-13：未知子命令 / 缺必填参数必须在**解析工作区与 store 之前**判定。
   * 否则（例如 store 已被别的会话占用时）会先撞 WORKSPACE_STORE_MISMATCH，
   * 用户拿到的是"store 不匹配"而不是"这个命令/参数根本不对"。
   */
  const KNOWN_COMMANDS = new Set(['init', 'status', 'probe', 'exec', 'review', 'diff', 'apply', 'discard', 'gc', 'audit'])
  if (!KNOWN_COMMANDS.has(command)) {
    process.stderr.write(`未知命令: ${command}\n\n${USAGE}`)
    process.exit(EXIT.USAGE)
  }
  if (command === 'discard' && flags.candidate === undefined) {
    problems.push('discard 需要 --candidate <id>')
  }
  if (command === 'exec' && !(passthrough !== undefined && passthrough.length > 0) && positional.length < 2) {
    problems.push('exec 需要命令，例如: exec -- pwsh -c "ni a.txt"')
  }
  if (problems.length > 0) usageError(problems, command)

  // WP11（2026-10-05）：探针缓存**不再落工作区** `<ws>\.dshstage\cache`。
  // owner 已决定工作区不再出现 `.dshstage`，暂存/缓存一律在 Windows 缓存面（`resolveStageRoot()`）。
  // `--no-cache` 仍然完全关闭缓存（传 `undefined`）。
  const probeCacheDir = () => resolve(resolveStageRoot({ workspaceRoot, sessionKey: flags.session }), 'probe-cache')

  if (command === 'probe') {
    const report = probe({
      root: workspaceRoot,
      cacheDir: flags['no-cache'] ? undefined : probeCacheDir(),
      useCache: flags['use-cache'] === true,
    })
    if (flags.json) out(report, flags)
    else process.stdout.write(`${formatReport(report)}\n`)
    process.exit(EXIT.OK)
  }

  const workspace = new Workspace({ workspaceRoot, sessionId: flags.session }).init()

  // U16-7：store 根可能由 `WINSTAGE_STAGE_ROOT`/`--session` 钉住。若它属于**另一个**
  // 工作区（manifest.workspaceRoot 不符），此前会静默给出别人的 store 读数 —— 现在 fail-fast。
  const manifestRoot = workspace.manifest?.workspaceRoot
  if (manifestRoot && canonical(manifestRoot) !== workspaceRoot) {
    fail(
      'WORKSPACE_STORE_MISMATCH',
      `解析到的暂存存储根 ${workspace.store.dir} 属于另一个工作区 ${canonical(manifestRoot)}，` +
        `与 --workspace ${workspaceRoot} 不一致；拒绝在别的会话/工作区的 store 上操作。` +
        `（检查 WINSTAGE_STAGE_ROOT 与 --session；init 会打印实际使用的 store 根）`,
    )
  }

  /** U16-6：候选 id 不存在是**用法/状态错误**，不是未捕获异常（不打印堆栈，给出下一步）。 */
  const resolveCandidateOrFail = (candidateId) => {
    try {
      return workspace.resolveCandidate(candidateId)
    } catch (error) {
      if (error?.code === 'CANDIDATE_NOT_FOUND' || /candidate .* does not exist/i.test(String(error?.message))) {
        fail('CANDIDATE_NOT_FOUND', `候选 ${candidateId} 不存在；先跑 review 查看可用候选 id（或 status --json 看待审列表）`)
      }
      throw error
    }
  }

  switch (command) {
    case 'init': {
      const report = probe({
        root: workspaceRoot,
        cacheDir: probeCacheDir(),
        useCache: flags['use-cache'] === true,
      })
      const payload = {
        workspaceRoot: workspace.root,
        storeDir: workspace.store.dir,
        sessionId: workspace.sessionId,
        tier: report.tier,
        instanceChecks: report.instanceChecks,
        // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复（机器可读面）
        staleAppContainerAces: report.staleAppContainerAces,
        corruption: workspace.corruption,
        entryCount: Object.keys(workspace.manifest.entries).length,
      }
      if (flags.json) out(payload, flags)
      else {
        process.stdout.write(`${formatReport(report, { workspace: { staleAceRepair: report.staleAppContainerAces } })}\n\n`)
        process.stdout.write(`workspace   = ${payload.workspaceRoot}\n`)
        process.stdout.write(`store       = ${payload.storeDir}\n`)
        process.stdout.write(`session     = ${payload.sessionId}\n`)
        process.stdout.write(`stagedItems = ${payload.entryCount}\n`)
        if (payload.corruption.length) {
          process.stdout.write(`⚠ 损坏项 ${payload.corruption.length} 个（禁止发布，见手册 3.1）:\n`)
          for (const item of payload.corruption) process.stdout.write(`   ${item.path}: ${item.reason}\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'status': {
      const pending = workspace.listReviews()
      const changes = workspace.diffEntries()
      const payload = {
        workspaceRoot: workspace.root,
        // U16-7：把"解析后的 store 根"显式打出来 —— 环境变量/会话键不同会导致读到不同 store，
        // 此前只有 init 打印它，status/JSON 用户无法发现"看的是另一个 store"。
        storeDir: workspace.store.dir,
        sessionId: workspace.sessionId,
        revision: workspace.manifest.revision,
        stagedEntries: Object.keys(workspace.manifest.entries).length,
        netChanges: changes.length,
        netChangeByOp: changes.reduce((acc, c) => ({ ...acc, [c.op]: (acc[c.op] || 0) + 1 }), {}),
        pendingCandidates: pending.length,
        pendingFiles: pending.reduce((sum, c) => sum + c.changes.length, 0),
        pendingHostOperations: pending.reduce((sum, c) => sum + (c.hostOperations?.length || 0), 0),
        corruption: workspace.corruption,
        candidates: pending.map((c) => ({
          id: c.id,
          status: c.status,
          createdAt: c.createdAt,
          files: c.changes.length,
          changes: c.changes.map((x) => `${x.op}:${x.path}`),
        })),
      }
      if (flags.json) out(payload, flags)
      else {
        process.stdout.write(`工作区      : ${payload.workspaceRoot}\n`)
        process.stdout.write(`存储根      : ${payload.storeDir}\n`)
        process.stdout.write(`会话        : ${payload.sessionId}  revision=${payload.revision}\n`)
        process.stdout.write(`暂存条目    : ${payload.stagedEntries}\n`)
        process.stdout.write(`净变化      : ${payload.netChanges} ${JSON.stringify(payload.netChangeByOp)}\n`)
        // 手册 12.2：明确分开展示"待审文件数"和"宿主操作数"
        process.stdout.write(`待审文件数  : ${payload.pendingFiles}（${payload.pendingCandidates} 份候选）\n`)
        process.stdout.write(`宿主操作数  : ${payload.pendingHostOperations}\n`)
        if (payload.corruption.length) process.stdout.write(`损坏项      : ${payload.corruption.length}\n`)
        for (const candidate of payload.candidates) {
          process.stdout.write(`  [${candidate.status}] ${candidate.id} — ${candidate.files} 个变更单元\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'exec': {
      const argv = passthrough && passthrough.length ? passthrough : positional.slice(1)
      if (!argv.length) fail('USAGE', 'exec 需要命令，例如: exec -- pwsh -c "ni a.txt"')
      // R34-05：`--timeout abc` 旧行为把 NaN 传给执行器（超时语义静默失效）。
      let timeoutMs
      if (flags.timeout !== undefined) {
        timeoutMs = Number(flags.timeout)
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
          fail('USAGE', `--timeout 需要正整数毫秒（收到 "${flags.timeout}"）`)
        }
      }
      const readOnlyMode = flags['read-only'] === true
      /**
       * ── R18-KNOWN-05a：只读模式先判命令，**写/判不出来就拒绝** ──────────────────
       * 结构化错误：码 + `executed:false` + 判定理由。拒绝发生在 init/spawn 之前，
       * 因此真实盘、store、候选队列都不可能被这条命令改变。
       */
      if (readOnlyMode) {
        const verdict = readOnlyExecVerdict(argv[0], argv.slice(1))
        if (!verdict.allowed) {
          fail(
            READ_ONLY_EXEC_REFUSED_CODE,
            `--read-only 只允许**正向证明无副作用**的命令；这条命令被判为 ${verdict.risk}，拒绝执行` +
              `（executed=false，未创建进程、真实盘与候选均未改变）`,
            { executed: false, commandRisk: verdict.risk, reasons: verdict.reasons, readOnly: true },
          )
        }
      }
      /**
       * 只读模式用**一次性暂存根**：即便 shim 仍产生暂存副作用（写/白障/注册表
       * overlay），也全部落在临时目录里，执行完整体删除 ⇒ 不并入清单、不冻结候选。
       */
      const readOnlyScratch = readOnlyMode ? mkdtempSync(join(tmpdir(), 'winstage-readonly-')) : undefined
      const scratchLayout = readOnlyScratch ? readOnlyScratchLayout(readOnlyScratch) : undefined
      if (scratchLayout) mkdirSync(scratchLayout.registryStageDir, { recursive: true })
      const executor = new WindowsStageExecutor({
        stagingRoot: scratchLayout ? scratchLayout.stagingRoot : workspace.store.stagedDir,
        // 注册表覆盖层必须落在**会话存储根**，不能落在暂存树里 —— 否则
        // "提取暂存树变化"会把 shim 自己的 `registry/overlay.<pid>.hive*` 当成用户改动
        // 去摄取（本机实测 `EPERM ... overlay.<pid>.hive.LOG1`）。与 `dsh-plugin/
        // shell-executor.ts` 的同一处参数保持一字不差。
        registryStageDir: scratchLayout ? scratchLayout.registryStageDir : workspace.store.dir,
        mode: readOnlyMode ? 'read-only' : 'workspace-write',
        tier: flags.tier,
      })
      let report
      try {
        report = await executor.init()
      } catch (error) {
        if (readOnlyScratch) rmSync(readOnlyScratch, { recursive: true, force: true })
        fail(error.code === 'SANDBOX_UNAVAILABLE' ? 'SANDBOX_UNAVAILABLE' : 'SANDBOX_INIT_FAILED', error.message)
      }
      try {
        // 执行前物化当前工作区版本（#3.2 / A16）；只读模式物化进一次性 scratch 的 shim 布局
        const materialize = readOnlyScratch ? materializeOverlayInto(workspace, readOnlyScratch) : workspace.materializeForExecution()
        const before = readOnlyScratch ? undefined : workspace.snapshotStagedTree()
        const execution = await executor.run({
          command: argv[0],
          args: argv.slice(1),
          cwd: readOnlyScratch ?? workspace.store.stagedDir,
          logicalCwd: workspace.root,
          timeoutMs,
        })
        // ── 只读模式：不捕获、不并入、不冻结（暂存副作用都在 scratch，随后删除）──
        const captured = readOnlyScratch ? [] : workspace.captureAfterExecution(before)
        // ── D9 修复：捕获结果必须**并入清单并冻结候选**，否则 exec → review → apply 断链 ──
        // 原先这里只有 `captured.length` 一个统计数字：暂存树里有命令产出的文件，
        // 但 `diffEntries()` 看不到任何变化 → `review` 恒为空 → `apply` 无候选可应用。
        // 这一段原本被 tests\e2e-flow.ts 在 CLI 之外手工补上（测试替被测代码干活）。
        const ingested = readOnlyScratch ? { ingested: 0, deletions: 0, skipped: [] } : workspace.ingestCapturedChanges(captured)
        const frozen = readOnlyScratch
          ? { frozen: false, reason: 'read-only-mode', changes: 0 }
          : workspace.freezeIfNeeded({ source: 'exec' })
        const payload = {
          execution: {
            argv: execution.argv,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            durationMs: execution.durationMs,
            stdout: execution.stdout,
            stderr: execution.stderr,
            classification: execution.classification,
            enforcement: execution.enforcement,
            tier: execution.tier,
            completedWithoutOutput: execution.completedWithoutOutput,
          },
          sandboxInit: report,
          ...(readOnlyScratch
            ? {
                readOnly: {
                  enforced: true,
                  commandRisk: 'read-only',
                  /** 一次性暂存根在返回时已销毁（下方 finally）；这是它的路径读数 */
                  scratchRoot: readOnlyScratch,
                  discarded: true,
                  candidateFrozen: false,
                  note: '--read-only：写/indeterminate 命令在 exec 前被拒；只读命令的暂存副作用（若有）落在一次性根里，执行后整体删除；不并入清单、不冻结候选',
                },
              }
            : {}),
          materialized: materialize,
          capturedChanges: captured.length,
          /** 新增：并入清单的条数 / 删除条数 / 跳过原因（可观测，不静默） */
          ingested,
          /** 新增：候选冻结结果（frozen=false 且 reason=already-represented 表示幂等复用） */
          candidate: {
            frozen: frozen.frozen === true,
            reason: frozen.reason,
            id: frozen.candidate?.id,
            files: frozen.candidate?.changes?.length,
            pendingAfter: workspace.listReviews().length,
          },
        }
        if (flags.json) out(payload, flags)
        else {
          process.stdout.write(`$ ${execution.argv.join(' ')}\n`)
          if (execution.stdout) process.stdout.write(execution.stdout)
          if (execution.stderr) process.stderr.write(execution.stderr)
          process.stdout.write(`\n退出码=${execution.exitCode} 分类=${execution.classification.kind} 用时=${execution.durationMs}ms\n`)
          process.stdout.write(formatExecTierLine(report))
          if (execution.completedWithoutOutput) process.stdout.write('（执行完成，无输出）\n')
          if (readOnlyScratch) {
            process.stdout.write(
              '只读模式：命令已按"正向证明只读"执行；暂存副作用落一次性根并已丢弃，未并入清单、未冻结候选\n',
            )
          } else {
            process.stdout.write(`沙箱内提取到 ${captured.length} 项变化，并入清单 ${ingested.ingested} 项，删除 ${ingested.deletions} 项\n`)
            if (frozen.frozen) process.stdout.write(`已冻结候选 ${frozen.candidate.id}（${frozen.candidate.changes.length} 个变更单元）→ 可用 review/apply 处理\n`)
            else process.stdout.write(`未新建候选：${frozen.reason}\n`)
            for (const skip of ingested.skipped) process.stdout.write(`  ⚠ 跳过 ${skip.path}: ${skip.reason}\n`)
          }
        }
        process.exit(execution.exitCode === 0 ? EXIT.OK : EXIT.FAIL)
      } finally {
        executor.dispose()
        // 一次性只读暂存根：无论成功失败都整体销毁（真实盘/store 从未被写）
        if (readOnlyScratch) {
          try {
            rmSync(readOnlyScratch, { recursive: true, force: true })
          } catch {
            /* 清理失败不改变命令结论（目录在 %TEMP% 下，下一次启动前会被轮转清理） */
          }
        }
      }
      break
    }

    case 'review': {
      const pending = workspace.listReviews()
      const payload = pending.map((c) => ({
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        files: c.changes.length,
        hostOperations: c.hostOperations?.length || 0,
        summary: c.summary,
        changes: c.changes.map((x) => ({ op: x.op, path: x.path, kind: x.kind })),
      }))
      if (flags.json) out(payload, flags)
      else if (payload.length === 0) process.stdout.write('待审队列为空（没有净变化就不会入队，见手册 #12.1）\n')
      else {
        for (const candidate of payload) {
          process.stdout.write(`候选 ${candidate.id}  [${candidate.status}]  ${candidate.files} 文件 / ${candidate.hostOperations} 宿主操作\n`)
          for (const change of candidate.changes) process.stdout.write(`   ${change.op.padEnd(7)} ${change.path}\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'diff': {
      let candidate
      if (flags.candidate) {
        candidate = resolveCandidateOrFail(flags.candidate).candidate
      } else {
        const pending = workspace.listReviews()
        candidate = pending[pending.length - 1]
      }
      // R34-06：`--json` 是机读契约 —— 空队列也必须给可解析 JSON（旧实现回显纯文本）。
      if (!candidate) {
        if (flags.json) out({ candidate: null, lines: [] }, flags)
        else process.stdout.write('没有可展示的候选\n')
        process.exit(EXIT.OK)
      }
      // R34-05：`--max-lines abc` 的 NaN 旧行为让截断语义静默失效。
      let maxLines = 40
      if (flags['max-lines'] !== undefined) {
        maxLines = Number(flags['max-lines'])
        if (!Number.isInteger(maxLines) || maxLines <= 0) {
          fail('USAGE', `--max-lines 需要正整数值（收到 "${flags['max-lines']}"）`)
        }
      }
      const lines = renderCandidateDiff(workspace.store, candidate, { maxLines })
      if (flags.json) out({ candidate: candidate.id, lines }, flags)
      else {
        process.stdout.write(`候选 ${candidate.id} [${candidate.status}] — before/after 均冻结在候选内\n`)
        for (const line of lines) {
          if (line.type === 'change-header') process.stdout.write(`\n--- ${line.op} ${line.path}\n`)
          else if (line.type === 'add') process.stdout.write(`+ ${line.text}\n`)
          else if (line.type === 'remove') process.stdout.write(`- ${line.text}\n`)
          else process.stdout.write(`  (${line.text})\n`)
        }
      }
      process.exit(EXIT.OK)
    }

    case 'apply': {
      let candidate
      let candidateId = flags.candidate
      if (candidateId) {
        // U16-6：显式 --candidate 先按同一套结构化错误解析（未知 id 给 `CODE: message`，不抛栈）。
        const resolved = resolveCandidateOrFail(candidateId)
        if (resolved.idempotent === 'ALREADY_APPLIED') {
          // R34-07：重复批准必须是**显式的 already-applied 成功语义**（不写盘），
          // 不再打印 `状态 undefined / 已应用 0 项` 这种无法判定的结果。
          const payload = { ...resolved, alreadyApplied: true, wroteToDisk: false }
          if (flags.json) out(payload, flags)
          else {
            process.stdout.write(
              `候选 ${resolved.id} 已经是 applied 状态（already-applied）：本次未再次写盘，真实工作区未改动。\n`,
            )
          }
          process.exit(EXIT.OK)
        }
        candidate = resolved.candidate
      } else {
        const pending = workspace.listReviews()
        if (!pending.length) {
          // R34-06：JSON 模式的"没有待审候选"同样必须是可解析 JSON。
          if (flags.json) {
            out({ id: null, status: 'no-pending-candidates', applied: [], failed: [], remaining: [], wroteToDisk: false }, flags)
          } else {
            process.stdout.write('没有待审候选\n')
          }
          process.exit(EXIT.OK)
        }
        candidate = pending[pending.length - 1]
        candidateId = candidate.id
      }
      const paths = typeof flags.paths === 'string' ? flags.paths.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      if (flags.paths !== undefined && (!paths || paths.length === 0)) {
        fail('USAGE', '--paths 需要至少一个工作区相对路径（逗号分隔），例如: --paths a.txt,src/b.txt')
      }
      /**
       * ── R34-08：路径列表要么全部命中、要么一个字节都不写 ────────────────────────
       * 实测缺陷：`apply --paths a.txt,nope.txt` 旧行为写入了 a.txt、对 nope.txt **一声不响**
       * （exit 0、failed=[]），是"静默半批应用"。审批是用户对整批的一次决定，含未知路径
       * 时必须拒整批并点名未命中的路径，而不是照写命中的那部分。
       */
      if (paths) {
        const known = new Set((candidate?.changes ?? []).map((change) => compareKey(change.path)))
        const requested = [...new Set(paths)]
        const unmatched = requested.filter((path) => !known.has(compareKey(path)))
        if (unmatched.length > 0) {
          fail(
            'NO_MATCHING_PATHS',
            `--paths 中有 ${unmatched.length} 个路径不在候选 ${candidateId} 里：${unmatched.join(', ')}。` +
              `为防止半批应用，本次一个文件都没有写入；用 review/diff 查看候选内的路径（相对路径、逗号分隔）。`,
          )
        }
      }
      const result = workspace.applyCandidate(candidateId, { paths, force: flags.force === true })
      const noDiskWrite = result.applied.length === 0 && result.failed.length === 0
      if (flags.json) out(noDiskWrite ? { ...result, wroteToDisk: false, noNetChange: true } : result, flags)
      else {
        process.stdout.write(`候选 ${result.id} → 状态 ${result.status}\n`)
        process.stdout.write(`已应用 ${result.applied.length} 项，失败 ${result.failed.length} 项\n`)
        // R34-09：0 应用 0 失败不是"模糊成功"：必须明说未写盘、以及为什么。
        if (noDiskWrite) {
          process.stdout.write('已无净变化：所选路径已经是目标状态（或没有可应用条目），本次未写盘。\n')
        }
        for (const item of result.failed) process.stdout.write(`  ✗ ${item.path}: ${item.code} — ${item.message}\n`)
        if (result.remaining?.length) {
          process.stdout.write(`未选择/未应用 ${result.remaining.length} 项，保留为可追踪修订（不会丢弃整份候选）\n`)
        }
      }
      /**
       * ── R34-10：退出码必须与"有没有失败项"一致 ──────────────────────────────────
       * 旧实现只把 STALE_BASELINE 映射成 4，其余失败（如 SANDBOX_PATH_MASKED_CONFIRM、
       * EPERM、回滚失败）一律 exit 0 —— 脚本会把"失败 N 项"当成功。
       */
      if (result.failed.length > 0) {
        process.exit(result.failed.some((f) => f.code === 'STALE_BASELINE') ? EXIT.STALE : EXIT.FAIL)
      }
      process.exit(EXIT.OK)
    }

    case 'discard': {
      if (!flags.candidate) fail('USAGE', 'discard 需要 --candidate <id>')
      const result = workspace.discardCandidate(flags.candidate, { reason: flags.reason })
      out(result, flags)
      process.exit(EXIT.OK)
    }

    case 'gc': {
      const report = workspace.store.collectGarbage({ apply: flags.apply === true })
      out(report, flags)
      process.exit(EXIT.OK)
    }

    case 'audit': {
      const { runAudit } = await import('./audit.ts')
      const report = await runAudit(workspace, { json: flags.json === true })
      process.exit(report.passed ? EXIT.OK : EXIT.FAIL)
    }

    default:
      process.stderr.write(`未知命令: ${command}\n\n${USAGE}`)
      process.exit(EXIT.USAGE)
  }
}

/**
 * 直接执行时才跑 main：测试可以安全 `import` 本模块取纯渲染函数（`usageFor` /
 * `formatExecTierLine`），不会被 CLI 的顶层 `main()` 副作用带跑。
 */
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1].length > 0 &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  main().catch((error) => {
    // U16-6：已知领域错误按 `CODE: message` 单行输出（与既有 USAGE / fail() 风格一致），
    // 不再把堆栈当作唯一错误形态；未知异常才保留堆栈（便于定位真 bug）。
    if (error instanceof SandboxError) {
      process.stderr.write(`${error.code}: ${error.message}\n`)
      if (error.detail && Object.keys(error.detail).length) process.stderr.write(`${JSON.stringify(error.detail)}\n`)
      process.exit(error.code === 'STALE_BASELINE' ? EXIT.STALE : EXIT.FAIL)
    }
    process.stderr.write(`未捕获错误: ${error?.stack || error}\n`)
    process.exit(EXIT.FAIL)
  })
}
