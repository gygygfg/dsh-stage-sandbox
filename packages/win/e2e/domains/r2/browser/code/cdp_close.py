"""BR-11 teardown: close the automation browser through CDP itself.

`taskkill` / `Get-CimInstance Win32_Process` are unusable in this session
(access denied), so the browser is asked to close itself over CDP.
"""
import asyncio
import json
import urllib.request

import websockets

HTTP = "http://127.0.0.1:9222"


async def main():
    try:
        ver = json.loads(urllib.request.urlopen(f"{HTTP}/json/version", timeout=8).read())
        print("tabs before close:", flush=True)
        tabs = json.loads(urllib.request.urlopen(f"{HTTP}/json/list", timeout=8).read())
        print(json.dumps([{"type": t.get("type"), "url": t.get("url", "")[:60]}
                          for t in tabs], ensure_ascii=True), flush=True)
        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=8 << 20) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Browser.close"}))
            try:
                print("reply:", await asyncio.wait_for(ws.recv(), 6), flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"no reply (browser exiting): {type(e).__name__}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"CLOSE_ERR {type(e).__name__}: {e}", flush=True)
    await asyncio.sleep(3)
    try:
        urllib.request.urlopen(f"{HTTP}/json/version", timeout=4)
        print("STILL_UP", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"CDP_DOWN ({type(e).__name__})", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
