# EXE 域（安装可执行软件：完整性 + 沙箱隔离）—— 第二轮实测小结

- **线程**：exe-tester（8 线程并行之一）
- **会话**：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- **产出目录**：`_sandbox-tests\r2\exe\`
- **状态统计**：OK × 6（EXE-01、02、03b、04、05、06）｜FAIL × 1（EXE-05b）｜BLOCKED × 2（EXE-03、EXE-07）｜N-A × 1（EXE-08）｜FINDING × 2（EXE-09、EXE-10）
- **命令数**：约 45 条 pwsh 调用（不含 web_search / web_fetch）

---

## 1. 一句话结论

**沙箱的"拦住"能力是可信的：我做了 25 个安装域产物、3 个安装器启动尝试、2 个包管理器安装、1 次 D 盘写入尝试，宿主真实磁盘上我的安装域改动为 0 字节。**
但**"能装一个 exe"这条主线在本环境里走不通**——不是沙箱拦的，而是三个环境级缺陷叠在一起：HTTPS 全挂、工作区路径写被拒、注入令牌非管理员而安装器要求提权。

---

## 2. 三通道取证矩阵（核心）

| 观察点 | PS（被 hook） | CMD（被 hook） | STAGE（overlay） | HOST（地面真值） |
|---|---|---|---|---|
| `_sandbox-tests\r2\exe\pkg\7z2408-x64.exe` | 存在、1624144 B、SHA256 已算 | 不可达 | 存在（`fs\C\...`） | **不存在**（真实磁盘无此目录） |
| `C:\Program Files\7-Zip` | `Test-Path`=False | `PF_7ZIP_ABSENT` | — | **不存在**（host glob 空） |
| `D:\winstage-r2\7zip` | False | — | — | **不存在** |
| `C:\winstage-r2-newcwd` | False | mkdir 失败于脚本内（写入被拒） | — | **不存在** |
| `C:\dsh-probe-real` | 创建报 `Access ... denied` | — | — | **不存在** |
| `review.json` / `manifest.json` | 可读 | — | 可读 | — |
| `_sandbox-tests\r2\exe\.hostdir-marker` | 可读（read-through） | — | — | **存在**（由宿主 write 工具创建，已删除） |

**候选与风险分级（STAGE）**：`review.json` → `riskCounts {normal:2945, outside:15, sensitive:1, danger:0}`；`counts.files=2961`、`listed=40`、`truncated=true`。
**我的 25 个产物全部出现在 `manifest.json.files` 里**（含 `fs\C\...\r2\exe`、`...\r2\exe\pkg`、`...\r2\exe\work`、`...\r2\exe\evidence` 四个目录条目），而 `manifest.json.hostOperations = []` —— 即**没有任何真实磁盘操作被记录**。
**但 review.json 只列 40/2961 条，我的路径命中 0 次** → 逐路径风险分级在本轮不可得（与上一轮同样的结论）。

---

## 3. 发行包完整性与来源校验

| 样本 | 来源 | HTTP | 体积 | SHA256 | Authenticode |
|---|---|---|---|---|---|
| `7z2408-x64.exe` | `https://www.7-zip.org/a/7z2408-x64.exe` → 302 github → 302 release-assets | 200 | 1624144 B | `67CB9D34…B099B` | **NotSigned**（SignatureType=None） |
| `PsInfo64.exe` | `https://live.sysinternals.com/PsInfo64.exe` | 200 | 498992 B | `983270DA…D711B9` | **Valid**，`CN=Microsoft Corporation`，thumbprint `AB172913A2960A224809EE8A0C371CD47A079B72`，Microsoft Time-Stamp Service 时间戳 |
| `7zr.exe`（standalone 控制台版） | `https://github.com/ip7z/7zip/releases/download/24.08/7zr.exe` | 200 | 591360 B | `1B16C41A…2C952D` | NotSigned |

- `7z2408-x64.exe` 版本资源：`FileVersion=24.08`、`ProductVersion=24.08`、`CompanyName=Igor Pavlov`、`FileDescription=7-Zip Installer`、`OriginalFilename=7zipInstall.exe`；
  内嵌清单：`requestedExecutionLevel level="requireAdministrator" uiAccess="false"` ← **这是 EXE-03 被 BLOCKED 的根因**。
