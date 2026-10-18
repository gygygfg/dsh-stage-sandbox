// @ts-nocheck —— 运维工具：以纯文本方式处理 profile 补丁，避免引入 YAML 依赖。
/**
 * 卸载还原（`tools/uninstall-restore.ts`）—— **默认只打印，不改文件**。
 *
 * ── 为什么要存在（交叉验证实测出的结构性缺口）───────────────────────────────────
 * 插件的装配补丁住在**包内**（`dsh-plugin/cordis.patch.yml`），`dsh plugin remove` 之后
 * 它随包消失 ⇒ 平台侧的 `fs-sandbox` / `pwsh-sandbox` 会**自动**恢复。但如果这三条
 * loader 行被抄进了 **profile 覆盖层**（`<DSH_HOME>/profiles/<p>/cordis.patch.yml`），
 * 卸载**不会**动它 —— 而覆盖层是用户层、优先级最高。实测后果：
 *
 *   - `pwsh-sandbox` 行仍在，其 `disabled` 表达式在没有显式 `enabled:false` 时
 *     **fail-safe 返回 true**（"读不懂 = 视为开启"）⇒ 平台 shell 提供方**继续让位**；
 *   - `winstage-shell` 行已随包消失 ⇒ **没有任何 shell 提供方**；
 *   - 症状：`ctx.shell` 缺失、所有 pwsh/bash 工具永久 pending，而设置页看不出为什么。
 *
 * 这就是"插件卸载后对客户端的修改**不可恢复**"的具体形态。本工具把它变成
 * **可预览、可备份、可回放**的一次操作。
 *
 * ── 它做什么 / 不做什么 ──────────────────────────────────────────────────────
 * 做：把 profile 覆盖层里由本插件引入的 `- id:` 条目整块摘掉，并在改写前留一份
 *     `<file>.bak-winstage-<ts>` 备份；逐条说明"摘/不摘"的理由。
 * 不做：不碰 `package.json`（依赖与 `dsh.profile.bundles` 由 `dsh plugin remove` 负责）；
 *     不删磁盘上的会话存储根（那是**用户尚未批准的暂存内容**，删了是数据丢失）；
 *     不改写 DSH 宿主安装目录（`patches/dsh/` 的回滚走 `tools/dsh-patches --revert`）。
 *
 * ── R17 审计修复（原子性 / 逐字节安全 / 空文件语义）──────────────────────────────
 * 审计在独立 profile 副本上实测出三处缺口，本文件已修：
 *   1. **换行被规范化**：旧实现 `split(/\r?\n/)` 后 `join('\n')` ⇒ CRLF 文件里
 *      **与插件无关的行**也被改成 LF（不是逐字节安全）。现在保留原始 EOL。
 *   2. **只剩注释 ⇒ 宿主启动失败**：loader 把"空或仅注释"的 patch 文件判为错误
 *      （官方唯一合法空态是 `[]`）。旧实现 `trim().length === 0 ? '[]'` 抓不到
 *      "只剩注释"，卸载后 profile 会变成 **comments-only ⇒ 下次启动直接失败**。
 *      现在"摘完后没有有效条目"时显式补一行 `[]`（注释保留）。
 *   3. **非原子写 + 无回滚**：旧实现 `copyFileSync` 后直接 `writeFileSync` 覆盖，
 *      写一半失败就留下截断文件。现在**临时文件 + rename 替换 + 回读校验**，
 *      任一步失败从备份**逐字节回滚**；备份文件名冲突时自动加序号（不覆盖旧备份）。
 *      `--apply` 失败会以非零退出码如实报告（不再是"看起来成功"）。
 *
 * ── R18 修复（KNOWN-08b）：home 级 patch 也必须还原 ─────────────────────────────
 * R17 只处理 `<DSH_HOME>/profiles/<p>/cordis.patch.yml`。但 DSH 的层序是
 *   bundle → profile 覆盖层 → **home 级 `<DSH_HOME>/cordis.patch.yml`**（后者优先级更高），
 * 若让位行被写进 home 层，卸载后平台 `pwsh-sandbox` 仍被 `disabled` 固定 ⇒ **没有 shell
 * 提供方**（pwsh/bash 全部 pending），而旧工具完全看不见这个文件。
 *
 * 现在默认 **两个层都审计**（`--scope both|profile|home` 可收窄）：
 *   · 默认 dry-run；`--apply` 才对**有变化**的层逐层执行（每层各自备份/原子写/回读/回滚）；
 *   · 覆盖层文件不存在 ⇒ 该层如实 `skip`（不是失败）；home 不传 `--profile` 也照常审计 home；
 *   · 任一层写失败 ⇒ 非零退出并逐层报告（**不做跨文件事务**：已写成功的层保留备份，
 *     失败的层已回滚 —— 两层的改动互不掩盖，JSON 里逐层给结论）。
 *
 * 用法：
 *   node tools/uninstall-restore.ts --profile desktop                 # 预览 profile + home 两层
 *   node tools/uninstall-restore.ts --profile desktop --dry-run       # 显式预览（同默认）
 *   node tools/uninstall-restore.ts --profile desktop --apply         # 实际改写（逐层备份/回滚）
 *   node tools/uninstall-restore.ts --home <dir> --scope home         # 只审计 home 层
 *   node tools/uninstall-restore.ts --profile desktop --json          # 机读输出（layers[]）
 *
 * 退出码：0 无需改动或已成功｜1 用法/定位/写入失败｜2 有条目需要人工确认（未自动摘除）。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本插件自己引入的 loader 行（无条件摘除） */
