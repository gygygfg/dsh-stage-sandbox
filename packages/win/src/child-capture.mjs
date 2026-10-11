/**
 * 子进程输出捕获 —— **单一权威定义**（R12 修复 · D5-N1）
 *
 * ── 要治的是什么（R11 D5-N1 实测）──────────────────────────────────────────────
 * WinStage TS 档沙箱内，`child_process.spawn(...)` 用默认 `stdio:'pipe'` 时，
 * Node 在**子进程创建期**就尝试建立匿名管道；受限环境拒绝之后，那条 Socket 上的
 * `error` 事件**没有监听者** ⇒ 未捕获异常 ⇒ **整个进程死亡**（不是返回错误码）：
 *
 *   at Object.Socket (node:net:550:41)
 *   at createSocket (node:internal/child_process:337:14)
 *   at ChildProcess.spawn (node:internal/child_process:492:23)
 *   ...
 *   { errno: -4053, code: 'ENOTCONN', syscall: 'read' }
 *   Node.js v24.21.0
 *
 * 证据：`.t/r11/network/run-n3/out/**`（`serve-ready` 之后进程直接没了，
 * `exit=1`，`child-spawn-diagnostic` / `hold-window` / `fatal` 一个都没跑）。
 * 同一脚本改用 `stdio:'ignore'` 就正常 ⇒ **是管道这一半，不是 spawn 本身**。
 *
 * ── 修法（与 `src/registry-bindings.mjs::runReg()` 的 pipe→file 回退同族）───────
 *   1. **先试管道**（正常环境下最省事，也保留"子进程边跑边读"的能力）；
 *   2. 管道被拒（`error` 是 EPERM/ENOTCONN/EACCES/EPIPE/EINVAL/UNKNOWN，或**同步抛**）
 *      ⇒ **自动重试文件重定向**（`stdio: ['ignore', fdOut, fdErr]`），
 *      并把 `via:'file'` / `pipeError` / `note` 如实带回去；
 *   3. `mode:'auto'`（默认）= 2 的粘性记忆：一旦本进程被拒过一次，后续调用**直接**走文件，
 *      不再每次都白挨一次崩溃窗口（与 `registry-bindings.mjs` 的 `pipesRefused` 同口径）；
 *   4. **兜底**：`installChildProcessPipeGuard()` 给这一族错误装全局守卫 ——
 *      万一还有第三处（第三方库、`execFileSync`…）走默认管道，进程也**不再整死**，
 *      而是记一条可读注记并继续。
 *
 * ── 为什么放在 `src/` 而不是 `dsh-plugin/` ─────────────────────────────────────
 * 这条边界与插件无关：它是"受限宿主里怎么安全地捕获子进程输出"的通用机制，
 * `src/registry-bindings.mjs`（reg.exe）、`src/testrunner.mjs`（套件）已经各写了一份，
 * 但都**没有**全局兜底。放在 `src/` 才能被两侧同时复用，也给"探针脚本"一个明确落点。
 *
 * 本模块：零外部依赖、纯 Node 标准库、可离线断言（`_pipeFailures` 注入缝）。
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync as nodeSpawnSync } from 'node:child_process'

/**
 * 管道被拒的错误码族。
 *
 * R12 复核修正（verifier `v5`/`v7`）：本机沙箱里**同步** `spawnSync` 面报的是
 * `ENOENT`（`error.code='ENOENT'`，没有 errorObject），而**异步** `read` 面才是
 * `ENOTCONN`（errno -4053）。旧族只有 ENOTCONN，于是降级分支在本环境**必然不触发**
 * ⇒ 返回静默空输出（比崩溃更隐蔽）。ENOENT 一并收进族。
 * 注意：ENOENT 也可能是"可执行文件真的不存在"，所以只在 `errorObject`/`error` 上判定，
 * 且降级后仍把 `pipeError` 原样带回（调用方可鉴别）。
 */
