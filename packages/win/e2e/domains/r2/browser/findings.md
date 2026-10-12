# r2 / browser 域实测小结（WinStage 沙箱第二轮）

- 线程：browser（浏览器操作） · 会话 `session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 产出目录：`_sandbox-tests\r2\browser\`（`results.json` / `findings.md` / `executions.log` / `evidence\` / `code\`）
- 规模：31 条 shell 命令 + 约 20 次 read/glob/grep/write 工具调用（合计 ~51，符合 40–70）
- 结论一句话：**浏览器能力本身（CDP、导航、JS、截图、下载、TLS、多标签）全部可用且已取证；但 `browser-use` 入口在本会话被一场会话级 shim 写拒绝打瘫，且坐标点击在本环境静默失效。**

---

## 1. 结论表

| ID | 标题 | 状态 | 通道 |
|---|---|---|---|
| BR-01 | `--doctor` 输出/耗时/步骤 | **FAIL** | CMD/HOST |
| BR-02 | 冷启动 + 附着 + CDP 端点 | OK（checkpoint 方法本身有误，见 §4） | PS/CMD/HOST/STAGE |
| BR-03 | 导航 + JS 求值（example.com / 百度） | OK（h1 为页面属性，非缺陷） | CMD/HOST |
| BR-04 | 截图落盘 + read_image + 哈希 | **OK** | CMD/HOST |
| BR-05 | AX 树 + AX→box 点击 + URL 变化 | **FAIL**（静默失效） | CMD/HOST |
| BR-06 | 多标签 new/list/switch | OK（确认必须传 `targetId`） | CMD |
| BR-07 | 下载 + 双通道 + 远端哈希 | **OK**（含逃逸面发现） | CMD/HOST/STAGE/PS |
| BR-08 | C:\eprof 与 `.config\browser-harness` 隔离面 | FINDING（逃逸面） | HOST/STAGE/PS |
| BR-09 | 网络与 TLS | OK（无中间人） | CMD/HOST |
| BR-10 | 沙箱视角 vs HOST | OK（一致，无矛盾） | PS/CMD/HOST |
| BR-11 | 收尾与无副作用 | **FAIL**（收尾不彻底 + 写拒绝不因关浏览器而解除） | CMD/PS/HOST |
| BR-12 | 易用性小结 | FINDING | 汇总 |

统计：OK 6 · FAIL 4 · FINDING 2 · BLOCKED 0（browser-use 入口按 FAIL 记，因环境缺陷而非域外阻塞）· N-A 1（h1 / harness stdout emoji 路径）。

---

## 2. CRITICAL（按协议要求单列）

### C-1【会话级】所有被 shim hook 的进程，写操作一律被拒 → 全部 8 线程的产盘能力可能同时失效
- 现象（PS/CMD 通道，20:15 仍复现）：`Set-Content`/`.NET File.WriteAllText` 写工作区内任意路径、`C:\Windows\Temp\…`、`%USERPROFILE%\.config\browser-harness\tmp\…` 全部
  `UnauthorizedAccessException: Access to the path '…' is denied.`；`cmd /c "echo x> …"` → `Access is denied.`
- 同时失效的还有：`Get-CimInstance Win32_Process` → 拒绝访问 `0x80041003`；`tasklist` → `ERROR: Access is denied`；`whoami` → `Access is denied`；`Get-PSDrive C` → Used=0/Free 空。
- 仍然正常的：**读**（`Get-Content`/`Get-ChildItem`/`Get-Acl`/`Get-Item`/`Get-Process`）、工作区外的 HOST 工具（`read`/`write`/`glob`/`grep`）、以及**写入 stageRoot 自身（passthrough）** —— `staged\probe2.txt`、`staged\fs\C\Windows\Temp\direct1.txt` 都写成功。
- 关键排除：`C:\` 剩余 67.68 GB（`.NET DriveInfo`）→ 不是磁盘满；沿 `WinStageSandbox → .dshstage → sessions → session-… → staged → staged\fs` 逐级 `Get-Acl`：全部是 `Administrators/Administrator FullControl`，只有 Everyone 的 `DeleteSubdirectoriesAndFiles` Deny（与被拒的写无关）；进程令牌是**普通管理员**（无 AppContainer `S-1-15-2-*`）→ 不是 ACL、不是容器。
- 最可能的机制（提供线索，非结论）：shim `failClosed=1`，其 overlay/registry 状态不可用即一律拒绝；`shim.log` 里出现
  `DshRegStageAttach: shared hive unusable (32) -> per-process hive=…overlay.5168.hive`（32 = ERROR_SHARING_VIOLATION）。
- 时间线：本次实测开头（17:44–17:47）`Get-CimInstance` 还是好的；在我执行过一条把 `$env:WINSTAGE_SHIM_DISABLE='1'` 的 pwsh 命令（伴随一次 `Error: EBUSY: resource busy or locked, read`、该命令零输出）之后开始全线拒绝。
  **无法排除是并行线程触发**（8 线程同时在跑）。
- 反向证据：**关掉自动化浏览器后写仍然被拒**（BR-11）→「存活浏览器独占暂存树」这条 FIX-BROWSER-USE.md 的根因解释，对本轮的全线程写拒绝不成立。

### C-2【逃逸面】浏览器的全部落盘写入对「候选 → 审批」面完全不可见
- `C:\eprof`：真实磁盘 **60 顶层项 / 824 文件**；`staged\fs\C\eprof = False`；104 个 candidate + `review.json` + `manifest.json` + `queue.json` 中 `eprof` 命中 **0**。
- 我的下载物（`typescript-5.6.3.tgz` 4174590B、`br04-example.png` 33523B、`typescript-packument.json` 7044B）同样：真实磁盘可见、overlay 无副本、候选面 0 条。
- 机制符合设计（浏览器进程树带 `WINSTAGE_SHIM_DISABLE=1`），但**对用户意味着**：一个被自动化驱动的浏览器可以往宿主磁盘任意位置写入，审批面一条都不显示。

### C-3【文档/证据链断裂】`WINSTAGE_SHIM_DISABLE=1` 逃生开关在本会话对 shimmed shell 的子进程**不生效**
- 实测：`$env:WINSTAGE_SHIM_DISABLE='1'; & <uv-python> -c "open(r'…\evidence\pyescape.txt','w')…"` → `PermissionError: [Errno 13] Permission denied`；`cmd /c "echo …> …\escape.txt"` → `Access is denied.`
- 而 preflight 用 `subprocess.Popen(env=…)` 起的 Edge **确实**没有进 overlay（`staged\fs\C\eprof=False`）→ 同一条开关，两条路径结果相反。
- 与 PROTOCOL §3.2（Lead 已实测「cmd + DISABLE 能写真实磁盘」）**通道矛盾**，请 Lead 复核：本会话该 HOST 通道已不可用。
- 附带：本会话后续 shell 里 `WINSTAGE_STAGE_ROOT` / `DSH_REGSTAGE_ROOT` / `WINSTAGE_SHIM_LOG` / `WINSTAGE_SHIM_CONFIG` **全部消失**（只剩 `DSH_*`）。协议要求「路径全部来自环境变量」，此状态下无法照做（我改用字面路径）。

### C-4【静默降级】坐标点击返回成功但完全不生效（BR-05）
- `Input.dispatchMouseEvent`（mouseMoved/mousePressed/mouseReleased，`buttons=1`）无报错；`elementFromPoint` 命中正确元素（`A|Learn more`、`BUTTON|bhbtn`）；但 `onclick` 不触发、链接不跳转；DOM 侧 `.click()` 立即生效。
- 根因取证：该标签**永久** `document.visibilityState == "hidden"`、`hidden == true`（`hasFocus == true`）；`Page.bringToFront`、`Target.activateTarget`、`Browser.setWindowBounds(windowState=normal, 1100x800)`（窗口几何确实改了）全都无法把它变可见；所有 msedge 的 `MainWindowHandle == 0`。
- 结论：本机 DSH 会话没有可交互桌面/窗口不会被合成，Chromium 在这种状态下**丢弃合成器输入但不报错**。

---

## 3. 证据索引（每条 checkpoint 的原始出处）

| 证据 | 位置 | 关键数字 |
|---|---|---|
| CDP 端点/版本 | `executions.log#BR-02` | `Edg/154.0.4258.53`，`ws://127.0.0.1:9222/devtools/browser/bf303578-…` |
| 浏览器命令行 | `executions.log#BR-02` | `--user-data-dir=C:\eprof --remote-debugging-port=9222 --no-sandbox --in-process-gpu …`（8 进程） |
| 截图 | `evidence\downloads\br04-example.png` | 33523 B，sha256 `55fa240a…51089d`（CDP 字节 == 宿主字节），read_image 450x813 非空白 |
| 下载（远端校验） | `evidence\downloads\typescript-5.6.3.tgz` | 4174590 B，sha1 `5f3449e3…` == registry shasum，sha512 integrity 一致，sha256 `ef67f8d8…` |
| 下载（第二通道） | `evidence\downloads\typescript-packument.json` | 7044 B，sha256 `0b19686d…` == python urllib 侧同内容哈希 |
| 候选面比对 | `executions.log#BR-07/#BR-08` | review.json 379929 B（files 2895 / normal 2879 / outside 15 / sensitive 1 / danger 0）；104 个 candidate；browser 产物命中 0 |
| TLS | `executions.log#BR-09` | baidu TLS 1.2 / GlobalSign RSA OV SSL CA 2018 / subject baidu.com；example.com h3 + isSecureContext |
| 驱动源码 | `code\cdp_probe.py` `cdp_probe2..6.py` `cdp_close.py` `smoke.py` | 自建 websockets CDP 客户端（不依赖 daemon） |

