/**
 * Container runtime control (v2.3 §16). An AI-invoked container must not escape
 * the sandbox by attaching to the host's PID/network/IPC/UTS namespaces. For
 * `podman`/`nerdctl` the command is rewritten to share the SANDBOX's
 * namespaces (`--net=host …` inside the sandbox means the sandbox's), so the
 * container inherits the confinement. `docker` is left unchanged: it reaches a
 * controlled socket, and the orchestrator socket is masked by default.
 * @module dsh-sandbox-linux/runtime/container
 */

/** A container command's plan. */
export interface ContainerPlan {
  /** The (possibly rewritten) argv. */
  readonly argv: readonly string[]
  /** The detected engine. */
  readonly engine: 'podman' | 'nerdctl' | 'docker'
  /** Whether the plan keeps the container inside the sandbox namespaces. */
  readonly confined: boolean
  /** A short note for diagnostics. */
  readonly note: string
}

/** Engines that can share the sandbox's namespaces via flags. */
const NAMESPACE_ENGINES = new Set(['podman', 'nerdctl'])
/** Subcommands that start a container and accept namespace flags. */
const RUN_SUBCOMMANDS = new Set(['run', 'create'])
/** The canonical flags that make the container share the calling namespaces. */
const NAMESPACE_FLAGS = ['--net=host', '--pid=host', '--ipc=host', '--uts=host'] as const

/**
 * Global options that take a separate value. Without this list, a value such as
 * `debug` in `podman --log-level debug run …` was mistaken for the subcommand
 * and the namespace flags were never added.
 */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--root',
  '--runroot',
  '--storage-driver',
  '--storage-opt',
  '--tmpdir',
  '--log-level',
  '--events-backend',
  '--cgroup-manager',
  '--runtime',
  '--runtime-flag',
  '--conmon',
  '--network-config-dir',
  '--registries-conf',
  '--registries-conf-dir',
  '--signature-policy',
  '--policy',
  '--url',
  '--identity',
  '--connection',
  '--context',
  '--namespace',
  '--secret',
  '--module',
  '--hooks-dir',
  '--db-backend',
  '--transient-store',
])

/** The bare executable name. */
function exeOf(token: string): string {
  return token.replace(/.*[/\\]/u, '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '')
}

/**
 * The index of the `run`/`create` subcommand, or -1 when this is not a
 * container-start command. Handles `podman container run`, `podman --root … run`
 * and global options written as `--opt=value` or `--opt value`.
 */
function findRunSubcommand(argv: readonly string[]): number {
  let index = 1
  while (index < argv.length) {
    const token = argv[index] as string
    if (token === 'container') {
      const next = argv[index + 1]
      return next !== undefined && RUN_SUBCOMMANDS.has(next.toLowerCase()) ? index + 1 : -1
    }
    if (token.startsWith('-')) {
      const name = token.toLowerCase()
      index += !name.includes('=') && GLOBAL_OPTIONS_WITH_VALUE.has(name) ? 2 : 1
      continue
    }
    return RUN_SUBCOMMANDS.has(token.toLowerCase()) ? index : -1
  }
  return -1
}

/** Whether any spelling of the namespace flag is already pinned to `host`. */
function hasHostFlag(argv: readonly string[], names: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = (argv[index] as string).toLowerCase()
    const flag = names.find(name => token === name || token.startsWith(`${name}=`))
    if (flag === undefined) continue
    if (token === `${flag}=host`) return true
    if (token === flag && (argv[index + 1] ?? '').toLowerCase() === 'host') return true
    // An explicit non-host value is still a value: adding a second one is
    // ambiguous, so treat it as "already specified" and leave it to the caller.
    if (token !== flag) return true
    if (index + 1 < argv.length && !(argv[index + 1] as string).startsWith('-')) return true
  }
  return false
}

/**
 * Plan a container command so it stays inside the sandbox.
 * @param argv - the requested argv.
 * @returns the plan, or `undefined` when it is not a container command.
 */
export function planContainerCommand(argv: readonly string[]): ContainerPlan | undefined {
  const engine = exeOf(argv[0] ?? '')
  if (engine !== 'podman' && engine !== 'nerdctl' && engine !== 'docker') return undefined
  if (engine === 'docker') {
    return { argv, engine, confined: false, note: 'docker reaches a controlled socket; the orchestrator socket is masked by default' }
  }
  if (!NAMESPACE_ENGINES.has(engine)) return undefined
  const subIndex = findRunSubcommand(argv)
  if (subIndex === -1) {
    return { argv, engine, confined: true, note: `${engine} does not start a container` }
  }
  const subcommand = argv[subIndex] as string
  const missing = NAMESPACE_FLAGS.filter(flag => {
    if (flag === '--net=host') return !hasHostFlag(argv, ['--net', '--network'])
    if (flag === '--pid=host') return !hasHostFlag(argv, ['--pid'])
    if (flag === '--ipc=host') return !hasHostFlag(argv, ['--ipc'])
    return !hasHostFlag(argv, ['--uts'])
  })
  if (missing.length === 0) return { argv, engine, confined: true, note: `${engine} ${subcommand} already namespace-shared` }
  const rewritten = [...argv.slice(0, subIndex + 1), ...missing, ...argv.slice(subIndex + 1)]
  return { argv: rewritten, engine, confined: true, note: `added ${missing.join(' ')} so ${engine} runs in the sandbox namespaces` }
}
