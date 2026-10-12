import { describe, expect, it } from 'vitest'
import { parseSystemctl, SystemdFacade } from '../../src/runtime/systemd.ts'

describe('systemctl parsing', () => {
  it('parses standalone invocations, with or without a wrapper', () => {
    expect(parseSystemctl('systemctl status nginx')?.argv).toEqual(['status', 'nginx'])
    expect(parseSystemctl('sudo systemctl restart nginx')?.exe).toBe('systemctl')
    expect(parseSystemctl('journalctl -u nginx')?.exe).toBe('journalctl')
  })

  it('does not intercept compound or embedded invocations', () => {
    expect(parseSystemctl('ls && systemctl status')).toBeUndefined()
    expect(parseSystemctl('systemctl status | grep active')).toBeUndefined()
    expect(parseSystemctl("bash -c 'systemctl status'")).toBeUndefined()
  })
})

describe('systemd facade', () => {
  it('controls and reports a baseline unit', () => {
    const facade = new SystemdFacade()
    expect(facade.exec(parseSystemctl('systemctl is-active systemd-journald.service')!).code).toBe(0)
    expect(facade.exec(parseSystemctl('systemctl stop systemd-journald.service')!).code).toBe(0)
    const inactive = facade.exec(parseSystemctl('systemctl is-active systemd-journald.service')!)
    expect(inactive.stdout.trim()).toBe('inactive')
    expect(inactive.code).toBe(3)
  })

  it('refuses an unknown unit with the real exit code', () => {
    const facade = new SystemdFacade()
    const result = facade.exec(parseSystemctl('systemctl start nope.service')!)
    expect(result.code).toBe(5)
    expect(result.stderr).toContain('Unit nope.service not found.')
  })

  it('synthesizes status, lists, journal, and system state', () => {
    const facade = new SystemdFacade()
    expect(facade.exec(parseSystemctl('systemctl status systemd-journald.service')!).stdout).toContain('Active: active (running)')
    expect(facade.exec(parseSystemctl('systemctl list-units')!).stdout.startsWith('UNIT LOAD ACTIVE SUB')).toBe(true)
    expect(facade.exec(parseSystemctl('journalctl -n 3')!).stdout).toContain('-- Logs begin at')
    const running = facade.exec(parseSystemctl('systemctl is-system-running')!)
    expect(running.stdout.trim()).toBe('running')
    expect(running.code).toBe(0)
  })

  it('enables and disables units, and rejects an unknown verb', () => {
    const facade = new SystemdFacade()
    expect(facade.exec(parseSystemctl('systemctl disable systemd-journald.service')!).stdout).toContain('Removed')
    expect(facade.exec(parseSystemctl('systemctl is-enabled systemd-journald.service')!).stdout.trim()).toBe('disabled')
    const unknown = facade.exec(parseSystemctl('systemctl frobnicate')!)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("Unknown command verb 'frobnicate'.")
  })
})
