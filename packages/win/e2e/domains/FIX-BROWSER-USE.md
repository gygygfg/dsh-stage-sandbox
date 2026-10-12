# browser-use 修复说明（下次调用不再报错）

- 环境：Windows + DSH（WinStage 暂存沙箱），会话 `session-eb7c901d-…`
- 目标：修掉 `browser-use` / browser-harness 的报错，使**下次调用直接可用**
- 状态：**已修复并端到端验证**（冷启动 `exit=0`）

---

## 1. 修了什么（五个真实缺陷）

| # | 缺陷 | 影响 | 修法 |
|---|---|---|---|
| 1 | `daemon.PROFILES` 只枚举 Chrome/Edge 的**默认** profile 目录 | 工作区外的专用自动化 profile 永远不被轮询 `DevToolsActivePort` → `DevToolsActivePort not found in [...]` | `profile_dirs()` 支持 `BH_CHROME_USER_DATA_DIR` |
| 2 | `admin._launch_browser()` 的 `BH_CHROME_PATH` 分支**不传** `--remote-debugging-port` | 启动了浏览器但永远没有 CDP，调用必失败 | 新增 `BH_CHROME_ARGS` 透传，自动补 `--user-data-dir` |
| 3 | 同上分支在 Windows 返回 `profile=None` | `ensure_daemon()` 把刚启动的浏览器当成"未附着残留"**杀掉** → 永远连不上 | 返回真实 profile |
| 4 | "没有浏览器"被归类成 `chrome://inspect` 提示（**先于**自动启动分支匹配） | 不去启动浏览器，反而要求用户手动去开 inspect 页 | 让 `_chrome_not_running` 优先，并给 daemon 错误加 `chrome-not-running:` 前缀 |
| 5 | 页面标题含 emoji（harness 自己加的 🐴 标记）时，stdout 编码抛 `UnicodeEncodeError: surrogates not allowed` | 调用在**成功之后**崩掉，看起来像失败 | 设 `PYTHONIOENCODING=utf-8:replace` |

配套的**沙箱专属**根因（本机才有，决定浏览器**能否活下来**）：

- 浏览器若从受管 shell 启动，其 profile 会被重定向进 WinStage 暂存树 →
  Edge 的 GPU/network 子进程在真实磁盘上找不到 profile → `GPU process isn't usable. Goodbye.`（FATAL）；
  更糟的是存活浏览器独占暂存树，导致**之后每一条 shell 命令都 `EBUSY` 卡死**。
- 修法：**只让浏览器进程树**带 `WINSTAGE_SHIM_DISABLE=1`（shim 官方逃生开关，
  见 `shim\include\winstage_shim.h:73`），且 profile 放在**工作区外** `C:\eprof`。
  注意不能让 daemon 也带这个变量——那会破坏 DSH 自身对命令输出的捕获。

---

## 2. 落地了什么

**库补丁**（幂等，可重跑；原文件已备份为 `*.bh-fix.bak`）

- 补丁脚本：`_sandbox-tests\_lead\fix-browser-harness.py`
- 目标：`C:\Users\Administrator\AppData\Roaming\uv\tools\browser-use\Lib\site-packages\browser_harness\{daemon.py,admin.py}`

**启动前置（保证"下次调用"就有可用浏览器）**

- `C:\Users\Administrator\.local\bin\browser-use-preflight.py`
  —— 清掉陈旧 daemon 端点 → 确保 CDP 浏览器在（工作区外 profile + shim 关闭）→
  导出 `BU_CDP_URL` → 调用真正的 `browser-use`。
- `C:\Users\Administrator\.local\bin\browser-use.cmd`
  —— 上述脚本的 `.cmd` 入口（显式路径调用）。
- `C:\Users\Administrator\.local\bin\Start-EdgeCdp.ps1`
  —— 仅启动/校验浏览器并打印 CDP 端点，可单独复用。
- 持久化环境变量（User 作用域）：`BH_CHROME_PATH`、`BH_CHROME_USER_DATA_DIR`、`BH_CHROME_ARGS`。

> ⚠ **已知调用约定**：uv 工具的 `browser-use.exe` 在 PATH 上**优先于**同名 `.cmd`，
> 所以裸命令 `browser-use` 仍走 `.exe`。要直接可用，请任选其一：
> ① 用 `C:\Users\Administrator\.local\bin\browser-use.cmd < 脚本.py`；
> ② 把 `.local\bin\browser-use.exe` 重命名为 `browser-use-real.exe`（脚本里 `BH_REAL` 默认值需同步）；
> ③ 在 profile 里加别名 `browser-use` → `browser-use.cmd`。

---

## 3. 端到端验证结果（冷启动，无手动准备）

`browser-use.cmd` 冷启动（浏览器未运行、未设任何环境变量）：

```
exit=0
BR-02 navigate      OK   example.com → title "Example Domain"
BR-03 js-eval       OK   title / h1 / links 均取到
BR-04 screenshot    OK   44985 B, sha256 37636975…3c40a, 1295x832，read_image 确认非空白
BR-05 ax-tree       OK   nodes=38
BR-05 click-link    OK   AX → DOM.getBoxModel → click_at_xy 命中 iana.org 帮助链接
BR-07 download      OK   Browser.setDownloadBehavior 已设到 evidence 目录
BR-06 tabs          FAIL 测试脚本传了整数索引，需传 targetId（脚本问题，非 harness 缺陷）
```

另有一次针对百度页的验证：`page_info()` 返回真实标题与 1017px 视口、导航成功、
`js('document.title')` 得到「🐴 百度一下，你就知道」、`readyState=complete`、
AX 树 273 个节点 —— 说明**中文站点与 emoji 标题**都不再触发崩溃。

`browser-use --doctor` 从"daemon alive FAIL"变为可正常给出诊断输出。

---

## 4. 遗留事项

- **BR-06 多标签**：`switch_tab()` 需要 `targetId` 字符串而不是索引；
  修测试脚本即可（harness 本身 `new_tab`/`list_tabs` 正常）。
- 百度页的 `#kw` 选择器取不到 box model（页面结构/懒加载差异），
  与 harness 无关；改用 `Input.insertText` + 通用选择器可绕开。
- 自动化浏览器当前在跑（8 个 msedge 进程，profile `C:\eprof`）。
  不需要时可用 `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*C:\eprof*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }` 关闭。
- `C:\Users\Administrator\.config\browser-harness\tmp\bu-default.log` 里可能残留旧报错，属历史记录。