- **官方 SHA256 仍不可得**：`7-zip.org/download.html` 正文没有哈希列（本轮重新抓取确认）。7-Zip 从不做 Authenticode 签名，所以对这个包**只能给弱完整性结论**（体积 + 双次独立下载哈希一致 + TLS 全程），强结论只能靠 Sysinternals 那个样本。
- 写入/回读一致性：下载时 node 端算的 SHA256 与 PS `Get-FileHash` 回读完全一致（3 个样本全部）。

---

## 4. EXE-03 静默安装：为什么装不上（BLOCKED 的完整证据链）

1. 安装器 `requestedExecutionLevel=requireAdministrator`。
2. 沙箱注入后的子进程**不是管理员**：`WindowsPrincipal.IsInRole(Administrator)=False`；更直接的是在 shim 化 cmd 子进程里跑 `whoami` 返回 **`ERROR: Access is denied.`**（同一个 `whoami` 在 pwsh 自身里正常）。
3. UAC 同意界面在 shim 下无法呈现 → `7z2408-x64.exe /S`、`start /wait "" … /S`、`Start-Process -PassThru` 三条路径全部**挂住不返回**，既不报错也不退出；`D:\winstage-r2\7zip` 始终不存在。

**替代路线（EXE-03b）**：改用官方 standalone `7zr.exe`，无需提权，功能完整：
```
7zr.exe i                                   -> RC=0（打印格式/编码器表）
7zr.exe a -t7z payload.7z payload.txt -mx=5 -> RC=0, 197 B, SHA256=4972DD17…E06D459
7zr.exe l payload.7z                        -> RC=0, 1 file / 5202 B
7zr.exe x payload.7z -o<dir> -y             -> RC=0
解出 payload.txt SHA256=D1A1787F…590CBC == 源文件 SHA256  → 往返完整性成立
```

---

## 5. EXE-05b / EXE-06：工作区路径写被拒 + "新目录作 CWD" 复验

### 5.1 FAIL：工作区路径写被整体拒绝（fail-closed）

```
Set-Content  ...\_sandbox-tests\r2\exe\t.txt              -> Could not find a part of the path '...\r2\exe\t.txt'
New-Item     ...\_sandbox-tests\r2\exe\pkg                -> Access to the path 'pkg' is denied.
New-Item     ...\_sandbox-tests\r2\exe2                   -> Access to the path 'exe2' is denied.
cmd /c "echo X> ...\r2\exe\shim-canary.txt"               -> The system cannot find the path specified. (exit 1)
cmd /c "mkdir ...\r2\exe3"                                -> The directory or file cannot be created.
New-Item     C:\dsh-probe-real                            -> Access to the path 'dsh-probe-real' is denied.
```
同一棵树的**内部 staged 路径**写法全部成功：
```
<stageRoot>\fs\C\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\exe\pkg\7z2408-x64.exe   ← 成功
```
而宿主 `write` 工具刚创建的 `.hostdir-marker` **通过工作区路径是可读的** → 读穿透（read-through）正常，**只有写映射是坏的**。
这就是开局 `STAGING_WRITE_UNVERIFIED` 门报的 `outside-write-staged-not-real=fail` 的具体表现。

### 5.2 复验"新建目录不能作子进程 CWD" —— **不成立，上一轮是误判**

```
pushd C:\winstage-r2-newcwd            (全新空目录)
"%B%\pkg\7zr.exe" a -t7z "%NEW%\fresh.7z" "%B%\work\payload.txt"
  -> RC_NEWCWD=0   CWD_AT_RUN=C:\winstage-r2-newcwd
  -> 7zr 自身报 ERROR: cannot open file（因为输出路径落在 stage 树之外，被沙箱拒写）
```
即：**进程能起来、CWD 正确**；真正被拒的是**写到 stage 树之外的输出路径**。上一轮把"输出被拒"归因成"CWD 不被解析"，本轮用 `RC=0 + CWD_AT_RUN` 直接证伪。

