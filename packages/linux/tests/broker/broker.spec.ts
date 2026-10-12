import { describe, expect, it } from 'vitest'
import { ExternalBroker, UnknownAdapterError } from '../../src/broker/broker.ts'
import type { AdapterCapabilities, BrokerOutcome, ExternalAdapter } from '../../src/broker/types.ts'

const CAPS: AdapterCapabilities = {
  supportsIdempotency: true, idempotencyRetentionMs: 1000, supportsQuery: true,
  transactionBoundary: 'none', compensationSemantics: 'full', irreversibleEffects: false,
}

class FakeAdapter implements ExternalAdapter {
  readonly id = 'fake'
  readonly capabilities = CAPS
  calls = 0
  queries = 0
  outcomes: BrokerOutcome[] = []
  compensated = false
  constructor(private readonly available_: boolean = true, private readonly queryResult: BrokerOutcome | undefined = undefined) {}
  async available(): Promise<boolean> { return this.available_ }
  async invoke(): Promise<BrokerOutcome> { this.calls += 1; return this.outcomes.shift() ?? { kind: 'succeeded' } }
  async query(): Promise<BrokerOutcome | undefined> { this.queries += 1; return this.queryResult }
  async compensate(): Promise<BrokerOutcome> { this.compensated = true; return { kind: 'succeeded', detail: 'compensated' } }
}

function op(adapterId = 'fake') {
  return { operationId: 'op1', adapterId, action: 'do', params: {} }
}

describe('external operation broker', () => {
  it('invokes once and replays a recorded terminal outcome by operation id', async () => {
    const broker = new ExternalBroker()
    const adapter = new FakeAdapter()
    broker.register(adapter)
    const first = await broker.invoke(op())
    const second = await broker.invoke(op())
    expect(first).toEqual({ kind: 'succeeded' })
    expect(second).toEqual(first)
    expect(adapter.calls).toBe(1)
  })

  it('refuses an unavailable adapter without invoking it', async () => {
    const broker = new ExternalBroker()
    const adapter = new FakeAdapter(false)
    broker.register(adapter)
    const outcome = await broker.invoke(op())
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false })
    expect(adapter.calls).toBe(0)
  })

  it('records an unknown outcome and reconciles it by query', async () => {
    const broker = new ExternalBroker()
    const adapter = new FakeAdapter(true, { kind: 'succeeded', detail: 'found' })
    adapter.outcomes = [{ kind: 'unknown', reason: 'response lost' }]
    broker.register(adapter)
    expect((await broker.invoke(op())).kind).toBe('unknown')
    expect((await broker.reconcile('op1'))).toEqual({ kind: 'succeeded', detail: 'found' })
    expect(adapter.queries).toBe(1)
  })

  it('leaves a retryable failure unrecorded so a retry re-invokes', async () => {
    const broker = new ExternalBroker()
    const adapter = new FakeAdapter()
    adapter.outcomes = [{ kind: 'failed', reason: 'transient', retryable: true }, { kind: 'succeeded' }]
    broker.register(adapter)
    expect((await broker.invoke(op())).kind).toBe('failed')
    expect((await broker.invoke(op())).kind).toBe('succeeded')
    expect(adapter.calls).toBe(2)
  })

  it('compensates through the adapter and refuses when none is declared', async () => {
    const broker = new ExternalBroker()
    const adapter = new FakeAdapter()
    broker.register(adapter)
    expect((await broker.compensate(op())).kind).toBe('succeeded')
    expect(adapter.compensated).toBe(true)
    const bare: ExternalAdapter = {
      id: 'bare',
      capabilities: CAPS,
      available: async () => true,
      invoke: async () => ({ kind: 'succeeded' }),
      query: async () => undefined,
    }
    broker.register(bare)
    expect((await broker.compensate(op('bare'))).kind).toBe('failed')
  })

  it('throws for an unregistered adapter', async () => {
    const broker = new ExternalBroker()
    await expect(broker.invoke(op('missing'))).rejects.toBeInstanceOf(UnknownAdapterError)
  })
})
