/**
 * ProjFS provider 控制协议（TS 侧常量与解析）。
 *
 * 与 `native/provider/src/ControlServer.cs` 一致：命名管道，一行 JSON 请求 / 一行 JSON 回复。
 * 这里只放**纯函数/常量**，便于在 Linux 上单测；连接与生命周期在 `provider-client.ts`。
 *
 * @module winstage-sandbox/nt/provider-protocol
 */

/** 默认管道名（与 provider 的 `--pipe` 默认值一致）。 */
export const DEFAULT_PROVIDER_PIPE = 'dshnt-provider'

/** Windows 命名管道路径；其它平台返回 undefined（测试可直接用 Unix socket 路径）。 */
export function providerSocketPath(
  pipeName: string = DEFAULT_PROVIDER_PIPE,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : undefined
}

/** 一行回复。`ok=false` 时 `error` 必有值（provider 的约定）。 */
export interface ProviderReply {
  id?: number
  ok: boolean
  error?: string
  [key: string]: unknown
}

/**
 * 解析一行回复。坏 JSON 不抛成“未知异常”，而是收成 `ok:false` + 原因，
 * 让调用方按“provider 不可用”处理（fail-closed）。
 */
export function parseProviderReply(line: string): ProviderReply {
  try {
    const parsed = JSON.parse(line) as unknown
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, error: 'provider reply is not an object' }
    }
    const reply = parsed as ProviderReply
    if (typeof reply.ok !== 'boolean') {
      return { ok: false, error: 'provider reply is missing boolean "ok"', reply }
    }
    return reply
  } catch (error) {
    return { ok: false, error: `bad provider reply: ${(error as Error)?.message ?? error}` }
  }
}
