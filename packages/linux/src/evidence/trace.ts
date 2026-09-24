/**
 * Out-of-bounds trace (v2.3 §12). A read outside the workspace leaves a trace
 * record once per (tool, path), so the model's reach is visible in review
 * without flooding it with repeats. A trace is non-blocking by design: it
 * records an observation, it does not authorize or deny the read.
 * @module dsh-sandbox-linux/evidence/trace
 */

import { systemClock, type Clock } from '../control/lease.ts'

/** One traced out-of-bounds access. */
export interface TraceRecord {
  /** The dedup key (`tool\0path`). */
  readonly key: string
  /** The tool that made the access. */
  readonly tool: string
  /** The path accessed outside the workspace. */
  readonly path: string
  /** The access kind. */
  readonly kind: 'read' | 'list' | 'search' | 'exec'
  /** Epoch milliseconds of the first observation. */
  readonly at: number
  /** How many times the access was observed. */
  readonly count: number
}

/** A sink that persists trace records (e.g. the evidence store). */
export interface TraceSink {
  /** Record one trace. */
  add(kind: 'observe', data: Record<string, unknown>): string
}

/**
 * The deduplicating trace log.
 */
export class TraceLog {
  private readonly records = new Map<string, TraceRecord>()
  private readonly sink: TraceSink | undefined
  private readonly clock: Clock

  /**
   * @param sink - an optional evidence sink.
   * @param clock - the clock used for trace timestamps.
   */
  constructor(sink?: TraceSink, clock: Clock = systemClock) {
    this.sink = sink
    this.clock = clock
  }

  /**
   * Record an access. A repeat (same tool and path) increments the count and
   * returns `undefined` so the caller emits no new evidence.
   * @param input - the tool, path, and access kind.
   * @returns the new record, or `undefined` for a repeat.
   */
  record(input: { tool: string; path: string; kind: TraceRecord['kind'] }): TraceRecord | undefined {
    const key = `${input.tool}\u0000${input.path}`
    const existing = this.records.get(key)
    if (existing !== undefined) {
      this.records.set(key, { ...existing, count: existing.count + 1 })
      return undefined
    }
    const record: TraceRecord = { key, tool: input.tool, path: input.path, kind: input.kind, at: this.clock.now(), count: 1 }
    this.records.set(key, record)
    this.sink?.add('observe', { trace: 'out-of-bounds', tool: input.tool, path: input.path, kind: input.kind })
    return record
  }

  /** Every trace, oldest first. */
  list(): TraceRecord[] {
    return [...this.records.values()]
  }
}
