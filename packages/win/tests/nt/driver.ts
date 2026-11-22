/**
 * `src/nt/driver.ts` 单测：假端口契约、fail-closed、事件订阅。
 *
 * @module winstage-sandbox/tests/nt/driver
 */

import {
  createDriverPort,
  FakeDriverPort,
  UnavailableDriverPort,
} from '../../src/nt/driver.ts'
import { NT_DRIVER_ABI_VERSION, type NtDriverEvent } from '../../src/nt/types.ts'
import { check, eq, rejectsCode, runSuite, section } from './harness.ts'

await runSuite('nt-driver', async () => {
  section('1. 握手')
  const fake = new FakeDriverPort()
  const hello = await fake.hello()
  eq('ABI 版本', hello.abiVersion, NT_DRIVER_ABI_VERSION)
  check('声明能力', hello.supports.includes('policy') && hello.supports.includes('apply'), hello.supports.join(','))

  section('2. 策略下发')
  const payload = new TextEncoder().encode('{"x":1}')
  const hash = 'a'.repeat(64)
  const first = await fake.setPolicy(payload, hash, 1)
  eq('generation 由控制面指定', first.generation, 1)
  eq('策略哈希可回读', fake.policyHash, hash)
  eq('策略 payload 可回读', fake.policyPayload?.length, payload.length)
  const second = await fake.setPolicy(payload, hash, 2)
  eq('再次下发 generation 递增', second.generation, 2)
  const idempotent = await fake.setPolicy(payload, hash, 2)
  eq('同 generation 幂等', idempotent.generation, 2)
  await rejectsCode('更小 generation 拒绝', () => fake.setPolicy(payload, hash, 1), 'NT_POLICY_GENERATION_MISMATCH')
  await rejectsCode('空 payload 拒绝', () => fake.setPolicy(new Uint8Array(0), hash, 3), 'NT_POLICY_INVALID')
  await rejectsCode('非法哈希拒绝', () => fake.setPolicy(payload, 'not-a-hash', 3), 'NT_POLICY_INVALID')
  await rejectsCode('非法 generation 拒绝', () => fake.setPolicy(payload, hash, 0), 'NT_POLICY_INVALID')

  section('3. 域注册')
  await fake.registerDomain({ id: 'd1', viewRoot: 'D:\\dshnt\\view\\s1', workspaceRoot: 'C:\\ws', storeRoot: 'D:\\store' })
  eq('域计数', (await fake.queryStats()).domains, 1)
  await fake.registerDomain({ id: 'd1', viewRoot: 'D:\\dshnt\\view\\s1', workspaceRoot: 'C:\\ws', storeRoot: 'D:\\store' })
  eq('同 id + 同根幂等（adopt 会重复注册）', (await fake.queryStats()).domains, 1)
  await rejectsCode(
    '同 id + 不同根拒绝',
    () => fake.registerDomain({ id: 'd1', viewRoot: 'D:\\dshnt\\view\\s2', workspaceRoot: 'C:\\ws', storeRoot: 'D:\\store' }),
    'NT_DOMAIN_DUPLICATE',
  )
  await rejectsCode('空 viewRoot 拒绝', () => fake.registerDomain({ id: 'd2', viewRoot: '' }), 'NT_VIEW_ROOT_INVALID')
  await fake.unregisterDomain('d1')
  eq('注销后域计数', (await fake.queryStats()).domains, 0)
  await rejectsCode('注销未知域拒绝', () => fake.unregisterDomain('nope'), 'NT_DOMAIN_NOT_REGISTERED')

  section('4. apply 授权')
  await fake.grantApply({ pid: 1234, imageHash: 'b'.repeat(64), paths: ['C:\\work\\proj\\a.txt'] })
  await fake.revokeApply(1234)
  await rejectsCode('非法 PID 拒绝', () => fake.grantApply({ pid: 0, imageHash: 'b'.repeat(64), paths: ['C:\\a'] }), 'NT_APPLY_DENIED')
  await rejectsCode('非法 imageHash 拒绝', () => fake.grantApply({ pid: 1, imageHash: 'nope', paths: ['C:\\a'] }), 'NT_APPLY_DENIED')
  await rejectsCode('空 paths 拒绝', () => fake.grantApply({ pid: 1, imageHash: 'b'.repeat(64), paths: [] }), 'NT_APPLY_DENIED')

  section('5. 事件订阅/退订')
  const events: NtDriverEvent[] = []
  const unsubscribe = fake.onEvent((event) => events.push(event))
  fake.emit({ type: 'deny', at: new Date().toISOString(), domainId: 'd1', path: 'C:\\x', access: 'write', action: 'deny' })
  eq('收到事件', events.length, 1)
  unsubscribe()
  fake.emit({ type: 'deny', at: new Date().toISOString(), domainId: 'd1', path: 'C:\\y', access: 'write', action: 'deny' })
  eq('退订后不再收到', events.length, 1)

  section('6. 真实驱动未实现时必须 fail-closed')
  const unavailable = new UnavailableDriverPort('test')
  await rejectsCode('hello 失败', () => unavailable.hello(), 'NT_DRIVER_UNAVAILABLE')
  await rejectsCode('setPolicy 失败', () => unavailable.setPolicy(new Uint8Array([1]), 'a'.repeat(64), 1), 'NT_DRIVER_UNAVAILABLE')
  await rejectsCode('registerDomain 失败', () => unavailable.registerDomain({ id: 'x', viewRoot: 'C:\\v' }), 'NT_DRIVER_UNAVAILABLE')
  const noop = unavailable.onEvent()
  check('onEvent 返回 noop 退订函数', typeof noop === 'function')
  check('createDriverPort(fake) 返回假端口', createDriverPort({ fake: true }) instanceof FakeDriverPort)
  check('默认 createDriverPort 不可用', createDriverPort({ port: undefined }) instanceof UnavailableDriverPort)
})
