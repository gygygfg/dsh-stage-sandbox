/**
 * `.git` 发布前的**引用完整性闸门**（fail-closed）。
 *
 * 要防的失败
 * ----------
 * 候选里可能同时有 `index` / `refs/**` / `objects/**`。如果发布顺序错了、或者对象
 * 被拒绝/漏掉，真实仓库就会进入「索引引用了不存在的 blob」的状态：
 *
 *     $ git status
 *     fatal: unable to read 3f2a9c…        ← 仓库不可用，且不是 git 自己能修的
 *
 * 这种损坏比「少发布一个文件」严重得多：它会让用户的整个工作流停摆，修复需要
 * 手工 `git fsck` / 重建索引。因此发布**指针之前**逐个解析 HEAD、所有 refs、index
 * 里的 blob OID，逐个确认对象存在；缺一个就整单拒绝（一个字节都不写）。
 *
 * 与 NeoAI 的 `GIT_REFERENTIAL_INTEGRITY` 闸门同源（`candidate.lua::_git_publish_gate`）。
 *
 * 口径
 * ----
 * 校验的是**应用之后**的状态：候选里出现的 `HEAD`/`refs`/`index` 用候选内容
 * （`readPost`），其余读真实盘。对象按「松散对象 → pack 索引 → alternates → 本批
 * 候选里的对象」四处查。
 *
 * @module winstage-sandbox/git-integrity
 */

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { gitPathClass, splitPathSegments } from './git-path.ts'

/** 一条待发布变更（只用到 `path` 与 `op`）。 */
export interface PendingGitChange {
  /** 逻辑路径（工作区相对或绝对）。 */
  path: string
  /** 操作：create / write / delete / metadata 等；`delete` 视为对象不存在。 */
  op?: string
}

/** 闸门输入。 */
export interface GitIntegrityInput {
  /** 仓库根（绝对路径）；`.git` 在其下。 */
  repoRoot: string
  /** 本批候选变更。 */
  changes: readonly PendingGitChange[]
  /**
   * 读取某个逻辑路径**应用之后**的内容。
   * 未变更的路径应由调用方回落到真实盘读取。
   * @returns 内容；路径在应用后不存在时返回 `undefined`。
   */
  readPost: (logicalPath: string) => Buffer | undefined
}

/**
 * 闸门结果。
 *
 * 用「单一形状 + 可选字段」而不是可辨识联合：本仓 `tsconfig` 关闭了 `strictNullChecks`，
 * 布尔字面量判别在那种配置下不做窄化，联合会让 `result.code` 无法访问。
 */
export interface GitIntegrityResult {
  /** 是否通过。 */
  ok: boolean
  /** 失败码（`ok === false` 时必有）。 */
  code?: string
  /** 失败原因（`ok === false` 时必有）。 */
  reason?: string
}

/** index 解析结果（同上：单一形状，便于在宽松 tsconfig 下访问字段）。 */
export interface IndexParseResult {
  /** 是否解析成功。 */
  ok: boolean
  /** blob OID 列表（成功时）。 */
  oids: string[]
  /** 失败码。 */
  code?: string
  /** 失败原因。 */
  reason?: string
}

/** 允许发布的类别（与 `git-path.ts` 的表一致）。 */
const PUBLISHABLE: ReadonlySet<string> = new Set(['object', 'pointer'])

/**
 * 校验一批候选是否能让真实仓库保持自洽。
 * @param input - 仓库根、候选变更、应用后读取器。
 * @returns `{ ok: true }` 或结构化拒绝。
 */
