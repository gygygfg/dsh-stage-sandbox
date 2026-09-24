/**
 * The seccomp baseline (v2.3 §7.1): a classic-BPF denylist applied to the
 * payload via `bwrap --seccomp FD`. It blocks dangerous syscalls (mount,
 * ptrace, bpf, module/key/io_uring families, …), rejects device-node creation
 * (`mknod`/`mknodat` with S_IFCHR/S_IFBLK — a raw-disk escape that bypasses
 * overlay staging), restricts `socket(2)` address families, and kills the x32
 * ABI (whose syscall numbers defeat exact-match comparisons).
 *
 * Because the provider's `confine` returns argv only, the filter fd is opened
 * by a tiny bash wrapper that `exec`s bwrap with fd 9 held open. bwrap itself
 * sets up privileges unfiltered and loads the filter onto the payload.
 *
 * Ported from `NeoAI/lua/NeoAI/sandbox/seccomp.lua`.
 * @module dsh-sandbox-linux/runtime/seccomp
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SeccompOptions } from './options.ts'

// Classic-BPF opcodes and seccomp return codes.
const BPF_LD_ABS = 0x20
const BPF_JEQ_K = 0x15
const BPF_JSET_K = 0x45
const BPF_RET_K = 0x06
const SECCOMP_RET_KILL_PROCESS = 0x80000000
const SECCOMP_RET_ALLOW = 0x7fff0000
const SECCOMP_RET_ERRNO_EPERM = 0x00050000 + 1
const SECCOMP_RET_ERRNO_ENOSYS = 0x00050000 + 38
const AUDIT_ARCH_X86_64 = 0xc000003e
const AUDIT_ARCH_AARCH64 = 0xc00000b7
/** `__X32_SYSCALL_BIT`: x32 shares the x86_64 arch but offsets the number. */
const X32_SYSCALL_BIT = 0x40000000

// seccomp_data field offsets: nr@0, arch@4, ip@8, args@16.
const ARG0_OFFSET = 16
const ARG1_OFFSET = 24
const ARG2_OFFSET = 32
/** clone(2) namespace flags: NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET. */
const CLONE_NS_MASK = 0x7e020000
/** mknod mode device bits: S_IFCHR(0x2000) | S_IFBLK(0x6000). */
const S_IFDEV_MASK = 0x6000
/** Allowed socket address families: AF_UNIX/AF_INET/AF_INET6/AF_NETLINK. */
const AF_ALLOW: readonly number[] = [1, 2, 10, 16]

/** One architecture's denylist. */
interface ArchSpec {
  readonly audit: number
  readonly clone: number
  readonly clone3?: number
  readonly socket: number
  readonly x32Guard?: boolean
  readonly mknod?: number
  readonly mknodat: number
  readonly blocked: readonly number[]
}

const ARCH: Record<string, ArchSpec> = {
  x86_64: {
    audit: AUDIT_ARCH_X86_64,
    clone: 56,
    clone3: 435,
    socket: 41,
    x32Guard: true,
    mknod: 133,
    mknodat: 259,
    blocked: [
      101, 155, 159, 161, 163, 164, 165, 166, 167, 168, 169, 172, 173,
      175, 176, 179, 227, 246, 248, 249, 250, 272, 298, 303, 304, 305, 308,
      310, 311, 312, 313, 321, 323, 425, 426, 427, 428, 429, 430, 431, 432,
      433, 438, 440, 442,
    ],
  },
  aarch64: {
    audit: AUDIT_ARCH_AARCH64,
    clone: 220,
    socket: 198,
    mknodat: 33,
    blocked: [
      40, 39, 41, 51, 60, 89, 97, 104, 105, 106, 112, 117, 142, 170, 171,
      217, 218, 219, 224, 225, 241, 264, 265, 266, 268, 270, 271, 273, 280,
      282, 425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 440, 442,
    ],
  },
}

/** Resolve the running CPU architecture to a filter architecture. */
export function filterArch(machine: string = process.arch): 'x86_64' | 'aarch64' | undefined {
  if (machine === 'x86_64' || machine === 'amd64' || machine === 'x64') return 'x86_64'
  if (machine === 'aarch64' || machine === 'arm64') return 'aarch64'
  return undefined
}

/** Growable little-endian byte writer for sock_filter programs. */
class BpfWriter {
  private readonly bytes: number[] = []

  /** Append one 8-byte `sock_filter` (`code` u16, `jt` u8, `jf` u8, `k` u32). */
  insn(code: number, jt: number, jf: number, k: number): void {
    this.bytes.push(code & 0xff, (code >> 8) & 0xff, jt & 0xff, jf & 0xff)
    this.bytes.push(k & 0xff, (k >>> 8) & 0xff, (k >>> 16) & 0xff, (k >>> 24) & 0xff)
  }

