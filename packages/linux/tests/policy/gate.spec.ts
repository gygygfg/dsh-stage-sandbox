import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxControl, type BackendSelector, type Stager } from '../../src/control/service.ts'
import type { CapabilityReport } from '../../src/pal/index.ts'
import type { Platform, PlanRequest } from '../../src/control/intent.ts'
import type { CandidateScope } from '../../src/control/records.ts'
import { freezeCandidate } from '../../src/candidate/freeze.ts'
import { scanTree } from '../../src/candidate/manifest.ts'
import { DirectoryPublicationBackend } from '../../src/publish/directory-backend.ts'
import { Publisher } from '../../src/publish/publisher.ts'
import { LeaseRegistry } from '../../src/control/lease.ts'
import { PolicyEngine } from '../../src/policy/engine.ts'
import { JavaScriptRuleExecutor } from '../../src/policy/javascript.ts'
import { PolicyPublicationGate } from '../../src/policy/gate.ts'
import { rulePackDigest } from '../../src/policy/pack.ts'

const CAPABILITIES: CapabilityReport['capabilities'] = {
  fileEffectPolicy: 'enforced', isolation: 'partial', resourceLimits: 'absent', syscallPolicy: 'absent',
  fileTransactions: 'absent', fileIdentity: 'absent', reparsePoints: 'absent', networkControl: 'absent',
  integrity: 'absent', privilegeReduction: 'partial',
}
const REPORT: CapabilityReport = { backendId: 'linux', backendVersion: '1', kernelVersion: 'test', capabilities: CAPABILITIES }
const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/w'] }

function request(): PlanRequest {
  return {
    tenant: 't', caller: 'c', platform: 'linux', mode: 'workspace-write',
    command: { exe: '/bin/true', argv: [], cwd: '/w', env: {} },
    workspaceRoot: '/w', inputDigests: [], clientIdempotencyKey: 'k1',
  }
}

describe('policy publication gate', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

  function controlWithGate(ruleSource: string | undefined): SandboxControl {
    const engine = new PolicyEngine()
    engine.registerExecutor(new JavaScriptRuleExecutor())
    if (ruleSource !== undefined) {
      const rules = [{ id: 'r', language: 'javascript', source: ruleSource }]
      expect(engine.loadPackJson(JSON.stringify({ id: 'p', version: '1', signature: rulePackDigest(rules), rules }))).toEqual({ ok: true })
    }
    const backends: BackendSelector = { report: (_platform: Platform) => REPORT }
    const stager: Stager = {
      async stage() {
        const path = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
        dirs.push(path)
        writeFileSync(join(path, 'x.txt'), 'x')
        return { candidate: freezeCandidate({ path, baseVersion: 'base', scope: SCOPE, entries: scanTree(path) }), impact: { fs: [], process: [], network: [] }, readOnly: false, evidenceIds: [] }
      },
    }
    const leases = new LeaseRegistry()
    const publisher = new Publisher(new DirectoryPublicationBackend(), leases)
    return new SandboxControl({ backends, stager, publisher, leases, gate: new PolicyPublicationGate(engine) })
  }

  it('advances to READY_TO_PUBLISH when no rule denies', async () => {
    const control = controlWithGate(undefined)
    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    record = await control.stage(record.commandId)
    expect(record.state).toBe('READY_TO_PUBLISH')
  })

  it('fails the candidate when a rule hard-denies', async () => {
    const control = controlWithGate('function evaluate(ctx) { return ctx.deny("PROTECTED_PATH_WRITE"); }')
    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    record = await control.stage(record.commandId)
    expect(record.state).toBe('FAILED')
  })

  it('requires publication authorization when a rule asks', async () => {
    const control = controlWithGate('function evaluate(ctx) { return ctx.ask("NEEDS_REVIEW"); }')
    let record = control.submit(request())
    record = control.authorizeExecution(record.commandId)
    record = await control.stage(record.commandId)
    expect(record.state).toBe('AWAITING_PUBLICATION_AUTH')
  })
})
