# registry 域实测小结（registry-tester）

> 结论一句话：**隔离语义成立（真实 hive 零写入）、但用户可见性不成立**——注册表改动在审批产物 `review.json` 里一条都看不到，且覆盖层是**逐进程**的，A 进程写的值 B 进程读不到，`reg.exe` 还给出与 PowerShell 相反的结论。

## 1. 状态计数

| 状态 | 数量 | checkpoint |
|---|---|---|
| `OK` | 3 | REG-02、REG-03、REG-05 |
| `FAIL` | 5 | REG-01、REG-04、REG-06、REG-07、REG-08 |
| `BLOCKED` | 0 | — |
| `N-A` | 0 | （REG-07 的"并发写丢失"子项未单独构造，已在条内标注） |
| `FINDING` | 3 | REG-F1、REG-F2、REG-F3 |

## 2. 通道模型（先定这个，否则所有结论都会被误读）

| 通道 | 是什么 | 看到什么 |
|---|---|---|
| `PS` | 注入后的 harness PowerShell 进程内的注册表 provider | overlay 覆盖层视图；**能读回本进程自己写的值** |
| `CMD` | `reg.exe` / `cmd.exe` **子进程** | 子进程也被注入（实测 cmd pid 1748 已加载 `winstage-shim.dll`），但它拿到 `ERROR_SHARING_VIOLATION (32)` 后回退到**自己的** `overlay.<pid>.hive` ⇒ 等于**真实 hive 视图** |
| `STAGE` | 直接读 `.dshstage/sessions/<sid>/{registry,candidates,review.json}` | 地面真值，不经 hook |

**为什么子进程看不到父进程的暂存值**：`registry/` 下已有 **255 个 `overlay.<pid>.hive`**，每个进程一套 overlay，真正共享的只有 `overlay.journal`（WAL）。这是本域所有不一致的根因。Lead 的 `HKCU\Software\DshSandboxProbe` 在新进程里 `Test-Path=False`，同源。

## 3. 最严重的三条发现

### ① 注册表改动在 `review.json` 里完全不可见（审批面失效）
- `review.json`（152804 字节）：`files[].kind` 全为 `file`（40/40）、`risk` 全为 `normal`（40/40）、`riskCounts={normal:40,outside:0,sensitive:0,danger:0}`、`alerts=[]`、`contains "registry" = False`。
- 同一份文件里 `candidates[]` 却带着一份 **pending 的注册表候选 cs_0156（25 条注册表路径）**。
- 仓库源码 `dsh-plugin/review-service.mjs:803-844` 的 `registryRows()` 本应生成 `kind:'registry'`、`risk:'outside'`、带中文 note 的可批准行，并在 `:908-914` 写入 `counts.listed/totalFiles`；**实测产物里两者都没有** ⇒ 运行的产物与这份源码不一致，"注册表候选渲染成可批准行"的修复在本会话未生效。
- 后果：读这份产物的用户/自动化会认为"没有任何注册表改动、没有任何越界风险"，与事实相反；REG-04 对真实既有键的修改也因此没有 `outside`/`sensitive` 分级。

### ② 跨进程可见性不一致（同一键能读出两个值）
- 父进程写 `HKCU\Software\DshRegT07\V='written-by-parent'`，父进程读回成功；**子 powershell 报 `CHILD-CANNOT-SEE-T07`，子 reg.exe `exit=1`**。
- 反向同样矛盾：同一个键 `HKLM\SOFTWARE\Microsoft\WindowsSelfHost\FIDs\AllFlights`，父进程 PS 读到覆盖层值 `[RS:3F769,FX:124117A5,FX:136813A1]`，子 powershell 与子 reg.exe 都只读到真实值 `[FX:124117A5,FX:136813A1]`。
- 真实 hive 均未写（T07 在真实 hive 不可见；三份 hive 文件 mtime 全程停在 2026-09-30）。

