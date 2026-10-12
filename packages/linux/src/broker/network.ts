/**
 * The network gateway policy: which endpoints a sandboxed operation may reach,
 * with byte budgets and lease expiry, under one explicit mode. The mode is not
 * a synonym for "blocked": `OFFLINE` forcibly blocks all egress and overrides
 * any grant; `CONTROLLED_ONLINE` enforces grants and rejects proxy bypass and
 * prohibited targets; `OBSERVED_ONLINE` provides a proxy and logging but
 * cannot promise that a direct path is covered. A deployment that only sets
 * proxy environment variables must report `OBSERVED_ONLINE`, never "fully
 * blocked".
 *
 * The gateway's own guarantee is L3/L4 authorization only: a five-tuple
 * cannot prove application identity, and an HTTP proxy that observes only
 * CONNECT targets cannot prove no external write occurred inside the tunnel.
 * @module dsh-sandbox-linux/broker/network
 */

import { systemClock, type Clock } from '../control/lease.ts'

/** The explicit network mode. */
export type NetworkMode = 'OFFLINE' | 'CONTROLLED_ONLINE' | 'OBSERVED_ONLINE'

/** One endpoint an operation may reach. */
export interface NetworkEndpoint {
  /** The host or IP literal. */
  readonly host: string
  /** The port. */
  readonly port: number
  /** The transport protocol. */
  readonly protocol: 'tcp' | 'udp'
  /** The direction relative to the sandbox. */
  readonly direction: 'egress' | 'ingress'
}

/** One granted endpoint set with budgets and a lease. */
export interface NetworkGrant {
  /** The grant identity. */
  readonly id: string
  /** The endpoints the grant allows. */
  readonly endpoints: readonly NetworkEndpoint[]
  /** The egress byte budget, or `null` for unbounded. */
  readonly txBudgetBytes: number | null
  /** The ingress byte budget, or `null` for unbounded. */
  readonly rxBudgetBytes: number | null
  /** Epoch milliseconds the grant expires. */
  readonly expiresAt: number
}

/** One connection attempt to authorize. */
export interface NetworkRequest {
  /** The endpoint the operation wants to reach. */
  readonly endpoint: NetworkEndpoint
  /** The bytes the operation wants to send now. */
  readonly txBytes: number
  /** The bytes the operation expects to receive now. */
  readonly rxBytes: number
  /** An optional claimed application identity; not verifiable at L3/L4. */
  readonly appIdentity?: string
  /** Whether the task requires forced blocking, which OBSERVED_ONLINE cannot promise. */
  readonly requiresForcedBlock?: boolean
}

/** The gateway's decision for one request. */
export type NetworkDecision =
  | { readonly kind: 'allow'; readonly grantId: string }
  | { readonly kind: 'deny'; readonly reason: string }

/** The accounting after one metered request. */
export interface NetworkAccounting {
  /** The grant the request was metered against. */
  readonly grantId: string
  /** Total transmitted bytes on the grant. */
  readonly txBytes: number
  /** Total received bytes on the grant. */
  readonly rxBytes: number
  /** Remaining transmit budget, or `null` for unbounded. */
  readonly txRemaining: number | null
  /** Remaining receive budget, or `null` for unbounded. */
  readonly rxRemaining: number | null
}

/** The honest guarantee a mode actually provides. */
export interface NetworkGuarantee {
  /** The configured mode. */
  readonly mode: NetworkMode
  /** Whether egress is forcibly constrained (not merely proxied). */
  readonly forcesEgress: boolean
  /** Whether direct paths are observed. */
  readonly observesDirectPaths: boolean
  /** A human-readable statement of what the mode does and does not promise. */
  readonly statement: string
}

/** One tracked live connection, so lease revocation can close existing flows. */
export interface LiveConnection {
  /** The connection identity. */
  readonly id: string
  /** The grant the connection was authorized under. */
  readonly grantId: string
  /** The endpoint. */
  readonly endpoint: NetworkEndpoint
}

/** Whether an endpoint equals a granted endpoint. */
function matches(granted: NetworkEndpoint, requested: NetworkEndpoint): boolean {
  return granted.host === requested.host
    && granted.port === requested.port
    && granted.protocol === requested.protocol
    && granted.direction === requested.direction
}

/** Whether a host is a local, link-local, or cloud-metadata address. */
export function isProhibitedTarget(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '169.254.169.254' || normalized === 'metadata.google.internal') return true
  if (normalized === '::1' || normalized === '0.0.0.0') return true
  if (/^127\./u.test(normalized)) return true
  if (/^169\.254\./u.test(normalized)) return true
  if (/^fe80:/u.test(normalized)) return true
  return false
}

/** The default-deny network gateway under an explicit mode. */
export class NetworkGateway {
  private readonly grants = new Map<string, NetworkGrant>()
  private readonly usage = new Map<string, { tx: number; rx: number }>()
  private readonly connections = new Map<string, LiveConnection>()
  private sequence = 0
  private connectionSequence = 0
  private readonly clock: Clock
  private readonly mode: NetworkMode

  /**
   * @param modeOrClock - the explicit network mode, or a clock (defaults to `CONTROLLED_ONLINE`).
   * @param clock - the clock used for expiry checks when a mode is given.
   */
  constructor(modeOrClock: NetworkMode | Clock = 'CONTROLLED_ONLINE', clock: Clock = systemClock) {
    if (typeof modeOrClock === 'string') {
      this.mode = modeOrClock
      this.clock = clock
    } else {
      this.mode = 'CONTROLLED_ONLINE'
      this.clock = modeOrClock
    }
  }

