# R11 / D4：注册表修改与隔离（暂存 overlay 是否真的生效）

> 责任：teammate `t4-registry`（task-4）· 完成 2026-10-10 23:5x（本地）
> 装置：`.t/r11/bin/supervisor.mjs`（pid 9452）拉起的**新 DSH 线程**，`--profile sbx`
> 判定标记：`[实测]` = 本轮真跑过并留原始输出；`[引用]` = 只读契约/源码；未跑 = `not-run`
> 本域只写 `.t/r11/registry/**`、`.t/r11/jobs/d4-*/**`、`docs/round11/registry-*.md`；产品代码未改。

---

## 0. 一句话结论

**"注册表写入进暂存 overlay"这条设计在本装配下**真的生效了**——不再是上一轮的"13/13 硬拒"**：
沙箱内新建键/写值被暂存捕获（WAL 126 条、`SET_VALUE` 109 条、`HARD_DENY` **0** 条），调用方看到成功，
真实 hive 一个字节没变（宿主侧审计 CLEAN + 负对照自证）。

**但"暂存审批"这条链路只有一半是活的**：
① 冻结出的注册表候选**只有 2 个"建键"单元、`values=0`**，而 WAL 里有 109 条值写 ⇒ **审批面板看不到、也批不了那些值**（缺陷 D4-R1，P0）；
② 往**真实 hive 里已存在**的键写仍然被内核硬拒，且**不产生任何 WAL 记录**（三分类一种都不成立、不可归因，缺陷 D4-R2，P1，与 R10 的 D-R2 同源）。

| 维度 | 本轮判定 | 对照 |
|---|---|---|
| 读面 | **完全开放**（8/8；`HKCU\Software` 18 子键、`HKLM Uninstall` 45+18、`Session Manager\Environment` 16 值、`HKCR\.txt`、`HKU` 6） | 与 R10 一致 |
| 写面（新建键/值） | **暂存成功**：13/20 探针、**压力 100/100**；WAL `CREATE_KEY 13 / SET_VALUE 109 / DELETE_* 2 / UNSTAGED 2 / HARD_DENY 0` | R10 是"写进去读不回、值冻结 0" ⇒ **明显改善** |
| 写面（已存在的真实键） | **仍硬拒**（`SecurityException` / `ERROR: Access is denied`），**WAL 零记录** | R10 D-R2 **复发** |
| 跨进程写后读 | **可用**（reg.exe 子进程 8/15 rc=0，其余 7 条全部可由"未暂存/被拒"解释） | R10 D-R1（跨进程读全丢）**已不成立**；靠 `t3_replay_journal` 重放 |
| 真实 hive 残留 | **0**（最终审计 CLEAN；负对照能 FAIL；广域 `reg search` 0 命中） | 与 R10 一致 |
| 审批候选可用性 | **不可用**：`keys=2 / values=0`，13 条路径进 `unfrozen` | R10 D-R3 **复发且根因已定位** |
| platform 对照 | 同一批写**真的落到真实 hive**（20/20 + 100/100），清理后归零 | 本轮新增实测 |

---

## 1. 装置与判据

### 1.1 运行

| run | 模式 | job | 起止 | lane | stderr | exit | 摘要 |
|---|---|---|---|---|---|---|---|
| R2 | `platform` | `d4-platform-1` | 23:37:58 → 23:38:12 | 无 `sandbox-lane.json`（无 shim） | 0 B | 0 | 对照：写全落真实盘 |
| R1 | `winstage` | `d4-winstage-1` | 23:38:16 → ~23:41 | TS / `degraded=false` / `shimCount=1` | 0 B | 0 | **起跑时真实 hive 里已有 R2 遗留**（见 §7.3）⇒ 只用于"已存在键"形态 |
| R3 | `winstage` | `d4-winstage-2` | ~23:43 → 23:44（waited 54134 ms） | TS / `degraded=false` / `shimCount=1` | 0 B | 0 | **干净起点，主证据** |
| — | （Lead 既有） | `probe3` | — | TS（raw） | 0 B | 0 | 只做 fs 探针，`overlay.journal` **0 字节**（未尝试注册表写） |

