/**
 * Security / sandbox-escape conformance for the hardened Linux backend.
 *
 * This suite is adversarial: every check runs a *dangerous* command or a
 * common container/namespace escape attempt **inside** the sandbox
 * (`ctx.sandbox.confine`, i.e. bubblewrap + seccomp + minimal root + masking +
 * the configured network mode) and asserts the attack is BLOCKED. A check
 * FAILS only when the boundary is actually breached — never when the sandbox
 * behaves correctly.
 *
 * Nothing here runs unconfined: destructive commands (`rm -rf`, fork bombs,
 * raw-device writes) are all wrapped by bwrap and, where resource exhaustion is
 * involved, bounded by a cgroup v2 domain as well.
 *
 * Covered attack classes:
 *   - host secret read (/etc/shadow, keys, host home, logs)
 *   - host root write / system-file overwrite (read-only root)
 *   - namespace escapes (unshare user/mount/pid, mount, setns)
 *   - seccomp-denied syscalls (ptrace, bpf, keyctl, io_uring, module load)
 *   - device-node creation, raw sockets, raw block devices
 *   - orchestrator sockets (docker/containerd/dbus) masked
 *   - network egress under OFFLINE / CONTROLLED_ONLINE
 *   - process-storm teardown and cgroup pids-limit resource containment
 *   - destructive in-workspace command does not touch the real workspace
 *
 * Run with: `./node_modules/.bin/tsx scripts/security-conformance.ts`
 * Or via the container runner (it is wired into scripts/container/run-tests.sh).
 * Exits non-zero on any FAIL.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import Provider, { type LinuxSandboxProvider } from '../src/index.ts'
import { CgroupDomain, nodeCgroupIo } from '../src/runtime/cgroup.ts'
import { scanUpper } from '../src/runtime/overlay.ts'

interface CheckResult {
  readonly name: string
  readonly status: 'pass' | 'fail' | 'skip'
  readonly detail: string
}

interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

const results: CheckResult[] = []
const record = (name: string, status: CheckResult['status'], detail: string): void => {
  results.push({ name, status, detail })
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

async function makeContext(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Provider, config)
  return ctx
}

function confinedArgv(ctx: Context, argv: readonly string[], workspace: string): string[] {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  return ctx.sandbox.confine(argv, policy).argv
}

function run(argv: readonly string[], cwd: string, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = argv
    if (program === undefined) {
      reject(new Error('empty argv'))
      return
    }
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Run a shell snippet confined, returning its stdout. */
async function shell(ctx: Context, workspace: string, script: string, timeoutMs = 15_000): Promise<RunResult> {
  return run(confinedArgv(ctx, ['/bin/sh', '-c', script], workspace), workspace, timeoutMs)
}

/** A command that prints `code=<exit>`; PASS when the command failed (blocked). */
async function expectBlocked(name: string, ctx: Context, workspace: string, command: string, timeoutMs = 15_000): Promise<void> {
  const result = await shell(ctx, workspace, `${command} >/dev/null 2>&1; echo "code=$?"`, timeoutMs)
  const code = Number.parseInt((result.stdout.match(/code=(-?\d+)/u)?.[1]) ?? '0', 10)
  record(name, code !== 0 ? 'pass' : 'fail', `exit=${code} cmd=${command}`)
}

// --- syscall denylist (arch-aware) -----------------------------------------

const SYSCALLS: Record<string, ReadonlyArray<readonly [string, number]>> = {
  x64: [
    ['ptrace', 101], ['bpf', 321], ['keyctl', 250], ['io_uring_setup', 425],
    ['init_module', 175], ['finit_module', 313], ['setns', 308], ['unshare', 272], ['mount', 165],
  ],
  arm64: [
    ['ptrace', 117], ['bpf', 280], ['keyctl', 219], ['io_uring_setup', 425],
    ['init_module', 105], ['finit_module', 273], ['setns', 268], ['unshare', 97], ['mount', 40],
  ],
}

function archKey(): string | undefined {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return undefined
}

