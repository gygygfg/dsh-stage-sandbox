import { describe, expect, it } from 'vitest'
import { replayDecision } from '../../src/policy/replay.ts'
import type { PolicyFacts } from '../../src/policy/facts.ts'

const facts = {} as PolicyFacts

describe('policy replay', () => {
  it('confirms a reproducible decision', async () => {
    const evaluate = async (): Promise<{ decision: string; reasonCodes: readonly string[] }> => ({ decision: 'ALLOW', reasonCodes: ['A', 'B'] })
    const result = await replayDecision(evaluate, facts, { decision: 'ALLOW', reasonCodes: ['B', 'A'] })
    expect(result.reproduced).toBe(true)
  })

  it('flags a non-reproducible decision', async () => {
    const evaluate = async (): Promise<{ decision: string; reasonCodes: readonly string[] }> => ({ decision: 'DENY', reasonCodes: ['X'] })
    const result = await replayDecision(evaluate, facts, { decision: 'ALLOW', reasonCodes: [] })
    expect(result.reproduced).toBe(false)
    expect(result.decision).toBe('DENY')
  })
})
