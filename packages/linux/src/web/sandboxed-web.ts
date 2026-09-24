/**
 * Sandboxed web runtime (v2.3). It replaces `ctx.web` so model-facing web
 * tools are authorized by the plugin's network gateway instead of reaching the
 * network unconditionally. The gateway's mode is explicit: `OFFLINE` blocks all
 * egress, `CONTROLLED_ONLINE` requires a covering grant, and `OBSERVED_ONLINE`
 * allows a proxy-style path but honestly reports that direct egress is not
 * forcibly constrained. Local, link-local, and cloud-metadata targets are
 * always rejected.
 *
 * The providers perform the actual I/O outside the confinement boundary, so
 * this seam is an authorization and observation layer, not an enforcement one;
 * that limit is what `OBSERVED_ONLINE` states.
 * @module dsh-sandbox-linux/web/sandboxed-web
 */

import { Context } from '@deepseek-ai/cordis'
import { WebError, WebRuntime } from '@deepseek-ai/dsh-web'
import type { WebFetchRequest, WebFetchResult, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type {} from '../broker/plugin.ts'
import { isProhibitedTarget, type NetworkEndpoint } from '../broker/network.ts'

/** The default port for a URL with no explicit port. */
function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * The sandboxed web runtime. It delegates provider selection and execution to
 * the harness web runtime and adds a network authorization check per fetch.
 */
export class SandboxedWebRuntime extends WebRuntime {
  static inject = ['sandboxBroker']

  /**
   * @param ctx - the plugin context; `ctx.sandboxBroker` must be mounted.
   * @param config - the provider selection config, passed through.
   */
  constructor(ctx: Context, config: ConstructorParameters<typeof WebRuntime>[1] = {}) {
    super(ctx, config)
  }

  /** The network mode the gateway is configured with. */
  get networkMode(): string {
    return this.ctx.sandboxBroker.network.networkMode
  }

  /** @inheritdoc */
  override async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const endpoint = this.endpointFor(request.url)
    const decision = this.ctx.sandboxBroker.network.authorize({ endpoint, txBytes: 0, rxBytes: 0, requiresForcedBlock: false })
    if (decision.kind === 'deny') {
      throw new WebError(`web fetch blocked by the sandbox network gateway: ${decision.reason}`, 'WEB_NETWORK_DENIED')
    }
    return super.fetch(request, signal)
  }

  /** @inheritdoc */
  override async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Search is provider-mediated and carries no model-supplied URL; only an
    // OFFLINE deployment blocks it outright.
    if (this.ctx.sandboxBroker.network.networkMode === 'OFFLINE') {
      throw new WebError('web search blocked: network mode OFFLINE', 'WEB_NETWORK_DENIED')
    }
    return super.search(request, signal)
  }

  /** Build the network endpoint for a fetch URL, rejecting non-HTTP schemes. */
  private endpointFor(url: string): NetworkEndpoint {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new WebError(`web fetch received an invalid URL: ${url}`, 'WEB_INVALID_URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new WebError(`web fetch only supports http/https, got ${parsed.protocol}`, 'WEB_INVALID_URL')
    }
    if (isProhibitedTarget(parsed.hostname)) {
      throw new WebError(`web fetch to '${parsed.hostname}' is a prohibited local or metadata address`, 'WEB_NETWORK_DENIED')
    }
    return { host: parsed.hostname, port: portOf(parsed), protocol: 'tcp', direction: 'egress' }
  }
}

export default SandboxedWebRuntime
