/**
 * 构造 `dshnt-launch.exe` 的参数（纯函数，可在 Linux 上单测）。
 *
 * 目的：把“域/视图/策略/网络/Job/环境/目标 argv”的启动契约固定下来，避免
 * `ctx.sandbox.confine()`、CLI、测试三处各拼一份参数而漂移。
 *
 * 安全约束：
 *   · launcher 必须是绝对本地路径；view/workspace 必须不重叠；
 *   · cwd 默认视图根，且不得逃出视图根；
 *   · 环境按允许清单重建；凭据类键默认拒绝（`NT_ENV_REJECTED`）；
 *   · 目标 argv 原样放在 `--` 之后，launcher 不解释 shell 字符串。
 *
 * @module winstage-sandbox/nt/launcher-args
 */

import { isPathInside, normalizeWin32Path } from './paths.ts'
import { NtError, type NtJobLimits, type NtNetworkMode, type NtTokenMode } from './types.ts'

/** 凭据类环境变量键（默认拒绝；显式 `allowSensitiveEnv` 才放行）。 */
export const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|SESSION_KEY|COOKIE)/i

/** `buildLauncherArgv` 输入。 */
export interface LauncherArgvInput {
  /** `dshnt-launch.exe` 的绝对本地路径。 */
  launcherPath: string
  domain: string
  viewRoot: string
  workspaceRoot: string
  policyGeneration: number
  network: NtNetworkMode
  job: NtJobLimits
  tokenMode: NtTokenMode
  /** AppContainer SID；`tokenMode='appcontainer'` 时必填。 */
  appContainerSid?: string
  /** 默认视图根；提供时必须位于视图根内。 */
  cwd?: string
  /** 环境白名单；按 key 字典序稳定输出。 */
  env?: Record<string, string>
  /** 允许凭据类环境键（默认 false；仅显式诊断用）。 */
  allowSensitiveEnv?: boolean
  /** 目标 argv；不能为空。 */
  argv: readonly string[]
}

/**
 * 构造 launcher argv。
 *
 * @param input - 启动契约
 * @returns 完整 argv（launcher + 选项 + `--` + 目标 argv）
 */
export function buildLauncherArgv(input: LauncherArgvInput): string[] {
  const launcher = normalizeWin32Path(input.launcherPath)
  if (typeof input.domain !== 'string' || input.domain.trim().length === 0 || /\s/.test(input.domain)) {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'domain id must be a non-empty string without whitespace' })
  }
  const viewRoot = normalizeWin32Path(input.viewRoot)
  const workspaceRoot = normalizeWin32Path(input.workspaceRoot)
  if (isPathInside(viewRoot, workspaceRoot) || isPathInside(workspaceRoot, viewRoot)) {
    throw new NtError('NT_VIEW_ROOT_INVALID', { reason: 'viewRoot and workspaceRoot must not overlap', viewRoot, workspaceRoot })
  }
  if (!Number.isInteger(input.policyGeneration) || input.policyGeneration <= 0) {
    throw new NtError('NT_POLICY_GENERATION_MISMATCH', { reason: 'policyGeneration must be a positive integer' })
  }
  if (input.network !== 'offline' && input.network !== 'allowlist' && input.network !== 'observed') {
    throw new NtError('NT_NETWORK_UNSUPPORTED', { reason: `unknown network mode: ${String(input.network)}` })
  }
  if (input.network === 'allowlist' && input.tokenMode !== 'appcontainer') {
    throw new NtError('NT_NETWORK_UNSUPPORTED', { reason: 'allowlist requires appcontainer token' })
  }
  if (input.tokenMode !== 'appcontainer' && input.tokenMode !== 'restricted') {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: `unknown token mode: ${String(input.tokenMode)}` })
  }
  if (input.tokenMode === 'appcontainer') {
    if (typeof input.appContainerSid !== 'string' || !/^S-1-\d+(-\d+)+$/i.test(input.appContainerSid)) {
      throw new NtError('NT_CAPABILITY_MISSING', { reason: 'appcontainer requires a valid SID' })
    }
  }

  const cwd = input.cwd === undefined ? viewRoot : normalizeWin32Path(input.cwd)
  if (!isPathInside(cwd, viewRoot)) {
    throw new NtError('NT_PATH_ESCAPE', { reason: 'cwd must be inside viewRoot', cwd, viewRoot })
  }

  validateJob(input.job)
  if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.some((item) => typeof item !== 'string')) {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'argv must be a non-empty string array' })
  }
  for (const item of input.argv) {
    if (item.includes('\0')) throw new NtError('NT_UNSUPPORTED_PATH', { reason: 'NUL in argv' })
  }

  const args = [
    launcher,
    '--domain',
    input.domain,
    '--view',
    viewRoot,
    '--workspace',
    workspaceRoot,
    '--policy-generation',
    String(input.policyGeneration),
    '--network',
    input.network,
    '--token',
    input.tokenMode,
    '--cwd',
    cwd,
    '--job-memory-mb',
    String(input.job.memoryMb),
    '--job-active-processes',
    String(input.job.activeProcessLimit),
    '--job-cpu-percent',
    String(input.job.cpuPercent),
    '--job-kill-on-close',
    input.job.killOnClose ? '1' : '0',
  ]
  if (input.tokenMode === 'appcontainer') args.push('--sid', String(input.appContainerSid))

  for (const [key, value] of sortedEnv(input.env ?? {}, input.allowSensitiveEnv === true)) {
    args.push('--env-allow', `${key}=${value}`)
  }

  args.push('--', ...input.argv)
  return args
}

/**
 * 校验并排序环境白名单。
 *
 * - key 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；
 * - value 不能含 NUL；
 * - 默认拒绝凭据类键（避免把宿主 token 带进沙箱）。
 */
export function sortedEnv(env: Record<string, string>, allowSensitive = false): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new NtError('NT_ENV_REJECTED', { reason: 'invalid env key', key })
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new NtError('NT_ENV_REJECTED', { reason: 'env value must be a string without NUL', key })
    }
    if (!allowSensitive && SENSITIVE_ENV_KEY.test(key)) {
      throw new NtError('NT_ENV_REJECTED', { reason: 'sensitive env key rejected', key })
    }
    entries.push([key, value])
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

function validateJob(job: NtJobLimits): void {
  if (job === null || typeof job !== 'object') {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'job limits missing' })
  }
  if (!Number.isFinite(job.memoryMb) || job.memoryMb <= 0) {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'job.memoryMb must be positive' })
  }
  if (!Number.isInteger(job.activeProcessLimit) || job.activeProcessLimit <= 0) {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'job.activeProcessLimit must be a positive integer' })
  }
  if (!Number.isInteger(job.cpuPercent) || job.cpuPercent < 0 || job.cpuPercent > 100) {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'job.cpuPercent must be 0..100' })
  }
  if (typeof job.killOnClose !== 'boolean') {
    throw new NtError('NT_CAPABILITY_MISSING', { reason: 'job.killOnClose must be boolean' })
  }
}
