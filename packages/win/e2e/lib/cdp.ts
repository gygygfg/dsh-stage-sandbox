// e2e/lib/cdp.ts —— 零依赖 CDP 客户端（Node >= 22 的全局 WebSocket）。
//
// 目的：用**真实浏览器**驱动 DSH web GUI 并取回可核对的渲染证据：
//   · 截图（Page.captureScreenshot）
//   · 整页 DOM（Runtime.evaluate → document.documentElement.outerHTML）
//   · 可访问性树（Accessibility.getFullAXTree）
//   · 面板子树结构（见 panel-dom.ts）
//
// 本文件把历史上三份一次性驱动合并为一份可复用实现：
//   _r3/cdp.mjs、_r3/gui.mjs（DOM 交互 + 文本注入）、.t/dsh2/s7-cdp.mjs（list/open/eval/shot）。
// 保留"零 npm 依赖"这条纪律 —— 只用 Node 内建 http + 全局 WebSocket。
//
// 为什么不用 Input 域做文本输入：历史实测（_r3/gui.mjs 头注）Input 域在本机 headless
// 标签页上会挂起，而 Runtime.evaluate 稳定；因此文本框注入优先走 JS（execCommand/insertText）。

import http from 'node:http'
import { writeFileSync } from 'node:fs'

export interface TargetInfo {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

export interface CdpClientOptions {
  /** CDP HTTP 端点，默认 http://127.0.0.1:9222 */
  endpoint?: string
  /** 连接超时（ms），默认 8000 */
  connectTimeoutMs?: number
}

export function httpJson<T = unknown>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d) as T)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`http timeout ${url}`)))
  })
}

export async function listTargets(opts: CdpClientOptions = {}): Promise<TargetInfo[]> {
  const endpoint = opts.endpoint ?? 'http://127.0.0.1:9222'
  return httpJson<TargetInfo[]>(`${endpoint}/json/list`, opts.connectTimeoutMs)
}

export class CdpClient {
  private ws: WebSocket
  private nextId = 0
  private pending = new Map<number, (msg: any) => void>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: any
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg)
        this.pending.delete(msg.id)
      }
    })
  }

  /** 连接到一个 target 的 webSocketDebuggerUrl。 */
  static async connect(wsUrl: string, timeoutMs = 8000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
      setTimeout(() => rej(new Error('ws open timeout')), timeoutMs)
    })
    return new CdpClient(ws)
  }

  /** 连接到一个候选 target（按 type/url 过滤，默认取第一个 page）。 */
  static async attach(opts: CdpClientOptions & { match?: (t: TargetInfo) => boolean } = {}): Promise<CdpClient> {
    const list = await listTargets(opts)
    const match = opts.match ?? ((t) => t.type === 'page')
    const page = list.find(match)
    if (!page) throw new Error('no matching CDP target')
    return CdpClient.connect(page.webSocketDebuggerUrl, opts.connectTimeoutMs)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('cdp closed'))
    return new Promise((resolve) => {
      const id = ++this.nextId
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Runtime.evaluate，返回 JS 值；表达式抛错时抛异常。 */
  async evaluate<T = unknown>(expression: string, { awaitPromise = true } = {}): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    const ex = r?.result?.exceptionDetails
    if (ex) throw new Error(ex.exception?.description || ex.text || 'evaluate exception')
    return r?.result?.result?.value as T
  }

  async screenshot(file: string): Promise<number> {
    await this.send('Page.enable')
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    const b64 = r?.result?.data
    if (!b64) throw new Error('no screenshot data')
    const buf = Buffer.from(b64, 'base64')
    writeFileSync(file, buf)
    return buf.length
  }

  async fullDom(): Promise<string> {
    return this.evaluate<string>('document.documentElement.outerHTML')
  }

  async innerText(): Promise<string> {
    return this.evaluate<string>('(document.body && document.body.innerText) || ""')
  }

  async axTree(): Promise<unknown> {
    await this.send('Accessibility.enable')
    const r = await this.send('Accessibility.getFullAXTree')
    return r?.result?.nodes ?? []
  }

  async navigate(url: string, waitMs = 4000): Promise<void> {
    await this.send('Page.enable')
    await this.send('Page.navigate', { url })
    await new Promise((r) => setTimeout(r, waitMs))
  }

  async clickSelector(selector: string): Promise<{ clicked: boolean; reason?: string; tag?: string; text?: string }> {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { clicked: false, reason: 'not-found' };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { clicked: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 80) };
    })()`
    const v = await this.evaluate<{ clicked: boolean; x?: number; y?: number; tag?: string; text?: string; reason?: string }>(expr)
    if (!v.clicked) return v
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: v.x, y: v.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: v.x, y: v.y, button: 'left', clickCount: 1 })
    return { clicked: true, tag: v.tag, text: v.text }
  }

  async insertText(text: string): Promise<void> {
    const r = await this.send('Input.insertText', { text })
    if (r?.error) {
      // 回退：CDP Input 域在部分 headless 标签页会挂起/不支持，用 JS 注入。
      await this.evaluate(
        `(() => { const el = document.querySelector('[contenteditable="true"], textarea'); if (el) { el.focus(); document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(text)}); } return true; })()`,
      )
    }
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}
