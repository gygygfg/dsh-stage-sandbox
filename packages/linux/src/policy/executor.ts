/**
 * Rule executor contract and registry. The control plane dispatches a rule to
 * the executor that owns its declared language; an unavailable executor is a
 * refusal for that rule, never a silent skip.
 * @module dsh-sandbox-linux/policy/executor
 */

import type { PolicyFacts } from './facts.ts'
import type { RuleVerdict } from './verdict.ts'

/** One rule to evaluate. */
export interface RuleSpec {
  /** Stable rule id, used in failure reporting. */
  readonly id: string
  /** The rule's declared language. */
  readonly language: string
  /** The rule source. */
  readonly source: string
}

/** Options for one evaluation. */
export interface EvaluateOptions {
  /** Wall-clock limit for the rule. */
  readonly timeoutMs: number
}

/** One language's rule executor. */
export interface RuleExecutor {
  /** The language this executor implements. */
  readonly language: string
  /**
   * Whether the executor can run on this host.
   * @returns `true` when a rule in this language can be evaluated.
   */
  available(): Promise<boolean>
  /**
   * Evaluate one rule against the facts.
   * @param rule - the rule to evaluate.
   * @param facts - the immutable fact snapshot.
   * @param options - the wall-clock limit.
   * @returns the rule's verdict; a failure is a DENY verdict, not a throw.
   */
  evaluate(rule: RuleSpec, facts: PolicyFacts, options: EvaluateOptions): Promise<RuleVerdict>
}

/** A named executor table. */
export class ExecutorRegistry {
  private readonly executors = new Map<string, RuleExecutor>()

  /**
   * Register an executor.
   * @param executor - the executor to register.
   * @returns the disposer that removes it.
   */
  register(executor: RuleExecutor): () => void {
    if (this.executors.has(executor.language)) throw new Error(`policy executor '${executor.language}' is already registered`)
    this.executors.set(executor.language, executor)
    return () => { if (this.executors.get(executor.language) === executor) this.executors.delete(executor.language) }
  }

  /**
   * Resolve an executor by language.
   * @param language - the rule's language.
   * @returns the executor, or `undefined`.
   */
  get(language: string): RuleExecutor | undefined {
    return this.executors.get(language)
  }

  /**
   * The registered languages.
   * @returns a snapshot array of language names.
   */
  languages(): string[] {
    return [...this.executors.keys()]
  }
}
