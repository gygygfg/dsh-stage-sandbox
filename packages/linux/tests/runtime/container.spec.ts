import { describe, expect, it } from 'vitest'
import { planContainerCommand } from '../../src/runtime/container.ts'

describe('container runtime control', () => {
  it('keeps podman inside the sandbox namespaces', () => {
    const plan = planContainerCommand(['podman', 'run', '-it', 'alpine'])
    expect(plan?.engine).toBe('podman')
    expect(plan?.confined).toBe(true)
    expect(plan?.argv).toEqual(['podman', 'run', '--net=host', '--pid=host', '--ipc=host', '--uts=host', '-it', 'alpine'])
  })

  it('does not double-add the namespace flags', () => {
    const argv = ['podman', 'run', '--net=host', '--pid=host', '--ipc=host', '--uts=host', 'alpine']
    expect(planContainerCommand(argv)?.argv).toEqual(argv)
  })

  it('leaves docker unchanged and non-\\-run subcommands alone', () => {
    expect(planContainerCommand(['docker', 'run', 'alpine'])?.confined).toBe(false)
    const exec = planContainerCommand(['podman', 'exec', 'c1', 'ls'])
    expect(exec?.argv).toEqual(['podman', 'exec', 'c1', 'ls'])
    expect(exec?.confined).toBe(true)
  })

  it('ignores non-container commands', () => {
    expect(planContainerCommand(['ls', '-la'])).toBeUndefined()
  })
})
