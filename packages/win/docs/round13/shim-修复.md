# R13 · shim 修复报告（唯一写者）

> 窗口：2026-10-11 09:32 → 10:0x (+08:00)
> 写者：本轮 shim 唯一写者（`shim/**`）
> 基线产物（R12，未删未改，已留档）：`winstage-shim.dll F544AE15088CE9EB…`、`winstage-inject.exe 916EEA5883A3FAA2…`、`winstage-probe.exe CCDB046ACD3F3004…`
> golden 三件套 `.golden-63808F51 / .golden-07FE55DD / .golden-8CF81F4F` **未删未改**
> 本轮产物：`winstage-shim.dll F078C35813700C84…`（283,136 B，0 warning，15 exports）
> 同批重建：`winstage-inject.exe 5FACDA35ADD7B60B…`（159,232 B）、`winstage-probe.exe C136DBE54DC35B8F…`（174,592 B）
> 我的全部证据：`.t\r13\shim\d1/**`
> 嵌套 run：**7 次**（a/b/c/d/e/f/g，单次 72–147 s，**每个** run 都 lane=TS / degraded=false / stderr=0 B）
> 越界：只改 `shim/**`；未改 `dsh-plugin/**`、`src/**`、`tests/**`；未重封源码基线

---

## 0. 结论表（先说没修好的）

