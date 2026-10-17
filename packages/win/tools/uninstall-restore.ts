// @ts-nocheck —— 运维工具：以纯文本方式处理 profile 补丁，避免引入 YAML 依赖。
/**
 * 卸载还原（`tools/uninstall-restore.ts`）—— **默认只打印，不改文件**。
 *
 * ── 为什么要存在（本轮交叉验证实测出的结构性缺口）───────────────────────────────
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
 * 用法：
 *   node tools/uninstall-restore.ts --profile desktop            # 预览（默认）
 *   node tools/uninstall-restore.ts --profile desktop --apply    # 实际改写（先备份）
 *   node tools/uninstall-restore.ts --profile desktop --json     # 机读输出
 *
 * 退出码：0 无需改动或已成功｜1 用法/定位失败｜2 有条目需要人工确认（未自动摘除）。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const out = { profile: process.env.DSH_PROFILE ?? '', home: process.env.DSH_HOME ?? '', apply: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--home') out.home = argv[++i]
    else if (arg === '--apply') out.apply = true
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

export function planRestore(patchPath) {
  if (!existsSync(patchPath)) {
    return { ok: false, code: 'no-profile-patch', patchPath, decisions: [], manual: [] }
  }
  const text = readFileSync(patchPath, 'utf8')
  const { lines, entries } = splitEntries(text)
  const decisions = []
  const manual = []
  const keep = new Array(lines.length).fill(true)

  for (const entry of entries) {
    if (OWN_IDS.has(entry.id)) {
      for (let i = entry.from; i < entry.to; i += 1) keep[i] = false
      decisions.push({ id: entry.id, action: 'remove', reason: '本插件自己的 loader 行（包内补丁已随卸载消失，覆盖层里的副本必须一起摘）' })
      continue
    }
    const matcher = PLATFORM_IDS[entry.id]
    if (!matcher) continue
    if (matcher(entry.block)) {
      for (let i = entry.from; i < entry.to; i += 1) keep[i] = false
      decisions.push({ id: entry.id, action: 'remove', reason: '形态确实是本插件写入的"让位"行（摘除后平台提供方恢复）' })
    } else {
      manual.push({
        id: entry.id,
        action: 'keep',
        reason: '该行存在，但形态**不是**本插件写入的那个（可能是你手写的）⇒ 不自动摘，请人工确认',
      })
    }
  }

  const next = lines.filter((_, i) => keep[i]).join('\n')
  // 顶层是空数组时给一个显式的 `[]`，否则 cordis 读到的是空文件（两种"空"语义不同）
  const cleaned = next.trim().length === 0 ? '[]\n' : next.replace(/\s*$/, '\n')
  return {
    ok: true,
    code: decisions.length > 0 ? 'will-restore' : 'nothing-to-do',
    patchPath,
    decisions,
    manual,
    before: text,
    after: cleaned,
    changed: cleaned !== text,
  }
}

export function applyRestore(plan) {
  if (!plan.ok || !plan.changed) return { applied: false, backupPath: undefined }
  const backupPath = `${plan.patchPath}.bak-winstage-${stamp()}`
  copyFileSync(plan.patchPath, backupPath)
  writeFileSync(plan.patchPath, plan.after, 'utf8')
  return { applied: true, backupPath }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.profile) {
    process.stdout.write(
      '用法: node tools/uninstall-restore.ts --profile <name> [--home <dir>] [--apply] [--json]\n' +
        '默认只预览；--apply 会先写 <file>.bak-winstage-<ts> 备份再改写。\n',
    )
    process.exit(args.help ? 0 : 1)
  }
  const home = args.home || defaultHome()
  if (!home) {
    process.stdout.write('定位失败：既没有 --home，也推导不出 DSH_HOME/USERPROFILE。\n')
    process.exit(1)
  }
  const profileDir = join(home, 'profiles', args.profile)
  if (!existsSync(profileDir)) {
    process.stdout.write(`定位失败：profile 目录不存在 —— ${profileDir}\n`)
    process.exit(1)
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const plan = planRestore(patchPath)
  if (!plan.ok) {
    process.stdout.write(`跳过：没有 profile 覆盖层补丁（${patchPath}）—— 包内补丁已随卸载消失，无需还原。\n`)
    process.exit(0)
  }

  let applied = { applied: false, backupPath: undefined }
  if (args.apply && plan.changed) applied = applyRestore(plan)

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, before: undefined, after: undefined, applied }, null, 2)}\n`)
  } else {
    process.stdout.write(`profile 覆盖层：${patchPath}\n`)
    if (plan.decisions.length === 0) {
      process.stdout.write('  · 没有本插件写入的条目 —— 无需还原。\n')
    } else {
      for (const decision of plan.decisions) {
        process.stdout.write(`  · 摘除 - id: ${decision.id} —— ${decision.reason}\n`)
      }
    }
    for (const item of plan.manual) {
      process.stdout.write(`  ⚠ 保留 - id: ${item.id} —— ${item.reason}\n`)
    }
    if (applied.applied) {
      process.stdout.write(`  · 已改写（备份 ${applied.backupPath}）。改 profile 需重启宿主才生效。\n`)
    } else if (plan.changed) {
      process.stdout.write('  · 预览模式：加 --apply 才会改写（改写前会自动备份）。\n')
    }
    process.stdout.write(
      '\n其余两件需要人工的事（本工具刻意不做）：\n' +
        `  1) 依赖与 bundle：dsh plugin --profile ${args.profile} remove dsh-winstage-sandbox\n` +
        '  2) 会话存储根（%LOCALAPPDATA%\\Temp\\winstage-stage\\<键>）保留未删 —— 里面可能有你尚未批准的暂存内容，删了是数据丢失。\n',
    )
  }
  process.exit(plan.manual.length > 0 ? 2 : 0)
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) main()
