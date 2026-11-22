/**
 * `provider-protocol` / `provider-client` / `supervisor` 单测。
 *
 * 全部离线：Unix socket 冒充 provider 管道，FakeDriverPort 冒充驱动。
 * 不 spawn 真实进程、不加载驱动、不触碰真实路径（`makeDir` 注入 no-op）。
 *
 * @module winstage-sandbox/tests/nt/supervisor
 */

import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { FakeDriverPort } from '../../src/nt/driver.ts'
import { POLICY_MAGIC } from '../../src/nt/policy-binary.ts'
import {
  PipeProviderControl,
  ProviderTransportError,
  type ProviderControl,
} from '../../src/nt/provider-client.ts'
import {
  DEFAULT_PROVIDER_PIPE,
  parseProviderReply,
  providerSocketPath,
} from '../../src/nt/provider-protocol.ts'
import { NtRuntime } from '../../src/nt/runtime.ts'
import { NtSupervisor } from '../../src/nt/supervisor.ts'
import { NtError } from '../../src/nt/types.ts'
import { check, eq, includes, rejectsCode, runSuite, section } from './harness.ts'

const WORKSPACE = 'C:\\work\\proj'
const VIEW = 'C:\\work\\.proj.dshnt\\view'
const STORE = 'C:\\work\\.proj.dshnt\\store'

const GOOD_COMMANDS: Record<string, string> = {
  'fltmc filters': 'dshnt   1   371100   0\n',
  'sc query dshnt': 'STATE : 4 RUNNING\n',
  'Client-ProjFS': 'Enabled\n',
}

async function goodRun(command: string): Promise<string> {
  for (const [needle, output] of Object.entries(GOOD_COMMANDS)) {
    if (command.includes(needle)) return output
  }
  throw new Error(`unexpected command: ${command}`)
}

async function runs(command: string): Promise<string> {
  if (command.includes('Client-ProjFS')) return 'Enabled\n'
  if (command.includes('fltmc filters')) return 'bindflt 1 409800 0\n'
  if (command.includes('sc query')) return 'STATE : 1 STOPPED\n'
  throw new Error(`unexpected command: ${command}`)
}

interface FakeProvider {
  server: Server
  ops: string[]
  close(): Promise<void>
}

