/**
 * 驱动通信端口的**线格式**（纯函数，可在 Linux 上单测）。
 *
 * 与 `native/include/dshnt_abi.h` 一一对应：
 *   · 消息 = 24 字节 header + payload；
 *   · 字符串用 `STRING_REF{Offset,Bytes}` 指向 payload 内的一段 UTF-16LE（无 NUL）；
 *   · 所有整数小端；结构 pack(8)。
 *
 * 这层只负责“字节 ↔ 对象”，不做任何安全判断；判断在驱动与 `status.ts`。
 *
 * @module winstage-sandbox/nt/driver-wire
 */

import { NT_DRIVER_ABI_VERSION, NtError, type NtAccess, type NtDriverEvent } from './types.ts'

export const MSG_HEADER_BYTES = 24

export const Msg = {
  hello: 1,
  setPolicy: 2,
  registerDomain: 3,
  unregisterDomain: 4,
  grantApply: 5,
  revokeApply: 6,
  queryStats: 7,
  event: 8,
  registerProcess: 9,
  unregisterProcess: 10,
  queryEvents: 11,
  reply: 0x8000,
} as const

export const ACCESS_BITS: Record<NtAccess, number> = {
  read: 0x1,
  write: 0x2,
  execute: 0x4,
  delete: 0x8,
  rename: 0x10,
  attribute: 0x20,
}

const EVENT_TYPES: Record<number, NtDriverEvent['type']> = {
  1: 'deny',
  2: 'stage',
  3: 'mask',
  4: 'redirect',
  5: 'domain',
  6: 'driver',
}

const EVENT_PATH_CHARS = 260
const EVENT_ID_CHARS = 64
export const EVENT_BATCH = 32

export interface WireMessage {
  type: number
  payload: Buffer
}

export interface WireReply {
  type: number
  status: number
  payload: Buffer
}

/** 字符串表：追加 UTF-16LE，返回 STRING_REF。 */
class StringTable {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private readonly seen = new Map<string, { offset: number; bytes: number }>()

  add(value: string | undefined): { offset: number; bytes: number } {
    if (value === undefined || value.length === 0) return { offset: 0, bytes: 0 }
    const hit = this.seen.get(value)
    if (hit !== undefined) return hit
    const encoded = Buffer.from(value, 'utf16le')
    const ref = { offset: this.bytes, bytes: encoded.length }
    this.chunks.push(encoded)
    this.bytes += encoded.length
    this.seen.set(value, ref)
    return ref
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.bytes)
  }
}

function header(type: number, size: number, status = 0): Buffer {
  const buf = Buffer.alloc(MSG_HEADER_BYTES)
  buf.writeUInt32LE(size, 0)
  buf.writeUInt16LE(NT_DRIVER_ABI_VERSION, 4)
  buf.writeUInt16LE(type, 6)
  buf.writeUInt32LE(status >>> 0, 8)
  buf.writeUInt32LE(0, 12)
  return buf
}

/** 打包一条请求消息。 */
export function encodeMessage(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([header(type, MSG_HEADER_BYTES + payload.length), payload])
}

/** 解析回复；`status !== 0` 时抛 `NT_INTERNAL`（附驱动状态码）。 */
export function decodeReply(buffer: Buffer): WireReply {
  if (buffer.length < MSG_HEADER_BYTES) {
    throw new NtError('NT_INTERNAL', { reason: 'short reply from driver', bytes: buffer.length })
  }
  const size = buffer.readUInt32LE(0)
  const version = buffer.readUInt16LE(4)
  const type = buffer.readUInt16LE(6) & ~Msg.reply
  const status = buffer.readUInt32LE(8)
  if (size !== buffer.length) {
    throw new NtError('NT_INTERNAL', { reason: 'reply size mismatch', size, actual: buffer.length })
  }
  if (version !== NT_DRIVER_ABI_VERSION) {
    throw new NtError('NT_DRIVER_VERSION_MISMATCH', { expected: NT_DRIVER_ABI_VERSION, actual: version })
  }
  if (status !== 0) {
    throw new NtError('NT_INTERNAL', { reason: 'driver returned failure', status: `0x${status.toString(16)}`, type })
  }
  return { type, status, payload: buffer.subarray(MSG_HEADER_BYTES) }
}

