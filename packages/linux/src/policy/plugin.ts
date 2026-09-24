/**
 * The Cordis service wrapper around the policy engine. It registers as
 * `ctx.sandboxPolicyEngine`, mounts the JavaScript and Python executors, loads
 * the configured signed rule packs, and exposes the publication gate the
 * control plane consults.
 * @module dsh-sandbox-linux/policy/plugin
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PolicyEngine } from './engine.ts'
import { JavaScriptRuleExecutor } from './javascript.ts'
import { PythonRuleExecutor } from './python.ts'
import { PolicyPublicationGate } from './gate.ts'
import type { PolicyFacts } from './facts.ts'
import type { PolicyVerdict } from './verdict.ts'
import type { LoadResult } from './engine.ts'

/** Plugin config for the policy engine. */
export interface Config {
  /** Default per-rule wall-clock limit, in milliseconds. */
  defaultTimeoutMs?: number
  /** Whether to mount the Python executor. */
  python?: boolean
  /** Signed rule packs as JSON strings. */
  packs?: string[]
}

/**
 * The policy engine service. A deployment loads signed packs through config;
 * with no packs, every evaluation aggregates to ALLOW.
 */
export class PolicyEngineService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    defaultTimeoutMs: z.natural().default(2_000),
    python: z.boolean().default(true),
    packs: z.array(z.string()).default([]),
  })

  /** The underlying engine. */
  readonly engine: PolicyEngine
  /** The publication gate the control plane consults. */
  readonly gate: PolicyPublicationGate

  /**
   * @param ctx - the plugin context.
   * @param config - the timeout, Python toggle, and signed packs.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicyEngine')
    this.engine = new PolicyEngine({ defaultTimeoutMs: config.defaultTimeoutMs as number })
    ctx.effect(() => this.engine.registerExecutor(new JavaScriptRuleExecutor()))
    if (config.python === true) ctx.effect(() => this.engine.registerExecutor(new PythonRuleExecutor()))
    for (const json of config.packs as string[]) {
      const result = this.engine.loadPackJson(json)
      if (!result.ok) throw new Error(`sandbox-policy-engine: ${result.reason}`)
    }
    this.gate = new PolicyPublicationGate(this.engine)
  }

  /**
   * Evaluate the loaded rules against a fact snapshot.
   * @param facts - the fact snapshot.
   * @returns the aggregate verdict.
   */
  evaluate(facts: PolicyFacts): Promise<PolicyVerdict> {
    return this.engine.evaluate(facts)
  }

  /**
   * Verify and load one rule pack.
   * @param json - the pack JSON.
   * @returns `ok`, or the refusal reason.
   */
  loadPackJson(json: string): LoadResult {
    return this.engine.loadPackJson(json)
  }

  /**
   * The registered executor languages.
   * @returns a snapshot array.
   */
  languages(): string[] {
    return this.engine.languages()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicyEngine: PolicyEngineService
  }
}

export default PolicyEngineService