export const PIPE_REFUSAL_CODES = Object.freeze(['EPERM', 'ENOTCONN', 'ENOENT', 'EACCES', 'EPIPE', 'EINVAL', 'UNKNOWN', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])

/** 本进程是否已被管道拒过（粘性；与 `registry-bindings.mjs` 的 `pipesRefused` 同一口径） */
let pipesRefused = false
/** 最近一次管道失败原因（可读；`undefined` = 没发生过） */
let lastPipeError

/** 测试/诊断用的注入缝：把"管道实现"换成会失败/会成功的替身 */
let pipeRunner = null

/**
 * 测试用：替换管道版实现（传 `null` 复位）。
 * 生产代码**不要**调用它。
 */
export function __setPipeRunnerForTest(fn) {
  pipeRunner = typeof fn === 'function' ? fn : null
  pipesRefused = false
  lastPipeError = undefined
}

/** 该错误是否属于"管道被拒"族 */
export function isPipeRefusal(error) {
  if (!error) return false
  const code = String(error.code ?? error.errno ?? error.name ?? '')
  if (PIPE_REFUSAL_CODES.includes(code)) return true
  return /ENOTCONN|ENOENT|EPERM|EACCES|EPIPE|named pipe|socket/i.test(String(error.message ?? ''))
}

function describe(error) {
  if (!error) return 'unknown'
  return `${error.code ?? error.name ?? 'ERR'}: ${error.message ?? String(error)}`
}

/**
 * 跑一个子进程并捕获 stdout/stderr，**管道优先、被拒即回退文件重定向**。
 *
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.tmpDir] 文件重定向的临时目录（默认系统 temp）
 * @param {'auto'|'pipe'|'file'} [options.mode] `auto`（默认）/ 只用管道 / 只用文件
 * @param {string} [options.encoding] `'utf8'`（默认）或 `null`（拿 Buffer 的 hex 长度）
 * @returns {{status:number|null, stdout:string, stderr:string, error:string|null,
 *            via:'pipe'|'file', pipeError?:string, note?:string, killed?:boolean}}
 */
export function spawnCaptured(command, argv, options = {}) {
  const mode = options.mode ?? 'auto'
  if (mode === 'file' || (mode === 'auto' && pipesRefused)) return runWithFileRedirect(command, argv, options)
  const piped = runWithPipe(command, argv, options)
  if (piped.status !== null || mode === 'pipe' || !isPipeRefusal(piped.errorObject)) return piped
  pipesRefused = true
  lastPipeError = piped.error ?? 'unknown'
  const redirected = runWithFileRedirect(command, argv, options)
  redirected.pipeError = piped.error ?? 'unknown'
  redirected.note =
    `piped stdio was refused (${redirected.pipeError}); retried with file redirection ` +
    '(residual boundary D5-N1: a confined host cannot open named pipes)'
  return redirected
}

/** 管道版（默认实现：`encoding` 决定拿 text 还是 Buffer） */
function runWithPipe(command, argv, options) {
  if (pipeRunner) {
    // ⚠ 注入的替身**抛错**时也要走同一条回退（替身只是"另一条管道实现"，
    //   不能让它的抛错形态绕过 `spawnCaptured` 的降级判定）
    try {
      return pipeRunner(command, argv, options)
    } catch (error) {
      return { status: null, stdout: '', stderr: '', error: describe(error), errorObject: error, via: 'pipe' }
    }
  }
  try {
    const result = nodeSpawnSync(command, argv, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      encoding: options.encoding === null ? null : options.encoding ?? 'utf8',
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    })
    return {
      status: result.status,
      stdout: normalize(result.stdout),
      stderr: normalize(result.stderr),
      error: result.error ? describe(result.error) : null,
      errorObject: result.error,
      via: 'pipe',
    }
  } catch (error) {
    // ★ 关键：同步抛出（含 `Socket` 的 error 转化为同步抛）也走同一条回退
    return { status: null, stdout: '', stderr: '', error: describe(error), errorObject: error, via: 'pipe' }
  }
}