export function checkGitIntegrity(input: GitIntegrityInput): GitIntegrityResult {
  const gitChanges = input.changes.filter((change) => gitPathClass(change.path) !== undefined)
  if (gitChanges.length === 0) return { ok: true }

  // ① 类别闸门：config/hooks/info/锁 一律不发布（整单拒绝，不做部分写入）。
  for (const change of gitChanges) {
    // 路径穿越：候选来自磁盘/队列（本地可篡改），`..` 会让下面的 join 逃出 .git。
    if (splitPathSegments(change.path).some((segment) => segment === '..')) {
      return { ok: false, code: 'SANDBOX_GIT_INTERNAL', reason: `${String(change.path)} 含 .. 段，拒绝按 .git 路径处理` }
    }
    const kind = gitPathClass(change.path)
    if (kind !== undefined && !PUBLISHABLE.has(kind)) {
      return {
        ok: false,
        code: 'SANDBOX_GIT_INTERNAL',
        reason: `${String(change.path)} 属于 .git 的 ${kind} 类条目（config/hooks/info/锁），暂存层不允许发布`,
      }
    }
    // 删除 HEAD 永远不是一个可用的仓库状态（不是"切到未出生分支"，是仓库损坏）。
    if (change.op === 'delete' && gitRelOf(change.path)?.toLowerCase() === 'head') {
      return { ok: false, code: 'SANDBOX_GIT_INTERNAL', reason: '拒绝删除 .git/HEAD（会留下不可用的仓库）' }
    }
  }

  const gitDir = join(input.repoRoot, '.git')
  let gitDirIsDirectory = false
  try {
    gitDirIsDirectory = existsSync(gitDir) && statSync(gitDir).isDirectory()
  } catch {
    gitDirIsDirectory = false
  }
  if (!gitDirIsDirectory) {
    return {
      ok: false,
      code: 'SANDBOX_GIT_INTERNAL',
      reason: `${gitDir} 不是目录（工作树的 .git 文件暂不支持暂存）`,
    }
  }

  /** `.git` 内的相对路径 → 应用后的内容。 */
  const read = (relInGit: string): Buffer | undefined => input.readPost(join(input.repoRoot, '.git', relInGit))

  const headText = textOf(read('HEAD'))
  const oidLength = detectOidLength(headText) ?? 40
  const packed = parsePackedRefs(textOf(read('packed-refs')))

  /** refs/ 下的名字集合：真实盘 + 本批候选。 */
  const refNames = new Set<string>(listRefNames(join(gitDir, 'refs')))
  for (const change of gitChanges) {
    const rel = gitRelOf(change.path)
    if (rel === undefined) continue
    if (rel.startsWith('refs/') && change.op !== 'delete') refNames.add(rel.slice('refs/'.length))
  }

  /** 解析一个 ref 名到 OID（跟随符号引用，带环检测）。 */
  const readRef = (name: string, seen = new Set<string>()): string | undefined => {
    const key = name.toLowerCase()
    if (seen.has(key)) return undefined
    seen.add(key)
    const raw = textOf(read(name))
    if (raw !== undefined) {
      const trimmed = raw.trim()
      if (trimmed.startsWith('ref:')) return readRef(trimmed.slice(4).trim(), seen)
      if (isOid(trimmed, oidLength)) return trimmed.toLowerCase()
    }
    const packedOid = packed.get(name)
    if (packedOid !== undefined && isOid(packedOid, oidLength)) return packedOid.toLowerCase()
    return undefined
  }

  /** 需要存在对象的引用：HEAD + 所有 refs + index 的 blob。 */
  const references: { oid: string; from: string }[] = []
  const head = headText === undefined ? undefined : headText.trim()
  if (head !== undefined && head.length > 0) {
    if (head.startsWith('ref:')) {
      const oid = readRef(head.slice(4).trim())
      if (oid !== undefined) references.push({ oid, from: 'HEAD' })
    } else if (isOid(head, oidLength)) {
      references.push({ oid: head.toLowerCase(), from: 'HEAD' })
    } else {
      return { ok: false, code: 'GIT_HEAD_CORRUPT', reason: `HEAD 内容无法解析：${head.slice(0, 80)}` }
    }
  }
  // `refNames` 的名字相对 `refs/`（`heads/main`），读取时要补回前缀。
  for (const name of refNames) {
    const oid = readRef(`refs/${name}`)
    if (oid !== undefined) references.push({ oid, from: `refs/${name}` })
  }

  const indexBuffer = read('index')
  if (indexBuffer !== undefined && indexBuffer.length > 0) {
    const parsed = parseIndexBlobOids(indexBuffer, oidLength)
    if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason }
    for (const oid of parsed.oids) references.push({ oid, from: 'index' })
  }

  // ② 对象存在性：本批候选里的对象也算存在（发布顺序保证对象先写）。
  const candidateObjects = new Set<string>()
  for (const change of gitChanges) {
    if (gitPathClass(change.path) !== 'object' || change.op === 'delete') continue
    const rel = gitRelOf(change.path)
    if (rel === undefined) continue
    const parts = rel.split('/')
    // .git/objects/<xx>/<rest> —— gitRelOf 已去掉 `.git`，故是 3 段。
    if (parts.length === 3 && parts[0] === 'objects' && parts[1].length === 2) {
      candidateObjects.add((parts[1] + parts[2]).toLowerCase())
    }
  }

  const store = createObjectStore(gitDir, oidLength)
  for (const reference of references) {
    if (candidateObjects.has(reference.oid)) continue
    if (store.has(reference.oid)) continue
    return {
      ok: false,
      code: 'GIT_REFERENTIAL_INTEGRITY',
      reason: `${reference.from} 引用的对象 ${reference.oid} 不存在；发布它将产生悬空引用（整单拒绝）`,
    }
  }
  return { ok: true }
}

