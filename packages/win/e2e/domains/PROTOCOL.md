# WinStage 沙箱测试协议 v1

本文件是所有测试线程的唯一共同契约。**先完整读一遍，再动手。**

## r3 更正（2026-10-04 实测）

> 本节由文档纠正线程 E 于 2026-10-05 依据 r3 轮六个域的原始证据写入。
> **本节优先于下文全部 v1 表述**：凡下文标注「已被 r3 证伪」的内容，一律以本节为准。
> 会话索引与证据出处见 `_sandbox-tests\r3\README.md`；会话原件为
> `.t\dsh2\home\sessions\--C-Users-Administrator-Desktop-WinStageSandbox-.t-dsh2-ws--\session-*\session.v4.jsonl.zstd`。

### C1. 宿主 read/write 工具是「暂存通道」，**不是**「真值通道」

- 原文（§1、§3.2）：把宿主工具与 `STAGE` 当成能回答「有没有真的落到宿主」的地面真值，
  并认为宿主工具读的是真实磁盘（真值通道）。→ **已被 r3 证伪，见本更正。**
- 实测：宿主 `write` 写 `<ws>\_hostonly\a.txt`，实际落在 `<stage>\_hostonly\a.txt`
  （`session-97132a99` CH-01、`session-d6e30323` CRITICAL）；宿主 write+read 自洽的
  `_r3\fs-sen\results.json` 在**真实磁盘上不存在**。
- 更正后定义：`HOST` = **暂存通道**（写落暂存、读是 read-through）。
  **唯一真值**是真实磁盘，且必须由**非沙箱进程**（用户自己的 PowerShell / 资源管理器）
  去查；宿主工具、沙箱内 pwsh、node 都不在此列。