async function startFakeProvider(
  socketPath: string,
  options: { failStart?: boolean; closeImmediately?: boolean; badJson?: boolean; wrongId?: boolean } = {},
): Promise<FakeProvider> {
  const ops: string[] = []
  const server = createServer((socket: Socket) => {
    if (options.closeImmediately === true) {
      socket.destroy()
      return
    }
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const request = JSON.parse(line) as { id?: number; op?: string }
        const op = String(request.op)
        ops.push(op)
        if (options.badJson === true) {
          socket.write('this is not json\n')
        } else if (options.wrongId === true) {
          socket.write(`${JSON.stringify({ id: (request.id ?? 0) + 999, ok: true })}\n`)
        } else if (op === 'start' && options.failStart === true) {
          socket.write(`${JSON.stringify({ id: request.id, ok: false, error: 'synthetic start failure' })}\n`)
        } else if (op === 'stats') {
          socket.write(
            `${JSON.stringify({ id: request.id, ok: true, stats: { domains: 1, views: [{ view: VIEW }] } })}\n`,
          )
        } else {
          socket.write(`${JSON.stringify({ id: request.id, ok: true })}\n`)
        }
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return {
    server,
    ops,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

function socketPath(tag: string): string {
  return join(tmpdir(), `dshnt-supervisor-${tag}-${process.pid}.sock`)
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 不存在即可
  }
}

function makeRuntime(
  driver: FakeDriverPort,
  overrides: {
    run?: (command: string) => Promise<string>
    providerSocket?: string
    viewRoot?: string
    storeRoot?: string
    providerPath?: string
  } = {},
): NtRuntime {
  return new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: overrides.viewRoot ?? VIEW,
      storeRoot: overrides.storeRoot ?? STORE,
      launcherPath: 'C:\\dshnt\\dshnt-launch.exe',
      providerPath: overrides.providerPath ?? 'C:\\dshnt\\dshnt-provider.exe',
      driver,
      run: overrides.run ?? goodRun,
      providerSocket: overrides.providerSocket,
    },
    driver,
  )
}

function makeSupervisor(runtime: NtRuntime, control: ProviderControl) {
  return new NtSupervisor({
    runtime,
    control,
    sleep: async () => {},
    makeDir: () => {},
    pingAttempts: 3,
    pingIntervalMs: 1,
    timeoutMs: 500,
  })
}

await runSuite('nt-supervisor', async () => {
  section('1. provider 协议（纯函数/常量）')
  eq('默认管道名', DEFAULT_PROVIDER_PIPE, 'dshnt-provider')
  eq('Windows 路径', providerSocketPath('p', 'win32'), '\\\\.\\pipe\\p')
  eq('非 Windows 无路径', providerSocketPath('p', 'linux'), undefined)
  eq('合法回复', parseProviderReply('{"id":1,"ok":true}'), { id: 1, ok: true })
  const badJson = parseProviderReply('nope')
  eq('坏 JSON 收成 ok=false', badJson.ok, false)
  includes('坏 JSON 带原因', String(badJson.error), 'bad provider reply')
  eq('缺 ok 也判失败', parseProviderReply('{"id":1}').ok, false)

  section('2. PipeProviderControl')
  const s1 = socketPath('client')
  removeSocket(s1)
  const fake = await startFakeProvider(s1)
  try {
    const control = new PipeProviderControl(s1, { timeoutMs: 1000 })
    const ping = await control.request('ping')
    eq('ping 成功', ping.ok, true)
    eq('op 被记录', fake.ops, ['ping'])
    eq('start 成功', (await control.request('start', { domain: 'd1' })).ok, true)
    control.close()
    let closed = false
    try {
      await control.request('ping')
    } catch {
      closed = true
    }
    check('关闭后拒绝请求', closed)
  } finally {
    await fake.close()
    removeSocket(s1)
  }

  const s2 = socketPath('noreply')
  removeSocket(s2)
  const closing = await startFakeProvider(s2, { closeImmediately: true })
  try {
    let closedError: unknown
    try {
      await new PipeProviderControl(s2, { timeoutMs: 500 }).request('ping')
    } catch (error) {
      closedError = error
    }
    check('管道提前关闭 → 传输错误', closedError instanceof ProviderTransportError, String(closedError))
  } finally {
    await closing.close()
    removeSocket(s2)
  }

  const s3 = socketPath('badjson')
  removeSocket(s3)
  const badServer = await startFakeProvider(s3, { badJson: true })
  try {
    const reply = await new PipeProviderControl(s3, { timeoutMs: 500 }).request('ping')
    eq('坏 JSON 不抛，返回 ok=false', reply.ok, false)
  } finally {
    await badServer.close()
    removeSocket(s3)
  }

  const s4 = socketPath('wrongid')
  removeSocket(s4)
  const wrongId = await startFakeProvider(s4, { wrongId: true })
  try {
    let mismatch = false
    try {
      await new PipeProviderControl(s4, { timeoutMs: 500 }).request('ping')
    } catch (error) {
      mismatch = error instanceof ProviderTransportError && error.message.includes('id mismatch')
    }
    check('回复 id 不一致 → 拒绝（不猜）', mismatch)
  } finally {
    await wrongId.close()
    removeSocket(s4)
  }

  section('3. supervisor.up()：完整拉起 + 幂等 + down')
  const s5 = socketPath('up')
  removeSocket(s5)
  const provider = await startFakeProvider(s5)
  const driver = new FakeDriverPort()
  const runtime = makeRuntime(driver, { providerSocket: s5 })
  const control = new PipeProviderControl(s5, { timeoutMs: 1000 })
  const supervisor = makeSupervisor(runtime, control)
  try {
    const state = await supervisor.up()
    eq('phase=up', state.phase, 'up')
    check('domain id 非空', typeof state.domainId === 'string' && state.domainId.length > 0, state.domainId)
    eq('policy generation=1', state.policyGeneration, 1)
    eq('未由 supervisor spawn', state.providerSpawned, false)
    eq('驱动域已注册', (await driver.queryStats()).domains, 1)
    eq('驱动策略 generation', (await driver.queryStats()).policyGeneration, 1)
    const payload = driver.policyPayload
    check('下发的 payload 是二进制策略', payload !== undefined && payload.length > 8)
    eq('payload magic', new DataView(payload!.buffer, payload!.byteOffset, 4).getUint32(0, true), POLICY_MAGIC)
    const status = supervisor.status()
    eq('探测到 kernel 档', status?.enforcement, 'kernel-projfs-minifilter')
    eq('网络标记为按子进程安装', status?.network.perChild, true)
    check('supervisor 判定就绪', status !== undefined && status.notes.some((note) => note.includes('per child')), status?.notes.join(' | '))
    check('op 顺序包含 start→protect', provider.ops.indexOf('start') >= 0 && provider.ops.indexOf('protect') > provider.ops.indexOf('start'), provider.ops.join(','))
    const again = await supervisor.up()
    eq('up 幂等', again.policyGeneration, 1)
    eq('未重复 start', provider.ops.filter((op) => op === 'start').length, 1)

    await supervisor.down()
    eq('down 后 phase=down', supervisor.state().phase, 'down')
    eq('域已注销', (await driver.queryStats()).domains, 0)
    check('调用了 stop/shutdown', provider.ops.includes('stop') && provider.ops.includes('shutdown'), provider.ops.join(','))
    await supervisor.down()
  } finally {
    await provider.close()
    removeSocket(s5)
  }

  section('4. 失败前置条件：无驱动 / 无 ProjFS / ABI / 策略')
  const s6 = socketPath('fail-pre')
  removeSocket(s6)
  const provider6 = await startFakeProvider(s6)
  try {
    const noDriver = makeSupervisor(makeRuntime(new FakeDriverPort(), { run: runs, providerSocket: s6 }), new PipeProviderControl(s6))
    await rejectsCode('无驱动 → NT_DRIVER_UNAVAILABLE', () => noDriver.up(), 'NT_DRIVER_UNAVAILABLE')
    check('未启动 provider（只有只读 stats 探测）', !provider6.ops.includes('start') && !provider6.ops.includes('protect'), provider6.ops.join(','))

    const noProjfs = makeSupervisor(
      makeRuntime(new FakeDriverPort(), {
        providerSocket: s6,
        run: async (command) => {
          if (command.includes('Client-ProjFS')) return 'Disabled\n'
          return goodRun(command)
        },
      }),
      new PipeProviderControl(s6),
    )
    await rejectsCode('ProjFS 未启用 → NT_PROJFS_NOT_ENABLED', () => noProjfs.up(), 'NT_PROJFS_NOT_ENABLED')
    check('仍未启动 provider', !provider6.ops.includes('start') && !provider6.ops.includes('protect'), provider6.ops.join(','))

    const abi = makeRuntime(new FakeDriverPort({ hello: { abiVersion: 1 } }), { providerSocket: s6 })
    await rejectsCode('ABI 不匹配 → NT_DRIVER_VERSION_MISMATCH', () => makeSupervisor(abi, new PipeProviderControl(s6)).up(), 'NT_DRIVER_VERSION_MISMATCH')
    check('ABI 失败未启动 provider', !provider6.ops.includes('start') && !provider6.ops.includes('protect'), provider6.ops.join(','))

    const overlap = makeRuntime(new FakeDriverPort(), { providerSocket: s6, viewRoot: 'C:\\work\\proj\\view' })
    await rejectsCode('视图根重叠 → NT_POLICY_INVALID', () => makeSupervisor(overlap, new PipeProviderControl(s6)).up(), 'NT_POLICY_INVALID')
    check('策略失败未启动 provider', !provider6.ops.includes('start') && !provider6.ops.includes('protect'), provider6.ops.join(','))
  } finally {
    await provider6.close()
    removeSocket(s6)
  }

  section('5. provider start 失败 → 回滚')
  const s7 = socketPath('fail-start')
  removeSocket(s7)
  const provider7 = await startFakeProvider(s7, { failStart: true })
  const driver7 = new FakeDriverPort()
  const supervisor7 = makeSupervisor(makeRuntime(driver7, { providerSocket: s7 }), new PipeProviderControl(s7))
  try {
    await rejectsCode('start 失败 → NT_PROJFS_PROVIDER_DOWN', () => supervisor7.up(), 'NT_PROJFS_PROVIDER_DOWN')
    eq('回滚后阶段', supervisor7.state().phase, 'failed')
    eq('回滚后域为 0', (await driver7.queryStats()).domains, 0)
    eq('回滚后策略 generation 未推进', (await driver7.queryStats()).policyGeneration, 0)
    check('尝试过 stop/shutdown', provider7.ops.includes('stop') && provider7.ops.includes('shutdown'), provider7.ops.join(','))
    await supervisor7.down()
    eq('显式 down 清掉 failed', supervisor7.state().phase, 'down')
  } finally {
    await provider7.close()
    removeSocket(s7)
  }

  section('6. 自 spawn provider（注入启动器）')
  const s8 = socketPath('spawn')
  removeSocket(s8)
  const provider8 = await startFakeProvider(s8)
  const driver8 = new FakeDriverPort()
  const runtime8 = makeRuntime(driver8, { providerSocket: s8 })
  const spawned: Array<{ file: string; args: string[]; log: string }> = []
  let killed = false
  const supervisor8 = new NtSupervisor({
    runtime: runtime8,
    socketPath: s8,
    providerPath: 'C:\\dshnt\\dshnt-provider.exe',
    providerLog: 'C:\\dshnt\\store\\provider.log',
    startProvider: async (input) => {
      spawned.push(input)
      return {
        pid: 4321,
        kill: () => {
          killed = true
        },
      }
    },
    sleep: async () => {},
    makeDir: () => {},
    pingAttempts: 3,
    pingIntervalMs: 1,
    timeoutMs: 500,
  })
  try {
    const state = await supervisor8.up()
    eq('spawn 标记', state.providerSpawned, true)
    eq('provider pid', state.providerPid, 4321)
    eq('启动参数含 --pipe', spawned[0]?.args.slice(0, 2), ['--pipe', DEFAULT_PROVIDER_PIPE])
    eq('启动文件', spawned[0]?.file, 'C:\\dshnt\\dshnt-provider.exe')
    eq('启动参数含 --log', spawned[0]?.args[2], '--log')
    await supervisor8.down()
    check('down 杀掉自启动的 provider', killed)
  } finally {
    await provider8.close()
    removeSocket(s8)
  }

  section('7. 命令面 up/down 与错误语义')
  const s9 = socketPath('cmd')
  removeSocket(s9)
  const provider9 = await startFakeProvider(s9)
  const driver9 = new FakeDriverPort()
  const supervisor9 = makeSupervisor(makeRuntime(driver9, { providerSocket: s9 }), new PipeProviderControl(s9))
  try {
    const { runNtCommand } = await import('../../dsh-plugin/nt-command.ts')
    const deps = {
      runtime: async () => makeRuntime(driver9, { providerSocket: s9 }),
      supervisor: async () => supervisor9,
    }
    const up = await runNtCommand('up', deps)
    eq('up 成功', up.kind, 'success')
    includes('up 输出 domain', up.text, 'NT 数据面已拉起')
    includes('up 输出 kernel 档', up.text, 'kernel-projfs-minifilter')
    const down = await runNtCommand('down', deps)
    eq('down 成功', down.kind, 'success')
    includes('down 说明未写工作区', down.text, '真实工作区未被改动')
    const noSupervisor = await runNtCommand('up', { runtime: async () => makeRuntime(driver9, { providerSocket: s9 }) })
    eq('缺少 supervisor → error', noSupervisor.kind, 'error')

    const broken = await runNtCommand('up', {
      runtime: async () => makeRuntime(driver9, { providerSocket: s9 }),
      supervisor: async () => {
        throw new NtError('NT_CAPABILITY_MISSING', { reason: 'synthetic' })
      },
    })
    eq('提升失败 → error', broken.kind, 'error')
    includes('失败文案不冒充“未执行副作用”', broken.text, '已尝试回滚并清理')
  } finally {
    await provider9.close()
    removeSocket(s9)
  }
})
