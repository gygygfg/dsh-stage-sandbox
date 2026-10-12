# browser-tester 轮2 小结 · danger-full-access

线程 `browser-tester`　写入范围 `_sandbox-tests\browser2\`　策略：`danger-full-access` / 审批 `never`
（轮1 产物仍在 `_sandbox-tests\browser\`，未改动。）

## 0. 一句话结论

轮2 **仍然 BLOCKED，但性质变了，而且拿到了两个高价值结论**：

1. **执行后端全面卡死**：本线程每一条 shell 命令都在执行前失败于 `EBUSY: resource busy or locked, read`
   （前台 / 后台 job / 指定 workdir 三种方式都试过），因此**任何浏览器操作都无法执行**。
   锁源指向 lead 崩溃的 Edge 实例持有的 staged 文件（`edge-new\lockfile` 等）——这形成死锁：
   杀进程要 shell，shell 要先解锁。**必须由用户/宿主介入。**
2. **Edge 崩溃的真正根因被定位，而且不是"GPU 在沙箱内起不来"**：是 **profile 目录被 staged-化**。
   Mojo 命名管道限制在轮2 确实已解除（旧日志的 `platform_channel.cc:187 FATAL` 消失，
   新日志出现 `DevTools listening on ws://127.0.0.1:9222/...`），真正的杀手是：Edge 把 profile
   写进工作区 → 只存在于 staging、真实磁盘上没有 → Edge 自己的子进程（GPU/network service，
   不经 WinStage shim）在真实磁盘上找不到这些目录 → GPU 缓存/进程初始化失败 → FATAL 退出。

状态计数（轮2）：`OK 0` / `BLOCKED 7` / `FINDING 2` / `FAIL 0` / `N-A 0`。

## 1. 【最高优先】执行后端 EBUSY 死锁

### 现象
```
$ Write-Output "ping"
Error: EBUSY: resource busy or locked, read
```
连**不碰文件**的纯字符串输出都失败，且失败发生在"执行前"。已穷尽的尝试（全部 EBUSY）：

