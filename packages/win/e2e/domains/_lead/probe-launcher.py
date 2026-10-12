"""Isolate the patched _launch_browser: does it start an Edge that exposes CDP?"""
import inspect
import os
import time
import urllib.request

from browser_harness import admin

print("BH_CHROME_PATH =", os.environ.get("BH_CHROME_PATH"))
print("BH_CHROME_USER_DATA_DIR =", os.environ.get("BH_CHROME_USER_DATA_DIR"))
print("BH_CHROME_ARGS =", os.environ.get("BH_CHROME_ARGS"))
print("WINSTAGE_SHIM_DISABLE =", os.environ.get("WINSTAGE_SHIM_DISABLE"))

src = inspect.getsource(admin._launch_browser)
print("--- patched marker present:", "BH-FIX" in src)

launch = admin._launch_browser()
print("launch =", launch)
proc, profile = launch if launch else (None, None)
print("process pid =", getattr(proc, "pid", None), "profile =", profile)

for i in range(30):
    time.sleep(1)
    try:
        body = urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=3).read()
        print(f"CDP up after {i+1}s:", body[:120])
        break
    except Exception as e:
        if proc is not None and proc.poll() is not None:
            print(f"browser exited after {i+1}s with code {proc.returncode}")
            break
else:
    print("CDP never came up in 30s")

if proc is not None:
    print("still alive:", proc.poll() is None)
