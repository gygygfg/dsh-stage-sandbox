// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * 装配层「开关判定」—— WinStage 此刻是否应当接管执行面/文件面。
 *
 * ── 为什么单独一个模块（这是本轮修掉的结构性缺口）──────────────────────────────
 * 设置页那个开关的值**落在 profile 覆盖层** `<DSH_HOME>/profiles/<DSH_PROFILE>/cordis.patch.yml`
 * 的 `id: winstage-sandbox` 行的 `config.enabled` 上（实测：该文件里逐字写着 `enabled: false`）。
 *
 * 而 bundle 层（`cordis.patch.yml`）的**行装载决策**发生在 profile 覆盖层**之前**，
 * 拿不到"组合后的 config" ⇒ 无法直接知道开关是开是关。于是历史上只能靠一个
 * **环境变量** `WINSTAGE_SHELL` 做环境级门控；一旦某个 profile 用**字面量**
 * 覆盖 `disabled`（3080 的 web profile 就是这么做的），
 * 那个门控就被静默绕过 ⇒ WinStage **永远**占着 `ctx.shell`，
 * 哪怕开关是关的、哪怕档位是 `danger-full-access`。
 * 后果实测：每一条 `pwsh` 都被拒 ⇒ 用户感知"关了沙箱 shell 全废"。
 *
 * ── 本轮修复（R17 · P0）：profile 定位不再只靠进程环境变量 ─────────────────────
 * 上一轮只认 `process.env.DSH_HOME` / `process.env.DSH_PROFILE`。**宿主进程没有这两个
 * 变量**（实测：DSH desktop host PID 11028 的 PEB 环境里 50 项、只有
 * `DSH_CLIENT_VERSION`，没有 DSH_HOME/DSH_PROFILE；这两个变量是 Harness 给**工具子进程**
 * 注入的，不是宿主自己的）。于是读取段落进 `catch`/`!p` 分支 ⇒ fail-safe 返回 `true`
 * ⇒ **开关写着 `enabled: false`，命令面仍被 WinStage 接管**（真实缺陷，证据见
 * `.lead/findings/cordis-auditor.md`）。
 *
 * 现在读取段的**第一优先来源是 `ctx.baseUrl`**：`dsh-app-boot` 的 `boot()` 逐字执行
 *   `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"`
 * （`.lead/asar/.../dsh-app-boot/lib/index.js:4525`），而 desktop 的
 *   `absoluteConfigPath = join(profile.dir, "cordis.yml")`
 * （`dsh/lib/profile-boot-*.js:289` → `:302` `boot(NAME, rootConfig, …)`）
 * ⇒ `ctx.baseUrl` = `<profile.dir>/` 的 file URL ⇒
 *   `new URL('cordis.patch.yml', ctx.baseUrl)` 精确指向 profile 覆盖层。
 * 这条链路在 loader 的 `!!js` 求值处可用：`Entry.ctx` 继承 `Loader.ctx`
 * （`cordis-plugin-loader/lib/index.js:133/322`），`Entry.disabledOf()` → `evaluate(this.ctx, …)`
 * （`:347-352`）就是 `with (ctx) { eval(expr) }`（`:233-237`）。**实测**（干净进程 + 真
 * `@deepseek-ai/cordis` Loader + 真 Entry）：表达式里 `ctx.baseUrl` 逐字等于
 * `file:///C:/Users/12075/.dsh/profiles/desktop/`（日志 `.lead/logs/cordis-auditor/gate-probe.log` E2）。
 *
 * 读取顺序（`PROFILE_SWITCH_READER_SOURCE`，YAML 内联与本模块**逐字共享**）：
 *   1. `ctx.baseUrl` ⇒ `<profile>/cordis.patch.yml`（宿主真实路径，**首选**）；
 *   2. `process.env.DSH_HOME` + `DSH_PROFILE`（CLI / 自测 / 工具子进程的兼容回退）；
 *   3. 都拿不到 / 文件不存在 / 正则不匹配 ⇒ **fail-safe 返回 `true`**（= 接管）。
 *      fail-safe 方向**刻意保持不变**：把"读不懂"解释成"关闭"会让用户静默失去沙箱。
 *      推论：`ctx.baseUrl` 与 env 都没有时仍会接管 —— 这是本轮**保留**的行为，回归测试
 *      `tests/assembly-toggle-selftest.ts` 的 B 段把它钉成"刻意 fail-safe"，不要改反。
 *
 * ── 本模块做什么 ───────────────────────────────────────────────────────────────
 * 用**纯文本 + 正则**从 profile 覆盖层读出 `enabled` 的布尔值：
 *   - 不解析 YAML（避免在 loader 求值表达式里引入解析器依赖与失败面）；
 *   - 只认 `id: winstage-sandbox` 这一段内的**第一个** `enabled: true|false`；
 *   - 输出**接管布尔**（`true` = WinStage 接管）。
 *
 * 该判定同时被两处使用，保证**唯一真源**：
 *   1. bundle 的 `cordis.patch.yml` 里 `!!js` 内联（**必须内联**，见下）；
 *   2. 本模块的 `winStageEnabledFromProfile()` / `shellProviderPlan()`（纯函数，回归测试直接
 *      import；与 YAML 内联表达式在 env × ctx.baseUrl × profile 三态矩阵上**逐格对拍**）。
 *
 * ── 为什么 YAML 里的 `!!js` 不能 import 本模块 ──────────────────────────────────
 * `!!js` 的求值器是 `new Function('ctx','expr','with (ctx) { return eval(expr) }')`
 * （`cordis-plugin-loader/src/config/utils.ts:5-9`），**同步**求值，
 * 而 `import()` 返回 Promise ⇒ 无法在其中 `await`。
 * 且实测该作用域内 **`require` 不可用**（`typeof require === 'undefined'`），
 * 唯一可用的读文件通道是 `process.getBuiltinModule('node:fs')`。
 * 因此 YAML 里必须写一段**内联**的等价判定；两处逻辑必须保持一致。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * YAML 两行 `disabled: !!js` 共用的**读取段源码**（逐字内联；回归测试断言两条表达式都包含它）。
 *
 * 约束（有回归门钉住，别改坏）：
 *   · 单行、不含 `: `（冒号+空格）—— YAML 会把 `disabled` 解析成映射而不是布尔；
 *   · 以 `(` 开头（`!!js !(...)` 不是合法 YAML：行首 `!` 会被当成第二个标签）；
 *   · 只用 `process` / `ctx` / 全局 `URL`，**不用 `require`**（loader 求值作用域里没有）。
 */
