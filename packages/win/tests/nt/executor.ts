/**
 * `src/nt/executor.ts` + `src/nt/provider.ts` 单测：K0 执行链、状态门禁、
 * 失败分类、环境白名单、域生命周期。
 *
 * @module winstage-sandbox/tests/nt/executor
 */

import { createNtStatus } from '../../src/nt/status.ts'
import { FakeDriverPort } from '../../src/nt/driver.ts'
import { NtSandboxProvider, buildDomainPolicy, createNtProvider } from '../../src/nt/provider.ts'
import { classifyExit } from '../../src/nt/executor.ts'
import type { NtSpawnResult } from '../../src/nt/executor.ts'
import type { NtStatus } from '../../src/nt/types.ts'
import { check, eq, rejectsCode, runSuite, section } from './harness.ts'

const LAUNCHER = 'C:\\dshnt\\bin\\dshnt-launch.exe'

function readyStatus(overrides: Partial<NtStatus> = {}): NtStatus {
  return createNtStatus({
    enforcement: 'kernel-projfs-minifilter',
    driver: { loaded: true, abiVersion: 2, altitude: '371100' },
    projfs: { enabled: true, providerRunning: true },
    policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    apply: { helperReady: true },
    ...overrides,
  })
}

function providerOptions(status: NtStatus | (() => NtStatus)) {
  return {
    workspaceRoot: 'C:\\work\\proj',
    viewRoot: 'C:\\dshnt\\view\\s1',
    storeRoot: 'C:\\dshnt\\store\\s1',
    launcherPath: LAUNCHER,
    driver: new FakeDriverPort(),
    status,
    domainId: 'sess-1',
  }
}

