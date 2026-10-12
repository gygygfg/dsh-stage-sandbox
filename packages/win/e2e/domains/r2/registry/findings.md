# registry 域实测小结（r2 · registry 测试线程）

> **一句话结论**：本轮 **真实注册表一个字节都没被改**，但原因与上一轮不同——不是 WinStage 的 overlay 隔离生效，而是这个测试线程拿到的执行环境是**未提权、未注入 shim** 的 `powershell.exe 5.1`，**所有注册表写操作被 fail-closed 直接拒绝**，overlay 层自 17:47 起已经完全僵死（13 个 8 KB 空 hive、journal 冻结）。因此**本域的核心命题（跨进程可见性 / 隔离语义）在本轮无法被有效测量**，这本身是最高价值的发现。

---

## 0. 先纠正一个契约级前提（否则后面每条结论都会被误读）

PROTOCOL §2/§3 假定：「shim 仍然生效，PS/CMD 通道被 hook，HOST 通道用 `WINSTAGE_SHIM_DISABLE=1` 的子进程」。**本线程实测该前提不成立。**

| 契约要求 | 本线程实测 | 证据 |
|---|---|---|
| shell 是 `pwsh` | **`pwsh.exe` 未安装**；实际是 `powershell.exe` 5.1.26100.33438 | `Get-Command pwsh` → not found；`C:\Program Files\PowerShell` 不存在 |
| 进程被注入 `winstage-shim.dll` | **未注入**（进程模块里没有任何 shim 模块） | `(Get-Process -Id $PID).Modules \| ? ModuleName -like '*shim*'` → 空 |
| `$env:WINSTAGE_STAGE_ROOT` 等可用 | **全部为空**（`WINSTAGE_STAGE_ROOT`/`DSH_REGSTAGE_ROOT`/`WINSTAGE_SHIM_LOG`/`WINSTAGE_SHIM_CONFIG`/`WINSTAGE_SHIM_DISABLE` 都不存在） | `[Environment]::GetEnvironmentVariable(...)` → NULL |
| `$env:DSH_SESSION_ID` = 本会话 | **=`301dd4ca-1aff-49a7-a12c-ff915c9e9384`**，而被测会话是 `session-4c5d9889-…` | 环境变量 dump |
| 可以起子进程（CMD / HOST 通道） | **进程创建被完全禁止**（`reg.exe`/`cmd.exe`/`whoami.exe`/`hostname.exe`/`where.exe` 全部 `Access is denied`） | 见 §3 |
| PS 可以写文件 | **写文件也被拒绝**（工作区、`C:\Windows\Temp`、桌面、`.dsh` 全部 `UnauthorizedAccessException`）；只有 `write` 工具（DSH 宿主，已提权）能写 | 见 §3 |

**后果**：`PS` 通道（只能读）、`CMD` 通道（不存在）、`HOST` 通道（不存在）。三通道取证在本域退化为「PS 只读 + STAGE 静态 + 宿主 write 工具」。

---

## 1. 状态计数

| 状态 | 数量 | checkpoint |
|---|---|---|
| `OK` | 1 | REG-07（真实注册表零改动，但归因是 fail-closed） |
| `FAIL` | 4 | REG-01、REG-02、REG-08、REG-10 |
| `BLOCKED` | 5 | REG-03、REG-04、REG-05、REG-06、REG-09 |
| `N-A` | 0 | — |
| `FINDING` | 5 | REG-F1…F4（F 系列 4 条 + REG-10 单列） |

---

## 2. 最严重的发现

### ① 真实注册表零改动 ✅，但**不是隔离生效**（归因纠正，最重要）
- `C:\Users\Administrator\NTUSER.DAT`（真实 HKCU hive）`size=1310720`、**`mtime=2026-09-30T11:23:39`** —— 比本轮全部测试活动（`2026-10-03 18:00–19:38`）早 **3 天**。任何真实的 HKCU 提交都会改动这个 mtime。**没动。**
- STAGE 侧：`overlay.journal`（2626 B）mtime **冻结在 `2026-10-03T17:47:18`**，共享 `overlay.hive` 冻结在 `17:40:33`，**13 个 `overlay.<pid>.hive` 全部恰好 8192 字节**（只有文件头、无任何 cell）。对全部 13 个 hive 做二进制扫描：`HKCU/HKLM/Software/WinStageR2` 命中 **0 次**。
- 产物侧：`review.json`(379687 B) / `queue.json` / `manifest.json` 中 `WinStageR2` 出现 **0 次**。
- 所有写入尝试从 18:19 起都是**显式拒绝**（原始异常文本见 §4）。

