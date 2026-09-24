/**
 * Runtime isolation options for the bwrap backend: the hardened defaults the
 * profile builder composes into mounts, plus the network, syscall, and
 * resource dimensions the PAL capability report advertises. These are the
 * knobs v2.3 §8/§9 require — a minimal read-only root instead of binding the
 * whole host, an explicit network mode instead of shared egress, a seccomp
 * baseline, and cgroup resource domains.
 *
 * Ported from `NeoAI/lua/NeoAI/sandbox/runtime.lua` and `seccomp.lua`.
 * @module dsh-sandbox-linux/runtime/options
 */

import type { NetworkMode } from '../broker/network.ts'

/** Seccomp baseline options. */
export interface SeccompOptions {
  /** Whether the denylist filter is applied to the payload. */
  readonly enabled: boolean
  /** An operator-supplied filter path; when absent a baseline is generated. */
  readonly filterPath?: string
  /** When `true`, a missing/unusable filter refuses confined execution instead of degrading. */
  readonly require: boolean
}

/** cgroup v2 resource-domain options. */
export interface LimitOptions {
  /** Whether resource domains are created for staged executions. */
  readonly enabled: boolean
  /** Memory cap as a fraction of the host total (0..1). */
  readonly memoryRatio: number
  /** An absolute memory cap in bytes; takes precedence over {@link memoryRatio}. */
  readonly memoryMaxBytes?: number
  /** Maximum number of PIDs in the domain. */
  readonly pidsMax: number
  /** CPU quota as a percent of one core; `0` means unbounded. */
  readonly cpuMax: number
  /** The cgroup v2 mount root. */
  readonly cgroupBase: string
}

/**
 * The complete runtime isolation plan. A profile builder turns one of these
 * plus a file-effect policy into concrete runner arguments; the PAL capability
 * report projects the same facts into what the host actually enforces.
 */
export interface RuntimeOptions {
  /** The explicit network mode (v2.3 §9). */
  readonly networkMode: NetworkMode
  /** Host directories exposed read-only inside the sandbox (whitelist). */
  readonly readonlyRoots: readonly string[]
  /** Host files/globs exposed read-only inside the sandbox (whitelist). */
  readonly readonlyPaths: readonly string[]
  /** Host sensitive directories/files masked (empty tmpfs or `/dev/null`). */
  readonly maskPaths: readonly string[]
  /** Roots replaced by a private writable tmpfs. */
  readonly tmpfsRoots: readonly string[]
  /** Dangerous `/proc` entries masked with an empty read-only file. */
  readonly procMaskPaths: readonly string[]
  /** Seccomp baseline. */
  readonly seccomp: SeccompOptions
  /** Resource domains. */
  readonly limits: LimitOptions
}

/**
 * The minimal read-only system set (v2.3 §8): without it a command cannot even
 * start; with it the host root is NOT broadly readable. `/lib*`, `/bin`,
 * `/sbin` are symlinks into `/usr` and must be kept or no binary can run.
 * Unlisted host paths (`/home`, `/var/log`, `/etc/shadow`, `/opt`, `/srv`,
 * `/mnt`, `/media`, `/boot`, `/usr/src`, ...) do not exist inside the sandbox.
 */
export const DEFAULT_READONLY_ROOTS: readonly string[] = [
  '/lib', '/lib32', '/lib64', '/libx32', '/bin', '/sbin',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib32', '/usr/lib64', '/usr/libx32',
  '/usr/libexec', '/usr/include',
  '/usr/share',
  '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/libexec',
  '/usr/local/include', '/usr/local/go',
  '/var/lib',
]

/** Minimal `/etc` necessities (globs allowed); unlisted entries stay hidden. */
export const DEFAULT_READONLY_PATHS: readonly string[] = [
  '/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d',
  '/etc/passwd', '/etc/group', '/etc/nsswitch.conf',
  '/etc/hosts', '/etc/hostname', '/etc/host.conf', '/etc/resolv.conf',
  '/etc/localtime', '/etc/timezone', '/etc/os-release', '/etc/debian_version',
  '/etc/ssl', '/etc/ca-certificates', '/etc/ca-certificates.conf',
  '/etc/alternatives', '/etc/terminfo', '/etc/mime.types', '/etc/shells',
  '/etc/environment', '/etc/profile', '/etc/profile.d', '/etc/bash.bashrc',
  '/etc/inputrc', '/etc/security', '/etc/pam.d', '/etc/xdg', '/etc/fonts',
  '/etc/gitconfig', '/etc/npmrc', '/etc/apt', '/etc/dpkg',
  '/etc/python3*',
]

/**
 * Host secrets and escape surfaces hidden by default (v2.3 §8): orchestrator
 * sockets, host credentials/keys, identity/log/history leak surfaces. Masked
 * with an empty tmpfs (dirs) or `/dev/null` (files/sockets).
 */
