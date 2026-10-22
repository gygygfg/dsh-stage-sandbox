#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R20 新登记套件。
/**
 * r20-file-boundaries —— **R20 文件侧边界回归套件**（R17 / R18 / R19 已修面）
 *
 * 存在理由（`.lead/r20-contract.md` §3，file-shim 线）：
 *   R19 登记了三条文件侧残余，R20 必须"真正修掉或如实收窄 + 证据"：
 *     R18 硬链接遮蔽绕过：`mklink /H <普通名> .npmrc` 后按普通名明文读；
 *     R19 目录枚举元数据泄漏：cmd dir / Get-ChildItem / node readdir 列出被遮蔽文件名；
 *     R17 ReplaceFileW / NtCreateFile / CopyFileEx 真实盘写与暂存语义。
 *
 * A. 静态守卫（读源码文本，不跑子进程）
 *   A1 R20 文件侧 13 个新 hook 目标必须在 `ws_hook.c::WS_TARGET`（回退即红）；
 *   A2 这些名字在 `ws_file.c` 里有实现体（不是仅声明）；
 *   A3 三条 fail-closed 文案必须在实现里（ReplaceFileW / NtCreateFile 写意图 /
 *      NtSetInformationFile(link) 的拒绝路径不得被删）；
 *   A4 未修残余 `NtQueryDirectoryFileEx` 不得悄悄启用（启用需同时更新本守卫与残余文档）。
 *
 * B. 行为回归（真实 injector + 真实磁盘，每个用例独立暂存根；canonical `shim\out`
 *    缺失时**整段 SKIP**，不是 PASS）
 *   B1 R18.1 预先存在的硬链接：按普通名读遮蔽文件 ⇒ node/cmd/powershell 三载体
 *        都不返回明文、暂存树无明文（R19 实测红：三载体全部 leaked=true）；
 *   B2 R18.2 注入进程 `mklink /H <普通名> <.npmrc>` ⇒ 拒绝且真实硬链接不存在；
 *   B3 R18.3 对照：pnpm/WinSxS 风格**普通文件**硬链接不误伤（两个名字都可读）；
 *   B4 R19.1/2/3 cmd dir / Get-ChildItem / node readdir 均不列出被遮蔽名、仍列出普通名；
 *   B5 R19.4 对照：普通目录三载体都不丢条目；
 *   B6 R17.1 `.NET [IO.File]::Replace` 载体 ⇒ fail-closed（真实 target 内容不变、
 *        无 backup 文件、replacement 仍在）；
 *   B7 R20① 托管 x64 载体回归：`csc /platform:x64` hello64.exe 经 injector 必须
 *        正常跑完且 stdout 正确（防 weak-stub/枚举 hook 把 CLR 启动搞挂）；
 *        载体产物不在（`.t/carrier/bin/hello64.exe` 缺失）时如实 SKIP。
 *   B8 R20 P0 收口（NT 命名空间/设备别名）：原生探针（套件用 repo zig 工具链现场编译）
 *        以 `\Device\HarddiskVolumeN\…` / `\\?\GLOBALROOT\Device\…` 写/读/delete-on-close：
 *        写 ⇒ 真实盘零写；读遮蔽文件 ⇒ 无明文；delete ⇒ 真实文件仍在（whiteout）；
 *        Win32 GLOBALROOT 写 ⇒ 进暂存且沙箱视图可读回。zig 工具链不在时如实 SKIP。
 *
 * 判定口径：安全方向是 fail-closed —— "拒绝 + 真实盘无变化" 算 PASS；
 * 只有"明文/被遮蔽名出现在输出或真实盘"才 FAIL。SKIP 不算 PASS。
 *
 * 用法：
 *   node tests\r20-file-boundaries.ts
 *   WINSTAGE_SHIM_OUT=<dir> node tests\r20-file-boundaries.ts   # 私有构建验证
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipSuiteWhenAppControlBlocks } from './_app-control.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r20-suite', 'file-boundaries')
const SHIMOUT = process.env.WINSTAGE_SHIM_OUT ? resolve(process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(SHIMOUT, 'winstage-shim.dll')
const INJECTOR = join(SHIMOUT, 'winstage-inject.exe')
const CMD = process.env.ComSpec || 'cmd.exe'
const PWSH = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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
function walkFiles(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

// 环境闸门（2026-10-22）：Smart App Control 强制态会拒绝注入器启动的探针进程（Win32 4551）。
if (skipSuiteWhenAppControlBlocks(W, 'r20-file-boundaries')) process.exit(0)
function fileHas(path, needle) {
  try {
    return readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
}

// ═════════════════════════ A. 静态守卫 ═════════════════════════
section('A. 静态守卫：R20 文件侧 hook 面与残余不得漂移')

const hookSource = readFileSync(join(REPO, 'shim', 'src', 'ws_hook.c'), 'utf8')
const fileSource = readFileSync(join(REPO, 'shim', 'src', 'ws_file.c'), 'utf8')
const hookTargets = new Set([...hookSource.matchAll(/WS_TARGET\(([A-Za-z0-9_]+)\)/g)].map((m) => m[1]))

const R20_FILE_TARGETS = [
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
{
  const missing = R20_FILE_TARGETS.filter((name) => !hookTargets.has(name))
  check(`A1 R20 文件侧 ${R20_FILE_TARGETS.length} 个 hook 目标全部在 WS_TARGET`, missing.length === 0, `missing=${missing.join(',') || '(none)'}`)
}
{
  const impls = [
    'ws_ReplaceFileW',
    'ws_ReplaceFileA',
    'ws_NtCreateFile',
    'ws_CreateHardLinkW',
    'ws_CreateHardLinkA',
    'ws_FindFirstFileW',
    'ws_FindFirstFileA',
    'ws_FindFirstFileExW',
    'ws_FindFirstFileExA',
    'ws_FindNextFileW',
    'ws_FindNextFileA',
    'ws_FindClose',
    'ws_NtQueryDirectoryFile',
  ]
  const missing = impls.filter((name) => !fileSource.includes(name))
  check(`A2 上述 ${impls.length} 个实现体在 ws_file.c 中存在（不是只在头文件里声明）`, missing.length === 0, `missing=${missing.join(',') || '(none)'}`)
}
{
  const markers = [
    ['ReplaceFileW fail-closed', 'fail-closed ReplaceFileW (real-disk zero-write; no staging model)'],
    ['NtCreateFile write-intent fail-closed', 'fail-closed NtCreateFile (write intent; real-disk zero-write)'],
    ['NtSetInformationFile(FileLinkInformation) fail-closed', 'fail-closed NtSetInformationFile(link)'],
    ['hardlink alias read deny', 'read denied: hardlink alias of a masked file'],
    ['directory batch filter', 'ws_NtQueryDirectoryFile'],
  ]
  const missing = markers.filter(([, needle]) => !fileSource.includes(needle)).map(([label]) => label)
  check('A3 五条 fail-closed / 过滤拒绝路径的文案仍在实现里（安全路径不得被静默删掉）', missing.length === 0, `missing=${missing.join(';') || '(none)'}`)
}
{
  /* R22-B：`NtQueryDirectoryFileEx` 已由 Lead 加入 WS_TARGET + ws_file.c 实现。
   * 守卫**翻转**：它必须保持在 WS_TARGET（回退即红）；行为证据在
   * `tests/r22-file-advex.ts`（Ex 枚举过滤先红后绿）。 */
  check(
    'A4 R22-B：NtQueryDirectoryFileEx 已在 WS_TARGET（R19 残余已修；回退即红）',
    hookTargets.has('NtQueryDirectoryFileEx'),
    hookTargets.has('NtQueryDirectoryFileEx') ? '已启用（与 R22 修复一致）' : '**回退**: 不在 WS_TARGET',
  )
}

