/**
 * A3 套件：批准后重放 plugin_manager 意图的纯执行器。
 *
 * 零子进程、零网络；用假 manager 断言调用参数与失败语义。
 * 用法：node tests/approval-execute.ts
 */
import { executeApprovalIntent } from '../dsh-plugin/approval-execute.ts'

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

process.stdout.write('=== approval-execute ===\n')

const calls: any[] = []
const manager = {
  async setPluginEnabled(...args: any[]) { calls.push(['setPluginEnabled', ...args]); return { application: 'applied', id: args[0] } },
  async setBundleEnabled(...args: any[]) { calls.push(['setBundleEnabled', ...args]); return { application: 'applied', id: args[0] } },
  async removeBundle(...args: any[]) { calls.push(['removeBundle', ...args]); return { application: 'applied', id: args[0] } },
  async setVersionExemption(...args: any[]) { calls.push(['setVersionExemption', ...args]); return { ok: true, args } },
  async fail() { throw new Error('boom') },
}

const setPlugin = await executeApprovalIntent(manager, { action: 'set_plugin', args: { target: 'p', enabled: false } })
ok(setPlugin.ok === true && calls.at(-1)?.[0] === 'setPluginEnabled' && calls.at(-1)?.[1] === 'p' && calls.at(-1)?.[2] === false, 'set_plugin 调用 setPluginEnabled(target,false)', JSON.stringify(setPlugin))

const setBundle = await executeApprovalIntent(manager, { action: 'set_bundle', args: { target: 'b', enabled: true } })
ok(setBundle.ok === true && calls.at(-1)?.[0] === 'setBundleEnabled' && calls.at(-1)?.[2] === true, 'set_bundle 调用 setBundleEnabled(target,true)', JSON.stringify(setBundle))

const remove = await executeApprovalIntent(manager, { action: 'remove_bundle', args: { target: 'b' } })
ok(remove.ok === true && calls.at(-1)?.[0] === 'removeBundle', 'remove_bundle 调用 removeBundle', JSON.stringify(remove))

const exemption = await executeApprovalIntent(manager, { action: 'set_version_exemption', args: { target: 'p@1', runtimeVersion: '0.2.2', enabled: true, acceptRisk: true } })
ok(exemption.ok === true && calls.at(-1)?.[0] === 'setVersionExemption' && calls.at(-1)?.[4] === true, 'set_version_exemption 透传 acceptRisk', JSON.stringify(exemption))

const install = await executeApprovalIntent(manager, { action: 'install_bundle', args: { target: 'x' } })
ok(install.ok === false && /需要交互式重试/.test(install.reason), 'install_bundle 不自动执行（明确失败）', JSON.stringify(install))

const missingTarget = await executeApprovalIntent(manager, { action: 'set_plugin', args: {} })
ok(missingTarget.ok === false && /缺少 target/.test(missingTarget.reason), '缺少 target => 明确失败', JSON.stringify(missingTarget))

const noManager = await executeApprovalIntent(undefined, { action: 'set_plugin', args: { target: 'p' } })
ok(noManager.ok === false && /服务不可用/.test(noManager.reason), '无 manager => 明确失败', JSON.stringify(noManager))

const partialManager = { setPluginEnabled: async () => { throw new Error('service-down') } }
const thrown = await executeApprovalIntent(partialManager, { action: 'set_plugin', args: { target: 'p', enabled: true } })
ok(thrown.ok === false && /service-down/.test(thrown.reason), '执行抛错 => ok:false 并保留原因', JSON.stringify(thrown))

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