export const PROFILE_SWITCH_READER_SOURCE =
  "(() => { try { const fs = process.getBuiltinModule('node:fs'); let p = null; if (process.env.DSH_HOME && process.env.DSH_PROFILE) p = process.env.DSH_HOME + '/profiles/' + process.env.DSH_PROFILE + '/cordis.patch.yml'; try { if (ctx && typeof ctx.baseUrl === 'string' && ctx.baseUrl.length > 0) p = new URL('cordis.patch.yml', ctx.baseUrl) } catch {} if (!p) return true; if (!fs.existsSync(p)) return true; const m = /id:\\s*winstage-sandbox\\b([\\s\\S]*?)(?=\\s*-\\s*id:|\\s*$)/.exec(fs.readFileSync(p, 'utf8')); if (!m) return true; const e = /enabled:\\s*(true|false)\\b/.exec(m[1]); return !e || e[1] !== 'false' } catch { return true } })()"

/** profile 覆盖层的路径（env 回退来源；DSH 的层序：bundle → profile → home → overlays） */
export function profilePatchPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : undefined
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : undefined
  if (!home || !profile) return undefined
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 从 loader 的 `ctx.baseUrl` 解析 profile 覆盖层路径（**首选来源**）。
 *
 * `ctx.baseUrl` 是 app-boot `boot()` 用 profile 根配置的目录设的 file URL
 * （`<profile.dir>/cordis.yml` 的 dirname），因此 `cordis.patch.yml` 与它同目录。
 * 不是合法 file URL ⇒ `undefined`（交给 env 回退 / fail-safe）。
 *
 * @param {string|undefined} baseUrl
 * @returns {string|undefined}
 */