/** 文件重定向版：受限环境里唯一能拿到子进程输出的方式 */
function runWithFileRedirect(command, argv, options) {
  const encoding = options.encoding === null ? null : options.encoding ?? 'utf8'
  let dir
  try {
    dir = mkdtempSync(join(options.tmpDir ?? tmpdir(), 'winstage-cap-'))
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: `cannot create redirect dir: ${describe(error)}`, via: 'file' }
  }
  const outPath = join(dir, 'stdout.bin')
  const errPath = join(dir, 'stderr.bin')
  let fdOut
  let fdErr
  try {
    fdOut = openSync(outPath, 'w')
    fdErr = openSync(errPath, 'w')
    const result = nodeSpawnSync(command, argv, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      stdio: ['ignore', fdOut, fdErr],
    })
    closeSync(fdOut)
    fdOut = undefined
    closeSync(fdErr)
    fdErr = undefined
    return {
      status: result.status,
      stdout: readRedirected(outPath, encoding),
      stderr: readRedirected(errPath, encoding),
      error: result.error ? describe(result.error) : null,
      errorObject: result.error,
      via: 'file',
    }
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error: describe(error), errorObject: error, via: 'file' }
  } finally {
    if (fdOut !== undefined) safeClose(fdOut)
    if (fdErr !== undefined) safeClose(fdErr)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

function normalize(value) {
  if (value === undefined || value === null) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function readRedirected(file, encoding) {
  try {
    const buffer = readFileSync(file)
    return encoding === null ? buffer.toString('hex') : buffer.toString(encoding)
  } catch {
    return ''
  }
}

function safeClose(fd) {
  try {
    closeSync(fd)
  } catch {
    /* best effort */
  }
}

/** 诊断：本进程是否已判定"管道被拒"、以及原因 */
export function pipeRefusalState() {
  return { refused: pipesRefused, error: lastPipeError }
}

/**
 * **兜底**：给"管道被拒"这一族错误装全局守卫。
 *
 * 为什么还必须要有它：本模块只覆盖**走这里**的调用；第三方库（或将来某处
 * 直接 `spawn` 默认 stdio）仍可能在沙箱里抛出同一个 `ENOTCONN`，
 * 而"未捕获即整进程死亡"的后果是**整个会话丢掉**（不是一条错误回执）。
 * 装上之后：同类错误变成一条**可读注记** + `process.exitCode`，
 * 进程继续活着 —— 与 `runReg()` 的"降级而非崩溃"同一口径。
 *
 * @param {{log?: (message:string)=>void, exitOnOther?: boolean}} [options]
 * @returns {() => void} 卸载函数（自测用）
 */
export function installChildProcessPipeGuard(options = {}) {
  const log = typeof options.log === 'function' ? options.log : (message) => console.error(message)
  /** 其它未捕获异常：默认**不**改变行为（照旧抛出/退出），只多记一条可读注记 */
  const exitOnOther = options.exitOnOther === true

  const classify = (error) => {
    if (!isPipeRefusal(error)) return null
    return (
      `[child-capture] 捕获到"管道被拒"类错误并**降级**（未让进程死亡）：${describe(error)}；` +
      '后续子进程输出请走 `spawnCaptured(..., { mode: "file" })` 或文件重定向（D5-N1）'
    )
  }

  const onUncaught = (error) => {
    const line = classify(error)
    if (line) {
      log(line)
      // 这一族是**环境边界**，不是程序错误 ⇒ 记一个非零退出码但**不崩**
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 70
      return
    }
    if (exitOnOther) process.exitCode = 1
    else {
      log(`[child-capture] 未捕获异常（非管道类，行为不变）：${describe(error)}`)
      throw error
    }
  }

  const onRejection = (reason) => {
    const line = classify(reason)
    if (line) {
      log(line)
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 70
      return
    }
    log(`[child-capture] 未处理的 Promise 拒绝（非管道类，行为不变）：${describe(reason)}`)
  }

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
  return () => {
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onRejection)
  }
}
