/**
 * External-operation adapter vocabulary. An adapter declares what recovery it
 * can promise (idempotency, query, transaction boundary, compensation,
 * irreversibility); the broker never assumes a capability the adapter did not
 * declare.
 * @module dsh-sandbox-linux/broker/types
 */

/** The recovery kinds an impact or adapter may promise. */
export type RecoveryKind = 'transactional' | 'compensate-only' | 'unknown'

/** The capabilities every external adapter must declare. */
export interface AdapterCapabilities {
  /** Whether the remote supports an idempotency key. */
  readonly supportsIdempotency: boolean
  /** How long the remote retains idempotency records, in milliseconds; `null` when unknown/unbounded. */
  readonly idempotencyRetentionMs: number | null
  /** Whether the remote can be queried for an operation's outcome. */
  readonly supportsQuery: boolean
  /** The transactional boundary the remote can offer. */
  readonly transactionBoundary: 'single-hive' | 'cross-hive' | 'none'
  /** How completely the adapter can compensate a committed effect. */
  readonly compensationSemantics: 'none' | 'best-effort' | 'full'
  /** Whether some effects cannot be undone or queried. */
  readonly irreversibleEffects: boolean
}

/** One external operation the broker invokes. */
export interface ExternalOperation {
  /** The stable operation identity; the idempotency key for the broker. */
  readonly operationId: string
  /** The adapter that owns the operation. */
  readonly adapterId: string
  /** The adapter-defined action name. */
  readonly action: string
  /** The adapter-defined parameters. */
  readonly params: Readonly<Record<string, unknown>>
}

/** The outcome of one external invocation. */
export type BrokerOutcome =
  | { readonly kind: 'succeeded'; readonly detail?: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: 'unknown'; readonly reason: string }

/** One external-operation adapter. */
export interface ExternalAdapter {
  /** The adapter identity. */
  readonly id: string
  /** The declared capabilities. */
  readonly capabilities: AdapterCapabilities
  /**
   * Whether the adapter can run on this host.
   * @returns `true` when the host provides the adapter's subsystem.
   */
  available(): Promise<boolean>
  /**
   * Invoke the operation.
   * @param operation - the operation to invoke.
   * @returns the outcome.
   */
  invoke(operation: ExternalOperation): Promise<BrokerOutcome>
  /**
   * Query an operation's outcome when the remote supports it.
   * @param operationId - the operation identity.
   * @returns the outcome, or `undefined` when unknown.
   */
  query(operationId: string): Promise<BrokerOutcome | undefined>
  /**
   * Compensate a committed effect.
   * @param operation - the operation to compensate.
   * @returns the compensation outcome.
   */
  compensate?(operation: ExternalOperation): Promise<BrokerOutcome>
}
