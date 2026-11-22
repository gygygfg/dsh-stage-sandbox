/**
 * `src/nt/runtime.ts` + `dsh-plugin/nt-command.ts` 单测。
 *
 * 全部离线：假驱动端口、注入的命令输出、临时 Unix socket 冒充 provider 管道。
 * 不加载驱动、不启 ProjFS、不读真实工作区。
 *
 * @module winstage-sandbox/tests/nt/runtime
 */

import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { FakeDriverPort, UnavailableDriverPort } from '../../src/nt/driver.ts'
import { registerCommands } from '../../dsh-plugin/host-plugin.ts'
import { runNtCommand, NT_USAGE } from '../../dsh-plugin/nt-command.ts'
import {
  createNtRuntime,
  createWindowsCommandRunner,
  defaultNtLayout,
  providerSocketPath,
  queryProviderStats,
  renderNtDoctor,
  renderNtStatus,
  NtRuntime,
} from '../../src/nt/runtime.ts'
import { assessNtStatus } from '../../src/nt/status-probe.ts'
import { check, eq, includes, runSuite, section } from './harness.ts'

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

/** 起一个只回答一行 JSON 的假 provider 管道（Linux 上用 Unix socket）。 */
async function startFakeProvider(socketPath: string, reply: string): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (!buffer.includes('\n')) return
      socket.write(`${reply}\n`)
      buffer = ''
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return server
}

function removeSocket(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // 不存在即可
  }
}

const SOCKET = join(tmpdir(), `dshnt-provider-test-${process.pid}.sock`)

