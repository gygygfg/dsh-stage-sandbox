/**
 * The publication writer (v2.3 §13). A write is attempted as the current
 * (unprivileged) identity first; when the filesystem refuses with a permission
 * error the writer reports `needs-root` instead of failing, so the caller can
 * request approval. Only an explicitly approved write uses the privileged
 * attempt, and a non-permission failure is never silently retried.
 * @module dsh-sandbox-linux/publish/writer
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One write request. */
export interface WriteRequest {
  /** The absolute destination path. */
  readonly path: string
  /** The exact bytes to write. */
  readonly content: Buffer
  /** The permission bits to apply, when known. */
  readonly mode?: number
}

/** The writer's verdict for one request. */
export type WriteOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'needs-root'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

/** The low-level write operations, injectable for tests. */
export interface WriterDeps {
  /** Attempt the write as the current identity. */
  write(request: WriteRequest): void
  /** Attempt the write with elevated privilege (only after approval). */
  rootWrite?(request: WriteRequest): void
}

/** The default writer: a plain filesystem write (`mkdir -p` then write). */
export const nodeWriterDeps: WriterDeps = {
  write: request => {
    mkdirSync(dirname(request.path), { recursive: true })
    writeFileSync(request.path, request.content, request.mode === undefined ? {} : { mode: request.mode })
  },
  rootWrite: request => {
    mkdirSync(dirname(request.path), { recursive: true })
    writeFileSync(request.path, request.content, request.mode === undefined ? {} : { mode: request.mode })
  },
}

/** Whether an error is a permission refusal that a root write could satisfy. */
export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
}

/**
 * Write one file, escalating to root only when approved.
 * @param request - the path, bytes, and mode.
 * @param options - whether a privileged retry is approved.
 * @param deps - the write operations (defaults to the real filesystem).
 * @returns the outcome.
 */
export function writeFileWithEscalation(request: WriteRequest, options: { allowRoot: boolean }, deps: WriterDeps = nodeWriterDeps): WriteOutcome {
  try {
    deps.write(request)
    return { kind: 'written' }
  } catch (error) {
    if (!isPermissionError(error)) {
      return { kind: 'failed', reason: `write failed: ${String(error)}` }
    }
    if (!options.allowRoot) {
      return { kind: 'needs-root', reason: `permission denied writing ${request.path}; approval required` }
    }
    if (deps.rootWrite === undefined) {
      return { kind: 'failed', reason: `permission denied writing ${request.path} and no privileged writer is configured` }
    }
    try {
      deps.rootWrite(request)
      return { kind: 'written' }
    } catch (rootError) {
      return { kind: 'failed', reason: `privileged write failed: ${String(rootError)}` }
    }
  }
}
