// e2e/lib/panel-dom.ts —— WinStage「暂存待审」悬浮窗的结构化取证。
//
// 由 .t/boundary-dsh/p_paneldom.py 重写为 TS（原来只在一次会话里手工跑）。
// 目标：把"面板渲染成什么样"变成**机器可读**的证据，而不只是像素截图：
//   · 面板根节点（以文案 `暂存待审` / `WinStage` + 含按钮 定位）
//   · 全部可交互子节点（tag/type/role/aria-label/title/text/checked/class）
//   · 面板内每一条候选文件行
//   · 可访问性（AX）树里与面板相关的节点
//
// 关键纪律（来自 docs/DSH集成.md §8 第 8 条）：判定"面板是否存在"**不能**用子串匹配，
// 因为 `/winstage status` 的输出会回显进聊天记录，AX 里会出现"包含面板文案的回显节点"。
// 因此这里定位根节点用"文案 + 确有 button"这条更强的谓词，并在结果里同时给出 rootLen
// 与 hits，供人工/断言复核，而不是只回一个布尔。

import type { CdpClient } from './cdp.ts'

export const PANEL_TEXT_RE = /暂存待审|暂时收起|WinStage 沙箱|W暂存待审/

export interface PanelHit {
  i: number
  tag: string
  type: string
  role: string
  ariaLabel: string
  title: string
  text: string
  checked: boolean | null
  cls: string
}

export interface PanelSnapshot {
  found: boolean
  rootTag?: string
  rootLen?: number
  hits?: PanelHit[]
  fileRows?: string[]
  err?: string
}

/**
 * 该表达式在页面里执行，返回面板结构。被 cdp.evaluate 调用。
 * 面板根：所有节点的 innerText 命中 PANEL_TEXT_RE 且**含 button** 的节点里，innerText 最短的那个
 * （最内层容器），避免把整个页面当面板。
 */
export function panelProbeExpression(): string {
  return `(() => {
    const re = ${PANEL_TEXT_RE.toString()};
    const all = Array.from(document.querySelectorAll('*'));
    const roots = all.filter(e => re.test(e.innerText || '') && e.querySelector('button'));
    roots.sort((x, y) => (x.innerText || '').length - (y.innerText || '').length);
    const root = roots[0];
    if (!root) return { found: false, err: 'no panel root' };
    const hits = [];
    [root, ...Array.from(root.querySelectorAll('*'))].forEach((e, i) => {
      const role = e.getAttribute('role') || '';
      const ariaLabel = e.getAttribute('aria-label') || '';
      const title = e.getAttribute('title') || '';
      const text = (e.innerText || '').trim().slice(0, 80);
      const tag = e.tagName.toLowerCase();
      const type = e.getAttribute('type') || '';
      const checked = e.checked === undefined ? null : e.checked;
      const clickable = tag === 'button' || role === 'button' || role === 'checkbox' || tag === 'input' || e.getAttribute('tabindex') !== null;
      if (clickable || ariaLabel || title || tag === 'input') {
        hits.push({ i, tag, type, role, ariaLabel, title, text, checked, cls: (e.className || '').toString().slice(0, 60) });
      }
    });
    const rows = [];
    root.querySelectorAll('input[type=checkbox]').forEach(cb => {
      const row = cb.closest('li, tr, label, div');
      if (row) rows.push((row.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200));
    });
    return { found: true, rootTag: root.tagName, rootLen: (root.innerText || '').length, hits: hits.slice(0, 200), fileRows: rows.slice(0, 100) };
  })()`
}

export async function capturePanel(cdp: CdpClient): Promise<PanelSnapshot> {
  try {
    return await cdp.evaluate<PanelSnapshot>(panelProbeExpression())
  } catch (e) {
    return { found: false, err: e instanceof Error ? e.message : String(e) }
  }
}

/** 把 AX 树裁剪成与面板相关的节点（name/role 含关键文案，或位于命中节点之下）。 */
export function filterAxForPanel(nodes: any[]): any[] {
  if (!Array.isArray(nodes)) return []
  return nodes
    .filter((n) => {
      const name = String(n?.name?.value ?? '')
      const role = String(n?.role?.value ?? '')
      return PANEL_TEXT_RE.test(name) || /批准|拒绝|勾选|收起|diff|候选/.test(name) || role === 'dialog'
    })
    .map((n) => ({ role: n?.role?.value, name: n?.name?.value, ignored: n?.ignored }))
}
