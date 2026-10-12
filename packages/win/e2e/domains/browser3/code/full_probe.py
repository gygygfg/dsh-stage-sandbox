"""Full round-3 browser verification on the fixed harness (no manual setup)."""
import hashlib
import json
import os

OUT = r"C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\browser3\evidence"
os.makedirs(OUT, exist_ok=True)
report = []


def step(name, fn):
    try:
        val = fn()
        report.append({"step": name, "ok": True, "value": val})
        print(f"[OK]   {name}: {val}")
    except Exception as e:
        report.append({"step": name, "ok": False, "error": f"{type(e).__name__}: {e}"})
        print(f"[FAIL] {name}: {type(e).__name__}: {e}")


step("tab-info", lambda: json.dumps(page_info(), ensure_ascii=False))

# --- BR-02 navigation ---
step("navigate-baidu", lambda: (new_tab("https://www.baidu.com"), wait_for_load(), js("document.title"))[2])

# --- BR-03 JS evaluation + real DOM interaction ---
def _center_of(selector):
    nodes = cdp("DOM.getDocument", depth=-1)
    root = nodes["root"]["nodeId"]
    q = cdp("DOM.querySelector", nodeId=root, selector=selector)
    nid = q["nodeId"]
    if not nid:
        raise RuntimeError(f"selector not found: {selector}")
    box = cdp("DOM.getBoxModel", nodeId=nid)["model"]["content"]
    x = sum(box[0::2]) / 4
    y = sum(box[1::2]) / 4
    return x, y


step("ax-tree", lambda: f"nodes={len(cdp('Accessibility.getFullAXTree')['nodes'])}")
step("boxmodel-center", lambda: json.dumps(_center_of("#kw, input[name=wd]")))

# --- BR-03b real interaction: focus the box, type Chinese text, press Enter ---
def search_chinese():
    x, y = _center_of("#kw, input[name=wd]")
    click_at_xy(x, y)
    cdp("Input.insertText", text="沙箱测试")
    for t in ("keyDown", "keyUp"):
        cdp("Input.dispatchKeyEvent", type=t, key="Enter", code="Enter",
            windowsVirtualKeyCode=13, nativeVirtualKeyCode=13)
    wait_for_load()
    return {"title": js("document.title"), "url": js("location.href")[:80],
            "value": js("(document.querySelector('#kw')||{}).value")}


step("search-chinese", search_chinese)

# --- BR-04 screenshot + hash + verification ---
def shot():
    path = os.path.join(OUT, "br04-baidu.png")
    png = cdp("Page.captureScreenshot", format="png")["data"]
    import base64

    raw = base64.b64decode(png)
    with open(path, "wb") as f:
        f.write(raw)
    return {"path": path, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


step("screenshot", shot)

# --- BR-05 click a real link via AX -> box -> click ---
def click_link():
    before = js("location.href")
    clicked = js("""(() => {
      const a = [...document.querySelectorAll('a')].find(x => x.href && x.href.startsWith('http'));
      if (!a) return 'NO_LINK';
      a.setAttribute('data-bh-target','1');
      return a.href;
    })()""")
    if clicked == "NO_LINK":
        return "no link found"
    x, y = _center_of("a[data-bh-target='1']")
    click_at_xy(x, y)
    return {"clicked": clicked[:60], "from": before[:40]}


step("click-link", click_link)

# --- BR-06 tabs ---
def tabs():
    a = len(list_tabs())
    new_tab("about:blank")
    b = len(list_tabs())
    switch_tab(b - 1)
    return {"before": a, "after": b, "current": json.dumps(current_tab(), ensure_ascii=False)[:120]}


step("tabs", tabs)

print("\n=== REPORT ===")
print(json.dumps(report, ensure_ascii=False, indent=2))
