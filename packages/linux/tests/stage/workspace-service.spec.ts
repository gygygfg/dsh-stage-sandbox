import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { WorkspaceStagingService } from '../../src/stage/workspace-service.ts'
import PolicyEngine from '../../src/policy/plugin.ts'

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

describe('workspace service branches and integrity', () => {
  let workspace: string
  let ctx: Context

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'a.txt'), 'original')
    ctx = new Context()
    await ctx.plugin(FakeSandboxPolicy as never, { mode: 'workspace-write', workspaceRoot: workspace } as never)
    await ctx.plugin(PolicyEngine as never, { defaultTimeoutMs: 2000, python: false, packs: [] } as never)
    await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace })
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('keeps branches isolated', () => {
    const main = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    const feature = ctx.sandboxWorkspace.branchFor(workspace, 'feature')
    main.materialize()
    feature.materialize()
    main.writeText(join(workspace, 'src', 'a.txt'), 'main-edit')
    feature.writeText(join(workspace, 'src', 'a.txt'), 'feature-edit')
    expect(main.readText(join(workspace, 'src', 'a.txt'))).toBe('main-edit')
    expect(feature.readText(join(workspace, 'src', 'a.txt'))).toBe('feature-edit')
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('original')
  })

  it('publishes a deletion recorded as a persistent marker', async () => {
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.remove(join(workspace, 'src', 'a.txt'))
    expect(branch.readText(join(workspace, 'src', 'a.txt'))).toBeUndefined()
    // A delete is a dangerous operation: it is frozen and held for confirmation.
    const held = await ctx.sandboxWorkspace.apply(workspace)
    expect(held.kind).toBe('needs-authorization')
    expect(held.danger?.dangerous).toBe(true)
    expect(existsSync(join(workspace, 'src', 'a.txt'))).toBe(true)
    // Confirming publishes it.
    const result = await ctx.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(result.kind).toBe('published')
    expect(existsSync(join(workspace, 'src', 'a.txt'))).toBe(false)
  })

  it('blocks publication when the logical view is corrupted', async () => {
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.writeText(join(workspace, 'src', 'a.txt'), 'staged')
    // Simulate a lost staged object without a deletion marker.
    rmSync(join(branch.root, 'src', 'a.txt'))
    const result = await ctx.sandboxWorkspace.apply(workspace)
    expect(result.kind).toBe('corrupted')
    expect(result.corrupted?.map(record => record.relative)).toContain('src/a.txt')
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('original')
  })

  it('binds a session to a branch', () => {
    ctx.sandboxWorkspace.bindSession('session-1', workspace, 'feature')
    expect(ctx.sandboxWorkspace.branchOfSession('session-1')).toEqual({ workspaceRoot: workspace, branchId: 'feature' })
    expect(ctx.sandboxWorkspace.branchOfSession('missing')).toBeUndefined()
  })

  it('freezes a dangerous change and holds it until confirmed', async () => {
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.writeText(join(workspace, '.git', 'config'), '[core]\n')
    const state = ctx.sandboxWorkspace.state(workspace)
    expect(state.danger.dangerous).toBe(true)
    expect(state.danger.reasons.map(reason => reason.code)).toContain('SENSITIVE_PATH')

    const held = await ctx.sandboxWorkspace.apply(workspace)
    expect(held.kind).toBe('needs-authorization')
    expect(ctx.sandboxWorkspace.state(workspace).pending).not.toBeNull()
    expect(existsSync(join(workspace, '.git', 'config'))).toBe(false)

    const confirmed = await ctx.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(confirmed.kind).toBe('published')
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('applies one file and leaves the rest pending (selective publication)', async () => {
    writeFileSync(join(workspace, 'src', 'b.txt'), 'base-b')
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.writeText(join(workspace, 'src', 'a.txt'), 'A')
    branch.writeText(join(workspace, 'src', 'b.txt'), 'B')

    const first = await ctx.sandboxWorkspace.apply(workspace, { files: [join(workspace, 'src', 'a.txt')], confirm: true })
    expect(first.kind).toBe('published')
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(workspace, 'src', 'b.txt'), 'utf8')).toBe('base-b')
    // Only the unapplied change remains pending.
    expect(ctx.sandboxWorkspace.state(workspace).changes.map(change => change.path)).toEqual(['src/b.txt'])

    const second = await ctx.sandboxWorkspace.apply(workspace, { confirm: true })
    expect(second.kind).toBe('published')
    expect(readFileSync(join(workspace, 'src', 'b.txt'), 'utf8')).toBe('B')
  })

  it('auto-applies a dangerous change covered by a narrow grant', async () => {
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.writeText(join(workspace, 'src', 'a.txt'), 'granted')
    const grant = ctx.sandboxWorkspace.issueGrant({ taskId: 'task', roots: [workspace], operations: ['apply'], fileBudget: 10, ttlMs: 1000 })
    expect(grant.id).toMatch(/^grant_/u)
    // The covering grant removes the confirmation requirement.
    const applied = await ctx.sandboxWorkspace.apply(workspace)
    expect(applied.kind).toBe('published')
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('granted')
  })

  it('rejects one staged file back to the base', () => {
    const branch = ctx.sandboxWorkspace.branchFor(workspace, 'main')
    branch.materialize()
    branch.writeText(join(workspace, 'src', 'a.txt'), 'A')
    expect(ctx.sandboxWorkspace.rejectFile(workspace, join(workspace, 'src', 'a.txt'))).toBe(true)
    expect(branch.readText(join(workspace, 'src', 'a.txt'))).toBe('original')
    expect(ctx.sandboxWorkspace.state(workspace).changes).toEqual([])
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('original')
  })
})
