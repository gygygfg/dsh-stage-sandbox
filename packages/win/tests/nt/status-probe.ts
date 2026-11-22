/**
 * `src/nt/status-probe.ts` 单测：本地化输出解析、状态真值表、采集器降级。
 *
 * @module winstage-sandbox/tests/nt/status-probe
 */

import {
  assessNtStatus,
  collectNtFacts,
  parseFltmcFilters,
  parseFltmcInstances,
  parseProjfsFeature,
  parseProviderStats,
} from '../../src/nt/status-probe.ts'
import { check, eq, runSuite, section } from './harness.ts'

const FILTERS_EN = `
筛选器名称                      数字实例       高度          框架
------------------------------  -------------  ------------  -----
bindflt                                 1       409800         0
dshnt                                   1       371100         0
WdFilter                                4       328010         0
`

const FILTERS_MISSING = `
筛选器名称                      数字实例       高度          框架
bindflt                                 1       409800         0
`

await runSuite('nt-status-probe', async () => {
  section('1. fltmc filters 解析')
  const loaded = parseFltmcFilters(FILTERS_EN)
  eq('识别 dshnt', loaded.loaded, true)
  eq('实例数', loaded.instances, 1)
  eq('高度', loaded.altitude, '371100')
  eq('未加载', parseFltmcFilters(FILTERS_MISSING).loaded, false)
  eq('相似名字不误判', parseFltmcFilters('dshnt-other  1 371100 0').loaded, false)

  section('2. fltmc instances')
  eq(
    '卷列表',
    parseFltmcInstances('C:     371100  dshnt  0\nD:     371100  dshnt  0\n'),
    ['C:', 'D:'],
  )
  eq('空输出', parseFltmcInstances(''), [])

  section('3. ProjFS 功能状态（中英文本地化）')
  eq('英文 Enabled', parseProjfsFeature('Enabled'), 'enabled')
  eq('中文 已启用', parseProjfsFeature('已启用'), 'enabled')
  eq('英文 Disabled', parseProjfsFeature('Disabled'), 'disabled')
  eq('中文 已禁用', parseProjfsFeature('已禁用'), 'disabled')
  eq('未知', parseProjfsFeature('what'), 'unknown')

  section('4. provider stats')
  eq('解析视图', parseProviderStats('{"ok":true,"stats":{"views":[{"view":"C:\\\\v1"}]}}').views, ['C:\\v1'])
  eq('provider 存活', parseProviderStats('{"ok":true,"stats":{}}').alive, true)
  eq('坏 JSON 不抛', parseProviderStats('not json').alive, false)

  section('5. 状态真值表')
  const ready = assessNtStatus({
    filter: { loaded: true, instances: 1, altitude: '371100' },
    service: 'running',
    projfs: 'enabled',
    providerAlive: true,
    providerViews: ['C:\\dshnt\\view\\s1'],
    policy: { valid: true, generation: 3, hash: 'a'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    applyReady: true,
    abiVersion: 2,
  })
  eq('全部就绪 → kernel', ready.enforcement, 'kernel-projfs-minifilter')
  eq('写屏障', ready.writeBarrier, 'kernel-projfs-minifilter')
  eq('域数来自 views', ready.domains, 1)

  const noProvider = assessNtStatus({
    filter: { loaded: true, instances: 1 },
    service: 'running',
    projfs: 'enabled',
    providerAlive: false,
    policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    abiVersion: 2,
  })
  eq('provider 不在 → unavailable', noProvider.enforcement, 'unavailable')
  eq('写屏障 none', noProvider.writeBarrier, 'none')

  const abiMismatch = assessNtStatus({
    filter: { loaded: true, instances: 1 },
    service: 'running',
    projfs: 'enabled',
    providerAlive: true,
    policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    abiVersion: 1,
  })
  eq('ABI 不符 → unavailable', abiMismatch.enforcement, 'unavailable')
  check('notes 说明 ABI', abiMismatch.notes.some((note) => note.includes('ABI')), abiMismatch.notes.join('|'))

  const noInstances = assessNtStatus({
    filter: { loaded: true, instances: 0 },
    service: 'running',
    projfs: 'enabled',
    providerAlive: true,
    policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    abiVersion: 2,
  })
  check('实例数 0 写进 notes', noInstances.notes.some((note) => note.includes('no instances')), noInstances.notes.join('|'))

  const observed = assessNtStatus({
    filter: { loaded: true, instances: 1 },
    service: 'running',
    projfs: 'enabled',
    providerAlive: true,
    policy: { valid: true, generation: 1, hash: 'a'.repeat(64) },
    network: { mode: 'observed', enforced: false },
    abiVersion: 2,
  })
  eq('observed 不算未强制（不是 offline/allowlist）', observed.network.enforced, false)
  eq('observed 仍可 kernel', observed.enforcement, 'kernel-projfs-minifilter')

  const policyBad = assessNtStatus({
    filter: { loaded: true, instances: 1 },
    service: 'running',
    projfs: 'enabled',
    providerAlive: true,
    policy: { valid: false, error: 'invalid' },
    network: { mode: 'offline', enforced: true },
    abiVersion: 2,
  })
  eq('策略非法 → unavailable', policyBad.enforcement, 'unavailable')

  section('6. 采集器：命令失败降级为 unknown')
  const facts = await collectNtFacts({
    run: async (command) => {
      if (command === 'fltmc filters') return FILTERS_EN
      if (command === 'sc query dshnt') return 'STATE : 4  RUNNING'
      throw new Error('not allowed')
    },
  })
  eq('filter 已加载', facts.filter?.loaded, true)
  eq('service running', facts.service, 'running')
  eq('ProjFS 命令失败 → unknown', facts.projfs, 'unknown')
  check('notes 记录失败', (facts.notes ?? []).some((note) => note.includes('ProjFS')), (facts.notes ?? []).join('|'))

  const missing = await collectNtFacts({
    run: async (command) => {
      if (command === 'fltmc filters') return FILTERS_MISSING
      if (command === 'sc query dshnt') return 'The specified service does not exist as an installed service.'
      return 'Disabled'
    },
  })
  eq('service missing', missing.service, 'missing')
  eq('filter 未加载', missing.filter?.loaded, false)
  eq('ProjFS disabled', missing.projfs, 'disabled')

  section('7. 事实直接拼装（不跑命令）')
  const assembled = await collectNtFacts({
    run: async () => 'Enabled',
    policy: { valid: true, generation: 9, hash: 'b'.repeat(64) },
    network: { mode: 'offline', enforced: true },
    applyReady: true,
  })
  eq('service 未知（命令输出既非 running 也非 missing）', assembled.service, 'unknown')
  eq('policy 透传', assembled.policy?.generation, 9)
  eq('network 透传', assembled.network?.mode, 'offline')
})