/**
 * 取路径里最后一个 `.git/` 之后的相对路径（`objects/xx/yy`）。
 * @param path - 逻辑路径。
 * @returns 相对路径；不是 `.git` 内部路径时 `undefined`。
 */
export function gitRelOf(path: string): string | undefined {
  const segments = splitPathSegments(path)
  let at = -1
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index].toLowerCase() === '.git') {
      at = index
      break
    }
  }
  if (at < 0) return undefined
  return segments.slice(at + 1).join('/')
}

/**
 * 解析 index v2/v3 的 blob OID 列表。v4（前缀压缩）未支持 ⇒ fail-closed。
 * @param buffer - index 文件内容。
 * @param oidLength - 对象名十六进制长度（40 或 64）。
 * @returns OID 列表或结构化错误。
 */
export function parseIndexBlobOids(
  buffer: Buffer,
  oidLength = 40,
): IndexParseResult {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'DIRC') {
    return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: 'index 缺少 DIRC 头' }
  }
  const version = buffer.readUInt32BE(4)
  if (version === 4) {
    return { ok: false, oids: [], code: 'GIT_INDEX_UNSUPPORTED', reason: 'index v4（路径前缀压缩）暂不支持校验，拒绝发布' }
  }
  if (version !== 2 && version !== 3) {
    return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `index 版本 ${version} 未知` }
  }
  const count = buffer.readUInt32BE(8)
  const oidBytes = oidLength / 2
  const oids: string[] = []
  let position = 12
  for (let entry = 0; entry < count; entry += 1) {
    const start = position
    // 固定头 40 字节（ctime/mtime/dev/ino/mode/uid/gid/size）+ oid + flags
    if (position + 40 + oidBytes + 2 > buffer.length) {
      return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `第 ${entry} 条 entry 越界` }
    }
    const oid = buffer.toString('hex', position + 40, position + 40 + oidBytes)
    oids.push(oid)
    const flags = buffer.readUInt16BE(position + 40 + oidBytes)
    const extended = version >= 3 && (flags & 0x4000) !== 0
    const cursor = position + 40 + oidBytes + 2 + (extended ? 2 : 0)
    const declared = flags & 0x0fff
    let end: number
    if (declared < 0x0fff) {
      end = cursor + declared + 1
    } else {
      let scan = cursor
      while (scan < buffer.length && buffer[scan] !== 0) scan += 1
      end = scan + 1
    }
    if (end > buffer.length) {
      return { ok: false, oids: [], code: 'GIT_INDEX_CORRUPT', reason: `第 ${entry} 条 entry 的路径越界` }
    }
    const entryBytes = end - start
    position = start + Math.ceil(entryBytes / 8) * 8
  }
  return { ok: true, oids }
}

/**
 * 对象库查询器（松散对象 → pack 索引 → alternates）。
 * @param gitDir - `.git` 绝对路径。
 * @param oidLength - 十六进制长度。
 * @returns `{ has(oid) }`。
 */