const OWN_IDS = new Set(['winstage-sandbox', 'winstage-fs', 'winstage-shell'])

/**
 * 平台侧被"让位"的两行：**只有形态确实是我们的**才摘。
 * 判据刻意保守 —— 用户可能出于别的原因亲手改过这两行，那种情形必须交回人手上。
 */
const PLATFORM_IDS = {
  'fs-sandbox': (block) => /disabled:\s*true/.test(block),
  'pwsh-sandbox': (block) => /WINSTAGE_SHELL/.test(block),
}

function parseArgs(argv) {
  const out = { profile: process.env.DSH_PROFILE ?? '', home: process.env.DSH_HOME ?? '', apply: false, json: false, scope: 'both' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--home') out.home = argv[++i]
    else if (arg === '--scope') out.scope = argv[++i]
    else if (arg === '--apply') out.apply = true
    else if (arg === '--dry-run') out.apply = false
    else if (arg === '--json') out.json = true
    else if (arg === '-h' || arg === '--help') out.help = true
  }
  return out
}

function defaultHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return userProfile ? join(userProfile, '.dsh') : ''
}

/** 原文件的 EOL 风格（保住与插件无关行的字节；缺省 LF） */
function detectEol(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

/** 一行是否是"有语义的 YAML 内容"（不是空行、不是整行注释） */
function isMeaningful(line) {
  const trimmed = line.trim()
  return trimmed.length > 0 && !trimmed.startsWith('#')
}

/** 把 YAML 顶层数组按 `- id: …` 切成块（与插件侧同一个判据，不引入 YAML 解析） */
function splitEntries(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const starts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-\s+id:\s*\S+/.test(lines[i])) starts.push(i)
  }
  const entries = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length
    const id = (/^-\s+id:\s*(\S+)/.exec(lines[from]) ?? [])[1] ?? ''
    entries.push({ id, from, to, block: lines.slice(from, to).join('\n') })
  }
  return { lines, entries }
}

function stamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 备份路径：`<file>.bak-winstage-<ts>`；同名已存在时加 `-1`/`-2`…（绝不覆盖旧备份） */
export function uniqueBackupPath(patchPath) {
  const base = `${patchPath}.bak-winstage-${stamp()}`
  if (!existsSync(base)) return base
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${process.pid}`
}

/**
 * 从一份 profile 覆盖层推导"摘除后"的文本。
 *
 * @param {string} text 原始文本（保留其 EOL 风格；与插件无关的行逐字节不动）
 * @param {{removeIds:Set<string>, manual:object[]}} selection
 * @returns {{after:string, keptLines:string[], eol:string, emptied:boolean}}
 */
export function rewritePatchText(text, selection) {
  const eol = detectEol(text)
  const { lines, entries } = splitEntries(text)
  const keep = new Array(lines.length).fill(true)
  for (const entry of entries) {
    if (!selection.removeIds.has(entry.id)) continue
    for (let i = entry.from; i < entry.to; i += 1) keep[i] = false
  }
  // 什么都没摘 ⇒ **逐字节原样返回**（`--apply` 不该因为"格式化"而改写用户文件）
  if (keep.every((flag) => flag === true)) {
    return { after: String(text), keptLines: lines, eol, emptied: false }
  }
  const keptLines = lines.filter((_, i) => keep[i])
  // 末尾的空行是 split 的产物（原文件以 EOL 结尾时 split 会多出 ''）；重组时按原结尾恢复
  const endsWithEol = /\r?\n$/.test(String(text))
  let bodyLines = keptLines.slice()
  if (endsWithEol && bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop()
  // 去掉因摘除块而在末尾留下的连续空行（输出时统一按原结尾风格补回 EOL）
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop()
  const meaningful = bodyLines.filter(isMeaningful)
  const tail = endsWithEol ? eol : ''
  let after
  if (meaningful.length === 0) {
    // 摘完后只剩注释/空行：loader 把"空或仅注释"判为启动错误 ⇒ 必须显式补 `[]`。
    const comments = bodyLines.filter((line) => line.trim().length > 0)
    after = comments.length > 0 ? `${comments.join(eol)}${eol}[]${tail}` : `[]${tail}`
  } else {
    after = `${bodyLines.join(eol)}${tail}`
  }
  return { after, keptLines: bodyLines, eol, emptied: meaningful.length === 0 }
}

/**
 * 审计一个 patch 覆盖层文件（profile 层或 home 层）。
 *
 * @param {string} patchPath 覆盖层文件路径
 * @param {{layer?: 'profile'|'home'}} [options] 层标识（只影响"文件不存在"时的 code 与展示）
 * @returns {object} `{ok, code, layer, patchPath, decisions, manual, before, after, changed, ...}`
 */
export function planRestore(patchPath, options = {}) {
  const layer = options.layer === 'home' ? 'home' : 'profile'
  if (!existsSync(patchPath)) {
    return {
      ok: false,
      code: layer === 'home' ? 'no-home-patch' : 'no-profile-patch',
      layer,
      patchPath,
      decisions: [],
      manual: [],
      changed: false,
    }
  }
  const text = readFileSync(patchPath, 'utf8')
  const { entries } = splitEntries(text)
  const decisions = []
  const manual = []
  const removeIds = new Set()

  for (const entry of entries) {
    if (OWN_IDS.has(entry.id)) {
      removeIds.add(entry.id)
      decisions.push({ id: entry.id, action: 'remove', reason: '本插件自己的 loader 行（包内补丁已随卸载消失，覆盖层里的副本必须一起摘）' })
      continue
    }
    const matcher = PLATFORM_IDS[entry.id]
    if (!matcher) continue
    if (matcher(entry.block)) {
      removeIds.add(entry.id)
      decisions.push({ id: entry.id, action: 'remove', reason: '形态确实是本插件写入的"让位"行（摘除后平台提供方恢复）' })
    } else {
      manual.push({
        id: entry.id,
        action: 'keep',
        reason: '该行存在，但形态**不是**本插件写入的那个（可能是你手写的）⇒ 不自动摘，请人工确认',
      })
    }
  }

  const rewritten = rewritePatchText(text, { removeIds, manual })
  return {
    ok: true,
    code: decisions.length > 0 ? 'will-restore' : 'nothing-to-do',
    layer,
    patchPath,
    decisions,
    manual,
    /** 摘除后是否只剩注释/空行（此时已自动补 `[]` 保证宿主可启动） */
    emptiedToEmptyList: rewritten.emptied,
    eol: rewritten.eol === '\r\n' ? 'CRLF' : 'LF',
    before: text,
    after: rewritten.after,
    changed: rewritten.after !== text,
  }
}

/**
 * 应用还原：备份 → 临时文件 → rename 替换 → 回读校验；任一步失败从备份逐字节回滚。
 *
 * @param {ReturnType<typeof planRestore>} plan
 * @returns {{applied:boolean, backupPath:string|undefined, verified?:boolean, rolledBack?:boolean, error?:string}}
 */
export function applyRestore(plan) {
  if (!plan.ok || !plan.changed) return { applied: false, backupPath: undefined }
  const backupPath = uniqueBackupPath(plan.patchPath)
  copyFileSync(plan.patchPath, backupPath)
  const tmpPath = `${plan.patchPath}.tmp-winstage-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmpPath, plan.after, 'utf8')
    renameSync(tmpPath, plan.patchPath) // Windows 的 rename 走 MoveFileEx(REPLACE_EXISTING)：原子替换
    const written = readFileSync(plan.patchPath, 'utf8')
    if (written !== plan.after) throw new Error('写入后回读内容与计划不一致')
    return { applied: true, backupPath, verified: true }
  } catch (error) {
    // 回滚：从备份**逐字节**恢复（不用 plan.before，避免任何重新编码）
    let rolledBack = false
    try {
      copyFileSync(backupPath, plan.patchPath)
      rolledBack = readFileSync(plan.patchPath, 'utf8') === plan.before
    } catch {
      rolledBack = false
    }
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      /* 清不掉临时文件不影响判定 */
    }
    return { applied: false, backupPath, rolledBack, error: String(error?.message ?? error) }
  }
}

