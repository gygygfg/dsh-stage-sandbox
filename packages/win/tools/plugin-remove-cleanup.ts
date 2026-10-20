// @ts-nocheck —— 运维工具：纯 node:fs，无第三方依赖（避免给 profile 引入包）。
/**
 * 工具：`tools/plugin-remove-cleanup.ts` —— **R25-B / R21-LC-04 收口**
 * `dsh plugin remove dsh-winstage-sandbox` **之后**的 profile `node_modules` 残留清理。
 *
 * ── 存在理由（R21 G5b 实测）────────────────────────────────────────────────────
 * `dsh plugin --profile <p> remove dsh-winstage-sandbox` 成功后，**依赖与 `dsh.profile.bundles`
 * 都已恢复**（`--dump-config` 0 行、宿主重启后 `/winstage-panel` 路由 404），但 pnpm 对
 * `link:` 依赖**只从 manifest/lock 移除、不删 `node_modules` 里的链接** ⇒ 残留：
 *
 *     <DSH_HOME>/profiles/<p>/node_modules/dsh-winstage-sandbox   （Windows Junction → 本地包目录）
 *
 * 这不是"插件还在跑"，而是**文件面残留**：它让 `pnpm install`/重装/审计的语义变脏，也让
 * "卸载后无残留"这句话不成立。本工具把它变成一次**显式、可预览、可复核**的清理动作。
 *
 * ── 它做什么 / 不做什么 ──────────────────────────────────────────────────────
 * 做（**只处理 `dsh-winstage-sandbox` 与可证明属于它的 `node_modules/.pnpm` 链接条目**）：
 *   1. 找到 profile `node_modules` 下的候选：
 *      · `node_modules/dsh-winstage-sandbox`
 *      · `node_modules/.pnpm/node_modules/dsh-winstage-sandbox`
 *      · `node_modules/.pnpm/dsh-winstage-sandbox` / `…@<版本>`（pnpm store 条目）
 *   2. **只删链接本身**（reparse point / symlink / junction）：`unlinkSync`，失败时退回
 *      `rmdirSync`（Windows junction 是"空目录型重解析点"）；**绝不递归**、**绝不跟随目标**
 *      ⇒ 真实包目录（`packages/win`）一字节不动。
 *   3. 逐条报告动作与结果；删除后 `lstat` 复核"确实不存在"。
 *
 * 不做：
 *   · 不碰 profile 覆盖层 / home 层 patch（那是 `tools/uninstall-restore.ts` 的职责）；
 *   · 不碰 `package.json` / `pnpm-lock.yaml` / `.modules.yaml`（宿主/pnpm 的记账，删了只会更脏）；
 *   · 不删任何**非链接**的实体文件/目录（名字匹配也拒绝 —— 见护栏 `not-a-link`）；
 *   · **不解决** R21-LC-05：二次 `dsh plugin remove` 仍会 exit 1
 *     （`ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS`，pnpm/宿主 CLI 行为）。本工具与它正交：
 *     先按正常方式 remove（哪怕它非零），再用本工具清残留即可。
 *
 * ── 安全护栏（任何一条不满足都**不做删除**）─────────────────────────────────────
 *   G1. `--profile` 必须指向**已初始化**的 profile（含 `package.json`），名字不允许路径穿越；
 *   G2. **插件仍在装配/仍在依赖里 ⇒ 拒绝**（exit 2）：`dsh.profile.bundles` 或 `dependencies`
 *       仍列出 `dsh-winstage-sandbox`，或 profile/home 覆盖层仍含 `winstage-*` loader 行。
 *       正确顺序永远是：**先 `dsh plugin remove`，再跑本工具**。
 *   G3. 候选路径（词法解析后）必须**严格位于** `<profile>/node_modules` 内；
 *       候选的**父目录 realpath** 也必须在 `node_modules` realpath 之内（防 `..`/父级 junction 逃逸）；
 *   G4. 只处理 `lstat().isSymbolicLink() === true` 的候选；实体目录/文件 ⇒ 记 `not-a-link` **拒绝删除**。
 *
 * ── 退出码 ───────────────────────────────────────────────────────────────────
 *   0  无需清理 / dry-run 成功 / apply 全部成功（含 `nothing-to-do` 幂等）
 *   1  用法错误、profile 定位失败、或删除/复核失败（**如实非零**，逐条明细）
 *   2  安全护栏拒绝（插件仍装配 ⇒ 先 remove；见 G2）
 *
 * 用法：
 *   node tools/plugin-remove-cleanup.ts --profile desktop                # 预览（默认 --dry-run）
 *   node tools/plugin-remove-cleanup.ts --profile desktop --apply        # 实际删除链接
 *   node tools/plugin-remove-cleanup.ts --home <dir> --profile <p> --json
 *   node tools/plugin-remove-cleanup.ts --profile <p> --help
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本插件在 profile 里的包名（与 `dsh.profile.bundles` / dependencies 同名） */
export const PLUGIN_NAME = 'dsh-winstage-sandbox'