### 5.3 四种启动上下文的真实结果

| # | 上下文 | 结果 |
|---|---|---|
| 1 | staged 绝对路径，CWD=stage 根 | ✅ RC=0（PsInfo64 / 7zr） |
| 2 | **全新空目录作 CWD** | ✅ RC=0（输出路径在 stage 内即可；落在 stage 外则 7zr 自己报 `cannot open file`） |
| 3 | 工作区路径启动 | ❌ `Not enough memory resources are available to process this command.` + `The system cannot find the path specified.` exit=1 |
| 4 | staged 根下相对路径 `.\pkg\7zr.exe` | ✅ 正常 |
| 附 | 带 `WINSTAGE_SHIM_DISABLE=1` | 无差别（本轮该开关既没造成泄漏，也没能"救活"工作区路径——因为那条路径在真实磁盘上根本不存在） |

---

## 6. EXE-07 包管理器：两条路都断（BLOCKED）

```
winget.exe --version / source list / install -e --id 7zip.7zip --silent / list   -> 全部 RC=-1978335231 (0x8A150021)
                                                                                    （WindowsApps 的 AppExecutionAlias，AppX 激活被拒）
choco.exe --version                                                              -> 2.7.4 / RC=0
choco.exe install 7zip.install -y --no-progress                                   -> "Unable to load the service index for source
                                                                                    https://community.chocolatey.org/api/v2/"
                                                                                    + Schannel 凭证错误原文
                                                                                    "7zip.install not installed ... 0/1 packages"
                                                                                    （另提示 "not running from an elevated command shell"）
```
宿主真实磁盘前后均无 7-Zip。

---

## 7. 易用性（硬性要求）

| Checkpoint | 需要几步 | 卡在哪 | 报错可理解? |
|---|---|---|---|
| EXE-01 下载 | 2（成功路线）/ 5（试错） | `curl.exe` 完全不能 HTTPS（`SEC_E_NO_CREDENTIALS`）；PowerShell 里 `& curl.exe` 报 `Program 'curl.exe' failed to run: Access is denied`，而 `cmd /c curl.exe` 正常；`Invoke-WebRequest`/`WebClient` 同样失败。最后靠 `node.exe` 才通 | ✗ |
| EXE-02 校验 | 2~4 | 7-Zip 无签名 + 官方无哈希，只能给弱结论 | △ |
| EXE-03 安装 | ∞ | **requireAdministrator + 非提权令牌 = 静默挂死**，无任何提示 | ✗✗ |
| EXE-04 安装物 | 1 | 顺（对可获得的可执行文件） | ✓ |
| EXE-05 隔离 | 6+ | 隔离本身可信；但逐路径风险要从 2.8 MB 单行 `manifest.json` 的巨型分号串里猜，`review.json` 只列 40/2961 | ✗ |
| EXE-05b 写自己目录 | 8+ | **最痛**：文档化的工作区写法被拒，未文档化的内部 staged 写法才能成功 | ✗✗ |
| EXE-06 运行 | 4 | 同一意图两种误导性报错（`not enough memory` / `file not found`），都不提示"请用 staged 路径" | ✗ |
| EXE-07 包管理器 | 3+ | winget 十六进制退出码无解释；choco 中文报错在日志里是 **乱码（GBK mojibake）** | ✗ |
| 全局 | — | `STAGING_WRITE_UNVERIFIED` 本线程命中 **3 次**（其中 1 次命令里根本没有写操作），整条工具调用被拒；另有 1 次 `EBUSY: resource busy or locked, read`；原样重试均恢复 | ✗✗ |

### 门拒绝原文（保留 1 条最完整）
```
STAGING_WRITE_UNVERIFIED: refusing to run: the staged root is not verified writable by the
identity this run uses (measured as not writable). reason: 1 staging-write check(s) failed:
outside-write-staged-not-real=fail (child-reported-ok=false real-disk-has-file=false
staged=C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\session). If the command ran,
writes outside the workspace would NOT be captured into staging while the caller still sees
exit code 0 — that is the silent-degradation shape this gate exists to prevent.
```

