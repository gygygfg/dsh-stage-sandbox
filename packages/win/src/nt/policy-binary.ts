/**
 * 策略 → 驱动二进制 payload（ABI v2）。
 *
 * 驱动不做 JSON 解析：控制面必须把 `NtPolicySet` 编码成
 * `native/include/dshnt_abi.h` 里固定的布局。任何字段/大小不匹配都会被驱动
 * 以 `STATUS_REVISION_MISMATCH` / `STATUS_INVALID_PARAMETER` 拒绝（fail-closed）。
 *
 * 布局（全部相对 payload 起点，小端）：
 *
 *   [0, 64)                     DSHNT_POLICY_HEADER
 *   [64, 64+StringBytes)        UTF-16LE 字符串区
 *   align8                      域数组：DomainCount × 112
 *   之后                        规则数组：RuleCount × 40
 *   之后                        globalMask 数组：GlobalMaskCount × 40
 *
 * 规则顺序有语义：这里按 `compilePolicy` 排好的顺序输出（特异性降序、
 * deny>mask>stage>allow、rule.id 稳定），驱动只取第一条命中。
 *
 * @module winstage-sandbox/nt/policy-binary
 */

import { canonicalPolicyJson, compilePolicy } from './policy.ts'
import {
  NT_DRIVER_ABI_VERSION,
  NT_POLICY_VERSION,
  NtError,
  type NtAccess,
  type NtDomain,
  type NtPolicySet,
  type NtRule,
} from './types.ts'

/** 与 `dshnt_abi.h` 保持一致；改这里必须同时改头文件与驱动。 */
export const POLICY_HEADER_BYTES = 64
export const DOMAIN_ENTRY_BYTES = 112
export const RULE_ENTRY_BYTES = 40
export const POLICY_MAGIC = 0x4453484e

const ACCESS_BITS: Record<NtAccess, number> = {
  read: 0x1,
  write: 0x2,
  execute: 0x4,
  delete: 0x8,
  rename: 0x10,
  attribute: 0x20,
}

const ACTION_CODES = { allow: 0, deny: 1, stage: 2, mask: 3 } as const
const MATCH_CODES = { exact: 0, prefix: 1 } as const
const TOKEN_CODES = { appcontainer: 0, restricted: 1 } as const
const NETWORK_CODES = { offline: 0, allowlist: 1, observed: 2 } as const
const DEFAULT_READ_CODES = { deny: 0, allow: 1 } as const

/** 编码结果：payload + 与 payload 一致的 canonical hash。 */
export interface EncodedPolicy {
  payload: Uint8Array
  hash: string
  generation: number
  stats: { domains: number; rules: number; masks: number; stringBytes: number; domainsOffset: number }
}

class Writer {
  private readonly buf: Uint8Array
  private readonly view: DataView
  private pos = 0

  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }

  u32(value: number): void {
    this.view.setUint32(this.pos, value >>> 0, true)
    this.pos += 4
  }

  u64(value: bigint): void {
    this.view.setBigUint64(this.pos, BigInt.asUintN(64, value), true)
    this.pos += 8
  }

  bytes(data: Uint8Array): void {
    this.buf.set(data, this.pos)
    this.pos += data.length
  }

  skip(count: number): void {
    this.pos += count
  }

  toBytes(): Uint8Array {
    return this.buf
  }
}

function utf16le(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf16le'))
}

function align8(value: number): number {
  return (value + 7) & ~7
}

/** 规则排序（与 `compilePolicy` 的 compareRules 同源语义；这里复用其输出顺序）。 */
function orderedRules(domain: NtDomain, compiled: ReturnType<typeof compilePolicy>): NtRule[] {
  const cd = compiled.domains.get(domain.id)
  if (cd === undefined) {
    throw new NtError('NT_POLICY_INVALID', { reason: 'domain missing from compiled policy', domain: domain.id })
  }
  return [...cd.rules]
}

/**
 * 把一份策略编码成驱动 payload。
 *
 * @throws `NT_POLICY_INVALID`（策略非法或超限）
 */