/** 本插件 bundle 引入的 loader 行 id（出现在 profile/home 覆盖层里 = 仍在装配） */
export const PLUGIN_LOADER_IDS = Object.freeze(['winstage-sandbox', 'winstage-fs', 'winstage-shell'])

/** 允许的 profile 名（与 DSH `resolveProfileDir` 同一纪律：单段、非保留名） */
function validProfileName(name) {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && name !== 'node_modules' && !/[\\/]/.test(name)
}

/** 宽松 JSON 读取（缺失/坏 JSON 都不抛） */
function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { ok: false, code: error?.code === 'ENOENT' ? 'missing' : 'invalid', detail: String(error?.message ?? error) }
  }
}

function readTextOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 覆盖层文本里是否含本插件的 loader 行。
 * 判据刻意只用"顶层条目行"（`- id: <one of PLUGIN_LOADER_IDS>`），不误伤注释/普通字符串。
 */
export function patchMentionsPlugin(text) {
  const ids = PLUGIN_LOADER_IDS.join('|')
  return new RegExp(`^[ \\t]*-[ \\t]+id:[ \\t]*(?:${ids})\\b`, 'm').test(String(text ?? ''))
}

/** 规范化比较键（Windows 大小写不敏感；其余平台原样） */
function compareKey(path) {
  const resolved = resolve(String(path))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** `candidate` 是否**严格位于** `root` 之内（词法；不跟随链接） */
export function isContainedIn(root, candidate) {
  const r = compareKey(root)
  const c = compareKey(candidate)
  if (c === r) return false
  return c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`)
}

/** `candidate` 的父目录是否与 `root` 相同或在其内（词法；用于"父级"判定） */
function isSameOrInside(root, candidate) {
  const r = compareKey(root)
  const c = compareKey(candidate)
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`)
}

/**
 * 父目录 realpath 是否仍在 `nodeModulesDir` 的 realpath 内（防父级 junction / `..` 逃逸）。
 * 候选自身是链接，**绝不** realpath 候选（那会跟随目标，正是本工具要避免的）。
 */
export function parentRealpathInside(nodeModulesDir, candidate) {
  try {
    const nmReal = realpathSync(nodeModulesDir)
    const parentReal = realpathSync(dirname(candidate))
    return isSameOrInside(nmReal, parentReal)
  } catch {
    return false
  }
}

/** 解析 `--home`（显式 > `DSH_HOME` > `%USERPROFILE%/.dsh`） */
export function resolveHome({ home, env = process.env } = {}) {
  if (typeof home === 'string' && home.trim().length > 0) return { ok: true, home: resolve(home.trim()), source: 'flag' }
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0) return { ok: true, home: resolve(env.DSH_HOME.trim()), source: 'env' }
  const userProfile = env?.USERPROFILE ?? env?.HOME
  if (typeof userProfile === 'string' && userProfile.length > 0) return { ok: true, home: join(userProfile, '.dsh'), source: 'userprofile' }
  return { ok: false, code: 'no-home', message: '定位失败：既没有 --home，也推导不出 DSH_HOME/USERPROFILE。' }
}

/** 解析 profile 目录；不存在/未初始化 ⇒ 明确失败（绝不猜） */
export function resolveProfileDir({ home, profile }) {
  const nameError = validateProfileName(profile)
  if (nameError !== undefined) return { ok: false, code: 'bad-profile', message: nameError }
  const dir = join(home, 'profiles', profile)
  if (!existsSync(join(dir, 'package.json')))
    return {
      ok: false,
      code: 'no-profile',
      dir,
      message: `没有找到已初始化的 profile：${dir}（缺 package.json）。先按正常方式初始化/安装再卸载：dsh plugin --profile ${profile} add <pkg>`,
    }
  return { ok: true, dir }
}

