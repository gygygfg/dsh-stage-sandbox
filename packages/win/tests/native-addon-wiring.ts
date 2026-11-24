#!/usr/bin/env node
// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .ts 源直跑（Node 类型剥离）
/**
 * native-addon-wiring —— 宿主进程内启动器（N-API addon）的**接线**守护
 * ============================================================================
 * 背景（2026-11-24 实测）：透明档原本为每条命令 spawn 一个 helper
 * （`bin\elevate.exe`），进程树里因此永远多一层：
 *
 *     DeepSeek Harness.exe -> elevate.exe -- cmd.exe /d /c ...\run-<hex>.cmd
 *
 * 真实模型 `Get-CimInstance Win32_Process` 一眼就能看到它。改名只能让名字变普通，
 * 去掉这一层的唯一办法是**宿主进程自己** CreateProcess(SUSPENDED)+注入 ——
 * `shim/addon/winstage-addon.c` 就是这个 N-API 模块，它复用 `ws_launch.c`
 * （CLI 注入器也用同一份代码，两边不可能漂移）。
 *
 * 本套件只做**静态**检查（读源码/PE 头），不启动任何 Windows 进程，因此可以在
 * Linux/CI 上直接跑；真实行为（无 helper 进程、孙进程 stdio 正常）见
 * `docs/AI红队渗透实测-2026-11-23.md` §14 的实测记录。
 *
 * 检查项：
 *   1. 产物命名/加载顺序：executor 会从"包内同目录 → shim 产物目录"找 addon，
 *      缺失时**不抛错**而是如实记录（`available:false` + 原因）。
 *   2. 只有"测试替身"（capability 自带另一个 spawn）才禁用 addon；生产环境里
 *      `cap.spawnTransparentProcess === spawnCapturedAsync` 必须启用。
 *   3. 失败回退：addon 创建进程失败时回退 helper 并把原因留在 `lastLaunch`。
 *   4. addon 源码：导出 `napi_register_module_v1`，**不**链接 libnode（运行时
 *      GetProcAddress 解析），因此单条 `zig cc -shared` 就能构建。
 *   5. 构建接线：`build-shim` 产出 `wds.node`（中立名，见 §6）且**不**把它塞进
 *      `artifactNames()`（三件套的 --check/--repair-stale 契约不变）；
 *      `build-plugin` 把它拷进 `dist/`。
 *   6. 已构建的 `.node`（若存在）：x64 DLL、导出 `napi_register_module_v1`、
 *      不 import node.exe/node.dll。
 *   7. shim 侧修复：CreateProcess 钩子把调用方**被重定向的** stdio 转发给子进程
 *      （否则孙进程拿到 NUL/控制台句柄：`cmd /c echo` 零输出、`tasklist | findstr`
 *      直接挂住 —— 两条都是实测）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { artifactNames } from '../tools/build-shim.ts'
import { parsePe } from '../tools/pe-exports.ts'
import { loadNativeAddon, resolveShimArtifacts, spawnCapturedAsync } from '../src/executor.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const W = (text) => process.stdout.write(`${text}\n`)
let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) passed += 1
  else failed += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

function read(rel) {
  const full = join(REPO, rel)
  return existsSync(full) ? readFileSync(full, 'utf8') : ''
}

W('=== 1. addon 源码：稳定 ABI、不链接 libnode ===')
const addonSrc = read('shim/addon/winstage-addon.c')
check('addon 源存在', addonSrc.length > 0, 'shim/addon/winstage-addon.c')
check(
  '导出稳定入口 napi_register_module_v1',
  /__declspec\(dllexport\)\s+napi_value\s+napi_register_module_v1/.test(addonSrc),
)
check(
  '运行期解析 N-API（GetProcAddress），不使用 node_api.h/libs',
  /napi_get_cb_info/.test(addonSrc) &&
    /GetProcAddress/.test(addonSrc) &&
    !/#include\s*[<"]node_api\.h[>"]/.test(addonSrc) &&
    !/#include\s*[<"]napi\.h[>"]/.test(addonSrc),
)
check(
  '只暴露 launch/poll/terminate/version',
  ['launch', 'poll', 'terminate'].every((name) => addonSrc.includes(`"${name}"`)) &&
    addonSrc.includes('winstage-native/1'),
)
check(
  '复用 ws_launch 核心（与 CLI 注入器同一份）',
  addonSrc.includes('../injector/ws_launch.h') && addonSrc.includes('ws_launch(&req'),
)
check(
  'stdio 走文件句柄（HANDLE_LIST 只是收紧继承，不是管道）',
  /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/.test(read('shim/injector/ws_launch.c')),
)

W('')
W('=== 2. 产物解析与加载顺序 ===')
const artifacts = resolveShimArtifacts({ shimDir: join(REPO, 'shim', 'out') })
check(
  'resolveShimArtifacts 给出 addonPath',
  typeof artifacts.addonPath === 'string' && /wds\.node$/.test(artifacts.addonPath),
  artifacts.addonPath,
)
const missing = loadNativeAddon({ addonPath: join(REPO, 'shim', 'out', 'definitely-missing.node') })
check(
  '缺失时不抛错，返回 available:false + tried',
  missing.available === false && Array.isArray(missing.tried) && missing.tried.length >= 1,
  JSON.stringify({ available: missing.available, error: String(missing.error).slice(0, 80) }),
)

W('')
W('=== 3. 执行器接线（生产启用 / 替身禁用 / 失败回退） ===')
const executorSrc = read('src/executor.ts')
check(
  '生产环境（cap.spawnTransparentProcess === spawnCapturedAsync）启用 addon',
  /cap\.spawnTransparentProcess !== spawnCapturedAsync/.test(executorSrc),
)
check(
  '只有测试替身才禁用 addon 并写明原因',
  /test double\); native launcher disabled/.test(executorSrc),
)
check(
  'addon 创建失败 ⇒ 回退 helper，原因进 lastLaunch',
  /NATIVE_LAUNCH_FAILED/.test(executorSrc) && /nativeFallback/.test(executorSrc),
)
check(
  '超时/终止走 addon（native.terminate），不是只靠 taskkill',
  /native\.addon\.terminate\(pid, exitCode\)/.test(executorSrc),
)
check(
  'initReport 暴露 nativeLauncher.available/path/error',
  /nativeLauncher: this\.nativeLauncher/.test(executorSrc) &&
    /available: this\.nativeLauncher\.available === true/.test(executorSrc),
)

W('')
W('=== 4. 构建接线 ===')
const buildShimSrc = read('tools/build-shim.ts')
check(
  'build-shim 产出 wds.node',
  buildShimSrc.includes("path.join(OUT, 'wds.node')"),
)
check(
  'addon 不属于三件套（--check/--repair-stale 契约不变）',
  Array.isArray(artifactNames('full')) && artifactNames('full').length === 3 && !artifactNames('full').includes('wds.node'),
  artifactNames('full').join(', '),
)
check(
  'addon 构建失败不拖垮三件套（only warning）',
  /addonInfo = \{ built: false, reason: e\.message \}/.test(buildShimSrc),
)
check(
  'CLI 注入器与 addon 共用 ws_launch.c',
  buildShimSrc.includes("path.join(SHIM, 'injector', 'ws_launch.c')"),
)
const buildPluginSrc = read('tools/build-plugin.ts')
check(
  'build-plugin 把 addon 拷进 dist/',
  buildPluginSrc.includes('wds.node') && buildPluginSrc.includes("join(OUT, 'wds.node')"),
)
check(
  'package.json 发布 addon 源码',
  (JSON.parse(read('package.json')).files ?? []).includes('shim/addon/'),
)

W('')
W('=== 5. 已构建产物的 PE 形状（不存在则跳过） ===')
const builtAddon = join(REPO, 'shim', 'out', 'wds.node')
check(
  /* 2026-11-24 审计实测：模型在 `tasklist /m` 里看到 DeepSeek Harness.exe 加载了
   * `winstage-addon.node` —— 文件名本身就是"这台机器被 WinStage 接管"的一句话证据
   * （垫片本体早已改名为 `wds.dll`，addon 漏了）。中立名与 `wds.dll` 同族。 */
  'addon 文件名不自我暴露（wds.node）',
  !/winstage/i.test(basename(builtAddon)),
  builtAddon,
)
if (!existsSync(builtAddon)) {
  W('  - 跳过：shim/out/wds.node 尚未构建（node tools/build-shim.ts）')
} else {
  let pe
  try {
    pe = parsePe(builtAddon)
  } catch (error) {
    pe = null
    check('addon 可解析为 PE', false, error.message)
  }
  if (pe) {
    check('addon 是 x64 DLL', pe.machine === 'x86_64' && pe.isDll === true, `${pe.machine} isDll=${pe.isDll}`)
    check('addon 导出 napi_register_module_v1', pe.exports.includes('napi_register_module_v1'))
    check(
      'addon 不 import libnode（否则必须 node-gyp/MSVC/node.lib）',
      pe.importDlls.every((name) => !/^node(\.exe|\.dll)?$/i.test(name)),
      pe.importDlls.join(', '),
    )
  }
}

