"""Round-2 browser probe #6: can the automation window be made visible?

probe #5 proved the blocker: the attached tab is permanently
`document.visibilityState == "hidden"`, and in that state Chromium accepts
`Input.dispatchMouseEvent` (no error) but never activates the element.
Here: ask the browser for the window, force `windowState=normal` with explicit
bounds, then re-test visibility and a coordinate click.
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
        for dom in ("Page.enable", "Runtime.enable", "DOM.enable"):
            await c.cmd(dom, {}, sid)
        await c.cmd("Page.bringToFront", {}, sid)
        await asyncio.sleep(1.5)
        before = {"vis": await c.js("document.visibilityState", sid),
                  "hidden": await c.js("document.hidden", sid)}

        win = await c.cmd("Browser.getWindowForTarget", {"targetId": tid})
        res = {}
        try:
            await c.cmd("Browser.setWindowBounds",
                        {"windowId": win["windowId"],
                         "bounds": {"windowState": "normal", "left": 0, "top": 0,
                                    "width": 1100, "height": 800}})
            res["setWindowBounds"] = "ok"
        except Exception as e:
            res["setWindowBounds"] = f"{type(e).__name__}: {e}"
        await c.cmd("Page.bringToFront", {}, sid)
        await asyncio.sleep(2)
        after = {"vis": await c.js("document.visibilityState", sid),
                 "hidden": await c.js("document.hidden", sid),
                 "win": await c.cmd("Browser.getWindowBounds",
                                    {"windowId": win["windowId"]})}

        await c.js("(()=>{const b=document.createElement('button');b.id='bhbtn2';"
                   "b.textContent='B2';b.style.cssText='position:fixed;left:20px;top:20px;"
                   "width:200px;height:60px;z-index:99999';"
                   "b.onclick=()=>{document.title='BTN2-CLICKED';};"
                   "document.body.appendChild(b);return 1;})()", sid)
        root = (await c.cmd("DOM.getDocument", {"depth": -1}, sid))["root"]["nodeId"]
        nid = (await c.cmd("DOM.querySelector", {"nodeId": root, "selector": "#bhbtn2"}, sid)
               )["nodeId"]
        box = (await c.cmd("DOM.getBoxModel", {"nodeId": nid}, sid))["model"]["content"]
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}
            if kind != "mouseMoved":
                p["buttons"] = 1
            await c.cmd("Input.dispatchMouseEvent", p, sid)
        await asyncio.sleep(1.5)
        title = await c.js("document.title", sid)
        rec("BR-05 window-visibility-fix", title == "BTN2-CLICKED",
            visibility_before=before, window=win, set_bounds=res,
            bounds_after=after, xy=[round(x, 1), round(y, 1)],
            title_after_click=title)
        await c.cmd("Target.closeTarget", {"targetId": tid})

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