export const DEFAULT_MASK_PATHS: readonly string[] = [
  '/run/docker.sock', '/var/run/docker.sock',
  '/run/containerd', '/run/containerd/containerd.sock',
  '/var/run/containerd', '/var/lib/docker', '/var/lib/containerd',
  '/run/podman', '/var/run/podman', '/var/lib/containers',
  '/run/dbus', '/run/systemd',
  '/root/.ssh', '/root/.aws', '/root/.gnupg', '/root/.kube',
  '/root/.docker/config.json', '/root/.netrc', '/root/.git-credentials',
  '/root/.cache/keyring-*', '/root/.cache/at-spi', '/root/.local/share/keyrings',
  '/root/.config/git/credentials', '/root/.git-credential-cache', '/root/.config/gh',
  '/root/.config/gcloud',
  '/home/*/.ssh', '/home/*/.gnupg', '/home/*/.netrc',
  '/home/*/.git-credentials', '/home/*/.config/git/credentials', '/home/*/.git-credential-cache',
  '/home/*/.config/gh', '/home/*/.aws', '/home/*/.kube', '/home/*/.docker/config.json',
  '/home/*/.cache/keyring-*', '/home/*/.local/share/keyrings',
  '/run/sshd', '/run/sshd.pid', '/run/ssh-agent.socket',
  '/run/user/*/keyring', '/run/user/*/keyring/ssh', '/run/user/*/ssh*',
  '/run/user/*/gnupg*', '/tmp/ssh-*', '/root/.ssh-agent',
  '/etc/shadow', '/etc/shadow-', '/etc/gshadow', '/etc/gshadow-',
  '/etc/sudoers', '/etc/sudoers.d', '/etc/machine-id', '/etc/hostid',
  '/etc/fstab',
  '/etc/ssh', '/etc/ssl/private', '/etc/ipa', '/etc/krb5.keytab',
  '/var/log', '/var/spool/cron', '/etc/crontab', '/etc/cron.d',
  '/etc/cron.daily', '/etc/cron.hourly', '/etc/cron.weekly', '/etc/cron.monthly',
  '/root/.bash_history', '/root/.zsh_history', '/root/.sh_history',
  '/root/.python_history', '/root/.mysql_history', '/root/.psql_history',
  '/root/.sqlite_history', '/root/.node_repl_history', '/root/.wget-hsts',
  '/root/.lesshst', '/root/.viminfo',
]

/** Roots replaced by a private writable tmpfs under `workspace-write`. */
export const DEFAULT_TMPFS_ROOTS: readonly string[] = ['/tmp', '/var/tmp']

/**
 * Dangerous global `/proc` entries masked with an empty read-only file:
 * coredump/modprobe primitives and kernel-information leak surfaces that a
 * PID namespace does not hide.
 */
export const DEFAULT_PROC_MASK_PATHS: readonly string[] = [
  '/proc/sys/kernel/core_pattern',
  '/proc/sys/kernel/modprobe',
  '/proc/sys/kernel/hotplug',
  '/proc/sys/kernel/uevent_helper',
  '/proc/sys/kernel/kexec_load_disabled',
  '/proc/sys/kernel/sysrq',
  '/proc/sys/kernel/panic',
  '/proc/sys/kernel/panic_on_oops',
  '/proc/sys/kernel/perf_event_paranoid',
  '/proc/sys/kernel/unprivileged_bpf_disabled',
  '/proc/sys/kernel/unprivileged_userns_clone',
  '/proc/sys/vm/drop_caches',
  '/proc/sys/vm/compact_memory',
  '/proc/sysrq-trigger',
  '/proc/kcore',
  '/proc/modules',
  '/proc/kallsyms',
  '/proc/vmallocinfo',
  '/proc/timer_list',
  '/proc/slabinfo',
  '/proc/interrupts',
  '/proc/softirqs',
  '/proc/buddyinfo',
  '/proc/zoneinfo',
  '/proc/pagetypeinfo',
  '/proc/keys',
  '/proc/sched_debug',
  '/proc/iomem',
  '/proc/ioports',
]

/**
 * The hardened defaults. Network defaults to `OBSERVED_ONLINE` so a plain
 * deployment keeps working while honestly reporting that direct egress is not
 * kernel-enforced; set `OFFLINE`/`CONTROLLED_ONLINE` for kernel isolation.
 */
export const DEFAULT_RUNTIME_OPTIONS: RuntimeOptions = {
  networkMode: 'OBSERVED_ONLINE',
  readonlyRoots: DEFAULT_READONLY_ROOTS,
  readonlyPaths: DEFAULT_READONLY_PATHS,
  maskPaths: DEFAULT_MASK_PATHS,
  tmpfsRoots: DEFAULT_TMPFS_ROOTS,
  procMaskPaths: DEFAULT_PROC_MASK_PATHS,
  seccomp: { enabled: true, require: false },
  limits: { enabled: true, memoryRatio: 0.75, pidsMax: 8192, cpuMax: 0, cgroupBase: '/sys/fs/cgroup' },
}
