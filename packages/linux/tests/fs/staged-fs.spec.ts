import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { StagedFileSystem } from '../../src/fs/staged-fs.ts'
import { WorkspaceStagingService } from '../../src/stage/workspace-service.ts'
import PolicyEngine from '../../src/policy/plugin.ts'
import { rulePackDigest } from '../../src/policy/pack.ts'

/** A minimal `ctx.sandboxPolicy` for the test: a fixed mode and root. */
class FakeSandboxPolicy extends Service {
  readonly defaultMode: SandboxMode
  private readonly root: string
  constructor(ctx: Context, config: { mode: SandboxMode; workspaceRoot: string }) {
    super(ctx, 'sandboxPolicy')
    this.defaultMode = config.mode
    this.root = config.workspaceRoot
  }
  resolve(): SandboxExecutionPolicy {
    return { mode: this.defaultMode, workspaceRoot: this.root }
  }
}

describe('staged filesystem', () => {
  let workspace: string
  let ctx: Context

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dsh-fs-'))
    writeFileSync(join(workspace, 'a.txt'), 'original')
    ctx = new Context()
    await ctx.plugin(FakeSandboxPolicy as never, { mode: 'workspace-write', workspaceRoot: workspace } as never)
    await ctx.plugin(PolicyEngine as never, { defaultTimeoutMs: 2000, python: false, packs: [] } as never)
    await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace })
    await ctx.plugin(StagedFileSystem as never, { cwd: workspace } as never)
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('stages a write without touching the real file, then applies it', async () => {
    const target = await ctx.fs.resolve(join(workspace, 'a.txt'))
    await ctx.fs.writeText(target, 'staged')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')

    const staged = await ctx.fs.resolve(join(workspace, 'a.txt'))
    expect(await ctx.fs.readText(staged)).toBe('staged')

    // An ordinary workspace write is L1 (green) and still needs one confirmation.
    const state = ctx.sandboxWorkspace.state(workspace)
    expect(state.danger.level).toBe('L1')
    expect(state.danger.marker).toBe('green')
    const held = await ctx.sandboxWorkspace.apply(workspace)
    expect(held.kind).toBe('needs-authorization')

    const applied = await ctx.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(applied.kind).toBe('published')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('staged')
  })

  it('stages a create and applies it', async () => {
    const target = await ctx.fs.resolve(join(workspace, 'b.txt'))
    await ctx.fs.writeText(target, 'created')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')
    const applied = await ctx.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(applied.kind).toBe('published')
    expect(readFileSync(join(workspace, 'b.txt'), 'utf8')).toBe('created')
  })

  it('discards staged changes', async () => {
    const target = await ctx.fs.resolve(join(workspace, 'a.txt'))
    await ctx.fs.writeText(target, 'staged')
    ctx.sandboxWorkspace.discard(workspace)
    expect(ctx.sandboxWorkspace.state(workspace).materialized).toBe(false)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')
  })

  it('refuses a write under read-only mode', async () => {
    const readOnly = new Context()
    await readOnly.plugin(FakeSandboxPolicy as never, { mode: 'read-only', workspaceRoot: workspace } as never)
    await readOnly.plugin(PolicyEngine as never, { defaultTimeoutMs: 2000, python: false, packs: [] } as never)
    await readOnly.plugin(WorkspaceStagingService, { workspaceRoot: workspace })
    await readOnly.plugin(StagedFileSystem as never, { cwd: workspace } as never)
    const target = await readOnly.fs.resolve(join(workspace, 'a.txt'))
    await expect(readOnly.fs.writeText(target, 'nope')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')
  })

  it('refuses to apply when a policy rule hard-denies the candidate', async () => {
    const guarded = new Context()
    const rules = [{ id: 'deny-all', language: 'javascript', source: 'function evaluate(ctx) { return ctx.deny("WORKSPACE_WRITE_DENIED"); }' }]
    const pack = JSON.stringify({ id: 'guard', version: '1', signature: rulePackDigest(rules), rules })
    await guarded.plugin(FakeSandboxPolicy as never, { mode: 'workspace-write', workspaceRoot: workspace } as never)
    await guarded.plugin(PolicyEngine as never, { defaultTimeoutMs: 2000, python: false, packs: [pack] } as never)
    await guarded.plugin(WorkspaceStagingService, { workspaceRoot: workspace })
    await guarded.plugin(StagedFileSystem as never, { cwd: workspace } as never)
    const target = await guarded.fs.resolve(join(workspace, 'a.txt'))
    await guarded.fs.writeText(target, 'staged')
    const result = await guarded.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(result.kind).toBe('denied')
    expect(result.reasonCodes).toContain('WORKSPACE_WRITE_DENIED')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original')
  })
})
