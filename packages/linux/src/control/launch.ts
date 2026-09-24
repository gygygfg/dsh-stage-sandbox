/**
 * The process startup boundary (v2.3). Every confined process starts through
 * a trusted launcher that explicitly constructs the environment and the
 * inherited-resource set: the environment is built from an allow-list rather
 * than merged with the parent (so removing a secret or proxy variable is not a
 * promise), inherited descriptors are closed, and capabilities are dropped
 * while identity and file access are constrained separately.
 *
 * This module owns the contract and the allow-list construction, and refuses
 * to start when the boundary cannot be converged.
 * @module dsh-sandbox-linux/control/launch
 */

/** The environment keys a confined process inherits by default. */
export const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
]

/**
 * Build a confined process's environment from an allow-list. Only listed keys
 * present in the source are copied; the parent environment is never merged in
 * and then pruned, so an unlisted secret or proxy variable cannot leak.
 * @param source - the parent environment.
 * @param allowlist - the permitted keys.
 * @returns the constructed environment.
 */
export function buildEnvironment(source: Readonly<Record<string, string | undefined>>, allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of allowlist) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

/** The inherited-resource convergence a launcher must provide. */
export interface InheritedResourcePolicy {
  /** Whether non-authorized file descriptors are closed. */
  readonly closesUnauthorizedDescriptors: boolean
  /** The capabilities removed from the process. */
  readonly droppedCapabilities: readonly string[]
  /** Whether the environment is built from the allow-list. */
  readonly environmentAllowList: boolean
}

/** The conservative boundary a confined launch must satisfy. */
export const DEFAULT_INHERITED_RESOURCE_POLICY: InheritedResourcePolicy = {
  closesUnauthorizedDescriptors: true,
  droppedCapabilities: ['CAP_SYS_ADMIN', 'CAP_SYS_PTRACE', 'CAP_NET_ADMIN'],
  environmentAllowList: true,
}

/** The result of checking a launch boundary. */
export type StartupBoundaryVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Verify a launcher's declared boundary. An un-converged inherited-resource
 * set refuses the start rather than silently proceeding with ambient access.
 * @param policy - the launcher's boundary facts.
 * @returns `ok`, or the refusal reason.
 */
export function assertStartupBoundary(policy: InheritedResourcePolicy): StartupBoundaryVerdict {
  if (!policy.closesUnauthorizedDescriptors) {
    return { ok: false, reason: 'unauthorized inherited descriptors are not converged' }
  }
  if (!policy.environmentAllowList) {
    return { ok: false, reason: 'the environment is not built from an allow-list' }
  }
  return { ok: true }
}
