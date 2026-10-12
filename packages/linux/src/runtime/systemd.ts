/**
 * The systemd facade (v2.3 §16). Inside the sandbox there is no real PID 1,
 * D-Bus, or `systemd`, so a real `systemctl` fails with "Failed to connect to
 * bus". The facade answers `systemctl`/`journalctl` invocations from in-session
 * state instead of touching the host, with realistic output and exit codes.
 *
 * It is intentionally a facade, not systemd: it manages unit state the AI
 * asked for (start/stop/enable) and synthesizes status/list output, but does
 * not run real services. Container/namespace execution is out of scope.
 * @module dsh-sandbox-linux/runtime/systemd
 */

/** The parsed form of one standalone `systemctl`/`journalctl` invocation. */
export interface SystemctlInvocation {
  /** The executable (`systemctl` or `journalctl`). */
  readonly exe: 'systemctl' | 'journalctl'
  /** The arguments after the executable. */
  readonly argv: readonly string[]
}

/** The synthesized command result. */
export interface FacadeResult {
  /** Captured stdout. */
  readonly stdout: string
  /** Captured stderr. */
  readonly stderr: string
  /** The exit code. */
  readonly code: number
}

/** One unit's in-session state. */
interface UnitState {
  active: boolean
  enabled: boolean
  failed: boolean
  sub: string
  description: string
}

/** Baseline units a running system always has. */
const BASELINE_UNITS: readonly [string, string][] = [
  ['sysinit.target', 'System Initialization'],
  ['basic.target', 'Basic System'],
  ['multi-user.target', 'Multi-User System'],
  ['systemd-journald.service', 'Journal Service'],
  ['systemd-udevd.service', 'Rule-based Manager for Device Events and Files'],
]