// ------------------------------------------------------------------ payloads

export function encodeHello(): Buffer {
  return encodeMessage(Msg.hello)
}

export interface HelloReply {
  abiVersion: number
  capabilities: number
  driverVersion: string
  altitude: string
}

export function decodeHello(reply: WireReply): HelloReply {
  const p = reply.payload
  if (p.length < 8 + 64 * 2 + 32 * 2) {
    throw new NtError('NT_INTERNAL', { reason: 'hello reply too small', bytes: p.length })
  }
  const abiVersion = p.readUInt32LE(0)
  const capabilities = p.readUInt32LE(4)
  const driverVersion = p.subarray(8, 8 + 64 * 2).toString('utf16le').replace(/\0.*$/s, '')
  const altitude = p.subarray(8 + 64 * 2, 8 + 64 * 2 + 32 * 2).toString('utf16le').replace(/\0.*$/s, '')
  return { abiVersion, capabilities, driverVersion, altitude }
}

export function encodeSetPolicy(payload: Uint8Array): Buffer {
  return encodeMessage(Msg.setPolicy, Buffer.from(payload))
}

export interface RegisterDomainInput {
  id: string
  workspaceRoot: string
  viewRoot: string
  storeRoot: string
  appContainerSid?: string
}

export function encodeRegisterDomain(input: RegisterDomainInput): Buffer {
  const table = new StringTable()
  const refs = {
    id: table.add(input.id),
    workspace: table.add(input.workspaceRoot),
    view: table.add(input.viewRoot),
    store: table.add(input.storeRoot),
    sid: table.add(input.appContainerSid),
  }
  const fields = Buffer.alloc(5 * 8)
  let at = 0
  for (const ref of [refs.id, refs.workspace, refs.view, refs.store, refs.sid]) {
    fields.writeUInt32LE(ref.offset, at)
    fields.writeUInt32LE(ref.bytes, at + 4)
    at += 8
  }
  return encodeMessage(Msg.registerDomain, Buffer.concat([fields, table.toBuffer()]))
}

export function encodeRegisterProcess(input: {
  pid: number
  domainId?: string
  flags: { root?: boolean; trusted?: boolean }
}): Buffer {
  const table = new StringTable()
  const ref = table.add(input.domainId)
  const fields = Buffer.alloc(12)
  fields.writeUInt32LE(input.pid >>> 0, 0)
  const flags = (input.flags.root === true ? 0x1 : 0) | (input.flags.trusted === true ? 0x2 : 0)
  fields.writeUInt32LE(flags, 4)
  fields.writeUInt32LE(ref.offset, 8)
  // STRING_REF = {Offset, Bytes}；上面只写了 Offset，补 Bytes。
  const refBytes = Buffer.alloc(4)
  refBytes.writeUInt32LE(ref.bytes, 0)
  return encodeMessage(Msg.registerProcess, Buffer.concat([fields, refBytes, table.toBuffer()]))
}

export function encodeUnregisterProcess(pid: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(pid >>> 0, 0)
  buf.writeUInt32LE(0, 4)
  return encodeMessage(Msg.unregisterProcess, buf)
}

export function encodeGrantApply(input: {
  pid: number
  imageHash: string
  paths: string[]
}): Buffer {
  const table = new StringTable()
  const refs = input.paths.map((path) => table.add(path))
  const head = Buffer.alloc(8 + 32 + 8)
  head.writeUInt32LE(input.pid >>> 0, 0)
  Buffer.from(input.imageHash, 'hex').copy(head, 4, 0, 32)
  head.writeUInt32LE(refs.length, 36)
  // PathStart：STRING_REF 数组在本消息字符串区之后的偏移（字节）。
  // 驱动按 strings + align8(stringBytes) 读；这里在 payload 末尾追加表。
  const strings = table.toBuffer()
  head.writeUInt32LE(align8(strings.length), 40)
  const refBuf = Buffer.alloc(refs.length * 8)
  refs.forEach((ref, index) => {
    refBuf.writeUInt32LE(ref.offset, index * 8)
    refBuf.writeUInt32LE(ref.bytes, index * 8 + 4)
  })
  const pad = Buffer.alloc(align8(strings.length) - strings.length)
  return encodeMessage(Msg.grantApply, Buffer.concat([head, strings, pad, refBuf]))
}

