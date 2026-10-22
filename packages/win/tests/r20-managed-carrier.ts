#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架；本套件为 R20 新登记套件。
/**
 * r20-managed-carrier —— **R20① 纯托管 (.NET Framework) exe 直接载体的回归套件**
 *
 * 存在理由（先红后绿，红读数在 .lead/findings/carrier-r20.md）：
 *   R19-FSREG-03 记录"用注入器启动任意纯托管 exe 即崩"：注入器
 *   `{"stage":"inject","error":"remote LoadLibraryW failed","win32Error":1114}`，
 *   子进程 WER 落在 ucrtbase.dll 0xC0000005。
 *
 *   根因（R20 已定位到行，两处，缺一不可）：
 *   A. **混合位宽镜像的导入表被按 8 字节 thunk 解析**：csc 默认 /platform:anycpu 的
 *      托管 exe 是 PE32/i386 镜像（machine=0x14c），却跑在 x64 进程里；其导入表只有
 *      4 字节 thunk（hello.exe: mscoree!`_CorExeMain`），`ws_patch_module()` 按 x64 的
 *      8 字节 `IMAGE_THUNK_DATA` 步进会越过 NULL 终止符读到 hint/name 字符串字节，
 *      把字符串（如 0x69614d657845726f = "orExeMai"）当 RVA 算成非法指针交给
 *      `strcmp` ⇒ ucrtbase!strcmp+0xb 0xC0000005。修复：IAT 补丁只处理与本进程
 *      同 machine 的镜像（`ws_hook.c::ws_patch_module`，Lead 落盘）。
 *   B. **重初始化跑在 DllMain/loader-lock 窗口**：远程 LoadLibraryW 只跑 DllMain，
 *      而 DllMain 里做 OpenProcessToken / attach reg hive / 全模块 IAT 补丁 / 日志 I/O，
 *      对"入口是 mscoree、CLR 尚未初始化"的进程尤其危险，且任何失败都表现为
 *      "整个 LoadLibraryW 失败"（1114），无法归因。修复：**延迟初始化** ——
 *      `DllMain` 只登记意图并返回；`winstage-inject.exe` / `ws_proc.c` 自注入在
 *      LoadLibraryW 返回后用**独立远程线程**调用导出的 `WinstageShimInit()`，等它
 *      返回（就绪）后才 ResumeThread；初始化失败变成可读的 `shimInitRc`。
 *
 *   本套件把两件事钉成硬断言：
 *     S0 静态契约：重活不得回到 DllMain（injector/自注入必须显式调用导出）；
 *     S1 夹具：csc 造 AnyCPU(PE32/i386) 与 x64 两份托管 exe；
 *     S2 核心回归：AnyCPU 托管 exe 经注入器启动 ⇒ 正常输出/exit 0/`shimInitRc:0`
 *        （修前：exit=111、`win32Error:1114`、WER ucrtbase 0xC0000005）；
 *     S3 `WINSTAGE_SHIM_DISABLE=1` 对照：仍正常（且 shim 不初始化，rc=1058）；
 *     S4 托管写操作进暂存、**真实盘零写**；S5 托管删除 ⇒ 白障、真实文件仍在；
 *     S6 托管注册表写 ⇒ 真实 HKCU 不变、暂存 registry journal 非空；
 *     S7 x64 托管 exe 对照（防"只修 AnyCPU 分支"的假绿）；
 *     S8 native 载体（node）注入无回归；
 *     S9 子进程自注入路径（ws_proc.c）同样走显式初始化：cmd 里再起 node，
 *        两个 PID 都必须在 shim.log 里有 `initialized:` 行；
 *     S10 直接 LoadLibrary 的消费者（winstage-probe selftest）显式调用导出仍可用；
 *     S11 三件套同版判据（部署残余）：注入器必须说延迟初始化协议（报告 shimInitRc）、
 *        DLL 导出 ABI 与 winstage_shim.h 一致、加载后真的 `initialized:` ——
 *        “旧注入器 + 新 DLL”这种静默不初始化的组合会在这里变红（发布门 + 文档 §13 R20 行）。
 *
 * 跳过条件（如实 SKIP，不是 PASS）：
 *   · 非 win32；
 *   · canonical `shim\out` 的 DLL/注入器缺失（用 WINSTAGE_SHIM_OUT 指向别的产物目录）；
 *   · 找不到 .NET Framework csc（`Framework64|Framework\v4.0.30319\csc.exe`）——
 *     此时 S1/S2/S3/S4/S5/S6/S7/S9 逐条 SKIP 并给出原因；静态断言照跑。
 *   · 缺 winstage-probe.exe → 只 SKIP S10。
 *
 * 用法：node tests\r20-managed-carrier.ts
 * 证据：每次运行把夹具/报告/shim.log/暂存树留在 `.t\r20-managed-carrier\`。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skipSuiteWhenAppControlBlocks } from './_app-control.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = join(REPO, '.t', 'r20-managed-carrier')
const OUT = process.env.WINSTAGE_SHIM_OUT ? resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : join(REPO, 'shim', 'out')
const DLL = join(OUT, 'winstage-shim.dll')
const INJECTOR = join(OUT, 'winstage-inject.exe')
const PROBE = join(OUT, 'winstage-probe.exe')
const SHIM_SRC = join(REPO, 'shim', 'src')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

// 环境闸门（2026-10-22）：Smart App Control 强制态会拒绝 C# 现场编译出的 exe（Win32 4551）。
if (skipSuiteWhenAppControlBlocks(W, 'r20-managed-carrier')) process.exit(0)

// S11「三件套同版」判据的运行时读数（分别由 S2 / S10 填充；csc 缺失时保持 null）。
let anyCpuRun = null
let probeSelftest = null

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`  ${condition ? '✓' : '✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ~ SKIP ${name}：${reason}`)
}
function skipAll(reason) {
  W('')
  W(`RESULT: SKIP checks=0 failures=0 reason=${reason}`)
  process.exit(0)
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
function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}
function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------- preflight */

