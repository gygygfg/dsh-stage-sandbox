/**
 * K0 执行链：`NtSession.confine()` → launcher → 目标进程 → 结果分类。
 *
 * 这一层不自己拼 launcher 参数（那是 `launcher-args.ts`）、不自己判定状态
 * （那是 `status.ts`），只负责把三步接起来并**如实**返回：
 *   · 退出码/信号/超时；
 *   · stdout/stderr（按上限截断并标记）；
 *   · 失败分类（denied / env-fault / apply-conflict / command-failed / unknown）。
 *
 * `spawn` 是注入的：Windows 上用真实子进程，离线自测用替身。这样“执行契约”
 * 可以在 Linux 上验证，而不是只存在于 Windows 脚本里。
 *
 * @module winstage-sandbox/nt/executor
 */

import { NtSession } from './session.ts'
import type { NtFailure } from './status.ts'
import { NtError, type NtStatus } from './types.ts'

export interface NtSpawnOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface NtSpawnResult {
  code: number | null
  signal?: string
  stdout: string
  stderr: string
  timedOut?: boolean
}

/** 注入点：真实实现用 `child_process.spawn`；测试用替身。 */
export type NtSpawn = (argv: string[], options: NtSpawnOptions) => Promise<NtSpawnResult>

export interface NtExecutorOptions {
  session: NtSession
  status: NtStatus | (() => NtStatus)
  spawn: NtSpawn
  /** 默认 cwd（视图根内的逻辑路径）。 */
  cwd?: string
  /** 默认环境白名单。 */
  env?: Record<string, string>
  timeoutMs?: number
  /** 单流输出上限（默认 1 MiB）。 */
  maxOutputBytes?: number
}

export interface NtExecResult extends NtSpawnResult {
  domainId: string
  enforcement: 'full' | 'partial'
  failure?: NtFailure
  truncated: { stdout: boolean; stderr: boolean }
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024

/**
 * K0 执行器。`run()` 幂等初始化会话；`dispose()` 幂等注销域。
 */
export class NtExecutor {
  private readonly session: NtSession
  private readonly options: NtExecutorOptions
  private initialized = false

  constructor(options: NtExecutorOptions) {
    this.options = options
    this.session = options.session
  }

  get domainId(): string {
    return this.session.domainId
  }

  /** 初始化（策略下发 + 域注册）。已初始化则直接返回。 */
  async init(): Promise<void> {
    if (this.initialized) return
    await this.session.init()
    this.initialized = true
  }

  /**
   * 在域内执行 argv。
   *
   * @throws `NtError`（初始化/状态/argv 校验失败；此时**没有**启动进程）
   */
  async run(argv: readonly string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<NtExecResult> {
    await this.init()

    const cwd = options.cwd ?? this.options.cwd
    const env = { ...(this.options.env ?? {}), ...(options.env ?? {}) }
    const confined = this.session.confine(argv, {
      ...(cwd === undefined ? {} : { cwd }),
      env,
    })

    const spawned = await this.options.spawn(confined.argv, {
      ...(cwd === undefined ? {} : { cwd }),
      env,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs,
    })

    const limit = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
    const stdout = clamp(spawned.stdout, limit)
    const stderr = clamp(spawned.stderr, limit)

    const result: NtExecResult = {
      ...spawned,
      stdout: stdout.text,
      stderr: stderr.text,
      domainId: confined.domainId,
      enforcement: confined.enforcement,
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    }

    if (spawned.timedOut === true) {
      result.failure = {
        kind: 'command-failed',
        code: 'NT_INTERNAL',
        message: 'process timed out',
        executed: true,
      }
    } else if (spawned.code !== 0) {
      result.failure = classifyExit(spawned.code, spawned.stderr, confined.denialSignatures)
    }

    return result
  }

  /** 注销域（失败不抛；诊断信息保留在 session.lastDisposeError）。 */
  async dispose(): Promise<void> {
    this.initialized = false
    await this.session.dispose()
  }

  /** 断言当前状态仍可执行（供工具层在 run 之前做一次显式检查）。 */
  assertReady(): void {
    const status = typeof this.options.status === 'function' ? this.options.status() : this.options.status
    if (status.enforcement !== 'kernel-projfs-minifilter' || !status.driver.loaded) {
      throw new NtError('NT_DRIVER_UNAVAILABLE', { enforcement: status.enforcement })
    }
  }
}

/** 退出码 → 失败分类。denied 只在**有输出证据**时成立；否则是普通命令失败。 */
export function classifyExit(code: number | null, stderr: string, denialSignatures: readonly string[]): NtFailure {
  const text = stderr
  for (const signature of denialSignatures) {
    if (signature.length > 0 && text.includes(signature)) {
      return {
        kind: 'denied',
        code: 'NT_ACCESS_DENIED',
        message: `sandbox denied the operation (matched "${signature}")`,
        executed: true,
      }
    }
  }
  // 0xC0000142 = DLL 初始化失败：典型的环境/令牌问题，而不是命令本身。
  const envFault =
    text.includes('0xC0000142') ||
    text.includes('STATUS_DLL_INIT_FAILED') ||
    text.includes('应用程序无法正常启动')
  if (envFault) {
    return {
      kind: 'env-fault',
      code: 'NT_CAPABILITY_MISSING',
      message: 'process failed during loader initialization in the sandbox',
      executed: true,
    }
  }
  return {
    kind: 'command-failed',
    code: code === null ? 'SIGNAL' : `EXIT_${code}`,
    message: code === null ? 'process was terminated by a signal' : `process exited with code ${code}`,
    executed: true,
  }
}

function clamp(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return { text, truncated: false }
  // 截断时保留尾部：构建工具的错误通常在最后。
  const kept = buffer.subarray(buffer.length - maxBytes).toString('utf8')
  return { text: `${kept}`, truncated: true }
}
