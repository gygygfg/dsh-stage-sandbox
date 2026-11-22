/**
 * NT 运行时装配（诊断面）。
 *
 * 把三样东西拼成一个可查询的对象：
 *   · `NtDriverPort`   —— 驱动通信端口（真实 Windows 或 Fake/Unavailable）
 *   · 状态探测          —— `fltmc` / `sc` / ProjFS / provider 管道
 *   · 域策略            —— `buildDomainPolicy` + `validatePolicy`（**只**校验，不下发）
 *
 * 为什么 v1 只做诊断：路径接管（`ctx.fs`/`ctx.shell` 切视图）需要 provider 生命周期、
 * 策略下发与 apply helper 三件套一起就位，任何一件缺失都必须 fail-closed；在这些
 * 未齐之前，本模块只回答“此刻能不能用”，**不**假装沙箱已经生效。真正的接管见
 * docs/nt/README.md 的 M2 清单。
 *
 * 可测试性：命令执行器、驱动端口、provider 管道路径都可注入；Linux 上整套
 * （含 doctor 输出）可以直接跑，不触碰任何系统状态。
 *
 * @module winstage-sandbox/nt/runtime
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createDriverPortAsync } from './driver.ts'
import { buildDomainPolicy } from './provider.ts'
import { validatePolicy } from './policy.ts'
import { assessNtStatus, collectNtFacts, parseProviderStats, type NtRawFacts } from './status-probe.ts'
import { isKernelReady, renderStatusCard, summarizeStatus } from './status.ts'
import {
  NtError,
  type NtDomain,
  type NtDriverHello,
  type NtDriverPort,
  type NtDriverStats,
  type NtNetworkMode,
  type NtStatus,
  type NtTokenMode,
} from './types.ts'

/** 默认 provider 管道名（与 `native/provider` 的 `--pipe` 默认值一致）。 */
export const DEFAULT_PROVIDER_PIPE = 'dshnt-provider'

/**
 * 包根目录；用于默认 launcher 路径。
 *
 * 不能写死 `../../`：源码在 `src/nt/`（上两级=包根），但部署产物是
 * `dist/index.mjs`（上两级=packages/）。这里从模块位置向上找带本包 name 的
 * package.json，源码树与 bundle 都得到同一个根。
 */
const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)))

function findPackageRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
        if (parsed.name === 'dsh-winstage-sandbox') return current
      } catch {
        // 继续向上
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

export interface NtLayout {
  viewRoot: string
  storeRoot: string
  launcherPath: string
}

/**
 * 默认布局：视图/store 是**工作区的兄弟目录**（同卷），不能落在工作区内部
 * ——策略校验会把重叠根直接判非法（否则“视图里能看到真实工作区”就是自欺）。
 *
 * 环境变量覆盖（显式优先，便于 M1/M2 的固定布局）：
 *   · `WINSTAGE_NT_ROOT`          —— 同时覆盖 view/store 的父目录
 *   · `WINSTAGE_NT_VIEW_ROOT`     —— 视图根
 *   · `WINSTAGE_NT_STORE_ROOT`    —— 候选/证据根
 *   · `WINSTAGE_NT_LAUNCHER`      —— launcher 可执行文件
 */
export function defaultNtLayout(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): NtLayout {
  const parent = win32.dirname(workspaceRoot)
  const name = win32.basename(workspaceRoot)
  const root = env.WINSTAGE_NT_ROOT?.trim() || win32.join(parent, `.${name}.dshnt`)
  return {
    viewRoot: env.WINSTAGE_NT_VIEW_ROOT?.trim() || win32.join(root, 'view'),
    storeRoot: env.WINSTAGE_NT_STORE_ROOT?.trim() || win32.join(root, 'store'),
    launcherPath:
      env.WINSTAGE_NT_LAUNCHER?.trim() || win32.join(PACKAGE_ROOT, 'native', 'launcher', 'out', 'dshnt-launch.exe'),
  }
}

/** Windows 命名管道路径（其它平台不适用；测试可直接给 `providerSocket`）。 */
export function providerSocketPath(pipeName: string = DEFAULT_PROVIDER_PIPE, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : undefined
}

/**
 * 向 provider 控制管道发一条 `stats` 请求。
 *
 * 协议是“一行 JSON 请求 / 一行 JSON 回复”（见 `native/provider/src/ControlServer.cs`）。
 * 任何失败（连不上 / 超时 / 坏 JSON）都收成 `{alive:false}`，**不抛**：诊断要能继续。
 */
export async function queryProviderStats(
  socketPath: string,
  timeoutMs = 1500,
): Promise<{ alive: boolean; views: string[]; error?: string }> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: { alive: boolean; views: string[]; error?: string }) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = connect(socketPath)
    let buffer = ''
    const timer = setTimeout(() => finish({ alive: false, views: [], error: 'provider pipe timed out' }), timeoutMs)
    timer.unref?.()
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id: 1, op: 'stats' })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      const parsed = parseProviderStats(buffer.slice(0, newline))
      finish({ alive: parsed.alive, views: parsed.views })
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      finish({ alive: false, views: [], error: (error as NodeJS.ErrnoException).code ?? String(error) })
    })
    socket.on('close', () => {
      clearTimeout(timer)
      finish({ alive: false, views: [], error: 'provider pipe closed before reply' })
    })
  })
}