export function createObjectStore(gitDir: string, oidLength = 40): { has: (oid: string) => boolean } {
  const objectsDir = join(gitDir, 'objects')
  const alternates = readAlternates(objectsDir)
  const packs = new Set<string>()
  let loaded = false

  const loadPacks = (): void => {
    if (loaded) return
    loaded = true
    for (const dir of [objectsDir, ...alternates]) {
      let entries: string[] = []
      try {
        entries = readdirSync(join(dir, 'pack'))
      } catch {
        continue
      }
      for (const name of entries) {
        if (!name.toLowerCase().endsWith('.idx')) continue
        for (const oid of readPackIndexOids(join(dir, 'pack', name), oidLength)) packs.add(oid)
      }
    }
  }

  const hasLoose = (oid: string): boolean => {
    if (oid.length < 3) return false
    for (const dir of [objectsDir, ...alternates]) {
      try {
        if (statSync(join(dir, oid.slice(0, 2), oid.slice(2))).isFile()) return true
      } catch {
        // 继续找下一个对象根
      }
    }
    return false
  }

  return {
    has(oid: string): boolean {
      const normalized = oid.toLowerCase()
      if (hasLoose(normalized)) return true
      loadPacks()
      return packs.has(normalized)
    },
  }
}

/**
 * 读取 pack 索引里的对象名集合（支持 v1/v2）。
 * @param file - `.idx` 路径。
 * @param oidLength - 十六进制长度。
 * @returns 对象名集合；格式不认识时返回空集（调用方会因此判「对象不存在」⇒ fail-closed）。
 */
export function readPackIndexOids(file: string, oidLength = 40): Set<string> {
  const out = new Set<string>()
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return out
  }
  const oidBytes = oidLength / 2
  let count: number
  let tableStart: number
  let entrySize: number
  let oidOffset: number
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xff744f63) {
    if (buffer.readUInt32BE(4) !== 2) return out
    count = buffer.readUInt32BE(8 + 255 * 4)
    tableStart = 8 + 256 * 4
    entrySize = oidBytes
    oidOffset = 0
  } else {
    count = buffer.length >= 256 * 4 ? buffer.readUInt32BE(255 * 4) : 0
    tableStart = 256 * 4
    entrySize = 4 + oidBytes
    oidOffset = 4
  }
  for (let index = 0; index < count; index += 1) {
    const at = tableStart + index * entrySize + oidOffset
    if (at + oidBytes > buffer.length) break
    out.add(buffer.toString('hex', at, at + oidBytes))
  }
  return out
}

/**
 * 读取 `objects/info/alternates`（每行一个对象目录，相对路径相对 objects 目录）。
 * @param objectsDir - 主对象目录。
 * @returns 附加对象目录（最多 8 个）。
 */
export function readAlternates(objectsDir: string): string[] {
  let text: string
  try {
    text = readFileSync(join(objectsDir, 'info', 'alternates'), 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(objectsDir, trimmed)
    if (!out.includes(resolved)) out.push(resolved)
    if (out.length >= 8) break
  }
  return out
}

/**
 * 枚举 `refs/` 下的引用名（相对 `refs/`，例如 `heads/main`）。
 * @param refsDir - `<git>/refs`。
 * @returns 引用名集合；目录不存在时为空。
 */
export function listRefNames(refsDir: string): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 16) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      let info
      try {
        info = lstatSync(abs)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        walk(abs, name, depth + 1)
        continue
      }
      if (info.isFile()) out.add(name)
    }
  }
  walk(refsDir, '', 0)
  return out
}

/**
 * 解析 `packed-refs` 文本。
 * @param text - 文件内容（可为 `undefined`）。
 * @returns ref 名 → OID。
 */
export function parsePackedRefs(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (text === undefined) return out
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue
    const match = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line)
    if (match === null) continue
    out.set(match[2], match[1].toLowerCase())
  }
  return out
}

/**
 * 按内容判断对象名长度（HEAD 指向的 OID）。
 * @param text - 文本。
 * @returns 40 或 64；判断不出时 `undefined`。
 */
export function detectOidLength(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  if (trimmed.startsWith('ref:')) return undefined
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return 64
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return 40
  return undefined
}

/**
 * 判断字符串是否是一个合法的对象名。
 * @param value - 候选字符串。
 * @param oidLength - 期望长度。
 * @returns 合法为 `true`。
 */
export function isOid(value: string, oidLength: number): boolean {
  return new RegExp(`^[0-9a-f]{${oidLength}}$`, 'i').test(value)
}

/**
 * Buffer → 文本。
 * @param buffer - 内容。
 * @returns 文本；`undefined` 原样返回。
 */
function textOf(buffer: Buffer | undefined): string | undefined {
  return buffer === undefined ? undefined : buffer.toString('utf8')
}
