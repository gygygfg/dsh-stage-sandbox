# 轮2：Edge 崩溃定位与修复 Runbook（含环境级 EBUSY 阻塞说明）

- 会话：`session-eb7c901d-97ed-4f83-9096-33c97138c361`
- 环境变化：DSH 文件策略 `workspace-write` → **`danger-full-access`**；审批策略 → `never`
- 状态：**根因已定位并修正；因 shell 层死锁，修复后的浏览器实测尚未执行**

---

## 1. 结论先行（三条）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **轮1「沙箱内起不了 Chromium（Mojo 要命名管道）」在轮2 已不成立** | 旧日志的 `FATAL:mojo\…platform_channel.cc:187 拒绝访问 (0x5)` 在轮2 日志中**完全消失**；`danger-full-access` 确实解除了该限制 |
| 2 | **Edge 崩溃根因不是 GPU，而是 profile 放错位置** | `--user-data-dir` 落在**工作区内** → 写入进 staging → **真实磁盘上没有这些目录** → Edge 自有子进程（GPU / network service，跑在 Edge 自己的沙箱里、**不经过 WinStage shim**）在真实磁盘上解析同一路径 → 找不到目录 → GPU 初始化失败 → FATAL |
| 3 | **GPU 失败是后果，不是原因** | 日志顺序：`DevTools listening on ws://127.0.0.1:9222/...`（可用）**早 1.2 秒**，随后才是 `Gpu Cache Creation failed: -2` → `GPU process launch failed: error_code=18` ×9 → `FATAL … GPU process isn't usable. Goodbye.` |

致命行原文（`_sandbox-tests\browser2\edge.err.txt`，仅存于 staging）：

```
ERROR:gpu\ipc\host\gpu_disk_cache.cc:737]   Gpu Cache Creation failed: -2
ERROR:content\browser\gpu\gpu_process_host.cc:1179] GPU process launch failed: error_code=18
ERROR:components\viz\host\persistent_cache_sandboxed_file_factory.cc:153]
  Failed to open persistent cache files in directory "…\browser2\edge-new\GPUPersistentCache\DawnGraphiteCache\…",
  error: 2: 系统找不到指定的路径。 (0x3)
FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:436] GPU process isn't usable. Goodbye.
bad_optional_access was thrown in -fno-exceptions mode
```

辅助证据：profile 内多处 `error: 2 (0x3)`（`GPUPersistentCache` / `Default\Cache\Cache_Data` / `Default\Network`）
与 `文件名或扩展名太长。(0xCE)`（staged 前缀把 profile 路径推过 260 字符 MAX_PATH）。

**轮2 已确认的正面事实**：Edge 能启动、DevTools **确实监听成功**（`ws://127.0.0.1:9222/devtools/browser/ee236f01-…`），
只是 1.2 秒后被 GPU FATAL 带走。

---

## 2. 判定标准必须修正（否则会永远误判失败）

- ✗ 旧标准：等 `--user-data-dir` 里出现 `DevToolsActivePort` 文件。
  实测 `glob **/DevToolsActivePort*` 在**所有**实验目录 → `No files found`；而 DevTools 明明已 listening。
- ✓ 新标准：**轮询 `http://127.0.0.1:<port>/json/version`**（HTTP 200 且返回 `webSocketDebuggerUrl`）
  **并且**进程仍存活 ≥10 秒（可用 `Get-Process -Id <pid>` 判定）。

---

## 3. 修复方案

**A（首选）——核心是「位置」，不是 GPU 参数**

```powershell
$edge='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$prof='C:\eprof'                 # ← 必须在【工作区之外】，且尽量短（避开 0xCE 超长路径）
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
$p = Start-Process $edge -PassThru -RedirectStandardError 'C:\eprof.err.txt' -RedirectStandardOutput 'C:\eprof.out.txt' -ArgumentList @(
  "--user-data-dir=$prof","--remote-debugging-port=9222",
  "--no-first-run","--no-default-browser-check",
  "--disable-extensions","--disable-sync",
  "--no-sandbox","--in-process-gpu","--disable-gpu-sandbox","--disable-software-rasterizer",
  "about:blank")
# 判定：轮询 http://127.0.0.1:9222/json/version 且 $p 存活 ≥10 秒
```

- 为什么这样能修：profile 位于工作区外 → Edge 所有子进程（含 GPU）在**真实磁盘**上都能看到它 →
  `0x3 找不到路径` 与 `0xCE 路径过长` 同时消失。
- GPU 相关参数（`--disable-gpu*` / `--in-process-gpu` / `--use-gl=swiftshader`）是**辅助**：
  若 A 仍 FATAL，再逐个加试并记录哪一组让 `/json/version` 稳定 ≥10 秒。