---

## 4. checkpoint 设计层面的坑（供 Lead 修协议）

1. **BR-02 的取证方法不成立**：`WINSTAGE_SHIM_DISABLE` 是环境变量，`Win32_Process.CommandLine` 永远不会包含它（实测命中 0）。应改为：命令行含 `--user-data-dir=C:\eprof` + `C:\eprof` 真实文件数 > 0 + `staged\fs\C\eprof` 不存在 + 浏览器 GPU 子进程存活。
2. **BR-03 的 `h1` 期望过时**：当前 `https://example.com` 没有 h1（`getElementsByTagName('h1').length == 0`，body 只有 1593 字节的 style+svg）。继续用 h1 判定会得到假失败。建议改用 `title` + `document.body.innerText` 前若干字符。
3. **BR-11 的收尾命令在本会话不可用**：`Get-CimInstance`（WMI）与 `taskkill` 都被拒绝访问，管道整条静默失败，还会打印出误导性的 `all msedge: 0`。可用替代：CDP `Browser.close` → `Get-Process` + `Stop-Process`。
4. **harness 的 stdout emoji 路径（上一轮缺陷 #5）本轮 N-A**：`browser-use` CLI 起不来，`PYTHONIOENCODING=utf-8:replace` 那一层无法验证；只能在 CDP 层证明中文标题正常（百度标题 UTF-8 字节 `e799bee5baa6…`）。

