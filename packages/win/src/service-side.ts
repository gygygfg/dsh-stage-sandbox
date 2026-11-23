/**
 * 服务侧写入（service-side writes）静态识别 —— TS（透明垫片）档的**策略补丁**。
 *
 * ── 为什么需要它（2026-11-23，AI 红队实测）────────────────────────────────────
 * 透明垫片只钩**本进程树**的 IAT。任何"让 Windows 服务代跑"的构造都绕过它：
 *
 *   · `wmic process call create "cmd /c …"`  → WmiPrvSE.exe（未注入）创建子进程
 *   · `schtasks /create …`                   → Task Scheduler 服务写真实任务文件
 *   · `sc create …`                          → services.exe 写真实服务键
 *   · `wevtutil cl` / `vssadmin delete shadows` / `Set-MpPreference` / `netsh advfirewall`
 *
 * 实测：前三条在真实盘/真实共享目录上留下了可复核的文件与注册表（见
 * docs/AI红队渗透实测-2026-11-23.md）。因此 TS 档必须把**已知的服务侧写入**按命令文本
 * 拦下（fail-closed），并如实告诉调用方"这一档不覆盖服务侧写入；要覆盖请用 NT 档"。
 *
 * ── 边界声明（必须写死，避免把文本拦截当成安全边界）────────────────────────────
 * 这是**策略拒绝**，不是内核边界：它可以被编码/间接调用/自写程序绕过（文本判定永远是
 * 不完备的）。真正的边界只有 NT（ProjFS + minifilter）档。本模块的价值是：
 *   ① 把最常见的几条"一句话逃逸"挡在门外；
 *   ② 让"这一档不覆盖什么"变成可查询、可测试的事实，而不是口头约定。
 *
 * ── 扫描面 ──────────────────────────────────────────────────────────────────
 *  · 命令 + 参数原文；
 *  · 参数里指向 `.cmd/.bat/.ps1` 的**脚本文件内容**（agent 常用"写脚本再跑"绕过文本面）；
 *  · PowerShell `-EncodedCommand/-enc` 的 base64（UTF-16LE）解码结果。
 */

export const SERVICE_SIDE_CHANNELS = Object.freeze({
  WMI_PROCESS_CREATE: 'wmi-process-create',
  SCM_SERVICE: 'scm-service',
  TASK_SCHEDULER: 'task-scheduler',
  EVENT_LOG: 'event-log',
  VOLUME_SHADOW: 'volume-shadow',
  DEFENDER_POLICY: 'defender-policy',
  FIREWALL: 'firewall',
  BOOT_CONFIG: 'boot-config',
})

/** 人读通道名（状态卡/错误文本共用） */
export const SERVICE_SIDE_CHANNEL_LABELS = Object.freeze({
  [SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE]: 'WMI 进程创建',
  [SERVICE_SIDE_CHANNELS.SCM_SERVICE]: '服务控制管理器（SCM）',
  [SERVICE_SIDE_CHANNELS.TASK_SCHEDULER]: '计划任务服务',
  [SERVICE_SIDE_CHANNELS.EVENT_LOG]: '事件日志服务',
  [SERVICE_SIDE_CHANNELS.VOLUME_SHADOW]: '卷影复制服务',
  [SERVICE_SIDE_CHANNELS.DEFENDER_POLICY]: 'Defender 策略服务',
  [SERVICE_SIDE_CHANNELS.FIREWALL]: '防火墙服务',
  [SERVICE_SIDE_CHANNELS.BOOT_CONFIG]: '启动配置（BCD）',
})

const SHELL_BASENAMES = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])

