/**
 * Static script scanning (v2.3 §10). A command that delegates execution to a
 * script or interpreter (`bash deploy.sh`, `python setup.py`, `node x.js`,
 * `bash -c '…'`) hides its real effects from the command line. This module
 * reads the referenced scripts, folds in shell text embedded in higher-level
 * languages, and recurses into sourced/referenced scripts so those effects
 * reach the danger classifier.
 *
 * It is deliberately static: an indirect execution it cannot resolve is marked
 * `opaque` (forcing review) rather than silently ignored. It is NOT a runtime
 * tracer and can be evaded — the overlay's effect capture is the dynamic side.
 * @module dsh-sandbox-linux/candidate/script-scan
 */

import { isAbsolute, resolve } from 'node:path'

/** The script-scan limits. */
export interface ScriptScanLimits {
  /** Maximum recursion depth; defaults to 4. */
  readonly maxDepth?: number
  /** Maximum scripts read; defaults to 20. */
  readonly maxFiles?: number
  /** Maximum total bytes read from scripts; defaults to 512 KiB. */
  readonly maxBytes?: number
  /** Maximum bytes read from one script; defaults to 256 KiB. */
  readonly maxScriptBytes?: number
}

/** The inputs to scanning one command. */
export interface ScriptScanInput extends ScriptScanLimits {
  /** The shell command line. */
  readonly command: string
  /** The working directory relative script paths resolve against. */
  readonly cwd: string
  /** Read a script's text; should prefer a staged copy. */
  readonly readFile: (path: string) => string | undefined
}

/** The scan result. */
export interface ScriptScanResult {
  /** The original command plus the shell text of every script it reaches. */
  readonly effective: string
  /** The absolute paths of the scripts that were read. */
  readonly scripts: readonly string[]
  /** Whether an indirect execution could not be resolved. */
  readonly opaque: boolean
  /** Why the scan is opaque. */
  readonly opaqueReasons: readonly string[]
}

/** Interpreters whose positional argument is a shell script. */
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh'])
/** Interpreters with an embedded-shell form. */
const LANGUAGES: ReadonlySet<string> = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'ruby', 'perl', 'php'])
/** Script extensions that are read and classified by shebang/interpreter. */
const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|py|js|cjs|mjs|ts|rb|pl|php)$/iu

/** Split a command into simple commands on `;`, `&&`, `||`, `|`, and newlines, respecting quotes. */
function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\\') {
      current += ch
      if (i + 1 < command.length) {
        current += command[i + 1]
        i += 1
      }
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      out.push(current)
      current = ''
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i += 1
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map(segment => segment.trim()).filter(segment => segment.length > 0)
}

/**
 * Split a command into simple commands (exposed for the danger classifier to
 * classify each folded script segment).
 * @param command - the command line.
 * @returns the simple commands.
 */
export function splitCommands(command: string): string[] {
  return segments(command)
}

/** Split one simple command into argv tokens, stripping quotes. */
function tokens(segment: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(segment)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  }
  return out
}

