import { describe, expect, it } from 'vitest'
import { canonicalize, digestOf, digestOfText } from '../../src/util/canonical.ts'

describe('canonical encoding', () => {
  it('sorts object keys so key order does not change the encoding', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }))
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('drops undefined object fields but rejects unrepresentable values', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(() => canonicalize({ a: () => 1 })).toThrow()
    expect(() => canonicalize({ a: Number.NaN })).toThrow()
    expect(() => canonicalize({ a: 1n })).toThrow()
  })

  it('encodes arrays in order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
    expect(digestOf([1, 2])).not.toBe(digestOf([2, 1]))
  })

  it('is stable and versioned', () => {
    expect(digestOf({ a: 1 })).toBe(digestOf({ a: 1 }))
    expect(digestOf({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(digestOfText('x')).not.toBe(digestOfText('y'))
  })
})
