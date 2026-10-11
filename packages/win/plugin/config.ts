/**
 * WinStageSandbox 插件配置 —— 使用平台自带的 `@deepseek-ai/schemastery`。
 *
 * ── 为什么这是"符合 Cordis 规范"的关键一步 ────────────────────────────────────
 * 旧实现 `dsh-plugin/schema.js` 是**手写的 schemastery 外观伪造**：它手工摆出
 * `Symbol.for('schemastery')` / `type` / `meta` / `~standard` / `toJSON()` 这几样
 * 框架恰好读取的属性，只为骗过 `dsh-app-boot` 的原生 schema 身份检查与设置页水合
 * （原因写在旧文件注释里：当时 bundle 以 `link:` 装进 profile，裸模块说明符按
 * **realpath** 解析，找不到本项目 `node_modules`，于是 `ERR_MODULE_NOT_FOUND`）。
 *
 * 本文件用**真的** schemastery 表达同一份配置，因此：
 *   · 原生身份（`Symbol.for('schemastery')`、`type`、`meta`）由库自己保证；
 *   · `~standard.validate` 由库自己提供（Cordis 的 `resolveConfig` 依赖它）；
 *   · `toJSON()` 由库自己提供（设置页 `new z(schema.toJSON())` 水合依赖它）；
 *   · `enabled` 要求"设置页改它不重挂行、原地热写" ⇒ 需要 `meta.volatile = true`
 *     （此前是手工摆上去的）。
 *
 * ── volatile 用 `.extra('volatile', true)` 而**不是** `.volatile()`（实测差异）─────
 * 两种写法都会把 `meta.volatile` 置为 `true`，但**输出类型不同**：
 *   · `.volatile()` 把该字段变成 `Volatile<T>` 引用对象，校验结果是 `{ value }` 包装
 *     （实测 `Config({})` 得到 `{"enabled":{}…}`）⇒ 消费方读到的 `config.enabled`
 *     不再是布尔，`config.enabled !== false` 这类判断会因对象恒真而**语义漂移**；
 *   · `.extra('volatile', true)` 只挂元数据、**保持字段为普通标量**，与旧手写 schema 的
 *     `validateObject`（`value[key] = raw`，普通值）+ `meta.volatile` 完全一致。
 * DSH 设置页读的是 `schema.meta.volatile`（旧文件注释逐字引用了
 * `volatileForm` 的 `if (schema.meta.volatile) return plainSchema(schema)`），
 * 因此取 `.extra` 这一条既满足水合、又不改运行期形状。
 *
 * ── 根**不**标 volatile（与旧实现同一条纪律）────────────────────────────────────
 * `dsh-app-boot` 的 `createConfigProjector()` 会先跑 `validateVolatilePlacement()`，
 * 对"volatile 字段被包在 volatile 字段里"直接抛
 *   `config/enabled: volatile fields require a fixed object path without an enclosing volatile field`。
 * 根 + 字段都标 volatile 正好命中 ⇒ 整份投影失败 ⇒ 设置页开关不可水合。
 * 因此只给**叶子字段**挂 volatile 元数据，根对象保持普通 object。
 */

import z from '@deepseek-ai/schemastery'

/**
 * 插件配置的运行时形状。
 * 与 `Config`（schema）是同一份事实的两种表达：schema 负责校验/水合，本接口负责类型。
 */
export interface Config {
  /** 是否启用 WinStage 沙箱（暂存—候选—选择性提交）。关闭后本插件不做任何检查。 */
  enabled: boolean
  /** 沙箱工作区根目录；留空则由运行期按 profile/loader 行解析。 */
  workspaceRoot: string
  /** 加载时执行一次真实能力探测（不创建沙箱，只报告本会话能否建立）。 */
  probeOnStart: boolean
  /** 把完整探测报告写入日志。 */
  verboseLog: boolean
}

/**
 * 插件 Config —— 同时就是「设置 → 通用」里这一行的表单定义。
 * `enabled` 会渲染成一个开关；`default` 决定初始状态；每个叶子字段标 `.volatile()`
 * 以获得"设置页热写、不重挂行"的语义。
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .extra('volatile', true)
    .description('启用 WinStage 沙箱（暂存—候选—选择性提交）。关闭后本插件不做任何检查。'),
  workspaceRoot: z
    .string()
    .default('')
    .extra('volatile', true)
    .description('沙箱工作区根目录；留空则使用插件所在项目的根目录。'),
  probeOnStart: z
    .boolean()
    .default(true)
    .extra('volatile', true)
    .description('加载时执行一次真实能力探测（不创建沙箱，只报告本会话能否建立）。'),
  verboseLog: z
    .boolean()
    .default(false)
    .extra('volatile', true)
    .description('把完整探测报告写入日志。'),
})

/** 字段名清单（便于测试与文档；顺序与 schema 一致）。 */
export const FIELD_NAMES = ['enabled', 'workspaceRoot', 'probeOnStart', 'verboseLog'] as const

/**
 * 读取一个配置字段的**普通值**，兼容两种运行期形态。
 *
 * ── 为什么需要它（真 schemastery 语义 vs 旧手写 schema）────────────────────────
 * 只要字段的 `meta.volatile === true`，真 schemastery 在校验时会把该字段输出成
 * `Volatile` **引用对象**（`{ get(), [Symbol.for('cosmokit.volatile.write')] }`），
 * 而不是普通标量。旧的 `dsh-plugin/schema.js` 是手写的，只摆了 `meta.volatile`
 * 却没实现这层包装，因此**旧行为是"普通值"**。
 *
 * 换成真 schemastery 后，框架到底把"引用对象"还是"已解包的值"交给插件，取决于
 * `dsh-app-boot` 的投影实现（本仓没有 harness 源码，无法静态断定）。本助手让下游
 * **两种情况都拿到普通值**：是引用就 `.get()`，否则原样返回。
 *
 * @param value - 校验输出里的字段值（可能是普通值，也可能是 Volatile 引用）
 * @returns 普通值；引用读取失败时返回 `undefined`
 */
export function readConfigValue<T = unknown>(value: unknown): T | undefined {
  if (value !== null && typeof value === 'object') {
    const candidate = value as { get?: () => unknown }
    if (typeof candidate.get === 'function') {
      try {
        return candidate.get() as T
      } catch {
        return undefined
      }
    }
  }
  return value as T
}

/** 读取布尔字段（非布尔或缺省则回退）。复刻旧代码 `config.x !== false` 的调用点语义。 */
export function boolOf(value: unknown, fallback: boolean): boolean {
  const resolved = readConfigValue(value)
  return typeof resolved === 'boolean' ? resolved : fallback
}

/** 读取字符串字段（非字符串或缺省则回退）。 */
export function stringOf(value: unknown, fallback = ''): string {
  const resolved = readConfigValue(value)
  return typeof resolved === 'string' ? resolved : fallback
}