/** Strip shell comments from a script body (line-oriented, quote-aware). */
function stripComments(body: string): string {
  return body
    .split('\n')
    .map(line => {
      let quote: string | null = null
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (quote !== null) {
          if (ch === quote) quote = null
          continue
        }
        if (ch === "'" || ch === '"') quote = ch
        else if (ch === '#' && (i === 0 || /\s/u.test(line[i - 1] as string))) return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

/** Extract embedded shell-string literals from a higher-level language body. */
function extractEmbedded(language: string, body: string): string[] {
  const patterns: readonly RegExp[] = language.startsWith('python')
    ? [/os\.system\(\s*(['"])([\s\S]*?)\1/gu, /os\.popen\(\s*(['"])([\s\S]*?)\1/gu, /subprocess\.\w+\(\s*(['"])([\s\S]*?)\1/gu]
    : language === 'node' || language === 'nodejs'
      ? [/child_process\.\w+\(\s*(['"`])([\s\S]*?)\1/gu, /\b(?:exec|execSync|spawn|spawnSync|execFile)\(\s*(['"`])([\s\S]*?)\1/gu]
      : language === 'php'
        ? [/\b(?:shell_exec|system|exec|passthru)\(\s*(['"])([\s\S]*?)\1/gu, /`([^`]*)`/gu]
        : [/`([^`]*)`/gu, /\b(?:system|exec)\(\s*(['"])([\s\S]*?)\1/gu, /%x\{([^}]*)\}/gu]
  const out: string[] = []
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body)) !== null) {
      const literal = match[2] ?? match[1]
      if (typeof literal === 'string' && literal.length > 0) out.push(literal)
    }
  }
  return out
}

/**
 * Scan one command for indirectly executed scripts. The returned `effective`
 * text folds the reached shell bodies so the danger classifier sees package
 * installs, device-level commands, and downloads that were hidden in a script.
 * @param input - the command, cwd, read function, and limits.
 * @returns the scan result.
 */
export function scanCommand(input: ScriptScanInput): ScriptScanResult {
  const maxDepth = input.maxDepth ?? 4
  const maxFiles = input.maxFiles ?? 20
  const maxBytes = input.maxBytes ?? 512 * 1024
  const maxScriptBytes = input.maxScriptBytes ?? 256 * 1024
  const scripts = new Set<string>()
  const opaqueReasons = new Set<string>()
  const folded: string[] = []

  const markOpaque = (reason: string): void => { opaqueReasons.add(reason) }

  const readScript = (path: string): string | undefined => {
    if (scripts.size >= maxFiles) {
      markOpaque('MAX_FILES')
      return undefined
    }
    const text = input.readFile(path)
    if (text === undefined) {
      markOpaque(`UNREADABLE_SCRIPT:${path}`)
      return undefined
    }
    scripts.add(path)
    if (text.length > maxScriptBytes) {
      markOpaque(`SCRIPT_TOO_LARGE:${path}`)
      return text.slice(0, maxScriptBytes)
    }
    return text
  }

  const pending: { depth: number; text: string; kind: 'shell' | 'language'; language?: string }[] = [
    { depth: 0, text: input.command, kind: 'shell' },
  ]
  let consumed = 0

  const resolveScript = (target: string): string => (isAbsolute(target) ? target : resolve(input.cwd, target))
  const bodyBytes = (text: string): number => Buffer.byteLength(text, 'utf8')

  while (pending.length > 0) {
    const job = pending.shift() as { depth: number; text: string; kind: 'shell' | 'language'; language?: string }
    // An opaque pipe (`... | sh`) hides the producer's content.
    if (/(?:^|\|)\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b/u.test(job.text) && job.text.includes('|')) {
      markOpaque('PIPE_TO_SHELL')
    }
    if (job.kind === 'language') {
      for (const snippet of extractEmbedded(job.language ?? '', job.text)) {
        if (/\$(?:\(|\{|[A-Za-z_])/u.test(snippet)) { markOpaque('DYNAMIC_COMMAND'); continue }
        folded.push(snippet)
        pending.push({ depth: job.depth, text: snippet, kind: 'shell' })
      }
      continue
    }
    const shellBody = stripComments(job.text)
    for (const segment of segments(shellBody)) {
      const argv = tokens(segment)
      const exe = (argv[0] ?? '').replace(/.*\//u, '').toLowerCase()
      const rest = argv.slice(1)
      let inline: string | undefined
      let scriptTarget: string | undefined
      let language: string | undefined

      if (SHELLS.has(exe)) {
        if (rest[0] === '-c') inline = rest[1]
        else if (rest[0] !== undefined && !rest[0].startsWith('-')) scriptTarget = rest[0]
        else { markOpaque('SHELL_NO_SCRIPT'); continue }
      } else if (LANGUAGES.has(exe)) {
        const flagIndex = rest.findIndex(token => token === '-c' || token === '-e')
        if (flagIndex !== -1) {
          inline = rest[flagIndex + 1]
          language = exe === 'nodejs' ? 'node' : exe
        } else if (rest.includes('-m')) {
          markOpaque('LANGUAGE_MODULE')
          continue
        } else if (rest[0] !== undefined && !rest[0].startsWith('-')) {
          scriptTarget = rest[0]
          language = exe === 'nodejs' ? 'node' : exe
        } else {
          markOpaque('LANGUAGE_STDIN')
          continue
        }
      } else if ((exe === 'source' || exe === '.') && rest[0] !== undefined) {
        scriptTarget = rest[0]
      } else if (exe.includes('.') && SCRIPT_EXTENSIONS.test(exe)) {
        scriptTarget = argv[0]
      }

      if (inline !== undefined) {
        if (inline.includes('$') && /\$(?:\(|\{|[A-Za-z_])/u.test(inline)) { markOpaque('DYNAMIC_COMMAND'); continue }
        if (job.depth >= maxDepth) { markOpaque('MAX_DEPTH'); continue }
        consumed += bodyBytes(inline)
        if (consumed > maxBytes) { markOpaque('MAX_BYTES'); break }
        folded.push(inline)
        pending.push({ depth: job.depth + 1, text: inline, kind: 'shell' })
        continue
      }
      if (scriptTarget === undefined) continue
      if (job.depth >= maxDepth) { markOpaque('MAX_DEPTH'); continue }
      const path = resolveScript(scriptTarget)
      const body = readScript(path)
      if (body === undefined) continue
      consumed += Math.min(bodyBytes(body), maxScriptBytes)
      if (consumed > maxBytes) { markOpaque('MAX_BYTES'); break }
      folded.push(body)
      const shebang = /^#!\s*(?:\S+\/)?([^\s/]+)/u.exec(body.trimStart())?.[1]?.toLowerCase()
      const targetLanguage = language ?? (shebang !== undefined && LANGUAGES.has(shebang) ? (shebang === 'nodejs' ? 'node' : shebang) : undefined)
      if (targetLanguage !== undefined) pending.push({ depth: job.depth + 1, text: body, kind: 'language', language: targetLanguage })
      else pending.push({ depth: job.depth + 1, text: body, kind: 'shell' })
    }
  }

  return {
    effective: [input.command, ...folded].join('\n'),
    scripts: [...scripts],
    opaque: opaqueReasons.size > 0,
    opaqueReasons: [...opaqueReasons],
  }
}