> **结论**：真实 hive 未被写入 = TRUE。但**写入根本没到达 overlay 层**（journal 一个字节都没涨），所以「隔离」没有被真正行使；这是 **fail-closed 拒绝**，不是 staging 隔离。**不能**据此说「WinStage 注册表隔离通过」。

### ② `review.json` 的注册表行仍然是 0 条，且出现自相矛盾（复制了上一轮缺陷）
`generatedAt=2026-10-03T11:30:46Z`、`candidateId=cs_0093_5d41b679`、`revision=4628`、`truncated=true`。

| 字段 | 值 |
|---|---|
| `counts` | `files=2873, listed=40, totalFiles=2873` |
| `riskCounts` | `normal=2857, **outside=15, sensitive=1**, danger=0` |
| `alerts` | **`[]`（空）** |
| `files[]` 长度 | 40，**`kind` 全部 = `file`（40/40），`risk` 全部 = `normal`（40/40）** |
| 全文正则 | `"kind"` 值只有 `file=40`；`"risk"` 值只有 `normal=40`；`HKCU` 出现 14 次但**只出现在 `candidates[]` 里** |

而 `candidates[]` 里**明明有一个纯注册表候选**：`cs_0045_61ebdd8a`（`pending`，14 条注册表路径：`HKCU\Software\Python`、`…\Python\Astral`、`…\CPython3.12.14\InstallPath` 等）。第二个候选项 `cs_0093_5d41b679` 是 2859 条文件路径、注册表路径 0 条。

**三处自相矛盾**（这是本轮新证据）：
1. `riskCounts` 声明 `outside=15 + sensitive=1`，但 `files[]` 里 **0 条** outside/sensitive（40/40 normal）⇒ 声明的风险在已发布行里**无法对账**；
2. `riskCounts` 非零而 `alerts` 为空；
3. `listed=40` / `totalFiles=2873` 且 `truncated=true` ⇒ 用户只看到 2873 条里的 40 条，**没有任何路径**能从 `outside=15` 走到具体条目。

> 后果与上一轮一致：读这份审批产物的人/自动化会得出「没有任何注册表改动、没有越界风险」，与候选列表自身矛盾。**REG-08 复现，且证据更强。**

### ③ `overlay` 层已经僵死 ~1h44m，而注入与文件 staging 仍在继续
- registry overlay：journal 2626 B 冻结 `17:47:18`，13 个 8 KB 空 hive。
- 同期文件侧仍活着：`staged\` 下 `2026-10-03T18:10:42–18:10:46` 共新增 **26 个 `.winstage-inject-*.json`**（全部 `"ok":true, dll=…winstage-shim.dll, remoteModule=0x53030000`），`shim.log` 增长到 229579 B（mtime `18:15:27`）。
- 也就是说：**shim 注入正常、文件 staging 正常，注册表 staging 死了**。配上 `failClosed=true`，结果就是 §4 的全面拒绝。

### ④ 同一个 API 在同一会话里先成功后失败（不可判定性）
- `~18:00`：`New-Item HKCU:\Software\WinStageR2Test` **成功**，6 个类型值（Sz/Dw/Qw/Bin/Multi/Exp）全部写入并回读正确。
- `18:19` 与 `18:36+`：**同一条命令** → `System.UnauthorizedAccessException: Access to the registry key 'HKEY_CURRENT_USER\Software\WinStageR2Test' is denied.`
- 且 19:31 的进程里 `Test-Path` 该键 = **False**（18:00 那个进程写的键，后续进程看不见）⇒ 与上一轮「逐进程 overlay」结论**同向**，但本轮只能给出**同一会话内两个独立进程之间**的互不可见，**拿不到父/子进程的直接对照**（子进程起不来）。

---

## 3. 为什么 CMD / HOST 通道不存在（原始错误）

```
Program 'reg.exe' failed to run: Access is denied
Program 'cmd.exe' failed to run: Access is denied
Program 'whoami.exe' failed to run: Access is denied
Program 'hostname.exe' failed to run: Access is denied
```
用 `System.Diagnostics.ProcessStartInfo` + 重定向 stdio 也失败：
```
Exception calling "Start" with "1" argument(s): "Access is denied"
```
**危险点**：`reg.exe` 起不来时 `$LASTEXITCODE` 返回**空值**（`$null`）而不是非零，输出为空 ⇒ 脚本无法区分「命令失败」和「命令根本没跑」。**静默降级的典型形态。**

写文件同样被拒（`write` 工具正常，因为 DSH 宿主进程是提权的）：
```
Set-Content C:\Windows\Temp\r2reg-probe.txt  -> UnauthorizedAccessException: Access is denied
Set-Content …\r2\registry\wtest.txt          -> UnauthorizedAccessException: Access is denied
Set-Content C:\Users\Administrator\.dsh\…    -> UnauthorizedAccessException: Access is denied
```

身份与执行策略：
```
identity = WIN-DV9KRECLBVS\Administrator, IsSystem=False, token=2364
groups   = None ; Everyone ; BUILTIN\Users ; INTERACTIVE ; CONSOLE LOGON ; Authenticated Users …
           ← 没有 Administrators（被过滤掉的未提权 token）
