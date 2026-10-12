import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildSeccompFilter,
  ensureSeccompFilter,
  filterArch,
  seccompWrapper,
} from '../../src/runtime/seccomp.ts'

const BPF_LD_ABS = 0x20
const BPF_RET_K = 0x06

describe('seccomp filter', () => {
  it('maps host architectures to filter architectures', () => {
    expect(filterArch('x64')).toBe('x86_64')
    expect(filterArch('amd64')).toBe('x86_64')
    expect(filterArch('arm64')).toBe('aarch64')
    expect(filterArch('riscv64')).toBeUndefined()
  })

  it('builds an x86_64 program that checks the arch and ends with ALLOW', () => {
    const bytes = buildSeccompFilter('x86_64')
    expect(bytes).toBeDefined()
    const program = bytes as Uint8Array
    expect(program.length % 8).toBe(0)
    // First instruction: LD abs at offset 4 (arch).
    expect([...program.slice(0, 8)]).toEqual([BPF_LD_ABS, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00])
    // Second instruction: JEQ AUDIT_ARCH_X86_64.
    expect([...program.slice(8, 16)]).toEqual([0x15, 0x00, 0x01, 0x00, 0x3e, 0x00, 0x00, 0xc0])
    // Last instruction: RET ALLOW (0x7fff0000 LE).
    const last = program.slice(program.length - 8)
    expect([...last]).toEqual([BPF_RET_K, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x7f])
  })

  it('builds an aarch64 program without the x32 guard', () => {
    const x86 = buildSeccompFilter('x86_64') as Uint8Array
    const arm = buildSeccompFilter('aarch64') as Uint8Array
    expect(arm.length).toBeGreaterThan(0)
    expect(arm.length).not.toBe(x86.length)
    expect(buildSeccompFilter('mips')).toBeUndefined()
  })

  it('refuses an operator filter path that does not exist', () => {
    const resolution = ensureSeccompFilter({ enabled: true, filterPath: '/no/such/filter.bpf', require: false }, tmpdir())
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.reason).toContain('SANDBOX_SECCOMP_FILTER_MISSING')
  })

  it('generates a baseline file when no path is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-seccomp-test-'))
    try {
      const resolution = ensureSeccompFilter({ enabled: true, require: false }, dir, 'x64')
      expect(resolution.ok).toBe(true)
      if (resolution.ok) {
        expect(statSync(resolution.path).size % 8).toBe(0)
        expect(resolution.path).toContain('baseline-v1-x86_64.bpf')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wraps the runner so fd 9 carries the filter', () => {
    const argv = seccompWrapper('/tmp/the filter.bpf', ['bwrap', '--seccomp', '9', '--', '/bin/true'])
    expect(argv[0]).toBe('bash')
    expect(argv[1]).toBe('-c')
    expect(argv[2]).toContain(`exec 9<'/tmp/the filter.bpf'`)
    expect(argv[2]).toContain('exec "$@"')
    expect(argv.slice(3)).toEqual(['bash', 'bwrap', '--seccomp', '9', '--', '/bin/true'])
  })
})
