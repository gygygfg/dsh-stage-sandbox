import { describe, expect, it } from 'vitest'
import { TraceLog, type TraceSink } from '../../src/evidence/trace.ts'

class RecordingSink implements TraceSink {
  readonly records: Record<string, unknown>[] = []
  add(_kind: 'observe', data: Record<string, unknown>): string {
    this.records.push(data)
    return `ev_${this.records.length}`
  }
}

describe('out-of-bounds trace', () => {
  it('records the first access and dedups repeats', () => {
    const sink = new RecordingSink()
    const log = new TraceLog(sink)
    expect(log.record({ tool: 'read_file', path: '/etc/hosts', kind: 'read' })?.path).toBe('/etc/hosts')
    expect(log.record({ tool: 'read_file', path: '/etc/hosts', kind: 'read' })).toBeUndefined()
    log.record({ tool: 'read_file', path: '/etc/passwd', kind: 'read' })
    expect(log.list()).toHaveLength(2)
    expect(log.list()[0]?.count).toBe(2)
    expect(sink.records).toHaveLength(2)
  })
})
