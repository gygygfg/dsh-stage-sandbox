#!/usr/bin/env node
/**
 * R49-C3：ON→OFF→ON 的真实 UI 残留探针。
 *
 * 启动独立 DSH web 进程（R48 ON home/profile），用 Playwright 打开 GUI：
 *   ON  : composer 反隐藏 style + WinStage 权限控件存在；
 *   用 settings/mutate 关闭 → 两者消失、composer 仍可用；
 *   再打开 → 两者恢复。
 *
 * 用法：node packages/win/e2e/r49/ui-residue.mjs
 * 退出码：PASS 0；FAIL 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { Server } from './approval-thread.mjs'

const results = []
function check(id, ok, detail = '') {
  results.push({ id, ok })
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${id}${ok || !detail ? '' : ` — ${String(detail).slice(0, 900)}`}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resolvePlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [
    process.env.DSH_PLAYWRIGHT_MODULE,
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'playwright'),
    path.join(process.cwd(), 'node_modules', 'playwright'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const mod = require(candidate)
      if (mod?.chromium) return mod
    } catch {
      /* try next */
    }
  }
  return null
}

async function main() {
  process.stdout.write('=== R49 UI residue ===\n')
  const server = new Server()
  let browser
  try {
    await server.start()
    process.stdout.write(`server=${server.base}\n`)
    const described = await server.settingsDescribe()
    const ns = (described?.namespaces ?? []).find((item) => item.ns === 'winstage-sandbox')
    if (!ns) throw new Error('winstage-sandbox settings namespace not found')

    const playwright = resolvePlaywright()
    if (!playwright) throw new Error('playwright not found; set DSH_PLAYWRIGHT_MODULE')
    try {
      browser = await playwright.chromium.launch({ channel: 'msedge', headless: true })
    } catch {
      browser = await playwright.chromium.launch({ headless: true })
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(server.authenticatedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(2500)
    if (await page.getByText('预览版说明').count()) {
      await page.locator('button').last().click().catch(() => {})
      await sleep(800)
    }
    await sleep(1200)
    let body = await page.locator('body').innerText()
    if (body.includes('选择工作区')) {
      const workspace = page.getByText('workspace', { exact: false }).first()
      if (await workspace.count()) {
        await workspace.click().catch(() => {})
        await page.waitForTimeout(1500)
      }
    }
    await page.locator('[data-composer-input="true"]').waitFor({ state: 'visible', timeout: 25000 })
    check('UI-COMPOSER', true)

    const counts = async () => page.evaluate(() => ({
      style: document.querySelectorAll('style[data-winstage-composer-unhide="1"]').length,
      permission: document.querySelectorAll('[data-winstage-permission]').length,
      chip: document.querySelectorAll('[data-winstage-chip]').length,
      panel: document.querySelectorAll('[data-winstage-panel]').length,
      composer: document.querySelectorAll('[data-composer-input="true"]').length,
    }))
    const on = await counts()
    check('ON-STYLE', on.style === 1, JSON.stringify(on))
    check('ON-PERMISSION', on.permission >= 1, JSON.stringify(on))
    check('ON-COMPOSER', on.composer >= 1, JSON.stringify(on))

    // 关闭：settings 事务写入 + 客户端 form.subscribe 驱动卸载
    const offView = await server.settingsMutate('winstage-sandbox', [{ op: 'set', path: ['enabled'], value: false }], ns.revision)
    await page.waitForFunction(
      () => document.querySelectorAll('style[data-winstage-composer-unhide="1"]').length === 0
        && document.querySelectorAll('[data-winstage-permission]').length === 0,
      { timeout: 20000 },
    ).catch(() => {})
    const off = await counts()
    check('OFF-STYLE-GONE', off.style === 0, JSON.stringify(off))
    check('OFF-PERMISSION-GONE', off.permission === 0, JSON.stringify(off))
    check('OFF-CHIP-GONE', off.chip === 0, JSON.stringify(off))
    check('OFF-COMPOSER-STILL-READY', off.composer >= 1, JSON.stringify(off))

    // 重新打开：style/permission 回来
    await server.settingsMutate('winstage-sandbox', [{ op: 'set', path: ['enabled'], value: true }], offView?.revision)
    await page.waitForFunction(
      () => document.querySelectorAll('style[data-winstage-composer-unhide="1"]').length === 1,
      { timeout: 20000 },
    ).catch(() => {})
    const back = await counts()
    check('ON-STYLE-BACK', back.style === 1, JSON.stringify(back))
    check('ON-PERMISSION-BACK', back.permission >= 1, JSON.stringify(back))
    check('NO-PAGE-ERROR', pageErrors.length === 0, pageErrors.join(' | '))

    const shot = path.join(os.tmpdir(), `r49-ui-residue-${Date.now()}.png`)
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    process.stdout.write(`screenshot=${shot}\n`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await server.stop()
  }
  const failed = results.filter((r) => !r.ok).length
  process.stdout.write(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'} checks=${results.length} failures=${failed}\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`\nFATAL: ${error?.stack ?? error}\n`)
  process.exit(1)
})