每条 run 的原始目录：`.t\r11\registry\run1\out`、`run2\out`、`run3\out`（`stdout.ndjson`/`stderr.txt`/`exitcode.txt`/`meta.txt`/`stage-root/**`）。

**四条"沙箱真生效"硬判据（R3）**：① `stderr.txt` = 0 B；② raw `stage-root/sandbox-lane.json` → `tierEffective=TS, degraded=false, shimCount=1`（`LANE_OK=true`）；
③ 暂存树有产物（35→37 文件；`registry/overlay.journal` 12312 B；`candidates/*.json`）；④ 真实工作区只有 `seed.txt` + 我预放的 `probe-reg.ps1`（`realWorkspaceFiles`，无 `probe-reg-out.json`）。

> **提取器口径提醒**：`lane.txt` 由 `docs/round10/env/scripts/sbx-extract.mjs` 生成，它依赖 `<out>/stage-root-path.txt`。
> 本域 R1/R3 都是 `lane_ok=true`；但 Lead 的 `probe3/out` 缺该文件 ⇒ `lane.txt` 报 `LANE_OK=false`，而 raw `sandbox-lane.json` 明明是 TS。
> **凡 `lane.txt` 与 raw 冲突，以 raw 为准**（我的 `collect.mjs` 就是这么算的）。

### 1.2 宿主侧"真值"口径（我自己复算，不采信被测自述）

| 工具 | 作用 | 路径 |
|---|---|---|
| `regstate.ps1` | 真实 hive 快照（探针键 rc、计数、`HKCU\Software` 全子键、Run 值 sha12） | `.t\r11\registry\host\regstate.ps1` |
| `residue-audit.ps1` | 12 个根 + 3 个值位的 `WSP4T4*` 全量审计（含 HKCR 两个后备库、WOW6432、HKU） | `.t\r11\registry\host\residue-audit.ps1` |
| `decode-journal.mjs` | **自建** WAL 逐字节解码（契约 §4.3）+ 变异体自证 | `.t\r11\registry\host\decode-journal.mjs` |
| `collect.mjs` / `brief.mjs` | 把 run 目录变成可判定 JSON / 紧凑摘要 | `.t\r11\registry\host\collect.mjs` |
| `cleanup-wsp4t4.ps1` | 只删 `WSP4T4*` 探针键/值并复验 | `.t\r11\registry\host\cleanup-wsp4t4.ps1` |

**解码器有判定力（不是自证循环）**：契约字节正例 `problems=0`；6 个变异体各自报错——
`version=9`、`reserved=7`、`bad magic`、截断尾部、`UNSTAGED status=5`、`HARD_DENY status=0`（`host/fixture/fixture-decode.json`）。
并在**真实 journal** 上复跑：`bytes=12312 records=126 trailing=0 problems=0`（`run3/wal-decode.txt`、`run3/wal-decoded.json`）。

---

## 2. 读面（R3，`run3/summary.json` → `probe.reads`，8/8 成功）

| id | 目标 | 结果 |
|---|---|---|
| RD01 | `HKCU\Software` | 18 子键：`7-Zip, appdatalow, ChangeTracker, Google, IM Providers, Intel, Microsoft, Netscape, …` |
| RD02 | `HKCU\…\CurrentVersion\Run` | 1 值：`LocalSend`（len 55，sha12 `08E6F615267A`；值正文只留前 24 字符） |
| RD03 | `HKLM\…\CurrentVersion\Uninstall` | **45** 子键（前 8：`7-Zip, AddressBook, Connection Manager, DirectDrawEx, DXM_Runtime, Fontcore, Git_is1, IE40`） |
| RD04 | `HKLM\SOFTWARE\WOW6432Node\…\Uninstall` | **18** 子键 |
| RD05 | `HKLM\SYSTEM\…\Session Manager\Environment` | 16 值；**只记类型/长度/sha12/前 32 字符**（`Path` len 272 sha12 `F8C16F16C9B3`），**整值不出证据**（打码） |
| RD06 | `HKCR\.txt` | 默认值 `txtfile`；子键 `PersistentHandler, ShellNew` |
| RD07 | `HKU` 根 | 6：`.DEFAULT, S-1-5-19, S-1-5-20, S-1-5-21-…-500, …-500_Classes, S-1-5-18` |
| RD08 | `HKLM\…\Windows NT\CurrentVersion` | `Windows Server 2025 Datacenter` / build `26100` / 31 值 |

