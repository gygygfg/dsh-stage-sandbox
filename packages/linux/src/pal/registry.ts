/**
 * The Platform Abstraction Layer registry: a named table of runtime backends
 * with one owner per host platform. Backends register as effects; selection is
 * by `process.platform`, so the control plane and the provider never branch on
 * an operating-system name.
 * @module dsh-sandbox-linux/pal/registry
 */

import type { RuntimeBackend, RuntimeBackendId } from './types.ts'

/** Failure codes of the PAL registry. */
export type SandboxPalErrorCode = 'duplicate-backend' | 'duplicate-platform' | 'backend-not-found'

/**
 * Thrown when a backend registration conflicts or a lookup misses. Registration
 * and lookup are same-process typed boundaries, so the code is for diagnostics
 * and tests, not for callers to branch on.
 */
export class SandboxPalError extends Error {
  /** The failure kind. */
  readonly code: SandboxPalErrorCode

  /**
   * @param code - the failure kind.
   * @param message - the human-readable failure text.
   */
  constructor(code: SandboxPalErrorCode, message: string) {
    super(message)
    this.name = 'SandboxPalError'
    this.code = code
  }
}

/**
 * Mutable backend table with one owner per platform. A platform is claimed by
 * the first backend that declares it; a second claim is rejected, so a chain
 * of runners on one platform stays inside that platform's backend instead of
 * becoming two backends the selector would have to arbitrate between. The
 * `Backend` type parameter lets a provider retrieve its richer backend without
 * a cast while the registry still stores only the `RuntimeBackend` contract.
 */
export class SandboxPal<Backend extends RuntimeBackend = RuntimeBackend> {
  private readonly byId = new Map<RuntimeBackendId, Backend>()
  private readonly platformOwners = new Map<string, Backend>()

  /**
   * Register a backend and claim every platform it serves. Registration is an
   * effect: the returned disposer removes the backend and releases only the
   * platform claims this registration still owns.
   * @param backend - the backend to register.
   * @returns the disposer that unregisters the backend.
   */
  register(backend: Backend): () => void {
    if (this.byId.has(backend.id)) {
      throw new SandboxPalError('duplicate-backend', `sandbox backend '${backend.id}' is already registered`)
    }
    for (const platform of backend.platforms) {
      const owner = this.platformOwners.get(platform)
      if (owner !== undefined) {
        throw new SandboxPalError('duplicate-platform', `sandbox platform '${platform}' is already served by backend '${owner.id}'`)
      }
    }
    this.byId.set(backend.id, backend)
    for (const platform of backend.platforms) this.platformOwners.set(platform, backend)
    return () => {
      // Remove only this registration's contribution: after dispose + re-register,
      // a stale disposer firing again must not remove the successor.
      if (this.byId.get(backend.id) !== backend) return
      this.byId.delete(backend.id)
      // The platform guard above already proved this registration owns each
      // claim: a replacement backend cannot exist while this id is still bound.
      for (const platform of backend.platforms) this.platformOwners.delete(platform)
    }
  }

  /**
   * Resolve a backend by id.
   * @param id - the registered backend id.
   * @returns the backend.
   */
  backend(id: RuntimeBackendId): Backend {
    const backend = this.byId.get(id)
    if (backend === undefined) {
      throw new SandboxPalError('backend-not-found', `sandbox backend '${id}' is not registered (registered: ${this.names().join(', ') || 'none'})`)
    }
    return backend
  }

  /**
   * Resolve the backend that serves a host platform.
   * @param platform - a `process.platform` value.
   * @returns the owning backend, or `undefined` when none serves the platform.
   */
  backendFor(platform: string): Backend | undefined {
    return this.platformOwners.get(platform)
  }

  /**
   * Registered backend ids, for diagnostics.
   * @returns a snapshot array of ids.
   */
  names(): RuntimeBackendId[] {
    return [...this.byId.keys()]
  }

  /**
   * Registered backends, for diagnostics.
   * @returns a snapshot array of backends.
   */
  backends(): Backend[] {
    return [...this.byId.values()]
  }
}
