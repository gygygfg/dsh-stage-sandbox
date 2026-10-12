"""Round-2 browser probe #4: prove the AX click really activated the link.

The current example.com link ("Learn more") is an external link; the click may
open a NEW tab instead of changing the current URL, so verify BOTH signals.
"""
import asyncio
import json
import time
import urllib.request

import websockets

HTTP = "http://127.0.0.1:9222"
REPORT = []


def rec(step, ok, **kw):
    row = {"step": step, "ok": bool(ok)}
    row.update(kw)
    REPORT.append(row)
    print(f"[{'OK  ' if ok else 'FAIL'}] {step} :: "
          f"{json.dumps(kw, ensure_ascii=True, default=str)[:520]}", flush=True)


class CDP:
    def __init__(self, ws):
        self.ws, self.i, self.events = ws, 0, []

    async def cmd(self, method, params=None, session=None, timeout=45):
        self.i += 1
        mid = self.i
        msg = {"id": mid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        await self.ws.send(json.dumps(msg))
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                raise TimeoutError(f"{method} (no reply in {timeout}s)")
            d = json.loads(await asyncio.wait_for(self.ws.recv(), left))
            if d.get("id") == mid:
                if "error" in d:
                    raise RuntimeError(f"{method} -> {json.dumps(d['error'])}")
                return d.get("result", {})
            self.events.append(d)

    async def js(self, expr, session):
        r = await self.cmd("Runtime.evaluate",
                           {"expression": expr, "returnByValue": True}, session)
        return r.get("result", {}).get("value")


async def main():
    ver = json.loads(urllib.request.urlopen(f"{HTTP}/json/version", timeout=10).read())
    async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=96 << 20) as ws:
        c = CDP(ws)
        tid = (await c.cmd("Target.createTarget",
                           {"url": "https://example.com", "background": True}))["targetId"]
        sid = (await c.cmd("Target.attachToTarget",
                           {"targetId": tid, "flatten": True}))["sessionId"]
        for dom in ("Page.enable", "Runtime.enable", "Accessibility.enable", "DOM.enable"):
            await c.cmd(dom, {}, sid)
        await c.cmd("Page.bringToFront", {}, sid)
        await asyncio.sleep(2)

        href = await c.js("(document.querySelector('a')||{}).href", sid)
        attrs = await c.js("(()=>{const a=document.querySelector('a');"
                           "return a? {target:a.target, rel:a.rel, text:a.textContent.trim()}:null;})()",
                           sid)
        pages0 = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                  if t["type"] == "page"]
        ids0 = {t["targetId"] for t in pages0}

        nodes = (await c.cmd("Accessibility.getFullAXTree", {}, sid))["nodes"]
        link = [n for n in nodes if (n.get("role") or {}).get("value") == "link"
                and (n.get("name") or {}).get("value") and n.get("backendDOMNodeId")][0]
        bnode = link["backendDOMNodeId"]
        await c.cmd("DOM.scrollIntoViewIfNeeded", {"backendNodeId": bnode}, sid)
        await asyncio.sleep(1.0)
        box = (await c.cmd("DOM.getBoxModel", {"backendNodeId": bnode}, sid)
               )["model"]["content"]
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}
            if kind != "mouseMoved":
                p["buttons"] = 1
            await c.cmd("Input.dispatchMouseEvent", p, sid)

        new_pages, after = [], await c.js("location.href", sid)
        end = time.time() + 20
        while time.time() < end:
            await asyncio.sleep(0.5)
            pages = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                     if t["type"] == "page"]
            new_pages = [t for t in pages if t["targetId"] not in ids0]
            try:
                after = await c.js("location.href", sid)
            except Exception:
                pass
            if new_pages or after != "https://example.com/":
                break
        rec("BR-05 ax-click-verified", bool(new_pages) or after != "https://example.com/",
            ax_name=link["name"]["value"][:40], link_href=href[:60], link_attrs=attrs,
            xy=[round(x, 1), round(y, 1)], this_tab_url=after[:70],
            new_tabs=[{"url": t.get("url", "")[:70], "title": t.get("title", "")[:40]}
                      for t in new_pages])
        for t in new_pages:
            await c.cmd("Target.closeTarget", {"targetId": t["targetId"]})
        await c.cmd("Target.closeTarget", {"targetId": tid})

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
