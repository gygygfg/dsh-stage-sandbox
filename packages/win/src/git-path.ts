/**
 * `.git` 内部路径的分类与发布顺序。
 *
 * 为什么需要这一层（真实边界，不是理论洁癖）
 * -----------------------------------------
 * `.git` 不是普通目录，而是一个「索引 ↔ 对象库 ↔ 指针」强耦合的数据库：
 * index 里只存 blob 哈希，真正的内容在 `objects/**`。逐文件、任意顺序地把
 * 候选写回真实仓库会出现两种损坏：
 *
 *   · **悬空引用**：先写 `index`/`refs`、后写（或永远没写）`objects` ⇒
 *     `fatal: unable to read <oid>`，仓库直接不可用；
 *   · **半截原子操作**：`git commit` 同时改 index + refs + logs，只应用一半会
 *     让 `HEAD` 与工作区、reflog 三者互相矛盾。
 *
 * 因此这里把 NeoAI 的分类口径（`runtime.git_path_class` + `candidate._apply_order`）
 * 移植到 Windows 侧，并把「永不发布」做成结构判定而不是文本提醒：
 *
 * | 类 | 路径 | 发布策略 |
 * |---|---|---|
 * | `object`   | `.git/objects/**` | 先写（内容寻址、不可变、幂等可累加） |
 * | `pointer`  | index / HEAD / refs / logs / packed-refs / worktrees | 最后写 |
 * | `transient`| `*.lock` / `gc.log` | **不发布**（锁与日志不是状态） |
 * | `other`    | config / hooks / info / modules / description | **永不发布**（`SANDBOX_GIT_INTERNAL`） |
 *
 * 最后一类是安全边界的关键：钩子在用户下一次 `commit` 时执行、`config` 能指定
 * `core.hooksPath`/`core.pager`（任意命令执行），它们一旦可发布，就等于把
 * 「暂存 → 审批」这层保护让给了载荷。NeoAI 把这些归入 `other` 并拒绝整单，
 * 本模块保持同一语义。
 *
 * 与 NeoAI 的一处**有意偏差**：`objects/**` 在本实现里位于真实盘（junction），
 * 不在候选里（见 `src/workspace.ts::materializeGitControlDir` 的注释）。分类与
 * 排序仍按上表实现，于是即使将来把对象库也纳入暂存，发布顺序与闸门不用改。
 *
 * @module winstage-sandbox/git-path
 */

/** `.git` 内部条目的发布类别。 */
export type GitPathClass = 'object' | 'pointer' | 'transient' | 'other'

/** 40/64 位十六进制对象名（SHA-1 / SHA-256 仓库）。 */
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/** 固定名的指针文件（小写比较；Windows 路径大小写不敏感）。 */
const POINTER_FILES: ReadonlySet<string> = new Set([
  'index',
  'head',
  'packed-refs',
  'orig_head',
  'merge_head',
  'cherry_pick_head',
  'revert_head',
  'fetch_head',
  'commit_editmsg',
  'merge_msg',
  'auto_merge',
  // 浅克隆的边界与 worktree 的公共目录指针：小而可变，属于状态（不是行为配置）。
  'shallow',
  'commondir',
])

/** 指针目录（其下全部是可变指针）。 */
const POINTER_DIRS: readonly string[] = ['refs/', 'logs/', 'worktrees/']

/** 临时文件：锁、gc 日志。它们不是状态，绝不发布。 */
const TRANSIENT_SUFFIX = '.lock'

/**
 * 把 Windows 或 POSIX 路径切成段，忽略空段。
 * @param path - 任意绝对/相对路径。
 * @returns 段数组（保留原大小写）。
 */
export function splitPathSegments(path: string): string[] {
  return String(path ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0)
}

/**
 * 找到路径里**最后一个** `.git` 段的下标。
 *
 * 取最后一个而不是第一个：嵌套仓库（`vendor/lib/.git/index`）属于内层仓库，
 * 分类必须按内层的相对路径算，否则会把 `vendor/lib/.git/index` 误当成外层指针。
 * 若 `.git` 出现在末段（`.git` 目录/文件本身），返回 `-1`——它不是内部路径。
 * @param segments - 路径段。
 * @returns `.git` 的下标，或 `-1`。
 */
export function gitSegmentIndex(segments: readonly string[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (String(segments[index]).toLowerCase() === '.git') {
      // 末段是 `.git` 本身 ⇒ 不是「内部路径」（工作树的 `.git` 是普通文件）。
      return index === segments.length - 1 ? -1 : index
    }
  }
  return -1
}