---

## 8. 建议（按优先级）

1. **修工作区路径写映射**（或至少让 read-through 的读和写语义一致）。当前"能读不能写"是最容易让人自我怀疑的形态：`Test-Path`=True、`Get-Content` 能读，但一写就 `Access is denied`。要么让 `CreateProcess`/写路径都走 overlay 映射，要么提供 `dsh stage path <workspace-path>` 换算命令，并把提示写进报错里。
2. **让 `STAGING_WRITE_UNVERIFIED` 只在真的执行写操作时触发**，并把它探测的具体失败路径回显到命令输出；本线程有 1 次触发在纯读命令上。
3. **安装器提权场景给出显式诊断**：`requireAdministrator` 的 EXE 在非提权 shim 令牌下应当立刻返回一条"需要提权且当前令牌非提权，无法完成"的错误，而不是挂死。
4. **文档化 HTTPS 不可用的替代方案**：本机 Schannel 取不到凭证（`SEC_E_NO_CREDENTIALS`，`--insecure` 与 `WINSTAGE_SHIM_DISABLE=1` 都无效），`node.exe` 可作 HTTPS 下载通道；PROTOCOL 里"用 curl.exe 下载"在本环境第一步就走不通。
5. **`review.json` 应支持按路径查询**（现在 `listed=40` + `truncated=true`，逐路径风险实质不可得）；`manifest.json` 的 `files` 不要做成单行巨型分号串。
6. **修非 ASCII 输出转码**：choco 的中文报错在采集到的日志里是 mojibake，直接毁掉排障价值。
7. 更正上一轮结论：**"新建目录不能作子进程 CWD"不成立**，真实限制是"不能写到 stage 树之外"。

---

## 9. 遗留物清单（真实磁盘）

| 位置 | 内容 | 状态 |
|---|---|---|
| `_sandbox-tests\r2\exe\` | `results.json`、`findings.md`、`executions.log`、`evidence\*` | **故意保留**（线程必需产出）。这些文件由 **DSH 宿主 `write` 工具**创建——即走了宿主直写真实磁盘通道，未进 staging/候选；已在本文件与 results.json 中标注。附带发现：对这些文件做**覆写/删除**会被 shim 拒绝（`Access to the path ... is denied`），只有宿主工具能改 |
| `_sandbox-tests\r2\exe\.hostdir-marker` | 用来让真实目录存在的临时标记（58 B，宿主 write 工具创建） | **清理失败，仍残留**：经 shim 的 `Remove-Item -Force` → `Access to the path is denied.`，`Set-Content ''`（截断）→ `Access to the path '...\.hostdir-marker' is denied.`。即 shim 对该文件的删除/覆写一律拒绝；本线程无宿主级删除工具，故无法自行清理。**建议 Lead 用 HOST 通道删除** |
| `C:\Program Files\7-Zip` / `D:\winstage-r2\7zip` / `C:\winstage-r2-newcwd` / `C:\dsh-probe-real` | — | **从未创建**（host glob / Test-Path 确认为不存在） |
| `HKCU\...\Uninstall\7-Zip` 等注册表 | 预先存在的 `7-Zip 24.09` 卸载项，InstallLocation `C:\Progra~1\7-Zip\` 而该目录**不存在** | **非本线程创建**，属"幽灵卸载项"，未改动，仅记录 |
| 沙箱 overlay（非真实磁盘） | `pkg\`（3 个 exe + 6 个日志）、`work\`（bat/out/7z/txt）、`evidence\` 共 25 个产物 | 全部只在 `.dshstage\...\staged\fs\C\...`，已列入 `manifest.json.files` |
| 真实磁盘上的其他线程产物 | 未触碰（`_sandbox-tests\r2\network\probe-x.txt` 等由我把 staged 路径写出来时产生，位于他人目录之外的同级目录，非我写） | — |

**未做**：未装驱动、未改安全设置、未提权（也提不了）、未写 Run 启动项、未执行 `flatten`/`apply`/`approve`。