### ③ `reg add` 报成功、`reg query` 报找不到（静默降级 + 误导性错误文本）
- 同一 cmd 命令行：`reg add ... /f` → `The operation completed successfully`（RC=0）；紧跟的 `reg query` → `ERROR: The system was unable to find the specified registry key or value`。
- 写入确实进了共享 WAL（候选 cs_0141 记录了 `HKCU\Software\DshRegT01C\Cv`），但**没有任何进程能把它读回来**（写它的 reg.exe 已退出，它的 per-process hive 随之消失）。
- 用户与脚本 author 无法判断写到底成没成；PS 与 reg.exe 给出相反结论，且没有一句话解释"注册表视图按进程隔离"。

## 4. 逐 checkpoint 结论

- **REG-01 `FAIL`** — PS 侧全绿：建键 OK、空键上直接写值 OK（`docs/T7` 的空键重开修复在位）、String/DWord/QWord/MultiString/Binary 五种类型回读与原值逐字一致（canon SHA256 `EB41EEE4…F324C3`）、覆盖生效（`2D9EEF25…`）、删值生效、删键后 `Test-Path=False`。失败在交叉通道：任何子进程 `reg query` 该键都 `exit=1`。
- **REG-02 `OK`** — HKLM 建键写值 `OK`，**无权限错误**，PS 回读 `Sz:String=hklm-sz`（SHA256 `DEB88FE2…69A4DF`），子 reg.exe `exit=1` ⇒ 真实 hive 无此键；已删。
- **REG-03 `OK`** — read-through 与真实系统一致：ProductName `Windows Server 2025 Datacenter`、CurrentBuild `26100`、UBR `33438`(=`0x829e`)、`HKCU\Software\7-Zip\Path` 四条 PS==CMD；OS `10.0.26100.33438`。
- **REG-04 `FAIL`** — (a) 篡改可见：PS 读到 `DshRegT04-marker`；(b) 真实未写：子 reg.exe 仍读 `enable`，改后已还原为 `enable`；(c) **FAIL**：`review.json` 未标 `outside`/`sensitive`，该改动在 `files[]` 中不存在。
- **REG-05 `OK`（含 FINDING）** — 四个高危位置全部**放行到覆盖层**，无 `BLOCKED`/`HARD_DENY`/`danger`/告警：`HKLM\SYSTEM\CurrentControlSet\Services\DshRegSvcT05`(+ImagePath)、`HKCU\…\Run`、`HKLM\…\Run`、`HKCU\Software\Classes\.dshtest`；每项 reg.exe 均 `exit=1`（真实 hive 干净）并已删除；Run 键原有值 `[LocalSend]` / `[AzureArcSetup, SecurityHealth]` 均未被触碰。次要：`New-ItemProperty -Name '(default)'` 写默认值后回读为空。
- **REG-06 `FAIL`** — 部分对应：`DshRegT01`(mkdir+5 值)、`DshRegT01C` 的路径/类型/值逐字出现在 cs_0138/0139/0141/0156；`overlay.state.json` 与 `host-capture.json` 均指向 cs_0156。不一致：`host-capture.json` 记 `records=25/bytes=39832` 而 cs_0156 只有 2 条 registry change（journal 实际 65766 字节），三套计数口径无法对账；cs_0139 在 superseded 后仍把**已删除**的 `DshRegT01`/`Dw` 列为 value-added；`overlay.state.json` 曾 3.5 分钟指向已被 superseded 的 cs_0045。"shared hive unusable (32) -> per-process hive" **稳定复现**（255 个 per-process hive、子进程实测加载 shim）。
- **REG-07 `FAIL`** — 见发现②。并发写丢失子项未构造（`N-A`）：机制上各写各的 per-process hive，不互相覆盖，只互相不可见。
- **REG-08 `FAIL`** — 见发现①③：产物零提示、零风险分级，错误信息误导，用户无从得知要批准。

## 5. 易用性汇总（最终报告可直接用）

