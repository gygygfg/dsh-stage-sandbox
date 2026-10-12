/**
 * Internal Linux platform-profile builders for the local sandbox provider.
 * @module dsh-sandbox-linux/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { DEFAULT_RUNTIME_OPTIONS, bwrapProfileArgs as runtimeBwrapProfileArgs, nodeProfileIo } from './runtime/index.ts'
import type { OverlaySpec, RuntimeOptions } from './runtime/index.ts'

/**
 * Build the bwrap profile arguments for one file-effect policy. Delegates to
 * the hardened runtime builder: a minimal read-only whitelist (NOT
 * `--ro-bind / /`), secret masking, an explicit network mode, a fresh
 * `/proc` with sysctls read-only, and the policy's writable surface.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param options - the runtime isolation options (hardened defaults).
 * @param overlay - an optional overlay layer for the workspace root.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(
  policy: SandboxPolicy,
  options: RuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  overlay?: OverlaySpec,
): string[] {
  return runtimeBwrapProfileArgs(policy, options, nodeProfileIo, overlay)
}

/**
 * Build the Landlock launcher grants for one file-effect policy. The
 * allow-list is Linux Landlock: read-only `/`, plus the writable workspace.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}
