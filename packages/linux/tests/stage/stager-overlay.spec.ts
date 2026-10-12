import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StagingStager, type CommandRunner } from '../../src/stage/stager.ts'
import type { PlanRequest } from '../../src/control/intent.ts'
import type { CandidateScope } from '../../src/control/records.ts'
import type { OverlaySpec } from '../../src/runtime/profile.ts'

const SCOPE: CandidateScope = { categories: ['filesystem'], writableRoots: ['/'] }

function request(): PlanRequest {
  return {
    tenant: 't1', caller: 'c1', platform: 'linux', mode: 'workspace-write',
    command: { exe: '/bin/true', argv: [], cwd: '/w', env: {} },
    workspaceRoot: '/w', inputDigests: [], clientIdempotencyKey: 'k1',
  }
}

describe('overlay-based filesystem stager', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'dsh-overlay-ws-'))
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'a.txt'), 'original')
    writeFileSync(join(workspace, 'src', 'keep.txt'), 'keep')
  })

  afterEach(() => rmSync(workspace, { recursive: true, force: true }))

  it('runs at the real workspace path and captures only the delta into the overlay upper', async () => {
    let overlay: OverlaySpec | undefined
    const confineOverlay = (argv: readonly string[], _policy: SandboxPolicy, spec: OverlaySpec): ConfinedArgv => {
      overlay = spec
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
    const runner: CommandRunner = {
      async run({ cwd }) {
        // The command runs against the real workspace path (overlay lower).
        expect(cwd).toBe(workspace)
        expect(overlay).toBeDefined()
        // Emulate overlay writes landing in the private upper layer.
        mkdirSync(join(overlay!.upper, 'src'), { recursive: true })
        writeFileSync(join(overlay!.upper, 'src', 'b.txt'), 'generated')
        writeFileSync(join(overlay!.upper, 'src', 'a.txt'), 'modified')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, signalled: false }
      },
    }
    const stager = new StagingStager({ workspaceRoot: workspace, runner, confineOverlay, scope: SCOPE, evidenceId: 'ev:1' })
    const result = await stager.stage({ request: request(), executionIntentHash: 'sha256:x', commandId: 'cmd', attemptId: 'att' })

    // The real workspace is untouched.
    expect(readFileSync(join(workspace, 'src', 'a.txt'), 'utf8')).toBe('original')
    expect(existsSync(join(workspace, 'src', 'b.txt'))).toBe(false)
    // The candidate is a delta: only changed content is on disk...
    expect(readFileSync(join(result.candidate.path, 'src', 'a.txt'), 'utf8')).toBe('modified')
    expect(existsSync(join(result.candidate.path, 'src', 'keep.txt'))).toBe(false)
    // ...but the entry list is the complete logical manifest.
    expect(result.candidate.entries?.map(entry => entry.path)).toContain('src/keep.txt')
    expect(result.impact.fs.map(entry => `${entry.kind}:${entry.path}`).sort()).toEqual(['create:src/b.txt', 'write:src/a.txt'])
  })
})