export function validateProfileName(profile) {
  if (typeof profile !== 'string' || profile.trim().length === 0) return '缺少 --profile <name>（或 DSH_PROFILE 环境变量）。'
  if (!validProfileName(profile.trim())) return `非法 profile 名：${JSON.stringify(profile)}（不允许路径分隔符 / "." / ".." / "node_modules"）。`
  return undefined
}

/**
 * G2：插件是否仍"装配/依赖中"（此时**拒绝**清理；正确顺序是先 `dsh plugin remove`）。
 *
 * 三层判据（任一命中即拒绝）：
 *   1. profile `package.json` 的 `dependencies` 仍列出本包（安装态）；
 *   2. profile `package.json` 的 `dsh.profile.bundles` 仍列出本包（装配态）；
 *   3. profile 覆盖层或 home 级 `<DSH_HOME>/cordis.patch.yml` 仍含 `winstage-*` loader 行
 *      （用户层把插件行抄进去的情形；那是 `uninstall-restore` 的职责）。
 *
 * @returns {{installed: boolean, reasons: Array<{layer: string, code: string, detail?: string}>}}
 */
export function inspectStillInstalled({ profileDir, home }) {
  const reasons = []
  const manifest = readJson(join(profileDir, 'package.json'))
  if (manifest.ok) {
    const dependencies = manifest.value?.dependencies ?? {}
    if (Object.prototype.hasOwnProperty.call(dependencies, PLUGIN_NAME))
      reasons.push({ layer: 'profile/package.json', code: 'dependency-present', detail: `dependencies["${PLUGIN_NAME}"] = ${JSON.stringify(dependencies[PLUGIN_NAME])}` })
    const bundles = Array.isArray(manifest.value?.dsh?.profile?.bundles) ? manifest.value.dsh.profile.bundles : []
    if (bundles.includes(PLUGIN_NAME)) reasons.push({ layer: 'profile/package.json', code: 'bundle-present', detail: `dsh.profile.bundles 含 ${PLUGIN_NAME}` })
  } else if (manifest.code === 'invalid') {
    // manifest 坏掉时**不得**当作"已卸载"继续删东西（fail-closed 走护栏）
    reasons.push({ layer: 'profile/package.json', code: 'manifest-unreadable', detail: manifest.detail })
  }
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  if (patchMentionsPlugin(readTextOrEmpty(profilePatchPath)))
    reasons.push({ layer: 'profile/cordis.patch.yml', code: 'loader-row-present', detail: profilePatchPath })
  const homePatchPath = join(home, 'cordis.patch.yml')
  if (patchMentionsPlugin(readTextOrEmpty(homePatchPath)))
    reasons.push({ layer: 'home/cordis.patch.yml', code: 'loader-row-present', detail: homePatchPath })
  return { installed: reasons.length > 0, reasons }
}

/** `.pnpm` 下哪些条目名字可证明属于本插件（`<name>` / `<name>@<version>`） */
export function isOwnedPnpmEntryName(name) {
  return name === PLUGIN_NAME || name.startsWith(`${PLUGIN_NAME}@`)
}

