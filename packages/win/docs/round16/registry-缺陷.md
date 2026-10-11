# R16 / D4：注册表修改与隔离 —— 缺陷清单

> 责任：teammate `registry`（task-4）· 2026-10-11 · 装置：`docs\round10\env\scripts\sbx-thread.cmd`（`--profile sbx`，独立进程）
> 主报告：[registry-报告.md](./registry-报告.md) · 原始证据：`.t\r16\registry\**`
> 产品代码**未改一行**（只报告）；`shim/out` golden 三件套未动（`63808F51…`/`07FE55DD…`/`8CF81F4F…`，mtime 2026-10-08/09）。
> 判定标记：`[实测]` = 本轮真跑并留原始读数；`[引用]` = 只读源码/契约。

---

## D4-R16-1 【P0 / 阻断】显式 32 位视图（`KEY_WOW64_32KEY`）的**键创建**被 UNSTAGED 透传 ⇒ 真实 hive 落空壳键

### 现象 [实测]

`winstage`(TS) run 结束后，**真实注册表**多出探针键（宿主侧不受限 pwsh 读得，非沙箱自述）：

| run | 真实 hive 新增（清理前） | 内容 |
|---|---|---|
| `run-w1`（token `1f4f18`） | `HKCU\Software\WinstageR16Probe_1f4f18`、`HKLM\SOFTWARE\WOW6432Node\WinstageR16Probe_1f4f18` | 空壳（子键 `net32`/`reg32`、`netlm32`，**无值**） |
| `run-w2`（token `926116`） | 同上两个 | 同形 |
| `run-w3`（最小复现，token `665a04`） | `HKCU\Software\WinstageR16Probe_665a04`（子键 `shellA1,shellA3,shellB1,shellB3`，无值）、`HKLM\SOFTWARE\WOW6432Node\WinstageR16Probe_665a04`（子键 `shellA2,shellB2`，无值） | **只有 32 位视图用例落真实键；默认/64 位视图用例一个都没有** |

`HKCU\Software` 子键数 `17`（`post-winstage-clean`）→ `19`（w1+w2 之后）→ 清理后回到 `17`。

**泄漏与视图强相关**（w3 三组对照，宿主侧读数 `host\post-w3.json`、`host\leaked-keys-detail-w3.json`）：

| 组 | 用例（每次都新建键） | 真实 hive 是否出现键壳 | 值是否落真实 hive |
|---|---|---|---|
| A1 `.NET CurrentUser Registry32 CreateSubKey`（不写值） | ✅ **出现** | — |
| A2 `.NET LocalMachine Registry32 CreateSubKey`（不写值） | ✅ **出现**（WOW6432Node） | — |
| A3 `reg.exe add /reg:32`（不写值） | ✅ **出现** | — |
| B1 A1 + `SetValue` | ✅ **出现** | ❌ 值在 overlay（`b1-val`） |
| B2 A2 + `SetValue` | ✅ **出现** | ❌ 值在 overlay（`b2-val`） |
| B3 `reg.exe add /reg:32 /v` | ✅ **出现** | ❌ 值在 overlay（`b3-val`） |
| C1 `.NET CurrentUser`（默认视图）+ 值 | ❌ 不出现 | ❌ 值在 overlay |
| C2 `.NET LocalMachine`（默认视图）+ 值 | ❌ 不出现 | ❌ 值在 overlay |
| C3 `reg.exe add`（默认视图）+ 值 | ❌ 不出现 | ❌ 值在 overlay |

⇒ 形态是**「真实 hive 只拿到空键壳、overlay 拿到值」的分叉**：调用方读回成功（overlay），宿主侧真实 hive 被改。

### 三件套证据 [实测]

1. **沙箱内读回**（`run-w1/out/stage-root-…/staged/probe-reg16-out.json`，摘要 `run-w1/summary.json`）：
   `W08`(`Registry32` CU) readback `net32-sz-r16`、`W11`(`Registry32` LM) readback `netlm32-sz-r16`、`W14`(`reg add /reg:32`) 报成功；
   探针自报 `reads=9/9 writes=24/25 stress=100/100`，`ownContaminated=false`。
   WOW64 读面同时取到真视图差异（`RD09`：`/reg:32` → `C:\Program Files (x86)`、91 子键；`/reg:64` → `C:\Program Files`、158 子键）。
