/**
 * cgroup v2 resource domains (v2.3 §7.1). Each staged execution that opts in
 * gets a private subtree under `<base>/dsh/<id>` with `memory.max`,
 * `pids.max`, and `cpu.max` written from {@link LimitOptions}; on timeout or
 * cancel the whole tree is killed with `cgroup.kill`. OOM attribution reads
 * `memory.events` along the domain → ancestor → root chain and diffs against a
 * baseline taken at command start, so a pre-existing ancestor OOM is never
 * blamed on this command.
 *
 * Availability is honest: when the cgroup root is absent or unwritable the
 * domain reports unavailable and the caller must not claim a limit. Ported
 * from `NeoAI/lua/NeoAI/sandbox/cgroup.lua`.
 * @module dsh-sandbox-linux/runtime/cgroup
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import type { LimitOptions } from './options.ts'

/** The filesystem operations a cgroup domain uses (injected for tests). */
export interface CgroupIo {
  /** Whether a path exists. */
  exists(path: string): boolean
  /** Read a file's text, or `undefined` when unreadable. */
  readFile(path: string): string | undefined
  /** Write a file; returns whether it succeeded. */
  writeFile(path: string, content: string): boolean
  /** Create a directory tree; returns whether it succeeded. */
  mkdir(path: string): boolean
  /** Remove a directory tree (best effort). */
  remove(path: string): void
  /** List a directory's entry names (empty when unreadable). */
  list(path: string): string[]
}

/** The default IO over the real filesystem. */
export const nodeCgroupIo: CgroupIo = {
  exists: path => existsSync(path),
  readFile: path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  writeFile: (path, content) => {
    try {
      writeFileSync(path, content)
      return true
    } catch {
      return false
    }
  },
  mkdir: path => {
    try {
      mkdirSync(path, { recursive: true })
      return true
    } catch {
      return false
    }
  },
  remove: path => {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best effort: a busy domain stays for the next janitor pass.
    }
  },
  list: path => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
}

/** One snapshot of a cgroup's accounting files. */
export interface CgroupSnapshot {
  /** The cgroup directory the snapshot was read from. */
  readonly path: string
  /** `memory.events` text, when readable. */
  readonly memoryEvents?: string
  /** `pids.events` text, when readable. */
  readonly pidsEvents?: string
  /** `memory.peak` value, when readable. */
  readonly memoryPeak?: string
  /** `memory.max` value, when readable. */
  readonly memoryMax?: string
  /** `pids.max` value, when readable. */
  readonly pidsMax?: string
  /** `cpu.max` value, when readable. */
  readonly cpuMax?: string
}

/** The resolved numeric limits a domain applies. */
export interface ResolvedLimits {
  /** `memory.max` bytes, or `undefined` when unbounded/unknown. */
  readonly memoryMax?: number
  /** `pids.max`. */
  readonly pidsMax: number
  /** `cpu.max` quota in microseconds per 100 ms period, or `undefined` when unbounded. */
  readonly cpuQuota?: number
}

/**
 * Resolve the concrete limits from options, the host memory total, and the
 * host CPU count. Memory takes the absolute cap when given, else the ratio of
 * total memory. CPU is a percent of one core.
 * @param options - the limit options.
 * @param hostMemoryBytes - the host memory total (defaults to the real one).
 * @returns the resolved limits.
 */
export function resolveLimits(options: LimitOptions, hostMemoryBytes: number = totalmem()): ResolvedLimits {
  const absolute = options.memoryMaxBytes
  const memoryMax = absolute !== undefined && absolute > 0
    ? absolute
    : (hostMemoryBytes > 0 && options.memoryRatio > 0 ? Math.floor(hostMemoryBytes * options.memoryRatio) : undefined)
  const cpuQuota = options.cpuMax > 0 ? Math.round((options.cpuMax / 100) * 100_000) : undefined
  return {
    ...(memoryMax === undefined ? {} : { memoryMax }),
    pidsMax: options.pidsMax,
    ...(cpuQuota === undefined ? {} : { cpuQuota }),
  }
}

/** The host CPU count budget used when no explicit CPU cap is configured. */
export function hostCpuBudget(): number {
  return Math.max(1, cpus().length - 2)
}

