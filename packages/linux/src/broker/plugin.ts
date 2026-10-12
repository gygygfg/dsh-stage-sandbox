/**
 * The Cordis service wrapper around the external-operation broker and the
 * network gateway. It registers as `ctx.sandboxBroker`; adapters are
 * registered by their owning subsystem.
 * @module dsh-sandbox-linux/broker/plugin
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ExternalBroker } from './broker.ts'
import { NetworkGateway, type NetworkMode } from './network.ts'
import type { ExternalAdapter } from './types.ts'

/** Plugin config for the broker. */
export interface Config {
  /** Default network-grant lease, in milliseconds. */
  networkDefaultTtlMs?: number
  /** The explicit network mode; defaults to CONTROLLED_ONLINE. */
  networkMode?: NetworkMode
}

/**
 * The broker service. It owns the adapter table and the default-deny network
 * gateway.
 */
export class SandboxBrokerService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    networkDefaultTtlMs: z.natural().default(60_000),
    networkMode: z.union([z.const('OFFLINE'), z.const('CONTROLLED_ONLINE'), z.const('OBSERVED_ONLINE')]).default('CONTROLLED_ONLINE'),
  })

  /** The external-operation broker. */
  readonly broker: ExternalBroker
  /** The default-deny network gateway. */
  readonly network: NetworkGateway

  /**
   * @param ctx - the plugin context.
   * @param config - the network-grant default lifetime.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxBroker')
    this.broker = new ExternalBroker()
    this.network = new NetworkGateway(config.networkMode ?? 'CONTROLLED_ONLINE')
    ctx.logger.info(`sandbox-broker: network mode ${this.network.networkMode}, default ttl ${config.networkDefaultTtlMs as number}ms`)
  }

  /**
   * Register an external adapter.
   * @param adapter - the adapter.
   * @returns the disposer.
   */
  registerAdapter(adapter: ExternalAdapter): () => void {
    return this.broker.register(adapter)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxBroker: SandboxBrokerService
  }
}

export default SandboxBrokerService