2. **真实盘读数（外部不受限 pwsh）**：`host\post-winstage-runs.json`(`RESIDUE-FOUND`, `probeHitCount=4`)、
   `host\post-w3.json`(`RESIDUE-FOUND`, `probeHitCount=3`)、`host\leaked-keys-detail*.json`；清理后 `host\post-winstage-clean.json`/
   `post-w3-clean.json` 均 `verdict=CLEAN`、`HKCU_Software=17`。
3. **同 run 暂存根 overlay 记录**（`host\decode-journal.mjs` 自建解码；w1:w2 `overlay.journal` 18732 B/141 条，w3 2392 B/19 条）：
   w3 逐条（`run-w3/wal-decoded.json`）——
   ```
   #1 UNSTAGED path=HKCU\Software\…665a04\shellA1   （只有 UNSTAGED，没有 CREATE_KEY）
   #2 UNSTAGED path=HKLM\SOFTWARE\…665a04\shellA2
   #3 UNSTAGED path=HKCU\Software\…665a04\shellA3
   #4 SET_VALUE path=HKCU\SOFTWARE\…665a04\shellA3 name= dataBytes=2      ← 值进 overlay
   #5 UNSTAGED path=HKCU\Software\…665a04\shellB1
   #6 SET_VALUE path=HKCU\SOFTWARE\…665a04\shellB1 name=V value="b1-val"  ← 键真建、值入 overlay
   #7 UNSTAGED path=HKLM\SOFTWARE\…665a04\shellB2
   #8 SET_VALUE path=HKLM\SOFTWARE\Wow6432Node\…665a04\shellB2 name=V value="b2-val"
   #9 UNSTAGED path=HKCU\Software\…665a04\shellB3
   #10 SET_VALUE path=HKCU\SOFTWARE\…665a04\shellB3 name=V value="b3-val"
   #11/#12 CREATE_KEY + SET_VALUE …\shellC1   ← 默认视图：两条都是 STAGE
   #13/#14/#15 CREATE_KEY + CREATE_KEY + SET_VALUE …\shellC2（HKLM 默认视图）
   #16/#17 CREATE_KEY + SET_VALUE …\shellC3
   counts={"UNSTAGED":7,"SET_VALUE":7,"CREATE_KEY":4,"DELETE_KEY":1} problems=0
   ```
   注意 32 位视图用例的 `SET_VALUE` 路径是**大写** `HKCU\SOFTWARE`/`SOFTWARE\Wow6432Node` —— 由透传返回的
   **真实句柄**反解出的路径，而创建那一步的路径是原始大小写。这正是"键真建、值被重新解释成 overlay 路径"的指纹。

### 根因 [引用，只读源码，未构建]

`shim/src/ws_reg.c`：

* **创建**：`ws_create_key_inner()`（`ws_reg.c:502`）在 `ws_reg.c:528`
  ```c
  if (!resolvable || ws_reg_wow64_unrepresentable(samDesired)) { … ws_reg_journal_unstaged(L"RegCreateKeyExW", reason, …);
      return g_orig.RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa, phkResult, lpdwDisposition); }
  ```
  第 **550 行**把**原始 `samDesired`**（仍含 `KEY_WOW64_32KEY`）原样交给真实 API。`RegCreateKeyExW` 是
  **创建**语义，键不存在时真实 API 就在被重定向的视图里把键建了出来 —— 这一步没有"纯开"守卫。
  对比：同文件 `ws_create_key_open_only()`（`ws_reg.c:445-479`）**先探测存在性、不存在就 `HARD_DENY`**，
  存在的目的是"绝不创建真实键"；但 528 分支没有复用它。
  `ws_reg_wow64_unrepresentable()`（`ws_reg.c:233-249`）在 64 位进程下对 `KEY_WOW64_32KEY` 返回 1，
  于是三个 32 位视图用例全部走这条透传分支。
* **值**：`RegSetValueExW` 没有视图参数，`ws_set_value_ex_inner()` 在 **`ws_reg.c:881`** 以
  `ws_reg_write_ctx(hKey, NULL, 0, …)` 调用 —— **`samDesired` 硬编码为 0** ⇒ 不再"不可表示" ⇒
  落到 `WS_WRITE_STAGE`（`ws_reg.c:393`）⇒ 值写进 overlay。
  于是透传创建出来的**真实句柄**反解出大写路径，值被 stage 到 overlay：**键在真实盘、值在暂存盘**。

### 最小复现（命令级，≤5 行）

