#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；R25 新套件（登记由 Lead 统一做）。
/**
 * r25-remove-cleanup —— **R25-B：`dsh plugin remove` 的 node_modules 链接残留清理工具回归**
 *
 * 存在理由（R21-LC-04，R25-B 收口）：
 *   `dsh plugin --profile <p> remove dsh-winstage-sandbox` 之后依赖与 `dsh.profile.bundles` 已恢复、
 *   宿主重启后 `/winstage-panel` 路由 404（功能已卸载），但 pnpm 对 `link:` 依赖**不删
 *   `node_modules` 里的 junction** ⇒ 文件面残留。`tools/plugin-remove-cleanup.ts` 显式清它。
 *
 * 本套件全部**离线**（不启动 DSH 宿主、不需要 pnpm/管理员）：
 *   A 纯函数：profile 名/路径包含性/覆盖层行判定/`.pnpm` 条目归属/参数解析/--home 解析；
 *   B 残留发现：direct junction + `.pnpm/node_modules` junction 都识别；实体目录记 not-a-link 拒删；
 *   C CLI dry-run：默认不删（junction/目标 sentinel 原样），JSON 报 residueCount；
 *   D CLI --apply：删除两个链接、目标目录与 sentinel **一字节不动**、实体目录仍被拒删；
 *   E 幂等：再次 --apply ⇒ exit 0 + nothing-to-do，不报失败；
 *   F 安全护栏：插件仍在 dependencies/bundles/profile 覆盖层/home 覆盖层 ⇒ exit 2 且零删除；
 *   G 越界拒绝：`.pnpm` 父级被 junction 指到 profile node_modules 之外 ⇒ 候选记
 *     parent-outside-node-modules、零删除、exit 0（安全跳过而不是误删）；
 *   H 只删链接：名字匹配的**实体目录**绝不递归删；目标目录内容始终不变；
 *   I 定位/用法：缺 --profile ⇒ exit 1；profile 不存在 ⇒ exit 1；--help ⇒ exit 0；未知参数 ⇒ exit 1；
 *   J 环境变量回退：DSH_HOME + DSH_PROFILE（无 flag）同样工作。
 *
 * 用法：node tests\r25-remove-cleanup.ts [--keep]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  PLUGIN_NAME,
  PLUGIN_LOADER_IDS,
  applyCleanup,
  collectResidues,
  inspectStillInstalled,
  isContainedIn,
  isOwnedPnpmEntryName,
  parentRealpathInside,
  parseArgsForTest,
  patchMentionsPlugin,
  planCleanup,
  validateProfileName,
} from '../tools/plugin-remove-cleanup.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'lifecycle', 'r25-remove-cleanup')
const TOOL = join(REPO, 'tools', 'plugin-remove-cleanup.ts')
const KEEP = process.argv.includes('--keep')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

let seq = 0
/**
 * 造一个"最小 profile"：`<root>/home/profiles/lcrm/`。
 * @param {{tag: string, junction?: boolean, manifest?: object, profilePatch?: string, homePatch?: string}} options
 */
function makeProfile(options) {
  const { tag, junction = false, manifest, profilePatch = '[]\n', homePatch } = options
  const root = join(SCRATCH, `${tag}-${seq++}`)
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'lcrm')
  const nodeModules = join(profileDir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  const pkg = manifest ?? { name: 'dsh-profile-lcrm', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(pkg, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), profilePatch)
  if (homePatch !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), homePatch)
  let target
  if (junction) {
    target = join(root, 'packages', 'win')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0' })}\n`)
    writeFileSync(join(target, 'sentinel.txt'), 'real package must never be deleted\n')
    symlinkSync(target, join(nodeModules, PLUGIN_NAME), 'junction')
  }
  return { root, home, profileDir, nodeModules, target }
}

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  // 显式清掉继承的 DSH_HOME/DSH_PROFILE，避免外部环境干扰（用例需要时再显式传入）
  if (extraEnv.DSH_HOME === undefined) delete env.DSH_HOME
  if (extraEnv.DSH_PROFILE === undefined) delete env.DSH_PROFILE
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, timeout: 120_000 })
  const parseJson = () => {
    try {
      return JSON.parse(result.stdout)
    } catch {
      return undefined
    }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: parseJson() }
}

