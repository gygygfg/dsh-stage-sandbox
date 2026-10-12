# 轮3：Edge 在沙箱内运行的完整修复 + 恢复执行清单

> 本文件是轮2 `FIX-EDGE-CRASH-RUNBOOK.md` 的**修正与升级版**。轮2 的「profile 放工作区外」
> 是**必要但不充分**的：真正的原因是**浏览器进程被 shim 注入**，必须显式关掉注入。

---

## 1. 两次修复的关系（重要）

| 轮次 | 结论 | 是否充分 |
|---|---|---|
| 轮1 | 「沙箱内起不了 Chromium（Mojo 要命名管道）」；DevTools 起不来 | 已被轮2 推翻 |
| 轮2 | 根因＝`--user-data-dir` 落在工作区内 → Edge 子进程在真实磁盘找不到 profile | **必要但不充分** |
| **轮3（本文件）** | Edge 由 DSH shell 派生 → **shim 被注入浏览器进程树** → 浏览器 profile 被重定向进 staging → ① 浏览器自身子进程读不到真实 profile 而 FATAL；② staging 里的 profile 被存活浏览器独占 → **DSH 后端读 staging 树 EBUSY，shell 与全部工具瘫痪** | **充分** |

轮3 的直接证据（实测）：

```
Error: EBUSY: resource busy or locked, open
 'C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-...\staged\fs\C\eprof\Default\Cookies'
```

即：`C:\eprof`（工作区**外**）的浏览器 profile 仍然出现在 **staging 树**里，说明 shim 已注入浏览器进程。

---

## 2. 根治办法：用官方逃生开关关掉浏览器进程树的 shim

`shim\include\winstage_shim.h:73` 明确记载：

```
WINSTAGE_SHIM_DISABLE  if set and not "0", the shim does nothing (escape hatch)
```

`shim\src\ws_entry.c:96` 在**安装任何 hook 之前**检查它 → 非 "0" 即整个 shim 空转（全程不暂存、
不重定向）。且 `ws_proc.c` 的子进程环境块重写只覆盖 3 个变量
（`WINSTAGE_STAGE_ROOT` / `WINSTAGE_SHIM_LOG` / `WINSTAGE_SHIM_CONFIG`），**不会清掉** `WINSTAGE_SHIM_DISABLE`，
因此该开关会被**整个浏览器进程树**继承。

### 启动脚本（在 DSH shell 里执行）

```powershell
# 1) 工作区外、短路径的 profile（避开 260 字符 MAX_PATH）
$prof = 'C:\eprof'
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue

# 2) 关掉浏览器进程树的 shim（关键！这样 profile 不会进 staging、也就不会锁死 shell）
$env:WINSTAGE_SHIM_DISABLE = '1'

# 3) 启动 Edge（GPU 参数是辅助项）
$p = Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -PassThru `
  -RedirectStandardError 'C:\eprof.err.txt' -RedirectStandardOutput 'C:\eprof.out.txt' `
  -ArgumentList @(
    "--user-data-dir=$prof", "--remote-debugging-port=9222",
    "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-sync",
    "--no-sandbox", "--in-process-gpu", "--disable-gpu-sandbox", "--disable-software-rasterizer",
    "about:blank")

Remove-Item Env:\WINSTAGE_SHIM_DISABLE -ErrorAction SilentlyContinue   # 只影响本次启动

# 4) 判定（不要用 DevToolsActivePort 文件，它不会出现）
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/version' -TimeoutSec 5).StatusCode  # 期望 200
```

### 已验证的部分（轮3 实测）

- ✅ Edge **能**在沙箱会话内稳定运行：`/json/version` 1 秒内返回 200，进程存活 >12 秒，
  返回 `"Browser": "Edg/154.0.4258.53"` 与 `webSocketDebuggerUrl: ws://127.0.0.1:9222/devtools/browser/…`
- ✅ 轮2 的 GPU FATAL（`GPU process isn't usable. Goodbye.`）在上述参数下**未再出现**；
  日志只剩无害告警（USB 枚举、QQBrowser 导入、扩展 Storage 目录）。