/** Wrap Python source in a shell heredoc so it is interpreted, not run as sh. */
function pyShell(code: string): string {
  return ['python3 - <<\'PY\'', code, 'PY'].join('\n')
}

function pythonProbe(syscalls: ReadonlyArray<readonly [string, number]>): string {
  const entries = syscalls.map(([name, nr]) => `("${name}",${nr})`).join(',')
  return [
    'import ctypes, socket',
    'libc = ctypes.CDLL(None, use_errno=True)',
    `probes = [${entries}]`,
    'for name, nr in probes:',
    '    ctypes.set_errno(0)',
    '    rc = libc.syscall(nr, 0, 0, 0, 0, 0, 0)',
    '    err = ctypes.get_errno()',
    '    state = "DENIED" if (rc == -1 and err == 1) else "ALLOWED"',
    '    print("syscall_" + name + "=" + state + " rc=" + str(rc) + " errno=" + str(err))',
    'for fam, label in [(17, "af_packet"), (40, "af_vsock")]:',
    '    try:',
    '        s = socket.socket(fam, socket.SOCK_RAW, 0)',
    '        s.close()',
    '        print(label + "=ALLOWED")',
    '    except OSError as e:',
    '        print(label + "=DENIED errno=" + str(e.errno))',
  ].join('\n')
}

async function checkSyscallDenylist(workspace: string): Promise<void> {
  const arch = archKey()
  if (arch === undefined) {
    record('seccomp-syscall-denylist', 'skip', `unsupported arch ${process.arch}`)
    return
  }
  const ctx = await makeContext({ seccompEnabled: true })
  const result = await shell(ctx, workspace, pyShell(pythonProbe(SYSCALLS[arch] as ReadonlyArray<readonly [string, number]>) ), 20_000)
  const lines = result.stdout.split('\n')
  for (const [name] of SYSCALLS[arch] as ReadonlyArray<readonly [string, number]>) {
    const line = lines.find(value => value.startsWith(`syscall_${name}=`))
    const denied = line?.includes('=DENIED') ?? false
    record(`seccomp-denies:${name}`, denied ? 'pass' : 'fail', line?.trim() ?? `no output; stderr=${result.stderr.trim().slice(0, 120)}`)
  }
  for (const label of ['af_packet', 'af_vsock']) {
    const line = lines.find(value => value.startsWith(`${label}=`))
    const denied = line?.includes('=DENIED') ?? false
    record(`seccomp-denies:${label}`, denied ? 'pass' : 'fail', line?.trim() ?? 'no output')
  }
}

// --- filesystem / secret isolation -----------------------------------------

async function checkHostSecrets(workspace: string): Promise<void> {
  const ctx = await makeContext()
  const script = [
    'echo "shadow=$(cat /etc/shadow 2>/dev/null | wc -c)"',
    'echo "gshadow=$(cat /etc/gshadow 2>/dev/null | wc -c)"',
    'echo "ssh=$(ls -A /root/.ssh 2>/dev/null | wc -l)"',
    'echo "aws=$(ls -A /root/.aws 2>/dev/null | wc -l)"',
    'echo "varlog=$(ls -A /var/log 2>/dev/null | wc -l)"',
    'for d in /root /home /srv /mnt; do test -e "$d" && echo "$d=present" || echo "$d=absent"; done',
  ].join('; ')
  const result = await shell(ctx, workspace, script)
  const out = result.stdout
  const ok = /shadow=0/u.test(out) && /gshadow=0/u.test(out) && /ssh=0/u.test(out)
    && /aws=0/u.test(out) && /varlog=0/u.test(out)
    && !/=(present)/u.test(out)
  record('host-secrets-hidden', ok ? 'pass' : 'fail', JSON.stringify(out.trim()))
}

