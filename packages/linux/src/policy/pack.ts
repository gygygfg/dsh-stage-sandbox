/**
 * Rule packs: a signed bundle of rules. A pack's signature is the digest of
 * its canonical rule list; loading verifies it, so a tampered rule set is
 * refused rather than evaluated. Rules declare a language and the phases they
 * apply to.
 * @module dsh-sandbox-linux/policy/pack
 */

import { digestOf } from '../util/canonical.ts'
import type { PolicyPhase } from './facts.ts'

/** One rule in a pack. */
export interface RuleDefinition {
  /** Stable rule id, used in failure reporting. */
  readonly id: string
  /** The rule's language (`javascript`, `python`, or a legacy `lua`). */
  readonly language: string
  /** The rule source. */
  readonly source: string
  /** The phases the rule applies to; absent means all phases. */
  readonly phases?: readonly PolicyPhase[]
}

/** A signed rule pack. */
export interface RulePack {
  /** The pack identity. */
  readonly id: string
  /** The pack version. */
  readonly version: string
  /** The digest of the canonical rule list. */
  readonly signature: string
  /** The rules in the pack. */
  readonly rules: readonly RuleDefinition[]
}

/**
 * The digest that authenticates a pack's rules.
 * @param rules - the pack's rules.
 * @returns the signature digest.
 */
export function rulePackDigest(rules: readonly RuleDefinition[]): string {
  return digestOf(rules)
}

/** The result of verifying a pack. */
export type PackVerification = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Verify a pack's signature and shape.
 * @param pack - the pack to verify.
 * @returns `ok` or the refusal reason.
 */
export function verifyRulePack(pack: RulePack): PackVerification {
  if (typeof pack.id !== 'string' || pack.id.length === 0) return { ok: false, reason: 'pack id is missing' }
  if (typeof pack.version !== 'string' || pack.version.length === 0) return { ok: false, reason: 'pack version is missing' }
  if (!Array.isArray(pack.rules) || pack.rules.length === 0) return { ok: false, reason: 'pack has no rules' }
  for (const rule of pack.rules) {
    if (typeof rule.id !== 'string' || rule.id.length === 0) return { ok: false, reason: 'a rule has no id' }
    if (typeof rule.language !== 'string' || rule.language.length === 0) return { ok: false, reason: `rule '${rule.id}' has no language` }
    if (typeof rule.source !== 'string' || rule.source.trim().length === 0) return { ok: false, reason: `rule '${rule.id}' has no source` }
  }
  const expected = rulePackDigest(pack.rules)
  if (pack.signature !== expected) return { ok: false, reason: `signature mismatch for pack '${pack.id}'` }
  return { ok: true }
}

/**
 * Parse and verify a pack from JSON text.
 * @param json - the pack JSON.
 * @returns the verified pack.
 * @throws Error when the pack is malformed or its signature does not match.
 */
export function parseRulePack(json: string): RulePack {
  const pack = JSON.parse(json) as RulePack
  const verification = verifyRulePack(pack)
  if (!verification.ok) throw new Error(`rule pack refused: ${verification.reason}`)
  return pack
}
