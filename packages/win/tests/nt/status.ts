/**
 * `src/nt/status.ts` 单测：fail-closed、写入屏障、失败分类、状态卡。
 *
 * @module winstage-sandbox/tests/nt/status
 */

import {
  assertKernelReady,
  classifyNtFailure,
  createNtStatus,
  hasKernelWriteBarrier,
  isKernelReady,
  renderStatusCard,
  summarizeStatus,
  writeBarrierFor,
} from '../../src/nt/status.ts'
import { NT_DRIVER_ABI_VERSION, NtError, type NtStatus } from '../../src/nt/types.ts'
import { check, eq, runSuite, section, throwsCode } from './harness.ts'

function readyStatus(overrides: Partial<NtStatus> = {}): NtStatus {
  return createNtStatus({
    enforcement: 'kernel-projfs-minifilter',
    driver: { loaded: true, abiVersion: NT_DRIVER_ABI_VERSION, version: '0.1.0', altitude: '328000' },
    projfs: { enabled: true, providerRunning: true, viewRoot: 'D:\\dshnt\\view\\s1' },
    policy: { valid: true, generation: 3, hash: 'a'.repeat(64) },
    domains: 1,
    network: { mode: 'offline', enforced: true },
    apply: { helperReady: true },
    ...overrides,
  })
}

await runSuite('nt-status', async () => {
  section('1. 默认未就绪必须 fail-closed')
  const empty = createNtStatus()
  check('默认不可用', !isKernelReady(empty))
  eq('默认 enforcement', empty.enforcement, 'unavailable')
  eq('默认写屏障', writeBarrierFor(empty), 'none')
  eq('默认无内核屏障', hasKernelWriteBarrier(empty), false)
  throwsCode('默认 assert 失败', () => assertKernelReady(empty), 'NT_DRIVER_UNAVAILABLE')

  section('2. 全就绪')
  const ready = readyStatus()
  check('isKernelReady', isKernelReady(ready))
  eq('写屏障 = ProjFS+minifilter', writeBarrierFor(ready), 'kernel-projfs-minifilter')
  eq('有内核屏障', hasKernelWriteBarrier(ready), true)
  let threw = false
  try {
    assertKernelReady(ready)
  } catch {
    threw = true
  }
  check('assert 不抛', !threw)
  const card = renderStatusCard(ready)
  check('状态卡含写屏障', card.includes('kernel-projfs-minifilter'), card)
  check('状态卡含策略 generation', card.includes('generation=3'), card)
  check('一句话结论为已生效', summarizeStatus(ready).includes('已生效'), summarizeStatus(ready))

  section('3. 逐项缺失的机读码')
  throwsCode(
    'ProjFS 未启用',
    () => assertKernelReady(readyStatus({ projfs: { enabled: false, providerRunning: false } })),
    'NT_PROJFS_NOT_ENABLED',
  )
  throwsCode(
    'ProjFS provider 挂了',
    () => assertKernelReady(readyStatus({ projfs: { enabled: true, providerRunning: false } })),
    'NT_PROJFS_PROVIDER_DOWN',
  )
  throwsCode(
    '策略非法',
    () => assertKernelReady(readyStatus({ policy: { valid: false } })),
    'NT_POLICY_INVALID',
  )
  throwsCode(
    '网络未强制',
    () => assertKernelReady(readyStatus({ network: { mode: 'offline', enforced: false } })),
    'NT_NETWORK_UNENFORCED',
  )
  throwsCode(
    'apply helper 缺失',
    () => assertKernelReady(readyStatus({ apply: { helperReady: false } })),
    'NT_APPLY_HELPER_UNAVAILABLE',
  )
  throwsCode(
    '驱动 ABI 不匹配',
    () => assertKernelReady(readyStatus({ driver: { loaded: true, abiVersion: 999 } })),
    'NT_DRIVER_VERSION_MISMATCH',
  )
  let observedOk = true
  try {
    assertKernelReady(readyStatus({ network: { mode: 'observed', enforced: false } }))
  } catch {
    observedOk = false
  }
  check('observed 模式不要求 enforced', observedOk)

  section('4. legacy 档位的写屏障必须显式')
  const legacy = createNtStatus({ enforcement: 'legacy', writeBarrier: 'user-mode-shim' })
  eq('legacy 保留显式屏障', writeBarrierFor(legacy), 'user-mode-shim')
  eq('legacy 不是内核屏障', hasKernelWriteBarrier(legacy), false)
  const legacyKernel = createNtStatus({ enforcement: 'legacy', writeBarrier: 'kernel-restricted-token' })
  eq('legacy 可声明受限令牌屏障', writeBarrierFor(legacyKernel), 'kernel-restricted-token')
  eq('受限令牌算内核屏障', hasKernelWriteBarrier(legacyKernel), true)

  section('5. 失败分类')
  const denied = classifyNtFailure(new NtError('NT_ACCESS_DENIED', { path: 'C:\\x' }))
  eq('拒绝分类', [denied.kind, denied.code, denied.executed], ['denied', 'NT_ACCESS_DENIED', false])
  const env = classifyNtFailure(new NtError('NT_DRIVER_UNAVAILABLE'))
  eq('环境故障分类', [env.kind, env.executed], ['env-fault', false])
  const conflict = classifyNtFailure(new NtError('NT_APPLY_CONFLICT'))
  eq('发布冲突分类', [conflict.kind, conflict.executed], ['apply-conflict', false])
  const internal = classifyNtFailure(new NtError('NT_INTERNAL'))
  eq('内部错误分类', internal.kind, 'unknown')
  const plain = classifyNtFailure(new Error('boom'))
  eq('普通错误不猜执行状态', [plain.kind, plain.executed], ['unknown', undefined])
  check('普通错误保留消息', plain.message === 'boom')

  section('6. 未就绪总结点名缺失项')
  const missing = summarizeStatus(createNtStatus())
  check('总结点名驱动', missing.includes('驱动'), missing)
  check('总结点名 ProjFS', missing.includes('ProjFS'), missing)
  check('总结说 fail-closed', missing.includes('fail-closed'), missing)
})
