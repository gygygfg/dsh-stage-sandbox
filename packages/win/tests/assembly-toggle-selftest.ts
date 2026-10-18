// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * assembly-toggle-selftest —— 装配层"shell 提供方择一"的离线确定性回归。
 *
 * ── 它守的是什么（缺陷本源）──────────────────────────────────────────────────
 * `ctx.shell` 是**单例服务名**：`dsh-plugin/cordis.patch.yml` 里
 *   · `pwsh-sandbox`（平台）与
 *   · `winstage-shell`（本沙箱）
 * 必须**恰好一个**处于启用态。两个都禁用 ⇒ `ctx.shell` 服务缺失（所有 shell 命令不可用）；
 * 两个都启用 ⇒ cordis 重复注册服务（插件加载即失败）。而这两个"禁用"开关是两条
 * 各自独立的 `!!js` 表达式，写在 YAML 文本里、**没有任何编译期约束**把它们绑在一起 ——
 * 只改其中一条是本项目最容易犯、也最难在运行期看出来的错（症状是"某个开关组合下 shell 整个消失"）。
 *
 * 本轮真实踩到的坑，本套件逐一钉住：
 *   ① 门控口径：旧表达式要求**进程环境变量** `WINSTAGE_SHELL=1` ⇒ 第二实例从未设过它，
 *      `winstage-shell` **永远不装载**，"沙箱开着但 shell 面是平台的" ⇒ 注册表写只剩内核硬拒。
 *      现口径：profile 开关是唯一权威，`WINSTAGE_SHELL=1`/`=0` 只作诊断强制。
 *   ② YAML 形态：`disabled: !!js !(...)` **不是合法 YAML** —— 行首的 `!` 会被解析成
 *      **第二个标签**，报 `YAMLException: duplication of a tag property (…)`，
 *      后果是**整条 bundle patch 被跳过**（实测：`dsh2.err.log` 里
 *      `failed to parse overlay … YAMLException` + `4 entries did not activate`）。
 *      因此表达式标量必须以 `(` 开头 —— 本套件用文本断言钉住这条。
 *      另一个同源坑：表达式里出现 `: `（冒号+空格）会被 YAML 当成**映射键分隔符**
 *      ⇒ `disabled` 变成对象而不是布尔（实测 dump `{'[object Object]': …}`）——
 *      **本轮真的踩中过**（三元 `… : null`），A6 就是为它加的。
 *   ③ **R17 · P0（本轮真实缺陷）**：profile 覆盖层的定位只认 `process.env.DSH_HOME/DSH_PROFILE`，
 *      而**宿主进程根本没有这两个变量**（实测 DSH desktop host 的 PEB 环境 50 项里只有
 *      `DSH_CLIENT_VERSION`；这两个 env 是 Harness 给**工具子进程**注入的）⇒ 读取段走
 *      fail-safe(true) ⇒ **开关 `enabled: false` 时命令面仍被 WinStage 接管**。
 *      现口径：**`ctx.baseUrl` 优先**（app-boot `boot()` 把它设成 profile 目录的 file URL，
 *      desktop 的 rootConfig = `<profile.dir>/cordis.yml`），env 仅作回退。
 *      B 段（host 形态矩阵）与 D 段（YAML × 模块纯函数逐格对拍）钉住它。
 *
 * ── 判据（都要求"能 FAIL"）──────────────────────────────────────────────────
 *   A. 文本形态：两行都存在；表达式以 `(` 开头；不含 `!!js !`、不含 `: `；
 *      两条表达式**逐字共享**同一段 profile 读取代码（`PROFILE_SWITCH_READER_SOURCE`）。
 *   B. **宿主真实形态**（ctx.baseUrl 有、DSH env 无）× profile {true, false, 缺失}：
 *      开关关 ⇒ 平台接管；开 ⇒ WinStage 接管；读不出 ⇒ fail-safe 接管。
 *   C. 优先级：ctx.baseUrl 与 env 指向**不同** profile 时，以 ctx.baseUrl 为准。
 *   D. 逐格对拍：YAML 两条表达式 vs `assembly-toggle.ts` 的 `shellProviderPlan()` /
 *      `winStageEnabledFromProfile()`，在 env {未设,1,0} × 来源 {baseUrl, env, 两无}
 *      × profile {true, false, 缺失} 上结果必须**逐格相同**（唯一真源不漂移）。
 *   E. 变异自证：把 shell 行极性改坏⇒"恰好一个"判据必须能红。
 *
 * 零子进程、零注册表、零网络 ⇒ 离线档，任何会话都能跑。
 *
 * 用法：node --import tsx tests\assembly-toggle-selftest.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import {
  PROFILE_SWITCH_READER_SOURCE,
  profilePatchPath,
  profilePatchPathFromBaseUrl,
  resolveProfilePatchPath,
  shellProviderPlan,
  winStageEnabledFromProfile,
} from '../dsh-plugin/assembly-toggle.ts'
import { switchEnabledFromRows } from '../dsh-plugin/host-plugin.ts'
import { installBaselineWatch } from '../dsh-plugin/baseline-watch.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const PATCH = join(REPO, 'dsh-plugin', 'cordis.patch.yml')
const SCRATCH = join(REPO, '.t', 'assembly-toggle-selftest')

