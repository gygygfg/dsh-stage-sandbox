/**
 * Capability requirement checking for the Platform Abstraction Layer. A plan
 * declares the mechanisms it depends on; the check refuses a plan the probed
 * host cannot enforce rather than silently degrading to a weaker boundary.
 * @module dsh-sandbox-linux/pal/capabilities
 */

import type { CapabilityReport, CapabilityRequirement } from './types.ts'

/** Ordering that makes "at least this status" a comparison. */
const STATUS_RANK = {
  absent: 0,
  partial: 1,
  enforced: 2,
} as const

/**
 * The requirements a report does not satisfy, in input order. An empty result
 * means the host can enforce every requirement.
 * @param report - the probed backend capabilities.
 * @param requirements - the capabilities a plan requires.
 * @returns the unmet requirements.
 */
export function capabilityGaps(report: CapabilityReport, requirements: readonly CapabilityRequirement[]): CapabilityRequirement[] {
  return requirements.filter(requirement => {
    const actual = (STATUS_RANK as Record<string, number | undefined>)[report.capabilities[requirement.capability]]
    const required = STATUS_RANK[requirement.minimum]
    // Missing/unknown is a gap, not a pass: a deserialized or partial report
    // must never be read as "the host enforces this".
    return actual === undefined || required === undefined || actual < required
  })
}

/**
 * Whether a report satisfies every requirement.
 * @param report - the probed backend capabilities.
 * @param requirements - the capabilities a plan requires.
 * @returns `true` when no requirement is unmet.
 */
export function meetsRequirements(report: CapabilityReport, requirements: readonly CapabilityRequirement[]): boolean {
  return capabilityGaps(report, requirements).length === 0
}
