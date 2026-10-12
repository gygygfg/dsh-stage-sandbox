"""End-to-end proof that the browser-use fix works with no browser pre-started."""
import json

print("=== BH-02 page_info on a fresh session ===")
try:
    print(json.dumps(page_info(), ensure_ascii=False)[:400])
except Exception as e:
    print("page_info:", type(e).__name__, e)

print("=== BH-03 navigate + evaluate ===")
new_tab("https://www.baidu.com")
wait_for_load()
print("title:", js("document.title"))
print("href:", js("location.href"))
print("readyState:", js("document.readyState"))
print("=== tabs ===")
print("current_tab:", json.dumps(current_tab(), ensure_ascii=False)[:200])
