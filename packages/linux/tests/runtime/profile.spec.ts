import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { bwrapProfileArgs, type ProfileIo } from '../../src/runtime/profile.ts'
import { DEFAULT_RUNTIME_OPTIONS, type RuntimeOptions } from '../../src/runtime/options.ts'

/** A fake filesystem: the listed paths exist, the listed dirs are directories. */
function fakeIo(files: readonly string[], dirs: readonly string[], globs: Readonly<Record<string, string[]>> = {}): ProfileIo {
  const all = new Set([...files, ...dirs])
  const dirSet = new Set(dirs)
  return {
    exists: path => all.has(path),
    isDirectory: path => dirSet.has(path),
    glob: pattern => globs[pattern] ?? [],
  }
}

const WS: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/ws' }
const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }

/** The pre-existing host paths the tests pretend are present. */
const FILES = ['/usr/bin/sh', '/etc/passwd', '/etc/shadow', '/root/.netrc', '/home/alice/.ssh/config']
const DIRS = ['/usr', '/usr/bin', '/usr/share', '/var/lib', '/var/lib/docker', '/root/.ssh', '/home/alice/.ssh', '/proc/sys', '/ws', '/tmp']

/** Whether `sequence` occurs contiguously in `argv`. */
function hasSequence(argv: readonly string[], sequence: readonly string[]): boolean {
  outer: for (let start = 0; start + sequence.length <= argv.length; start += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (argv[start + offset] !== sequence[offset]) continue outer
    }
    return true
  }
  return false
}

describe('bwrap runtime profile', () => {
  const io = fakeIo(FILES, DIRS, { '/home/*/.ssh': ['/home/alice/.ssh'] })

  it('never binds the whole host root read-only', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--ro-bind', '/', '/'])).toBe(false)
    expect(hasSequence(argv, ['--ro-bind-try', '/', '/'])).toBe(false)
  })

  it('binds only the minimal read-only whitelist that exists', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--ro-bind-try', '/usr/bin', '/usr/bin'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind-try', '/usr/share', '/usr/share'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind-try', '/etc/passwd', '/etc/passwd'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind-try', '/var/lib', '/var/lib'])).toBe(true)
    // /usr is not bound whole (only its whitelisted subtrees).
    expect(hasSequence(argv, ['--ro-bind-try', '/usr', '/usr'])).toBe(false)
  })

  it('mounts a fresh /proc with sysctls read-only', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--proc', '/proc'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind-try', '/proc/sys', '/proc/sys'])).toBe(true)
  })

  it('gives workspace-write a private tmpfs and a writable workspace bind', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--bind', '/ws', '/ws'])).toBe(true)
    expect(hasSequence(argv, ['--tmpfs', '/tmp'])).toBe(true)
  })

  it('keeps read-only mode read-only but workspace-readable', () => {
    const argv = bwrapProfileArgs(RO, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--bind', '/ws', '/ws'])).toBe(false)
    expect(hasSequence(argv, ['--ro-bind-try', '/ws', '/ws'])).toBe(true)
    // No writable tmpfs roots under read-only.
    expect(hasSequence(argv, ['--tmpfs', '/tmp'])).toBe(false)
    expect(hasSequence(argv, ['--tmpfs', '/var/tmp'])).toBe(false)
  })

  it('masks sensitive directories with tmpfs and files with /dev/null', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--tmpfs', '/root/.ssh'])).toBe(true)
    expect(hasSequence(argv, ['--tmpfs', '/var/lib/docker'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind', '/dev/null', '/etc/shadow'])).toBe(true)
    expect(hasSequence(argv, ['--ro-bind', '/dev/null', '/root/.netrc'])).toBe(true)
  })

  it('applies masks after the writable mounts so they win', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    const workspace = argv.indexOf('--bind')
    const docker = argv.lastIndexOf('/var/lib/docker')
    expect(docker).toBeGreaterThan(workspace)
  })

  it('unshares the network namespace only under an isolating mode', () => {
    const observed = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(observed).not.toContain('--unshare-net')
    const offline: RuntimeOptions = { ...DEFAULT_RUNTIME_OPTIONS, networkMode: 'OFFLINE' }
    expect(bwrapProfileArgs(WS, offline, io)).toContain('--unshare-net')
  })

  it('expands glob masks and skips missing paths', () => {
    const argv = bwrapProfileArgs(WS, DEFAULT_RUNTIME_OPTIONS, io)
    expect(hasSequence(argv, ['--tmpfs', '/home/alice/.ssh'])).toBe(true)
    // /proc/kcore does not exist in the fake io, so it is not masked.
    expect(argv).not.toContain('/proc/kcore')
  })
})
