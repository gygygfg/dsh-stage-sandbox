"""Round-2 browser probe #3: BR-05 click needs scrollIntoView; plus h1 forensics."""
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
          f"{json.dumps(kw, ensure_ascii=True, default=str)[:500]}", flush=True)


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
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:300])
        return r.get("result", {}).get("value")

    async def goto(self, url, session, timeout=45):
        await self.cmd("Page.navigate", {"url": url}, session)
        end = time.time() + timeout
        while time.time() < end:
            await asyncio.sleep(0.4)
            try:
                if await self.js("document.readyState", session) == "complete":
                    return True
            except Exception:
                pass
        return False


async def main():
    ver = json.loads(urllib.request.urlopen(f"{HTTP}/json/version", timeout=10).read())
    async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=96 << 20) as ws:
        c = CDP(ws)
        tid = (await c.cmd("Target.createTarget",
                           {"url": "about:blank", "background": True}))["targetId"]
        sid = (await c.cmd("Target.attachToTarget",
                           {"targetId": tid, "flatten": True}))["sessionId"]
        for dom in ("Page.enable", "Runtime.enable", "Accessibility.enable", "DOM.enable"):
            await c.cmd(dom, {}, sid)
        await c.cmd("Page.bringToFront", {}, sid)

        # --- h1 forensics on example.com ---
        try:
            await c.goto("https://example.com", sid)
            rec("BR-03 h1-forensics", True,
                h1_n=await c.js("document.getElementsByTagName('h1').length", sid),
                any_h=await c.js("[...document.querySelectorAll('h1,h2,h3')]"
                                 ".map(e=>e.tagName+':'+e.textContent.trim())", sid),
                body_len=await c.js("document.body.innerHTML.length", sid),
                body_head=await c.js("document.body.innerHTML.slice(0,300)", sid),
                viewport=await c.js("[innerWidth,innerHeight]", sid),
                ua=await c.js("navigator.userAgent.slice(0,60)", sid))
        except Exception as e:
            rec("BR-03 h1-forensics", False, error=f"{type(e).__name__}: {e}")

        # --- BR-05: AX -> box model -> scroll into view -> click -> URL change ---
        try:
            nodes = (await c.cmd("Accessibility.getFullAXTree", {}, sid))["nodes"]
            links = [n for n in nodes
                     if (n.get("role") or {}).get("value") == "link"
                     and (n.get("name") or {}).get("value")
                     and n.get("backendDOMNodeId")]
            target = links[0]
            bnode = target["backendDOMNodeId"]
            before = await c.js("location.href", sid)
            box0 = (await c.cmd("DOM.getBoxModel", {"backendNodeId": bnode}, sid)
                    )["model"]["content"]
            y0 = sum(box0[1::2]) / 4
            await c.cmd("DOM.scrollIntoViewIfNeeded", {"backendNodeId": bnode}, sid)
            await asyncio.sleep(1.2)
            box = (await c.cmd("DOM.getBoxModel", {"backendNodeId": bnode}, sid)
                   )["model"]["content"]
            x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
            hit = await c.js(
                f"(()=>{{const e=document.elementFromPoint({x},{y});"
                f"return e? e.tagName+'|'+(e.textContent||'').trim().slice(0,40):'NONE';}})()", sid)
            await c.cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y}, sid)
            for kind in ("mousePressed", "mouseReleased"):
                await c.cmd("Input.dispatchMouseEvent",
                            {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1},
                            sid)
            after = before
            end = time.time() + 25
            while time.time() < end and after == before:
                await asyncio.sleep(0.5)
                try:
                    after = await c.js("location.href", sid)
                except Exception:
                    pass
            rec("BR-05 ax-scroll-click", before != after,
                ax_role="link", ax_name=target["name"]["value"][:50],
                y_before_scroll=round(y0, 1), xy_after_scroll=[round(x, 1), round(y, 1)],
                elementFromPoint=hit, before=before[:60], after=after[:70],
                title_after=(await c.js("document.title", sid))[:40])
        except Exception as e:
            rec("BR-05 ax-scroll-click", False, error=f"{type(e).__name__}: {e}")

        # --- BR-09b: curl-style TLS comparison inside the browser page ---
        try:
            await c.goto("https://example.com", sid)
            rec("BR-09b page-protocol", True,
                protocol=await c.js("performance.getEntriesByType('navigation')[0]"
                                    ".nextHopProtocol", sid),
                secure=await c.js("window.isSecureContext", sid),
                origin=await c.js("location.origin", sid))
        except Exception as e:
            rec("BR-09b page-protocol", False, error=f"{type(e).__name__}: {e}")

        await c.cmd("Target.closeTarget", {"targetId": tid})

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
