/**
 * ProjFS 视图的读取抽象与候选 diff。
 *
 * ProjFS 把“真实工作区（lower）+ 视图根（upper）”合并成一个目录：
 *   · placeholder = 未修改，内容来自 lower；
 *   · full        = 被写过/物化，内容在视图根；
 *   · tombstone   = 被删除，枚举时隐藏，且不得从 lower 复活；
 *   · absent      = 视图里没有该条目（对 base 而言可能是 corruption，不是删除）。
 *
 * 本模块只做**控制面**判定，不直接调 ProjFS；真实 `ViewProbe` 在 M1 由
 * `PrjGetOnDiskFileState` / `fs` 实现，测试用 `MemoryViewProbe`。
 *
 * @module winstage-sandbox/nt/view
 */

import { createHash } from 'node:crypto'
import { normalizeRelativeWin32Path } from './paths.ts'
import { NtError } from './types.ts'

/** 视图条目状态。 */
export type ViewEntryState = 'placeholder' | 'full' | 'tombstone' | 'absent'

/** 视图 stat 结果。`hash` 可选；不可读/大文件时由调用方决定是否 unverified。 */
export interface ViewStat {
  state: ViewEntryState
  isDirectory: boolean
  size: number
  mtimeMs: number
  hash?: string
}

/** 目录枚举条目（直接子项）。 */
export interface ViewDirEntry {
  name: string
  state: ViewEntryState
  isDirectory: boolean
  size: number
  mtimeMs: number
  hash?: string
}

/** 视图读取抽象。真实实现由 ProjFS/fs 提供；测试用内存实现。 */
export interface ViewProbe {
  state(rel: string): Promise<ViewEntryState>
  stat(rel: string): Promise<ViewStat | undefined>
  list(rel: string): Promise<readonly ViewDirEntry[]>
  read?(rel: string): Promise<Buffer>
}

/** 基线清单条目（真实工作区）。 */
export interface ViewManifestEntry {
  rel: string
  isDirectory: boolean
  size: number
  mtimeMs: number
  hash?: string
}

/** 基线清单；key 为规范化相对路径（小写、反斜杠、无前导分隔符）。 */
export type ViewManifest = ReadonlyMap<string, ViewManifestEntry>

/** 单条变更。 */
export interface ViewChange {
  rel: string
  kind: 'created' | 'modified' | 'deleted'
  before?: ViewManifestEntry
  after?: ViewStat
  /** 因为超过 maxHashBytes / 无读取能力而未能校验内容哈希。 */
  hashUnverified?: boolean
}

/** diff 结果。删除是权威逻辑状态；`corrupted` 不得被解释为删除。 */
export interface ViewDiff {
  created: ViewChange[]
  modified: ViewChange[]
  deleted: ViewChange[]
  unchanged: string[]
  /** base 中存在、但视图既无 tombstone 也无 full/placeholder 的条目（损坏）。 */
  corrupted: string[]
  dirsCreated: string[]
  dirsDeleted: string[]
}

/** 默认大文件阈值：超过此大小不整文件读哈希，改用 size/mtime 判定并标记 unverified。 */
export const DEFAULT_MAX_HASH_BYTES = 64 * 1024 * 1024

