import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWhiteout, mergeManifest, scanUpper } from '../../src/runtime/overlay.ts'
import type { ManifestEntry } from '../../src/candidate/manifest.ts'

const roots: string[] = []
function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('overlay whiteout detection', () => {
  it('recognises a 0:0 character device as a whiteout', () => {
    expect(isWhiteout({ isCharacterDevice: () => true, rdev: 0 })).toBe(true)
    expect(isWhiteout({ isCharacterDevice: () => true, rdev: 1 })).toBe(false)
    expect(isWhiteout({ isCharacterDevice: () => false, rdev: 0 })).toBe(false)
  })
})

describe('scanUpper', () => {
  it('captures created and modified files, directories, and symlinks', () => {
    const upper = tempRoot('dsh-upper-')
    mkdirSync(join(upper, 'src'))
    writeFileSync(join(upper, 'src', 'new.txt'), 'new')
    writeFileSync(join(upper, 'top.txt'), 'top')
    symlinkSync('top.txt', join(upper, 'link'))
    const capture = scanUpper(upper)
    expect(capture.deletions).toEqual([])
    const paths = capture.entries.map(entry => `${entry.kind}:${entry.path}`).sort()
    expect(paths).toEqual(['directory:src', 'file:src/new.txt', 'file:top.txt', 'symlink:link'])
    const file = capture.entries.find(entry => entry.path === 'src/new.txt')
    expect(file?.digest).toMatch(/^sha256:/)
  })

  it('returns nothing for a missing upper', () => {
    expect(scanUpper(join(tmpdir(), 'dsh-does-not-exist-xyz'))).toEqual({ entries: [], deletions: [] })
  })
})

describe('mergeManifest', () => {
  const base: ManifestEntry[] = [
    { path: 'src', kind: 'directory', mode: 0o755 },
    { path: 'src/a.txt', kind: 'file', mode: 0o644, size: 8, digest: 'sha256:a' },
    { path: 'src/keep.txt', kind: 'file', mode: 0o644, size: 4, digest: 'sha256:k' },
    { path: 'gone', kind: 'directory', mode: 0o755 },
    { path: 'gone/old.txt', kind: 'file', mode: 0o644, size: 1, digest: 'sha256:o' },
  ]

  it('overrides a modified file and keeps untouched base entries', () => {
    const changed: ManifestEntry[] = [{ path: 'src/a.txt', kind: 'file', mode: 0o644, size: 7, digest: 'sha256:a2' }]
    const merged = mergeManifest(base, changed, [])
    expect(merged.map(entry => entry.path)).toEqual(['gone', 'gone/old.txt', 'src', 'src/a.txt', 'src/keep.txt'])
    expect(merged.find(entry => entry.path === 'src/a.txt')?.digest).toBe('sha256:a2')
  })

  it('drops a deleted path and its descendants', () => {
    const merged = mergeManifest(base, [], ['gone'])
    expect(merged.map(entry => entry.path)).toEqual(['src', 'src/a.txt', 'src/keep.txt'])
  })

  it('drops base descendants when a file replaces a directory', () => {
    const changed: ManifestEntry[] = [{ path: 'gone', kind: 'file', mode: 0o644, size: 3, digest: 'sha256:g' }]
    const merged = mergeManifest(base, changed, [])
    expect(merged.map(entry => entry.path)).toEqual(['gone', 'src', 'src/a.txt', 'src/keep.txt'])
  })
})
