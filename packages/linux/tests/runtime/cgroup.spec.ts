import { describe, expect, it } from 'vitest'
import {
  CgroupDomain,
  cgroupAvailable,
  cgroupChain,
  listDomains,
  oomAttribution,
  oomBaseline,
  readOomCount,
  resolveLimits,
  type CgroupIo,
} from '../../src/runtime/cgroup.ts'
import type { LimitOptions } from '../../src/runtime/options.ts'

/** An in-memory cgroup filesystem. */
class MapIo implements CgroupIo {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>()

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }

  readFile(path: string): string | undefined {
    return this.files.get(path)
  }

  writeFile(path: string, content: string): boolean {
    this.files.set(path, content)
    return true
  }

  mkdir(path: string): boolean {
    this.dirs.add(path)
    return true
  }

  remove(path: string): void {
    for (const key of [...this.files.keys()]) if (key.startsWith(path)) this.files.delete(key)
    for (const dir of [...this.dirs]) if (dir.startsWith(path)) this.dirs.delete(dir)
  }

  list(path: string): string[] {
    const prefix = `${path.replace(/\/+$/u, '')}/`
    return [...this.dirs]
      .filter(dir => dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/'))
      .map(dir => dir.slice(prefix.length))
  }
}

const OPTIONS: LimitOptions = { enabled: true, memoryRatio: 0.5, pidsMax: 100, cpuMax: 50, cgroupBase: '/cg' }

describe('cgroup limit model', () => {
  it('counts oom_kill and oom_group_kill events', () => {
    expect(readOomCount('oom_kill 2\noom_group_kill 3\nmax 10')).toBe(5)
    expect(readOomCount(undefined)).toBe(0)
  })

  it('resolves memory from ratio or absolute cap and cpu from percent', () => {
    expect(resolveLimits(OPTIONS, 1000)).toEqual({ memoryMax: 500, pidsMax: 100, cpuQuota: 50_000 })
    const absolute = resolveLimits({ ...OPTIONS, memoryMaxBytes: 42, cpuMax: 0 }, 1000)
    expect(absolute.memoryMax).toBe(42)
    expect(absolute.cpuQuota).toBeUndefined()
  })

  it('builds the domain → ancestor → root chain', () => {
    expect(cgroupChain('/cg/dsh/x', '/cg')).toEqual(['/cg/dsh/x', '/cg/dsh', '/cg'])
  })
})

describe('cgroup OOM attribution', () => {
  const chain = ['/cg/dsh/x', '/cg/dsh', '/cg']

  function withEvents(values: readonly number[]): MapIo {
    const io = new MapIo()
    chain.forEach((path, index) => io.files.set(`${path}/memory.events`, `oom_kill ${values[index]}`))
    return io
  }

  it('blames the sandbox domain when the deepest counter rises', () => {
    const io = withEvents([0, 0, 0])
    const baseline = oomBaseline(chain, io)
    io.files.set('/cg/dsh/x/memory.events', 'oom_kill 1')
    expect(oomAttribution(chain, baseline, io)).toMatchObject({ oom: true, level: 'sandbox', oomKill: 1 })
  })

  it('blames an ancestor when only an outer counter rises', () => {
    const io = withEvents([0, 1, 5])
    const baseline = oomBaseline(chain, io)
    io.files.set('/cg/dsh/memory.events', 'oom_kill 2')
    expect(oomAttribution(chain, baseline, io)).toMatchObject({ oom: true, level: 'ancestor', path: '/cg/dsh', oomKill: 1 })
  })

  it('blames the root and reports no OOM when nothing changed', () => {
    const io = withEvents([0, 0, 0])
    const baseline = oomBaseline(chain, io)
    io.files.set('/cg/memory.events', 'oom_kill 7')
    expect(oomAttribution(chain, baseline, io)).toMatchObject({ oom: true, level: 'root', oomKill: 7 })
    expect(oomAttribution(chain, baseline, io).oom).toBe(true)
    const steady = oomBaseline(chain, io)
    expect(oomAttribution(chain, steady, io)).toEqual({ oom: false })
  })
})

describe('CgroupDomain', () => {
  it('is unavailable when the cgroup root is absent', () => {
    expect(cgroupAvailable('/cg', new MapIo())).toBe(false)
    expect(CgroupDomain.create('a', OPTIONS, new MapIo(), 1000)).toBeUndefined()
  })

  it('writes limits, adopts a process, kills, snapshots, and releases', () => {
    const io = new MapIo()
    io.files.set('/cg/cgroup.controllers', 'cpu memory pids')
    const domain = CgroupDomain.create('attempt 1', OPTIONS, io, 1000)
    expect(domain).toBeDefined()
    const d = domain as CgroupDomain
    expect(d.path).toBe('/cg/dsh/attempt_1')
    expect(io.files.get('/cg/dsh/attempt_1/memory.max')).toBe('500')
    expect(io.files.get('/cg/dsh/attempt_1/memory.swap.max')).toBe('0')
    expect(io.files.get('/cg/dsh/attempt_1/pids.max')).toBe('100')
    expect(io.files.get('/cg/dsh/attempt_1/cpu.max')).toBe('50000 100000')
    expect(d.addProcess(4242)).toBe(true)
    expect(io.files.get(d.procsPath())).toBe('4242')
    expect(d.kill()).toBe(true)
    expect(io.files.get('/cg/dsh/attempt_1/cgroup.kill')).toBe('1')
    io.files.set('/cg/dsh/attempt_1/memory.peak', '12345')
    expect(d.snapshot()).toMatchObject({ memoryPeak: '12345', memoryMax: '500' })
    d.release()
    expect(io.exists('/cg/dsh/attempt_1')).toBe(false)
  })

  it('lists domains for garbage collection', () => {
    const io = new MapIo()
    io.dirs.add('/cg/dsh')
    io.dirs.add('/cg/dsh/one')
    io.dirs.add('/cg/dsh/two')
    expect(listDomains('/cg', io)).toEqual(['/cg/dsh/one', '/cg/dsh/two'])
  })
})
