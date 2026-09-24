import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StagingStager, type CommandRunner } from '../../src/stage/stager.ts'
import { LogicalWorkspace } from '../../src/workspace/logical.ts'
import type { PlanRequest } from '../../src/control/intent.ts'
import type { CandidateScope } from '../../src/control/records.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

function request(): PlanRequest {
  return {
    tenant: 't1', caller: 'c1', platform: 'linux', mode: 'workspace-write',
    command: { exe: '/bin/true', argv: [], cwd: '/w', env: {} },
    workspaceRoot: '/w', inputDigests: [], clientIdempotencyKey: 'k1',
  }
}

describe('copy-based filesystem stager', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'a.txt'), 'original')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('runs against a private copy and leaves the real workspace untouched', async () => {
    const runner: CommandRunner = {
      async run({ cwd }) {
        writeFileSync(join(cwd, 'src', 'b.txt'), 'generated')
        writeFileSync(join(cwd, 'src', 'a.txt'), 'modified')
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, signalled: false }
      },
    }
    const stager = new StagingStager({ workspaceRoot: workspace, runner, scope: SCOPE, evidenceId: 'ev:1' })
    const result = await stager.stage({ request: request(), executionIntentHash: 'sha256:x', commandId: 'cmd', attemptId: 'att' })

    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('original')
    expect(existsSync(join(workspace, 'src', 'b.txt'))).toBe(false)
    expect(readFileSync(join(result.candidate.path, 'src', 'a.txt'), 'utf8')).toBe('modified')
    expect(existsSync(join(result.candidate.path, 'src', 'b.txt'))).toBe(true)
    expect(result.readOnly).toBe(false)
    expect(result.impact.fs.map(entry => `${entry.kind}:${entry.path}`).sort()).toEqual(['create:src/b.txt', 'write:src/a.txt'])
  })

  it('reports a read-only result when the command changed nothing', async () => {
    const runner: CommandRunner = {
      async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signalled: false } },
    }
    const stager = new StagingStager({ workspaceRoot: workspace, runner, scope: SCOPE })
    const result = await stager.stage({ request: request(), executionIntentHash: 'sha256:x', commandId: 'cmd', attemptId: 'att' })
    expect(result.readOnly).toBe(true)
    expect(result.impact.fs).toEqual([])
    expect(result.candidate.baseVersion).toMatch(/^sha256:/)
  })

  it('records a delete when the command removes a file', async () => {
    const runner: CommandRunner = {
      async run({ cwd }) {
        rmSync(join(cwd, 'src', 'a.txt'))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signalled: false }
      },
    }
    const stager = new StagingStager({ workspaceRoot: workspace, runner, scope: SCOPE })
    const result = await stager.stage({ request: request(), executionIntentHash: 'sha256:x', commandId: 'cmd', attemptId: 'att' })
    expect(result.impact.fs).toEqual([
      expect.objectContaining({ kind: 'delete', path: 'src/a.txt', afterHash: null }),
    ])
  })

  it('runs against the unified workspace projection and diffs relative to its input version', async () => {
    const projection = new LogicalWorkspace({ baseRoot: workspace, scope: SCOPE })
    projection.materialize()
    projection.writeText(join(workspace, 'src', 'a.txt'), 'staged-before-command')
    let observed = ''
    const runner: CommandRunner = {
      async run({ cwd }) {
        observed = readFileSync(join(cwd, 'src', 'a.txt'), 'utf8')
        writeFileSync(join(cwd, 'src', 'generated.txt'), 'generated')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signalled: false }
      },
    }
    const stager = new StagingStager({ workspaceRoot: workspace, runner, scope: SCOPE, projection })
    const result = await stager.stage({ request: request(), executionIntentHash: 'sha256:x', commandId: 'cmd', attemptId: 'att' })
    expect(observed).toBe('staged-before-command')
    // Only the change relative to the input logical version is extracted.
    expect(result.impact.fs.map(entry => `${entry.kind}:${entry.path}`)).toEqual(['create:src/generated.txt'])
    expect(result.candidate.baseVersion).toBe(projection.revisionDigest())
    projection.dispose()
  })
})
