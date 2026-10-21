/**
 * R41-UX-02：面板 `/trust` 是纯查看，不得把"刷新了几次"写成"失根次数"。
 *
 * 红（修前）：`buildTrustCard({storeDir})`（面板路径）每次调用都会
 *   `noteStageRootLoss()` 写 `sandbox-lane.json`，count 每次 +1；
 * 绿：`recordLoss:false` 不写盘、count 保持历史值；默认（命令面）仍按显式观测记账。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { buildTrustCard } from '../dsh-plugin/host-plugin.ts'
import { LANE_JOURNAL_BASENAME } from '../dsh-plugin/shell-executor.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH = join(HERE, '..', '.t', 'ux-r41-trust-loss')
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

let checks = 0
let failures = 0
const check = (name, ok, detail) => {
  checks += 1
  if (!ok) failures += 1
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}

const dir = join(SCRATCH, 'store')
mkdirSync(dir, { recursive: true })
const laneFile = join(dir, LANE_JOURNAL_BASENAME)
writeFileSync(laneFile, JSON.stringify({ version: 1, seq: 4, at: '2026-01-01T00:00:00.000Z' }))
const before = readFileSync(laneFile)

const viewed = buildTrustCard({ storeDir: dir, recordLoss: false })
const afterView = readFileSync(laneFile)
check(
  'U1 面板 recordLoss:false 不写 lane journal（字节不变）',
  Buffer.compare(before, afterView) === 0 && viewed.stageRoot.lossCount === 0,
  JSON.stringify({ same: Buffer.compare(before, afterView) === 0, count: viewed.stageRoot.lossCount, alive: viewed.stageRoot.alive }),
)

const viewedAgain = buildTrustCard({ storeDir: dir, recordLoss: false })
check(
  'U2 连续刷新两次仍不增加失根计数（0 → 0）',
  viewedAgain.stageRoot.lossCount === 0 && Buffer.compare(before, readFileSync(laneFile)) === 0,
  JSON.stringify({ count: viewedAgain.stageRoot.lossCount }),
)

const observed = buildTrustCard({ storeDir: dir })
const observedRecord = JSON.parse(readFileSync(laneFile, 'utf8'))
check(
  'U3 命令面显式观测（默认 recordLoss=true）仍记账 1 次',
  observed.stageRoot.lossCount === 1 && observedRecord?.history?.rootLoss?.count === 1 && existsSync(laneFile),
  JSON.stringify({ cardCount: observed.stageRoot.lossCount, journalCount: observedRecord?.history?.rootLoss?.count }),
)

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures ? 1 : 0)
