/**
 * Vocabulary for the unified workspace service (v2.3). The service keeps one
 * logical version per workspace branch; every tool — file edit, read, directory
 * listing, search, Git, command execution — resolves paths through the same
 * namespace, so a deleted object stays deleted, a staged write stays visible,
 * and a missing storage object is corruption rather than a silent fall back to
 * the real disk.
 * @module dsh-sandbox-linux/workspace/types
 */

/**
 * The lifecycle object kinds the workspace service owns. Each has an explicit
 * owner and lifetime; none is implicitly shared between branches.
 */
export type WorkspaceObjectKind =
  | 'workspace'
  | 'branch'
  | 'session'
  | 'attempt'
  | 'candidate'
  | 'operation'
  | 'service'

/** One lifecycle object's identity, owner, and lifetime. */
export interface WorkspaceObject {
  /** The object kind. */
  readonly kind: WorkspaceObjectKind
  /** The stable object identity. */
  readonly id: string
  /** The owning object identity, or `null` for a root. */
  readonly owner: string | null
  /** The workspace branch the object is bound to. */
  readonly branchId: string | null
}

/**
 * The logical state of one path in the unified namespace. `baseline` is an
 * unmodified base object; `staged-file`/`staged-directory` are staged
 * creations or modifications; `deleted` is an explicit, persistent deletion
 * marker; `corrupted` means the record declares the object but the storage
 * object is missing, and publication must be blocked rather than falling back
 * to the real disk.
 */
export type LogicalStateKind =
  | 'absent'
  | 'baseline'
  | 'staged-file'
  | 'staged-directory'
  | 'deleted'
  | 'corrupted'

/** One path's logical state. */
export interface LogicalState {
  /** The logical (real) absolute path. */
  readonly path: string
  /** The POSIX-separated path relative to the workspace root (`''` for the root). */
  readonly relative: string
  /** The logical state kind. */
  readonly kind: LogicalStateKind
  /** The corruption reason, when `kind` is `corrupted`. */
  readonly reason?: string
}

/** One directory entry as a logical listing reports it. */
export interface LogicalEntry {
  /** The entry name (basename). */
  readonly name: string
  /** The logical (real) absolute path. */
  readonly path: string
  /** The POSIX-separated path relative to the workspace root. */
  readonly relative: string
  /** The entry kind. */
  readonly kind: 'file' | 'directory' | 'symlink'
}

/** A structured logical read result: distinct kinds are never conflated. */
export type LogicalRead =
  | { readonly kind: 'file'; readonly state: LogicalState; readonly content: string; readonly digest: string }
  | { readonly kind: 'directory'; readonly state: LogicalState; readonly entries: readonly LogicalEntry[] }
  | { readonly kind: 'absent'; readonly state: LogicalState }
  | { readonly kind: 'corrupted'; readonly state: LogicalState; readonly reason: string }

/** One corrupted path and why the storage object is missing. */
export interface CorruptionRecord {
  /** The POSIX-separated relative path. */
  readonly relative: string
  /** The logical (real) absolute path. */
  readonly path: string
  /** The reason the object is considered corrupted. */
  readonly reason: string
}

/** The workspace integrity check result. */
export interface WorkspaceIntegrity {
  /** Whether the logical view is free of corruption. */
  readonly ok: boolean
  /** The corrupted paths, empty when `ok`. */
  readonly corrupted: readonly CorruptionRecord[]
}
