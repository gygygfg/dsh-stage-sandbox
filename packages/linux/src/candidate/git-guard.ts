/**
 * Git command guard (v2.3 §11). `.git` is a coupled database: an index or ref
 * references blobs in `.git/objects`. A raw `git` mutation run through the
 * shell would be captured as ordinary files and could be published
 * "index without object" (a dangling reference). The guard recognises a
 * mutating `git` invocation so the candidate is graded for review and the
 * publication applies `.git` objects before pointers (see `applyRank`).
 *
 * The command allowance is deliberately read-only-biased: read verbs pass,
 * anything that writes `.git` is flagged.
 * @module dsh-sandbox-linux/candidate/git-guard
 */

import { splitCommands } from './script-scan.ts'

/** Read-only git verbs (the first positional argument). */
const READ_VERBS: ReadonlySet<string> = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'blame', 'grep', 'describe', 'shortlog', 'whatchanged', 'show-ref',
  'for-each-ref', 'verify-pack', 'count-objects', 'name-rev', 'merge-base', 'diff-tree',
])

/** Mutating git verbs. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'add', 'commit', 'rm', 'mv', 'reset', 'checkout', 'switch', 'restore', 'stash',
  'merge', 'rebase', 'cherry-pick', 'revert', 'clean', 'gc', 'prune', 'fetch',
  'pull', 'push', 'update-ref', 'symbolic-ref', 'apply', 'am', 'filter-branch',
  'replace', 'notes', 'submodule', 'worktree', 'sparse-checkout', 'init', 'clone',
  'tag', 'branch', 'config', 'reflog', 'remote', 'repack', 'prune-packed', 'pack-refs',
])

/** The guard verdict for one command line. */
export interface GitGuardVerdict {
  /** Whether a mutating git invocation was found. */
  readonly denied: boolean
  /** The stable reason code, when denied. */
  readonly reason?: string
}

/** Privilege wrappers a git invocation may be nested under. */
const WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas', 'su'])

/** Drop leading privilege wrappers and their options. */
function withoutWrappers(tokens: readonly string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const exe = (tokens[index] as string).replace(/.*\//u, '').toLowerCase()
    if (!WRAPPERS.has(exe)) break
    index += 1
    while (index < tokens.length && (tokens[index] as string).startsWith('-')) {
      if (['-u', '-g', '-p', '-C', '-h', '-U'].includes(tokens[index] as string)) index += 1
      index += 1
    }
    if (exe === 'su' && index < tokens.length && !['-c'].includes(tokens[index] as string)) index += 1
    if (tokens[index] === '-c') index += 1
  }
  return tokens.slice(index)
}

/** The first positional argument of a `git` invocation, skipping options. */
function gitVerb(tokens: readonly string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    if (token.startsWith('-')) {
      // `-C <path>`, `-c <k=v>`, `--git-dir <path>` consume the next token.
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(token)) i += 1
      continue
    }
    return token.toLowerCase()
  }
  return undefined
}

/**
 * Whether a shell command line contains a mutating git invocation.
 * @param command - the command line.
 * @returns the guard verdict.
 */
export function checkGitCommand(command: string): GitGuardVerdict {
  for (const segment of splitCommands(command)) {
    const raw = segment.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? []
    const tokens = withoutWrappers(raw)
    const exe = (tokens[0] ?? '').replace(/.*\//u, '').toLowerCase()
    if (exe !== 'git') continue
    const verb = gitVerb(tokens.slice(1))
    if (verb === undefined) continue
    if (WRITE_VERBS.has(verb) && !READ_VERBS.has(verb)) {
      return { denied: true, reason: 'SANDBOX_GIT_MUTATION_VIA_COMMAND' }
    }
  }
  return { denied: false }
}
