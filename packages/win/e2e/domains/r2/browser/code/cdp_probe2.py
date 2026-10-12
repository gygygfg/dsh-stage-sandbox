"""Round-2 browser probe #2: fix the two failures of probe #1.

probe #1 showed that on a *background* tab both `Page.captureScreenshot` and
synthetic clicks time out / miss, so this run brings the target to the front
first (`Page.bringToFront`, the WinStage analogue of `activate_tab`) and
re-verifies BR-03 (h1), BR-04 (screenshot written by the browser) and BR-05
(AX -> box model -> click -> URL change).
"""
import asyncio
import base64
import hashlib
import json
import os
import time
import urllib.request

import websockets

HTTP = "http://127.0.0.1:9222"
WORK = r"C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser"
DW = os.path.join(WORK, "evidence", "downloads")
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
        await c.cmd("Browser.setDownloadBehavior",
                    {"behavior": "allow", "downloadPath": DW, "eventsEnabled": True})

        # reuse the tab probe #1 left behind, else make one
        targets = (await c.cmd("Target.getTargets"))["targetInfos"]
        pages = [t for t in targets if t["type"] == "page"]
        tid = pages[-1]["targetId"] if pages else (
            await c.cmd("Target.createTarget", {"url": "about:blank"}))["targetId"]
        sid = (await c.cmd("Target.attachToTarget",
                           {"targetId": tid, "flatten": True}))["sessionId"]
        for dom in ("Page.enable", "Runtime.enable", "Network.enable",
                    "Accessibility.enable", "DOM.enable"):
            await c.cmd(dom, {}, sid)
        await c.cmd("Page.bringToFront", {}, sid)
        rec("BR-05b bringToFront", True, targetId=tid[:16], pages=len(pages))

        # ---------------- BR-03 ----------------
        try:
            ok = await c.goto("https://example.com", sid)
            title = await c.js("document.title", sid)
            h1 = await c.js("(document.querySelector('h1')||{}).textContent", sid)
            h1b = await c.js("document.getElementsByTagName('h1').length", sid)
            h1c = await c.js("document.documentElement.outerHTML.slice(0,200)", sid)
            links = await c.js("document.querySelectorAll('a').length", sid)
            rec("BR-03 navigate+js example.com", title == "Example Domain" and links == 1,
                loaded=ok, title=title, h1=h1, h1_count=h1b, links=links, head=h1c)
        except Exception as e:
            rec("BR-03 navigate+js example.com", False, error=f"{type(e).__name__}: {e}")

        # ---------------- BR-04 ----------------
        try:
            r = await c.cmd("Page.captureScreenshot",
                            {"format": "png", "fromSurface": True}, sid, timeout=30)
            raw = base64.b64decode(r["data"])
            b64 = base64.b64encode(raw).decode()
            expr = (
                "(async () => { const bin = atob(%s); const arr = new Uint8Array(bin.length);"
                " for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);"
                " const blob = new Blob([arr], {type: 'image/png'});"
                " const a = document.createElement('a'); a.href = URL.createObjectURL(blob);"
                " a.download = 'br04-example.png'; document.body.appendChild(a); a.click();"
                " a.remove(); return arr.length; })()"
            ) % json.dumps(b64)
            n = await c.js(expr, sid)
            dest = os.path.join(DW, "br04-example.png")
            end = time.time() + 60
            size = None
            while time.time() < end:
                await asyncio.sleep(0.5)
                if os.path.exists(dest) and os.path.getsize(dest) > 0 \
                        and not os.path.exists(dest + ".crdownload"):
                    size = os.path.getsize(dest)
                    break
            h = hashlib.sha256()
            if size:
                with open(dest, "rb") as fh:
                    h.update(fh.read())
            rec("BR-04 screenshot -> browser download", size is not None,
                cdp_bytes=len(raw), cdp_sha256=hashlib.sha256(raw).hexdigest(),
                js_returned=n, host_file=dest, host_bytes=size,
                host_sha256=h.hexdigest() if size else None)
        except Exception as e:
            rec("BR-04 screenshot -> browser download", False, error=f"{type(e).__name__}: {e}")

        # ---------------- BR-05 ----------------
        try:
            nodes = (await c.cmd("Accessibility.getFullAXTree", {}, sid))["nodes"]
            links = [n for n in nodes
                     if (n.get("role") or {}).get("value") == "link"
                     and (n.get("name") or {}).get("value")
                     and n.get("backendDOMNodeId")]
            target = links[0]
            before = await c.js("location.href", sid)
            box = (await c.cmd("DOM.getBoxModel",
                               {"backendNodeId": target["backendDOMNodeId"]}, sid)
                   )["model"]["content"]
            x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
            hit = await c.js(
                f"(()=>{{const e=document.elementFromPoint({x},{y});"
                f"return e? e.tagName+':'+(e.textContent||'').trim().slice(0,30):'NONE';}})()", sid)
            await c.cmd("Input.dispatchMouseEvent",
                        {"type": "mouseMoved", "x": x, "y": y}, sid)
            for kind in ("mousePressed", "mouseReleased"):
                await c.cmd("Input.dispatchMouseEvent",
                            {"type": kind, "x": x, "y": y, "button": "left",
                             "clickCount": 1}, sid)
            after = before
            end = time.time() + 20
            while time.time() < end and after == before:
                await asyncio.sleep(0.5)
                try:
                    after = await c.js("location.href", sid)
                except Exception:
                    pass
            rec("BR-05 ax-click", before != after, ax_role="link",
                ax_name=target["name"]["value"][:60], xy=[round(x, 1), round(y, 1)],
                elementFromPoint=hit, before=before[:70], after=after[:70])
        except Exception as e:
            rec("BR-05 ax-click", False, error=f"{type(e).__name__}: {e}")

        # ---------------- BR-06: documented switch_tab usage ----------------
        try:
            pages_before = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                            if t["type"] == "page"]
            t_new = (await c.cmd("Target.createTarget",
                                 {"url": "https://example.com/", "background": True}))["targetId"]
            await asyncio.sleep(2)
            pages_after = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                           if t["type"] == "page"]
            s_new = (await c.cmd("Target.attachToTarget",
                                 {"targetId": t_new, "flatten": True}))["sessionId"]
            ttl_new = await c.js("document.title", s_new)
            # what an index-based switch_tab does: a bare integer is not a target id
            idx_err = "n/a"
            try:
                await c.cmd("Target.activateTarget", {"targetId": "1"})
            except Exception as e:
                idx_err = str(e)[:140]
            await c.cmd("Target.closeTarget", {"targetId": t_new})
            rec("BR-06 tabs(targetId)", len(pages_after) == len(pages_before) + 1,
                pages_before=len(pages_before), pages_after=len(pages_after),
                new_targetId=t_new[:16], title_of_new_tab=ttl_new,
                integer_targetId_result=idx_err)
        except Exception as e:
            rec("BR-06 tabs(targetId)", False, error=f"{type(e).__name__}: {e}")

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
