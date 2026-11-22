/**
 * CAS 发布的 manifest 契约与纯函数预检。
 *
 * apply helper 只做文件复制/替换/删除；真正的“能不能写”在写入前由这里判定：
 *   · 每个 change 的 before/after 哈希必须齐全且合法；
 *   · 当前真实文件哈希必须等于 `expectedBase`，否则整批零写（`NT_APPLY_CONFLICT`）；
 *   · 路径只能是工作区内的规范化相对路径；ADS/设备/UNC/`..` 一律拒绝；
 *   · created 不应出现在 expectedBase；modified/deleted 必须出现在 expectedBase。
 *
 * 本模块不碰磁盘；测试用 `current` 回调模拟真实文件哈希。
 *
 * @module winstage-sandbox/nt/apply-manifest
 */

import { isPathInside, normalizeRelativeWin32Path, normalizeWin32Path } from './paths.ts'
import { NtError } from './types.ts'

export type ApplyChangeKind = 'created' | 'modified' | 'deleted'

export interface ApplyChange {
  /** 工作区相对路径（规范化后小写、反斜杠）。 */
  rel: string
  kind: ApplyChangeKind
  /** modified/deleted 的基线哈希；created 不需要。 */
  beforeSha256?: string
  /** created/modified 的新内容哈希。 */
  afterSha256?: string
  /** created/modified 的 CAS blob 绝对路径；deleted 不需要。 */
  afterBlob?: string
  /** 可选 POSIX 模式/属性提示；不参与安全判定。 */
  mode?: number
}

export interface ApplyManifest {
  /** 真实工作区绝对路径。 */
  workspaceRoot: string
  /** 候选 id；用于 journal/undo 命名。 */
  candidateId: string
  /** 基线：工作区相对路径 → SHA-256。 */
  expectedBase: Record<string, string>
  changes: ApplyChange[]
}

export interface ApplyConflict {
  rel: string
  expected?: string
  actual?: string
}

export interface ApplyPlan {
  manifest: ApplyManifest
  /** 写入项（created/modified），父目录浅的先写。 */
  writes: ApplyChange[]
  /** 删除项，子路径深的先删。 */
  deletes: ApplyChange[]
}

export interface ValidateApplyManifestOptions {
  /** CAS blob 根；提供时 afterBlob 必须位于其内。 */
  blobRoot?: string
}

