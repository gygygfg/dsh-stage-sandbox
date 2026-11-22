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

  it('finds run/create after global options that take a value', () => {
    const byLogLevel = planContainerCommand(['podman', '--log-level', 'debug', 'run', '-it', 'alpine'])
    expect(byLogLevel?.argv).toEqual(['podman', '--log-level', 'debug', 'run', '--net=host', '--pid=host', '--ipc=host', '--uts=host', '-it', 'alpine'])
    const byRoot = planContainerCommand(['podman', '--root', '/tmp/x', 'run', 'alpine'])
    expect(byRoot?.argv).toEqual(['podman', '--root', '/tmp/x', 'run', '--net=host', '--pid=host', '--ipc=host', '--uts=host', 'alpine'])
  })

  it('handles the grouped `container run` form', () => {
    const plan = planContainerCommand(['podman', 'container', 'run', 'alpine'])
    expect(plan?.argv).toEqual(['podman', 'container', 'run', '--net=host', '--pid=host', '--ipc=host', '--uts=host', 'alpine'])
  })

  it('recognizes the space-separated namespace flag form', () => {
    const argv = ['podman', 'run', '--net', 'host', '--pid', 'host', '--ipc', 'host', '--uts', 'host', 'alpine']
    expect(planContainerCommand(argv)?.argv).toEqual(argv)
  })

  it('does not treat an exec container named "run" as a run subcommand', () => {
    const argv = ['podman', 'exec', 'run', 'ls']
    expect(planContainerCommand(argv)?.argv).toEqual(argv)
  })

  it('ignores non-container commands', () => {
    expect(planContainerCommand(['ls', '-la'])).toBeUndefined()
  })
})
