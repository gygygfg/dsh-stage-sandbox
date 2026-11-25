/**
 * A bounded, reviewable preview of one registry value.
 *
 * Why the review surface needs this
 * ---------------------------------
 * `ReviewService.registryRows()` used to expose only the key, the value name,
 * the operation and the risk class. That is enough to say "something wrote to
 * `HKCU\...\Run`", but not enough to say **what will run**: the payload
 * (`calc.exe`, a script, a DLL path) lives in the value data, which stayed in
 * the overlay journal. A reviewer could see the target and still approve a
 * backdoor, which is the precise failure mode "verifiable" is supposed to
 * exclude.
 *
 * This module decodes the value with the same codec the stage uses
 * (`decodeRegistryValue`) and returns a short, printable preview. It is
 * deliberately **display-only**: the bytes that are applied are still the
 * frozen journal bytes, never this string.
 *
 * @module winstage-sandbox/registry-preview
 */

import { decodeRegistryValue } from './registry-guard.ts'

/** A display preview of one registry value. */
export interface RegistryPreview {
  /** Printable text, truncated to the caller's limit. */
  readonly text: string
  /** Raw byte length of the encoded value. */
  readonly bytes: number
  /** True when the text was replaced because the value name looks secret. */
  readonly redacted: boolean
  /** The registry type name, when it could be resolved. */
  readonly type?: string
  /** Why the preview is not the full value (`truncated` / `redacted` / `undecodable`). */
  readonly note?: string
}

/** Render a decoded value as one line. */
function renderDecoded(value: unknown): string {
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : value.join('; ')
  if (Buffer.isBuffer(value)) {
    return value.length === 0 ? '(empty)' : value.toString('hex')
  }
  return String(value)
}

/**
 * Preview one registry value.
 * @param type - the registry type (name or numeric value).
 * @param dataHex - the encoded value bytes as lower-case hex.
 * @param options - `maxChars` (default 160) and `sensitive` (redact the text).
 * @returns the preview; never throws for an unsupported type (it falls back to
 *   a hex head and says so).
 */
export function previewRegistryValue(
  type: unknown,
  dataHex: unknown,
  options: { maxChars?: number; sensitive?: boolean } = {},
): RegistryPreview {
  const maxChars = Math.max(8, Number(options.maxChars) || 160)
  const hex = typeof dataHex === 'string' ? dataHex : ''
  const bytes = Math.floor(hex.length / 2)
  let typeName: string | undefined
  try {
    typeName = typeof type === 'string' ? type : undefined
  } catch {
    typeName = undefined
  }

  if (options.sensitive === true) {
    return {
      text: `[redacted len=${bytes}]`,
      bytes,
      redacted: true,
      ...(typeName === undefined ? {} : { type: typeName }),
      note: 'redacted',
    }
  }

  let text: string
  let note: string | undefined
  try {
    text = renderDecoded(decodeRegistryValue(type as never, hex))
  } catch {
    // Unsupported codec: show the bytes rather than claiming the value is
    // empty. The raw hex is enough for a reviewer to recognise a payload.
    text = bytes === 0 ? '(empty)' : hex
    note = 'undecodable'
  }

  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}… (+${text.length - maxChars} chars)`
    note = note === undefined ? 'truncated' : `${note}+truncated`
  }
  return {
    text,
    bytes,
    redacted: false,
    ...(typeName === undefined ? {} : { type: typeName }),
    ...(note === undefined ? {} : { note }),
  }
}