```powershell
# 1) 在 TS 沙箱线程内（64 位 powershell.exe）：
$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
$null=$b.CreateSubKey('Software\WinstageR16Probe_<tok>\shellA1'); $b.Close()   # 不写任何值
# 2) 宿主（不受限 pwsh）读真实盘：
Get-Item 'HKCU:\Software\WinstageR16Probe_<tok>\shellA1'                        # ⇒ 存在（空壳）
node .t\r16\registry\host\decode-journal.mjs <stageRoot>\registry\overlay.journal # ⇒ 该路径只有 UNSTAGED，没有 CREATE_KEY
```
等价一键脚本：`.t\r16\registry\payload\probe-reg16-min.ps1 -Token <tok> -Victim <v32> -Victim64 <v64>`；
run：`.t\r16\registry\run-w3\**`（lane `TS/degraded=false/LANE_OK=true`，`stderr=0B`）。

### 影响

* 直接推翻本域的核心结论"真实注册表零改动"：**任何使用显式 32 位视图写注册表的程序（32 位安装器、
  部分 COM/驱动工具、`reg.exe /reg:32`、`RegistryView.Registry32`）都会在真实 hive 留下键壳**；
* 调用方看到"成功"，审批面板看不到（见 D4-R16-3），宿主审计只有一条 `UNSTAGED`（无 `HARD_DENY`），
  用户无法区分"沙箱策略"与"真的没写"；
* 键壳本身会改变真实 hive 的枚举结果（`HKCU\Software` 计数 17→19），并可能影响后续"键是否存在"的判断。

### 建议修复（diff 级描述，**未实施**）

**首选（最小、可回滚，仅改一个分支）**：把 `ws_reg.c:550` 的直接透传替换为"纯开"守卫，复用同文件既有的
`ws_create_key_open_only()`：

```c
/* ws_reg.c:541-551 —— 现行为 */
UINT16 reason = …; ws_reg_journal_unstaged(L"RegCreateKeyExW", reason, resolvable ? canonical : NULL);
return g_orig.RegCreateKeyExW(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa, phkResult, lpdwDisposition);

/* 建议 */
UINT16 reason = …; ws_reg_journal_unstaged(L"RegCreateKeyExW", reason, resolvable ? canonical : NULL);
return ws_create_key_open_only(hKey, lpSubKey, Reserved, lpClass, dwOptions, samDesired, sa,
                               phkResult, lpdwDisposition, resolvable, hive, canonical);
```

⚠ 两个注意点：
1. `ws_create_key_open_only()` 的存在性探测在 `ws_reg.c:458-459` 把 `samDesired & ~WS_SAM_WOW64_MASK`
   **剥掉了 WOW64 掩码** —— 对"32 位视图"这条路径必须**保留原始 `samDesired`**（否则会去 64 位视图探测、
   误判"不存在"而拒绝一个本该放行的纯开）。要么给该函数加一个 `int keepWow64View` 形参，要么在调用点
   用 `g_orig.RegOpenKeyExW(hKey, lpSubKey, 0, KEY_READ | (samDesired & WS_SAM_WOW64_MASK), &probe)` 先探测。
2. 语义取舍：修后"32 位视图下新建键"会变成 `ERROR_ACCESS_DENIED`（fail-closed），这是**有意**的
   —— 契约宁可拒绝也不能静默改真实盘；若要更友好，可额外写一条 `HARD_DENY`（reason=`wow64-32key`）让面板可见。

**次选（约束更强）**：在 `ws_reg_write_ctx()` 之外再引入一条"创建类 API 不得透传"的编译期/运行期不变式
（`ws_create_key*` 一族禁止调用 `g_orig.RegCreateKeyExW`，只允许 `RegOpenKeyExW`），并补一条
`tests/registry-unstaged-wow64.mjs` 风格的用例：**透传分支后真实 hive 的键集合必须逐字节不变**。

---

## D4-R16-2 【P0 / 阻断】同族：显式 32 位视图的**删除**会真删真实键

### 现象 [实测]

run-w3 的 D1：沙箱内 `reg.exe delete "HKCU\Software\WinstageR16Probe_7a5342" /reg:32 /f`
（该键由**宿主在 run 之前用不受限 pwsh 真实创建**，含值 `Pre=1`）：
沙箱内报 `exit=0`；run 结束后宿主侧审计 **该真实键消失**（`host\post-w3.json`：`HKCU:\Software\WinstageR16Probe_7a5342` 不在命中列表）。
对照组 D2：默认视图删除 `…_bbea2c`（同形预建）⇒ **真实键仍在、值 `Pre=1` 完好**（staged `DELETE_KEY`）。