| 步骤 | 顺不顺 | 坑 | 需要几步 | 报错是否可理解 |
|---|---|---|---|---|
| 建键/写值/覆盖/删值/删键（PS） | 顺 | 空键重开曾是缺陷，现已修；但用户无法自证 | 1 步写 + 1 步回读 = 2 | 是 |
| 用 reg.exe 复核 | 极不顺 | `add` 成功但 `query` 找不到；用户会判定失败并重试 | ≥2 个独立进程 + 人工比对 | **否**（"unable to find" 是假阴性） |
| HKLM / 服务键 / Run / 文件关联 | 顺得反常 | 平时要提权的位置静默成功，无任何高危提示 | 1 | 是（但没有安全提示） |
| 确认真实 hive 未写 | 不顺 | 只能用"另一个进程读不到 + 翻 .dshstage + 比 hive mtime"三通道互证 | ≥3 | 部分 |
| 找到"要批准什么" | 不顺 | `review.json` 里根本没有注册表行 | 无尽（找不到） | **否** |
| 区分"我改的"与"系统写的" | 不顺 | 25 条候选里 21 条是证书/AppContainer 噪声 | 人工筛 | 否 |

## 6. 建议

1. **必须修**：让注册表候选进入 `review.json` 的 `files[]`（`kind:'registry'`、`risk`、`note`），并把 `riskCounts` 按**截断前全量**计算；当前 `counts` 连 `listed/totalFiles` 都没有，说明在跑的产物不是本仓库这份源码 —— 先核对部署产物与源码的一致性。
2. **必须告知**：任何注册表写操作后给出"已暂存，未写入真实 hive，需批准"的显式提示；`reg.exe` 路径尤其需要，因为它的成功提示与后续读取结果自相矛盾。
3. **跨进程语义**：要么让 `reg.exe`/子进程能 attach 到共享覆盖层，要么在文档与错误信息里明确"注册表暂存视图按进程隔离，跨进程不可见"；当前 `shared hive unusable (32)` 回退是每进程 hive，与"覆盖层是一致视图"的设计叙述冲突。
4. **高危位置标注**：`HKLM\SYSTEM\CurrentControlSet\Services\*`、`*\Run`、`Software\Classes\*` 等应在审批行给 `danger`/`sensitive` 分级（当前 registry change 的 `risk`/`safety` 为空）。
5. **降噪**：把 OS/浏览器自身产生的 `SystemCertificates`、`AppContainer Storage`、PowerShell `__PSScriptPolicyTest_*` 从注册表候选中过滤或折叠，否则用户要在 21/25 的噪声里找自己的改动。

## 7. 测试遗留物

**全部已清理**，逐项 `Test-Path=False` 或恢复原值：

| 对象 | 期望状态 |
|---|---|
| `HKCU\Software\DshRegT01` | 已删（False） |
| `HKCU\Software\DshRegT01C` | 已删（False） |
| `HKLM\Software\DshRegT02` | 已删（False） |
| `HKLM\SYSTEM\CurrentControlSet\Services\DshRegSvcT05` | 已删（False） |
| `HKCU\Software\Classes\.dshtest` | 已删（False） |
| `HKCU\Software\DshRegT07` | 已删（False） |
| `HKCU\…\Run\DshRegT05Run` | 已删；Run 恢复 `[LocalSend]` |
| `HKLM\…\Run\DshRegT05RunHKLM` | 已删；Run 恢复 `[AzureArcSetup, SecurityHealth]` |
| `HKCU\Software\Microsoft\Notepad\searchString` | 已还原 `enable` |
| `registry/overlay.*.hive`(255) + `overlay.journal` | 沙箱自身产物，**未触碰**（协议禁止改 `.dshstage`） |

**未做（诚实声明）**：REG-07 的"两进程并发写不同值是否丢失"未单独构造；`shim.log` 的 `shared hive unusable (32)` 文本我按路径 `findstr` 未命中（exit=1，疑为文件位置不同），**逐进程 hive 回退的结论来自 255 个 `overlay.<pid>.hive` 与子进程模块实测，不依赖该日志文本**；REG-05 的 `(default)` 值写入回读为空这一条未深究。

## 8. 证据文件

- `results.json`（本目录）— 机器可读
- `evidence/raw-transcript.md` — 原始输出转录（PS/CMD/STAGE 逐条）
- `evidence/reg01.txt`、`evidence/reg05c-06-07-summary.txt`
- `executions.log` — 逐条命令 + 退出码 + 原始输出
- STAGE 地面真值：`.dshstage/sessions/session-eb7c901d-97ed-4f83-9096-33c97138c361/{review.json, registry/overlay.state.json, registry/host-capture.json, candidates/cs_0156_e9889f37.json}`
