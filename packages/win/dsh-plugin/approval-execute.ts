// @ts-nocheck —— 与 host-plugin.ts 同一过渡策略。
/**
 * A3：用户批准后重放 `plugin_manager` 写意图的纯执行器。
 *
 * 只做可安全重放的 set/remove；`install_bundle`（交互式下载/构建脚本）明确要求用户
 * 手动重试，不在这里偷偷执行。所有失败返回 `{ok:false, reason}`，绝不伪装成功。
 *
 * @module winstage-sandbox/approval-execute
 */

/**
 * @param {object|undefined} manager `pluginManager` 服务
 * @param {{action?:string,args?:object}} item 队列 request record
 * @returns {Promise<{ok:boolean, action?:string, reason?:string, result?:unknown}>}
 */
export async function executeApprovalIntent(manager, item) {
  if (!manager || typeof manager !== 'object') return { ok: false, reason: 'pluginManager 服务不可用' }
  const args = item?.args && typeof item.args === 'object' ? item.args : {}
  try {
    switch (item?.action) {
      case 'set_plugin':
        if (typeof args.target !== 'string') return { ok: false, reason: 'set_plugin 缺少 target' }
        if (typeof manager.setPluginEnabled !== 'function') return { ok: false, reason: 'pluginManager 不支持 setPluginEnabled' }
        return { ok: true, action: item.action, result: await manager.setPluginEnabled(args.target, args.enabled === true) }
      case 'set_bundle':
        if (typeof args.target !== 'string') return { ok: false, reason: 'set_bundle 缺少 target' }
        if (typeof manager.setBundleEnabled !== 'function') return { ok: false, reason: 'pluginManager 不支持 setBundleEnabled' }
        return { ok: true, action: item.action, result: await manager.setBundleEnabled(args.target, args.enabled === true) }
      case 'remove_bundle':
        if (typeof args.target !== 'string') return { ok: false, reason: 'remove_bundle 缺少 target' }
        if (typeof manager.removeBundle !== 'function') return { ok: false, reason: 'pluginManager 不支持 removeBundle' }
        return { ok: true, action: item.action, result: await manager.removeBundle(args.target) }
      case 'set_version_exemption':
        if (typeof args.target !== 'string' || typeof args.runtimeVersion !== 'string' || typeof args.enabled !== 'boolean') {
          return { ok: false, reason: 'set_version_exemption 参数不完整' }
        }
        if (typeof manager.setVersionExemption !== 'function') return { ok: false, reason: 'pluginManager 不支持 setVersionExemption' }
        return {
          ok: true,
          action: item.action,
          result: await manager.setVersionExemption(args.target, args.runtimeVersion, args.enabled, args.acceptRisk === true),
        }
      default:
        return { ok: false, reason: `action ${String(item?.action)} 需要交互式重试，未自动执行` }
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}
