/**
 * Behavior observation (v2.3 §12). The static scan cannot see what a command
 * actually opens at runtime; this module observes it. The strongest backend is
 * eBPF (`bpftrace`), then `strace`; when neither is available the observer
 * reports `none` rather than pretending to cover anything.
 *
 * The observation runs on the HOST around the confinement runner (`strace -f`
 * follows the payload's forks), because the in-sandbox seccomp baseline blocks
 * `ptrace`. It records file accesses outside the workspace so they can be added
 * to the out-of-bounds trace.
 * @module dsh-sandbox-linux/runtime/observer
 */

import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

/** The observation backends, strongest first. */
export type ObserverBackend = 'bpftrace' | 'strace' | 'none'

/** Whether an executable exists on PATH (injectable for tests). */
export type BinaryProbe = (binary: string) => boolean

/** The default probe: `command -v <binary>`. */
export const pathProbe: BinaryProbe = binary => {
  try {
    return spawnSync('sh', ['-c', `command -v ${JSON.stringify(binary)}`], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * Detect the strongest available observation backend.
 * @param probe - the binary probe (defaults to a PATH lookup).
 * @returns the backend.
 */
export function detectObserverBackend(probe: BinaryProbe = pathProbe): ObserverBackend {
  if (probe('bpftrace')) return 'bpftrace'
  if (probe('strace')) return 'strace'
  return 'none'
}

/**
 * Wrap a command with `strace` to record its file accesses to a trace file.
 * Only meaningful when {@link detectObserverBackend} reports `strace`.
 * @param argv - the command argv (the confinement runner, then the payload).
 * @param tracePath - the file `strace` writes its output to.
 * @returns the argv to spawn instead.
 */
export function wrapWithStrace(argv: readonly string[], tracePath: string): string[] {
  return ['strace', '-f', '-e', 'trace=openat,open,stat,lstat,access', '-o', tracePath, '--', ...argv]
}

/** Whether a path is the root or a descendant of it. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Parse `strace` output for successfully opened files outside the workspace.
 * Failed opens (`= -1 …`) are ignored, and the result is deduplicated.
 * @param output - the strace output.
 * @param workspaceRoot - the workspace root that is in bounds.
 * @returns the out-of-bounds paths, in first-seen order.
 */
export function parseStraceFileAccesses(output: string, workspaceRoot: string): string[] {
  const root = resolve(workspaceRoot)
  const seen = new Set<string>()
  const result: string[] = []
  const pattern = /(?:openat|open|stat|lstat|access)\((?:[^,]*,\s*)?"([^"]+)"[^)]*\)\s*=\s*(\d+)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(output)) !== null) {
    const path = match[1]
    if (path === undefined || !path.startsWith('/')) continue
    if (isUnder(root, path)) continue
    if (seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}
