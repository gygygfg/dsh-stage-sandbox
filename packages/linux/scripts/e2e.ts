/**
 * End-to-end dry-run/commit smoke through the real `ctx.sandbox` backend: a
 * command writes into the private staging copy, the real workspace is
 * untouched until publication, and the CAS publish applies the frozen
 * candidate.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Provider from '../src/index.ts'
import Control from '../src/control/plugin.ts'
import PolicyEngine from '../src/policy/plugin.ts'
import type { PlanRequest } from '../src/control/intent.ts'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
writeFileSync(join(workspace, 'a.txt'), 'base')

const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value

const ctx = new Context()
await ctx.plugin(Provider)
await ctx.plugin(PolicyEngine, { defaultTimeoutMs: 2000, python: false, packs: [] })
await ctx.plugin(Control, { workspaceRoot: workspace })

const request: PlanRequest = {
  tenant: 't', caller: 'c', platform: 'linux', mode: 'workspace-write',
  command: { exe: '/bin/sh', argv: ['-c', 'echo generated > generated.txt'], cwd: workspace, env },
  workspaceRoot: workspace, inputDigests: [], clientIdempotencyKey: 'k1',
}

let record = ctx.sandboxControl.submit(request)
console.log('submitted:', record.state)
record = ctx.sandboxControl.authorizeExecution(record.commandId)
record = await ctx.sandboxControl.stage(record.commandId)
console.log('staged:', record.state, 'candidate:', record.candidate?.digest)
console.log('workspace untouched before publish:', !existsSync(join(workspace, 'generated.txt')))

record = await ctx.sandboxControl.publish(record.commandId, workspace, record.candidate?.baseVersion ?? '')
console.log('published:', record.state)
console.log('generated.txt:', readFileSync(join(workspace, 'generated.txt'), 'utf8').trim())

rmSync(workspace, { recursive: true, force: true })
