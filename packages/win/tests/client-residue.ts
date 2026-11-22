/**
 * C3（静态部分）：客户端残留探针。
 *
 * 断言 `dsh-plugin/client.ts` 里所有会影响平台 UI 的注册/样式都受
 * `readSwitch(form) === 'on'` 约束，并且有同步 disposer。真实的 DOM/slot 运行时
 * 探针仍由 R48/R49 UI 用例覆盖；本套件是离线、确定性的第一道门。
 *
 * 用法：node tests/client-residue.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'dsh-plugin', 'client.ts'), 'utf8')

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
function blockAfter(marker: string, length = 2600): string {
  const at = SRC.indexOf(marker)
  return at < 0 ? '' : SRC.slice(at, at + length)
}

process.stdout.write('=== client-residue ===\n')

const composer = blockAfter("ctx.slots.inject('conversation.composer'", 3200)
ok(composer.length > 0, '找到 conversation.composer 注入')
ok(/readSwitch\(form\) === 'on'/.test(composer), 'composer 只在 ON 时注册')
ok(/return \(\) => \{[\s\S]{0,300}off\(\)[\s\S]{0,300}dispose\(\)/.test(composer), 'composer disposer 同时退订+dispose')

const chip = blockAfter("ctx.slots.inject('conversation.input.dock'", 2600)
ok(chip.length > 0, '找到 conversation.input.dock 注入')
ok(/readSwitch\(form\) === 'on'/.test(chip), 'chip 只在 ON 时注册')
ok(/return \(\) => \{[\s\S]{0,300}off\(\)/.test(chip), 'chip disposer 退订')

const permission = blockAfter("ctx.slots.inject('conversation.input.permission'", 2600)
ok(permission.length > 0, '找到 conversation.input.permission 注入')
ok(/readSwitch\(form\) === 'on'/.test(permission), 'permission 只在 ON 时遮蔽')

const cssAt = SRC.lastIndexOf("data-winstage-composer-unhide")
const css = cssAt < 0 ? '' : SRC.slice(Math.max(0, cssAt - 1600), cssAt + 700)
ok(css.length > 0, '找到 composer 反隐藏 CSS')
ok(/readSwitch\(form\) === 'on'/.test(css), 'CSS 只在 ON 时注入')
ok(/style\.remove\(\)/.test(css), 'CSS 有 remove() 回收路径')
ok((SRC.match(/data-winstage-composer-unhide/g) ?? []).length === 1, 'CSS 只有一个注入点')
ok(/data-winstage-setting-layers/.test(SRC), '设置行暴露 base/user 层级锚点')
ok(/layerBase/.test(SRC) && /layerUser/.test(SRC), '层级文案有 i18n 键')

ok((SRC.match(/ctx\.slots\.inject\(/g) ?? []).length === 4, '槽位注入恰为 4 处（settings/composer/chip/permission）')
ok(!/ctx\.slots\.register\(composerEntry, WinStageReview\)\s*\n\s*const offForm/.test(SRC), 'composer 没有“先注册再订阅”的旧形态')

process.stdout.write(`\nRESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${checks} failures=${failures}\n`)
process.exit(failures === 0 ? 0 : 1)
