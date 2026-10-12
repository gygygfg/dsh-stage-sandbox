// e2e/lib/web-gui.ts —— 宿主侧 Web GUI 取证驱动（Playwright 优先，CDP 兜底）。
//
// 用途：连到 DSH web GUI（guest 转发到宿主，或 guest 内 Edge 的 CDP），在关键状态各取：
//   · PNG 截图            · 整页 outerHTML
//   · 面板结构化快照       · 可访问性(AX)快照
//
// 为什么 Playwright 优先：DOM + 截图 + AX 三件事它一次给全，且 Chromium 已在本机缓存
// （~/.cache/ms-playwright）。它装在 ebk-capture 技能的 node_modules 里（宿主侧工具），
// 因此这里按**绝对路径动态 import**，不把 playwright 加进本仓依赖。
// 可用 PLAYWRIGHT_MODULE / PLAYWRIGHT_BROWSERS_PATH 覆盖。

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { writeJson, writeText } from './artifacts.ts'
import { panelProbeExpression, filterAxForPanel, type PanelSnapshot } from './panel-dom.ts'

export function resolvePlaywrightModule(): string {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    '/root/.config/opencode/skills/ebk-capture/scripts/node_modules/playwright/index.js',
    '/root/.config/opencode/skills/ebk-capture/scripts/node_modules/playwright-core/index.js',
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE to its index.js')
}

async function loadPlaywright(): Promise<any> {
  const mod = await import(pathToFileURL(resolvePlaywrightModule()).href)
  return mod.default ?? mod
}

export interface WebSessionOptions {
  /** 目标 URL（含 token） */
  url?: string
  /** 或：连接已存在的 CDP 端点（guest 内 Edge） */
  cdpEndpoint?: string
  headed?: boolean
  timeoutMs?: number
}

export interface WebSession {
  page: any
  browser: any
  context: any
  goto(url: string): Promise<void>
  capture(name: string, dirs: { domDir: string; screenshotsDir: string }): Promise<CaptureResult>
  close(): Promise<void>
}

export interface CaptureResult {
  name: string
  screenshot: string
  dom: string
  panel: PanelSnapshot
  ax: unknown[]
  domBytes: number
}

export async function openWebSession(opts: WebSessionOptions = {}): Promise<WebSession> {
  const pw = await loadPlaywright()
  let browser: any
  if (opts.cdpEndpoint) {
    browser = await pw.chromium.connectOverCDP(opts.cdpEndpoint)
  } else {
    browser = await pw.chromium.launch({
      headless: !opts.headed,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
  }
  const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1440, height: 900 } }))
  const page = context.pages()[0] ?? (await context.newPage())
  page.setDefaultTimeout(opts.timeoutMs ?? 30000)

  const goto = async (url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
  }
  if (opts.url) await goto(opts.url)

  const capture = async (name: string, dirs: { domDir: string; screenshotsDir: string }): Promise<CaptureResult> => {
    const screenshot = join(dirs.screenshotsDir, `${name}.png`)
    const dom = join(dirs.domDir, `${name}.html`)
    await page.screenshot({ path: screenshot, fullPage: true })
    const outer = await page.content()
    writeText(dom, outer)

    let panel: PanelSnapshot
    try {
      panel = (await page.evaluate(panelProbeExpression())) as PanelSnapshot
    } catch (e) {
      panel = { found: false, err: e instanceof Error ? e.message : String(e) }
    }
    let ax: unknown[] = []
    try {
      const snap = await page.accessibility.snapshot({ interestingOnly: false })
      const flat: any[] = []
      const walk = (n: any) => {
        if (!n) return
        flat.push({ role: n.role, name: n.name, value: n.value, children: undefined })
        for (const c of n.children ?? []) walk(c)
      }
      walk(snap)
      ax = filterAxForPanel(flat)
    } catch {
      // accessibility snapshot 不可用时留空（不阻断取证）
    }
    writeJson(join(dirs.domDir, `${name}.panel.json`), panel)
    writeJson(join(dirs.domDir, `${name}.ax.json`), ax)
    return { name, screenshot, dom, panel, ax, domBytes: Buffer.byteLength(outer) }
  }

  return {
    page,
    browser,
    context,
    goto,
    capture,
    close: async () => {
      try {
        await browser.close()
      } catch {
        // ignore
      }
    },
  }
}
