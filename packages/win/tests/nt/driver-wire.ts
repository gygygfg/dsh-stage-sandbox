/**
 * `src/nt/driver-wire.ts` 单测：消息布局、回复解析、事件解码、失败语义。
 *
 * @module winstage-sandbox/tests/nt/driver-wire
 */

import {
  ACCESS_BITS,
  EVENT_BATCH,
  MSG_HEADER_BYTES,
  Msg,
  decodeEvents,
  decodeHello,
  decodeReply,
  decodeStats,
  encodeGrantApply,
  encodeHello,
  encodeMessage,
  encodeQueryStats,
  encodeRegisterProcess,
  encodeSetPolicy,
  encodeUnregisterDomain,
} from '../../src/nt/driver-wire.ts'
import { NT_DRIVER_ABI_VERSION } from '../../src/nt/types.ts'
import { check, eq, runSuite, section } from './harness.ts'

function headerOf(message: Buffer) {
  return {
    size: message.readUInt32LE(0),
    version: message.readUInt16LE(4),
    type: message.readUInt16LE(6),
    status: message.readUInt32LE(8),
  }
}

function reply(type: number, payload: Buffer, status = 0): Buffer {
  const header = Buffer.alloc(MSG_HEADER_BYTES)
  header.writeUInt32LE(MSG_HEADER_BYTES + payload.length, 0)
  header.writeUInt16LE(NT_DRIVER_ABI_VERSION, 4)
  header.writeUInt16LE(type | Msg.reply, 6)
  header.writeUInt32LE(status >>> 0, 8)
  return Buffer.concat([header, payload])
}

