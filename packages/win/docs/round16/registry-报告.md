# R16 / D4：注册表修改与隔离 —— 域报告

> 责任：teammate `registry`（task-4）· 窗口 2026-10-11 17:46 → 18:36 (+08:00)
> 装置：`docs\round10\env\scripts\sbx-thread.cmd`（每次起**独立进程**的 `dsh --profile sbx`，`WINSTAGE_SHELL=1`，暂存根钉唯一）
> 判定标记：`[实测]` = 本轮真跑并留原始输出；`[引用]` = 只读源码/文档；未跑 = `not-run`
> 写作用域：`.t\r16\registry\**`、`docs\round16\registry-报告.md`、`docs\round16\registry-缺陷.md`。**产品代码未改一行**；`shim/out` golden 三件套未动。
> 缺陷清单：[registry-缺陷.md](./registry-缺陷.md)（D4-R16-1 … D4-R16-5）

---

## 0. 一句话结论

**"注册表写入进暂存 overlay、真实 hive 零改动"这条核心判据在本装配下不成立**：

1. **【P0，本轮首证】** 显式 **32 位视图**（`KEY_WOW64_32KEY`）的**键创建与键删除**被 shim 以
   `UNSTAGED` 透传给真实 API，**真实 hive 被改**：新建键留下空壳、`/reg:32` 删除**真删**。
   默认/64 位视图**没有**这个问题（w3 三组 A/B vs C 对照，宿主侧读数）⇒ 泄漏与视图严格相关。
2. **【P0】** 注册表写入**完全不产生审批候选**（无 `registry-stage` 候选、无 `registry/host-capture.json`），
   比 R11 的"`values=0`"更差 —— 审批面整条断掉。
3. **好消息**：R11 的两条主要缺陷在本轮方向相反 ——
   ① 写**真实已存在键**（`HKCU:\Console/Environment/Run`）**不再被硬拒**，改为正常进暂存（R11 D4-R2 已修）；
   ② 读面 + 跨进程（新进程）读回可用（R11 D4-R1/R5 不再以原形态成立）；
   ③ `HARD_DENY` 全 journal **0 条**。
4. **零残留终态成立**：所有真实残留已清理，终局审计 `verdict=CLEAN`、`HKCU_Software=17`（= 基线）、
   `HKCR/HKLM/WOW6432Node/HKU/Run` 全部回到基线；R10/R11 的历史遗留键 `HKCU\Software\WinstageOpenq0731wq4`
   （`P=z`）**仍在、未改**（只报告未删）。

| 维度 | R16 判定 | 对照 |
|---|---|---|
| 读面 | **完全开放 9/9**（含 WOW64 视图对照） | 与 R11 一致（8/8 → 9/9） |
| 写面（默认/64 位视图，20 条通道） | **全部 STAGE 成功**，真实 hive 无残留 | 明显优于 R11（R11 13/20 + 已存在键硬拒） |
| 写面（**显式 32 位视图**，6 条通道） | **P0：键创建/删除透传真实 API ⇒ 真实 hive 被改** | R11 是"透传后被 ACL 拒"（同分支、环境不同） |
| 压力 | **100/100** 成功 | 同 R11 |
| 真实 hive 残留 | **有**（w1/w2/w3 各 2–4 键壳 + 1 真实键被删）⇒ 已清理 ⇒ 终态 CLEAN | R11 为 0；本轮**推翻** |
| 审批候选 | **0 个注册表候选**（`host-capture.json` 不存在） | R11 有 `keys=2/values=0` ⇒ **更差** |
| platform 对照 | 同一批写**全落真实 hive**（25/25 + 100/100，4 键 + 3 值），清理后归零 | 本轮新增实测 |

---

## 1. 装置、run 台账与 §1.1 四条判据

### 1.1 run 台账 `[实测]`