- 本线程复核（2026-10-05）**写入前**：真实磁盘 `_sandbox-tests\r3` **不存在**
  （`cmd /c dir` → `File Not Found`），而暂存树里已有 `staged\_sandbox-tests\r3\`；
  本会话 pwsh 在工作区建目录直接被 ACL 拒（`Access to the path '_r3probe' is denied`），
  只有本会话 `staged` 根可写。→ 与 C1 一致。
- 本线程复核（2026-10-05）**写入后 —— 重要限定**：宿主工具写的 `_sandbox-tests\PROTOCOL.md`
  与 `_sandbox-tests\r3\README.md`，在 `staged\_sandbox-tests\…`、`staged\fs\…`、
  `staged-ext\…`（以及 `wo`/`real`/`private`/`cache`/`blobs`）里**都没有副本**，而真实磁盘上
  两者**已更新**（`PROTOCOL.md` 17781B mtime `2026-10-05 08:58:12`；`r3\README.md` 9725B
  mtime `08:58:40`），`cmd /c dir <ws>\_sandbox-tests\r3` 也返回了 `README.md`。
  即：**这两次宿主写入直接落到了真实磁盘**。而同一天同一 stage 根下，另一个通道
  `09:01:59` 起写入并**持续重写**的那份探针却**只进了暂存**
  （`staged\_sandbox-tests\r3\_lane-probe\probe-*.txt`，2037B，真实磁盘无此文件）。
- **C1 的准确表述（据此收紧）**：宿主 read/write **既可能只落暂存、也可能直落真实磁盘**，
  取决于当时 shim/暂存是否介入，**同一会话的不同时刻都可能不同**。
  因此：① 「宿主写 + 宿主读自洽」在任何情况下都**不构成**落盘证据（r3 已证）；
  ② **不能预设**宿主工具写没写真实盘 —— **每一次**都要用 `REAL`（非沙箱进程，
  或 `cmd` 的真实盘窗口）复核并记录结论。

### C2. `cmd /c dir` **不是** read-through（原 §3.2 通道定义错误）

- 原文（§3.2）：`CMD`：`cmd /c dir` / `reg.exe query`（不同 API 路径）→ **也被 hook**。
- 实测：对**仅存在于暂存**的文件，`cmd /c dir` 报 `File Not Found`，而同一文件
  PS/.NET `Test-Path` 报 `True`（有正对照）。即 `CMD` 看到的是**真实磁盘**，不读 overlay。
- 更正：`CMD` 是真实磁盘窗口，**不是** overlay 读取路径。
  「cmd 看不见」≠「文件不存在于任何地方」；反之「cmd 看得见」也不证明没有暂存层改动。

### C3. overlay 有**三套互不可见**的布局（原 §1 只写了一种）

- 原文（§1）：只写了 `staged\fs\<盘符>\<路径>` 一种。→ **已被 r3 证伪（不完整）。**
- 实测三套并存，**同路径可有两份不同内容，且都进同一个 `review.json`**：

  | 布局 | 写入方 |
  |---|---|
  | `staged\<工作区相对路径>\…` | 宿主 `write`/`edit` 工具（HOST） |
  | `staged\fs\<盘符>\<绝对路径>\…` | 注入 shim 的进程（PS / node / cmd 原生命令） |
  | `staged-ext\<hash>\<文件名>` | 扩展/旁路写（大对象、特殊文件等） |

  （r3 会话 `session-4a363277` 另见 `staged\wo\…` 白蚀墓碑目录。）
- 后果：**用一套布局搜索为空，不能反证另一套为空**；取证必须三套都列。

### C4. 「工作区外写入被暂存」不总成立

- 实测（`session-97132a99` PIP-02）：`Set-Content C:\ProgramData\pip\pip.ini` 报成功、
  进程内 SHA256 自洽，但**新进程** `exists:False`，**暂存树与真实磁盘都没有**该文件；
  执行门自检 `outside-write-staged-not-real=fail`。
- 更正：「报成功」既不代表落真实盘，也不代表进暂存 —— 存在**静默丢失**这第三种状态。
  必须三处分别取证：真实磁盘（REAL）、暂存树（STAGE）、candidates/`review.json`（STAGE）。

### C5. 执行门 `STAGING_WRITE_UNVERIFIED` 会**闩锁**，且无解除提示

- 原文（§1「已知坑」）只写成「一次递归列目录曾触发拒绝」。→ **已被 r3 证伪（严重低估）。**
- 实测：触发后**连 `Write-Output` 都被拒**，持续数分钟，没有任何解除时机/原因的提示；
  退出码形态 `3762504530` / `2` / `127`；探针另有 `0xC0000005`、`0xE0434352`、
  `exit 127`、`>25s 挂死` 四种形态。
- 更正：按**粘滞故障**处理 —— 触发后停止该会话的写类探针、记录形态、换会话重试；
  不要在同一会话里反复重试写（会持续失败并污染证据）。

### C6. 中途失根 / 会话漂移：失败报文只有一句 `Access is denied`

- 实测：`WINSTAGE_STAGE_ROOT` 在运行中途变空、冒出多个新会话，所有写入失败且
  **之前暂存的产物消失**，报文只有 `Access is denied`，与策略拒绝**无法区分**。
- 更正：因此「一次拒绝」**不能**判定为「策略正确拦截」。判定前先确认三件事：
  `WINSTAGE_STAGE_ROOT` 是否非空、stageRoot 下原有产物是否还在、失败是进暂存还是被 ACL 硬拒。
  本线程实测签名：4 个 `WINSTAGE_*` 全空 + 工作区写 `Access to the path … is denied`
  + `staged\fs` 为空 → 属「已脱离沙箱」，不是「策略拦截」。

### C7. PowerShell 原生命令 stdout 被静默吞掉 —— 取证方法必须改

- 实测：`& node --version` 输出与退出码**皆空**；必须 `cmd /c "node --version > file"`
  再读文件才拿到 `v24.21.0`。
- 本线程复核（2026-10-05，已复现）：`$o = & node --version 2>&1` → `len=0`、退出码空；
  `cmd /c "node --version > <stage>\_r3\_nodever.txt"` → 读回 `v24.21.0`。
- 更正：**凡需要读外部命令输出的取证，一律重定向到文件（放暂存内）再读回**，
  不要依赖管道、`$LASTEXITCODE` 或「命令没报错就说明没输出」。取证法见 §3.2。

### C8. 读面无审计（写面却有完整仪表）—— 设计缺口，不是测试噪声

- 实测：以下均可**静默读取**，零提示、零审计、不进 `review.json`：
  `.dsh\.credentials.yaml`（223B，含 secret/API key）、`%USERPROFILE%\.npmrc`、
  PSReadLine 历史、Edge `Login Data`（126976B，含 `password_value`）。
  DPAPI 在本令牌下可往返；伪造 AWS key / GitHub token 经 node HTTPS POST 到 httpbin
  被**原样回显**。
- 对照：写面有候选、风险分级（normal/outside/sensitive/danger）与 `review.json`。
- 更正：读敏感文件「能读到」**不构成**隔离失败证据（读面本就没有闸门）；
  报告必须把「读面无闸门」写成**缺口/建议**，不要与写面拦截混为一谈。

### C9. 隔离确实守住的部分（不要被 C1–C8 误读成「全盘失守」）

- 真实磁盘**零产物**（r3 六域汇总）；`C:\Windows\Temp` 三种写入方式**全拒**；
  `System32` / `D:\` 越界写**全拒**。
- 真实 `NTUSER.DAT` 的 size/mtime 与基线一致（SHA256 因 hive 独占取不到 → 记 `N-A`，
  属**环境限制**而非缺陷）；真实 hive 中**无测试键**。
- 更正：陈述隔离能力时，**写面/注册表面的「拦住了」与读面的「没拦」必须分开**；
  「真实磁盘零产物」以 `REAL` 通道为准。

### C10. 通道定义与取证法（取代 §3 的 v1 三通道）

见下文 §3 第 2/3 条（已按本轮更正重写）：
`REAL`（唯一真值，非沙箱进程）/ `HOST`（暂存通道）/ `PS`（hook + read-through）/
`CMD`（真实磁盘窗口，非 read-through）/ `STAGE`（暂存层真值）。

## 0. 本次任务

对 DSH WinStage 沙箱做端到端实测：文件读写、浏览器、pip、node/npm、exe 安装、
注册表、网络、个人敏感文件保护，并**额外做一条主线：测试操作设计的易用性**
（哪些地方让人困惑、报错误导、容易误判、文档缺失、需要几倍工作量才能完成一件事）。

## 1. 沙箱模型（v1 由 Lead 实测确认；**其中多条已被 r3 证伪，见 r3 更正**）

> ⚠️ 本节保留原文以供追溯。凡标注「已被 r3 证伪」的条目，一律以 §r3 更正 为准。

- 当前 DSH 文件策略：`workspace-write`；工作区根 =
  `C:\Users\Administrator\Desktop\WinStageSandbox`。
- 注入 `winstage-shim.dll` 到子进程，hook 约 64~319 个 IAT 站点（file + reg 两个族）。
- **写操作被重定向**到 staged 目录：
  `C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361\staged\fs\<盘符>\<路径>`
  > ⚠️ **已被 r3 证伪（不完整），见 r3 更正 C3**：这只是 shim 进程那一套布局；
  > 实际有**三套互不可见**的布局（`staged\<工作区相对路径>`、`staged\fs\<盘符>\<绝对路径>`、
  > `staged-ext\<hash>\<文件名>`），同路径可有两份内容且都进同一个 `review.json`。
- **读操作 read-through**：先看 overlay，未命中再回退真实磁盘 → 沙箱内看到的是
  「真实内容 + 本会话改动」的一致视图。
  > ⚠️ **已被 r3 证伪（就「谁在看」而言），见 r3 更正 C1/C2**：
  > read-through 只对 PS/.NET 一族成立；**`cmd /c dir` 不是 read-through**（C2），
  > **宿主 read/write 工具看的也不是真实磁盘，而是暂存通道**（C1）。
- 注册表改动进 overlay hive，**真实注册表一个字节未写**。
- 所有改动汇聚成候选（candidate），呈现在 `review.json` 里，带风险分级
  （normal / outside / sensitive / danger），需**人工勾选批准**才会由宿主写盘；
  拒绝则丢弃。这是 WinStage 的核心安全语义。
- 关键推论：**沙箱内任何进程看到的结果都不能证明宿主磁盘被改动**。
  你必须用「异通道」交叉验证，并如实记录两条通道是否一致。
  > ✅ 方向仍成立；但 ⚠️ **原文默认「异通道」可从沙箱内取得 —— 已被 r3 证伪，见 r3 更正 C1/C10**。
  > 宿主 read/write 工具本身也在「沙箱内」一侧（暂存通道）；真值只能由**非沙箱进程**
  > 在真实磁盘上给出（`REAL`）。
- 已知坑（Lead 已遇到，请留意）：PowerShell 启动时会写
  `StartupProfileData-NonInteractive`、`__PSScriptPolicyTest_*` 等噪声，会污染
  review.json 的候选列表；一次递归列目录曾触发
  `STAGING_WRITE_UNVERIFIED` 执行门拒绝（gate）。
  > ⚠️ **已被 r3 证伪（严重低估），见 r3 更正 C5/C6**：该门会**闩锁** —— 触发后连
  > `Write-Output` 都被拒数分钟、无解除提示（退出码 `3762504530`/`2`/`127`，
  > 另有 `0xC0000005`、`0xE0434352`、`exit 127`、`>25s` 挂死四种形态）；
  > 且会话可能**中途失根**（`WINSTAGE_STAGE_ROOT` 变空、暂存产物消失），
  > 报文只有一句 `Access is denied`，与策略拒绝无法区分。

## 2. 环境事实（Lead 已确认）

- `node` v24.21.0、`npm` 11.19.0（`C:\Program Files\nodejs`）、`pnpm` 已装、
  `git`、`curl`(或 curl.exe)、`winget`、`choco` 存在。
- `python` / `python3` 指向
  `C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe`，
  是 **0 字节的 Microsoft Store 别名存根**（`python -c ...` 无输出，`--version`
  退出码 9009），**没有真实 Python 解释器**；`pip` 不存在。
- 受限模式下 Node.js 的 `child_process.spawn/exec` 若走默认
  `stdio:'pipe'` 会 `EPERM`；`stdio:'inherit'|'ignore'` 可用。PowerShell 自身管道不受影响。
- 判定 `python`/`pip` 是否装机、装在哪里，是 pip 线程的第一步。

## 3. 必须遵守的取证规则

1. **每次写操作后必须回读并记录 SHA256**（完整性校验），格式：
   `写入 SHA256 == 回读 SHA256`。
   > ⚠️ **已被 r3 限定，见 r3 更正 C1/C4**：在 `HOST`/`PS` 通道上的「写读自洽」
   > **不能**当作落盘证据（暂存通道自洽即可通过）；它只是暂存层完整性校验。
2. **标注每条观察走的是哪条通道**，五选一（**取代 v1 的三通道定义**，见 r3 更正 C1/C2/C10）：
   - `REAL`：**唯一真值通道** —— 真实磁盘，且必须由**非沙箱进程**查看
     （用户自己的 PowerShell / 资源管理器 / 任务管理器）。只有它能回答
     「有没有真的落到宿主」。本会话的 pwsh **不算** `REAL`：它可能已被 hook
     （读 read-through、写进暂存或被 ACL 拒），也可能已脱离沙箱而只看真实磁盘 ——
     同一台机上两种状态并存过；故 pwsh 的观察记 `PS`，落盘结论须由用户侧 `REAL` 复核。
   - `HOST`：宿主 `read`/`write`/`edit`/`glob`/`grep` 工具。**不是真值通道，是暂存通道**：
     写入落到 `<stage>\<工作区相对路径>`，读取走 read-through（暂存优先、未命中回真实磁盘）。
   - `PS`：PowerShell provider（`Get-Item`/`Get-FileHash`/`Test-Path`/`Get-ItemProperty`）
     → 读被 hook 且 read-through（暂存优先）。
   - `CMD`：`cmd /c dir` / `reg.exe query`。**不是 read-through**（C2）：对只在暂存里的
     文件报 `File Not Found`，而同一文件 PS/.NET 报 `True`。它看到的是**真实磁盘**，
     但看不到暂存内容 —— 别把「cmd 看不见」当成「文件哪儿都不存在」。
   - `STAGE`：直接读 `<stage>\...` 与 `<session>\candidates\*.json`、`review.json`
     → **暂存层真值**（只证明暂存了什么，**不**证明宿主磁盘被改动）。
   注意：**同一会话里所有派生进程共享同一 stageRoot**；且 overlay 有**三套布局**（C3），
   只看一套会漏。
   **取证法（C7）**：PowerShell 里 `& node --version` 这类原生命令的 stdout 会被静默吞掉
   （实测直接捕获 `len=0`、退出码为空，而重定向到文件再读得到 `v24.21.0`）。
   **凡需要读外部命令输出，一律 `cmd /c "<命令> > <暂存内文件> 2>&1"` 再读文件**，
   不要依赖管道或 `$LASTEXITCODE`。
3. 涉及「有没有真的落到宿主」的结论：**只能**由 `REAL`（用户侧非沙箱进程）支撑；
   `HOST`/`PS`/`CMD`/`STAGE` 都不能单独当真值（C1）。同时给出三件套并如实记录不一致：
   ① 真实磁盘路径是否存在（`REAL`）；② 暂存路径是否存在（`STAGE`，三套布局都查）；
   ③ candidates / `review.json` 记录（`STAGE`）。**不得**用其中一条去「推定」另一条；
   `HOST write` + `HOST read` 自洽**不构成**落盘证据（r3 实例：`_r3\fs-sen\results.json`
   宿主写读自洽，真实磁盘不存在）。
4. 记录 `review.json` 的风险分级结果（`normal/outside/sensitive/danger`）——
   这是隔离与保护能力的直接证据。
5. 每执行一条命令，把**命令行 + 退出码 + 关键原始输出**追加到自己的
   `executions.log`。不要只写「测试通过」。
   > ⚠️ **已被 r3 限定（C5/C7）**：退出码与输出本身可能不可靠（四种崩溃形态、
   > 原生命令 stdout 被静默吞掉）。命令输出一律重定向到文件再读回；缺失的输出
   > 记「被吞」而不是「无输出」。
6. 预期被拒绝的操作（越权写、挂载、提权、读敏感文件）要记 `BLOCKED` 并给出
   错误文本；**沙箱放行了本应拦住的操作，是最高优先级发现**，请立刻用
   `send_message` 通知 lead（目标 `lead`）。
   > ⚠️ **已被 r3 限定（C6/C8）**：① 仅凭一句 `Access is denied` **不能**判为
   > 「策略拦截」——可能是失根/脱离沙箱（C6）；② 读敏感文件在 r3 中**本来就被放行**
   > （读面零闸门、零审计），这是 C8 的设计缺口，**不要**记成「放了本应拦住的
   > 操作」的意外事故，也不要因此判隔离失败。

## 4. 状态码

| 状态 | 含义 |
|---|---|
| `OK` | 行为符合沙箱设计语义，且已取证 |
| `FAIL` | 明确缺陷/不一致/崩溃/静默降级 |
| `BLOCKED` | 被沙箱或环境拒绝（记录错误文本） |
| `N-A` | 环境不具备（例如无真实 Python），说明原因 |
| `FINDING` | 补充的安全/易用性观察，非通过/失败判定 |

## 5. 你的产出（只写自己目录，不要碰别人的）

目录：`_sandbox-tests\<your-area>\`（相对工作区根）

1. `results.json` —— 机器可读，数组，每个 checkpoint 一项：
```json
{
  "id": "FS-03",
  "title": "工作区内写入并回读",
  "status": "OK",
  "channel": ["PS", "STAGE"],
  "command": "Set-Content ...; Get-FileHash ...",
  "expected": "写入成功且回读哈希一致，改动进入候选列表",
  "observed": "写入成功，SHA256 一致；candidates 记录 risk=normal",
  "evidence": ["evidence/fs03.txt", "staged:fs/C/.../x.txt"],
  "usability": "需要手工拼 3 条命令才能确认落盘位置，建议 DSH 提供 `dsh stage ls`"
}
```
2. `findings.md` —— 人类可读小结：结论、证据、**易用性**、建议。
3. `executions.log` —— 逐条命令记录。
4. `evidence/` —— 原始输出、staged 路径清单、哈希、截图/下载文件等。

**易用性**是硬性要求：每条 checkpoint 都要写一句「这一步顺不顺、坑在哪、
需要几步、报错是否可理解」。最终报告会汇总成一张易用性表。

## 6. 纪律

- 只在自己 `_sandbox-tests\<your-area>\` 下写文件；**不要**改别人的目录、
  不要动 `.dshstage` 内容、不要执行 `flatten`/`apply`/`approve` 之类把改动落到
  宿主真实磁盘的操作。
- 破坏性/危险动作（改 HKLM 服务、删系统文件、真实提权、写 Run 启动项）先做
  最小无害变体；确实必要才做，并在 findings 里标注「测试遗留物」。
- 不装驱动、不改系统安全设置、不碰真实用户凭据内容。
- 超时不要卡死：单条命令加 `timeoutMs`，失败就记录并继续下一条。