### 根因 [引用]

`shim/src/ws_reg.c:1430-1450` `ws_delete_key_inner()`：`WS_WRITE_PASSTHROUGH` 分支直接
```c
return g_orig.RegDeleteKeyExW(root, ws_reg_rel_of(hive, canonical), samDesired, 0);   /* 1448 */
return g_orig.RegDeleteKeyExW(hKey, lpSubKey, samDesired, 0);                           /* 1450 */
```
保留 `samDesired`（含 `KEY_WOW64_32KEY`）⇒ 真实 API 在 32 位视图里**真的把键删掉**。
与 D4-R16-1 同一根因族（"通不过 overlay 就透传"没有对**有真实副作用**的 API 分类）。

### 最小复现（命令级）

```powershell
# 宿主（不受限）：先真实建一个键
New-Item 'HKCU:\Software\WinstageR16Probe_<v>' -Force; New-ItemProperty 'HKCU:\Software\WinstageR16Probe_<v>' -Name Pre -Value 1
# TS 沙箱线程内：
reg.exe delete "HKCU\Software\WinstageR16Probe_<v>" /reg:32 /f      # exit=0
# 宿主复核：
Test-Path 'HKCU:\Software\WinstageR16Probe_<v>'                      # ⇒ False（被真删）
```
证据：`run-w3/wal-decoded.json` `#18 UNSTAGED path=HKCU\Software\WinstageR16Probe_7a5342`、`#19 DELETE_KEY path=…bbea2c`。

### 影响

比 D4-R16-1 更重：**静默销毁真实数据**。任何"清理旧版本键"的 32 位安装器在沙箱里跑，都会真的删掉宿主注册表键。

### 建议修复

同 D4-R16-1 的纪律：删除类 API 的 `PASSTHROUGH` 只在"键**确实存在于该视图**"时允许，
且必须落一条可归因记录；对"32 位视图删除"这条路径，最小修法是**不保留 `KEY_WOW64_32KEY`**（或直接
`HARD_DENY` + reason=`wow64-32key`），因为 overlay 无法表达 32 位视图的删除语义。

---

## D4-R16-3 【P0 / 高】注册表写入**完全不产生审批候选**（`registry-stage` 候选缺失 + `host-capture.json` 缺失）

### 现象 [实测]

run-w1/w2/w3 的暂存根里：

| 产物 | R16 读数 | R11（上一轮同域） |
|---|---|---|
| `candidates\*.json` | **只有 1 个**，`source="shell"`（9 个文件候选） | 2 个：`shell` + **`registry-stage`**（keys=2/values=0） |
| `registry\host-capture.json` | **不存在** | 存在：`{"bytes":12312,"records":2,"enqueued":true,"candidateId":"cs_0002_…”}` |
| `queue.json` | `order=[cs_0001_…]`，只有 shell 候选 | 含注册表候选 |
| journal | 141 条（w1/w2）、19 条（w3），`HARD_DENY=0` | 126 条 |

⇒ 即使按 R11 的悲观结论"只有键没有值"，R16 golden 也更差：**连键候选都没有**。
用户批准"全部"时，注册表这次运行的所有改动（含真实键壳）**一条都不会被应用，也一条都看不到**。

### 代码指针 [引用]

* 接线存在：`dsh-plugin/shell-executor.mjs:1870` 在每次命令后调用
  `captureRegistryChanges({ sessionDir: workspace.store?.dir, … })`；
  被调方 `dsh-plugin/registry-capture.mjs:144`：
  * `:156` `no-session-dir`、`:158` `no-wal`、`:166` `no-wal-records`、`:170` `no-new-records` —— 这四条
    **早退不打任何日志**；
  * `:187 stage-construct-failed` / `:197 freeze-failed` 会 `logError`（"注册表捕获失败 —— …"）；
  * `:210-217` 只有走到末尾才 `writeMarker()` 写 `host-capture.json`。
* 本轮证据：`host-capture.json` **不存在** ⇒ 一次都没有走到 `:210`；而 run 目录下（`audit.jsonl`、
  `sandbox-audit.json`、`review.json`、`manifest.json`、`stdout.ndjson`、staged/shim.log）**搜不到**
  `注册表捕获失败`/`注册表候选已冻结`/`no-wal` 任何字符串（`grep` 全目录 0 命中）。