/** SHA-256（小写十六进制）。 */
export function hashBuffer(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 从条目数组构建 manifest；重复/非法相对路径直接抛错（不静默覆盖）。 */
export function manifestFromEntries(entries: readonly ViewManifestEntry[]): ViewManifest {
  const manifest = new Map<string, ViewManifestEntry>()
  for (const entry of entries) {
    const rel = normalizeRelativeWin32Path(entry.rel)
    if (rel.length === 0) throw new NtError('NT_UNSUPPORTED_PATH', { reason: 'manifest root entry is not allowed' })
    if (manifest.has(rel)) throw new NtError('NT_UNSUPPORTED_PATH', { reason: 'duplicate manifest entry', rel })
    manifest.set(rel, {
      ...entry,
      rel,
      hash: entry.hash === undefined ? undefined : entry.hash.toLowerCase(),
    })
  }
  return manifest
}

/** 便捷构造一个文件 manifest 条目（测试/控制面用）。 */
export function fileManifestEntry(rel: string, data: Buffer, mtimeMs = 0): ViewManifestEntry {
  return {
    rel: normalizeRelativeWin32Path(rel),
    isDirectory: false,
    size: data.length,
    mtimeMs,
    hash: hashBuffer(data),
  }
}

/** 便捷构造一个目录 manifest 条目。 */
export function dirManifestEntry(rel: string, mtimeMs = 0): ViewManifestEntry {
  return {
    rel: normalizeRelativeWin32Path(rel),
    isDirectory: true,
    size: 0,
    mtimeMs,
  }
}

/**
 * 对视图与基线做 diff。
 *
 * @param input - base manifest + probe + 可选阈值
 * @returns 创建/修改/删除/未变/损坏 + 目录变化
 */
export async function diffView(input: {
  base: ViewManifest
  probe: ViewProbe
  maxHashBytes?: number
}): Promise<ViewDiff> {
  const maxHashBytes = input.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES
  const created: ViewChange[] = []
  const modified: ViewChange[] = []
  const deleted: ViewChange[] = []
  const unchanged: string[] = []
  const corrupted: string[] = []

  const baseFiles = [...input.base.values()].filter((entry) => !entry.isDirectory).sort((a, b) => compareRel(a.rel, b.rel))
  const baseDirs = [...input.base.values()].filter((entry) => entry.isDirectory).sort((a, b) => compareRel(a.rel, b.rel))
  const stateCache = new Map<string, ViewEntryState>()
  const stateOf = async (rel: string): Promise<ViewEntryState> => {
    const norm = normalizeRelativeWin32Path(rel)
    const cached = stateCache.get(norm)
    if (cached !== undefined) return cached
    const value = await input.probe.state(norm)
    stateCache.set(norm, value)
    return value
  }
  const parentState = async (rel: string): Promise<'none' | 'tombstone' | 'absent'> => {
    const parts = rel.split('\\')
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('\\')
      const state = await stateOf(parent)
      if (state === 'tombstone') return 'tombstone'
      if (state === 'absent') return 'absent'
    }
    return 'none'
  }

  for (const entry of baseFiles) {
    const ancestor = await parentState(entry.rel)
    if (ancestor === 'tombstone') {
      // 目录被删除：其下文件随目录一起删除，不应误报 corruption。
      deleted.push({ rel: entry.rel, kind: 'deleted', before: entry })
      continue
    }
    if (ancestor === 'absent') {
      corrupted.push(entry.rel)
      continue
    }
    const state = await stateOf(entry.rel)
    if (state === 'tombstone') {
      deleted.push({ rel: entry.rel, kind: 'deleted', before: entry })
      continue
    }
    if (state === 'absent') {
      // 关键不变量：缺失的暂存副本是 corruption，不得从真实盘回退推断为删除。
      corrupted.push(entry.rel)
      continue
    }
    if (state === 'placeholder') {
      // 未修改：内容仍来自 lower。元数据变化先按未变处理（v1）。
      unchanged.push(entry.rel)
      continue
    }
    const stat = await input.probe.stat(entry.rel)
    if (stat === undefined || stat.state === 'absent') {
      corrupted.push(entry.rel)
      continue
    }
    if (stat.state === 'tombstone') {
      deleted.push({ rel: entry.rel, kind: 'deleted', before: entry })
      continue
    }
    if (stat.isDirectory) {
      corrupted.push(entry.rel)
      continue
    }
    const changed = await isContentChanged(entry, stat, input.probe, maxHashBytes)
    if (changed.changed) {
      modified.push({ rel: entry.rel, kind: 'modified', before: entry, after: stat, hashUnverified: changed.unverified })
    } else {
      unchanged.push(entry.rel)
    }
  }

  // 视图新增条目：递归枚举 full 文件；placeholder 不在 base 中出现属于异常，忽略；
  // tombstone 对“base 不存在”的路径没有语义，忽略。
  const seenDirs = new Set<string>()
  const newFiles: ViewChange[] = []
  const dirsCreated = new Set<string>()
  const viewEntries = await walkView(input.probe, '', seenDirs, new Set())
  for (const item of viewEntries) {
    if (item.isDirectory) {
      // 只有 full 目录才是“视图内新建/物化”；placeholder 是 lower 的投影。
      if (item.state === 'full' && !baseDirs.some((entry) => entry.rel === item.rel)) dirsCreated.add(item.rel)
      continue
    }
    if (input.base.has(item.rel)) continue
    if (item.state === 'full') {
      const stat = await input.probe.stat(item.rel)
      if (stat === undefined) continue
      newFiles.push({ rel: item.rel, kind: 'created', after: stat })
    } else if (item.state === 'placeholder') {
      // base 不存在却是 placeholder：投影异常；不把它当作用户创建。
      unchanged.push(item.rel)
    }
  }
  created.push(...newFiles.sort((a, b) => compareRel(a.rel, b.rel)))

  const dirsDeleted: string[] = []
  for (const entry of baseDirs) {
    if (seenDirs.has(entry.rel)) continue
    const ancestor = await parentState(entry.rel)
    const state = await stateOf(entry.rel)
    if (ancestor === 'tombstone' || state === 'tombstone') {
      dirsDeleted.push(entry.rel)
    } else if (state === 'absent') {
      // 目录缺失且没有 tombstone：与文件同口径，按 corruption 处理，不当作删除。
      corrupted.push(entry.rel)
    }
  }

  return {
    created,
    modified,
    deleted,
    unchanged,
    corrupted,
    dirsCreated: [...dirsCreated].sort(compareRel),
    dirsDeleted: dirsDeleted.sort(compareRel),
  }
}

