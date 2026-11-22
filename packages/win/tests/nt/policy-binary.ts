/**
 * `src/nt/policy-binary.ts` 单测：布局、确定性、规则顺序、字符串引用。
 *
 * 这些断言是**驱动 ABI 的在 Linux 侧替身**：这里的字节布局一旦漂移，
 * 驱动会以 STATUS_INVALID_PARAMETER 拒绝，而 Windows 上才看得到错误。
 *
 * @module winstage-sandbox/tests/nt/policy-binary
 */

import {
  DOMAIN_ENTRY_BYTES,
  POLICY_HEADER_BYTES,
  POLICY_MAGIC,
  RULE_ENTRY_BYTES,
  describeEncodedPolicy,
  encodePolicy,
} from '../../src/nt/policy-binary.ts'
import { canonicalPolicyJson, compilePolicy, defaultRulesForDomain, policyHash } from '../../src/nt/policy.ts'
import { NT_DRIVER_ABI_VERSION, type NtPolicySet } from '../../src/nt/types.ts'
import { check, eq, runSuite, section } from './harness.ts'

function fixture(): NtPolicySet {
  const domain = {
    id: 'sess-1',
    label: 'dsh.ai.sess-1',
    workspaceRoot: 'C:\\work\\proj',
    viewRoot: 'C:\\dshnt\\view\\sess-1',
    storeRoot: 'C:\\dshnt\\store\\sess-1',
    tokenMode: 'restricted' as const,
    job: { memoryMb: 2048, activeProcessLimit: 64, cpuPercent: 50, killOnClose: true },
    network: { mode: 'offline' as const, allow: [] },
    defaultRead: 'allow' as const,
    rules: [
      ...defaultRulesForDomain({
        workspaceRoot: 'C:\\work\\proj',
        viewRoot: 'C:\\dshnt\\view\\sess-1',
        storeRoot: 'C:\\dshnt\\store\\sess-1',
      }),
      {
        id: 'read-secrets-deny',
        type: 'secret',
        match: { kind: 'prefix' as const, path: 'C:\\work\\proj\\secrets' },
        access: ['read' as const],
        action: 'deny' as const,
      },
    ],
  }
  return {
    version: 1,
    generation: 7,
    createdAt: '2026-11-22T00:00:00.000Z',
    globalMasks: [
      { kind: 'exact', path: 'C:\\Users\\alice\\.ssh\\id_rsa' },
      { kind: 'prefix', path: 'C:\\Users\\alice\\.aws' },
    ],
    domains: [domain],
  }
}

