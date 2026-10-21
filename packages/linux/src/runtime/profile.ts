/**
 * The bwrap profile builder: compose a hardened mount/namespace profile from a
 * file-effect policy plus {@link RuntimeOptions}. Unlike the legacy
 * `--ro-bind / /` profile, the host root is NOT broadly exposed — only an
 * explicit read-only whitelist plus masked secrets, a fresh `/proc`, and the
 * policy's writable surface. Globs and existence are injected so the builder
 * is a pure, testable function.
 *
 * Ported from `NeoAI/lua/NeoAI/sandbox/runtime.lua` (`_append_readonly_mounts`,
 * `_masked_paths`, `_append_proc_sys_ro`).
 * @module dsh-sandbox-linux/runtime/profile
 */

import * as nodeFs from 'node:fs'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { DEFAULT_RUNTIME_OPTIONS, type RuntimeOptions } from './options.ts'
import { networkArgs } from './network.ts'

/** One extra mount an overlay command needs (e.g. a materialize inbox). */
export interface OverlayBind {
  /** The host source path. */
  readonly src: string
  /** The path inside the sandbox. */
  readonly dest: string
  /** Mount read-only (defaults to read-write). */
  readonly readOnly?: boolean
}

/** An overlay writable layer for the policy's workspace root. */
export interface OverlaySpec {
  /** The host directory writes land in (the overlay upper). */
  readonly upper: string
  /** An empty host directory on the same filesystem as {@link upper}. */
  readonly work: string
  /** Extra binds the command needs beyond the standard profile. */
  readonly binds?: readonly OverlayBind[]
}

/** The filesystem facts the profile builder consults (injected for tests). */
export interface ProfileIo {
  /** Whether a path exists. */
  exists(path: string): boolean
  /** Whether a path is a directory. */
  isDirectory(path: string): boolean
  /** Expand a glob pattern to concrete paths (empty when unsupported/missing). */
  glob(pattern: string): string[]
}

/**
 * The filesystem operations the glob helper needs, injected so the Node 20
 * fallback is a pure function under test.
 *
 * `fs.globSync` exists only from Node 22.0.0. Importing it as a named binding
 * (`import { globSync } from 'node:fs'`) makes the module fail to LINK on
 * Node 20 before any fallback can run, so this module uses a namespace import
 * and feature detection instead.
 */
export interface GlobFileSystem {
  /** Node >=22's `fs.globSync`; `undefined` on Node 20. */
  readonly globSync?: (pattern: string) => string[]
  /** `fs.readdirSync(path)`; consulted only when {@link GlobFileSystem.globSync} is absent. */
  readonly readdirSync?: (path: string) => readonly string[] | undefined
}

/** A path segment containing glob magic (`*`, `?`, `[`). */
const GLOB_MAGIC = /[*?[]/u

/**
 * Glob syntax the fallback deliberately does not implement: `**` (recursive),
 * braces, escapes, and extended globs. Returning `[]` for these matches the
 * historical {@link ProfileIo.glob} contract ("empty when unsupported") and
 * keeps the fallback small; the hardened defaults and documented options only
 * use single-segment `*` / `?` / `[...]`.
 */
const UNSUPPORTED_GLOB_SYNTAX = /[\\{}()|]/u

/** Escape one literal character for a `RegExp` source. */
function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character
}

/**
 * Compile one path-segment glob into a predicate on directory entry names.
 * Supports `*`, `?`, and `[...]` (with `!`/`^` negation); a pattern never
 * matches across `/`, and case sensitivity follows the host filesystem.
 * @param segment - one globbed path segment (a directory entry name pattern).
 * @returns whether a directory entry name matches that segment.
 */
