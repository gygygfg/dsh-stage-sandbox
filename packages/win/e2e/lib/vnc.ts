// e2e/lib/vnc.ts —— noVNC 控制台键盘/鼠标驱动（用 Playwright 操作 8006 的 viewer）。
//
// 场景：复用**已装好的** Windows 镜像时，dockurr 的 `/oem/install.bat` **不会**再触发
// （它只在安装阶段跑一次），因此需要在 guest 桌面里手动把 bootstrap 拉起来。
// 本模块把"开 viewer → 连接 → 发快捷键/打字"变成可复用的驱动。
//
// 原理：noVNC 在页面里监听 keydown/keyup 并转发给 VM；Playwright 的 page.keyboard
// 事件发到已聚焦的页面元素上，所以先点 canvas 聚焦，再发键即可。

import { openWebSession, type WebSession } from './web-gui.ts'

export interface VncOptions {
  url: string
  timeoutMs?: number
}

export class VncConsole {
  private session: WebSession

  constructor(session: WebSession) {
    this.session = session
  }

  get page(): any {
    return this.session.page
  }

  /** 打开 viewer 并尝试连接（点画布中央 + Enter）。 */
  static async open(opts: VncOptions): Promise<VncConsole> {
    const session = await openWebSession({ url: opts.url, timeoutMs: opts.timeoutMs ?? 30000 })
    const vnc = new VncConsole(session)
    await vnc.connect()
    return vnc
  }

  async connect(): Promise<boolean> {
    const page = this.session.page
    // noVNC 的连接页：点中央 + Enter（与 ebk-capture 的自动连接一致）
    try {
      const box = await page.locator('canvas').first().boundingBox()
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(800)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1500)
      return true
    } catch {
      return false
    }
  }

  /** 聚焦画布（保证后续键盘事件被 noVNC 捕获）。 */
  async focusCanvas(): Promise<void> {
    const page = this.session.page
    const box = await page.locator('canvas').first().boundingBox().catch(() => null)
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(300)
  }

  async press(keys: string): Promise<void> {
    await this.session.page.keyboard.press(keys)
    await this.session.page.waitForTimeout(300)
  }

  async type(text: string, delayMs = 25): Promise<void> {
    await this.session.page.keyboard.type(text, { delay: delayMs })
    await this.session.page.waitForTimeout(300)
  }

  /** Win+R 打开运行框并执行一条命令。 */
  async runCommand(command: string): Promise<void> {
    await this.focusCanvas()
    await this.press('Meta+r')
    await this.session.page.waitForTimeout(800)
    await this.type(command)
    await this.press('Enter')
  }

  async screenshot(file: string): Promise<number> {
    return this.session.page.screenshot({ path: file, fullPage: false })
  }

  async close(): Promise<void> {
    await this.session.close()
  }
}
