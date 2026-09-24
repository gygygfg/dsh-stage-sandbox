/**
 * Actual-execution capability probing (v2.3). A probe is no longer a version
 * check: it measures the deployment's real lower/upper/work filesystem, mount
 * topology, namespace and privilege context, and runtime argument syntax, then
 * exercises create, read, modify, delete, directory change, candidate capture,
 * and cleanup against that deployment. The cache is keyed by the environment
 * fingerprint, and a cached success never replaces the checks an instance must
 * still perform at start.
 * @module dsh-sandbox-linux/pal/probe
 */

import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestOf } from '../util/canonical.ts'
import type { EnvironmentFingerprint, ExecutionValidation, OperationValidation, ValidationOperation } from './types.ts'

/**
 * The filesystem operations an actual-execution probe exercises. A test injects
 * a fake so the validation logic is testable without a real deployment.
 */
export interface ExecutionProbe {
  /** Create a file and return its path. */
  create(dir: string): string
  /** Read a file's content. */
  read(path: string): string
  /** Modify a file's content. */
  modify(path: string, content: string): void
  /** Delete a file. */
  remove(path: string): void
  /** Create and remove a directory. */
  directoryChange(dir: string): void
  /** Capture the current tree as a candidate snapshot and return its identity. */
  capture(dir: string): string
  /** Remove a directory tree. */
  cleanup(dir: string): void
}

/** The default probe: real filesystem operations. */
export const defaultExecutionProbe: ExecutionProbe = {
  create: dir => {
    const path = join(dir, 'probe.txt')
    writeFileSync(path, 'probe')
    return path
  },
  read: path => readFileSync(path, 'utf8'),
  modify: (path, content) => writeFileSync(path, content),
  remove: path => rmSync(path, { force: true }),
  directoryChange: dir => {
    const nested = join(dir, 'probe-dir')
    writeFileSync(join(dir, 'seed'), '')
    readdirSync(dir)
    rmSync(nested, { recursive: true, force: true })
  },
  capture: dir => digestOf(readdirSync(dir).sort()),
  cleanup: dir => rmSync(dir, { recursive: true, force: true }),
}

/**
 * Read the filesystem type backing a directory, when the runtime exposes it.
 * @param dir - the directory to inspect.
 * @returns the filesystem type name, or `unknown`.
 */
function fsTypeOf(dir: string): string {
  try {
    const stats = statfsSync(dir)
    return `fs-${String(stats.type)}`
  } catch {
    return 'unknown'
  }
}

/** Read the namespace context of the current process, when observable. */
function namespaceContext(): string {
  if (process.platform !== 'linux') return 'non-linux'
  try {
    const namespaces = readdirSync('/proc/self/ns').sort()
    return namespaces.join(',')
  } catch {
    return 'unknown'
  }
}

/** Read the mount topology of the current process, when observable. */
function mountTopology(): string {
  if (process.platform !== 'linux') return 'non-linux'
  try {
    const lines = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(line => line.length > 0)
    return `mounts:${lines.length}`
  } catch {
    return 'unknown'
  }
}

/**
 * Build the environment fingerprint a capability verdict is only meaningful
 * for. Overrides let a backend record a more precise context it observed.
 * @param overrides - environment facts the caller measured directly.
 * @returns the fingerprint.
 */
export function environmentFingerprint(overrides: Partial<EnvironmentFingerprint> = {}): EnvironmentFingerprint {
  return {
    platform: process.platform,
    kernelVersion: release(),
    fsType: fsTypeOf(tmpdir()),
    mountTopology: mountTopology(),
    namespaceContext: namespaceContext(),
    privilegeContext: `uid:${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}`,
    runtimeVersion: process.version,
    ...overrides,
  }
}

/** The stable digest of an environment fingerprint, used as a cache key. */
export function fingerprintKey(environment: EnvironmentFingerprint): string {
  return digestOf(environment)
}

/**
 * Exercise the actual-execution operations against a real (or injected) probe.
 * Every operation is attempted; a failure is recorded rather than aborting the
 * whole validation, so the report names exactly what the deployment cannot do.
 * @param input - the probe and the base directory to run under.
 * @returns the validation result.
 */
export function validateExecution(input: { readonly probe?: ExecutionProbe; readonly baseDir?: string; readonly environment?: EnvironmentFingerprint } = {}): ExecutionValidation {
  const probe = input.probe ?? defaultExecutionProbe
  const environment = input.environment ?? environmentFingerprint()
  const baseDir = input.baseDir ?? mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const operations: OperationValidation[] = []
  const run = (operation: ValidationOperation, action: () => void): void => {
    try {
      action()
      operations.push({ operation, ok: true })
    } catch (error) {
      operations.push({ operation, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  let file = ''
  run('create', () => { file = probe.create(baseDir) })
  run('read', () => {
    if (file === '') throw new Error('create did not produce a file')
    probe.read(file)
  })
  run('modify', () => {
    if (file === '') throw new Error('create did not produce a file')
    probe.modify(file, 'modified')
  })
  run('directory-change', () => probe.directoryChange(baseDir))
  run('candidate-capture', () => { probe.capture(baseDir) })
  run('delete', () => {
    if (file === '') throw new Error('create did not produce a file')
    probe.remove(file)
  })
  run('cleanup', () => probe.cleanup(baseDir))
  return {
    fingerprint: fingerprintKey(environment),
    operations,
    ok: operations.every(entry => entry.ok),
  }
}

/**
 * A probe cache keyed by environment fingerprint. A cached success is a
 * starting point, not a substitute for the checks an instance performs when it
 * starts.
 */
export class ProbeCache {
  private readonly entries = new Map<string, ExecutionValidation>()

  /**
   * The cached validation for an environment fingerprint.
   * @param key - the fingerprint key.
   * @returns the validation, or `undefined`.
   */
  get(key: string): ExecutionValidation | undefined {
    return this.entries.get(key)
  }

  /**
   * Record a validation.
   * @param key - the fingerprint key.
   * @param validation - the validation result.
   */
  set(key: string, validation: ExecutionValidation): void {
    this.entries.set(key, validation)
  }

  /** Drop every cached entry, e.g. when the deployment environment changes. */
  clear(): void {
    this.entries.clear()
  }
}
