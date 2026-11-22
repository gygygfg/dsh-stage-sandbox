/**
 * Windows 路径规范化、视图映射与输出还原。
 *
 * 设计约束：
 *   · 所有安全判定使用**规范化后的小写路径**（Windows 大小写不敏感）；
 *   · 策略只接受绝对本地盘路径（`C:\...`）；设备/UNC/ADS/通配符默认拒绝，
 *     避免“策略说 A、内核打开 B”的歧义；
 *   · 视图映射只允许工作区内部路径 → 视图根；任何 `..` 逃逸都必须抛
 *     `NT_PATH_ESCAPE`，绝不静默截断；
 *   · `concealViewText` 只做**用户可见性**还原，不构成安全边界。
 *
 * @module winstage-sandbox/nt/paths
 */

import { win32 as pathWin32 } from 'node:path'
import { NtError } from './types.ts'

/** Windows 路径上限（NT 名义上限 32767；实际组件上限另算）。 */
export const MAX_WIN32_PATH = 32767

export interface NormalizePathOptions {
  /** 允许 UNC（`\\server\share`）。默认 false；v1 策略不接受 UNC。 */
  allowUnc?: boolean
  /** 允许 ADS（`file:stream`）。默认 false。 */
  allowAds?: boolean
  /** 允许 `*` / `?`。默认 false；策略 v1 不支持 glob。 */
  allowWildcards?: boolean
  /** 是否 trim 首尾空白（默认 true；策略输入用 true，真实文件路径请显式 false）。 */
  trim?: boolean
}

/**
 * 把输入规范成绝对本地 Windows 路径（小写、反斜杠、无尾随分隔符）。
 *
 * 抛 `NtError('NT_UNSUPPORTED_PATH' | 'NT_PATH_ESCAPE')`，不返回“尽力而为”的猜测值。
 *
 * @param input - 原始路径
 * @param options - 放宽选项（默认全部拒绝）
 * @returns 规范化后的小写路径；根路径保留 `c:\`
 */