  /** The configured mode. */
  get networkMode(): NetworkMode {
    return this.mode
  }

  /** The guarantee this mode actually provides. */
  guarantee(): NetworkGuarantee {
    switch (this.mode) {
      case 'OFFLINE':
        return { mode: this.mode, forcesEgress: true, observesDirectPaths: true, statement: 'all network egress is forcibly blocked; grants are ignored' }
      case 'CONTROLLED_ONLINE':
        return { mode: this.mode, forcesEgress: true, observesDirectPaths: true, statement: 'egress is restricted to granted endpoints; proxy bypass and prohibited targets are rejected' }
      case 'OBSERVED_ONLINE':
        return { mode: this.mode, forcesEgress: false, observesDirectPaths: false, statement: 'a proxy and logs are provided, but direct paths are not forcibly covered' }
    }
  }

  /**
   * Grant an endpoint set with budgets and a lease.
   * @param input - the endpoints, byte budgets, and lease lifetime.
   * @returns the created grant.
   */
  grant(input: { endpoints: readonly NetworkEndpoint[]; txBudgetBytes?: number | null; rxBudgetBytes?: number | null; ttlMs: number }): NetworkGrant {
    const grant: NetworkGrant = {
      id: `netgrant_${++this.sequence}`,
      endpoints: input.endpoints,
      txBudgetBytes: input.txBudgetBytes ?? null,
      rxBudgetBytes: input.rxBudgetBytes ?? null,
      expiresAt: this.clock.now() + input.ttlMs,
    }
    this.grants.set(grant.id, grant)
    this.usage.set(grant.id, { tx: 0, rx: 0 })
    return grant
  }

  /**
   * Revoke a grant. Existing connections authorized under it are returned so
   * the caller can close them; a revoked grant no longer authorizes anything.
   * @param grantId - the grant to revoke.
   * @returns the live connections that were authorized under the grant.
   */
  revoke(grantId: string): LiveConnection[] {
    this.grants.delete(grantId)
    this.usage.delete(grantId)
    const closed: LiveConnection[] = []
    for (const [id, connection] of this.connections) {
      if (connection.grantId === grantId) {
        closed.push(connection)
        this.connections.delete(id)
      }
    }
    return closed
  }

  /**
   * Authorize one connection attempt against the live grants. `OFFLINE` denies
   * everything before grants are considered; `OBSERVED_ONLINE` refuses a task
   * that requires forced blocking rather than silently degrading.
   * @param request - the connection attempt.
   * @returns the decision.
   */
  authorize(request: NetworkRequest): NetworkDecision {
    if (this.mode === 'OFFLINE') return { kind: 'deny', reason: 'network mode OFFLINE blocks all egress' }
    if (this.mode === 'OBSERVED_ONLINE' && request.requiresForcedBlock === true) {
      return { kind: 'deny', reason: 'network mode OBSERVED_ONLINE cannot promise forced blocking' }
    }
    if (request.endpoint.direction === 'egress' && isProhibitedTarget(request.endpoint.host)) {
      return { kind: 'deny', reason: `target '${request.endpoint.host}' is a prohibited local or metadata address` }
    }
    let denial = 'no network grant covers this endpoint'
    for (const grant of [...this.grants.values()].reverse()) {
      if (this.clock.now() >= grant.expiresAt) {
        denial = 'network grant expired'
        continue
      }
      if (!grant.endpoints.some(endpoint => matches(endpoint, request.endpoint))) continue
      const used = this.usage.get(grant.id) ?? { tx: 0, rx: 0 }
      if (grant.txBudgetBytes !== null && used.tx + request.txBytes > grant.txBudgetBytes) {
        denial = 'network transmit budget exhausted'
        continue
      }
      if (grant.rxBudgetBytes !== null && used.rx + request.rxBytes > grant.rxBudgetBytes) {
        denial = 'network receive budget exhausted'
        continue
      }
      const id = `conn_${++this.connectionSequence}`
      this.connections.set(id, { id, grantId: grant.id, endpoint: request.endpoint })
      return { kind: 'allow', grantId: grant.id }
    }
    return { kind: 'deny', reason: denial }
  }

  /**
   * Meter bytes against a grant.
   * @param grantId - the grant to meter.
   * @param txBytes - transmitted bytes.
   * @param rxBytes - received bytes.
   * @returns the accounting after the update.
   */
  account(grantId: string, txBytes: number, rxBytes: number): NetworkAccounting {
    const grant = this.grants.get(grantId)
    if (grant === undefined) throw new Error(`network grant '${grantId}' does not exist`)
    const used = this.usage.get(grantId) ?? { tx: 0, rx: 0 }
    used.tx += txBytes
    used.rx += rxBytes
    this.usage.set(grantId, used)
    return {
      grantId,
      txBytes: used.tx,
      rxBytes: used.rx,
      txRemaining: grant.txBudgetBytes === null ? null : Math.max(0, grant.txBudgetBytes - used.tx),
      rxRemaining: grant.rxBudgetBytes === null ? null : Math.max(0, grant.rxBudgetBytes - used.rx),
    }
  }
}
