import { describe, expect, it, vi } from 'vitest'
import { planWorkspaceRedirect, type RedirectWorkspace } from '../../src/subprocess/sandboxed-subprocess.ts'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const REAL = '/ws'
const STAGE = '/stage'

function workspace(): RedirectWorkspace {
  return {
    root: STAGE,
    relativeFor(path: string): string | undefined {
      if (path === REAL) return ''
      if (path.startsWith(`${REAL}/`)) return path.slice(REAL.length + 1)
      if (path === STAGE) return ''
      if (path.startsWith(`${STAGE}/`)) return path.slice(STAGE.length + 1)
      return undefined
    },
    pathFor(path: string): string | undefined {
      if (path === REAL) return STAGE
      if (path.startsWith(`${REAL}/`)) return `${STAGE}${path.slice(REAL.length)}`
      return undefined
    },
    materialize: vi.fn(),
  }
}

const confine = (argv: readonly string[], policy: SandboxPolicy): { argv: readonly string[] } => ({
  argv: ['bwrap', '--bind', policy.workspaceRoot, policy.workspaceRoot, '--', ...argv],
})

describe('sandboxed subprocess redirect', () => {
  it('redirects a workspace-scoped spawn into the staging tree and confines it', () => {
    const ws = workspace()
    const plan = planWorkspaceRedirect({
      argv: ['rg', '--no-config', '--files'],
      cwd: REAL,
      requestedRoot: REAL,
      mode: 'workspace-write',
      isStagingPath: () => false,
      workspace: ws,
      confine,
    })
    expect(ws.materialize).toHaveBeenCalled()
    expect(plan?.cwd).toBe(STAGE)
    expect(plan?.argv.slice(0, 2)).toEqual(['bwrap', '--bind'])
    expect(plan?.argv).toContain(STAGE)
  })

  it('rewrites an absolute workspace path argument to a relative one', () => {
    const plan = planWorkspaceRedirect({
      argv: ['rg', '--json', '--regexp=x', '--', `${REAL}/src`],
      cwd: REAL,
      requestedRoot: REAL,
      mode: 'workspace-write',
      isStagingPath: () => false,
      workspace: workspace(),
      confine,
    })
    expect(plan?.argv.at(-1)).toBe('src')
  })

  it('passes through a spawn outside the workspace', () => {
    const plan = planWorkspaceRedirect({
      argv: ['lsp-server'],
      cwd: '/elsewhere',
      requestedRoot: REAL,
      mode: 'workspace-write',
      isStagingPath: () => false,
      workspace: workspace(),
      confine,
    })
    expect(plan).toBeUndefined()
  })

  it('passes through danger-full-access and already-staged spawns', () => {
    expect(planWorkspaceRedirect({ argv: ['rg'], cwd: REAL, requestedRoot: REAL, mode: 'danger-full-access', isStagingPath: () => false, workspace: workspace(), confine })).toBeUndefined()
    expect(planWorkspaceRedirect({ argv: ['rg'], cwd: `${STAGE}/src`, requestedRoot: REAL, mode: 'workspace-write', isStagingPath: path => path.startsWith(STAGE), workspace: workspace(), confine })).toBeUndefined()
  })

  it('runs at the real path when an overlay is registered', () => {
    const plan = planWorkspaceRedirect({
      argv: ['rg', '--files'],
      cwd: REAL,
      requestedRoot: REAL,
      mode: 'workspace-write',
      isStagingPath: () => false,
      workspace: workspace(),
      confine,
      overlay: true,
    })
    // No rewrite into the staging tree; the provider mounts the overlay at the real root.
    expect(plan?.cwd).toBe(REAL)
    expect(plan?.argv.slice(0, 4)).toEqual(['bwrap', '--bind', REAL, REAL])
    expect(plan?.argv).toContain('rg')
  })

  it('unwraps a pre-confined argv and re-confines it against the staging tree', () => {
    const plan = planWorkspaceRedirect({
      argv: ['bwrap', '--bind', REAL, REAL, '--', '/bin/bash', '--norc'],
      cwd: REAL,
      requestedRoot: REAL,
      mode: 'workspace-write',
      isStagingPath: () => false,
      workspace: workspace(),
      confine,
    })
    // Re-confined once (not nested), with the inner command preserved.
    expect(plan?.argv.filter(entry => entry === 'bwrap')).toHaveLength(1)
    expect(plan?.argv).toContain('/bin/bash')
    expect(plan?.cwd).toBe(STAGE)
    expect(plan?.argv).toContain(STAGE)
  })
})
