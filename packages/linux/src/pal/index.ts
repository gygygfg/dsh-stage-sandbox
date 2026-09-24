/**
 * Platform Abstraction Layer for the process sandbox: the `RuntimeBackend`
 * capability contract, the capability-requirement check, and the named
 * backend registry. Platform differences converge here; the sandbox provider
 * and the control plane select a backend by host platform and never branch on
 * an operating-system name.
 * @module dsh-sandbox-linux/pal
 */

export { capabilityGaps, meetsRequirements } from './capabilities.ts'
export { SandboxPal, SandboxPalError } from './registry.ts'
export type { SandboxPalErrorCode } from './registry.ts'
export {
  defaultExecutionProbe,
  environmentFingerprint,
  fingerprintKey,
  ProbeCache,
  validateExecution,
} from './probe.ts'
export type { ExecutionProbe } from './probe.ts'
export type {
  CapabilityReport,
  CapabilityRequirement,
  CapabilityStatus,
  EnvironmentFingerprint,
  ExecutionValidation,
  OperationValidation,
  RequiredCapabilityStatus,
  RuntimeBackend,
  RuntimeBackendId,
  SandboxCapability,
  ValidationOperation,
} from './types.ts'
