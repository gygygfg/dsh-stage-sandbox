/**
 * ProjFS provider 控制客户端（named pipe / Unix socket）。
 *
 * 协议：一次连接可以承载多行请求，但本客户端采用**一请求一连接**：
 * provider 的 `ControlServer` 每个连接只处理到客户端关闭，且每次连接都很便宜；
 * 这样超时/取消/异常不会污染后续请求。
 *
 * 可测试性：`socketPath` 在 Linux 上就是 Unix socket；单测起一个假 provider 即可。
 * 任何传输层失败都抛 `ProviderTransportError`，由调用方转成 `NT_*` 机读码；
 * `ok:false` 的业务拒绝**不**抛，调用方可以读到 `error` 原文。
 *
 * @module winstage-sandbox/nt/provider-client
 */

import { connect, type Socket } from 'node:net'
import { parseProviderReply, type ProviderReply } from './provider-protocol.ts'

/** 传输层失败（连不上/超时/管道提前关闭）。 */
export class ProviderTransportError extends Error {
  readonly detail?: Record<string, unknown>

  constructor(message: string, detail?: Record<string, unknown> & { cause?: unknown }) {
    super(message, detail?.cause === undefined ? undefined : { cause: detail.cause })
    this.name = 'ProviderTransportError'
    this.detail = detail
  }
}

export interface ProviderRequestOptions {
  /** 单次请求超时（默认 5000 ms）。 */
  timeoutMs?: number
  /** 连接超时（默认与 timeoutMs 相同）。 */
  connectTimeoutMs?: number
}

export interface ProviderControl {
  /** 发一条请求；传输失败抛 `ProviderTransportError`。 */
  request(op: string, fields?: Record<string, unknown>, options?: ProviderRequestOptions): Promise<ProviderReply>
  /** 释放客户端（连接是按请求建立的，这里只清空队列引用）。 */
  close(): void
}

const DEFAULT_TIMEOUT_MS = 5000

/**
 * 基于 `node:net` 的实现。请求串行化：provider 的响应没有乱序保证，
 * 并发请求会让“一行回复属于谁”不可判定。
 */
export class PipeProviderControl implements ProviderControl {
  private readonly socketPath: string
  private readonly defaultTimeoutMs: number
  private queue: Promise<unknown> = Promise.resolve()
  private nextId = 1
  private closed = false

  constructor(socketPath: string, options: { timeoutMs?: number } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length === 0) {
      throw new ProviderTransportError('provider socket path is required')
    }
    this.socketPath = socketPath
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  request(op: string, fields: Record<string, unknown> = {}, options: ProviderRequestOptions = {}): Promise<ProviderReply> {
    const run = () => this.execute(op, fields, options)
    const result = this.queue.then(run, run)
    // 队列只负责“前一个完成”，失败不阻断后续请求（调用方自己决定是否继续）。
    this.queue = result.catch(() => undefined)
    return result
  }

  close(): void {
    this.closed = true
  }

  private execute(
    op: string,
    fields: Record<string, unknown>,
    options: ProviderRequestOptions,
  ): Promise<ProviderReply> {
    if (this.closed) {
      return Promise.reject(new ProviderTransportError('provider client is closed'))
    }
    if (typeof op !== 'string' || op.length === 0) {
      return Promise.reject(new ProviderTransportError('provider op is required'))
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const connectTimeoutMs = options.connectTimeoutMs ?? timeoutMs
    const id = this.nextId++
    const payload = `${JSON.stringify({ id, op, ...fields })}\n`

    return new Promise<ProviderReply>((resolve, reject) => {
      let settled = false
      let buffer = ''
      let timer: NodeJS.Timeout | undefined
      let connectTimer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        if (connectTimer !== undefined) clearTimeout(connectTimer)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        socket.destroy()
        reject(error)
      }
      const succeed = (reply: ProviderReply) => {
        if (settled) return
        settled = true
        cleanup()
        socket.end()
        resolve(reply)
      }

      const socket: Socket = connect(this.socketPath)
      connectTimer = setTimeout(
        () => fail(new ProviderTransportError(`provider connect timed out after ${connectTimeoutMs} ms`, { op, socketPath: this.socketPath })),
        connectTimeoutMs,
      )
      connectTimer.unref?.()

      socket.on('connect', () => {
        if (connectTimer !== undefined) clearTimeout(connectTimer)
        timer = setTimeout(
          () => fail(new ProviderTransportError(`provider request "${op}" timed out after ${timeoutMs} ms`, { op, id })),
          timeoutMs,
        )
        timer.unref?.()
        socket.write(payload)
      })

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        const reply = parseProviderReply(line)
        if (reply.id !== undefined && reply.id !== id) {
          // provider 按请求重放 id；不一致说明协议错位，不能“猜”是哪条。
          fail(new ProviderTransportError('provider reply id mismatch', { expected: id, actual: reply.id }))
          return
        }
        succeed(reply)
      })

      socket.on('error', (error) => {
        fail(new ProviderTransportError(`provider pipe error: ${(error as Error)?.message ?? error}`, { op, cause: error }))
      })

      socket.on('close', () => {
        if (!settled) {
          fail(new ProviderTransportError('provider pipe closed before reply', { op, id, buffer }))
        }
      })
    })
  }
}
