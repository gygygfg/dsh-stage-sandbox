/**
 * Platform Abstraction Layer vocabulary: the backend identity, the capability
 * model, and the `RuntimeBackend` contract the sandbox provider selects from.
 * Platform differences converge here; the control plane, the policy service,
 * the publisher, and the state machine stay platform-independent.
 * @module dsh-sandbox-linux/pal/types
 */

/**
 * Identity of one runtime backend. This plugin is Linux-only: the backend is
 * the host's Linux isolation mechanism set (namespaces and Landlock), and may
 * own several functionally probed runners behind the single id.
 */
export type RuntimeBackendId = 'linux'

/**
 * How completely a backend provides one capability. `enforced` means the
 * mechanism governs every effect it claims; `partial` means it governs a
 * subset (an older kernel ABI, an ambient-access boundary); `absent` means the
 * host has no mechanism and a plan requiring it must be refused.
 */
export type CapabilityStatus = 'enforced' | 'partial' | 'absent'

/**
 * A capability a backend can provide or lack. The set is closed so a
 * requirement names a known mechanism and a missing report entry is a compile
 * error rather than a silent gap.
 */
export type SandboxCapability =
  | 'fileEffectPolicy'
  | 'isolation'
  | 'resourceLimits'
  | 'syscallPolicy'
  | 'fileTransactions'
  | 'fileIdentity'
  | 'reparsePoints'
  | 'networkControl'
  | 'integrity'
  | 'privilegeReduction'

/**
 * A capability status a requirement may ask for. `absent` is excluded because
 * requiring an absent mechanism is the same as requiring nothing.
 */
export type RequiredCapabilityStatus = Exclude<CapabilityStatus, 'absent'>

/**
 * What one backend reports about a host after probing it. The report is a
 * per-host fact, not a promise: a plan whose required capability is `absent`
 * or below its required status is refused, and the report is what the refusal
 * cites.
 */
export interface CapabilityReport {
  /** The backend that produced this report. */
  readonly backendId: RuntimeBackendId
  /** The backend implementation's own version, for execution-intent binding. */
  readonly backendVersion: string
  /** The probed kernel or build version, for diagnostics. */
  readonly kernelVersion: string
  /** One status per known capability. */
  readonly capabilities: Readonly<Record<SandboxCapability, CapabilityStatus>>
  /** The deployment environment the report was probed in. */
  readonly environment?: EnvironmentFingerprint
  /** The actual-execution validation the report covers. */
  readonly validation?: ExecutionValidation
}

/**
 * The deployment environment a probe was run in. A capability verdict is only
 * meaningful for the environment it was measured in, so the fingerprint is
 * bound into the probe cache key and into the execution intent.
 */
export interface EnvironmentFingerprint {
  /** The host platform. */
  readonly platform: string
  /** The kernel or build version. */
  readonly kernelVersion: string
  /** The filesystem type backing the probe's lower/upper/work directories. */
  readonly fsType: string
  /** The mount topology the probe observed. */
  readonly mountTopology: string
  /** The namespace context the probe ran in. */
  readonly namespaceContext: string
  /** The privilege context the probe ran under. */
  readonly privilegeContext: string
  /** The runtime version and argument syntax the probe used. */
  readonly runtimeVersion: string
}

/** One operation the actual-execution validation exercised. */
export type ValidationOperation =
  | 'create'
  | 'read'
  | 'modify'
  | 'delete'
  | 'directory-change'
  | 'candidate-capture'
  | 'cleanup'

/** The result of validating one operation. */
export interface OperationValidation {
  /** The operation exercised. */
  readonly operation: ValidationOperation
  /** Whether the operation actually completed. */
  readonly ok: boolean
  /** A diagnostic detail when the operation failed. */
  readonly detail?: string
}

/**
 * The result of validating that this deployment can actually perform the
 * operations a task needs — not merely that a version string is present. A
 * cached success never replaces the necessary checks at instance start.
 */
export interface ExecutionValidation {
  /** The environment fingerprint the validation was measured in. */
  readonly fingerprint: string
  /** One result per exercised operation. */
  readonly operations: readonly OperationValidation[]
  /** Whether every exercised operation succeeded. */
  readonly ok: boolean
}

/** One capability a plan requires and the minimum status that satisfies it. */
export interface CapabilityRequirement {
  /** The required capability. */
  readonly capability: SandboxCapability
  /** The minimum status that satisfies the requirement. */
  readonly minimum: RequiredCapabilityStatus
}

/**
 * One platform runtime backend. `probe()` is a per-host fact, so a provider
 * caches its verdict for the provider lifetime; `unusable` means the backend
 * cannot confine on this host and selection must fall through or fail closed.
 */
export interface RuntimeBackend {
  /** The backend identity. */
  readonly id: RuntimeBackendId
  /** The `process.platform` values this backend serves, e.g. `['linux']`. */
  readonly platforms: readonly string[]
  /**
   * Probe the host and report what the backend can enforce.
   * @returns the capability report, or `unusable` when the backend cannot
   *   confine here.
   */
  probe(): CapabilityReport | 'unusable'
}