/** Sum `oom_kill` and `oom_group_kill` counters from a `memory.events` text. */
export function readOomCount(memoryEvents: string | undefined): number {
  if (memoryEvents === undefined) return 0
  let total = 0
  for (const line of memoryEvents.split('\n')) {
    const [key, value] = line.trim().split(/\s+/u)
    if (key === 'oom_kill' || key === 'oom_group_kill') total += Number(value) || 0
  }
  return total
}

/** The cgroup path chain from a domain up to (and including) the base root. */
export function cgroupChain(domainPath: string, base: string): string[] {
  const normalizedBase = base.replace(/\/+$/u, '')
  const chain: string[] = []
  let current = domainPath.replace(/\/+$/u, '')
  while (current.startsWith(normalizedBase) && current.length > normalizedBase.length) {
    chain.push(current)
    const slash = current.lastIndexOf('/')
    if (slash <= 0) break
    current = current.slice(0, slash)
  }
  chain.push(normalizedBase)
  return chain
}

/** Capture each cgroup's OOM counter as the command-start baseline. */
export function oomBaseline(chain: readonly string[], io: CgroupIo = nodeCgroupIo): Map<string, number> {
  const baseline = new Map<string, number>()
  for (const path of chain) baseline.set(path, readOomCount(io.readFile(`${path}/memory.events`)))
  return baseline
}

/** The OOM attribution for one command's domain chain. */
export interface OomAttribution {
  /** Whether any cgroup in the chain recorded a new OOM kill. */
  readonly oom: boolean
  /** The cgroup that recorded it (`sandbox` when the domain itself did). */
  readonly level?: 'sandbox' | 'ancestor' | 'root'
  /** The cgroup path that recorded it. */
  readonly path?: string
  /** The number of new OOM kills since the baseline. */
  readonly oomKill?: number
}

/**
 * Attribute an OOM by diffing `memory.events` along the domain → ancestor →
 * root chain against the baseline. The deepest domain with an increase wins,
 * so a sandbox-domain limit is distinguished from a host/container OOM.
 * @param chain - the domain → root path chain (deepest first).
 * @param baseline - the counters captured at command start.
 * @param io - the cgroup IO (defaults to the real filesystem).
 * @returns the attribution.
 */
export function oomAttribution(
  chain: readonly string[],
  baseline: ReadonlyMap<string, number>,
  io: CgroupIo = nodeCgroupIo,
): OomAttribution {
  for (let index = 0; index < chain.length; index += 1) {
    const path = chain[index] as string
    const current = readOomCount(io.readFile(`${path}/memory.events`))
    const before = baseline.get(path) ?? 0
    if (current > before) {
      const level = index === 0 ? 'sandbox' : (index === chain.length - 1 ? 'root' : 'ancestor')
      return { oom: true, level, path, oomKill: current - before }
    }
  }
  return { oom: false }
}

/** Whether the cgroup v2 root is present and exposes controllers. */
export function cgroupAvailable(base: string = '/sys/fs/cgroup', io: CgroupIo = nodeCgroupIo): boolean {
  return io.exists(`${base}/cgroup.controllers`)
}

/** Sanitize an id for use as one cgroup directory name. */
function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/gu, '_')
}

/**
 * Enable the controllers this module needs (`memory`, `pids`) in one cgroup's
 * `subtree_control` when they are available but not yet delegated. Best
 * effort: an unwritable node is left as-is and the caller's limit writes may
 * then fail, which the capability report reflects.
 */
function enableControllers(dir: string, io: CgroupIo): void {
  const controllers = io.readFile(`${dir}/cgroup.controllers`)
  if (controllers === undefined) return
  const available = new Set(controllers.trim().split(/\s+/u))
  const current = new Set((io.readFile(`${dir}/cgroup.subtree_control`) ?? '').trim().split(/\s+/u))
  const add = ['memory', 'pids'].filter(name => available.has(name) && !current.has(name))
  if (add.length > 0) io.writeFile(`${dir}/cgroup.subtree_control`, add.map(name => `+${name}`).join(' '))
}

/**
 * A live cgroup v2 resource domain for one execution attempt. The caller
 * moves the process in (write its pid to {@link procsPath}) and later either
 * {@link kill}s and {@link release}s it, or just releases it.
 */
export class CgroupDomain {
  /** The domain directory. */
  readonly path: string
  /** The resolved limits the domain applied (the subset that took effect). */
  readonly applied: ResolvedLimits
  private readonly io: CgroupIo
  private readonly base: string

