/**
 * The kernel-level network boundary per {@link NetworkMode}. The application
 * layer already gates fetches through the broker's {@link NetworkGateway};
 * this module makes the boundary real at the kernel: a fresh network
 * namespace with no interfaces (plus loopback down) forces ALL egress off, so
 * a direct socket cannot bypass the authorization layer.
 *
 * `OBSERVED_ONLINE` deliberately does NOT unshare: it keeps shared egress and
 * honestly reports that direct paths are not covered. `CONTROLLED_ONLINE`
 * unshares for now (there is no netns gateway yet; phase 2 adds one), so it is
 * functionally offline until that lands and the capability report says so.
 * @module dsh-sandbox-linux/runtime/network
 */

import type { NetworkMode } from '../broker/network.ts'

/**
 * Whether a mode creates a private network namespace.
 * @param mode - the configured network mode.
 * @returns `true` when all egress is kernel-forced off.
 */
export function networkIsolated(mode: NetworkMode): boolean {
  return mode === 'OFFLINE' || mode === 'CONTROLLED_ONLINE'
}

/**
 * The bwrap arguments for a network mode.
 * @param mode - the configured network mode.
 * @returns `['--unshare-net']` when isolated, else `[]`.
 */
export function networkArgs(mode: NetworkMode): string[] {
  return networkIsolated(mode) ? ['--unshare-net'] : []
}

/**
 * Whether the mode provides a kernel-enforced egress boundary (as opposed to
 * an observation/authorization layer only).
 * @param mode - the configured network mode.
 * @returns `true` for `OFFLINE` and `CONTROLLED_ONLINE`.
 */
export function networkEnforced(mode: NetworkMode): boolean {
  return networkIsolated(mode)
}
