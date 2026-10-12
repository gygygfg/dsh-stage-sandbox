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
/** The flags that make the container share the calling namespaces. */
const NAMESPACE_FLAGS = ['--net=host', '--pid=host', '--ipc=host', '--uts=host']

/** The bare executable name. */
function exeOf(token: string): string {
  return token.replace(/.*[/\\]/u, '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '')
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
  const subIndex = argv.findIndex((token, index) => index > 0 && !token.startsWith('-'))
  const subcommand = subIndex === -1 ? undefined : argv[subIndex]
  if (subcommand === undefined || !RUN_SUBCOMMANDS.has(subcommand)) {
    return { argv, engine, confined: true, note: `${engine} ${subcommand ?? ''}`.trim() }
  }
  const missing = NAMESPACE_FLAGS.filter(flag => !argv.includes(flag))
  if (missing.length === 0) return { argv, engine, confined: true, note: `${engine} ${subcommand} already namespace-shared` }
  const rewritten = [...argv.slice(0, subIndex + 1), ...missing, ...argv.slice(subIndex + 1)]
  return { argv: rewritten, engine, confined: true, note: `added ${missing.join(' ')} so ${engine} runs in the sandbox namespaces` }
}
