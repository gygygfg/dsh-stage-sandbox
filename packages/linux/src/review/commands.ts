/**
 * Human commands for reviewing and applying staged candidates. They expose the
 * workspace-staging service to the user: inspect the pending filesystem
 * changes and their danger level, apply them under CAS, or discard them.
 * @module dsh-sandbox-linux/review/commands
 */

import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { markerAnsi } from '../candidate/danger.ts'
import type {} from '../stage/workspace-service.ts'

/** Services this plugin requires before its commands register. */
export const inject = ['commands', 'sandboxWorkspace', 'sandboxPolicy']

/** Parse a `--file <path>` (or `--file=<path>`) argument, resolved against the root. */
function filesArg(raw: string, root: string): string[] | undefined {
  const match = /--file(?:=|\s+)(\S+)/u.exec(raw)
  if (match === null || match[1] === undefined) return undefined
  const value = match[1]
  return [isAbsolute(value) ? value : join(root, value)]
}

/** Render a staged change as one review line. */
function describe(kind: string, path: string): string {
  return `  ${kind.padEnd(6)} ${path}`
}

/** Render a colored danger header for a level/marker. */
function dangerHeader(level: string, marker: 'green' | 'yellow' | 'red'): string {
  const reset = '\u001B[0m'
  const label = level === 'L1' ? 'L1 green' : level === 'L2' ? 'L2 yellow' : 'L3 red'
  return `${markerAnsi(marker)}● ${label}${reset}`
}

/**
 * Register the review commands. They operate on the workspace the current
 * sandbox policy resolves to.
 * @param ctx - the plugin context; `ctx.commands`, `ctx.sandboxWorkspace`, and
 *   `ctx.sandboxPolicy` must be mounted.
 */
export function apply(ctx: Context): void {
  const root = (): string => ctx.sandboxPolicy.resolve().workspaceRoot

  ctx.effect(() => ctx.commands.register({
    name: 'sandbox-review',
    description: 'List the staged sandbox candidate, its danger level, and any confirmation it needs',
    handler: () => {
      const state = ctx.sandboxWorkspace.state(root())
      if (state.changes.length === 0 && state.pending === null) return { kind: 'success', text: 'No staged changes.' }
      const lines = state.changes.map(change => describe(change.kind, change.path))
      const parts = [`Staged changes (${state.changes.length}):\n${lines.join('\n')}`]
      if (state.danger.dangerous && state.danger.marker !== null) {
        const reasons = state.danger.reasons.map(reason => `  ${reason.level} ${reason.code} ${reason.detail}`)
        parts.push(`${dangerHeader(state.danger.level, state.danger.marker)}\n${reasons.join('\n')}`)
        if (state.danger.consequences.length > 0) {
          parts.push(`Consequences:\n${state.danger.consequences.map(line => `  - ${line}`).join('\n')}`)
        }
      }
      if (state.pending !== null) {
        const pending = state.pending
        parts.push(`A candidate is frozen and awaiting confirmation (${pending.candidate.digest.slice(0, 24)}…): `
          + `${pending.confirmationsReceived}/${pending.confirmationsRequired} confirmations. `
          + `Run /sandbox-apply --force to confirm, or /sandbox-discard to reject.`)
      }
      return { kind: 'success', text: parts.join('\n\n') }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'sandbox-apply',
    description: 'Publish the staged sandbox candidate under CAS (--force confirms a policy review or a dangerous operation; L3 needs two confirmations)',
    handler: async invocation => {
      const force = /(^|\s)--force(\s|$)/u.test(invocation.rawInput)
      const files = filesArg(invocation.rawInput, root())
      const result = await ctx.sandboxWorkspace.apply(root(), { force, confirm: force, ...(files === undefined ? {} : { files }) })
      if (result.kind === 'published') return { kind: 'success', text: `Applied candidate ${result.candidate?.digest ?? 'unknown'}.` }
      if (result.kind === 'needs-authorization') {
        const pending = ctx.sandboxWorkspace.state(root()).pending
        const header = result.danger?.dangerous === true && result.danger.marker !== null
          ? `${dangerHeader(result.danger.level, result.danger.marker)} `
          : ''
        const consequences = result.danger?.consequences.length
          ? `\nConsequences:\n${result.danger.consequences.map(line => `  - ${line}`).join('\n')}`
          : ''
        const progress = pending !== null ? ` (${pending.confirmationsReceived}/${pending.confirmationsRequired} confirmations)` : ''
        const action = pending !== null && pending.confirmationsReceived < pending.confirmationsRequired
          ? `Re-run /sandbox-apply --force to confirm${pending.confirmationsRequired > 1 ? ' again' : ''}.`
          : 'Re-run /sandbox-apply --force to confirm.'
        return { kind: 'error', text: `${header}Confirmation required${progress}: ${result.reasonCodes?.join(', ') ?? 'review'}.${consequences}\n${action}` }
      }
      if (result.kind === 'denied') return { kind: 'error', text: `Policy denied the candidate: ${result.reasonCodes?.join(', ') ?? 'denied'}.` }
      if (result.kind === 'corrupted') {
        const paths = result.corrupted?.map(record => record.relative).join(', ') ?? 'unknown'
        return { kind: 'error', text: `Cannot apply: the staged view is corrupted (${paths}). Publication is blocked rather than inferred as a deletion.` }
      }
      if (result.kind === 'conflict') return { kind: 'error', text: 'Cannot apply: the workspace changed since the candidate was staged.' }
      return { kind: 'error', text: `Cannot apply: ${result.kind}.` }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'sandbox-reject',
    description: 'Revert one staged file to the base without touching the real workspace (--file <path>)',
    handler: invocation => {
      const files = filesArg(invocation.rawInput, root())
      if (files === undefined || files[0] === undefined) return { kind: 'error', text: 'Usage: /sandbox-reject --file <path>' }
      const ok = ctx.sandboxWorkspace.rejectFile(root(), files[0])
      return ok
        ? { kind: 'success', text: `Reverted staged ${files[0]}.` }
        : { kind: 'error', text: `No staged change for ${files[0]}.` }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'sandbox-discard',
    description: 'Discard the staged sandbox candidate without changing the real workspace',
    handler: () => {
      ctx.sandboxWorkspace.discard(root())
      return { kind: 'success', text: 'Staged changes discarded.' }
    },
  }))
}