const has = (text, needle) => typeof text === 'string' && text.includes(needle)

// ── A：纯函数 ───────────────────────────────────────────────────────────────
section('A · 纯函数（profile 名 / 路径包含性 / 覆盖层判定 / .pnpm 归属 / 参数）')
check('A1 空 profile 名被拒绝', validateProfileName('') !== undefined && validateProfileName('   ') !== undefined)
check('A2 路径分隔符 profile 名被拒绝', validateProfileName('a/b') !== undefined && validateProfileName('a\\b') !== undefined)
check('A3 "."/".."/"node_modules" 被拒绝', ['..', '.', 'node_modules'].every((name) => validateProfileName(name) !== undefined))
check('A4 正常 profile 名通过', validateProfileName('lcrm') === undefined && validateProfileName('desktop') === undefined)
const nmExample = join(SCRATCH, 'containment', 'node_modules')
check('A5 isContainedIn：严格子路径为真', isContainedIn(nmExample, join(nmExample, PLUGIN_NAME)) === true)
check('A6 isContainedIn：根自身为假', isContainedIn(nmExample, nmExample) === false)
check('A7 isContainedIn：.. 逃逸为假', isContainedIn(nmExample, join(nmExample, '..', 'evil')) === false)
check('A8 isContainedIn：无关绝对路径为假', isContainedIn(nmExample, join(SCRATCH, 'elsewhere', 'x')) === false)
check('A9 parentRealpathInside：父目录不存在时为假（fail-closed）', parentRealpathInside(join(SCRATCH, 'nope'), join(SCRATCH, 'nope', 'x')) === false)
check(
  'A10 patchMentionsPlugin：三条 loader 行都识别',
  PLUGIN_LOADER_IDS.every((id) => patchMentionsPlugin(`- id: ${id}\n  name: x\n`)) === true,
)
check('A11 patchMentionsPlugin：其他行/注释行不误伤', patchMentionsPlugin('# - id: winstage-sandbox\n- id: other\n') === false)
check(
  'A12 isOwnedPnpmEntryName：<name> 与 <name>@<ver> 为真，前缀不匹配为假',
  isOwnedPnpmEntryName(PLUGIN_NAME) === true && isOwnedPnpmEntryName(`${PLUGIN_NAME}@1.0.0`) === true && isOwnedPnpmEntryName(`${PLUGIN_NAME}-evil`) === false,
)
const parsedDefault = parseArgsForTest(['--profile', 'lcrm'])
check('A13 parseArgs：默认 dry-run（apply=false）', parsedDefault.apply === false && parsedDefault.profile === 'lcrm')
const parsedApply = parseArgsForTest(['--home', 'C:\\h', '--profile=lcrm', '--apply', '--json'])
check('A14 parseArgs：--apply/--json/--home=/--profile=', parsedApply.apply === true && parsedApply.json === true && parsedApply.home === 'C:\\h' && parsedApply.profile === 'lcrm')
check('A15 parseArgs：--dry-run 覆盖 --apply 顺序（后者生效）', parseArgsForTest(['--apply', '--dry-run']).apply === false)

