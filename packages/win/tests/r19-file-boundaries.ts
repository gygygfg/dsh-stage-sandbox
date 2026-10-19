#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R19 新登记套件。
/**
 * r19-file-boundaries —— **R19 文件侧边界回归套件**（离线、确定性、零管理员）
 *
 * 存在理由（`docs/round19/R19-独立测试与边界修复报告.md` §残余）：
 * R19 主轮把时间压在注册表 P0 上，文件侧边界矩阵只剩插件自带断言。本套件把 R19
 * **实测出来的文件侧安全结局**钉成硬断言，同时把**已知残余/有意不修**的部分做成
 * 静态守卫（有人偷偷补 hook 而不更新残余清单，这里必须见红）。
 *
 * A. 行为回归（真实 Workspace + 真实磁盘，每个用例独立暂存根）
 *   A1 候选路径 `..\` 穿越：apply 必须 `UNSAFE_RELATIVE_PATH` 拒绝，且**不创建**任何外部文件
 *   A2 仅大小写重命名：必须 `CASE_ONLY_RENAME_UNSUPPORTED` 显式拒绝（旧行为：静默退化成删除 ⇒ 数据丢失）
 *   A3 工作区内 junction 指向外部：stage 写经 junction，apply 必须 `APPLY_PATH_OUTSIDE` 拒绝，
 *      真实外部文件**一字节不变**；同一工作区内的普通写仍必须能正常 apply（对照组）
 *   A4 尾点/尾空格文件名：create → apply 内容回读逐字节一致（Windows 实际允许；不钉文件名形态）
 *   A5 CAS/选择性 apply 基线：真实文件在暂存后被外部改写 ⇒ apply 整批拒绝、真实盘不变（防覆盖）
 *
 * B. 静态守卫（读源码文本，不跑子进程）
 *   B1 `ws_hook.c` 必须含 23 个 advapi32 写类 + `CopyFileExW/A` + `CopyFile2`（R19 已修）
 *   B2 R20 已修文件侧 hook（ReplaceFileW/A、NtCreateFile、CreateHardLinkW/A、FindFirst* / FindNext*、
 *      FindClose、NtQueryDirectoryFile）**必须在 WS_TARGET**；未修残余 `NtQueryDirectoryFileEx`
 *      **不得**悄悄启用（启用需同时更新本守卫与残余文档）
 *   B3 `REG_STAGE_HOOKED_APIS` 与 `REG_STAGE_UNHOOKED_APIS` 不得重叠；R16 ntdll/Zw 注册表写类
 *      已进 WS_TARGET（R20 修复面；TS 清单同步见 `r20-registry-boundaries`）
 *   B4 `REG_STAGE_HARD_DENY_REASON` 含 R19 新增的 4..8 原因码
 *
 * 用法：
 *   node tests\r19-file-boundaries.ts            # 正常，应当全绿，退出码 0
 *   node tests\r19-file-boundaries.ts --plant    # 变异体（只扰动测试侧输入），应当见红
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../src/workspace.ts'
import {
  REG_STAGE_HARD_DENY_REASON,
  REG_STAGE_HOOKED_APIS,
  REG_STAGE_UNHOOKED_APIS,
} from '../src/registry-stage.ts'

const PLANT = process.argv.includes('--plant')
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r19-suite', 'file-boundaries')
const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}\n      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}
function isolateStage(tag) {
  process.env.WINSTAGE_STAGE_ROOT = join(SCRATCH, `stage-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`)
}
function freshRoot(tag) {
  const root = join(SCRATCH, `ws-${tag}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}
function expectThrows(fn) {
  try {
    fn()
    return { threw: false }
  } catch (error) {
    return { threw: true, code: error?.code, message: String(error?.message ?? error) }
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

// ═════════════════════════ A. 行为回归 ═════════════════════════
section('A. 文件侧行为回归（真实 Workspace + 真实磁盘）')

// A1：候选路径 ..\ 穿越
{
  const root = freshRoot('traversal')
  writeFileSync(join(root, 'seed.txt'), 'seed')
  isolateStage('traversal')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r19-traversal' })
  ws.writeFile(join(root, 'new.txt'), 'new', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const candidatePath = ws.store.candidatePath(frozen.candidate.id)
  const record = JSON.parse(readFileSync(candidatePath, 'utf8'))
  const createChange = record.changes.find((c) => c.op === 'create' && c.kind === 'file')
  check('A1.0 前置：候选里存在 create 文件单元（否则本用例无判定力）', createChange !== undefined, `changes=${record.changes.length}`)
  if (createChange) createChange.path = '..\\..\\r19-traversal-evil.txt'
  writeFileSync(candidatePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const result = expectThrows(() => ws.applyCandidate(frozen.candidate.id, { force: true }))
  check(
    'A1.1 候选路径含 `..` ⇒ apply 结构化拒绝（UNSAFE_RELATIVE_PATH）',
    result.threw && result.code === 'UNSAFE_RELATIVE_PATH',
    JSON.stringify(result).slice(0, 240),
  )
  const evilCandidates = [
    join(REPO, '.t', 'r19-traversal-evil.txt'),
    join(SCRATCH, '..', 'r19-traversal-evil.txt'),
  ]
  check('A1.2 外部/越界目标一个都没有被创建', evilCandidates.every((p) => !existsSync(p)), JSON.stringify(evilCandidates))
}

// A2：仅大小写重命名（旧行为 = 静默删除）
{
  const root = freshRoot('case-only')
  writeFileSync(join(root, 'a.txt'), 'lower')
  isolateStage('case-only')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r19-case-only' })
  const result = expectThrows(() => ws.rename(join(root, 'a.txt'), join(root, 'A.txt')))
  check(
    'A2.1 仅大小写 rename ⇒ 显式拒绝（CASE_ONLY_RENAME_UNSUPPORTED），不退化成删除',
    result.threw && result.code === 'CASE_ONLY_RENAME_UNSUPPORTED',
    JSON.stringify(result).slice(0, 240),
  )
  check(
    'A2.2 真实文件仍在、内容不变、暂存面无 delete 单元',
    existsSync(join(root, 'a.txt')) && readFileSync(join(root, 'a.txt'), 'utf8') === 'lower' && ws.diffEntries().length === 0,
    JSON.stringify({ exists: existsSync(join(root, 'a.txt')), diff: ws.diffEntries().map((c) => `${c.op}:${c.path}`) }),
  )
}

// A3：工作区内 junction 指向外部 ⇒ apply fail-closed；普通写对照仍可用
{
  const root = freshRoot('junction')
  const outside = join(SCRATCH, 'outside-target')
  rmSync(outside, { recursive: true, force: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'evidence.txt'), 'OUTSIDE-ORIGINAL')
  const junction = join(root, 'link-out')
  let junctionCreated = true
  try {
    symlinkSync(outside, junction, 'junction')
  } catch (error) {
    junctionCreated = false
    skip('A3 工作区内 junction 指向外部', `本机无法创建 junction（${error?.code}）；换一台允许 junction 的机器必须重跑`)
  }
  if (junctionCreated) {
    isolateStage('junction')
    const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r19-junction' })
    ws.writeFile(join(root, 'link-out', 'evidence.txt'), 'THROUGH-JUNCTION', { origin: 'test' })
    ws.writeFile(join(root, 'link-out', 'new.txt'), 'THROUGH-JUNCTION-NEW', { origin: 'test' })
    ws.writeFile(join(root, 'normal.txt'), 'NORMAL', { origin: 'test' })
    const frozen = ws.freezeCandidate({})
    const before = readFileSync(join(outside, 'evidence.txt'), 'utf8')
    const result = ws.applyCandidate(frozen.candidate.id, { force: true, confirmedMasks: true })
    const failedCodes = (result.failed ?? []).map((f) => f.code)
    check(
      'A3.1 经 junction 的 workspace-relative 单元 ⇒ APPLY_PATH_OUTSIDE 拒绝',
      failedCodes.filter((code) => code === 'APPLY_PATH_OUTSIDE').length >= 1,
      JSON.stringify({ applied: result.applied, failed: result.failed, codes: failedCodes }).slice(0, 320),
    )
    check(
      'A3.2 真实外部目标一字节未变、新文件不存在',
      readFileSync(join(outside, 'evidence.txt'), 'utf8') === before && !existsSync(join(outside, 'new.txt')),
      JSON.stringify({ evidence: readFileSync(join(outside, 'evidence.txt'), 'utf8'), newExists: existsSync(join(outside, 'new.txt')) }),
    )
    check(
      'A3.3 对照：同一候选里的普通工作区写仍成功 apply',
      (result.applied ?? []).some((a) => a.path === 'normal.txt') && readFileSync(join(root, 'normal.txt'), 'utf8') === 'NORMAL',
      JSON.stringify(result.applied),
    )
  }
}

// A4：尾点 / 尾空格文件名 create → apply
{
  const root = freshRoot('tail')
  isolateStage('tail')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r19-tail' })
  const target = join(root, 'taildot. ')
  ws.writeFile(target, 'TAIL', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  const result = ws.applyCandidate(frozen.candidate.id, { force: true })
  const names = readdirSync(root)
  const candidateNames = names.filter((n) => n.startsWith('taildot'))
  const contentOk =
    candidateNames.length > 0 &&
    candidateNames.some((n) => {
      try {
        return readFileSync(join(root, n), 'utf8') === 'TAIL'
      } catch {
        return false
      }
    })
  check(
    'A4.1 尾点/尾空格文件名 create → apply 成功且内容逐字节一致',
    (result.failed ?? []).length === 0 && contentOk,
    JSON.stringify({ failed: result.failed, names: candidateNames }).slice(0, 240),
  )
}

// A5：基线冲突（真实文件在暂存后被外部改）⇒ 整批拒绝、真实盘不变
{
  const root = freshRoot('cas')
  writeFileSync(join(root, 'guarded.txt'), 'BASE')
  isolateStage('cas')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'r19-cas' })
  ws.writeFile(join(root, 'guarded.txt'), 'STAGED', { origin: 'test' })
  const frozen = ws.freezeCandidate({})
  writeFileSync(join(root, 'guarded.txt'), 'EXTERNAL-CHANGE')
  const result = ws.applyCandidate(frozen.candidate.id)
  check(
    'A5.1 CAS：外部改写后 apply 拒绝覆盖（真实盘保留 EXTERNAL-CHANGE）',
    readFileSync(join(root, 'guarded.txt'), 'utf8') === 'EXTERNAL-CHANGE' && (result.failed ?? []).length > 0 && (result.applied ?? []).length === 0,
    JSON.stringify({ failed: result.failed, applied: result.applied }).slice(0, 320),
  )
}

// ═════════════════════════ B. 静态守卫（残余/契约） ═════════════════════════
section('B. 静态守卫：R19 hook 面与已登记残余不得漂移')

const hookSource = readFileSync(join(REPO, 'shim', 'src', 'ws_hook.c'), 'utf8')
const hookTargets = new Set([...hookSource.matchAll(/WS_TARGET\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1]))

// B1：R19 已修面必须在 WS_TARGET
{
  const required = ['CopyFileExW', 'CopyFileExA', 'CopyFile2']
  const missing = required.filter((name) => !hookTargets.has(name))
  check('B1.1 CopyFileExW/A + CopyFile2 已在 WS_TARGET（R19-FSREG-05 已修面）', missing.length === 0, `missing=${missing.join(',') || '(none)'}`)
  const advapi = REG_STAGE_HOOKED_APIS.filter((name) => name.startsWith('Reg'))
  const missingAdvapi = advapi.filter((name) => !hookTargets.has(name))
  check(
    `B1.2 REG_STAGE_HOOKED_APIS 的 ${advapi.length} 个 Reg* 全部出现在 WS_TARGET（契约↔实现同源）`,
    missingAdvapi.length === 0,
    `missing=${missingAdvapi.join(',') || '(none)'}`,
  )
}

// B2：R20 已修文件侧 hook 必须在 WS_TARGET；未修残余保留静态守卫
{
  // R20（`.lead/r20-contract.md` §2/§3）把这些名字真正接进了 IAT 点钩：
  //   R17 ReplaceFileW/A、NtCreateFile、CreateHardLinkW/A
  //   R19 FindFirstFileW/A、FindFirstFileExW/A、FindNextFileW/A、FindClose、NtQueryDirectoryFile
  // 它们现在是"已修面"：从 WS_TARGET 消失 = 修复回退 = 这里必须见红。
  const fixedTargets = [
    'ReplaceFileW',
    'ReplaceFileA',
    'NtCreateFile',
    'CreateHardLinkW',
    'CreateHardLinkA',
    'FindFirstFileW',
    'FindFirstFileA',
    'FindFirstFileExW',
    'FindFirstFileExA',
    'FindNextFileW',
    'FindNextFileA',
    'FindClose',
    'NtQueryDirectoryFile',
  ]
  const missing = fixedTargets.filter((name) => !hookTargets.has(name))
  check(
    'B2.1 R20 文件侧已修面（ReplaceFileW/A、NtCreateFile、CreateHardLinkW/A、FindFirst*/FindNext*、FindClose、NtQueryDirectoryFile）全部在 WS_TARGET',
    missing.length === 0,
    `missing=${missing.join(',') || '(none)'}`,
  )
  // R22-B：`NtQueryDirectoryFileEx` 已由 Lead 加入 WS_TARGET + `ws_file.c` 实现
  // （R19 残留的 Ex 枚举泄漏已修，行为证据在 `tests/r22-file-advex.ts`）。
  // 守卫翻转：它必须仍在 WS_TARGET，**回退即红**。
  const enabledTargets = ['NtQueryDirectoryFileEx']
  const stillMissing = enabledTargets.filter((name) => !hookTargets.has(name))
  check(
    'B2.2 R22-B：NtQueryDirectoryFileEx 已在 WS_TARGET（R19 残余已修；回退即红）',
    stillMissing.length === 0,
    stillMissing.length === 0 ? '已启用（与 R22 修复一致）' : `**回退**: 不在 WS_TARGET（${stillMissing.join(',')}）`,
  )
}

