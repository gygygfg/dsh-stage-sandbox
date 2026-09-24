/**
 * Re-exports for the unified workspace service (v2.3).
 * @module dsh-sandbox-linux/workspace
 */

export { LogicalWorkspace, logicalPathDigest } from './logical.ts'
export type { LogicalMutation, LogicalWorkspaceOptions } from './logical.ts'
export {
  completed,
  restorePaths,
  UNOBSERVED,
} from './result.ts'
export type { ObservedScope, PathMap, ToolResult, ToolStatus } from './result.ts'
export type {
  CorruptionRecord,
  LogicalEntry,
  LogicalRead,
  LogicalState,
  LogicalStateKind,
  WorkspaceIntegrity,
  WorkspaceObject,
  WorkspaceObjectKind,
} from './types.ts'