export function segmentGlobMatcher(segment: string): (name: string) => boolean {
  let source = '^'
  let index = 0
  while (index < segment.length) {
    const character = segment.charAt(index)
    if (character === '*') {
      source += '[^/]*'
      index += 1
      continue
    }
    if (character === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (character === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close <= index + 1) {
        source += '\\['
        index += 1
        continue
      }
      const raw = segment.slice(index + 1, close)
      const body = raw.startsWith('!') || raw.startsWith('^') ? `^${raw.slice(1)}` : raw
      source += `[${body.replace(/\\/gu, '\\\\')}]`
      index = close + 1
      continue
    }
    source += escapeRegexCharacter(character)
    index += 1
  }
  const matcher = new RegExp(`${source}$`, 'u')
  return name => matcher.test(name)
}

/** Read one directory, mapping unreadable/vanished directories to `undefined`. */
function readDirectory(
  path: string,
  readdir: (path: string) => readonly string[] | undefined,
): readonly string[] | undefined {
  try {
    return readdir(path)
  } catch {
    return undefined
  }
}

/**
 * Node 20 fallback for {@link globPaths}: a readdir walk over the pattern's
 * path segments.
 *
 * Supported: absolute POSIX patterns whose magic stays inside single segments
 * (`*`, `?`, `[...]`), which covers every hardened default: suffix globs such
 * as `/etc/python3*`, middle wildcards such as the per-home `.ssh` masks, and
 * `/root/.cache/keyring-*`.
 * Unsupported syntax (`**`, braces, escapes, extended globs), relative
 * patterns, and `.`/`..` segments yield `[]` — never a partial guess. As with
 * minimatch's default, a wildcard does not match a leading `.`.
 *
 * @param pattern - the configured glob.
 * @param readdir - directory listing (entry names), `undefined` when unreadable.
 * @returns concrete matching paths, sorted and deduplicated; `[]` otherwise.
 */
export function expandSimpleGlob(pattern: string, readdir: (path: string) => readonly string[] | undefined): string[] {
  if (typeof pattern !== 'string' || !pattern.startsWith('/')) return []
  if (pattern.includes('**') || UNSUPPORTED_GLOB_SYNTAX.test(pattern)) return []
  const trimmed = pattern.replace(/\/+$/u, '')
  if (trimmed === '') return []
  const segments = trimmed.split('/').slice(1)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return []
  let current: string[] = ['']
  for (const segment of segments) {
    const next: string[] = []
    if (!GLOB_MAGIC.test(segment)) {
      for (const base of current) next.push(`${base}/${segment}`)
    } else {
      const matches = segmentGlobMatcher(segment)
      const wantsDot = segment.startsWith('.')
      for (const base of current) {
        const entries = readDirectory(base === '' ? '/' : base, readdir)
        if (entries === undefined) continue
        for (const entry of entries) {
          if (entry === '' || entry === '.' || entry === '..') continue
          if (!wantsDot && entry.startsWith('.')) continue
          if (!matches(entry)) continue
          next.push(`${base}/${entry}`)
        }
      }
    }
    current = next
    if (current.length === 0) return []
  }
  return [...new Set(current)].sort()
}

/**
 * Expand a glob through the injected filesystem: the native `fs.globSync` on
 * Node >=22, the readdir fallback on Node 20. Never throws.
 * @param pattern - the configured glob.
 * @param fs - the filesystem operations to use.
 * @returns concrete matching paths; `[]` when unsupported, missing, or on error.
 */
export function globPaths(pattern: string, fs: GlobFileSystem): string[] {
  if (typeof fs.globSync === 'function') {
    try {
      return fs.globSync(pattern)
    } catch {
      return []
    }
  }
  try {
    return expandSimpleGlob(pattern, path => (typeof fs.readdirSync === 'function' ? fs.readdirSync(path) : undefined))
  } catch {
    return []
  }
}

/**
 * The real filesystem as {@link GlobFileSystem}. The cast is deliberate:
 * `@types/node` is compiled against Node 24 and types `globSync` as always
 * present, while Node 20's runtime namespace has no such export; `globPaths`
 * feature-detects it.
 */
const nodeGlobFileSystem = nodeFs as unknown as GlobFileSystem