export function normalizeWin32Path(input: string, options: NormalizePathOptions = {}): string {
  if (typeof input !== 'string') {
    throw new NtError('NT_UNSUPPORTED_PATH', { input: String(input), reason: 'not-a-string' })
  }
  let path = options.trim === false ? input : input.trim()
  if (path.length === 0) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'empty' })
  }
  if (path.includes('\0')) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'nul-byte' })
  }

  // 统一分隔符。Windows 接受 `/`，但策略/驱动必须只看到 `\`。
  path = path.replace(/\//g, '\\')

  // `\\?\` 长路径前缀：去掉后再做本地绝对路径校验。
  if (/^\\\\\?\\UNC\\/i.test(path)) {
    if (!options.allowUnc) {
      throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'unc' })
    }
    path = `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  } else if (/^\\\\\?\\/i.test(path)) {
    path = path.slice('\\\\?\\'.length)
  }

  // 设备命名空间：策略 v1 不把它当作可映射文件路径。
  if (/^\\\\\.\\/i.test(path) || /^\\Device\\/i.test(path) || /^GLOBALROOT\\/i.test(path)) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'device-namespace' })
  }

  // UNC：保留给未来；v1 策略/视图映射拒绝。
  if (/^\\\\/.test(path) && !options.allowUnc) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'unc' })
  }

  // 盘符相对路径（`C:foo`）含义依赖当前目录，不能作为安全判定输入。
  if (/^[A-Za-z]:$/.test(path)) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'drive-relative' })
  }
  if (!/^[A-Za-z]:\\/.test(path)) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'not-absolute-local' })
  }
  if (path.length > MAX_WIN32_PATH) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'too-long', length: path.length })
  }

  // 用 Node 的 win32 语义处理 `.` / `..` / 重复分隔符；之后仍是绝对路径。
  const normalized = pathWin32.normalize(path)
  if (!/^[A-Za-z]:\\/.test(normalized)) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'normalized-not-absolute', normalized })
  }

  // ADS：盘符后的冒号（`C:\a.txt:secret`）。v1 不支持，避免策略只看到文件而驱动打开流。
  if (!options.allowAds && normalized.slice(2).includes(':')) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'alternate-data-stream' })
  }

  // 通配符：策略 v1 只支持 exact/prefix，允许 `*` 会让“匹配”和“真实路径”分叉。
  if (!options.allowWildcards && /[*?]/.test(normalized)) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'wildcard' })
  }

  // 去掉尾随分隔符（根 `C:\` 除外）。
  const withoutTrailing = normalized.length > 3 && normalized.endsWith('\\') ? normalized.slice(0, -1) : normalized
  return withoutTrailing.toLowerCase()
}

/** 是否是规范化后合法的绝对本地路径。 */
export function isLocalAbsoluteWin32Path(input: string): boolean {
  try {
    normalizeWin32Path(input)
    return true
  } catch {
    return false
  }
}

/**
 * 规范化一个**相对**路径（manifest / view 内部条目）。
 * 拒绝绝对路径、盘符、UNC、`..` 与 ADS；空串表示根。
 */
export function normalizeRelativeWin32Path(input: string): string {
  if (typeof input !== 'string') {
    throw new NtError('NT_UNSUPPORTED_PATH', { input: String(input), reason: 'not-a-string' })
  }
  let rel = input.trim().replace(/\//g, '\\')
  if (rel.length === 0) return ''
  if (rel.includes('\0')) throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'nul-byte' })
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('\\')) {
    throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'relative-expected' })
  }
  const parts: string[] = []
  for (const part of rel.split('\\')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      throw new NtError('NT_PATH_ESCAPE', { input, reason: 'dot-dot-in-relative-path' })
    }
    if (part.includes(':')) {
      throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'alternate-data-stream' })
    }
    if (/[*?]/.test(part)) {
      throw new NtError('NT_UNSUPPORTED_PATH', { input, reason: 'wildcard' })
    }
    parts.push(part)
  }
  return parts.join('\\').toLowerCase()
}

/** 判断 `child` 是否等于 `parent` 或位于其下（前缀边界安全：`C:\ws2` 不属于 `C:\ws`）。 */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizeWin32Path(child)
  const p = normalizeWin32Path(parent)
  if (c === p) return true
  if (p.endsWith('\\')) return c.startsWith(p)
  return c.startsWith(`${p}\\`)
}

/** 断言 `child` 在 `parent` 内；否则抛 `NT_PATH_ESCAPE`。 */
export function assertPathInside(child: string, parent: string, detail?: Record<string, unknown>): void {
  if (!isPathInside(child, parent)) {
    throw new NtError('NT_PATH_ESCAPE', { child, parent, ...detail })
  }
}

/** 返回 `child` 相对 `parent` 的路径（空串表示同一路径；不含前导分隔符）。 */
export function relativeToRoot(child: string, parent: string): string {
  const c = normalizeWin32Path(child)
  const p = normalizeWin32Path(parent)
  if (c === p) return ''
  if (p.endsWith('\\')) {
    if (!c.startsWith(p)) throw new NtError('NT_PATH_ESCAPE', { child: c, parent: p })
    return c.slice(p.length)
  }
  if (!c.startsWith(`${p}\\`)) throw new NtError('NT_PATH_ESCAPE', { child: c, parent: p })
  return c.slice(p.length + 1)
}

/** 把相对路径接到一个绝对根下；拒绝 `..` 与绝对输入。 */
export function joinWin32(root: string, relative: string): string {
  const base = normalizeWin32Path(root)
  const rel = normalizeRelativeWin32Path(relative)
  if (rel.length === 0) return base
  const joined = base.endsWith('\\') ? `${base}${rel}` : `${base}\\${rel}`
  const normalized = normalizeWin32Path(joined)
  assertPathInside(normalized, base, { operation: 'joinWin32' })
  return normalized
}

/** 逻辑工作区路径 → 视图根路径。 */
export function logicalToView(logicalPath: string, workspaceRoot: string, viewRoot: string): string {
  const logical = normalizeWin32Path(logicalPath)
  const workspace = normalizeWin32Path(workspaceRoot)
  const view = normalizeWin32Path(viewRoot)
  assertPathInside(logical, workspace, { operation: 'logicalToView' })
  return joinWin32(view, relativeToRoot(logical, workspace))
}

/** 视图根路径 → 逻辑工作区路径。 */
export function viewToLogical(viewPath: string, workspaceRoot: string, viewRoot: string): string {
  const view = normalizeWin32Path(viewRoot)
  const workspace = normalizeWin32Path(workspaceRoot)
  const candidate = normalizeWin32Path(viewPath)
  assertPathInside(candidate, view, { operation: 'viewToLogical' })
  return joinWin32(workspace, relativeToRoot(candidate, view))
}

/** 前缀/精确匹配的“特异性”分数；数值越大越具体。 */
export function matchSpecificity(match: { kind: 'exact' | 'prefix'; path: string }): number {
  return match.kind === 'exact' ? 1_000_000 + match.path.length : match.path.length
}

/** 判断一个已规范化的路径是否命中 match。 */
export function matchPath(match: { kind: 'exact' | 'prefix'; path: string }, path: string): boolean {
  const candidate = normalizeWin32Path(path)
  if (match.kind === 'exact') return candidate === match.path
  return isPathInside(candidate, match.path)
}

/** 是否是盘符根（`C:\`）。 */
export function isDriveRoot(path: string): boolean {
  const normalized = normalizeWin32Path(path)
  return /^[a-z]:\\$/.test(normalized)
}

/** 是否包含 ADS（把用户输入当作真实路径时用于诊断；允许 ADS 规范化后再判断）。 */
export function hasAlternateDataStream(input: string): boolean {
  try {
    const normalized = normalizeWin32Path(input, { allowAds: true })
    return normalized.slice(2).includes(':')
  } catch {
    return false
  }
}

/**
 * 把输出中的视图根还原成真实工作区根，并去掉常见的沙箱指纹。
 *
 * ⚠ 这是**用户可见性**处理，不是安全边界：真正的边界在驱动/ProjFS。
 *
 * @param text - 命令输出/错误
 * @param mappings - `{from,to}` 列表；`from` 通常是视图根/临时根，`to` 是逻辑工作区根
 * @param extraTokens - 额外要去掉的指纹词（默认包含 `dshnt`/`dsh-nt`/`projfs`）
 */
export function concealViewText(
  text: string,
  mappings: ReadonlyArray<{ from: string; to: string }>,
  extraTokens: readonly string[] = ['dshnt', 'dsh-nt', 'projfs', 'Projected File System'],
): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let output = text
  const sorted = [...mappings].filter((m) => m.from.length > 0).sort((a, b) => b.from.length - a.from.length)
  for (const mapping of sorted) {
    const variants = new Set<string>([mapping.from, mapping.from.replace(/\\/g, '/')])
    for (const from of variants) {
      const pattern = new RegExp(escapeRegExp(from), 'gi')
      // 保留分隔符风格：文本里是正斜杠时，替换目标也用正斜杠，避免 `C:\a/b` 混合形态。
      const replacement = from.includes('/') ? mapping.to.replace(/\\/g, '/') : mapping.to
      output = output.replace(pattern, replacement)
    }
  }
  for (const token of extraTokens) {
    if (token.length === 0) continue
    output = output.replace(new RegExp(escapeRegExp(token), 'gi'), 'sandbox')
  }
  return output
}

/** 正则转义。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