function baseNameLower(value) {
  const text = String(value ?? '').replace(/^["']|["']$/g, '')
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return (index >= 0 ? text.slice(index + 1) : text).toLowerCase()
}

/** 把一段命令文本按"命令位"粗分（够用即可：我们只匹配已知构造，不追求完整语法） */
function normalize(text) {
  return String(text ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * @param {string} text 已拼接的命令文本（含脚本内容/解码后的载荷）
 * @returns {{channel: string, reason: string, evidence: string}|null}
 */
export function matchServiceSideText(text) {
  const s = normalize(text)
  if (!s) return null

  // ── WMI 进程创建 ────────────────────────────────────────────────────────────
  if (/\bwmic(\.exe)?\b/.test(s) && /\bprocess\s+call\s+create\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE,
      reason: 'wmic process call create 由 WmiPrvSE（未注入的服务进程）创建子进程',
      evidence: 'wmic process call create',
    }
  }
  if (/win32_process[\s\S]{0,240}?\.\s*create\s*\(/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE,
      reason: 'Win32_Process.Create 由 WmiPrvSE（未注入的服务进程）创建子进程',
      evidence: 'Win32_Process.Create(',
    }
  }
  if (/\binvoke-cimmethod\b[\s\S]{0,240}?win32_process/.test(s) && /-methodname\s+["']?create/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE,
      reason: 'Invoke-CimMethod Win32_Process Create 走 WMI 服务',
      evidence: 'Invoke-CimMethod Win32_Process -MethodName Create',
    }
  }
  if (/\bwmic(\.exe)?\b/.test(s) && /\bshadowcopy\b[\s\S]{0,80}\bdelete\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.VOLUME_SHADOW,
      reason: 'wmic shadowcopy delete 由 VSS 服务删除卷影副本',
      evidence: 'wmic shadowcopy delete',
    }
  }

  // ── SCM（服务）──────────────────────────────────────────────────────────────
  if (/\bsc(\.exe)?\s+(create|config|delete|failure|sdset|triggerinfo)\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.SCM_SERVICE,
      reason: 'sc create/config/delete 由 services.exe 写真实服务键（不在暂存覆盖层）',
      evidence: 'sc <mutating verb>',
    }
  }
  if (/\b(new|set|remove)-service\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.SCM_SERVICE,
      reason: '*-Service 通过 SCM 写真实服务配置',
      evidence: '*-Service',
    }
  }

  // ── 计划任务 ────────────────────────────────────────────────────────────────
  if (/\bschtasks(\.exe)?\b[\s\S]{0,200}?\/(create|change)\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.TASK_SCHEDULER,
      reason: 'schtasks /create|/change 由计划任务服务写真实任务文件',
      evidence: 'schtasks /create',
    }
  }
  if (/\bregister-scheduledtask\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.TASK_SCHEDULER,
      reason: 'Register-ScheduledTask 由计划任务服务写真实任务文件',
      evidence: 'Register-ScheduledTask',
    }
  }

  // ── 事件日志 / 卷影 / Defender / 防火墙 / BCD ────────────────────────────────
  if (/\bwevtutil(\.exe)?\b[\s\S]{0,120}?\b(cl|clear-log)\b/.test(s) || /\bclear-eventlog\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.EVENT_LOG,
      reason: 'wevtutil cl / Clear-EventLog 由事件日志服务清真实日志',
      evidence: 'wevtutil cl',
    }
  }
  if (/\bvssadmin(\.exe)?\b[\s\S]{0,120}?\bdelete\b[\s\S]{0,40}?\bshadows?\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.VOLUME_SHADOW,
      reason: 'vssadmin delete shadows 由 VSS 服务删除真实卷影副本',
      evidence: 'vssadmin delete shadows',
    }
  }
  if (/\b(set|add|remove)-mppreference\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.DEFENDER_POLICY,
      reason: '*MpPreference 通过 Defender 服务改真实策略',
      evidence: '*-MpPreference',
    }
  }
  if (/\bnetsh(\.exe)?\b[\s\S]{0,120}?\badvfirewall\b[\s\S]{0,80}?\b(set|add|delete|reset)\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.FIREWALL,
      reason: 'netsh advfirewall 改真实防火墙策略（由防火墙服务执行）',
      evidence: 'netsh advfirewall <set|add|delete|reset>',
    }
  }
  if (/\bbcdedit(\.exe)?\b/.test(s) && /\/(set|setglobal|delete|create|import|export|copy|default|timeout|bootsequence|displayorder|toolsdisplayorder)\b/.test(s)) {
    return {
      channel: SERVICE_SIDE_CHANNELS.BOOT_CONFIG,
      reason: 'bcdedit 写操作改真实启动配置（不在暂存覆盖层）',
      evidence: 'bcdedit /<mutating switch>',
    }
  }

  return null
}