**B（备选）** 若 A 的 profile 位置仍出问题，改用 `%LOCALAPPDATA%\Temp\eprof`（同样在工作区外）。

**C（连接）** Edge 起来后：`$env:BU_CDP_URL='http://127.0.0.1:9222'`，再跑 `browser-use`。

> 已固化的启动器：[`launch-edge.mjs`](launch-edge.mjs)（含 base/gpu3/inproc/swift/nosandbox 五组参数）。
> 注意：**它的 profile 目录参数由调用方传入，务必传工作区外路径**；其内置的
> `DevToolsActivePort` 判定需按第 2 节改为 `/json/version` 轮询。

---

## 4. 当前阻塞：环境级 shell 死锁（必须宿主侧介入）

**现象**：**每一条** `pwsh` 命令（含 `"hello"`、`Get-Process`、`Get-Date`、后台 job、指定 `workdir`）
都在**执行前**失败：`EBUSY: resource busy or locked, read`。

**范围**：Lead 线程 10+ 次、browser-tester 线程 6+ 次、另派**全新子代理** 5/5 次同样失败
→ **环境级，不是线程局部**。同时 `read`/`glob`/`grep`/`write` 四个宿主侧工具**仍然正常**。

**锁源（有证据）**：我启动后崩溃的 Edge 的存活子进程仍独占 staged 树里的文件：
`browser2\edge-new\lockfile`、`Default\LOCK`、`Default\Sync Data\LevelDB\LOCK`、
`Default\load_statistics.db-wal`、`Crashpad\reports\*.dmp`。
后端在准备阶段要读该 staged 树 → 被锁 → 连只读命令一起废掉。

**死锁**：杀进程需要 shell，shell 需要先解锁 ⇒ 会话内无法自救。

**需要用户做（二选一）**

1. 任务管理器 →「详细信息」→ 右键列头 →「选择列」→ 勾选**命令行** → 结束命令行含
   `_sandbox-tests\browser2` 或 `.t\dsh2\browser` 的 `msedge.exe`（**不要**动用户自己的 Edge 窗口）；或
2. **重启 DSH 会话**（最省事，一并释放泄漏句柄）。

**恢复自检**：`Write-Output "shell-alive"` 能返回即已恢复。

---

## 5. 恢复后待执行清单

| 项 | 内容 | 判定 |
|---|---|---|
| R1 | 用第 3 节 A 参数启动 Edge（profile 在工作区外） | `/json/version` 200 且进程存活 ≥10s |
| R2 | `browser-use --doctor` → `new_tab('https://www.baidu.com')` → `wait_for_load()` → `page_info()` | 拿到标题与 URL |
| R3 | BR-03：`js('document.title')`、`js('location.href')`、百度输入框中文检索 | 结果页标题/首条结果文本 |
| R4 | BR-04：截图 → SHA256 → `read_image` 验证非空白 | 真实 PNG + 哈希 |
| R5 | BR-05：`cdp('Accessibility.getFullAXTree')` 节点数 → `DOM.getBoxModel` → `click_at_xy` 真实点击 | 点击生效 |
| R6 | BR-06：`list_tabs`/`new_tab`/`switch_tab` | 无重复标签、用户 12 个 msedge 不被触碰 |
| R7 | **BR-07（轮1 盲区，安全关键）**：让浏览器把文件**下载到工作区外**（如 `%USERPROFILE%\Downloads`），三通道取证 | 是否真实落盘 / 是否进候选审批面 |
| R8 | 产出 `_sandbox-tests\browser2\results.json` + `findings.md` | JSON 合法（用 `ConvertFrom-Json` 校验） |
| R9 | 结束自建 Edge 实例，确认无残留进程与工作区内 profile | 无 |

**轮2 现状**：BR-01~BR-07 全部 `BLOCKED`（OK 0 / BLOCKED 7 / FINDING 2），
**BR-04 截图 0 份、BR-07 仍未验证（不得当作通过）**。用户自有 msedge 进程全程未被触碰。

---

## 6. 给产品/文档的反馈

1. **必须把「子进程不经过 shim」写进文档**：Edge/Chromium 的 GPU 与 network service 子进程
   不继承 WinStage 覆盖层，任何 profile/缓存放进工作区都会导致「沙箱内看似成功、真实磁盘不存在」的
   静默分裂。**建议默认把浏览器 user-data-dir 指到工作区外**。
2. **判定脚本不要依赖 `DevToolsActivePort` 文件**，改轮询 `/json/version`。
3. `EBUSY` 应从「卡死一切命令」降级为「可诊断、可恢复」：建议后端读 staged 树时跳过被独占文件，
   或在错误里点明被锁路径；否则一个崩溃的浏览器实例就能让整个会话失去 shell。
