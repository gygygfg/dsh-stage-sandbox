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

import { existsSync, globSync, statSync } from 'node:fs'
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

/** The default IO over the real filesystem. */
export const nodeProfileIo: ProfileIo = {
  exists: path => existsSync(path),
  isDirectory: path => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  glob: pattern => {
    try {
      return globSync(pattern)
    } catch {
      return []
    }
  },
}

/** Whether a configured path is a glob pattern. */
function isGlob(path: string): boolean {
  return /[*?[]/u.test(path)
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