| run | 模式 | token | session | 暂存根 | lane | stderr | exit | 用途 |
|---|---|---|---|---|---|---|---|---|
| `run-w1` | winstage | `1f4f18` | `session-bf94de37-c441-40ee-8823-a2a9b5ed95e1` | `<out>\stage-root-27328109214908` | **TS** / `degraded=false` / `shimCount=1` | 0 B | 0 | 全通道矩阵 + 100 压力 + WOW64 |
| `run-w2` | winstage | `926116` | `session-c0284bcf-19e4-4e86-852a-dede694da266` | `<out>\stage-root-27328109214908` | **TS** / `degraded=false` | 0 B | 0 | 复现 + 跨 run 隔离（外来 token 不可见） |
| `run-w3` | winstage | `665a04` | `session-081c95ae-5130-41e8-957f-ae65366d882b` | `<out>\stage-root-295362528732464` | **TS** / `degraded=false` | 0 B | 0 | **最小复现**：空壳 vs 空壳+值 vs 默认视图 + 删除 |
| `run-p1` | **platform** | `544a38` | `session-3449e361-aa2a-4faa-8e68-ef596359aa4f` | 无（`WINSTAGE_SHELL=0`） | 无 `sandbox-lane.json`（平台档不产生） | 0 B | 0 | 对照：真实 hive 应被写 |
| 宿主对照 `smoke1/2/3` | 无沙箱 | `f3a023`/`0dbb94`/`c94fdc` | — | — | — | 0 B | — | 证明探针**有判定力**（不受限时真的写真实盘） |
| 宿主对照 `min-smoke` | 无沙箱 | `4fa5f4` | — | — | — | 0 B | — | 最小复现脚本的宿主对照（11/11 + 两 victim 均被删） |

> 沙箱 run 4 个（协议上限 6；Lead 特批 8），其中 TS 有效 run 3 个；platform 对照 1 个。

### 1.2 §1.1 四条判据（逐 run）`[实测]`