/**
 * 分类一个 `.git` 内部路径。
 * @param path - 逻辑路径（工作区相对或绝对，`/` 或 `\` 均可）。
 * @returns 类别；不是 `.git` 内部路径时返回 `undefined`。
 */
export function gitPathClass(path: string): GitPathClass | undefined {
  const segments = splitPathSegments(path)
  const at = gitSegmentIndex(segments)
  if (at < 0) return undefined
  const rel = segments.slice(at + 1).map((segment) => segment.toLowerCase())
  if (rel.length === 0) return 'other'
  const first = rel[0]
  const joined = `${rel.join('/')}${rel.length === 1 ? '' : '/'}`

  if (joined.endsWith(TRANSIENT_SUFFIX) || first === 'gc.log' || first === 'index.lock') return 'transient'
  if (POINTER_FILES.has(first)) return 'pointer'
  if (POINTER_DIRS.some((dir) => joined.startsWith(dir))) return 'pointer'
  if (first === 'objects') return 'object'
  /*
   * `config` / `hooks/` / `info/` / `modules/`（子模块） / `description` /
   * `config.worktree` 等一律 `other`：它们的共同点是「能改变 git 的行为」而不只是
   * 「记录状态」，因此宁可整单拒绝，也不允许它们进入候选。
   */
  return 'other'
}

/**
 * 是否属于 `.git` 内部（任何类别）。
 * @param path - 逻辑路径。
 * @returns `.git` 内部为 `true`。
 */
export function isGitControlPath(path: string): boolean {
  return gitPathClass(path) !== undefined
}

/**
 * 是否允许发布（`object` / `pointer`）。`transient` / `other` 永远为 `false`。
 * @param path - 逻辑路径。
 * @returns 允许发布为 `true`；不是 `.git` 内部路径时也返回 `true`（不由本模块管辖）。
 */
export function isGitPublishable(path: string): boolean {
  const kind = gitPathClass(path)
  return kind === undefined || kind === 'object' || kind === 'pointer'
}

/**
 * 发布排序位次：对象 0 → 普通文件 1 → 指针 2；禁止发布 -1。
 *
 * 排序的语义不是「好看」，而是**先后依赖**：任何被写入的 index/refs 所引用的
 * 对象必须已经存在，否则下一次 `git status` 就会报悬空引用。
 * @param path - 逻辑路径。
 * @returns 位次。
 */
export function gitApplyRank(path: string): number {
  const kind = gitPathClass(path)
  if (kind === 'object') return 0
  if (kind === 'pointer') return 2
  if (kind === 'transient' || kind === 'other') return -1
  return 1
}

/**
 * 按「对象 → 普通 → 指针」稳定排序（同档按路径字典序，保证可复现）。
 * @param changes - 带 `path` 的变更列表。
 * @returns 新数组（不修改入参）。
 */
export function orderForApply<T extends { path: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((left, right) => {
    const rank = gitApplyRank(left.path) - gitApplyRank(right.path)
    if (rank !== 0) return rank
    return String(left.path) < String(right.path) ? -1 : String(left.path) > String(right.path) ? 1 : 0
  })
}

/**
 * 解析仓库根：路径里最后一个 `.git` 之前的部分。
 *
 * 返回**逻辑路径**（保留调用方给出的分隔符形态），供调用方拼 `.git` 目录。
 * @param path - 逻辑路径（工作区相对或绝对）。
 * @returns 仓库根（可能为空串，表示工作区根就是仓库根）；不是 `.git` 内部路径时为 `undefined`。
 */
export function gitRepoRootOf(path: string): string | undefined {
  const raw = String(path ?? '').replaceAll('\\', '/')
  const segments = splitPathSegments(raw)
  const at = gitSegmentIndex(segments)
  if (at < 0) return undefined
  const head = segments.slice(0, at)
  if (head.length === 0) {
    if (raw.startsWith('//')) return '//'
    return raw.startsWith('/') ? '/' : ''
  }
  // 盘符（`C:`）保持原样，不再补前导 `/`——否则会得到 `/C:/repo` 这种不可用的根。
  if (/^[A-Za-z]:$/.test(head[0])) return head.join('/')
  if (raw.startsWith('//')) return `//${head.join('/')}`
  if (raw.startsWith('/')) return `/${head.join('/')}`
  return head.join('/')
}