await runSuite('nt-driver-wire', async () => {
  section('1. 消息头')
  const hello = encodeHello()
  eq('size 等于总长度', headerOf(hello).size, hello.length)
  eq('ABI 版本', headerOf(hello).version, NT_DRIVER_ABI_VERSION)
  eq('type hello', headerOf(hello).type, Msg.hello)
  eq('请求 status 为 0', headerOf(hello).status, 0)

  const policy = encodeSetPolicy(new Uint8Array([1, 2, 3, 4]))
  eq('setPolicy type', headerOf(policy).type, Msg.setPolicy)
  eq('setPolicy payload 原样', policy.subarray(MSG_HEADER_BYTES).toString('hex'), '01020304')

  section('2. 回复解析')
  const ok = decodeReply(reply(Msg.hello, Buffer.alloc(0)))
  eq('reply type 去掉高 bit', ok.type, Msg.hello)
  eq('reply status', ok.status, 0)

  let versionError = ''
  try {
    const badVersion = reply(Msg.hello, Buffer.alloc(0))
    badVersion.writeUInt16LE(99, 4)
    decodeReply(badVersion)
  } catch (error) {
    versionError = (error as { code?: string }).code ?? ''
  }
  eq('版本不符 → NT_DRIVER_VERSION_MISMATCH', versionError, 'NT_DRIVER_VERSION_MISMATCH')

  let statusError = ''
  try {
    decodeReply(reply(Msg.queryStats, Buffer.alloc(0), 0x80070005))
  } catch (error) {
    statusError = (error as { code?: string }).code ?? ''
  }
  eq('驱动 status 非 0 → NT_INTERNAL', statusError, 'NT_INTERNAL')

  let shortError = ''
  try {
    decodeReply(Buffer.alloc(4))
  } catch (error) {
    shortError = (error as { code?: string }).code ?? ''
  }
  eq('短回复 → NT_INTERNAL', shortError, 'NT_INTERNAL')

  section('3. HELLO 解码')
  {
    const payload = Buffer.alloc(8 + 64 * 2 + 32 * 2)
    payload.writeUInt32LE(NT_DRIVER_ABI_VERSION, 0)
    payload.writeUInt32LE(0xf, 4)
    payload.write('0.1.0', 8, 'utf16le')
    payload.write('371100', 8 + 64 * 2, 'utf16le')
    const parsed = decodeHello({ type: Msg.hello, status: 0, payload })
    eq('abiVersion', parsed.abiVersion, NT_DRIVER_ABI_VERSION)
    eq('capabilities', parsed.capabilities, 0xf)
    eq('driverVersion', parsed.driverVersion, '0.1.0')
    eq('altitude', parsed.altitude, '371100')
  }

  section('4. STATS 解码')
  {
    const payload = Buffer.alloc(56)
    payload.writeUInt32LE(2, 0)
    payload.writeUInt32LE(9, 4)
    payload.writeBigUInt64LE(11n, 8)
    payload.writeBigUInt64LE(22n, 16)
    payload.writeBigUInt64LE(33n, 24)
    payload.writeUInt32LE(7, 32)
    payload.writeUInt32LE(0, 36)
    payload.writeUInt32LE(4, 40)
    payload.writeBigUInt64LE(5n, 48)
    const stats = decodeStats({ type: Msg.queryStats, status: 0, payload })
    eq('domains', stats.domains, 2)
    eq('rules', stats.rules, 9)
    eq('redirects', stats.redirects.toString(), '11')
    eq('denies', stats.denies.toString(), '22')
    eq('masks', stats.masks.toString(), '33')
    eq('generation', stats.policyGeneration, 7)
    eq('processCount', stats.processCount, 4)
    eq('events', stats.events.toString(), '5')
  }

  section('5. REGISTER_PROCESS 布局')
  const register = encodeRegisterProcess({
    pid: 4242,
    domainId: 'sess-1',
    flags: { root: true },
  })
  eq('type', headerOf(register).type, Msg.registerProcess)
  const body = register.subarray(MSG_HEADER_BYTES)
  eq('pid', body.readUInt32LE(0), 4242)
  eq('flags root', body.readUInt32LE(4), 0x1)
  const refOffset = body.readUInt32LE(8)
  const refBytes = body.readUInt32LE(12)
  eq('domainId 字节数', refBytes, 'sess-1'.length * 2)
  eq('domainId 内容', body.subarray(16 + refOffset, 16 + refOffset + refBytes).toString('utf16le'), 'sess-1')

  const trusted = encodeRegisterProcess({ pid: 7, flags: { trusted: true } })
  const trustedBody = trusted.subarray(MSG_HEADER_BYTES)
  eq('flags trusted', trustedBody.readUInt32LE(4), 0x2)
  eq('无域时 ref 为空', trustedBody.readUInt32LE(12), 0)

  section('5b. UNREGISTER_DOMAIN 布局')
  const unregister = encodeUnregisterDomain('sess-1')
  eq('type', headerOf(unregister).type, Msg.unregisterDomain)
  const unregisterBody = unregister.subarray(MSG_HEADER_BYTES)
  const unregisterOffset = unregisterBody.readUInt32LE(0)
  const unregisterBytes = unregisterBody.readUInt32LE(4)
  eq('id 字节数', unregisterBytes, 'sess-1'.length * 2)
  eq('id 内容', unregisterBody.subarray(8 + unregisterOffset, 8 + unregisterOffset + unregisterBytes).toString('utf16le'), 'sess-1')

  section('6. GRANT_APPLY 布局')
  const grant = encodeGrantApply({
    pid: 99,
    imageHash: 'a'.repeat(64),
    paths: ['C:\\work\\proj\\a.txt', 'C:\\work\\proj\\b.txt'],
  })
  const grantBody = grant.subarray(MSG_HEADER_BYTES)
  eq('grant pid', grantBody.readUInt32LE(0), 99)
  eq('grant hash 首字节', grantBody.subarray(4, 6).toString('hex'), 'aaaa')
  eq('grant pathCount', grantBody.readUInt32LE(36), 2)
  const pathStart = grantBody.readUInt32LE(40)
  eq('grant pathStart 对齐到 8', pathStart % 8, 0)

  section('7. 事件解码')
  {
    const RECORD = 4 * 4 + 8 + (64 + 260 + 64) * 2
    const payload = Buffer.alloc(8 + RECORD * 2)
    payload.writeUInt32LE(2, 0)
    payload.writeUInt32LE(1, 4)
    const write = (index: number, type: number, access: number, action: number, pid: number, domain: string, path: string, rule: string) => {
      const at = 8 + index * RECORD
      payload.writeUInt32LE(type, at)
      payload.writeUInt32LE(access, at + 4)
      payload.writeUInt32LE(action, at + 8)
      payload.writeUInt32LE(pid, at + 12)
      payload.writeBigUInt64LE(133000000000000000n, at + 16)
      payload.write(domain, at + 24, 'utf16le')
      payload.write(path, at + 24 + 64 * 2, 'utf16le')
      payload.write(rule, at + 24 + (64 + 260) * 2, 'utf16le')
    }
    write(0, 1, ACCESS_BITS.write, 1, 1234, 'sess-1', 'C:\\work\\proj\\a.txt', 'ws-write-stage')
    write(1, 4, ACCESS_BITS.read, 0, 5678, 'sess-1', 'C:\\work\\proj\\b.txt', '')

    const decoded = decodeEvents({ type: Msg.queryEvents, status: 0, payload })
    eq('事件数量', decoded.count, 2)
    eq('丢弃计数', decoded.dropped, 1)
    eq('第一条类型', decoded.events[0]?.type, 'deny')
    eq('第一条 access', decoded.events[0]?.access, 'write')
    eq('第一条 action', decoded.events[0]?.action, 'deny')
    eq('第一条 pid', decoded.events[0]?.pid, 1234)
    eq('第一条 domain', decoded.events[0]?.domainId, 'sess-1')
    eq('第一条 path', decoded.events[0]?.path, 'C:\\work\\proj\\a.txt')
    eq('第一条 rule', decoded.events[0]?.ruleId, 'ws-write-stage')
    check('时间戳是 ISO', /^\d{4}-\d{2}-\d{2}T/.test(decoded.events[0]?.at ?? ''), decoded.events[0]?.at)
    eq('第二条类型', decoded.events[1]?.type, 'redirect')
    eq('第二条无 ruleId', decoded.events[1]?.ruleId, undefined)
    eq('batch 上限', EVENT_BATCH, 32)
  }

  section('8. 空 payload 与未知类型')
  const query = encodeQueryStats()
  eq('queryStats type', headerOf(query).type, Msg.queryStats)
  eq('queryStats 无 payload', query.length, MSG_HEADER_BYTES)
  const unknown = encodeMessage(0x7fff)
  eq('未知类型仍可编码', headerOf(unknown).type, 0x7fff)
})
