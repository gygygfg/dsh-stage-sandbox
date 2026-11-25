// @ts-nocheck —— 与既有测试脚本一致：纯 node 断言，不参与 tsc 严格检查。
/**
 * 审阅面的后果分级（`ReviewService.snapshot()`）—— 真实暂存链路，不是纯函数。
 *
 * 纯函数测试（`tests/severity.ts`）证明规则本身；这个套件证明规则真的接进了
 * `snapshot()`：面板/驱动拿到的 `level`、每行 `severityReasons`、以及注册表行的
 * 值预览字段，都来自同一次净 diff。如果只测纯函数，接线漏了也会绿。
 *
 * 用法：`node tests/review-severity.ts`
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReviewService } from '../dsh-plugin/review-service.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRATCH = mkdtempSync(join(REPO, '.t', 'review-severity-'))

let failures = 0
let assertions = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${ok || detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
}

const root = join(SCRATCH, 'ws')
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'README.md'), 'A'.repeat(200))
writeFileSync(join(root, 'src', 'a.py'), 'print(1)\n')

const svc = new ReviewService({ workspaceRoot: root, sessionId: 'review-severity', storeDir: join(SCRATCH, 'store') })
const ws = svc.reload()

process.stdout.write('=== 普通新增 ===\n')
ws.writeFile(join(root, 'out.txt'), 'ok\n')
{
  const snap = svc.snapshot()
  const row = (snap.files || []).find((item) => item.path === 'out.txt')
  check('out.txt 行存在', row !== undefined, JSON.stringify(snap.files?.map((f) => f.path)))
  check('普通新增 = L1', row?.level === 'L1', JSON.stringify(row))
  check('顶层 level = L1', snap.level === 'L1', String(snap.level))
}

process.stdout.write('\n=== 内容清零 ===\n')
ws.writeFile(join(root, 'README.md'), '')
{
  const snap = svc.snapshot()
  const row = (snap.files || []).find((item) => item.path === 'README.md')
  check('清零行 = L3', row?.level === 'L3', JSON.stringify(row))
  check('清零理由 CONTENT_WIPED', Array.isArray(row?.severityReasons) && row.severityReasons.some((reason) => reason.code === 'CONTENT_WIPED'), JSON.stringify(row?.severityReasons))
  check('顶层 level = L3', snap.level === 'L3', String(snap.level))
  check('levelCounts 有 L3', snap.levelCounts?.L3 >= 1, JSON.stringify(snap.levelCounts))
}

process.stdout.write('\n=== 删除 ===\n')
ws.remove(join(root, 'src', 'a.py'))
{
  const snap = svc.snapshot()
  const row = (snap.files || []).find((item) => item.path === 'src/a.py')
  check('删除行 = L2', row?.level === 'L2', JSON.stringify(row))
  check('删除理由 FILE_DELETE', Array.isArray(row?.severityReasons) && row.severityReasons.some((reason) => reason.code === 'FILE_DELETE'), JSON.stringify(row?.severityReasons))
}

process.stdout.write('\n=== .git 内部在阶段期被拒（不是审阅行）===\n')
{
  let denied = null
  try {
    ws.writeFile(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n')
  } catch (error) {
    denied = error
  }
  check('写 .git/hooks 被阶段拒绝', denied !== null && String(denied.code) === 'SANDBOX_GIT_INTERNAL', denied && String(denied.code))
}

rmSync(SCRATCH, { recursive: true, force: true })
process.stdout.write(`\n${assertions} 项断言，失败 ${failures} 项\n`)
process.exit(failures === 0 ? 0 : 1)
