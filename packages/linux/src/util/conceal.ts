/**
 * Concealment helpers (v2.3 §4/§15): the model must never see sandbox-internal
 * paths or fingerprints, and a command's output must be reported in the real
 * workspace's paths. `restorePaths` rewrites staging paths to the real ones;
 * `redactFingerprint` removes residual sandbox identifiers from text that has
 * no path mapping.
 * @module dsh-sandbox-linux/util/conceal
 */

/** Substrings that identify sandbox internals and must not reach model output. */
const FINGERPRINTS: readonly string[] = [
  'dsh-logical-',
  'dsh-candidate-',
  'dsh-overlay-',
  'dsh-overlay-probe-',
  'dsh-resident-inbox-',
  'dsh-logical',
]

/** One path mapping: a staging prefix and the real prefix it represents. */
export interface PathMapping {
  /** The staging root (or prefix) to replace. */
  readonly from: string
  /** The real root to substitute. */
  readonly to: string
}

/**
 * Rewrite staging paths in text to their real workspace paths.
 * @param text - the text to rewrite.
 * @param mappings - the prefix mappings (longest `from` first is applied by caller order).
 * @returns the rewritten text.
 */
export function restorePaths(text: string, mappings: readonly PathMapping[]): string {
  let result = text
  for (const mapping of mappings) {
    if (mapping.from !== '') result = result.split(mapping.from).join(mapping.to)
  }
  return result
}

/**
 * Remove sandbox fingerprints from text that has no path mapping.
 * @param text - the text to redact.
 * @returns the redacted text.
 */
export function redactFingerprint(text: string): string {
  let result = text
  for (const fingerprint of FINGERPRINTS) result = result.split(fingerprint).join('')
  return result
}
