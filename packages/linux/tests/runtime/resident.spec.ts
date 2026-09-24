import { describe, expect, it } from 'vitest'
import { ResidentSandbox } from '../../src/runtime/resident.ts'

const identity = (argv: readonly string[]): readonly string[] => argv

/** Start a plain-host resident (no confinement) for protocol testing. */
async function startResident(): Promise<ResidentSandbox> {
  const resident = new ResidentSandbox()
  await resident.start({ confine: identity, cwd: process.cwd(), env: process.env as Record<string, string> })
  return resident
}

describe('resident command server', () => {
  it('runs a command and captures stdout, stderr, and the exit code', async () => {
    const resident = await startResident()
    try {
      const ok = await resident.exec('echo hello')
      expect(ok.exitCode).toBe(0)
      expect(ok.stdout).toBe('hello\n')
      const bad = await resident.exec('echo oops >&2; exit 3')
      expect(bad.exitCode).toBe(3)
      expect(bad.stderr).toBe('oops\n')
    } finally {
      resident.stop()
    }
  })

  it('persists cwd and exported variables across commands', async () => {
    const resident = await startResident()
    try {
      await resident.exec('cd /tmp')
      expect((await resident.exec('pwd')).stdout.trim()).toBe('/tmp')
      await resident.exec('export DSH_RESIDENT_TEST=kept')
      expect((await resident.exec('echo $DSH_RESIDENT_TEST')).stdout.trim()).toBe('kept')
    } finally {
      resident.stop()
    }
  })

  it('keeps background processes alive across commands', async () => {
    const resident = await startResident()
    try {
      const started = await resident.exec('sleep 300 & echo $!')
      const pid = Number.parseInt(started.stdout.trim(), 10)
      expect(Number.isNaN(pid)).toBe(false)
      const alive = await resident.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`)
      expect(alive.stdout.trim()).toBe('alive')
      await resident.exec(`kill ${pid} 2>/dev/null || true`)
    } finally {
      resident.stop()
    }
  })

  it('times out and stops the server on a hung command', async () => {
    const resident = await startResident()
    try {
      await expect(resident.exec('sleep 30', { timeoutMs: 300 })).rejects.toThrow(/timed out/u)
      expect(resident.running).toBe(false)
    } finally {
      resident.stop()
    }
  })

  it('rejects a command after stop', async () => {
    const resident = await startResident()
    resident.stop()
    await expect(resident.exec('echo nope')).rejects.toThrow(/not running|stopped/u)
  })
})
