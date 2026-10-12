"""Round-2 browser probe #5: is the synthetic click delivered at all?

BR-05's coordinate click lands on the right element (elementFromPoint == the
link) but the same-tab navigation never happens.  This isolates the cause:
inject a button at a known position on example.com and click it by
coordinates; if the button's onclick does not fire, CDP input is not reaching
the renderer (focus/visibility), not a link problem.
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
        for dom in ("Page.enable", "Runtime.enable", "DOM.enable", "Accessibility.enable"):
            await c.cmd(dom, {}, sid)
        await c.cmd("Page.bringToFront", {}, sid)
        await asyncio.sleep(2)

        state = {
            "hasFocus": await c.js("document.hasFocus()", sid),
            "visibilityState": await c.js("document.visibilityState", sid),
            "hidden": await c.js("document.hidden", sid),
        }

        await c.js("(()=>{const b=document.createElement('button');b.id='bhbtn';"
                   "b.textContent='BH-BUTTON';b.style.cssText="
                   "'position:fixed;left:20px;top:20px;width:200px;height:60px;z-index:99999';"
                   "b.onclick=()=>{document.title='BTN-CLICKED';};"
                   "document.body.appendChild(b);return 'ok';})()", sid)
        root = (await c.cmd("DOM.getDocument", {"depth": -1}, sid))["root"]["nodeId"]
        nid = (await c.cmd("DOM.querySelector", {"nodeId": root, "selector": "#bhbtn"}, sid)
               )["nodeId"]
        box = (await c.cmd("DOM.getBoxModel", {"nodeId": nid}, sid))["model"]["content"]
        x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            p = {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1}
            if kind != "mouseMoved":
                p["buttons"] = 1
            await c.cmd("Input.dispatchMouseEvent", p, sid)
        await asyncio.sleep(1.5)
        via_cdp = await c.js("document.title", sid)

        # control: same click through the DOM API
        await c.js("document.title='RESET';document.getElementById('bhbtn').click()", sid)
        await asyncio.sleep(0.5)
        via_dom = await c.js("document.title", sid)

        # second attempt after an explicit activateTarget + Input "touch"-style press
        await c.cmd("Target.activateTarget", {"targetId": tid})
        await c.cmd("Page.bringToFront", {}, sid)
        await c.js("document.title='RESET2'", sid)
        for kind in ("mousePressed", "mouseReleased"):
            await c.cmd("Input.dispatchMouseEvent",
                        {"type": kind, "x": x, "y": y, "button": "left",
                         "clickCount": 1, "buttons": 1, "pointerType": "mouse"}, sid)
        await asyncio.sleep(1.5)
        via_cdp2 = await c.js("document.title", sid)

        rec("BR-05 input-delivery", via_cdp == "BTN-CLICKED",
            dom_state=state, xy=[round(x, 1), round(y, 1)],
            title_after_cdp_click=via_cdp, title_after_dom_click=via_dom,
            title_after_cdp_click_activated=via_cdp2,
            elementFromPoint=await c.js(
                f"(()=>{{const e=document.elementFromPoint({x},{y});"
                f"return e?e.tagName+'|'+e.id:'NONE';}})()", sid))
        await c.cmd("Target.closeTarget", {"targetId": tid})

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
