// @ts-nocheck —— 与 host-plugin.ts 同一过渡策略：运行期由 esbuild 打包，类型后补。
/**
 * 只读 `plugin_manager` 审批的自动放行（A1a）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * DSH 0.2.2-rc.5 的 `plugin_manager` 在 `execute()` 一开始就无条件调用
 * `approveEscalation({ requestedMode: 'danger-full-access' })`，包括
 * `list_plugins` / `list_bundles` / `list_version_exemptions` 这些**只读**动作
 * （安装目录内 `dsh-plugin-manager/src/tools.ts:105-112`）。
 * 结果：无人值守会话一调 `plugin_manager list_plugins` 就弹旧审批框，整轮停住。
 *
 * ── 为什么在 `approval/request` 上拦 ────────────────────────────────────────
 * DSH 的 `approval/request` 是 Cordis waterfall（`dsh-user-approval/src/index.ts:293-333`）：
 * 插件可以用 `{ prepend: true }` 在客户端 answerer 之前 claim，返回
 * `allowed-once` 后客户端不会再看到弹窗。这里只对**参数可证明是只读**的
 * `plugin_manager` 调用放行；其余一律 `next()` 交回平台，绝不扩大权限。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────────
 * - reason 由工具自己拼：`escalate sandbox to ...: plugin_manager <JSON>. ...`；
 *   JSON 里的 action 来自模型参数，但 action 枚举只允许工具自己执行对应分支。
 * - 只放行白名单 action；解析失败/未知 action/非 plugin_manager ⇒ `next()`。
 * - 本模块不修改工具、不写文件、不依赖网络；纯分类 + 一个事件监听。
 *
 * @module winstage-sandbox/plugin-manager-approval
 */

/** 明确只读、可安全自动放行的 `plugin_manager` action。 */
export const READ_ONLY_PLUGIN_MANAGER_ACTIONS = Object.freeze([
  'list_plugins',
  'list_bundles',
  'list_version_exemptions',
])

/** 从 `plugin_manager <JSON>` 的 reason 中提取参数；失败返回 null。 */
export function parsePluginManagerArgs(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return null
  const marker = reason.indexOf('plugin_manager ')
  if (marker < 0) return null
  const start = reason.indexOf('{', marker + 'plugin_manager '.length)
  if (start < 0) return null
  const json = extractJsonObject(reason, start)
  if (json === null) return null
  try {
    const args = JSON.parse(json)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
    return args
  } catch {
    return null
  }
}

/**
 * 从 `start` 的 `{` 开始做**字符串感知**的括号配对，返回完整 JSON 文本。
 * 不能简单 `lastIndexOf('}')`：justification 后面还有英文句子，且参数里可能含 `}`。
 * @param {string} text
 * @param {number} start
 * @returns {string|null}
 */
function extractJsonObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
      if (depth < 0) return null
    }
  }
  return null
}

/**
 * 分类一条审批请求。
 * @returns {{kind:'allow', action:string, args:object} | {kind:'pass'}}
 */
export function classifyPluginManagerApproval(request) {
  if (!request || typeof request !== 'object') return { kind: 'pass' }
  if (String(request.toolName ?? '') !== 'plugin_manager') return { kind: 'pass' }
  const args = parsePluginManagerArgs(request.reason)
  if (args === null) return { kind: 'pass' }
  const action = typeof args.action === 'string' ? args.action : ''
  if (!READ_ONLY_PLUGIN_MANAGER_ACTIONS.includes(action)) return { kind: 'pass' }
  return { kind: 'allow', action, args }
}

/**
 * 分类一条 `tools/execute` 调用：只读 action 交给工具本体（并由 approval listener
 * 自动放行），其余 `plugin_manager` action 入队并返回“已提交，等待确认”。
 * @returns {{kind:'pass'} | {kind:'queue', action:string, args:object}}
 */
export function classifyPluginManagerExecution(exec) {
  if (!exec || typeof exec !== 'object') return { kind: 'pass' }
  if (String(exec.name ?? '') !== 'plugin_manager') return { kind: 'pass' }
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { kind: 'pass' }
  const action = typeof args.action === 'string' ? args.action : ''
  if (action.length === 0 || READ_ONLY_PLUGIN_MANAGER_ACTIONS.includes(action)) return { kind: 'pass' }
  return { kind: 'queue', action, args }
}

/**
 * 注册 `approval/request` 监听：只读 `plugin_manager` 直接放行，其余交回平台。
 *
 * 若传入 `queue`，额外注册 `tools/execute` 包装：`plugin_manager` 的写动作在**工具本体
 * 执行前**入队并返回中性回执，因此不会触发审批弹窗，也不会悬挂。只读动作仍走本体。
 *
 * @param {object} ctx Cordis context（宿主侧；必须有 `on`）。
 * @param {object} options
 * @param {(message:string)=>void} [options.log] 用户侧日志（不进模型可见面）。
 * @param {() => boolean} [options.isActive] 现读 WinStage 开关；返回 false 时完全不介入。
 * @param {{enqueue:Function}} [options.queue] 持久化队列；缺省时只做只读放行（兼容旧调用）。
 * @returns {() => void} disposer；失败时也返回安全空函数。
 */
