# fs-tester findings —「不同目录读写文件」域

- 线程：**fs-tester**｜会话：`session-eb7c901d-97ed-4f83-9096-33c97138c361`
- 工作区：`C:\Users\Administrator\Desktop\WinStageSandbox`
- staged 根：`.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361\staged`
- 产出：`results.json`（机器可读）、`executions.log`（逐条命令）、`evidence\`（原始证据）

## 0. 结论表

| # | checkpoint | 状态 | 一句话结论 |
|---|---|---|---|
| FS-01 | 工作区内新建/覆盖/追加/删除 + SHA256 | **OK** | 四步哈希全部一致（写入==回读==staged），删除两侧同步消失 |
| FS-02 | 嵌套/深层/60 个小文件 | **OK** | 60/60 双通道哈希一致；315 字符路径可建；但**不能用通配符枚举**（见 FS-11） |
| FS-03 | 工作区外写 4 个目标 | **OK** | 4/4 收容进 staging，真实磁盘 0 改动；但 CMD `dir` 看不见，risk 分级查不到 |
| FS-04 | 删除 + 跨目录重命名 | **OK** | 真实文件删除是 whiteout（REAL 确认原文件仍在）；重命名同样只进 overlay |
| FS-05 | 读穿透 / overlay 遮蔽 | **OK** | 真实内容可读；写入后沙箱读 overlay、宿主仍是原文件；overlay 未触碰真实 win.ini |
| FS-06 | 边界路径 | **OK** | 长路径/Unicode/大小写 OK；保留名被拒（报错晦涩）；尾点尾空格静默规整；ADS 被展平 |
| FS-07 | symlink/junction 逃逸 | **FAIL** ⚠️ | **写穿到真实 `C:\Windows`，exit=0，无候选、无记录** |
| FS-08 | 权限/只读/icacls | **BLOCKED** | 未执行（Lead 中途收口指令），非沙箱拒绝 |
| FS-09 | 静默降级检测 | **FAIL** | 存在一例：exit=0 但 staged/manifest 全无记录而真实磁盘有文件（FS-07） |
| FS-10 | 20MB 大文件 + 吞吐 | **OK** | 20MB 写 31 ms（649.5 MB/s），写==读 SHA256；工作区外同样被收容 |
| FS-11 | *(增补)* 目录枚举盲区 | **FAIL** | staged-only 文件对一切目录枚举 API 不可见，但按精确路径可访问 |
| FS-12 | *(增补)* 覆盖真实文件基线丢失 | **FAIL** | 覆盖真实存在的 win.ini 时 manifest `base=absent`，评审显示为 op=create |
| FS-13 | *(增补)* review.json 截断/噪声/矛盾 | **FAIL** | 1657 条改动只显示 40 条；riskCounts 声称 danger=0 而 alerts 有 17 条 danger |
| FS-14 | *(增补)* 执行门间歇拒绝 + probe 崩溃 | **FAIL** | ~20~25% 的命令被拒（含纯读命令）；probe 子进程崩在 0xC0000005 / CLR |

| FS-15 | *(增补)* ADS 在 staging 中展平为兄弟文件 | **FINDING** | 沙箱内 ADS 可读写，但 STAGE 落地为 `fs06b-ads.txthidden`；宿主落盘行为未证实 |
| FS-16 | *(增补)* `Get-Content` 把无 BOM UTF-8 当 GBK 解码 | **FINDING** | 读中文/JSON 静默乱码；须用 `[IO.File]::ReadAllText(p, UTF8Encoding)` |

**计数：OK 7 ｜ FAIL 6 ｜ BLOCKED 1 ｜ N-A 0 ｜ FINDING 2 ｜ 合计 16**

（OK：FS-01~FS-06、FS-10；FAIL：FS-07、FS-09、FS-11~FS-14；BLOCKED：FS-08；FINDING：FS-15、FS-16）

## 1. 取证方法（先读这段，否则后面每条 REAL 结论都无法复核）

本线程用**四条通道**，并且在结论上只信后两条：

| 通道 | 含义 | 是否被 hook |
|---|---|---|
| `PS` | PowerShell provider（`Test-Path`/`Get-Item`/`Get-Content`/`Get-FileHash`） | 被 hook，read-through |
| `CMD` | `cmd /c dir` / `type` | 被 hook，但**目录枚举不叠加 overlay** |
| `STAGE` | 直接读 `.dshstage\...\staged` 镜像、`manifest.json`、`candidates\*.json` | 不经过 hook（passthrough） |
| `REAL` | DSH 宿主文件工具 `read` / `glob` / `write` | **不被 hook = 宿主真实磁盘** |

**REAL 通道的有效性已做对照实验**（这是本次最重要的方法学发现，否则无法判定「有没有真落盘」）：

1. 对**同一个文件** `C:\Windows\win.ini`：PS 读到写 overlay 后的 **192 字节带 marker** 版本，REAL 同时读到**原始 167 字节、无 marker** → REAL 不受 overlay 影响。
2. REAL 读取所有 staged-only 文件（`fs03-*` 等）一律 `not found`，而 PS `Test-Path=True`、STAGE 镜像存在。
3. REAL(glob) `C:\Windows\Temp` 列出真实文件（`silconfig.log`、`MpSigStub.log`、`winstage-prop2-1kcvfegu.txt`），不含任何 staged 探针文件。
4. PS 删除真实文件后，REAL 仍读到原内容 → 证明那是 whiteout 而非真删。
5. REAL(write) 写工作区不进 staged 镜像 → 宿主工具不经过 shim。

补充事实：`PWD` 被重定向到 **staged 根**（PS 与 CMD 都是），所以本次所有测试都使用绝对路径。

## 2. 安全发现

### S-1（严重）junction 写穿逃逸到真实磁盘 — `C:\Windows` 被写入
- 复现：`mklink /J` 建链接（**不需要管理员权限**）→ 经链接 `Set-Content` → **真实文件出现**。
- 证据（三通道互证）：
  - REAL(read) `C:\Windows\fs07-through.txt` = `WRITTEN-THROUGH-JUNCTION`；PS 量得 `len=24`、`SHA256=937E12F9A346F754800A4F5E749D1E52872C01C84CEA3F875ACBAABD59938876`。
  - STAGE：`staged\fs\C\Windows\fs07-through.txt` **不存在** → 沙箱里没有副本，PS 能读到只能来自 read-through 回退的真实文件。
  - STAGE：`staged\...\_sandbox-tests\fs\work\fs07-link` 的属性 = `Directory, ReparsePoint`，`LinkType=Junction`，`Target=[C:\Windows]`；列该目录直接列出**真实 `C:\Windows` 的内容**（`System32`、`WinSxS`、`win.ini`…）。
  - `manifest` 无该路径记录，`hostOperations=0`，exit code 0。
- 根因（推断，与全部证据一致）：shim 只做「路径字符串 → staged 路径」映射，把 reparse point **真实创建**在 passthrough 的 stage 树里；打开映射后的路径时 NTFS 重解析到真实目标。**reparse point 从未被解析或拒绝。**
- 与 Lead 复测差异的解释：Lead 的 junction 指向「沙箱内新建、真实磁盘不存在」的目录 → NTFS 无法解析 → 写穿失败。**逃逸的前提是 junction 目标在真实磁盘上存在**（`C:\Windows` 存在），两者不矛盾。
- **未证实**（不写成结论）：写工作区外 junction（`C:\Windows\Temp\fs07-junction-real\fs07-escape2.txt`）——命令以 `0xE0434352` 崩溃，REAL 未发现产物；写 `System32`（未尝试）。
- 影响：隔离性的根本缺陷。任何沙箱内进程都能读写任意真实路径，绕过候选审批与 `review.json`。

### S-2（严重）真实文件删除/覆盖在评审界面上「不可辨识」
- FS-04：删除真实文件 → 评审记录 `op=delete`，但界面没有把「这是宿主上真实存在文件的删除」凸显；本会话候选里就有两条这样的记录（见 §5），一旦批准会真删宿主文件。
- FS-12：覆盖真实存在的 `C:\Windows\win.ini` → `baseHash=absent`、`op=create`，**看不到 before 基线**。对照 `silconfig.log` 的 whiteout 记录却有 `base=ae41c583…`，说明 shim 有能力取基线，只是覆盖路径上没取。

### S-3（严重）评审汇总自相矛盾，危险改动被噪声埋掉
- `manifest.entries=1657`，`review.json` 只列 **40** 条（**97.6% 被截断**），且按字母序被 `.winstage-inject-*.json` / `.winstage-run-*` 这类 shim 自身簿记文件占满。
- `riskCounts={"normal":40,"outside":0,"sensitive":0,"danger":0}`，而 `alerts` 同时有 `kind=danger-change, severity=danger, count=17`（含 `fs\C\Users\Administrator\.npmrc`）。**读 riskCounts 会得出「本会话没有危险改动」的错误结论。**
- 直接后果：协议 §3.4 要求记录每条路径的 risk 分级，但 FS-03/04/05/07 的路径在 `review.json` 里**查不到**，该要求无法完成。

### S-4（高）执行门间歇性拒绝，误报「隔离已损坏」
- 约 20 次 pwsh 调用中 **4~5 次被整体拒绝（20~25%）**，**包括纯读命令**（`Get-ChildItem`、读 `review.json`）。同一命令原样重试即通过。
- 拒绝文案 4 种形态：`exit=3221225477 (0xC0000005)` ×2、`exit=2`、`exit=1`、`staged=<截断路径>`。
- STAGE 侧 49 条 `.winstage-inject-*.json` 的 `childExitCode` 分布：0×40、1×5、2×1、**0xC0000005×1**、**0xE0434352×2** → 门的 probe 子进程真的会崩。
- 文案会让用户以为沙箱隔离失效（恐慌），实际是门自身 probe 崩溃；无重试提示、不区分「probe 崩了」与「staging 真的不可写」。

### S-5（中）目录枚举盲区使「写成功」看起来像「没写」
- staged-only 文件：精确路径 `Test-Path=True`、`Get-Item` 正常，但 `Get-ChildItem`（含 `-Recurse`/`*.txt`/`-Filter`）全部返回 0；`[System.IO.Directory]::GetFiles` 抛 `DirectoryNotFoundException`；`cmd dir` 返回 `File Not Found`。
- 自相矛盾：`Test-Path <dir> -PathType Container` = **True** 而 `GetFiles(<dir>)` 抛「路径不存在」。
- 规则：**只有真实磁盘上已存在的目录项会被枚举出来**（`_sandbox-tests\fs` 能列出真实存在的 `risk.ps1/stage.ps1/evidence`，列不出 staged-only 的 `work`）。
- 影响：`glob`/`find`/`ls -R`/npm/pip/git 遍历/构建系统都会误判文件不存在。

### S-6（低，未证实）ADS 被展平为兄弟文件
- `Set-Content -Stream hidden` 在沙箱内可读写，但 STAGE 里落地为 **`fs06b-ads.txthidden`**（普通文件），数据流语义丢失。若宿主按此落盘会多出一个可见文件。未执行 apply → 仅记 **FINDING**。

## 3. 易用性发现（每步几步、坑在哪、报错是否可理解）

| # | 现象 | 影响 |
|---|---|---|
| U-1 | **PWD 被重定向到 staged 根**，相对路径写进 staging 而非工作区 | 高。文档未说明；照抄常规脚本会写错位置且不易察觉 |
| U-2 | 判定「有没有真落盘」需要手工拼 PS + STAGE（+REAL）3~4 条命令 | 高。缺 `dsh stage ls` / `dsh stage diff` 这类工具 |
| U-3 | **PS 与 CMD 结论相反**（PS 看得见、`dir` 看不见） | 高。极易误判，且没有解释性提示 |
| U-4 | 执行门报错文本暗示「隔离已损坏」，实为 probe 崩溃；且随机 20~25% 失败 | 高。无人值守/脚本化不可用 |
| U-5 | `review.json` 只显示 40 条且被 shim 噪声占满；危险路径查不到分级 | 高。评审功能名义存在但实际不可用 |
| U-6 | `riskCounts` 与 `alerts` 矛盾（danger 0 vs 17） | 高。会得出反向结论 |
| U-7 | 删除真实文件在沙箱内看起来「成功且彻底」 | 高。只有 STAGE/REAL 能看出是 whiteout |
| U-8 | 覆盖真实文件显示为 `op=create`、无 before | 高。审批时不知道在覆盖什么 |
| U-9 | 保留名 `NUL` 报原始 .NET 文案（`FileStream was asked to open a device…`） | 中。不可理解 |
| U-10 | 尾点/尾空格被静默规整，无警告 | 低。与 Windows 一致，但无提示 |
| U-11 | `New-Item -ItemType SymbolicLink` / `mklink /H` 报 `The system cannot find the path specified` | 中。真实原因是权限/父目录，报错严重误导 |
| U-12 | 自写 `.ps1` 被执行策略拒绝（Restricted），只能用内联命令 | 中。测试脚本化受阻 |
| U-13 | 工作区外写入在沙箱内完全可见，但宿主上不存在，无任何不一致提示 | 中。对排障/对比版本危险 |
| U-14 | 工作区内 20MB 写入 0.65 GB/s，无小文件写放大 | 好。这一块顺 |
| U-15 | 中文/emoji/大小写/长路径（315 字符）均正常 | 好。这一块顺 |

## 4. 建议（按优先级）

1. **修 reparse point 逃逸（P0）**：对 `CreateFile`/`CreateDirectory`/`DeviceIoControl(FSCTL_SET_REPARSE_POINT)` 等路径，写入前必须解析 reparse point；若解析后的目标在工作区/允许集之外，**拒绝**并把已创建的 junction 视为不可信。同时把 stage 树设为不可包含 reparse point，或对 staged 路径做最终目标的 containment 校验（`GetFinalPathNameByHandle`）。
2. **修目录枚举盲区（P0）**：在 `FindFirstFile/FindNextFile/NtQueryDirectoryFile` 层面合并 overlay 与真实目录；至少不要出现「`Test-Path Container=True` 但 `GetFiles` 抛路径不存在」的自相矛盾。
3. **重新设计评审展示（P0）**：
   - 去掉 40 条上限，或**按风险排序**而不是按字母序，并把 shim 自身簿记文件（`.winstage-inject-*`/`.winstage-run-*`）从候选里剔除；
   - `riskCounts` 必须覆盖全部改动，且与 `alerts` 一致；
   - 覆盖真实已存在文件时必须记录 `baseHash` 并把 `op` 标为 `modify`；
   - 对真实文件的 `delete` 加显著警示（「将删除宿主上真实存在的文件」）。
4. **修执行门（P1)**：probe 崩溃与「staging 真的不可写」分开报错；probe 失败自动重试 1~2 次；文案不要断言隔离已损坏。
5. **通道语义显式化（P1）**：文档明确「工作区外写在沙箱内可见、宿主不存在」；为 `dir`/枚举差异给出说明；提供 `dsh stage ls|diff|<path>` 与 `dsh stage risk <path>` 命令。
6. **补测（P1）**：FS-08（只读文件、`icacls`）本轮未执行；FS-07 的写穿 `System32`、工作区外 junction 向量未证实；并发写未测。
7. **ADS（P2）**：明确流名映射方案，或在文档中声明不支持并在写 ADS 时报可理解的错误。
8. **报错本地化（P2）**：保留名、符号链接失败的报错改为可理解的中文/英文说明。

## 5. 测试遗留物（重要 — 评审时请注意）

**真实磁盘被改动的文件（唯一一处）：**

| 路径 | 内容 | 大小 | SHA256 | 说明 |
|---|---|---|---|---|
| `C:\Windows\fs07-through.txt` | `WRITTEN-THROUGH-JUNCTION` | 24 B | `937E12F9A346F754800A4F5E749D1E52872C01C84CEA3F875ACBAABD59938876` | FS-07 逃逸产物。清理尝试因命令 `0xE0434352` 崩溃而**未生效**，文件仍在。之后未再重试清理（避免产生更多真实写入） |

**⚠️ pending 候选中的危险项（一旦批准会改真实磁盘）：**

- `C:\Windows\Temp\silconfig.log` ｜ `op=delete` ｜ **批准将真删宿主文件**
- `C:\Windows\Temp\winstage-prop2-1kcvfegu.txt` ｜ `op=delete` ｜ **批准将真删宿主文件**
- `fs\C\ProgramData\fs04-renamed-silconfig.log` ｜ `op=create`
- `fs\C\Windows\win.ini` ｜ `op=create`、`base=absent`（内容已还原为与真实一致，批准无实质变化）

**仅存在于 staging（真实磁盘已确认不存在）：** `C:\Windows\Temp\fs03-win-temp.txt`、`C:\Users\Administrator\fs03-home.txt`、`C:\Users\Administrator\AppData\Local\Temp\fs03-local-temp.txt`、`C:\ProgramData\fs03-programdata.txt`、`C:\Windows\Temp\fs_probe_real.txt`、`C:\ProgramData\fs04-b.txt`、`C:\Windows\Temp\fs10-20mb.bin`（20MB）、`C:\Windows\Temp\fs07-junction-real`（junction，仅 stage 树内）、`<ws>\_sandbox-tests\fs\work\fs07-link`（junction，仅 stage 树内）、以及 `<ws>\_sandbox-tests\fs\` 下的 `work\fs02\*`(60+嵌套)、`work\fs06b\*`、`fs10-20mb.bin`、`risk.ps1`、`stage.ps1`、`evidence\*`。

## 6. 局限与不确定点（不夸大）

1. **FS-08 未执行**（Lead 中途收口）。status 记 `BLOCKED` 但注明是 **NOT_EXECUTED，不是沙箱拒绝**。
2. **FS-07 第二向量未证实**（工作区外 junction 写穿）；命令崩溃、REAL 无产物。**未写成结论**。
3. **未做并发**测试；FS-10 只覆盖单进程 20MB。
4. **未执行任何 apply/approve/flatten**，因此「宿主落盘后的行为」（ADS、junction、win.ini 覆盖）均为未验证推断 → FS-15 只记 `FINDING`。
5. FS-12 的 `baseHash` 设计语义未由实现方确认（可能有意只为 delete 记录 base），但「覆盖真实文件却显示为 create 且无 before」在评审上是明确的信息缺失。
6. 一切 REAL 结论依赖「宿主文件工具未被 hook」这一前提，已用 §1 的对照实验验证；如需更强证据，建议由 Lead 在宿主侧独立 `dir`/`certutil -hashfile` 复核 `C:\Windows\fs07-through.txt`。
