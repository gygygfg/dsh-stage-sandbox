/**
 * Danger classification for staged candidates (v2.3). Every staged change is
 * graded before it can be published:
 *
 * - **L1 (green)** — an ordinary workspace write that touches no protected
 *   object, or a package installed through an official channel.
 * - **L2 (yellow)** — a change outside the workspace, a protected object inside
 *   the workspace, a destructive in-workspace edit, or a third-party download
 *   or install.
 * - **L3 (red)** — a system-file change, sensitive data written or sent outside
 *   the workspace, a host (registry/system-state) operation, or a
 *   download-and-execute pattern. L3 requires two user confirmations and a
 *   consequences view.
 *
 * The classifier is deliberately independent of the rule packs, so a missing
 * or permissive pack cannot silently authorize a destructive change.
 * @module dsh-sandbox-linux/candidate/danger
 */

import { basename, isAbsolute } from 'node:path'
import type { FsImpact } from './impact.ts'
import { scanCommand, splitCommands } from './script-scan.ts'
import { checkGitCommand } from './git-guard.ts'
import { classifyPrivilege } from './privilege.ts'

/** The three danger levels. */
export type DangerLevel = 'L1' | 'L2' | 'L3'

/** The approval-window marker color for a level. */
export type DangerMarker = 'green' | 'yellow' | 'red'

/** One reason a candidate is dangerous. */
export interface DangerReason {
  /** A stable reason code, safe for a UI or a policy rule. */
  readonly code: string
  /** The level this reason assigns. */
  readonly level: DangerLevel
  /** A human-readable explanation. */
  readonly detail: string
  /** The affected path, when the reason is path-specific. */
  readonly path?: string
}

/** One command the staged execution ran, for command-level classification. */
export interface CommandIntent {
  /** The command line (shell syntax is permitted). */
  readonly command: string
}

/** The result of classifying one candidate's changes and commands. */
export interface DangerAssessment {
  /** Whether the candidate is dangerous at all (always true for a graded change). */
  readonly dangerous: boolean
  /** The highest level present, or `none` when nothing is staged. */
  readonly level: DangerLevel | 'none'
  /** The approval-window marker, or `null` when nothing is staged. */
  readonly marker: DangerMarker | null
  /** How many explicit confirmations the level requires (0, 1, or 2). */
  readonly confirmationsRequired: number
  /** The consequences the user must be shown before confirming. */
  readonly consequences: readonly string[]
  /** The reasons, ordered L3 → L1. */
  readonly reasons: readonly DangerReason[]
}

/** The inputs to danger classification. */
export interface DangerInput {
  /** The absolute workspace root the changes are scoped to. */
  readonly workspaceRoot: string
  /** The staged filesystem changes. */
  readonly changes: readonly FsImpact[]
  /** The commands the staged execution ran. */
  readonly commands?: readonly CommandIntent[]
  /** The number of host operations (registry/system-state) in the candidate. */
  readonly hostOperationCount?: number
  /** The number of file changes above which a bulk-edit reason is raised; defaults to 20. */
  readonly bulkThreshold?: number
  /**
   * Reads the *base* (pre-staging) content of a workspace path. Used to tell a
   * manifest's unchanged scripts from ones the candidate added or rewrote.
   */
  readonly readBase?: (path: string) => string | undefined
  /**
   * The working directory commands ran in, for resolving scripts they
   * delegate to. Defaults to the workspace root.
   */
  readonly cwd?: string
  /**
   * Read a script's text (preferring a staged copy). When present, commands
   * are statically scanned for indirectly executed scripts so their effects
   * reach the classifier.
   */
  readonly readFile?: (path: string) => string | undefined
}

/** Level ordering for reducing a reason list to its highest. */
const LEVEL_RANK: Record<DangerLevel, number> = { L1: 1, L2: 2, L3: 3 }

/** The marker color for each level. */
const LEVEL_MARKER: Record<DangerLevel, DangerMarker> = { L1: 'green', L2: 'yellow', L3: 'red' }

/** How many explicit confirmations each level requires. */
const LEVEL_CONFIRMATIONS: Record<DangerLevel, number> = { L1: 1, L2: 1, L3: 2 }

/** Path segments and file names that are protected by default. */
const SENSITIVE_SEGMENTS: readonly string[] = [
  '.git',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.dsh',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'authorized_keys',
  'id_rsa',
  'id_ed25519',
  'credentials',
  '.env',
  '.env.local',
]