// ── B：残留发现（只读）与拒绝项 ─────────────────────────────────────────────
section('B · 残留发现（direct junction + .pnpm hoisted junction + 实体目录拒删）')
const fixtureB = makeProfile({ tag: 'discover', junction: true })
mkdirSync(join(fixtureB.nodeModules, '.pnpm', 'node_modules'), { recursive: true })
symlinkSync(fixtureB.target, join(fixtureB.nodeModules, '.pnpm', 'node_modules', PLUGIN_NAME), 'junction')
// pnpm store 条目必须是"实体目录"形态（link: 依赖通常没有，但名字匹配时必须拒删）
const storeEntry = join(fixtureB.nodeModules, '.pnpm', `${PLUGIN_NAME}@1.0.0`)
mkdirSync(storeEntry, { recursive: true })
writeFileSync(join(storeEntry, 'package.json'), '{"name":"dsh-winstage-sandbox"}\n')
const collectedB = collectResidues({ profileDir: fixtureB.profileDir })
check('B1 发现 2 个链接残留（direct + pnpm-hoisted）', collectedB.residues.length === 2, JSON.stringify(collectedB.residues.map((r) => r.path)))
check(
  'B2 残留按 ownedBy 分类正确',
  collectedB.residues.some((r) => r.ownedBy === 'direct') && collectedB.residues.some((r) => r.ownedBy === 'pnpm-hoisted'),
)
check('B3 残留都带 linkTarget（证明只认链接）', collectedB.residues.every((r) => r.kind === 'link' && typeof r.linkTarget === 'string'))
check(
  'B4 名字匹配的实体目录记 not-a-link 拒绝删除',
  collectedB.refused.some((r) => r.path.endsWith(`${PLUGIN_NAME}@1.0.0`) && r.code === 'not-a-link' && r.kind === 'directory'),
  JSON.stringify(collectedB.refused),
)
const planB = planCleanup({ home: fixtureB.home, profile: 'lcrm' })
check('B5 planCleanup：未装配 ⇒ ok + residue-found', planB.ok === true && planB.code === 'residue-found')
check('B6 planCleanup：护栏 installed=false', planB.guard.installed === false && planB.guard.reasons.length === 0)
const dryB = applyCleanup({ residues: [] })
check('B7 applyCleanup：空计划零动作（纯函数不写盘）', dryB.actions.length === 0 && dryB.removedCount === 0 && dryB.failedCount === 0)
check('B8 计划是只读的：dry plan 后两个链接仍在', existsSync(join(fixtureB.nodeModules, PLUGIN_NAME)) && existsSync(join(fixtureB.nodeModules, '.pnpm', 'node_modules', PLUGIN_NAME)))

// ── C：CLI dry-run（默认）──────────────────────────────────────────────────
section('C · CLI --dry-run（默认）：不删任何东西')
const cDry = runCli(['--home', fixtureB.home, '--profile', 'lcrm', '--json'])
check('C1 dry-run exit=0', cDry.code === 0, `code=${cDry.code} stderr=${cDry.stderr}`)
check('C2 dry-run JSON：dryRun=true、residueCount=2、removed=0', cDry.json?.dryRun === true && cDry.json?.summary?.residueCount === 2 && cDry.json?.summary?.removed === 0, JSON.stringify(cDry.json?.summary))
check('C3 dry-run 后 direct junction 仍在', existsSync(join(fixtureB.nodeModules, PLUGIN_NAME)))
check('C4 dry-run 后 pnpm-hoisted junction 仍在', existsSync(join(fixtureB.nodeModules, '.pnpm', 'node_modules', PLUGIN_NAME)))
check('C5 dry-run 后真实包 sentinel 原样', readFileSync(join(fixtureB.target, 'sentinel.txt'), 'utf8').includes('must never be deleted'))
const cDryHuman = runCli(['--home', fixtureB.home, '--profile', 'lcrm'])
check('C6 dry-run 人读输出含 "dry-run" 与待删提示', has(cDryHuman.stdout, 'dry-run') && has(cDryHuman.stdout, '待删'))