  private constructor(path: string, base: string, applied: ResolvedLimits, io: CgroupIo) {
    this.path = path
    this.base = base
    this.applied = applied
    this.io = io
  }

  /**
   * Create a domain, writing the configured limits. Returns `undefined` when
   * the cgroup root is unavailable or the domain directory cannot be created.
   * @param id - a caller-unique id (sanitized into the directory name).
   * @param options - the limit options.
   * @param io - the cgroup IO (defaults to the real filesystem).
   * @param hostMemoryBytes - the host memory total (defaults to the real one).
   * @returns the domain, or `undefined` when unavailable.
   */
  static create(
    id: string,
    options: LimitOptions,
    io: CgroupIo = nodeCgroupIo,
    hostMemoryBytes: number = totalmem(),
  ): CgroupDomain | undefined {
    const base = options.cgroupBase.replace(/\/+$/u, '')
    if (!options.enabled || !cgroupAvailable(base, io)) return undefined
    const parent = `${base}/dsh`
    if (!io.mkdir(parent)) return undefined
    // `memory.max`/`pids.max` only take effect when the controller is enabled
    // in the PARENT's subtree_control, so delegate down the chain first.
    enableControllers(base, io)
    enableControllers(parent, io)
    const path = `${parent}/${sanitizeId(id)}`
    if (!io.mkdir(path)) return undefined
    const limits = resolveLimits(options, hostMemoryBytes)
    if (limits.memoryMax !== undefined) {
      io.writeFile(`${path}/memory.max`, String(limits.memoryMax))
      // Without this a memory-capped command can silently swap and never OOM.
      io.writeFile(`${path}/memory.swap.max`, '0')
    }
    io.writeFile(`${path}/pids.max`, String(limits.pidsMax))
    if (limits.cpuQuota !== undefined) io.writeFile(`${path}/cpu.max`, `${limits.cpuQuota} 100000`)
    return new CgroupDomain(path, base, limits, io)
  }

  /** The `cgroup.procs` file a process pid is written to for membership. */
  procsPath(): string {
    return `${this.path}/cgroup.procs`
  }

  /** Move one pid into the domain (idempotent). */
  addProcess(pid: number): boolean {
    return this.io.writeFile(this.procsPath(), String(pid))
  }

  /** Kill every process in the domain (`cgroup.kill`). */
  kill(): boolean {
    return this.io.writeFile(`${this.path}/cgroup.kill`, '1')
  }

  /** One snapshot of the domain's accounting files. */
  snapshot(): CgroupSnapshot {
    const read = (file: string): string | undefined => this.io.readFile(`${this.path}/${file}`)
    const memoryEvents = read('memory.events')
    const pidsEvents = read('pids.events')
    const memoryPeak = read('memory.peak')
    const memoryMax = read('memory.max')
    const pidsMax = read('pids.max')
    const cpuMax = read('cpu.max')
    return {
      path: this.path,
      ...(memoryEvents === undefined ? {} : { memoryEvents }),
      ...(pidsEvents === undefined ? {} : { pidsEvents }),
      ...(memoryPeak === undefined ? {} : { memoryPeak }),
      ...(memoryMax === undefined ? {} : { memoryMax }),
      ...(pidsMax === undefined ? {} : { pidsMax }),
      ...(cpuMax === undefined ? {} : { cpuMax }),
    }
  }

  /** The domain → root path chain. */
  chain(): string[] {
    return cgroupChain(this.path, this.base)
  }

  /** Capture the command-start OOM baseline for the whole chain. */
  oomBaseline(): Map<string, number> {
    return oomBaseline(this.chain(), this.io)
  }

  /** Attribute a possible OOM against the captured baseline. */
  oomAttribution(baseline: ReadonlyMap<string, number>): OomAttribution {
    return oomAttribution(this.chain(), baseline, this.io)
  }

  /** Remove the domain directory (best effort). */
  release(): void {
    this.io.remove(this.path)
  }
}

/** List the domains currently under `<base>/dsh`, for startup garbage collection. */
export function listDomains(base: string = '/sys/fs/cgroup', io: CgroupIo = nodeCgroupIo): string[] {
  const root = `${base.replace(/\/+$/u, '')}/dsh`
  if (!io.exists(root)) return []
  return io.list(root).map(name => `${root}/${name}`)
}