function tryReadlink(path) {
  try {
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

function statOrUndefined(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/**
 * 收集残留候选（只读，不删任何东西）。
 *
 * @returns {{ok: boolean, code?: string, nodeModulesDir?: string, profileDir?: string,
 *            residues: Array<{path: string, absolutePath: string, kind: string, ownedBy: string, linkTarget?: string}>,
 *            refused: Array<{path: string, code: string, kind?: string, detail?: string}>}}
 */
export function collectResidues({ profileDir }) {
  const nodeModulesDir = join(profileDir, 'node_modules')
  if (!existsSync(nodeModulesDir))
    return { ok: true, code: 'nothing-to-do', profileDir, nodeModulesDir, residues: [], refused: [] }

  /** @type {Array<{absolutePath: string, ownedBy: string}>} */
  const candidates = []
  const pushCandidate = (absolutePath, ownedBy) => {
    if (candidates.some((item) => compareKey(item.absolutePath) === compareKey(absolutePath))) return
    candidates.push({ absolutePath, ownedBy })
  }
  pushCandidate(join(nodeModulesDir, PLUGIN_NAME), 'direct')
  pushCandidate(join(nodeModulesDir, '.pnpm', 'node_modules', PLUGIN_NAME), 'pnpm-hoisted')
  const pnpmDir = join(nodeModulesDir, '.pnpm')
  if (statOrUndefined(pnpmDir)?.isDirectory()) {
    let names = []
    try {
      names = readdirSync(pnpmDir).sort()
    } catch {
      names = []
    }
    for (const name of names) if (isOwnedPnpmEntryName(name)) pushCandidate(join(pnpmDir, name), 'pnpm-store')
  }

  const residues = []
  const refused = []
  const rel = (absolutePath) => absolutePath.slice(profileDir.length).replaceAll('\\', '/')
  for (const candidate of candidates) {
    if (!isContainedIn(nodeModulesDir, candidate.absolutePath)) {
      // G3：词法必须严格在 node_modules 内（结构性防线；正常派生不会触发）
      refused.push({ path: rel(candidate.absolutePath), code: 'path-outside-node-modules', detail: candidate.absolutePath })
      continue
    }
    let st
    try {
      st = lstatSync(candidate.absolutePath)
    } catch (error) {
      // 不存在的候选 = 没有残留（**先判存在**再判父级：否则缺失的 `.pnpm/node_modules`
      // 会被 realpath 失败误报成"越界拒绝"，把 nothing-to-do 变成噪声）
      if (error?.code === 'ENOENT') continue
      refused.push({ path: rel(candidate.absolutePath), code: 'lstat-failed', detail: String(error?.message ?? error) })
      continue
    }
    if (!parentRealpathInside(nodeModulesDir, candidate.absolutePath)) {
      // G3：父级 realpath 不在 node_modules 内（父级被 junction/`..` 指到外面）
      refused.push({ path: rel(candidate.absolutePath), code: 'parent-outside-node-modules', detail: candidate.absolutePath })
      continue
    }
    if (!st.isSymbolicLink()) {
      // G4：实体文件/目录**绝不删**（即使名字匹配 —— 防"递归删真实包"）
      refused.push({ path: rel(candidate.absolutePath), code: 'not-a-link', kind: st.isDirectory() ? 'directory' : 'file' })
      continue
    }
    residues.push({
      path: rel(candidate.absolutePath),
      absolutePath: candidate.absolutePath,
      kind: 'link',
      ownedBy: candidate.ownedBy,
      linkTarget: tryReadlink(candidate.absolutePath),
    })
  }
  return { ok: true, code: residues.length > 0 ? 'residue-found' : 'nothing-to-do', profileDir, nodeModulesDir, residues, refused }
}

/**
 * 只删"链接本身"：`unlinkSync`；Windows junction 若被系统当作目录（EISDIR/EPERM/EACCES）
 * 再退回 `rmdirSync`（**空目录型重解析点**，不会递归、不会跟随目标）。
 */
export function removeLinkOnly(absolutePath) {
  try {
    unlinkSync(absolutePath)
  } catch (error) {
    const retryable = process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code)
    if (!retryable) throw error
    rmdirSync(absolutePath)
  }
  // 删除后复核：lstat 必须 ENOENT（"真的没了"，而不是"换了个形态还在"）
  try {
    lstatSync(absolutePath)
    throw new Error('删除后 lstat 仍能看到该路径（可能被替换/未真正删除）')
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

/**
 * 计划（**不写盘**）：先护栏，再收集。
 * @returns {{ok: boolean, code: string, message?: string, home?: string, profile?: string, profileDir?: string,
 *            nodeModulesDir?: string, guard?: object, residues?: Array, refused?: Array}}
 */
export function planCleanup({ home, profile }) {
  const homeRes = resolveHome({ home })
  if (!homeRes.ok) return { ok: false, code: homeRes.code, message: homeRes.message }
  const profileRes = resolveProfileDir({ home: homeRes.home, profile })
  if (!profileRes.ok) return { ok: false, code: profileRes.code, message: profileRes.message, home: homeRes.home, profile }
  const guard = inspectStillInstalled({ profileDir: profileRes.dir, home: homeRes.home })
  const collected = collectResidues({ profileDir: profileRes.dir })
  if (guard.installed)
    return {
      ok: false,
      code: 'plugin-still-installed',
      message:
        `插件仍装配/依赖中（${guard.reasons.map((item) => `${item.layer}:${item.code}`).join('、')}）⇒ 拒绝清理。\n` +
        `正确顺序：先 dsh plugin --profile ${profile} remove ${PLUGIN_NAME}，再运行本工具。`,
      home: homeRes.home,
      profile,
      profileDir: profileRes.dir,
      nodeModulesDir: collected.nodeModulesDir,
      guard,
      residues: collected.residues,
      refused: collected.refused,
    }
  return {
    ok: true,
    code: collected.code,
    home: homeRes.home,
    profile,
    profileDir: profileRes.dir,
    nodeModulesDir: collected.nodeModulesDir,
    guard,
    residues: collected.residues,
    refused: collected.refused,
  }
}

/** 执行删除（`--apply`）；逐条记录成功/失败，失败**不隐藏**。 */
export function applyCleanup(plan) {
  const actions = []
  for (const residue of plan.residues ?? []) {
    try {
      removeLinkOnly(residue.absolutePath)
      actions.push({ path: residue.path, action: 'removed', verified: true, linkTarget: residue.linkTarget })
    } catch (error) {
      actions.push({ path: residue.path, action: 'failed', error: `${error?.code ?? 'EIO'}: ${String(error?.message ?? error)}` })
    }
  }
  const removedCount = actions.filter((item) => item.action === 'removed').length
  const failedCount = actions.filter((item) => item.action === 'failed').length
  return { actions, removedCount, failedCount }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { home: '', profile: process.env.DSH_PROFILE ?? '', apply: false, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') out.home = argv[++i] ?? ''
    else if (arg === '--profile') out.profile = argv[++i] ?? ''
    else if (arg === '--apply') out.apply = true
    else if (arg === '--dry-run') out.apply = false
    else if (arg === '--json') out.json = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else if (arg.startsWith('--home=')) out.home = arg.slice('--home='.length)
    else if (arg.startsWith('--profile=')) out.profile = arg.slice('--profile='.length)
    else out.unknown = [...(out.unknown ?? []), arg]
  }
  return out
}

/** 测试用：暴露参数解析（纯函数，无副作用） */
export function parseArgsForTest(argv) {
  return parseArgs(argv)
}

const USAGE =
  '用法: node tools/plugin-remove-cleanup.ts --profile <name> [--home <dir>] [--dry-run|--apply] [--json]\n' +
  '\n' +
  '清理 `dsh plugin remove dsh-winstage-sandbox` 之后的 profile node_modules 链接残留（R21-LC-04）：\n' +
  '  · 默认 --dry-run（只预览，不删任何东西）；--apply 才删。\n' +
  '  · 只删 reparse point/symlink/junction 本身，不递归、不跟随目标（真实包目录不动）。\n' +
  '  · 安全护栏：插件仍在 dsh.profile.bundles/dependencies 或覆盖层仍有 winstage-* 行 ⇒ 拒绝（exit 2），\n' +
  '    请先执行 dsh plugin --profile <name> remove dsh-winstage-sandbox。\n' +
  '  · 幂等：没有残留 ⇒ exit 0 + nothing-to-do。\n' +
  '  · 二次 `dsh plugin remove` 的 exit 1（ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS）是宿主 CLI 的既定残余\n' +
  '    （R21-LC-05），本工具不处理；按正常流程 remove（哪怕非零）后再跑本工具即可。\n' +
  '\n' +
  '退出码: 0 无需清理/成功；1 用法/定位/删除失败；2 安全护栏拒绝（插件仍装配）。\n'

function report(plan, dryRun) {
  const result = dryRun ? { actions: [], removedCount: 0, failedCount: 0 } : applyCleanup(plan)
  return {
    version: 1,
    tool: 'plugin-remove-cleanup',
    home: plan.home,
    profile: plan.profile,
    profileDir: plan.profileDir,
    nodeModulesDir: plan.nodeModulesDir,
    dryRun,
    code: plan.code,
    guard: plan.guard ?? { installed: false, reasons: [] },
    residues: plan.residues ?? [],
    refused: plan.refused ?? [],
    actions: result.actions,
    summary: {
      residueCount: (plan.residues ?? []).length,
      refusedCount: (plan.refused ?? []).length,
      removed: result.removedCount,
      failed: result.failedCount,
      changed: result.removedCount > 0,
    },
  }
}

function printHuman(payload) {
  const lines = []
  lines.push(`[plugin-remove-cleanup] home=${payload.home}`)
  lines.push(`  profile=${payload.profile} dir=${payload.profileDir}`)
  lines.push(`  node_modules=${payload.nodeModulesDir ?? '（不存在）'}`)
  if (payload.guard.installed) {
    lines.push('  ✗ 安全护栏拒绝：插件仍装配/依赖中 ⇒ 先执行 `dsh plugin --profile ' + payload.profile + ' remove ' + PLUGIN_NAME + '`')
    for (const reason of payload.guard.reasons) lines.push(`      · ${reason.layer}: ${reason.code}${reason.detail ? `（${reason.detail}）` : ''}`)
  }
  if ((payload.residues ?? []).length === 0 && (payload.refused ?? []).length === 0) {
    lines.push('  · nothing-to-do：没有发现本插件的 node_modules 链接残留')
  }
  for (const residue of payload.residues ?? []) {
    lines.push(`  · 残留 [${residue.ownedBy}] ${residue.path} → ${residue.linkTarget ?? '（读不到目标）'}`)
  }
  for (const refused of payload.refused ?? []) {
    lines.push(`  ⚠ 拒删 ${refused.path}：${refused.code}${refused.detail ? `（${refused.detail}）` : ''}`)
  }
  for (const action of payload.actions ?? []) {
    if (action.action === 'removed') lines.push(`  ✓ 已删除链接：${action.path}（复核不存在；目标未删除）`)
    else lines.push(`  ✗ 删除失败：${action.path} —— ${action.error}`)
  }
  const summary = payload.summary
  if (payload.dryRun) lines.push(`  · dry-run：待删 ${summary.residueCount} 项；加 --apply 才执行（本次未改任何文件）`)
  else if (payload.guard.installed) lines.push('  · 未执行任何删除（护栏拒绝）')
  else if (summary.residueCount === 0) lines.push('  · nothing-to-do（幂等：无需清理）')
  else lines.push(`  · 已删除 ${summary.removed} 项，失败 ${summary.failed} 项`)
  lines.push('  提示：R21-LC-05（二次 `dsh plugin remove` exit 1 / ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS）是宿主 CLI 残余，本工具不处理。')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  if (args.unknown?.length) {
    process.stdout.write(`未知参数：${args.unknown.join(' ')}\n\n${USAGE}`)
    process.exit(1)
  }
  const plan = planCleanup({ home: args.home, profile: args.profile })
  if (!plan.ok) {
    const payload = {
      version: 1,
      tool: 'plugin-remove-cleanup',
      home: plan.home ?? args.home,
      profile: plan.profile ?? args.profile,
      profileDir: plan.profileDir,
      code: plan.code,
      message: plan.message,
      guard: plan.guard ?? { installed: false, reasons: [] },
      residues: plan.residues ?? [],
      refused: plan.refused ?? [],
      actions: [],
      summary: { residueCount: (plan.residues ?? []).length, refusedCount: (plan.refused ?? []).length, removed: 0, failed: 0, changed: false },
      dryRun: args.apply !== true,
    }
    if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else {
      process.stdout.write(`✗ ${plan.message ?? plan.code}\n`)
      if (plan.guard?.reasons?.length) for (const reason of plan.guard.reasons) process.stdout.write(`    · ${reason.layer}: ${reason.code}${reason.detail ? `（${reason.detail}）` : ''}\n`)
      process.stdout.write('  · 未删除任何东西。\n')
    }
    // 护栏拒绝 = 2；其余定位/用法错误 = 1
    process.exit(plan.code === 'plugin-still-installed' ? 2 : 1)
  }
  const payload = report(plan, args.apply !== true)
  if (args.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else printHuman(payload)
  process.exit(payload.summary.failed > 0 ? 1 : 0)
}

// 入口守卫用 pathToFileURL（Windows 上 argv[1] 是反斜杠路径，直接拼 file:// 永不相等 —— R18 教训）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
