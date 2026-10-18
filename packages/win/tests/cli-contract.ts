// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * cli-contract —— CLI 对外契约套件（round16 缺陷 U16-5/6/7/8/9 的回归钉）
 * ============================================================================
 * 为什么单独一个套件：round16 的 7 域实测里，CLI 的六条 P2 全部是"读代码看不出来、
 * 把命令喂进去跑才看得见"的**契约**问题。它们不在任何既有套件里：
 *   · U16-5 `--help` 退出码 2（脚本里等于错误）；子命令 help 不含真实参数；
 *   · U16-6 候选不存在时抛未捕获堆栈，与同仓 `CODE: message` 风格不一致；
 *   · U16-7 `status --workspace <不存在>` 回显入参却 exit 0，并静默读**别的 store**；
 *   · U16-8 `exec` 文本模式不显示档位（只有 --json 里有）；
 *   · U16-9 字典串里 markdown `**` 原样显示（R11 D7-e 复现）。
 *
 * 每条断言都是"给输入 → 真跑 CLI 子进程 → 断言退出码/文本"。子进程用
 * `spawnSync(..., { stdio: ['ignore', fd, fd] })` 的文件描述符重定向（不用命名管道，
 * 与 `run.cmd` 同一理由：受限令牌会话下管道打开会 EPERM，见残余边界 R10）。
 *
 * 环境：CLI 会建立 stage guard。在**受限/已被占用的**会话里（本机实测：DSH 自己的
 * WinStage shell 会话里，`Add-Type` 临时文件会被暂存层拦住）它无法建立 ⇒ 本套件如实
 * 报 **SKIP**（不是 PASS，也不是 FAIL），与"缺能力的宿主上 bwrap 用例如实 SKIP"同口径。
 *
 * 全部离线：只写 os.tmpdir() 下的临时工作区/存储根，结束时删干净；零注册表写、
 * 零系统状态改动。
 */

import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CLI = join(PKG, 'src', 'cli.ts')

let assertions = 0
let failures = 0
function check(name, condition, evidence) {
  assertions += 1
  if (!condition) failures += 1
  process.stdout.write(`  ${condition ? '✓' : '✗'} ${name}\n`)
  if (evidence !== undefined) process.stdout.write(`      证据: ${evidence}\n`)
}
function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

const ROOT = mkdtempSync(join(tmpdir(), 'winstage-cli-contract-'))
let seq = 0

/** 跑一次 CLI；stdout/stderr 落文件后用文件描述符重定向（避免命名管道）。 */
function runCli(args, options = {}) {
  const log = join(ROOT, `run-${(seq += 1)}.log`)
  const fd = openSync(log, 'w')
  const env = { ...process.env, ...(options.env || {}) }
  // 子进程必须拿一个**自己的**、可写的存储根：继承调用方的会话根会和它抢 guard。
  env.WINSTAGE_STAGE_ROOT = options.storeRoot || join(ROOT, `store-${seq}`)
  // 清掉调用方会话的 WinStage 身份，避免子进程以为自己在别人的暂存树里。
  delete env.WINSTAGE_SHIM_CONFIG
  delete env.WINSTAGE_SHIM_LOG
  delete env.WINSTAGE_AUDIT_LOG
  delete env.WINSTAGE_REGSTAGE_SESSION_DIR
  delete env.DSH_REGSTAGE_ROOT
  delete env.DSH_SESSION_ID
  let result
  /**
   * 宿主形态自适应：在 **DSH-as-node**（Electron 可执行文件以 node 身份运行）里，
   * 子进程必须同样带 `--expose-internals`（R17 shell-runner 配方），否则 CLI 解析不到
   * `@deepseek-ai/dsh-sandbox-windows-acl`；普通 node 下原样传 CLI。
   */
  const execAsDshNode = /DeepSeek Harness(?:\.exe)?$/i.test(process.execPath) || process.env.ELECTRON_RUN_AS_NODE === '1'
  const argv = execAsDshNode ? ['--expose-internals', CLI, ...args] : [CLI, ...args]
  try {
    result = spawnSync(process.execPath, argv, {
      cwd: options.cwd || ROOT,
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 180000,
    })
  } finally {
    closeSync(fd)
  }
  return { status: result.status, text: readFileSync(log, 'utf8'), signal: result.signal }
}

