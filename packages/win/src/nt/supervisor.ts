/**
 * NT 数据面生命周期（M2）：把“驱动 + ProjFS provider + 策略 + 域”安全地拉起来。
 *
 * 顺序是**强制**的，任一步失败都会回滚并抛带机读码的 `NtError`：
 *
 *   1. 校验域策略（重叠根/缺 SID/空 allowlist 等，纯函数，先于任何副作用）
 *   2. 探测驱动与 ProjFS（没有驱动就不启动 provider）
 *   3. 驱动 hello 检查 ABI
 *   4. 启动 provider 进程 → 等 `ping` 就绪
 *   5. `start`（ProjFS 视图）+ `protect`（标记 lower 受保护）
 *   6. 查询当前策略 generation → 用 `generation+1` 编码二进制策略 → `setPolicy`
 *   7. `registerDomain`
 *   8. 重新探测；必须是 `kernel-projfs-minifilter`
 *
 * 为什么不在 `NtSession.init()` 里做这些：`NtSession.init()` 的前置条件包含
 * “provider 已在运行”，而启动 provider 正是这里的工作（否则会死锁）。
 * 这里完成后，`NtSession`/`NtSandboxProvider` 的 confine 才有意义。
 *
 * 网络档位不在“就绪”前置条件里：WFP 闸门是**按子进程**安装的（launcher 持有
 * DYNAMIC 会话直到子进程退出），初始化阶段没有“已安装”的全局状态。offline/
 * allowlist 的强制点在 `dshnt-launch.exe`：安装失败即拒绝启动（fail-closed）。
 *
 * @module winstage-sandbox/nt/supervisor
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { encodePolicy } from './policy-binary.ts'
import { validatePolicy } from './policy.ts'
import { PipeProviderControl, type ProviderControl } from './provider-client.ts'
import { DEFAULT_PROVIDER_PIPE, providerSocketPath } from './provider-protocol.ts'
import { isKernelReady } from './status.ts'
import { isNtError, NtError, NT_DRIVER_ABI_VERSION, type NtPolicySet, type NtStatus } from './types.ts'
import type { NtRuntime } from './runtime.ts'

export type NtSupervisorPhase = 'down' | 'starting' | 'up' | 'failed'

export interface NtSupervisorState {
  phase: NtSupervisorPhase
  domainId?: string
  policyGeneration?: number
  providerPid?: number
  /** 是否由本 supervisor 启动了 provider 进程（外部传入的 control 不算）。 */
  providerSpawned: boolean
  error?: string
}

/** 启动后的 provider 进程句柄（测试可注入替身）。 */
export interface NtProviderHandle {
  pid?: number
  kill(): void
}

export interface NtSupervisorOptions {
  runtime: NtRuntime
  /** provider 管道名（默认 dshnt-provider）。 */
  pipeName?: string
  /** 直接指定套接字路径（测试用 Unix socket）；默认由 pipeName 推导。 */
  socketPath?: string
  /** provider 可执行文件；默认取 runtime.providerPath。 */
  providerPath?: string
  /** provider 日志；默认取 `<storeRoot>/provider.log`。 */
  providerLog?: string
  /** 注入控制客户端（测试）；提供时**不会**自行 spawn provider。 */
  control?: ProviderControl
  /** 注入进程启动器（测试）；默认 node:child_process.spawn。 */
  startProvider?: (input: { file: string; args: string[]; log: string }) => Promise<NtProviderHandle>
  /** 注入 sleep（测试可 no-op）。 */
  sleep?: (ms: number) => Promise<void>
  /** 注入目录创建（测试可 no-op，避免在非 Windows 上按 Windows 路径mkdir）。 */
  makeDir?: (path: string) => void
  pingAttempts?: number
  pingIntervalMs?: number
  timeoutMs?: number
}

const DEFAULT_PING_ATTEMPTS = 80
const DEFAULT_PING_INTERVAL_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 默认启动器：独立进程、无控制台窗口；退出由 supervisor 的 kill 负责。 */
async function spawnProvider(input: { file: string; args: string[]; log: string }): Promise<NtProviderHandle> {
  const child = nodeSpawn(input.file, input.args, {
    windowsHide: true,
    stdio: 'ignore',
  })
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill(): void {
      try {
        child.kill()
      } catch {
        // 已退出/无权限：清理路径不抛
      }
    },
  }
}

function defaultMakeDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/**
 * 一次性拉起/收起 NT 数据面。一个实例对应一个域（一个工作区 + 视图 + store）。
 */