/**
 * 解析要审计的层（R18 · KNOWN-08b）：profile 覆盖层 + home 级 patch。
 *
 * 层序（DSH）：bundle → profile 覆盖层 → **home 级 `<DSH_HOME>/cordis.patch.yml`**；
 * home 层优先级更高，所以"卸载后没有 shell 提供方"可能只在 home 层留下痕迹。
 *
 * @param {{home: string, profile?: string, scope?: 'both'|'profile'|'home'}} options
 * @returns {{ok: boolean, code?: string, layers: Array<{layer:'profile'|'home', patchPath:string, skipped?:string}>, error?: string}}
 */
export function resolveLayers({ home, profile, scope = 'both' }) {
  if (scope !== 'both' && scope !== 'profile' && scope !== 'home') {
    return { ok: false, code: 'bad-scope', layers: [], error: `--scope 只能是 both|profile|home（收到 ${scope}）` }
  }
  if (typeof home !== 'string' || home.length === 0) {
    return { ok: false, code: 'no-home', layers: [], error: '定位失败：既没有 --home，也推导不出 DSH_HOME/USERPROFILE。' }
  }
  const layers = []
  if (scope !== 'home') {
    if (typeof profile !== 'string' || profile.length === 0) {
      layers.push({ layer: 'profile', patchPath: '', skipped: 'no-profile-name' })
    } else {
      layers.push({ layer: 'profile', patchPath: join(home, 'profiles', profile, 'cordis.patch.yml') })
    }
  }
  if (scope !== 'profile') {
    // app-boot 的 homePatchPath() = join($DSH_HOME, 'cordis.patch.yml')（实测源码
    // `.lead/asar/.../dsh/lib/profile-boot-*.js:115-116`）
    layers.push({ layer: 'home', patchPath: join(home, 'cordis.patch.yml') })
  }
  return { ok: true, code: 'ok', layers }
}

/**
 * 审计两层（**不写任何文件**；`--apply` 的写操作在 `applyAllRestores`）。
 *
 * @param {{home: string, profile?: string, scope?: 'both'|'profile'|'home'}} options
 * @returns {{ok:boolean, code?:string, error?:string, home:string, profile:string,
 *            layers:Array<{layer:string, patchPath:string, skipped?:string, plan:object}>}}
 */
