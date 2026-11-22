/**
 * `src/nt/session.ts` 单测：策略下发/域注册/launcher 包装/幂等清理。
 *
 * @module winstage-sandbox/tests/nt/session
 */

import { FakeDriverPort } from '../../src/nt/driver.ts'
import { defaultRulesForDomain } from '../../src/nt/policy.ts'
import { NtSession } from '../../src/nt/session.ts'
import { createNtStatus } from '../../src/nt/status.ts'
import { defaultJobLimits, type NtDomain, type NtPolicySet } from '../../src/nt/types.ts'
import { check, eq, rejectsCode, runSuite, section } from './harness.ts'

const WORKSPACE = 'C:\\work\\proj'
const VIEW = 'D:\\dshnt\\view\\s1'
const STORE = 'D:\\dshnt\\store\\s1'

function domain(overrides: Partial<NtDomain> = {}): NtDomain {
  return {
    id: 'sess-1',
    label: 'dsh.ai.sess-1',
    workspaceRoot: WORKSPACE,
    viewRoot: VIEW,
    storeRoot: STORE,
    tokenMode: 'appcontainer',
    appContainerSid: 'S-1-15-2-1-2-3-4',
    job: defaultJobLimits(),
    network: { mode: 'offline', allow: [] },
    defaultRead: 'deny',
    rules: defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
    ...overrides,
  }
}

function policy(d: NtDomain = domain()): NtPolicySet {
  return {
    version: 1,
    generation: 5,
    createdAt: '2026-01-01T00:00:00.000Z',
    globalMasks: [],
    domains: [d],
  }
}

function status() {
  return createNtStatus({
    enforcement: 'kernel-projfs-minifilter',
    driver: { loaded: true, abiVersion: 1, version: '0.1.0' },
    projfs: { enabled: true, providerRunning: true, viewRoot: VIEW },
    policy: { valid: true, generation: 5, hash: 'a'.repeat(64) },
    domains: 1,
    network: { mode: 'offline', enforced: true },
    apply: { helperReady: true },
  })
}

await runSuite('nt-session', async () => {
  section('1. 正常 init')
  const driver = new FakeDriverPort()
  const session = new NtSession({
    domain: domain(),
    policy: policy(),
    driver,
    status: status(),
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
  })
  const report = await session.init()
  eq('domain id', report.domainId, 'sess-1')
  eq('policy generation', report.policyGeneration, 5)
  eq('driver generation', report.driverGeneration, 5)
  eq('policy hash 长度', report.policyHash.length, 64)
  eq('域已注册', (await driver.queryStats()).domains, 1)
  const report2 = await session.init()
  eq('init 幂等', report2.driverGeneration, 5)

  section('2. confine')
  const confined = session.confine(['C:\\Windows\\System32\\cmd.exe', '/c', 'echo hi'], { env: { PATH: 'C:\\Windows' } })
  eq('enforcement', confined.enforcement, 'full')
  check('argv 首个是 launcher', confined.argv[0] === 'c:\\dshnt\\bin\\dshnt-launch.exe')
  const separator = confined.argv.indexOf('--')
  check('-- 之后是目标 argv', separator > 0 && confined.argv[separator + 1] === 'C:\\Windows\\System32\\cmd.exe')
  check('含 --domain', confined.argv[confined.argv.indexOf('--domain') + 1] === 'sess-1')
  await rejectsCode('凭据环境拒绝', () => Promise.resolve(session.confine(['cmd.exe'], { env: { GITHUB_TOKEN: 'x' } })), 'NT_ENV_REJECTED')
  await rejectsCode(
    'cwd 越界拒绝',
    () => Promise.resolve(session.confine(['cmd.exe'], { cwd: 'C:\\other' })),
    'NT_PATH_ESCAPE',
  )

  section('3. 策略判定')
  eq('工作区写 stage', session.decide('C:\\work\\proj\\a.ts', 'write').action, 'stage')
  eq('view 直接读 deny', session.decide('D:\\dshnt\\view\\s1\\a.ts', 'read').action, 'deny')

  section('4. 清理')
  await session.dispose()
  eq('注销后域计数', (await driver.queryStats()).domains, 0)
  await session.dispose()
  check('dispose 幂等不抛', true)
  await rejectsCode('dispose 后 confine 拒绝', () => Promise.resolve(session.confine(['cmd.exe'])), 'NT_DOMAIN_NOT_REGISTERED')

  section('5. 失败关闭')
  const badAbi = new FakeDriverPort({ hello: { abiVersion: 999 } })
  const badAbiSession = new NtSession({
    domain: domain(),
    policy: policy(),
    driver: badAbi,
    status: status(),
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
  })
  await rejectsCode('ABI 不匹配', () => badAbiSession.init(), 'NT_DRIVER_VERSION_MISMATCH')

  const notReady = new NtSession({
    domain: domain(),
    policy: policy(),
    driver: new FakeDriverPort(),
    status: createNtStatus(),
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
  })
  await rejectsCode('状态未就绪', () => notReady.init(), 'NT_DRIVER_UNAVAILABLE')

  const missingDomain = new NtSession({
    domain: domain({ id: 'other' }),
    policy: policy(),
    driver: new FakeDriverPort(),
    status: status(),
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
  })
  await rejectsCode('策略中缺域', () => missingDomain.init(), 'NT_POLICY_INVALID')

  let live = status()
  const liveSession = new NtSession({
    domain: domain(),
    policy: policy(),
    driver: new FakeDriverPort(),
    status: () => live,
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
  })
  await liveSession.init()
  live = createNtStatus()
  await rejectsCode(
    'init 后驱动卸载 → confine 仍 fail-closed',
    () => Promise.resolve(liveSession.confine(['cmd.exe'])),
    'NT_DRIVER_UNAVAILABLE',
  )
})