await runSuite('nt-policy-binary', async () => {
  const policy = fixture()
  const compiled = compilePolicy(policy)
  const encoded = encodePolicy(policy)

  section('1. 头部')
  const bytes = Buffer.from(encoded.payload.buffer, encoded.payload.byteOffset, encoded.payload.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  eq('magic', view.getUint32(0, true), POLICY_MAGIC)
  eq('ABI 版本', view.getUint32(4, true), NT_DRIVER_ABI_VERSION)
  eq('generation', view.getUint32(8, true), policy.generation)
  eq('域数', view.getUint32(12, true), 1)
  eq('globalMask 数', view.getUint32(16, true), 2)
  check('规则数 > 0', view.getUint32(20, true) > 0, `rules=${view.getUint32(20, true)}`)
  eq('字符串区字节数', view.getUint32(24, true), encoded.stats.stringBytes)
  eq('payload 中的 hash', Buffer.from(encoded.payload.subarray(32, 64)).toString('hex'), policyHash(policy))
  eq('编码结果 hash', encoded.hash, policyHash(policy))

  section('2. 大小与布局')
  const expectedSize =
    POLICY_HEADER_BYTES +
    encoded.stats.domainsOffset +
    encoded.stats.domains * DOMAIN_ENTRY_BYTES +
    encoded.stats.rules * RULE_ENTRY_BYTES +
    encoded.stats.masks * RULE_ENTRY_BYTES
  eq('总大小 = header + strings(pad8) + domains + rules + masks', encoded.payload.length, expectedSize)
  eq('domain 结构大小', DOMAIN_ENTRY_BYTES, 104)
  eq('rule 结构大小', RULE_ENTRY_BYTES, 40)
  eq('header 大小', POLICY_HEADER_BYTES, 64)

  section('3. 域字段与字符串引用')
  const stringsBase = POLICY_HEADER_BYTES
  const domainAt = stringsBase + encoded.stats.domainsOffset
  const readRef = (offset: number): string => {
    const refOffset = view.getUint32(offset, true)
    const refBytes = view.getUint32(offset + 4, true)
    return bytes.subarray(stringsBase + refOffset, stringsBase + refOffset + refBytes).toString('utf16le')
  }
  eq('domain id', readRef(domainAt), 'sess-1')
  eq('domain label', readRef(domainAt + 8), 'dsh.ai.sess-1')
  eq('workspace', readRef(domainAt + 16), 'C:\\work\\proj')
  eq('view', readRef(domainAt + 24), 'C:\\dshnt\\view\\sess-1')
  eq('store', readRef(domainAt + 32), 'C:\\dshnt\\store\\sess-1')
  eq('空 SID 引用', view.getUint32(domainAt + 40, true) + view.getUint32(domainAt + 44, true), 0)
  eq('token mode restricted', view.getUint32(domainAt + 48, true), 1)
  eq('default read allow', view.getUint32(domainAt + 52, true), 1)
  eq('network offline', view.getUint32(domainAt + 56, true), 0)
  eq('rule count 与策略一致', view.getUint32(domainAt + 68, true), compiled.domains.get('sess-1')?.rules.length)
  eq('job memory bytes', view.getBigUint64(domainAt + 80, true).toString(), (2048n * 1024n * 1024n).toString())
  eq('job activeProcessLimit', view.getUint32(domainAt + 88, true), 64)
  eq('job cpuPercent', view.getUint32(domainAt + 92, true), 50)
  eq('job killOnClose', view.getUint32(domainAt + 96, true), 1)
  eq('domain 条目宽度', domainAt + DOMAIN_ENTRY_BYTES, domainAt + 104)

  section('4. 规则顺序（与 compilePolicy 同源）')
  const rulesAt = domainAt + encoded.stats.domains * DOMAIN_ENTRY_BYTES
  const ruleIds: string[] = []
  for (let i = 0; i < encoded.stats.rules; i++) {
    ruleIds.push(readRef(rulesAt + i * RULE_ENTRY_BYTES))
  }
  const expectedOrder = (compiled.domains.get('sess-1')?.rules ?? []).map((rule) => rule.id)
  eq('规则 id 顺序', ruleIds, expectedOrder)
  const denyIndex = ruleIds.indexOf('read-secrets-deny')
  check('自定义 deny 规则存在', denyIndex >= 0, `ids=${ruleIds.join(',')}`)
  const denyAt = rulesAt + denyIndex * RULE_ENTRY_BYTES
  eq('deny 规则 access mask 为 read', view.getUint32(denyAt + 28, true), 0x1)
  eq('deny 规则 action 为 deny', view.getUint32(denyAt + 32, true), 1)
  // 规则路径在 compilePolicy 里规范化（小写）；驱动按大小写不敏感比较。
  eq('deny 规则 path（规范化后小写）', readRef(denyAt + 16), 'c:\\work\\proj\\secrets')
  eq('deny 规则 match kind prefix', view.getUint32(denyAt + 24, true), 1)

  section('5. globalMask')
  const masksAt = rulesAt + encoded.stats.rules * RULE_ENTRY_BYTES
  eq('mask 路径', readRef(masksAt + 16), 'C:\\Users\\alice\\.ssh\\id_rsa')
  eq('mask kind exact', view.getUint32(masksAt + 24, true), 0)
  eq('mask access 全量', view.getUint32(masksAt + 28, true), 0x3f)
  eq('mask action', view.getUint32(masksAt + 32, true), 3)

  section('6. 确定性')
  const again = encodePolicy(policy)
  check('两次编码字节一致', Buffer.compare(bytes, Buffer.from(again.payload)) === 0)
  const canonical = canonicalPolicyJson(policy)
  check('canonical JSON 不含 createdAt', !canonical.includes('createdAt'))

  const described = describeEncodedPolicy(policy)
  eq('describe bytes', described.bytes, encoded.payload.length)
  eq('describe domains', described.domains, 1)
  check('canonicalBytes > 0', described.canonicalBytes > 0, String(described.canonicalBytes))
})
