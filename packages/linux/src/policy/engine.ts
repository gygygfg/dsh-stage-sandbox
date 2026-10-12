/**
 * The policy engine: load signed rule packs, dispatch each applicable rule to
 * the executor for its language, and aggregate the verdicts. Executor order
 * never changes the aggregate, and an unavailable executor is a refusal for
 * that rule.
 * @module dsh-sandbox-linux/policy/engine
 */

import type { PolicyFacts } from './facts.ts'
import { ExecutorRegistry, type EvaluateOptions, type RuleExecutor } from './executor.ts'
import { parseRulePack, verifyRulePack, type RulePack } from './pack.ts'
import { aggregate, failureVerdict, type PolicyVerdict } from './verdict.ts'

/** The engine's construction inputs. */
export interface PolicyEngineOptions {
  /** The executor registry; a default one with no executors is created when absent. */
  readonly registry?: ExecutorRegistry
  /** The default per-rule wall-clock limit. */
  readonly defaultTimeoutMs?: number
}

/** The result of loading a pack. */
export type LoadResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * The policy engine. It holds verified packs and evaluates them against a fact
 * snapshot.
 */
export class PolicyEngine {
  /** The executor registry. */
  readonly registry: ExecutorRegistry
  private readonly defaultTimeoutMs: number
  private readonly packs: RulePack[] = []

  /**
   * @param options - the registry and default timeout.
   */
  constructor(options: PolicyEngineOptions = {}) {
    this.registry = options.registry ?? new ExecutorRegistry()
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2_000
  }

  /**
   * Load a verified rule pack.
   * @param pack - the pack to load.
   * @returns `ok`, or the refusal reason when the signature does not match.
   */
  loadPack(pack: RulePack): LoadResult {
    const verification = verifyRulePack(pack)
    if (!verification.ok) return verification
    this.packs.push(pack)
    return { ok: true }
  }

  /**
   * Parse, verify, and load a pack from JSON text.
   * @param json - the pack JSON.
   * @returns `ok`, or the refusal reason.
   */
  loadPackJson(json: string): LoadResult {
    try {
      return this.loadPack(parseRulePack(json))
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Evaluate every applicable rule against the facts and aggregate.
   * @param facts - the immutable fact snapshot.
   * @returns the aggregate policy verdict.
   */
  async evaluate(facts: PolicyFacts): Promise<PolicyVerdict> {
    const options: EvaluateOptions = { timeoutMs: this.defaultTimeoutMs }
    const evaluated: { id: string; verdict: import('./verdict.ts').RuleVerdict }[] = []
    for (const pack of this.packs) {
      for (const rule of pack.rules) {
        if (rule.phases !== undefined && !rule.phases.includes(facts.phase)) continue
        const executor = this.registry.get(rule.language)
        if (executor === undefined) {
          evaluated.push({ id: rule.id, verdict: failureVerdict(`no executor registered for language '${rule.language}'`) })
          continue
        }
        if (!(await executor.available())) {
          evaluated.push({ id: rule.id, verdict: failureVerdict(`executor '${rule.language}' is unavailable on this host`) })
          continue
        }
        evaluated.push({ id: rule.id, verdict: await executor.evaluate(rule, facts, options) })
      }
    }
    return aggregate(evaluated)
  }

  /**
   * The loaded pack ids.
   * @returns a snapshot array.
   */
  packIds(): string[] {
    return this.packs.map(pack => pack.id)
  }

  /**
   * The registered executor languages.
   * @returns a snapshot array.
   */
  languages(): string[] {
    return this.registry.languages()
  }

  /**
   * Register a rule executor.
   * @param executor - the executor.
   * @returns the disposer.
   */
  registerExecutor(executor: RuleExecutor): () => void {
    return this.registry.register(executor)
  }
}