---

## 5. 易用性（硬性要求）

**TOP3**

1. **daemon 端点写不进去 = 整个入口死掉，且没有任何降级路径。** 报错是 5 行 Python traceback + `PermissionError: [WinError 5] 拒绝访问。: 'C:\Users\Administrator\.config\browser-harness\runtime\bu-default.port'`，全程没有一个字提到沙箱/重定向。`browser-use` 有 `BU_CDP_URL`（我这条 CDP 通道明明活着）却仍强制 `ensure_daemon()`。建议：端点目录不可写时直接以「无 daemon 模式」连 `BU_CDP_URL`。
2. **点击静默失效**：CDP 返回 success，页面毫无反应。必须自己想到用 `elementFromPoint` + DOM `.click()` 做对照才能定位（我花了 4 个探针）。建议 harness 的 `click_at_xy` 在点击后校验一次「页面是否有反应/可见性」，不可见时明确抛错。
3. **`--doctor` 的判定会把用户带偏**：浏览器明明在跑（CDP 可用、824 个 profile 文件），它报 `[FAIL] chrome running — start chrome/edge`；反之上一次它又因为读到残留端口文件而报 `[ok] daemon alive`。建议判定条件改为「连一次 CDP 并 `Runtime.evaluate('1+1')` 成功」。

**其他**

- 截图/点击前必须 `Page.bringToFront`，否则 `Page.captureScreenshot` 直接 40 s 超时——这条约定 skill 只有一句暗示，没有可判定的判据。
- 下载路径的目录必须存在（我用宿主 write 工具先建目录）；`Browser.setDownloadBehavior` 对不存在的 downloadPath 不报错。
- 上一轮遗留的 `switch_tab` 用法：本轮拿到硬证据——传整数 → `-32602 No target with given id found`，必须传 `targetId` 字符串。
- `browser-use-preflight.py` 的 `clear_stale_endpoint()` 是**安慰剂**：它打印 `removed stale endpoint bu-wstage.port`，但 HOST glob 在 30 分钟后仍看到该文件，候选面里只留下一条 op="delete" 记录 → 删除被 shim 吞掉。建议改为「删除失败就换一个 `BU_NAME`」。
- 用户想「用浏览器做一次验收」在本会话的实际步数：**≥6 步**（查残留 → 直连 9222 → 自写 CDP 客户端 → bringToFront → scrollIntoView → 接受「点击不可用」的结论 → 让浏览器自己写盘）。在环境正常时应该是 1 步（`browser-use.cmd < 脚本`）。

---

## 6. 建议（给 Lead / 沙箱侧）