/** The default IO over the real filesystem. */
export const nodeProfileIo: ProfileIo = {
  exists: path => nodeFs.existsSync(path),
  isDirectory: path => {
    try {
      return nodeFs.statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  glob: pattern => globPaths(pattern, nodeGlobFileSystem),
}

/** Whether a configured path is a glob pattern. */
function isGlob(path: string): boolean {
  return GLOB_MAGIC.test(path)
}

/** Expand a config list to existing concrete paths, deduplicated (globs expanded). */
function expand(paths: readonly string[], io: ProfileIo): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (path: string): void => {
    if (path === '' || path === '/') return
    const normalized = path.replace(/\/+$/u, '') || '/'
    if (normalized === '/' || seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }
  for (const path of paths) {
    if (isGlob(path)) {
      for (const match of io.glob(path)) add(match)
    } else {
      add(path)
    }
  }
  return out
}

/**
 * Append a mask for one path: a directory becomes an empty tmpfs, a
 * file/socket is overwritten with `/dev/null` (a `connect` then fails).
 * Missing paths are skipped (nothing to hide); globs are expanded first.
 */
function appendMask(args: string[], path: string, io: ProfileIo): void {
  for (const target of isGlob(path) ? expand([path], io) : [path]) {
    if (target === '' || !io.exists(target)) continue
    if (io.isDirectory(target)) {
      args.push('--tmpfs', target)
    } else {
      args.push('--ro-bind', '/dev/null', target)
    }
  }
}

/**
 * Build the bwrap profile arguments for one file-effect policy under the
 * hardened runtime options. The returned args do NOT include the trailing
 * `--` separator or the command argv.
 *
 * @param policy - the file-effect policy this execution runs under.
 * @param options - the runtime isolation options.
 * @param io - the filesystem facts (defaults to the real filesystem).
 * @param overlay - when present, the workspace root is mounted as an overlay
 *   (lower = the real workspace, upper = the private writable layer) so the
 *   command sees the logical view at the real path and writes only to the
 *   delta layer.
 * @returns the profile arguments before the trailing separator.
 */
export function bwrapProfileArgs(
  policy: SandboxPolicy,
  options: RuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  io: ProfileIo = nodeProfileIo,
  overlay?: OverlaySpec,
): string[] {
  const args: string[] = []

  // Namespaces: PID/IPC/UTS plus the network boundary (never the whole
  // `--unshare-all`, which would also try to unshare user/mount).
  args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts')
  args.push(...networkArgs(options.networkMode))
  args.push('--die-with-parent')

  // Minimal read-only system set (whitelist), not `--ro-bind / /`.
  for (const root of expand(options.readonlyRoots, io)) {
    if (io.exists(root)) args.push('--ro-bind-try', root, root)
  }
  for (const path of expand(options.readonlyPaths, io)) {
    if (io.exists(path)) args.push('--ro-bind-try', path, path)
  }

  // A fresh /dev and /proc, with global sysctls made read-only.
  args.push('--dev', '/dev')
  args.push('--proc', '/proc')
  if (io.exists('/proc/sys')) args.push('--ro-bind-try', '/proc/sys', '/proc/sys')

  // Writable surface: private tmpfs roots then the workspace (overlay when a
  // delta layer is supplied, else a direct bind).
  if (policy.mode === 'workspace-write') {
    for (const root of options.tmpfsRoots) args.push('--tmpfs', root)
    if (overlay === undefined) {
      args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    } else {
      args.push('--overlay-src', policy.workspaceRoot, '--overlay', overlay.upper, overlay.work, policy.workspaceRoot)
      for (const bind of overlay.binds ?? []) {
        args.push(bind.readOnly === true ? '--ro-bind' : '--bind', bind.src, bind.dest)
      }
    }
  } else {
    // read-only still needs the workspace readable.
    args.push('--ro-bind-try', policy.workspaceRoot, policy.workspaceRoot)
  }

  // Masks last so they override every earlier mount.
  for (const path of options.procMaskPaths) appendMask(args, path, io)
  for (const path of options.maskPaths) appendMask(args, path, io)

  return args
}
