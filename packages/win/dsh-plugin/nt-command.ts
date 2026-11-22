/**
 * `/winstage nt` 命令面（状态与诊断）。
 *
 * 只做两件事，且都**只读**：
 *   · `status` —— 用与 `ctx.sandbox` 相同的判据回答“内核路径此刻是否就绪”；
 *   · `doctor` —— 逐项列出驱动/ProjFS/provider/策略/网络的**机器事实**与修复动作。
 *
 * 不在这里下发策略、不启动 provider、不创建沙箱：v1 的 NT 后端尚未接管执行链，
 * 把诊断命令做成“顺手初始化”会让用户误以为沙箱已经生效。
 *
 * @module winstage-sandbox/dsh-plugin/nt-command
 */

import { isNtError } from '../src/nt/types.ts'
import { renderNtDoctor, renderNtStatus, type NtRuntime } from '../src/nt/runtime.ts'
import type { NtSupervisor } from '../src/nt/supervisor.ts'

/** 运行时提供者：命令执行时才装配（避免加载插件就去碰驱动/管道）。 */
export type NtRuntimeProvider = () => Promise<NtRuntime>

export interface NtCommandDeps {
  runtime: NtRuntimeProvider
  /** 数据面生命周期（up/down）；未接线时 up/down 明确报错。 */
  supervisor?: () => Promise<NtSupervisor>
  log?: { warn?: (message: string) => void }
}

export interface NtCommandResult {
  kind: 'success' | 'error'
  text: string
}

export const NT_USAGE =
  '用法：/winstage nt status（内核路径就绪情况）| doctor（逐项诊断）| up（启动 driver/provider/策略/域）| down（收起）'

/** 执行一个 `/winstage nt` 子命令。未知子命令返回用法，不抛异常。 */
export async function runNtCommand(sub: string | undefined, deps: NtCommandDeps): Promise<NtCommandResult> {
  const command = (sub ?? 'status').trim().toLowerCase()
  if (command === '' || command === 'help' || command === '-h') {
    return { kind: 'success', text: NT_USAGE }
  }
  if (!['status', 'doctor', 'up', 'down'].includes(command)) {
    return { kind: 'error', text: `未知子命令 "${sub}"；${NT_USAGE}` }
  }
  try {
    if (command === 'up' || command === 'down') {
      if (typeof deps.supervisor !== 'function') {
        return { kind: 'error', text: 'NT 数据面生命周期未接线：宿主没有提供 supervisor。' }
      }
      const supervisor = await deps.supervisor()
      if (command === 'down') {
        await supervisor.down()
        return { kind: 'success', text: 'NT 数据面已收起（域已注销；provider 已停止；真实工作区未被改动）。' }
      }
      const state = await supervisor.up()
      const status = supervisor.status() ?? (await (await deps.runtime()).probe())
      const lines = [
        `NT 数据面已拉起：domain=${state.domainId ?? '?'} generation=${state.policyGeneration ?? '?'}` +
          (state.providerPid === undefined ? '' : ` providerPid=${state.providerPid}`),
        '',
        renderNtStatus(status),
        '',
        '注意：网络闸门按子进程安装（launcher 持有 WFP 会话，失败即拒绝启动）；' +
          'ctx.fs/ctx.shell 的路径切换仍未接管（M2 下一步）。',
      ]
      return { kind: 'success', text: lines.join('\n') }
    }
    const runtime = await deps.runtime()
    if (command === 'status') {
      const status = await runtime.probe()
      return { kind: 'success', text: renderNtStatus(status) }
    }
    const report = await runtime.doctor()
    return { kind: 'success', text: renderNtDoctor(report) }
  } catch (error) {
    deps.log?.warn?.(`/winstage nt ${command} 失败：${(error as Error)?.message ?? error}`)
    const detail = isNtError(error) ? `${error.code}：${error.message}` : String((error as Error)?.message ?? error)
    const prefix =
      command === 'up' || command === 'down'
        ? 'NT 数据面操作失败（已尝试回滚并清理；真实工作区未被写入）'
        : 'NT 诊断失败（本次没有执行任何沙箱操作）'
    return { kind: 'error', text: `${prefix}：${detail}` }
  }
}