/** 默认命令执行器：Windows 上用 `cmd.exe /d /s /c`；其它平台直接拒绝（事实=unknown）。 */
export function createWindowsCommandRunner(platform: NodeJS.Platform = process.platform) {
  return async (command: string): Promise<string> => {
    if (platform !== 'win32') {
      throw new Error(`windows command is unavailable on ${platform}`)
    }
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'cmd.exe',
        ['/d', '/s', '/c', command],
        { windowsHide: true, timeout: 15000, maxBuffer: 1 << 20 },
        (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        },
      )
    })
  }
}

export interface NtRuntimeOptions {
  /** 真实工作区（lower）。 */
  workspaceRoot: string
  /** 视图根（upper）。 */
  viewRoot: string
  /** 控制面 store。 */
  storeRoot: string
  /** launcher 绝对路径。 */
  launcherPath: string
  /** 驱动端口；默认按平台装配（不可用即 fail-closed 端口）。 */
  driver?: NtDriverPort
  /** 命令执行器（诊断用）；默认 Windows 走 cmd.exe。 */
  run?: (command: string) => Promise<string>
  /** provider 管道名（默认 dshnt-provider）。 */
  providerPipe?: string
  /** 直接指定 provider 的套接字路径（测试可用 Unix socket）。 */
  providerSocket?: string
  policy?: NtRawFacts['policy']
  network?: NtRawFacts['network']
  applyReady?: boolean
  tokenMode?: NtTokenMode
  networkMode?: NtNetworkMode
  appContainerSid?: string
  job?: Partial<NtDomain['job']>
  extraRules?: NtDomain['rules']
  platform?: NodeJS.Platform
}

/** 一条诊断结论。`fail` 才会让 `ok=false`；`warn` 是“没坏，但此刻不可用”。 */
export interface NtDoctorCheck {
  id: string
  title: string
  status: 'ok' | 'warn' | 'fail'
  detail?: string
  /** 可操作的修复动作（用户侧文案）。 */
  fix?: string
}

export interface NtDoctorReport {
  /** 能力面是否齐全（不等于沙箱已接管；见 `ready`）。 */
  ok: boolean
  /** 内核路径此刻是否就绪（与 `/winstage nt status` 同一判据）。 */
  ready: boolean
  checks: NtDoctorCheck[]
  status: NtStatus
  summary: string
  /** 驱动 hello（拿得到才有）。 */
  hello?: NtDriverHello
  /** 驱动统计（拿得到才有）。 */
  stats?: NtDriverStats
}

/**
 * NT 运行时（诊断用）。
 *
 * `probe()` 每次重新采集事实（驱动可能刚被卸载/重载），**不缓存**状态。
 */
export class NtRuntime {
  readonly driver: NtDriverPort
  private readonly options: NtRuntimeOptions
  private readonly run: (command: string) => Promise<string>
  private readonly platform: NodeJS.Platform

  constructor(options: NtRuntimeOptions, driver: NtDriverPort) {
    this.options = options
    this.driver = driver
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? createWindowsCommandRunner(this.platform)
  }

  /** 该域的策略（与 provider 用**同一**构造函数，避免诊断/运行两套规则）。 */
  policy() {
    return buildDomainPolicy({
      workspaceRoot: this.options.workspaceRoot,
      viewRoot: this.options.viewRoot,
      storeRoot: this.options.storeRoot,
      ...(this.options.tokenMode === undefined ? {} : { tokenMode: this.options.tokenMode }),
      ...(this.options.networkMode === undefined ? {} : { network: this.options.networkMode }),
      ...(this.options.job === undefined ? {} : { job: this.options.job }),
      ...(this.options.extraRules === undefined ? {} : { extraRules: this.options.extraRules }),
      ...(this.options.appContainerSid === undefined ? {} : { appContainerSid: this.options.appContainerSid }),
    })
  }

