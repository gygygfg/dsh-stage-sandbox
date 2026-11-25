/**
 * Consequence severity for the review surface.
 *
 * Why this exists on Windows
 * --------------------------
 * `classifyChange()` answers **where** a change lands (inside the workspace,
 * outside it, or a masked/credential path). It deliberately does not answer
 * **what the change does**: deleting `README.md` and appending a line to it are
 * both `risk: "normal"` when the file is inside the workspace. The Linux
 * package has had a consequence classifier (`candidate/danger.ts`) since the
 * 2026-11-25 hardening round; Windows did not, so a reviewer that rejects
 * "L2+" had nothing to reject and the review surface could not distinguish a
 * destructive write from a benign one.
 *
 * This module is the Windows counterpart. It is deliberately a **pure
 * function** over data the review surface already has (path, operation,
 * before/after byte counts, registry key/value). It never reads the disk and
 * never decides whether to publish; it only assigns a level and machine-
 * readable reasons that `snapshot()` exposes to the reviewer.
 *
 * Levels are the same three used on Linux:
 *
 * | level | meaning | examples |
 * |---|---|---|
 * | `L1` | ordinary, reversible, inside the workspace | edit a source file, add output |
 * | `L2` | destructive or outside the workspace, but recoverable | delete a file, write another registry value |
 * | `L3` | irreversible, persistent, or system-wide | empty a file, install a git hook, `Run`/`Services` value, System32 write |
 *
 * The mapping is intentionally conservative: an unclear case is not promoted
 * to L3 by guesswork, and a credential path stays L3 through the existing
 * `safety: "danger"` path (the caller merges that verdict in).
 *
 * @module winstage-sandbox/severity
 */

import { gitPathClass } from './git-path.ts'

/** The consequence level shown next to one review row. */
export type SeverityLevel = 'L1' | 'L2' | 'L3'

/** One machine-readable reason for a level. */
export interface SeverityReason {
  /** Stable code (`CONTENT_WIPED`, `PERSISTENCE_REGISTRY`, …). */
  readonly code: string
  /** The level this reason contributes. */
  readonly level: SeverityLevel
  /** One-line human-readable explanation. */
  readonly detail: string
  /** The path the reason applies to, when it is not the whole row. */
  readonly path?: string
}

/** A level plus the reasons that produced it. */
export interface SeverityVerdict {
  readonly level: SeverityLevel
  readonly reasons: readonly SeverityReason[]
}

const ORDER: Record<SeverityLevel, number> = { L1: 1, L2: 2, L3: 3 }

/** Compare two levels. */
export function levelRank(level: SeverityLevel): number {
  return ORDER[level] ?? 1
}

/** Pick the higher of two levels. */
export function maxLevel(left: SeverityLevel, right: SeverityLevel): SeverityLevel {
  return levelRank(left) >= levelRank(right) ? left : right
}

/** Collapse a list of levels to the highest. */
export function highestLevel(levels: readonly SeverityLevel[]): SeverityLevel {
  let level: SeverityLevel = 'L1'
  for (const candidate of levels) level = maxLevel(level, candidate)
  return level
}

/** Build a verdict from a list of reasons (highest reason wins). */
export function verdictOf(reasons: readonly SeverityReason[]): SeverityVerdict {
  return { level: highestLevel(reasons.map((reason) => reason.level)), reasons: [...reasons] }
}

/** A Windows path that the system itself owns, not a user workspace. */
const SYSTEM_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\\)windows\\system32(\\|$)/i,
  /(^|\\)windows\\syswow64(\\|$)/i,
  /(^|\\)windows\\tasks(\\|$)/i,
  /(^|\\)windows\\system32\\drivers\\etc\\hosts$/i,
  /(^|\\)programdata\\microsoft\\windows\\start menu\\programs\\startup(\\|$)/i,
  /(^|\\)users\\[^\\]+\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup(\\|$)/i,
]

/** Whether a path is a Windows system location. */
export function isSystemPath(path: string): boolean {
  const normalized = String(path ?? '').replaceAll('/', '\\')
  return SYSTEM_PATH_PATTERNS.some((pattern) => pattern.test(normalized))
}

/** Whether the path looks absolute (drive letter or UNC). */
export function isAbsoluteWindowsPath(path: string): boolean {
  const text = String(path ?? '')
  return /^[A-Za-z]:[\\/]/u.test(text) || /^\\\\/u.test(text)
}

/** Input for one filesystem change. */
export interface FileSeverityInput {
  /** Workspace-relative path, or an absolute path for an external entry. */
  readonly path: string
  /** `create` / `modify` / `delete` / `mkdir`. */
  readonly op: string
  /** `file` or `dir`. */
  readonly kind: string
  /** Bytes in the base version (0 when the file did not exist). */
  readonly beforeBytes?: number
  /** Bytes in the candidate (0 for a deletion). */
  readonly afterBytes?: number
  /** True when the change lands outside the workspace. */
  readonly external?: boolean
}

/**
 * Classify a filesystem change.
 *
 * Order matters: the most specific consequence wins (a `.git` hook is L3 even
 * if the file is tiny; a System32 write is L3 even if it only creates a file).
 * @param input - the change as the review surface sees it.
 * @returns the level and its reasons.
 */