let checks = 0
let failures = 0
function ok(condition, label, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  }
}

/** 取某一行（`- id: <id>`）之后**第一条** `disabled: !!js <expr>` 的表达式文本 */
function expressionFor(text, id) {
  const rowAt = text.indexOf(`- id: ${id}`)
  if (rowAt < 0) return undefined
  const tail = text.slice(rowAt)
  const match = /^[^\S\n]*disabled:\s*!!js\s+(.+)$/m.exec(tail)
  return match ? match[1].trim() : undefined
}

const require_ = createRequire(import.meta.url)

/**
 * 在**假的 `process` + 指定的 `ctx`** 下求值表达式。
 *
 * 为什么传假 `process` 而不是改真实环境：表达式读 `process.env` 与
 * `process.getBuiltinModule`；用参数遮蔽可以让矩阵各格互不干扰，且**不污染**本进程环境。
 *
 * 为什么用 `with (ctx)`：这就是 loader 的真实求值形态
 * （`cordis-plugin-loader/lib/index.js` 的 `evaluate = new Function('ctx','expr',
 * 'with (ctx) { return eval(expr) }')`）。用同形求值才能钉住 `ctx.baseUrl` 这条通路。
 */
function evaluate(expression, { env, ctx = {} }) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('process', 'ctx', `with (ctx) { return (${expression}); }`)
  return fn({ env, getBuiltinModule: (name) => require_(name) }, ctx)
}

process.stdout.write('=== assembly-toggle-selftest ===\n')
const text = readFileSync(PATCH, 'utf8')

// ── A. 文本形态 ──────────────────────────────────────────────────────────────
const pwshExpr = expressionFor(text, 'pwsh-sandbox')
const shellExpr = expressionFor(text, 'winstage-shell')

