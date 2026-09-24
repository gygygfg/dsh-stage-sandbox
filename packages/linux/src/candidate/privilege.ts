/**
 * Privilege tiers (v2.3 §14). A command segment is graded into a tier that
 * decides how it is isolated and whether its host effects are a proposal:
 *
 * - **T0 (baseline)** — ordinary confined execution.
 * - **T1 (elevated-in-isolation)** — package installs, container runtimes,
 *   network mutations that run confined but with a wider surface.
 * - **T2 (host-affecting)** — kernel/host state (mount, modules, services,
 *   partition tables, registry); its effects must be frozen as a host proposal.
 *
 * A privilege wrapper (`sudo`, `doas`, `su`) never lowers the tier of the
 * command it wraps; `sudo mount` is still T2.
 * @module dsh-sandbox-linux/candidate/privilege
 */

import { splitCommands } from './script-scan.ts'

/** The privilege tiers. */
export type PrivilegeTier = 'T0' | 'T1' | 'T2'

/** The classification of one command line. */
export interface PrivilegeAssessment {
  /** The highest tier present. */
  readonly tier: PrivilegeTier
  /** Whether a privilege wrapper was used. */
  readonly elevated: boolean
  /** Human-readable reasons, one per elevated segment. */
  readonly reasons: readonly string[]
}

/** Commands that change host/kernel state (T2). */
const HOST_COMMANDS: ReadonlySet<string> = new Set([
  'mount', 'umount', 'systemctl', 'service', 'modprobe', 'insmod', 'rmmod', 'depmod',
  'iptables', 'ip6tables', 'nft', 'ufw', 'mknod', 'mkfs', 'fdisk', 'parted', 'sfdisk',
  'bcdedit', 'diskpart', 'reg', 'sc', 'netsh', 'schtasks', 'chroot', 'setenforce',
  'update-grub', 'grub-install', 'poweroff', 'reboot', 'halt', 'shutdown', 'kexec', 'sysctl',
])
/** Commands that install packages or run containers (T1). */
const ELEVATED_COMMANDS: ReadonlySet<string> = new Set([
  'apt', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'emerge', 'nix', 'nix-env',
  'pip', 'pip3', 'npm', 'pnpm', 'yarn', 'cargo', 'gem', 'composer', 'dotnet', 'nuget',
  'brew', 'choco', 'winget', 'scoop',
  'docker', 'podman', 'nerdctl', 'kubectl', 'helm', 'terraform', 'ansible-playbook',
])
/** Privilege wrappers. */
const WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas', 'su'])

/** The bare executable name of an argv token. */
function exeOf(token: string | undefined): string {
  return (token ?? '').replace(/.*[/\\]/u, '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, '')
}

/** Skip a wrapper's own options and arguments to the wrapped command. */
function unwrap(tokens: readonly string[]): { tokens: readonly string[]; wrapped: boolean } {
  let index = 0
  let wrapped = false
  while (index < tokens.length) {
    const exe = exeOf(tokens[index])
    if (!WRAPPERS.has(exe)) break
    wrapped = true
    index += 1
    // Consume the wrapper's options; `-u user`, `-g group`, `-p prompt` take a value.
    while (index < tokens.length && (tokens[index] as string).startsWith('-')) {
      if (['-u', '-g', '-p', '-C', '-h', '-U'].includes(tokens[index] as string)) index += 1
      index += 1
    }
    // `su <user>` has a bare user argument before `-c`.
    if (exe === 'su' && index < tokens.length && !['-c'].includes(tokens[index] as string)) index += 1
    if (tokens[index] === '-c') index += 1
  }
  return { tokens: tokens.slice(index), wrapped }
}

/** The tier and reason one segment contributes, or `undefined` for T0. */
function segmentTier(segment: string): { tier: 'T1' | 'T2'; reason: string } | undefined {
  const raw = segment.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? []
  const { tokens } = unwrap(raw)
  const exe = exeOf(tokens[0])
  const args = tokens.slice(1).map(argument => argument.toLowerCase())
  if (HOST_COMMANDS.has(exe)) {
    if (exe === 'sysctl' && !args.some(argument => argument.startsWith('-w') || argument.includes('='))) return undefined
    return { tier: 'T2', reason: `${exe} changes host or kernel state` }
  }
  if (ELEVATED_COMMANDS.has(exe)) return { tier: 'T1', reason: `${exe} installs software or manages containers` }
  if (exe === 'git' && args.some(argument => ['push', 'fetch', 'pull', 'clone', 'remote', 'submodule'].includes(argument))) {
    return { tier: 'T1', reason: 'git network or submodule operation' }
  }
  return undefined
}

/**
 * Classify one command line into the highest privilege tier it uses.
 * @param command - the command line.
 * @returns the assessment.
 */
export function classifyPrivilege(command: string): PrivilegeAssessment {
  let tier: PrivilegeTier = 'T0'
  let elevated = false
  const reasons: string[] = []
  for (const segment of splitCommands(command)) {
    if (segment.trim() === '') continue
    const raw = segment.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? []
    const { wrapped } = unwrap(raw)
    if (wrapped) elevated = true
    const contribution = segmentTier(segment)
    if (contribution === undefined) continue
    if (contribution.tier === 'T2') tier = 'T2'
    else if (tier === 'T0') tier = 'T1'
    reasons.push(contribution.reason)
  }
  return { tier, elevated, reasons }
}