export function installPluginManagerReadOnlyApproval(ctx, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const isActive = typeof options.isActive === 'function' ? options.isActive : () => true
  if (!ctx || typeof ctx.on !== 'function') return () => {}

  let offApproval
  let offExecute
  try {
    offApproval = ctx.on('approval/request', async (request, next) => {
      if (typeof next !== 'function') return 'unavailable'
      try {
        if (!isActive()) return next()
        if (request?.signal?.aborted) return next()
        const decision = classifyPluginManagerApproval(request)
        if (decision.kind === 'allow') {
          // 只读白名单：放行本次调用。客户端 answerer 不再收到该请求 ⇒ 不弹窗。
          log(`[winstage] auto-allow read-only plugin_manager.${decision.action} (A1a)`)
          return 'allowed-once'
        }
        // A4：其他审批来源（pwsh 升权 / MCP / 网络 / 未知工具）不弹窗，入队后立即
        // 以 rejected 结束本次调用。模型看到原生拒绝，可继续；用户可稍后用
        // /winstage approvals 查看。不可重放的来源在批准时明确要求人工重试。
        if (options.queue && typeof options.queue.enqueue === 'function') {
          let entry
          try {
            entry = options.queue.enqueue({
              sessionId: typeof request?.agent?.session?.id === 'string' ? request.agent.session.id : '',
              toolName: String(request?.toolName ?? 'unknown'),
              action: 'approval',
              args: { reason: String(request?.reason ?? '') },
              reason: String(request?.reason ?? ''),
            })
          } catch (queueError) {
            // 队列不可用 ⇒ 立即拒绝（fail-closed），绝不回退到阻塞弹窗。
            try {
              log(`[winstage] approval queue unavailable: ${String(queueError?.message ?? queueError)}`)
            } catch {
              /* best effort */
            }
            return 'rejected'
          }
          log(`[winstage] queued non-plugin_manager approval ${entry.id} (${String(request?.toolName ?? 'unknown')}) (A4)`)
          return 'rejected'
        }
        return next()
      } catch (error) {
        // 分类器自身的任何异常都不得改变审批结局：交回平台，保持 fail-closed。
        try {
          log(`[winstage] plugin_manager approval classifier failed: ${String(error?.message ?? error)}`)
        } catch {
          /* best effort */
        }
        return next()
      }
    }, { prepend: true })
  } catch (error) {
    try {
      log(`[winstage] failed to register plugin_manager approval listener: ${String(error?.message ?? error)}`)
    } catch {
      /* best effort */
    }
    return () => {}
  }

  // A3：写动作在工具体之前入队，返回“已提交，等待确认（尚未执行）”。
  if (options.queue && typeof options.queue.enqueue === 'function' && typeof ctx.on === 'function') {
    try {
      offExecute = ctx.on('tools/execute', async (exec, next) => {
        if (typeof next !== 'function') throw new Error('tools/execute next() is unavailable')
        try {
          if (!isActive()) return next()
          const decision = classifyPluginManagerExecution(exec)
          if (decision.kind !== 'queue') return next()
          const entry = options.queue.enqueue({
            sessionId: typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : '',
            toolName: 'plugin_manager',
            action: decision.action,
            args: decision.args,
            reason: typeof exec?.callId === 'string' ? `callId=${exec.callId}` : '',
          })
          log(`[winstage] queued plugin_manager.${decision.action} as ${entry.id} (A3)`)
          const receipt = {
            status: 'queued',
            id: entry.id,
            action: decision.action,
            message: '已提交，等待确认（尚未执行）',
          }
          return {
            isError: false,
            value: JSON.stringify(receipt),
            content: [{
              type: 'text',
              text: `已提交，等待确认（尚未执行）。审批项 ${entry.id}；用 /winstage approvals 查看。`,
            }],
            meta: { winstage: { approvalId: entry.id, queued: true, action: decision.action } },
          }
        } catch (error) {
          // 队列/回执失败必须 fail-closed，绝不能落回工具本体去触发弹窗。
          try {
            log(`[winstage] async approval queue failed: ${String(error?.message ?? error)}`)
          } catch {
            /* best effort */
          }
          throw new Error('审批队列不可用，已拒绝执行（fail-closed）')
        }
      })
    } catch (error) {
      try {
        log(`[winstage] failed to register tools/execute queue listener: ${String(error?.message ?? error)}`)
      } catch {
        /* best effort */
      }
    }
  }

  return () => {
    try {
      offApproval?.()
    } catch {
      /* disposal must not throw */
    }
    try {
      offExecute?.()
    } catch {
      /* disposal must not throw */
    }
  }
}