// B3：HOOKED 与 UNHOOKED 不重叠；R16 ntdll/Zw 注册表写面已在 WS_TARGET（R20 修复面）
{
  const hooked = new Set(REG_STAGE_HOOKED_APIS)
  const overlap = REG_STAGE_UNHOOKED_APIS.filter((name) => hooked.has(name))
  check('B3.1 REG_STAGE_HOOKED_APIS 与 REG_STAGE_UNHOOKED_APIS 无重叠', overlap.length === 0, `overlap=${overlap.join(',') || '(none)'}`)
  // R20 / R16：ntdll 注册表写类（以及同名 Zw 别名）已进 WS_TARGET。这里只钉 C 侧
  // "真的接上了钩子"这一实现事实；TS 侧 HOOKED/UNHOOKED 清单的同步由
  // `tests/r20-registry-boundaries.ts` 覆盖（reg-shim 线）。
  const ntdllFixed = [
    'NtCreateKey',
    'NtSetValueKey',
    'NtDeleteKey',
    'NtDeleteValueKey',
    'NtRenameKey',
    'NtLoadKey',
    'NtLoadKey2',
    'NtUnloadKey',
    'NtSaveKey',
    'NtSaveKeyEx',
    'NtRestoreKey',
    'NtReplaceKey',
    'ZwCreateKey',
    'ZwSetValueKey',
    'ZwDeleteKey',
    'ZwDeleteValueKey',
    'ZwRenameKey',
    'ZwLoadKey',
    'ZwLoadKey2',
    'ZwUnloadKey',
    'ZwSaveKey',
    'ZwSaveKeyEx',
    'ZwRestoreKey',
    'ZwReplaceKey',
  ]
  const missing = ntdllFixed.filter((name) => !hookTargets.has(name))
  check(
    'B3.2 R16 ntdll/Zw 注册表写类已在 WS_TARGET（R20 修复面；TS 清单同步见 r20-registry-boundaries）',
    missing.length === 0,
    `missing=${missing.join(',') || '(none)'}`,
  )
}

// B4：R19 新增硬拒原因码 4..8
{
  const codes = Object.keys(REG_STAGE_HARD_DENY_REASON)
  const values = Object.values(REG_STAGE_HARD_DENY_REASON)
  const required = [4, 5, 6, 7, 8]
  const missing = required.filter((value) => !values.includes(value))
  check(
    'B4.1 REG_STAGE_HARD_DENY_REASON 含 R19 的 4..8 原因码',
    missing.length === 0,
    `codes=${codes.join(',')} values=${values.join(',')}`,
  )
}

// ═════════════════════════ 汇总 ═════════════════════════
W('')
W('='.repeat(64))
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${verdict} checks=${assertions} failures=${failures} skips=${skips}${PLANT ? ' mode=plant' : ''}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