| # | 命令 | 结果 |
|---|---|---|
| 1-4 | `Write-Output "ping"/"ping2"/"probe-again"/"probe3"` | EBUSY |
| 5 | `Get-Process msedge \| Measure-Object` | EBUSY |
| 6-7 | 显式 `workdir=C:\` / `workdir=C:\Windows\Temp` | EBUSY |
| 8 | `run_in_background: true` → job `pwsh-94` | 启动后 `[status: failed, EBUSY]` |
| 9-10 | `Get-ChildItem`、`cmd /c dir` | EBUSY |

**未被阻断的能力**：`read` / `glob` / `grep` / `write` 全部正常 —— 本轮的根因分析正是靠它们完成的。

### 锁源（有证据）
staged 树里 lead 那次崩溃的 profile 含存活进程会独占持有的文件：
```
<staged>\...\browser2\edge-new\lockfile
<staged>\...\browser2\edge-new\Default\LOCK
<staged>\...\browser2\edge-new\Default\Sync Data\LevelDB\LOCK
<staged>\...\browser2\edge-new\Default\load_statistics.db-wal
<staged>\...\browser2\edge-new\Crashpad\reports\7b423954-...dmp
```
后端在准备阶段枚举/读取 staged 树 → 命中被独占的文件 → 整个命令被拒绝。
完整原始错误与尝试清单：`evidence/round2-blocker-EBUSY.txt`。

### 需要用户/宿主做的（我无法自救）
1. 结束命令行含 `_sandbox-tests\browser2` 或 `.t\dsh2\browser` 的 **msedge.exe**（测试实例）。
   任务管理器需先在"详细信息"页 → 右键列头 → 选择列 → 勾选**命令行**才能区分；
   **不要**动用户自己打开的 Edge 窗口。
2. 或直接**重启 DSH 应用 / 会话**（最省事，可一并清掉所有泄漏句柄）。
3. 恢复后先验证 `Write-Output "shell-alive"`，并避开/删除 `_sandbox-tests\browser2\edge-new`。

### 对后端的建议
- 枚举/读取 staged 树时**容错单个 EBUSY/EPERM 文件**（跳过 + 告警），不要让一个被占用的文件
  让整个 agent 线程失去执行能力（轮1 是约 50% 拒绝、可重试；轮2 是 100% 拒绝、无出路）。
- 错误信息里给出**触发路径**（现在只有 "read" 二字，只能靠猜）。
- 对 Chromium 系进程考虑跳过写入重定向，或禁止把 profile 类长生命周期目录放进 staged 树
  （本轮证明重定向会让 Chromium 自身崩溃）。

## 2. Edge 崩溃根因：profile 被 staged-化（非 GPU 本身）

### 决定性证据：真实磁盘 vs staging
```
$ read  <ws>\_sandbox-tests\browser2\edge-new\Last Version      -> Error: not found
$ read  <ws>\_sandbox-tests\browser2\edge.err.txt              -> Error: not found
$ glob  <ws>\_sandbox-tests\browser2  **/*                      -> 只有 launch-edge.mjs（lead 的脚本）
$ glob  <staged>\...\_sandbox-tests\browser2  *                 -> 141 个路径，含
        edge.err.txt / edge.out.txt / edge-new\Last Version / edge-new\lockfile /
        edge-new\Default\LOCK / edge-new\Crashpad\reports\*.dmp ...
```
→ **Edge 的整个 profile 树只存在于 staging，真实磁盘上不存在。**

Edge 的 GPU / network service 子进程运行在 **Edge 自有沙箱**内，不经过 WinStage shim，
它们在**真实磁盘**上解析同一批路径，于是：
```
error: 2: 系统找不到指定的路径。 (0x3)        <- GPUPersistentCache / Default\Cache\Cache_Data / Default\Network
文件名或扩展名太长。 (0xCE)                    <- Default\Storage\ext\<32字符id>\def\Network
Gpu Cache Creation failed: -2
GPU process launch failed: error_code=18       （重复 9 次）
FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:436] GPU process isn't usable. Goodbye.
```
即：**GPU 失败是 profile 不可见的后果，不必然是独立原因。**

### 另一个必须纠正的认知：DevTools 其实起来了
lead 的 `browser2\edge.err.txt` 第 7 行（STAGE 通道可读）：
```
DevTools listening on ws://127.0.0.1:9222/devtools/browser/ee236f01-f3ff-40b1-a768-8aa825135f92
```
这比第 49 行的 GPU FATAL（02:46:19.764）早约 **1.2 秒**。所以"30 秒内不产生 `DevToolsActivePort`"
的判断需要修正为：**DevTools 监听建立过，浏览器随后被 GPU FATAL 杀掉**；
另外 `DevToolsActivePort` 文件在任何实验目录里都不存在（`glob **/DevToolsActivePort*` → No files），
**因此不应该把"有没有 DevToolsActivePort 文件"当作唯一判定标准** —— 应同时轮询
`http://127.0.0.1:9222/json/version` 并判断浏览器进程是否存活。

### 轮2 已解除的限制（好消息）
旧日志 `.t\dsh2\browser\raw\edge2-no-sandbox-only.err.txt`（0928）：
```
FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : 拒绝访问。 (0x5)
```
轮2 的 1003 日志里**没有**这条 → danger-full-access 确实解除了"Mojo 需要命名管道"的限制。
轮1 的 README 结论"沙箱内起不了 Chromium"在轮2 **已不成立**，剩下的是 staged-化这个次生问题。

### 首选修复（解除 EBUSY 后按序验证）
判定标准：45 秒内出现 `DevToolsActivePort` **或** `/json/version` 可访问，且进程存活 > 60 秒。

**A)（首选）把 profile 放到工作区之外的短路径**
```powershell
$prof = 'C:\eprof'          # 或 $env:LOCALAPPDATA\Temp\eprof —— 关键是"不在工作区内"且路径短
Start-Process 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -PassThru `
  -ArgumentList @("--user-data-dir=$prof",'--remote-debugging-port=9222',
    '--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync',
    '--no-sandbox','--in-process-gpu','--disable-gpu-sandbox','--disable-software-rasterizer',
    'about:blank')