⇒ 读面**没有任何收敛**（与 R10 "读 100% 开放"一致）；沙箱只拦写。

---

## 3. 写面：逐机制（R3 = 干净起点，`run3/summary.json` → `probe.writes`）

`preexist` 先行取证：13 个 `WSP4T4*` 目标键**全部 `keyExists=false`**（`ItemNotFoundException`）⇒ R3 的 readback 只能是**本次暂存**造成的。
（另有 3 个故意选的"已存在键"：`HKCU:\Console`、`HKCU:\Environment`、`HKCU:\…\Run`。）

| # | 机制 | 调用方看到 | 原始错误文本 | WAL | 真实 hive |
|---|---|---|---|---|---|
| W00 | PS `New-Item`（建父键） | **成功** | — | `CREATE_KEY HKCU\Software\WSP4T4` | 未变 |
| W01 | PS `New-Item`（建子键） | **成功** | — | `CREATE_KEY …\ps` | 未变 |
| W02 | PS `New-ItemProperty` | **成功**（读回 `ps-sz-r11`） | — | `SET_VALUE …\ps\PSZ` | 未变 |
| W03 | PS `Set-ItemProperty` **已存在键** `HKCU:\Console` | **失败** | `System.Security.SecurityException \| Requested registry access is not allowed.` | **无** | 未变 |
| W04 | PS `New-ItemProperty` **已存在键** `HKCU:\Environment` | **失败** | 同上 | **无** | 未变 |
| W05 | PS `New-Item` HKCR | **成功** | — | `CREATE_KEY HKCR\WSP4T4_CLS` | 未变 |
| W06 | .NET `CurrentUser.CreateSubKey`+`SetValue` | **成功**（读回 `dotnet-sz`） | — | `CREATE_KEY …\net` + `SET_VALUE DN` | 未变 |
| W07 | .NET `LocalMachine.CreateSubKey` | **成功** | — | `CREATE_KEY/SET_VALUE HKLM\SOFTWARE\WSP4T4\netlm` | 未变 |
| W08 | .NET `OpenBaseKey(LM, Registry64)` | **成功** | — | `CREATE_KEY/SET_VALUE …\net64` | 未变 |
| W09 | .NET `OpenBaseKey(LM, Registry32)` | **失败** | `Access to the registry key 'HKEY_LOCAL_MACHINE\SOFTWARE\WSP4T4\net32' is denied.` | **`UNSTAGED`（reason=1，透传）** | 未变 |
| W10 | `reg.exe add HKCU` | **成功** | — | `CREATE_KEY/SET_VALUE …\regexe\R1` | 未变 |
| W11 | `reg.exe add HKCU /reg:64` | **成功** | — | `CREATE_KEY/SET_VALUE …\reg64\R64` | 未变 |
| W12 | `reg.exe add HKCU /reg:32` | **失败** | `reg.exe : ERROR: Access is denied.`（exit=1） | **`UNSTAGED`（reason=1）** | 未变 |
| W13 | `reg.exe add HKLM` | **成功** | — | `CREATE_KEY/SET_VALUE HKLM\SOFTWARE\WSP4T4\regexe\R2` | 未变 |
| W14 | `reg.exe add` **已存在键** `…\Run` | **失败** | `reg.exe : ERROR: Access is denied.`（exit=1） | **无** | 未变（Run 仍只有 `LocalSend`） |
| W15 | `reg import`（UTF-16LE .reg） | **失败** | `ERROR: Error opening the file. There may be a disk or file system error.`（exit=1，file bytes=330 hex=`fffe570069006e00`） | **无** | 未变 |
| W16 | WMI `StdRegProv.CreateKey/SetStringValue` | **失败** | `Exception calling "CreateKey" : "Access denied "` | **无** | 未变 |
| W17 | COM `WScript.Shell.RegWrite` | **成功**（读回 `com-sz-r11`） | — | `SET_VALUE …\com\`（默认值）+ `…\com\CV` | 未变 |
| W18 | PS `Remove-ItemProperty` | **成功** | — | **`DELETE_VALUE …\ps\PSZ`** | 未变 |
| W19 | PS 建键+`Remove-Item` | **成功** | — | `CREATE_KEY …\del` + **`DELETE_KEY …\del`** | 未变 |

**13/20 成功**。失败面**逐条可归因**，没有一条是"不可归因"：
1. **W03/W04/W14（3 条）= 目标键在真实 hive 里已存在** ⇒ 净变化 no-op ⇒ 转发真实 API ⇒ 受限令牌下内核硬拒（详见 §6 与缺陷 D4-R2）；
2. **W09/W12（2 条）= 32 位视图**：契约 v1.4 明确要求**透传 + `UNSTAGED`**，本轮行为**符合契约**（`shim.log`：`unstaged passthrough: HKLM\SOFTWARE\WSP4T4\net32 (reason=1) -> real API`），透传目标被真实 ACL 拒 ⇒ 视图对照仍不可用；
3. **W15（1 条）= `reg import` 读不到沙箱内的 .reg 文件**（文件在暂存树里，映射后 `reg.exe` 打不开）；
4. **W16（1 条）= WMI provider 在 `WmiPrvSE.exe` 里执行**，不在注入链 ⇒ 走真实 API ⇒ 拒。**这一条必须按"绕过 shim"记账，不能读成"暂存失败"**。

> 20 条探针的**完整原始 JSON**：`run3/out/stage-root/staged/probe-reg-out.json`（23 KB，含每条错误类型全名、rcText、readback）。
> 同一批操作在**宿主（完全无沙箱）**下的对照：`host/smoke/probe-reg-out.json`（20/20 + 100/100，无 `winstage` 模块，`WINSTAGE_SHELL=0`）。

---

## 4. 一致性压力（≥50 次要求 → 实测 100 次）

| 量 | R3（干净） | R1（起跑即有遗留） |
|---|---|---|
| 重复写总次数 | **100**（PS `New-ItemProperty` ×50 + .NET `SetValue` ×50） | 100 |
| `reportedSuccess` | **100** | **0** |
| `reportedFailure` | **0** | 100 |
| 同进程读回 | `valueCount=100`（`S00…S49`,`D00…D49`） | 100（**但读的是 R2 留在真实 hive 的那份**） |
| WAL 对应记录 | `SET_VALUE` ×100 | **0** |

对 §3 问的两类不一致：
* **"报告成功但真实未写"**：R3 下 100/100 报成功、真实 hive 零变化 ⇒ **这是暂存设计的预期语义**（不是缺陷）；关键是它有 WAL 记录、且**没动真实 hive** ⇒ 可审计、可应用/丢弃。
* **"报告失败但真实已写"**：**两类下都没出现**（R1 写全失败且真实 hive 未变；R3 无失败写入落到真实 hive）。

---

## 5. 暂存面核对（不信被测自述，自己解码）

### 5.1 WAL（自建解码器，`run3/wal-decode.txt`）

```
journal=…\run3\out\stage-root\registry\overlay.journal bytes=12312 records=126 trailing=0
counts={"CREATE_KEY":13,"SET_VALUE":109,"UNSTAGED":2,"DELETE_VALUE":1,"DELETE_KEY":1}
problems(0)=[]
#1 CREATE_KEY path=HKCU\Software\WSP4T4 …
#3 SET_VALUE path=HKCU\Software\WSP4T4\ps name=PSZ type=REG_SZ dataBytes=20 flags=[HAS_VALUE_NAME,HAS_DATA] value="ps-sz-r11"
#12 UNSTAGED path=HKLM\SOFTWARE\WSP4T4\net32 type=REG_SZ status=0 flags=[UNSTAGED]
#126 SET_VALUE path=HKCU\Software\WSP4T4\stress name=D49 … value="w49"
```

* **`HARD_DENY` = 0 条**：没有任何一次调用被 shim 判成"硬拒"。R1 的 journal（328 B）同样 **0 条 `HARD_DENY`**、0 条 `SET_VALUE`。
* 逐字段合规（`reserved=0`、`version=1`、`UNSTAGED → status=0`、`HAS_VALUE_NAME|HAS_DATA`）**全部通过**；数据字节是原样线格式（`REG_SZ` 含结尾 NUL，`dataBytes` 与字符串长度一致）。
* **`overlay.hive` 8192 B 不变、`overlay.local.hive` 32768 B**，另有按 pid 的 `overlay.<pid>.hive`（见 5.3）。
* shim 自报 `registry/host-capture.json`：`{"bytes":12312,"records":2,"enqueued":true,"candidateId":"cs_0002_1ffd1242"}` ⇒ **它自己承认只冻住了 2 条**（与 §5.4 的缺陷一致）。

### 5.2 候选（`run3/out/stage-root/candidates/`）

| 候选 | `source` | changes | keys/values | 说明 |
|---|---|---|---|---|
| `cs_0001_7eed2a88.json` | `shell` | 10（`fs\…` 文件） | — | 文件候选（与注册表无关） |
| `cs_0002_1ffd1242.json` | **`registry-stage`** | **2**（`op=mkdir`, `diffKind=subkey-added`） | **keys=2, values=0** | 只有 `HKCU\Software\WSP4T4`、`HKLM\SOFTWARE\WSP4T4` |

`unfrozen` 13 条 + 13 条 warning，原文（`run3/candidate-quote.txt`）：

```
HKCR\WSP4T4_CLS: 基线读取失败（reg query HKCR\WSP4T4_CLS did not run or failed unrecognizably
(status=1, via=pipe, error=none, stderr="<乱码>: 系统找不到指定的注册表项或值。"）: refusing to
translate "we could not read it" into "the key does not exist"，该路径**不**进入候选 ——
候选必须冻结一个可验证的 before（手册 #12.6），读不到就不许假装读到
```

⇒ **宿主侧候选生成的唯一输入是 WAL（126 条），但最终候选里 `values=0`**。审批面板即使全批，也只会"建两个键"，109 个值永远不会被应用。⇒ 缺陷 **D4-R1**。

### 5.3 attach / 跨进程（`shim.log`，77177 行）

```
[winstage-shim][…][1] DshRegStageAttach: … tier=1 hive=…\registry\overlay.hive  journal=…\overlay.journal (replayedBytes=0 viewIncomplete=0)
[winstage-shim][5616][1] DshRegStageAttach: shared hive unusable (32) -> SESSION hive=…\overlay.local.hive (journal stays shared: …\overlay.journal)
[winstage-shim][13436][1] DshRegStageAttach: BOTH shared hives unusable (32/32) -> per-process hive=…\overlay.13436.hive (journal stays shared: …)
[winstage-shim][9648][3] t3_replay_journal: applied=11 auditSkipped=1 bytes=1032 rc=0
```

| 量 | 值 |
|---|---|
| 进程 attach 次数 | 32（`hooks installed` / `child injection armed` 同为 32） |
| `tier=1`（共享 hive 可用） | 4 |
| `tier=2`（`overlay.local.hive`） | 6 |
| `tier=3`（`overlay.<pid>.hive`） | **22** |
| `t3_replay_journal` 行 | 21（例：`applied=11/13 … rc=0`） |
| `REGDBG branch=` | `PASSTHROUGH` 4018 + `ctx` 271；**无任何写分支日志**（`REGDBG` 只覆盖读/枚举/句柄路径） |
| `probePathHits`（日志里出现探针路径的行） | 1163 |

**判读**：共享 hive 在多数子进程里因 `ERROR_SHARING_VIOLATION(32)` 不可用 ⇒ 退回逐进程 hive（R10 D-R1 的机制**仍在**）；
但**这次跨进程读没丢**，因为 attach 时按 journal 重放（`t3_replay_journal`）。实测 `xproc`：`XP02/03/05/06/08/10/11/13` rc=0 且值逐字正确（例：`XP05 → S00 = v00`）。
7 条 rc≠0 全部可由"未暂存/被拒"解释：`XP01`（W18 刚删的 PSZ）、`XP04`（Run 已存在键写被拒）、`XP07`（WMI）、`XP09`（reg import 失败）、`XP12`（32 位透传被拒）、`XP14/XP15`（已存在键写被拒）。

---

## 6. 零残留（宿主侧复算 + 负对照）

命令与原始输出：`.t\r11\registry\host\residue-final.log` / `residue-negctl.log` / `residue-final2.log`。

| 判据 | 结果 | 证据 |
|---|---|---|
| **Z1** 12 个根全量 `WSP4T4*` 审计（HKCR 两个后备库 + WOW6432 + HKU + Console/Environment/Run 值位） | `hitCount=0 verdict=CLEAN` | `residue-final.json` |
| **Z2** 负对照（注入 `HKCU\Software\WSP4T4_NEGCTL` 后重跑） | `hitCount=1 verdict=RESIDUE-FOUND hits=HKCU:\Software\WSP4T4_NEGCTL` ⇒ **审计有判定力** | `residue-negctl.json` |
| **Z3** 删掉负对照后复跑 | `hitCount=0 verdict=CLEAN` | `residue-final2.json` |
| **Z4** `reg query … /f WSP4T4 /k /s`（HKCU\Software、HKLM\SOFTWARE、WOW6432Node） | 三条全 `rc=1` + `End of search: 0 match(es) found.` | 见本次会话原始输出；数组传参已修正 |
| **Z5** 计数对照（真实 hive） | `HKCU\Software` 16(baseline 15:29) → 18(R2 后) → 17(R2 清理后) → 17(R3 后)；`Uninstall` 45/45、`Uninstall32` 18/18、`HKU` 6/6 **全程不变** | `baseline-pre.json`、`state-*.json` |
| **Z6** 3 个**故意写进已存在键**的值 | `hkcu_Run_has_probe / Console / Env` 全程 `False`（写确实被拒） | `state-post-run3.json` |
| **Z7** 历史遗留键 `HKCU\Software\WinstageOpenq0731wq4`（`P=z`） | **仍在、未改**（只报告，未删） | `state-after-platform.json` |
| **Z8** platform 模式**临时**写入 → 清理 → 复验 | 清理前 4 键 + 3 值全部存在；清理后 7 项全 `False` + 6 根 `SWEEP_CLEAN` | `post-platform-before-cleanup.json`、`cleanup-platform.log`、`post-platform-after-cleanup.json` |

> `HKCU\Software` 的 16→17 漂移与探针无关：多出来的键是 Windows/Edge 自身活动（`appdatalow` 等），
> 且**探针路径零命中**（Z1/Z4）。探针键名一律带 `WSP4T4` 前缀，可枚举、可复查。

---

## 7. 对照：`platform` 模式（`d4-platform-1`）

### 7.1 装配差异

| 项 | `winstage`（R3） | `platform`（R2） |
|---|---|---|
| `WINSTAGE_SHELL` | 1 | 0 |
| `sandbox-lane.json` | 存在（TS，`shimCount=1`） | **不存在**（无 shim） |
| 线程 shell cwd | `<out>\stage-root\staged` | **真实工作区** `<ws>` |
| shim 模块/注入 | 32 进程注入、`reg=on` | 无 |
| `registry/overlay.journal` | 12312 B / 126 条 | **不存在** |
| 我预放的 `probe-reg.ps1` 在 stage-root | 有 | 有（未被使用） |

### 7.2 同一批写的落点

| 判据 | platform（R2） |
|---|---|
| `reportedSuccess` | **20/20**；压力 **100/100** |
| 真实 hive | `HKCU\Software\WSP4T4`、`HKLM\SOFTWARE\WSP4T4`、`HKLM\SOFTWARE\WOW6432Node\WSP4T4`、`HKCR\WSP4T4_CLS` 全部 `rc=0`；`probeHKCU/HKLM/WOW/runProbe` 全 `True` |
| 探针 JSON 落点 | **真实盘** `run2\ws\probe-reg-out.json`（不是暂存树） |
| 清理后 | 7 项全 `False`（`cleanup-platform.log`：`KEY_DELETED ×4`、`VAL_DELETED ×3`、`SWEEP_CLEAN ×6`） |

⇒ **同一批操作在 platform 模式真的改真实注册表**；而 winstage(TS) 模式下 13/20 成功、100/100 压力成功、真实 hive **零变化**。
这就是"暂存面确实在起作用"的直接反证。

### 7.3 一条重要方法学教训（我自己踩的）

R2（23:38:12 结束）先把真实键写了出来，R1（23:38:16 起跑）**紧接着**运行 ⇒ R1 的 readback/读面看到了 R2 的**真实遗留**，
于是出现"写报失败、读却能读到"的假象。我据此把 R1 判为**污染运行**并**重跑了 R3（干净起点，`preexist` 13/13 缺席自证）**。
R1 仍然有效的是：**写尝试的成功率与 WAL**（与污染无关）——它给出的"已存在键 ⇒ 硬拒 + 零 WAL 记录"形态，已被 R3 的 W03/W04/W14 **独立复现**。

---

## 8. 结论：本装配下"注册表暂存审批"是否真的生效？

**分三层回答（都有原始证据）**：

1. **"写进 overlay、不进真实 hive"——生效。** R3：126 条 WAL（`SET_VALUE` 109、`CREATE_KEY` 13、`DELETE_*` 2、`UNSTAGED` 2、`HARD_DENY` 0），`problems=0`；13/20 探针 + 100/100 压力成功；真实 hive 零残留（Z1–Z8）。
   相比上一轮"13/13 硬拒"与 R10"写进去读不回、值冻结 0"，**这是质变**。
2. **"跨进程可读回"——生效（靠重放兜住）。** 逐进程 hive（tier=2/3 共 28/32 次 attach）使共享 hive 语义破损，但 `t3_replay_journal`（21 次，`applied=11/13 rc=0`）把会话视图重建出来，reg.exe 子进程 8/15 读到正确值，未读到的那 7 条全可归因。
3. **"走审批面板、可选择性应用"——不生效（只有键、没有值）。** 冻结候选 `keys=2 / values=0`，13 条路径被 `unfrozen`；宿主 `host-capture.json` 自报 `records=2`。**用户即使"批准全部"，也只有两个建键动作，109 条值写永远不会被应用。**

**"只有硬拒"的假设不成立**——`HARD_DENY` 在 WAL 里为 0 条。**但"已存在键的写入"确实只剩内核硬拒**，且**连一条 WAL 记录都没有**（D4-R2），这与 R10 的 D-R2 是同一个洞：这类失败既不是"暂存成功"、也不是"被拒的暂存"（无 `HARD_DENY` 记录）、也不是"透传"（无 `UNSTAGED`），**三分类一种都不成立 ⇒ 不可归因**。

---

## 9. 未跑 / 诚实边界（`not-run`）

1. **`apply()` 的真实副作用**：`not-run`（本轮刻意不触发，避免动真实 hive；契约 §13 已声明其风险）。
2. **`discard()` 后的审计轨迹**：`not-run`（`overlay.state.json` 停在 `status=pending`）。
3. **重启后白障是否仍生效**（契约 A6 门槛）：`not-run`——但本轮观察到 attach 时会 `t3_replay_journal`，为下轮提供了可测入口。
4. **`RegSetKeySecurity` / 25 条 §8.2 硬拒 API / `REG_OPTION_VOLATILE`**：`not-run`（未构造夹具）。
5. **`HKPD`/`REG_OPTION_CREATE_LINK` 等**：`not-run`。
6. **多会话并发隔离（两个沙箱线程同时写同一键）**：`not-run`（本轮 R2/R3 是**顺序**跑的，就是为了消除污染）。
7. **`probe3` 的 0 字节 journal**：只能证明"未尝试写"，不能证明"写不进"——本轮 R3 才把它推到 126 条。
8. **`reg import` 的可用性**：`not-run` 到"换一种文件通道（工作区外 / temp 直写）后能不能成功"。
9. 探针自身缺陷（已记录在 `registry-缺陷.md` §探针侧）：`R` 别名遮蔽、`reg.exe query` 单字符串传参、PowerShell 逗号优先级生成坏 `.reg`、`contaminated` 标志过粗（把 `Console/Environment/Run` 三个**故意存在的系统键**算成污染，正确口径应为"探针自有的 `WSP4T4*` 键"，重算后为 **0**）、R1/R2 时间重叠。

---

## 10. 证据索引

| 路径 | 内容 |
|---|---|
| `.t\r11\registry\payload\probe-reg.ps1` | 探针（纯 ASCII，`sha256 070E34C7…AB471`），含 `preexist` 前置取证与 `DIGEST` 行 |
| `.t\r11\registry\run3\out\**` | **主证据**：stdout.ndjson / stderr(0B) / exitcode / meta / stage-root（lane、journal、candidates、staged/shim.log、staged/probe-reg-out.json） |
| `.t\r11\registry\run3\summary.json`、`wal-decode.txt`、`wal-decoded.json`、`candidate-quote.txt` | collect.mjs 摘要 / WAL 解码原文 / 候选原文 |
| `.t\r11\registry\run1\out\**`、`run1\summary.json` | 污染运行（"已存在键"形态 + 0/100 压力） |
| `.t\r11\registry\run2\out\**`、`run2\summary.json`、`run2\ws\probe-reg-out.json` | platform 对照（写落真实盘） |
| `.t\r11\registry\host\baseline-pre.json` / `state-*.json` | 宿主侧真实 hive 快照链（before/after 每个阶段） |
| `.t\r11\registry\host\residue-*.json` / `.log` | 零残留审计 + 负对照 |
| `.t\r11\registry\host\platform-real-writes.txt` | platform 落点抓取的**失败尝试**（单字符串传参 bug，已在 `registry-缺陷.md` 如实登记；`probeKeys rc=0` 与 `state-post-platform-before-cleanup.json` 才是有效证据） |
| `.t\r11\registry\host\fixture\fixture-decode.json` | 解码器判定力自证（正例 + 6 变异体） |
| `.t\r11\registry\host\smoke\probe-reg-out.json` | 宿主（无沙箱）对照：20/20 + 100/100 |
| `.t\r11\registry\host\{regstate,residue-audit,cleanup-wsp4t4}.ps1`、`{decode-journal,collect,brief,fixture-journal}.mjs` | 可复跑的判据工具 |

### 复现（PowerShell）

```powershell
# 1) 干净起点确认（全部 False）
powershell -NoProfile -File .t\r11\registry\host\regstate.ps1 -Out .t\r11\registry\host\state-pre.json -Label pre
# 2) 新开带沙箱线程（宿主需在跑：.t\r11\supervisor.pid.txt）
node .t\r11\bin\submit-job.mjs d4-winstage-3 .t\r11\registry\run3\ws .t\r11\registry\run3\prompt.txt .t\r11\registry\run3\out winstage
node .t\r11\bin\wait-job.mjs d4-winstage-3 900
# 3) 解码 WAL + 汇总 + 零残留
node .t\r11\registry\host\decode-journal.mjs .t\r11\registry\run3\out\stage-root\registry\overlay.journal --selftest
node .t\r11\registry\host\collect.mjs .t\r11\registry\run3\out .t\r11\registry\run3\summary.json
powershell -NoProfile -File .t\r11\registry\host\residue-audit.ps1 -Out .t\r11\registry\host\residue-final.json -Label final
```