/** Absolute prefixes that identify operating-system files. */
const SYSTEM_PREFIXES: readonly string[] = [
  '/etc/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/boot/',
  '/sys/',
  '/proc/',
  '/dev/',
  '/var/',
  '/root/',
]

/** File-change kinds that are inherently destructive. */
const DESTRUCTIVE_KINDS: ReadonlySet<FsImpact['kind']> = new Set(['delete', 'rename', 'link'])

/** Package managers that install from the OS distribution's official repositories. */
const DISTRO_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['apt', 'apt-get', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'emerge', 'nix', 'nix-env', 'port'])
/** Package managers whose default registry is the ecosystem's official one. */
const ECOSYSTEM_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pip', 'pip3', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'gem', 'composer', 'dotnet', 'nuget'])
/** Desktop package managers that install from an official catalog. */
const DESKTOP_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['brew'])
/** Downloaders. */
const DOWNLOADERS: ReadonlySet<string> = new Set(['curl', 'wget', 'aria2c'])
/** Network senders that could exfiltrate data. */
const NETWORK_SENDERS: ReadonlySet<string> = new Set(['curl', 'wget', 'scp', 'rsync', 'nc', 'ncat', 'socat', 'ssh', 'ftp', 'tftp'])

/**
 * Interpreters that can open a socket from an inline program. A red-team
 * payload rarely calls `curl`; it calls the language it is already running.
 */
const INLINE_NET_CLIENTS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php'])

/** Manifest files whose script entries run automatically on install/publish. */
const MANIFEST_FILES: readonly string[] = [
  'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'composer.json', 'cargo.toml', 'go.mod',
]

/** Lifecycle script names that execute on install, publish, or pack. */
const LIFECYCLE_SCRIPT = /(?:^|[^a-z])(?:postinstall|preinstall|prepare|prepublish|prepack|postpack)(?:[^a-z]|$)/iu

/** Shell/interpreter fragments that turn a lifecycle script into code execution. */
const SCRIPT_EXEC = /(?:curl|wget|powershell|sh\s+-c|bash\s+-c|node\s+-e|python\d?\s+-c|base64\s+-d|\|\s*(?:ba)?sh\b)/iu

/** Inline network APIs, so an interpreter sending data is not mistaken for a local script. */
const INLINE_NETWORK = /\b(?:urllib|http\.client|httplib|requests|socket|fetch|axios|https?)\.?/iu

/** Whether a manifest path escapes the workspace root. */
function escapesWorkspace(path: string): boolean {
  if (isAbsolute(path)) return true
  const normalized = path.replaceAll('\\', '/')
  return normalized === '..' || normalized.startsWith('../')
}

/** Whether a path is an operating-system path. */
function isSystemPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  if (normalized.startsWith('/')) return SYSTEM_PREFIXES.some(prefix => normalized.startsWith(prefix.replaceAll('\\', '/')))
  if (/^[a-z]:\//u.test(normalized)) return SYSTEM_PREFIXES.some(prefix => normalized.startsWith(prefix.replaceAll('\\', '/')))
  return false
}

/** Whether a path contains a protected segment. */
function hasSensitiveSegment(path: string): boolean {
  return path.split(/[\\/]/u).some(segment => SENSITIVE_SEGMENTS.includes(segment))
}

/**
 * Whether free text (a command line, not a path) names a protected object.
 * A payload writes `open('.env')`, not a path with separators, so segment-wise
 * path matching alone would miss it.
 * @param text - the command line.
 * @returns true when a protected name appears as a word.
 */
function mentionsSensitive(text: string): boolean {
  const words = text.split(/[^a-z0-9._-]+/u)
  return words.some(word => SENSITIVE_SEGMENTS.includes(word))
}

/** Extract the first http(s) URL from a command line, if any. */
function firstUrl(commandLine: string): string | undefined {
  return /https?:\/\/[^\s'"`;|)]+/iu.exec(commandLine)?.[0]
}

/** Whether a URL host is a bare IP address. */
function isIpHost(url: string): boolean {
  const host = /^https?:\/\/([^/:]+)/iu.exec(url)?.[1] ?? ''
  return /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) || host.startsWith('[')
}

/** URL shorteners that hide the real destination. */
const URL_SHORTENERS: readonly string[] = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'rebrand.ly']

