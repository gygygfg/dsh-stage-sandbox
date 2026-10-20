/**
 * WinStageSandbox —— Cordis 规范入口（TypeScript）。
 *
 * ── 本文件在重构中的位置 ────────────────────────────────────────────────────
 * 重构目标是把插件外壳迁到 TypeScript、用**平台自带**的 `@deepseek-ai/schemastery`
 * 表达配置、并让入口符合 Cordis 的插件契约。本文件是"规范入口"这一层：
 *   · `Config` 来自 `./config.ts`（真 schemastery），**取代**旧的手写
 *     `dsh-plugin/schema.js`（那份是"手摆 `Symbol.for('schemastery')`/`meta`/`toJSON`
 *     以骗过框架身份检查"的伪造外观）；
 *   · `name` / `inject` / `apply` 逐条保留与旧入口一致的对外契约。
 *
 * ── 为什么先"包装"而不是一次全迁 ────────────────────────────────────────────
 * 旧实现 `dsh-plugin/host-plugin.mjs`（1651 行）承载了命令面、审阅面、能力探测等
 * 久经测试的逻辑（`tests/*.mjs` 大量断言依赖它导出的纯函数）。一次性重写会把
 * "规范化"与"重写语义"两件事混在一起，一旦出问题无法二分。因此本入口**先做规范外壳**：
 * 配置用新 schema，行为**委托**给既有实现；随后按阶段把实现内迁成独立 `.ts` 模块
 * （`plugin/host-plugin.ts` 等），每次只动一层、每次都跑 tsc 与既有套件。
 *
 * ── 配置形状的桥接（真 schemastery 的一个实测语义）──────────────────────────
 * 真 schemastery 对 `meta.volatile === true` 的字段，校验输出是 `Volatile` 引用对象
 * 而非普通标量；旧手写 schema 产出普通值。为不改动下游（`host-plugin.mjs` 逐处
 * `config.enabled !== false` 之类），本入口在委托前用 `normalizeConfig()` 把两形态
 * 统一成**普通值**，于是"用真 schema + 行为不变"同时成立。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, boolOf, stringArrayOf, stringOf } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import {
  apply as applyImpl,
  inject as implInject,
  name as implName,
  probeRuntime,
} from '../dsh-plugin/host-plugin.ts'

export { Config }
export { probeRuntime }
export * as policy from './policy/engine.ts'
export * as risk from './risk.ts'
export * as approvalHub from './approval-hub.ts'
export * as reviewState from './review-state.ts'
export { applyWithGuard, discardAll, renderReview, parseApplyArgs, registerAlignedCommands } from './commands.ts'
export { buildAlignedDeps, riskFactsOf, unitOf } from './wire.ts'

/** 插件名（与旧入口逐字一致；`cordis.patch.yml` 的 `name` 断言依赖它）。 */
export const name: string = implName

/**
 * 服务依赖：留空数组（与旧入口一致）。
 * 命令面用 `ctx.inject(['commands'], …)` 惰性注册，缺失 `commands` 服务不影响加载。
 */
export const inject = implInject

/**
 * 把（可能含 `Volatile` 引用的）配置归一成普通值。
 *
 * @param raw - schemastery 校验输出或插件传入的配置对象。
 * @returns 与旧 `schema.js` 的 `validateObject()` 同形的普通配置。
 */
export function normalizeConfig(raw: unknown): ConfigShape {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: boolOf(source.enabled, true),
    workspaceRoot: stringOf(source.workspaceRoot, ''),
    probeOnStart: boolOf(source.probeOnStart, true),
    verboseLog: boolOf(source.verboseLog, false),
    // R24-A2：自定义 mask 正则字符串数组（默认 [] = 不启用，行为不变）。
    // 这里只做形态归一；正则合法性与 fail-closed 在 host-plugin.compileConfiguredMasks()。
    masks: stringArrayOf(source.masks, []),
  }
}

/**
 * 插件装配体（Cordis Function 插件）。
 *
 * @param ctx - DSH 注入的上下文。
 * @param config - 已由 `Config` schema 校验/水合的配置（可能含 Volatile 引用）。
 */
export function apply(ctx: Context, config: ConfigShape): void {
  applyImpl(ctx, normalizeConfig(config))
}

export default { name, inject, Config, apply }
