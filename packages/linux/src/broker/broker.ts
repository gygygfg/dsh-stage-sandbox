/**
 * The external-operation broker. It owns the adapter table and the durable
 * outcome log, invokes an adapter only after confirming it is available, and
 * deduplicates by operation id. An `unknown` outcome is recorded as unknown
 * and reconciled by query; it is never reported as success, rolled back, or
 * safely retryable.
 * @module dsh-sandbox-linux/broker/broker
 */

import type { AdapterCapabilities, BrokerOutcome, ExternalAdapter, ExternalOperation } from './types.ts'

/** Thrown when an operation names an unregistered adapter. */
export class UnknownAdapterError extends Error {
  /**
   * @param adapterId - the missing adapter id.
   */
  constructor(adapterId: string) {
    super(`external adapter '${adapterId}' is not registered`)
    this.name = 'UnknownAdapterError'
  }
}

/** One recorded operation outcome. */
interface OperationRecord {
  readonly operation: ExternalOperation
  readonly outcome: BrokerOutcome
}

/**
 * The broker. It is process-local in this increment; a durable implementation
 * persists the outcome log behind the same contract.
 */
export class ExternalBroker {
  private readonly adapters = new Map<string, ExternalAdapter>()
  private readonly records = new Map<string, OperationRecord>()

  /**
   * Register an adapter.
   * @param adapter - the adapter to register.
   * @returns the disposer that removes it.
   */
  register(adapter: ExternalAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error(`external adapter '${adapter.id}' is already registered`)
    this.adapters.set(adapter.id, adapter)
    return () => { if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id) }
  }

  /**
   * The declared capabilities of an adapter.
   * @param adapterId - the adapter id.
   * @returns the capabilities.
   * @throws UnknownAdapterError when the adapter is not registered.
   */
  capabilitiesOf(adapterId: string): AdapterCapabilities {
    return this.requireAdapter(adapterId).capabilities
  }

  /**
   * Invoke an operation. A repeated invocation of the same operation id with a
   * recorded terminal outcome returns that outcome without re-invoking.
   * @param operation - the operation to invoke.
   * @returns the outcome.
   */
  async invoke(operation: ExternalOperation): Promise<BrokerOutcome> {
    const recorded = this.records.get(operation.operationId)
    if (recorded !== undefined) return recorded.outcome
    const adapter = this.requireAdapter(operation.adapterId)
    if (!(await adapter.available())) {
      return { kind: 'failed', reason: `adapter '${adapter.id}' is unavailable on this host`, retryable: false }
    }
    const outcome = await adapter.invoke(operation)
    // A failed retryable outcome is not terminal; leave it unrecorded so a
    // caller may retry the same stable operation id.
    if (outcome.kind === 'succeeded' || (outcome.kind === 'failed' && !outcome.retryable)) {
      this.records.set(operation.operationId, { operation, outcome })
    }
    if (outcome.kind === 'unknown') this.records.set(operation.operationId, { operation, outcome })
    return outcome
  }

  /**
   * Reconcile an operation whose outcome was unknown.
   * @param operationId - the operation identity.
   * @returns the recorded or queried outcome, or `undefined` when still unknown.
   */
  async reconcile(operationId: string): Promise<BrokerOutcome | undefined> {
    const recorded = this.records.get(operationId)
    if (recorded === undefined) return undefined
    if (recorded.outcome.kind !== 'unknown') return recorded.outcome
    const adapter = this.adapters.get(recorded.operation.adapterId)
    if (adapter === undefined || !adapter.capabilities.supportsQuery) return undefined
    const queried = await adapter.query(operationId)
    if (queried !== undefined && queried.kind !== 'unknown') {
      this.records.set(operationId, { operation: recorded.operation, outcome: queried })
    }
    return queried
  }

  /**
   * Compensate a committed operation.
   * @param operation - the operation to compensate.
   * @returns the compensation outcome.
   */
  async compensate(operation: ExternalOperation): Promise<BrokerOutcome> {
    const adapter = this.requireAdapter(operation.adapterId)
    if (adapter.compensate === undefined) {
      return { kind: 'failed', reason: `adapter '${adapter.id}' declares no compensation`, retryable: false }
    }
    return adapter.compensate(operation)
  }

  /**
   * The adapters registered, for diagnostics.
   * @returns a snapshot array of adapter ids.
   */
  adapterIds(): string[] {
    return [...this.adapters.keys()]
  }

  /** Resolve an adapter or throw. */
  private requireAdapter(adapterId: string): ExternalAdapter {
    const adapter = this.adapters.get(adapterId)
    if (adapter === undefined) throw new UnknownAdapterError(adapterId)
    return adapter
  }
}
