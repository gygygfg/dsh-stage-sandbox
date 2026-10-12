import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { NetworkGateway } from '../../src/broker/network.ts'
import { SandboxedWebRuntime } from '../../src/web/sandboxed-web.ts'

class FakeBroker extends Service {
  readonly network: NetworkGateway
  constructor(ctx: Context, mode: 'OFFLINE' | 'CONTROLLED_ONLINE' | 'OBSERVED_ONLINE') {
    super(ctx, 'sandboxBroker')
    this.network = new NetworkGateway(mode)
  }
}

describe('sandboxed web runtime', () => {
  it('rejects local and metadata targets', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeBroker as never, 'OBSERVED_ONLINE' as never)
    await ctx.plugin(SandboxedWebRuntime as never, { searchProvider: 's', fetchProvider: 'f' } as never)
    await expect(ctx.web.fetch({ url: 'http://169.254.169.254/latest/meta-data' })).rejects.toMatchObject({ code: 'WEB_NETWORK_DENIED' })
    await expect(ctx.web.fetch({ url: 'http://localhost:8080/' })).rejects.toMatchObject({ code: 'WEB_NETWORK_DENIED' })
  })

  it('blocks everything under OFFLINE, including search', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeBroker as never, 'OFFLINE' as never)
    await ctx.plugin(SandboxedWebRuntime as never, { searchProvider: 's', fetchProvider: 'f' } as never)
    await expect(ctx.web.fetch({ url: 'https://example.com/' })).rejects.toMatchObject({ code: 'WEB_NETWORK_DENIED' })
    await expect(ctx.web.search({ query: 'anything' })).rejects.toMatchObject({ code: 'WEB_NETWORK_DENIED' })
  })
})