/** Official hosts whose downloads are trusted. */
const OFFICIAL_HOSTS: readonly string[] = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io', 'proxy.golang.org', 'sum.golang.org', 'deb.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com', 'packages.microsoft.com', 'github.com', 'objects.githubusercontent.com']

/** Whether a URL points at an official host. */
function isOfficialUrl(url: string): boolean {
  const host = (/^https?:\/\/([^/:]+)/iu.exec(url)?.[1] ?? '').toLowerCase()
  return OFFICIAL_HOSTS.some(official => host === official || host.endsWith(`.${official}`))
}

/** Whether a command line contains a shell-execution pipe. */
function pipesToShell(commandLine: string): boolean {
  return /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby)\b/iu.test(commandLine)
}

/** Whether a command modifies the operating system or its configuration. */
function modifiesSystem(exe: string, commandLine: string): boolean {
  if (['systemctl', 'service', 'format', 'mkfs', 'fdisk', 'parted', 'mount', 'umount'].includes(exe)) return true
  if (['chmod', 'chown', 'chattr', 'setfacl'].includes(exe) && /(?:\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/)/iu.test(commandLine)) return true
  if (/\b(?:rm|rmdir)\s+(?:-[a-z]+\s+)*\/(?:\s|$)/iu.test(commandLine)) return true
  if (/\bdd\s+.*of=\/dev\//iu.test(commandLine)) return true
  if (/(?:>|>>|tee)\s*(?:\/etc\/|\/usr\/|\/boot\/)/iu.test(commandLine)) return true
  return false
}

/** Whether a package install targets a third-party channel. */
function installsThirdParty(exe: string, args: readonly string[], commandLine: string): boolean {
  if (args.some(argument => /^https?:\/\//iu.test(argument) || /\.(?:deb|rpm|msi|pkg|dmg|apk|whl|tgz|tar\.gz)(?:\?|$)/iu.test(argument))) return true
  if (/(?:--index-url|--extra-index-url|--registry|--git|--source|--repo|add-apt-repository|ppa:)/iu.test(commandLine)) return true
  if (/\b(?:git\+|github:|gitlab:|bitbucket:)/iu.test(commandLine)) return true
  if (exe === 'cargo' && args.includes('--path')) return true
  return false
}


/** Manifest files whose `scripts` object runs automatically on install. */
const JSON_MANIFESTS = new Set(['package.json', 'composer.json'])

/**
 * Reasons a manifest write adds or rewrites an install-time script.
 *
 * A payload hidden in a build artifact only leaves an ordinary-looking write to
 * `package.json`; the command line says `python3 test.py`. The only evidence is
 * the file content, which is why the classifier compares the staged manifest
 * with its base version instead of trusting the change kind.
 * @param change - the staged change.
 * @param workspaceRoot - the real workspace root.
 * @param input - the readers supplied by the workspace service.
 * @returns the manifest-script reasons.
 */
function classifyManifest(change: FsImpact, workspaceRoot: string, input: DangerInput): DangerReason[] {
  const name = basename(change.path).toLowerCase()
  if (!JSON_MANIFESTS.has(name)) return []
  if (change.kind !== 'write' && change.kind !== 'create') return []
  if (isAbsolute(change.path) || change.path.startsWith('..')) return []
  const read = input.readFile
  if (read === undefined) return []
  const absolute = `${workspaceRoot.replace(/\/$/u, '')}/${change.path}`
  const parse = (text: string | undefined): Record<string, unknown> | undefined => {
    if (text === undefined) return undefined
    try {
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  const now = parse(read(absolute))
  if (now === undefined) return []
  const before = parse(input.readBase?.(absolute)) ?? {}
  const scriptsOf = (manifest: Record<string, unknown>): Record<string, unknown> =>
    typeof manifest.scripts === 'object' && manifest.scripts !== null ? manifest.scripts as Record<string, unknown> : {}
  const oldScripts = scriptsOf(before)
  const newScripts = scriptsOf(now)
  const reasons: DangerReason[] = []
  for (const [key, value] of Object.entries(newScripts)) {
    if (typeof value !== 'string' || oldScripts[key] === value) continue
    if (SCRIPT_EXEC.test(value)) {
      reasons.push({ code: 'MANIFEST_SCRIPT_INJECTION', level: 'L3', detail: `install script "${key}" runs a shell command (${value.slice(0, 80)})`, path: change.path })
    } else {
      reasons.push({ code: 'MANIFEST_SCRIPT_ADDED', level: 'L2', detail: `adds or rewrites the install script "${key}"`, path: change.path })
    }
  }
  return reasons
}

/** Classify one staged filesystem change. */
function classifyChange(change: FsImpact, workspaceRoot: string, input: DangerInput): DangerReason[] {
  const reasons: DangerReason[] = []
  const system = isSystemPath(change.path)
  const escape = escapesWorkspace(change.path)
  const sensitive = hasSensitiveSegment(change.path)
  if (system) {
    reasons.push({ code: 'SYSTEM_FILE', level: 'L3', detail: `${change.kind} of system path ${change.path}`, path: change.path })
  } else if (escape && sensitive) {
    reasons.push({ code: 'SENSITIVE_ESCAPE', level: 'L3', detail: `sensitive data written outside the workspace at ${change.path}`, path: change.path })
  } else if (escape) {
    reasons.push({ code: 'OUTSIDE_WORKSPACE', level: 'L2', detail: `${change.kind} outside the workspace at ${change.path}`, path: change.path })
  } else if (sensitive) {
    reasons.push({ code: 'SENSITIVE_PATH', level: 'L2', detail: `${change.path} is a protected path`, path: change.path })
  }
  if (DESTRUCTIVE_KINDS.has(change.kind) && !system) {
    reasons.push({ code: `DESTRUCTIVE_${change.kind.toUpperCase()}`, level: 'L2', detail: `${change.kind} of ${change.path} is not easily undone`, path: change.path })
  }
  // A write that removes the file's content is a deletion the user did not ask
  // for: the path still exists, so a path-only policy sees an ordinary write.
  const beforeBytes = change.beforeBytes ?? 0
  const afterBytes = change.afterBytes ?? 0
  const wiped = change.kind === 'write' && beforeBytes >= 64 && afterBytes === 0
  const shrunk = change.kind === 'write' && beforeBytes >= 1024 && afterBytes <= beforeBytes / 2
  if (wiped) {
    reasons.push({ code: 'CONTENT_WIPED', level: 'L3', detail: `${change.path} was truncated from ${beforeBytes} bytes to empty`, path: change.path })
  } else if (shrunk) {
    reasons.push({ code: 'CONTENT_TRUNCATED', level: 'L2', detail: `${change.path} shrank from ${beforeBytes} to ${afterBytes} bytes`, path: change.path })
  }
  // A git hook runs on the user's next commit, outside this sandbox.
  if (/(?:^|\/)\.git\/hooks\//u.test(change.path) && !system) {
    reasons.push({ code: 'PERSISTENCE_HOOK', level: 'L2', detail: `installs a git hook that runs on later commands (${change.path})`, path: change.path })
  }
  if (change.kind === 'metadata') {
    reasons.push({ code: 'METADATA_CHANGE', level: 'L2', detail: `permission or metadata change on ${change.path}`, path: change.path })
  }
  // An ordinary workspace write that touches nothing protected is L1 (green).
  const hook = /(?:^|\/)\.git\/hooks\//u.test(change.path)
  if (!system && !escape && !sensitive && !DESTRUCTIVE_KINDS.has(change.kind) && change.kind !== 'metadata'
      && !hook && !wiped && !shrunk) {
    reasons.push({ code: 'WORKSPACE_WRITE', level: 'L1', detail: `${change.kind} of ${change.path}`, path: change.path })
  }
  return reasons
}

/** Classify one staged command. */
function classifyCommand(intent: CommandIntent): DangerReason[] {
  const reasons: DangerReason[] = []
  const line = intent.command.toLowerCase()
  const tokens = intent.command.match(/"[^"]*"|'[^']*'|\S+/gu)?.map(token => token.replace(/^["']|["']$/gu, '')) ?? []
  const exe = basename(tokens[0] ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/u, '')
  const args = tokens.slice(1).map(argument => argument.toLowerCase())
  const url = firstUrl(line)

  // Download-and-execute and untrusted downloads.
  if (DOWNLOADERS.has(exe)) {
    if (pipesToShell(line)) {
      reasons.push({ code: 'DOWNLOAD_AND_EXECUTE', level: 'L3', detail: `downloads remote content and executes it (${line.slice(0, 120)})` })
    }
    if (url !== undefined) {
      if (isIpHost(url) || URL_SHORTENERS.some(shortener => url.includes(shortener))) {
        reasons.push({ code: 'UNTRUSTED_SOURCE', level: 'L3', detail: `downloads from an untrusted source ${url}` })
      }
      if (/\.(?:exe|msi|dll|scr|bat|cmd|ps1|sh|jar|dmg|pkg|apk|deb|rpm)(?:\?|$)/iu.test(url)) {
        reasons.push({ code: 'EXECUTABLE_DOWNLOAD', level: isOfficialUrl(url) ? 'L2' : 'L3', detail: `downloads an executable or script from ${url}` })
      } else if (!isOfficialUrl(url)) {
        reasons.push({ code: 'THIRD_PARTY_DOWNLOAD', level: 'L2', detail: `downloads from a third-party source ${url}` })
      }
    } else if (['certutil', 'bitsadmin', 'start-bitstransfer'].includes(exe)) {
      reasons.push({ code: 'THIRD_PARTY_DOWNLOAD', level: 'L2', detail: `uses a download utility (${exe})` })
    }
  }

  // Package installs.
  if (DISTRO_PACKAGE_MANAGERS.has(exe) && args.includes('install')) {
    reasons.push(installsThirdParty(exe, args, line)
      ? { code: 'THIRD_PARTY_INSTALL', level: 'L2', detail: `installs a package from a third-party source (${line.slice(0, 120)})` }
      : { code: 'OFFICIAL_PACKAGE_INSTALL', level: 'L1', detail: `installs a package from the official distribution repository (${line.slice(0, 120)})` })
  } else if (ECOSYSTEM_PACKAGE_MANAGERS.has(exe) && (args.includes('install') || args.includes('add') || (exe === 'go' && args.includes('get')))) {
    reasons.push(installsThirdParty(exe, args, line)
      ? { code: 'THIRD_PARTY_INSTALL', level: 'L2', detail: `installs a package from a third-party source (${line.slice(0, 120)})` }
      : { code: 'OFFICIAL_PACKAGE_INSTALL', level: 'L1', detail: `installs a package from the official ${exe} registry (${line.slice(0, 120)})` })
  } else if (DESKTOP_PACKAGE_MANAGERS.has(exe) && (args.includes('install') || args.includes('add'))) {
    reasons.push(installsThirdParty(exe, args, line)
      ? { code: 'THIRD_PARTY_INSTALL', level: 'L2', detail: `installs a package from a third-party source (${line.slice(0, 120)})` }
      : { code: 'OFFICIAL_PACKAGE_INSTALL', level: 'L1', detail: `installs a package from the official ${exe} catalog (${line.slice(0, 120)})` })
  }

  // Running an arbitrary package without installing it.
  if (exe === 'npx' || exe === 'pnpx' || exe === 'bunx') {
    reasons.push({ code: 'THIRD_PARTY_EXECUTE', level: 'L2', detail: `executes an arbitrary package (${line.slice(0, 120)})` })
  }

  // System modification.
  if (modifiesSystem(exe, line)) {
    reasons.push({ code: 'SYSTEM_MODIFICATION', level: 'L3', detail: `modifies system state (${line.slice(0, 120)})` })
  }

  // Privilege escalation.
  if (['sudo', 'doas', 'runas', 'su'].includes(exe)) {
    reasons.push({ code: 'PRIVILEGE_ESCALATION', level: 'L2', detail: `runs with elevated privileges (${line.slice(0, 120)})` })
  }

  // Sensitive data sent to a remote host. A payload usually runs inside the
  // language already at hand, so an inline program counts as a network sender
  // when it also names a sensitive path.
  const networkish = url !== undefined || INLINE_NETWORK.test(line)
  if ((NETWORK_SENDERS.has(exe) || INLINE_NET_CLIENTS.has(exe)) && networkish && mentionsSensitive(line)) {
    reasons.push({ code: 'SENSITIVE_EXFIL', level: 'L3', detail: `may send sensitive data to a remote host (${line.slice(0, 120)})` })
  }

  // Adding a lifecycle script to a manifest is persistence plus code execution
  // on the next install, even when the file change itself looks like a write.
  if (MANIFEST_FILES.some(manifest => line.includes(manifest)) && LIFECYCLE_SCRIPT.test(line) && SCRIPT_EXEC.test(line)) {
    reasons.push({ code: 'MANIFEST_SCRIPT_INJECTION', level: 'L3', detail: `adds an install-time script to a manifest (${line.slice(0, 120)})` })
  }

  // A raw git mutation couples `.git` (index/object/ref) and must be reviewed;
  // publication writes objects before pointers so a ref never dangles.
  const git = checkGitCommand(intent.command)
  if (git.denied && git.reason !== undefined) {
    reasons.push({ code: git.reason, level: 'L2', detail: `mutates git state through the shell (${line.slice(0, 120)})` })
  }

  // Privilege tier: a host-affecting (T2) command is hard to undo and must be
  // reviewed. T1 (elevated-in-isolation, e.g. an official package install) is
  // intentionally NOT raised here — it is confined, and some T1 installs are
  // already graded L1.
  const privilege = classifyPrivilege(intent.command)
  if (privilege.tier === 'T2') {
    reasons.push({ code: 'PRIVILEGE_TIER_T2', level: 'L3', detail: `host-affecting command (${line.slice(0, 120)})` })
  }
  return reasons
}

/** Build the human-readable consequences a user must see before confirming. */
function consequencesOf(level: DangerLevel, reasons: readonly DangerReason[]): string[] {
  const lines = reasons.map(reason => reason.detail)
  if (level === 'L3') {
    lines.push('This operation is hard to undo and may affect the host or expose sensitive data.')
  }
  return lines
}

/**
 * Classify a candidate's staged changes and commands. The highest reason wins;
 * the level, marker color, confirmation count, and consequences are derived
 * from it.
 * @param input - the workspace root, changes, commands, and host-operation count.
 * @returns the assessment.
 */
export function assessDanger(input: DangerInput): DangerAssessment {
  const reasons: DangerReason[] = []
  const bulkThreshold = input.bulkThreshold ?? 20
  for (const change of input.changes) {
    reasons.push(...classifyChange(change, input.workspaceRoot, input))
    reasons.push(...classifyManifest(change, input.workspaceRoot, input))
  }
  for (const command of input.commands ?? []) {
    reasons.push(...classifyCommand(command))
    if (input.readFile === undefined) continue
    // Statically fold scripts the command delegates to, so a hidden install or
    // device command is classified too. An unresolved indirect execution forces
    // review (L1) rather than being ignored.
    const scan = scanCommand({ command: command.command, cwd: input.cwd ?? input.workspaceRoot, readFile: input.readFile })
    if (scan.opaque) {
      reasons.push({ code: 'OPAQUE_SCRIPT_EXECUTION', level: 'L1', detail: `indirect execution could not be fully resolved (${scan.opaqueReasons.join(', ')})` })
    }
    const folded = scan.effective.slice(command.command.length)
    for (const segment of splitCommands(folded)) reasons.push(...classifyCommand({ command: segment }))
  }
  if ((input.hostOperationCount ?? 0) > 0) {
    reasons.push({ code: 'HOST_OPERATION', level: 'L3', detail: `${input.hostOperationCount} host operation(s) change system state` })
  }
  if (input.changes.length > bulkThreshold) {
    reasons.push({ code: 'BULK_CHANGE', level: 'L2', detail: `${input.changes.length} files changed at once (threshold ${bulkThreshold})` })
  }
  if (reasons.length === 0) {
    return { dangerous: false, level: 'none', marker: null, confirmationsRequired: 0, consequences: [], reasons: [] }
  }
  const level = reasons.reduce<DangerLevel>((acc, reason) => LEVEL_RANK[reason.level] > LEVEL_RANK[acc] ? reason.level : acc, 'L1')
  const order: Record<DangerLevel, number> = { L3: 0, L2: 1, L1: 2 }
  return {
    dangerous: true,
    level,
    marker: LEVEL_MARKER[level],
    confirmationsRequired: LEVEL_CONFIRMATIONS[level],
    consequences: consequencesOf(level, reasons),
    reasons: [...reasons].sort((a, b) => order[a.level] - order[b.level]),
  }
}

/** The ANSI color code for a marker, for terminal review output. */
export function markerAnsi(marker: DangerMarker): string {
  return marker === 'green' ? '\u001B[32m' : marker === 'yellow' ? '\u001B[33m' : '\u001B[31m'
}