| 判据 | w1 | w2 | w3 | 读数出处 |
|---|---|---|---|---|
| ① `stderr.txt` 0 字节 | ✅ 0 B | ✅ 0 B | ✅ 0 B | `<out>\stderr.txt` |
| ② 暂存面在工作（含 `staged\*` 且同 run 有 `candidates\*.json`） | ✅ 清单 69 行、`staged\probe-reg16-out.json`；候选 1 | ✅ 同上 | ✅ 清单；`staged\probe-reg16-min-out.json`；候选 1 | `<out>\stage-root-inventory.txt`、`<stageRoot>\candidates\` |
| ③ 真实工作区零污染（只有预放种子） | ✅ `files=2`（`seed.txt` + `probe-reg16.ps1`） | ✅ `files=2` | ✅ `files=2` | `<out>\workspace-inventory.txt` |
| ④ **lane 真的是 TS** | ✅ `LANE_OK=true`（raw `degraded=false` + `tierEffective=TS`） | ✅ 同 | ✅ 同 | `<out>\lane.txt` + raw `<stageRoot>\sandbox-lane.json` |

`lane.txt` 与 raw `sandbox-lane.json` 三个 run 完全一致（R11 D4-R7 的"假红"未复现）。
`run-p1` 的判据④**不适用**（平台档不产生 `sandbox-lane.json`，`lane.txt` 写 `lane_file=(missing)`）——
按协议它只作**负对照**，不用于声称"沙箱隔离生效"。

### 1.3 判据工具与判定力自证 `[实测]`

| 工具 | 作用 | 自证 |
|---|---|---|
| `host\probe-reg16.ps1`（同步副本 `payload\`） | 沙箱内探针（9 读 + 25 通道写 + 100 压力 + 13 跨进程读） | 宿主对照 `smoke3`：读 9/9、写 **25/25**、压力 **100/100**、跨进程 **13/13**、stderr 0 ⇒ 探针在不受限环境**确实能写真实盘** |
| `host\regstate.ps1` | 外部不受限真实 hive 快照/残留审计（键存在性 + 深度 2 值+子键 + `reg query /f … /k /s` 4 根扫描 + WOW64 视图扫描） | 负对照 `smoke3`：`verdict=RESIDUE-FOUND`、`probeHitCount=7`、计数 `17→18`；清理后复扫 `CLEAN`、计数回 `17` ⇒ 审计有判定力 |
| `host\decode-journal.mjs`（自 R11 复制，逐字节 WAL 解码） | 解 overlay WAL | ① 对 R11 真 journal 复算 = R11 文档值（`bytes=12312 records=126 counts={CREATE_KEY:13,SET_VALUE:109,UNSTAGED:2,DELETE_VALUE:1,DELETE_KEY:1} problems=0`）；② 变异体自证（version=9 / reserved=7 / bad magic 各自报错） |
| `host\analyze-run.mjs` | run 目录 → 可判定 JSON（§1.1 判据 + WAL + 候选 + 探针 JSON） | 对 R11 `run3` 复算：`LANE_OK_raw=true`、journal 126 条、候选 2（含 `registry-stage`）⇒ 与 R11 文档逐条一致 |

---

## 2. 读面（w1，`run-w1\summary.json` → `probe.reads`，9/9 成功）

| id | 目标 | 结果 |
|---|---|---|
| RD01 | `HKCU\Software` | **17** 子键（= 基线；32 位视图的透传发生在这次读**之后**，所以沙箱内读面看不到自己造成的残留 —— 必须宿主侧复核） |
| RD02 | `HKCU\…\CurrentVersion\Run` | 1 值（只记 长度/sha12/前 24 字符） |
| RD03 | `HKLM\…\CurrentVersion\Uninstall` | **45** 子键 |
| RD04 | `HKLM\SOFTWARE\WOW6432Node\…\Uninstall` | **18** 子键 |
| RD05 | `HKLM\SYSTEM\…\Session Manager\Environment` | 16 值，**整值不出证据**（只记类型/长度/sha12/前 32 字符） |
| RD06 | `HKCR\.txt` | 默认值 `txtfile` + 子键 |
| RD07 | `HKU` | 6 子键 |
| RD08 | `HKLM\…\Windows NT\CurrentVersion` | `Windows Server 2025 Datacenter` / build `26100` |
| **RD09** | **WOW64 视图对照（新增）** | `reg query … /reg:32` → `ProgramFilesDir = C:\Program Files (x86)`（`rc=0`）；`/reg:64` → `C:\Program Files`（`rc=0`）；`.NET Registry32` 子键数 **91** vs `Registry64` **158**；`sameValue=false`；`Registry32` 读 `HKCU…Run` = 1 值 |

⇒ 读面**没有任何收敛**；两个视图的读**都可用**（所以 32 位视图的**写**不可用才格外刺眼）。

---

## 3. 写面：逐通道三件套证据（w1 = 干净起点）

**三件套** = (a) 沙箱内读回值（`staged\probe-reg16-out.json`）｜(b) **外部不受限 pwsh 读真实注册表**
（`host\post-winstage-runs.json` / `host\post-w3.json` / `host\leaked-keys-detail*.json`）｜
(c) 同 run 暂存根 `registry\overlay.journal` 记录（`host\decode-journal.mjs`，w1 `bytes=18732 records=141`）。

`preexist` 前置取证：**本轮 token 作用域的 20 条目标探测 20/20 `keyExists=false`**（`ownContaminated=false`），
另有 3 个**故意选的**系统键（`HKCU:\Console`/`Environment`/`Run`）`keyExists=true`、`valueExists=false`（`existingKeysSeen=3`）⇒
读回命中只可能来自本次暂存**或**本次透传，可归因。
> 探针侧小瑕疵（如实登记）：`peSpecs` 的 PowerShell 数组把 `$KP + '\ps'` 之类扁平化，
> 于是 `name` 字段落成 `'\ps'`、存在性探测实际落在**根键**上；根键缺席 ⇒ 子键必缺席，所以结论不变，
> 但下一轮应改成 `@('hkcu-ps', ($KP + '\ps'), 'PSZ')` 的显式括号写法。

| # | 通道 | 进程内/新进程 | (a) 沙箱内读回 | (b) **真实 hive** | (c) overlay WAL |
|---|---|---|---|---|---|
| W01 | PS `New-Item`（根键） | 本进程 | `<key-exists>` | 无残留 | `CREATE_KEY HKCU\Software\<t>` |
| W01B | PS `New-Item`（`ps` 子键） | 本进程 | `<key-exists>` | 无残留 | `CREATE_KEY …\ps` |
| W02 | PS `New-ItemProperty` REG_SZ | 本进程 | `ps-sz-r16` ✅ | 无残留 | `SET_VALUE …\ps PSZ` |
| W03 | PS `Set-ItemProperty` REG_SZ | 本进程 | `ps2-sz-r16` ✅ | 无残留 | `SET_VALUE …\ps PSZ2` |
| W04 | PS `New-ItemProperty` REG_DWORD | 本进程 | `4242` ✅ | 无残留 | `SET_VALUE …\ps PDW=4242` |
| W05 | PS 建子键 + 写值 | 本进程 | `child-sz-r16` ✅ | 无残留 | `CREATE_KEY …\ps\child` + `SET_VALUE CV` |
| W06 | .NET `CurrentUser.CreateSubKey`+`SetValue` | 本进程 | `dotnet-sz-r16` ✅ | 无残留 | `CREATE_KEY …\net` + `SET_VALUE DN` |
| W07 | .NET `CurrentUser` `Registry64` 建键 | 本进程 | `net64-sz-r16` ✅ | 无残留 | `CREATE_KEY …\net64` + `SET_VALUE V` |
| **W08** | **.NET `CurrentUser` `Registry32` 建键** | 本进程 | `net32-sz-r16`（调用方见成功） | **🔴 键壳 `…\net32` 残留** | **`UNSTAGED wow64-32key` + `SET_VALUE HKCU\SOFTWARE\…\net32`** |
| W09 | .NET `LocalMachine.CreateSubKey` | 本进程 | `netlm-sz-r16` ✅ | 无残留 | `CREATE_KEY HKLM\SOFTWARE\<t>` + `…\netlm` + `SET_VALUE V` |
| W10 | .NET `LocalMachine` `Registry64` | 本进程 | `netlm64-sz-r16` ✅ | 无残留 | `CREATE_KEY …\netlm64` + `SET_VALUE V` |
| **W11** | **.NET `LocalMachine` `Registry32`** | 本进程 | `netlm32-sz-r16`（见成功） | **🔴 键壳 `WOW6432Node\…\netlm32` 残留** | **`UNSTAGED` + `SET_VALUE …\Wow6432Node\…\netlm32`** |
| W12 | `reg.exe add` HKCU（默认视图） | **新进程** | `null`（见缺陷 D4-R16-4） | 无残留 | `CREATE_KEY …\regexe` + `SET_VALUE R1` |
| W13 | `reg.exe add /reg:64` | 新进程 | `null` | 无残留 | `CREATE_KEY …\reg64` + `SET_VALUE R64` |
| **W14** | **`reg.exe add /reg:32`** | 新进程 | `null`（命令 exit=0） | **🔴 键壳 `…\reg32` 残留** | **`UNSTAGED` + `SET_VALUE HKCU\SOFTWARE\…\reg32`** |
| W15 | `reg.exe add` HKLM | 新进程 | `null` | 无残留 | `CREATE_KEY HKLM\SOFTWARE\<t>\regexe` + `SET_VALUE R2` |
| W16 | `reg import`（`.reg` 在 **TEMP**，UTF-16LE 232 B） | 新进程 | **失败** `exit=1 ERROR: Error opening the file…` | 无残留 | **无记录**（D4-R16-5） |
| W17 | `reg import`（`.reg` 在 **staged CWD**） | 新进程 | `null`，命令 `exit=0` | 无残留 | `CREATE_KEY …\imp2` + `SET_VALUE IV2` |
| W18 | COM `WScript.Shell.RegWrite` | 本进程 | `com-sz-r16` ✅ | 无残留 | `CREATE_KEY …\com` + `SET_VALUE 默认值` + `SET_VALUE CV` |
| W19 | PS `Remove-ItemProperty`（删 W02 值） | 本进程 | `null`（值已删） | 无残留 | `DELETE_VALUE …\ps PSZ` |
| W20 | PS 建键 + `Remove-Item` | 本进程 | 键已不存在 | 无残留 | `CREATE_KEY …\del` + `DELETE_KEY …\del` |
| W21 | PS `Set-ItemProperty` **真实已存在键** `HKCU:\Console` | 本进程 | `console-sz-r16` ✅ | 无残留（`HKCU\Console` 无该值） | `SET_VALUE HKCU\Console R16_<t>_CV` |
| W22 | PS `New-ItemProperty` **真实已存在键** `HKCU:\Environment` | 本进程 | `env-sz-r16` ✅ | 无残留 | `SET_VALUE HKCU\Environment R16_<t>_EV` |
| W23 | `reg.exe add` **真实已存在键** `…\Run` | 新进程 | `null` | 无残留（`Run` 仍只有原 1 值） | `SET_VALUE HKCU\SOFTWARE\…\Run R16_<t>_RV` |
| W24 | PS `New-Item` HKCR | 本进程 | `<key-exists>` | 无残留 | `CREATE_KEY HKCR\<t>_CLS` |
| stress | PS `New-ItemProperty`×50 + .NET `SetValue`×50 | 本进程 | `valueCount=100`（S00–S49 + D00–D49） | 无残留 | `SET_VALUE`×100 |
| xproc | `reg.exe query`×13（**新进程**读回） | 新进程 | **12/13 `rc=0`**（唯一失败 XP07 = W16 的 `imp\IV`，可归因） | — | — |

**小结（w1）**：(a) 侧 **24/25 通道报成功 + 压力 100/100**；(b) 侧**只有 3 条通道**（W08/W11/W14）在真实 hive 留键壳；
(c) 侧 **141 条 WAL，`problems=0`，`HARD_DENY=0`**。
即：**失败面几乎清零（只 W16），但"成功"里有 3 条是"真的动了真实盘"** —— 这正是 P0 的隐蔽性。

### 3.1 25 条通道里，哪些会留真实残留 `[实测]`

| 分类 | 通道 | 真实残留 |
|---|---|---|
| **会留（显式 32 位视图的创建类）** | `W08`（.NET CU `Registry32`）、`W11`（.NET LM `Registry32`）、`W14`（`reg /reg:32`）；w3 的 `A1/A2/A3`（只建键不写值）、`B1/B2/B3`（建键+写值） | **空壳键**（值在 overlay）；`HKLM` 侧落在 `WOW6432Node` |
| **会删（显式 32 位视图的删除类）** | `reg.exe delete … /reg:32`（w3 `D1`） | **真实键被真删**（D4-R16-2） |
| **不会留** | 默认/64 位视图的**全部**创建/写值/删除（`W01–W07, W09, W10, W12, W13, W15, W17–W24, stress`；w3 `C1/C2/C3`、`D2`） | 无（全部 STAGE） |
| **不产生任何记录** | `reg import`（TEMP 路径，`W16`） | 无（也没进 WAL） |

### 3.2 一致性压力 `[实测]`

| 量 | w1 | w2 |
|---|---|---|
| 重复写 | 100（PS×50 + .NET×50） | 100 |
| `reportedSuccess` | **100/100** | **100/100** |
| 同进程读回 | `valueCount=100` | `valueCount=100` |
| WAL `SET_VALUE` 对应 | 100 条 | 100 条 |
| 真实 hive | 无残留 | 无残留 |

（R11 里 R1"100/0 失败"的形态本轮未复现；本轮两个 run 都是干净起点，`preexist` 21/21 缺席自证。）

---

## 4. 判据"真实注册表零改动" —— **不成立**（本域核心 P0）

### 4.1 事实链（全部为宿主侧不受限读数）`[实测]`

| 时点 | 文件 | 读数 |
|---|---|---|
| 基线 | `host\baseline-pre.json` | `CLEAN`、`probeHitCount=0`、`HKCU_Software=17`、`Run_values=1` |
| 宿主对照（证明探针能写） | `host\post-smoke3.json` | `RESIDUE-FOUND`、`hitCount=7`、`HKCU_Software=18`、`Run_values=2` |
| 清理后 | `host\post-smoke3-clean.json` | `CLEAN`、`17` |
| **w1+w2（TS）之后** | `host\post-winstage-runs.json` | **`RESIDUE-FOUND`、`hitCount=4`**：`HKCU\Software\WinstageR16Probe_1f4f18`、`HKLM\SOFTWARE\WOW6432Node\WinstageR16Probe_1f4f18`、同 `_926116` 两键；`HKCU_Software=19` |
| 立即清理 | `host\cleanup-after-winstage.log` | `KEY_DELETED ×4`，4 根 `reg query /f … /k /s` 全 `rc=1 End of search: 0 match(es) found.` |
| 清理后 | `host\post-winstage-clean.json` | `CLEAN`、`17` |
| **w3（最小复现）之后** | `host\post-w3.json` + `host\leaked-keys-detail-w3.json` | **`RESIDUE-FOUND`、`hitCount=3`**：`HKCU\…_665a04{subs=shellA1,shellA3,shellB1,shellB3, vals=[]}`、`HKLM\SOFTWARE\WOW6432Node\…_665a04{subs=shellA2,shellB2, vals=[]}`、**`HKCU\…_7a5342` 已不存在（D1 真删）**；`…_bbea2c` 仍在（D2 对照） |
| 清理后 | `host\cleanup-after-w3.log` + `post-w3-clean.json` | `KEY_DELETED ×3`、`CLEAN`、`17` |
| **终局（含 platform 清理后）** | `host\final-audit.json` + `final-audit.log` | **`CLEAN`、`probeHitCount=0`、`sweepRc0=0`、`17/45/18/6/1` = 基线**；四个根枚举 `WinstageR16Probe*` **0 命中** |
| **收口复核（最终一次，12 token + WOW64 视图扫描）** | `host\closeout-audit.json` + `closeout-audit.log` | **`verdict=CLEAN`、`probeHitCount=0`、`sweepRc0=0`、`HKCU_Software=17 / HKLM_Uninstall=45 / Uninstall32=18 / HKU=6 / Run_values=1`（= 基线）**；`HKCU\Software`+`HKLM\SOFTWARE`+`WOW6432Node`+`HKCR` 枚举 `*WinstageR16Probe*` = **0**；`HKCU:\Console`/`Environment`/`Run` 上 `R16_*` 值 = **0/0/0**；历史遗留键 `WinstageOpenq0731wq4`(`P=z`) 仍在且未改 |

**清理前后各留原始读数**（协议硬判据）：已按要求完成，且**负对照**（宿主 smoke）能 FAIL、清理后能 CLEAN ⇒ 审计有判定力。

### 4.2 历史遗留键复验（task 项 5）`[实测]`

`HKCU\Software\WinstageOpenq0731wq4` **仍在**，`P=z`（`REG_SZ`）、无子键、值名 `P` 单一 ——
与 R10 `汇总报告.md:118`、R11 `Z7` 的记录一致（`state-after-platform.json`）。`LEGACYSCAN` 四个根只命中它一个。
**未删**（只报告；它不是本轮探针键）。

> 说明：R15 §5 提到的是"清理读数/凭据副本"清单，没有点名注册表遗留键；本域按 R10/R11 的确切键名做了复验，
> 并额外枚举 `*Winstage*`/`*WSP4T4*` 两个前缀（结果：仅该键）。

---

## 5. 审批候选：整条链路断掉（P0，D4-R16-3）

| 产物 | w1 | w2 | w3 | R11 run3（对照） |
|---|---|---|---|---|
| `candidates\*.json` | **1 个**：`cs_0001_4d06617b.json`，`source="shell"`，`changes=9`（文件） | 1 个 `source="shell"` | 1 个 `source="shell"` | 2 个：`shell` + **`registry-stage`** |
| 注册表候选 | **无** | **无** | **无** | `changes=2`，`summary={"keys":2,"values":0}` |
| `registry\host-capture.json` | **不存在** | **不存在** | **不存在** | 存在 `{"bytes":12312,"records":2,"enqueued":true,"candidateId":"cs_0002_…"}` |
| `queue.json` | `order=["cs_0001_…"]` | 同 | 同 | 含 `cs_0002_…` |
| WAL 记录 | 141（`SET_VALUE 120`） | 141 | 19 | 126 |
| 全 run 目录搜 `注册表捕获失败`/`注册表候选已冻结`/`no-wal` | **0 命中** | 0 命中 | 0 命中 | — |

⇒ 141 条 WAL（含 3 条真实键壳对应的 `UNSTAGED`）**一条都没变成候选**；用户点"批准全部"时注册表这次运行
**一条改动都不会被应用，也不会被看到**。接线存在（`shell-executor.mjs:1870` → `registry-capture.mjs:144`），
但 `host-capture.json` 缺失证明**一次都没走到 `:210 writeMarker()`**；四条早退分支（`:156/:158/:166/:170`）
**不打日志**，所以 headless 下不可归因 —— 这一点在缺陷里如实标为"未定死，附判别方法"（D4-R16-3）。

---

## 6. 对照：`platform` 模式（run-p1，`WINSTAGE_SHELL=0`）`[实测]`

| 判据 | winstage(TS) | **platform(p1)** |
|---|---|---|
| `sandbox-lane.json` | 存在（**TS**, `degraded=false`） | **不存在**（`lane.txt` → `lane_file=(missing)`，`LANE_OK=false`，按协议只作对照） |
| 线程 shell cwd | `<stageRoot>\staged`（暂存树） | **真实工作区** `run-p1\ws` |
| 探针读数 | 读 9/9、写 24/25、压力 100/100、跨进程 12/13 | 读 **9/9**、写 **25/25**、压力 **100/100**、跨进程 **13/13** |
| 探针输出落点 | 暂存树 `staged\probe-reg16-out.json` | **真实盘** `run-p1\ws\probe-reg16-out.json`（21397 B）+ `r16-544a38-imp2.reg` |
| `registry\overlay.journal` | 18732 B / 141 条 | **不存在**（`stage-root-inventory.txt` 只有 2 个 staged 文件） |
| **真实 hive** | 默认视图写**零残留**；32 位视图写**留键壳** | **4 键 + 3 值全部真实存在**：`HKCU\Software\WinstageR16Probe_544a38`（11 子键含 `stress`）、`HKLM\SOFTWARE\…544a38`、`HKLM\SOFTWARE\WOW6432Node\…544a38`、`HKCR\…544a38_CLS`、`HKCU\Console :: R16_544a38_CV`、`HKCU\Environment :: R16_544a38_EV`、`HKCU\…\Run :: R16_544a38_RV`；`HKCU_Software 17→18`、`Run_values 1→2` |
| 清理 | — | `cleanup-after-platform.log`：`KEY_DELETED ×4` + `VAL_DELETED ×3` + 4 根 `0 match`；`final-audit.json` = `CLEAN` |

⇒ **同一批 25+100 条写**：`platform` 全部落真实 hive；`winstage(TS)` 的默认视图全部落 overlay
（除 W16），32 位视图的键创建/删除则**透传到真实 hive**。
**「对照 run 的残留已清理」**：`final-audit.json` `CLEAN`、`probeHitCount=0`、四个根枚举 0 命中，
`HKCU_Software` 回到基线 `17` ⇒ **对照 run 的残留已全部清理完毕**。

---

## 7. 与 R11 同域结论的对照（复现 / 已修 / 变化）

| R11 结论 | R16 状态 | 证据 |
|---|---|---|
| 写面 13/20 成功、`SET_VALUE 109`、`HARD_DENY 0` | **改善** | w1/w2 各 **24/25**（唯一失败是 W16）+ 压力 100/100；`SET_VALUE 120`、`HARD_DENY 0` |
| **D4-R1** 候选 `values=0`（有键无值） | **恶化** | R16 **连 `registry-stage` 候选都没有**，`host-capture.json` 不存在（§5） |
| **D4-R2** 写"真实已存在键" ⇒ 内核硬拒 + WAL 零记录 | **已修（不再复现）** | `W21/W22/W23` 全部 `STAGE` 成功（WAL `#37/#38/#39`），真实 hive 无值 ⇒ 该缺陷**方向已反转** |
| **D4-R3(a)** 32 位视图透传后必被 ACL 拒（"对照不可用"） | **质变为 P0** | R16 同样透传，但**真实写入成功**（w1/w2/w3）；不再是"不可用"，而是**改真实盘**。差异原因见 O3（同分支、令牌/ACL 环境不同） |
| **D4-R3(b)** WMI 绕过注入链 | **not-run** | 本轮未构造 WMI 通道（探针未含 `StdRegProv`） |
| **D4-R4** `reg import` 打不开 `.reg` | **复现并细化** | 仅 **TEMP 路径**失败（100% 复现）；同一脚本从 **staged CWD** 导入成功（`W17`）⇒ D4-R16-5 |
| **D4-R5** 共享 hive 不可用 → 逐进程 hive，靠 journal 重放 | **部分复现 + 新面** | 暂存根仍有 `overlay.<pid>.hive`（w1 `overlay.11912.hive` 等）；新增"**子进程 reg.exe 写、本进程读回为 null**"（D4-R16-4） |
| **D4-R6** 候选 warning 中文乱码 | **not-run** | 本轮无注册表候选（无观测对象） |
| **D4-R7** `lane.txt` 假红 | **未复现** | 三个 run `lane.txt` 与 raw `sandbox-lane.json` 一致 |
| R11 §9 `reg import` 换通道可行性 | **已补跑** | `W17`（staged CWD）成功 ⇒ 该 not-run 项本轮结清 |
| R11 §9 "重启后白障/多会话并发" 等 | **仍 not-run** | 见 §8 |