  /** 采集事实 → `NtStatus`。任何失败都降级为“未知/未就绪”，绝不默认可用。 */
  async probe(): Promise<NtStatus> {
    const facts = await collectNtFacts({
      run: this.run,
      ...(this.options.providerPipe === undefined ? {} : { providerPipe: this.options.providerPipe }),
      ...(this.options.policy === undefined ? {} : { policy: this.options.policy }),
      ...(this.options.network === undefined ? {} : { network: this.options.network }),
      applyReady: this.options.applyReady === true,
    })

    const socketPath = this.options.providerSocket ?? providerSocketPath(this.options.providerPipe ?? DEFAULT_PROVIDER_PIPE, this.platform)
    if (socketPath !== undefined) {
      const provider = await queryProviderStats(socketPath)
      facts.providerAlive = provider.alive
      facts.providerViews = provider.views
      if (!provider.alive && provider.error !== undefined) {
        facts.notes = [...(facts.notes ?? []), `provider probe: ${provider.error}`]
      }
    }

    try {
      const hello = await this.driver.hello()
      facts.abiVersion = hello.abiVersion
      facts.filter = facts.filter ?? { loaded: true }
      if (facts.filter.altitude === undefined) facts.filter.altitude = hello.altitude
    } catch (error) {
      const reason = error instanceof NtError ? error.code : String((error as Error)?.message ?? error)
      facts.service = facts.service === 'running' ? facts.service : 'unknown'
      facts.notes = [...(facts.notes ?? []), `driver hello failed: ${reason}`]
    }

    if (this.options.policy === undefined) {
      // 驱动只接受 generation 单调递增；这里只把“已下发”当作事实，不猜 hash。
      try {
        const stats = await this.driver.queryStats()
        if (stats.policyGeneration > 0) {
          facts.policy = { valid: true, generation: stats.policyGeneration, hash: '' }
        }
      } catch {
        // 端口不可用：保持 policy 未提供（unknown）。
      }
    }

    return assessNtStatus(facts)
  }

  /** 诊断：逐项列出“能不能用”，以及每一步怎么修。 */
  async doctor(): Promise<NtDoctorReport> {
    const status = await this.probe()
    const checks: NtDoctorCheck[] = []

    checks.push(
      status.driver.loaded
        ? { id: 'driver-filter', title: 'dshnt 筛选器已加载', status: 'ok', detail: status.driver.altitude ? `altitude=${status.driver.altitude}` : undefined }
        : {
            id: 'driver-filter',
            title: 'dshnt 筛选器未加载',
            status: 'fail',
            detail: status.driver.error ?? 'fltmc filters 未列出 dshnt',
            fix: '安装驱动：pnputil /add-driver dshnt.inf /install（或 sc create + Instances 键），然后 fltmc load dshnt。',
          },
    )

    let hello: NtDriverHello | undefined
    try {
      hello = await this.driver.hello()
    } catch (error) {
      hello = undefined
      checks.push({
        id: 'driver-port',
        title: '驱动通信端口不可用',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
        fix: '确认 dshnt.sys 已加载、\\DshNtPort 存在，且当前进程有 koffi 依赖。',
      })
    }
    if (hello !== undefined) {
      const abiOk = hello.abiVersion === 2
      checks.push({
        id: 'driver-abi',
        title: abiOk ? `驱动 ABI 匹配（v${hello.abiVersion}）` : `驱动 ABI 不匹配（v${hello.abiVersion}，控制面 v2）`,
        status: abiOk ? 'ok' : 'fail',
        detail: `driver=${hello.driverVersion} altitude=${hello.altitude} supports=${hello.supports.join(',')}`,
        ...(abiOk ? {} : { fix: '把驱动与控制面升级到同一 ABI；不要混用旧 .sys。' }),
      })
    }

    checks.push(
      status.projfs.enabled
        ? { id: 'projfs-feature', title: 'Client-ProjFS 已启用', status: 'ok' }
        : {
            id: 'projfs-feature',
            title: 'Client-ProjFS 未启用（或无法确认）',
            status: 'fail',
            fix: 'Enable-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -All（需要重启）。',
          },
    )

    checks.push(
      status.projfs.providerRunning
        ? { id: 'provider', title: 'ProjFS provider 在运行', status: 'ok', detail: status.projfs.viewRoot ? `view=${status.projfs.viewRoot}` : undefined }
        : {
            id: 'provider',
            title: 'ProjFS provider 未运行',
            status: 'fail',
            detail: status.projfs.error,
            fix: '启动 dshnt-provider（--pipe dshnt-provider）并由控制面下发 start。',
          },
    )

    const built = this.policy()
    const validation = validatePolicy(built.policy, { requireAppContainerSid: this.options.tokenMode === 'appcontainer' })
    checks.push(
      validation.ok
        ? { id: 'policy-compile', title: '域策略校验通过', status: 'ok', detail: `rules=${built.domain.rules.length}` }
        : {
            id: 'policy-compile',
            title: '域策略校验失败',
            status: 'fail',
            detail: validation.errors.join('; '),
            fix: '检查 workspace/view/store 根是否重叠、规则路径是否合法。',
          },
    )
    if (status.policy.valid) {
      checks.push({
        id: 'policy-applied',
        title: `策略已下发（generation=${status.policy.generation ?? '?'}）`,
        status: 'ok',
      })
    } else {
      checks.push({
        id: 'policy-applied',
        title: '策略尚未下发到驱动',
        status: 'warn',
        detail: 'v1 的插件只做诊断，不自动 set-policy；沙箱因此未接管。',
        fix: 'M2 起由控制面自动下发；在此之前可用 dshnt-ctl set-policy <file> 手工验证。',
      })
    }

    if (status.network.mode === 'observed') {
      checks.push({ id: 'network-gate', title: '网络档位 observed（只记录，不拦截）', status: 'ok' })
    } else if (status.network.enforced) {
      checks.push({ id: 'network-gate', title: `网络闸门已安装（${status.network.mode}）`, status: 'ok' })
    } else {
      checks.push({
        id: 'network-gate',
        title: `网络闸门未安装（${status.network.mode}）`,
        status: 'warn',
        detail: 'WFP 闸门按子进程（launcher）安装；此刻没有沙箱子进程在跑。',
        fix: '在 offline/allowlist 下启动子进程时由 launcher 安装并回读；失败即 fail-closed。',
      })
    }

    checks.push({
      id: 'apply-path',
      title: 'apply 走可信控制面（journal/undo）',
      status: 'ok',
      detail: 'v1 未使用内核 apply helper / grantApply；driver 的能力位保留给 M2。',
    })

    const warnings = status.notes.filter((note) => !/^probed at /.test(note))
    if (warnings.length > 0) {
      checks.push({
        id: 'facts',
        title: '采集期间有降级事实',
        status: 'warn',
        detail: warnings.join(' | '),
      })
    }

    const ok = checks.every((check) => check.status !== 'fail')
    const ready = isKernelReady(status)
    const summary = ok
      ? ready
        ? summarizeStatus(status)
        : `内核能力齐备，但沙箱尚未接管：${summarizeStatus(status)}`
      : `NT 能力诊断未通过：${checks.filter((check) => check.status === 'fail').map((check) => check.title).join('；')}`

    const stats = await this.driver.queryStats().catch(() => undefined)
    return {
      ok,
      ready,
      checks,
      status,
      summary,
      ...(hello === undefined ? {} : { hello }),
      ...(stats === undefined ? {} : { stats }),
    }
  }

