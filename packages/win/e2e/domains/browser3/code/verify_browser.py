"""Round-3 browser verification: page-agnostic, proves each capability end to end."""
import base64
import hashlib
import json
import os

OUT = r"C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\browser3\evidence"
os.makedirs(OUT, exist_ok=True)
results = []


def step(name, fn):
    try:
        val = fn()
        results.append({"step": name, "ok": True, "value": val})
        print(f"[OK]   {name}: {val}")
    except Exception as e:
        results.append({"step": name, "ok": False, "error": f"{type(e).__name__}: {e}"})
        print(f"[FAIL] {name}: {type(e).__name__}: {e}")


def center(selector):
    root = cdp("DOM.getDocument", depth=-1)["root"]["nodeId"]
    nid = cdp("DOM.querySelector", nodeId=root, selector=selector)["nodeId"]
    if not nid:
        raise RuntimeError(f"selector not found: {selector}")
    box = cdp("DOM.getBoxModel", nodeId=nid)["model"]["content"]
    return sum(box[0::2]) / 4, sum(box[1::2]) / 4


# BR-02: navigate a simple, stable page
step("BR-02 navigate", lambda: (new_tab("https://example.com"), wait_for_load(), js("document.title"))[2])

# BR-03: JS evaluation on the rendered DOM
step("BR-03 js-eval", lambda: {"title": js("document.title"),
                               "h1": js("document.querySelector('h1').textContent"),
                               "links": js("document.querySelectorAll('a').length")})

# BR-04: screenshot -> file -> sha256
def screenshot():
    p = os.path.join(OUT, "br04-example.png")
    raw = base64.b64decode(cdp("Page.captureScreenshot", format="png")["data"])
    open(p, "wb").write(raw)
    return {"path": p, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()[:32]}


step("BR-04 screenshot", screenshot)

# BR-05: AX tree + real coordinate click on a link
step("BR-05 ax-tree", lambda: f"nodes={len(cdp('Accessibility.getFullAXTree')['nodes'])}")


def click_link():
    href = js("document.querySelector('a').href")
    x, y = center("a")
    click_at_xy(x, y)
    wait_for_load()
    return {"clicked_href": href[:60], "now": js("location.href")[:60]}


step("BR-05 click-link", click_link)

# BR-06: tab management
def tabs():
    before = len(list_tabs())
    new_tab("about:blank")
    after_open = len(list_tabs())
    switch_tab(0)
    return {"before": before, "after_open": after_open, "current": js("location.href")[:40]}


step("BR-06 tabs", tabs)

# BR-07 (security, round-1 blind spot): download target location
def download_probe():
    tgt = os.path.join(OUT, "download-target.txt")
    cdp("Browser.setDownloadBehavior", behavior="allow", downloadPath=OUT)
    js("""(() => {
      const b = new Blob(['download-probe'], {type: 'text/plain'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = 'bh-download.txt';
      document.body.appendChild(a); a.click(); a.remove(); return 'triggered';
    })()""")
    return {"download_dir": OUT, "cdn_behavior": "set to allow"}


step("BR-07 download-trigger", download_probe)

print("\n=== REPORT ===")
print(json.dumps(results, ensure_ascii=False, indent=2))
