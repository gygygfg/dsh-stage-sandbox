/**
 * Rule verdicts and the aggregate decision. A rule returns a decision, reason
 * codes, required grants, and constraints; the aggregator combines them with a
 * fixed precedence (DENY beats NEEDS_CONFIRMATION beats ALLOW), unions reason
 * codes and required grants, and intersects constraints. A failed rule is a
 * DENY, never a skip.
 * @module dsh-sandbox-linux/policy/verdict
 */

/** The decision vocabulary. */
export type PolicyDecision = 'ALLOW' | 'DENY' | 'NEEDS_CONFIRMATION'

/** One rule's verdict. */
export interface RuleVerdict {
  /** The rule's decision. */
  readonly decision: PolicyDecision
  /** Stable reason codes explaining the decision. */
  readonly reasonCodes: readonly string[]
  /** Grants the rule requires to allow the operation. */
  readonly requiredGrants: readonly string[]
  /** Constraints the operation must satisfy (numeric upper bounds, booleans). */
  readonly constraints: Readonly<Record<string, number | boolean | string>>
}

/** The aggregate verdict over all evaluated rules. */
export interface PolicyVerdict extends RuleVerdict {
  /** Ids of rules that failed to evaluate (errors, timeouts, bad output). */
  readonly failedRules: readonly string[]
  /** Ids of rules that contributed a DENY. */
  readonly deniedBy: readonly string[]
  /** Ids of rules that contributed a NEEDS_CONFIRMATION. */
  readonly confirmationBy: readonly string[]
}

/** A constant used to encode a rule-evaluation failure. */
export const POLICY_EVALUATION_FAILED = 'POLICY_EVALUATION_FAILED'

/** A verdict for one rule that failed to evaluate. */
export function failureVerdict(reason: string): RuleVerdict {
  return { decision: 'DENY', reasonCodes: [POLICY_EVALUATION_FAILED, reason], requiredGrants: [], constraints: {} }
}

/** The numeric/boolean ordering used to intersect constraints strictly. */
function stricter(left: number | boolean | string | undefined, right: number | boolean | string): number | boolean | string {
  if (left === undefined) return right
  if (typeof left === 'number' && typeof right === 'number') return Math.min(left, right)
  if (typeof left === 'boolean' && typeof right === 'boolean') return left && right
  return right
}

/**
 * Aggregate rule verdicts into one policy verdict. Any failed rule or any DENY
 * yields DENY; otherwise any NEEDS_CONFIRMATION yields NEEDS_CONFIRMATION;
 * otherwise ALLOW. Hard denies are never overridden by confirmations.
 * @param evaluated - pairs of rule id and verdict.
 * @returns the aggregate verdict.
 */
export function aggregate(evaluated: readonly { readonly id: string; readonly verdict: RuleVerdict }[]): PolicyVerdict {
  const reasonCodes: string[] = []
  const requiredGrants = new Set<string>()
  const constraints: Record<string, number | boolean | string> = {}
  const failedRules: string[] = []
  const deniedBy: string[] = []
  const confirmationBy: string[] = []
  let decision: PolicyDecision = 'ALLOW'
  const raise = (candidate: PolicyDecision): void => {
    if (candidate === 'DENY') decision = 'DENY'
    else if (candidate === 'NEEDS_CONFIRMATION' && decision !== 'DENY') decision = 'NEEDS_CONFIRMATION'
  }
  for (const { id, verdict } of evaluated) {
    if (verdict.reasonCodes.includes(POLICY_EVALUATION_FAILED)) failedRules.push(id)
    if (verdict.decision === 'DENY') deniedBy.push(id)
    if (verdict.decision === 'NEEDS_CONFIRMATION') confirmationBy.push(id)
    raise(verdict.decision)
    for (const code of verdict.reasonCodes) if (!reasonCodes.includes(code)) reasonCodes.push(code)
    for (const grant of verdict.requiredGrants) requiredGrants.add(grant)
    for (const [key, value] of Object.entries(verdict.constraints)) constraints[key] = stricter(constraints[key], value)
  }
  if (failedRules.length > 0) decision = 'DENY'
  return {
    decision,
    reasonCodes,
    requiredGrants: [...requiredGrants],
    constraints,
    failedRules,
    deniedBy,
    confirmationBy,
  }
}
