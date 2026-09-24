import { describe, expect, it } from 'vitest'
import { JavaScriptRuleExecutor } from '../../src/policy/javascript.ts'
import { POLICY_EVALUATION_FAILED } from '../../src/policy/verdict.ts'
import type { PolicyFacts } from '../../src/policy/facts.ts'

export function makeFacts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    schemaVersion: '2.3',
    phase: 'publication',
    platform: 'linux',
    identity: { tenant: 't', caller: 'c' },
    envelope: { mode: 'workspace-write', workspaceRoot: '/w', backendId: 'linux', backendVersion: '1', exe: '/bin/sh', argv: [], cwd: '/w' },
    coverage: { fs: 'complete', process: 'complete', network: 'missing' },
    grants: [],
    ...overrides,
  }
}

const executor = new JavaScriptRuleExecutor()

describe('javascript rule executor', () => {
  it('runs an allow rule', async () => {
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source: 'export function evaluate(ctx) { return ctx.allow(); }' }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('ALLOW')
  })

  it('runs a deny rule with required grants', async () => {
    const source = 'function evaluate(ctx) { return ctx.deny("PROTECTED_PATH_WRITE", { requiredGrants: ["system:protected:write"] }); }'
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('DENY')
    expect(verdict.requiredGrants).toEqual(['system:protected:write'])
  })

  it('denies a rule that reaches for require, process, or eval', async () => {
    for (const source of [
      'function evaluate() { return require("fs"); }',
      'function evaluate() { return process.env; }',
      'function evaluate() { return eval("1+1"); }',
      'function evaluate() { return new Function("return 1")(); }',
      'function evaluate() { return globalThis.constructor.constructor("return 1")(); }',
    ]) {
      const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source }, makeFacts(), { timeoutMs: 500 })
      expect(verdict.decision).toBe('DENY')
      expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
    }
  })

  it('exposes normalizePath and the fact snapshot', async () => {
    const source = 'function evaluate(ctx) { return ctx.normalizePath(ctx.facts.envelope.workspaceRoot + "//a\\\\b") === "/w/a/b" ? ctx.allow() : ctx.deny("BAD"); }'
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('ALLOW')
  })

  it('denies a non-deterministic rule that calls Math.random', async () => {
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source: 'function evaluate() { return Math.random() > 0.5 ? ctx.allow() : ctx.deny("X"); }' }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('DENY')
    expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
  })

  it('denies a rule that times out', async () => {
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source: 'function evaluate() { while (true) {} }' }, makeFacts(), { timeoutMs: 100 })
    expect(verdict.decision).toBe('DENY')
    expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
  })

  it('denies malformed output', async () => {
    const verdict = await executor.evaluate({ id: 'r', language: 'javascript', source: 'function evaluate() { return 42; }' }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('DENY')
  })
})
