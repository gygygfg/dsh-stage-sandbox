/**
 * A session-resident sandbox command server (v2.3 §16). One persistent bwrap
 * instance runs a tiny bash server; commands are sent as framed requests over
 * its stdin and their output comes back as framed responses. Because the
 * server shell persists, `cd`/`export` survive between commands and background
 * processes started with `&` keep running across tool calls (they are children
 * of the persistent shell, not of a one-shot process).
 *
 * The server is deliberately dependency-light (bash + base64 + mktemp + tr,
 * all in the minimal read-only root) and self-heals: if the server dies (an
 * `exit`, an OOM, a signal) the client observes EOF and the caller restarts it.
 * @module dsh-sandbox-linux/runtime/resident
 */

import { spawn, type ChildProcess } from 'node:child_process'

/**
 * The server loop. It prints `READY` once, then reads `REQ <id> <base64>` lines
 * from stdin, evaluates the decoded script in the current shell (so state
 * persists), and answers `RES <id> <base64-code> <base64-out> <base64-err>`.
 * `STOP` exits. Output is base64 so control bytes and NUL never break framing.
 */
export const RESIDENT_SERVER_SCRIPT = [
  'set +m',
  '__STATE="$(mktemp)"',
  ': > "$__STATE"',
  "printf 'READY\\n'",
  "while IFS= read -r __line; do",
  '  case "$__line" in',
  '    "REQ "*)',
  '      __rest="${__line#REQ }"',
  '      __id="${__rest%% *}"',
  '      __b64="${__rest#* }"',
  '      __script="$(printf \'%s\' "$__b64" | base64 -d 2>/dev/null)"',
  '      __d="$(mktemp -d)"',
  '      (',
  '        { [ -s "$__STATE" ] && . "$__STATE"; } 2>/dev/null || true',
  '        eval "$__script"',
  '        __rc=$?',
  '        { printf \'cd %q\\n\' "$(pwd)"; export -p; } > "$__d/state" 2>/dev/null',
  '        exit "$__rc"',
  '      ) </dev/null >"$__d/out" 2>"$__d/err"',
  '      __code=$?',
  '      if [ -f "$__d/state" ]; then mv "$__d/state" "$__STATE"; else : > "$__STATE"; fi',
  '      __bo="$(base64 < "$__d/out" | tr -d \'\\n\')"',
  '      __be="$(base64 < "$__d/err" | tr -d \'\\n\')"',
  '      __bc="$(printf \'%s\' "$__code" | base64 | tr -d \'\\n\')"',
  "      printf 'RES %s %s %s %s\\n' \"$__id\" \"$__bc\" \"$__bo\" \"$__be\"",
  '      rm -rf "$__d"',
  '      ;;',
  '    STOP) rm -f "$__STATE"; exit 0 ;;',
  '  esac',
  'done',
].join('\n')

/** How one resident server is started. */
export interface ResidentStartInput {
  /** Wrap the inner `bash -c <server>` argv with the sandbox confinement. */
  readonly confine: (argv: readonly string[]) => readonly string[]
  /** The working directory the server starts in. */
  readonly cwd: string
  /** The environment the server inherits. */
  readonly env: Readonly<Record<string, string>>
}

/** Per-command options. */
export interface ResidentExecOptions {
  /** Wall-clock timeout; on expiry the server is stopped. */
  readonly timeoutMs?: number
  /** Cancellation; on abort the server is stopped. */
  readonly signal?: AbortSignal
}

/** One command's result. */
export interface ResidentExecResult {
  /** The exit status, or `null` when unknown (a killed server). */
  readonly exitCode: number | null
  /** Captured stdout. */
  readonly stdout: string
  /** Captured stderr. */
  readonly stderr: string
  /** Whether the client's timeout fired. */
  readonly timedOut: boolean
}

/** Decode a base64 field to UTF-8 (empty for a missing field). */
function decodeBase64(value: string | undefined): string {
  return value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8')
}

/** Quote one value as a single-quoted POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/** One materialize request: the inbox, the target root, and the deletions. */
export interface ResidentMaterializeInput {
  /** The in-namespace path of the inbox holding the delta. */
  readonly inbox: string
  /** The in-namespace workspace root to write into. */
  readonly workspace: string
  /** POSIX-relative paths to delete. */
  readonly deletions?: readonly string[]
  /** Wall-clock timeout. */
  readonly timeoutMs?: number
}

/**
 * One resident server. Requests are serialized, so a single in-flight response
 * is expected at a time; background processes the commands start are not
 * tracked here — they live in the server's namespace and are reclaimed when the
 * server is stopped.
 */
