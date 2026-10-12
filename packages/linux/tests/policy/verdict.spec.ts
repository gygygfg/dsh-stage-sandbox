import { describe, expect, it } from 'vitest'
import { aggregate, POLICY_EVALUATION_FAILED, failureVerdict, type RuleVerdict } from '../../src/policy/verdict.ts'

const allow: RuleVerdict = { decision: 'ALLOW', reasonCodes: [], requiredGrants: [], constraints: {} }
const ask = (code: string): RuleVerdict => ({ decision: 'NEEDS_CONFIRMATION', reasonCodes: [code], requiredGrants: [code], constraints: {} })
const deny = (code: string): RuleVerdict => ({ decision: 'DENY', reasonCodes: [code], requiredGrants: [], constraints: {} })

describe('policy verdict aggregation', () => {
  it('is ALLOW only when every rule allows', () => {
    expect(aggregate([{ id: 'a', verdict: allow }, { id: 'b', verdict: allow }]).decision).toBe('ALLOW')
  })

  it('lets DENY beat NEEDS_CONFIRMATION regardless of order', () => {
    const a = aggregate([{ id: 'a', verdict: ask('ASK') }, { id: 'b', verdict: deny('HARD') }])
    const b = aggregate([{ id: 'b', verdict: deny('HARD') }, { id: 'a', verdict: ask('ASK') }])
    expect(a.decision).toBe('DENY')
    expect(b.decision).toBe('DENY')
    expect(a.reasonCodes).toContain('HARD')
    expect(a.reasonCodes).toContain('ASK')
  })

  it('treats a failed rule as DENY and records it', () => {
    const result = aggregate([{ id: 'broken', verdict: failureVerdict('boom') }])
    expect(result.decision).toBe('DENY')
    expect(result.failedRules).toEqual(['broken'])
    expect(result.reasonCodes).toContain(POLICY_EVALUATION_FAILED)
  })

  it('unions required grants and intersects numeric constraints strictly', () => {
    const result = aggregate([
      { id: 'a', verdict: { decision: 'ALLOW', reasonCodes: [], requiredGrants: ['g1'], constraints: { maxBytes: 100, flag: true } } },
      { id: 'b', verdict: { decision: 'ALLOW', reasonCodes: [], requiredGrants: ['g2'], constraints: { maxBytes: 40, flag: false } } },
    ])
    expect([...result.requiredGrants].sort()).toEqual(['g1', 'g2'])
    expect(result.constraints).toEqual({ maxBytes: 40, flag: false })
  })
})
