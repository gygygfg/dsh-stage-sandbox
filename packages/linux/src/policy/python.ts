/**
 * The Python rule executor. Each rule runs in a fresh isolated `python3`
 * subprocess (`-I`) whose embedded harness AST-whitelists the rule source,
 * installs a `sys.audit` hook that blocks filesystem, network, subprocess,
 * ctypes, and import events, restricts builtins, and bounds CPU time. A rule
 * that fails the whitelist, trips the audit hook, times out, or returns
 * malformed output yields a DENY with `POLICY_EVALUATION_FAILED`.
 *
 * The harness is self-contained (stdlib only). RestrictedPython is explicitly
 * not a sandbox, and a `sys.audit` hook (PEP 578) is not defined as one
 * either: the AST whitelist, audit hook, and builtin restriction are
 * additional hardening only and do not by themselves satisfy the execution
 * boundary. Rules must run in an OS-constrained, low-privilege independent
 * host; this executor uses a fresh `python3 -I` subprocess as that host, and a
 * deployment that cannot provide such a host must not treat the in-process
 * hardening as isolation.
 * @module dsh-sandbox-linux/policy/python
 */

import { spawn } from 'node:child_process'
import type { PolicyFacts } from './facts.ts'
import type { EvaluateOptions, RuleExecutor, RuleSpec } from './executor.ts'
import { failureVerdict, type RuleVerdict } from './verdict.ts'

/** The embedded restricted harness; it reads one JSON job on stdin and writes one JSON verdict on stdout. */
export const PYTHON_HARNESS = String.raw`
import sys, json, ast, signal, resource, builtins

BANNED_NAMES = {
    "eval", "exec", "compile", "open", "__import__", "getattr", "setattr", "delattr",
    "globals", "locals", "vars", "dir", "input", "breakpoint", "memoryview",
    "exit", "quit", "help", "type", "object", "super", "classmethod", "staticmethod",
    "property", "importlib", "os", "sys", "subprocess", "socket", "ctypes", "pickle",
}

class Guard(ast.NodeVisitor):
    def visit_Import(self, node): raise ValueError("import is forbidden")
    def visit_ImportFrom(self, node): raise ValueError("import is forbidden")
    def visit_Global(self, node): raise ValueError("global is forbidden")
    def visit_Nonlocal(self, node): raise ValueError("nonlocal is forbidden")
    def visit_ClassDef(self, node): raise ValueError("class is forbidden")
    def visit_AsyncFunctionDef(self, node): raise ValueError("async is forbidden")
    def visit_Await(self, node): raise ValueError("await is forbidden")
    def visit_Yield(self, node): raise ValueError("yield is forbidden")
    def visit_YieldFrom(self, node): raise ValueError("yield is forbidden")
    def visit_Name(self, node):
        if node.id in BANNED_NAMES: raise ValueError("name is forbidden: " + node.id)
    def visit_Attribute(self, node):
        if node.attr.startswith("__"): raise ValueError("dunder attribute is forbidden: " + node.attr)
        self.generic_visit(node)

class Grants:
    def __init__(self, grants): self._grants = set(grants)
    def allows(self, grant): return grant in self._grants

class Ctx:
    def __init__(self, facts, grants):
        self.facts = facts
        self.platform = facts.get("platform")
        self.grants = Grants(grants)
    def _verdict(self, decision, code, required_grants, requiredGrants, constraints):
        return {"decision": decision, "reasonCodes": [code], "requiredGrants": required_grants or requiredGrants or [], "constraints": constraints or {}}
    def deny(self, code, required_grants=None, requiredGrants=None, constraints=None):
        return self._verdict("DENY", code, required_grants, requiredGrants, constraints)
    def ask(self, code, required_grants=None, requiredGrants=None, constraints=None):
        return self._verdict("NEEDS_CONFIRMATION", code, required_grants, requiredGrants, constraints)
    def allow(self):
        return {"decision": "ALLOW", "reasonCodes": [], "requiredGrants": [], "constraints": {}}
    def normalize_path(self, p):
        s = str(p).replace("\\", "/")
        while "//" in s: s = s.replace("//", "/")
        return s

SAFE = {name: getattr(builtins, name) for name in (
    "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple", "frozenset",
    "min", "max", "sum", "sorted", "any", "all", "range", "enumerate", "zip", "abs",
    "round", "isinstance", "repr", "Exception", "ValueError", "KeyError", "TypeError",
)}

BLOCKED_PREFIXES = ("open", "socket", "subprocess", "os.system", "os.exec", "os.spawn", "os.fork", "ctypes", "shutil", "urllib", "http", "ftplib", "smtplib", "import")

def _audit(event, args):
    for prefix in BLOCKED_PREFIXES:
        if event.startswith(prefix):
            raise RuntimeError("audit blocked: " + event)

def _alarm(signum, frame):
    raise TimeoutError("rule timed out")

def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def main():
    payload = json.loads(sys.stdin.read())
    source = payload["source"]
    facts = payload["facts"]
    grants = payload.get("grants", [])
    timeout_ms = int(payload.get("timeoutMs", 1000))
    try:
        tree = ast.parse(source, mode="exec")
        Guard().visit(tree)
        signal.signal(signal.SIGALRM, _alarm)
        signal.alarm(max(1, (timeout_ms + 999) // 1000))
        namespace = {"__builtins__": SAFE}
        exec(compile(tree, "<rule>", "exec"), namespace)
        fn = namespace.get("evaluate")
        if not callable(fn):
            raise ValueError("rule does not define evaluate(ctx)")
        verdict = fn(Ctx(facts, grants))
        decision = verdict.get("decision")
        if decision not in ("ALLOW", "DENY", "NEEDS_CONFIRMATION"):
            raise ValueError("invalid decision")
        emit({"decision": decision, "reasonCodes": verdict.get("reasonCodes", []), "requiredGrants": verdict.get("requiredGrants", []), "constraints": verdict.get("constraints", {})})
    except BaseException as error:
        emit({"decision": "DENY", "reasonCodes": ["POLICY_EVALUATION_FAILED", str(error)], "requiredGrants": [], "constraints": {}})
    finally:
        signal.alarm(0)

sys.addaudithook(_audit)
main()
`