---

## 8. not-run / 诚实边界

1. **`apply()` / `discard()` 的真实副作用**：`not-run`（刻意不触发；`overlay.state.json` 未出现在本轮产物里）。
2. **WMI `StdRegProv`（R11 D4-R3b）**：`not-run`（探针未含该通道）。
3. **`RegLoadAppKey` / `REG_OPTION_VOLATILE` / `RegSetKeySecurity` / `REG_OPTION_CREATE_LINK`**：`not-run`。
4. **重启后 WAL 重放（白障门槛）**：`not-run`。
5. **多会话并发写同一键**：`not-run`（w1/w2 是并行启动但各自独立暂存根、不同 token；**未做同键竞争**）。
6. **D4-R16-3 的具体早退分支**（`no-wal` vs `construct/freeze-failed`）：**未定死**（headless 两条路径都不可观测），
   缺陷里给了判别方法。
7. **R11 D4-R6（warning 乱码）**：`not-run`（无候选样本）。
8. **修复后回归**：本轮**不许改源码/不换件**（Lead 指令），因此"建议补丁是否能让 lane 仍为 TS + 真实盘零改动"**未验证**。
9. **A 变体（`RegCreateKeyExA`/`RegSetValueExA`）**：`not-run`（探针走了 W 变体与 .NET/COM/reg.exe 通道）。
10. **是否还有其他"透传即真副作用"的 API**（如 `RegRestoreKey`、`RegSaveKey`）：`not-run`（只做了 `RegDeleteKeyEx` 一条同族实证）。