export function encodePolicy(policy: NtPolicySet): EncodedPolicy {
  if (policy.version !== NT_POLICY_VERSION) {
    throw new NtError('NT_POLICY_INVALID', { reason: `unsupported policy version ${policy.version}` })
  }
  if (!Number.isInteger(policy.generation) || policy.generation <= 0) {
    throw new NtError('NT_POLICY_INVALID', { reason: 'generation must be a positive integer' })
  }

  const compiled = compilePolicy(policy)

  // 1. 收集字符串并记录偏移（去重，避免同一路径重复占空间）。
  const stringBytes: number[] = []
  const offsets = new Map<string, { offset: number; bytes: number }>()
  const addString = (value: string): { offset: number; bytes: number } => {
    const hit = offsets.get(value)
    if (hit !== undefined) return hit
    const encoded = utf16le(value)
    const entry = { offset: stringBytes.length, bytes: encoded.length }
    for (const byte of encoded) stringBytes.push(byte)
    offsets.set(value, entry)
    return entry
  }
  const emptyRef = { offset: 0, bytes: 0 }

  type DomainLayout = {
    domain: NtDomain
    rules: NtRule[]
    refs: {
      id: { offset: number; bytes: number }
      label: { offset: number; bytes: number }
      workspace: { offset: number; bytes: number }
      view: { offset: number; bytes: number }
      store: { offset: number; bytes: number }
      sid: { offset: number; bytes: number }
    }
    ruleStart: number
  }

  const domainLayouts: DomainLayout[] = []
  let totalRules = 0

  for (const domain of policy.domains) {
    const rules = orderedRules(domain, compiled)
    domainLayouts.push({
      domain,
      rules,
      ruleStart: totalRules,
      refs: {
        id: addString(domain.id),
        label: addString(domain.label),
        workspace: addString(domain.workspaceRoot),
        view: addString(domain.viewRoot),
        store: addString(domain.storeRoot),
        sid: domain.appContainerSid === undefined ? emptyRef : addString(domain.appContainerSid),
      },
    })
    totalRules += rules.length
  }

  const maskRefs = (policy.globalMasks ?? []).map((mask) => ({
    match: mask,
    ref: addString(mask.path),
    kind: MATCH_CODES[mask.kind],
  }))

  const ruleRefs: Array<{
    rule: NtRule
    id: { offset: number; bytes: number }
    type: { offset: number; bytes: number }
    path: { offset: number; bytes: number }
  }> = []
  for (const layout of domainLayouts) {
    for (const rule of layout.rules) {
      ruleRefs.push({
        rule,
        id: addString(rule.id),
        type: addString(rule.type),
        path: addString(rule.match.path),
      })
    }
  }

  if (stringBytes.length > 0xffffffff) {
    throw new NtError('NT_POLICY_INVALID', { reason: 'string blob too large' })
  }

  const domainsOffset = align8(stringBytes.length)
  const totalSize =
    POLICY_HEADER_BYTES + domainsOffset + domainLayouts.length * DOMAIN_ENTRY_BYTES +
    totalRules * RULE_ENTRY_BYTES + maskRefs.length * RULE_ENTRY_BYTES

  const writer = new Writer(totalSize)
  const hash = compiled.hash

  // 2. header
  writer.u32(POLICY_MAGIC)
  writer.u32(NT_DRIVER_ABI_VERSION)
  writer.u32(policy.generation)
  writer.u32(domainLayouts.length)
  writer.u32(maskRefs.length)
  writer.u32(totalRules)
  writer.u32(stringBytes.length)
  writer.u32(0)
  writer.bytes(Buffer.from(hash, 'hex'))

  // 3. 字符串区
  writer.bytes(Uint8Array.from(stringBytes))
  writer.skip(domainsOffset - stringBytes.length)

  // 4. 域数组
  for (const layout of domainLayouts) {
    const d = layout.domain
    const r = layout.refs
    writer.u32(r.id.offset)
    writer.u32(r.id.bytes)
    writer.u32(r.label.offset)
    writer.u32(r.label.bytes)
    writer.u32(r.workspace.offset)
    writer.u32(r.workspace.bytes)
    writer.u32(r.view.offset)
    writer.u32(r.view.bytes)
    writer.u32(r.store.offset)
    writer.u32(r.store.bytes)
    writer.u32(r.sid.offset)
    writer.u32(r.sid.bytes)
    writer.u32(TOKEN_CODES[d.tokenMode])
    writer.u32(DEFAULT_READ_CODES[d.defaultRead])
    writer.u32(NETWORK_CODES[d.network.mode])
    writer.u32(d.network.allow.length)
    writer.u32(0) // EndpointStart（v1 不编码端点，见下）
    writer.u32(layout.rules.length)
    writer.u32(layout.ruleStart)
    // pack(8)：DSHNT_JOB_LIMITS 的 UINT64 必须 8 字节对齐。
    writer.u32(0)
    writer.u64(BigInt(d.job.memoryMb) * 1024n * 1024n)
    writer.u32(d.job.activeProcessLimit)
    writer.u32(d.job.cpuPercent)
    writer.u32(d.job.killOnClose ? 1 : 0)
    writer.u32(0)
    // 结构体尾部补齐到 112 字节（DomainCount 项之间必须同宽）。
    writer.skip(DOMAIN_ENTRY_BYTES - 104)
  }

  // 5. 规则数组
  for (const ref of ruleRefs) {
    const rule = ref.rule
    writer.u32(ref.id.offset)
    writer.u32(ref.id.bytes)
    writer.u32(ref.type.offset)
    writer.u32(ref.type.bytes)
    writer.u32(ref.path.offset)
    writer.u32(ref.path.bytes)
    writer.u32(MATCH_CODES[rule.match.kind])
    writer.u32(rule.access.reduce((mask, access) => mask | ACCESS_BITS[access], 0))
    writer.u32(ACTION_CODES[rule.action])
    writer.u32(0)
  }

  // 6. globalMask 数组（复用 RULE_ENTRY 布局：只有 Path/MatchKind 有意义）
  for (const mask of maskRefs) {
    writer.u32(0) // Id
    writer.u32(0)
    writer.u32(0) // Type
    writer.u32(0)
    writer.u32(mask.ref.offset)
    writer.u32(mask.ref.bytes)
    writer.u32(mask.kind)
    writer.u32(0x3f) // 全访问
    writer.u32(ACTION_CODES.mask)
    writer.u32(0)
  }

  return {
    payload: writer.toBytes(),
    hash,
    generation: policy.generation,
    stats: {
      domains: domainLayouts.length,
      rules: totalRules,
      masks: maskRefs.length,
      stringBytes: stringBytes.length,
      domainsOffset,
    },
  }
}

/**
 * 仅用于诊断：把编码结果与 canonical JSON 的字节数一起报告。
 * 供 `/winstage nt doctor` 与自测对比“控制面看到的大小/哈希”。
 */
export function describeEncodedPolicy(policy: NtPolicySet): {
  bytes: number
  hash: string
  generation: number
  canonicalBytes: number
  domains: number
  rules: number
  masks: number
} {
  const encoded = encodePolicy(policy)
  const canonical = canonicalPolicyJson(policy)
  return {
    bytes: encoded.payload.length,
    hash: encoded.hash,
    generation: encoded.generation,
    canonicalBytes: Buffer.byteLength(canonical, 'utf8'),
    domains: encoded.stats.domains,
    rules: encoded.stats.rules,
    masks: encoded.stats.masks,
  }
}
