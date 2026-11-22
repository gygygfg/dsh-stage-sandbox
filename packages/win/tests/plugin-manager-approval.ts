/**
 * A1a 套件：只读 `plugin_manager` 审批自动放行（纯分类 + 事件监听接线）。
 *
 * 零子进程、零文件、零网络；只调用本仓 `dsh-plugin/plugin-manager-approval.ts` 的纯函数，
 * 以及一个记录型假 `ctx`（不启动 Cordis）。
 *
 * 用法：node tests/plugin-manager-approval.ts
 */
import {
  READ_ONLY_PLUGIN_MANAGER_ACTIONS,
  classifyPluginManagerApproval,
  installPluginManagerReadOnlyApproval,
  parsePluginManagerArgs,
} from '../dsh-plugin/plugin-manager-approval.ts'

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

function reasonOf(action: string, extra: Record<string, unknown> = {}): string {
  const args = JSON.stringify({ action, ...extra })
  return `escalate sandbox to danger-full-access: plugin_manager ${args}. Profile changes persist across sessions; installed Host code runs outside the workspace sandbox.`
}

process.stdout.write('=== plugin-manager-approval ===\n')
process.stdout.write('[1] 只读动作白名单与解析\n')
ok(READ_ONLY_PLUGIN_MANAGER_ACTIONS.length === 3, '白名单恰有 3 个只读 action')
for (const action of READ_ONLY_PLUGIN_MANAGER_ACTIONS) {
  const parsed = parsePluginManagerArgs(reasonOf(action, { limit: 50 }))
  ok(parsed?.action === action, `解析 ${action}`, parsed)
  const decision = classifyPluginManagerApproval({ toolName: 'plugin_manager', reason: reasonOf(action) })
  ok(decision.kind === 'allow' && decision.action === action, `分类 ${action} => allow`, decision)
}

process.stdout.write('[2] 非只读/未知/非 plugin_manager 一律 pass\n')
for (const action of ['install_bundle', 'set_plugin', 'set_bundle', 'remove_bundle', 'set_version_exemption']) {
  const decision = classifyPluginManagerApproval({ toolName: 'plugin_manager', reason: reasonOf(action) })
  ok(decision.kind === 'pass', `分类 ${action} => pass`, decision)
}
ok(classifyPluginManagerApproval({ toolName: 'pwsh', reason: 'whatever' }).kind === 'pass', '非 plugin_manager => pass')
ok(classifyPluginManagerApproval({ toolName: 'plugin_manager', reason: 'no json here' }).kind === 'pass', '无 JSON => pass')
ok(classifyPluginManagerApproval({ toolName: 'plugin_manager', reason: 'plugin_manager {broken' }).kind === 'pass', '坏 JSON => pass')
ok(classifyPluginManagerApproval(null).kind === 'pass', '空请求 => pass')

process.stdout.write('[3] 字符串里的花括号不影响配对\n')
const tricky = `escalate sandbox to danger-full-access: plugin_manager {"action":"list_plugins","note":"a}b{c"}. trailing`
ok(parsePluginManagerArgs(tricky)?.action === 'list_plugins', '字符串内 }/{ 不截断 JSON')