/** Split a shell command into tokens, or `undefined` when it is not a single simple command. */
function simpleTokens(command: string): string[] | undefined {
  if (/[;&|><`\n]/u.test(command.replace(/"[^"]*"|'[^']*'/gu, ''))) return undefined
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? []
  return tokens.length === 0 ? undefined : tokens
}

/**
 * Parse a command as a standalone `systemctl`/`journalctl` invocation, skipping
 * a leading privilege wrapper. Compound commands, pipes, and redirections are
 * not intercepted.
 * @param command - the command line.
 * @returns the invocation, or `undefined`.
 */
export function parseSystemctl(command: string): SystemctlInvocation | undefined {
  const tokens = simpleTokens(command)
  if (tokens === undefined) return undefined
  let index = 0
  while (index < tokens.length && ['sudo', 'doas'].includes((tokens[index] as string).replace(/.*\//u, ''))) index += 1
  const exe = (tokens[index] ?? '').replace(/.*\//u, '')
  if (exe !== 'systemctl' && exe !== 'journalctl') return undefined
  return { exe, argv: tokens.slice(index + 1) }
}

/** The facade's in-session unit table. */
export class SystemdFacade {
  private readonly units = new Map<string, UnitState>()

  constructor() {
    for (const [name, description] of BASELINE_UNITS) {
      this.units.set(name, { active: true, enabled: true, failed: false, sub: 'running', description })
    }
  }

  /** Ensure a unit exists, creating an inactive placeholder on first reference. */
  private unit(name: string): UnitState {
    let unit = this.units.get(name)
    if (unit === undefined) {
      unit = { active: false, enabled: false, failed: false, sub: 'dead', description: `${name} unit` }
      this.units.set(name, unit)
    }
    return unit
  }

  /** Whether a unit is known (baseline or previously referenced). */
  private known(name: string): boolean {
    return this.units.has(name)
  }

  /**
   * Run one parsed invocation against the facade.
   * @param invocation - the parsed invocation.
   * @returns the synthesized result.
   */
  exec(invocation: SystemctlInvocation): FacadeResult {
    return invocation.exe === 'journalctl' ? this.journal(invocation.argv) : this.systemctl(invocation.argv)
  }

  private systemctl(argv: readonly string[]): FacadeResult {
    if (argv.includes('--version')) {
      return { stdout: 'systemd 255 (255.4)\n+PAM +AUDIT +SELINUX -APPARMOR +IMA +SECCOMP\n', stderr: '', code: 0 }
    }
    const [verbRaw, unitArg] = argv.filter(argument => !argument.startsWith('-'))
    const verb = (verbRaw ?? 'list-units').toLowerCase()
    const flags = argv.filter(argument => argument.startsWith('-'))
    switch (verb) {
      case 'start':
      case 'stop':
      case 'restart':
      case 'reload':
        return this.control(verb, unitArg)
      case 'status':
        return this.status(unitArg)
      case 'is-active':
        return this.isActive(unitArg)
      case 'is-enabled':
        return this.isEnabled(unitArg)
      case 'is-system-running':
        return this.isSystemRunning()
      case 'is-failed':
        return this.isFailed()
      case 'enable':
      case 'disable':
        return this.enableDisable(verb, unitArg)
      case 'daemon-reload':
        return { stdout: '', stderr: '', code: 0 }
      case 'list-units':
      case 'list-unit-files':
        return this.listUnits(verb, flags)
      case 'cat':
        return this.known(unitArg ?? '') ? { stdout: '', stderr: '', code: 0 } : { stdout: '', stderr: `No files found for ${unitArg}.\n`, code: 1 }
      default:
        return { stdout: '', stderr: `Unknown command verb '${verbRaw}'. See 'systemctl --help'.\n`, code: 1 }
    }
  }

  private control(verb: string, unitArg: string | undefined): FacadeResult {
    if (unitArg === undefined) return { stdout: '', stderr: 'Too few arguments.\n', code: 1 }
    if (!this.known(unitArg)) return { stdout: '', stderr: `Failed to ${verb} ${unitArg}: Unit ${unitArg} not found.\n`, code: 5 }
    const unit = this.unit(unitArg)
    if (verb === 'stop') { unit.active = false; unit.sub = 'dead' } else { unit.active = true; unit.failed = false; unit.sub = unitArg.endsWith('.target') ? 'active' : 'running' }
    return { stdout: '', stderr: '', code: 0 }
  }

  private status(unitArg: string | undefined): FacadeResult {
    if (unitArg === undefined || !this.known(unitArg)) return { stdout: '', stderr: `Unit ${unitArg ?? ''} could not be found.\n`, code: 4 }
    const unit = this.unit(unitArg)
    const active = unit.active ? (unit.sub === 'dead' ? 'inactive' : 'active') : 'inactive'
    const lines = [
      `● ${unitArg} - ${unit.description}`,
      `     Loaded: loaded (/etc/systemd/system/${unitArg}; ${unit.enabled ? 'enabled' : 'disabled'})`,
      `     Active: ${active === 'active' ? 'active (running)' : 'inactive (dead)'}`,
      '',
    ].join('\n')
    return { stdout: lines, stderr: '', code: unit.active ? 0 : 3 }
  }

  private isActive(unitArg: string | undefined): FacadeResult {
    if (unitArg === undefined || !this.known(unitArg)) return { stdout: 'inactive\n', stderr: '', code: 4 }
    const unit = this.unit(unitArg)
    const state = unit.failed ? 'failed' : unit.active ? 'active' : 'inactive'
    return { stdout: `${state}\n`, stderr: '', code: unit.active && !unit.failed ? 0 : 3 }
  }

  private isEnabled(unitArg: string | undefined): FacadeResult {
    if (unitArg === undefined || !this.known(unitArg)) return { stdout: 'not-found\n', stderr: '', code: 1 }
    const unit = this.unit(unitArg)
    return { stdout: `${unit.enabled ? 'enabled' : 'disabled'}\n`, stderr: '', code: unit.enabled ? 0 : 1 }
  }

  private isSystemRunning(): FacadeResult {
    const degraded = [...this.units.values()].some(unit => unit.failed)
    return { stdout: `${degraded ? 'degraded' : 'running'}\n`, stderr: '', code: degraded ? 1 : 0 }
  }

  private isFailed(): FacadeResult {
    const failed = [...this.units.values()].some(unit => unit.failed)
    return { stdout: `${failed ? 'failed' : ''}\n`, stderr: '', code: failed ? 0 : 1 }
  }

  private enableDisable(verb: string, unitArg: string | undefined): FacadeResult {
    if (unitArg === undefined || !this.known(unitArg)) return { stdout: '', stderr: `Failed to ${verb} ${unitArg ?? ''}: Unit file does not exist.\n`, code: 1 }
    const unit = this.unit(unitArg)
    unit.enabled = verb === 'enable'
    const line = verb === 'enable'
      ? `Created symlink /etc/systemd/system/multi-user.target.wants/${unitArg} → /etc/systemd/system/${unitArg}.\n`
      : `Removed "/etc/systemd/system/multi-user.target.wants/${unitArg}".\n`
    return { stdout: line, stderr: '', code: 0 }
  }

  private listUnits(verb: string, flags: readonly string[]): FacadeResult {
    const active = [...this.units.entries()].filter(([, unit]) => unit.active || flags.includes('--all'))
    const header = verb === 'list-unit-files'
      ? 'UNIT FILE                        STATE\n'
      : 'UNIT LOAD ACTIVE SUB DESCRIPTION\n'
    const body = active
      .map(([name, unit]) => verb === 'list-unit-files'
        ? `${name.padEnd(32)} ${unit.enabled ? 'enabled' : 'disabled'}`
        : `${name.padEnd(20)} loaded ${unit.active ? 'active' : 'inactive'} ${unit.sub.padEnd(6)} ${unit.description}`)
      .join('\n')
    return { stdout: `${header}${body}\n`, stderr: '', code: 0 }
  }

  private journal(argv: readonly string[]): FacadeResult {
    const unit = argv.find(argument => !argument.startsWith('-'))
    const lineCount = (() => {
      const index = argv.findIndex(argument => argument === '-n')
      const value = index === -1 ? undefined : argv[index + 1]
      return value !== undefined && /^\d+$/u.test(value) ? Number(value) : 5
    })()
    const header = `-- Logs begin at ${new Date(0).toISOString().replace('T', ' ').slice(0, 19)} UTC --\n`
    const lines = Array.from({ length: lineCount }, () => `${unit ?? 'systemd'}[1]: synthesized log entry.`).join('\n')
    return { stdout: `${header}${lines}\n`, stderr: '', code: 0 }
  }
}