function freshDir(name) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function jsonOf(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── 环境预检：stage guard 建立在**未受限**会话上；建不起来就如实 SKIP ──────────────
const probeWs = freshDir('probe-ws')
const probe = runCli(['status', '--workspace', probeWs, '--json'], { storeRoot: join(ROOT, 'probe-store') })
if (/StageGuardUnavailableError|protected session directory could not be established/i.test(probe.text)) {
  process.stdout.write('\n========================================================================\n')
  process.stdout.write('SKIP: 当前会话无法建立 stage guard（受限令牌/已被别的会话占用/暂存层拦截了 Add-Type 临时文件）\n')
  process.stdout.write(`  证据: status=${probe.status} 首行=${probe.text.split(/\r?\n/)[0]?.slice(0, 200)}\n`)
  process.stdout.write('  这不是 PASS：CLI 契约套件需要能建 store 的会话。换未受限会话再跑。\n')
  process.stdout.write('RESULT: SKIP checks=0 failures=0 mode=normal\n')
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(0)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. U16-5：`--help` 是成功路径，且子命令 help 必须覆盖真实参数
// ═══════════════════════════════════════════════════════════════════════════
section('1. U16-5：`--help` 退出码 0；`apply --help` 必须列出 --paths/--force')

{
  const r = runCli(['--help'])
  check('`--help` 退出码 0（不是用法错误 2）', r.status === 0, `exit=${r.status}`)
  check('全局 help 列出全部子命令', ['init', 'status', 'exec', 'review', 'diff', 'apply', 'discard', 'gc', 'audit'].every((c) => r.text.includes(c)), '命令表')
  const applyHelp = runCli(['apply', '--help'])
  check('`apply --help` 退出码 0', applyHelp.status === 0, `exit=${applyHelp.status}`)
  check('`apply --help` 含 --paths（选择性应用）', applyHelp.text.includes('--paths'), '语料=apply usage')
  check('`apply --help` 含 --force', applyHelp.text.includes('--force'), '语料=apply usage')
  check('`apply --help` 含 --candidate', applyHelp.text.includes('--candidate'), '语料=apply usage')
  const execHelp = runCli(['exec', '--help'])
  check(
    '`exec --help` 含 --tier/--timeout/--read-only（代码实际支持但旧 help 未列）',
    ['--tier', '--timeout', '--read-only'].every((f) => execHelp.text.includes(f)),
    `exit=${execHelp.status}`,
  )
  const noargs = runCli([])
  check('无参仍是用法错误（退出码 2，且给出命令表）', noargs.status === 2 && noargs.text.includes('命令：'), `exit=${noargs.status}`)
  const unknown = runCli(['frobnicate'])
  check('未知命令退出码 2 且点名', unknown.status === 2 && unknown.text.includes('未知命令: frobnicate'), `exit=${unknown.status}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. U16-6：候选不存在 → `CODE: message` + 出路，不是未捕获堆栈
// ═══════════════════════════════════════════════════════════════════════════
section('2. U16-6：未知候选 id 不得抛未捕获堆栈')

const wsA = freshDir('ws-a')
const storeShared = join(ROOT, 'store-shared')
{
  const status = runCli(['status', '--workspace', wsA, '--json'], { storeRoot: storeShared })
  check('前置：工作区可初始化 store', status.status === 0, `exit=${status.status} ${status.text.slice(0, 120)}`)
  for (const sub of ['apply', 'diff']) {
    const r = runCli([sub, '--workspace', wsA, '--candidate', 'cs_9999_deadbeef', '--json'], { storeRoot: storeShared })
    check(`\`${sub} --candidate <不存在>\` 退出码 1（已知状态错误）`, r.status === 1, `exit=${r.status}`)
    check(`\`${sub}\` 输出 \`CANDIDATE_NOT_FOUND: …\``, /CANDIDATE_NOT_FOUND:/.test(r.text), r.text.split(/\r?\n/)[0] ?? '')
    check(`\`${sub}\` 不再出现"未捕获错误"/堆栈`, !/未捕获错误/.test(r.text) && !/\n\s+at .*workspace\.ts/.test(r.text), '无栈帧')
    check(`\`${sub}\` 给出下一步（先跑 review）`, r.text.includes('review'), '文案含 review')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. U16-7：--workspace 不存在 / 与 store 不匹配 ⇒ fail-fast；status 打印 store 根
// ═══════════════════════════════════════════════════════════════════════════
section('3. U16-7：status 不得"回显入参 + exit 0 + 静默读别的 store"')

{
  const missing = runCli(['status', '--workspace', join(ROOT, 'no-such-ws')], { storeRoot: join(ROOT, 'store-3a') })
  check('`status --workspace <不存在>` 退出码非 0', missing.status !== 0, `exit=${missing.status}`)
  check('错误码点名为 `WORKSPACE_NOT_FOUND`', missing.text.includes('WORKSPACE_NOT_FOUND'), missing.text.split(/\r?\n/)[0] ?? '')

  const wsB = freshDir('ws-b')
  const mismatch = runCli(['status', '--workspace', wsB], { storeRoot: storeShared })
  check('同一 store 上换一个工作区 ⇒ `WORKSPACE_STORE_MISMATCH`（不再静默给别人的读数）', mismatch.text.includes('WORKSPACE_STORE_MISMATCH') && mismatch.status !== 0, mismatch.text.split(/\r?\n/)[0] ?? '')

  const status = runCli(['status', '--workspace', wsA], { storeRoot: storeShared })
  check('文本 status 打印解析后的存储根', status.status === 0 && /存储根\s*:/.test(status.text), `exit=${status.status}`)
  const json = runCli(['status', '--workspace', wsA, '--json'], { storeRoot: storeShared })
  const payload = jsonOf(json.text)
  check('JSON status 含 storeDir 且等于钉住的 store 根', payload?.storeDir === storeShared, `storeDir=${payload?.storeDir ?? '(missing)'}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. U16-8 / U16-9：纯渲染与字典（import 模块，不经 CLI 顶层 main）
// ═══════════════════════════════════════════════════════════════════════════
section('4. U16-8/U16-9：exec 文本档位行 + 字典串不得含 markdown `**`')

{
  const cliMod = await import('../src/cli.ts')
  check('导出了 usageFor（帮助文本单一来源）', typeof cliMod.usageFor === 'function', typeof cliMod.usageFor)
  check('`exec` 文本档位行 = `档位=T1(restricted-token)`', cliMod.formatExecTierLine({ tierEffective: 'T1', launchMode: 'restricted-token' }) === '档位=T1(restricted-token)\n', JSON.stringify(cliMod.formatExecTierLine({ tierEffective: 'T1', launchMode: 'restricted-token' })))
  check('档位行与 lane 同源字段 tierEffective（shim 档 ⇒ TS(shim)）', cliMod.formatExecTierLine({ tierEffective: 'TS', launchMode: 'shim' }) === '档位=TS(shim)\n', 'tierEffective 优先')
  check('缺档位字段时不出空标签（返回空串）', cliMod.formatExecTierLine({}) === '', '空串')

  const clientSrc = readFileSync(join(PKG, 'dsh-plugin', 'client.ts'), 'utf8')
  const offender = clientSrc
    .split(/\r?\n/)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /^\s*(?:[A-Za-z0-9_]+:\s*)?'[^']*\*\*[^']*'/.test(line))
  check('client 字典串里没有 markdown `**`（U16-9 / R11 D7-e）', offender.length === 0, offender.length ? offender.map(({ index, line }) => `${index}: ${line.trim().slice(0, 100)}`).join(' | ') : '0 处')
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. R18-KNOWN-05a：`--read-only` 必须是**真正只读**
//    · 写/判不出来的命令 ⇒ 执行前拒绝（READ_ONLY_COMMAND_REFUSED + executed:false）；
//      真实盘、暂存树、候选队列都不变；
//    · 正向证明只读的命令 ⇒ 能跑；执行后**不并入、不冻结候选**；
//    · 纯渲染函数 `readOnlyExecVerdict()` / `readOnlyScratchLayout()` 离线断言。
// ═══════════════════════════════════════════════════════════════════════════
section('5. R18-KNOWN-05a：`exec --read-only` 真正只读（拒绝写命令 / 不冻结候选）')

let skips = 0
function skip(name, evidence) {
  skips += 1
  process.stdout.write(`  ~ SKIP ${name}\n`)
  if (evidence !== undefined) process.stdout.write(`      原因: ${String(evidence).slice(0, 300)}\n`)
}

{
  const cliMod = await import('../src/cli.ts')
  check('导出 readOnlyExecVerdict（唯一判据入口）', typeof cliMod.readOnlyExecVerdict === 'function', typeof cliMod.readOnlyExecVerdict)
  const readOnlyCase = cliMod.readOnlyExecVerdict('cmd', ['/c', 'echo', 'hello'])
  check('对照：`cmd /c echo hello` 在 --read-only 下允许执行', readOnlyCase.allowed === true && readOnlyCase.risk === 'read-only', JSON.stringify(readOnlyCase))
  const writeCase = cliMod.readOnlyExecVerdict('cmd', ['/c', 'echo', 'x', '>', 'out.txt'])
  check('写命令（重定向）⇒ 拒绝（risk=write-capable）', writeCase.allowed === false && writeCase.risk !== 'read-only', JSON.stringify(writeCase))
  const indeterminateCase = cliMod.readOnlyExecVerdict('node', ['script.js'])
  check('判定不了（未知程序）⇒ 拒绝（fail-closed）', indeterminateCase.allowed === false && indeterminateCase.risk === 'indeterminate', JSON.stringify(indeterminateCase))
  check('拒绝码是结构化常量 READ_ONLY_COMMAND_REFUSED', cliMod.READ_ONLY_EXEC_REFUSED_CODE === 'READ_ONLY_COMMAND_REFUSED', cliMod.READ_ONLY_EXEC_REFUSED_CODE)
  const layout = cliMod.readOnlyScratchLayout('C:\\Temp\\ro-probe')
  check('一次性布局：stagingRoot 与 registryStageDir 分离且同属 scratch', layout.stagingRoot === 'C:\\Temp\\ro-probe' && layout.registryStageDir.startsWith('C:\\Temp\\ro-probe'), JSON.stringify(layout))
}

// ── 端到端（需要能建 store 的未受限会话；Low IL 会话会在 §0 预检就 SKIP）──
{
  const wsRO = freshDir('ws-readonly')
  const storeRO = join(ROOT, 'store-readonly')
  writeFileSync(join(wsRO, 'seed.txt'), 'SEED-V1\n')
  const readOnlyEnv = { WINSTAGE_SHIM_DIR: join(PKG, 'shim', 'out') }
  const statusBefore = runCli(['status', '--workspace', wsRO, '--json'], { storeRoot: storeRO })
  const pendingBefore = jsonOf(statusBefore.text)?.pendingCandidates

  // ① 写命令：执行前拒绝，executed=false，真实盘/候选不变
  {
    const r = runCli(['exec', '--workspace', wsRO, '--read-only', '--tier', 'TS', '--', 'cmd', '/c', 'echo', 'BAD', '>', 'bad.txt'], {
      storeRoot: storeRO,
    })
    check('写命令在 --read-only 下退出码 1', r.status === 1, `exit=${r.status} ${r.text.split(/\r?\n/)[0]?.slice(0, 160)}`)
    check('错误码 = READ_ONLY_COMMAND_REFUSED', r.text.includes('READ_ONLY_COMMAND_REFUSED'), r.text.split(/\r?\n/)[0]?.slice(0, 160))
    check(
      '错误载荷含 executed:false 与 commandRisk',
      /"executed":\s*false/.test(r.text) && /"commandRisk"/.test(r.text),
      r.text.split(/\r?\n/).slice(0, 4).join(' | ').slice(0, 220),
    )
    check('被拒命令没有在真实工作区产生文件', !existsSync(join(wsRO, 'bad.txt')), `exists=${existsSync(join(wsRO, 'bad.txt'))}`)
    const statusAfterReject = jsonOf(runCli(['status', '--workspace', wsRO, '--json'], { storeRoot: storeRO }).text)
    check('被拒命令不改变候选队列（pendingCandidates 不变）', statusAfterReject?.pendingCandidates === pendingBefore, `${pendingBefore} → ${statusAfterReject?.pendingCandidates}`)
  }

  // ② 只读命令：必须能跑；执行后不并入、不冻结候选；真实盘不变
  {
    const r = runCli(['exec', '--workspace', wsRO, '--read-only', '--tier', 'TS', '--json', '--', 'cmd', '/c', 'type', join(wsRO, 'seed.txt')], {
      storeRoot: storeRO,
      env: readOnlyEnv,
    })
    if (/SANDBOX_INIT_FAILED|SANDBOX_UNAVAILABLE|StageGuardUnavailableError/.test(r.text)) {
      skip('只读命令端到端执行（本会话初始化不了沙箱）', r.text.split(/\r?\n/)[0])
    } else {
      const payload = jsonOf(r.text)
      check('只读命令退出码 0 且 stdout 含 seed.txt 内容', r.status === 0 && /SEED-V1/.test(r.text), `exit=${r.status} | ${r.text.split(/\r?\n/).slice(-4).join(' | ').slice(0, 220)}`)
      check(
        '结果显式声明 readOnly.enforced / candidateFrozen=false',
        payload?.readOnly?.enforced === true && payload?.readOnly?.candidateFrozen === false,
        JSON.stringify(payload?.readOnly),
      )
      check(
        'capturedChanges=0 且 candidate.frozen=false（不并入、不冻结）',
        payload?.capturedChanges === 0 && payload?.candidate?.frozen === false,
        JSON.stringify({ capturedChanges: payload?.capturedChanges, candidate: payload?.candidate }),
      )
      check('真实工作区 seed.txt 未被改动', readFileSync(join(wsRO, 'seed.txt'), 'utf8') === 'SEED-V1\n', 'SEED-V1')
      const statusAfter = jsonOf(runCli(['status', '--workspace', wsRO, '--json'], { storeRoot: storeRO }).text)
      check('只读命令后候选队列仍为空', statusAfter?.pendingCandidates === 0, `pendingCandidates=${statusAfter?.pendingCandidates}`)
    }
  }
}

rmSync(ROOT, { recursive: true, force: true })
process.stdout.write('\n========================================================================\n')
process.stdout.write(
  `CLI 契约（help 退出码/子命令参数/候选错误/workspace 校验/store 根/档位行/字典/--read-only）：断言 ${assertions} 项，失败 ${failures} 项${skips ? `，SKIP ${skips} 项` : ''}\n`,
)
process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}${skips ? ` skips=${skips}` : ''} mode=normal\n`)
process.exit(failures === 0 ? 0 : 1)
