/**
 * Runtime-isolation conformance for the hardened bwrap backend. Verifies, on
 * the real host, the v2.3 mechanisms the plugin now claims:
 *
 *   1. the host root is no longer broadly readable (minimal read-only set),
 *   2. `OFFLINE` really isolates the network namespace,
 *   3. the seccomp baseline is loaded (and absent when disabled),
 *   4. cgroup v2 resource domains enforce `memory.max` and attribute the OOM.
 *
 * Run with the repo's tsx: `./node_modules/.bin/tsx scripts/runtime-conformance.ts`.
 * Checks 1–3 require bubblewrap; check 4 is skipped when cgroup delegation is
 * unavailable. Exits non-zero on any hard failure.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import Provider, { type LinuxSandboxProvider } from '../src/index.ts'
import { CgroupDomain, nodeCgroupIo } from '../src/runtime/cgroup.ts'
import { scanUpper } from '../src/runtime/overlay.ts'
import PolicyEngine from '../src/policy/plugin.ts'
import WorkspaceStagingService from '../src/stage/workspace-service.ts'

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

async function makeContext(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Provider, config)
  return ctx
}

function confinedArgv(ctx: Context, argv: readonly string[], workspace: string): string[] {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  return ctx.sandbox.confine(argv, policy).argv
}

function run(argv: readonly string[], cwd: string, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = argv
    if (program === undefined) {
      reject(new Error('empty argv'))
      return
    }
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function checkHostRootHidden(workspace: string): Promise<void> {
  const ctx = await makeContext()
  // Masking makes a sensitive path an empty tmpfs/`/dev/null`, so the
  // guarantee is CONTENT hidden, not absence. Assert the bytes are gone while
  // the genuinely whitelisted files stay readable.
  const script = [
    'echo shadow_bytes=$(wc -c < /etc/shadow 2>/dev/null || echo NA)',
    'echo sudoers_bytes=$(wc -c < /etc/sudoers 2>/dev/null || echo NA)',
    'echo ssh_entries=$(ls -A /root/.ssh 2>/dev/null | wc -l)',
    'echo passwd_bytes=$(wc -c < /etc/passwd)',
    'echo usr=$(test -e /usr/bin/sh && echo READABLE || echo MISSING)',
  ].join('; ')
  const result = await run(confinedArgv(ctx, ['/bin/sh', '-c', script], workspace), workspace)
  const out = result.stdout
  // A masked sensitive file is unreadable (NA) or empty (0); either way no
  // bytes leak. Whitelisted files stay readable.
  const ok = !/(shadow_bytes|sudoers_bytes)=[1-9]/u.test(out)
    && /ssh_entries=0/u.test(out)
    && /passwd_bytes=[1-9]/u.test(out)
    && /usr=READABLE/u.test(out)
  record('host-root-hidden', ok ? 'pass' : 'fail', JSON.stringify(out.trim() || result.stderr.trim()))
}

async function checkNetworkIsolation(workspace: string): Promise<void> {
  const offline = await makeContext({ networkMode: 'OFFLINE' })
  const offlineResult = await run(confinedArgv(offline, ['/bin/sh', '-c', 'cat /proc/net/dev'], workspace), workspace)
  const isolated = !/(eth|enp|wlan|bond|docker)/u.test(offlineResult.stdout)
  const observed = await makeContext({ networkMode: 'OBSERVED_ONLINE' })
  const observedResult = await run(confinedArgv(observed, ['/bin/sh', '-c', 'cat /proc/net/dev'], workspace), workspace)
  const shared = /(eth|enp|wlan|bond|docker)/u.test(observedResult.stdout)
  const ok = isolated && shared
  record(
    'network-isolation',
    ok ? 'pass' : 'fail',
    `offline-ifaces=${offlineResult.stdout.split('\n').slice(2).map(line => line.split(':')[0]).filter(Boolean).join(',') || 'lo only'}; observed-has-host-iface=${shared}`,
  )
}

async function checkSeccomp(workspace: string): Promise<void> {
  const withFilter = await makeContext({ seccompEnabled: true })
  const filtered = await run(confinedArgv(withFilter, ['/bin/sh', '-c', 'grep -i ^Seccomp: /proc/self/status'], workspace), workspace)
  const withoutFilter = await makeContext({ seccompEnabled: false })
  const plain = await run(confinedArgv(withoutFilter, ['/bin/sh', '-c', 'grep -i ^Seccomp: /proc/self/status'], workspace), workspace)
  const filterLoaded = /Seccomp:\s*2/u.test(filtered.stdout)
  const plainUnfiltered = /Seccomp:\s*0/u.test(plain.stdout)
  const mountBlocked = await run(
    confinedArgv(withFilter, ['/bin/sh', '-c', 'mount -t tmpfs none /mnt >/dev/null 2>&1; echo code=$?'], workspace),
    workspace,
  )
  const mountDenied = /code=(1|[1-9][0-9]+)/u.test(mountBlocked.stdout)
  const ok = filterLoaded && plainUnfiltered && mountDenied
  record('seccomp-baseline', ok ? 'pass' : 'fail', `with=${filtered.stdout.trim()}; without=${plain.stdout.trim()}; mount=${mountBlocked.stdout.trim()}`)
}

async function checkOverlayDelta(workspace: string): Promise<void> {
  writeFileSync(join(workspace, 'a.txt'), 'original')
  writeFileSync(join(workspace, 'keep.txt'), 'keep')
  const ctx = await makeContext()
  const provider = ctx.sandbox as LinuxSandboxProvider
  if (!provider.overlaySupported()) {
    record('overlay-delta-execution', 'skip', 'bwrap overlay unsupported on this host')
    return
  }
  const overlayRoot = mkdtempSync(join(tmpdir(), 'dsh-conformance-ovl-'))
  try {
    const upper = join(overlayRoot, 'upper')
    const work = join(overlayRoot, 'work')
    mkdirSync(upper)
    mkdirSync(work)
    const argv = provider.confineOverlay(
      ['/bin/sh', '-c', 'echo changed > a.txt; echo new > b.txt; rm keep.txt'],
      { mode: 'workspace-write', workspaceRoot: workspace },
      { upper, work },
    ).argv
    const result = await run(argv, workspace)
    const untouched = readFileSync(join(workspace, 'a.txt'), 'utf8') === 'original'
      && !existsSync(join(workspace, 'b.txt'))
      && existsSync(join(workspace, 'keep.txt'))
    const capture = scanUpper(upper)
    const changed = capture.entries.map(entry => entry.path).sort().join(',')
    const ok = result.code === 0 && untouched && changed === 'a.txt,b.txt'
      && capture.deletions.includes('keep.txt')
    record('overlay-delta-execution', ok ? 'pass' : 'fail', `code=${result.code} untouched=${untouched} changed=[${changed}] deleted=[${capture.deletions.join(',')}]`)
  } finally {
    rmSync(overlayRoot, { recursive: true, force: true })
  }
}

async function checkWorkspaceOverlay(workspace: string): Promise<void> {
  writeFileSync(join(workspace, 'a.txt'), 'original')
  writeFileSync(join(workspace, 'b.txt'), 'base-b')
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(PolicyEngine, { defaultTimeoutMs: 2000, python: false, packs: [] })
  await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace, stateDir: '' })
  const provider = ctx.sandbox as LinuxSandboxProvider
  if (!provider.overlaySupported()) {
    record('workspace-overlay-publish', 'skip', 'bwrap overlay unsupported on this host')
    return
  }
  const service = ctx.sandboxWorkspace
  const ws = service.workspaceFor(workspace)
  // A base-only file is readable through the delta via the base fallback.
  const baseFallback = ws.readText(join(workspace, 'b.txt')) === 'base-b'
  // A tool edit lands in the delta.
  ws.writeText(join(workspace, 'a.txt'), 'staged-a')
  // A command runs against the overlay at the real path, seeing the tool edit.
  provider.registerOverlay(workspace, ws.overlaySpec())
  const argv = ctx.sandbox.confine(
    ['/bin/sh', '-c', 'cat a.txt > out.txt; echo extra >> a.txt; rm b.txt'],
    { mode: 'workspace-write', workspaceRoot: workspace },
  ).argv
  const result = await run(argv, workspace)
  ws.reconcileOverlay()
  const realUntouched = readFileSync(join(workspace, 'a.txt'), 'utf8') === 'original'
    && existsSync(join(workspace, 'b.txt'))
    && !existsSync(join(workspace, 'out.txt'))
  const seesCommand = ws.readText(join(workspace, 'out.txt')) === 'staged-a'
  const commandEdit = ws.readText(join(workspace, 'a.txt')) === 'staged-aextra\n'
  const commandDelete = ws.exists(join(workspace, 'b.txt')) === false
  // Publishing applies the full manifest from delta content under CAS.
  const applied = await service.apply(workspace, { confirm: true })
  const published = applied.kind === 'published'
  const realApplied = readFileSync(join(workspace, 'a.txt'), 'utf8') === 'staged-aextra\n'
    && readFileSync(join(workspace, 'out.txt'), 'utf8') === 'staged-a'
    && !existsSync(join(workspace, 'b.txt'))
  const ok = result.code === 0 && baseFallback && realUntouched && seesCommand && commandEdit && commandDelete && published && realApplied
  record('workspace-overlay-publish', ok ? 'pass' : 'fail',
    `code=${result.code} baseFallback=${baseFallback} realUntouched=${realUntouched} seesCommand=${seesCommand} commandEdit=${commandEdit} commandDelete=${commandDelete} published=${published} realApplied=${realApplied}`)
}

async function checkSelectivePublish(workspace: string): Promise<void> {
  writeFileSync(join(workspace, 'a.txt'), 'base-a')
  writeFileSync(join(workspace, 'b.txt'), 'base-b')
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(PolicyEngine, { defaultTimeoutMs: 2000, python: false, packs: [] })
  await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace, stateDir: '' })
  const service = ctx.sandboxWorkspace
  const ws = service.workspaceFor(workspace)
  ws.writeText(join(workspace, 'a.txt'), 'new-a')
  ws.writeText(join(workspace, 'b.txt'), 'new-b')
  try {
    const first = await service.apply(workspace, { files: [join(workspace, 'a.txt')], confirm: true })
    const aApplied = first.kind === 'published' && readFileSync(join(workspace, 'a.txt'), 'utf8') === 'new-a'
    const bPending = readFileSync(join(workspace, 'b.txt'), 'utf8') === 'base-b'
      && service.state(workspace).changes.map(change => change.path).join(',') === 'b.txt'
    const second = await service.apply(workspace, { confirm: true })
    const bApplied = second.kind === 'published' && readFileSync(join(workspace, 'b.txt'), 'utf8') === 'new-b'
    const ok = aApplied && bPending && bApplied
    record('workspace-selective-publish', ok ? 'pass' : 'fail', `aApplied=${aApplied} bPending=${bPending} bApplied=${bApplied}`)
  } finally {
    service.discard(workspace)
  }
}

async function checkResident(workspace: string): Promise<void> {
  writeFileSync(join(workspace, 'a.txt'), 'base-a')
  const ctx = new Context()
  await ctx.plugin(Provider)
  await ctx.plugin(PolicyEngine, { defaultTimeoutMs: 2000, python: false, packs: [] })
  await ctx.plugin(WorkspaceStagingService, { workspaceRoot: workspace, stateDir: '', resident: true })
  const provider = ctx.sandbox as LinuxSandboxProvider
  if (!provider.overlaySupported()) {
    record('resident-server', 'skip', 'bwrap overlay unsupported on this host')
    return
  }
  const service = ctx.sandboxWorkspace
  const ws = service.workspaceFor(workspace)
  ws.writeText(join(workspace, 'from-tool.txt'), 'from-tool')
  const run = (command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
    service.runResident({ workspaceRoot: workspace, command, cwd: workspace, env: {} })
  try {
    const seesEdit = (await run('cat from-tool.txt')).stdout === 'from-tool'
    // Edits made after the server started are pushed in from inside its namespace.
    ws.writeText(join(workspace, 'after-mount.txt'), 'after-mount')
    const seesAfter = (await run('cat after-mount.txt')).stdout === 'after-mount'
    ws.remove(join(workspace, 'a.txt'))
    const seesDelete = (await run('test -e a.txt && echo present || echo gone')).stdout.trim() === 'gone'
    await run('cd /tmp')
    const cwd = (await run('pwd')).stdout.trim()
    await run('export DSH_RESIDENT_CHECK=ok')
    const variable = (await run('echo $DSH_RESIDENT_CHECK')).stdout.trim()
    const pid = Number.parseInt((await run('sleep 300 & echo $!')).stdout.trim(), 10)
    const alive = (await run(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`)).stdout.trim()
    const untouched = !existsSync(join(workspace, 'from-tool.txt'))
      && !existsSync(join(workspace, 'after-mount.txt'))
      && existsSync(join(workspace, 'a.txt'))
    const ok = cwd === '/tmp' && variable === 'ok' && alive === 'alive' && seesEdit && seesAfter && seesDelete && untouched
    record('resident-server', ok ? 'pass' : 'fail',
      `cwd=${cwd} var=${variable} bg=${alive} seesEdit=${seesEdit} afterMount=${seesAfter} delete=${seesDelete} untouched=${untouched}`)
  } finally {
    service.discard(workspace)
  }
}

async function checkCgroup(workspace: string): Promise<void> {
  const base = '/sys/fs/cgroup'
  const domain = CgroupDomain.create('conformance', {
    enabled: true,
    memoryRatio: 0,
    memoryMaxBytes: 64 * 1024 * 1024,
    pidsMax: 512,
    cpuMax: 0,
    cgroupBase: base,
  }, nodeCgroupIo, totalmem())
  if (domain === undefined) {
    record('cgroup-memory-limit', 'skip', 'cgroup v2 delegation unavailable on this host')
    return
  }
  const baseline = domain.oomBaseline()
  const allocator = 'const b=[]; for (let i=0;i<512;i++){ b.push(Buffer.alloc(1024*1024, i%256)); } console.log("allocated")'
  const result = await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', allocator], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid !== undefined) domain.addProcess(child.pid)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
  })
  const attribution = domain.oomAttribution(baseline)
  domain.release()
  const killed = result.code !== 0 && !result.stdout.includes('allocated')
  const ok = killed && attribution.oom && attribution.level === 'sandbox'
  record('cgroup-memory-limit', ok ? 'pass' : 'fail', `code=${result.code} signal=${result.signal} oom=${JSON.stringify(attribution)}`)
}

async function main(): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-conformance-'))
  try {
    await checkHostRootHidden(workspace)
    await checkNetworkIsolation(workspace)
    await checkSeccomp(workspace)
    await checkOverlayDelta(workspace)
    await checkWorkspaceOverlay(workspace)
    await checkSelectivePublish(workspace)
    await checkResident(workspace)
    await checkCgroup(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  for (const result of results) console.log(`[${result.status.toUpperCase()}] ${result.name}: ${result.detail}`)
  const failed = results.filter(result => result.status === 'fail')
  console.log(`\n${results.length - failed.length}/${results.length} checks passed/skipped`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
