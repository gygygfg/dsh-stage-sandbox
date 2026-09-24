import { describe, expect, it } from 'vitest'
import { detectObserverBackend, parseStraceFileAccesses, wrapWithStrace } from '../../src/runtime/observer.ts'

describe('observer backend detection', () => {
  it('prefers bpftrace, then strace, else none', () => {
    expect(detectObserverBackend(() => true)).toBe('bpftrace')
    expect(detectObserverBackend(binary => binary === 'strace')).toBe('strace')
    expect(detectObserverBackend(() => false)).toBe('none')
  })
})

describe('strace observation', () => {
  it('wraps the command with a follow-fork strace', () => {
    const argv = wrapWithStrace(['bwrap', '--', '/bin/cat'], '/tmp/trace')
    expect(argv.slice(0, 6)).toEqual(['strace', '-f', '-e', 'trace=openat,open,stat,lstat,access', '-o', '/tmp/trace'])
    expect(argv.slice(-2)).toEqual(['--', '/bin/cat'])
  })

  it('reports successful opens outside the workspace and ignores failures', () => {
    const output = [
      'openat(AT_FDCWD, "/ws/src/a.txt", O_RDONLY) = 3',
      'openat(AT_FDCWD, "/etc/passwd", O_RDONLY) = 4',
      'openat(AT_FDCWD, "/etc/missing", O_RDONLY) = -1 ENOENT (No such file or directory)',
      'open("/root/.ssh/id_rsa", O_RDONLY) = 5',
      'openat(AT_FDCWD, "/etc/passwd", O_RDONLY) = 6',
    ].join('\n')
    expect(parseStraceFileAccesses(output, '/ws')).toEqual(['/etc/passwd', '/root/.ssh/id_rsa'])
  })
})