/** Validate a decoded rule result into a verdict, or a failure. */
function decodeVerdict(raw: unknown): RuleVerdict {
  if (raw === null || typeof raw !== 'object') return failureVerdict('rule returned a non-object verdict')
  const value = raw as Record<string, unknown>
  const decision = value.decision
  if (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'NEEDS_CONFIRMATION') return failureVerdict('rule returned an invalid decision')
  const reasonCodes = Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((code): code is string => typeof code === 'string') : []
  const requiredGrants = Array.isArray(value.requiredGrants) ? value.requiredGrants.filter((grant): grant is string => typeof grant === 'string') : []
  const constraints = value.constraints !== null && typeof value.constraints === 'object' ? value.constraints as RuleVerdict['constraints'] : {}
  return { decision, reasonCodes, requiredGrants, constraints }
}

/** The subprocess-isolated Python executor. */
export class PythonRuleExecutor implements RuleExecutor {
  /** @inheritdoc */
  readonly language = 'python'
  private readonly pythonPath: string

  /**
   * @param pythonPath - the `python3` executable; defaults to `python3`.
   */
  constructor(pythonPath = 'python3') {
    this.pythonPath = pythonPath
  }

  /** @inheritdoc */
  async available(): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.pythonPath, ['-I', '-c', 'pass'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', code => resolve(code === 0))
    })
  }

  /** @inheritdoc */
  async evaluate(rule: RuleSpec, facts: PolicyFacts, options: EvaluateOptions): Promise<RuleVerdict> {
    const payload = JSON.stringify({ source: rule.source, facts, grants: facts.grants, timeoutMs: options.timeoutMs })
    return new Promise(resolve => {
      const child = spawn(this.pythonPath, ['-I', '-c', PYTHON_HARNESS], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (verdict: RuleVerdict): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(verdict)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(failureVerdict('python rule exceeded the host wall-clock limit'))
      }, options.timeoutMs + 2_000)
      child.on('error', error => finish(failureVerdict(error.message)))
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('close', () => {
        if (stdout.length === 0 || stdout.length > 64 * 1024) {
          finish(failureVerdict(stderr.trim().split('\n').pop() ?? 'python rule produced no verdict'))
          return
        }
        try {
          finish(decodeVerdict(JSON.parse(stdout)))
        } catch (error) {
          finish(failureVerdict(error instanceof Error ? error.message : String(error)))
        }
      })
      child.stdin.end(payload)
    })
  }
}