process.stdout.write('[4] 监听器接线（假 ctx）\n')
{
  const handlers = new Map<string, { fn: Function; options?: { prepend?: boolean } }>()
  let disposed = 0
  const ctx = {
    on(name: string, fn: Function, options?: { prepend?: boolean }) {
      handlers.set(name, { fn, options })
      return () => { disposed += 1 }
    },
  }
  const queue = {
    enqueued: [] as any[],
    enqueue(request: any) {
      const record = { id: `ap_test_${this.enqueued.length + 1}`, ...request }
      this.enqueued.push(record)
      return record
    },
  }
  const dispose = installPluginManagerReadOnlyApproval(ctx as never, { isActive: () => true, queue: queue as never })
  const approval = handlers.get('approval/request')?.fn as ((request: unknown, next: () => Promise<string>) => Promise<string>) | undefined
  const execute = handlers.get('tools/execute')?.fn as ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  ok(typeof approval === 'function', '注册了 approval/request handler')
  ok(handlers.get('approval/request')?.options?.prepend === true, 'approval/request 以 prepend:true 注册')
  ok(typeof execute === 'function', '有 queue 时注册了 tools/execute handler')

  let nextCalls = 0
  const next = async () => { nextCalls += 1; return 'unavailable' }
  const allowed = await approval!({ toolName: 'plugin_manager', reason: reasonOf('list_plugins') }, next)
  ok(allowed === 'allowed-once' && nextCalls === 0, '只读请求 => allowed-once，且不调用 next', { allowed, nextCalls })

  nextCalls = 0
  const nonPlugin = await approval!({ toolName: 'pwsh', reason: 'escalate sandbox to workspace-write: need git metadata' }, next)
  ok(nonPlugin === 'rejected' && nextCalls === 0, 'A4 其他审批 => rejected（入队，不弹窗）', { nonPlugin, nextCalls })
  ok(queue.enqueued.at(-1)?.action === 'approval' && queue.enqueued.at(-1)?.toolName === 'pwsh', 'A4 其他审批入队且记录来源', JSON.stringify(queue.enqueued.at(-1)))

  nextCalls = 0
  const queued = await execute!(
    { name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'p', enabled: false }, agent: { session: { id: 's1' } }, callId: 'c1' },
    async () => { nextCalls += 1; return { isError: false, value: 'body-ran' } },
  ) as any
  ok(nextCalls === 0, '写动作不调用工具本体（不触发审批/不悬挂）', { nextCalls })
  ok(queued && queued.isError === false && String(queued.value).includes('queued'), '写动作返回非阻塞 queued 回执', JSON.stringify(queued))
  ok(queue.enqueued.length === 2 && queue.enqueued.at(-1).action === 'set_plugin', '写动作入队且记录 action', JSON.stringify(queue.enqueued))
  ok(queued?.meta?.winstage?.approvalId === queue.enqueued.at(-1).id, '回执带 approvalId', JSON.stringify(queued?.meta))

  nextCalls = 0
  await execute!({ name: 'plugin_manager', arguments: { action: 'list_plugins' } }, async () => { nextCalls += 1; return { isError: false, value: 'body' } })
  ok(nextCalls === 1, '只读动作交回工具本体', { nextCalls })
  nextCalls = 0
  await execute!({ name: 'other_tool', arguments: {} }, async () => { nextCalls += 1; return { isError: false, value: 'body' } })
  ok(nextCalls === 1, '非 plugin_manager 交回本体', { nextCalls })

  const before = disposed
  dispose()
  ok(disposed === before + 2, 'disposer 同时注销两个监听', { before, after: disposed })
}

process.stdout.write('[5] 监听器自身异常 fail-closed\n')
{
  let handler: ((request: unknown, next: () => Promise<string>) => Promise<string>) | undefined
  const ctx = { on(_n: string, fn: typeof handler) { if (_n === 'approval/request') handler = fn; return () => {} } }
  installPluginManagerReadOnlyApproval(ctx as never, {
    isActive: () => { throw new Error('boom') },
  })
  let nextCalls = 0
  const result = await handler!({ toolName: 'plugin_manager', reason: reasonOf('list_plugins') }, async () => {
    nextCalls += 1
    return 'unavailable'
  })
  ok(result === 'unavailable' && nextCalls === 1, 'isActive 抛错 => next()，不放行', { result, nextCalls })
}

process.stdout.write('[6] 队列写入失败 => fail-closed（不落回工具本体）\n')
{
  let execute: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = { on(_n: string, fn: typeof execute) { if (_n === 'tools/execute') execute = fn; return () => {} } }
  installPluginManagerReadOnlyApproval(ctx as never, {
    isActive: () => true,
    queue: { enqueue() { throw new Error('disk-full') } } as never,
  })
  let threw = false
  try {
    await execute!({ name: 'plugin_manager', arguments: { action: 'set_plugin', target: 'p', enabled: false } }, async () => ({ isError: false, value: 'body' }))
  } catch {
    threw = true
  }
  ok(threw, 'enqueue 抛错 => 包装器抛错（fail-closed）', String(threw))
}

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
