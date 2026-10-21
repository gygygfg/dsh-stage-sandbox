// @ts-nocheck —— 全量 TS 化过渡脚手架：本文件由 .mjs 机械转换而来，类型待逐步补齐。
/**
 * WinStage 暂存文件系统 —— `ctx.fs` 的一个**替代**提供方。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 * 继承 `LocalFileSystem`（DSH 自带的本地后端），只改两件事：
 *   1. **变更面**（`writeText` / `editText`）：写进暂存树，**绝不写真实工作区**；
 *   2. **读取面**：命中暂存条目的路径读**投影**，其余一律 `super` 走真实磁盘。
 * 于是 DSH 的 `write` / `edit` / `read` 工具在**不改工具代码**的前提下获得
 * "暂存—候选—选择性提交"语义 —— 这正是 `@deepseek-ai/dsh-fs-sandbox` 的对接方式
 * （它替换 `fs-local` 的方式与本文件完全相同）。
 *
 * ── 三条必须遵守的契约（读源码 + 实测得到，违反会静默劣化）────────────────────
 *   1. `writeText` 返回的 `version` **不是装饰**：`dsh-tool-fs` 会把它作为
 *      `fs/observed` 的版本记进观测策略，并在**下一次**编辑时作为 `expected.version`
 *      传回。因此 `stat()` 必须对同一内容返回**同一个** version，且必须真的校验
 *      `expected`（不匹配 → `FS_STALE_VERSION`；`createIfAbsent` 撞上已存在 →
 *      `FS_NOT_OBSERVED`）。返回常量会使陈旧检测**静默失效**。
 *   2. 抛出的错误必须是**同一个模块实例**的 `FsError`：`dsh-tool-fs` 用
 *      `error instanceof FsError` 判别，第二份 dsh-fs 副本会让判别失败。
 *      所以这里用 `resolveDshModuleRoot()` 定位**运行时那一份**并按其绝对路径 import。
 *      ⚠ R32-A：同一进程里**测试代码/其它入口**可能解析到另一份 dsh-fs（DSH-as-node
 *      下实测有两份模块实例）——因此凡是要对"本 provider 抛出的错误"做 instanceof 判别，
 *      一律用本文件导出的 `isStagingFsError()`（用**本文件自己那份** FsError），
 *      不要拿调用方静态 import 的副本去比（那会把真 FsError 误判成非 FsError）。
 *   3. 边界映射必须先 `canonical()`：`Workspace.relative()` 用**词法**判定，
 *      而 8.3 短名（`ADMINI~1`）与长名是同一对象的两种拼写；不归一就会被判成
 *      "在工作区外"（实测踩到过）。
 *
 * ── 它刻意不做的事（残余边界，见 README 的对应小节）──────────────────────────
 *   - 工作区**之外**的写入同样进暂存（S3a：**硬拒已取消**，不再有 `FS_SANDBOX_DENIED`）；
 *     外部条目的键 = 规范化绝对路径，物化对象在 `.dshstage/staged-ext/`，
 *     **真实磁盘在批准之前一位不改**；只有 `stageOutside:'direct'` 这个显式逃生口
 *     才会直通真实磁盘（默认关闭，供宿主自身流程排障用）；
 *   - `bash` / `pwsh` 的写入不经过 `ctx.fs`，因此仍然落在真实工作区；
 *   - `watch` 已覆写：超类（真实磁盘）观察者照旧，**另把暂存变更转成失效通知**；
 *     **跨进程**改动（CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知。
 *
 * ── 第四轮（BUG-1 / BUG-2 / BUG-8）：不静默、互见、原子 ──────────────────────
 *   ① **写入必须回读确认**（BUG-1，"报成功但产物不存在"最坏形态）：`writeText` /
 *      `editText` 走完 `workspace.writeFile()` 之后，`verifyPersistedWrite()` 会**从磁盘**
 *      回读三样东西并逐字节比对：`manifest.json` 里的条目、`blobs/<aa>/<hash>`、
 *      物化对象 `staged/<rel>`（或 `staged-ext/...`）。任一条不成立 ⇒
 *      抛 `staging_write_not_persisted`（**不是**返回成功，也不返回"看起来对"的 version）。
 *      ⚠ 只覆盖经 `ctx.fs` 的写入；`bash`/`pwsh` 那条通道（shim）不经过本文件，
 *      它的"进程内成功、磁盘上没有"要靠 `src/executor.ts` 的执行门自检 + 下面的互见读取来暴露。
 *   ② **两套布局互见**（BUG-2）：读取（`currentOf`/`readText`/`stat`/`lstat`/`listDir`）
 *      在清单落点之外**同时看** shim/shell 通道的 `<staged>\fs\<盘符>\<绝对路径>`
 *      （以及 `wo\` 删除标记）；写入**归一到清单落点**。两边同时存在同一逻辑目标时，
 *      给一条 error 级告警（`warnSplitOnce()`）并把真实落点（`stagedPath` /
 *      `otherLayout` / `splitDetected`）写进写入回执。
 *   ③ **目录创建原子化**（BUG-8）：`ensureStagedParentsAtomic()` 逐层非递归 mkdir +
 *      逐层回读，失败回滚本次新建的层并抛 `staging_mkdir_failed`（`error.level` = 具体哪一层）。
 *
 * ── Phase 1 / WP2（成功即存在 + 透明性 + 环境类失败）───────────────────────────
 *   ① 存储根由 `review-service.ts::resolveReviewStoreDir()` → `src/stage-guard.ts`
 *      `resolveStageRoot()` 解析（**Windows 缓存**），本文件一个存储路径字面量都不拼；
 *   ② 写入回读闸门（`verifyPersistedWrite()`）的**失败文案已普通化**：模型可见的那句话
 *      零机制字样、不回显暂存落点；细节挂 `error.stagedPath` / `error.problems` + 日志；
 *   ③ **根丢失 / 守卫不可用 ⇒ 可重试的环境类普通失败**：`mapStageFailure()` 把它归成
 *      `ENV_FAULT_RETRYABLE`（复用 `src/executor.ts::FAILURE_CODE_ENVIRONMENT`）+
 *      `category: 'environment'`，**不再**把 `STAGE_ROOT_LOST` / `STAGE_GUARD_UNAVAILABLE`
 *      的原样 message 甩给模型；
 *   ④ `assertTransparentFailureTexts()` 是这条硬约束的**自检**（WP0 的禁用词清单 +
 *      本车道补的三条），装载时跑一次，离线自测再跑一次并带阳性对照。
 *
 * ── Phase 1 / WP4（读侧只记不拦）──────────────────────────────────────────────
 *   四条读入口（`readText` / `readBytes` / `readByteRange` / `listDir`）接 `src/paths.ts`
 *   的 29 条 `MASK_CLASSES`：默认 `readPolicy:'record'` ⇒ 记**会话级去重计数**
 *   （去重键 = `maskId + maskKey`）+ 每条遮蔽类至多一条用户侧合并提示，
 *   **读成功性一位不改**；`review.json` 增 `readVisibility` 段（登记表在
 *   `review-service.ts`，与快照同一个所有者）。`readPolicy:'block'` 是显式开关，
 *   默认关闭 —— 黑名单不是边界，见 `maskedHitOf()` 上方的说明。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical, compareKey, maskKey, maskReason } from '../src/paths.ts'
import { STATE, hashAbsent, isExternalKey } from '../src/store.ts'
import { FAILURE_CODE_ENVIRONMENT, FAILURE_SEMANTICS, resolveDshModuleRoot } from '../src/executor.ts'
import { STAGE_GUARD_UNAVAILABLE, STAGE_ROOT_LOST, checkTransparentMessages, stageBaseDir } from '../src/stage-guard.ts'
import {
  getReviewService,
  legacyWorkspaceStoreDir,
  recordReadVisibility,
  resolveReviewStoreDir,
  setReadVisibilityPolicy,
} from './review-service.ts'
import { rootSessionIdFor, rootSessionIdOf } from './session-identity.ts'
import { UNSTAGED_REASONS, recordUnstaged } from './unstaged-ledger.ts'
import { noteEffectiveStaging } from './review-service.ts'

/** 在候选 node_modules 根中定位**真实文件**（包的 exports 映射不作用于绝对 file: URL） */
function locatePackageFile(relativePath) {
  let roots = []
  try {
    roots = resolveDshModuleRoot() || []
  } catch {
    roots = []
  }
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, relativePath)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 解析并导入一个平台包（`@deepseek-ai/*`）。
 *
 * ── 为什么要有**裸名兜底**（本轮修复）────────────────────────────────────────
 * 打包发行（Electron/asar）里 `@deepseek-ai/*` 只存在于 `resources/app.asar` 内，
 * 磁盘上**没有真实文件** ⇒ `locatePackageFile()` 必然全部落空。而运行时（App 自己的
 * 模块加载器）能按裸包名解析到 asar 内的那一份，且与别处 import 的**是同一个实例**。
 * 缺这条兜底 ⇒ 桌面 App 里本入口必走 fail-closed，`fs` 服务缺失，`sessionController`
 * 起不来（实测：选工作区即报 `active Service 'sessionController' is unavailable`）。
 *
 * 顺序刻意是"磁盘绝对路径优先"：dev/同树/`DSH_SANDBOX_NODE_ROOT` 场景仍按原口径命中，
 * 只有磁盘解析不到时才退回运行时解析，**不改变既有部署的行为**。
 */
async function importPlatformModule(spec, relativePath) {
  const file = locatePackageFile(relativePath)
  const errors = []
  if (file) {
    try {
      return { mod: await import(pathToFileURL(file).href), from: file }
    } catch (error) {
      // 磁盘上有文件但 import 失败（传递依赖缺失等）—— 仍要退回运行时解析再试一次。
      errors.push(`${file}: ${error?.message ?? error}`)
    }
  }
  try {
    return { mod: await import(spec), from: spec }
  } catch (error) {
    errors.push(`${spec}: ${error?.message ?? error}`)
    return { mod: undefined, from: spec, error: new Error(errors.join(' | ')) }
  }
}

const fsImport = await importPlatformModule('@deepseek-ai/dsh-fs', join('@deepseek-ai', 'dsh-fs', 'lib', 'index.js'))
const fsLocalImport = await importPlatformModule('@deepseek-ai/dsh-fs-local', join('@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'))

if (!fsImport.mod || !fsLocalImport.mod) {
  // fail-closed：拿不到契约就不注册任何 fs 提供方（宁可文件工具不激活，也不静默放行）
  throw new Error(
    'WinStage 暂存文件系统：无法定位 @deepseek-ai/dsh-fs 或 @deepseek-ai/dsh-fs-local。' +
      '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。' +
      `（磁盘与运行时解析均失败：dsh-fs=${fsImport.error ? fsImport.error.message : 'ok'}；` +
      `dsh-fs-local=${fsLocalImport.error ? fsLocalImport.error.message : 'ok'}）`,
  )
}

const { FsError, FsVersion, FsTargetKey } = fsImport.mod
const { LocalFileSystem } = fsLocalImport.mod

/**
 * ★ R32-A：**provider 同实例**的 FsError 判别（供测试/诊断使用；生产 `dsh-tool-fs` 不需要它）。
 *
 * ── 为什么必须由本文件导出，而不是让调用方自己 `import '@deepseek-ai/dsh-fs'` ──────────
 * `instanceof` 判的是**模块实例级**的 class 身份。同一进程里完全可能加载出**两份**
 * `@deepseek-ai/dsh-fs`：
 *   · 生产（DSH-as-node / Electron-as-node）：宿主 loader 按**裸名/asar** 解析出一份，
 *     本文件的 `importPlatformModule()` 也可能解析到另一份（asar 内 vs 磁盘 node_modules）；
 *   · 自测（`node tests/...`）：测试进程按文件路径解析出一份，与本模块解析到的那份未必同一实例。
 * 于是测试代码若拿**自己那份** `FsError` 做 `error instanceof FsError`，在 DSH-as-node 下会得到
 * `false`（R32 实测：`r21-fs-policy` 8× `isFsError:false`），而错误对象本身一直是 provider
 * 抛出的**真 FsError**、`code/readPolicy/maskId` 全部正确 —— 产品行为没有缺陷。
 *
 * ── 为什么不能放宽成"按 code 字符串匹配" ──────────────────────────────────────────
 * `dsh-tool-fs` 的错误映射依赖 `error instanceof FsError` 来区分"文件系统错误"与宿主/策略错误；
 * 若把判别降级成 `error.code === 'FS_READ_DENIED'` 之类的字符串比较，任何普通 Error（或外部
 * 构造的对象）都能伪装成 FsError，类型契约退化成"可伪造字段"。因此本 helper **保留
 * `instanceof` 语义**，只是改用**本模块自己那份** FsError 做判别 —— 与 provider 抛错时用的是
 * 同一个 class 实例，这才是"provider 同实例判别"的准确含义。
 *
 * @param {unknown} error 任何被 provider 拒绝路径抛出的错误
 * @returns {boolean} 是否为本 provider 所抛的那份 `FsError` 实例
 */
export function isStagingFsError(error) {
  try {
    return error instanceof FsError
  } catch {
    return false
  }
}

/**
 * 平台自带的**沙箱** fs 后端（`ctx.fs` 的正常提供方）。
 *
 * 关闭开关时本提供方整体按它的面工作 ⇒「关掉暂存」==「退回平台原来的沙箱/审批模式」
 * （围栏、`FS_SANDBOX_DENIED`、同回合升权提示、`sandboxMode` 广告全部一致），而**不需要
 * 在运行中把 `fs` 这个服务名从一行搬到另一行**。
 *
 * 为什么不做行级热切换（关掉开关就 enable `fs-sandbox` 行、disable `winstage-fs` 行）：
 * `EntryGroup.update()` 对同一层的 id **并发** `create()`；被关掉那行的
 * `fiber.dispose()`（内部异步）不 await，而新打开那行的 `provide('fs')` 可能先执行 ⇒
 * cordis 对重复 provide 硬失败（`service "fs" has been registered at <...>`）。
 * 本 profile 在线切换 bundle 时**实测崩过宿主进程**（docs/DSH集成.md §4）。
 * 一个提供方、两种面，就没有这个事务。
 *
 * 找不到该包时这里是 `undefined` —— 装配方（fs-entry.ts）会 fail-closed，
 * 绝不静默退化成"没有围栏的本地写"。
 */
const sandboxImport = await importPlatformModule('@deepseek-ai/dsh-fs-sandbox', join('@deepseek-ai', 'dsh-fs-sandbox', 'lib', 'index.js'))
const SandboxedFileSystem = sandboxImport.mod ? sandboxImport.mod.SandboxedFileSystem : undefined

export { SandboxedFileSystem }

