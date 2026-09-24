import { describe, expect, it } from 'vitest'
import { checkGitCommand } from '../../src/candidate/git-guard.ts'

describe('git command guard', () => {
  it('flags mutating git invocations', () => {
    expect(checkGitCommand('git commit -m "x"').denied).toBe(true)
    expect(checkGitCommand('git -C /repo reset --hard').denied).toBe(true)
    expect(checkGitCommand('ls && git add .').denied).toBe(true)
    expect(checkGitCommand('sudo git push').denied).toBe(true)
    expect(checkGitCommand('git config user.name x').reason).toBe('SANDBOX_GIT_MUTATION_VIA_COMMAND')
  })

  it('allows read-only git invocations', () => {
    expect(checkGitCommand('git status').denied).toBe(false)
    expect(checkGitCommand('git log --oneline').denied).toBe(false)
    expect(checkGitCommand('git diff --stat').denied).toBe(false)
    expect(checkGitCommand('npm test').denied).toBe(false)
  })
})
