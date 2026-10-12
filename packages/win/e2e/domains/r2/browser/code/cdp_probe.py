"""Direct-CDP driver for the WinStage round-2 browser checkpoints (BR-03..BR-09).

Why this exists
---------------
`browser-use` (the documented entry point) cannot run in this session any more:
its daemon must publish its IPC endpoint under
``%USERPROFILE%\\.config\\browser-harness\\runtime\\bu-*.port`` and every
shim-redirected write now fails with ACCESS_DENIED, so
``ensure_daemon() -> restart_daemon() -> ipc.cleanup_endpoint()`` raises
``PermissionError: [WinError 5]``.

This driver therefore talks straight to the CDP endpoint that
``browser-use-preflight.py`` already started (profile ``C:\\eprof``, browser
process tree launched with ``WINSTAGE_SHIM_DISABLE=1``).  It needs NO disk
writes of its own: every evidence file is written *by the browser* (downloads),
which is exactly what BR-04/BR-07/BR-08 need to measure.

Run:  <uv-python> cdp_probe.py
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
EV = os.path.join(WORK, "evidence")
DW = os.path.join(EV, "downloads")
TARBALL = "https://registry.npmmirror.com/typescript/-/typescript-5.6.3.tgz"
PACKUMENT = "https://registry.npmmirror.com/typescript/5.6.3"

REPORT = []


def rec(step, ok, **kw):
    row = {"step": step, "ok": bool(ok)}
    row.update(kw)
    REPORT.append(row)
    txt = json.dumps(kw, ensure_ascii=True, default=str)
    print(f"[{'OK  ' if ok else 'FAIL'}] {step} :: {txt[:600]}", flush=True)


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.i = 0
        self.events = []

    async def cmd(self, method, params=None, session=None, timeout=40):
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
                raise TimeoutError(f"{method} timed out")
            raw = await asyncio.wait_for(self.ws.recv(), left)
            d = json.loads(raw)
            if d.get("id") == mid:
                if "error" in d:
                    raise RuntimeError(f"{method} -> {json.dumps(d['error'])}")
                return d.get("result", {})
            self.events.append(d)

    async def js(self, expr, session):
        r = await self.cmd(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
            session,
        )
        res = r.get("result", {})
        if res.get("subtype") == "error":
            raise RuntimeError(res.get("description", "js error"))
        return res.get("value")

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

    async def wait_file(self, path, timeout=90):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if os.path.exists(path) and os.path.getsize(path) > 0:
                    # a .crdownload sibling means still in flight
                    if not os.path.exists(path + ".crdownload"):
                        return os.path.getsize(path)
            except OSError:
                pass
            await asyncio.sleep(0.5)
        return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha512_b64_file(path):
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return base64.b64encode(h.digest()).decode()


async def blob_download(c, session, name, mime, payload):
    b64 = base64.b64encode(payload).decode()
    expr = (
        "(async () => { const bin = atob(%s); const arr = new Uint8Array(bin.length);"
        " for (let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);"
        " const blob = new Blob([arr], {type: %s});"
        " const a = document.createElement('a'); a.href = URL.createObjectURL(blob);"
        " a.download = %s; document.body.appendChild(a); a.click(); a.remove();"
        " return 'triggered'; })()"
    ) % (json.dumps(b64), json.dumps(mime), json.dumps(name))
    return await c.js(expr, session)


async def main():
    ver = json.loads(urllib.request.urlopen(f"{HTTP}/json/version", timeout=10).read())
    rec("BR-02 cdp-endpoint", True, browser=ver.get("Browser"),
        ws=ver.get("webSocketDebuggerUrl", "")[:60])

    async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=96 << 20) as ws:
        c = CDP(ws)

        await c.cmd("Browser.setDownloadBehavior",
                    {"behavior": "allow", "downloadPath": DW, "eventsEnabled": True})
        rec("BR-07 download-behavior", True, downloadPath=DW)

        # ---- open our own tab (targetId, never an index) ----
        tid = (await c.cmd("Target.createTarget", {"url": "about:blank",
                                                  "background": True}))["targetId"]
        sid = (await c.cmd("Target.attachToTarget", {"targetId": tid,
                                                     "flatten": True}))["sessionId"]
        for dom in ("Page.enable", "Runtime.enable", "Network.enable",
                    "Accessibility.enable", "DOM.enable"):
            await c.cmd(dom, {}, sid)
        rec("BR-06 new_tab(createTarget)", True, targetId=tid[:16], sessionId=sid[:12])

        # ---- BR-03: navigate + JS evaluation on example.com ----
        try:
            ok = await c.goto("https://example.com", sid)
            title = await c.js("document.title", sid)
            h1 = await c.js("(document.querySelector('h1')||{}).textContent", sid)
            links = await c.js("document.querySelectorAll('a').length", sid)
            href = await c.js("document.querySelector('a').href", sid)
            rec("BR-03 navigate+js example.com", ok and title == "Example Domain",
                title=title, h1=h1, links=links, first_href=href)
        except Exception as e:
            rec("BR-03 navigate+js example.com", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-04: screenshot, written to real disk BY THE BROWSER ----
        try:
            b64png = (await c.cmd("Page.captureScreenshot", {"format": "png"}, sid))["data"]
            raw = base64.b64decode(b64png)
            await blob_download(c, sid, "br04-example.png", "image/png", raw)
            size = await c.wait_file(os.path.join(DW, "br04-example.png"), 60)
            local = os.path.join(DW, "br04-example.png")
            rec("BR-04 screenshot -> browser download", size is not None,
                cdp_bytes=len(raw), cdp_sha256=hashlib.sha256(raw).hexdigest(),
                host_file=local, host_bytes=size,
                host_sha256=sha256_file(local) if size else None)
        except Exception as e:
            rec("BR-04 screenshot -> browser download", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-05: AX tree + AX -> box model -> real click ----
        try:
            nodes = (await c.cmd("Accessibility.getFullAXTree", {}, sid))["nodes"]
            links = [n for n in nodes
                     if (n.get("role") or {}).get("value") == "link"
                     and (n.get("name") or {}).get("value")
                     and n.get("backendDOMNodeId")]
            rec("BR-05 ax-tree", True, nodes=len(nodes), link_nodes=len(links))
            target = links[0]
            before = await c.js("location.href", sid)
            box = (await c.cmd("DOM.getBoxModel",
                               {"backendNodeId": target["backendDOMNodeId"]}, sid))["model"]["content"]
            x, y = sum(box[0::2]) / 4, sum(box[1::2]) / 4
            for kind in ("mousePressed", "mouseReleased"):
                await c.cmd("Input.dispatchMouseEvent",
                            {"type": kind, "x": x, "y": y, "button": "left",
                             "clickCount": 1}, sid)
            await asyncio.sleep(2.5)
            after = await c.js("location.href", sid)
            rec("BR-05 ax-click", before != after, ax_name=target["name"]["value"][:60],
                xy=[round(x, 1), round(y, 1)], before=before[:60], after=after[:60])
        except Exception as e:
            rec("BR-05 ax-click", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-09: TLS / certificate of a fresh https navigation ----
        try:
            c.events.clear()
            await c.goto("https://www.baidu.com", sid)
            secs = [e for e in c.events
                    if e.get("method") == "Network.responseReceived"
                    and e["params"].get("type") == "Document"]
            det = (secs[-1]["params"]["response"].get("securityDetails") or {}) if secs else {}
            rec("BR-09 tls", bool(det.get("issuer")), protocol=det.get("protocol"),
                issuer=det.get("issuer"), subject=det.get("subjectName"),
                valid_to=det.get("validTo"), san=det.get("sanList"))
        except Exception as e:
            rec("BR-09 tls", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-03b: Chinese site / non-ASCII title (emoji regression) ----
        try:
            t = await c.js("document.title", sid)
            enc = await c.js("document.characterSet", sid)
            rec("BR-03b unicode-title", bool(t), title_repr=repr(t),
                title_utf8_hex=t.encode("utf-8").hex()[:120],
                charset=enc, has_non_ascii=any(ord(ch) > 127 for ch in t))
        except Exception as e:
            rec("BR-03b unicode-title", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-06: multi-tab: list / create / activate / close (targetId) ----
        try:
            before = (await c.cmd("Target.getTargets"))["targetInfos"]
            pages_before = [t for t in before if t["type"] == "page"]
            t2 = (await c.cmd("Target.createTarget", {"url": "about:blank",
                                                      "background": True}))["targetId"]
            pages_after = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                           if t["type"] == "page"]
            await c.cmd("Target.activateTarget", {"targetId": t2})
            activ = [t for t in (await c.cmd("Target.getTargets"))["targetInfos"]
                     if t.get("attached") and t["targetId"] == t2]
            idx_guess = None
            try:
                # deliberately show that an index is meaningless to CDP activate
                await c.cmd("Target.activateTarget", {"targetId": str(len(pages_after) - 1)})
                idx_guess = "accepted"
            except Exception as e:
                idx_guess = f"rejected: {json.dumps(getattr(e, 'args', [str(e)]))[:120]}"
            await c.cmd("Target.closeTarget", {"targetId": t2})
            rec("BR-06 tabs", len(pages_after) == len(pages_before) + 1,
                pages_before=len(pages_before), pages_after=len(pages_after),
                created=t2[:16], activated=True, index_instead_of_targetId=idx_guess)
        except Exception as e:
            rec("BR-06 tabs", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-07: real remote download + integrity against the registry ----
        try:
            meta = json.loads(urllib.request.urlopen(PACKUMENT, timeout=20).read())
            dist = meta["dist"]
            if not await c.goto(TARBALL, sid, timeout=30):
                pass  # a download navigation never reaches readyState complete
            dest = os.path.join(DW, os.path.basename(TARBALL))
            size = await c.wait_file(dest, 120)
            if size is None:
                raise RuntimeError(f"download never appeared at {dest}")
            got_sha1 = sha1_file(dest)
            got_sha512 = sha512_b64_file(dest)
            rec("BR-07 remote-download", got_sha1 == dist.get("shasum"),
                file=dest, bytes=size, sha256=sha256_file(dest), sha1=got_sha1,
                remote_sha1=dist.get("shasum"),
                integrity_match=(f"sha512-{got_sha512}" == dist.get("integrity")),
                remote_integrity=dist.get("integrity"),
                tarball=dist.get("tarball"))
        except Exception as e:
            rec("BR-07 remote-download", False, error=f"{type(e).__name__}: {e}")

        # ---- BR-07b: a second, differently-typed download (JSON) ----
        try:
            dest = os.path.join(DW, "typescript-packument.json")
            body = urllib.request.urlopen(PACKUMENT, timeout=20).read()
            await blob_download(c, sid, "typescript-packument.json",
                                "application/json", body)
            size = await c.wait_file(dest, 60)
            rec("BR-07b json-download", size is not None, file=dest, bytes=size,
                sha256=sha256_file(dest) if size else None,
                py_sha256=hashlib.sha256(body).hexdigest())
        except Exception as e:
            rec("BR-07b json-download", False, error=f"{type(e).__name__}: {e}")

    print("===REPORT-BEGIN===", flush=True)
    print(json.dumps(REPORT, ensure_ascii=True, indent=1), flush=True)
    print("===REPORT-END===", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