---

## 9. 证据索引

| 路径 | 内容 |
|---|---|
| `.t\r16\registry\host\tokens.json` | 12 个唯一 token（w1/w2/p1/m1/v32/v64 + 4 个宿主对照）；**不含任何真实键名** |
| `.t\r16\registry\host\{baseline-pre,post-smoke3,post-smoke3-clean,post-winstage-runs,post-winstage-clean,post-w3,post-w3-clean,post-platform,final-audit}.json` + `.log` | 真实 hive 快照链（**清理前后各留读数**） |
| `.t\r16\registry\host\leaked-keys-detail.json`、`leaked-keys-detail-w3.json` | P0 残留键的逐值/逐子键明细 |
| `.t\r16\registry\host\platform-real-writes-detail.json` | platform 对照的真实写入明细（清理前） |
| `.t\r16\registry\host\{cleanup-after-winstage,cleanup-after-w3,cleanup-after-platform,cleanup-min-smoke}.log` | 清理动作 + 4 根复扫（全 `0 match`） |
| `.t\r16\registry\host\{regstate.ps1,cleanup-r16.ps1,decode-journal.mjs,analyze-run.mjs}` | 可复跑判据工具（含负对照自证） |
| `.t\r16\registry\host\smoke\{smoke1…3}.log`、`min-smoke.log`、`probe-reg16*-out.json` | 宿主（无沙箱）对照：证明探针有判定力 |
| `.t\r16\registry\payload\{probe-reg16.ps1,probe-reg16-min.ps1}` | 沙箱内探针（同步副本在各 run 的 `ws\`） |
| `.t\r16\registry\run-w1\**`、`run-w2\**`、`run-w3\**` | 主证据（`out\stdout.ndjson / stderr(0B) / exitcode / lane.txt / stage-root-path.txt / summary.json / analyze.txt / wal-decoded.json`） |
| `.t\r16\registry\run-w3\wal-decoded.json` | **最小复现的 19 条 WAL 逐条**（`UNSTAGED` vs `CREATE_KEY` 对照） |
| `.t\r16\registry\run-p1\**` | platform 对照（真实工作区 4 文件、无 journal、无 lane） |

### 复现（PowerShell，逐条可重跑）

```powershell
$r='C:\Users\Administrator\Desktop\dsh-winstage-sandbox'; $reg="$r\.t\r16\registry"
# 0) 基线（应为 CLEAN）—— 注意 token 从 tokens.json 读，勿硬编码
$t = Get-Content "$reg\host\tokens.json" -Raw | ConvertFrom-Json
$all = "$($t.w1),$($t.w2),$($t.p1),$($t.m1),$($t.v32),$($t.v64)"
powershell -NoProfile -ExecutionPolicy Bypass -File "$reg\host\regstate.ps1" -Out "$reg\host\repro-baseline.json" -Label repro -Tokens $all
# 1) 最小复现（先真实预建两个 victim 键，再起 TS run）
New-Item "HKCU:\Software\WinstageR16Probe_$($t.v32)" -Force | Out-Null
New-ItemProperty "HKCU:\Software\WinstageR16Probe_$($t.v32)" -Name Pre -Value 1 -Force | Out-Null
cmd /c "$r\docs\round10\env\scripts\sbx-thread.cmd" "$reg\run-w3\ws" "$reg\run-w3\prompt.txt" "$reg\run-w3\out" winstage
# 2) 宿主侧复核（不受限）：32 位视图用例应有键壳、默认视图用例应无、victim32 应消失
powershell -NoProfile -ExecutionPolicy Bypass -File "$reg\host\regstate.ps1" -Out "$reg\host\repro-after.json" -Label after -Tokens $all
# 3) 解码 WAL（应看到 UNSTAGED 与 CREATE_KEY 的对照）
node "$reg\host\decode-journal.mjs" "$(Get-Content "$reg\run-w3\out\stage-root-path.txt")\registry\overlay.journal" --selftest
# 4) 清理并复扫（终态必须 CLEAN）
powershell -NoProfile -ExecutionPolicy Bypass -File "$reg\host\cleanup-r16.ps1" -Tokens $all -Log "$reg\host\repro-cleanup.log"
```

### 源码指针（只读分析，未构建）

* `shim/src/ws_reg.c:528-551` `ws_create_key_inner()` —— **32 位视图创建被透传（P0 根因）**；
  对比 `ws_reg.c:445-479` `ws_create_key_open_only()` 的"纯开"守卫。
* `shim/src/ws_reg.c:233-249` `ws_reg_wow64_unrepresentable()` —— 判定"overlay 无法表示该视图"。
* `shim/src/ws_reg.c:881` `ws_set_value_ex_inner()` —— `samDesired` 硬编码 0 ⇒ 值被 STAGE（分叉的另一半）。
* `shim/src/ws_reg.c:1430-1450` `ws_delete_key_inner()` —— **32 位视图删除被透传（P0 同族）**。
* `dsh-plugin/shell-executor.mjs:1870` → `dsh-plugin/registry-capture.mjs:144/156/158/166/170/187/197/210` —— 候选链路。