// ── D：CLI --apply：删链接、不动目标、实体目录拒删 ──────────────────────────
section('D · CLI --apply：只删链接本身（目标/实体目录都不动）')
const dApply = runCli(['--home', fixtureB.home, '--profile', 'lcrm', '--apply', '--json'])
check('D1 apply exit=0', dApply.code === 0, `code=${dApply.code} stdout=${dApply.stdout} stderr=${dApply.stderr}`)
check('D2 apply JSON：removed=2、failed=0', dApply.json?.summary?.removed === 2 && dApply.json?.summary?.failed === 0, JSON.stringify(dApply.json?.summary))
check('D3 apply 后 direct junction 已删除', existsSync(join(fixtureB.nodeModules, PLUGIN_NAME)) === false)
check('D4 apply 后 pnpm-hoisted junction 已删除', existsSync(join(fixtureB.nodeModules, '.pnpm', 'node_modules', PLUGIN_NAME)) === false)
check(
  'D5 目标真实包未被删除（package.json + sentinel 都在）',
  existsSync(join(fixtureB.target, 'package.json')) && existsSync(join(fixtureB.target, 'sentinel.txt')),
)
check('D6 名字匹配的实体目录 apply 后仍在（绝不递归删真实目录）', existsSync(storeEntry))
const actionsD = dApply.json?.actions ?? []
check('D7 每条动作都带 verified=true（删除后复核不存在）', actionsD.length === 2 && actionsD.every((a) => a.action === 'removed' && a.verified === true), JSON.stringify(actionsD))

// ── E：幂等 ─────────────────────────────────────────────────────────────────
section('E · 幂等：再次 --apply ⇒ nothing-to-do exit 0')
const eAgain = runCli(['--home', fixtureB.home, '--profile', 'lcrm', '--apply', '--json'])
check('E1 再次 apply exit=0', eAgain.code === 0, `code=${eAgain.code}`)
check('E2 再次 apply code=nothing-to-do、removed=0', eAgain.json?.code === 'nothing-to-do' && eAgain.json?.summary?.removed === 0, JSON.stringify(eAgain.json?.summary))
check('E3 再次 apply 不把实体目录当残留（residueCount=0、refused=1）', eAgain.json?.summary?.residueCount === 0 && eAgain.json?.summary?.refusedCount === 1)
const eAgainHuman = runCli(['--home', fixtureB.home, '--profile', 'lcrm', '--apply'])
check('E4 人读输出含 nothing-to-do', has(eAgainHuman.stdout, 'nothing-to-do'))

// ── F：安全护栏（插件仍装配 ⇒ exit 2，零删除）──────────────────────────────
section('F · 安全护栏：插件仍装配/依赖中 ⇒ 拒绝（exit 2），一步都不删')
const fixtureF = makeProfile({
  tag: 'guard-dep',
  junction: true,
  manifest: {
    name: 'dsh-profile-lcrm',
    private: true,
    dependencies: { [PLUGIN_NAME]: 'link:C:/somewhere/packages/win' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME] } },
  },
})
const fDep = runCli(['--home', fixtureF.home, '--profile', 'lcrm', '--apply', '--json'])
check('F1 依赖/bundles 仍在 ⇒ exit=2', fDep.code === 2, `code=${fDep.code}`)
check('F2 code=plugin-still-installed 且 reasons≥2', fDep.json?.code === 'plugin-still-installed' && (fDep.json?.guard?.reasons ?? []).length >= 2, JSON.stringify(fDep.json?.guard))
check('F3 护栏拒绝时零删除（junction 仍在、目标仍在）', existsSync(join(fixtureF.nodeModules, PLUGIN_NAME)) && existsSync(join(fixtureF.target, 'sentinel.txt')))
check('F4 护栏拒绝时 apply 仍标记 dryRun 语义（未写盘）', (fDep.json?.actions ?? []).length === 0)

const fixtureFP = makeProfile({
  tag: 'guard-patch',
  junction: true,
  profilePatch: '# layer\n- id: winstage-sandbox\n  name: dsh-winstage-sandbox\n  config:\n    enabled: false\n',
})
const fPatch = runCli(['--home', fixtureFP.home, '--profile', 'lcrm', '--apply', '--json'])
check('F5 profile 覆盖层仍有 winstage 行 ⇒ exit=2', fPatch.code === 2, `code=${fPatch.code}`)
check(
  'F6 护栏原因指向 profile/cordis.patch.yml:loader-row-present',
  (fPatch.json?.guard?.reasons ?? []).some((r) => r.layer === 'profile/cordis.patch.yml' && r.code === 'loader-row-present'),
  JSON.stringify(fPatch.json?.guard?.reasons),
)
check('F7 覆盖层护栏拒绝后 junction 原样', existsSync(join(fixtureFP.nodeModules, PLUGIN_NAME)))