async function checkProcMasked(workspace: string): Promise<void> {
  const ctx = await makeContext()
  const script = [
    'for f in /proc/kcore /proc/kallsyms /proc/modules /proc/sysrq-trigger /proc/sys/kernel/core_pattern; do',
    '  echo "$f=$(wc -c < "$f" 2>/dev/null || echo X)";',
    'done',
    'echo x > /proc/sysrq-trigger 2>/dev/null; echo "sysrq_write=$?";',
    'echo x > /proc/sys/kernel/core_pattern 2>/dev/null; echo "core_write=$?";',
  ].join('\n')
  const result = await shell(ctx, workspace, script)
  const out = result.stdout
  const allHidden = ['/proc/kcore', '/proc/kallsyms', '/proc/modules', '/proc/sysrq-trigger', '/proc/sys/kernel/core_pattern']
    .every(file => {
      const match = out.match(new RegExp(`${file.replace(/[/.]/gu, '\\$&')}=(\\S+)`, 'u'))
      // A masked proc entry is overlaid with /dev/null: either it reads as 0
      // bytes or the open is denied — never the real kernel bytes.
      return match !== null && (match[1] === '0' || match[1] === 'X')
    })
  const writesDenied = /sysrq_write=[1-9]/u.test(out) && /core_write=[1-9]/u.test(out)
  record('proc-entries-masked', allHidden && writesDenied ? 'pass' : 'fail', JSON.stringify(out.trim()))
}

async function checkHostRootReadonly(workspace: string): Promise<void> {
  const ctx = await makeContext()
  const script = [
    'touch /usr/bin/dsh-escape 2>/dev/null; echo "usr=$?";',
    'echo pwned >> /etc/passwd 2>/dev/null; echo "passwd=$?";',
    'touch /var/lib/dsh-escape 2>/dev/null; echo "varlib=$?";',
    'rm -f /etc/passwd 2>/dev/null; echo "rm=$?";',
  ].join(' ')
  const result = await shell(ctx, workspace, script)
  const out = result.stdout
  const denied = ['usr', 'passwd', 'varlib', 'rm'].every(key => new RegExp(`${key}=[1-9]`, 'u').test(out))
  const hostIntact = existsSync('/usr/bin/sh') || existsSync('/bin/sh')
  record('host-root-readonly', denied && hostIntact ? 'pass' : 'fail', JSON.stringify(out.trim()))
}

async function checkDeviceAccess(workspace: string): Promise<void> {
  const ctx = await makeContext()
  const script = [
    'mknod /tmp/dsh-dev c 1 3 2>/dev/null; echo "mknod=$?";',
    'test -e /dev/sda && echo "sda=present" || echo "sda=absent";',
    'test -e /dev/mem && echo "mem=present" || echo "mem=absent";',
    'test -e /dev/kmsg && echo "kmsg=present" || echo "kmsg=absent";',
    'echo "block_devices=$(find /dev -type b 2>/dev/null | wc -l)";',
  ].join(' ')
  const result = await shell(ctx, workspace, script)
  const out = result.stdout
  const ok = /mknod=[1-9]/u.test(out) && /sda=absent/u.test(out) && /mem=absent/u.test(out)
    && /kmsg=absent/u.test(out) && /block_devices=0/u.test(out)
  record('block-device-access-denied', ok ? 'pass' : 'fail', JSON.stringify(out.trim()))
}

async function checkOrchestratorSockets(workspace: string): Promise<void> {
  const ctx = await makeContext()
  const script = [
    'for s in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/dbus/system_bus_socket; do',
    '  if [ -S "$s" ]; then echo "$s=still-a-socket"; else echo "$s=no-socket"; fi;',
    'done',
    'python3 - <<\'PY\'',
    'import socket',
    'for p in ["/var/run/docker.sock","/run/docker.sock","/run/containerd/containerd.sock"]:',
    '    try:',
    '        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    '        s.settimeout(1)',
    '        s.connect(p)',
    '        print("connect_" + p + "=OPEN")',
    '    except OSError as e:',
    '        print("connect_" + p + "=DENIED errno=" + str(e.errno))',
    'PY',
  ].join('\n')
  const result = await shell(ctx, workspace, script, 20_000)
  const out = result.stdout
  const ok = !/still-a-socket/u.test(out) && !/=OPEN/u.test(out) && /no-socket/u.test(out)
  record('orchestrator-sockets-masked', ok ? 'pass' : 'fail', JSON.stringify(out.trim().slice(0, 300)))
}