```
**位置是主修复；`--no-sandbox`/`--in-process-gpu` 是辅助**（避免 GPU 子进程再被 Edge 自有沙箱拒绝）。

**B)** 若 A 仍失败，保留 A 的 profile 位置，逐个试 `--disable-gpu` / `--use-gl=swiftshader` /
`--disable-gpu-compositing` / `--in-process-gpu` 的单用与组合。

**C)** 验证通道用 `/json/version` 轮询，而不是只看 `DevToolsActivePort` 文件（理由见上）。
连上后 `browser-use` 用 `BU_CDP_URL=http://127.0.0.1:9222`。

## 3. BR-02 ~ BR-07 结论

| id | 轮2 状态 | 说明 |
|---|---|---|
| BR-01 `--doctor` 复测 | BLOCKED | shell 全死，无法执行；轮1 输出仍有效 |
| BR-02 导航 + `page_info` | BLOCKED | 需先解 EBUSY + 用第 2 节 A 方案起 Edge |
| BR-03 JS/DOM 交互 | BLOCKED | 同上；0 份交互证据 |
| BR-04 截图 + `read_image` | BLOCKED | **0 份截图证据**，不计为通过 |
| BR-05 AX 树 + 坐标点击 | BLOCKED | 同上 |
| BR-06 多标签页 | BLOCKED | 未创建/切换/关闭任何标签页；用户自有 msedge 进程未被触碰 |
| BR-07 下载落点判定 | BLOCKED | **仍是未验证盲区**，不能当作通过 |

BR-06/BR-07 的补充证据（本轮唯一直接相关的实测）：Edge 写入**工作区内**的文件
**只进 staging、不落真实磁盘**（141 个 profile 文件 vs 真实磁盘 0 个）。
这既解释了 Edge 崩溃，也说明"子进程写入被导向 staging"在 `danger-full-access` 下**依然存在**；
但**浏览器下载到工作区外**的行为必须单独实测，不能由此推断。

## 4. 易用性（轮2）

| # | 坑 | 代价 | 与轮1 对比 |
|---|---|---|---|
| 1 | 执行后端 100% EBUSY，无任何可绕过手段 | 彻底无出路，且**无法自救**（杀进程需 shell） | 轮1 是 ~50% 拒绝、可重试；轮2 危害大得多 |
| 2 | EBUSY 错误只有一个 "read" 字，不含路径 | 排障只能靠猜 | 新问题 |
| 3 | `DevToolsActivePort` 文件始终不生成，但 DevTools 确实监听过 | 用错判定标准会误判成"端口没起来" | 新问题 |
| 4 | Chromium 在"写入被重定向"的环境下会因自己的子进程看不到 profile 而 FATAL | 表面像 GPU/沙箱问题，实际是文件重定向问题 | 轮1 被笼统归因为"沙箱内起不了 Chromium" |
| 5 | heredoc `browser-use <<'PY'` 在 Windows 仍不适用（轮1 已记录，未变） | 需自行改用 stdin 管道 | 未变 |

**教训**：EBUSY 的触发条件（某个存活进程持有 staged 内文件的锁）会让**整个 agent 线程失去执行能力**，
且形成"杀进程要 shell、shell 要先解锁"的死锁 —— 这类失败必须由宿主侧兜底，不能指望 agent 自愈。

## 5. 证据

| 文件 | 内容 |
|---|---|
| `results.json` | 机器可读，BR-01~BR-09（轮2·danger-full-access） |
| `evidence/round2-blocker-EBUSY.txt` | EBUSY 全部尝试 + 原始错误 + 锁源 + 用户需做什么 |
| `evidence/edge-crash-rootcause.txt` | Edge 崩溃原始日志 + 真实磁盘/staging 对照 + 修复参数 |

测试遗留物：`_sandbox-tests\browser2\edge-new\`（lead 启动的崩溃 profile，仅存在于 staging）、
`edge.err.txt`、`edge.out.txt`。**未能在结束前关闭自建实例**——因为轮2 我自始至终没能启动任何
浏览器实例（shell 全死）；需要用户按第 1 节清理存活句柄。用户自有 msedge 进程未被触碰。
