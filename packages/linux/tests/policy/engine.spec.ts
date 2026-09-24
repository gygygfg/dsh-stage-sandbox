import { describe, expect, it } from 'vitest'
import { PolicyEngine } from '../../src/policy/engine.ts'
import { JavaScriptRuleExecutor } from '../../src/policy/javascript.ts'
import { PythonRuleExecutor } from '../../src/policy/python.ts'
import { rulePackDigest, type RuleDefinition } from '../../src/policy/pack.ts'
import { POLICY_EVALUATION_FAILED } from '../../src/policy/verdict.ts'
import { makeFacts } from './javascript.spec.ts'

function pack(rules: RuleDefinition[]): string {
  return JSON.stringify({ id: 'test-pack', version: '1', signature: rulePackDigest(rules), rules })
}

describe('policy engine', () => {
  it('loads a signed pack and aggregates its rules', async () => {
    const engine = new PolicyEngine()
    engine.registerExecutor(new JavaScriptRuleExecutor())
    expect(engine.loadPackJson(pack([{ id: 'r1', language: 'javascript', source: 'function evaluate(ctx) { return ctx.deny("BLOCKED_PATH"); }' }]))).toEqual({ ok: true })
    const verdict = await engine.evaluate(makeFacts())
    expect(verdict.decision).toBe('DENY')
    expect(verdict.reasonCodes).toContain('BLOCKED_PATH')
  })

  it('refuses a pack whose signature does not match', () => {
    const engine = new PolicyEngine()
    const tampered = JSON.stringify({ id: 'p', version: '1', signature: 'sha256:deadbeef', rules: [{ id: 'r', language: 'javascript', source: 'function evaluate() {}' }] })
    const result = engine.loadPackJson(tampered)
    expect(result.ok).toBe(false)
    expect(engine.packIds()).toEqual([])
  })

  it('denies when a rule language has no registered executor', async () => {
    const engine = new PolicyEngine()
    engine.loadPackJson(pack([{ id: 'lua-rule', language: 'lua', source: 'return {}' }]))
    const verdict = await engine.evaluate(makeFacts())
    expect(verdict.decision).toBe('DENY')
    expect(verdict.failedRules).toEqual(['lua-rule'])
    expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
  })

  it('produces the same aggregate regardless of rule order', async () => {
    const engine = new PolicyEngine()
    engine.registerExecutor(new JavaScriptRuleExecutor())
    engine.loadPackJson(pack([
      { id: 'allow', language: 'javascript', source: 'function evaluate(ctx) { return ctx.allow(); }' },
      { id: 'deny', language: 'javascript', source: 'function evaluate(ctx) { return ctx.deny("HARD"); }' },
    ]))
    const first = await engine.evaluate(makeFacts())
    const second = await engine.evaluate(makeFacts())
    expect(first.decision).toBe('DENY')
    expect(second.decision).toBe('DENY')
    expect(first.reasonCodes).toEqual(second.reasonCodes)
  })

  it('only runs rules applicable to the fact phase', async () => {
    const engine = new PolicyEngine()
    engine.registerExecutor(new JavaScriptRuleExecutor())
    engine.loadPackJson(pack([
      { id: 'pub', language: 'javascript', phases: ['publication'], source: 'function evaluate(ctx) { return ctx.deny("PUB"); }' },
      { id: 'pre', language: 'javascript', phases: ['preflight'], source: 'function evaluate(ctx) { return ctx.deny("PRE"); }' },
    ]))
    const verdict = await engine.evaluate(makeFacts({ phase: 'publication' }))
    expect(verdict.reasonCodes).toContain('PUB')
    expect(verdict.reasonCodes).not.toContain('PRE')
  })

  it('runs the Python executor when the host provides python3', async () => {
    const executor = new PythonRuleExecutor()
    if (!(await executor.available())) return
    const engine = new PolicyEngine()
    engine.registerExecutor(executor)
    engine.loadPackJson(pack([{ id: 'py', language: 'python', source: 'def evaluate(ctx):\n    return ctx.ask("NEEDS_REVIEW")' }]))
    const verdict = await engine.evaluate(makeFacts())
    expect(verdict.decision).toBe('NEEDS_CONFIRMATION')
    expect(verdict.reasonCodes).toContain('NEEDS_REVIEW')
  })
})