Get-ExecutionPolicy LocalMachine = RemoteSigned  （.ps1 直接执行报 "not digitally signed"，只能 Get-Content -Raw | Invoke-Expression）
```

---

## 4. 逐 checkpoint

| ID | 状态 | 通道 | 关键观察 |
|---|---|---|---|
| **REG-01** | `FAIL` | PS | 同一会话同一命令**先成功后 Access denied**；6 种类型值在 18:00 那次全部回读正确；`HKCU\Software\WinStageR2SingleTest`、`HKCU\Software\Microsoft\WinStageR2Test` 同样被拒。真实 `NTUSER.DAT` mtime 未变。**用户无法判断写是进了 overlay 还是真 hive。** |
| **REG-02** | `FAIL` | PS/STAGE | 18:00 的进程能写能读；18:19 的进程对**同一个键**报 Access denied；19:31 的进程 `Test-Path=False` ⇒ 进程间互不可见（同向复现上一轮）。`reg.exe` 侧完全无法验证。STAGE：13 个 `overlay.<pid>.hive`（pid=2476,3536,5168,5292,6068,6740,8552,8768,11072,11252,11712,12008,13064），**全部 8192 B**，0/13 含路径字符串。 |
| **REG-03** | `BLOCKED` | PS | `HKLM\SOFTWARE\WinStageR2Test` → `UnauthorizedAccessException: Access to the registry key HKEY_LOCAL_MACHINE\SOFTWARE\WinStageR2Test is denied.`；`HKLM\SYSTEM\CurrentControlSet\Services\WinStageR2Svc` → 同样 denied。**未读取、未修改任何既有服务的 Start 值。** |
| **REG-04** | `BLOCKED` | PS/CMD | 类型写入仅 18:00 成功过一次（REG_SZ/EXPAND_SZ/DWORD/QWORD/BINARY/MULTI_SZ 均正确）；此后全拒。`reg copy/export/import/delete /f/add /f` **无法运行**（进程创建被拒）。 |
| **REG-05** | `BLOCKED` | PS/STAGE | Run 键写入被拒，异常类不同：`System.Security.SecurityException: Requested registry access is not allowed.`（其他键是 UnauthorizedAccessException）⇒ Run 路径额外受保护。**未留下任何自启动项**（`WinStageR2Probe` 在所有产物中出现 0 次）。风险分级因此**无法通过实写评估**。 |
| **REG-06** | `BLOCKED` | PS/CMD | `HKLM\SOFTWARE\WOW6432Node\WinStageR2Test` → denied；`/reg:32` vs `/reg:64` 对比**无法运行**。 |
| **REG-07** | `OK` | HOST/STAGE | **真实注册表未改**，8 条写入路径逐条列表见 `results.json` 的 `writePathTable`；依据 = NTUSER.DAT mtime + 13 个空 hive + journal 冻结 + 产物 0 命中 + 全部显式拒绝。**归因：fail-closed，不是 overlay 隔离。** |
| **REG-08** | `FAIL` | STAGE | 见 §2②。注册表行 **0 条**；`riskCounts(outside=15,sensitive=1)` 与 `files[](40/40 normal)` **矛盾**；`alerts=[]`。 |
| **REG-09** | `BLOCKED` | HOST | 逃生开关**不可达**：`WINSTAGE_SHIM_DISABLE` 在活进程里**根本不存在**（没有 shim 可禁用），且 `reg.exe` 起不来 ⇒ 既不能改真 hive 也不能删。**未能确证逃生开关**；这是**证据链缺口**，不是已证实的逃逸。 |
| **REG-10** | `FINDING` | PS/STAGE/HOST | 回答「我的注册表改动生效了吗」需要 **4 条通道 ≈ 10 条命令**，且要看懂 `.dshstage` 内部布局；错误文本三种口径不一致（denied / not allowed / does not exist），`reg.exe` 失败还给出**空退出码**。 |

---

## 5. 易用性（硬性要求）

| 问题 | 顺不顺 | 坑 | 需要几步 | 报错可理解？ |
|---|---|---|---|---|
| 写一个 HKCU 值并确认生效 | **极不顺** | 同一命令先成功后 Access denied；**成功的写与暂存的写外观完全一样**，没有任何「已暂存/需批准」提示 | 无法确定 | **否** |
| 用 `reg.exe` 复核 | **不可能** | `reg.exe` 起不来；`$LASTEXITCODE` 是**空值**，脚本会误判成功 | ∞ | **否**（完全没有错误码） |
| 确认真实 hive 未写 | 不顺 | 只能靠 `NTUSER.DAT` mtime + 逐字节翻 13 个 hive + 解析 review.json | ≥4 通道 / ~10 命令 | 部分 |
| 找到「要批准什么」 | **不可能** | `files[]` 里没有注册表行，而 `riskCounts` 又说有 15 outside + 1 sensitive，指向不存在的行 | ∞ | **否** |
| 判断「我是被拒绝还是没权限」 | 不顺 | 三种异常文本混用；未提权与沙箱拒绝**外观完全相同** | — | **否** |

**建议**：① 每次注册表写操作输出一行 `staged|applied|refused + 通道 + 原因`；② 原生子进程启动失败必须置非零退出码；③ 把 `files[]` 里补上 `kind:'registry'` 行并让 `riskCounts` 与 `alerts` 自洽、可按 candidateId 追溯；④ 公开 `.dshstage` 布局并提供 `dsh reg status`；⑤ 修 `overlay` 僵死（§2③）与 executor 的 `STAGING_WRITE_UNVERIFIED` 误报（staged 路径被截断成不存在的 `.dshstage\session`）。

---

## 6. 测试遗留物（诚实声明）

- **真实注册表**：**零遗留**。没有创建任何键/值、没有自启动项、没有触碰任何服务或驱动的 `Start`。
- **真实磁盘**：仅本目录的产出（`results.json`/`findings.md`/`executions.log`/`evidence/*`，经 DSH 宿主 `write` 工具写入），加几个辅助脚本（`a.ps1`/`analyze.ps1`/`xchk.ps1`/`b00-exeprobe.ps1`/`a01-02.ps1`）。
- **`.dshstage`**：**未触碰**（协议禁止）。13 个 `overlay.<pid>.hive` + `overlay.hive` + `overlay.journal` 保持原样。
- **未做（诚实声明）**：REG-02 的**父/子进程**直接对照未取得（子进程创建被禁），只能给同一会话内两个独立进程的互不可见；REG-04 的 `reg copy/export/import`、REG-06 的 `/reg:32|/reg:64`、REG-09 的逃生开关**均未实际执行**；HKLM 的 `config\{SOFTWARE,SYSTEM}` hive mtime 在未提权下**不可读**，故 HKLM 侧的地面真值依据是「写被拒」而非 mtime。
- **环境噪声**：pwsh 工具本身多次在执行器层失败（`STAGING_WRITE_UNVERIFIED` ×1、`EBUSY` ×1、静默超时 ×2），约消耗 10 条命令预算。

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `evidence/reg00-recon.txt` | overlay 目录普查（70→13 hive 的两次快照、pid 名单、journal/shared hive mtime） |
| `evidence/reg00b-exeprobe.txt` | 进程创建能力探测（reg/cmd/whoami/where 全部 Access is denied） |
| `evidence/reg-write-attempts.txt` | 本轮全部 17 次注册表写入尝试的逐条原始异常文本 + 真实 hive 地面真值判定（含 `NTUSER.DAT` mtime） + 清理状态 |
| `evidence/reg-static-analysis.txt` | A0–A8 静态分析：token/身份、review.json 全部字段与直方图、候选、残留扫描、hive/journal 二进制扫描 |
| `evidence/reg08-review-header.txt` | review.json 头部字段单列 |
| `executions.log` | 逐条命令 + 退出码 + 原始输出/报错 |
