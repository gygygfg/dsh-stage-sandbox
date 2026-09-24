import { describe, expect, it } from 'vitest'
import { highEntropyEvidence, publishSecretBearingText, renderForDisplay, resolveForExecution, type SecretMapping } from '../../src/secrets/phases.ts'
import { digestOfText } from '../../src/util/canonical.ts'

const SECRET = 'sk-live-abcdef0123456789'
const baselineDigest = digestOfText('baseline-doc')
const mapping: SecretMapping = {
  placeholder: '{{secret:api}}',
  secretId: 'api',
  secretDigest: digestOfText(SECRET),
  baselineDigest,
  mapVersion: 1,
}

describe('secret phases', () => {
  it('display redacts real secrets to a placeholder', () => {
    const display = renderForDisplay(`token=${SECRET}`, [mapping], { api: SECRET })
    expect(display).toBe('token={{secret:api}}')
    expect(display).not.toContain(SECRET)
  })

  it('execution refuses an unauthorized secret and resolves an authorized one', () => {
    expect(resolveForExecution('{{secret:api}}', [mapping], { secrets: { api: SECRET }, authorizedSecretIds: [] })).toMatchObject({ kind: 'denied' })
    expect(resolveForExecution('{{secret:api}}', [mapping], { secrets: { api: SECRET }, authorizedSecretIds: ['api'] })).toEqual({ kind: 'ok', text: SECRET })
  })

  it('publication constructs verified final bytes and binds the digest', () => {
    const result = publishSecretBearingText('Authorization: {{secret:api}}', [mapping], { secrets: { api: SECRET }, approvedBaselineDigest: baselineDigest })
    expect(result.kind).toBe('published')
    if (result.kind === 'published') {
      expect(result.text).toBe(`Authorization: ${SECRET}`)
      expect(result.digest).toBe(digestOfText(result.text))
      expect(result.mapVersion).toBe(1)
    }
  })

  it('refuses publication when the mapping is lost or stale, never writing a placeholder', () => {
    expect(publishSecretBearingText('{{secret:api}}', [], { secrets: { api: SECRET }, approvedBaselineDigest: baselineDigest })).toMatchObject({ kind: 'refused' })
    expect(publishSecretBearingText('{{secret:api}}', [mapping], { secrets: { api: SECRET }, approvedBaselineDigest: digestOfText('other') })).toMatchObject({ kind: 'refused' })
    expect(publishSecretBearingText('{{secret:api}}', [mapping], { secrets: {}, approvedBaselineDigest: baselineDigest })).toMatchObject({ kind: 'refused' })
  })

  it('treats high-entropy scanning as auxiliary evidence only', () => {
    const evidence = highEntropyEvidence(`key ${'A1b2C3d4E5f6G7h8I9j0'}`)
    expect(evidence).toContain('A1b2C3d4E5f6G7h8I9j0')
  })
})
