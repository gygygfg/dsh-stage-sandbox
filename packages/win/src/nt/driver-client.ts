/**
 * 真实驱动端口客户端（Windows，koffi → fltlib）。
 *
 * 只在 `process.platform === 'win32'` 且 `koffi` 可解析时可用；否则由
 * `createDriverPort()` 退回 `UnavailableDriverPort`（fail-closed）。
 *
 * 线格式全部在 `driver-wire.ts`（纯函数、Linux 可测）；这里只做 FFI 与句柄生命周期。
 * 任何 FFI 失败都抛 `NT_DRIVER_UNAVAILABLE`/`NT_INTERNAL`，绝不“看起来成功”。
 *
 * @module winstage-sandbox/nt/driver-client
 */

import { createRequire } from 'node:module'
import {
  Msg,
  decodeEvents,
  decodeHello,
  decodeReply,
  decodeStats,
  encodeGrantApply,
  encodeHello,
  encodeQueryEvents,
  encodeQueryStats,
  encodeRegisterDomain,
  encodeRegisterProcess,
  encodeRevokeApply,
  encodeSetPolicy,
  encodeUnregisterProcess,
  type StatsReply,
} from './driver-wire.ts'
import {
  NtError,
  type NtDriverEvent,
  type NtDriverHello,
  type NtDriverPort,
  type NtDriverStats,
} from './types.ts'

interface FfiBinding {
  port: unknown
  call(message: Buffer): Buffer
  close(): void
}

interface KoffiFfi {
  connect(): FfiBinding
}

const require_ = createRequire(import.meta.url)

/**
 * 打开 \DshNtPort 的 FFI 绑定。
 *
 * @throws `NT_DRIVER_UNAVAILABLE`（koffi/fltlib/端口不可用）
 */
function connectPort(): FfiBinding {
  if (process.platform !== 'win32') {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'driver port requires Windows' })
  }

  let koffi: any
  try {
    koffi = require_('koffi')
  } catch (error) {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'koffi is not installed' }, { cause: error })
  }

  let fltlib: any
  let kernel32: any
  try {
    fltlib = koffi.load('fltlib.dll')
    kernel32 = koffi.load('kernel32.dll')
  } catch (error) {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'cannot load fltlib.dll' }, { cause: error })
  }

  const FilterConnectCommunicationPort = fltlib.func(
    'int32 __stdcall FilterConnectCommunicationPort(const char16_t *name, uint32_t options, void *context, uint16_t contextSize, void *securityAttributes, _Out_ void **port)',
  )
  const FilterSendMessage = fltlib.func(
    'int32 __stdcall FilterSendMessage(void *port, void *inBuffer, uint32_t inSize, void *outBuffer, uint32_t outSize, _Out_ uint32_t *returned)',
  )
  const CloseHandle = kernel32.func('int32 __stdcall CloseHandle(void *handle)')

  const portSlot = koffi.alloc('void *', 1)
  const hr = FilterConnectCommunicationPort('\\DshNtPort', 0, null, 0, null, portSlot)
  if (hr < 0) {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'FilterConnectCommunicationPort failed', hr: hr >>> 0 })
  }
  const handle = koffi.decode(portSlot, 'void *')
  if (handle === null || handle === 0) {
    throw new NtError('NT_DRIVER_UNAVAILABLE', { reason: 'empty port handle' })
  }

  const returnedSlot = koffi.alloc('uint32_t', 1)

  return {
    port: handle,
    call(message: Buffer): Buffer {
      const out = Buffer.alloc(64 * 1024)
      const rc = FilterSendMessage(handle, message, message.length, out, out.length, returnedSlot)
      if (rc < 0) {
        throw new NtError('NT_INTERNAL', { reason: 'FilterSendMessage failed', hr: rc >>> 0 })
      }
      const returned = koffi.decode(returnedSlot, 'uint32_t')
      return out.subarray(0, returned)
    },
    close(): void {
      CloseHandle(handle)
    },
  }
}

/** 真实端口实现。一个实例 = 一个端口句柄。 */
export class WindowsDriverPort implements NtDriverPort {
  private binding: FfiBinding | undefined
  private helloCache: NtDriverHello | undefined
  private readonly listeners = new Set<(event: NtDriverEvent) => void>()
  private pollTimer: NodeJS.Timeout | undefined

  private ensure(): FfiBinding {
    if (this.binding === undefined) {
      this.binding = connectPort()
    }
    return this.binding
  }

