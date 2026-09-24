import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileControlStore } from '../../src/control/store.ts'
import type { OperationRecord } from '../../src/control/records.ts'
import type { PlanRequest } from '../../src/control/intent.ts'

function record(commandId: string, key: string): OperationRecord {
  const request: PlanRequest = {
    tenant: 't', caller: 'c', platform: 'linux', mode: 'workspace-write',
    command: { exe: '/bin/true', argv: [], cwd: '/w', env: {} },
    workspaceRoot: '/w', inputDigests: [], clientIdempotencyKey: key,
  }
  return { commandId, attemptId: 'a', tenant: 't', caller: 'c', clientIdempotencyKey: key, requestHash: 'h', platform: 'linux', request, state: 'RECEIVED', stateVersion: 0, events: [] }
}

describe('file-backed control store', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-ctl-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('persists a created record and its commits across a restart', () => {
    const first = new FileControlStore(dir)
    first.create(record('cmd1', 'k1'))
    first.commit('cmd1', 0, 'parsed', 'PARSED', { executionIntentHash: 'intent-1' })

    const reloaded = new FileControlStore(dir)
    const found = reloaded.get('cmd1')
    expect(found?.state).toBe('PARSED')
    expect(found?.stateVersion).toBe(1)
    expect(found?.executionIntentHash).toBe('intent-1')
    expect(found?.events).toHaveLength(1)
    expect(reloaded.findByIdempotencyKey('t', 'c', 'k1')?.commandId).toBe('cmd1')
  })

  it('enforces optimistic concurrency on the reloaded store', () => {
    const store = new FileControlStore(dir)
    store.create(record('cmd2', 'k2'))
    store.commit('cmd2', 0, 'parsed', 'PARSED')
    expect(() => store.commit('cmd2', 0, 'parsed', 'PARSED')).toThrow(/version conflict/u)
  })
})