/** LF 归一（与 fs-local 的 diff basis 一致） */
function normalizeLineEndings(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

/** 记录原始换行风格，写入时还原（避免一次编辑把整个 CRLF 文件变成 LF） */
function lineEndingOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

function restoreLineEndings(text, eol) {
  return eol === '\r\n' ? String(text).replace(/\n/g, '\r\n') : String(text)
}

/**
 * 两个"暂存根"是否指向同一目录（C-8 fail-closed 用）。
 * 走 `canonical()` 归一（长路径前缀 / 分隔符 / 8.3 短名 / 链接），再按 Windows
 * 大小写不敏感比较；任一步抛错就退回字面比较，绝不因为比较本身让插件起不来。
 */
function sameRoot(a, b) {
  try {
    return canonical(String(a)).toLowerCase() === canonical(String(b)).toLowerCase()
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase()
  }
}

/** 内容戳（与 `src/store.ts::sha256Buffer` 同一算法：用来自证"落盘内容 == 提交内容"） */
function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// ═══════════════════════════════════════════════════════════════════════════
// WP2：模型可见失败文案的**普通化** + 环境类失败的可重试映射
// ═══════════════════════════════════════════════════════════════════════════
//
// 三条硬口径（owner 已定）：
//   ① **失败就是普通失败**：模型可见的那句话里不得出现机制字样
//      （`沙箱`/`暂存`/`staging`/`stage`/`替代路径`/`overlay`/`STAGE_ROOT_LOST` …）。
//      机制细节只进 **error 级日志**（`logError`，人工侧）与 **非 message 属性**
//      （`error.stagedPath` / `error.problems` / `error.technicalCode`）。
//   ② **根丢失 / 守卫不可用 = 可重试的环境类普通失败**：语义码复用
//      `src/executor.ts` 的 `FAILURE_CODE_ENVIRONMENT`（`ENV_FAULT_RETRYABLE`），
//      **不另造一套**（`shell-executor.ts` 的 `WINSTAGE_SHELL_RUN_FAILED` 用同一族码，
//      两处口径因此不会漂移）。若跨模块不便 import 就复用其**常量名**并注明 —— 本文件
//      直接 import（它本来就依赖 `resolveDshModuleRoot()`），所以没有第二份字面量。
//   ③ 机检必须能自证：`assertTransparentFailureTexts()` 对**本文件能产出的全部**
//      模型可见文案跑 WP0 的 `checkTransparentMessages()`（外加本车道补的三条），
//      自测里还给一条**阳性对照**，证明不是假绿。

/** 环境类失败的语义码（= `src/executor.ts` 的常量，不是第二份字面量） */
export const ENV_FAULT_RETRYABLE = FAILURE_CODE_ENVIRONMENT

/** 触发"环境类普通失败"映射的两个稳定技术码（来自 `src/stage-guard.ts`） */
const STAGE_LOSS_CODES = new Set([STAGE_ROOT_LOST, STAGE_GUARD_UNAVAILABLE])

/** 该错误是不是"根丢了 / 守卫建不起来" */
function isStageLossError(error) {
  return typeof error?.code === 'string' && STAGE_LOSS_CODES.has(error.code)
}

/** 本车道在 WP0 禁用词之外**额外**要挡的字样（技术码与 `overlay` 同义说法） */
const EXTRA_FORBIDDEN_TOKENS = Object.freeze(['stage_root_lost', 'stage_guard_unavailable', 'overlay'])

/**
 * 模型可见文案的透明性检查：**WP0 的清单 + 本车道的补充**（纯函数，不抛）。
 * 返回 `{ ok, violations: [{ text, word }] }`。
 */
export function transparencyReport(texts = []) {
  const base = checkTransparentMessages(texts)
  const violations = [...base.violations]
  for (const text of texts) {
    const lower = String(text).toLowerCase()
    for (const token of EXTRA_FORBIDDEN_TOKENS) {
      if (lower.includes(token)) violations.push({ text: String(text), word: token })
    }
  }
  return { ok: violations.length === 0, violations }
}

/**
 * 本文件能产出的**模型可见**失败文案模板（模板函数 → 句子的唯一来源）。
 * 三条都是"普通失败"的口气：不解释机制、不给替代路径、不出现内部行话。
 * ⚠ 调用方传入的 `displayPath` 会被**逐字回显**（那是调用方自己给的路径，不是机制泄漏）；
 *   自检用一条不含禁用词的字面路径，避免"路径恰好叫 staging-fs.ts"这种假阳性。
 */
export const MODEL_VISIBLE_FAILURE_TEXTS = Object.freeze({
  /** 写入回读失败（产物不存在/内容不一致）⇒ 不返回成功 */
  writeNotPersisted: (displayPath) => `cannot save "${displayPath}": the change could not be read back from disk and is not reported as applied`,
  /** 根丢失 / 守卫不可用 ⇒ 可重试的环境类普通失败 */
  environmentRetryable: (displayPath) => `cannot complete the operation on "${displayPath}": the session working directory is temporarily unavailable, retry this operation`,
  /** 读侧 `readPolicy:'block'` 命中遮蔽表（默认 `record` 时**不会**出现） */
  readDenied: (displayPath) => `cannot read "${displayPath}": this path is not readable under the current read policy`,
  /** 拒绝经 `ctx.fs` 写本工具自身的状态机（自指条目） */
  storeWriteDenied: (displayPath) => `refusing to modify "${displayPath}": this path belongs to this tool's own bookkeeping files, and a change there could never be approved`,
  /**
   * 清单条目指向的内容对象在磁盘上不见了（历史上这句话写的是
   * `staged content for "…" is missing` —— 含 `staged`（= 禁用词 `stage` 的子串）
   * 且泄漏机制；这里改成普通失败口径，细节仍走 `logError` 与 `error.code`）。
   */
  contentMissing: (displayPath) => `content for "${displayPath}" is not available`,
  /**
   * `stageOutside: 'deny'`：工作区外写入被显式拒绝（opt-in 档）。
   *
   * 措辞要求：**诚实**（说清"没有写、也不在待批队列里"）+ **零机制字样**
   * （不出现 staging/staged/暂存/替代路径）。因此它说的是"this tool is configured to
   * refuse writes outside the workspace"，而不是"已进暂存等你批准"。
   * 注意与 `'stage'` 档的区别：那一档**确实**写成功了（进待批队列），只是没落真实盘；
   * 那一档的诚实信息走非枚举 diagnostics（见 `locationDiagnostics()`），因为
   * `dsh-tool-fs` 的输出 schema 是 `additionalProperties:false` 且渲染器只认
   * `operation`，**回执里加键到不了模型**（实测见修复报告 §1.2）。
   */
  outsideWriteDenied: (displayPath) =>
    `refusing to write "${displayPath}": this tool is configured to refuse writes outside the workspace, and nothing was written`,
})

/** 自检：本文件能产出的全部模型可见文案都过透明性检查（自测会显式再跑一次） */
export function assertTransparentFailureTexts() {
  const sample = 'C:\\ws\\a.txt'
  const samples = [
    MODEL_VISIBLE_FAILURE_TEXTS.writeNotPersisted(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.environmentRetryable(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.readDenied(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.storeWriteDenied(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.contentMissing(sample),
    MODEL_VISIBLE_FAILURE_TEXTS.outsideWriteDenied(sample),
  ]
  const result = transparencyReport(samples)
  if (!result.ok) {
    throw new Error(`transparency violation: ${JSON.stringify(result.violations)}`)
  }
  return { ok: true, checked: samples.length }
}
assertTransparentFailureTexts()

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 / WP9：**成功路径**也不能自曝（哪些键真的会到模型）
// ═══════════════════════════════════════════════════════════════════════════
//
// 实证（读 `@deepseek-ai/dsh-tool-fs` / `dsh-tools` 源码，不是猜）：
//   · `dsh-tools` 的 `ToolRuntime.createSuccessResult()`（lib/index.js:3540-3571）拿工具体
//     返回的对象按 `tool.output.schema` **校验**（`additionalProperties:false`）后，只把
//     `tool.output.render()` 的产出（`content`）发给模型；
//   · `write` / `edit` 的 render 是 `formatWriteOutput()`（dsh-tool-fs lib/index.js:508-514）：
//       `<path>${displayPath}</path>\n<type>file</type>\n<content>\nCreated|Updated file\n</content>`
//     它只读 outcome 的 `operation`；`before` / `after` 走 `presentationMeta`（人工侧 diff 卡）；
//   · `dsh-tool-fs` 的 `execute` 只从本文件的 outcome 里取
//     `operation` / `version` / `before` / `after`（lib/index.js:586-599, 745-750）。
// ⇒ **模型可见面**只有：render 正文（逻辑路径 + "Created/Updated file"）+ 失败时的
//    平台/普通化 message。`writeText` 返回对象上多出来的键在真机通道里**渲染不到**，
//    但它们是"一次 `{...outcome}` 或任何 JSON 化就能到模型"的形状 ⇒ WP9 把它们移出。
//
// 因此 outcome 的可见键收紧成 `{ operation, version, before, after }`（`logicalPath` **不能**进可见面：DSH write/edit 输出 schema 是 additionalProperties:false，真机实测会报 invalid output）
// （真实工作区路径），诊断（暂存落点/第二套布局/分裂）走下面的 **Symbol 键非枚举** 旁路：
// `Object.keys` / `JSON.stringify` / 展开运算符都取不到，也不进 `snapshotJsonValue` 快照。
// 内部消费者（自测 / 将来的 run-capture 复核面）用 `STAGE_DIAGNOSTICS` 显式读取。

/** 写入回执的**非模型可见**诊断通道（Symbol 键 + 非枚举） */
export const STAGE_DIAGNOSTICS = Symbol.for('winstage.stagingFs.diagnostics')

/** 把诊断挂成非枚举旁路属性（不改变任何可见键；失败也不影响调用方） */
export function attachStageDiagnostics(outcome, diagnostics) {
  if (outcome === null || typeof outcome !== 'object') return outcome
  try {
    Object.defineProperty(outcome, STAGE_DIAGNOSTICS, {
      value: Object.freeze({ ...diagnostics }),
      enumerable: false,
      writable: false,
      configurable: false,
    })
  } catch {
    /* 冻结对象等极端情形：宁可少一条旁路，也不让写入回执本身失败 */
  }
  return outcome
}

/** 读回诊断（没有返回 undefined） */
export function stageDiagnosticsOf(outcome) {
  return outcome === null || typeof outcome !== 'object' ? undefined : outcome[STAGE_DIAGNOSTICS]
}

/** 覆盖级常量：staging 自己的存储树上的机制字样（成功/失败两条路径都不能出现） */
const STAGE_ROOT_MARKERS = Object.freeze(['.dshstage', 'staged-ext', `${sep}staged${sep}`])

/** 成功回执的可见键白名单（真实文件系统写操作会有的键；逻辑路径由 render 的 `<path>` 提供） */
export const SUCCESS_OUTCOME_KEYS = Object.freeze(['operation', 'version', 'before', 'after'])

/**
 * **成功路径的零自曝机检**（与 `assertTransparentFailureTexts()` 同族，各测一条路径）。
 *
 * 三条判据，逐条说清适用范围（避免"把用户内容当机制泄漏"的假红）：
 *   ① **可见键白名单**：outcome 的可枚举键**只能**是真实文件系统写操作会有的那些
 *      （`operation` / `version` / `before` / `after`）。
 *      这是最硬的一条：任何 `staged` / `stagedPath` / `layout` / `splitDetected` 回来都会被点名。
 *   ② **存储树字样扫描**：每个字符串值（含 `after` / `before` 内容）都不得包含
 *      `.dshstage` / `staged-ext` / `\staged\` —— 真落点绝不会长在写回执里。
 *   ③ **禁用词扫描**：只对**本文件模板生成**的字段（`operation`）跑 WP0 的
 *      `checkTransparentMessages()`（复用 `src/stage-guard.ts` 的 `FORBIDDEN_MODEL_TEXT`，
 *      **不另造词表**）。
 *
 * ⚠ 哪些字段**不**做禁用词扫描，以及为什么（第一版实测踩到过全部三种假红）：
 *   · `before` / `after` 是**用户文件内容**：一个叫 `staging-notes.md` 的真实文件、
 *     或内容里写着 "sandbox" 的脚本，都是合法用户数据 —— 拿词表扫它必然假红；
 *   · 逻辑路径由 render 的 `<path>` 提供；`logicalPath` 只走非枚举诊断面，绝不进 write/edit outcome。
 *     `...\WinStageSandbox\...` 这样的目录下（本项目自己就是），扫它同样是假红；
 *   · `version` 是**不透明内容戳**（`dsh-fs` 的 `FsVersion`，如 `winstage:<sha256>`），
 *     模型只把它当 token 回传、从不解读，`winstage:` 里就含子串 `stage`。
 *   三者的泄漏面都由判据①（键白名单，任何 `stagedPath`/`layout` 回来都会被点名）与
 *   判据②（**落点**字样：`.dshstage` / `staged-ext` / `\staged\`，它扫**每一个**字符串值）
 *   覆盖 —— 这正是"真实落点绝不出现在写回执里"的那条判据。
 *
 * @param outcome `writeText` / `editText` 的返回值
 * @returns `{ ok, violations, visibleKeys }`
 */
export function checkTransparentSuccessOutcome(outcome, allowedKeys = SUCCESS_OUTCOME_KEYS) {
  const violations = []
  if (outcome === null || typeof outcome !== 'object') {
    return { ok: false, violations: [{ word: 'not-an-object', text: String(outcome) }], visibleKeys: [] }
  }
  const visibleKeys = Object.keys(outcome)
  for (const key of visibleKeys) {
    if (!allowedKeys.includes(key)) violations.push({ word: `unexpected-visible-key:${key}`, text: key })
  }
  const allStrings = []
  for (const key of visibleKeys) {
    const value = outcome[key]
    if (typeof value === 'string') allStrings.push({ key, value })
  }
  violations.push(...checkTransparentMessages([String(outcome.operation ?? '')]).violations)
  for (const { key, value } of allStrings) {
    const lower = value.toLowerCase()
    for (const token of STAGE_ROOT_MARKERS) {
      if (lower.includes(token.toLowerCase())) violations.push({ word: `${token} (in ${key})`, text: value })
    }
  }
  return { ok: violations.length === 0, violations, visibleKeys }
}

/** 自检：成功路径同样零自曝（装载时跑一次，自测再跑一次并带阳性对照） */
export function assertTransparentSuccessOutcome() {
  const clean = checkTransparentSuccessOutcome({
    operation: 'create',
    version: 'winstage:0000',
    before: null,
    after: 'hello\n',
  })
  if (!clean.ok) throw new Error(`success-path transparency violation: ${JSON.stringify(clean.violations)}`)
  // 阳性对照 1：多出来的可见键必须点名
  const dirtyKey = checkTransparentSuccessOutcome({ operation: 'create', version: 'winstage:0000', stagedPath: 'C:\\stage\\staged\\a.txt' })
  if (dirtyKey.ok) throw new Error('success-path transparency checker is not armed (extra visible key passed)')
  // 阳性对照 2：可见字符串里的暂存落点必须点名
  const dirtyPath = checkTransparentSuccessOutcome({ operation: 'create', version: 'winstage:0000', after: `C:\\x\\.dshstage\\staged\\a.txt` })
  if (dirtyPath.ok) throw new Error('success-path transparency checker is not armed (stage root in visible string passed)')
  return { ok: true, checked: 3 }
}
assertTransparentSuccessOutcome()

/**
 * ── 暂存树的**第二套布局**：shim / shell 通道的落点（BUG-2）─────────────────────
 *
 * `[实测]`（3081 会话 `session-97132a99` CH-01 / `session-73feedf7`）同一逻辑目标存在
 * **三套互不可见的落点**：
 *   · `<store>\staged\<工作区相对路径>`       ← 本插件（`ctx.fs` / 宿主工具）写；
 *   · `<store>\staged\fs\<盘符>\<绝对路径>`   ← shim / pwsh 写（`shim\src\ws_stage.c`）；
 *   · `<store>\staged-ext\<分桶>\<叶名>`      ← 工作区**外**条目（`src/store.ts:381`）。
 * 前两套**指向同一逻辑目标**却互不可见 ⇒ "宿主工具写 `_r3\pkg\a.txt` 落在
 * `<stage>\_r3\pkg\a.txt`，PS 写同一个目标落在 `<stage>\fs\C\...\ws\_r3\pkg\a.txt`，
 * 两边读不到对方的产物"，而这正是"命令说写成功、宿主工具说文件不存在"的机器。
 *
 * 口径与 `src/workspace.ts:118-157`（`ws_fs_map()` 的逆映射）**逐字对齐**：
 *   `C:\a\b`           → `<staged>\fs\C\a\b`
 *   `\\server\share\x` → `<staged>\fs\_unc\server\share\x`
 *   `wo\` 子树同理（`<staged>\wo\C\a\b` = 该逻辑目标的**删除标记**）。
 *
 * 反解不出来（相对路径 / 层级不足 / 首段既不是盘符也不是 `_unc`）返回 `undefined`：
 * 调用方按"该布局里没有这个目标"处理，**绝不猜**一个路径去读或去删。
 */
const SHIM_FS_LEAF = 'fs'
const SHIM_WHITEOUT_LEAF = 'wo'

/** 逻辑绝对路径 → `{drive, parts}`（`_unc` 表示 UNC 根） */
function splitLogicalPath(abs) {
  const normalized = normalize(String(abs))
  if (normalized.startsWith('\\\\')) {
    const parts = normalized.slice(2).split(/[\\/]+/).filter((part) => part.length > 0)
    return parts.length === 0 ? undefined : { drive: '_unc', parts }
  }
  const match = /^([a-zA-Z]):[\\/]?(.*)$/.exec(normalized)
  if (!match) return undefined
  const parts = match[2].split(/[\\/]+/).filter((part) => part.length > 0)
  return { drive: match[1].toUpperCase(), parts }
}

/** 逻辑绝对路径 → shim/shell 布局里的物理路径（`leaf` = `fs`（内容）或 `wo`（删除标记）） */
export function shimLayoutPathOf(stagedDir, abs, leaf = SHIM_FS_LEAF) {
  if (typeof stagedDir !== 'string' || stagedDir.length === 0) return undefined
  const parsed = splitLogicalPath(abs)
  if (parsed === undefined) return undefined
  return join(stagedDir, leaf, parsed.drive, ...parsed.parts)
}

/** shim/shell 布局里的物理路径 → 逻辑绝对路径（`listDir` 合并时用；反解不出返回 `undefined`） */
export function logicalFromShimLayout(stagedDir, abs, leaf = SHIM_FS_LEAF) {
  if (typeof stagedDir !== 'string' || typeof abs !== 'string') return undefined
  let rel
  try {
    rel = relative(join(stagedDir, leaf), normalize(abs))
  } catch {
    return undefined
  }
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.length < 1) return undefined
  const [head, ...rest] = parts
  if (head.toLowerCase() === '_unc') return rest.length > 0 ? `\\\\${rest.join('\\')}` : undefined
  if (!/^[a-zA-Z]$/.test(head)) return undefined
  return rest.length > 0 ? `${head.toUpperCase()}:\\${rest.join('\\')}` : `${head.toUpperCase()}:\\`
}

/**
 * WinStage 自身存储的**状态机路径**（P0-8）。
 *
 * `.dshstage/**` 既是插件元数据（manifest/review/queue）又是暂存对象树（blobs/staged/
 * staged-ext/candidates/sessions）。**写侧此前零判据**（读/批准侧只有 `src/paths.ts:199`
 * 的 `stage-store`（hard:true）遮蔽）⇒ agent 可以经 `ctx.fs` 把 `review.json` /
 * `manifest.json` / `staged/**` 改写进暂存并生成**自指条目**：出生即 stale ⇒ 批准必然
 * `STALE_BASELINE`、`pending` 永久（"条目怎么点都不消失"）。
 *
 * 这里拒绝的是**状态机本身**：三个元数据文件 + 存储目录树。`.dshstage` 根下的**其它**
 * 普通文件（例如敏感路径测试用的 `confirm-probe.txt`）不在其列，保持既有行为。
 *
 * ⚠ 边界（必须如实声明）：本守卫**只在经 `ctx.fs`** 的路径上生效。
 *   `bash`/`pwsh` 等 shell 写入完全绕过 `ctx.fs`（见本文件头部第 30 行），插件自己的
 *   `src/store.ts` 也走 `node:fs` 直写 —— 那些**不受本守卫约束**。
 *   因此这**不等于**解决 R8。
 */
const STORE_SEGMENT_TAIL = '\\.dshstage\\'
const STORE_METADATA_FILES = new Set(['manifest.json', 'review.json', 'queue.json'])
const STORE_STATE_DIRS = new Set(['blobs', 'staged', 'staged-ext', 'candidates', 'sessions', 'real', 'private', 'cache'])

/**
 * R34-SEC-03（P3）：把 `.dshstage` 下的首段归一成**真实长名**再判定。
 *
 * 词法守卫的绕过形态（实测）：Windows 打开文件时会**去掉段尾的空格/点**，
 * 8.3 短名也会别名到长名。于是 `.dshstage\review.json␠`、`review.json.`、
 * `REVIEW~1.JSON` 在 Win32 上都落到 `review.json`，但旧守卫只做 `toLowerCase()`
 * ⇒ 判定为"普通文件"、放行写入。归一规则：
 *   · 去掉段尾空格与点；
 *   · `~数字` 的 8.3 形态若其基名是某个状态文件/目录的前缀（≥3 字符）⇒ 按该长名判定；
 * 这是**过度收紧**可接受的地方：`.dshstage` 是插件自己的状态目录，不是用户命名空间。
 */
function storeSegmentKey(segment) {
  const trimmed = String(segment).replace(/[ .]+$/g, '')
  const lower = trimmed.toLowerCase()
  if (STORE_METADATA_FILES.has(lower) || STORE_STATE_DIRS.has(lower)) return lower
  if (/~\d+/.test(lower)) {
    const base = lower.split('~')[0]
    if (base.length >= 3) {
      for (const name of [...STORE_METADATA_FILES, ...STORE_STATE_DIRS]) {
        if (name.startsWith(base)) return name
      }
    }
  }
  return lower
}

/**
 * 该绝对路径是否命中 WinStage 存储的**状态机**（元数据文件或存储目录树）。
 *
 * ★ R40-FS-04（P1）：判定必须同时认**当前布局**（Phase 1 之后存储根在 Windows 缓存面，
 * `%LOCALAPPDATA%\Temp\winstage-stage\<会话>`，路径里**没有** `.dshstage` 段）。
 * 旧实现只做 `\.dshstage\` 的字面搜索 ⇒ 自从 WP0 把存储搬出工作区后，这条守卫对**真实**
 * 存储根一次也命中不到（`ctx.fs` 写 `<存储根>\manifest.json` / `blobs\x` 会被当成普通
 * 工作区外条目暂存，批准后落到活的存储上）。r34 §4 只覆盖了**旧布局**词法夹具，因此
 * 一直是假绿。
 *
 * @param {string} abs 逻辑绝对路径
 * @param {string[]} [stateRoots] `compareKey()` 归一后的存储根（本会话的新根 + 旧布局根）
 */
function isStoreStatePath(abs, stateRoots) {
  if (typeof abs !== 'string' || abs.length === 0) return false
  const normalized = abs.replace(/\//g, '\\')
  const legacyRule = (rest) => {
    const slash = rest.indexOf('\\')
    const head = slash < 0 ? rest : rest.slice(0, slash)
    const key = storeSegmentKey(head)
    if (slash < 0) return STORE_METADATA_FILES.has(key) || STORE_STATE_DIRS.has(key)
    return STORE_STATE_DIRS.has(key)
  }
  const at = normalized.toLowerCase().lastIndexOf(STORE_SEGMENT_TAIL)
  if (at >= 0) {
    const rest = normalized.slice(at + STORE_SEGMENT_TAIL.length)
    if (rest.length === 0) return false
    if (legacyRule(rest)) return true
  }
  if (!Array.isArray(stateRoots) || stateRoots.length === 0) return false
  let key
  try {
    key = compareKey(normalized)
  } catch {
    key = normalized.toLowerCase()
  }
  for (const root of stateRoots) {
    if (typeof root !== 'string' || root.length === 0) continue
    if (key === root) return true
    const prefix = root.endsWith('\\') ? root : `${root}\\`
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (rest.length === 0) return true
    if (legacyRule(rest)) return true
  }
  return false
}

/**
 * 字面替换，错误码与 fs-local 对齐。
 *
 * ★ R40-FS-01（P1）：`oldString` / `newString` **必须先做 LF 归一**再匹配/替换 ——
 * 基类 `dsh-fs-local:applyLiteralEdit` 就是这么做的（`normalizeLineEndings(oldString)` /
 * `normalizeLineEndings(newString)`），本实现此前漏了这一步，于是 CRLF 文件上：
 *   · `readText` 返回的是**原样 CRLF**（`readTextInner` 不改换行），模型把它当 `oldString`
 *     传回来 ⇒ 与归一后的 LF 文本比对 0 命中 ⇒ 假 `FS_EDIT_NOT_FOUND`（读-改-写闭环断在
 *     最常见的一步上）；
 *   · 带 `\r\n` 的 `newString` 被插进 LF 归一文本后，再由 `restoreLineEndings()` 把每个
 *     `\n` 扩成 `\r\n` ⇒ 落盘/批准后是 `\r\r\n`（内容被破坏，且 before/after 与实际落点不一致）。
 * 归一口径与 `currentOf` 用的一致（同一个 `normalizeLineEndings`），因此两边不会再漂移。
 */
function applyLiteralEdit(text, edit, displayPath) {
  if (!edit || typeof edit.oldString !== 'string' || edit.oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must be a non-empty string`, 'FS_EDIT_NOT_FOUND')
  }
  const oldString = normalizeLineEndings(edit.oldString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must be a non-empty string`, 'FS_EDIT_NOT_FOUND')
  }
  const newString = normalizeLineEndings(typeof edit.newString === 'string' ? edit.newString : '')
  const occurrences = text.split(oldString).length - 1
  if (occurrences === 0) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace was not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (occurrences > 1 && edit.replaceAll !== true) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace is ambiguous (${occurrences} matches)`, 'FS_AMBIGUOUS_EDIT')
  }
  const next = edit.replaceAll === true
    ? text.split(oldString).join(newString)
    : text.replace(oldString, newString)
  return next
}

/**
 * 读侧策略的合法取值（R24-A1）。`normalizeReadPolicy()` 是**唯一**归一入口。
 */
export const READ_POLICY_VALUES = Object.freeze(['record', 'block'])

/**
 * `readPolicy` 三态归一（R24-A1；**唯一**的归一/日志入口）。
 *
 * 语义（与 `WINSTAGE_STAGE_OUTSIDE` 同风格，**显式通道**）：
 *   · 未设 / 空串 / 纯空白 ⇒ `record`（产品默认 = 只记不拦，读取面边界不变）；
 *   · `'record'` / `'block'`（去首尾空白后逐字匹配）⇒ 对应档；
 *   · **其它任何非空值 ⇒ fail-safe 到 `block`**（`source:'invalid-fail-safe'`）：
 *     显式配置了却拼错时，**不得静默退回"只记不拦"**（那会把一次配置失误伪造成
 *     "读侧策略已生效"）。调用方（`staging-fs` 构造函数）对这一档记一条 error 级日志。
 *
 * 为什么归一放在 `staging-fs.ts` 而不是 `fs-entry.ts`：`fs-entry.ts` 只做"env → 选项"
 * 的**白名单形态透传**（非空字符串原样交给本文件），这样生产装配与自测构造**同一条**
 * 归一判据，不会出现"entry 归一一套、构造函数另一套"的漂移。
 *
 * @param {unknown} raw `options.readPolicy`（生产来自 `WINSTAGE_READ_POLICY`）
 * @returns {{policy:'record'|'block', raw:string|undefined, source:'default'|'explicit'|'invalid-fail-safe'}}
 */
export function normalizeReadPolicy(raw) {
  if (raw === undefined || raw === null) return { policy: 'record', raw: undefined, source: 'default' }
  const value = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  if (value.length === 0) return { policy: 'record', raw: undefined, source: 'default' }
  if (value === 'record' || value === 'block') return { policy: value, raw: value, source: 'explicit' }
  return { policy: 'block', raw: value, source: 'invalid-fail-safe' }
}

/**
 * 构造暂存文件系统类。
 *
 * 返回的类就是 loader 行的插件本身（与 `SandboxedFileSystem` 同构）：
 * 它 `extends LocalFileSystem`，`Config` 由基类继承（`cwd` / `diffBasisMaxBytes`），
 * 服务名 `fs` 由 `FileSystem` 基类在构造时 `provide` 出来。
 *
 * @param {{log?: (msg: string, level?: string) => void, onMutation?: () => void, stageOutside?: 'stage'|'deny'|'direct', base?: object}} options
 *   `base` 仅供**自测**替换基类（默认就是 DSH 的 `LocalFileSystem`）；生产装配不要传。
 *   `stageOutside` 三态，**显式判定**（不再靠 fallthrough）：
 *     · `'stage'`（**默认**）：工作区外的写入进暂存、等批准。真实磁盘一位不改。
 *     · `'deny'`：工作区外的写入**显式拒绝**（`FS_SANDBOX_DENIED`），真实磁盘一位不改、
 *       也**不产生候选**。模型面看到的是本插件自己的诚实文案（实测：`dsh-tool-fs` 的
 *       `mapError()` 在暂存面（`sandboxMode === undefined` ⇒ `policy === undefined`）
 *       **不会**把它换成 `[sandbox: …]` 标记 —— 见
 *       `git 历史（历史归档已清理）` §1.3 的实测与读码）。
 *     · `'direct'`：显式逃生口，直通真实磁盘。
 *   任何**其它**取值一律 fail-safe 归一为 `'stage'`（不静默变成拒绝，也不静默直写）。
 *   `readPolicy` 三态**显式通道**（R24-A1，生产来自 `WINSTAGE_READ_POLICY`）：
 *   未设/空 ⇒ `record`（默认不变）；`record`/`block` ⇒ 对应档；
 *   **其它非空值 ⇒ fail-safe 到 `block` + error 级日志**（不得静默退回只记不拦）。
 *   归一判据只有 `normalizeReadPolicy()` 一处（见其上注释）。
 */
export function createStagingFileSystem(options = {}) {
  const rawStageOutside = options.stageOutside
  const stageOutside =
    rawStageOutside === 'direct' || rawStageOutside === 'deny' || rawStageOutside === 'stage'
      ? rawStageOutside
      : 'stage'
  // 生产默认基类 = 平台的 `SandboxedFileSystem`：关掉开关时**原样**退回它。
  // 离线自测显式传 `base`（替身基类），因此两种面都能被断言。
  const Base = options.base || SandboxedFileSystem || LocalFileSystem
  /** 自测/装配方可注入"是否接管"的判定；生产默认读 loader 树（见 stagingEnabled()） */
  const enabledOverride = typeof options.enabled === 'function' ? options.enabled : undefined

  return class StagingFileSystem extends Base {
    /**
     * `cwd` / `diffBasisMaxBytes` 的 schema 来自基类，这里显式声明为**自有**静态属性：
     * 静态属性虽然可继承，但把配置契约摆在自己身上更稳（装配器读的是 `plugin.Config`）。
     */
    static Config = Base.Config

    constructor(ctx, config) {
      super(ctx, config)
      /**
       * **本插件自己的** loader entry —— 必须在构造时抓住。
       *
       * 不能改成"调用时读 `this.ctx.fiber.entry`"：`ctx.<service>` 拿到的是 cordis 的
       * traceable 代理（cordis/lib/index.js:123-129 `createTraceable`），它会把
       * `service.ctx` 改写成**调用方**的 ctx。于是 `dsh-tool-fs` 调
       * `ctx.fs.writeText(...)` 时，方法里的 `this.ctx` 是**工具的** ctx，那里的
       * `fiber.entry.parent.data` 根本不是 loader 根 include 的条目表 —— 开关会永远
       * 读成"没找到该行 ⇒ 接管"。真实 loader 实测抓到这个
       * （`.t/loader-toggle-harness.ts`）。
       * `fiber.entry` 在插件**构造之前**就由 loader 的 `internal/plugin` 处理器设好
       * （cordis/lib/index.js:129-135），所以这里能直接拿到，且 entry 对象在
       * 后续 `EntryGroup.update()` 里是复用的（`group.create()` 先查 `store[id]`）。
       */
      this.rootEntry = ctx?.fiber?.entry
      const logger = ctx?.logger
      this.log =
        options.log ||
        ((message) => {
          if (logger && typeof logger.info === 'function') logger.info(message)
          else console.log(`[winstage-fs] ${message}`)
        })
      /** 存下来给 ReviewService 用（"失败必须响"要走 error/warn 级日志） */
      this.logger = logger
      /**
       * **error 级**日志：守卫/拒绝路径必须响。优先 `logger.warn` / `logger.error`
       * （DSH 实例日志可见），没有 logger 时退到 `console.error`（进程 stderr）。
       */
      this.logError = (message) => {
        const line = `[winstage-fs] ${message}`
        try {
          if (logger && typeof logger.warn === 'function') return logger.warn(line)
          if (logger && typeof logger.error === 'function') return logger.error(line)
        } catch {
          /* best effort */
        }
        try {
          console.error(line)
        } catch {
          /* best effort */
        }
      }
      // ── C-8 配置漂移 fail-closed（与文件头 58-64 行同风格）──────────────────────
      // 两个 loader 行用**不同的配置键**表达同一个暂存根：host 行 `workspaceRoot`、
      // 本行 `cwd`。`getReviewService()` 按 canonical 根做进程内单例
      // （review-service.ts:330-343），两键一旦不一致就会产生两个单例 ——
      // 于是"暂存写到 A、快照发布在 B"，面板永远看不到改动。
      // 因此：两键**都给了且不一致**时直接 throw，宁可不激活，也不静默分叉。
      //
      // ⚠ 已知限制（**不要**读成"守卫生效"）：`cordis-plugin-include/lib/index.js:99-102`
      //   对 `config` 是**整体替换**（`target[key] = value`），不是深合并。所以任何
      //   **只重述 `cwd`** 的 profile 覆盖层（例如现存形态的 3081
      //   `.t\dsh2\home\profiles\dsh2\cordis.patch.yml`）会把本行 config 换成
      //   `{ cwd }` 而已 —— `workspaceRoot === undefined` ⇒ 上面第一个合取项恒假
      //   ⇒ **本守卫在该实例上不触发**，且 bundle 补丁里锚点提供的
      //   `fs.config.workspaceRoot` 也被整段绕过。此时 drift 检测退化为
      //   "外部约定两处写同一个字面值"。
      //   要让守卫真正生效，profile 覆盖层必须**同时**重述 `workspaceRoot` 与 `cwd`
      //   （T1 正在补）。在此之前，3081 上这条守卫是**空转**的。
      const hasWorkspaceRoot =
        config?.workspaceRoot !== undefined && config?.workspaceRoot !== null && String(config.workspaceRoot).length > 0
      const hasCwd = typeof config?.cwd === 'string' && config.cwd.length > 0
      /**
       * R34-G-03：profile 覆盖层对 `config` 是**整体替换**，不是深合并。只重述
       * `workspaceRoot`、丢掉 `cwd` 时，旧实现会静默回退 `process.cwd()`：
       *   ·  `workspaceRoot`（host 行/fs 行）与真实 `cwd`（暂存键映射）分叉；
       *   ·  `shell-executor` 又把 fs 行的 `workspaceRoot` 当权威根 ⇒ 两半各建一个根；
       * 这正是"暂存写到 A、快照发布在 B"的原始形态。
       * 因此：只要显式给了 `workspaceRoot`，`cwd` 就必须同时存在且指向同一目录；
       * 缺 `cwd` 也算 drift（不再回退到宿主 cwd）。两键都不给（离线自测/无配置）才回退。
       */
      const drift = hasWorkspaceRoot && (!hasCwd || !sameRoot(config.cwd, config.workspaceRoot))
      if (drift) {
        const error = new Error(
          hasCwd
            ? `WinStage 暂存文件系统：配置漂移 —— workspaceRoot(${config.workspaceRoot}) 与 cwd(${config.cwd}) ` +
                '必须指向同一个暂存根，否则"暂存写到 A、快照发布在 B"'
            : `WinStage 暂存文件系统：配置不完整 —— 给了 workspaceRoot(${config.workspaceRoot}) 却没有 cwd。` +
                'profile 覆盖层对 config 是整体替换，必须同时重述 cwd 与 workspaceRoot（不得回退宿主 cwd）。',
        )
        error.code = 'FS_STAGE_ROOT_DRIFT'
        throw error
      }
      /**
       * 工作区根（canonical）—— **键映射与存储根解耦**：`keyOf()` 只用它判断内外，
       * 存储根则按会话走（见 `stagingFor()`）。
       */
      this.workspaceRoot = canonical(hasCwd ? config.cwd : process.cwd())
      /**
       * R34b-G-04：配置了根却指向不存在的目录 ⇒ 装配期 fail-closed。
       * 旧行为会让 `keyOf()` 把每个路径都判成"工作区外"（或让暂存根指向一个不存在的树），
       * 写入/快照的去向不可预测。这里明确拒绝，并提示"三处根必须一致"；不回退宿主 cwd。
       */
      if ((hasCwd || hasWorkspaceRoot) && !existsSync(this.workspaceRoot)) {
        const error = new Error(
          `WinStage 暂存文件系统：配置的工作区根不存在 —— ${this.workspaceRoot}。` +
            '请修正 profile 覆盖层里的 winstage-fs.config.cwd/workspaceRoot（与 host/shell 行一致）；本插件不会自动创建用户工作区。',
        )
        error.code = 'FS_STAGE_ROOT_NOT_FOUND'
        error.root = this.workspaceRoot
        throw error
      }
      /** 装配/自测可固定一个会话身份；生产里不传，按每次调用现解析 */
      this.fixedSessionId =
        typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : undefined
      /** 会话 id（'' = 无会话/共享）→ ReviewService；一次进程内不重复解析 */
      this.sessionServices = new Map()
      /**
       * ★ R19 修复（P1·关态零影响）：共享服务改为**惰性构造**，构造函数绝不建暂存根。
       *
       * 旧实现在这里无条件 `this.staging = this.stagingFor(undefined)`。`getReviewService()`
       * 会 new `ReviewService` → `Workspace.init()` → `Store.ensureLayout()`，于是**只要
       * `winstage-fs` 行被装载**（它恒装载，关态也不 disable —— "一个提供方、两种面"），
       * 哪怕 `config.enabled === false`、`stagingEnabled() === false`，磁盘上都会被创建
       * `%LOCALAPPDATA%\Temp\winstage-stage\<键>\` 的整套布局：
       *   `manifest.json + staged/ candidates/ blobs/ real/ cache/ private/ staged-ext/`
       * 这直接违反"关闭后本插件不做任何检查 / 关态对原 harness 零影响"（`plugin/config.ts`
       * 的 `enabled` 描述、`docs/插件启动-环境监测与开关保证.md` §2），也是"关态仍写盘"的
       * 唯一一处装配期写入。最小复现（先红）：`.t/r19-cordis/probe7.ts` —— 旧实现构造后
       * 8 个条目；`.t/r19-cordis/offstate-diff.ts` C0 现在断言根目录为空。
       *
       * 为什么删掉是安全的：`this.staging` 全文件**只有一个读者**（下面的
       * `unstagedLedgerDir`），其余所有暂存路径都走 `stagingFor(...)`（本身就是惰性 + 缓存）；
       * 而 `noteUnstaged()`（唯一账本写入点）只在 `stagingEnabled()` 为真的分支里被调用，
       * 所以账本落点同样可以按需解析 —— 见下面 `unstagedLedgerDir` 的 getter。
       * ⚠ 不要把它改成"关态时给个空壳服务"：那仍会建根；必须**完全不触碰**存储。
       */
      /**
       * **开态 prewarm（保留既有语义；关态绝不触发）**：开关为**开**时仍在构造期解析一次
       * 共享服务 —— 与 R19 之前的行为对齐（"启动即建共享服务 / 迁移升级前的 `.dshstage/` 旧布局"），
       * 以免惰性化把"启动即迁移"的时机推迟到首次暂存操作。
       * 判据用 `this.stagingEnabled()`（现读 loader 行真值；此时 `workspaceRoot`/`rootEntry`
       * 都已就绪）。**关态下这段一步都不执行** ⇒ 不 `getReviewService()`、不 `ensureLayout()`、
       * 不在磁盘建任何暂存根（`crosscheck-boundaries` §7 与 `.t/r19-cordis/probe7.ts` 钉住）。
       * 解析失败不能拖垮装配：与旧实现一致地只记 error 日志（服务会在首次真正用到时重试）。
       */
      if (this.stagingEnabled()) {
        try {
          this.stagingFor(undefined)
        } catch (error) {
          this.logError(`开态 prewarm 共享暂存服务失败（已忽略，首次暂存操作会重试）：${error?.message ?? error}`)
        }
      }
      /** 已就"某类操作绕过暂存"报过 error 日志的键（只报一次；账本本身不丢） */
      this.warnedUnstaged = new Set()
      /** R34：已就"守卫不可用、只读回退真实磁盘"报过 error 日志的会话键（只报一次） */
      this.warnedReadFallback = new Set()
      /** R34：已判定"守卫不可用且无暂存状态"的会话键（避免每个读入口重复等守卫超时） */
      this.readFallbackSessions = new Set()
      /** 本实例登记的 `watch()` 观察者：`{ rel, isDir, changed }`（见下方 watch 覆写） */
      this.watchers = new Set()
      /**
       * WP4 读侧策略（**默认 `record` = 只记不拦**）。
       *
       * 为什么默认只记：`src/paths.ts` 的 29 条 `MASK_CLASSES` 是**黑名单**
       * （换个文件名就绕过），把它当读边界会给出"已经挡住了"的假承诺。
       * owner 决定：默认只记 + 用户侧可见；`'block'` 作为**显式**开关保留，
       * 但它同样不是边界（它只覆盖本插件的六个读入口）。
       *
       * R24-A1：生产通道 = `WINSTAGE_READ_POLICY`（`fs-entry.ts` 透传 → 本构造参数）。
       * 归一**只**走 `normalizeReadPolicy()`：未设 = record（默认不变）；block = block；
       * **其它非空值 = fail-safe 到 block + 这里一条 error 级日志**（显式配置了却拼错，
       * 不得静默退回"只记不拦"）。`readPolicyRaw/source` 留作机读诊断。
       */
      const readPolicy = normalizeReadPolicy(options.readPolicy)
      this.readPolicy = readPolicy.policy
      this.readPolicyRaw = readPolicy.raw
      this.readPolicySource = readPolicy.source
      if (readPolicy.source === 'invalid-fail-safe') {
        this.logError(
          `读策略配置非法（WINSTAGE_READ_POLICY=${JSON.stringify(readPolicy.raw)}）：fail-safe 到 'block'。` +
            '显式配置了却拼错时不得静默退回"只记不拦"；合法值：record | block（未设 = record）。',
        )
      }
      /**
       * 已就"暂存落点分裂"报过警的逻辑目标（BUG-2）。只报一次：同一个目标每写一次就刷一条
       * error 级日志会把真正的新问题淹掉；但**绝不静默**（第一次一定响）。
       */
      this.warnedSplits = new Set()
      this.log(
        `暂存文件系统已挂载：工作区 = ${this.workspaceRoot}；` +
          `存储 = 按会话隔离（无会话时 .dshstage/ 根）；工作区外写入 = ${stageOutside === 'direct' ? 'direct（显式逃生口）' : 'stage（进暂存，等批准）'}`,
      )
    }

    /**
     * 本次调用的**会话身份**（审批内容隔离的根）。按优先级：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. `sandboxPolicy.sessionId` —— 工具层按会话解析后**随每次写调用**传进来
     *      （dsh-sandbox-policy 的 resolve() 在带 session 时返回它）；
     *   3. **调用方 ctx 上的 ambient initiator**（`ctx.agents.currentInitiator()`）：
     *      agent loop 用 `withInitiator` 包住整轮驱动，所以 read/stat/listDir 这些
     *      **没有 policy 参数**的调用也能拿到身份。
     * 都拿不到 ⇒ `undefined` ⇒ 走共享存储（与升级前逐字一致）。
     */
    sessionIdOf(sandboxPolicy) {
      if (this.fixedSessionId) return this.fixedSessionId
      if (sandboxPolicy && typeof sandboxPolicy.sessionId === 'string' && sandboxPolicy.sessionId.length > 0) {
        return rootSessionIdFor(this.ctx, sandboxPolicy.sessionId) ?? sandboxPolicy.sessionId
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx?.agents
        const session = agents?.currentInitiator?.()
        const id = session?.session?.id ?? session?.id
        // ★ 委派子会话**归到顶层祖先**（用户报障"子 agent 没有包含在沙箱里"）：
        //   不归并的话，子 agent 的写落在子会话自己的暂存存储里 ⇒ 父会话面板一行不显示、
        //   `/winstage approve` 也批不到（既批不了也拒不了 = 静默）。归并**不放宽围栏**：
        //   写仍先落暂存、仍要用户手势才落真实磁盘。口径见 `session-identity.ts` 文件头。
        const agentSession = session?.session ?? session?.agent?.session ?? undefined
        if (typeof id === 'string' && id.length > 0) return rootSessionIdOf(this.ctx, agentSession ?? session) ?? id
      } catch {
        /* 读不到 initiator ⇒ 下面统一记一次日志 */
      }
      // 拿不到会话身份 ⇒ 只能落共享存储（行为与升级前一致），但**必须响**：
      // 静默分流正是"面板里条目随 Turn 消失"的根因（见 review-service.absorbSharedStore）。
      if (!this.warnedNoSession) {
        this.warnedNoSession = true
        this.log(
          '拿不到调用方会话身份（sandboxPolicy.sessionId 与 ctx.agents.currentInitiator() 都不可用）：' +
            '本次变更会落在共享 .dshstage/ 存储；下一次带会话身份的写/命令会自动把它并入会话存储。',
        )
      }
      return undefined
    }

    /**
     * 本次调用的**会话工作区根**（会话自己的 cwd）。
     * 写路径来自 `sandboxPolicy.workspaceRoot`（策略服务按会话 cwd 解析）；读路径没有 policy
     * 参数，改从 ambient initiator 的 `session.header.cwd` 取。
     * @returns {string|undefined} canonical 根；拿不到返回 undefined
     */
    sessionWorkspaceOf(sandboxPolicy) {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0) {
        try {
          return canonical(sandboxPolicy.workspaceRoot)
        } catch {
          /* 落回 ambient */
        }
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx?.agents
        const cwd = agents?.currentInitiator?.()?.session?.header?.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return canonical(cwd)
      } catch {
        /* 读不到 ⇒ undefined */
      }
      return undefined
    }

    /**
     * 本会话是否属于**插件配置的暂存根**。
     *
     * 不匹配时**绝不假装暂存**（那会让"写成功"回执与真实磁盘脱节，且内容进了一个
     * 该会话看不见的待审存储）：调用方改为直接 `super`（平台沙箱/审批面）。
     * 拿不到会话工作区（agentless 调用）时按"属于"处理，保持升级前行为。
     */
    inConfiguredWorkspace(sandboxPolicy) {
      const sessionRoot = this.sessionWorkspaceOf(sandboxPolicy)
      if (sessionRoot === undefined) return true
      try {
        return sameRoot(sessionRoot, this.workspaceRoot)
      } catch {
        return true
      }
    }

    /**
     * 不匹配时的**一次性**日志（每次调用都刷屏没有意义；但静默更糟）。
     */
    warnForeignWorkspace(sandboxPolicy) {
      if (this.warnedForeignWorkspace) return
      this.warnedForeignWorkspace = true
      this.logError(
        `会话工作区（${this.sessionWorkspaceOf(sandboxPolicy) ?? '未知'}）与 WinStage 配置的暂存根（${this.workspaceRoot}）不同：` +
          '本会话的写入**仍然进暂存**（暂存优先，R12 D7-a 修复），并会记一条"配置根不一致"的账到 review.json 的 unstaged 段。',
      )
    }

    /**
     * R12 修复 · D7-a（R19 改为**惰性**）：绕过暂存的账本落点。
     *
     * 为什么必须与 `review.json` **同一个存储根**：`stagingFor(undefined)` 的 `storeDir` 就是
     * `resolveReviewStoreDir()` 对同一个 `workspaceRoot` 的解析结果，与 `ReviewService.publish()`
     * 写 `review.json` 的目录**逐字同源**，于是"记了账"与"面板读得到账"是结构性事实。
     *
     * 为什么改成 getter（R19 关态零影响）：账本写入点 `noteUnstaged()` **只会在
     * `stagingEnabled()` 为真的路径上被调用**，所以关态完全不需要解析它；旧实现把它放在
     * 构造函数里 ⇒ 关态装配也要 `getReviewService()` ⇒ 建暂存根。现在首次真正记账时才解析，
     * 解析失败（根不可用等）仍按 `recordUnstaged()` 既有纪律落 error 日志、绝不让写失败。
     * 解析结果缓存到 `_unstagedLedgerDir`（一次实例生命周期内不变）。
     */
    get unstagedLedgerDir() {
      if (this._unstagedLedgerDir === undefined) {
        try {
          const service = this.stagingFor(undefined)
          this._unstagedLedgerDir = service?.storeDir ?? service?.workspace?.store?.dir ?? null
        } catch (error) {
          // 解析不出来 ⇒ 交给 recordUnstaged() 按"无落点"处理（它会自己响），而不是抛给调用方；
          // 记 null 避免每次记账都重试 + 重复日志（一次实例生命周期内只解析一次）。
          this.logError(`账本落点解析失败（已忽略，不影响本次操作）：${error?.message ?? error}`)
          this._unstagedLedgerDir = null
        }
      }
      return this._unstagedLedgerDir ?? undefined
    }

    /**
     * R12 修复 · D7-a：**"本次操作没有走暂存"必须落账，绝不静默**。
     *
     * 落点选择（为什么是账本文件而不是只打日志）：
     *   · 日志只有读宿主日志的人看得到；R11 D7-a 的实测结论正是"**界面与审计零提示**"；
     *   · 账本写在**与 `review.json` 同一个存储根**，`ReviewService.publish()` 会把
     *     它并进快照的 `unstaged` 段 ⇒ 面板/审计/复核者都必然看得到。
     *
     * 本方法**绝不抛**（记账失败不能把一次正常写入变成失败），失败只走 error 日志。
     *
     * @returns {{reason:string, path:string, appliedToDisk:boolean}|undefined}
     */
    noteUnstaged(op, path, reason, extras = {}) {
      const display = String(path ?? '')
      const record = recordUnstaged(
        this.unstagedLedgerDir,
        {
          op,
          path: display,
          reason,
          appliedToDisk: extras.appliedToDisk === true,
          physical: extras.physical,
          sessionId: extras.sessionId,
        },
        { onError: (message) => this.logError(message) },
      )
      // 人工侧也响一次（与账本同源，不重复计数）：同一个"操作+原因"只报一次，避免刷屏
      const key = `${op}\u0000${reason}`
      if (!this.warnedUnstaged.has(key)) {
        this.warnedUnstaged.add(key)
        this.logError(
          `本次 ${op} **没有走暂存**（原因 ${reason}）："${display}" ` +
            `${extras.appliedToDisk === true ? '已直接落到真实磁盘' : '落在平台面'}` +
            `${extras.physical ? `（物理落点 ${extras.physical}）` : ''}。` +
            '该动作不会出现在待审面板里，也无法被拒绝 —— 这条事实已记入 review.json 的 unstaged 段。',
        )
      }
      return record ? { reason, path: display, appliedToDisk: record.appliedToDisk } : undefined
    }

    /**
     * 会话工作区与配置暂存根不一致时的处理（R12 修复 · D7-a 第 ① 条：**暂存优先**）。
     *
     * ── 为什么改掉旧的"直接 `super.*`"（本次修复的核心决定）──────────────────────
     * 旧实现：`inConfiguredWorkspace()` 为假 ⇒ 立刻 `return super.writeText(...)`。
     * 后果（R11 D7-a 实测）：写入**绕过暂存**、不进 `manifest.json`、不进 `staged\`、
     * 不进待审面板，**却真实落到磁盘**，而界面与审计零提示 ——
     * 一个**配置问题**（暂存根与会话工作区不一致）被翻译成了**隔离悄悄失效**。
     *
     * 现在的口径：**仍然进暂存**，另记一条 `foreign-session-workspace` 的账。
     * 于是"工具说写成功"与"真实磁盘未变"始终一致，面板也一定看得见这条。
     */
    stageOverForeignWorkspace(op, target, sandboxPolicy) {
      const sessionRoot = this.sessionWorkspaceOf(sandboxPolicy)
      this.warnForeignWorkspace(sandboxPolicy)
      this.noteUnstaged(op, target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.FOREIGN_WORKSPACE, {
        sessionId: this.sessionIdOf(sandboxPolicy),
        physical: sessionRoot,
      })
    }

    /** 会话身份 → 该会话自己的审阅服务（缓存；`undefined` ⇒ 共享存储） */
    stagingFor(sessionId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
      let service = this.sessionServices.get(key)
      if (!service) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this
        service = getReviewService({
          workspaceRoot: this.workspaceRoot,
          ...(key ? { sessionId: key } : {}),
          // T3d：只有"本行此刻接管"时才允许认领共享存储里的条目；关闭态一律不认领。
          // （写路径上还有一次显式 `absorbSharedStore()`，在 `!stagingEnabled()` 早退**之后**，
          //   所以关闭态的写既不走暂存也不会认领。）
          claimShared: this.stagingEnabled(),
          ...(this.logger ? { logger: this.logger } : {}),
          /**
           * R12 修复 · D7-b/d：把**生效值**注入审阅服务（与 `stagingEnabled()` 同一处真值）。
           *
           * 这是 `effectiveStagingHint` 的唯一生产来源：`snapshot()` 拿它写出
           * `staging.{effective, mismatch}`，界面因此不会再把"配置值"当成"生效值"。
           * 用 getter 而不是一个固定布尔：开关是**每次现读**的（见 `stagingEnabled()` 注释），
           * 注入快照值会把"热切换"变成"要重启"。
           */
          get effectiveStaging() {
            return { enabled: self.stagingEnabled() }
          },
        })
        this.sessionServices.set(key, service)
      }
      return service
    }

    /**
     * R34：**只读**操作对"守卫建不起来"的窄回退。
     *
     * 背景（实测）：本插件被装进一个**已经受限**的宿主（例如 DSH 自己的
     * workspace-write 沙箱，或任何二级受限令牌）时，`acquireStageGuard()` 会以
     * `root-not-creatable:EPERM` 失败 —— 这是 `R6 / STAGE_GUARD_UNAVAILABLE` 的
     * 既有边界，写入必须 fail-closed，**不能**放宽。
     *
     * 但旧实现让**读也走同一个 `stagingFor()`**（`stat`/`readText`/`listDir`…），
     * 于是"会话工作目录解析"这种只读动作在第一个 Turn 就抛
     * `environmentRetryable`，整个会话起不来。这里把两类操作分开：
     *   · **有既有暂存状态** ⇒ 依旧抛（绝不能把未批准的暂存内容藏起来）；
     *   · **没有任何暂存状态**（连 manifest 都没有）⇒ 只读回退真实磁盘，
     *     并一次性记 error 日志；写入路径**不经过本方法**，仍然 fail-closed。
     *
     * 判据保守：manifest 存在但读不懂/解析失败 ⇒ 当作"有状态"，fail-closed。
     */
    stagingForRead(sessionId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
      if (!this.readFallbackSessions) this.readFallbackSessions = new Set()
      /**
       * 已经判定过"守卫建不起来、且无暂存状态" ⇒ 本次进程内不再重试 `stagingFor()`。
       * 否则每个读入口都会重新走一遍 `acquireStageGuard()`（最坏情况要等 keeper
       * 超时 20s）——一个会话的启动会因此被放大成 N 个 20s。若之后真的出现了暂存
       * 状态（例如另一个进程写入），`stagingFor()` 会重新尝试并照旧抛错（fail-closed）。
       */
      if (this.readFallbackSessions.has(key)) {
        if (this.hasExistingStagedState(sessionId)) return this.stagingFor(sessionId)
        return undefined
      }
      try {
        return this.stagingFor(sessionId)
      } catch (error) {
        if (error?.code !== STAGE_GUARD_UNAVAILABLE) throw error
        if (this.hasExistingStagedState(sessionId)) throw error
        this.readFallbackSessions.add(key)
        if (!this.warnedReadFallback) this.warnedReadFallback = new Set()
        if (!this.warnedReadFallback.has(key)) {
          this.warnedReadFallback.add(key)
          this.logError(
            `会话工作根不可用（code=${error.code}，reason=${error.reason ?? 'n/a'}）且本会话没有既有暂存状态：` +
              '本次只读操作回退真实磁盘；写入仍按环境类失败拒绝（绝不静默写真实盘）。',
          )
        }
        return undefined
      }
    }

    /**
     * 该会话是否已有**会被投影**的暂存状态。
     *
     * 只看 manifest 的 `entries`：它才是"有没有待批/已暂存条目"的权威；缺失或解析失败时
     * 保守地返回 `true`（fail-closed）。同时检查新布局（缓存根）与旧 `<workspace>/.dshstage`
     * 布局，避免迁移期把旧暂存内容藏起来。
     */
    hasExistingStagedState(sessionId) {
      const dirs = []
      try {
        dirs.push(resolveReviewStoreDir({ workspaceRoot: this.workspaceRoot, sessionId }))
      } catch {
        /* 解析失败 ⇒ 下面按"无状态"处理，但仅在两个布局都确实不存在时才回退 */
      }
      try {
        dirs.push(join(this.workspaceRoot, '.dshstage'))
      } catch {
        /* ignore */
      }
      // 旧布局还有 `<workspace>/.dshstage/sessions/<会话键>/manifest.json` 这一层；
      // 迁移期一旦存在任何会话的暂存清单，就不允许"只读回退"把内容藏起来。
      try {
        const legacySessions = join(this.workspaceRoot, '.dshstage', 'sessions')
        if (existsSync(legacySessions)) {
          for (const name of readdirSync(legacySessions)) dirs.push(join(legacySessions, name))
        }
      } catch {
        return true // 列不动旧布局 ⇒ 不能证明没有暂存内容，保守 fail-closed
      }
      for (const dir of dirs) {
        if (!dir) continue
        let manifestPath
        try {
          manifestPath = join(String(dir), 'manifest.json')
        } catch {
          continue
        }
        if (!existsSync(manifestPath)) continue
        try {
          const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
          const entries = parsed?.entries
          if (entries && typeof entries === 'object' && Object.keys(entries).length > 0) return true
          // manifest 存在但 entries 为空：没有可投影的条目，允许回退。
        } catch {
          // manifest 在但读不懂：保守 fail-closed（不能证明没有暂存内容）。
          return true
        }
      }
      return false
    }

    /**
     * 本行此刻是否应当接管变更面 —— **开关的唯一真源**。
     *
     * 读的是 loader 行 `winstage-sandbox`（设置页那一行）的 `config.enabled`，而且
     * **每次调用都现读**：`rootEntry.parent.data` 是 patch 组合后的那一份，设置改动走
     * configEditor → reconcileProfilePatches → `EntryGroup.update()` 会把整份换新
     * （`parent` 这个 EntryGroup 对象本身不变，只有它的 `data` 被换）。
     * 因此"关掉/打开"即时生效，且**不需要卸载或重挂任何行**；命令面与面板也按
     * 同一个开关现读，所以三处不会漂移。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为。
     */
    stagingEnabled() {
      const enabled = this.stagingEnabledRaw()
      /**
       * R12 修复 · D7-b/d：**顺手登记生效值**（进程内台账，零 IO）。
       *
       * 登记点是这里而不是构造时：`stagingEnabled()` 是"开关的唯一真源"，
       * 每次调用都现读 ⇒ 用户热切换开关时台账跟着变，快照里的 `staging.effective`
       * 也必然跟着变。`snapshot()` 只是把它读出来，不另立一个权威。
       */
      try {
        noteEffectiveStaging(this.workspaceRoot, enabled)
      } catch {
        /* 登记失败绝不影响开关判定 */
      }
      return enabled
    }

    /** `stagingEnabled()` 的原始判定（登记逻辑见上面的包装） */
    stagingEnabledRaw() {
      if (enabledOverride) return enabledOverride() !== false
      try {
        // 只认构造时抓住的 rootEntry；`this.ctx.fiber.entry` 会指向**调用方**（见构造函数注释）
        const data = (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data
        if (!Array.isArray(data)) return true
        const row = data.find((item) => item && item.id === 'winstage-sandbox')
        if (!row || !row.config) return true
        return row.config.enabled !== false
      } catch {
        return true
      }
    }

    /**
     * 围栏能力**只跟着开关的面走**：
     *   - 开启（暂存面）：报 `undefined`，`dsh-tool-fs` 就不向模型广告
     *     `sandbox_permissions` —— 升权了变更也仍进暂存，广告它只会失真；
     *   - 关闭（平台面）：报平台后端自己的默认模式（`super.sandboxMode`），
     *     于是 `[sandbox: …]` 拒绝与同回合升权提示都与"没装本插件"逐字一致。
     */
    get sandboxMode() {
      if (this.stagingEnabled()) return undefined
      return super.sandboxMode
    }

    // ==================== 暂存落点：命名空间互见 + 原子 mkdir + 回读闸门 ====================
    //
    // 这一节是 BUG-1 / BUG-2 / BUG-8 的修复面，三条口径写在这里、不要在别处另立一套：
    //   ① **不静默**：任何暂存写入都要**回读**确认产物真的存在且内容一致，才允许返回成功
    //      （`verifyPersistedWrite()` → `staging_write_not_persisted`）；
    //   ② **互见**：读取时清单落点与 shim/shell 落点**两边都看**；写入归一到清单落点；
    //      两边同时存在且指向同一逻辑目标时，给一条可见告警并把真实落点写进写入回执
    //      （`shimContentOf()` / `locationReceipt()` / `warnSplitOnce()`）；
    //   ③ **原子**：多级目录逐层创建、逐层回读，失败回滚并点名**具体哪一层**
    //      （`ensureStagedParentsAtomic()` → `staging_mkdir_failed`）。

    /** shim/shell 布局的存储根（= `Store.stagedDir`；`fs/` 与 `wo/` 就挂在它下面） */
    stagedDirOf(ws) {
      const dir = ws?.store?.stagedDir
      return typeof dir === 'string' && dir.length > 0 ? dir : undefined
    }

    /** 本插件通道里该清单键的物化落点（`staged/<rel>` 或 `staged-ext/<分桶>/<叶名>`） */
    stagedPathOf(ws, key) {
      try {
        return ws.store.stagedPath(key)
      } catch {
        return undefined
      }
    }

    /** 同一逻辑目标在 shim/shell 通道里的物理落点（内容树） */
    shimMirrorOf(ws, abs) {
      return shimLayoutPathOf(this.stagedDirOf(ws), abs, SHIM_FS_LEAF)
    }

    /**
     * **读取时两边都看**（BUG-2）：清单/`staged/<rel>` 之外，再看 shim/shell 通道的
     * `<staged>\fs\<盘符>\<绝对路径>`；命中就返回与 `currentOf()` 同形状的结果。
     *
     * `version` 是内容的稳定函数（`winstage:shimfs:<sha256>`）：同一内容永远同一版本，
     * 满足 `dsh-tool-fs` 的观测契约（与文件头契约 ① 同一条）。
     * 内容树里没有、但 `wo\` 有删除标记 ⇒ 按**已删除**处理（`workspace.ts` 同口径）。
     */
    shimContentOf(ws, target, abs) {
      const mirror = this.shimMirrorOf(ws, abs)
      if (mirror === undefined) return undefined
      let info
      try {
        info = statSync(mirror)
      } catch {
        return undefined
      }
      if (info.isDirectory()) {
        return {
          exists: true,
          kind: 'dir',
          version: `winstage:shimfs:dir:${String(abs).toLowerCase()}`,
          layout: 'shim-fs',
          physical: mirror,
        }
      }
      if (!info.isFile()) return undefined
      let buffer
      try {
        buffer = readFileSync(mirror)
      } catch {
        return undefined
      }
      const hash = sha256Of(buffer)
      return {
        exists: true,
        kind: 'file',
        text: buffer.toString('utf8'),
        version: `winstage:shimfs:${hash}`,
        hash,
        layout: 'shim-fs',
        physical: mirror,
      }
    }

    /** shim/shell 通道的删除标记（`<staged>\wo\<盘符>\<绝对路径>`）；没有返回 `undefined` */
    shimWhiteoutOf(ws, abs) {
      const marker = shimLayoutPathOf(this.stagedDirOf(ws), abs, SHIM_WHITEOUT_LEAF)
      if (marker === undefined) return undefined
      try {
        return statSync(marker).isFile() ? marker : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 该清单键在两套布局里**有没有本插件可见的内容**：清单里有**构成净变化的**条目，
     * 或 shim/shell 通道的落点存在，或 shim 的删除标记存在。
     *
     * 读取面据此决定"要不要走暂存投影"。判据必须是 `hasEntry()`（净变化）而不是
     * "条目存在"：后者的语义是"这条已经被批准过、磁盘就是真值"，那样会让
     * `readText` 绕过基线后端的二进制/解码校验（返回空串而不是抛错）。
     */
    hasStagedContent(ws, key, abs) {
      if (this.hasEntry(ws, key)) return true
      const mirror = this.shimMirrorOf(ws, abs)
      if (mirror !== undefined) {
        try {
          if (existsSync(mirror)) return true
        } catch {
          /* 探测失败 ⇒ 按"没有"处理，由真实磁盘分支兜底 */
        }
      }
      return this.shimWhiteoutOf(ws, abs) !== undefined
    }

    /**
     * shim 布局里某个目录的**直接子项**（`listDir` 合并用）。
     *
     * 返回 `{ entries, deleted }`：`deleted` 是被 `wo\` 标记删除的子项名（小写）——
     * 调用方据此**压掉**真实磁盘/清单里的同名项，"删除"这一逻辑状态才不会被宿主一侧复活。
     * 目录不存在 ⇒ `undefined`（调用方按"该布局没有这个目录"处理）。
     */
    shimChildrenOf(ws, shimDir) {
      if (shimDir === undefined) return undefined
      const stagedDir = this.stagedDirOf(ws)
      let dirents
      try {
        dirents = readdirSync(shimDir, { withFileTypes: true })
      } catch {
        return undefined
      }
      const entries = []
      const deleted = new Set()
      for (const dirent of dirents) {
        const childDir = join(shimDir, dirent.name)
        const childAbs = logicalFromShimLayout(stagedDir, childDir, SHIM_FS_LEAF)
        if (childAbs === undefined) continue
        let target
        try {
          target = { targetKey: FsTargetKey(canonical(childAbs)), displayPath: childAbs }
        } catch {
          continue
        }
        if (this.shimWhiteoutOf(ws, childAbs) !== undefined) {
          deleted.add(dirent.name.toLowerCase())
          continue
        }
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, type: 'directory', target })
          continue
        }
        if (!dirent.isFile()) continue
        let size
        let version
        try {
          const info = statSync(childDir)
          size = info.size
          version = FsVersion(`winstage:shimfs:${sha256Of(readFileSync(childDir))}`)
        } catch {
          continue
        }
        entries.push({ name: dirent.name, type: 'file', target, version, size })
      }
      return { entries, deleted }
    }

    /**
     * ★ R11-D（`readdir` vs `stat` 一致性）：`wo\` 布局里某个**逻辑目录**的直接子项删除标记。
     *
     * 为什么必须单独有它：`shimChildrenOf()` 只能**从内容树 `fs\` 出发**发现删除标记
     * （`staged\fs\<盘符>\<绝对路径>` 的每个子项再看它有没有同名 `wo\` 标记）。于是当
     * **真实磁盘上的文件被删除、而内容树里没有它的对应项**时（这是删除的常见形态：
     * 目标本来只存在于真实盘），`shimChildrenOf()` 返回的 `deleted` 永远是空集，
     * 更糟的是内容目录 `fs\...\<dir>` 根本不存在 ⇒ 它返回 `undefined` ⇒
     * `listDirInner()` 直接早退回 `super.listDir()`，**整棵 `wo\` 树被忽略**。
     *
     * 实测形态（`.t/round10/fileio/toolface-consistency.ts` 的 C6/C7）：
     *   · `listDir(dir)` **列着** `realdel.txt`（真实盘那一侧给出来的）；
     *   · `stat(realdel.txt)` 返回**不存在**（`currentOf()` 走 `shimWhiteoutOf()`）。
     *   ⇒ 同一目录上 `readdir` 与 `stat` **自相矛盾**（与 `exe` 域 D-EXE-6 同形）。
     *
     * 判据与 `currentOf()` 的 `shimWhiteoutOf()` **同一棵树、同一个口径**：`wo\` 镜像
     * 逻辑目录结构，其下的每个直接子项名 = 该子项被逻辑删除。目录自身被标记删除时
     * 返回空集与 `selfDeleted: true`，调用方据此返回空列表（与 `stat` 的"不存在"一致）。
     */
    shimDeletionsOf(ws, dirAbs) {
      const stagedDir = this.stagedDirOf(ws)
      const woDir = shimLayoutPathOf(stagedDir, dirAbs, SHIM_WHITEOUT_LEAF)
      if (woDir === undefined) return undefined
      let dirents
      try {
        dirents = readdirSync(woDir, { withFileTypes: true })
      } catch {
        return undefined
      }
      const deleted = new Set()
      for (const dirent of dirents) deleted.add(dirent.name.toLowerCase())
      return { deleted, selfDeleted: this.shimWhiteoutOf(ws, dirAbs) !== undefined }
    }

    /**
     * ★ **BUG-8：多级目录原子化 + 逐层回读**。
     *
     * 现场（3081 `session-d6e30323` FS-03，原始输出见 `_r3\bugc-evidence-final.txt`）：
     * `New-Item -Force` 建 8 层深目录，只有最深两层报 `…is denied`，a–f 层**一句报错都没有**，
     * 而暂存树里一个目录都没落下（`staged_exists=False`、`deep_depth_ok=False`）——
     * "报成功但产物不存在"的目录版。
     *
     * 这里把"建目录"从 `mkdirSync(recursive:true)`（只有一次成败、失败还说不出是哪一层）
     * 换成**逐层非递归 + 每层立刻回读**：
     *   · 任一层失败 ⇒ 把**本次调用新建的层**按深度倒序回滚（不留半成品），
     *     再抛 `staging_mkdir_failed`：`error.level` = 失败的那一层（**具体到层**）、
     *     `error.createdLevels` / `error.rollback` = 建了哪些、回滚结果；
     *   · 每层建完**立刻** `statSync().isDirectory()` 复核 —— "mkdir 没抛错"不算成功证据。
     *
     * @param {string} stagedParent 物化对象的**父目录**（`dirname(stagedPath)`）
     * @param {string} stagedPath 物化对象本身（只用于报错时给出完整落点）
     */
    ensureStagedParentsAtomic(stagedParent, stagedPath) {
      if (typeof stagedParent !== 'string' || stagedParent.length === 0) return { created: [], levels: 0 }
      /** 自深向浅收集"不是目录"的层（含**被文件挡住**的那一层，那也要点名） */
      const missing = []
      let cursor = stagedParent
      while (typeof cursor === 'string' && cursor.length > 0) {
        let isDir = false
        try {
          isDir = statSync(cursor).isDirectory()
        } catch {
          isDir = false
        }
        if (isDir) break
        missing.push(cursor)
        const parent = dirname(cursor)
        if (parent === cursor || parent.length === 0) break
        cursor = parent
      }
      missing.reverse() // 由浅到深
      const created = []
      const rollback = []
      const fail = (level, error) => {
        // 全败：本次新建的层按深度倒序撤掉（非递归 rmdir：绝不误删别人往里面放的东西）
        for (const done of [...created].reverse()) {
          try {
            rmdirSync(done)
          } catch (cleanupError) {
            rollback.push({ path: done, code: cleanupError.code, message: cleanupError.message })
          }
        }
        const detail = [error?.code, error?.message].filter(Boolean).join(': ')
        this.logError(
          `暂存目录创建失败（BUG-8）：${level ?? stagedPath} —— ${detail || '未知错误'}` +
            `（本次新建 ${created.length} 层，已回滚 ${created.length - rollback.length} 层）`,
        )
        const failure = new FsError(
          `cannot create the staging directory for "${stagedPath}": failed at level "${level}"` +
            `${detail ? ` (${detail})` : ''} — ${created.length} level(s) created by this call were rolled back; nothing was staged.`,
          'staging_mkdir_failed',
        )
        failure.level = level
        failure.stagedPath = stagedPath
        failure.createdLevels = [...created]
        failure.rollback = rollback
        failure.cause = error
        throw failure
      }
      for (const level of missing) {
        let alreadyDir = false
        try {
          alreadyDir = statSync(level).isDirectory()
        } catch {
          alreadyDir = false
        }
        if (!alreadyDir) {
          try {
            mkdirSync(level) // 非递归：一次只建一层 ⇒ "哪一层失败"永远可归因
          } catch (error) {
            // EEXIST 可能是并发方刚建好；仍然要过下面的回读，不当作成功。
            if (error.code !== 'EEXIST') return fail(level, error)
          }
        }
        let verified = false
        try {
          verified = statSync(level).isDirectory()
        } catch {
          verified = false
        }
        if (!verified) {
          return fail(level, Object.assign(new Error('mkdir reported success but the directory is not there'), { code: 'EPERSIST' }))
        }
        if (!created.includes(level)) created.push(level)
      }
      return { created, levels: missing.length }
    }

    /**
     * ★ **BUG-1 的闸门：只有回读证明产物真的存在且内容一致，才允许返回成功**。
     *
     * 三条独立判据（缺一不可）：
     *   ① 清单条目声明的 `stagedHash` == 提交内容的 sha256；且**磁盘上的 `manifest.json`**
     *      里也是同一个 hash（"本进程内存里自洽"不算证据，新进程读的是磁盘那一份）；
     *   ② 内容对象 blob 在磁盘上、且**逐字节等于**提交内容 —— `Store.putBlob()` 对已存在的
     *      `<blobs>/<aa>/<hash>` 是**信任式**的（只看路径在不在，不校验内容），
     *      这正是"进程内自洽、落盘不一致"能成立的那条缝；
     *   ③ 物化暂存对象（`staged/<rel>` 或 `staged-ext/<分桶>/<叶名>`）存在、是普通文件、
     *      逐字节相等 —— 3079/3081 实测 BUG-1 的形态正是 `staged_exists=False`。
     *
     * 任一不成立 ⇒ 抛 `staging_write_not_persisted`（**不是**返回成功，也**不是**返回一个
     * "看起来对"的 version），同时留一条 error 级日志与清单上的 `persistenceFailure` 记账。
     */
    verifyPersistedWrite({ ws, key, abs, buffer, displayPath }) {
      const entry = ws.entryOf(key)
      const hash = sha256Of(buffer)
      const stagedPath = this.stagedPathOf(ws, key)
      const problems = []
      const fail = (reason, detail) => {
        problems.push({ check: reason, ...(detail ? { detail } : {}) })
      }

      if (!entry) fail('manifest-entry-missing', `no manifest entry for "${key}"`)
      else {
        if (entry.state !== STATE.FILE) fail('manifest-entry-not-a-file', `state=${entry.state} (expected ${STATE.FILE})`)
        if (entry.kind !== 'file') fail('manifest-entry-kind', `kind=${entry.kind}`)
        if (entry.stagedHash !== hash) fail('manifest-hash-mismatch', `stagedHash=${entry.stagedHash} expected=${hash}`)
      }

      // ② blobs/<aa>/<hash> 必须真的装着**这次提交的内容**
      let blobBytes
      try {
        if (!ws.store.hasBlob(hash)) fail('blob-missing', `no blob at ${ws.store.blobPath(hash)}`)
        else {
          blobBytes = ws.store.readBlob(hash)
          if (!blobBytes.equals(buffer)) {
            fail('blob-content-mismatch', `${blobBytes.length} bytes on disk vs ${buffer.length} submitted`)
          }
        }
      } catch (error) {
        fail('blob-unreadable', `${error?.code ?? ''} ${error?.message ?? error}`.trim())
      }

      // ③ 物化对象必须真的在暂存树里、且内容一致
      try {
        const info = statSync(stagedPath)
        if (!info.isFile()) fail('staged-object-not-a-regular-file', `type at ${stagedPath}`)
        else {
          const onDisk = readFileSync(stagedPath)
          if (!onDisk.equals(buffer)) {
            fail('staged-object-content-mismatch', `${onDisk.length} bytes at ${stagedPath} vs ${buffer.length} submitted`)
          }
        }
      } catch (error) {
        fail('staged-object-missing', `${error?.code ?? ''} at ${stagedPath}`.trim())
      }

      // ①b 磁盘上的 manifest.json（"新进程看到的那一份"）
      try {
        const raw = JSON.parse(readFileSync(ws.store.manifestPath, 'utf8'))
        const persisted = raw?.entries?.[key]
        if (!persisted) fail('manifest-not-persisted', `no entry for "${key}" in ${ws.store.manifestPath}`)
        else if (persisted.stagedHash !== hash) {
          fail('manifest-persisted-hash-mismatch', `${persisted.stagedHash} on disk vs ${hash} submitted`)
        }
      } catch (error) {
        fail('manifest-unreadable', `${error?.code ?? ''} ${error?.message ?? error}`.trim())
      }

      if (problems.length === 0) return { hash, stagedPath, verified: true }

      const summary = problems.map((item) => `${item.check}${item.detail ? ` (${item.detail})` : ''}`).join('; ')
      this.logError(
        `暂存写入**没有**持久化（BUG-1）："${displayPath}" → ${stagedPath} —— ${summary}。` +
          '本次写入不返回成功。',
      )
      if (entry) {
        entry.persistenceFailure = { at: new Date().toISOString(), hash, stagedPath, problems }
        try {
          ws.store.touch(ws.manifest)
        } catch {
          /* 记账失败不掩盖真正的失败 */
        }
      }
      const failure = new FsError(
        // ★ WP2 透明性：这句话是**模型可见**的 ⇒ 零机制字样（不出现 staging/stage/暂存/
        //   替代路径/overlay），也**不回显**暂存落点。诊断细节一律挂下面的非 message 属性，
        //   完整原因进 `logError`（人工侧）。自检见 `assertTransparentFailureTexts()`。
        MODEL_VISIBLE_FAILURE_TEXTS.writeNotPersisted(displayPath),
        'staging_write_not_persisted',
      )
      failure.stagedPath = stagedPath
      failure.expectedHash = hash
      failure.problems = problems
      throw failure
    }

    /** 分裂告警：同一逻辑目标在两套布局里都有落点时，报**一条**（不刷屏、也不静默） */
    warnSplitOnce(abs, stagedPath, foreign) {
      const key = String(abs).toLowerCase()
      if (this.warnedSplits.size > 200) this.warnedSplits.clear()
      if (this.warnedSplits.has(key)) return
      this.warnedSplits.add(key)
      this.logError(
        `暂存落点分裂（BUG-2）：同一逻辑目标 ${abs} 同时存在于两套互不可见的布局 —— ` +
          `本插件落点 ${stagedPath}（本次写入已归一到这里，读取时两边都看）；` +
          `shim/shell 通道落点 ${foreign}。清单/审批/快照只认前者，后者不会被自动清理。`,
      )
    }

    /**
     * 写入回执（WP9 之后：**可见的那一段**只带真实工作区路径）。
     *
     * 历史（BUG-2）要求"把真实落点写进写入回执"，当时的做法是把
     * `layout`（`staged` / `staged-ext`）与 `stagedPath`（暂存根下的物理落点）
     * 直接塞进 `writeText` 的返回对象。实证结论见本文件 WP9 段：
     * `dsh-tool-fs` 只取 `operation`/`version`/`before`/`after`，**不渲染**这些键 ——
     * 但它们是"一次展开或 JSON 化就到模型"的形状（`staged` / `staged-ext` / `.dshstage`
     * 全在里面）。因此：
     *   · 可见面只留 `logicalPath`（= 真实工作区绝对路径，模型本就该看到它）；
     *   · 真实落点 / 第二套布局 / 分裂标记全部走 `STAGE_DIAGNOSTICS` 非枚举旁路
     *     （见 `attachStageDiagnostics()`），人工侧与自测用 `stageDiagnosticsOf()` 读。
     */
    locationReceipt(ws, key, abs, current) {
      /**
       * R40-E2E（真机实测）：**不要**把 `logicalPath` 放进可见 outcome。
       * `dsh-tool-fs` 的 write/edit 输出 schema 是 `additionalProperties:false`，只声明
       * `operation/version/before/after`；多一个 `logicalPath` 会让工具返回
       * `value.logicalPath is not a declared property` —— 写明明成功进了暂存，模型却拿到
       * 一条失败回执（实测：两个 write 都报 invalid output，随后 read 仍能读到暂存内容）。
       * 逻辑路径已由 render 的 `<path>` 呈现；诊断面仍保留 `logicalPath`（非模型可见）。
       */
      return {}
    }

    /** 真实落点诊断（**非模型可见**；BUG-2 的 `stagedPath` / `otherLayout` / `splitDetected`） */
    locationDiagnostics(ws, key, abs, current) {
      const stagedPath = this.stagedPathOf(ws, key)
      const diagnostics = {
        layout: isExternalKey(key) ? 'staged-ext' : 'staged',
        stagedPath,
        logicalPath: abs,
      }
      // ── R11-D / D1：工作区外写的**诚实记账**（非枚举旁路；模型面到不了，见修复报告 §1.2）
      // 三个事实必须能被"人工面/面板/自测"读到，而不是只体现在"工具说成功"上：
      //   outsideWorkspace  这次写入的目标在工作区之外；
      //   appliedToDisk     **false** —— 真实磁盘一位未改（默认 `'stage'` 档）；
      //   pendingApproval   true —— 已进待批队列，等用户批准才落盘。
      // 只有 `stageOutside === 'stage'` 且目标在工作区外时才有意义；`'direct'` 档是
      // 直写真实盘（`appliedToDisk` 应为 true 且不产生条目），`'deny'` 档在更前面就抛了。
      if (isExternalKey(key)) {
        diagnostics.outsideWorkspace = true
        diagnostics.stageOutside = stageOutside
        diagnostics.appliedToDisk = stageOutside === 'direct'
        diagnostics.pendingApproval = stageOutside !== 'direct'
      }
      const mirror = this.shimMirrorOf(ws, abs)
      let foreign = current && current.layout === 'shim-fs' ? current.physical : undefined
      if (foreign === undefined && mirror !== undefined) {
        try {
          if (existsSync(mirror)) foreign = mirror
        } catch {
          foreign = undefined
        }
      }
      if (foreign !== undefined) {
        diagnostics.otherLayout = { layout: 'shim-fs', path: foreign }
        diagnostics.splitDetected = true
        this.warnSplitOnce(abs, stagedPath, foreign)
      }
      return diagnostics
    }

    // ==================== 路径映射 ====================

    /**
     * `FsTarget` → **清单键**（S3a）。
     *
     *   工作区**内** → `{ key: <相对路径>, external: false, abs }`（根为 `''`）
     *   工作区**外** → `{ key: <规范化绝对路径>, external: true, abs }`
     *
     * 根返回 `''` 而不是 `undefined` 是**必须**的：根自身不参与暂存（写根会报错），
     * 但根的**目录枚举**必须合并暂存子项 —— 早期版本在这里返回 `undefined`，
     * 导致"只在暂存里存在的新目录"在根枚举中消失（自测抓到）。
     *
     * 外部键用**绝对路径**（与 `src/workspace.ts` 的 `keyOf()` 同一模型），
     * 因此 `entryOf()` 对两种条目是同一个查找，键空间天然不相交。
     */
    /**
     * R40-FS-04（P1）：本进程要保护的**存储根**清单（`compareKey` 归一，大小写/分隔符不敏感）。
     *
     * 两个来源，缺一不可：
     *   · 本会话的新根 `resolveReviewStoreDir()`（Phase 1 之后的唯一写入口，
     *     `%LOCALAPPDATA%\Temp\winstage-stage\<会话>` 或 `WINSTAGE_STAGE_ROOT`）；
     *   · 旧布局根 `<workspaceRoot>/.dshstage`（只读/搬迁用；词法守卫继续对它生效）。
     *
     * 残余（如实标注）：**兄弟会话**的根（同一 `winstage-stage` 下的别的会话目录）不在本
     * 清单里 —— 那需要枚举 baseDir，超出本守卫的"本会话状态机"口径，本轮不宣称覆盖。
     */
    stateRoots() {
      // 刻意**不缓存**：解析是纯函数（无 IO 副作用），而 `WINSTAGE_STAGE_ROOT`/会话身份
      // 都可能在同一进程内变化（测试与多会话宿主）；缓存旧根会让守卫在错的目标上生效。
      const roots = []
      const add = (path) => {
        if (typeof path !== 'string' || path.length === 0) return
        try {
          roots.push(compareKey(canonical(path)))
        } catch {
          roots.push(path.replace(/\//g, '\\').toLowerCase())
        }
      }
      try {
        add(resolveReviewStoreDir({ workspaceRoot: this.workspaceRoot, sessionId: this.sessionIdOf() }))
      } catch {
        /* 解析失败不阻断写路径：词法守卫仍然生效 */
      }
      try {
        add(legacyWorkspaceStoreDir(this.workspaceRoot))
      } catch {
        /* 同上 */
      }
      /**
       * R40-FS-04 残余收口：**兄弟会话**的存储根同样不能被 `ctx.fs` 改写。
       * 同一 `winstage-stage` base 下的每个会话目录（有 manifest/review 的）都加进守卫；
       * 只枚举本机缓存 base（通常个位数目录），不递归、不跟随链接。
       */
      try {
        const base = stageBaseDir(process.env)
        if (existsSync(base)) {
          for (const name of readdirSync(base)) {
            try {
              const dir = join(base, name)
              if (!statSync(dir).isDirectory()) continue
              if (existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, 'review.json'))) add(dir)
            } catch {
              /* 单个目录读不到就跳过，不阻断写路径 */
            }
          }
        }
      } catch {
        /* base 不可读 ⇒ 只保护已知根 */
      }
      return roots
    }

    /**
     * P0-8：**经 `ctx.fs` 的存储写入一律拒绝**（"失败必须响"）。
     *
     * 抛 `FsError` + `FS_SANDBOX_DENIED`：`dsh-tool-fs` 的 `mapError()`（实测
     * `dsh-tool-fs/lib/index.js:1159-1163`）会把**这条 message 整体换成**平台的
     * `[sandbox: <mode>]` 拒绝标记 + 同回合升权提示 —— 也就是说模型看到的是平台那套
     * 原生拒绝文案（与"没装本插件"逐字一致），本函数的 message 只进日志/`cause`。
     * 因此这里的话术只需对**人工侧**负责：不含暂存/机制行话，也不假装是策略边界。
     */
    denyStoreWrite(place, verb) {
      const target = String(place?.abs ?? '')
      this.logError(`P0-8 refused to ${verb} WinStage's own store: ${target}`)
      throw new FsError(
        MODEL_VISIBLE_FAILURE_TEXTS.storeWriteDenied(target),
        'FS_SANDBOX_DENIED',
      )
    }

    /**
     * `stageOutside: 'deny'`：工作区外写入的**显式拒绝**（opt-in，默认仍是 `'stage'`）。
     *
     * 语义与"暂存"档的区别，只在这两件事上：
     *   · 不产生任何条目/候选（真实盘与暂存树**都不动**）；
     *   · 抛 `FS_SANDBOX_DENIED`，模型面看到一条失败回执。
     *
     * 为什么文案按"普通失败"口径写：`dsh-tool-fs` 的 `mapError()` 只在
     * `error.code === 'FS_SANDBOX_DENIED'` 时把 message 换成平台 `[sandbox: <mode>]`
     * 标记 + 同回合升权提示。**本插件的暂存面 `sandboxMode` 返回 `undefined`**
     * ⇒ 该组合下 `FsSandboxController.policy === undefined`（`escalationModes === []`），
     * 实测（`evidence/fix/probe-store-deny/`，经同一 `denyStoreWrite` 通道）模型看到的
     * 是**本插件自己的文案**，既没有标记、也没有崩（读码上 `mapError` 会读
     * `policy.mode`，但该分支实测未被走到）。因此这里的话术必须自己就诚实、可读，
     * 不能指望平台标记兜底。
     */
    denyOutsideWrite(place, verb) {
      const target = String(place?.abs ?? '')
      this.logError(
        `stageOutside='deny' refused to ${verb} outside the workspace: ${target}` +
          `（未写真实磁盘、未产生条目/候选）`,
      )
      throw new FsError(MODEL_VISIBLE_FAILURE_TEXTS.outsideWriteDenied(target), 'FS_SANDBOX_DENIED')
    }

    keyOf(target) {
      try {
        const abs = canonical(target.targetKey)
        const root = this.workspaceRoot
        const rel = relative(root, abs)
        if (rel === '') return { key: '', external: false, abs: root }
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { key: abs, external: true, abs }
        return { key: rel, external: false, abs }
      } catch {
        return undefined
      }
    }

    entryOf(ws, rel) {
      return ws.entryOf(rel)
    }

    /**
     * 该路径是否存在**构成净变化的**暂存条目。
     *
     * 不再是"清单里有条目就算"：批准过的条目**不会**从清单里消失 —— `applyOneChange()`
     * 只是把 `baseHash = stagedHash` 标记为"已是新基线"（src/workspace.ts:1002-1015）。
     * 此后真实文件若被外部改过，暂存 blob 仍是**批准当时**的旧内容；继续遮蔽真实磁盘就会
     * 让用户看到"净 diff 是空的、read 却是陈旧内容" —— 那正是面板那句"已不在当前净 diff：
     * 暂存内容已被取代，无法再批准"不可见的那一半。
     */
    hasEntry(ws, rel) {
      return this.projectsEntry(ws.entryOf(rel))
    }

    /**
     * 该暂存条目是否构成**净变化** —— 只有净变化才允许遮蔽真实磁盘。
     *
     * 判据与 `src/workspace.ts:780 diffEntries()` **逐条对齐**（同一个仓库不能有两套
     * "什么算变化"的口径）：删除类看真实基线是否曾经存在、目录类只看**非合成**的 mkdir、
     * 文件类看 `stagedHash !== baseHash`。
     */
    projectsEntry(entry) {
      if (!entry) return false
      if (entry.state === STATE.DELETED) {
        return !(entry.baseHash === hashAbsent() && entry.baseKind === undefined)
      }
      if (entry.kind === 'dir') return entry.baseKind !== 'dir' && entry.synthetic !== true
      return entry.stagedHash !== entry.baseHash
    }

    /**
     * 该目录下（含自身）是否有暂存条目；根（`''`）表示"暂存树里是否有工作区内条目"。
     * 键空间隔离：列工作区内目录时不把外部条目算进来（反之亦然）——
     * 否则 `C:\out` 会被当成工作区根的直接子项（`c:`）混进根枚举。
     */
    hasEntryUnder(ws, rel) {
      const external = isExternalKey(rel)
      const inSpace = (entry) => (entry.external === true) === external
      const projects = (entry) => this.projectsEntry(entry)
      if (rel === '') {
        return Object.values(ws.manifest.entries).some((entry) => entry.external !== true && projects(entry))
      }
      if (this.hasEntry(ws, rel)) return true
      const prefix = `${rel}${sep}`.toLowerCase()
      return Object.entries(ws.manifest.entries).some(
        ([key, entry]) => inSpace(entry) && projects(entry) && key.toLowerCase().startsWith(prefix),
      )
    }

    /** 变更前把该会话的 Workspace 重建成最新（另一进程/会话可能刚改过） */
    reloaded(service) {
      service.reload()
      return service.workspace
    }

    // ==================== 变更面 ====================

    /**
     * 把"根丢了 / 守卫不可用"归一成**可重试的环境类普通失败**（WP2 口径④）。
     *
     * 其余错误**原样抛出**（绝不吞、绝不改写 `code`）：平台沙箱的 `FS_SANDBOX_DENIED`、
     * 回读闸门的 `staging_write_not_persisted`、陈旧版本 … 各自的语义各有归属。
     */
    mapStageFailure(error, displayPath) {
      if (!isStageLossError(error)) return error
      this.logError(
        `会话工作根不可用（code=${error.code}，reason=${error.reason ?? 'n/a'}，root=${error.root ?? 'n/a'}）：` +
          `"${displayPath}" 的本次操作**没有**完成，按可重试的环境类失败上报；机制细节只在这一行日志里出现。`,
      )
      const failure = new FsError(
        MODEL_VISIBLE_FAILURE_TEXTS.environmentRetryable(displayPath),
        ENV_FAULT_RETRYABLE,
      )
      // 语义分类与 `src/executor.ts` 的三层口径同一套（`environment` ⇒ 可重试）
      failure.category = FAILURE_SEMANTICS.ENVIRONMENT
      failure.retryable = true
      failure.classification = 'environment-fault'
      // 机制细节一律挂**非 message 属性**（只有代码/日志/人工侧看得到）
      failure.technicalCode = error.code
      failure.reason = error.reason
      failure.root = error.root
      failure.detail = error.message
      return failure
    }

    /** 统一的"环境类失败映射"外壳（八个模型可见入口共用同一份判定，不各写一遍） */
    async withStageFailureMap(displayPath, run) {
      try {
        return await run()
      } catch (error) {
        throw this.mapStageFailure(error, displayPath ?? 'unknown')
      }
    }

    async writeText(target, content, expected, signal, sandboxPolicy) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () =>
        this.writeTextStaged(target, content, expected, signal, sandboxPolicy),
      )
    }

    async writeTextStaged(target, content, expected, signal, sandboxPolicy) {
      // 关：原样走平台沙箱后端（围栏 + 真实磁盘），暂存树一位不碰。
      // ⚠ 这是"用户把开关关掉"的**显式**选择（`enabled:false` 且未被
      //   `WINSTAGE_SHELL=1` 强制）⇒ 不是"绕过暂存"，**不记账**（记了会把
      //   "用户主动关掉沙箱"误报成"隔离失效"）。判据与面板的 `readSwitch()` 同源。
      if (!this.stagingEnabled()) return super.writeText(target, content, expected, signal, sandboxPolicy)
      // R12 D7-a：会话工作区与配置暂存根不一致时**仍然进暂存**（旧实现直接 super ⇒ 静默落真实盘）
      if (!this.inConfiguredWorkspace(sandboxPolicy)) this.stageOverForeignWorkspace('write', target, sandboxPolicy)
      if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
      const place = this.keyOf(target)
      if (place === undefined) {
        // 目标拿不到暂存键 ⇒ 只能交给平台面。**必须落账**（R11 D7-a 的形态之一）
        this.noteUnstaged('write', target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.UNRESOLVED_TARGET, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true,
        })
        return super.writeText(target, content, expected, signal, sandboxPolicy)
      }
      if (place.key === '') {
        throw new FsError(`cannot write "${target.displayPath}": the workspace root is not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      // ── P0-8：WinStage 自己的存储状态机**不给经 `ctx.fs` 的写权** ──────────────
      // 放在 `stageOutside === 'direct'` 之前：那个逃生口会**直写真实磁盘**，更必须先拦。
      if (isStoreStatePath(place.abs, this.stateRoots())) this.denyStoreWrite(place, 'write')
      // 显式逃生口（默认关闭）：直通真实磁盘。**不是**默认路径，也不再有"拒绝"分支。
      if (place.external && stageOutside === 'direct') {
        this.noteUnstaged('write', target?.displayPath ?? place.abs, UNSTAGED_REASONS.STAGE_OUTSIDE_DIRECT, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true,
        })
        return super.writeText(target, content, expected, signal, sandboxPolicy)
      }
      // 显式拒绝档（`stageOutside: 'deny'`）：工作区外写一律拒绝，**在一切变更之前**抛。
      if (place.external && stageOutside === 'deny') this.denyOutsideWrite(place, 'write')
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy))
      // 自愈：上一段"拿不到会话"的写可能积在共享存储里（旧进程尤其如此）
      service.absorbSharedStore?.()
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service)
        const abs = place.abs
        const current = await this.currentOf(ws, target, place.key, signal, abs)
        if (current.exists && current.kind !== 'file') {
          throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        }
        if (expected?.kind === 'replaceIfVersion') {
          if (!current.exists) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
          if (current.version !== String(expected.version)) {
            throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
          }
        } else if (expected?.kind === 'createIfAbsent' && current.exists) {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
        }

        const before =
          current.exists && Buffer.byteLength(String(content), 'utf8') < (this.config?.diffBasisMaxBytes ?? 0)
            ? normalizeLineEndings(current.text)
            : null
        const buffer = Buffer.from(String(content), 'utf8')
        // ★ BUG-8：先**原子**建好多级父目录（逐层回读、失败回滚并点名层）。
        //   放在 writeFile 之前：`workspace.writeFile()` 内部那记 `mkdirSync(recursive:true)`
        //   只有一次成败、失败说不出是哪一层，而且半成品会留在暂存树里。
        const stagedPath = this.stagedPathOf(ws, place.key)
        this.ensureStagedParentsAtomic(dirname(stagedPath), stagedPath)
        const result = ws.writeFile(abs, String(content), { origin: 'dsh-tool' })
        // ★ BUG-1：回读闸门 —— 产物不存在/内容不一致 ⇒ 抛显式失败，绝不返回成功
        this.verifyPersistedWrite({ ws, key: place.key, abs, buffer, displayPath: target.displayPath })
        const after = normalizeLineEndings(content)
        service.markFresh()
        service.afterMutation('dsh-write')
        this.notifyStagedChange(place.key)
        // WP9：可见面只留真实文件系统写操作会有的键；真实落点走非枚举旁路。
        return attachStageDiagnostics(
          {
            operation: current.exists ? 'update' : 'create',
            version: FsVersion(`winstage:${result.hash}`),
            before,
            after,
            ...this.locationReceipt(ws, place.key, abs, current),
          },
          this.locationDiagnostics(ws, place.key, abs, current),
        )
      })
    }

    async editText(target, edit, expected, signal, sandboxPolicy) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () =>
        this.editTextStaged(target, edit, expected, signal, sandboxPolicy),
      )
    }

    async editTextStaged(target, edit, expected, signal, sandboxPolicy) {
      // 关：显式退回平台面（用户主动关掉沙箱 ⇒ 不是"绕过暂存"，不记账）
      if (!this.stagingEnabled()) return super.editText(target, edit, expected, signal, sandboxPolicy)
      // R12 D7-a：与 writeTextStaged 同一口径 —— 会话根不一致时**仍然进暂存**
      if (!this.inConfiguredWorkspace(sandboxPolicy)) this.stageOverForeignWorkspace('edit', target, sandboxPolicy)
      if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
      const place = this.keyOf(target)
      if (place === undefined) {
        this.noteUnstaged('edit', target?.displayPath ?? target?.targetKey, UNSTAGED_REASONS.UNRESOLVED_TARGET, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true,
        })
        return super.editText(target, edit, expected, signal, sandboxPolicy)
      }
      if (place.key === '') {
        throw new FsError(`cannot edit "${target.displayPath}": the workspace root is not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      // ── P0-8：同 writeText（见那里的说明）────────────────────────────────────
      if (isStoreStatePath(place.abs, this.stateRoots())) this.denyStoreWrite(place, 'edit')
      if (place.external && stageOutside === 'direct') {
        this.noteUnstaged('edit', target?.displayPath ?? place.abs, UNSTAGED_REASONS.STAGE_OUTSIDE_DIRECT, {
          sessionId: this.sessionIdOf(sandboxPolicy),
          appliedToDisk: true,
        })
        return super.editText(target, edit, expected, signal, sandboxPolicy)
      }
      if (place.external && stageOutside === 'deny') this.denyOutsideWrite(place, 'edit')
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy))
      // 同上：写路径是"一定会话级"的入口，顺手把共享存储并进来
      service.absorbSharedStore?.()
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service)
        const abs = place.abs
        const current = await this.currentOf(ws, target, place.key, signal, abs)
        if (!current.exists) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        if (current.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        if (expected && current.version !== String(expected.version)) {
          throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
        const normalized = normalizeLineEndings(current.text)
        const edited = applyLiteralEdit(normalized, edit, target.displayPath)
        const storage = restoreLineEndings(edited, lineEndingOf(current.text))
        const buffer = Buffer.from(storage, 'utf8')
        // ★ BUG-8 / BUG-1：与 writeText 同一套闸门（原子父目录 + 回读确认）
        const stagedPath = this.stagedPathOf(ws, place.key)
        this.ensureStagedParentsAtomic(dirname(stagedPath), stagedPath)
        const result = ws.writeFile(abs, storage, { origin: 'dsh-tool' })
        this.verifyPersistedWrite({ ws, key: place.key, abs, buffer, displayPath: target.displayPath })
        service.markFresh()
        service.afterMutation('dsh-edit')
        this.notifyStagedChange(place.key)
        // WP9：同 writeText —— 可见面不带 `staged` / `staged-ext` / 暂存落点。
        return attachStageDiagnostics(
          {
            version: FsVersion(`winstage:${result.hash}`),
            before: normalized,
            after: edited,
            ...this.locationReceipt(ws, place.key, abs, current),
          },
          this.locationDiagnostics(ws, place.key, abs, current),
        )
      })
    }

    // ==================== 监听面（S7） ====================

    /**
     * 覆写 `watch`：**超类观察者照旧**（真实磁盘变更仍然通知），
     * 另把**暂存变更**也转成失效通知。
     *
     * 为什么需要：基类 `LocalFileSystem.watch`（dsh-fs-local/lib/index.js:726-750）
     * 只盯真实磁盘；暂存写入从不碰真实磁盘，所以走 `write`/`edit` 的改动过去不会让
     * `ctx.remote.workspaceFiles.changes` 的客户端文件视图失效（S7）。
     *
     * 契约（dsh-fs `watch(target, changed, signal)`）：回调**没有事件类型、没有路径**，
     * 只表示"这个 target 失效了"；所以这里只需决定"该不该叫醒它"。
     * 判定与超类逐字对齐（`:731-739`）：**目录** target 对**直接子项**通知；
     * **文件** target 只对该文件本身通知。
     *
     * 残余边界（如实标注，不做假承诺）：**跨进程**改动
     * （CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知 —— 超类的本地观察者也看不到。
     */
    async watch(target, changed, signal) {
      // 关：暂存树不会被改动，失效通知也就没有暂存来源 —— 原样只观察真实磁盘
      if (!this.stagingEnabled()) return super.watch(target, changed, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.watch(target, changed, signal)
      }
      const close = await super.watch(target, changed, signal)
      const place = this.keyOf(target)
      if (place === undefined) return close
      const rel = place.key
      let isDir = rel === ''
      if (!isDir) {
        try {
          isDir = (await super.stat(target, signal))?.type === 'directory'
        } catch {
          isDir = false
        }
      }
      // 外部条目（绝对键）同样登记：它现在也有暂存变更需要失效通知
      // （S3a 之前工作区外根本没有暂存条目，所以这里只会走真实磁盘语义）。
      const entry = { rel, isDir, changed }
      this.watchers.add(entry)
      return async () => {
        this.watchers.delete(entry)
        await close()
      }
    }

    /**
     * 暂存变更 → 本地失效通知。
     * 只触碰本次登记的观察者；**任何异常都在这里吞掉**（chokidar 的回调抛错会变成
     * error 分支，而写路径绝不能因为"通知"失败而失败）。
     */
    notifyStagedChange(rel) {
      if (this.watchers.size === 0) return
      const changedRel = String(rel)
      const parentOf = (value) => {
        const dir = dirname(value === '' ? '.' : value)
        return dir === '' ? '.' : dir
      }
      for (const entry of [...this.watchers]) {
        try {
          const hit = entry.isDir
            ? parentOf(changedRel) === (entry.rel === '' ? '.' : entry.rel)
            : changedRel === entry.rel
          if (hit) entry.changed()
        } catch (error) {
          this.log(`暂存变更通知失败（${changedRel}）：${error?.message ?? error}`)
        }
      }
    }

    // ==================== 读取面 ====================

    /**
     * 当前状态：本插件暂存条目 → **shim/shell 通道的同一逻辑目标** → 真实磁盘。
     * `key` 既可以是工作区相对路径，也可以是工作区外条目的绝对路径键（S3a）。
     * @param {string} [explicitAbs] `keyOf()` 给出的规范化绝对路径（shim 布局映射要用它；
     *   不传时按 `key` 现推，工作区外键就是它自己，工作区内的用 `store.realPath()`）
     * @returns {{exists: boolean, kind?: 'file'|'dir', text?: string, version?: string, layout?: string}}
     */
    async currentOf(ws, target, key, signal, explicitAbs) {
      const entry = ws.entryOf(key)
      const abs = explicitAbs ?? (isExternalKey(key) ? key : (() => {
        try {
          return ws.store.realPath(key)
        } catch {
          return key
        }
      })())
      // 只有**净变化**条目才遮蔽真实磁盘：批准过、随后被外部改过的旧条目不投影
      const projected = this.projectsEntry(entry)
      if (projected && entry.state === STATE.DELETED) return { exists: false }
      if (projected && entry.state !== STATE.DELETED) {
        if (entry.kind === 'dir') return { exists: true, kind: 'dir', version: `winstage:dir:${key}` }
        if (!ws.store.hasBlob(entry.stagedHash)) {
          // ★ WP2 透明性：这句话是**模型可见**的 ⇒ 普通失败口径（旧文案 `staged content for …`
          //   含禁用词 `staged` 且泄漏机制）。根因细节走这一行 error 级日志。
          this.logError(`清单条目的内容对象不在磁盘上：key=${key} hash=${entry.stagedHash}`)
          throw new FsError(MODEL_VISIBLE_FAILURE_TEXTS.contentMissing(target.displayPath), 'FS_IO_ERROR')
        }
        return {
          exists: true,
          kind: 'file',
          text: ws.store.readBlob(entry.stagedHash).toString('utf8'),
          version: `winstage:${entry.stagedHash}`,
        }
      }
      // 合成目录：真实不存在，但暂存树里有**构成净变化的**子项。
      // 用本文件的 hasEntryUnder 而不是 workspace.hasStagedDescendant：后者不看净变化，
      // 会把"只剩已批准条目"的目录也合成出来。
      if (this.hasEntryUnder(ws, key)) return { exists: true, kind: 'dir', version: `winstage:dir:${key}` }
      // ── BUG-2：读取时**两边都看** ─────────────────────────────────────────────
      // 本插件的落点里没有构成净变化的条目时，再看 shim/shell 通道的同一逻辑目标
      // （`<staged>\fs\<盘符>\<绝对路径>`）。命中就返回它 —— 绝不因为"清单里没有"
      // 就回落到真实磁盘，那正是"命令刚在沙箱里写过、`read` 却说文件不存在"的机器。
      // 先看内容树、再看 `wo\` 删除标记（与 shim 的落盘顺序一致）。
      const mirror = this.shimContentOf(ws, target, abs)
      if (mirror !== undefined) return mirror
      const whiteout = this.shimWhiteoutOf(ws, abs)
      if (whiteout !== undefined) return { exists: false, layout: 'shim-fs', physical: whiteout, whiteout: true }
      const info = await super.stat(target, signal)
      if (!info) return { exists: false }
      if (info.type === 'directory') return { exists: true, kind: 'dir', version: String(info.version) }
      if (info.type !== 'file') return { exists: true, kind: 'other', version: String(info.version) }
      // 基线文件：文本按需读（只在需要 before 文本时读）
      let text
      try {
        text = await super.readText(target, signal)
      } catch {
        text = undefined
      }
      // ★ R40-FS-02（P2）：`size` 必须来自真实 stat。此前只回了 `text`，而 `statInner`/
      // `lstatInner` 用 `Buffer.byteLength(current.text ?? '')` 反推大小 ⇒ 任何**非 UTF-8/
      // 二进制**文件（`super.readText` 抛 `FS_NOT_TEXT` ⇒ `text` 为 undefined）的
      // `stat().size` / `lstat().size` 都会被报成 **0**，与真实磁盘同一条路径上的读数自相矛盾。
      return { exists: true, kind: 'file', version: String(info.version), text, size: info.size }
    }

    async stat(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.statInner(target, signal))
    }

    async statInner(target, signal) {
      // ★ 交叉验证发现的漏网：`stat` 是**第五条**读入口，却完全没有遮蔽判定 ——
      //   哪怕 `readPolicy:'block'` 也拦不住它，且它连"只记"那一条可见性记录都不产生。
      //   后果：`.aws/credentials` 的存在性与文件大小可以被确认，而面板的
      //   `readVisibility` 段对此**一无所知**（"没有记录"会被读成"没有敏感读"）。
      //   放在所有早退之前，与 `listDirInner` 同一形态（无论走哪条分支都要登记）。
      this.guardMaskedRead(target, 'stat')
      if (!this.stagingEnabled()) return super.stat(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.stat(target, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.stat(target, signal)
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return super.stat(target, signal)
      const ws = service.fresh()
      const current = await this.currentOf(ws, target, place.key, signal, place.abs)
      if (!current.exists) return undefined
      if (current.kind === 'dir') return { version: FsVersion(current.version), type: 'directory', size: 0 }
      if (current.kind !== 'file') return { version: FsVersion(current.version), type: 'other' }
      return { version: FsVersion(current.version), type: 'file', size: current.size ?? Buffer.byteLength(current.text ?? '', 'utf8') }
    }

    async lstat(path, opts, signal) {
      return this.withStageFailureMap(typeof path === 'string' ? path : undefined, () => this.lstatInner(path, opts, signal))
    }

    async lstatInner(path, opts, signal) {
      /**
       * ★ R21 修复（P2·读侧守卫位置）：`lstat` 的遮蔽判定此前排在**两个早退之后** ——
       * 关态（`!stagingEnabled()`）与异工作区（`!inConfiguredWorkspace()`）两条分支
       * 直接 `super.lstat` 返回，于是：
       *   · `readPolicy:'block'` 下 `stat`/`readText` 抛 `FS_READ_DENIED`，`lstat` 却把
       *     `type`/`size` 原样交出去（存在性与大小可读 —— 与 crosscheck-boundaries 发现的
       *     “`stat` 是第五条漏网入口”是同一族缺陷，只是这次是 `lstat` 分支位置写错）；
       *   · `readPolicy:'record'` 下这次读**一条可见性记录都不产生**，`review.json` 的
       *     `readVisibility` 段照样读成“没有敏感读”。
       * 注释原本就写着“必须在早退之前”，实现却排在之后（代码/注释不一致）。
       *
       * 修法与 `statInner` / `listDirInner` 同形：**先算出逻辑绝对路径，再守卫，最后才
       * 分派**（关态/异工作区仍然照旧 `super`，只是这一次读已经被登记/已按策略拦下）。
       * 结构约束（`tests/crosscheck-boundaries.ts` §2 的位置断言会机检）：
       * `guardMaskedRead(` 的**首次出现位置必须早于函数里第一个 `return`** —— 因此
       * 空/非字符串路径的失败分支只能**后置**（它没有可判定的绝对路径，守卫跳过；
       * 关态仍交回基类、开态沿用既有 `FS_NOT_FOUND`，错误语义与旧实现逐字一致）。
       */
      const base = opts?.cwd || this.config?.cwd || process.cwd()
      const validPath = typeof path === 'string' && path.trim().length > 0
      let abs
      if (validPath) {
        abs = canonical(isAbsolute(path) ? path : join(base, path))
        this.guardMaskedRead({ targetKey: FsTargetKey(abs), displayPath: path }, 'lstat')
      }
      if (!this.stagingEnabled()) return super.lstat(path, opts, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.lstat(path, opts, signal)
      }
      if (!validPath) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
      const place = this.keyOf({ targetKey: FsTargetKey(abs), displayPath: path })
      if (place === undefined) return super.lstat(path, opts, signal)
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return super.lstat(path, opts, signal)
      const ws = service.fresh()
      const current = await this.currentOf(ws, { targetKey: FsTargetKey(abs), displayPath: path }, place.key, signal, place.abs)
      if (!current.exists) return undefined
      if (current.kind === 'dir') return { version: FsVersion(current.version), type: 'directory', size: 0 }
      if (current.kind !== 'file') return { version: FsVersion(current.version), type: 'other' }
      return { version: FsVersion(current.version), type: 'file', size: current.size ?? Buffer.byteLength(current.text ?? '', 'utf8') }
    }

    // ==================== 读取面：WP4 读侧可见性 ====================
    //
    // 四条读入口（`readText` / `readBytes` / `readByteRange` / `listDir`）在**做任何事之前**
    // 先把逻辑绝对路径喂给 `src/paths.ts` 的 29 条 `MASK_CLASSES`（经 `maskReason()`）。
    //
    // 默认 `readPolicy: 'record'`（**只记不拦**）：命中 ⇒ 记一条**会话级去重计数**
    // （去重键 = `maskId + maskKey`，同一个对象读一百次只有一条），至多发一条用户侧合并提示；
    // **读成功性一位不改**（返回值、异常、时序都不动）。
    //
    // `readPolicy: 'block'` 才拦：命中即抛普通失败（`FS_READ_DENIED`），文案同上"普通失败"口径；
    // `listDir` 还会把命中的**子项**从列表里去掉。这一档默认关闭，理由见 owner 决策：
    // **黑名单不是边界**（换个名字就绕过），只记不拦才是诚实面对这个事实的做法；
    // 真边界在 T0（AppContainer），而它的接线状态见 `docs\T2-T0接线契约.md`。

    /** 逻辑绝对路径 → 是否命中遮蔽表（纯查询；任何异常都当"没命中"，绝不因此让读失败） */
    maskedHitOf(abs) {
      if (typeof abs !== 'string' || abs.length === 0) return undefined
      try {
        return maskReason(abs)
      } catch {
        return undefined
      }
    }

    /**
     * 读入口的遮蔽判定 + 登记（`readPolicy:'record'` 时**只记不拦**）。
     *
     * @param {object} target `FsTarget`
     * @param {string} op 读入口名（进登记项的 `ops`，供面板显示"是哪种读命中的"）
     * @returns {{id: string, reason?: string}|undefined} 命中项；未命中 `undefined`
     */
    guardMaskedRead(target, op) {
      const place = this.keyOf(target)
      let abs = place?.abs
      if (abs === undefined) {
        try {
          abs = canonical(String(target?.targetKey ?? target?.displayPath ?? ''))
        } catch {
          abs = undefined
        }
      }
      const hit = this.maskedHitOf(abs)
      if (!hit) return undefined
      this.noteMaskedRead(abs, hit, op, target)
      if (this.readPolicy === 'block') {
        this.logError(`读策略 block：拒绝读取命中遮蔽类 ${hit.id} 的路径（${abs}）`)
        const error = new FsError(
          MODEL_VISIBLE_FAILURE_TEXTS.readDenied(target?.displayPath ?? abs),
          'FS_READ_DENIED',
        )
        error.maskId = hit.id
        error.readPolicy = this.readPolicy
        throw error
      }
      return hit
    }

    /**
     * 登记一次命中（**去重计数**与会话绑定；提示按"新命中的遮蔽类"至多一条）。
     * `listDir` 的子项也走这里（它没有 `target`，`displayPath` 由调用方给出）。
     */
    noteMaskedRead(abs, hit, op, target) {
      const sessionId = this.sessionIdOf()
      setReadVisibilityPolicy(sessionId, this.readPolicy)
      let result
      try {
        result = recordReadVisibility({
          sessionId,
          maskId: hit.id,
          maskKey: maskKey(abs),
          reason: hit.reason,
          op,
        })
      } catch (error) {
        // 登记失败**绝不能**改变读结果（只记不拦的语义就是"读照旧"）
        this.logError(`读侧可见性登记失败（已忽略，读结果不受影响）：${error?.message ?? error}`)
        return
      }
      if (result.firstForMaskId) {
        const where = target?.displayPath ?? abs
        this.log(
          `读侧可见性（readPolicy=${this.readPolicy}）：本次会话记录到新的敏感类读取 —— 遮蔽类 ${hit.id}（例：${where}）。` +
            '只记录、不拦截；去重键 = maskId + maskKey（同一对象重复读只累计次数）。' +
            '完整清单见 review.json 的 readVisibility 段。',
        )
      }
    }

    /**
     * `listDir` 的子项面：命中遮蔽表的子项**记录**；`readPolicy:'block'` 时从结果里去掉。
     * 只记不拦档下这个方法**不改变列表内容**（返回入参原样，且绝不在调用方的对象上写字段）。
     */
    filterMaskedChildren(dirAbs, entries, op) {
      if (!Array.isArray(entries)) return entries
      const maskedNames = new Set()
      for (const entry of entries) {
        const name = entry?.name
        if (typeof name !== 'string' || name.length === 0) continue
        const childAbs = dirAbs === undefined ? undefined : join(dirAbs, name)
        const hit = this.maskedHitOf(childAbs)
        if (!hit) continue
        this.noteMaskedRead(childAbs, hit, op, { displayPath: childAbs })
        maskedNames.add(name.toLowerCase())
      }
      if (this.readPolicy !== 'block' || maskedNames.size === 0) return entries
      this.logError(`读策略 block：从目录列表中移除 ${maskedNames.size} 个命中遮蔽表的子项`)
      return entries.filter((entry) => !maskedNames.has(String(entry?.name ?? '').toLowerCase()))
    }

    async readText(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.readTextInner(target, signal))
    }

    async readTextInner(target, signal) {
      this.guardMaskedRead(target, 'readText')
      if (!this.stagingEnabled()) return super.readText(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readText(target, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readText(target, signal)
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return super.readText(target, signal)
      const ws = service.fresh()
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readText(target, signal)
      const current = await this.currentOf(ws, target, place.key, signal, place.abs)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      return current.text ?? ''
    }

    async streamText(target, signal) {
      if (!this.stagingEnabled()) return super.streamText(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.streamText(target, signal)
      }
      const text = await this.readText(target, signal)
      return (async function* stream() {
        yield text
      })()
    }

    async readBytes(target, signal, maxBytes) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () =>
        this.readBytesInner(target, signal, maxBytes),
      )
    }

    async readBytesInner(target, signal, maxBytes) {
      this.guardMaskedRead(target, 'readBytes')
      if (!this.stagingEnabled()) return super.readBytes(target, signal, maxBytes)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readBytes(target, signal, maxBytes)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readBytes(target, signal, maxBytes)
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return super.readBytes(target, signal, maxBytes)
      const ws = service.fresh()
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readBytes(target, signal, maxBytes)
      const current = await this.currentOf(ws, target, place.key, signal, place.abs)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const buffer = Buffer.from(current.text ?? '', 'utf8')
      if (Number.isSafeInteger(maxBytes) && buffer.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file is larger than ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return new Uint8Array(buffer)
    }

    async readByteRange(target, range, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () =>
        this.readByteRangeInner(target, range, signal),
      )
    }

    async readByteRangeInner(target, range, signal) {
      this.guardMaskedRead(target, 'readByteRange')
      if (!this.stagingEnabled()) return super.readByteRange(target, range, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readByteRange(target, range, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readByteRange(target, range, signal)
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return super.readByteRange(target, range, signal)
      const ws = service.fresh()
      if (!this.hasStagedContent(ws, place.key, place.abs)) return super.readByteRange(target, range, signal)
      const current = await this.currentOf(ws, target, place.key, signal, place.abs)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const buffer = Buffer.from(current.text ?? '', 'utf8')
      const offset = Number(range?.offset ?? 0)
      const length = Number(range?.length ?? buffer.length)
      // ★ R40-FS-03（P2）：非法区间不得被 `Buffer.subarray()` 静默"解释"成另一个窗口 ——
      //   · `{offset:-4,length:10}` ⇒ `subarray(-4, 6)` ⇒ 空（谎称"文件末尾之后"）；
      //   · `{offset:2,length:-3}` ⇒ `subarray(2, -1)` ⇒ 返回 7 个字节（`CDEFGHI`），
      //     与请求的负长度毫无关系。基类对同一入参直接抛 `ERR_OUT_OF_RANGE`，不给内容。
      // 这里只对**合法**区间按同一公式裁剪 `[offset, min(len, offset+length))`；非法区间
      // 交回基类 ⇒ 与"未暂存/关态"走同一条拒绝路径，不会出现两套语义。
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        return super.readByteRange(target, range, signal)
      }
      return new Uint8Array(buffer.subarray(Math.min(offset, buffer.length), Math.min(buffer.length, offset + length)))
    }

    async listDir(target, signal) {
      return this.withStageFailureMap(target?.displayPath ?? target?.targetKey, () => this.listDirInner(target, signal))
    }

    async listDirInner(target, signal) {
      // WP4：目录**自身**的遮蔽判定放在所有早退之前 —— 无论走哪条分支（关掉开关、
      // 别人的工作区、没有暂存内容），这一次读都被登记到（只记不拦档下结果不变）。
      this.guardMaskedRead(target, 'listDir')
      const dirPlace = this.keyOf(target)
      const dirAbs = dirPlace?.abs
      const finish = (entries) => this.filterMaskedChildren(dirAbs, entries, 'listDir')
      if (!this.stagingEnabled()) return finish(await super.listDir(target, signal))
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return finish(await super.listDir(target, signal))
      }
      const place = this.keyOf(target)
      if (place === undefined) return finish(await super.listDir(target, signal))
      const rel = place.key
      // R34：守卫建不起来且无既有暂存状态 ⇒ 只读回退真实磁盘（写入仍 fail-closed）
      const service = this.stagingForRead(this.sessionIdOf())
      if (service === undefined) return finish(await super.listDir(target, signal))
      const ws = service.fresh()
      // ── BUG-2：shim/shell 通道的同一逻辑目录也要参与合并 ────────────────────────
      const shimDir = this.shimMirrorOf(ws, place.abs)
      const shim = this.shimChildrenOf(ws, shimDir)
      // ★ R11-D：`wo\` 删除标记**独立于内容树**扫描。只看 `shim` 会导致
      // "真实文件被删除（内容树无对应项）"这条最常见形态被整棵忽略 ⇒
      // `readdir` 列着它、`stat` 说不存在（同目录自相矛盾）。见 `shimDeletionsOf()`。
      const wo = this.shimDeletionsOf(ws, place.abs)
      if (wo?.selfDeleted) return finish([])
      const woDeleted = wo?.deleted
      if (!this.hasEntryUnder(ws, rel) && shim === undefined && (woDeleted === undefined || woDeleted.size === 0)) {
        return finish(await super.listDir(target, signal))
      }

      /** @type {Map<string, {name: string, type: string, target: object, version?: string, size?: number}>} */
      const merged = new Map()
      try {
        for (const entry of await super.listDir(target, signal)) {
          merged.set(entry.name.toLowerCase(), entry)
        }
      } catch {
        // 目录只存在于暂存树里（真实磁盘上没有）→ 基线为空
      }
      // shim 的删除标记优先于真实磁盘（与 `wo\` = 逻辑删除同一口径）
      if (shim !== undefined) {
        for (const name of shim.deleted) merged.delete(name)
        for (const entry of shim.entries) merged.set(entry.name.toLowerCase(), entry)
      }
      // ★ R11-D：`wo\` 那一侧的删除标记最后再压一次 —— 它覆盖"内容树里没有对应项"
      // 的删除（上面 `shim.deleted` 只覆盖内容树能看见的那一半）。
      if (woDeleted !== undefined) {
        for (const name of woDeleted) merged.delete(name)
      }
      // 键空间隔离（S3a）：列工作区内目录时不合并外部条目（否则 `C:\out` 会以 `c:` 混进根枚举）；
      // 列外部目录时只合并外部条目。真实磁盘那一侧由上面的 super.listDir 提供。
      const external = place.external
      const prefix = rel === '' ? '' : `${rel}${sep}`.toLowerCase()
      for (const [key, entry] of Object.entries(ws.manifest.entries)) {
        if ((entry.external === true) !== external) continue
        if (!this.projectsEntry(entry)) continue // 无净变化的条目（已批准、后来被外部改过）不合并
        const lower = key.toLowerCase()
        if (rel !== '' && !lower.startsWith(prefix)) continue
        const rest = rel === '' ? key : key.slice(rel.length + 1)
        if (rest.length === 0) continue
        const head = rest.split(/[\\/]/)[0]
        const childRel = join(rel, head)
        const isDirect = !rest.slice(head.length).match(/[\\/]/)
        const childAbs = ws.absolute(childRel)
        const targetOfChild = { targetKey: FsTargetKey(canonical(childAbs)), displayPath: childAbs }
        const keyOfChild = head.toLowerCase()

        if (entry.state === STATE.DELETED && isDirect) {
          merged.delete(keyOfChild)
          continue
        }
        const direct = isDirect ? entry : undefined
        const kind = direct ? direct.kind : 'dir'
        if (kind === 'dir') {
          merged.set(keyOfChild, { name: head, type: 'directory', target: targetOfChild })
          continue
        }
        merged.set(keyOfChild, {
          name: head,
          type: 'file',
          target: targetOfChild,
          version: FsVersion(`winstage:${direct.stagedHash}`),
          size: direct.size,
        })
      }
      return finish([...merged.values()])
    }
  }
}
