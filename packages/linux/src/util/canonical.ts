/**
 * Versioned canonical encoding and digesting for the sandbox control plane.
 * Every hash the control plane binds an authorization or a candidate to is
 * computed over this encoding, so field ordering, absent-value handling, and
 * number/string representation are fixed rather than incidental.
 * @module dsh-sandbox-linux/util/canonical
 */

import { createHash } from 'node:crypto'

/** The canonical encoding version, bound into every digest's prefix. */
export const CANONICAL_VERSION = 1

/**
 * Encode a JSON-compatible value deterministically: object keys in code-unit
 * order, arrays in order, no insignificant whitespace. A value the encoding
 * cannot represent (a function, symbol, bigint, or `undefined`) throws rather
 * than silently dropping a field that a digest is supposed to cover.
 * @param value - the value to encode.
 * @returns the canonical JSON text.
 */
export function canonicalize(value: unknown): string {
  return encode(value)
}

function encode(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite number is not representable')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${encode(entryValue)}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalize: value of type ${typeof value} is not representable`)
  }
}

/**
 * The `sha256:` digest of a value's canonical encoding.
 * @param value - the value to digest.
 * @returns the versioned digest string.
 */
export function digestOf(value: unknown): string {
  return digestOfText(canonicalize(value))
}

/**
 * The `sha256:` digest of raw text, prefixed with the canonical version so a
 * later encoding change is distinguishable from a content change.
 * @param text - the text to digest.
 * @returns the versioned digest string.
 */
export function digestOfText(text: string): string {
  const hash = createHash('sha256').update(`v${CANONICAL_VERSION}\n`).update(text).digest('hex')
  return `sha256:${hash}`
}
