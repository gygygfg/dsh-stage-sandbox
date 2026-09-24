import { describe, expect, it } from 'vitest'
import { assertStartupBoundary, buildEnvironment, DEFAULT_INHERITED_RESOURCE_POLICY } from '../../src/control/launch.ts'

describe('startup boundary', () => {
  it('builds the environment from an allow-list instead of pruning the parent', () => {
    const environment = buildEnvironment({ PATH: '/bin', SECRET_TOKEN: 'leak', HTTP_PROXY: 'http://proxy' })
    expect(environment.PATH).toBe('/bin')
    expect(environment.SECRET_TOKEN).toBeUndefined()
    expect(environment.HTTP_PROXY).toBeUndefined()
  })

  it('refuses a launch whose inherited resources did not converge', () => {
    expect(assertStartupBoundary(DEFAULT_INHERITED_RESOURCE_POLICY)).toEqual({ ok: true })
    expect(assertStartupBoundary({ ...DEFAULT_INHERITED_RESOURCE_POLICY, closesUnauthorizedDescriptors: false })).toMatchObject({ ok: false })
    expect(assertStartupBoundary({ ...DEFAULT_INHERITED_RESOURCE_POLICY, environmentAllowList: false })).toMatchObject({ ok: false })
  })
})