process.stdout.write('\n[A] 文本形态\n')
ok(typeof pwshExpr === 'string' && pwshExpr.length > 0, 'A1 `pwsh-sandbox` 行有一条 `disabled: !!js` 表达式')
ok(typeof shellExpr === 'string' && shellExpr.length > 0, 'A2 `winstage-shell` 行有一条 `disabled: !!js` 表达式')
ok(pwshExpr?.startsWith('(') === true, 'A3 pwsh 表达式标量以 `(` 开头（YAML：行首 `!` 会被当成第二个标签）', pwshExpr?.slice(0, 24))
ok(shellExpr?.startsWith('(') === true, 'A4 shell 表达式标量以 `(` 开头（同上）', shellExpr?.slice(0, 24))
ok(!/disabled:\s*!!js\s*!/.test(text), 'A5 全文不含 `!!js !`（已知会整条 bundle 被 YAML 解析失败跳过）')
ok(
  pwshExpr?.includes(': ') !== true && shellExpr?.includes(': ') !== true,
  'A6 两条表达式都不含 `: `（冒号+空格）：YAML 会把它当映射键分隔符 ⇒ `disabled` 变成对象而不是布尔（本轮真的踩中过三元 `… : null`）',
)
ok(
  PROFILE_SWITCH_READER_SOURCE.includes(': ') === false && PROFILE_SWITCH_READER_SOURCE.startsWith('(') === true,
  'A7 共享读取段自身满足同一形态约束（无 `: `/以 `(` 开头）',
)
ok(pwshExpr?.includes(PROFILE_SWITCH_READER_SOURCE) === true, 'A8 pwsh 表达式**逐字包含**共享读取段 `PROFILE_SWITCH_READER_SOURCE`')
ok(shellExpr?.includes(PROFILE_SWITCH_READER_SOURCE) === true, 'A9 shell 表达式**逐字包含**同一读取段（防只改一条）')
ok(
  pwshExpr?.includes("process.env.WINSTAGE_SHELL !== '0'") === true &&
    shellExpr?.includes("process.env.WINSTAGE_SHELL !== '0'") === true,
  'A10 两条表达式都认 `WINSTAGE_SHELL=0` 强制交还',
)
ok(
  pwshExpr?.includes("process.env.WINSTAGE_SHELL === '1'") === true &&
    shellExpr?.includes("process.env.WINSTAGE_SHELL === '1'") === true,
  'A11 两条表达式都认 `WINSTAGE_SHELL=1` 强制接管',
)
ok(
  PROFILE_SWITCH_READER_SOURCE.includes('ctx.baseUrl') === true,
  'A12 共享读取段以 `ctx.baseUrl` 为**首选**来源（R17 修复：宿主没有 DSH_HOME/DSH_PROFILE）',
)
ok(
  PROFILE_SWITCH_READER_SOURCE.includes('process.env.DSH_HOME') === true &&
    PROFILE_SWITCH_READER_SOURCE.includes('process.env.DSH_PROFILE') === true,
  'A13 共享读取段保留 env 回退（CLI / 自测 / 工具子进程）',
)