- ❌ **未验证**：`WINSTAGE_SHIM_DISABLE=1` 生效后 profile 不再进 staging ——
  因为环境随即被 EBUSY 锁死，无法再执行命令确认。

---

## 3. 当前必须由宿主侧完成的一步

**现象**：每一条 `pwsh` 命令（含 `"shell-check"`）在**执行前**失败于
`EBUSY: ... open '...\staged\fs\C\eprof\Default\Cookies'`；DSH 的 `read`/`write` 工具对同一路径同样 EBUSY。
→ **所有工具都被这一个锁挡住，会话内无法自救。**

**处置（任选其一）**

1. 任务管理器 →「详细信息」→ 勾选「命令行」列 → 结束命令行含 `C:\eprof` 的 `msedge.exe`
   （**不要**动用户自己的 Edge 窗口）；或
2. **重启 DSH 会话**（最省事，并清掉 staging 里的锁）。
3. 另外建议删除残留的 `C:\eprof` 与 staging 里的
   `…\staged\fs\C\eprof\` 子树，避免下次启动立刻复锁。

**恢复自检**：`"shell-check"` 能返回即已恢复。

---

## 4. 恢复后待执行清单

| 项 | 内容 | 判定 |
|---|---|---|
| R1 | 按第 2 节启动 Edge（**务必带 `WINSTAGE_SHIM_DISABLE=1`**） | `/json/version` 200 且进程存活 ≥10s |
| R1b | **新增验证**：确认 `…\staged\fs\C\eprof\` 不再产生（STAGE 通道） | 不再出现即锁死问题根除 |
| R2 | `$env:BU_CDP_URL='http://127.0.0.1:9222'`；`browser-use --doctor` → `new_tab('https://www.baidu.com')` → `wait_for_load()` → `page_info()` | 标题/URL |
| R3 | `js('document.title')`、`js('location.href')`；百度输入框中文检索 | 结果页标题/首条结果 |
| R4 | 截图 → SHA256 → `read_image` 验证非空白 | 真实 PNG + 哈希 |
| R5 | `cdp('Accessibility.getFullAXTree')` 节点数 → `DOM.getBoxModel` → `click_at_xy` | 点击生效 |
| R6 | `list_tabs` / `new_tab` / `switch_tab` | 无重复标签；用户 13 个 msedge 不被触碰 |
| R7 | **BR-07（安全关键盲区）**：浏览器下载到**工作区外**（如 `%USERPROFILE%\Downloads`） | 是否真实落盘；是否进候选/审批面 |
| R8 | 产出 `_sandbox-tests\browser2\results.json` + `findings.md`（`ConvertFrom-Json` 校验） | JSON 合法 |
| R9 | 结束自建实例；确认无 `C:\eprof` 残留进程与 staging 残锁 | 干净 |

---

## 5. 产品级反馈（本轮最有价值的产出之一）

1. **`WINSTAGE_SHIM_DISABLE` 的存在必须在文档里显式提示给浏览器场景**：
   任何 Chromium 系浏览器从 DSH shell 启动都会被注入 shim，其 profile 被重定向到 staging，
   于是「浏览器进程读真实 profile」与「staging 树被浏览器独占」同时发生 ——
   轻则浏览器 FATAL，重则**整个会话的工具链瘫痪（EBUSY）**。
2. **EBUSY 必须降级为可恢复**：当前后端读 staged 树时遇到被独占文件会连带废掉 **所有** 工具
   （含只读命令与 `read`），且报错只给一个路径、不给处置建议。建议：
   跳过被独占文件、或在门上直接提示「结束该进程 / 该路径已被浏览器占用」。
3. **判定脚本不要用 `DevToolsActivePort` 文件**（本机从未出现），改轮询 `/json/version`。
4. README「沙箱内起不了 Chromium（Mojo 需命名管道）」在 `danger-full-access` 下**已不成立**：
   轮3 实测 DevTools 正常监听、浏览器稳定运行；该结论应更新，并补上
   「浏览器必须用 `WINSTAGE_SHIM_DISABLE=1` + 工作区外 profile 启动」这一条件。
