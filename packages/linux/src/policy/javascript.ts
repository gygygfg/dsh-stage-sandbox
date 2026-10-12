/**
 * The JavaScript rule executor. Each rule runs in its own `node:vm` context
 * with a frozen global, no `require`/`process`/`Buffer`, no `eval`/`Function`,
 * frozen prototypes, and no `Date.now`/`Math.random`; the only inputs are the
 * fact snapshot and the injected `ctx` helpers. A rule that throws, times out,
 * or returns malformed output yields a DENY with `POLICY_EVALUATION_FAILED`.
 *
 * `node:vm` is explicitly NOT a security mechanism. The context, frozen
 * prototypes, and disabled globals are additional hardening only; they do not
 * by themselves satisfy the execution boundary. Rules must run in an
 * OS-constrained, low-privilege independent host. This in-process executor is
 * therefore suitable only for trusted rule packs; a deployment that runs
 * untrusted rules must swap in a host-isolated executor (for example
 * `isolated-vm`) behind the same {@link RuleExecutor} contract.
 * @module dsh-sandbox-linux/policy/javascript
 */

import vm from 'node:vm'
import type { PolicyFacts } from './facts.ts'
import type { RuleExecutor, RuleSpec, EvaluateOptions } from './executor.ts'
import { failureVerdict, type RuleVerdict } from './verdict.ts'

/** The maximum serialized verdict size accepted from a rule. */
const MAX_RESULT_BYTES = 64 * 1024

/** The hardening script run once per rule context, before the rule source. */
const HARDEN = `(function () {
  var g = globalThis;
  if (g.Math) { try { g.Math.random = undefined; } catch (e) {} }
  if (g.Date) { try { g.Date.now = undefined; } catch (e) {} }
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
  try { Object.freeze(Math); } catch (e) {}
  try { Object.freeze(JSON); } catch (e) {}
  try { delete g.eval; } catch (e) {}
  try { delete g.Function; } catch (e) {}
  g.eval = undefined;
  g.Function = undefined;
})();`

/** Strip a leading `export ` from an `export function evaluate` declaration. */
function stripExport(source: string): string {
  return source.replace(/^\s*export\s+(function\s+evaluate)/u, '$1')
}

/** Validate a decoded rule result into a verdict, or a failure. */
function decodeVerdict(raw: unknown): RuleVerdict {
  if (raw === null || typeof raw !== 'object') return failureVerdict('rule returned a non-object verdict')
  const value = raw as Record<string, unknown>
  const decision = value.decision
  if (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'NEEDS_CONFIRMATION') {
    return failureVerdict('rule returned an invalid decision')
  }
  const reasonCodes = Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((code): code is string => typeof code === 'string') : []
  const requiredGrants = Array.isArray(value.requiredGrants) ? value.requiredGrants.filter((grant): grant is string => typeof grant === 'string') : []
  const constraints = value.constraints !== null && typeof value.constraints === 'object' ? value.constraints as RuleVerdict['constraints'] : {}
  return { decision, reasonCodes, requiredGrants, constraints }
}

/** The `node:vm`-backed JavaScript executor. */
export class JavaScriptRuleExecutor implements RuleExecutor {
  /** @inheritdoc */
  readonly language = 'javascript'

  /** @inheritdoc */
  async available(): Promise<boolean> {
    return true
  }

  /** @inheritdoc */
  async evaluate(rule: RuleSpec, facts: PolicyFacts, options: EvaluateOptions): Promise<RuleVerdict> {
    const context = vm.createContext({})
    try {
      vm.runInContext(HARDEN, context)
      const program = [
        '"use strict";',
        `const __facts = ${JSON.stringify(facts)};`,
        `const __grants = ${JSON.stringify(facts.grants)};`,
        'const normalizePath = (p) => String(p).replace(/\\\\/g, "/").replace(/\\/+/g, "/");',
        'const __make = (decision, code, opts) => { const o = opts || {}; return { decision, reasonCodes: code ? [code] : [], requiredGrants: o.requiredGrants || [], constraints: o.constraints || {} }; };',
        'const __ctx = Object.freeze({ facts: __facts, platform: __facts.platform, grants: Object.freeze({ allows: (g) => __grants.indexOf(g) !== -1 }), deny: (c, o) => __make("DENY", c, o), ask: (c, o) => __make("NEEDS_CONFIRMATION", c, o), allow: () => __make("ALLOW", null, null), normalizePath });',
        stripExport(rule.source),
        'JSON.stringify(evaluate(__ctx));',
      ].join('\n')
      const script = new vm.Script(program, { filename: `${rule.id}.js` })
      const raw = script.runInContext(context, { timeout: options.timeoutMs })
      if (typeof raw !== 'string' || raw.length > MAX_RESULT_BYTES) return failureVerdict('rule returned no serializable verdict')
      return decodeVerdict(JSON.parse(raw))
    } catch (error) {
      return failureVerdict(error instanceof Error ? error.message : String(error))
    }
  }
}
