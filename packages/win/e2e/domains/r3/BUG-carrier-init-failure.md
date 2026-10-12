# BUG-carrier-init-failure —— shim 载体进程初始化失败导致整条车道静默降级

调查者：专项调查者 F ｜ 日期：本轮 ｜ 未改动任何源码/profile
证据源：`ws\.t\dsh2\logs\winstage-diag.jsonl`（190 行 / 190 可解析）、`shim\out\triage-report.json`、
`docs\T6-门禁收敛与载体完整性报告.md`、`src\executor.mjs`、`shim\src\*.c`、`dsh-plugin\shell-executor.mjs`；
本轮新建的实证脚本与原始输出见 `$STAGE\_r3\`（`scan-out.txt` `timeline.txt` `interleave.txt` `raw.txt` `clobber.txt`）。

---

## 0. 完整原文（那条被截断的 reason，逐字节还原）

日志第 7 行，`at=2026-10-04T15:00:26.894Z`，`lanes.fallbackReason` 全长 **347** 字符。
`jsonl` 里是转义形式（`\r\n` 为字面两字符），真实字符串为：

```
transparent shim unavailable (injector exit=4294901760 (111=injection failure) report.ok=true The shell cannot be started. A failure occurred during initialization:
Could not load file or assembly 'System.Data.dll' or one of its dependencies. An internal error occurred. (Exception from HRESUL) — fail-closed fallback to the restricted-token mode
```

**这条 reason 里融合了三个不同来源的文本，必须拆开读**：

| 片段 | 来源 | 证据 |
|---|---|---|
| `transparent shim unavailable (` … `)` | `selectLaunchMode()` 模板 | `src\executor.mjs:4692`：`` `transparent shim unavailable (${probe?.reason ?? 'not probed'}) — fail-closed …` `` |
| `injector exit=4294901760 (111=injection failure) report.ok=true` … | 探测的 `shim-inject-canary` check detail | `src\executor.mjs:4444`：`` `injector exit=${canaryRun.code} (111=injection failure) report.ok=${injectReport?.ok ?? 'n/a'} ${String(injectReport?.error ?? canaryRun.err).slice(0, 200)}` `` |
| `— fail-closed fallback to the restricted-token mode` | `selectLaunchMode()` 模板 | 同上 `:4692` |

**截断原因已确证**：`:4444` 的 `.slice(0, 200)`。实测该 reason 中 `report.ok=true ` 之后的载荷恰好 **202** 字符 = 200（切片）+ `' '`（`.slice(0,200)` 与 `—` 之间的连接空格）+ 0，因此 `(Exception from HRESULT: 0x8007054F)` 被切成 `(Exception from HRESUL`。
⇒ **不是日志写入截断，是 `:4444` 的 200 字符切片**。这是纯粹的诊断保真度缺陷：截掉的正是最关键的 HRESULT。

计数（本轮统计）：`4294901760` 记录 **16** 条，**distinct reason 字符串 = 1**，区间 `15:00:26.894Z` – `15:03:34.620Z`，与你给的时间线一致。

---

## 1. `exit=4294901760` 是什么 / 为何 `report.ok=true` 与它同时出现

### 1.1 `4294901760` 的归属（确证）

`4294901760 = 0xFFFF0000`。它**不是**注入器的错误码（注入器自己的失败码是 `111`，`src\executor.mjs:3862` `SHIM_INJECT_FAILURE_EXIT = 111`；`shim\injector\winstage-inject.c:478` `return INJECT_FAILED`）。

**它是被注入的 PowerShell 子进程自己的退出码，被注入器原样透传。** 证据：

* `shim\injector\winstage-inject.c:491-492`
  `GetExitCodeProcess(pi.hProcess, &childExit); rc = (int)childExit;`
  → 成功注入后 `winstage-inject.exe` 的进程退出码 = 子进程退出码。
* 同一函数 `:498-504` 在**同一分支**里写报告：
  `{"ok":true,…,"childPid":…,"childExitCode":…,"remoteModule":"0x…"}`
  → `report.ok` 只表示"注入成功"，**与子进程是否活着毫无关系**。

`0xFFFF0000` 的语义有仓库内独立旁证：`shim\out\triage-report.json` 里 `config=B-reg-off/C-file-off, target=powershell` 的 `exitCode` 正是 `4294901760`，`stderr` 正是 `The shell cannot be started … System.Data.dll`；即 PowerShell 在 shell 初始化阶段自行退出 `0xFFFF0000`。

### 1.2 归类路径（确证）

```
probeTransparentShimUncached()                       src\executor.mjs:4281
  └─ runCapturedToFiles(injectorPath, […, canaryTarget, '-NoLogo','-NonInteractive','-NoProfile', …])
                                                     src\executor.mjs:4415-4433
       └─ canaryRun.code === 4294901760              ← 注入器透传子进程退出码
  └─ injectReport = JSON.parse(reportPath) ; ok=true   src\executor.mjs:4436
  └─ injectionOk = code===0 && ok!==false && code!==111   src\executor.mjs:4440   →  false
  └─ record('shim-inject-canary', false, `injector exit=… report.ok=… …`)  :4441-4445
  └─ available = checks.every(ok) = false ; reason = 该 check 的 detail  :4468-4469
selectLaunchMode('auto', {available:false, reason})   src\executor.mjs:4682-4693
  └─ mode='restricted-token', tierEffective='T1',
     fallbackReason = `transparent shim unavailable (${reason}) — fail-closed …`
```

**"注入器自身成功但目标进程启动失败"这条路径根本没有被单独归类**：唯一的判据是 `canaryRun.code === 0`（`:4440`）。因为注入器把子进程退出码当自己的退出码（`:492`），任何"注入成功但子进程起不来"都会走进 `injectionOk = false`，被和"注入失败"混成同一个 `shim-inject-canary` fail。`111` 那个特判（`:4440` 尾项、`:4540`）其实是**冗余且误导**的：`code === 0` 已经蕴含 `code !== 111`。

**`report.ok=true` 与 `exit=4294901760` 同时出现的完整解释**：两者描述的是**两个不同进程**。`ok=true` 是注入器关于**自己**远程 `LoadLibraryW` 结果的报告（`:499`）；`4294901760` 是**子进程** PowerShell 的退出码，被注入器借去当了自己的退出码（`:492`）。日志把二者并列却不标注归属，因此读起来像自相矛盾，实际不是。

> 顺带修正一处行号：任务书给的"`:2985` `SHIM_INJECT_FAILURE_EXIT=111`"和"`:3526/:3631/:3666` 解析段"在当前工作树上已位移。实测：`SHIM_INJECT_FAILURE_EXIT` 在 **`:3862`**；`report.ok/exit` 的解析与归类在 **`:4434-4445`**；抛 `TS_INJECTION_FAILED` 在 **`:4540-4545`**；`selectLaunchMode` 在 **`:4682-4696`**（任务书说 `:3805-3816`，那里现在是 `canonicalDir`/`sameDir`）。

---

## 2. 是哪个程序集 / 载体是不是 `powershell.exe`

### 2.1 程序集（确证）

`System.Data.dll`。HRESULT 被 `:4444` 的 200 字符切片吃掉，但完整值可从仓库内独立证据补回：
`_sandbox-tests\sensitive\evidence\env-gate.txt:16-18` 记录了**同一句话的完整形态**：

```
"The shell cannot be started. A failure occurred during initialization: Could not load file or
 assembly 'System.Data.dll' or one of its dependencies. An internal error occurred.
 (Exception from HRESULT: 0x8007054F)"   [exit code 4294901760]
```

⇒ `0x8007054F` = `ERROR_INTERNAL_ERROR`（Win32 1295）被 CLR 包成 HRESULT。

**注意 `System.Data.dll` 是误导性的**：这句话是 PowerShell **`InitialSessionState` 类型初始化器**失败时的统一外壳，`System.Data.dll` 只是**第一个被反射探测**的程序集，不是故障组件。（`docs\T6-…md:282-283` 把同一签名与 `0x800700b7` 并列，属同一外壳的两种内层码。）

### 2.2 载体（确证 = `powershell.exe`）

`src\executor.mjs:4410-4431` 写死了金丝雀载体：

```js
canaryTarget = resolveExecutable('powershell', { env: shimEnv, cwd: stageRoot })   // :4410
canaryRun = runCapturedToFiles(artifacts.injectorPath,
  ['--dll', artifacts.dllPath, '--report', reportPath, '--',
   canaryTarget, '-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass',
   '-File', canaryScriptPath], …)                                                  // :4415-4433
```

⇒ 载体是 **`powershell.exe`，参数 `-NoLogo -NonInteractive -NoProfile -ExecutionPolicy Bypass -File <canary>`**，`resolveExecutable('powershell')` 失败时回退字面量 `'powershell.exe'`（`:4411-4413`）。你的猜测正确。这也解释了为什么 `triage-report.json` 里同一个 shim 对 `target=cmd` 全绿、对 `target=powershell` 才红。

---

## 3. 为什么是间歇的（三个候选线，逐条判定）

先给出排除性事实，它把问题空间砍掉一大半。

### 3.1 排除性证据：失败与成功**同秒交错**（确证）

按分钟统计（本轮重算，与你的一致，另有 15:00 的 `shim|OK:7` 与 `restricted-token|CARRIER-INIT:7`）：

```
2026-10-04T15:00  {"shim|OK":7,  "restricted-token|CARRIER-INIT":7}
2026-10-04T15:01  {"shim|OK":21, "restricted-token|CARRIER-INIT":4}
2026-10-04T15:02  {"shim|OK":19, "restricted-token|CARRIER-INIT":4}
2026-10-04T15:03  {"shim|OK":15, "restricted-token|CARRIER-INIT":1}
2026-10-04T15:04 起 {"restricted-token|ARTIFACT-NOTFOUND": …}   ← 另一独立原因，全灭
```

更关键的是**毫秒级交错**（`$STAGE\_r3\interleave.txt`）：

```
15:01:31.636  97132a99  shim              ok
15:01:32.875  16192a87  restricted-token  CARRIER-INIT     (间隔 1239 ms)
15:01:50.291  16192a87  restricted-token  CARRIER-INIT
15:01:51.847  73feedf7  shim              ok                (间隔 1556 ms)
15:02:04.248  73feedf7  shim              ok
15:02:04.906  16192a87  restricted-token  CARRIER-INIT     (间隔  658 ms)
15:02:04.906  16192a87  restricted-token  CARRIER-INIT
15:02:06.294  d6e30323  shim              ok                (间隔 1388 ms)
```

**同一台机器、同一秒内**既有 shim 成功又有 CLR 失败 ⇒ **任何"全局环境/令牌/策略"解释都不成立**（全局状态不会在 700 ms 内翻转）。同一个 session 内也交替（flips：`16192a87`=6、`d6e30323`=5、`97132a99`=4）。
并且 15:04 之后**零** carrier-init——同一环境、同一 shim，说明失败是**每次子进程启动独立掷骰**。

### 3.2 ① Low IL / 受限令牌下 CLR 初始化 —— **判定：不成立（已排除）**

shim 车道上**根本没有受限令牌、没有 Low IL**，所以谈不上"CLR 在降权环境下初始化失败"。
证据：`src\executor.mjs:3840-3841` 注释与 `initTransparent()` 实现（`:1978-2060`）明确"以**普通令牌 + 正常完整性**启动（不 `CreateRestrictedToken`、不加 Low IL 标签）"；`:1974-1975`"不调用 `AclSandbox.init()` ⇒ 没有 `CreateRestrictedToken`、没有 Low IL 标签"。
`shim\src\ws_entry.c` 只在 `:32` 用 `OpenProcessToken(TOKEN_QUERY)` **读** SID（`ws_compute_user_sid`，只读），`:56-80` `ws_prepare_stage_root()` 只建目录；**全程没有任何降权/改完整性级别的调用**。
⇒ 载体进程是**普通令牌 + 正常 IL**。失败与降权顺序无关。

### 3.3 ② mitigation / Job（默认 `none` 是否真的 `none`）—— **判定：`none` 属实，且 Job 在此路径不存在**

* `mitigationProfile` 默认 `'none'`：`src\executor.mjs:1529` `this.mitigationProfileRequested = options.mitigationProfile ?? 'none'`；`:1442`、`src\capability.mjs:1091` 同。`:1520` 注释："`mitigationProfile` 默认 `'none'`：**刻意不用**"。
* `src\capability.mjs:1019-1102`：默认档为 `none`（`noop:true`），baseline/hardened/untrusted 必须显式点名；真正注入只发生在 `src\appcontainer-runtime.mjs`（T0 路径）。**shim 路径不注入任何 mitigation。**
* Job：`src\executor.mjs:4484-4487` 明确"这里的子进程**不在 Job Object 里**"、"不建 Job Object ⇒ `terminate()` 用 `taskkill /T /F`"；`:2058` `treeReclaim: 'taskkill /T /F (transparent mode has no Job Object)'`。

⇒ mitigation/Job 维度**恒为常量**，无法产生间歇性。**不成立。**

### 3.4 ③ 并发/竞态 —— **判定：成立，且不是"并发起命令"造成的**

先说排除：`dsh-plugin\shell-executor.mjs:1195` 每条命令 `new WindowsStageExecutor(opts)`，`:1232` `await executor.init()`，即**每条命令各自 init 一次**；`probeTransparentShim()` 有**进程内缓存**（`src\executor.mjs:4235` `transparentProbeCache`，键含三个产物的 `size@mtime` + stageRoot + captureDir，`:4237-4259`）。
这一点很重要，且**改变了修复设计**：缓存是**宿主进程级**的，所以

* 同一个宿主进程内：一次金丝雀失败 ⇒ **该判定被缓存**，后续命令**不再重试**，直接被钉死在 `restricted-token`；
* 但 `shell-executor.mjs:1195` 每条命令新建执行器——若宿主为每个命令起独立进程，则每条命令**重新掷骰**。

这与观测到的形状**完全吻合**：长时间的连续 `restricted-token`（`16192a87` 尾部连续 27 次）与短促的交替（`97132a99` 有 4 次翻转、`d6e30323` 有 5 次）共存。⇒ **"静默降级一旦发生就粘住"是缓存造成的，而"是否发生"是子进程内竞态造成的。**

再给根因：**CLR 启动期的线程 LastError 踩踏竞态（确证机制 + 实证）**。

机制链（`shim\src\ws_util.c:23-69`）：`ws_log()` 里唯一的一次文件操作是

```c
h = g_orig.CreateFileW(g_ws.logPath, FILE_APPEND_DATA, FILE_SHARE_READ|FILE_SHARE_WRITE,
                       NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);   // ws_util.c:56-62
```

`OPEN_ALWAYS` + 日志文件**已存在** ⇒ `GetLastError()` 变成 `ERROR_ALREADY_EXISTS`(183)。而 `ws_log` **从不保存/恢复调用线程的 last error**。

本轮**实测复现**（`$STAGE\_r3\clobber.ps1` → `clobber.txt`，受限车道内 `powershell -NoProfile -File`）：

```
probe path exists at start: False
first  (file did NOT exist) : after ws_log-like open lastError=0
second (file now exists)    : after ws_log-like open lastError=183
third  (file now exists)    : after ws_log-like open lastError=183
```

`183 = 0xB7`，正是 `docs\T6-…md:262` 记录的 CLR 内层码 `0x800700b7`。**"第一次不踩、之后每次都踩"**就是间歇性的来源。

谁在踩（按风险排序，均为**确证**——这些文件里没有任何 `GetLastError/SetLastError` 保护）：

| 站点 | 代码 | 判定 |
|---|---|---|
| `shim\src\ws_proc.c:211-224` | 注入失败/成功后 `ws_log(...)`（`:216`、`:229`），**无保存恢复**；`:235` 还硬 `SetLastError(0)` | 每次 `CreateProcess*` 后踩 |
| `shim\src\ws_t3reg.c:302-303` | `ws_open_file_raw(journalPath, GENERIC_WRITE\|GENERIC_READ, …, OPEN_ALWAYS)` 打开 journal；`:347-351` 之后 `ws_log(...)`（`:348`）**无保存恢复**，直接 `return ERROR_SUCCESS` | 每次注册表覆盖层 attach/写 journal 后踩。`:335` 的 `ws_log` 同理 |
| `shim\src\ws_reg.c:48` | `#define WS_TRACE(...) do { if (g_ws.verbose) ws_log(...); } while (0)` —— **verbose-gated，生产不开** | 生产路径**不踩**（判定：注册表钩子族在本次事故中不是元凶） |
| `shim\src\ws_file.c:216-217` | `ws_log_w` + `WS_TRACE_FILE` 之后**紧跟** `SetLastError(ERROR_ACCESS_DENIED)`（`:218`） | 被自己的 SetLastError 覆盖 ⇒ 安全 |
| `shim\src\ws_file.c:225-227` | 真调用**之前**的 trace | 安全（调用者的错误由真调用决定） |
| `shim\src\ws_file.c:262-264`、`:305-307` | **有** `GetLastError`/`SetLastError` 保护 | 已修（`docs\T6` §7.1 只修了这里） |

**这解释了为什么 `docs\T6` §7.1 声称"已修复"却仍在发生**：修复只落在 `ws_file.c` 的两个站点，而 §7.1 结尾的待办正是"同一模式在 `ws_reg.c`、`ws_hook.c`、`ws_t3reg.c` 也存在……**本轮未做**"。事故 survivor 就是这些**未修站点**（尤其 `ws_t3reg.c` 的 `OPEN_ALWAYS` journal 打开 + `ws_log`，以及 `ws_proc.c` 的子进程注入日志）。

**为什么 PowerShell 特别倒霉**：`InitialSessionState` 类型初始化器在启动期频繁走注册表（证书库 `HKCU\Software\Microsoft\SystemCertificates\…`，`shim\src\ws_reg.c:1042-1047` 的注释专门讨论过这条路径），每次覆盖层交互都可能触发 `ws_t3reg.c` 的 journal 写 + `ws_log`；而 CLR 的 `LoadLibrary`/绑定路径会读 `GetLastError()` 来判定失败原因。两者一撞 ⇒ 与 `ws_file.c:200-201` 注释描述的同一类故障（".NET reads files with OPEN_ALWAYS during startup"）但发生在 registry/journal 侧。

> `shim\src\ws_file.c:10` 的头注释其实已经点出这条通用规则（"…or `ws_log()` ->"），但没有把它变成 `ws_log` 自身的义务——这是修复应该走的方向。

---

## 4. 为什么失败会"静默"（分类缺陷）

### 4.1 归一化（确证）

`src\executor.mjs:4682-4696` `selectLaunchMode()`：

```js
if (want === TRANSPARENT_TIER || want === 'AUTO') {
  if (probe?.available === true) return { mode:'shim', … }
  return { mode:'restricted-token', tierEffective:'T1',
           fallbackReason: `transparent shim unavailable (${probe?.reason ?? 'not probed'}) — fail-closed fallback to the restricted-token mode` }
}
```

**任何** `probe.available !== true` 都塌进**同一条** fail-closed 回退，`fallbackReason` 只承载一个自由文本串。因此：
"注入器产物被删"（15:04 的 `not found: …\winstage-inject.exe`）、"载体 CLR 起不来"（15:00–15:03）、"ABI 不匹配"、"金丝雀能力不足"在**结构上完全同型**——下游只能靠正则猜。

### 4.2 `classifyLaneFallback` 在这条 reason 上落到了哪里（**实测**，非推演）

`dsh-plugin\shell-executor.mjs:150-172`。本轮**真正 import 该模块并喂入日志里的原始字符串**（`$STAGE\_r3\classify.mjs` → `classify.txt`），结果如下（三个用例都是实测）：

```
=== CARRIER-INIT (this bug, live raw) ===        input len=347
code = "probe-failed"
text = "探测未通过（金丝雀能力 / selftest / ABI 不匹配）"

=== ARTIFACT-NOTFOUND (15:04 live raw) ===       input len=216
code = "artifact-missing"
text = "shim 产物缺失或不完整（DLL / winstage-inject.exe / winstage-probe.exe）"

=== probe reason only (剥掉 selectLaunchMode 外壳) ===   input len=264
code = "unclassified"
text = "未归类的回退原因：injector exit=4294901760 … (Exception from HRESUL"
```

逐条 regex 归因（同一脚本实测）：

```
artifact-missing -> no match
acl-denied       -> no match
env-missing      -> no match
token-restricted -> no match
probe-failed     -> MATCH "unavailable" at 17        ← 唯一命中项
indexOf("acl")        = -1
indexOf("denied")     = -1
indexOf("cannot create") = -1
indexOf("cannot write")  = -1
indexOf("failure")    = 70   context="(111=injection failure) report.ok=t"
indexOf("failed")     = -1
indexOf("cannot be started") = 104
```

**判定（确证）**：`carrier-init` 被归成 **`probe-failed`**，文案是"探测未通过（金丝雀能力 / selftest / ABI 不匹配）"——**把"载体进程 CLR 起不来"误导成"金丝雀能力/ABI 不匹配"，排查方向被引偏**。

**更要紧的结构性发现（确证）**：命中 `probe-failed` 的是 **`unavailable`**，而这个词来自 **`selectLaunchMode()` 自己的外壳文本** `transparent shim unavailable (`（`:4692`）——**不是来自任何真实原因**。
把外壳剥掉后（第三个用例），**同一条 reason 立刻退化成 `unclassified`**，因为：

* `failed` 在文中 **不存在**（`indexOf("failed") = -1`）；
* 文中只有 `failure`（`(111=injection failure)`、`A failure occurred`），而 `probe-failed` 的 pattern 写的是 `failed`（`:166`）；
* `acl-denied` 的 `/acl|denied/` 也**都不匹配**（`indexOf` 均为 `-1`）。

⇒ **分类结果是"外壳措辞的函数"，而不是"真实原因的函数"**：`transparent shim unavailable` 这句话的措辞一旦改动（或 reason 以另一种拼装顺序出现），同一个缺陷就会从 `probe-failed` 直接掉到 `unclassified`。
**这比"分类错误"更严重：分类器对本条 reason 是不可靠的**，而 `:145` 的注释还宣称"无法归类 ⇒ `unclassified` 并原样透出 `raw`（绝不吞掉原因）"——它确实没吞，但它**给了一个错误的 code**。

> 我此前按肉眼推演曾猜 `acl-denied`（以为 `System.Data.dll` 里含 `acl`、或 `cannot be started` 命中 `cannot create`）——**实测证伪**：两者都不匹配。这也从侧面证明：**靠读正则判断归类结果本身就不可靠**，故本轮改为直接执行真函数取证。

### 4.3 分类改进建议（reason 匹配规则）

**先说结论：只加正则不够。** 实测已证明命中项是外壳词 `unavailable`（§4.2），所以**必须双向修**：

**(a) 结构优先（首选，治本）** —— 在 `src\executor.mjs:4440-4445` 让失败 detail **携带机器可读前缀**，分类器先读前缀、正则只兜底：

```js
// src\executor.mjs:4440 附近，拆开"注入器健康"与"载体存活"
const injectorHealthy = injectReport?.ok === true
const childStarted    = canaryRun.code === 0
const carrierInitFailed = injectorHealthy && !childStarted
// 让 fallbackReason 从这个前缀开始，而不是从"transparent shim unavailable"开始
//   例如 probe.reason = `carrier-init-failed: injectorOk=true childExit=0xFFFF0000 …`
```

**(b) 正则兜底** —— 在 `dsh-plugin\shell-executor.mjs:150-172` 的**最前面**插入新 code，**且必须先于 `probe-failed`**（因为 `probe-failed` 的 `unavailable` 会抢走外壳文本）：

```js
hit('carrier-init-failed',
    '载体进程初始化失败（注入成功但子进程 CLR/.NET 启动期退出；不是能力/ABI 问题）',
    /injector exit=(0x)?ffff0000|4294901760|the shell cannot be started|could not load file or assembly|exception from hresult|0x8007054f|0x800700b7|0xe0434352|status_dll_init_failed|0xc0000142/) ??
```

**(c) 顺手收紧两条规则的假阳性面**（本条虽未误判，但 15:04 的 `not found` 与 `System.Data.dll` 共享 `dll` 字样，边界很薄）：

```js
// 只认"路径缺件"，不认消息正文里的 dll 字样
hit('artifact-missing', '…', /not found:|no such file|enoent|incomplete|artifacts missing/) ??
// 只认真正的拒绝访问；去掉裸 'denied' 与裸 'acl'
hit('acl-denied', '…', /access is denied|eperm|eacces|privilege not held|cannot create|cannot write|dacl/) ??
```

**(d) 把 `failed` 的脆弱性去掉**：`:166` 用 `failed` 作 pattern，但真实文本里是 `failure`（实测 `indexOf("failed") = -1`）。若保留 `probe-failed` 兜底，至少应改成 `/fail(ed|ure)/`，否则剥掉外壳后同一条 reason 会掉进 `unclassified`。

**(e) 建议补的离线断言**（`dsh-plugin` 自测，纯函数、不需要真进程）：
喂入本条 347 字符原始串，断言 `classifyLaneFallback(...).code === 'carrier-init-failed'`；
再喂入**剥掉外壳**的 264 字符串，断言**仍然**是 `carrier-init-failed`（这一条专治上面 (d) 的退化）。

**`4600f176` 这类 reason 的归属**：`4600f176` 是 32 位十六进制、看起来像 commit 短哈希；**它不在本条 reason 中**（本轮对 347 字符原文做过 `indexOf` 全量检查，未出现该串）。若它指 `0xFFFF0000` 类退出码，按 (b) 会落到新增的 `carrier-init-failed`；若它指任何**未被上述 pattern 覆盖**的措辞，则仍会落到 `probe-failed`/`unclassified`——**这正是必须做 (a) 而不是继续堆正则的理由**。

---

## 5. 可落地的缓解/修复（候选排序：收益/风险/工作量）

### C1（首选）载体存活判定与产物完整性判定**解耦** — S

* **改动点**：`src\executor.mjs:4440`。当前
  `const injectionOk = canaryRun.code === 0 && injectReport?.ok !== false && canaryRun.code !== SHIM_INJECT_FAILURE_EXIT`
  把"注入器是否健康"与"子进程是否活着"混在一个布尔里（因为 `winstage-inject.c:492` 透传子进程码）。
  改为三步独立判定：
  1. `injectorRan = injectReport?.ok === true`（注入器自身健康，`:499` 的 `ok` 字段）；
  2. `childStarted = canaryRun.code === 0`（载体可用）；
  3. 探针通过与否仍由 `canaryJudge`（`:4455`）决定。
  并把 `record('shim-inject-canary', …)` 的 detail 拆成 `injector=ok child=0xFFFF0000`，附加机器可读前缀。
* **预期效果**：日志与 `fallbackReason` 立刻可区分"注入器坏"与"载体起不来"，**不再需要正则猜**；不改任何安全语义（仍然 fail-closed，仍然回退 `restricted-token`）。
* **风险**：极低。纯诊断/分类改动，`available` 的取值集合不变（`injectionOk` 仍须为真才能 `available`）。**唯一风险**是若有人依赖旧 detail 字符串做断言——`tools\carrier-flake.mjs` 与自测需一并核对。
* **本机受限车道测法**：`node autotest.mjs --only <shim/ts 相关 suite>`；再用 `$STAGE\_r3\classify.mjs` 喂入本条 reason，断言返回 `carrier-init-failed` 而**不是** `acl-denied`。
* **工作量**：S（~10 行 + 一个离线分类断言）。

### C2 载体失败"有限重试 + 连续失败才降级" — M

* **改动点**：`src\executor.mjs:4281` `probeTransparentShimUncached()` 的金丝雀段（`:4415-4445`）外包一层重试 `N=3`（建议 3，间隔 0），仅当**全部**失败才认定 `available=false`；`reason` 里带上 `failed=3/3 carrierExitCodes=[0xFFFF0000,…]`。
  并**修正缓存方向**：`transparentProbeCache`（`:4235-4279`）目前连**失败结论**一起缓存（`:4277` 无条件 `set`），导致一次抖动被同一个宿主进程**永久**钉死。改为**只缓存成功**（fail 不写缓存），失败可用 `cache:false` 语义隐式重试。
* **预期效果**：把 15:00–15:03 观测到的 16/74（≈22%）瞬时失败压到 ≈1%（0.22³），且"抖动一次就粘住"消失。
* **风险**：**中**。① 每次重试多一次注入器进程（实测 `docs\T6`/`executor.mjs:4228-4229` 注释称金丝雀约 1~2 s），命令启动延迟增加最多 ~2×N；② 重试会**多跑几次探针脚本**，必须在受限车道确认探针本身无副作用（它只写金丝雀输出文件，应无副作用，但需实测）；③ 若失败是**稳定的**环境问题（例如 15:04 的产物缺件），重试纯属浪费——所以重试必须**只针对 `childStarted=false` 且 `injectorRan=true`**，产物缺件（`:4440` 前的前置 stat 检查）**不重试**。
* **本机受限车道测法**：`node tools\carrier-flake.mjs`（该脚本默认测**生产路径**，`--verbose` 才开 verbose，见 `tools\carrier-flake.mjs:40-42`）；跑 30~50 次统计 `carrier-init` 率，与不重试基线对比。注意其历史基线是 5/96≈4%（verbose 放大），本次生产路径观测是 16/74≈22%，**先复测基线再评效果**。
* **工作量**：M（重试 + 缓存策略 + 其自测）。

### C3 换更稳的载体 / 注入前先做"无 shim 探针" — M~L

* **改动点 A（低成本、已可立即用）**：`src\executor.mjs:4410` 的 `canaryTarget` 从 `powershell` 改为**两级**：先用 `cmd.exe`（`triage-report.json` 显示 `target=cmd` 在**全部四种 config 下都绿**）判定"注入器 + shim 是否健康"，再单独用 `powershell` 判定"PowerShell 载体是否可用"。这样载体 CLR 抖动**不再拖累**对注入器健康度的判断。
* **改动点 B**：在 `:4415` 注入金丝雀**之前**，先跑一次**不注入**的 `powershell -NoProfile -NonInteractive -File <同样脚本>`（`triage-report.json` 的"不注入"基线是 **0/24**）。若"不注入"也失败 ⇒ 判定 `env-not-satisfied`（环境不满足），**不归因于 shim**，也不重试。
* **预期效果**：把"shim 坏了"与"这台机器的 PowerShell 坏了"分开；对 `System.Data.dll` 类失败给出正确归因（"环境不满足"而非"探测失败"）。
* **风险**：**中**。① 多一次子进程 ⇒ 探测更慢（一次 ~1 s）；② 换 `cmd.exe` 当健康探针会**改变能力探针的覆盖面**（cmd 无法证明"四类能力恢复"，`executor.mjs:3844-3855` 的三级探测语义要求 PowerShell/脚本能力），因此**只能把 cmd 探针用于"注入器健康"，不能替代能力探针**，否则等于放宽了 `available` 判据——这是**安全相关**的，必须显式禁止；③ 若"不注入也失败"被误判成"可以放行"，会破坏 fail-closed，故 `env-not-satisfied` **仍必须是 `available=false`**（只是 reason 不同）。
* **本机受限车道测法**：`node -e` 直接跑 `probeTransparentShim({cache:false})` 两次并读 `checks`；对照 `shim\out\triage-report.json` 的 A/B/C/D 四配置矩阵复现方法。
* **工作量**：M（仅 A+归因）/ L（含 B 与完整自测）。

### C4（根因侧，收益最高但风险最高）统一修掉 `ws_log` 的 LastError 踩踏 — M

* **改动点**（**需重编 DLL**，故单列）：三选一，从稳到险：
  1. **在 `ws_log` 内部自保**（`shim\src\ws_util.c:23-69`）：进入时 `DWORD saved = GetLastError();`，`return` 前 `SetLastError(saved);`（含 `:63` 的失败早退分支）。**一处修全部站点**，这是最干净的做法。
  2. 顺带修 `ws_proc.c:235` 与 `:208` 的硬 `SetLastError(0)`（成功路径不该清零调用者的 last error）。
  3. 审计 `ws_t3reg.c:335/348` 等调用后写日志的站点（与 `ws_file.c:262-264` 同型）。
* **预期效果**：直接消灭 `ERROR_ALREADY_EXISTS`(183) 注入，从根上消除 `0x800700b7` / `0xFFFF0000` 类载体启动失败（`docs\T6` §7.1 已在 `ws_file.c` 证明此法有效：修前 3/3 复现，修后 3/3 干净）。
* **风险**：**中高**。① 需要重编 `shim\out\winstage-shim.dll`（`tools\build-shim.mjs`），本机受限车道**能否编译/部署**未验证；② `ws_log` 在 DllMain 早期可能被调用，此时 `SetLastError` 语义弱，可能掩盖真实错误——**必须先证明没有依赖 `ws_log` 之后残留 last error 的代码路径**；③ 改的是与安全边界相关的 DLL，任何回归都可能让 shim 静默失效（`executor.mjs:2005` 明确不设 `WINSTAGE_SHIM_DISABLE`）。
* **本机受限车道测法**：**不要**在受限车道首次验证。先离线复跑 `$STAGE\_r3\clobber.ps1` 确认机制；再在**未受限会话**里 `node tools\build-shim.mjs` + `node tools\carrier-flake.mjs`（生产路径）对比修前/修后失败率；最后用 `node autotest.mjs --only <file/registry 真产物 suite>` 验证 shim 行为未变。
* **工作量**：M（代码 ~5 行）+ **部署/验证成本高**。

### 排序结论

| 序 | 候选 | 消除"静默" | 消除"失败" | 风险 | 工作量 |
|---|---|---|---|---|---|
| 1 | **C1 解耦注入器/载体判定**（+分类规则 `carrier-init-failed`） | **是** | 否 | 极低 | S |
| 2 | **C2 只针对载体失败重试 N=3 + 只缓存成功** | 是 | 大幅降低 | 中 | M |
| 3 | **C3 载体分级探针（cmd 健诊 + 无 shim 基线）** | 是 | 降低/正确归因 | 中 | M–L |
| 4 | C4 统一修 `ws_log` LastError | 否 | **根因消除** | 中高 | M+部署 |

**若只能做一件事：C1。** 它把"静默"这个最危险的属性拿掉，成本最低且不动任何安全判据。
**C4 是唯一的根因修复**，但需要重编/重部署 DLL，应排在 C1/C2 之后作为独立工作项。

---

## 6. 显式区分：确证 vs 推断

### 6.1 确证（有文件/行号或本轮实测）

1. `4294901760 = 0xFFFF0000` 是**被注入子进程 PowerShell** 的退出码，被注入器透传为自身退出码：`winstage-inject.c:491-492`。
2. `report.ok=true` 只表示注入器远程 `LoadLibraryW` 成功，与子进程存活无关：`winstage-inject.c:498-504`。
3. 归类判据是 `canaryRun.code === 0`：`executor.mjs:4440`；`111` 特判冗余。
4. 该 reason 的 200 字符截断来自 `executor.mjs:4444` 的 `.slice(0, 200)`；被截掉的是 `0x8007054F`。完整值见 `env-gate.txt:16-18`。
5. 载体是 `powershell.exe`，参数 `-NoLogo -NonInteractive -NoProfile -ExecutionPolicy Bypass -File <canary>`：`executor.mjs:4410-4433`。
6. 失败记录 16 条、distinct reason 1 条、区间 `15:00:26.894Z`–`15:03:34.620Z`；15:04 起换成 `not found: …\winstage-inject.exe`（25/19/12/… 全灭）。
7. 失败与成功**同秒交错**（最小间隔 658 ms，跨 session）：⇒ 非全局环境原因。
8. shim 车道**无受限令牌、无 Low IL、无 Job**：`executor.mjs:1974-1975, 3840-3841, 4484-4487, 2058`。
9. `mitigationProfile` 默认 `'none'` 且 shim 路径不注入：`executor.mjs:1520, 1529`；`capability.mjs:1091, 1099, 1019-1038`。
10. `ws_log()` 用 `OPEN_ALWAYS` 打开日志：`ws_util.c:56-62`；**本轮实测**该操作把线程 last error 置为 `183`（`clobber.txt`）。
11. `ws_file.c` 有 `GetLastError/SetLastError` 保护（`:262-264, 305-307, 401-403, 451-453, 537-539, 618-620, 735-738, 755-758`），而 `ws_proc.c`、`ws_t3reg.c` **完全没有**；`ws_reg.c` 的 trace 是 verbose-gated（`:48`）。
12. `selectLaunchMode()` 把所有 `available!==true` 归一成同一回退：`executor.mjs:4682-4696`。
13. `classifyLaneFallback()` 的 code 集合里**没有"载体初始化失败"这一类**（六个 code：`none / artifact-missing / acl-denied / env-missing / token-restricted / probe-failed / unclassified`）：`shell-executor.mjs:150-172`。**实测**：本条 347 字符 reason → **`probe-failed`**（"探测未通过（金丝雀能力 / selftest / ABI 不匹配）"）；命中项是**外壳词 `unavailable`**（来自 `selectLaunchMode` 的 `transparent shim unavailable (`），**不是任何真实原因**；剥掉外壳后同一条 reason 退化成 **`unclassified`**，因为文中只有 `failure`、没有 `failed`。`classify.mjs` → `classify.txt`。
14. 探测结论被**进程内缓存**，含失败结论：`executor.mjs:4235-4279`（`:4277` 无条件 `set`）；`shell-executor.mjs:1195, 1232` 每条命令新建执行器并 `init()`。
15. `shim.log` 证明生产环境 `families: file=on reg=on`，且 `traceStagedOps` 默认 1（`ws_util.c:346`），即 `ws_file.c` 的 trace 在**生产**也打。

### 6.2 推断（附可执行验证方法）

| # | 推断 | 验证方法（可执行） |
|---|---|---|
| I1 | `ws_t3reg.c` 的 `OPEN_ALWAYS` journal 打开 + `ws_log`（`:302-303, 348`）是本次事故的**主要**踩踏站点 | 在**未受限**会话里 `WINSTAGE_SHIM_VERBOSE=1` 重跑 `node tools\carrier-flake.mjs`，抓 `shim\out\…\shim.log`：确认失败那次在 `DshRegStageAttach` 之后、CLR 报错之前有 `OPEN_ALWAYS` 日志；或临时给 `ws_t3reg.c` 加保存恢复后对比失败率 |
| I2 | 受害线程是 CLR 启动线程（`_CorExeMain`/绑定路径读 `GetLastError`） | 注入器加 `--no-inject`（`docs\T6` §6 已有该开关）跑同一 PowerShell：若不注入时失败率掉到 `triage-report.json` 的 0/24 水平 ⇒ 证实 shim 侧踩踏 |
| I3 | `System.Data.dll` 只是**第一个**被探测的程序集，非故障组件 | `powershell -NoProfile -Command "[System.Data.DataSet]::new()"` 与 `"...[System.Data.SqlClient.SqlConnection]::new()"` 在不注入环境下均应成功；失败时 `stderr` 应同样报 `Could not load file or assembly 'X'` 而 `X` 随探测顺序变 |
| I4 | 载体抖动率约 22%（16/74）且与 verbose 无关 | `node tools\carrier-flake.mjs`（默认生产路径）跑 50 次；与 `docs\T6` §7.1 的 5/96≈4%（verbose）对比。**先复测基线** |
| I5 | 单条目 union 缓存在 `WS_ENUM_MAX_NAMES=4096` 处截断，可致证书库读空 ⇒ `0xFFFF0000`（**与 I1 竞争同一症状**） | `shim\src\ws_reg.c:1053, 1144, 1167`；用一个子键数 >4096 的真实键（如 `HKLM\SOFTWARE\Classes`）在注入环境下 `RegEnumKeyEx` 计数并与不注入对比；若在第 4096 项截断，则为**第二个**独立载体级缺陷 |
| I6 | `probe.available` 的失败结论被缓存进宿主进程 ⇒ 长期 `restricted-token` | 同一宿主进程内连续两次 `probeTransparentShim({cache:false})` vs 默认（命中缓存）：比较 `checks` 是否重算；观察 `16192a87` 尾部连续 27 次 `restricted-token` |
| I7 | `0xC0000142 (STATUS_DLL_INIT_FAILED)`、`0xE0434352`、`spawn UNKNOWN(127)` 与本条**同源**（shim 在 `DllMain`/CLR 启动期踩踏 last error） | 在 `ws_proc.c`/`ws_t3reg.c` 加保存恢复后重跑，观察这三个码是否一并消失；`0xE0434352` 已在 `env-gate.txt:14` 记为 CLR 异常 |
| I8 | 15:04 起的 `not found: …@local\shim\out\winstage-inject.exe` 是**部署目录产物被删**，与载体失败无因果 | `Test-Path 'C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\home\profiles\dsh2\node_modules\@local\shim\out\winstage-inject.exe'`（现应已恢复/重建）；对比 `shim\out\` 与部署目录的产物 mtime |

### 6.3 本轮未能确证（诚实声明）

* **`classifyLaneFallback` 的具体命中项**：六个 code 里没有 `carrier-init`，故本条 reason 必落 `acl-denied`/`probe-failed`/`unclassified` 之一——但**我不写死是哪一个**，因为逐字节复核时我的肉眼推演两次自相矛盾（`cannot be started` ≠ `cannot create`；`System.Data.dll` 里不存在 `acl`、也不存在 `denied`）。实测输出见 `$STAGE\_r3\classify.txt`。
* **`4600f176` 的指代**：该串**不在**本条 reason 中（对 347 字符原文做过全量 `indexOf`，未出现）；若为 commit 短哈希，本轮未做 git 历史核对。不影响 §1–§5 的任何判定。
* **CLR 读到 `183` 的精确调用点**：`docs\T6:261-262` 称"CLR 启动时正读到这个值，于是报 `Starting the CLR failed with HRESULT 800700b7`"，与本轮实测的 `183` 数值一致，但**"CLR 在哪一行读"未在源码级确认**（CLR 非本仓源码）。
* **`ws_hook.c` 的踩踏站点**：本轮只确认 `ws_reg.c` 的 trace 是 verbose-gated、`ws_file.c` 已修；`ws_hook.c` 的 `ws_log` 站点（`:376, 424, 496, 548, 609`）全部 `g_ws.verbose`-gated，故**生产不踩**，但未逐站点审计是否存在非 gated 的调用后写日志。
* **`ws_log` 的 LastError 踩踏与本次 `System.Data.dll` 失败的因果**：机制已实测、站点已定位（§3.4），但**"哪一个站点在本次 16 次失败中真正扣动扳机"未做单站点隔离实验**（需要重编 DLL 或开 verbose，均超出本轮"不改源码"的授权）。验证方法见 §6.2 的 I1/I2。

---

## 7. 一句话结论

**能在不碰 profile 的前提下缓解**——把 `src\executor.mjs:4440` 的"注入器健康"与"载体存活"解耦、并给 `classifyLaneFallback` 补一个 `carrier-init-failed` 类（C1，约 10 行，纯分类、不改安全判据），就能立刻消掉"静默"；真正的根因（`ws_proc.c`/`ws_t3reg.c` 调用真 API 之后写 `ws_log` 踩掉线程 last error，已实测产生 `183`/`0x800700b7`）需要重编 DLL，属独立工作项。

---

## 附：本轮实证脚本与产物（均在 `$STAGE\_r3\`，未改动任何源码）

| 文件 | 用途 |
|---|---|
| `scan.mjs` → `scan-out.txt` | 日志解析、distinct reason、`4294901760` 全量对象 dump |
| `timeline.mjs` → `timeline.txt` | 按分钟 `launchMode × 分类` 时间线、`workingDirectory` 分布 |
| `interleave.mjs` → `interleave.txt` | 秒级交错证明、per-session lane 翻转计数 |
| `raw.mjs` → `raw.txt` | 完整未截断原文、200 字符切片取证 |
| `clobber.ps1` → `clobber.txt` | **实测** `ws_log` 式 `OPEN_ALWAYS` 把 last error 踩成 `183` |
| `classify.mjs` → `classify.txt` | 把本条 reason 喂给 `classifyLaneFallback` 的实测分类结果 |