await runSuite('nt-runtime', async () => {
  section('1. 默认布局（视图/store 必须是工作区的兄弟目录）')
  const layout = defaultNtLayout(WORKSPACE, {})
  eq('view 根', layout.viewRoot, 'C:\\work\\.proj.dshnt\\view')
  eq('store 根', layout.storeRoot, 'C:\\work\\.proj.dshnt\\store')
  check('launcher 指向包内 native/launcher/out', layout.launcherPath.replace(/\\/g, '/').includes('/native/launcher/out/dshnt-launch.exe'), layout.launcherPath)
  const overridden = defaultNtLayout(WORKSPACE, {
    WINSTAGE_NT_ROOT: 'D:\\nt',
    WINSTAGE_NT_VIEW_ROOT: 'D:\\v',
    WINSTAGE_NT_STORE_ROOT: 'D:\\s',
    WINSTAGE_NT_LAUNCHER: 'D:\\l.exe',
  })
  eq('ROOT 覆盖', [overridden.viewRoot, overridden.storeRoot], ['D:\\v', 'D:\\s'])
  eq('launcher 覆盖', overridden.launcherPath, 'D:\\l.exe')

  section('2. 管道路径与命令执行器')
  eq('Windows 命名管道', providerSocketPath('p1', 'win32'), '\\\\.\\pipe\\p1')
  eq('非 Windows 不给路径', providerSocketPath('p1', 'linux'), undefined)
  let rejected = false
  try {
    await createWindowsCommandRunner('linux')('fltmc filters')
  } catch {
    rejected = true
  }
  check('非 Windows 上命令执行器拒绝（事实=unknown）', rejected)

  section('3. provider 管道探测（真实 socket）')
  removeSocket(SOCKET)
  const providerReply = JSON.stringify({ id: 1, ok: true, stats: { views: [{ view: VIEW }] } })
  const server = await startFakeProvider(SOCKET, providerReply)
  try {
    const alive = await queryProviderStats(SOCKET, 3000)
    eq('连上即存活', alive.alive, true)
    eq('取到视图根', alive.views, [VIEW])
  } finally {
    server.close()
  }
  const missing = await queryProviderStats(join(tmpdir(), `dshnt-missing-${process.pid}.sock`), 500)
  eq('管道不存在 → 不存活且不抛', missing.alive, false)
  check('给出原因', typeof missing.error === 'string' && missing.error.length > 0, missing.error)

  section('4. probe：全部事实为正 → 内核档')
  removeSocket(SOCKET)
  const server2 = await startFakeProvider(SOCKET, providerReply)
  const driver = new FakeDriverPort()
  await driver.setPolicy(new TextEncoder().encode('{}'), 'a'.repeat(64), 1)
  const runtime = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: VIEW,
      storeRoot: STORE,
      launcherPath: 'C:\\dshnt\\dshnt-launch.exe',
      driver,
      run: goodRun,
      providerSocket: SOCKET,
      policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
      network: { mode: 'offline', enforced: true },
      applyReady: true,
    },
    driver,
  )
  try {
    const status = await runtime.probe()
    eq('enforcement', status.enforcement, 'kernel-projfs-minifilter')
    eq('写屏障', status.writeBarrier, 'kernel-projfs-minifilter')
    eq('驱动 altitude', status.driver.altitude, '371100')
    eq('provider 视图', status.projfs.viewRoot, VIEW)
    eq('策略 generation', status.policy.generation, 1)
    eq('网络 enforced', status.network.enforced, true)
    eq('域数', status.domains, 1)

    const report = await runtime.doctor()
    eq('能力诊断通过', report.ok, true)
    eq('沙箱就绪', report.ready, true)
    eq('无失败项', report.checks.filter((item) => item.status === 'fail').length, 0)
    check('ABI 检查可见', report.checks.some((item) => item.id === 'driver-abi' && item.status === 'ok'))
    check('策略已下发为 ok', report.checks.some((item) => item.id === 'policy-applied' && item.status === 'ok'))
    includes('诊断文本含结论', renderNtDoctor(report), '沙箱就绪: 是')
    includes('状态文本含档位', renderNtStatus(status), 'kernel-projfs-minifilter')
  } finally {
    server2.close()
  }

  section('5. probe/doctor：驱动不可用 → fail-closed')
  const broken = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: VIEW,
      storeRoot: STORE,
      launcherPath: 'C:\\dshnt\\dshnt-launch.exe',
      driver: new UnavailableDriverPort('no driver in test'),
      run: async () => {
        throw new Error('fltmc unavailable')
      },
      network: { mode: 'offline', enforced: false },
    },
    new UnavailableDriverPort('no driver in test'),
  )
  const brokenStatus = await broken.probe()
  eq('不可用档', brokenStatus.enforcement, 'unavailable')
  check('写屏障不是内核', brokenStatus.writeBarrier !== 'kernel-projfs-minifilter', brokenStatus.writeBarrier)
  const brokenReport = await broken.doctor()
  eq('诊断不通过', brokenReport.ok, false)
  check('驱动端口项失败', brokenReport.checks.some((item) => item.id === 'driver-port' && item.status === 'fail'))
  includes('失败有修复动作', renderNtDoctor(brokenReport), '→')

  section('6. doctor：ABI 不匹配必须红')
  const abiDriver = new FakeDriverPort({ hello: { abiVersion: 1 } })
  const abiRuntime = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: VIEW,
      storeRoot: STORE,
      launcherPath: 'x',
      driver: abiDriver,
      run: goodRun,
      providerSocket: join(tmpdir(), `dshnt-none-${process.pid}.sock`),
    },
    abiDriver,
  )
  const abiReport = await abiRuntime.doctor()
  check('ABI 项红', abiReport.checks.some((item) => item.id === 'driver-abi' && item.status === 'fail'))
  eq('整体不通过', abiReport.ok, false)
  check('未声明 ready', !abiReport.ready, String(abiReport.ready))

  section('7. 策略校验：重叠根 / appcontainer 缺 SID 必须红')
  const overlap = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: 'C:\\work\\proj\\view',
      storeRoot: STORE,
      launcherPath: 'x',
      driver: new FakeDriverPort(),
      run: goodRun,
    },
    new FakeDriverPort(),
  )
  const overlapReport = await overlap.doctor()
  check('重叠视图根被判非法', overlapReport.checks.some((item) => item.id === 'policy-compile' && item.status === 'fail'))
  const noSid = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: VIEW,
      storeRoot: STORE,
      launcherPath: 'x',
      driver: new FakeDriverPort(),
      run: goodRun,
      tokenMode: 'appcontainer',
    },
    new FakeDriverPort(),
  )
  const noSidReport = await noSid.doctor()
  check('appcontainer 缺 SID 被判非法', noSidReport.checks.some((item) => item.id === 'policy-compile' && item.status === 'fail'))
  const withSid = new NtRuntime(
    {
      workspaceRoot: WORKSPACE,
      viewRoot: VIEW,
      storeRoot: STORE,
      launcherPath: 'x',
      driver: new FakeDriverPort(),
      run: goodRun,
      tokenMode: 'appcontainer',
      appContainerSid: 'S-1-15-2-1-2-3-4-5-6-7-8',
    },
    new FakeDriverPort(),
  )
  const withSidReport = await withSid.doctor()
  check('appcontainer 有 SID 时策略可编译', !withSidReport.checks.some((item) => item.id === 'policy-compile' && item.status === 'fail'))

  section('8. /winstage nt 命令面')
  const statusRuntime = {
    probe: async () => assessNtStatus({ notes: ['probed'] }),
    doctor: async () => ({
      ok: false,
      ready: false,
      checks: [{ id: 'x', title: '驱动未加载', status: 'fail' as const, fix: '装驱动' }],
      status: assessNtStatus({}),
      summary: '诊断未通过',
    }),
  }
  const deps = { runtime: async () => statusRuntime as unknown as NtRuntime }
  const statusResult = await runNtCommand('status', deps)
  eq('status 成功', statusResult.kind, 'success')
  includes('status 输出含未就绪结论', statusResult.text, '未就绪')
  eq('默认子命令=status', (await runNtCommand(undefined, deps)).kind, 'success')
  const doctorResult = await runNtCommand('doctor', deps)
  eq('doctor 成功', doctorResult.kind, 'success')
  includes('doctor 输出含修复动作', doctorResult.text, '装驱动')
  const help = await runNtCommand('help', deps)
  eq('help 文案', help.text, NT_USAGE)
  eq('未知子命令报错', (await runNtCommand('nope', deps)).kind, 'error')
  const failing = await runNtCommand('status', {
    runtime: async () => {
      throw new Error('boom')
    },
  })
  eq('装配失败 → error', failing.kind, 'error')
  includes('错误不冒充执行过', failing.text, '本次没有执行任何沙箱操作')

  section('9. createNtRuntime 默认端口 fail-closed')
  const auto = await createNtRuntime({
    workspaceRoot: WORKSPACE,
    viewRoot: VIEW,
    storeRoot: STORE,
    launcherPath: 'x',
    run: goodRun,
    providerSocket: join(tmpdir(), `dshnt-none2-${process.pid}.sock`),
  })
  const autoStatus = await auto.probe()
  check('默认端口不会假装可用', autoStatus.enforcement !== 'kernel-projfs-minifilter', autoStatus.enforcement)
  await auto.dispose()

  section('10. 插件命令注册（/winstage nt 真的接上了）')
  const registered: Array<{ name: string; handler: (invocation: { rawInput?: string }) => unknown }> = []
  const scope = {
    commands: {
      register(definition: { name: string; handler: (invocation: { rawInput?: string }) => unknown }) {
        registered.push(definition)
        return () => {}
      },
    },
    effect: (fn: () => unknown) => fn(),
  }
  const log = { info() {}, warn() {} }
  registerCommands(scope as never, {} as never, log as never, {
    isEnabled: () => true,
    ntRuntime: deps.runtime,
  } as never)
  const ntDefinition = registered.find((item) => item.name === 'winstage-nt')
  const umbrella = registered.find((item) => item.name === 'winstage')
  check('注册了 winstage-nt', ntDefinition !== undefined, registered.map((item) => item.name).join(','))
  check('注册了伞形 winstage', umbrella !== undefined)
  const direct = (await ntDefinition?.handler({ rawInput: 'doctor' })) as { kind: string; text: string }
  eq('winstage-nt doctor 成功', direct.kind, 'success')
  includes('winstage-nt 输出来自诊断', direct.text, '装驱动')
  const viaUmbrella = (await umbrella?.handler({ rawInput: 'nt status' })) as { kind: string; text: string }
  eq('伞形 /winstage nt status 成功', viaUmbrella.kind, 'success')
  includes('伞形输出含未就绪结论', viaUmbrella.text, '未就绪')

  const bare: Array<{ name: string; handler: (invocation: { rawInput?: string }) => unknown }> = []
  const bareScope = {
    commands: {
      register(definition: { name: string; handler: (invocation: { rawInput?: string }) => unknown }) {
        bare.push(definition)
        return () => {}
      },
    },
    effect: (fn: () => unknown) => fn(),
  }
  registerCommands(bareScope as never, {} as never, log as never, { isEnabled: () => true } as never)
  const bareNt = bare.find((item) => item.name === 'winstage-nt')
  const noRuntime = (await bareNt?.handler({ rawInput: 'status' })) as { kind: string; text: string }
  eq('缺少运行时接线时明确报错（不静默）', noRuntime.kind, 'error')

  removeSocket(SOCKET)
})
