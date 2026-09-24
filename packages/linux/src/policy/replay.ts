/**
 * Policy replay (v2.3 §13). A stored decision must be reproducible from the
 * same rule packs and the same facts: replay re-evaluates and compares. A
 * mismatch means the decision was not a pure function of its inputs (a
 * non-deterministic rule, a changed pack) and must not be trusted.
 * @module dsh-sandbox-linux/policy/replay
 */

import type { PolicyFacts } from './facts.ts'

/** The minimal verdict a replay compares. */
export interface ReplayVerdict {
  /** The decision. */
  readonly decision: string
  /** The reason codes, order-insensitive for comparison. */
  readonly reasonCodes: readonly string[]
}

/** The replay comparison result. */
export interface ReplayResult {
  /** Whether the decision reproduced exactly. */
  readonly reproduced: boolean
  /** The replayed decision. */
  readonly decision: string
  /** The replayed reason codes. */
  readonly reasonCodes: readonly string[]
}

/** Whether two verdicts are identical by decision and reason-code set. */
function sameVerdict(a: ReplayVerdict, b: ReplayVerdict): boolean {
  if (a.decision !== b.decision) return false
  const left = [...a.reasonCodes].sort()
  const right = [...b.reasonCodes].sort()
  return left.length === right.length && left.every((code, index) => code === right[index])
}

/**
 * Re-evaluate a decision from its facts and compare with the recorded verdict.
 * @param evaluate - the policy evaluation function.
 * @param facts - the immutable facts the decision was made from.
 * @param expected - the recorded verdict.
 * @returns the replay result.
 */
export async function replayDecision(
  evaluate: (facts: PolicyFacts) => Promise<ReplayVerdict>,
  facts: PolicyFacts,
  expected: ReplayVerdict,
): Promise<ReplayResult> {
  const replayed = await evaluate(facts)
  return { reproduced: sameVerdict(replayed, expected), decision: replayed.decision, reasonCodes: replayed.reasonCodes }
}