async function isContentChanged(
  base: ViewManifestEntry,
  stat: ViewStat,
  probe: ViewProbe,
  maxHashBytes: number,
): Promise<{ changed: boolean; unverified: boolean }> {
  if (base.size !== stat.size) return { changed: true, unverified: false }
  if (base.hash !== undefined && stat.hash !== undefined) {
    return { changed: base.hash.toLowerCase() !== stat.hash.toLowerCase(), unverified: false }
  }
  if (base.mtimeMs !== 0 && stat.mtimeMs !== 0 && base.mtimeMs === stat.mtimeMs) {
    return { changed: false, unverified: true }
  }
  if (probe.read !== undefined && stat.size <= maxHashBytes) {
    const buffer = await probe.read(base.rel)
    const hash = hashBuffer(buffer)
    return { changed: base.hash === undefined || hash !== base.hash.toLowerCase(), unverified: false }
  }
  // 没有可靠哈希来源：size/mtime 不同即视为修改，但标记 unverified（发布前需复核）。
  return { changed: base.size !== stat.size || base.mtimeMs !== stat.mtimeMs, unverified: true }
}

interface WalkItem {
  rel: string
  state: ViewEntryState
  isDirectory: boolean
}

async function walkView(
  probe: ViewProbe,
  rel: string,
  dirs: Set<string>,
  visited: Set<string>,
): Promise<WalkItem[]> {
  const normalized = rel.length === 0 ? '' : normalizeRelativeWin32Path(rel)
  if (visited.has(normalized)) return []
  visited.add(normalized)
  if (normalized.length > 0) dirs.add(normalized)
  const listed = await probe.list(normalized)
  const items: WalkItem[] = []
  for (const entry of listed) {
    if (entry.state === 'tombstone' || entry.state === 'absent') continue
    const childRel = normalized.length === 0 ? entry.name : `${normalized}\\${entry.name}`
    const childNorm = normalizeRelativeWin32Path(childRel)
    items.push({ rel: childNorm, state: entry.state, isDirectory: entry.isDirectory })
    if (entry.isDirectory) {
      items.push(...(await walkView(probe, childNorm, dirs, visited)))
    }
  }
  return items
}