await runSuite('nt-executor', async () => {
  section('1. 域/策略构造')
  const built = buildDomainPolicy({
    workspaceRoot: 'C:\\work\\proj',
    viewRoot: 'C:\\dshnt\\view\\s1',
    storeRoot: 'C:\\dshnt\\store\\s1',
    domainId: 'd1',
  })
  eq('域 id', built.domain.id, 'd1')
  eq('默认网络 offline', built.domain.network.mode, 'offline')
  eq('默认令牌 restricted', built.domain.tokenMode, 'restricted')
  check('默认规则包含工作区 stage', built.domain.rules.some((rule) => rule.action === 'stage'), `${built.domain.rules.length} rules`)
  check('默认规则包含 store 拒绝', built.domain.rules.some((rule) => rule.type === 'store'), built.domain.rules.map((r) => r.type).join(','))

  section('2. 不可用时 fail-closed')
  await rejectsCode(
    '非 kernel 状态 → createNtProvider 拒绝',
    async () => createNtProvider(providerOptions(createNtStatus({ enforcement: 'legacy' }))),
    'NT_CAPABILITY_MISSING',
  )

  const unavailable = new NtSandboxProvider(providerOptions(createNtStatus({ enforcement: 'unavailable' })))
  let spawnCalls = 0
  let initCode = ''
  try {
    await unavailable.init()
  } catch (error) {
    initCode = (error as { code?: string }).code ?? ''
  }
  eq('unavailable 时 init 抛 NT_DRIVER_UNAVAILABLE', initCode, 'NT_DRIVER_UNAVAILABLE')
  await rejectsCode(
    'unavailable 时 run 不起进程',
    async () => {
      const executor = unavailable.executorFor(async () => {
        spawnCalls += 1
        return { code: 0, stdout: '', stderr: '' }
      })
      return executor.run(['cmd', '/c', 'echo', 'hi'])
    },
    'NT_DRIVER_UNAVAILABLE',
  )
  eq('spawn 一次也没被调用', spawnCalls, 0)
  await unavailable.dispose()

  section('3. 就绪：策略下发 + 域注册 + argv')
  const driver = new FakeDriverPort()
  const provider = new NtSandboxProvider({
    ...providerOptions(() => status),
    driver,
  })
  let status = readyStatus()
  await provider.init()
  eq('策略已下发（哈希可回读）', driver.policyHash !== undefined, true)
  eq('域已注册（再注册会重复）', await driver.registerDomain({ id: 'sess-1', viewRoot: 'C:\\dshnt\\view\\s1' }).then(
    () => 'registered',
    (error: { code?: string }) => error.code ?? 'error',
  ), 'NT_DOMAIN_DUPLICATE')

  const argv = provider.confine(['cmd.exe', '/c', 'echo hi'])
  // 路径在控制面统一规范化（小写）——Windows 大小写不敏感，launcher 侧按原样可执行。
  eq('argv[0] 是 launcher（规范化后小写）', argv[0], LAUNCHER.toLowerCase())
  check('argv 含 --domain', argv.includes('--domain') && argv.includes('sess-1'))
  check('argv 含 --view', argv.includes('--view') && argv.includes('c:\\dshnt\\view\\s1'), argv.join(' '))
  eq('argv 末尾是目标 argv', argv.slice(argv.indexOf('--') + 1), ['cmd.exe', '/c', 'echo hi'])

  section('4. 执行与失败分类')
  const okRun = await provider.executorFor(async () => ({ code: 0, stdout: 'hello', stderr: '' })).run(['cmd.exe'])
  eq('成功退出码', okRun.code, 0)
  eq('enforcement 标注 full', okRun.enforcement, 'full')
  eq('无失败分类', okRun.failure, undefined)

  const deniedRun = await provider
    .executorFor(async () => ({ code: 1, stdout: '', stderr: 'Access is denied.' }))
    .run(['cmd.exe', '/c', 'type', 'C:\\work\\proj\\x'])
  eq('拒绝输出 → denied', deniedRun.failure?.kind, 'denied')
  eq('denied 的 executed 为 true（进程确实跑过）', deniedRun.failure?.executed, true)

  const failRun = await provider
    .executorFor(async () => ({ code: 9009, stdout: '', stderr: "'foo' is not recognized" }))
    .run(['foo'])
  eq('普通非零 → command-failed', failRun.failure?.kind, 'command-failed')
  eq('command-failed 的 code', failRun.failure?.code, 'EXIT_9009')

  const timedOut = await provider
    .executorFor(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }))
    .run(['ping', '-t', '127.0.0.1'])
  eq('超时 → command-failed + executed', `${timedOut.failure?.kind}:${timedOut.failure?.executed}`, 'command-failed:true')

  section('5. 输出截断')
  const big = 'x'.repeat(2048)
  const truncated = await provider
    .executorFor(async () => ({ code: 0, stdout: big, stderr: big }))
    .run(['cmd.exe'], {})
  eq('默认上限不截断 2KiB', truncated.truncated.stdout, false)
  const smallProvider = new NtSandboxProvider({ ...providerOptions(() => status), driver, domainId: 'sess-2' })
  await smallProvider.init()
  const small = await smallProvider
    .executorFor(async () => ({ code: 0, stdout: big, stderr: 'e' }), { maxOutputBytes: 8 })
    .run(['cmd.exe'])
  eq('显式上限生效', small.truncated.stdout, true)
  eq('截断后长度等于上限', Buffer.byteLength(small.stdout, 'utf8'), 8)

  section('6. 环境白名单')
  await rejectsCode(
    '凭据类环境变量 → NT_ENV_REJECTED',
    async () => {
      provider.confine(['cmd.exe'], { env: { GITHUB_TOKEN: 'x' } })
    },
    'NT_ENV_REJECTED',
  )
  const withEnv = provider.confine(['cmd.exe'], { env: { DSH_MODE: 'test', PATH: 'C:\\Windows\\System32' } })
  check('合法环境进入 argv', withEnv.includes('--env-allow') && withEnv.includes('DSH_MODE=test'))

  section('7. 运行中掉档 ⇒ 立即拒绝')
  status = createNtStatus({ enforcement: 'unavailable', driver: { loaded: false }, projfs: { enabled: true, providerRunning: true } })
  let droppedSpawn = 0
  await rejectsCode(
    '状态掉档后 run 拒绝',
    async () => {
      const executor = provider.executorFor(async () => {
        droppedSpawn += 1
        return { code: 0, stdout: '', stderr: '' }
      })
      return executor.run(['cmd.exe'])
    },
    'NT_DRIVER_UNAVAILABLE',
  )
  eq('掉档后没有启动进程', droppedSpawn, 0)

  section('8. dispose 幂等')
  await provider.dispose()
  await provider.dispose()
  eq('dispose 后域可重新注册', await driver
    .registerDomain({ id: 'sess-1', viewRoot: 'C:\\dshnt\\view\\s1' })
    .then(() => 'ok', () => 'fail'), 'ok')
  await smallProvider.dispose()

  section('9. classifyExit 纯函数')
  eq('denied 签名', classifyExit(1, '拒绝访问。', ['拒绝访问']).kind, 'denied')
  eq('0xC0000142 → env-fault', classifyExit(3221225794, 'The application was unable to start correctly (0xC0000142)', []).kind, 'env-fault')
  eq('null → SIGNAL', classifyExit(null, '', []).code, 'SIGNAL')
  eq('无签名 → command-failed', classifyExit(2, 'some error', ['Access is denied']).kind, 'command-failed')

  const emptySpawn: NtSpawnResult = { code: 0, stdout: '', stderr: '' }
  eq('伪造结果类型保持', emptySpawn.code, 0)
})
