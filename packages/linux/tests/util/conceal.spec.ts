import { describe, expect, it } from 'vitest'
import { redactFingerprint, restorePaths } from '../../src/util/conceal.ts'

describe('concealment', () => {
  it('rewrites staging paths to real workspace paths', () => {
    const text = 'wrote /stage/src/a.txt and /stage/src/b.txt'
    expect(restorePaths(text, [{ from: '/stage', to: '/real/ws' }])).toBe('wrote /real/ws/src/a.txt and /real/ws/src/b.txt')
  })

  it('removes sandbox fingerprints', () => {
    expect(redactFingerprint('in /tmp/dsh-logical-abc/src')).toBe('in /tmp/abc/src')
    expect(redactFingerprint('dsh-overlay-xyz')).toBe('xyz')
  })
})
