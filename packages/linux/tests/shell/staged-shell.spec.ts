import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { StagedShellExecutor } from '../../src/shell/staged-shell.ts'
import { WorkspaceStagingService } from '../../src/stage/workspace-service.ts'
import PolicyEngine from '../../src/policy/plugin.ts'

class FakeSandboxPolicy extends Service {
  readonly defaultMode = 'workspace-write'
  private readonly root: string
  constructor(ctx: Context, config: { workspaceRoot: string }) {
    super(ctx, 'sandboxPolicy')
    this.root = config.workspaceRoot
  }
  resolve(): SandboxExecutionPolicy {
    return { mode: this.defaultMode, workspaceRoot: this.root }
  }
}
class FakeSandbox extends Service { constructor(ctx: Context) { super(ctx, 'sandbox') } }
class FakeSubprocess extends Service { constructor(ctx: Context) { super(ctx, 'subprocess') } }

/** Exposes the protected redirection for a unit assertion. */
class TestShell extends StagedShellExecutor {
  expose(spec: ShellExecSpec): ShellExecSpec { return this.stagedSpec(spec) }
}

const FULL_CONFIG = { cwd: '/', timeoutMs: 1000, maxTimeoutMs: 2000, maxOutputBytes: 1000, maxSpillBytes: 1000, graceMs: 100 }

describe('staged shell executor redirection', () => {
  let workspace: string
  let ctx: Context

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dsh-sh-'))
    writeFileSync(join(workspace, 'a.txt'), 'x')
    ctx = new Context()
    await ctx.plugin(FakeSandboxPolicy as never, { workspaceRoot: workspace } as never)
    await ctx.plugin(FakeSandbox as never, {} as never)
    await ctx.plugin(FakeSubprocess as never, {} as never)
    await ctx.plugin(PolicyEngine as never, { defaultTimeoutMs: 2000, python: false, packs: [] } as never)
    await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace })
    await ctx.plugin(TestShell as never, { ...FULL_CONFIG, cwd: workspace } as never)
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  function spec(policy?: SandboxExecutionPolicy): ShellExecSpec {
    return { command: 'echo hi', workdir: workspace, timeoutMs: 1000, stdoutMaxBytes: 1000, sandboxPolicy: policy }
  }

  it('redirects workdir and workspace root into the overlay', () => {
    const shell = ctx.shell as unknown as TestShell
    const policy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
    const staged = shell.expose(spec(policy))
    expect(staged.workdir).not.toBe(workspace)
    expect(staged.workdir.startsWith(ctx.sandboxWorkspace.workspaceFor(workspace).root)).toBe(true)
    expect(staged.sandboxPolicy?.workspaceRoot).toBe(ctx.sandboxWorkspace.workspaceFor(workspace).root)
  })

  it('leaves a danger-full-access spec unchanged', () => {
    const shell = ctx.shell as unknown as TestShell
    const original = spec({ mode: 'danger-full-access', workspaceRoot: workspace })
    const staged = shell.expose(original)
    expect(staged).toBe(original)
  })
})
