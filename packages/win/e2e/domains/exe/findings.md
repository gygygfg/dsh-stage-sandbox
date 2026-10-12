# EXE 安装完整性与沙箱隔离 —— 测试小结（exe-tester）

**目录**：`_sandbox-tests\exe\`　**会话**：`session-eb7c901d-97ed-4f83-9096-33c97138c361`
**状态计数**：OK × 2（EXE-01、EXE-02）｜FAIL × 2（EXE-03、EXE-04）｜BLOCKED × 2（EXE-02b、EXE-05）｜N-A × 1（EXE-06）｜FINDING × 1（EXE-07）

---

## 1. 结论先说

1. **宿主真实系统没有被改动。** 三通道互证：STAGE 通道里我的 16 个产物全部位于
   `.dshstage\sessions\session-eb7c901d-...\staged\fs\C\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\exe\...`；
   而 CMD 通道（不认 overlay，等同真实磁盘视图）对工作区绝对路径返回 `File Not Found`，
   进程创建也解析不到这些文件。捕获成立、真实磁盘零写入。
2. **但「装一个 exe」这条主线在本沙箱里走不通**：写进工作区的文件只存在于 staged overlay，
   **Windows 进程创建无法解析工作区路径**，所以下载来的安装器/工具无法直接运行。
   唯一可行的执行方式是用内部 staged 路径（详见 §3）。
3. **通道不一致是最严重的问题**：同一路径，PS 说在、CMD 说不在、CreateProcess 说找不到文件。
   这与 PROTOCOL §3「CMD 也被 hook」的前提相矛盾，会直接误导测试者。

---

## 2. 发行包完整性结论（EXE-02 / EXE-03）

| 样本 | 来源 | HTTP | 体积 | SHA256 | Authenticode |
|---|---|---|---|---|---|
| `sigcheck.exe` | `https://live.sysinternals.com/sigcheck.exe` | 200 | 437536 B | `AB8B16649C4211AE6A954C9A614BFB2F97C2076228680F4B305E29885166E5BE` | **Valid**，`CN=Microsoft Corporation`，Time-Stamp Service 已签名 |
| `7z2409-x64.exe` | `https://www.7-zip.org/a/7z2409-x64.exe`（302 → release-assets.githubusercontent.com） | 200 | 1637343 B | `BDD1A33DE78618D16EE4CE148B849932C05D0015491C34887846D431D29F308E` | **NotSigned** |
| `7z2409-extra.7z` | 同上 | **404** | 162 B（错误页） | `766C1D6B...59C07` | — |

**官方哈希比对结论：N-A（不可行），理由已穷尽验证。** 7-Zip 24.09 的 SHA256 在四个官方/准官方渠道都不存在：

- `https://www.7-zip.org/download.html` —— 正文不含任何哈希值；
- GitHub release `body`（经 `api.github.com` 取得）—— 只有 24.09 变更说明；
- GitHub release API 的 16 个 asset —— `digest` 字段**全为空**；
- SourceForge `7z2409-x64.exe.sha256` —— **404**。

因此对 7-Zip 只能给出**较弱的完整性结论**：体积与 GitHub 官方 release API 公布的 asset size
`1637343` 逐字节一致（1637343 == 1637343），且下载全程 TLS；**无签名、无官方哈希可核对**。
`sigcheck.exe` 则有强结论：Authenticode `Valid`，签发者 `CN=Microsoft Corporation`，
thumbprint `AB172913A2960A224809EE8A0C371CD47A079B72`，带微软时间戳。

> 附带发现（读取保真度）：两个文件的 `VersionInfo / FileVersion / ProductVersion / CompanyName /
> FileDescription` 经 PowerShell 读出**全部为空**，而 `sigcheck.exe` 事实上带完整版本资源。

---

## 3. 安装产物落在哪 / 安装器能否安装（EXE-02b / EXE-04）

### 3.1 四通道取证矩阵

| 观察 | PS（`Test-Path`/`Get-Item`/`Get-FileHash`） | CMD（`cmd /c dir`） | CreateProcess | STAGE（`.dshstage\...\staged`） |
|---|---|---|---|---|
| 工作区绝对路径 `...\_sandbox-tests\exe\evidence` | **存在**（True；`Get-Item` 返回 437536 B） | **File Not Found** | **file not found** | 存在（16 个产物） |
| 内部 staged 路径 `fs\C\...\evidence` | — | **可见**（列出全部 16 个） | **可执行**（`.bat`、`.exe` 均退出码 0） | 存在 |

关键命令与原始结果：

```
cmd /c "C:\...\_sandbox-tests\exe\evidence\hello.bat ARG1"
  -> "The system cannot find the path specified."   exit=1
& "C:\...\downloads\sigcheck.exe" -accepteula -nobanner
  -> "Program 'sigcheck.exe' failed to run: The system cannot find the file specified"
cmd /c "fs\C\...\evidence\hello.bat ARG1"
  -> HELLO_FROM_BAT ARG1                            exit=0
cmd /c "fs\C\...\evidence\where_copy.exe cmd.exe"
  -> C:\Windows\System32\cmd.exe                    exit=0
```

**结论：写进工作区的文件只进 staged overlay；PowerShell 能通过 read-through 读到，
但 `cmd` 与进程创建都不认工作区路径。** 想让下载来的工具跑起来，必须手工拼出
`.dshstage\sessions\<sessionId>\staged\fs\C\<盘符>\<路径>`（或从 CWD=`staged` 根用相对路径
`fs\C\...`）。这是一个**无法从任何文档或报错推断出来的**隐性要求。

### 3.2 安装器执行结果