// ═════════════════════════ B. 行为回归 ═════════════════════════
section('B. 行为回归（injector + 真实磁盘；每用例独立暂存根）')

function behaviorSkipAll(reason) {
  W('')
  W(`  ~ SKIP 全部行为用例：${reason}`)
  skips += 1
}
if (process.platform !== 'win32') {
  behaviorSkipAll('requires-win32')
} else if (!existsSync(DLL) || !existsSync(INJECTOR)) {
  behaviorSkipAll(`canonical shim 产物缺失（dll=${existsSync(DLL)} injector=${existsSync(INJECTOR)}）；先由 Lead 重建 shim/out`)
} else {
  rmSync(SCRATCH, { recursive: true, force: true })
  const STAGE = join(SCRATCH, 'stage')
  const SENS = join(SCRATCH, 'sens')
  const ADV = join(SCRATCH, 'adv')
  const NORMAL = join(SCRATCH, 'normal')
  for (const d of [STAGE, SENS, ADV, NORMAL, join(SCRATCH, 'session')]) mkdirSync(d, { recursive: true })
  const MARK = 'R20-SUITE-MASK-MARKER'
  const NORMAL_MARK = 'R20-SUITE-NORMAL'
  writeFileSync(join(SENS, '.npmrc'), `${MARK}-NPMRC`)
  writeFileSync(join(SENS, '.git-credentials'), `${MARK}-GITCRED`)
  writeFileSync(join(SENS, 'normal.txt'), NORMAL_MARK)
  writeFileSync(join(NORMAL, 'n1.txt'), 'NORMAL-1')
  writeFileSync(join(NORMAL, 'n2.txt'), 'NORMAL-2')

  const MASK = join(SCRATCH, 'session', 'read-deny.mask.json')
  const exported = spawnSync(process.execPath, [join(REPO, 'src', 'paths.ts'), '--export-mask', MASK], { encoding: 'utf8' })
  if (exported.status !== 0) {
    behaviorSkipAll(`mask 导出失败（status=${exported.status}）`)
  } else {
    let cfgSeq = 0
    function inject(tag, exe, args, timeout = 120000) {
      cfgSeq += 1
      const cfg = join(SCRATCH, `cfg-${tag}-${cfgSeq}.json`)
      writeFileSync(
        cfg,
        JSON.stringify({
          stageRoot: STAGE,
          logPath: join(STAGE, `shim-${tag}.log`),
          failClosed: true,
          readThrough: true,
          verbose: false,
          readDenyFile: MASK,
          readDenyFailClosed: true,
          passthrough: [STAGE],
        }),
      )
      const env = { ...process.env }
      env.WINSTAGE_STAGE_ROOT = STAGE
      env.WINSTAGE_SHIM_CONFIG = cfg
      env.WINSTAGE_SHIM_LOG = join(STAGE, `shim-${tag}.log`)
      const r = spawnSync(
        INJECTOR,
        ['--dll', DLL, '--report', join(SCRATCH, `report-${tag}.json`), '--cwd', SCRATCH, '--', exe, ...args],
        { env, encoding: 'utf8', timeout },
      )
      return { status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` }
    }
    const stagedHas = (needle) => walkFiles(STAGE).filter((f) => fileHas(f, needle)).length
    const containsMark = (text) => text.includes(MARK)

    // ── B1 R18.1：预先存在的硬链接按普通名读 ────────────────────────────────
    {
      const link = join(ADV, 'harmless.txt')
      spawnSync(CMD, ['/d', '/c', 'mklink', '/H', link, join(SENS, '.npmrc')], { encoding: 'utf8' })
      check('B1.0 前置：硬链接创建成功（否则本用例无判定力）', existsSync(link) && fileHas(link, MARK), `link=${link}`)
      const nodeRead = inject('r18-node', process.execPath, [
        '-e',
        `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(link)},'utf8'))}catch(e){process.stderr.write('DENIED:'+e.code);process.exit(9)}`,
      ])
      check(
        'B1.1 node 按普通名读硬链接别名 ⇒ 拒绝且无明文、暂存树无明文',
        !containsMark(nodeRead.text) && stagedHas(MARK) === 0 && nodeRead.status !== 0,
        `status=${nodeRead.status} leaked=${containsMark(nodeRead.text)} stagedLeak=${stagedHas(MARK)}`,
      )
      const cmdRead = inject('r18-cmd', CMD, ['/d', '/c', 'type', link])
      check(
        'B1.2 cmd type 按普通名读 ⇒ 不返回明文',
        !containsMark(cmdRead.text),
        `status=${cmdRead.status} leaked=${containsMark(cmdRead.text)}`,
      )
      const psRead = inject('r18-ps', PWSH, ['-NoProfile', '-NonInteractive', '-Command', `[IO.File]::ReadAllText('${link}')`])
      check(
        'B1.3 powershell [IO.File]::ReadAllText 按普通名读 ⇒ 不返回明文',
        !containsMark(psRead.text),
        `status=${psRead.status} leaked=${containsMark(psRead.text)}`,
      )
    }

    // ── B2 R18.2：从被遮蔽文件创建硬链接 ⇒ fail-closed ─────────────────────
    {
      const newLink = join(ADV, 'hl-from-masked.txt')
      rmSync(newLink, { force: true })
      const r = inject('r18-createhl', CMD, ['/d', '/c', 'mklink', '/H', newLink, join(SENS, '.npmrc')])
      check(
        'B2.1 注入进程 mklink /H 普通名 .npmrc ⇒ 拒绝（真实硬链接不存在）',
        !existsSync(newLink),
        `status=${r.status} realCreated=${existsSync(newLink)} text=${r.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
      )
    }

    // ── B2b R18.2：非遮蔽源的 CreateHardLink 必须暂存（真实盘零写） ─────────
    {
      const stagedLink = join(ADV, 'hl-normal-staged.txt')
      rmSync(stagedLink, { force: true })
      const r = inject('r18-hl-normal', CMD, ['/d', '/c', 'mklink', '/H', stagedLink, join(NORMAL, 'n1.txt')])
      const readBack = inject('r18-hl-normal-read', process.execPath, [
        '-e',
        `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(stagedLink)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`,
      ])
      check(
        'B2.2 非遮蔽源 mklink /H ⇒ 暂存语义（真实盘无新链接、暂存树可读回原内容）',
        !existsSync(stagedLink) && readBack.text.includes('NORMAL-1'),
        `status=${r.status} realCreated=${existsSync(stagedLink)} readBackStatus=${readBack.status} readBack=${readBack.text.trim().slice(0, 80)}`,
      )
    }

    // ── B3 R18.3：pnpm/WinSxS 风格正常硬链接不误伤 ─────────────────────────
    {
      const a = join(NORMAL, 'store-file.txt')
      const b = join(NORMAL, 'linked-file.txt')
      writeFileSync(a, 'R20-NORMAL-HARDLINK')
      rmSync(b, { force: true })
      spawnSync(CMD, ['/d', '/c', 'mklink', '/H', b, a], { encoding: 'utf8' })
      const readA = inject('r18-ctl-a', process.execPath, [
        '-e',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(a)},'utf8'))`,
      ])
      const readB = inject('r18-ctl-b', process.execPath, [
        '-e',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(b)},'utf8'))`,
      ])
      check(
        'B3.1 对照：普通文件的硬链接两个名字都可读（不误伤 pnpm/WinSxS 场景）',
        existsSync(b) && readA.text.includes('R20-NORMAL-HARDLINK') && readB.text.includes('R20-NORMAL-HARDLINK'),
        `made=${existsSync(b)} aStatus=${readA.status} bStatus=${readB.status}`,
      )
    }

    // ── B4 R19：三载体目录枚举不列出被遮蔽名 ────────────────────────────────
    {
      /* 隔离：清空暂存根。B2.2 在 NORMAL 下落过暂存副本，node 的目录句柄会解析到
       * 覆盖层目录；而"目录枚举不与真实目录合并"是**预存限制**（同一探针在 R19
       * canonical shim 上测得完全相同的 node 行为，见 findings R20-FS-R2）。枚举
       * 过滤的用例必须从干净暂存根开始，否则测到的是那条预存限制。 */
      rmSync(STAGE, { recursive: true, force: true })
      mkdirSync(STAGE, { recursive: true })
      const hideAll = (text) => {
        const lower = text.toLowerCase()
        return !lower.includes('.npmrc') && !lower.includes('.git-credentials')
      }
      const cmdDir = inject('r19-cmd', CMD, ['/d', '/c', 'dir', '/b', SENS])
      check(
        'B4.1 cmd dir 不列出 .npmrc/.git-credentials、仍列出 normal.txt',
        hideAll(cmdDir.text) && cmdDir.text.includes('normal.txt'),
        `text=${cmdDir.text.replace(/\r?\n/g, ' | ').slice(0, 200)}`,
      )
      const psDir = inject('r19-ps', PWSH, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-ChildItem -LiteralPath '${SENS}' -Force | ForEach-Object { $_.Name }`,
      ])
      check(
        'B4.2 powershell Get-ChildItem 不列出 .npmrc/.git-credentials、仍列出 normal.txt',
        hideAll(psDir.text) && psDir.text.includes('normal.txt'),
        `text=${psDir.text.replace(/\r?\n/g, ' | ').slice(0, 200)}`,
      )
      const nodeDir = inject('r19-node', process.execPath, [
        '-e',
        `process.stdout.write(require('fs').readdirSync(${JSON.stringify(SENS)}).join(','))`,
      ])
      check(
        'B4.3 node readdir（NtQueryDirectoryFile 载体）不列出 .npmrc/.git-credentials、仍列出 normal.txt',
        hideAll(nodeDir.text) && nodeDir.text.includes('normal.txt'),
        `text=${nodeDir.text.slice(0, 200)}`,
      )
    }

    // ── B5 R19.4：普通目录对照不丢条目 ──────────────────────────────────────
    {
      const cmdDir = inject('r19-ctl-cmd', CMD, ['/d', '/c', 'dir', '/b', NORMAL])
      const psDir = inject('r19-ctl-ps', PWSH, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-ChildItem -LiteralPath '${NORMAL}' -Force | ForEach-Object { $_.Name }`,
      ])
      const nodeDir = inject('r19-ctl-node', process.execPath, [
        '-e',
        `process.stdout.write(require('fs').readdirSync(${JSON.stringify(NORMAL)}).join(','))`,
      ])
      check(
        'B5.1 对照：普通目录 cmd / powershell / node 都保留 n1.txt 与 n2.txt',
        cmdDir.text.includes('n1.txt') &&
          cmdDir.text.includes('n2.txt') &&
          psDir.text.includes('n1.txt') &&
          psDir.text.includes('n2.txt') &&
          nodeDir.text.includes('n1.txt') &&
          nodeDir.text.includes('n2.txt'),
        `cmd=${cmdDir.text.replace(/\r?\n/g, '|').slice(0, 80)} node=${nodeDir.text.slice(0, 80)}`,
      )
    }

    // ── B6 R17.1：.NET File.Replace（ReplaceFileW 载体）fail-closed ─────────
    {
      const target = join(NORMAL, 'replace-target.txt')
      const replacement = join(NORMAL, 'replace-src.txt')
      const backup = join(NORMAL, 'replace-backup.txt')
      writeFileSync(target, 'R20-TARGET-ORIGINAL')
      writeFileSync(replacement, 'R20-REPLACEMENT')
      rmSync(backup, { force: true })
      const r = inject('r17-replace', PWSH, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[IO.File]::Replace('${target}','${replacement}','${backup}')`,
      ])
      const targetContent = (() => {
        try {
          return readFileSync(target, 'utf8')
        } catch {
          return '<missing>'
        }
      })()
      check(
        'B6.1 .NET [IO.File]::Replace ⇒ fail-closed：真实 target 内容不变、无 backup、replacement 仍在（真实盘零写）',
        targetContent === 'R20-TARGET-ORIGINAL' && !existsSync(backup) && existsSync(replacement) && readFileSync(replacement, 'utf8') === 'R20-REPLACEMENT',
        `target=${targetContent} backupExists=${existsSync(backup)} replacementExists=${existsSync(replacement)} text=${r.text.replace(/\r?\n/g, ' | ').slice(0, 200)}`,
      )
    }

    // ── B7 R20①：托管 x64 exe 载体回归（防枚举 hook 把 CLR 启动搞挂） ───────
    {
      const hello = join(REPO, '.t', 'carrier', 'bin', 'hello64.exe')
      if (!existsSync(hello)) {
        skip('B7.1 托管 x64 exe（csc /platform:x64 hello64.exe）经 injector 正常启动', `载体产物不在：${hello}`)
      } else {
        const r = inject('r20-hello64', hello, [])
        check(
          'B7.1 托管 x64 exe 经 injector 正常跑完且 stdout 正确（枚举 hook 不得挂 CLR 启动）',
          r.status === 0 && r.text.includes('HELLO-MANAGED'),
          `status=${r.status} text=${r.text.trim().slice(0, 200)}`,
        )
      }
    }
    // ── B8 R20 P0 收口：NT 命名空间 / Win32 设备别名必须走暂存/遮蔽管线 ─────
    // 红（canonical 收口前实测，.lead/logs/file-shim/pathbypass-r20.log）：
    //   原生模块用 \Device\HarddiskVolumeN\… / \??\Volume{GUID}\… / \\?\GLOBALROOT\Device\…
    //   / \\.\C:\… 可以真实盘写、遮蔽明文读、真实删除。
    // 绿：映射成普通 Win32 路径后统一走管线 —— 写意图 deny（真实盘零写）、遮蔽读 deny、
    //   delete 记 whiteout（真实文件仍在）、非遮蔽设备路径读保持可用。
    {
      const DEV_MARK = 'R20-DEV-MARK'
      const zig = join(REPO, 'tools', 'toolchain', 'zig-0.13.0', 'zig.exe')
      const devProbe = join(SCRATCH, 'r20-devprobe.exe')
      const devSrc = String.raw`#include <windows.h>
#include <winternl.h>
#include <stdio.h>
NTSTATUS NTAPI NtOpenFile(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG);
static int dev_of(const wchar_t *win, wchar_t *out, int cch){
  WCHAR drive[3]={win[0],win[1],0}; WCHAR d[512];
  if(!QueryDosDeviceW(drive,d,512)) return 0;
  out[0]=0; wcscpy(out,d); wcsncat(out,win+2,(size_t)cch-1-wcslen(out)); return 1;
}
static int gr_of(const wchar_t *win, wchar_t *out, int cch){
  wchar_t d[512]; WCHAR drive[3]={win[0],win[1],0};
  if(!QueryDosDeviceW(drive,d,512)) return 0;
  out[0]=0; wcscpy(out,L"\\\\?\\GLOBALROOT"); wcsncat(out,d,(size_t)cch-1-wcslen(out));
  wcsncat(out,win+2,(size_t)cch-1-wcslen(out)); return 1;
}
static int ntopen(const wchar_t *nt, ACCESS_MASK a, ULONG disp, ULONG opts, HANDLE *h){
  UNICODE_STRING n; n.Length=(USHORT)(wcslen(nt)*sizeof(WCHAR)); n.MaximumLength=(USHORT)(n.Length+sizeof(WCHAR)); n.Buffer=(WCHAR*)nt;
  OBJECT_ATTRIBUTES oa; InitializeObjectAttributes(&oa,&n,OBJ_CASE_INSENSITIVE,NULL,NULL);
  IO_STATUS_BLOCK ios; memset(&ios,0,sizeof(ios));
  return (int)NtCreateFile(h,a|SYNCHRONIZE,&oa,&ios,NULL,FILE_ATTRIBUTE_NORMAL,7,disp,opts,NULL,0);
}
int main(int argc,char**argv){
  if(argc<3) return 2;
  wchar_t p[1024]; MultiByteToWideChar(CP_ACP,0,argv[2],-1,p,1024);
  wchar_t dev[1024];
  if(!strcmp(argv[1],"ntwrite-dev")){
    if(!dev_of(p,dev,1024)) return 3;
    HANDLE h=INVALID_HANDLE_VALUE; if(ntopen(dev,GENERIC_WRITE,3,0x60,&h)<0) return 4;
    DWORD w=0; BOOL ok=WriteFile(h,"R20-DEV-MARK",12,&w,NULL); CloseHandle(h); return ok?0:5;
  }
  if(!strcmp(argv[1],"ntread-dev")){
    if(!dev_of(p,dev,1024)) return 3;
    HANDLE h=INVALID_HANDLE_VALUE; if(ntopen(dev,GENERIC_READ,1,0x60,&h)<0) return 6;
    char buf[256]; DWORD got=0; BOOL ok=ReadFile(h,buf,255,&got,NULL); CloseHandle(h);
    if(ok){ buf[got]=0; printf("CONTENT=%s\n",buf);} return ok?0:7;
  }
  if(!strcmp(argv[1],"ntdel-dev")){
    if(!dev_of(p,dev,1024)) return 3;
    UNICODE_STRING n; n.Length=(USHORT)(wcslen(dev)*sizeof(WCHAR)); n.MaximumLength=(USHORT)(n.Length+sizeof(WCHAR)); n.Buffer=dev;
    OBJECT_ATTRIBUTES oa; InitializeObjectAttributes(&oa,&n,OBJ_CASE_INSENSITIVE,NULL,NULL);
    IO_STATUS_BLOCK ios; memset(&ios,0,sizeof(ios)); HANDLE h=INVALID_HANDLE_VALUE;
    NTSTATUS st=NtOpenFile(&h,DELETE|SYNCHRONIZE,&oa,&ios,7,0x40|0x1000);
    if(st>=0) CloseHandle(h);
    return st<0?8:0;
  }
  if(!strcmp(argv[1],"winwrite-gr")){
    wchar_t g[1024]; if(!gr_of(p,g,1024)) return 3;
    HANDLE h=CreateFileW(g,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,0x80,NULL);
    if(h==INVALID_HANDLE_VALUE) return 9;
    DWORD w=0; BOOL ok=WriteFile(h,"R20-DEV-MARK",12,&w,NULL); CloseHandle(h); return ok?0:10;
  }
  if(!strcmp(argv[1],"ntread-sysroot")){
    WCHAR wd[512]; UINT wn=GetWindowsDirectoryW(wd,512); if(!wn||wn>=512) return 12;
    if(_wcsnicmp(p,wd,wn)!=0||p[wn]!=L'\\') return 13;
    wchar_t nt[1024]; wcscpy(nt,L"\\SystemRoot\\"); wcsncat(nt,p+wn+1,900-wcslen(nt));
    HANDLE h=INVALID_HANDLE_VALUE; if(ntopen(nt,GENERIC_READ,1,0x60,&h)<0) return 14;
    char buf[256]; DWORD got=0; BOOL ok=ReadFile(h,buf,255,&got,NULL); CloseHandle(h);
    if(ok){ buf[got]=0; printf("CONTENT=%s\n",buf);} return ok?0:15;
  }
  return 11;
}
`
      let devReady = false
      if (!existsSync(zig)) {
        skip('B8.0 设备路径行为断言（需 zig 编译原生探针）', `工具链不在：${zig}`)
      } else {
        const srcPath = join(SCRATCH, 'r20-devprobe.c')
        writeFileSync(srcPath, devSrc, 'utf8')
        for (const d of ['tmp', 'zigcache/global', 'zigcache/local']) mkdirSync(join(SCRATCH, d), { recursive: true })
        const comp = spawnSync(zig, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-o', devProbe, srcPath], {
          env: {
            ...process.env,
            TMP: join(SCRATCH, 'tmp'),
            TEMP: join(SCRATCH, 'tmp'),
            ZIG_GLOBAL_CACHE_DIR: join(SCRATCH, 'zigcache', 'global'),
            ZIG_LOCAL_CACHE_DIR: join(SCRATCH, 'zigcache', 'local'),
          },
          encoding: 'utf8',
          timeout: 180000,
        })
        devReady = comp.status === 0 && existsSync(devProbe)
        if (!devReady) {
          skip('B8.0 设备路径行为断言（需 zig 编译原生探针）', `zig 编译失败 status=${comp.status} ${String(comp.stderr ?? '').slice(0, 200)}`)
        }
      }
      const devDir = join(ADV, 'devpaths')
      mkdirSync(devDir, { recursive: true })
      if (!devReady) {
        skip('B8.1 NT 设备路径写意图 deny', 'devProbe 不可用')
        skip('B8.2 NT 设备路径读遮蔽文件拒绝', 'devProbe 不可用')
        skip('B8.3 NT 设备路径 delete-on-close 不真删', 'devProbe 不可用')
        skip('B8.4 Win32 GLOBALROOT 写进暂存', 'devProbe 不可用')
      } else {
        const devTarget = join(devDir, 'via-device.txt')
        rmSync(devTarget, { force: true })
        const wDev = inject('r20-ntwrite-dev', devProbe, ['ntwrite-dev', devTarget])
        check(
          'B8.1 NtCreateFile 经 \\Device\\HarddiskVolumeN\\… 写 ⇒ 拒绝，真实盘零写',
          !existsSync(devTarget),
          `status=${wDev.status} realExists=${existsSync(devTarget)} text=${wDev.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
        )
        const maskedDev = join(devDir, '.npmrc')
        writeFileSync(maskedDev, `${MARK}-DEV`)
        const rDev = inject('r20-ntread-dev', devProbe, ['ntread-dev', maskedDev])
        check(
          'B8.2 NtCreateFile 经设备路径读 .npmrc ⇒ 拒绝且无明文（遮蔽读边界不因别名失效）',
          !rDev.text.includes(`${MARK}-DEV`),
          `status=${rDev.status} leaked=${rDev.text.includes(`${MARK}-DEV`)} text=${rDev.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
        )
        const victim = join(devDir, 'victim-del.txt')
        writeFileSync(victim, 'R20-DEV-DELETE')
        const dDev = inject('r20-ntdel-dev', devProbe, ['ntdel-dev', victim])
        check(
          'B8.3 NtOpenFile(delete-on-close) 经设备路径 ⇒ 真实文件不删（overlay whiteout）',
          existsSync(victim),
          `status=${dDev.status} realStillExists=${existsSync(victim)} text=${dDev.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
        )
        const grTarget = join(devDir, 'via-globalroot.txt')
        rmSync(grTarget, { force: true })
        const wGr = inject('r20-winwrite-gr', devProbe, ['winwrite-gr', grTarget])
        const readGr = inject('r20-winread-gr-staged', process.execPath, [
          '-e',
          `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(grTarget)},'utf8'))}catch(e){process.stderr.write('ERR:'+e.code);process.exit(9)}`,
        ])
        check(
          'B8.4 CreateFileW(\\\\?\\GLOBALROOT\\Device\\…\\…) 写 ⇒ 走暂存（真实盘无文件、沙箱视图可读回）',
          !existsSync(grTarget) && readGr.text.includes(DEV_MARK),
          `writeStatus=${wGr.status} realExists=${existsSync(grTarget)} readStatus=${readGr.status} text=${wGr.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
        )
        /* \SystemRoot\… 是另一个可写 NT 别名；canonical 收口前经它读 Windows hosts
         * （遮蔽清单命中 `...\drivers\etc\hosts`）会拿到明文（pathbypass-red2 实测 leaked=true）。 */
        const hostsFile = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
        if (!existsSync(hostsFile)) {
          skip('B8.5 NtCreateFile 经 \\SystemRoot\\… 读被遮蔽 hosts ⇒ 拒绝', `hosts 文件不在：${hostsFile}`)
        } else {
          const rSys = inject('r20-ntread-sysroot-masked', devProbe, ['ntread-sysroot', hostsFile])
          check(
            'B8.5 NtCreateFile 经 \\SystemRoot\\… 读被遮蔽 Windows hosts ⇒ 拒绝且无内容',
            !rSys.text.includes('CONTENT='),
            `status=${rSys.status} contentSeen=${rSys.text.includes('CONTENT=')} text=${rSys.text.replace(/\r?\n/g, ' | ').slice(0, 160)}`,
          )
        }
      }
    }
  }
}

// ═════════════════════════ 汇总 ═════════════════════════
W('')
W('='.repeat(64))
const verdict = failures === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${verdict} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