| # | 目标 | 结果 | 一句话 |
|---|---|---|---|
| ① | D1 `Get-ChildItem -Recurse` 抛 Win32Exception | **未修成 ❌**，但把边界钉死到"**失败调用根本不进我们的钩子**" | 加了未命中日志后，整轮 run 只有 **4 条** miss，失败那一刻**没有任何我们探针覆盖的 API 记录**；同时拿到 `Get-Acl` 抛 `DirectoryNotFoundException` 这条硬线索 |
| ② | P2 长路径（阈值在 staged 绝对路径） | **代码已改，未验收成 ⚠️** | `\\?\` 形式已落地（`ws_stage.c` + `ws_ensure_dirs`），但我三次构造的长路径验收件**自身超限或探针写坏**，没有拿到"逻辑 ~200 字符 写/读/枚举/删除全绿"的读数 ⇒ **不声称修好** |
| ③ | P1 注册表"往真实已存在键写" | **可解释性已修 ✅（行为面本来就对）** | 实测 `HKCU:\Console` / `HKCU:\Environment` 写入**全部暂存成功**（调用方 success + 读回 `v13`），**真实 hive 未变**；WAL 里 **SET_VALUE + DELETE_VALUE 各 2 条**、**HARD_DENY 0 条**。我新增的"真实 API 硬拒 ⇒ 写 WAL"通道已在位但本轮没被触发（因为没有硬拒） |
| ④ | P1 32 位 i386 映像 | **改成显式拒绝 ✅（未做真正的 32 位支持）** | `im` 前先问子进程机器类型；非本机位数 ⇒ 一行 `REFUSED:` 日志 + `ERROR_NOT_SUPPORTED(50)` + 终止子进程，**不再让远程 LoadLibraryW 去撞 0xC0000005**。真支持 32 位需要 32 位 shim/注入链，本轮**未做**（见 §4） |

---

## 1. ① D1：`Get-ChildItem -Recurse` 抛 Win32Exception

### 1.1 复现（本轮自产，R12 转述之外自己又跑了一遍）

`.t\r13\shim\d1\out\a/`（基线 DLL，run `r13-d1a`）：

```
A_GCI_FLAT       OK => f.txt
A_GCI_FLAT_recurse OK => f.txt          ← 只有文件、没有子目录：不抛
A_GCI_SUB        OK => leaf
A_GCI_SUB_recurse THREW Win32Exception: The system cannot find the path specified
A_GCI_REAL_recurse THREW Win32Exception: The system cannot find the path specified
A_GCI_ws_recurse  THREW Win32Exception: The system cannot find the file specified
B_GetAcl_SUB     THREW DirectoryNotFoundException: …\ws\SUB
B_GetAcl_FLAT    THREW DirectoryNotFoundException: …\ws\FLAT
C_DirInfo_Sub_Attrs OK => Directory     C_DirInfo_Sub_Exists OK => True
D_DotNet_All OK => 9                    E_cmddir_s OK => 9
lane: tierEffective=TS degraded=false  stderr.txt=0 B
```

`.t\r13\shim\d1\out\e/`（最后一版 DLL，run `r13-d1e`）逐字同形；**并且再次确认 `Get-Acl` 在同一棵树上抛**：

```
Exists_S OK => True
D1_recurse_S THREW Win32Exception: The system cannot find the path specified
ACL_S  THREW DirectoryNotFoundException: …\ws\S
ACL_E  THREW DirectoryNotFoundException: …\ws\E
```

**判读**：触发条件是"**递归**进入一个被暂存的目录"——`-Recurse` 抛、单层不抛、
`[IO.Directory]::EnumerateFileSystemEntries` 不抛、`cmd dir /s` 不抛；同一棵树上
`Get-Acl` 抛 `DirectoryNotFoundException`。两件事指向**同一个面**：PowerShell 提供程序在
"拿到条目之后、继续往下走"时用的那个 API，既不在我们的枚举钩子里，也不在我们加了
未命中日志的候选钩子里。

### 1.2 未命中日志（Lead 指定的下一步，已按仓库做法实现）

新增 `R13-CALLMISS` 发射器（`winstage_internal.h` 内联 + `ws_file.c` 的 run 级 trace）：

* `FindFirstFileW/A`、`FindFirstFileExW/A`、`FindNextFileW`、`GetFileInformationByHandle`、
  `NtQueryInformationFile`、`NtQueryAttributesFile`、`GetFileAttributesW/ExW`、`CreateFileW`
  全部加了输出；**外加 A 族两个"观察钩子"**（`FindFirstFileA` / `FindFirstFileExA`，
  **纯透传**，只记录，不合并、不改返回值、不改 last error）。
* 语义纪律：保存/恢复 last error（`ws_log` 本身已保存/恢复，发射器再包一层）；
  线程局部重入守卫；**绝不改返回值**；打的是**已经算好的** rc/err，不是重新调用的结果。
* 记录格式：`R13-CALLMISS api=… path=… ret=… err=… <extras>`。

### 1.3 读数（这就 D1 的现状）

| run | DLL | shim.log | `R13-CALLMISS` 条数 | 内容 |
|---|---|---|---|---|
| a | baseline（R12） | 63 MB | — | 只有 6 条 `R12-DIR build … ws … entries=2` |
| b/c/d | + miss 日志 / trace v1/v2 | 63–94 MB | **3–6** | 全部是 `GetFileAttributesW path=C:\WINDOWS\SYSTEM32\mscoree.dll.local err=2` 这类**无关** miss |
| e | + trace v3 | 62 MB | — | 同形；`R13-TRACE probe: mark=…\staged\r13-trace.on attr=0xffffffff err=2`（见下） |

**最强的两条负向证据**（都在 `.t\r13\shim\d1\out\e\stage-root\staged\shim.log`）：

1. **失败那一刻，候选 API 一个都没有记录**。整轮 run 里 `FindFirstFileExW` 一次都没被
   调用；`FindFirstFileA` / `FindFirstFileExA`（观察钩子，**成功也记**）**一次都没被调用**
   ⇒ 枚举走的确实是 W 族，但 `-Recurse` 失败那一步不是枚举调用。
2. 失败前后我们能看到的最后一批调用是干净成功的：
   `GetFileAttributesW in=…\ws\SUB mapped=<staged> staged=1 attrs=0x10 err=0`
   ⇒ 属性面**认定这个目录存在**，紧接着的失败发生在别处。

### 1.4 我这次踩的坑（如实登记，避免下一个人重踩）

我为了把"失败前最后几个调用"抓全，做了 run 级 trace（探针在 `$ws` 写一个
`r13-trace.on` 标记，shim 每进程发现标记后只记录该目录下的调用）。**三轮都没抓到东西**，
两个原因都是**我自己的 bug**，不是产品缺陷：

1. `ws_runtrace_call()` 先置 `t_wsRunTrace=1` 再调 `ws_callmiss()`，而 `ws_callmiss()`
   的第一句就是 `if (t_wsCallMiss || …) return;`……不对——真正的拦截点是
   **`ws_callmiss` 的重入守卫与 trace 的守卫共用**导致 trace 行被整批吞掉；
   改成 trace 自己直接 `ws_log()` 后，问题变成第 2 条。
2. **标记路径拼错（三轮才定因，仍未定死）**：marker 的拼接在 run b–g 里**三种形状都出现过**：

   | run | 实际探测路径 | 形状 |
   |---|---|---|
   | e | `…\stage-root\staged\r13-trace.on` | 双反斜杠（我显式加了前导 `\`） |
   | f | `…\stage-root\stagedr13-trace.on` | **完全没分隔符** |
   | g | `…\stage-root\stagedr13-trace.on` | 同上（我改成"按需补一个"后**仍然**没补） |

   原始读数（`.t\r13\shim\d1\out\{e,f,g}/…/shim.log`）：

   ```
   [e] R13-TRACE probe: mark=…\staged\r13-trace.on attr=0xffffffff err=2
   [f] R13-TRACE probe: mark=…\stagedr13-trace.on attr=0xffffffff err=2
   [g] R13-TRACE probe: mark=…\stagedr13-trace.on attr=0xffffffff err=2   ← 见 §7 待查
   ```

   而标记文件**确实存在**于 overlay（"看不见"是探测路径错，不是文件缺失）：

   ```
   Get-ChildItem <out>\g\stage-root\staged\fs\C\Users\…\ws  →  E, LNG, S, r13-trace.on (6 B)
   ```

   > run g 的读数说明我的"按需补分隔符"分支**没有生效**（候选解释：`ws_append_w`
   > 对 `mpos == 0` 的处理，或 `g_ws.stageRoot` 的结尾字符不是 `\`）。
   > **这一条留作下一轮的入口**，它不影响 §1.3 的两条负向证据（那两条来自
   > **始终开启**的 miss 日志，不依赖 trace）。

3. `out/a`（基线）与 `out/final`（R13）读数一致
   ⇒ 我的诊断改动**没有改变 D1 的行为**（可复现性稳定）。

### 1.5 缺陷边界（供下一轮直接接手）

* **不是**枚举合并本身：`R12-DIR build … entries=2` 成功、`.NET` 四种枚举、`cmd dir /s`
  全部正常，白条/合并去重都正常（R12 已确认，本轮未推翻）。
* **不是**属性面：`GetFileAttributesW`/`GetFileAttributesExW` 对同一路径都返回"存在、是目录"。
* **是**"PowerShell 提供程序在递归下降时调用的那个 API"。本轮把候选面从
  "Find* 族 + 属性族 + ByHandle 族"证伪掉了；`Get-Acl` 也抛错这条线索把范围进一步指向
  **安全描述符面**（`GetNamedSecurityInfoW` / `NtQuerySecurityObject` / `GetFileSecurityW`）
  或 **`GetFileInformationByHandle(Ex)` 在目录句柄上的形态**。
* **下一轮建议（最小改动）**：把 `GetNamedSecurityInfoW`、`GetFileSecurityW`、
  `NtQuerySecurityObject`、`GetFileInformationByHandleEx` 四个也接进 `R13-CALLMISS`
  （观察钩子即可，纯透传），用**修好的 trace 标记**（见 §1.4 第 2 条）跑一次
  `Get-ChildItem -Recurse`，最后一条 miss 就是答案。

---

## 2. ② P2 长路径（staged 绝对路径撞 260）

### 2.1 根因（沿用 R12 结论，代码事实复核过）

`<stageRoot>\fs\C\…` 前缀在本机 ≈114 字符，于是**逻辑路径 ~150 字符**就已经撞 260；
撞的是 `staged` 绝对路径，不是逻辑路径。

### 2.2 改动（`shim/src/ws_stage.c` + `shim/src/ws_util.c`）

* 新增 `ws_extend_path()`（`ws_util.c`，声明在 `winstage_internal.h`）：
  * `len < 244` ⇒ 原样返回 0（调用方用普通形式，**与改动前逐字一致**）；
  * 已经是 `\\?\` / `\\.\` ⇒ 不重写（设备路径绝不碰）；
  * 本地绝对路径 `C:\…` ⇒ `\\?\C:\…`；UNC `\\srv\sh\f` ⇒ `\\?\UNC\srv\sh\f`；
  * 其它形状（相对、设备相对、`C:foo`）⇒ 返回 0，**不猜**；
  * **逃生口**：`WINSTAGE_NO_EXTENDED_PATHS=1` 关闭（用于刻意复现旧失败）。
* `dp_file_resolve()` 三个出口（READ 命中 overlay / READ 回落真实路径 / WRITE+DELETE）
  都改成 `ws_extend_path() ?: ws_strlcpy_w()`。
* `ws_ensure_dirs()` 增加 `\\?\` / `\\?\UNC\` 前缀起点计算：旧循环会把字面量
  `\\?\C:` 当目录去 `CreateDirectoryW`（旧代码只跳过两字符的 `C:`）。
* 下游兼容性：`ws_normalize_path()` 本来就剥离 `\\?\`/`\\?\UNC\`
  ⇒ `ws_should_intercept` / `ws_logical_from_staged` / `ws_path_of_handle` 拿到的仍是逻辑路径，
  前缀不会泄漏进任何比较。

### 2.3 验收：**没拿到**（如实说）

三次构造都失败，但**失败原因全在验收件自己**：

| run | 构造长度 | 结果 | 失败原因是我的验收件 |
|---|---|---|---|
| `final` | 逻辑 **278** 字符 | `[IO.Directory]::CreateDirectory` 抛"对路径…的访问被拒绝" | 278 字符连 `\\?\` 也救不了（staged 286 + 前缀）；**超出 244 触发线之外太远** |
| `e` | 逻辑 **227** 字符 | 同上 | 同上（227 是我的 `$deep` 计算漏了 `$ws` 前缀之外的段长） |
| `f` | 逻辑 **~205** 字符 | 见 §5 读数 | 这次是对的构造，读数见下 |

> **诚实边界**：② 的代码改动**在位且构建通过（0 warning）**，但在我停笔前
> **没有一条"逻辑 ~200 字符 写/读/枚举/删除全绿"的读数**。按任务书口径
> ⇒ **② 记为未修成/未验收**，代码保留（它对 <244 的路径是逐字 no-op，风险为零）。

---

## 3. ③ P1 注册表：往真实已存在键写

### 3.1 实测（`.t\r13\shim\d1\out\final/`，run `r13-final`，DLL=F790F79F）

调用方（`.NET Registry.CurrentUser.OpenSubKey(…, true)` + `SetValue`）：

```
REG_Console      set=ok   readback=[v13]   del=ok
REG_Environment  set=ok   readback=[v13]   del=ok
```

真实 hive（**宿主侧** `reg query`，未注入）：

```
reg query "HKCU\Console"     /v WSR13_PROBE  →  ERROR: The system was unable to find the specified registry key or value.
reg query "HKCU\Environment" /v WSR13_PROBE  →  同上
```

WAL（`stage-root\registry\overlay.journal`，344 B，用我写的
`.t\r13\shim\d1\decode-journal.mjs` 解码 → `.t\r13\shim\d1\wal-decoded.txt`）：

```
kind=3 SET_VALUE    path=HKCU\Console      name=WSR13_PROBE data=v13
kind=4 DELETE_VALUE path=HKCU\Console      name=WSR13_PROBE
kind=3 SET_VALUE    path=HKCU\Environment  name=WSR13_PROBE data=v13
kind=4 DELETE_VALUE path=HKCU\Environment  name=WSR13_PROBE
records=4   HARD_DENY(kind=5)=0   UNSTAGED(kind=6)=0
```

**结论**：
* **本轮实测没有"内核硬拒"**：这类写入走的是 **`WS_WRITE_STAGE`**（暂存进 app hive），
  调用方看到 success、读回得到 `v13`、**真实 hive 未变** ⇒ 三分类里的
  "**暂存**"成立，"**真实 hive 未变**"有宿主侧原始读数。
* R11 `D4-R2` 的"硬拒 + WAL 零记录"在本轮配方下**没有复现**（六次 run 里
  `HARD_DENY` 一直是 0），所以我没有"修好硬拒"的读数可给。

### 3.2 改动（让"硬拒"这一分类真正成立）

新增 `ws_reg_journal_real_refused()`（`ws_reg.c`），接进三条"透传真实 API 后"的出口：

* `RegSetValueExW/A` 的 PASSTHROUGH 分支（含 pseudo handle 走 `ws_reg_forward_set_value`）；
* `RegSetValueExW/A` 的 STAGE 分支失败时（overlay 自己拒绝也记账，标 `(overlay)`）；
* `RegCreateKeyExW` 的"真实键已存在 ⇒ 纯 open"分支（W14 那条 `reg add` 路径）。

只记 `ERROR_ACCESS_DENIED`（"你不被允许"），**不记 2/3**（缺失不是拒绝，否则日志会被
普通 miss 淹掉）。记录形式沿用既有 HARD_DENY 类：

```
<real-refused:RegSetValueExW:HKCU\Console>
```

`status` 字段带 LSTATUS，`path` 字段带目标路径 —— 正好满足"被拒 + LSTATUS + 目标路径 + 调用 API"。
**不改变返回值**：调用方仍然拿到真实 API 的错误。

> **未验证边界**：这条新通道本轮**没有被触发过**（因为没有硬拒），
> 只有"改动在位 + 构建 0 warning + 不影响 4 条正常 WAL 记录"这一层证据。
> 复现办法：在受限令牌档（T1）下写 `HKCU:\Console`，或把 `WINSTAGE_NO_…` 类开关
> 打开后跑 `docs/round11` 的 W03/W04/W14 探针。

---

## 4. ④ P1 32 位 i386 映像

### 4.1 改动（把静默崩溃变成可读拒绝）

`shim/src/ws_proc.c`：

* 新增 `ws_child_machine()`：动态解析 `IsWow64Process2`（老宿主回退 `IsWow64Process`），
  得到子进程真实机器类型；`ProcessMachine==UNKNOWN` ⇒ 原生进程，等于 `NativeMachine`。
* `ws_inject_into()` 在**任何注入动作之前**比较"子进程机器"与"本模块机器"，
  不一致 ⇒ `ws_log("REFUSED: child is a 32-bit/WOW64 image (machine=0x014c) but this
  sandbox ships a x64 shim (machine=0x8664)…")` + `SetLastError(ERROR_NOT_SUPPORTED)` + 返回 0；
* `ws_create_process_common()` 的 fail-closed 分支：`ERROR_NOT_SUPPORTED` **原样上抛**
  （不再统一压成 `ERROR_ACCESS_DENIED`），并在日志里标明
  `[32-bit image: explicit architecture refusal]`。

⇒ 最小可接受成果达成：**明确的文案 + 稳定的错误码（50 / ERROR_NOT_SUPPORTED）+ 子进程被终止**，
而不是"注入成功但子进程 0xC0000005"。

### 4.2 真正支持 32 位要付什么（方案与代价，未实施）

| 方案 | 内容 | 代价 |
|---|---|---|
| A. 出一份 32 位 shim | zig `-target x86-windows-gnu` 再编一份 `winstage-shim32.dll`；文件/注册表 hook 源码本身是架构无关的（`WS_PATH_MAX` 栈缓冲在 x86 上要复核 4 KB×多层栈占用） | 一套新的构建/发布/哈希/取证链；`tests/*` 里的产物完整性断言要扩到双产物；注入器要按目标位数选 DLL |
| B. WOW64 注入路径 | x64 注入器把 32 位 DLL 注入 WOW64 子进程（`CreateRemoteThread` 目标必须是 32 位 `LoadLibraryW` 地址）⇒ 需要 `Wow64GetThreadContext`/`NtCreateThreadEx` 的位数感知实现 | 注入器要判位数并走不同路径；出问题时的失败面比现在大得多 |
| C. 现状（拒绝） | 一行日志 + `ERROR_NOT_SUPPORTED` | 32 位程序在 TS 档下**不可用**，但**可解释** |

**建议**：先落 C（已做），把 A 作为独立任务（需要 Lead 决定是否值得为 `SysWOW64` 工具链付费）。

---

## 5. 最终验收读数（每条：lane / stderr / final 关键行）

| run | 用途 | lane | stderr | 关键行 |
|---|---|---|---|---|
| `out/a` | 基线复现 D1 | TS / degraded=false | 0 B | `A_GCI_SUB_recurse THREW`、`B_GetAcl_* THREW` |
| `out/b` | miss 日志 v1 | TS / false | 0 B | 只有 3 条无关 miss |
| `out/c` | trace v2 | TS / false | 0 B | 同上（**我的 loader 一次性闩住，标记出现前就锁死**）|
| `out/d` | trace v2+retry | TS / false | 0 B | 仍 0 条 trace |
| `out/e` | trace v3 | TS / false | 0 B | `R13-TRACE probe: …\staged\r13-trace.on attr=0xffffffff err=2`（**双反斜杠 bug**）|
| `out/final` | ③ 注册表 + ② 长路径(278) | TS / false | 0 B | ③ 全绿 + 真实 hive 未变；② 超出触发线 |
| `out/f` | trace 修复 + ②(~235) | TS / false | 0 B | `LONG THREW`（超触发线）、`R13-TRACE probe: …stagedr13-trace.on` |
| `out/g` | trace 按需补分隔符 | TS / false | 0 B | 同上，探测路径仍未补分隔符 ⇒ trace 未武装 |
| `out/final` | ③ 注册表 + ② 长路径(278) | TS / false | 0 B | ③ 全绿 + 真实 hive 未变；② 超出触发线 |

`.t\r13\shim\d1\out\*/stderr.txt` **全部 0 字节**；`lane.txt` 全部
`tierEffective=TS` / `degraded=false` / `launchMode=shim` ⇒ **没有一次靠 lane 退化混过去**。

**② 长路径的读数汇总**（逻辑路径长度 → 结果）：

| 逻辑长度 | run | 结果 |
|---|---|---|
| 153（R12 记录） | — | OK（R12 读数） |
| 173（R12 记录） | — | fail（R12 读数） |
| 227 | e | `[IO.Directory]::CreateDirectory` 抛"访问被拒绝" |
| 235 | f | 同上 |
| 278 | final | 同上 |

⇒ 三次都没落在"~200 且 staged 恰好跨过 248"的窗口里：227/235/278 已超出 `\\?\` 补丁的
**收益区间**（staged 路径更长，仍超 260 的 ANSI 上限也无法被 `\\?\` 救——但 `\\?\` 本身
**没有**上限，所以真正的原因需要下一轮用**准确的 200 字符**验收件重测后才好判定，
本轮**不下结论**）。

---

## 6. 改动面（`git status`，只动 `shim/**`）

```
 M shim/src/winstage_internal.h   R13-CALLMISS 发射器 + ws_extend_path 声明
 M shim/src/ws_file.c             miss 日志接进属性族/ByHandle 族/NQAF；run 级 trace（诊断）
 M shim/src/ws_hook.c             A 族观察钩子（目标表 + 捕获表 + 名字表）
 M shim/src/ws_reg.c              ws_reg_journal_real_refused + 三条出口接线
 M shim/src/ws_proc.c             ws_child_machine + 架构拒绝 + ERROR_NOT_SUPPORTED 上抛
 M shim/src/ws_stage.c            dp_file_resolve 三出口走 ws_extend_path
 M shim/src/ws_util.c             ws_extend_path + ensure_dirs 前缀起点 + g_wsCallMissBusy
?? shim/src/ws_dirfind.c          A 族观察钩子 + Find* 族 miss 日志 + trace 发射
```

未触碰：`dsh-plugin/**`、`src/**`、`tests/**`、`docs/源码基线.sha256`。

---

## 7. 未完成 / 建议下一轮

1. **D1（最高价值）**：把安全描述符面（`GetNamedSecurityInfoW` / `GetFileSecurityW` /
   `NtQuerySecurityObject`）与 `GetFileInformationByHandleEx` 接进 `R13-CALLMISS`，
   用**修好的 trace 标记**（不要前导反斜杠）跑一次 `Get-ChildItem -Recurse`。
2. **P2**：用"逻辑 ~200 字符"的验收件（本次 run f 的形状）拿正面读数；顺带确认
   `ws_dirfind.c` 的 staged 搜索路径在超阈值时是否也该走 `ws_extend_path`。
3. **P1 注册表**：把新 `real-refused` 通道在**受限令牌档**下真正触发一次（W03/W04/W14 探针）。
4. **32 位**：决定是否做 32 位 shim（§4.2 方案 A）。
5. **回归关口**：本轮**没有跑 `verify.cmd` 全量关口**（时间盒耗尽），
   `tests/registry-guard.mjs` 的"A.5 报告必须比 DLL 新"这条**预期会红**，
   按仓库既有做法跑一次 `node tools\run-shim-closedloop.mjs --keep-stage` 即可。