/** 校验并规范化 manifest；失败抛 `NT_APPLY_DENIED`（数据非法，不是冲突）。 */
export function validateApplyManifest(manifest: ApplyManifest, options: ValidateApplyManifestOptions = {}): ApplyManifest {
  if (manifest === null || typeof manifest !== 'object') {
    throw new NtError('NT_APPLY_DENIED', { reason: 'manifest must be an object' })
  }
  const workspaceRoot = normalizeWin32Path(manifest.workspaceRoot)
  if (typeof manifest.candidateId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(manifest.candidateId)) {
    throw new NtError('NT_APPLY_DENIED', { reason: 'candidateId must match [A-Za-z0-9._-]+' })
  }
  if (manifest.expectedBase === null || typeof manifest.expectedBase !== 'object' || Array.isArray(manifest.expectedBase)) {
    throw new NtError('NT_APPLY_DENIED', { reason: 'expectedBase must be an object' })
  }
  if (!Array.isArray(manifest.changes) || manifest.changes.length === 0) {
    throw new NtError('NT_APPLY_DENIED', { reason: 'changes must be a non-empty array' })
  }

  const expectedBase: Record<string, string> = {}
  for (const [rawRel, hash] of Object.entries(manifest.expectedBase)) {
    const rel = normalizeRel(rawRel)
    validateSha256(hash, `expectedBase[${rawRel}]`)
    if (Object.prototype.hasOwnProperty.call(expectedBase, rel)) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'duplicate expectedBase path after normalization', rel })
    }
    expectedBase[rel] = hash.toLowerCase()
  }

  const seen = new Set<string>()
  const changes: ApplyChange[] = manifest.changes.map((change, index) => {
    const at = `changes[${index}]`
    if (change === null || typeof change !== 'object') {
      throw new NtError('NT_APPLY_DENIED', { reason: `${at} must be an object` })
    }
    const rel = normalizeRel(change.rel)
    if (seen.has(rel)) throw new NtError('NT_APPLY_DENIED', { reason: 'duplicate change path', rel })
    seen.add(rel)
    if (change.kind !== 'created' && change.kind !== 'modified' && change.kind !== 'deleted') {
      throw new NtError('NT_APPLY_DENIED', { reason: `${at}.kind must be created/modified/deleted` })
    }
    const inBase = Object.prototype.hasOwnProperty.call(expectedBase, rel)
    if (change.kind === 'created' && inBase) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'created path is already in expectedBase; use modified', rel })
    }
    if ((change.kind === 'modified' || change.kind === 'deleted') && !inBase) {
      throw new NtError('NT_APPLY_DENIED', { reason: `${change.kind} path is missing from expectedBase`, rel })
    }
    if (change.kind === 'created' || change.kind === 'modified') {
      validateSha256(change.afterSha256, `${at}.afterSha256`)
      if (typeof change.afterBlob !== 'string' || change.afterBlob.length === 0) {
        throw new NtError('NT_APPLY_DENIED', { reason: `${at}.afterBlob is required` })
      }
      const blob = normalizeWin32Path(change.afterBlob)
      if (options.blobRoot !== undefined) {
        const blobRoot = normalizeWin32Path(options.blobRoot)
        if (!isPathInside(blob, blobRoot)) {
          throw new NtError('NT_APPLY_DENIED', { reason: 'afterBlob must be inside blobRoot', rel, blob, blobRoot })
        }
      }
      if (change.kind === 'modified') validateSha256(change.beforeSha256, `${at}.beforeSha256`)
    }
    if (change.kind === 'deleted') {
      validateSha256(change.beforeSha256, `${at}.beforeSha256`)
      if (change.afterSha256 !== undefined || change.afterBlob !== undefined) {
        throw new NtError('NT_APPLY_DENIED', { reason: 'deleted must not carry afterSha256/afterBlob', rel })
      }
    }
    if (change.mode !== undefined && (!Number.isInteger(change.mode) || change.mode < 0)) {
      throw new NtError('NT_APPLY_DENIED', { reason: `${at}.mode must be a non-negative integer` })
    }
    return {
      ...change,
      rel,
      beforeSha256: change.beforeSha256?.toLowerCase(),
      afterSha256: change.afterSha256?.toLowerCase(),
      afterBlob: change.afterBlob === undefined ? undefined : normalizeWin32Path(change.afterBlob),
    }
  })

  return { workspaceRoot, candidateId: manifest.candidateId, expectedBase, changes }
}

/**
 * 预检当前真实文件并生成写入计划。
 *
 * @param manifest - 已校验/待校验 manifest
 * @param current - 返回路径当前 SHA-256；不存在返回 undefined
 * @param options - blobRoot 等
 * @throws `NT_APPLY_CONFLICT`（整批零写）、`NT_APPLY_DENIED`（manifest 非法）
 */
export function planApply(
  manifest: ApplyManifest,
  current: (rel: string) => string | undefined,
  options: ValidateApplyManifestOptions = {},
): ApplyPlan {
  const normalized = validateApplyManifest(manifest, options)
  const conflicts: ApplyConflict[] = []
  for (const change of normalized.changes) {
    const expected = normalized.expectedBase[change.rel]
    const actual = current(change.rel)?.toLowerCase()
    if (expected !== actual) {
      conflicts.push({ rel: change.rel, expected, actual })
    }
  }
  if (conflicts.length > 0) {
    throw new NtError('NT_APPLY_CONFLICT', { conflicts, zeroWrite: true })
  }
  const writes = normalized.changes
    .filter((change) => change.kind === 'created' || change.kind === 'modified')
    .sort((a, b) => depth(a.rel) - depth(b.rel) || compare(a.rel, b.rel))
  const deletes = normalized.changes
    .filter((change) => change.kind === 'deleted')
    .sort((a, b) => depth(b.rel) - depth(a.rel) || compare(a.rel, b.rel))
  return { manifest: normalized, writes, deletes }
}

/** 路径深度（`a` = 1，`a\b` = 2）。 */
export function pathDepth(rel: string): number {
  return depth(normalizeRelativeWin32Path(rel))
}

function depth(rel: string): number {
  return rel.length === 0 ? 0 : rel.split('\\').length
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function normalizeRel(value: string): string {
  const rel = normalizeRelativeWin32Path(value)
  if (rel.length === 0) throw new NtError('NT_APPLY_DENIED', { reason: 'path must not be the workspace root' })
  return rel
}

function validateSha256(value: unknown, where: string): void {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new NtError('NT_APPLY_DENIED', { reason: `${where} must be 64 hex chars` })
  }
}