### 未定死的一步（如实标注）

早退到底落在 `no-wal`（`workspace.store?.dir` 与 overlay 实际所在根不一致）还是
`stage-construct-failed`/`freeze-failed`（日志被吞），本轮**未能区分**：这两条路径在 headless 下不可观测
（`stderr.txt=0B`）。判别方法（下一轮可直接跑）：
```powershell
# 在 shell executor 调用点前后各打一次：store.dir 是否等于 stage-root-path.txt，journal 是否在该目录
Get-Content <out>\stage-root-path.txt
Test-Path <store.dir>\registry\overlay.journal
```
或直接把 `registry-capture.mjs` 的四条早退分支改成 `logError` 后再跑一次同型 run（**需 Lead 放行改源码**）。

### 影响

注册表暂存链路的**审批面整条断掉**（比 R11 的 `values=0` 更彻底）。这是本域的核心交付物失效，
且与 D4-R16-1 叠加后形成"真实键壳已落盘、面板却显示什么都没发生"的最坏组合。

### 建议修复（未实施）

1. 四条早退分支补 `logError`（含 `sessionDir` 与 `journalPath` 实参），让 headless 也能归因；
2. 在 `captureRegistryChanges` 入口断言 `sessionDir === <overlay 实际根>`（或直接由执行器把
   `registryStageDir`（`shell-executor.mjs:1620`）传进来，而不是 `workspace.store?.dir`），消除"两个根"的可能；
3. 修复 D4-R16-1/D4-R16-2 之后，补一条端到端门禁：**TS run 的命令写注册表 ⇒ `queue.json` 必须出现
   `source=registry-stage` 候选**，否则视为回归。

---

## D4-R16-4 【P1 / 中】子进程 `reg.exe` 写入的值在**本进程内读不回**（新进程可见）

### 现象 [实测]

w1/w2 每条 channel 的即时读回（同一条 `powershell.exe` 进程内 `Get-Item … .GetValue()`）：

| 通道 | 写通道 | 进程内读回 | 跨进程（`reg.exe query`） | journal |
|---|---|---|---|---|
| `W12` `reg.exe add` HKCU | **子进程** | `null` | `XP03 rc=0` 读到 `rex-sz-r16` | `SET_VALUE …\regexe R1` ✅ |
| `W13` `reg.exe add /reg:64` | 子进程 | `null` | ✅ | ✅ |
| `W15` `reg.exe add` HKLM | 子进程 | `null` | `XP09 rc=0` ✅ | ✅ |
| `W17` `reg import`（staged CWD） | 子进程 | `null` | `XP08 rc=0` ✅ | ✅ |
| `W23` `reg.exe add` 已存在 Run 键 | 子进程 | `null` | `XP13 rc=0` ✅ | ✅ |
| `W02/W03/W06/W08/W18/W21/W22` `.NET/PS/COM` | **本进程** | ✅ 读到值 | ✅ | ✅ |

w3 同形：`B3`（`reg.exe add /reg:32 /v`）进程内 `<novalue>`，而 `B3` 的值确实在 overlay（journal `#10`）。
⇒ **"写者进程内看不见刚写的值"**，读回 `null` 而不是报错，容易被误读成"写失败"。

### 根因判断 [实测+引用]

符合 R11 已记的机制（`registry-capture.mjs` 头注释 §②、R11 D4-R5）：子进程 attach 时因
`ERROR_SHARING_VIOLATION` 退回逐进程 `overlay.<pid>.hive`，跨进程可见性靠 attach 时
`t3_replay_journal` 重放；**已经 attach 的父进程不会在一次子进程写之后重放**，所以父进程视图不更新。
w1 暂存根里能看到 `overlay.11912.hive`（子进程 pid 命名的覆盖层）即此形态。

### 影响

agent 在**同一进程**里"写完立刻读"会读到 `null`；若它基于这个读数决策，会得出"写没生效"的错误结论。
R11 把"跨进程读回"记为可用（靠重放兜住），本轮**修正为**："跨进程（新进程）可用；**同进程内不刷新**"。

### 建议修复（未提供实现）

值写完成后（或 `RegQueryValueEx` 未命中时）按 journal 增量重放一次，或让 `RegQueryValueEx` 在
"句柄属于本 run 的 overlay 但视图未刷新"时触发一次 replay。

---

