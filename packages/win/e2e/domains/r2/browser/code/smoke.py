"""BR smoke test: does browser-use still reach the CDP browser at all?"""
import json

print("SMOKE_START", flush=True)
try:
    info = page_info()
    print("SMOKE page_info: " + json.dumps(info, ensure_ascii=False)[:400], flush=True)
except Exception as e:  # noqa: BLE001
    print(f"SMOKE_ERR {type(e).__name__}: {e}", flush=True)
print("SMOKE_END", flush=True)