  private request(message: Buffer) {
    const binding = this.ensure()
    return decodeReply(binding.call(message))
  }

  async hello(): Promise<NtDriverHello> {
    if (this.helloCache !== undefined) return this.helloCache
    const reply = decodeHello(this.request(encodeHello()))
    this.helloCache = {
      abiVersion: reply.abiVersion,
      driverVersion: reply.driverVersion,
      altitude: reply.altitude,
      supports: decodeCapabilities(reply.capabilities),
    }
    return this.helloCache
  }

  async setPolicy(payload: Uint8Array, hash: string, generation: number): Promise<{ generation: number }> {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new NtError('NT_POLICY_INVALID', { reason: 'policy hash must be 64 lowercase hex chars' })
    }
    this.request(encodeSetPolicy(payload))
    return { generation }
  }

  async registerDomain(input: {
    id: string
    viewRoot: string
    workspaceRoot?: string
    storeRoot?: string
    appContainerSid?: string
  }): Promise<void> {
    if (input.workspaceRoot === undefined || input.storeRoot === undefined) {
      throw new NtError('NT_VIEW_ROOT_INVALID', {
        reason: 'real driver requires workspaceRoot and storeRoot so it can verify the policy',
      })
    }
    this.request(
      encodeRegisterDomain({
        id: input.id,
        workspaceRoot: input.workspaceRoot,
        viewRoot: input.viewRoot,
        storeRoot: input.storeRoot,
        ...(input.appContainerSid === undefined ? {} : { appContainerSid: input.appContainerSid }),
      }),
    )
  }

  async unregisterDomain(_id: string): Promise<void> {
    // 域的生命周期由 PID 映射决定；显式注销在 v1 是 no-op（驱动侧同样）。
  }

  async grantApply(input: { pid: number; imageHash: string; paths: string[] }): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(input.imageHash)) {
      throw new NtError('NT_APPLY_DENIED', { reason: 'imageHash must be 64 lowercase hex chars' })
    }
    this.request(encodeGrantApply(input))
  }

  async revokeApply(pid: number): Promise<void> {
    this.request(encodeRevokeApply(pid))
  }

  async queryStats(): Promise<NtDriverStats> {
    const stats: StatsReply = decodeStats(this.request(encodeQueryStats()))
    return {
      domains: stats.domains,
      rules: stats.rules,
      redirects: Number(stats.redirects),
      denies: Number(stats.denies),
      masks: Number(stats.masks),
      policyGeneration: stats.policyGeneration,
      processCount: stats.processCount,
      ...(stats.lastError === 0 ? {} : { lastError: `0x${stats.lastError.toString(16)}` }),
    }
  }

  async registerProcess(input: {
    pid: number
    domainId?: string
    flags: { root?: boolean; trusted?: boolean }
  }): Promise<void> {
    this.request(encodeRegisterProcess(input))
  }

  async unregisterProcess(pid: number): Promise<void> {
    this.request(encodeUnregisterProcess(pid))
  }

  async queryEvents(): Promise<NtDriverEvent[]> {
    const reply = decodeEvents(this.request(encodeQueryEvents()))
    return reply.events
  }

  onEvent(listener: (event: NtDriverEvent) => void): () => void {
    this.listeners.add(listener)
    if (this.pollTimer === undefined) {
      this.pollTimer = setInterval(() => {
        this.queryEvents()
          .then((events) => {
            for (const event of events) {
              for (const listener of this.listeners) listener(event)
            }
          })
          .catch(() => {
            // 驱动被卸载/端口断开：停止轮询，状态卡会显示 driver.loaded=false。
            this.stopPolling()
          })
      }, 1000)
      this.pollTimer.unref?.()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stopPolling()
    }
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  /** 关闭端口（不影响驱动本身）。 */
  close(): void {
    this.stopPolling()
    this.binding?.close()
    this.binding = undefined
    this.helloCache = undefined
  }
}

function decodeCapabilities(mask: number): string[] {
  const out: string[] = []
  if (mask & 0x1) out.push('policy')
  if (mask & 0x2) out.push('domain')
  if (mask & 0x4) out.push('apply')
  if (mask & 0x8) out.push('events')
  return out
}

/** 可用则返回真实端口，否则 undefined（由 `createDriverPort` 决定 fail-closed 方式）。 */
export function tryCreateWindowsDriverPort(): NtDriverPort | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const requireKoffi = () => require_('koffi')
    requireKoffi()
  } catch {
    return undefined
  }
  return new WindowsDriverPort()
}

export { Msg }