export function profilePatchPathFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  try {
    return fileURLToPath(new URL('cordis.patch.yml', baseUrl))
  } catch {
    return undefined
  }
}

/**
 * 解析 profile 覆盖层位置：`ctx.baseUrl` 优先，`DSH_HOME`/`DSH_PROFILE` 回退。
 *
 * @param {{baseUrl?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{path: string, source: 'ctx.baseUrl'|'env'}|undefined} 两源都不可用 ⇒ `undefined`
 */
export function resolveProfilePatchPath({ baseUrl, env = process.env } = {}) {
  const fromBase = profilePatchPathFromBaseUrl(baseUrl)
  if (fromBase) return { path: fromBase, source: 'ctx.baseUrl' }
  const fromEnv = profilePatchPath(env)
  if (fromEnv) return { path: fromEnv, source: 'env' }
  return undefined
}

/**
 * 从一份 entry-list YAML **文本**里判定 `id: winstage-sandbox` 行的 `config.enabled`。
 * @param {string} source
 * @returns {boolean} `true` = WinStage 接管；判不出也返回 `true`（fail-safe 见文件头）
 */
export function winStageEnabledInProfileText(source) {
  if (typeof source !== 'string' || source.length === 0) return true
  // 只取 `id: winstage-sandbox` 之后、下一个 `- id:` 之前的那一段
  const section = /id:\s*winstage-sandbox\b([\s\S]*?)(?=\n\s*-\s*id:|\s*$)/.exec(source)
  if (!section) return true
  const hit = /enabled:\s*(true|false)\b/.exec(section[1])
  if (!hit) return true
  return hit[1] !== 'false'
}

/**
 * 读 profile 覆盖层并判定。**读不到文件/两源都不可用/读失败也返回 `true`**（fail-safe）。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [baseUrl] loader `ctx.baseUrl`（首选；`undefined` 时只看 env）
 * @returns {boolean}
 */
export function winStageEnabledFromProfile(env = process.env, baseUrl) {
  try {
    const resolved = resolveProfilePatchPath({ baseUrl, env })
    if (!resolved || !existsSync(resolved.path)) return true
    return winStageEnabledInProfileText(readFileSync(resolved.path, 'utf8'))
  } catch {
    return true
  }
}

/**
 * 装配层择一计划（纯函数，供回归测试与文档共用；**唯一口径**，别在别处另写一份）。
 *
 * 与 YAML 两条 `disabled: !!js` 逐字等价：
 *   · `on = (WINSTAGE_SHELL !== '0') && (WINSTAGE_SHELL === '1' || winStageEnabledFromProfile(...))`
 *   · `pwsh-sandbox.disabled = on`；`winstage-shell.disabled = !on`
 * ⇒ `on` 为真时**恰好一个**提供方启用（`ctx.shell` 单例安全）。
 *
 * @param {{env?: NodeJS.ProcessEnv, baseUrl?: string}} [options]
 * @returns {{on: boolean, pwshDisabled: boolean, shellDisabled: boolean, forcedByEnv: boolean}}
 */
export function shellProviderPlan({ env = process.env, baseUrl } = {}) {
  const forced = typeof env.WINSTAGE_SHELL === 'string' ? env.WINSTAGE_SHELL : undefined
  const fromProfile = winStageEnabledFromProfile(env, baseUrl)
  const on = forced !== '0' && (forced === '1' || fromProfile)
  return { on, pwshDisabled: on, shellDisabled: !on, forcedByEnv: forced === '0' || forced === '1' }
}