export class NtSupervisor {
  private readonly runtime: NtRuntime
  private readonly options: NtSupervisorOptions
  private phase: NtSupervisorPhase = 'down'
  private control: ProviderControl | undefined
  private provider: NtProviderHandle | undefined
  private domainId: string | undefined
  private registered = false
  private policyGeneration: number | undefined
  private lastError: string | undefined
  private lastStatus: NtStatus | undefined

  constructor(options: NtSupervisorOptions) {
    this.options = options
    this.runtime = options.runtime
  }

  state(): NtSupervisorState {
    return {
      phase: this.phase,
      ...(this.domainId === undefined ? {} : { domainId: this.domainId }),
      ...(this.policyGeneration === undefined ? {} : { policyGeneration: this.policyGeneration }),
      ...(this.provider?.pid === undefined ? {} : { providerPid: this.provider.pid }),
      providerSpawned: this.provider !== undefined,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  /** 最近一次探测（成功后就是就绪状态）。 */
  status(): NtStatus | undefined {
    return this.lastStatus
  }

  /** 拉起数据面；已就绪时幂等返回。失败会先回滚再抛错。 */
  async up(): Promise<NtSupervisorState> {
    if (this.phase === 'up') return this.state()
    if (this.phase === 'starting') {
      throw new NtError('NT_INTERNAL', { reason: 'nt supervisor is already starting' })
    }

    this.phase = 'starting'
    this.lastError = undefined
    try {
      // 1) 纯校验先做：非法策略不产生任何副作用（不 spawn、不下发）。
      const base = this.runtime.policy()
      this.domainId = base.domain.id
      const validation = validatePolicy(base.policy, {
        requireAppContainerSid: base.domain.tokenMode === 'appcontainer',
      })
      if (!validation.ok) {
        throw new NtError('NT_POLICY_INVALID', { errors: validation.errors, warnings: validation.warnings })
      }

      // 2) 没有驱动/ProjFS 就不要启动 provider（避免留下孤儿进程）。
      const pre = await this.runtime.probe()
      this.lastStatus = pre
      if (!pre.driver.loaded) {
        throw new NtError('NT_DRIVER_UNAVAILABLE', { notes: pre.notes, driver: pre.driver })
      }
      if (!pre.projfs.enabled) {
        throw new NtError('NT_PROJFS_NOT_ENABLED', { notes: pre.notes })
      }

      // 3) ABI 必须匹配；混用旧驱动比“不可用”更危险。
      const hello = await this.runtime.driver.hello()
      if (hello.abiVersion !== NT_DRIVER_ABI_VERSION) {
        throw new NtError('NT_DRIVER_VERSION_MISMATCH', {
          expected: NT_DRIVER_ABI_VERSION,
          actual: hello.abiVersion,
          driverVersion: hello.driverVersion,
        })
      }

      // 4) provider：外部 control（测试/复用）优先；否则自己 spawn。
      const pipeName = this.options.pipeName ?? DEFAULT_PROVIDER_PIPE
      if (this.options.control !== undefined) {
        this.control = this.options.control
      } else {
        const socketPath = this.options.socketPath ?? providerSocketPath(pipeName, process.platform)
        if (socketPath === undefined) {
          throw new NtError('NT_PROJFS_UNAVAILABLE', {
            reason: 'provider control requires Windows named pipes (or an injected control/socketPath)',
          })
        }
        const providerPath = this.options.providerPath ?? this.runtime.providerPath
        if (typeof providerPath !== 'string' || providerPath.length === 0) {
          throw new NtError('NT_PROJFS_UNAVAILABLE', { reason: 'provider executable path is not configured' })
        }
        const providerLog = this.options.providerLog ?? win32.join(this.runtime.storeRoot, 'provider.log')
        const makeDir = this.options.makeDir ?? defaultMakeDir
        try {
          makeDir(this.runtime.storeRoot)
          makeDir(win32.dirname(providerLog))
        } catch (error) {
          throw new NtError('NT_VIEW_UNAVAILABLE', { reason: 'cannot create store directory' }, { cause: error })
        }
        this.control = new PipeProviderControl(socketPath)
        const starter = this.options.startProvider ?? spawnProvider
        this.provider = await starter({
          file: providerPath,
          args: ['--pipe', pipeName, '--log', providerLog],
          log: providerLog,
        })
      }

      // 5) 等 provider 就绪，再启动视图。
      await this.waitForPing()
      const started = await this.control.request('start', {
        domain: base.domain.id,
        workspace: this.runtime.workspaceRoot,
        view: this.runtime.viewRoot,
      })
      if (!started.ok) {
        throw new NtError('NT_PROJFS_PROVIDER_DOWN', { op: 'start', error: started.error })
      }
      const protectedReply = await this.control.request('protect', { value: true })
      if (!protectedReply.ok) {
        throw new NtError('NT_PROJFS_PROVIDER_DOWN', { op: 'protect', error: protectedReply.error })
      }

      // 6) 策略 generation 必须单调递增；同 generation 的“改内容”驱动会忽略。
      const current = await this.currentGeneration()
      const generation = Math.max(1, current + 1)
      const policy: NtPolicySet = {
        ...base.policy,
        generation,
        createdAt: new Date().toISOString(),
      }
      const encoded = encodePolicy(policy)
      const applied = await this.runtime.driver.setPolicy(encoded.payload, encoded.hash, encoded.generation)
      this.policyGeneration = applied.generation

      // 7) 注册域（驱动只对已注册域的 PID 做重定向/判定）。
      await this.runtime.driver.registerDomain({
        id: base.domain.id,
        viewRoot: base.domain.viewRoot,
        workspaceRoot: base.domain.workspaceRoot,
        storeRoot: base.domain.storeRoot,
        ...(base.domain.appContainerSid === undefined ? {} : { appContainerSid: base.domain.appContainerSid }),
      })
      this.registered = true

      // 8) 事实核对：不是“函数没报错”，而是重新探测到 kernel 档。
      const status = await this.runtime.probe()
      this.lastStatus = status
      if (status.enforcement !== 'kernel-projfs-minifilter') {
        throw new NtError('NT_CAPABILITY_MISSING', {
          reason: 'data plane did not reach kernel-projfs-minifilter after start',
          enforcement: status.enforcement,
          driver: status.driver,
          projfs: status.projfs,
          policy: status.policy,
        })
      }
      if (!isKernelReady(status)) {
        // network.enforced 在初始化阶段不可观测（按子进程安装）；这里只记录，不阻断。
        status.notes.push('network gate is installed per child by the launcher; ambient enforcement is not observable here')
      }

      this.phase = 'up'
      return this.state()
    } catch (error) {
      const failure = isNtError(error)
        ? error
        : new NtError('NT_INTERNAL', { phase: 'up', reason: String((error as Error)?.message ?? error) }, { cause: error })
      this.lastError = `${failure.code}: ${failure.message}`
      await this.down()
      this.phase = 'failed'
      throw failure
    }
  }

  /** 收起数据面（幂等；清理路径不抛）。`phase` 最终为 down。 */
  async down(): Promise<void> {
    // 先注销域：避免驱动继续把进程重定向到即将停止的视图。
    if (this.registered && this.domainId !== undefined) {
      try {
        await this.runtime.driver.unregisterDomain(this.domainId)
      } catch {
        // 驱动已卸载/域已消失：清理继续
      }
      this.registered = false
    }
    if (this.control !== undefined) {
      if (this.domainId !== undefined) {
        try {
          await this.control.request('stop', { domain: this.domainId }, { timeoutMs: 2000 })
        } catch {
          // provider 已退出/管道断开
        }
      }
      try {
        await this.control.request('shutdown', {}, { timeoutMs: 2000 })
      } catch {
        // 同上
      }
      try {
        this.control.close()
      } catch {
        // 忽略
      }
      this.control = undefined
    }
    if (this.provider !== undefined) {
      try {
        this.provider.kill()
      } catch {
        // 已退出
      }
      this.provider = undefined
    }
    this.policyGeneration = undefined
    this.domainId = undefined
    this.phase = 'down'
  }

  private async waitForPing(): Promise<void> {
    if (this.control === undefined) throw new NtError('NT_PROJFS_PROVIDER_DOWN', { reason: 'no control client' })
    const attempts = this.options.pingAttempts ?? DEFAULT_PING_ATTEMPTS
    const interval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
    const timeoutMs = this.options.timeoutMs ?? 1000
    const sleep = this.options.sleep ?? delay
    let last: unknown
    for (let i = 0; i < attempts; i += 1) {
      try {
        const reply = await this.control.request('ping', {}, { timeoutMs })
        if (reply.ok) return
        last = reply.error
      } catch (error) {
        last = (error as Error)?.message ?? error
      }
      await sleep(interval)
    }
    throw new NtError('NT_PROJFS_PROVIDER_DOWN', {
      reason: `provider did not answer ping after ${attempts} attempts`,
      last: last === undefined ? undefined : String(last),
    })
  }

  private async currentGeneration(): Promise<number> {
    try {
      const stats = await this.runtime.driver.queryStats()
      return Number.isInteger(stats.policyGeneration) && stats.policyGeneration > 0 ? stats.policyGeneration : 0
    } catch {
      // 查不到就按 0 处理：setPolicy 会由驱动做最终校验（不允许倒退）。
      return 0
    }
  }
}