const fixtureFH = makeProfile({
  tag: 'guard-home-patch',
  junction: true,
  homePatch: '- id: winstage-fs\n  name: dsh-winstage-sandbox/fs\n',
})
const fHomePatch = runCli(['--home', fixtureFH.home, '--profile', 'lcrm', '--apply', '--json'])
check('F8 home 级覆盖层仍有 winstage 行 ⇒ exit=2', fHomePatch.code === 2, `code=${fHomePatch.code}`)
check(
  'F9 护栏原因指向 home/cordis.patch.yml:loader-row-present',
  (fHomePatch.json?.guard?.reasons ?? []).some((r) => r.layer === 'home/cordis.patch.yml' && r.code === 'loader-row-present'),
  JSON.stringify(fHomePatch.json?.guard?.reasons),
)
// 清掉 home patch 后同一 fixture 可以正常清理
rmSync(join(fixtureFH.home, 'cordis.patch.yml'), { force: true })
const fHomePatchOk = runCli(['--home', fixtureFH.home, '--profile', 'lcrm', '--apply', '--json'])
check('F10 移除覆盖层行后 ⇒ exit=0 且 removed=1', fHomePatchOk.code === 0 && fHomePatchOk.json?.summary?.removed === 1, `code=${fHomePatchOk.code}`)

// ── G：越界拒绝（父级被 junction 指到外部）──────────────────────────────────
section('G · 越界拒绝：`.pnpm` 父级 realpath 在 node_modules 外 ⇒ 安全跳过')
const fixtureG = makeProfile({ tag: 'escape' })
const outside = join(fixtureG.root, 'outside', '.pnpm')
mkdirSync(join(outside, 'node_modules'), { recursive: true })
const outsideTarget = join(fixtureG.root, 'outside', 'pkg')
mkdirSync(outsideTarget, { recursive: true })
writeFileSync(join(outsideTarget, 'sentinel.txt'), 'outside real package\n')
symlinkSync(outsideTarget, join(outside, 'node_modules', PLUGIN_NAME), 'junction')
// profile 的 node_modules/.pnpm 本身是 junction → 派生候选的父级 realpath 落在 node_modules 之外
symlinkSync(outside, join(fixtureG.nodeModules, '.pnpm'), 'junction')
const collectedG = collectResidues({ profileDir: fixtureG.profileDir })
check(
  'G1 越界候选被记 parent-outside-node-modules 拒绝',
  collectedG.refused.some((r) => r.code === 'parent-outside-node-modules'),
  JSON.stringify(collectedG.refused),
)
check('G2 越界候选没有被当作残留', collectedG.residues.length === 0, JSON.stringify(collectedG.residues))
const gApply = runCli(['--home', fixtureG.home, '--profile', 'lcrm', '--apply', '--json'])
check('G3 越界场景 apply exit=0（安全跳过、无删除）', gApply.code === 0 && gApply.json?.summary?.removed === 0, `code=${gApply.code}`)
check('G4 外部 junction 与目标 sentinel 原样未动', existsSync(join(outside, 'node_modules', PLUGIN_NAME)) && existsSync(join(outsideTarget, 'sentinel.txt')))