- `sigcheck.exe` 即使从 staged 路径执行也 **fail-fast**：退出码 `-1073740791`（`0xC0000409`
  STATUS_STACK_BUFFER_OVERRUN），stdout/stderr 均为空。
- `7z2409-x64.exe` **未执行**：既因为上面的路径问题，也因为读 manifest 的
  `sigcheck -m` 跑不起来，无法在事前确认 `requestedExecutionLevel`，不愿贸然触发 UAC。
  **本线程全程零交互、零 UAC、零提权。**
- 正向对照：同一 staged 目录下的 `hello.bat` 与 `where_copy.exe`（`C:\Windows\System32\where.exe` 副本）
  都能正常执行并返回退出码 0 —— 说明「staged 路径可执行」成立，被拦下的是 `sigcheck` 这个下载二进制本身。

### 3.3 注册表

本线程没有完成任何安装，因此**未产生任何卸载项**，也未独立取证注册表 overlay
（该域由 registry-tester 负责）。不做无依据的结论。

### 3.4 review.json 风险分级

`...\sessions\session-eb7c901d-...\review.json`：

- `riskCounts`：`normal=1637`、`outside=29`、`sensitive=27`、**`danger=20`**
- `truncated=true`、`listed=40`、`counts.files=1693`
- 全文检索 `_sandbox-tests\exe` 出现次数 = **0**

即：**我这批产物的逐路径风险分级不可得**。danger=20 的条目全部指向
`.dsh` 密钥探针、`.npmrc`、`.ssh` 探针以及 `.t\` 测试脚手架，与 exe 线程无关；
但受 `listed=40`/`truncated` 限制，无法断言我的产物被判为 `normal`。

---

## 4. 易用性（硬性要求）

| Checkpoint | 需要几步 | 卡在哪 / 坑 | 报错是否可理解 |
|---|---|---|---|
| EXE-01 侦察 | 6+ | `winget source update` 对两个源输出**「已取消」**——既不是 `failed` 也不是 `error`，极易误判为成功；要再跑 `winget search` 才看到「尝试更新源失败」 | ✗ |
| EXE-01 choco | — | `choco --version` 崩 `.NET CLR 0xE0434352`，stderr 仅有「由于 Exception.ToString() 失败，因此无法打印异常字符串。」；直接跑真实体则只有 `Access is denied.` | ✗✗ 完全无自救线索 |
| EXE-02 下载 | 2 | 顺。但 `github.com` 直连 443 超时、而 7-zip.org 的 302 落点（release-assets.githubusercontent.com）可达，通道结论相反 | ✓ |
| EXE-03 签名/哈希 | 2~5 | 签名是有效结论；「比对官方哈希」要依次排除 4 个官方渠道才能确认「官方就没发布」 | △ |
| EXE-04 执行/隔离 | 8+ | **最痛**：`Test-Path=True` 而 `CreateProcess=file not found`，三条通道三个答案；唯一解是手工拼 staged 内部路径 | ✗✗ 把人推向「是不是我路径写错了」 |
| EXE-05 运行校验 | — | `0xC0000409` fail-fast，stdout/stderr 全空，无错误码含义说明 | ✗✗ |
| EXE-06 卸载 | — | 因装不上而天然无法验收 | — |
| 全局 | — | 执行门 `STAGING_WRITE_UNVERIFIED` 随机触发，**整条工具调用被拒绝启动**，本线程命中 5 次 | ✗✗ |

### 执行门原文（保留 1 条最完整记录）

```
STAGING_WRITE_UNVERIFIED: refusing to run: the staged root is not verified writable by the
identity this run uses (measured as not writable). reason: 1 staging-write check(s) failed:
outside-write-staged-not-real=fail (child-reported-ok=false real-disk-has-file=false
staged=C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361).
If the command ran, writes outside the workspace would NOT be captured into staging while the
caller still sees exit code 0 — that is the silent-degradation shape this gate exists to prevent.
```

- 触发**随机**，与命令内容弱相关；**原样重试通常 1 次即恢复**（本线程 5/5），但有 2 次需第 3 次才恢复，期间测试线程完全停摆。
- 疑似与多 teammate 并发写 staging 的全局可写性探测竞态有关。
- 建议：门探测加锁，或改为只探测本会话路径；并把拒绝原因**回显到命令输出**而不是只出现在工具层错误里。

---

## 5. 建议（按优先级）

1. **修复或在文档中显式说明「工作区路径不可执行」**。要么让 `CreateProcess` 也走 read-through 映射，
   要么提供 `dsh stage path <workspace-path>` 之类的换算式，并让 `file not found` 报错里带上提示。
2. **统一通道语义**。当前 PS 认 overlay、CMD 与 CreateProcess 不认；PROTOCOL §3「CMD 也被 hook」与实测不符，应更正。
3. **review.json 不应截断到 40 条却仍宣称能做逐路径风险分级**；若必然截断，至少提供按路径查询的接口。
4. **choco 报错不可用**：至少打印异常类型与栈，或明确提示「被沙箱拦截」。
5. `winget source update` 的「已取消」应改为带原因的失败，并指出源不可达/被拦截。
6. 执行门 `STAGING_WRITE_UNVERIFIED` 加锁去竞态；拒绝时把原文并入命令输出。

---

## 6. 测试遗留物

| 位置 | 内容 |
|---|---|
| `downloads\` | `sigcheck.exe`(437536 B)、`7z2409-x64.exe`(1637343 B)、`7z2409-extra.7z`(162 B 错误页) |
| `evidence\` | 侦察/签名/通道/review 原始输出，以及 3 个可执行性对照文件 `hello.bat`、`hello.ps1`、`where_copy.exe` |

**全部仅存在于 staged overlay，真实磁盘零残留。** 未安装软件、未写注册表、未提权、未改系统设置。
