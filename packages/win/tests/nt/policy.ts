/**
 * `src/nt/policy.ts` 单测：校验、优先级、默认拒绝、哈希稳定性。
 *
 * @module winstage-sandbox/tests/nt/policy
 */

import {
  canonicalPolicyJson,
  compilePolicy,
  defaultCredentialMasks,
  defaultRulesForDomain,
  policyHash,
  validatePolicy,
} from '../../src/nt/policy.ts'
import { defaultJobLimits, type NtDomain, type NtPolicySet, type NtRule } from '../../src/nt/types.ts'
import { check, eq, runSuite, section, throwsCode } from './harness.ts'

const WORKSPACE = 'C:\\work\\proj'
const VIEW = 'D:\\dshnt\\view\\s1'
const STORE = 'D:\\dshnt\\store\\s1'

function makeDomain(overrides: Partial<NtDomain> = {}): NtDomain {
  return {
    id: 'd1',
    label: 'dsh.ai.d1',
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

function makePolicy(domains: NtDomain[] = [makeDomain()], overrides: Partial<NtPolicySet> = {}): NtPolicySet {
  return {
    version: 1,
    generation: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    globalMasks: [],
    domains,
    ...overrides,
  }
}

function rule(overrides: Partial<NtRule> & Pick<NtRule, 'id' | 'match' | 'access' | 'action'>): NtRule {
  return { type: overrides.type ?? 'test', ...overrides }
}

await runSuite('nt-policy', async () => {
  section('1. 基础校验')
  const base = makePolicy()
  const baseValidation = validatePolicy(base)
  check('默认策略合法', baseValidation.ok, baseValidation.errors.join('; ') || undefined)
  eq('默认策略无错误', baseValidation.errors, [])
  const compiled = compilePolicy(base)

  section('2. 工作区读写删')
  eq('工作区读 allow', compiled.decide('d1', 'C:\\work\\proj\\src\\a.ts', 'read').action, 'allow')
  eq('工作区执行 allow', compiled.decide('d1', 'C:\\work\\proj\\node_modules\\.bin\\x.cmd', 'execute').action, 'allow')
  eq('工作区写 stage', compiled.decide('d1', 'C:\\work\\proj\\src\\a.ts', 'write').action, 'stage')
  eq('工作区删 stage', compiled.decide('d1', 'C:\\work\\proj\\src\\a.ts', 'delete').action, 'stage')
  eq('工作区改名 stage', compiled.decide('d1', 'C:\\work\\proj\\src\\a.ts', 'rename').action, 'stage')
  eq('工作区属性 stage', compiled.decide('d1', 'C:\\work\\proj\\src\\a.ts', 'attribute').action, 'stage')

  section('3. 系统目录 / store / view')
  eq('系统目录读 allow', compiled.decide('d1', 'C:\\Windows\\System32\\kernel32.dll', 'read').action, 'allow')
  eq('系统目录写 deny', compiled.decide('d1', 'C:\\Windows\\System32\\evil.dll', 'write').action, 'deny')
  eq('view 根直接读 deny', compiled.decide('d1', 'D:\\dshnt\\view\\s1\\a.txt', 'read').action, 'deny')
  eq('store 根直接写 deny', compiled.decide('d1', 'D:\\dshnt\\store\\s1\\manifest.json', 'write').action, 'deny')

  section('4. 默认拒绝 / 域缺失 / 非法路径')
  eq('未知路径读 deny（defaultRead=deny）', compiled.decide('d1', 'C:\\other\\a.txt', 'read').action, 'deny')
  eq('未知路径写 deny', compiled.decide('d1', 'C:\\other\\a.txt', 'write').action, 'deny')
  eq('域缺失 deny', compiled.decide('missing', 'C:\\work\\proj\\a.txt', 'read').action, 'deny')
  eq('非法路径 deny', compiled.decide('d1', 'C:relative', 'read').action, 'deny')
  const allowRead = compilePolicy(makePolicy([makeDomain({ defaultRead: 'allow' })]))
  eq('defaultRead=allow 时未知路径读 allow', allowRead.decide('d1', 'C:\\other\\a.txt', 'read').action, 'allow')

  section('5. 全局 mask 优先')
  const masked = compilePolicy(
    makePolicy([makeDomain()], { globalMasks: [{ kind: 'prefix', path: 'C:\\Users\\alice\\.ssh' }] }),
  )
  eq('凭据读 mask', masked.decide('d1', 'C:\\Users\\alice\\.ssh\\id_rsa', 'read').action, 'mask')
  eq('凭据写 mask（驱动按拒绝处理）', masked.decide('d1', 'C:\\Users\\alice\\.ssh\\id_rsa', 'write').action, 'mask')

  section('6. 特异性与 deny 优先')
  const specific = compilePolicy(
    makePolicy([
      makeDomain({
        rules: [
          ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
          rule({ id: 'secret-exact-deny', type: 'secret', match: { kind: 'exact', path: 'C:\\work\\proj\\secret.txt' }, access: ['read'], action: 'deny' }),
        ],
      }),
    ]),
  )
  eq('精确 deny 覆盖工作区 allow', specific.decide('d1', 'C:\\work\\proj\\secret.txt', 'read').action, 'deny')
  eq('相邻文件仍 allow', specific.decide('d1', 'C:\\work\\proj\\public.txt', 'read').action, 'allow')

  const sameSpecificity = compilePolicy(
    makePolicy([
      makeDomain({
        rules: [
          ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
          rule({ id: 'z-allow', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\same.txt' }, access: ['read'], action: 'allow' }),
          rule({ id: 'a-deny', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\same.txt' }, access: ['read'], action: 'deny' }),
        ],
      }),
    ]),
  )
  eq('同特异性 deny 优先', sameSpecificity.decide('d1', 'C:\\work\\proj\\same.txt', 'read').action, 'deny')

  section('7. 策略哈希稳定')
  const domainA = makeDomain()
  const domainB = makeDomain({
    id: 'd2',
    label: 'dsh.ai.d2',
    viewRoot: 'D:\\dshnt\\view\\s2',
    storeRoot: 'D:\\dshnt\\store\\s2',
    appContainerSid: 'S-1-15-2-9-9-9',
  })
  const p1 = makePolicy([domainA, domainB], { createdAt: '2026-01-01T00:00:00.000Z' })
  const p2 = makePolicy([domainB, domainA], { createdAt: '2026-12-31T23:59:59.000Z' })
  eq('域顺序/createdAt 不影响哈希', policyHash(p1), policyHash(p2))
  check('canonical JSON 不含 createdAt 字面值', !canonicalPolicyJson(p1).includes('2026-01-01'), canonicalPolicyJson(p1).slice(0, 120))
  const p3 = makePolicy([makeDomain({ rules: [...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }), rule({ id: 'x', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\x' }, access: ['read'], action: 'deny' })] })])
  check('规则变化改变哈希', policyHash(p1) !== policyHash(p3))

  section('8. 非法策略必须被拒绝')
  const invalidCases: Array<[string, NtPolicySet]> = [
    ['viewRoot 落在 workspace 内', makePolicy([makeDomain({ viewRoot: 'C:\\work\\proj\\view' })])],
    ['storeRoot 落在 workspace 内', makePolicy([makeDomain({ storeRoot: 'C:\\work\\proj\\store' })])],
    [
      'stage 落在 workspace 外',
      makePolicy([
        makeDomain({
          rules: [
            ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
            rule({ id: 'stage-outside', type: 'test', match: { kind: 'prefix', path: 'C:\\Windows' }, access: ['write'], action: 'stage' }),
          ],
        }),
      ]),
    ],
    [
      '工作区内 allow write（绕过暂存）',
      makePolicy([
        makeDomain({
          rules: [
            ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
            rule({ id: 'bypass', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\a.txt' }, access: ['write'], action: 'allow' }),
          ],
        }),
      ]),
    ],
    [
      '重复 rule id',
      makePolicy([
        makeDomain({
          rules: [
            ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
            rule({ id: 'dup', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\a' }, access: ['read'], action: 'allow' }),
            rule({ id: 'dup', type: 'test', match: { kind: 'exact', path: 'C:\\work\\proj\\b' }, access: ['read'], action: 'allow' }),
          ],
        }),
      ]),
    ],
    [
      '设备路径规则',
      makePolicy([
        makeDomain({
          rules: [
            ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
            rule({ id: 'device', type: 'device', match: { kind: 'prefix', path: '\\Device\\HarddiskVolume1' }, access: ['read'], action: 'deny' }),
          ],
        }),
      ]),
    ],
    [
      'ADS 规则',
      makePolicy([
        makeDomain({
          rules: [
            ...defaultRulesForDomain({ workspaceRoot: WORKSPACE, viewRoot: VIEW, storeRoot: STORE }),
            rule({ id: 'ads', type: 'secret', match: { kind: 'exact', path: 'C:\\work\\proj\\a.txt:secret' }, access: ['read'], action: 'deny' }),
          ],
        }),
      ]),
    ],
    ['非法 SID', makePolicy([makeDomain({ appContainerSid: 'not-a-sid' })])],
    [
      'allowlist + restricted 不支持',
      makePolicy([makeDomain({ tokenMode: 'restricted', network: { mode: 'allowlist', allow: [{ host: 'example.com', port: 443 }] } })]),
    ],
    ['allowlist 空列表（不得静默当 offline）', makePolicy([makeDomain({ network: { mode: 'allowlist', allow: [] } })])],
    ['allowlist 域名（闸门没有 DNS）', makePolicy([makeDomain({ network: { mode: 'allowlist', allow: [{ host: 'example.com', port: 443 }] } })])],
    ['allowlist 端口越界', makePolicy([makeDomain({ network: { mode: 'allowlist', allow: [{ host: '10.0.0.1', port: 70000 }] } })])],
    [
      '重复 AppContainer SID',
      makePolicy([
        makeDomain(),
        makeDomain({ id: 'd2', viewRoot: 'D:\\dshnt\\view\\s2', storeRoot: 'D:\\dshnt\\store\\s2' }),
      ]),
    ],
  ]
  for (const [label, policy] of invalidCases) {
    const result = validatePolicy(policy)
    check(`拒绝：${label}`, !result.ok, result.errors.join('; ') || '（未报错）')
  }
  throwsCode('compilePolicy 对非法策略抛 NT_POLICY_INVALID', () => compilePolicy(invalidCases[0][1]), 'NT_POLICY_INVALID')

  const allowOk = validatePolicy(
    makePolicy([makeDomain({ network: { mode: 'allowlist', allow: [{ host: '10.0.0.1', port: 443 }, { host: '2001:db8::1', port: 53 }] } })]),
  )
  check('IP 字面量 allowlist 合法', allowOk.ok, allowOk.errors.join('; '))

  section('9. 重复域 id / 跨域根重叠')
  const duplicateId = validatePolicy(makePolicy([makeDomain(), makeDomain({ viewRoot: 'D:\\dshnt\\view\\s2', storeRoot: 'D:\\dshnt\\store\\s2', appContainerSid: 'S-1-15-2-9-9-9' })]))
  check('重复域 id 被拒绝', !duplicateId.ok, duplicateId.errors.join('; '))
  const overlapView = validatePolicy(
    makePolicy([
      makeDomain(),
      makeDomain({
        id: 'd2',
        viewRoot: 'C:\\work\\proj\\nested-view',
        storeRoot: 'D:\\dshnt\\store\\s2',
        appContainerSid: 'S-1-15-2-9-9-9',
      }),
    ]),
  )
  check('viewRoot 跨域重叠被拒绝', !overlapView.ok, overlapView.errors.join('; '))

  section('10. 观察模式的诚实警告')
  const observed = validatePolicy(makePolicy([makeDomain({ network: { mode: 'observed', allow: [] } })]))
  check('observed 合法但有警告', observed.ok && observed.warnings.some((line) => line.includes('observed')), observed.warnings.join('; '))

  section('11. 凭据默认遮蔽')
  const masks = defaultCredentialMasks('C:\\Users\\alice')
  check('包含 .ssh 前缀', masks.some((mask) => mask.kind === 'prefix' && mask.path === 'c:\\users\\alice\\.ssh'))
  check('包含 crypto 前缀', masks.some((mask) => mask.path.includes('\\appdata\\roaming\\microsoft\\crypto')))
})
