/**
 * A2 套件：异步审批队列（只追加 JSONL）的入队/折叠/决策/幂等。
 *
 * 零子进程、零网络；只在 `.t` 下写临时目录。
 * 用法：node tests/approval-queue.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApprovalQueue, APPROVAL_QUEUE_BASENAME } from '../dsh-plugin/approval-queue.ts'

let checks = 0
let failures = 0
function ok(condition: boolean, label: string, detail?: unknown): void {
  checks += 1
  if (condition) process.stdout.write(`  ✓ ${label}\n`)
  else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}\n`)
  }
}

const root = join(process.cwd(), '.t', `a2-queue-${process.pid}-${Date.now()}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
process.stdout.write('=== approval-queue ===\n')

try {
  const queue = createApprovalQueue(root)
  const a = queue.enqueue({ sessionId: 's1', toolName: 'plugin_manager', action: 'set_plugin', args: { target: 'p', enabled: false } })
  const b = queue.enqueue({ sessionId: 's2', toolName: 'plugin_manager', action: 'set_bundle', args: { target: 'b', enabled: true } })
  ok(typeof a.id === 'string' && a.id.startsWith('ap_'), 'enqueue 返回 ap_ id', a.id)
  ok(queue.listPending().length === 2, '两个待处理项', JSON.stringify(queue.listPending().map((x) => x.id)))
  ok(queue.get(a.id)?.action === 'set_plugin', 'get 读回 action', JSON.stringify(queue.get(a.id)))
  ok(existsSync(join(root, '.dshstage', APPROVAL_QUEUE_BASENAME)), '队列落在 .dshstage/async-approvals.jsonl')
  ok(!existsSync(join(root, '.dshstage', `${APPROVAL_QUEUE_BASENAME}.lock`)), '写后锁文件已释放（B3）')

  const first = queue.decide(a.id, 'approved', { by: 'user', result: { ok: true } })
  ok(first.ok === true && first.idempotent === false, '首次决策写入', JSON.stringify(first))
  ok(queue.listPending().map((x) => x.id).join(',') === b.id, '决策后从 pending 消失', JSON.stringify(queue.listPending().map((x) => x.id)))
  const again = queue.decide(a.id, 'rejected', { by: 'user' })
  ok(again.ok === true && again.idempotent === true && again.decision.outcome === 'approved', '同 id 决策幂等（保留 first）', JSON.stringify(again))

  // 两个独立实例共享同一文件状态
  const queue2 = createApprovalQueue(root)
  ok(queue2.listPending().length === 1 && queue2.get(a.id)?.decision?.outcome === 'approved', '新实例折叠同一 JSONL', JSON.stringify(queue2.listAll().map((x) => [x.id, x.decision?.outcome])))

  // 坏行跳过，不影响后续行
  writeFileSync(join(root, '.dshstage', APPROVAL_QUEUE_BASENAME), `${readFileSync(join(root, '.dshstage', APPROVAL_QUEUE_BASENAME), 'utf8')}\n{broken\n`, 'utf8')
  ok(queue.listPending().length === 1, '损坏行被跳过', JSON.stringify(queue.listPending().map((x) => x.id)))
  ok(queue.decide('missing', 'approved').ok === false, '未知 id 决策失败', JSON.stringify(queue.decide('missing', 'approved')))
} finally {
  rmSync(root, { recursive: true, force: true })
}

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