export function assessFileChange(input: FileSeverityInput): SeverityVerdict {
  const reasons: SeverityReason[] = []
  const path = String(input.path ?? '')
  const before = Math.max(0, Number(input.beforeBytes) || 0)
  const after = Math.max(0, Number(input.afterBytes) || 0)

  const gitClass = gitPathClass(path)
  if (gitClass !== undefined) {
    if (gitClass === 'other') {
      reasons.push({
        code: 'PERSISTENCE_GIT_INTERNAL',
        level: 'L3',
        detail: '`.git` config/hooks/info are behaviour, not state: a hook runs on the next commit and `core.hooksPath` is arbitrary execution',
        path,
      })
    } else if (gitClass === 'pointer') {
      if (input.op === 'delete') {
        reasons.push({
          code: 'GIT_POINTER_DELETE',
          level: 'L3',
          detail: 'deleting an index/ref/HEAD leaves the repository unusable',
          path,
        })
      } else {
        reasons.push({
          code: 'GIT_REFERENCE_UPDATE',
          level: 'L2',
          detail: 'updates a git pointer (index/ref/log) that must resolve against the object store',
          path,
        })
      }
    }
    // Objects are content-addressed and additive: they add no consequence by
    // themselves. Referential integrity is enforced by the publication gate.
  }

  if (input.op === 'delete') {
    reasons.push({
      code: input.kind === 'dir' ? 'DIRECTORY_DELETE' : 'FILE_DELETE',
      level: input.kind === 'dir' ? 'L3' : 'L2',
      detail: input.kind === 'dir' ? 'removes a directory tree' : 'removes a file',
      path,
    })
  } else if (input.op === 'modify' || input.op === 'create') {
    if (before > 0 && after === 0) {
      reasons.push({
        code: 'CONTENT_WIPED',
        level: 'L3',
        detail: `content was truncated from ${before} bytes to empty`,
        path,
      })
    } else if (before >= 1024 && after * 2 <= before) {
      reasons.push({
        code: 'CONTENT_TRUNCATED',
        level: 'L2',
        detail: `content shrank from ${before} to ${after} bytes (more than half)`,
        path,
      })
    }
  }

  const external = input.external === true || (isAbsoluteWindowsPath(path) && input.external !== false)
  if (external) {
    reasons.push({
      code: 'OUTSIDE_WORKSPACE',
      level: 'L2',
      detail: 'the change lands outside the workspace; publishing writes to the host',
      path,
    })
    if (isSystemPath(path)) {
      reasons.push({
        code: 'SYSTEM_PATH_WRITE',
        level: 'L3',
        detail: 'the target is an operating-system location (System32 / Startup / hosts / Tasks)',
        path,
      })
    }
  }

  return verdictOf(reasons)
}

/** Registry key fragments whose values run code or start programs. */
const PERSISTENCE_REGISTRY_PATTERNS: readonly RegExp[] = [
  /\\currentversion\\run(once|services)?(\\|$)/i,
  /\\policies\\explorer\\run(\\|$)/i,
  /\\winlogon(\\|$)/i,
  /\\services\\[^\\]+\\(imagepath|serviceDll)$/i,
  /\\image file execution options\\[^\\]+\\(debugger|globalflag)$/i,
  /\\appinit_dlls$/i,
  /\\shell\\open\\command$/i,
  /\\user shell folders(\\|$)/i,
  /\\environment\\userinitmprlogonscript$/i,
  /\\active setup\\installed components(\\|$)/i,
]

/** Input for one registry change. */
export interface RegistrySeverityInput {
  /** Canonical key path (`HKCU\Software\...\Run`). */
  readonly path: string
  /** `create` / `modify` / `delete` / `unsupported`. */
  readonly op: string
  /** Value name, when the change is a value rather than a key. */
  readonly valueName?: string
}

/**
 * Classify a registry change.
 *
 * Registry writes are outside the workspace by definition, so the floor is L2.
 * A value on a persistence/execution key is L3: approving it would make the
 * payload run at logon or as a service, long after the review.
 * @param input - the registry change as the review surface sees it.
 * @returns the level and its reasons.
 */
export function assessRegistryChange(input: RegistrySeverityInput): SeverityVerdict {
  const reasons: SeverityReason[] = []
  const path = String(input.path ?? '')
  const target = input.valueName !== undefined ? `${path}\\${input.valueName}` : path

  if (input.op === 'delete') {
    reasons.push({
      code: 'REGISTRY_DELETE',
      level: 'L2',
      detail: 'removes a registry key or value',
      path: target,
    })
  } else if (input.op === 'unsupported') {
    reasons.push({
      code: 'REGISTRY_UNSUPPORTED',
      level: 'L2',
      detail: 'security-descriptor / readability changes cannot be staged faithfully',
      path: target,
    })
  } else {
    reasons.push({
      code: 'REGISTRY_WRITE',
      level: 'L2',
      detail: 'writes to the real registry (outside the workspace)',
      path: target,
    })
    if (PERSISTENCE_REGISTRY_PATTERNS.some((pattern) => pattern.test(target))) {
      reasons.push({
        code: 'PERSISTENCE_REGISTRY',
        level: 'L3',
        detail: 'the key/value is a persistence or execution point (Run / Winlogon / Services / IFEO / Shell)',
        path: target,
      })
    }
  }

  return verdictOf(reasons)
}

/** Whether a registry value name looks like a secret (used only for display). */
export function looksSensitiveValueName(name: string | undefined): boolean {
  return /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key/i.test(String(name ?? ''))
}