// --- network ---------------------------------------------------------------

function networkEgressProbe(): string {
  return [
    'echo "ifaces=$(cat /proc/net/dev | awk -F: \'NR>2 {gsub(/ /,"",$1); if ($1!="lo") print $1}\' | wc -l)"',
    'python3 - <<\'PY\'',
    'import socket',
    'for host in [("1.1.1.1", 443), ("169.254.169.254", 80)]:',
    '    try:',
    '        s = socket.create_connection(host, timeout=2)',
    '        print("egress_" + host[0] + "=OPEN")',
    '        s.close()',
    '    except OSError as e:',
    '        print("egress_" + host[0] + "=BLOCKED errno=" + str(e.errno))',
    'PY',
  ].join('\n')
}

async function checkNetworkIsolation(workspace: string): Promise<void> {
  for (const mode of ['OFFLINE', 'CONTROLLED_ONLINE']) {
    const ctx = await makeContext({ networkMode: mode })
    const result = await shell(ctx, workspace, networkEgressProbe(), 20_000)
    const out = result.stdout
    const noHostIfaces = /ifaces=0/u.test(out)
    const egressBlocked = !/=OPEN/u.test(out) && /egress_1\.1\.1\.1=BLOCKED/u.test(out)
    record(`network-${mode.toLowerCase()}-isolated`, noHostIfaces && egressBlocked ? 'pass' : 'fail', JSON.stringify(out.trim().slice(0, 240)))
  }
}

// --- resource exhaustion ---------------------------------------------------

/**
 * Count the live descendants of a pid by scanning the outer `/proc` (works
 * across the sandbox's child PID namespace). `stat` is parsed from the last
 * `)` so a `comm` containing spaces/parens cannot shift the fields.
 */
function descendantsOf(rootPid: number): number {
  const childrenOf = new Map<number, number[]>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/u.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const ppid = Number(rest[1])
      const list = childrenOf.get(ppid) ?? []
      list.push(Number(name))
      childrenOf.set(ppid, list)
    } catch {
      // the process vanished while scanning
    }
  }
  const seen = new Set<number>()
  const stack = [rootPid]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    for (const child of childrenOf.get(pid) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        stack.push(child)
      }
    }
  }
  return seen.size
}

async function checkProcessStorm(workspace: string): Promise<void> {
  const ctx = await makeContext()
  // A bounded process storm (not an unbounded fork bomb: the sandbox payload
  // runs as root in a user namespace, where RLIMIT_NPROC is NOT enforced, so
  // an unbounded bomb would risk the host — real DoS containment is the cgroup
  // pids domain, verified by checkCgroupPids below). This asserts the sandbox
  // tears the whole process tree down and leaks nothing.
  const storm = 'for i in $(seq 1 200); do sleep 30 & done; echo launched=$i; wait'
  const argv = confinedArgv(ctx, ['/bin/bash', '-c', storm], workspace)
  const [program, ...args] = argv
  const child = spawn(program as string, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
  let maxDescendants = 0
  const started = Date.now()
  while (Date.now() - started < 2500) {
    if (child.pid !== undefined) maxDescendants = Math.max(maxDescendants, descendantsOf(child.pid))
    await sleep(200)
  }
  child.kill('SIGKILL')
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => { child.once('close', () => { resolve() }) })
  }
  await sleep(1500)
  const remaining = child.pid === undefined ? 0 : descendantsOf(child.pid)
  const ok = maxDescendants >= 1 && maxDescendants <= 260 && remaining === 0
  record('process-storm-contained', ok ? 'pass' : 'fail',
    `maxDescendants=${maxDescendants} remainingAfterKill=${remaining} expected=200`)
}