/** 从 base64 里解出 PowerShell `-EncodedCommand`（UTF-16LE；失败则返回空串） */
export function decodePowerShellEncodedCommand(text) {
  const match = /(?:^|\s)-(?:encodedcommand|enc|e)\s+([A-Za-z0-9+/=]{8,})/i.exec(String(text ?? ''))
  if (!match) return ''
  try {
    const buffer = Buffer.from(match[1], 'base64')
    if (buffer.length % 2 !== 0) return ''
    return buffer.toString('utf16le')
  } catch {
    return ''
  }
}

/**
 * 构造分类文本：命令 + 参数 + 参数指向的脚本文件内容 + EncodedCommand 载荷。
 *
 * 只读**已存在**的小脚本（≤ 256 KiB），不跟随命令行里凭空出现的路径；
 * 读不到就跳过（分类器仍然对命令文本生效，读失败不改变"不命中"的结论）。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{readFile?: (path: string) => string|null, maxBytes?: number}} [io]
 */
export function buildServiceSideScanText(command, args = [], io = {}) {
  const argv = [command, ...(Array.isArray(args) ? args : [])].filter((v) => v !== undefined && v !== null).map(String)
  const parts = [argv.join(' ')]
  const readFile = io.readFile
  const maxBytes = io.maxBytes ?? 256 * 1024
  if (typeof readFile === 'function') {
    const candidates = new Set()
    for (const token of argv) {
      const cleaned = token.replace(/^["']|["']$/g, '')
      if (!/\.(cmd|bat|ps1)$/i.test(cleaned)) continue
      candidates.add(cleaned)
    }
    for (const candidate of candidates) {
      try {
        const text = readFile(candidate, maxBytes)
        if (typeof text === 'string' && text.length > 0) parts.push(text.slice(0, maxBytes))
      } catch {
        /* 读不到脚本不影响对命令文本本身的判定 */
      }
    }
  }
  const decoded = decodePowerShellEncodedCommand(parts.join(' '))
  if (decoded) parts.push(decoded)
  return parts.join('\n')
}

/**
 * 组合入口：命令是否命中"服务侧写入"。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{readFile?: Function, maxBytes?: number, allow?: boolean}} [options]
 * @returns {{hit: boolean, channel?: string, label?: string, reason?: string, evidence?: string}}
 */
export function classifyServiceSideWrite(command, args = [], options = {}) {
  if (options.allow === true) return { hit: false }
  const text = buildServiceSideScanText(command, args, options)
  const match = matchServiceSideText(text)
  if (!match) return { hit: false }
  return {
    hit: true,
    channel: match.channel,
    label: SERVICE_SIDE_CHANNEL_LABELS[match.channel] ?? match.channel,
    reason: match.reason,
    evidence: match.evidence,
  }
}

/** 已经实现"真重定向"（不是拒绝）的通道 —— 目前只有 WMI 进程创建（shim 改写内层命令行）。 */
export const SERVICE_SIDE_REDIRECTED = Object.freeze({
  [SERVICE_SIDE_CHANNELS.WMI_PROCESS_CREATE]: 'injector-rewrite',
})

/** 某通道在当前 lane 上是否可重定向；返回重定向方式或 null */
export function serviceSideRedirectFor(channel, lane) {
  if (lane !== 'shim') return null
  return SERVICE_SIDE_REDIRECTED[channel] ?? null
}

/** 供状态卡/文档引用：TS 档**尚未覆盖**的服务侧通道清单（WMI 已改为重定向，见上） */
export const SERVICE_SIDE_UNCOVERED = Object.freeze([
  SERVICE_SIDE_CHANNELS.SCM_SERVICE,
  SERVICE_SIDE_CHANNELS.TASK_SCHEDULER,
  SERVICE_SIDE_CHANNELS.EVENT_LOG,
  SERVICE_SIDE_CHANNELS.VOLUME_SHADOW,
  SERVICE_SIDE_CHANNELS.DEFENDER_POLICY,
  SERVICE_SIDE_CHANNELS.FIREWALL,
  SERVICE_SIDE_CHANNELS.BOOT_CONFIG,
])

export function isShellCommand(command) {
  return SHELL_BASENAMES.has(baseNameLower(command))
}