function compareRel(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 内存视图（测试/本地演练）。
 *
 * 语义与 ProjFS 对齐：placeholder 读 data（若无 data 则用 lower 内容），
 * full 读 data，tombstone 隐藏，absent 表示没有条目。
 */
export class MemoryViewProbe implements ViewProbe {
  private readonly entries = new Map<string, MemoryEntry>()

  constructor(initial?: ReadonlyArray<MemoryEntry>) {
    if (initial !== undefined) {
      for (const entry of initial) this.set(entry)
    }
  }

  set(entry: MemoryEntry): this {
    const rel = normalizeRelativeWin32Path(entry.rel)
    if (rel.length === 0) throw new NtError('NT_UNSUPPORTED_PATH', { reason: 'view root entry is not allowed' })
    this.entries.set(rel, {
      rel,
      state: entry.state,
      isDirectory: entry.isDirectory === true,
      data: entry.data,
      size: entry.size ?? entry.data?.length ?? 0,
      mtimeMs: entry.mtimeMs ?? 0,
      hash: entry.hash,
    })
    return this
  }

  setFile(rel: string, data: Buffer, options: { state?: 'full' | 'placeholder'; mtimeMs?: number } = {}): this {
    return this.set({
      rel,
      state: options.state ?? 'full',
      isDirectory: false,
      data,
      mtimeMs: options.mtimeMs ?? 0,
    })
  }

  setPlaceholder(rel: string, data: Buffer, mtimeMs = 0): this {
    return this.set({ rel, state: 'placeholder', isDirectory: false, data, mtimeMs })
  }

  setTombstone(rel: string): this {
    return this.set({ rel, state: 'tombstone', isDirectory: false, size: 0, mtimeMs: 0 })
  }

  setDir(rel: string, state: 'full' | 'placeholder' = 'full'): this {
    return this.set({ rel, state, isDirectory: true, size: 0, mtimeMs: 0 })
  }

  async state(rel: string): Promise<ViewEntryState> {
    return this.entries.get(normalizeRelativeWin32Path(rel))?.state ?? 'absent'
  }

  async stat(rel: string): Promise<ViewStat | undefined> {
    const entry = this.entries.get(normalizeRelativeWin32Path(rel))
    if (entry === undefined || entry.state === 'absent') return undefined
    return {
      state: entry.state,
      isDirectory: entry.isDirectory,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      hash: entry.hash ?? (entry.data === undefined ? undefined : hashBuffer(entry.data)),
    }
  }

  async list(rel: string): Promise<readonly ViewDirEntry[]> {
    const normalized = rel.length === 0 ? '' : normalizeRelativeWin32Path(rel)
    const prefix = normalized.length === 0 ? '' : `${normalized}\\`
    const out: ViewDirEntry[] = []
    for (const [childRel, entry] of this.entries) {
      if (childRel === normalized) continue
      if (!childRel.startsWith(prefix)) continue
      const rest = childRel.slice(prefix.length)
      if (rest.includes('\\')) continue
      if (entry.state === 'tombstone') continue
      out.push({
        name: rest,
        state: entry.state,
        isDirectory: entry.isDirectory,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        hash: entry.hash,
      })
    }
    return out.sort((a, b) => compareRel(a.name, b.name))
  }

  async read(rel: string): Promise<Buffer> {
    const entry = this.entries.get(normalizeRelativeWin32Path(rel))
    if (entry === undefined || entry.data === undefined) {
      throw new NtError('NT_VIEW_UNAVAILABLE', { reason: 'no data for view entry', rel })
    }
    return entry.data
  }
}

/** 内存视图条目。 */
export interface MemoryEntry {
  rel: string
  state: 'placeholder' | 'full' | 'tombstone' | 'absent'
  isDirectory?: boolean
  data?: Buffer
  size?: number
  mtimeMs?: number
  hash?: string
}