if (process.platform !== 'win32') skipAll('requires-win32')
for (const [label, path] of [['dll', DLL], ['injector', INJECTOR]]) {
  if (!existsSync(path)) {
    skipAll(`missing-${label}-${path} (run: node tools\\build-shim.ts, or set WINSTAGE_SHIM_OUT)`)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const CSC_CANDIDATES = [
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]
const CSC = CSC_CANDIDATES.find((path) => existsSync(path)) || null
const NODE_EXE = process.execPath
const CMD = process.env.ComSpec || 'cmd.exe'

/* ----------------------------------------------------- injection harness */

function paths(tag) {
  const stage = join(SCRATCH, `stage-${tag}`)
  const real = join(SCRATCH, `real-${tag}`)
  return {
    stage,
    real,
    log: join(stage, 'shim.log'),
    report: join(SCRATCH, `report-${tag}.json`),
  }
}

/**
 * 用产品注入器启动一个子进程。stage root 每个 case 唯一（与 verify.cmd 给每个套件的
 * 唯一 root 是同一纪律），返回值带 injector report（JSON）与完整 stdout/stderr。
 */
function inject(tag, exe, args, extraEnv = {}, timeout = 90000) {
  const p = paths(tag)
  mkdirSync(p.stage, { recursive: true })
  mkdirSync(p.real, { recursive: true })
  rmSync(p.report, { force: true })
  const env = {
    ...process.env,
    WINSTAGE_STAGE_ROOT: p.stage,
    WINSTAGE_SHIM_LOG: p.log,
    ...extraEnv,
  }
  // verify.cmd 给每个套件设了 WINSTAGE_STAGE_ROOT；显式覆盖成这个 case 自己的 root。
  const r = spawnSync(INJECTOR, ['--dll', DLL, '--report', p.report, '--cwd', SCRATCH, '--', exe, ...args], {
    env,
    encoding: 'utf8',
    timeout,
  })
  let report = null
  try {
    report = JSON.parse(readFileSync(p.report, 'utf8'))
  } catch {
    report = null
  }
  return {
    ...p,
    status: r.status ?? -1,
    text: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    report,
    timedOut: r.error?.code === 'ETIMEDOUT',
  }
}

/** 读一个 PE 的 machine 字段（0x14c=i386/PE32, 0x8664=x64/PE32+）。 */
function peMachine(file) {
  try {
    const buf = readFileSync(file)
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null
    const eLfanew = buf.readUInt32LE(0x3c)
    if (buf.readUInt32LE(eLfanew) !== 0x00004550) return null
    return buf.readUInt16LE(eLfanew + 4)
  } catch {
    return null
  }
}

const HELLO_CS = `using System;
class Hello { static int Main(string[] a) { Console.WriteLine("HELLO-MANAGED"); return 0; } }
`

const MANAGED_CS = `using System;
using System.IO;
using Microsoft.Win32;
class R20Managed {
  static int Main(string[] args) {
    string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "hello";
    try {
      if (mode == "hello") { Console.WriteLine("HELLO-MANAGED"); return 0; }
      if (mode == "write") {
        string target = args[1]; string content = args[2];
        string dir = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(target, content);
        string back = File.Exists(target) ? File.ReadAllText(target) : null;
        Console.WriteLine("MANAGED-WRITE exists=" + File.Exists(target) + " readback=" + (back == content));
        return back == content ? 0 : 3;
      }
      if (mode == "delete") {
        string target = args[1];
        if (File.Exists(target)) File.Delete(target);
        Console.WriteLine("MANAGED-DELETE exists=" + File.Exists(target));
        return 0;
      }
      if (mode == "reg") {
        string sub = args[1]; string value = args[2];
        Registry.SetValue("HKEY_CURRENT_USER\\\\Software\\\\" + sub, "R20Value", value, RegistryValueKind.String);
        object got = Registry.GetValue("HKEY_CURRENT_USER\\\\Software\\\\" + sub, "R20Value", null);
        Console.WriteLine("MANAGED-REG readback=" + ((got as string) == value));
        return ((got as string) == value) ? 0 : 3;
      }
      Console.WriteLine("UNKNOWN-MODE " + mode); return 2;
    } catch (Exception e) {
      Console.WriteLine("MANAGED-EXCEPTION " + e.GetType().Name + ": " + e.Message); return 4;
    }
  }
}
`

function compileManaged(name, source, platform) {
  const src = join(SCRATCH, `${name}.cs`)
  const exe = join(SCRATCH, `${name}.exe`)
  writeFileSync(src, source)
  const r = spawnSync(CSC, ['/nologo', '/target:exe', `/platform:${platform}`, `/out:${exe}`, src], {
    encoding: 'utf8',
    timeout: 120000,
  })
  return { exe, status: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/* ------------------------------------------------ S0 static transport contract */

section('S0 静态契约：重活必须在显式初始化里，不得回到 DllMain')
{
  const entry = readText(join(SHIM_SRC, 'ws_entry.c'))
  const dllMainAt = entry.indexOf('BOOL WINAPI DllMain')
  const dllMainBody = dllMainAt >= 0 ? entry.slice(dllMainAt) : ''
  check(
    'S0.1 shim/src/ws_entry.c 的 DllMain 不再调用 ws_init_full（延迟初始化）',
    dllMainAt >= 0 && dllMainBody.length > 0 && !dllMainBody.includes('ws_init_full'),
    dllMainAt < 0 ? 'ws_entry.c 里找不到 DllMain' : `DllMain 之后的 ${dllMainBody.length} 字符内无 ws_init_full`,
  )
  const injector = readText(join(REPO, 'shim', 'injector', 'winstage-inject.c'))
  check(
    'S0.2 注入器在 LoadLibraryW 之后显式远程调用 WinstageShimInit',
    injector.includes('WinstageShimInit') && injector.includes('CreateRemoteThread') && injector.includes('resolve_remote_export'),
    `injector 文本长度=${injector.length}`,
  )
  const proc = readText(join(SHIM_SRC, 'ws_proc.c'))
  check(
    'S0.3 子进程自注入（ws_proc.c）同样显式远程初始化',
    proc.includes('ws_remote_init') && proc.includes('WinstageShimInit') && proc.includes('CreateRemoteThread'),
    `ws_proc.c 文本长度=${proc.length}`,
  )
  const header = readText(join(SHIM_SRC, '..', 'include', 'winstage_shim.h'))
  check(
    'S0.4 WinstageShimInit 仍在公开导出 ABI 中',
    header.includes('WinstageShimInit'),
    header.includes('WinstageShimInit') ? 'winstage_shim.h 声明存在' : 'winstage_shim.h 缺声明',
  )
  // 根因 A 的机器校验：AnyCPU 托管镜像是 PE32/i386，却被 x64 进程看到 —— 若有人删掉
  // 这道过滤，4 字节 thunk 会被按 8 字节解析，越过 NULL 终止符把字符串字节当 RVA。
  // 行为上能否复现取决于具体 PE 布局（见 findings 的红读数），所以这里钉源码不变量。
  const hook = readText(join(SHIM_SRC, 'ws_hook.c'))
  const patchModuleAt = hook.indexOf('static int ws_patch_module(')
  const patchModuleBody = patchModuleAt >= 0 ? hook.slice(patchModuleAt, hook.indexOf('static int ws_patch_all(', patchModuleAt)) : ''
  const guardAt = patchModuleBody.indexOf('FileHeader.Machine')
  const importParseAt = patchModuleBody.indexOf('IMAGE_IMPORT_DESCRIPTOR')
  check(
    'S0.5 ws_hook.c::ws_patch_module 按本进程 machine 过滤镜像，且校验在导入表解析之前',
    patchModuleBody.length > 0 &&
      guardAt >= 0 &&
      importParseAt > guardAt &&
      (patchModuleBody.includes('IMAGE_FILE_MACHINE_AMD64') || patchModuleBody.includes('IMAGE_FILE_MACHINE_I386')),
    patchModuleBody.length === 0
      ? '找不到 ws_patch_module 函数体'
      : `guardAt=${guardAt} importParseAt=${importParseAt}`,
  )

  // ── 三件套同版（部署残余）判据 —— 静态半 ──────────────────────────────
  // 背景：DllMain 惰性化后，**旧注入器 + 新 DLL** 会"加载成功但永不初始化"（静默无钩子）。
  // 项目的发布门是 build-shim 一次性原子发布 DLL/注入器/probe 三件套；下面两条钉住
  // "注入器必须说延迟初始化协议（报告 shimInitRc）" 与 "发布门必须要求 ABI 导出"，
  // 运行时半（ABI 握手 + 真的初始化了）见 S11。文档口径见 docs §13 R20 行。
  check(
    'S0.6 注入器必须把初始化结果写进报告（shimInitRc 字段；旧注入器没有 ⇒ 静默不初始化无法发现）',
    injector.includes('shimInitRc'),
    'injector 源码含 shimInitRc 报告字段',
  )
  const buildShim = readText(join(REPO, 'tools', 'build-shim.ts'))
  const reqAt = buildShim.indexOf('const requiredExports = [')
  const reqBody = reqAt >= 0 ? buildShim.slice(reqAt, buildShim.indexOf('];', reqAt)) : ''
  check(
    'S0.7 发布门（build-shim requiredExports）同时要求 WinstageShimInit 与 ABI 导出（三件套原子发布）',
    reqBody.includes('WinstageShimInit') &&
      reqBody.includes('WinstageShimAbiVersion') &&
      reqBody.includes('WinstageShimStatsJson'),
    `requiredExports=${reqBody.replace(/\s+/g, ' ').slice(0, 300)}`,
  )
}

/* ------------------------------------------- S1 fixtures (needs csc / .NET Framework) */

let helloAny = null
let helloX64 = null
let managedAny = null

if (!CSC) {
  skip('S1 csc 夹具', `找不到 .NET Framework csc（尝试过 ${CSC_CANDIDATES.join(' ; ')}）`)
} else {
  section('S1 夹具：csc 造 AnyCPU(PE32/i386) 与 x64 托管 exe')
  const any = compileManaged('hello-anycpu', HELLO_CS, 'anycpu')
  const x64 = compileManaged('hello-x64', HELLO_CS, 'x64')
  const mgd = compileManaged('r20managed-anycpu', MANAGED_CS, 'anycpu')
  check('S1.1 csc 编译 AnyCPU/x64 托管 exe 成功', any.status === 0 && x64.status === 0 && mgd.status === 0, `any=${any.status} x64=${x64.status} managed=${mgd.status}`)
  if (any.status === 0 && x64.status === 0 && mgd.status === 0) {
    helloAny = any.exe
    helloX64 = x64.exe
    managedAny = mgd.exe
    check('S1.2 AnyCPU 托管 exe 是 PE32/i386 镜像（machine=0x14c，正是崩溃根因的形态）', peMachine(helloAny) === 0x14c, `machine=0x${(peMachine(helloAny) ?? 0).toString(16)}`)
    check('S1.3 x64 托管 exe 是 PE32+/x64 镜像（对照）', peMachine(helloX64) === 0x8664, `machine=0x${(peMachine(helloX64) ?? 0).toString(16)}`)
  } else {
    skip('S1.2/S1.3 PE machine 断言', `编译失败：${(any.text || x64.text || mgd.text).slice(0, 300)}`)
  }
}

/* --------------------------------------- S2 core regression: AnyCPU managed exe */

section('S2 核心回归：AnyCPU 纯托管 exe 经注入器启动（修前 exit=111 / 1114 / WER 0xC0000005）')
if (!helloAny) {
  skip('S2 AnyCPU 托管 exe 注入', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const r = inject('s2-anycpu', helloAny, [])
  anyCpuRun = r
  const log = readText(r.log)
  check(
    'S2.1 注入器返回 ok:true 且子进程 exit 0（不再是 111/1114）',
    r.report?.ok === true && r.status === 0,
    `status=${r.status} report=${JSON.stringify(r.report)} text=${r.text.slice(0, 200)}`,
  )
  check('S2.2 托管 exe 正常执行并输出 HELLO-MANAGED', r.text.includes('HELLO-MANAGED'), `stdout=${r.text.slice(0, 200)}`)
  check(
    'S2.3 注入器显式初始化就绪（report.shimInitRc === 0）',
    r.report?.shimInitRc === 0,
    `shimInitRc=${r.report?.shimInitRc}`,
  )
  check(
    'S2.4 shim 在子进程内完成初始化（shim.log 有 initialized: 行）',
    log.includes('initialized:'),
    `shim.log 前 300 字：${log.slice(0, 300)}`,
  )
}

/* -------------------------------------------------- S3 WINSTAGE_SHIM_DISABLE=1 */

section('S3 对照：WINSTAGE_SHIM_DISABLE=1 仍正常（且不初始化）')
if (!helloAny) {
  skip('S3 DISABLE 对照', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const r = inject('s3-disable', helloAny, [], { WINSTAGE_SHIM_DISABLE: '1' })
  check(
    'S3.1 DISABLE=1 时托管 exe 正常输出/exit 0',
    r.status === 0 && r.text.includes('HELLO-MANAGED') && r.report?.ok === true,
    `status=${r.status} text=${r.text.slice(0, 160)}`,
  )
  check(
    'S3.2 DISABLE=1 时 shim 不初始化（report.shimInitRc=1058 ERROR_SERVICE_DISABLED，无 shim.log）',
    r.report?.shimInitRc === 1058 && !existsSync(r.log),
    `shimInitRc=${r.report?.shimInitRc} logExists=${existsSync(r.log)}`,
  )
}

/* ---------------------------------- S4 managed write => staged, real disk untouched */

section('S4 托管写操作进暂存、真实盘零写')
if (!managedAny) {
  skip('S4 托管写', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const p = paths('s4-managed-write')
  const target = join(p.real, 'managed.txt')
  const r = inject('s4-managed-write', managedAny, ['write', target, 'managed-content'])
  const staged = walkFiles(join(r.stage, 'fs')).filter((file) => readText(file).includes('managed-content'))
  check(
    'S4.1 托管 .NET File.WriteAllText 成功且回读一致',
    r.status === 0 && r.text.includes('MANAGED-WRITE') && r.text.includes('readback=True'),
    `status=${r.status} text=${r.text.slice(-200)}`,
  )
  check('S4.2 真实盘不存在目标文件（写被暂存）', !existsSync(target), `realExists=${existsSync(target)} target=${target}`)
  check('S4.3 暂存树里有目标文件且内容正确', staged.length > 0, `staged=${staged.slice(0, 3).join(', ') || '(none)'}`)
}

/* ---------------------------------------- S5 managed delete => whiteout, real file kept */

section('S5 托管删除 ⇒ 白障（真实文件仍在）')
if (!managedAny) {
  skip('S5 托管删除', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const p = paths('s5-managed-delete')
  mkdirSync(p.real, { recursive: true })
  const target = join(p.real, 'existing.txt')
  writeFileSync(target, 'ORIGINAL')
  const r = inject('s5-managed-delete', managedAny, ['delete', target])
  const whiteouts = walkFiles(join(r.stage, 'wo')).filter((file) => file.endsWith('existing.txt'))
  check(
    'S5.1 托管 File.Delete 在暂存视图里生效（exists=False）',
    r.status === 0 && r.text.includes('MANAGED-DELETE exists=False'),
    `status=${r.status} text=${r.text.slice(-160)}`,
  )
  check('S5.2 真实盘文件仍在（删除被白障化）', existsSync(target) && readText(target) === 'ORIGINAL', `realExists=${existsSync(target)}`)
  check('S5.3 暂存白障记录存在', whiteouts.length > 0, `wo=${whiteouts.slice(0, 3).join(', ') || '(none)'}`)
}

/* ------------------------- S6 managed registry write => real HKCU untouched, WAL/journal */

section('S6 托管注册表写 ⇒ 真实 HKCU 不变、暂存 journal 非空')
if (!managedAny) {
  skip('S6 托管注册表', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const subKey = 'R20ManagedCarrierSuite'
  const fullKey = `HKCU\\Software\\${subKey}`
  spawnSync('reg.exe', ['delete', fullKey, '/f'], { encoding: 'utf8' })
  const r = inject('s6-managed-reg', managedAny, ['reg', subKey, 'r20-value'])
  const realQuery = spawnSync('reg.exe', ['query', fullKey], { encoding: 'utf8' })
  const journal = fileSize(join(r.stage, 'registry', 'overlay.journal'))
  check(
    'S6.1 托管 Registry.SetValue 成功且暂存视图回读一致',
    r.status === 0 && r.text.includes('MANAGED-REG readback=True'),
    `status=${r.status} text=${r.text.slice(-160)}`,
  )
  check('S6.2 真实 HKCU 未出现该键（写被暂存）', realQuery.status !== 0, `reg query exit=${realQuery.status}`)
  check('S6.3 暂存 registry journal 非空（有暂存记录）', journal > 0, `journalBytes=${journal}`)
  // 回归防御：即使上面哪条红了，也不把测试键留在真实 HKCU。
  spawnSync('reg.exe', ['delete', fullKey, '/f'], { encoding: 'utf8' })
}

/* ---------------------------------------------- S7 x64 managed control (same fix path) */

section('S7 对照：x64 托管 exe（防只修 AnyCPU 分支的假绿）')
if (!helloX64) {
  skip('S7 x64 托管 exe', CSC ? '夹具未编译成功' : '缺 csc')
} else {
  const r = inject('s7-x64', helloX64, [])
  check(
    'S7.1 x64 托管 exe 注入后正常输出/exit 0/shimInitRc 0',
    r.status === 0 && r.text.includes('HELLO-MANAGED') && r.report?.shimInitRc === 0,
    `status=${r.status} report=${JSON.stringify(r.report)}`,
  )
}

/* ------------------------------------------------------ S8 native carrier no regression */

section('S8 native 载体无回归（node 注入）')
{
  const r = inject('s8-node', NODE_EXE, ['-e', "console.log('NATIVE-NODE')"])
  check(
    'S8.1 node 载体注入后正常输出/exit 0',
    r.status === 0 && r.text.includes('NATIVE-NODE') && r.report?.ok === true,
    `status=${r.status} text=${r.text.slice(-160)}`,
  )
}

/* -------------------------------- S9 child self-injection path (ws_proc.c) uses explicit init */

section('S9 子进程自注入路径同样显式初始化（cmd → node，两个 PID 都要 initialized）')
{
  const childScript = join(SCRATCH, 'childnode.cjs')
  const wrapper = join(SCRATCH, 'childnode.cmd')
  writeFileSync(childScript, "console.log('CHILD-NODE');\n")
  writeFileSync(wrapper, `@echo off\r\n"${NODE_EXE}" "${childScript}"\r\n`)
  const r = inject('s9-cmdchild', CMD, ['/d', '/c', wrapper])
  const log = readText(r.log)
  const initPids = new Set()
  for (const match of log.matchAll(/^\[winstage-shim\]\[(\d+)\]\[\d+\] initialized:/gm)) initPids.add(match[1])
  check(
    'S9.1 cmd 载体与它自注入的 node 子进程都正常执行',
    r.status === 0 && r.text.includes('CHILD-NODE') && r.report?.ok === true,
    `status=${r.status} text=${r.text.slice(-200)}`,
  )
  check(
    'S9.2 shim.log 里至少 2 个不同 PID 完成 initialized（自注入也走了显式初始化）',
    initPids.size >= 2,
    `initializedPids=${[...initPids].join(',') || '(none)'}`,
  )
}

/* ------------------------- S10 direct-LoadLibrary consumer: explicit export still works */

section('S10 直接 LoadLibrary 的消费者（winstage-probe selftest）显式 Init 仍可用')
if (!existsSync(PROBE)) {
  skip('S10 probe selftest', `缺 ${PROBE}`)
} else {
  const outJson = join(SCRATCH, 'probe-selftest.json')
  rmSync(outJson, { force: true })
  const env = { ...process.env, WINSTAGE_SHIM_DISABLE: '1' }
  delete env.WINSTAGE_STAGE_ROOT
  const r = spawnSync(PROBE, ['selftest', DLL, outJson], { env, encoding: 'utf8', timeout: 60000 })
  let probe = null
  try {
    probe = JSON.parse(readFileSync(outJson, 'utf8'))
  } catch {
    probe = null
  }
  probeSelftest = probe
  check(
    'S10.1 直接 LoadLibrary + 显式 WinstageShimInit 可用（loaded/hasInitExport）',
    r.status === 0 && probe?.loaded === true && probe?.hasInitExport === true,
    `probe=${JSON.stringify(probe)?.slice(0, 300)} status=${r.status}`,
  )
  check(
    'S10.2 DISABLE=1 时显式 Init 返回 1058（初始化入口可见、可归因）',
    probe?.initReturn === 1058,
    `initReturn=${probe?.initReturn}`,
  )
}

/* ---------------- S11 三件套同版判据（运行时半：ABI 握手 + 真的初始化了） */

section('S11 三件套同版判据（运行时半：ABI 握手 / 延迟初始化协议 / 真的初始化了）')
{
  const header = readText(join(REPO, 'shim', 'include', 'winstage_shim.h'))
  const abiMatch = /#define\s+WINSTAGE_SHIM_ABI_VERSION\s+\(?(\d+)u?\)?/.exec(header)
  const abi = abiMatch ? Number(abiMatch[1]) : null
  check('S11.1 ABI 版本可从 winstage_shim.h 解析（同版判断的版本锚）', abi !== null && abi > 0, `headerAbi=${abi}`)
  if (existsSync(PROBE)) {
    check(
      'S11.2 DLL 导出的 ABI 与源码声明一致（probe selftest abiVersion === header ABI）',
      abi !== null && probeSelftest?.abiVersion === abi,
      `probeAbi=${probeSelftest?.abiVersion} headerAbi=${abi}`,
    )
  } else {
    skip('S11.2 ABI 握手', `缺 ${PROBE}`)
  }
  if (!anyCpuRun) {
    skip('S11.3/S11.4 注入器协议 + 真的初始化', CSC ? 'AnyCPU 夹具未注入成功' : '缺 csc')
  } else {
    check(
      'S11.3 注入器使用延迟初始化协议（成功报告带 shimInitRc 字段；旧注入器没有 ⇒ 静默不初始化可被发现）',
      anyCpuRun.report != null && Object.prototype.hasOwnProperty.call(anyCpuRun.report, 'shimInitRc'),
      `report=${JSON.stringify(anyCpuRun.report)?.slice(0, 240)}`,
    )
    check(
      'S11.4 DLL 真的初始化了（shim.log 有 initialized:，排除"加载成功但静默"）',
      readText(anyCpuRun.log).includes('initialized:'),
      `logExists=${existsSync(anyCpuRun.log)}`,
    )
  }
}

/* -------------------------------------------------------------------- result */

W('')
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} skips=${skips}`)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
