import { describe, expect, it } from 'vitest'
import { PythonRuleExecutor } from '../../src/policy/python.ts'
import { POLICY_EVALUATION_FAILED } from '../../src/policy/verdict.ts'
import { makeFacts } from './javascript.spec.ts'

const executor = new PythonRuleExecutor()
const available = await executor.available()

describe.skipIf(!available)('python rule executor', () => {
  it('runs an allow rule', async () => {
    const verdict = await executor.evaluate({ id: 'r', language: 'python', source: 'def evaluate(ctx):\n    return ctx.allow()' }, makeFacts(), { timeoutMs: 1000 })
    expect(verdict.decision).toBe('ALLOW')
  })

  it('runs a deny rule with required grants', async () => {
    const source = 'def evaluate(ctx):\n    return ctx.deny("NETWORK_EGRESS_WITHOUT_GRANT", required_grants=["network:egress"])'
    const verdict = await executor.evaluate({ id: 'r', language: 'python', source }, makeFacts(), { timeoutMs: 1000 })
    expect(verdict.decision).toBe('DENY')
    expect(verdict.requiredGrants).toEqual(['network:egress'])
  })

  it('denies import, open, and dunder traversal', async () => {
    for (const source of [
      'def evaluate(ctx):\n    import os\n    return ctx.allow()',
      'def evaluate(ctx):\n    open("/etc/passwd")\n    return ctx.allow()',
      'def evaluate(ctx):\n    return ctx.__class__',
      'def evaluate(ctx):\n    return ().__class__.__base__.__subclasses__()',
      'def evaluate(ctx):\n    return eval("1+1")',
    ]) {
      const verdict = await executor.evaluate({ id: 'r', language: 'python', source }, makeFacts(), { timeoutMs: 1000 })
      expect(verdict.decision).toBe('DENY')
      expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
    }
  })

  it('denies a rule that times out', async () => {
    const source = 'def evaluate(ctx):\n    while True:\n        pass'
    const verdict = await executor.evaluate({ id: 'r', language: 'python', source }, makeFacts(), { timeoutMs: 500 })
    expect(verdict.decision).toBe('DENY')
    expect(verdict.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
  })
})