// ── H：只删链接（实体目录形态的同名候选）───────────────────────────────────
section('H · 只删链接：同名实体目录不被递归删除')
const fixtureH = makeProfile({ tag: 'real-dir' })
mkdirSync(join(fixtureH.nodeModules, PLUGIN_NAME), { recursive: true })
writeFileSync(join(fixtureH.nodeModules, PLUGIN_NAME, 'package.json'), '{"name":"dsh-winstage-sandbox"}\n')
const hApply = runCli(['--home', fixtureH.home, '--profile', 'lcrm', '--apply', '--json'])
check('H1 实体目录候选 ⇒ exit=0、removed=0、refused=1(not-a-link)', hApply.code === 0 && hApply.json?.summary?.removed === 0 && hApply.json?.summary?.refusedCount === 1, `code=${hApply.code} summary=${JSON.stringify(hApply.json?.summary)}`)
check('H2 实体目录及其内容原样（未递归删）', existsSync(join(fixtureH.nodeModules, PLUGIN_NAME, 'package.json')))

// ── I：定位/用法 ────────────────────────────────────────────────────────────
section('I · 定位/用法：缺 profile / profile 不存在 / --help / 未知参数')
const iNoProfile = runCli(['--home', fixtureB.home])
check('I1 缺 --profile ⇒ exit=1', iNoProfile.code === 1, `code=${iNoProfile.code}`)
check('I2 缺 profile 的错误信息可行动（提到 --profile）', has(iNoProfile.stdout, '--profile'))
const iNoProfileDir = runCli(['--home', fixtureB.home, '--profile', 'ghost'])
check('I3 profile 不存在（无 package.json）⇒ exit=1', iNoProfileDir.code === 1, `code=${iNoProfileDir.code}`)
const iHelp = runCli(['--help'])
check('I4 --help ⇒ exit=0 且输出含用法/退出码', iHelp.code === 0 && has(iHelp.stdout, '用法') && has(iHelp.stdout, '退出码'))
const iUnknown = runCli(['--profile', 'lcrm', '--bogus'])
check('I5 未知参数 ⇒ exit=1', iUnknown.code === 1, `code=${iUnknown.code}`)
const iNoHomeNoEnv = (() => {
  const env = { ...process.env }
  delete env.DSH_HOME
  delete env.USERPROFILE
  delete env.HOME
  const result = spawnSync(process.execPath, [TOOL, '--profile', 'lcrm'], { encoding: 'utf8', env, timeout: 120_000 })
  return result
})()
check('I6 无 --home 且无 DSH_HOME/USERPROFILE ⇒ exit=1（不猜路径）', iNoHomeNoEnv.status === 1, `code=${iNoHomeNoEnv.status}`)

// ── J：环境变量回退 + 空 profile（无 node_modules）幂等 ──────────────────────
section('J · 环境变量回退（DSH_HOME/DSH_PROFILE）与 nothing-to-do')
const fixtureJ = makeProfile({ tag: 'env-fallback', junction: true })
const jEnv = runCli([], { DSH_HOME: fixtureJ.home, DSH_PROFILE: 'lcrm' })
check('J1 仅用 DSH_HOME+DSH_PROFILE ⇒ dry-run exit=0 并发现残留', jEnv.code === 0 && has(jEnv.stdout, PLUGIN_NAME), `code=${jEnv.code} stdout=${jEnv.stdout}`)
const fixtureEmpty = makeProfile({ tag: 'empty', junction: false })
const jEmpty = runCli(['--home', fixtureEmpty.home, '--profile', 'lcrm', '--json'])
check('J2 没有 node_modules 残留 ⇒ exit=0 + nothing-to-do', jEmpty.code === 0 && jEmpty.json?.code === 'nothing-to-do', JSON.stringify(jEmpty.json?.code))
const jEmptyApply = runCli(['--home', fixtureEmpty.home, '--profile', 'lcrm', '--apply', '--json'])
check('J3 无残留时 --apply 也 exit=0（幂等）', jEmptyApply.code === 0 && jEmptyApply.json?.summary?.removed === 0)

// ── 汇总 ────────────────────────────────────────────────────────────────────
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W('')
W(`RESULT: ${verdict} assertions=${assertions} failures=${failures}`)
W(`（R25-B / R21-LC-04：tools/plugin-remove-cleanup.ts 的离线回归；R21-LC-05 二次 remove exit 1 仍是宿主 CLI 残余，不在本套件范围）`)
if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