async function checkCgroupPids(workspace: string): Promise<void> {
  const domain = CgroupDomain.create('security-pids', {
    enabled: true, memoryRatio: 0, memoryMaxBytes: 256 * 1024 * 1024, pidsMax: 16, cpuMax: 0, cgroupBase: '/sys/fs/cgroup',
  }, nodeCgroupIo, totalmem())
  if (domain === undefined) {
    record('cgroup-pids-limit', 'skip', 'cgroup v2 delegation unavailable')
    return
  }
  // A direct child (no bwrap) so cgroup membership is unambiguous. Ask for 100
  // processes under a pids.max of 16; the limit must hold.
  const child = spawn('/bin/bash', ['-c', 'for i in $(seq 1 100); do sleep 30 & done; echo done; wait'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid !== undefined) domain.addProcess(child.pid)
  await sleep(2500)
  const current = Number.parseInt((() => { try { return readFileSync(join(domain.path, 'pids.current'), 'utf8') } catch { return '0' } })().trim(), 10)
  const events = (() => { try { return readFileSync(join(domain.path, 'pids.events'), 'utf8') } catch { return '' } })()
  const limitHits = Number.parseInt(events.match(/(^|\n)max (\d+)/u)?.[2] ?? '0', 10)
  domain.kill()
  child.kill('SIGKILL')
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => { child.once('close', () => { resolve() }) })
  }
  domain.release()
  const ok = current > 0 && current <= 16 && limitHits >= 1
  record('cgroup-pids-limit', ok ? 'pass' : 'fail',
    `pids.current=${current} pids.max=16 limitHits=${limitHits}`)
}

// --- staging safety --------------------------------------------------------

async function checkDestructiveStaging(workspace: string): Promise<void> {
  writeFileSync(join(workspace, 'victim.txt'), 'original')
  writeFileSync(join(workspace, 'keep.txt'), 'keep')
  const ctx = await makeContext()
  const provider = ctx.sandbox as LinuxSandboxProvider
  if (!provider.overlaySupported()) {
    record('destructive-staging-contained', 'skip', 'bwrap overlay unsupported on this host')
    return
  }
  const overlayRoot = mkdtempSync(join(tmpdir(), 'dsh-security-ovl-'))
  try {
    const upper = join(overlayRoot, 'upper')
    const work = join(overlayRoot, 'work')
    mkdirSync(upper)
    mkdirSync(work)
    const argv = provider.confineOverlay(
      ['/bin/sh', '-c', 'rm -rf victim.txt keep.txt; echo pwned > victim.txt; dd if=/dev/zero of=big bs=1M count=8'],
      { mode: 'workspace-write', workspaceRoot: workspace },
      { upper, work },
    ).argv
    const result = await run(argv, workspace, 30_000)
    const realUntouched = readFileSync(join(workspace, 'victim.txt'), 'utf8') === 'original'
      && existsSync(join(workspace, 'keep.txt'))
      && !existsSync(join(workspace, 'big'))
    const captured = scanUpper(upper).entries.map(entry => entry.path).sort().join(',')
    const ok = result.code === 0 && realUntouched && captured.includes('victim.txt') && captured.includes('big')
    record('destructive-staging-contained', ok ? 'pass' : 'fail',
      `code=${result.code} realUntouched=${realUntouched} captured=[${captured}]`)
  } finally {
    rmSync(overlayRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-security-'))
  try {
    await checkHostSecrets(workspace)
    await checkProcMasked(workspace)
    await checkHostRootReadonly(workspace)
    await checkDeviceAccess(workspace)
    await checkOrchestratorSockets(workspace)
    await checkSyscallDenylist(workspace)
    await checkNetworkIsolation(workspace)
    await checkProcessStorm(workspace)
    await checkCgroupPids(workspace)
    await checkDestructiveStaging(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  for (const result of results) {
    const color = result.status === 'pass' ? '\x1b[32m' : result.status === 'fail' ? '\x1b[31m' : '\x1b[33m'
    console.log(`${color}[${result.status.toUpperCase()}]\x1b[0m ${result.name}: ${result.detail}`)
  }
  const failed = results.filter(result => result.status === 'fail')
  console.log(`\n${results.length - failed.length}/${results.length} security checks passed/skipped`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