export class ResidentSandbox {
  private child: ChildProcess | undefined
  private buffer = ''
  private sequence = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: unknown) => void) | undefined
  private pending: { id: string; resolve: (result: ResidentExecResult) => void; reject: (error: unknown) => void; timer?: NodeJS.Timeout } | undefined

  /** Whether the server process is currently running. */
  get running(): boolean {
    return this.child !== undefined
  }

  /**
   * Start the resident server if it is not already running.
   * @param input - the confinement wrapper, working directory, and environment.
   */
  async start(input: ResidentStartInput): Promise<void> {
    if (this.child !== undefined) return
    const argv = input.confine(['bash', '-c', RESIDENT_SERVER_SCRIPT])
    const [exe, ...args] = argv
    if (exe === undefined) throw new Error('resident: empty confined argv')
    const child = spawn(exe, args, { cwd: input.cwd, env: { ...input.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.buffer = ''
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => this.onData(String(chunk)))
    child.on('error', error => this.fail(error))
    child.on('close', () => this.fail(new Error('resident: server exited')))
    await ready
  }

  /**
   * Run one shell script in the resident server.
   * @param script - the shell source (`bash` semantics).
   * @param options - timeout and cancellation.
   * @returns the command's result.
   */
  exec(script: string, options: ResidentExecOptions = {}): Promise<ResidentExecResult> {
    const run = (): Promise<ResidentExecResult> => this.dispatch(script, options)
    const result = this.queue.then(run, run)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Whether a command is currently in flight. */
  busy(): boolean {
    return this.pending !== undefined
  }

  /**
   * Push a tool-edit delta into the resident instance from inside its namespace:
   * copy the inbox into the workspace (the overlay), then remove deleted paths.
   * Running this inside the namespace is what makes host-side edits visible to
   * the next command despite overlayfs dentry caching.
   * @param input - the inbox path, workspace root, and deletions.
   */
  async materialize(input: ResidentMaterializeInput): Promise<void> {
    const lines = [
      `mkdir -p ${shellQuote(input.workspace)}`,
      `cp -a ${shellQuote(`${input.inbox}/.`)} ${shellQuote(`${input.workspace}/`)} 2>/dev/null || true`,
    ]
    for (const relative of input.deletions ?? []) {
      lines.push(`rm -rf -- ${shellQuote(`${input.workspace}/${relative}`)}`)
    }
    const result = await this.exec(lines.join('\n'), { timeoutMs: input.timeoutMs ?? 30_000 })
    if (result.exitCode !== 0) throw new Error(`resident: materialize failed: ${result.stderr.trim()}`)
  }

  /** Stop the server and fail any in-flight command. */
  stop(): void {
    const child = this.child
    if (child !== undefined) {
      try {
        child.stdin?.write('STOP\n')
      } catch {
        // the pipe may already be closed
      }
      child.kill('SIGKILL')
    }
    this.fail(new Error('resident: stopped'))
  }

  private dispatch(script: string, options: ResidentExecOptions): Promise<ResidentExecResult> {
    const child = this.child
    if (child === undefined || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new Error('resident: server is not running'))
    }
    const id = String(++this.sequence)
    const payload = Buffer.from(script, 'utf8').toString('base64')
    return new Promise<ResidentExecResult>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 60_000
      const settle = (error: Error): void => {
        const current = this.pending
        if (current !== undefined && current.id === id) {
          this.pending = undefined
          if (current.timer !== undefined) clearTimeout(current.timer)
          current.reject(error)
        }
        this.stop()
      }
      const timer = setTimeout(() => settle(new Error(`resident: command timed out after ${timeoutMs}ms`)), timeoutMs)
      this.pending = { id, resolve, reject, timer }
      options.signal?.addEventListener('abort', () => settle(new Error('resident: command aborted')), { once: true })
      child.stdin?.write(`REQ ${id} ${payload}\n`)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line === 'READY') {
        const resolve = this.readyResolve
        this.readyResolve = undefined
        this.readyReject = undefined
        resolve?.()
        continue
      }
      if (line.startsWith('RES ')) this.onResult(line)
    }
  }

  private onResult(line: string): void {
    const [kind, id, code, out, err] = line.split(' ')
    if (kind !== 'RES' || id === undefined) return
    const pending = this.pending
    if (pending === undefined || pending.id !== id) return
    this.pending = undefined
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const numeric = Number.parseInt(decodeBase64(code).trim(), 10)
    pending.resolve({
      exitCode: Number.isNaN(numeric) ? null : numeric,
      stdout: decodeBase64(out),
      stderr: decodeBase64(err),
      timedOut: false,
    })
  }

  private fail(error: unknown): void {
    this.child = undefined
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
    }
    const reject = this.readyReject
    this.readyReject = undefined
    this.readyResolve = undefined
    reject?.(error)
  }
}