export function planAllRestores({ home, profile = '', scope = 'both' }) {
  const resolved = resolveLayers({ home, profile, scope })
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error, home, profile, layers: [] }
  const layers = resolved.layers.map((item) => {
    if (item.skipped !== undefined) return { ...item, plan: { ok: false, code: 'skipped', decisions: [], manual: [], changed: false } }
    return { ...item, plan: planRestore(item.patchPath, { layer: item.layer }) }
  })
  return { ok: true, code: 'ok', home, profile, scope, layers }
}

/**
 * 逐层应用（`--apply` 路径）：每层独立走 R17 的纪律（唯一备份 + 临时文件 + rename +
 * 回读校验 + 失败逐字节回滚）。**不做跨文件事务** —— 某层失败时其它层已完成的结果
 * 保留（各自有备份），并在返回值里逐层如实报告，绝不把"部分成功"说成整体成功。
 *
 * @param {ReturnType<typeof planAllRestores>} bundle
 * @param {{apply: boolean}} options
 * @returns {{applied: Array<{layer:string, patchPath:string, applied:boolean,
 *            backupPath?:string, verified?:boolean, rolledBack?:boolean, error?:string,
 *            skipped?:string, changed:boolean}>, failedCount:number, writtenCount:number}}
 */
export function applyAllRestores(bundle, { apply = false } = {}) {
  const results = []
  let failedCount = 0
  let writtenCount = 0
  for (const entry of bundle.layers ?? []) {
    if (entry.skipped !== undefined) {
      results.push({ layer: entry.layer, patchPath: entry.patchPath, applied: false, skipped: entry.skipped, changed: false })
      continue
    }
    const plan = entry.plan
    if (!plan.ok) {
      results.push({ layer: entry.layer, patchPath: entry.patchPath, applied: false, skipped: plan.code, changed: false })
      continue
    }
    if (!plan.changed) {
      results.push({ layer: entry.layer, patchPath: entry.patchPath, applied: false, changed: false })
      continue
    }
    if (!apply) {
      results.push({ layer: entry.layer, patchPath: entry.patchPath, applied: false, changed: true, dryRun: true })
      continue
    }
    const applied = applyRestore(plan)
    if (applied.applied) writtenCount += 1
    else failedCount += 1
    results.push({ layer: entry.layer, patchPath: entry.patchPath, ...applied, changed: true })
  }
  return { applied: results, failedCount, writtenCount }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const usage =
    '用法: node tools/uninstall-restore.ts [--profile <name>] [--home <dir>] [--scope both|profile|home] [--dry-run|--apply] [--json]\n' +
    '默认审计 profile 覆盖层 + home 级 patch（<DSH_HOME>/cordis.patch.yml）两层，且只预览。\n' +
    '--apply 会先写 <file>.bak-winstage-<ts> 唯一备份，再以"临时文件 + rename + 回读校验"逐层改写；\n' +
    '任一层失败从备份逐字节回滚，并以非零退出码如实报告（不做跨文件事务）。\n'
  if (args.help) {
    process.stdout.write(usage)
    process.exit(0)
  }
  const home = args.home || defaultHome()
  if (!home) {
    process.stdout.write('定位失败：既没有 --home，也推导不出 DSH_HOME/USERPROFILE。\n')
    process.exit(1)
  }
  const bundle = planAllRestores({ home, profile: args.profile, scope: args.scope })
  if (!bundle.ok) {
    process.stdout.write(`${bundle.error ?? '定位失败'}\n`)
    process.exit(1)
  }
  const results = applyAllRestores(bundle, { apply: args.apply })
  const anyFailed = results.failedCount > 0
  const anyManual = bundle.layers.some((layer) => (layer.plan?.manual ?? []).length > 0)

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          version: 2,
          home: bundle.home,
          profile: bundle.profile,
          scope: bundle.scope,
          layers: bundle.layers.map((layer) => ({
            layer: layer.layer,
            patchPath: layer.patchPath || null,
            skipped: layer.skipped ?? null,
            ok: layer.plan.ok === true,
            code: layer.plan.code ?? null,
            changed: layer.plan.changed === true,
            emptiedToEmptyList: layer.plan.emptiedToEmptyList === true,
            eol: layer.plan.eol ?? null,
            decisions: layer.plan.decisions ?? [],
            manual: layer.plan.manual ?? [],
            applied: results.applied.find((item) => item.layer === layer.layer) ?? null,
          })),
          summary: {
            changed: bundle.layers.some((layer) => layer.plan?.changed === true),
            written: results.writtenCount,
            failed: results.failedCount,
            manual: anyManual,
            dryRun: args.apply !== true,
          },
        },
        null,
        2,
      )}\n`,
    )
  } else {
    for (const layer of bundle.layers) {
      process.stdout.write(`\n[${layer.layer}] ${layer.patchPath || '（未指定 profile）'}\n`)
      if (layer.skipped !== undefined) {
        process.stdout.write(`  · 跳过：${layer.skipped}${layer.skipped === 'no-profile-name' ? '（可用 --profile <name> 指定）' : ''}\n`)
        continue
      }
      const plan = layer.plan
      if (!plan.ok) {
        process.stdout.write(`  · 跳过：没有该层覆盖层补丁（${plan.code}）—— 包内补丁已随卸载消失，无需还原。\n`)
        continue
      }
      process.stdout.write(`  · EOL=${plan.eol}\n`)
      if (plan.decisions.length === 0) {
        process.stdout.write('  · 没有本插件写入的条目 —— 无需还原。\n')
      } else {
        for (const decision of plan.decisions) process.stdout.write(`  · 摘除 - id: ${decision.id} —— ${decision.reason}\n`)
      }
      if (plan.emptiedToEmptyList) {
        process.stdout.write('  · 摘完后没有有效条目：已显式补 `[]`（否则"仅注释"的补丁会让宿主启动失败）。\n')
      }
      for (const item of plan.manual) process.stdout.write(`  ⚠ 保留 - id: ${item.id} —— ${item.reason}\n`)
      const applied = results.applied.find((item) => item.layer === layer.layer)
      if (applied?.applied) {
        process.stdout.write(`  · 已改写并回读校验通过（备份 ${applied.backupPath}）。改 profile/home 需重启宿主才生效。\n`)
      } else if (applied?.error !== undefined) {
        process.stdout.write(
          `  ✗ 改写失败：${applied.error}${applied.rolledBack ? '（已从备份逐字节回滚，该层保持原样）' : '（回滚也失败，请手工用备份恢复）'}\n` +
            `    备份：${applied.backupPath}\n`,
        )
      } else if (plan.changed) {
        process.stdout.write('  · 预览模式：加 --apply 才会改写（逐层唯一备份 + 原子写 + 回读校验 + 失败回滚）。\n')
      }
    }
    process.stdout.write(
      '\n其余两件需要人工的事（本工具刻意不做）：\n' +
        `  1) 依赖与 bundle：dsh plugin${args.profile ? ` --profile ${args.profile}` : ''} remove dsh-winstage-sandbox\n` +
        '  2) 会话存储根（%LOCALAPPDATA%\\Temp\\winstage-stage\\<键>）保留未删 —— 里面可能有你尚未批准的暂存内容，删了是数据丢失。\n',
    )
  }
  if (anyFailed) process.exit(1)
  process.exit(anyManual ? 2 : 0)
}

// ★ R18 修复：入口守卫必须用 `pathToFileURL`（Windows 上 `process.argv[1]` 是
//   `C:\...\uninstall-restore.ts`，旧写法 `file://${argv[1].replace(/\\/g,'/')}` 得到
//   `file://C:/...`（两个斜杠），而 `import.meta.url` 是 `file:///C:/...`（三个斜杠）
//   ⇒ **永远不相等、CLI 静默什么都不做**（退出码 0）。本轮前实测：`--apply` 后文件
//   一个字节都没变、也没有任何输出。修复后 CLI 才真正可执行，且能被 §A/B 的 A/B 探针验证。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
