"""R2: browser-use connects to the isolated Edge over CDP and loads a page."""
import json

try:
    info = page_info()
    print("PRE-ATTACH page_info:", json.dumps(info, ensure_ascii=False)[:400])
except Exception as e:
    print("PRE-ATTACH page_info failed:", type(e).__name__, e)

t = new_tab("https://www.baidu.com")
wait_for_load()
info = page_info()
print("POST-NAV page_info:", json.dumps(info, ensure_ascii=False)[:600])
print("title:", js("document.title"))
print("href:", js("location.href"))
print("readyState:", js("document.readyState"))
print("UA:", js("navigator.userAgent"))
