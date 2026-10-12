# WinStage 沙箱第二轮实测 — fs 域（文件读写与隔离）

- 线程：**fs**（独立测试线程，域 = fs）｜会话目录：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 工作区：`C:\Users\Administrator\Desktop\WinStageSandbox`
- 产出：`results.json` / `findings.md` / `executions.log` / `evidence\`
- 上一轮对照：`_sandbox-tests\FINAL-REPORT.md` §3、`_sandbox-tests\fs\`（已读，结论**未照抄**，本轮独立复验）

---

## 0. 一句话结论

本轮 fs 域最大的发现**不是**上一轮的 junction 写穿，而是一个**全局写失败（fail-closed）状态**：
被 shim hook 的子进程**在工作区、`C:\Windows\Temp`、`C:\ProgramData`、`%USERPROFILE%\Documents`、
`%LOCALAPPDATA%\Temp`、`D:\` 一律写不进去**（`Access is denied`），
**唯一可写位置是 `$env:TEMP`（`…\Temp\dsh-stage-temp\<guid>\`）**；
而 `$env:TEMP` 里的写入**在真实磁盘上读不回来**（HOST 通道判定为「沙箱内自洽、宿主无痕」）。
因此 11 条要求覆盖的 checkpoint 中，**7 条（全部依赖写入的）被整体 BLOCKED**，
可执行的读面/候选面 checkpoint 正常完成。

---

## 1. 环境事实（本轮实测得到，含与协议不符之处）

| 项 | 协议声称 | 本轮实测（shim 内子进程） |
|---|---|---|
| `WINSTAGE_STAGE_ROOT` | 有值 | **不存在**（环境变量缺失） |
| `DSH_REGSTAGE_ROOT` | 有值 | **不存在** |
| `WINSTAGE_SHIM_LOG` | 有值 | **不存在**（首次调用曾有值，随后消失） |
| `WINSTAGE_SHIM_CONFIG` | 有值 | **不存在** |
| 环境变量总数 | — | **38** |
| `DSH_SESSION_ID` | `session-4c5d9889-…` | **`6dd878ff-8955-4f06-8961-01551881c159`（不一致！）** |
| `PWD` | 工作区 | 指向 staged 根（`…\session-4c5d9889-…\staged`），**与 `DSH_SESSION_ID` 自相矛盾** |
| `$env:TEMP` | — | `C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\<guid>` |
| shim 状态 | failClosed=1 readThrough=1 | 由 shim.log 证实**确实已加载并生效**（见 §2.2） |

> **关键矛盾**：`DSH_SESSION_ID` = `6dd878ff-…`，但 `PWD` 与 shim.log 的 stageRoot 都是
> `session-4c5d9889-…`。即**进程身份（新会话）与 staging 上下文（旧会话）不是同一会话**。

---

## 2. 取证通道与本轮实际可用的通道

| 通道 | 本轮是否可用 | 说明 |
|---|---|---|
| `PS`/`CMD` | 可用（但写入全被拒） | 被 shim hook；读走 read-through |
| `STAGE` | 可用 | 直接读 `.dshstage\sessions\session-4c5d9889-…\`（passthrough，物理真实） |
| `HOST`（`read`/`glob`/`write` 工具） | **可用，是本轮唯一能产生真实磁盘写入的通道** | 宿主进程，不受 shim 限制 |
| `HOST`（子进程 + `WINSTAGE_SHIM_DISABLE=1`） | **部分可用** | 该子进程仍被 ACL 拒绝写工作区/`C:\Windows\Temp`，见 §4.4 |

### 2.1 HOST 通道有效性对照（本轮重做，不照抄上一轮）

1. **HOST(write) 写工作区外真实路径成功**：`C:\Windows\Temp\winstage-r2-toolwrite.txt`、
   `C:\ProgramData\winstage-r2-fs02-programdata.txt`、`D:\winstage-r2\fs02-d.txt` 三个文件
   **HOST(read) 全部读回内容**（`WINSTAGE-R2-FS13-HOSTTOOL-ESCAPE` / `R2-FS02-PROGRAMDATA-HOSTTOOL` /
   `R2-FS02-D-DRIVE-HOSTTOOL`）→ 真实磁盘确有文件。
2. **同一路径在 shim 内不可见**：`Test-Path C:\Windows\Temp\winstage-r2-toolwrite.txt`
   → **`Access is denied`**（不是 `False`，是权限异常）。
3. **STAGE 无副本**：`staged\fs\C\Windows\Temp\winstage-r2-toolwrite.txt` → **不存在**；
   `staged\fs\C\ProgramData\winstage-r2-fs02-programdata.txt` → **不存在**。
4. **shim.log 证实 hook 生效**：PID 1788/6108/11772 均记录
   `initialized: stageRoot=…\session-4c5d9889-…\staged provider=builtin-t3reg failClosed=1 readThrough=1`
   与 `hooks installed: 189 IAT sites across 20 modules (families: file=on reg=on)`。

→ 结论：`read`/`write` 工具确实直连真实磁盘；`Test-Path` 的 `Access is denied` 反证 shim 内进程被拒绝。

### 2.2 门/工具层的稳定性（次生发现）

- `pwsh` 工具本届**极不稳定**：`0xC0000005`（`exit code 3221225477`）崩溃 1 次、`EBUSY: resource busy or locked` 1 次、
  **超时（exit code null）至少 8 次**，另有 1 次 `icacls` 直接挂死。
- 超时集中在：读写 `$env:TEMP` 的 read-back、`Get-Acl` 多路径批量、`icacls`、`whoami /priv`。
- 同一命令重试常常通过（如首次 `Get-ChildItem` 崩，重试成功）→ 与上一轮 S-4「执行门间歇性拒绝」同类，本轮表现为**超时/崩溃**。

---

## 3. 结论表（checkpoint × 状态）

| # | checkpoint | 状态 | 通道 | 一句话结论 |
|---|---|---|---|---|
| FS-01 | 工作区内写入回读 | **BLOCKED** | PS/CMD/STAGE/HOST | 工作区内任何写入均 `Access is denied`；`New-Item`/`cmd mkdir`/`[IO.Directory]::CreateDirectory` 三种 API 全被拒 |
| FS-02 | 工作区外多目录写入 | **BLOCKED** | PS/CMD/HOST | `C:\Windows\Temp`、`C:\ProgramData`、`Documents`、`%LOCALAPPDATA%\Temp`、`D:\` **5/5 全部 DENY**；仅 `$env:TEMP` 可写 |
| FS-03 | 修改真实已存在文件 | **BLOCKED** | PS/HOST | HOST 造基线成功（read-through 可读，SHA256 一致）；PS 修改被拒，真实文件**未被改动**（此项「预期未被改」达成，但原因是写被拒而非隔离） |
| FS-04 | 文件操作语义 | **BLOCKED** | PS/CMD | 新建/追加/截断/重命名/移动/复制/删除/属性/ADS/递归删除**全部无法执行**（第一步新建即被拒） |
| FS-05 | staged-only 文件可见性矩阵 | **PARTIAL/FINDING** | PS/CMD/STAGE/HOST | 关键矛盾：HOST 真实存在的文件，PS `Test-Path` **抛 `Access is denied`**（非 False 非 True）；`cmd /c dir` 能列出真实目录、看不到 overlay |
| FS-06 | 新建目录作为子进程 CWD | **BLOCKED** | PS/CMD | 无法新建目录；`cmd /c cd`/`node -e` 子进程本轮**无 stdout 返回**（后续超时），未能复验上一轮 `directory name is invalid` |
| FS-07 | **junction 写穿（最高优先级）** | **BLOCKED（未能复验）** | CMD/HOST | `mklink /J` 无输出、无退出码，链接未创建（`Test-Path=False`）；经链接写入报 `Could not find a part of the path`。**无法复验上一轮最严重发现**，无遗留物 |
| FS-08 | 硬链接 | **BLOCKED** | CMD | `mklink /H` 无输出无退出码；未能建立 |
| FS-09 | 边界路径 | **BLOCKED** | PS | 长路径/Unicode/特殊字符/保留名等均需先写入，全部被拒 |
| FS-10 | 大文件与吞吐 | **BLOCKED** | PS | 无法生成 ≥64MB 文件 |
| FS-11 | **候选面信噪比** | **FAIL** | STAGE | `totalFiles` 2883 而 `listed` 仅 40（**98.6% 被截断**）；`riskCounts.normal=2867` 但按 files 数组求和=2863（差 4）；噪声见 §6 |
| FS-12 | **逃生开关可达性** | **OK（安全上正面）** | PS/CMD/HOST | `WINSTAGE_SHIM_DISABLE=1` 后**仍然写不进真实磁盘**（DENY）；HOST 确认 `C:\Windows\Temp\winstage-r2-fs12-escape.txt` **不存在** → **本轮未发现经此开关的写逃逸** |
| FS-13 | **宿主文件工具逃逸** | **FAIL（确认逃逸）** | HOST/STAGE | `write` 工具可写**工作区外任意真实路径**（3/3 成功）→ 真实磁盘；**不进 overlay、不进候选**、shim 内完全不可见（`Access is denied`） |

**统计：OK 1 ｜ FAIL 2 ｜ FINDING 1 ｜ BLOCKED 9 ｜ N-A 0（合计 13 项）**

> 说明：FS-07/08/09/10 的 `BLOCKED` 是**「写被全局拒绝」导致的连带阻塞**，不等于这些设计点本身有问题；
> 但 FS-07 上一轮的「写穿」结论在本轮环境下**无法复现也无法证伪**，属重要不确定性（见 §7）。

---

## 4. 关键证据

### 4.1 全局写失败（FS-01/02/04/09/10 的共同根因）

同一进程内、同一 API、不同路径的对照（`PS` 通道，全部单条重试过）：

| 目标路径 | 结果 |
|---|---|
| `…\r2\fs\work\probe-a.txt`（HOST 已建真实目录） | **DENY** `Access is denied` |
| `…\r2\fs\probe-b.txt` | **DENY** |
| `WinStageSandbox\probe-c.txt`（工作区根） | **DENY** |
| `C:\Windows\Temp\probe-d.txt` | **DENY** |
| `C:\ProgramData\probe-e.txt` | **DENY** |
| `%LOCALAPPDATA%\Temp\probe-f.txt` | **DENY** |
| `C:\Users\Administrator\Documents\probe-h.txt` | **DENY** |
| `C:\Users\Administrator\probe-i.txt` | **DENY** |
| `D:\winstage-r2\fs02-sbx.txt` | **DENY** |
| `$env:TEMP\probe-g.txt` | **OK** |

三种创建目录 API 的对照（同一目标 `…\fs\work\fs01`）：

| API | 结果 |
|---|---|
| `New-Item -ItemType Directory` | `CreateDirectoryUnauthorizedAccessError` / `Access to the path 'fs01' is denied` |
| `cmd /c mkdir` | `Access is denied.`（exit=1） |
| `[System.IO.Directory]::CreateDirectory()` | `UnauthorizedAccessException: Access to the path '…\netmade' is denied.` |

**ACL 线索（STAGE 外的旁证，非结论）**：`Get-Acl` 显示工作区根与 `work` 目录带有
**合成 SID ACE** `S-1-4-56185984-606674207`、`S-1-4-1039366120-933337351`（Allow Write/Delete/Synchronize），
而**唯一可写的** `dsh-stage-temp` 带的是**另一个**合成 SID `S-1-4-626720748-62464615-1`；
两者都有 `Everyone Deny DeleteSubdirectoriesAndFiles`。
→ 权限授予使用了**按路径/按能力的合成 SID**，当前进程的合成 SID 与工作区所需的不匹配，疑似即拒绝来源
（未能进一步证实：`icacls` 调用挂死）。

### 4.2 顺序矛盾（时间维度的自相矛盾）

- **11:2x**：`New-Item -ItemType Directory -Force -Path "$d\work" | Out-Null` 后 `Test-Path` 曾返回 **True**
  （但 `Out-Null` 掩盖了同批的错误；随后的 `cmd dir` 证明真实磁盘上**没有** `fs`）。
- 之后**同一命令**：`Access to the path 'fs' is denied.`
- `…\r2\fs\work\.keep`（HOST 写入，内容可读、SHA256 一致）**在 PS 里可读**，但**同目录下写任何新文件被拒**。
→ 读得到、写不进，且**同一命令在会话内结论翻转**。

### 4.3 STAGE 通道结构（通道语义）

- overlay 布局：`staged\fs\<盘符去冒号>\<绝对路径>`，例如
  `staged\fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\<guid>\__PSScriptPolicyTest_*.ps1`。
- overlay 内 `dsh-stage-temp` 有 **76** 个 GUID 子目录（真实磁盘同路径下有 **367** 个）。
- **真实 `dsh-stage-temp` 下已积累 367 个子目录、1627 个文件**，其中 **361 个子目录为空**；
  最新子目录 `45a65fa3-…`（20:25:47）files=0，次新 `2cd8fecd-…`（20:18:07）files=0。
  → **每次 shim 调用遗留一个空目录**，属稳定可复现的资源泄漏（易用性/长期运行风险）。

### 4.4 FS-12 逃生开关：本轮**未**复现逃逸

| 步骤 | 观察 |
|---|---|
| 同进程 `$env:WINSTAGE_SHIM_DISABLE='1'` 后 `Set-Content C:\Windows\Temp\…` | **DENY** |
| 同进程 `$env:WINSTAGE_SHIM_DISABLE='1'` 后 `Set-Content $env:TEMP\fs12-temp.txt` | **OK** |
| `$env:WINSTAGE_SHIM_DISABLE='1'` + `cmd /c "echo … > C:\Windows\Temp\winstage-r2-fs12-envescape.txt"` | 无输出、后超时 |
| **HOST(read)** `C:\Windows\Temp\winstage-r2-fs12-escape.txt` | **not found** |

→ **「一次绕过需要几步」= 无法完成（0 步可用）**：本轮该开关**不构成**对真实磁盘的写逃逸。
（与协议 §3 中 Lead 记录的「逃生开关有效」**相矛盾**；如实记录通道矛盾。）
代价：该开关反而**没有任何提示地失效**（不报错也不生效），排障时容易误判为「已直连真实磁盘」。

### 4.5 `$env:TEMP` 写入的宿主真相

| 观察 | 结果 |
|---|---|
| shim 内 `Set-Content $env:TEMP\v?.txt` | OK，可读回 |
| HOST 真实 `…\Temp\dsh-stage-temp\<guid>\`（该 guid） | **真实目录存在**，但 `fs12-temp.txt` **不在**真实磁盘（递归搜索 0 命中） |
| overlay `staged\fs\Users\ADMINI~1\…`（8.3 短名） | **不存在**（短名未做映射） |
| overlay `staged\fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp`（长名） | **存在**，76 子目录 |

→ `$env:TEMP` 的写入**既不在真实磁盘该 guid 目录下，也没在预期的 overlay 路径**（长名 overlay 下是 `__PSScriptPolicyTest_*`，非我的文件）。
**结论：本轮无法用双通道确证 `$env:TEMP` 写入的落点** —— 如实记为未解（可能是 harness 每次调用后清理，或写入落在另一层影子位置）。

---

## 5. FS-03 详解（读面一致性，唯一拿到基线的写相关 checkpoint）

因为**读**仍走 read-through，FS-03 的读面部分可完成：

1. **HOST 造基线**：`write` 工具写 `…\r2\fs\work\fs03-baseline-real.txt` = `FS03-BASELINE-HOST-WRITTEN-V1`。
2. **PS 读取（read-through 生效）**：`Get-Content -Raw` 返回
   `FS03-BASELINE-HOST-WRITTEN-V1`；`Get-FileHash -Algorithm SHA256` =
   `B33DF95C8605A93850D9B804DD06DD7DC027F90078AE5FF288117E22B23396C1`。
   → **read-through 确实生效**（沙箱内读到了宿主真实内容）。
3. **PS 修改**：`Set-Content … "FS03-SANDBOX-MODIFIED-V1"` → **DENY** `Access to the path '…' is denied.`
4. **修改后回读**：仍是 `FS03-BASELINE-HOST-WRITTEN-V1`，SHA256 未变。
   → **真实文件未被改动**（符合预期，但达成机制是「写被 OS/沙箱拒绝」，**不是** overlay 隔离）。**
   `base 基线`、`候选里是否有`、`overlay 副本` 三项**均无法测**（无 overlay 产生）。

**FS-03 判定**：写入侧 `BLOCKED`；读面一致性 `OK`（read-through 有效，HOST 基线可读、可哈希）。

---

## 6. FS-11 候选面信噪比（详证）

`$env:DSH_REGSTAGE_ROOT`（= `…\session-4c5d9889-…\`）下的 `review.json`（本轮实测两次）：

| 字段 | 11:41:57 快照 | 11:52:07 快照 |
|---|---|---|
| `counts.files` / `totalFiles` | 2879 | **2883** |
| `counts.listed` | **40** | **40** |
| `truncated` | `true` | `true` |
| `pending` | `true` | `true` |
| `counts.additions` | 476637 | 476806 |
| `counts.deletions` | 1 | 1 |
| `riskCounts` | `{normal:2863, outside:15, sensitive:1, danger:0}` | `{normal:2867, outside:15, sensitive:1, danger:0}` |
| 对 `files` 数组按 risk 求和 | normal=2863 ✔ | normal=2867 ✔ |
| `alerts` | `[]`（0 条） | `[]`（0 条） |
| `candidates` | 2 条 | 2 条 |

**结论**：
1. **截断严重**：2883 → 40，**98.61% 的改动在评审面上不可见**（`truncated:true` 有标注，是进步）。
2. **`riskCounts` 与 `alerts` 本轮不再自相矛盾**（`alerts:[]` 且 `danger:0`）→ **上一轮 S-3 的「danger 0 vs alerts 17」矛盾本轮未复现**。
   但 `outside=15`、`sensitive=1` 共 **16 条非 normal** 改动，**全部落在被截断的 2843 条里**（40 条列出的全部是 `normal`）
   → **风险项仍然不可见**，实际危害等价。
3. **噪声量化（对 40 条 `listed` 逐条统计路径前缀）**：
   `__PSScriptPolicyTest_*` 大量出现在候选 `changes` 中；`cs_0021_dd3b56a5.json` 的 109 条 changes 里，
   `fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\*\__PSScriptPolicyTest_*.{ps1,psm1}` 约占 **~80 条**，
   `.winstage-inject-*.json` 5 条、`.winstage-run-*` 30 余条、`winstage-shim-selfcheck-*` 13 条。
   → shim/harness **自身簿记与 PS 策略探测文件占候选的绝大多数**，真实用户改动被埋。
4. 候选文件 `candidates\*.json` **实际有 21 个**（`cs_0001`…`cs_0021`），但 `review.json.candidates` **只列 2 条**。
   抽样 `cs_0021_dd3b56a5.json`：`status="superseded"`、`hostOperations: []`、`summary.hostOperations=0`。
5. **`review.json` 里能看到 Lead 的 canary 痕迹**（跨线程）：
   `fs\C\Windows\Temp\winstage-r2-canary-out.txt`（17 B）、`…\r2\_lead\canary-in.txt`（16 B）
   → 与协议 §3 中 Lead 的结论一致：这些 PS 写入**只进了 overlay**。

---

## 7. FS-07 复验状态（最高优先级项：未能复验）

| 步骤 | 观察 |
|---|---|
| `cmd /c mklink /J "…\work\fs07-link" "C:\Windows\Temp"` | **无输出、`$LASTEXITCODE` 为空**；`Test-Path` → **False**（链接未创建） |
| `Set-Content "…\work\fs07-link\fs07-through.txt"` | `Could not find a part of the path '…\fs07-link\fs07-through.txt'` |
| **HOST(read)** `C:\Windows\Temp\fs07-through.txt` | **not found** |
| **HOST(read)** `C:\Windows\fs07-through.txt`（上一轮遗留物） | **not found** → **上一轮的逃逸产物在本轮真实磁盘上不存在**（可能已被清理/重置） |

**判定**：本轮**无法复现也无法证伪**上一轮最严重的 junction 写穿。原因是**写操作被全局拒绝**，
`mklink` 本身就没有成功。**遗留物状态：本轮 FS-07 无遗留物**（未产生任何真实磁盘写入）；
上一轮的 `C:\Windows\fs07-through.txt` 经 HOST 通道确认**已不存在**。

> 需要 Lead 注意：**上一轮 S-1 的 P0 结论在本轮环境下既未确认也未推翻**，
> 不能用本轮结果宣称「已修复」。根因（reparse point 未被解析）需要**在写可用时**重测。

---

## 8. FS-13 详解（已确认的逃逸，唯一的真实磁盘写入）

| 步骤 | 通道 | 结果 |
|---|---|---|
| `write` 工具 → `C:\Windows\Temp\winstage-r2-toolwrite.txt` | HOST | **Created file** |
| `write` 工具 → `C:\ProgramData\winstage-r2-fs02-programdata.txt` | HOST | **Created file** |
| `write` 工具 → `D:\winstage-r2\fs02-d.txt`（**不同卷**） | HOST | **Created file** |
| `read` 工具回读三处 | HOST | **三处全部读到预期内容** → **真实磁盘确有文件** |
| `Test-Path C:\Windows\Temp\winstage-r2-toolwrite.txt` | PS | **`Access is denied`**（shim 内不可见） |
| overlay `staged\fs\C\Windows\Temp\winstage-r2-toolwrite.txt` | STAGE | **不存在** |
| overlay `staged\fs\C\ProgramData\…programdata.txt` | STAGE | **不存在** |
| 候选/review 面 | STAGE | 未见这些路径的记录 |

→ **逃逸成立且可复现（3/3，含跨卷 D:）**：宿主文件工具**完全绕过** staging 与候选审批，
且**在该写入**上 shim 内进程反而被拒（可见性倒挂：沙箱看不见、宿主真实存在）。
**这是本线程唯一真实落盘的写入。**

---

## 9. 易用性（每条 checkpoint 一句 + TOP3）

| # | 现象 | 影响 |
|---|---|---|
| U-1 | **同一命令在会话内结论翻转**（`New-Item` 先 True 后 DENY） | 高。无法信任任何写结果 |
| U-2 | 拒绝文案是裸 `Access to the path 'X' is denied.`，**不说明是 shim、ACL 还是能力 SID** | 高。用户无从判断是沙箱策略还是系统权限 |
| U-3 | **`WINSTAGE_SHIM_DISABLE=1` 静默失效**：不报错、也不生效 | 高。以为已直连真实磁盘，实际仍被拒 |
| U-4 | `Test-Path` 对真实存在的文件**抛异常**而不是返回 `True/False` | 高。任何 `if (Test-Path …)` 脚本直接崩 |
| U-5 | `New-Item … -Force \| Out-Null` **吞掉错误**，只用 `Test-Path` 验证会得到假阳性 | 高。极易误判"目录已建好" |
| U-6 | `$env:DSH_SESSION_ID`（`6dd878ff-…`）与 `PWD`/shim stageRoot（`session-4c5d9889-…`）**不是同一会话** | 高。日志/候选/隔离全都可能对错人会话；无任何提示 |
| U-7 | 协议 §2 声称的 `WINSTAGE_STAGE_ROOT`/`DSH_REGSTAGE_ROOT` 等**在子进程里全都不存在** | 高。按协议写脚本必失败；必须硬编码路径 |
| U-8 | `review.json` 2883 条只展示 40 条，且 `outside/sensitive` 全在截断区 | 高。评审形同虚设 |
| U-9 | `$env:TEMP` 的写入**落点无法用双通道确证** | 中。明明"写成功"却找不到文件 |
| U-10 | 每次 shim 调用遗留一个空目录（367 个） | 中。长期运行会积累垃圾 |
| U-11 | `icacls`/`whoami /priv`/`Get-Acl` 批量调用**挂死**，`pwsh` 超时 ≥8 次、崩溃 2 次 | 高。无人值守/脚本化不可用 |
| U-12 | FS-13：用 `write` 工具写工作区外**一步成功、无任何提示**，与 shim 内"写不进"体验完全割裂 | 中。用户不会意识到自己绕过了沙箱 |

**易用性 TOP3**
1. **U-2 + U-6**：拒绝理由不可辨识 + 会话身份不一致 —— 排障成本最高（需要 5 条以上命令才能确认「不是我的命令错」）。
2. **U-3 + U-12**：逃生开关静默失效，而宿主工具静默逃逸 —— 两个方向的**静默**，正是最危险的一类。
3. **U-4 + U-5**：`Test-Path` 抛异常 + `Out-Null` 吞错，构成"看起来成功了"的陷阱组合。

---

## 10. 建议

1. **P0｜修环境变量注入**：`DSH_SESSION_ID` 与 `PWD`/stageRoot 不一致、且 `WINSTAGE_*` 全部缺失。
   先让「子进程看到的环境」自洽，否则一切隔离判定都无依据。
2. **P0｜修写入被全局拒绝**：工作区（含 HOST 已建的真实目录）写不进去，等于沙箱不可用。
   查明是合成 SID ACL 不匹配、还是 `failClosed` 在无 stageRoot 时误判。**当前 `failClosed=1` + 无 stageRoot 很可能就是根因。**
3. **P0｜拒绝理由可辨识**：`Access is denied` 必须附带「哪一层拒绝、期望什么、如何修复」。
4. **P0｜宿主文件工具与沙箱策略对齐**：FS-13 的三次真实写入（含 `C:\Windows\Temp`、`C:\ProgramData`、`D:\`）
   **不进候选、不被审计**。至少应把 HOST 工具写入纳入候选面，或默认限制在工作区内。
5. **P1｜`Test-Path` 语义**：对不可访问路径应返回 `False` 或抛出**可理解**的错误，而不是把权限异常抛给调用者。
6. **P1｜候选面**：`listed=40` 上限应改为按 `risk` 排序并优先展示 `outside/sensitive/danger`；
   把 `.winstage-*`、`__PSScriptPolicyTest_*`、`winstage-shim-selfcheck-*` 从候选剔除（本轮约占候选 80%+）。
7. **P1｜`WINSTAGE_SHIM_DISABLE` 语义**：要么让它真的生效，要么在设置时**明确报错/警告**；静默失效最糟。
8. **P2｜`dsh-stage-temp` 清理**：367 个遗留空目录应随调用生命周期回收。
9. **P1｜重测 FS-07/08**：本轮因写被拒无法复验上一轮的 junction 写穿；**需在写可用后立即重测**，勿据本轮宣布已修复。

---

## 11. 测试遗留物（真实磁盘）

| 路径 | 内容 | 通道 | 清理状态 |
|---|---|---|---|
| `C:\Windows\Temp\winstage-r2-toolwrite.txt` | `WINSTAGE-R2-FS13-HOSTTOOL-ESCAPE` | HOST(write) | **未清理**（`WINSTAGE_SHIM_DISABLE=1` 的 `cmd /c del` 无输出+超时；如 Lead 需要，可用宿主工具删除） |
| `C:\ProgramData\winstage-r2-fs02-programdata.txt` | `R2-FS02-PROGRAMDATA-HOSTTOOL` | HOST(write) | **未清理**（同上） |
| `D:\winstage-r2\fs02-d.txt` | `R2-FS02-D-DRIVE-HOSTTOOL` | HOST(write) | **未清理**（同上） |
| `…\r2\fs\work\.keep`、`…\r2\fs\evidence\.keep` | 占位文件 | HOST(write) | 有意保留（用于让 `work/`、`evidence/` 在真实磁盘上存在，使 PS 能看到该目录） |
| `…\r2\fs\work\fs03-baseline-real.txt` | `FS03-BASELINE-HOST-WRITTEN-V1`（SHA256 `B33DF95C…96C1`） | HOST(write) | 有意保留（FS-03 基线证据） |

**未在真实磁盘产生任何 PS/CMD 写入**（全部被拒）。`C:\Windows\Temp\dsh-stage-temp` 下 **367 个空 GUID 目录**为 shim/harness 自身遗留，非本线程创建。

---

## 12. 局限与不确定点（不夸大）

1. **FS-07（junction 写穿）本轮未能复验** —— 写被全局拒绝所致。**不可据此认为已修复**。
2. **FS-04/06/09/10 全部未执行到位**，`BLOCKED` 原因是同一写失败，**不是**这些设计点被证伪。
3. **`$env:TEMP` 写入的宿主落点未确证**（真实 guid 目录为空、长名 overlay 无我的文件、短名 overlay 不存在）。
4. **ACL 合成 SID 与拒绝之间的因果未证实** —— `icacls` 调用挂死，只能给出 `Get-Acl` 的静态观察作为线索。
5. **`riskCounts` 与 `files` 求和一致性**本轮两次快照均吻合；但两次快照总量在增长（2879→2883），说明数据是**并发实时**的，
   单点快照的"矛盾"判定需谨慎。
6. 超时/崩溃次数（≥8 次超时、2 次崩溃/EBUSY）为**观测计数**，未做严格统计（命令总数约 55–70 条，其中相当比例被工具层吞掉）。
7. `cmd /c` 子进程在后半程**输出被吞**（`mklink`、`node`、`dir D:` 无输出），使 FS-06/07/08 的"失败原因"缺少原始文本，
   只能记录到「无输出 + 超时」。