  /** 释放端口（Windows 上关闭 FilterSendMessage 句柄）。 */
  async dispose(): Promise<void> {
    const closeable = this.driver as unknown as { close?: () => void }
    if (typeof closeable.close === 'function') {
      closeable.close()
    }
  }
}

/** 装配运行时。默认端口在 Windows+koffi 可用时才真实连接，否则 fail-closed。 */
export async function createNtRuntime(options: NtRuntimeOptions): Promise<NtRuntime> {
  const driver =
    options.driver ??
    (await createDriverPortAsync({ fake: process.env.DSH_NT_FAKE_DRIVER === '1' }))
  return new NtRuntime(options, driver)
}

/** 状态卡文本（`/winstage nt status`）。 */
export function renderNtStatus(status: NtStatus): string {
  return [summarizeStatus(status), '', renderStatusCard(status)].join('\n')
}

const MARK: Readonly<Record<NtDoctorCheck['status'], string>> = Object.freeze({
  ok: '✓',
  warn: '!',
  fail: '✗',
})

/** 诊断文本（`/winstage nt doctor`）。 */
export function renderNtDoctor(report: NtDoctorReport): string {
  const lines = [report.summary, '', `能力: ${report.ok ? '通过' : '未通过'} · 沙箱就绪: ${report.ready ? '是' : '否'}`]
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.title}${check.detail ? `（${check.detail}）` : ''}`)
    if (check.fix) lines.push(`      → ${check.fix}`)
  }
  if (report.stats !== undefined) {
    lines.push(
      `  驱动统计: generation=${report.stats.policyGeneration} domains=${report.stats.domains} rules=${report.stats.rules} ` +
        `redirects=${report.stats.redirects} denies=${report.stats.denies} masks=${report.stats.masks}` +
        (report.stats.processCount === undefined ? '' : ` processes=${report.stats.processCount}`),
    )
  }
  return lines.join('\n')
}
