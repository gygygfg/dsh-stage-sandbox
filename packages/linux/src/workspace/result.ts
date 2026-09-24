/**
 * Structured tool results for the unified workspace (v2.3). Every tool return
 * carries the execution status, the exit code or termination reason, the
 * result data, the logical paths it observed, the observed scope, and the
 * evidence references. Distinct outcomes — empty directory, no match, object
 * not found, permission denied, query failure, corrupted storage — are
 * different statuses, never one rendered string.
 * @module dsh-sandbox-linux/workspace/result
 */

import type { ImpactCoverage } from '../candidate/impact.ts'

/** The terminal status of one tool execution. */
export type ToolStatus =
  | 'completed'
  | 'completed-no-output'
  | 'failed'
  | 'not-executed'
  | 'denied'
  | 'not-found'
  | 'empty'
  | 'no-match'
  | 'permission-denied'
  | 'corrupted'
  | 'timeout'
  | 'signalled'

/** The observation coverage per impact category at result time. */
export interface ObservedScope {
  /** Filesystem observation coverage. */
  readonly fs: ImpactCoverage
  /** Process observation coverage. */
  readonly process: ImpactCoverage
  /** Network observation coverage. */
  readonly network: ImpactCoverage
}

/** One structured tool result. */
export interface ToolResult<T = unknown> {
  /** The terminal status. */
  readonly status: ToolStatus
  /** The process exit code, or `null` when no process ran or it was signalled. */
  readonly exitCode: number | null
  /** The termination reason when the process was signalled or timed out. */
  readonly termination?: string
  /** The result payload. */
  readonly data?: T
  /** The logical paths the tool observed, in display order. */
  readonly logicalPaths: readonly string[]
  /** Whether the paths are the staged view or the real workspace. */
  readonly view: 'staged' | 'real'
  /** The observation coverage. */
  readonly observed: ObservedScope
  /** Evidence references backing the result. */
  readonly evidence: readonly string[]
  /** The policy reason codes when denied. */
  readonly reasonCodes?: readonly string[]
}

/** The observation coverage with every category unobserved. */
export const UNOBSERVED: ObservedScope = {
  fs: 'missing',
  process: 'missing',
  network: 'missing',
}

/** Build a completed result, distinguishing "no output" from "not executed". */
export function completed<T>(input: {
  readonly exitCode: number
  readonly data?: T
  readonly hasOutput: boolean
  readonly logicalPaths?: readonly string[]
  readonly observed?: ObservedScope
  readonly evidence?: readonly string[]
  readonly view?: 'staged' | 'real'
}): ToolResult<T> {
  const status: ToolStatus = input.exitCode === 0 ? (input.hasOutput ? 'completed' : 'completed-no-output') : 'failed'
  return {
    status,
    exitCode: input.exitCode,
    ...(input.data === undefined ? {} : { data: input.data }),
    logicalPaths: input.logicalPaths ?? [],
    view: input.view ?? 'staged',
    observed: input.observed ?? UNOBSERVED,
    evidence: input.evidence ?? [],
  }
}

/**
 * A path-restoration mapping. Structured path fields are mapped from staging
 * paths to logical paths; arbitrary file bodies are never string-replaced, so
 * business content cannot be corrupted by path restoration.
 */
export type PathMap = (stagingPath: string) => string | undefined

/**
 * Restore structured path fields in a value: any string under a known
 * `pathKeys` field name is mapped when the mapping knows it. Nested objects
 * and arrays are walked; a value the mapping does not know is left unchanged.
 * @param value - the structured value to walk.
 * @param map - the staging-path to logical-path mapping.
 * @param pathKeys - the field names whose string values are paths.
 * @returns the value with path fields restored.
 */
export function restorePaths<T>(value: T, map: PathMap, pathKeys: readonly string[] = ['path', 'file', 'target', 'cwd', 'root', 'uri']): T {
  const keys = new Set(pathKeys)
  const walk = (node: unknown, key: string | undefined): unknown => {
    if (typeof node === 'string') {
      if (key !== undefined && keys.has(key)) return map(node) ?? node
      return node
    }
    if (Array.isArray(node)) return node.map(entry => walk(entry, undefined))
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [childKey, childValue] of Object.entries(node as Record<string, unknown>)) out[childKey] = walk(childValue, childKey)
      return out
    }
    return node
  }
  return walk(value, undefined) as T
}
