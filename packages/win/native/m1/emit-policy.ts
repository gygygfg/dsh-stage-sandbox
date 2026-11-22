/**
 * 生成 M1 端到端测试用的策略二进制 + 摘要（在宿主 Linux 上跑）。
 *
 *   node native/m1/emit-policy.ts --out <dir> \
 *     --workspace 'C:\m1\ws' --view 'C:\m1\view' --store 'C:\m1\store' \
 *     --domain d1 --generation 1
 *
 * 输出 <dir>/policy.bin 与 <dir>/policy.json（generation/hash/bytes/domain）。
 * 这是控制面唯一的策略编码实现（驱动只认这份字节）。
 *
 * @module winstage-sandbox/native/m1/emit-policy
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDomainPolicy } from '../../src/nt/provider.ts'
import { encodePolicy } from '../../src/nt/policy-binary.ts'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const outDir = arg('out', '.')
const workspace = arg('workspace', 'C:\\m1\\ws')
const view = arg('view', 'C:\\m1\\view')
const store = arg('store', 'C:\\m1\\store')
const domainId = arg('domain', 'd1')
const generation = Number(arg('generation', '1'))

const { domain, policy } = buildDomainPolicy({
  workspaceRoot: workspace,
  viewRoot: view,
  storeRoot: store,
  domainId,
  generation,
  network: 'offline',
  tokenMode: 'restricted',
  extraRules: [
    {
      id: 'm1-secret-deny',
      type: 'secret',
      match: { kind: 'prefix', path: `${workspace}\\secret` },
      access: ['read', 'write', 'delete', 'rename', 'attribute', 'execute'],
      action: 'deny',
    },
  ],
})

// globalMask：被遮蔽的路径对读/写都“不存在”。
policy.globalMasks = [{ kind: 'exact', path: `${workspace}\\masked.txt` }]

const encoded = encodePolicy(policy)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'policy.bin'), encoded.payload)
writeFileSync(
  join(outDir, 'policy.json'),
  `${JSON.stringify(
    {
      domainId: domain.id,
      generation: encoded.generation,
      hash: encoded.hash,
      bytes: encoded.payload.length,
      rules: encoded.stats.rules,
      masks: encoded.stats.masks,
      workspace,
      view,
      store,
    },
    null,
    2,
  )}\n`,
)

process.stdout.write(
  `policy.bin ${encoded.payload.length} bytes generation=${encoded.generation} hash=${encoded.hash.slice(0, 16)}…\n`,
)