  /** The encoded program. */
  finish(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

/**
 * Build the denylist BPF program for one architecture.
 * @param arch - the filter architecture.
 * @returns the encoded program, or `undefined` for an unsupported architecture.
 */
export function buildSeccompFilter(arch: string): Uint8Array | undefined {
  const spec = ARCH[arch]
  if (spec === undefined) return undefined
  const w = new BpfWriter()
  w.insn(BPF_LD_ABS, 0, 0, 4)
  w.insn(BPF_JEQ_K, 1, 0, spec.audit)
  w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)
  w.insn(BPF_LD_ABS, 0, 0, 0)
  if (spec.x32Guard === true) {
    w.insn(BPF_JSET_K, 0, 1, X32_SYSCALL_BIT)
    w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)
  }
  // socket: allow the listed address families, EPERM the rest.
  {
    const n = AF_ALLOW.length
    w.insn(BPF_JEQ_K, 0, n + 2, spec.socket)
    w.insn(BPF_LD_ABS, 0, 0, ARG0_OFFSET)
    for (let i = 0; i < n; i += 1) w.insn(BPF_JEQ_K, n - i + 1, 0, AF_ALLOW[i] as number)
    w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM)
  }
  // clone: deny namespace-creating flags, else allow.
  w.insn(BPF_JEQ_K, 0, 3, spec.clone)
  w.insn(BPF_LD_ABS, 0, 0, ARG0_OFFSET)
  w.insn(BPF_JSET_K, 0, 1, CLONE_NS_MASK)
  w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM)
  // clone3: can't deref the flags pointer → ENOSYS so glibc falls back to clone.
  if (spec.clone3 !== undefined) {
    w.insn(BPF_JEQ_K, 0, 1, spec.clone3)
    w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_ENOSYS)
  }
  // mknod/mknodat: deny device nodes (mode has S_IFCHR/S_IFBLK).
  if (spec.mknod !== undefined) {
    w.insn(BPF_JEQ_K, 0, 3, spec.mknod)
    w.insn(BPF_LD_ABS, 0, 0, ARG1_OFFSET)
    w.insn(BPF_JSET_K, 0, 1, S_IFDEV_MASK)
    w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM)
  }
  w.insn(BPF_JEQ_K, 0, 3, spec.mknodat)
  w.insn(BPF_LD_ABS, 0, 0, ARG2_OFFSET)
  w.insn(BPF_JSET_K, 0, 1, S_IFDEV_MASK)
  w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM)
  for (const nr of spec.blocked) {
    w.insn(BPF_JEQ_K, 0, 1, nr)
    w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM)
  }
  w.insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW)
  return w.finish()
}

/** The result of resolving a seccomp filter file. */
export type SeccompResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Ensure a filter file exists: an operator-supplied path is used verbatim;
 * otherwise a versioned baseline is generated for the running architecture.
 * @param options - the seccomp options.
 * @param dir - the directory generated baselines are written under.
 * @param arch - the architecture to generate for (defaults to the host).
 * @returns the filter path, or a refusal reason.
 */
export function ensureSeccompFilter(options: SeccompOptions, dir: string, arch: string = process.arch): SeccompResolution {
  if (options.filterPath !== undefined && options.filterPath !== '') {
    if (existsSync(options.filterPath)) return { ok: true, path: options.filterPath }
    return { ok: false, reason: `SANDBOX_SECCOMP_FILTER_MISSING: ${options.filterPath}` }
  }
  const name = filterArch(arch)
  if (name === undefined) return { ok: false, reason: `SANDBOX_SECCOMP_ARCH_UNSUPPORTED: ${arch}` }
  const bytes = buildSeccompFilter(name)
  if (bytes === undefined) return { ok: false, reason: `SANDBOX_SECCOMP_BUILD_FAILED: ${name}` }
  const path = join(dir, `baseline-v1-${name}.bpf`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, bytes)
  } catch (error) {
    return { ok: false, reason: `SANDBOX_SECCOMP_WRITE_FAILED: ${path}: ${String(error)}` }
  }
  return { ok: true, path }
}

/** Whether a filter is available for this host/configuration. */
export function seccompAvailable(options: SeccompOptions, dir: string, arch: string = process.arch): boolean {
  return ensureSeccompFilter(options, dir, arch).ok
}

/** Quote one path as a single-quoted POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * Wrap a runner argv so fd 9 carries the seccomp filter into `bwrap --seccomp
 * 9`. The wrapper `exec`s the runner (replacing bash), so no extra process
 * survives; the filter is opened without CLOEXEC and is inherited.
 * @param filterPath - the filter file to open.
 * @param runnerArgv - the runner argv (`bwrap` plus profile args, including `--seccomp 9`).
 * @returns the argv to spawn instead.
 */
export function seccompWrapper(filterPath: string, runnerArgv: readonly string[]): string[] {
  const script = `exec 9<${shellQuote(filterPath)}; exec "$@"`
  return ['bash', '-c', script, 'bash', ...runnerArgv]
}
