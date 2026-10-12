import { describe, expect, it } from 'vitest'
import { HostOperationRegistry } from '../../src/control/hostop.ts'

describe('host-operation proposals', () => {
  it('freezes a proposal without running it, then replays on approval', async () => {
    const registry = new HostOperationRegistry()
    const proposal = registry.propose({ command: 'systemctl restart nginx', summary: 'restart nginx' })
    expect(proposal.state).toBe('proposed')
    let ran = 0
    const result = await registry.replay(proposal.id, async command => {
      ran += 1
      return { exitCode: 0, stdout: `ran ${command}`, stderr: '' }
    })
    expect(result.kind).toBe('applied')
    expect(ran).toBe(1)
    expect(registry.list()[0]?.state).toBe('applied')
  })

  it('never replays a rejected or unknown proposal', async () => {
    const registry = new HostOperationRegistry()
    const proposal = registry.propose({ command: 'reboot', summary: 'reboot host' })
    expect(registry.reject(proposal.id)).toBe(true)
    expect(registry.reject(proposal.id)).toBe(false)
    let ran = 0
    const run = async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => { ran += 1; return { exitCode: 0, stdout: '', stderr: '' } }
    expect((await registry.replay(proposal.id, run)).kind).toBe('rejected')
    expect((await registry.replay('hostop_missing', run)).kind).toBe('not-found')
    expect(ran).toBe(0)
  })
})
