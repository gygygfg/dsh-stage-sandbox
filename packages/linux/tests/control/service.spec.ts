import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SandboxControl, ControlError, type BackendSelector, type Stager } from '../../src/control/service.ts'
import type { CapabilityReport } from '../../src/pal/index.ts'
import type { Platform, PlanRequest } from '../../src/control/intent.ts'
import { DirectoryPublicationBackend } from '../../src/publish/directory-backend.ts'
import { Publisher } from '../../src/publish/publisher.ts'
import { LeaseRegistry, type Clock } from '../../src/control/lease.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { scanTree } from '../../src/candidate/manifest.ts'
import type { CandidateScope } from '../../src/control/records.ts'

class TestClock implements Clock {
  private value = 0
  now(): number { return this.value }
}

const CAPABILITIES: CapabilityReport['capabilities'] = {
  fileEffectPolicy: 'enforced', isolation: 'partial', resourceLimits: 'absent', syscallPolicy: 'absent',
  fileTransactions: 'absent', fileIdentity: 'absent', reparsePoints: 'absent', networkControl: 'absent',
  integrity: 'absent', privilegeReduction: 'partial',
}

const REPORT: CapabilityReport = { backendId: 'linux', backendVersion: '1', kernelVersion: 'test', capabilities: CAPABILITIES }

function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    tenant: 't1', caller: 'c1', platform: 'linux', mode: 'workspace-write',
    command: { exe: '/bin/echo', argv: ['hi'], cwd: '/w', env: {} },
    workspaceRoot: '/w', inputDigests: ['sha256:in'], clientIdempotencyKey: 'k1',
    ...overrides,
  }
}

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/w'] }

describe('sandbox control plane', () => {
  let root: string
  let backend: DirectoryPublicationBackend
  let leases: LeaseRegistry

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-ctl-'))
    backend = new DirectoryPublicationBackend()
    leases = new LeaseRegistry(new TestClock())
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function makeControl(options: { usable?: boolean; readOnly?: boolean } = {}): { control: SandboxControl; staged: { candidatePath: string } } {
    const selector: BackendSelector = {
      report: (_platform: Platform) => (options.usable === false ? 'unusable' : REPORT),
    }
    const staged = { candidatePath: '' }
    const stager: Stager = {
      async stage() {
        const path = mkdtempSync(join(tmpdir(), 'dsh-stage-'))
        staged.candidatePath = path
        writeFileSync(join(path, 'out.txt'), 'staged output')
        const candidate = freezeCandidate({ path, baseVersion: 'base', scope: SCOPE, entries: scanTree(path), now: 1 })
        return { candidate, impact: { fs: [], process: [], network: [] }, readOnly: options.readOnly === true, evidenceIds: [] }
      },
    }
    const publisher = new Publisher(backend, leases, new TestClock())
    return { control: new SandboxControl({ backends: selector, stager, publisher, leases, clock: new TestClock() }), staged }
  }

  it('submits to AWAITING_EXECUTION_AUTH and binds an execution intent', () => {
    const { control } = makeControl()
    const record = control.submit(request())
    expect(record.state).toBe('AWAITING_EXECUTION_AUTH')
    expect(record.executionIntentHash).toMatch(/^sha256:/)
  })

  it('rejects a plan when the platform backend is unusable', () => {
    const { control } = makeControl({ usable: false })
    const record = control.submit(request())
    expect(record.state).toBe('REJECTED')
  })

  it('replays the same command for an identical idempotent submission', () => {
    const { control } = makeControl()
    const first = control.submit(request())
    const second = control.submit(request())
    expect(second.commandId).toBe(first.commandId)
  })

  it('refuses a different request under the same idempotency key', () => {
    const { control } = makeControl()
    control.submit(request())
    expect(() => control.submit(request({ command: { exe: '/bin/echo', argv: ['different'], cwd: '/w', env: {} } }))).toThrowError(ControlError)
    try {
      control.submit(request({ mode: 'read-only' }))
    } catch (error) {
      expect((error as ControlError).code).toBe('IDEMPOTENCY_MISMATCH')
    }
  })

  it('walks authorize -> stage -> publish to COMMITTED and writes the candidate', async () => {
    const { control } = makeControl()
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old')
    const base = await backend.currentVersion(target)

    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    expect(record.state).toBe('PREFLIGHTED')
    record = await control.stage(record.commandId)
    expect(record.state).toBe('READY_TO_PUBLISH')
    expect(record.candidate).toBeDefined()
    record = await control.publish(record.commandId, target, base)
    expect(record.state).toBe('COMMITTED')
    expect(record.receipt?.newVersion).toBeTruthy()
    expect(readFileSync(join(target, 'out.txt'), 'utf8')).toBe('staged output')
  })

  it('returns CONFLICT when the base moved before publication', async () => {
    const { control } = makeControl()
    const target = join(root, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'old.txt'), 'old')
    const base = await backend.currentVersion(target)
    writeFileSync(join(target, 'old.txt'), 'changed by someone else')

    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    record = await control.stage(record.commandId)
    record = await control.publish(record.commandId, target, base)
    expect(record.state).toBe('CONFLICT')
    expect(readFileSync(join(target, 'old.txt'), 'utf8')).toBe('changed by someone else')
  })

  it('marks a read-only result COMPLETED_READ_ONLY', async () => {
    const { control } = makeControl({ readOnly: true })
    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    record = await control.stage(record.commandId)
    expect(record.state).toBe('COMPLETED_READ_ONLY')
  })

  it('refuses to stage before execution authorization', async () => {
    const { control } = makeControl()
    const record = control.submit(request())
    await expect(control.stage(record.commandId)).rejects.toMatchObject({ code: 'NOT_READY' })
  })
})