1. **先修 C-1**：这是本轮最大的可用性/安全问题。若确认是 `failClosed=1` + overlay/registry 状态损坏导致的全局拒绝，则「沙箱一坏就把用户的 shell 变成只读」这个失败模式需要在协议里明确（现在是静默的：`read` 正常，只有写失败，很容易被误读为权限问题）。
2. **候选面补一条「浏览器/harness 外写」提示**：`C:\eprof`（824 文件）、`~\.config\browser-harness\` 全都不进候选；至少把这两个根列进 review 的 outside 类别。
3. **给 harness 加降级路径**：端点目录不可写 → 无 daemon 直连；`BU_HOME`/`BH_RUNTIME_DIR`（`paths.py` 已支持）应在文档里作为「沙箱内把状态目录放到可写位置」的官方解法出现。
4. **`--doctor` 改为行为式判定**（真连一次 CDP + 真 evaluate）。
5. **BR-02/BR-03/BR-11 的 checkpoint 文本按 §4 修正**。

---

## 7. 遗留物（测试在真实磁盘/会话状态里留下的东西）

| 遗留物 | 位置 | 状态 |
|---|---|---|
| 自建 CDP 驱动与探针 | `_sandbox-tests\r2\browser\code\{smoke,cdp_probe,cdp_probe2..6,cdp_close}.py` | 保留（证据/可复现） |
| 下载证据（浏览器直写真盘） | `_sandbox-tests\r2\browser\evidence\downloads\{br04-example.png,typescript-5.6.3.tgz,typescript-packument.json,README.txt}` | 保留（本域核心证据） |
| `C:\eprof` | 60 顶层项 / 824 文件 | **保留**：自动化 profile 未删除（下一轮 boot 会复用；删除需 shim 写权限，本会话无法安全清理） |
| `%USERPROFILE%\.config\browser-harness\` | `runtime\bu-wstage.{pid,port}`、`bu-default.spawnlock`、`tmp\bu-*.log` | 保留（真实磁盘；`bu-default.pid/.port` 在 20:15 已不存在） |
| 候选面污染 | `.dshstage\…\candidates\cs_0074…cs_0111`、`review.json` 中 `probe2` / `direct1` 条目 | **已知且已尽量回收**：`staged\probe2.txt` 已删除、overlay 里的 `staged\fs\C\Windows\Temp\direct1.txt` 已删除（passthrough 删除成功）；候选 JSON 是快照文件，我没有删除（协议禁止动 `.dshstage` 状态文件）——**请 FS 域/Lead 知悉这两条是我造成的测试遗留**。 |
| 失败的空文件 | 无 | 所有被拒的 `Set-Content`（`t1/t2/t3/ps-roundtrip/dotnet/escape/pyescape/final/after-close.txt`）均未产生文件（写被拒时不落盘，已用 `cmd dir` 复核 evidence 目录只有 downloads 一项） |
| 残留进程 | 3 个 msedge（PID 1480/6032/11588，20:20:36 起，`MainWindowHandle=0`，**不属于** C:\eprof，最近 4 分钟未触碰 eprof） | 未清理：`taskkill` 被拒；`Stop-Process` 杀掉后同秒复活，判断为 GUI 侧 Edge 的常驻进程，不再触碰。CDP 9222 已关闭（`curl` exit 7）。python/daemon 残留 = 0。 |
| 暂存树 | 未被占用 | 全程 31 条命令无 EBUSY 复发；最后一条 PS/CMD 读正常 |

---

## 8. 复现命令（最小集）

```powershell
# 0) 冷态确认（本会话后半段 Get-CimInstance 不可用，退化用 Get-Process）
Get-Process msedge,python -ErrorAction SilentlyContinue | Select Id,ProcessName,StartTime

# 1) 入口（本会话必然失败，这是 C-1 的直接证据）
cmd /c "C:\Users\Administrator\.local\bin\browser-use.cmd --doctor 2>&1"
$env:PYTHONIOENCODING='utf-8:replace'
cmd /c "C:\Users\Administrator\.local\bin\browser-use.cmd < C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser\code\smoke.py 2>&1"

# 2) 写拒绝（C-1）
try { Set-Content -LiteralPath "C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser\evidence\t1.txt" -Value x -ErrorAction Stop; "OK" } catch { $_.Exception.Message }
try { Set-Content -LiteralPath "$env:WINSTAGE_STAGE_ROOT\ok.txt" -Value x -ErrorAction Stop; "OK(passthrough)" } catch { $_.Exception.Message }

# 3) 直连 CDP 跑完 BR-03..BR-09（绕过 daemon；浏览器由 preflight 拉起）
& "C:\Users\Administrator\AppData\Roaming\uv\tools\browser-use\Scripts\python.exe" `
  "C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser\code\cdp_probe.py"
& "C:\Users\Administrator\AppData\Roaming\uv\tools\browser-use\Scripts\python.exe" `
  "C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser\code\cdp_probe5.py"   # 点击静默失效（C-4）

# 4) 收尾
& "C:\Users\Administrator\AppData\Roaming\uv\tools\browser-use\Scripts\python.exe" `
  "C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\browser\code\cdp_close.py"
curl.exe -s --max-time 4 http://127.0.0.1:9222/json/version   # 期望 exit 7
```