// ── B. 宿主真实形态（ctx.baseUrl 有、DSH env 无）─────────────────────────────
process.stdout.write('\n[B] 宿主真实形态矩阵（ctx.baseUrl 存在 + env 不含 DSH_HOME/DSH_PROFILE）\n')
mkdirSync(SCRATCH, { recursive: true })
function makeProfile(name, body) {
  const dir = join(SCRATCH, name.replace(/[^A-Za-z0-9_.-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cordis.patch.yml')
  if (body === null) rmSync(file, { force: true })
  else writeFileSync(file, `- id: winstage-sandbox\n  config:\n    ${body}`, 'utf8')
  return { dir, file, baseUrl: pathToFileURL(dir + '\\').href }
}
const hostEnv = {} // 宿主进程：只有 DSH_CLIENT_VERSION 之类，没有 DSH_HOME/DSH_PROFILE
const offProfile = makeProfile('off', 'enabled: false\n')
const onProfile = makeProfile('on', 'enabled: true\n')
const missingProfile = makeProfile('missing', null)
// env 回退来源：scratch home/profiles/{off,on}（B 段 env 回退用例在矩阵里就要能读到文件）
const SCRATCH_HOME = join(SCRATCH, 'home')
mkdirSync(join(SCRATCH_HOME, 'profiles', 'off'), { recursive: true })
mkdirSync(join(SCRATCH_HOME, 'profiles', 'on'), { recursive: true })
writeFileSync(join(SCRATCH_HOME, 'profiles', 'off', 'cordis.patch.yml'), '- id: winstage-sandbox\n  config:\n    enabled: false\n', 'utf8')
writeFileSync(join(SCRATCH_HOME, 'profiles', 'on', 'cordis.patch.yml'), '- id: winstage-sandbox\n  config:\n    enabled: true\n', 'utf8')

const hostCases = [
  ['host: baseUrl + enabled:false ⇒ 交还平台', offProfile.baseUrl, hostEnv, false],
  ['host: baseUrl + enabled:true ⇒ WinStage 接管', onProfile.baseUrl, hostEnv, true],
  ['host: baseUrl + profile 缺失 ⇒ fail-safe 接管', missingProfile.baseUrl, hostEnv, true],
  ['host: baseUrl 缺失 + env 有 + enabled:false ⇒ env 回退交还', undefined, { DSH_HOME: SCRATCH_HOME, DSH_PROFILE: 'off' }, false],
  ['host: baseUrl 与 env 都缺失 ⇒ fail-safe 接管', undefined, {}, true],
]
for (const [label, baseUrl, env, expectWinstage] of hostCases) {
  const pwshDisabled = evaluate(pwshExpr, { env, ctx: baseUrl === undefined ? {} : { baseUrl } })
  const shellDisabled = evaluate(shellExpr, { env, ctx: baseUrl === undefined ? {} : { baseUrl } })
  const winstage = shellDisabled === false
  const platform = pwshDisabled === false
  ok(winstage === expectWinstage, `B ${label}`, `platform=${platform} winstage=${winstage}`)
  ok(winstage !== platform, `B 恰好一个 shell 提供方启用 —— ${label}`, `platform=${platform} winstage=${winstage}`)
}

// env 回退要真的能读到：文件已在前面摆好（SCRATCH_HOME/profiles/{off,on}）
{
  const envFallback = { DSH_HOME: SCRATCH_HOME, DSH_PROFILE: 'off' }
  const shellDisabled = evaluate(shellExpr, { env: envFallback, ctx: {} })
  ok(shellDisabled === true, 'B env 回退路径确实读到了 profile 开关（enabled:false ⇒ shell 行禁用）', String(shellDisabled))
  ok(winStageEnabledFromProfile(envFallback) === false, 'B `winStageEnabledFromProfile(env)` 与 YAML 同结论')
}

// ── C. 优先级：ctx.baseUrl 胜过 env ──────────────────────────────────────────
process.stdout.write('\n[C] 来源优先级\n')
{
  const envOn = { DSH_HOME: join(SCRATCH, 'home'), DSH_PROFILE: 'on' }
  mkdirSync(join(SCRATCH, 'home', 'profiles', 'on'), { recursive: true })
  writeFileSync(join(SCRATCH, 'home', 'profiles', 'on', 'cordis.patch.yml'), '- id: winstage-sandbox\n  config:\n    enabled: true\n', 'utf8')
  const ctxOff = { baseUrl: offProfile.baseUrl }
  ok(evaluate(shellExpr, { env: envOn, ctx: ctxOff }) === true, 'C1 baseUrl(enabled:false) 与 env(enabled:true) 冲突时，以 baseUrl 为准（shell 行禁用）')
  ok(shellProviderPlan({ env: envOn, baseUrl: offProfile.baseUrl }).on === false, 'C2 模块纯函数与 C1 同结论')
  const resolved = resolveProfilePatchPath({ baseUrl: offProfile.baseUrl, env: envOn })
  ok(resolved?.source === 'ctx.baseUrl', 'C3 resolveProfilePatchPath 报告来源=ctx.baseUrl', JSON.stringify(resolved))
  ok(typeof resolved?.path === 'string' && resolved.path.endsWith('cordis.patch.yml'), 'C4 解出的路径指向 `cordis.patch.yml`', resolved?.path)
  ok(profilePatchPathFromBaseUrl(offProfile.baseUrl) === resolved?.path, 'C5 `profilePatchPathFromBaseUrl` 与解析器同源')
  ok(profilePatchPath({ DSH_HOME: 'C:\\dsh', DSH_PROFILE: 'p' }) === join('C:\\dsh', 'profiles', 'p', 'cordis.patch.yml'), 'C6 `profilePatchPath(env)` 保持原契约（env 回退路径不变）')
  ok(resolveProfilePatchPath({ env: {} }) === undefined, 'C7 两源都不可用 ⇒ undefined（调用方按 fail-safe 接管）')
}

// ── D. 逐格对拍：YAML 表达式 vs assembly-toggle 纯函数 ────────────────────────
process.stdout.write('\n[D] YAML 内联 × 模块纯函数逐格对拍\n')
const envStates = [
  ['env=unset', {}],
  ['env=1', { WINSTAGE_SHELL: '1' }],
  ['env=0', { WINSTAGE_SHELL: '0' }],
]
const sourceStates = [
  ['src=baseUrl(off)', { ctx: { baseUrl: offProfile.baseUrl } }],
  ['src=baseUrl(on)', { ctx: { baseUrl: onProfile.baseUrl } }],
  ['src=baseUrl(missing)', { ctx: { baseUrl: missingProfile.baseUrl } }],
  ['src=env(off)', { ctx: {}, env: { DSH_HOME: join(SCRATCH, 'home'), DSH_PROFILE: 'off' } }],
  ['src=env(on)', { ctx: {}, env: { DSH_HOME: join(SCRATCH, 'home'), DSH_PROFILE: 'on' } }],
  ['src=none', { ctx: {}, env: {} }],
]
for (const [envLabel, envBase] of envStates) {
  for (const [srcLabel, source] of sourceStates) {
    const env = { ...(source.env ?? {}), ...envBase }
    const ctx = source.ctx ?? {}
    const pwshDisabled = evaluate(pwshExpr, { env, ctx })
    const shellDisabled = evaluate(shellExpr, { env, ctx })
    const winstage = shellDisabled === false
    const platform = pwshDisabled === false
    const baseUrl = ctx.baseUrl
    const envForPlan = worldEnv(env)
    const plan = shellProviderPlan({ env: envForPlan, baseUrl })
    const label = `${envLabel} ${srcLabel}`
    ok(
      pwshDisabled === plan.pwshDisabled && shellDisabled === plan.shellDisabled,
      `D1 YAML 与模块纯函数逐格相同 —— ${label}`,
      `yaml=(${pwshDisabled},${shellDisabled}) module=(${plan.pwshDisabled},${plan.shellDisabled})`,
    )
    ok(winstage !== platform, `D2 恰好一个提供方 —— ${label}`, `platform=${platform} winstage=${winstage}`)
  }
}
/** 把矩阵里的"来源 env"与"强制 env"合并成纯函数需要的 env 形状（含 DSH_HOME/DSH_PROFILE 时保留） */
function worldEnv(env) {
  const out = { ...env }
  return out
}

// ── E. 变异自证（负面对照）─────────────────────────────────────────────────
process.stdout.write('\n[E] 变异自证（负面对照）\n')
{
  // 变异体 = 把平台行的表达式当成 shell 行（极性同向）⇒ "恰好一个"必须失败
  const env = {}
  const ctx = { baseUrl: offProfile.baseUrl }
  const mutatedShellDisabled = evaluate(pwshExpr, { env, ctx })
  const platform = evaluate(pwshExpr, { env, ctx }) === false
  const mutatedWinstage = mutatedShellDisabled === false
  ok(
    platform === mutatedWinstage,
    'E1 极性同向的变异体确实违反"恰好一个"（证明 B/D 段断言有分辨力）',
    `platform=${platform} mutatedWinstage=${mutatedWinstage}`,
  )
  // 变异体 = 退回"只认 env"的旧读取段（本轮 P0 原形态）⇒ 宿主形态下必须**误接管**
  const legacyReader =
    "(() => { try { const p = process.env.DSH_HOME + '/profiles/' + process.env.DSH_PROFILE + '/cordis.patch.yml'; const fs = process.getBuiltinModule('node:fs'); if (!fs.existsSync(p)) return true; const m = /id:\\s*winstage-sandbox\\b([\\s\\S]*?)(?=\\s*-\\s*id:|\\s*$)/.exec(fs.readFileSync(p, 'utf8')); if (!m) return true; const e = /enabled:\\s*(true|false)\\b/.exec(m[1]); return !e || e[1] !== 'false'; } catch { return true } })()"
  const legacyOn = evaluate(legacyReader, { env: {}, ctx })
  ok(
    legacyOn === true && shellProviderPlan({ env: {}, baseUrl: offProfile.baseUrl }).on === false,
    'E2 旧的"只认 env"读取段在同一宿主形态下**误判为接管**，新口径判为交还 ⇒ P0 回归有分辨力',
    `legacyOn=${legacyOn} newOn=${shellProviderPlan({ env: {}, baseUrl: offProfile.baseUrl }).on}`,
  )
}

// ── H. 宿主运行期开关读法（R17 P1：apply 快照 ≠ 活值）────────────────────────
process.stdout.write('\n[H] 宿主运行期开关：必须现读 loader 行表，不能读 apply 快照\n')
{
  // 行表（组合后 config）是唯一活源；这里只测纯函数读法，不启宿主。
  ok(switchEnabledFromRows([{ id: 'winstage-sandbox', config: { enabled: false } }]) === false, 'H1 行表 enabled:false ⇒ 关闭（活值读法）')
  ok(switchEnabledFromRows([{ id: 'winstage-sandbox', config: { enabled: true } }]) === true, 'H2 行表 enabled:true ⇒ 开启')
  ok(switchEnabledFromRows([{ id: 'winstage-sandbox' }]) === true, 'H3 行存在但无 config ⇒ 维持历史"接管"口径（与 fs 面一致）')
  ok(switchEnabledFromRows([{ id: 'other', config: { enabled: false } }]) === undefined, 'H4 行表里没有本行 ⇒ undefined（调用方回退 apply 参数）')
  ok(switchEnabledFromRows(undefined) === undefined && switchEnabledFromRows(null) === undefined, 'H5 没有行表（离线自测 / 非 cordis ctx）⇒ undefined')
  // 活值语义：同一个行数组对象被 EntryGroup.update 换新后，下一次读必须拿到新值（不缓存）
  const row = { id: 'winstage-sandbox', config: { enabled: false } }
  const rowsA = [row]
  const first = switchEnabledFromRows(rowsA)
  row.config = { enabled: true }
  const second = switchEnabledFromRows(rowsA)
  ok(first === false && second === true, 'H6 行表内容更新后同一读法立即看到新值（不缓存 ⇒ 设置页热写生效）', `first=${first} second=${second}`)
  const hostSrc = readFileSync(join(REPO, 'dsh-plugin', 'host-plugin.ts'), 'utf8')
  ok(
    /const isEnabled = \(\) => \{\s*\n\s*const fromRows = switchEnabledFromRows\(ctx\?\.fiber\?\.entry\?\.parent\?\.data\)/.test(hostSrc),
    'H7 `apply` 的 isEnabled 现读 `ctx.fiber.entry.parent.data`（R17 P1 修复接线）',
  )
  ok(
    /typeof fromRows === 'boolean' \? fromRows : config\.enabled !== false/.test(hostSrc),
    'H8 行表不可用时回退 apply 参数（离线自测 / 桩 ctx 不破）',
  )
  ok(
    !/const isEnabled = \(\) => config\.enabled !== false/.test(hostSrc),
    'H9 旧的"只读 apply 快照"写法不得复活（那是运行中关掉开关仍执行命令的根因）',
  )
}

// ── I. R18 · KNOWN-08a：baseline-watch 随开关启停（运行期闸门 + dispose 对称）────
// 缺陷：轮询在 apply 期按当时开关装配一次 ⇒ 运行中关掉开关后定时器继续只读扫描；
// 关闭态启动后再打开又永远不恢复（要重启）。修法：恒装配，把现读开关真值交给
// watcher —— 开=轮询、关=clearInterval 停轮询(零 IO)+轻量恢复检查、重开=自动恢复。
// 这里用**假定时器**驱动，断言 start/stop 次数、关态零 tick、恢复、dispose 清理。
process.stdout.write('\n[I] R18 KNOWN-08a：baseline-watch 随开关启停\n')
{
  function makeFakeTimers() {
    let seq = 1
    const intervals = new Map()
    const timeouts = new Map()
    const stats = { intervalCreated: 0, intervalCleared: 0, timeoutCreated: 0, timeoutCleared: 0, unref: 0, interrupted: false }
    const handle = (fn, ms, kind) => ({
      id: seq++,
      kind,
      ms,
      fn,
      unref() {
        stats.unref += 1
        return this
      },
    })
    const timers = {
      setInterval(fn, ms) {
        const h = handle(fn, ms, 'interval')
        intervals.set(h.id, h)
        stats.intervalCreated += 1
        return h
      },
      clearInterval(h) {
        if (h && intervals.delete(h.id)) stats.intervalCleared += 1
      },
      setTimeout(fn, ms) {
        const h = handle(fn, ms, 'timeout')
        timeouts.set(h.id, h)
        stats.timeoutCreated += 1
        return h
      },
      clearTimeout(h) {
        if (h && timeouts.delete(h.id)) stats.timeoutCleared += 1
      },
    }
    return {
      timers,
      stats,
      intervals,
      timeouts,
      fireInterval() {
        const [h] = [...intervals.values()]
        if (h) h.fn()
      },
      fireTimeout() {
        const [h] = [...timeouts.values()]
        if (!h) return
        timeouts.delete(h.id)
        h.fn()
      },
    }
  }

  let enabled = true
  let isEnabledCalls = 0
  let tickCount = 0
  const env = { WINSTAGE_WATCH_MS: '1500' }
  const fake = makeFakeTimers()
  const watcher = installBaselineWatch({}, {
    workspaceRoot: SCRATCH,
    env,
    timers: fake.timers,
    tick: () => {
      tickCount += 1
      return 1
    },
    isEnabled: () => {
      isEnabledCalls += 1
      return enabled
    },
  })

  ok(fake.stats.intervalCreated === 1 && fake.stats.timeoutCreated === 0, 'I1 开态装配 ⇒ 起 1 个轮询 interval（无恢复检查）', JSON.stringify(fake.stats))
  ok(fake.timers && watcher.isPolling() === true, 'I2 isPolling()=true（可判定的运行态）')
  ok(fake.stats.unref >= 1, 'I3 定时器调用 unref（不把进程钉住）', String(fake.stats.unref))
  fake.fireInterval()
  fake.fireInterval()
  ok(tickCount === 2, 'I4 开态每拍真的执行复核 tick', `tickCount=${tickCount}`)

  // 运行中关掉：下一拍必须停轮询 + 转恢复检查，且**这一拍不执行 tick**
  enabled = false
  fake.fireInterval()
  ok(fake.stats.intervalCleared === 1 && watcher.isPolling() === false, 'I5 关态下一拍 ⇒ interval 被 clearInterval（轮询停止）', JSON.stringify(fake.stats))
  ok(tickCount === 2, 'I6 关态那一拍**零 IO**：tick 没有被调用', `tickCount=${tickCount}`)
  ok(watcher.resumeScheduled() === true && fake.stats.timeoutCreated === 1, 'I7 关态挂 1 个轻量恢复检查（只判开关，不碰文件）')

  // 仍然关着：恢复检查不重启轮询，只是重排
  fake.fireTimeout()
  ok(watcher.isPolling() === false && fake.stats.intervalCreated === 1 && watcher.resumeScheduled() === true, 'I8 仍关着 ⇒ 恢复检查重排、不重启轮询', JSON.stringify(fake.stats))

  // 重新打开：恢复检查在下一拍恢复轮询（不需要重启宿主）
  enabled = true
  fake.fireTimeout()
  ok(watcher.isPolling() === true && fake.stats.intervalCreated === 2 && watcher.resumeScheduled() === false, 'I9 重新打开 ⇒ 自动恢复轮询（interval#2）', JSON.stringify(fake.stats))
  fake.fireInterval()
  ok(tickCount === 3, 'I10 恢复后 tick 继续执行', `tickCount=${tickCount}`)

  // dispose 对称：两个定时器都被清掉，之后任何恢复检查都不再启动
  watcher.stop()
  ok(watcher.disposed() === true && watcher.isPolling() === false && watcher.resumeScheduled() === false, 'I11 stop() 后无轮询、无恢复检查（dispose 对称）')
  ok(fake.intervals.size === 0 && fake.timeouts.size === 0, 'I12 stop() 后假定时器表为空（没有遗留句柄）', `i=${fake.intervals.size} t=${fake.timeouts.size}`)

  // 关闭态启动 ⇒ 不轮询（零 IO），但保留恢复检查
  {
    const fake2 = makeFakeTimers()
    let ticks = 0
    const w2 = installBaselineWatch({}, {
      workspaceRoot: SCRATCH,
      env,
      timers: fake2.timers,
      tick: () => {
        ticks += 1
        return 0
      },
      isEnabled: () => false,
    })
    ok(fake2.stats.intervalCreated === 0 && w2.isPolling() === false, 'I13 关闭态启动 ⇒ 不起轮询（零后台 IO）', JSON.stringify(fake2.stats))
    ok(w2.resumeScheduled() === true && fake2.stats.timeoutCreated === 1, 'I14 关闭态启动仍保留恢复检查（重新打开可恢复）')
    w2.stop()
  }

  // ctx.effect 持有：disposer 真的清掉两个定时器（Cordis 卸载协议）
  {
    const fake3 = makeFakeTimers()
    const disposers = []
    const ctx = { effect: (fn) => disposers.push(fn()) }
    let enabled3 = true
    const w3 = installBaselineWatch(ctx, {
      workspaceRoot: SCRATCH,
      env,
      timers: fake3.timers,
      tick: () => 1,
      isEnabled: () => enabled3,
    })
    ok(disposers.length === 1 && typeof disposers[0] === 'function', 'I15 watcher 由 ctx.effect 持有（返回 disposer）')
    enabled3 = false
    fake3.fireInterval() // 关态 → 停轮询 + 恢复检查
    ok(fake3.intervals.size === 0 && fake3.timeouts.size === 1, 'I16 关态时只剩恢复检查句柄', `i=${fake3.intervals.size} t=${fake3.timeouts.size}`)
    disposers[0]() // = 卸载
    ok(w3.disposed() === true && fake3.intervals.size === 0 && fake3.timeouts.size === 0, 'I17 卸载（disposer）⇒ 轮询与恢复检查全部清理（dispose 对称）')
  }

  // fail-safe：开关判定抛错 ⇒ 继续轮询（绝不静默停掉可见性复核）
  {
    const fake4 = makeFakeTimers()
    let ticks = 0
    const w4 = installBaselineWatch({}, {
      workspaceRoot: SCRATCH,
      env,
      timers: fake4.timers,
      tick: () => {
        ticks += 1
        return 1
      },
      isEnabled: () => {
        throw new Error('switch-unreadable')
      },
    })
    ok(w4.isPolling() === true, 'I18 开关判定抛错 ⇒ fail-safe 继续轮询（不静默停复核）')
    fake4.fireInterval()
    ok(ticks === 1 && w4.isPolling() === true, 'I19 抛错后一拍仍执行 tick')
    w4.stop()
  }

  // 静态接线：host-plugin 不能再按 apply 期开关装配；必须把 isEnabled 传给 watcher
  const hostSrc2 = readFileSync(join(REPO, 'dsh-plugin', 'host-plugin.ts'), 'utf8')
  ok(!/if \(isEnabled\(\)\) \{\s*\n\s*installBaselineWatch/.test(hostSrc2), 'I20 host-plugin 不得再"只在开态装配"（旧缺陷形态）')
  ok(/installBaselineWatch\(ctx, \{[\s\S]{0,300}isEnabled,/.test(hostSrc2), 'I21 host-plugin 把现读开关 isEnabled 交给 watcher')
}

const failed = failures > 0
process.stdout.write(`\n断言 ${checks} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'} (${checks} checks)\n`)
process.exit(failed ? 1 : 0)