export function encodeQueryStats(): Buffer {
  return encodeMessage(Msg.queryStats)
}

export interface StatsReply {
  domains: number
  rules: number
  redirects: bigint
  denies: bigint
  masks: bigint
  policyGeneration: number
  lastError: number
  processCount: number
  events: bigint
}

export function decodeStats(reply: WireReply): StatsReply {
  const p = reply.payload
  // DSHNT_STATS：u32 Domains, u32 Rules, u64×3, u32×4, u64 Events = 56 字节
  if (p.length < 56) {
    throw new NtError('NT_INTERNAL', { reason: 'stats reply too small', bytes: p.length })
  }
  return {
    domains: p.readUInt32LE(0),
    rules: p.readUInt32LE(4),
    redirects: p.readBigUInt64LE(8),
    denies: p.readBigUInt64LE(16),
    masks: p.readBigUInt64LE(24),
    policyGeneration: p.readUInt32LE(32),
    lastError: p.readUInt32LE(36),
    processCount: p.readUInt32LE(40),
    events: p.readBigUInt64LE(48),
  }
}

export interface EventsReply {
  count: number
  dropped: number
  events: NtDriverEvent[]
}

export function decodeEvents(reply: WireReply): EventsReply {
  const p = reply.payload
  if (p.length < 8) {
    throw new NtError('NT_INTERNAL', { reason: 'events reply too small', bytes: p.length })
  }
  const count = p.readUInt32LE(0)
  const dropped = p.readUInt32LE(4)
  const recordBytes = 4 * 4 + 8 + (EVENT_ID_CHARS + EVENT_PATH_CHARS + EVENT_ID_CHARS) * 2
  const events: NtDriverEvent[] = []
  for (let i = 0; i < count && i < EVENT_BATCH; i++) {
    const at = 8 + i * recordBytes
    if (at + recordBytes > p.length) break
    const typeCode = p.readUInt32LE(at)
    const accessMask = p.readUInt32LE(at + 4)
    const actionCode = p.readUInt32LE(at + 8)
    const pid = p.readUInt32LE(at + 12)
    const filetime = p.readBigUInt64LE(at + 16)
    const domainId = readFixedString(p, at + 24, EVENT_ID_CHARS)
    const path = readFixedString(p, at + 24 + EVENT_ID_CHARS * 2, EVENT_PATH_CHARS)
    const ruleId = readFixedString(p, at + 24 + (EVENT_ID_CHARS + EVENT_PATH_CHARS) * 2, EVENT_ID_CHARS)

    const event: NtDriverEvent = {
      type: EVENT_TYPES[typeCode] ?? 'driver',
      at: filetimeToIso(filetime),
      pid,
    }
    if (domainId) event.domainId = domainId
    if (path) event.path = path
    if (ruleId) event.ruleId = ruleId
    const access = decodeAccess(accessMask)
    if (access !== undefined) event.access = access
    const action = decodeAction(actionCode)
    if (action !== undefined) event.action = action
    events.push(event)
  }
  return { count, dropped, events }
}

function readFixedString(buffer: Buffer, offset: number, chars: number): string {
  let end = offset + chars * 2
  for (let i = offset; i + 1 < offset + chars * 2; i += 2) {
    if (buffer.readUInt16LE(i) === 0) {
      end = i
      break
    }
  }
  return buffer.subarray(offset, end).toString('utf16le')
}

function filetimeToIso(filetime: bigint): string {
  const epochDiff = 116444736000000000n
  const ms = Number((filetime - epochDiff) / 10000n)
  return new Date(ms).toISOString()
}

function decodeAccess(mask: number): NtAccess | undefined {
  for (const [access, bit] of Object.entries(ACCESS_BITS) as Array<[NtAccess, number]>) {
    if (mask === bit) return access
  }
  return undefined
}

function decodeAction(code: number): 'allow' | 'deny' | 'stage' | 'mask' | undefined {
  return (['allow', 'deny', 'stage', 'mask'] as const)[code]
}

function align8(value: number): number {
  return (value + 7) & ~7
}

export function encodeQueryEvents(): Buffer {
  return encodeMessage(Msg.queryEvents)
}

export function encodeRevokeApply(pid: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(pid >>> 0, 0)
  return encodeMessage(Msg.revokeApply, buf)
}