## D4-R16-5 【P2 / 低】`reg import` 只在 **TEMP 路径**失败；同一个 `.reg` 从 **staged CWD** 导入成功

### 现象 [实测]

* `W16`：`.reg` 写在 `$env:TEMP`（= `%LOCALAPPDATA%\Temp\dsh-stage-temp\<guid>\`，暂存映射路径）⇒
  ```
  reg.exe : ERROR: Error opening the file. There may be a disk or file system error.
  file=…\dsh-stage-temp\ae62835a-…\r16-1f4f18-imp.reg bytes=232 hex=fffe570069006e00 exit=1
  ```
  （w1 与 w2 各一次，**100% 复现**；R11 D4-R4 同形）
* `W17`：同一个探针把 `.reg` 写到**staged 树的 CWD**（`<stageRoot>\staged\r16-…-imp2.reg`）⇒ `exit=0`，
  journal `CREATE_KEY …\imp2` + `SET_VALUE … name=IV2 value="imp2-sz-r16"`，跨进程 `XP08 rc=0` 读到值。

⇒ 结论细化：**不是"`reg import` 在沙箱里不可用"，而是"暂存映射出来的 TEMP 路径对 `reg.exe` 不可读"**；
把 `.reg` 放在暂存树工作目录里就能用。错误文案（"disk or file system error"）不具自救性。

### 建议修复

`shell-executor` 侧给子进程的 TEMP 换成**暂存树内**的目录，或在 `reg import` 失败时把
"文件路径是否位于暂存映射面"写进错误提示。

---

## 观察（非缺陷，供下轮）

* **O1** `sbx-thread.cmd:81` 用 `%RANDOM%%RANDOM%%RANDOM%` 生成暂存根叶子：同一秒内启动的两个 `cmd.exe`
  会拿到**相同**的 `RANDOM` 序列 ⇒ 两个 run 的 `stage-root-27328109214908` 叶子完全同名（本轮 w1/w2 实测）。
  因为各自 `<outDir>` 不同，实际路径不同、不冲突；但"唯一根"这一说法**只在 outDir 不同时成立**。
  真正依赖唯一性时应改用 `%RANDOM%` + pid/时间戳。
* **O2** 沙箱内 `$env:WINSTAGE_STAGE_ROOT` 指向 `…\stage-root-…\staged`（不是 overlay 所在的根），
  所以"在沙箱里读 WAL 尺寸"的探针会读到空目录（本轮 `walPreSorted=[]`）。取证应以**宿主侧解码**为准。
* **O3** 沙箱内探针身份为 `WIN-DV9KRECLBVS\Administrator`、`hasRestrictedSid=false`、`hasAdminsSid=true`
  （与 R11 相同）⇒ TS 档下**不是**受限令牌；这解释了为什么"透传"在 R16 能真写成功，而 R11 的
  32 位透传被 ACL 拒（R11 run3 `W09/W12/W14` 全是 `Access is denied`）。**同一契约分支，两种结果，
  取决于被注入进程的令牌能否改真实键** —— 这本身说明"依赖 ACL 兜住透传"不可靠。

## 上一轮缺陷在本轮的复现状态 [实测]

| R11 编号 | 结论 | R16 状态 |
|---|---|---|
| D4-R1 候选 `values=0` | 复现 | **更差**：连 `registry-stage` 候选都没有（D4-R16-3） |
| D4-R2 写"已存在真实键"被硬拒 + WAL 零记录 | 复现 | **不再复现（已修）**：`W21/W22/W23` 全部 `STAGE` 成功，journal `#37/#38/#39`，真实 hive 无值；全 journal `HARD_DENY=0` |
| D4-R3(a) 32 位视图不可用于对照 | 复现 | **升级为 P0**：不再只是"对照不可用"，而是**改真实 hive**（D4-R16-1/2） |
| D4-R4 `reg import` 打不开 `.reg` | 复现 | **细化**：仅 TEMP 路径失败；staged CWD 路径成功（D4-R16-5） |
| D4-R5 共享 hive 不可用 → 逐进程 hive | 部分复现 | 仍在（`overlay.<pid>.hive`）；新增"同进程读回不刷新"（D4-R16-4） |
| D4-R6 候选 warning 乱码 | 未复现 | 本轮无 registry 候选，**not-run**（无观测对象） |
| D4-R7 `lane.txt` 假红 | 未复现 | 本轮三 run `lane.txt` 与 raw `sandbox-lane.json` 一致（`LANE_OK=true`） |