W('')
W('=== 6. shim：把调用方被重定向的 stdio 转发给子进程 ===')
const procSrc = read('shim/src/ws_proc.c')
check(
  'CreateProcess 钩子转发 stdio（STARTF_USESTDHANDLES）',
  /stdioSi\.dwFlags \|= STARTF_USESTDHANDLES/.test(procSrc) &&
    /stdioSi\.hStdOutput = hOut/.test(procSrc),
)
check(
  '只在调用方没指定句柄、且 stdout/err 是文件/管道时转发',
  /outType == FILE_TYPE_DISK \|\| outType == FILE_TYPE_PIPE/.test(procSrc) &&
    /!\(si->dwFlags & STARTF_USESTDHANDLES\)/.test(procSrc),
)
check(
  'STARTUPINFOEXW 调用方不动（避免悬空 lpAttributeList）',
  /!\(si->dwFlags & EXTENDED_STARTUPINFO_PRESENT\)/.test(procSrc),
)
check('spawnCapturedAsync 仍是 helper 车道（回退路径存在）', typeof spawnCapturedAsync === 'function')

W('')
const result = failed === 0 ? 'PASS' : 'FAIL'
W(`RESULT: ${result} checks=${passed + failed} failures=${failed} mode=normal`)
process.exit(failed === 0 ? 0 : 1)
