/**
 * Secret handling across the display, execution, and publication phases
 * (v2.3). A key placeholder is not simultaneously redacted display text, a
 * usable credential, and publishable content. Display uses controlled
 * placeholders; execution provides no real secret by default and only the
 * explicitly authorized ones; publication is performed by a trusted service
 * that constructs the final bytes, verifies them, freezes them, and binds the
 * final digest. When a mapping is lost, ambiguous, or unverifiable, publication
 * is refused — a placeholder is never written into a real file.
 * @module dsh-sandbox-linux/secrets/phases
 */

import { digestOfText } from '../util/canonical.ts'

/** The three phases a secret passes through. */
export type SecretPhase = 'display' | 'execute' | 'publish'

/** One placeholder-to-secret mapping. */
export interface SecretMapping {
  /** The placeholder token that appears in displayed and staged text. */
  readonly placeholder: string
  /** The secret identity the placeholder maps to. */
  readonly secretId: string
  /** The digest of the real secret, for verification without revealing it. */
  readonly secretDigest: string
  /** The digest of the baseline document the mapping was created against. */
  readonly baselineDigest: string
  /** The mapping version; a bump invalidates older approvals. */
  readonly mapVersion: number
}

/** The execution-phase secret resolution result. */
export type SecretResolution =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'denied'; readonly reason: string }

/** The publication-phase result. */
export type PublicationResult =
  | { readonly kind: 'published'; readonly text: string; readonly digest: string; readonly mapVersion: number }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Render text for display: replace every mapped secret occurrence with its
 * placeholder and redact any recognized secret material. This phase never
 * produces usable credentials.
 * @param text - the text to render.
 * @param mappings - the known mappings.
 * @param secrets - the real secret values, keyed by secret id.
 * @returns the display text.
 */
export function renderForDisplay(text: string, mappings: readonly SecretMapping[], secrets: Readonly<Record<string, string>> = {}): string {
  let rendered = text
  for (const mapping of mappings) {
    const value = secrets[mapping.secretId]
    if (value !== undefined && value.length > 0) rendered = rendered.split(value).join(mapping.placeholder)
  }
  return rendered
}

/**
 * Resolve placeholders for execution. No real secret is provided unless its id
 * is explicitly authorized; an unauthorized placeholder yields a denial rather
 * than a usable credential.
 * @param text - the displayed text.
 * @param mappings - the known mappings.
 * @param input - the real secrets and the authorized secret ids.
 * @returns the resolution.
 */
export function resolveForExecution(text: string, mappings: readonly SecretMapping[], input: { readonly secrets: Readonly<Record<string, string>>; readonly authorizedSecretIds: readonly string[] }): SecretResolution {
  const authorized = new Set(input.authorizedSecretIds)
  let resolved = text
  for (const mapping of mappings) {
    if (!resolved.includes(mapping.placeholder)) continue
    if (!authorized.has(mapping.secretId)) {
      return { kind: 'denied', reason: `secret '${mapping.secretId}' is not authorized for this execution` }
    }
    const value = input.secrets[mapping.secretId]
    if (value === undefined) return { kind: 'denied', reason: `secret '${mapping.secretId}' is unavailable` }
    resolved = resolved.split(mapping.placeholder).join(value)
  }
  return { kind: 'ok', text: resolved }
}

/**
 * Construct the final bytes for publication. Every placeholder in the text
 * must map unambiguously to a real secret whose digest matches the mapping; a
 * lost, ambiguous, or unverifiable mapping refuses publication. The result
 * binds the final digest and the mapping version.
 * @param text - the text to publish.
 * @param mappings - the known mappings.
 * @param input - the real secrets and the baseline digest the approval was bound to.
 * @returns the publication result.
 */
export function publishSecretBearingText(text: string, mappings: readonly SecretMapping[], input: { readonly secrets: Readonly<Record<string, string>>; readonly approvedBaselineDigest: string }): PublicationResult {
  const byPlaceholder = new Map<string, SecretMapping>()
  for (const mapping of mappings) {
    if (byPlaceholder.has(mapping.placeholder)) return { kind: 'refused', reason: `placeholder '${mapping.placeholder}' is ambiguous` }
    byPlaceholder.set(mapping.placeholder, mapping)
  }
  let finalText = text
  let mapVersion = 0
  for (const [placeholder, mapping] of byPlaceholder) {
    if (!finalText.includes(placeholder)) continue
    if (mapping.baselineDigest !== input.approvedBaselineDigest) {
      return { kind: 'refused', reason: `mapping for '${placeholder}' was created against a different baseline` }
    }
    const value = input.secrets[mapping.secretId]
    if (value === undefined) return { kind: 'refused', reason: `mapping for '${placeholder}' has no verifiable secret` }
    if (digestOfText(value) !== mapping.secretDigest) {
      return { kind: 'refused', reason: `mapping for '${placeholder}' does not match the secret it claims` }
    }
    finalText = finalText.split(placeholder).join(value)
    mapVersion = Math.max(mapVersion, mapping.mapVersion)
  }
  if (containsUnmappedPlaceholder(finalText)) {
    return { kind: 'refused', reason: 'publication text still contains an unmapped placeholder' }
  }
  return { kind: 'published', text: finalText, digest: digestOfText(finalText), mapVersion }
}

/** Whether the text still contains a placeholder-shaped token. */
function containsUnmappedPlaceholder(text: string): boolean {
  return /\{\{\s*secret:[^}]+\}\}/u.test(text)
}

/**
 * High-entropy scanning is auxiliary evidence only. It never substitutes for
 * explicit rules over known secrets and named credentials, and a suspected
 * high-entropy token is reported, not used to abort the whole agent.
 * @param text - the text to scan.
 * @returns the suspected tokens, as evidence only.
 */
export function highEntropyEvidence(text: string): readonly string[] {
  const tokens = text.split(/[^\w+/=.-]/u).filter(token => token.length >= 20)
  return tokens.filter(token => /^[A-Za-z0-9+/=_-]+$/u.test(token) && new Set(token).size >= 12)
}