/**
 * 危险 git 子命令（**会破坏对象库或仓库结构**的那一小撮）。
 *
 * 与 NeoAI 的差异：NeoAI 拒绝**全部**变更子命令、只允许专用 git 工具；本项目的
 * agent 直接跑 `git add/commit`，一刀切会打断正常开发。因此只拒绝真正不可逆的
 * 对象库操作，其余交给「暂存 + 发布闸门」。取舍写在 `docs/GIT-暂存与完整性.md`。
 */
const DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'gc',
  'prune',
  'prune-packed',
  'repack',
  'maintenance',
  'filter-branch',
  'filter-repo',
])

/** 需要跟一个独立取值的 git 全局选项（跳过其值，才能找到真正的子命令）。 */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
])

/**
 * 从一段命令行文本里找出**破坏性 git 子命令**。
 *
 * 覆盖的写法：`git gc`、`git.exe prune`、`git -C repo gc`、`git -c k=v repack`、
 * `cmd /c "git gc"`、`powershell -Command "git gc"`（同一 token 流里出现即算）。
 * 只读子命令（`git status`/`log`/`cat-file`…）不命中。
 *
 * @param commandLine - 单条命令的拼接文本（不含 shell 分隔符语义）。
 * @returns 命中的子命令与原因；未命中返回 `undefined`。
 */
export function findDestructiveGitCommand(
  commandLine: string,
): { subcommand: string; reason: string } | undefined {
  /*
   * 解释器载荷（`cmd /c "git gc"`、`powershell -Command "git prune"`）在第一次分词后
   * 仍然是一整个 token（引号里去掉了）。只对**紧跟解释器标志**的那个 token 展开一层，
   * 否则 `echo "git gc"` 这种"只是打印字符串"的写法会被误拒。
   */
  const tokens = expandNestedTokens(tokenize(commandLine))
  for (let index = 0; index < tokens.length; index += 1) {
    if (baseName(tokens[index]) !== 'git' && baseName(tokens[index]) !== 'git.exe') continue
    let cursor = index + 1
    while (cursor < tokens.length) {
      const token = tokens[cursor]
      if (token === '--') {
        cursor += 1
        continue
      }
      if (GIT_VALUE_OPTIONS.has(token)) {
        cursor += 2
        continue
      }
      if (/^--[^=]+=/.test(token)) {
        cursor += 1
        continue
      }
      if (/^-[cC]$/.test(token)) {
        cursor += 2
        continue
      }
      if (token.startsWith('-')) {
        cursor += 1
        continue
      }
      const subcommand = token.toLowerCase()
      if (DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) {
        return {
          subcommand,
          reason:
            `git ${subcommand} 会改写/删除对象库或仓库结构（gc/prune/repack 会删对象，`
            + 'filter-branch 会重写历史），暂存层无法安全回滚；请在宿主上执行',
        }
      }
      break
    }
  }
  return undefined
}

/**
 * 极简分词（与 `src/executor.ts::tokenizeCommandLine` 同口径）。
 * 本地复制而不是 import，避免 executor ↔ git-path 的循环依赖。
 * @param text - 命令文本。
 * @returns token 数组。
 */
function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(String(text ?? ''))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3])
  }
  return out
}

/**
 * 把「引号里还带着一条命令」的 token 再展开一层。
 *
 * `cmd /c "git gc"` 与 `powershell -Command "git prune"` 在第一次分词后都是单个
 * `git gc` token；不展开就等于对这两种最常见的解释器写法失明。
 * @param tokens - 初次分词结果。
 * @returns 展开后的 token 序列（保留原始 token，随后追加它的子 token）。
 */
/** 解释器里"下一个 token 是脚本正文"的标志。 */
const INLINE_PAYLOAD_FLAGS: ReadonlySet<string> = new Set([
  '/c',
  '/k',
  '-c',
  '-command',
  '/command',
  '-e',
  '--eval',
])

function expandNestedTokens(tokens: readonly string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    out.push(token)
    const previous = index === 0 ? '' : String(tokens[index - 1]).toLowerCase()
    if (!INLINE_PAYLOAD_FLAGS.has(previous)) continue
    if (!/\s/.test(token)) continue
    for (const nested of tokenize(token)) out.push(nested)
  }
  return out
}

/**
 * 取 token 的文件名部分（小写）。
 * @param token - 单个 token。
 * @returns 小写文件名。
 */
function baseName(token: string): string {
  const text = String(token ?? '').toLowerCase()
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return cut >= 0 ? text.slice(cut + 1) : text
}
