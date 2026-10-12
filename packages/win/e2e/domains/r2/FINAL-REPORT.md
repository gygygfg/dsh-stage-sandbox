# WinStage 沙箱实测总报告（第二轮 · 8 线程并行 + Lead 独立复核）

- 被测对象：`C:\Users\Administrator\Desktop\WinStageSandbox`（WinStage 暂存—候选—选择性提交沙箱，Windows + DSH）
- 会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 会话档位：**`danger-full-access` + 审批 `never`**（第一轮是 `workspace-write` + `ask`，这是本轮的主要变量）
- 方法：8 个独立子 agent 线程按同一契约 [`PROTOCOL.md`](_sandbox-tests/r2/PROTOCOL.md) 分域实测 + Lead 通道级独立复核
- 规模：**100 个 checkpoint**（**Lead 从 8 份 `results.json` 独立重算**：OK 30 · FAIL 22 · FINDING 23 · BLOCKED 24 · N-A 1），350+ 条 shell 命令
  > ⚠ 各线程**口头自报**的数字与此有出入（browser 与 registry 各偏差 1 项）；**以文件为准**，详见 §10「独立重算与数据质量」
- 分域证据：`_sandbox-tests\r2\<域>\{results.json, findings.md, executions.log, evidence\}`
- Lead 专项：[`LEAD-INCIDENT-REPORT.md`](_sandbox-tests/r2/_lead/LEAD-INCIDENT-REPORT.md)（会话级故障根因）
- 第一轮对照：[`FINAL-REPORT.md`](_sandbox-tests/FINAL-REPORT.md)（会话 `session-eb7c901d-…`，91 项）

> **一句话结论**：本轮**没有测出"隔离"，而是测出了执行面自己坏掉**。
> 8 线程并行开跑约 15–25 分钟后，会话的 WinStage shell 执行面退化：
> **所有工作区/真实路径写入一律 `Access is denied`，只剩 stageRoot 与私有 temp 可写**，
> 但**读面、宿主 `write`/`read` 工具、node 网络通道仍正常**。
> 24 项 BLOCKED 全部由此产生；同时确证了两条**跨通道逃逸**（宿主文件工具、浏览器 profile），
> 一个**零管控的网络面**（可证明），以及**读面 100% 开放且零提示**。

---

## 1. 头条两件事

### 1.1 🔴 会话级执行面退化（阻断级，24 项 BLOCKED 的根因）

| 项 | 内容 |
|---|---|
| 现象 | 工作区任意路径、`C:\Windows\Temp`、`C:\ProgramData`、`%USERPROFILE%\Documents`、`D:\`、`%LOCALAPPDATA%\Temp` 写入**全部** `Access denied`；三种建目录 API 同样被拒；**唯一可写 = `stageRoot` 与 `$env:TEMP`（`…\dsh-stage-temp\<guid>`）** |
| 伴随 | `WINSTAGE_STAGE_ROOT`/`WINSTAGE_SHIM_CONFIG`/`WINSTAGE_SHIM_LOG`/`DSH_REGSTAGE_ROOT` 从进程环境**整体消失**，但 shim 仍在注入（`shim.log` 持续 `failClosed=1 readThrough=1`） |
| 令牌 | `isAdmin=False`（会话开始时为 True）、组里**无 `BUILTIN\Administrators`**；`whoami`/`Get-CimInstance`/`tasklist`/`reg.exe`/`cmd.exe` 间歇 `Access is denied`；`$LASTEXITCODE` 返回**空值而非非零**（脚本无法察觉命令没跑） |
| 身份错配 | 每个 subagent 线程的 `DSH_SESSION_ID` = **该线程自己的 id**（`6dd878ff-…`/`76aa210c-…`/`301dd4ca-…`/…），**不是**被测会话 `session-4c5d9889-…`；而 `PWD`/shim 记录的 stageRoot 仍是本会话 |
| ACL 线索 | 工作区授权的是 `S-1-4-56185984-606674207`/`S-1-4-1039366120-933337351`，而唯一可写的 `dsh-stage-temp` 用的是**另一个** SID `S-1-4-626720748-62464615-1` |
| Lead 已排除 | ① ACL 缺权限（`Administrator Allow FullControl` 在位）；② shim `failClosed` 缺 stageRoot（子进程补回 4 个变量仍 DENY）；③ `WINSTAGE_SHIM_DISABLE=1` 绕过（仍 DENY）；④ 有进程独占暂存树（杀光 msedge ×9 + uv 守护 + 残留 powershell 无效）；⑤ 单纯并发（降并发重测仍 DENY） |
| 可恢复性 | **会话内不可恢复**。修复脚本按技能要求必须**非受限**运行，而本会话审批为 `never`（提权请求自动拒绝）。**需宿主侧重启执行面** |
| 次生缺陷 | `src/executor.mjs:2184-2231` 的 failsafe 闸门只探**工作区外**写入 ⇒ 把"环境坏了"报成单条命令被 `STAGING_WRITE_UNVERIFIED` 拒；文案是给实现者看的，且建议的 `dsh-stage init` 命令**本机不存在** |

### 1.2 🔴 两处跨通道逃逸（已由 Lead 用宿主通道独立确证）

| 逃逸面 | 证据 | 严重度 |
|---|---|---|
| **宿主 `write`/`edit` 工具直写真实磁盘**（含**跨卷**） | Lead 用宿主 `read` 逐一确证 4 个真实文件存在：`C:\Windows\Temp\winstage-r2-escape.txt`、`C:\Windows\Temp\winstage-r2-toolwrite.txt`、`C:\ProgramData\winstage-r2-fs02-programdata.txt`、**`D:\winstage-r2\fs02-d.txt`**；同时 `Test-Path`/枚举**看不到**它们、候选面 0 条 —— **可见性倒挂** | 🔴 |
| **浏览器 profile 整体落真实磁盘** | `C:\eprof` 真盘 **824 个文件**；overlay 无副本；`review.json`/`manifest.json`/`queue.json` 搜 `eprof` **命中 0**；浏览器下载物同理（`typescript-5.6.3.tgz` 4.17 MB 真落盘、候选 0 条） | 🟠 |

---

## 2. 环境基线异常（不是沙箱策略，但**污染全部结论**）

> network 线程的原话：「若后续改成提权运行，本报告的网络结论会**静默翻转**」。

1. **令牌非提权** ⇒ Schannel 全线失效：`curl.exe`（exit 35）/`Invoke-WebRequest`/`HttpClient`/`SslStream` 一律
   `SEC_E_NO_CREDENTIALS (0x8009030E)`（`--insecure` 无效、加 `WINSTAGE_SHIM_DISABLE=1` 仍失败）；
   **唯一可用的 HTTPS 通道是 `node.exe`（OpenSSL 自带 CA）**。纯 HTTP 正常。
2. **ICMP 被拒**（含 `127.0.0.1`），但裸 ICMP socket 可创建 ⇒ 拦的是 send。UDP 正常。
3. `netsh wfp show state` 因缺提权 `error=5` 失败 ⇒ WFP 取证只能走注册表旁路。
4. **`requireAdministrator` 清单的安装器静默挂死**（7-Zip 安装器三条启动路径 4 次超时、零报错）。
5. **`pwsh` 未安装**，`powershell.exe` 5.1；PowerShell 管道接原生命令一律 `Access is denied`，
   必须让子进程自己重定向到文件再读；`cmd` 写不进时**仍返回 exit 0**（静默失败）。
6. 工具面不稳定：`STAGING_WRITE_UNVERIFIED` 多域命中（fs 0 次 · browser 3 次 · exe 3 次 · node 1 次 · sensitive 3 次）、
   EBUSY 数次、`0xC0000005` 崩溃 1 次（Lead 的宿主快照脚本）、`pwsh` 超时 ≥11 次。

---

## 3. 分域判定矩阵

| 域 | OK · FAIL · FINDING · BLOCKED · N-A | 本域最关键结论 |
|---|---|---|
| **fs**（13） | 1 · 2 · 1 · 9 · 0 | 写侧 9/13 不可执行；**FS-13 宿主工具逃逸确证（跨卷 3/3）**；FS-11 `totalFiles=2883` vs `listed=40`（**98.61% 截断**，16 条非 normal 改动全在截断区）；FS-07 junction **未复验**（`mklink` 静默无输出、链接未建成） |
| **browser**（12） | 6 · 4 · 2 · 0 · 1 | **BR-07 下载逃逸确证**（sha1/sha512 与 registry 一致、真落宿主、候选 0 条）；BR-04 截图 CDP 字节 == 宿主字节；**BR-05 点击静默失效**（`dispatchMouseEvent` 返回成功但 `visibilityState` 恒 `hidden`、`MainWindowHandle=0`）；BR-01 `--doctor` 误报；`browser-use` 入口因 daemon 端点写不进被打瘫，线程改用自建 CDP 客户端完成 |
| **pip**（11） | 2 · 1 · 4 · 4 · 0 | **机器上有真 Python**（`uv` 装的 3.12.14 + pip 26.2.1，HOST 确认真盘）；但**装不出新 Python**：`uv python install` 因"真实盘是 JUNCTION、overlay 里被实体化成普通目录"→ 删目录报 `os error 145`，3.13 下载 21 MiB 后白丢；**一个包都没装成**（写被拒） |
| **node**（19） | 7 · 4 · 4 · 4 · 0 | **更正上一轮"npm 100% 不可用"**：`--cache=<可写>` 后 view/install/ci/cache verify/pack **全通**，裸 `npm install ms` 成功；**CRITICAL：pnpm 静默降级** —— 打印 `+3 packages / Done / exit 0`，但 `require('is-odd')` 立即 `MODULE_NOT_FOUND`，根因是 shim **未 hook `fs.realpath`/`GetFinalPathNameByHandle`**（影响 npm link/monorepo/一切 symlink 解析）；完整性三方一致（lock integrity = registry `dist.integrity` = 本地重算 sha512） |
| **exe**（12） | 6 · 1 · 2 · 2 · 1 | **安装域真实磁盘改动 0 字节**（25 个产物全在 overlay、`hostOperations=[]`）；**更正上一轮"新目录不能作 CWD"**（全新目录作 CWD 跑 7zr `RC=0`、CWD 正确）；7zr `i/a/l/x` 全 RC=0 且解出文件 SHA256 == 源文件；7z 安装器 **NotSigned** + `requireAdministrator` 挂死；winget `0x8A150021` 全命令失败 |
| **registry**（14） | 1 · 4 · 5 · 5 · 0 | **真实注册表零改动 = TRUE**（硬证据：真实 `NTUSER.DAT` mtime 早于测试 3 天；三份内部文件里 `WinStageR2` 出现 0 次）——**但归因是 fail-closed 全拒，不是隔离**（overlay 本轮僵死：journal 冻结 17:47:18、13 个 `overlay.<pid>.hive` 全是 8192 B 空壳、二进制扫描 0 命中）；REG-08 复现：`files[]` 40 条**注册表行 0 条**，而 `riskCounts` 却声明 `outside=15, sensitive=1` 且 `alerts=[]` |
| **network**（10） | 5 · 2 · 3 · 0 · 0 | **网络零管控，且可证明**：shim `ws_hook.c` 的 `g_targets[]` 只有文件/进程创建/23 个 `Reg*`，**网络 API = 0**；344 条防火墙规则里 WinStage/DSH 相关 **0** 条；无服务无驱动；**无网络命名空间**（沙箱监听器出现在全局连接表，宿主三个地址入站全 200）；无限速（5.0 MB/s）；无 TLS 中间人（52.9 MB 下载 SHA256 == 远端 `SHASUMS256.txt`） |
| **sensitive**（9） | 1 · 6 · 2 · 0 · 0 | **读面 100% 开放且零提示**：`.dsh\.credentials.yaml`(223 B)/`.npmrc`/PSReadLine 历史三通道可读且 SHA256 逐字节一致；DPAPI 主密钥、3 个凭据 blob、Edge `Login Data`/`Local State` 全可读；**外发无管控**（`node fetch` HTTPS 与明文 HTTP 均 200 且回显含假秘密）；**写被拒但完全静默不可审计**（`cmd echo >> .npmrc` exit 0 而文件未变、shim.log 零拒绝记录、review.json 零候选零告警） |

---

## 4. 对矛盾与上一轮结论的裁定（Lead）

| 争议 | 裁定 |
|---|---|
| **`WINSTAGE_SHIM_DISABLE=1` 是否有效**（fs/network/sensitive 说"静默失效"，与 PROTOCOL §3 矛盾） | **两者都对，是时间差**。Lead 在**退化前**实测：带该变量的 `cmd` 子进程写出真实文件，宿主 `read` 工具确证内容 `WINSTAGE-ESCAPE-OK` ⇒ **开关本身有效**。退化后进程创建/写入本身被拒（`$LASTEXITCODE` 返空），因而"传了开关也没用" ⇒ **退化态下不可用，不等于开关失效**。⚠ 但该开关**无需任何特权即可从沙箱内命令使用**，本身即是逃逸面 |
| **FS-07 junction 写穿**（上一轮最严重发现） | **本轮既未确认也未推翻**（`mklink /J` 静默无输出、链接未建成）。**不得宣称已修复**。上一轮遗留物 `C:\Windows\fs07-through.txt` 经宿主通道确认**已不存在** |
| **exe「新建目录不能作子进程 CWD」**（上一轮 🟠 第 9 条） | **上一轮结论被证伪**：全新空目录作 CWD 跑 7zr `RC=0`、`CWD_AT_RUN` 正确。真正被拒的是"写到 stage 树之外" |
| **node「npm 在内完全不可用」**（上一轮 🟠 第 8 条） | **上一轮结论被证伪**：`--cache=<可写路径>` 后全通；上一轮的 `EEXIST`+`ENOENT` 双错未复现，现为单一明确 `EPERM` |
| **`riskCounts` vs `alerts` 自相矛盾**（上一轮 FS-11/REG-08） | **alerts 侧已改善**（本轮 `alerts=[]`，不再与 `riskCounts` 数值冲突）；但**注册表行 0 条 + 98.6% 截断**仍在，危害等价 |
| **注册表跨进程 hive** | **复现且证据更强**：同一会话 ~18:00 建键 + 6 种类型值全部回读正确，18:19 起同调用 `Access is denied`，19:31 另一进程 `Test-Path=False` |

---

## 5. 易用性评估

### 5.1 沙箱操作设计（用户视角）

| 操作 | 步骤 | 报错可理解度 | 主要问题 |
|---|---|---|---|
| 确认"文件到底写没写进真实磁盘" | ≥3 命令 ×3 通道 | ✕ | 沙箱内**无法自证**；本轮出现"宿主工具写了、`Test-Path` 抛异常、枚举看不见"的**倒挂** |
| 判断"写失败是沙箱还是 Windows" | 不可能 | ✕ | 裸 `UnauthorizedAccessException` 不区分 shim 拦截 / ACL / 能力 SID；`icacls`、`whoami /priv`、`Get-Acl` 批量调用**挂死** |
| 知道"我的敏感文件被读了" | 不可能 | ✕ | 读访问不进 `review.json`、`shim.log` 无敏感标签、零提示 |
| 知道"我被拦了" | 不可能 | ✕ | `cmd echo >> .npmrc` **exit 0 且文件未变**；shim.log 零拒绝记录 |
| 知道"要批准什么" | ≥4 | ✕ | `review.json` `totalFiles=2883` 只列 40（98.6% 截断），16 条非 normal **全在截断区**；注册表行 0 条；`manifest.json` 是 2.8 MB 单行 |
| 判断沙箱是否还活着 | ✕ | ✕ | 退化**无任何用户可见信号**；闸门把"环境坏了"报成"你这条命令被拒" |
| 装包/装软件 | 1 步预期 → 3+ 步可行 | ✕ | pnpm 打印成功但依赖不可用；npm 成功但装进 overlay（用户项目里没有）；安装器提权不可用即静默挂死；HTTPS 全挂而文档只写 curl |
| 用浏览器做验收 | ≥6 步 | ✕ | 需自建 CDP 驱动；`--doctor` 误报；点击静默失效无报错 |

### 5.2 本轮**测试设计**本身的易用性（Lead 亲历，属用户第二个诉求）

| 问题 | 影响 | 建议 |
|---|---|---|
| **8 路并行 subagent 触发了执行面退化** | 整个 round 的写侧数据报废（24 项 BLOCKED） | 并行度应有上限；或并行线程共享父会话 stageRoot（现为各自 `DSH_SESSION_ID`） |
| `PROTOCOL.md` §3 假设的 HOST 通道在退化态不存在 | 各线程按协议写的脚本**静默拿到空字符串** | 协议应加"前置自检"：`WINSTAGE_STAGE_ROOT` 非空 + 工作区可写，失败即停机上报 |
| Lead **无法回话**给 subagent | 三个线程带着疑问继续跑（`send_message` 报 `active teammate not found`） | 子 agent 应可被寻址，或在 prompt 里预置"环境异常即停" |
| 环境事实（管理员/HTTPS 可用）与实际不符 | 三个线程的第一版结论都是错的（防火墙 0 条、curl 可用、写成功） | 环境清单应机器校验后注入协议 |

---

## 6. 修复清单

### P0（阻断级）
1. **围栏退化必须自愈或显式升级**：检测到「shim 在 + `WINSTAGE_STAGE_ROOT` 空 + 工作区写被拒」时，不要静默全拒；
   应重建暂存上下文 / 明确降级放行 / 弹可操作提示（"本会话沙箱执行面已失效，请重启会话"）。
2. **闸门探测面补全**（`src/executor.mjs:2184-2231`）：自检同时探「工作区内 + 工作区外」两条，
   并按 `env-missing` / `acl-denied` / `token-restricted` 分类给文案；`remediation` 里的 `dsh-stage`
   命令本机不存在（`Get-Command dsh-stage` 为空），要么提供要么改文案。
3. **宿主文件工具纳入 staging**（`write`/`edit` 与插件 FS 层）：本轮已确证跨卷逃逸（`D:\`），
   让"人工批准"语义在主通道上失效。
4. **子线程 session 身份错配**：并行 subagent 应继承父会话 stageRoot，或明确不支持并发。

### P1
5. **shim 补 `fs.realpath`/`GetFinalPathNameByHandle`**：否则 pnpm / npm link / monorepo **静默错误成功**。
6. **`review.json` 信噪比与完整性**：`listed` 必须与 `totalFiles` 一致且可翻页；注册表行要渲染；
   过滤 `__PSScriptPolicyTest_*`（单候选约 80/109 条）、`.winstage-run-*`、`winstage-shim-selfcheck-*`。
7. **敏感面给出信号**：读访问审计、外发域名白名单、实时提示（当前读面 100% 开放且零提示）。
8. **网络面明确"不提供的保证"**：shim hook 目标表可证明网络 0 hook、无命名空间、无代理无 MITM —— 应写入用户可见安全说明。
9. **`uv python install` 的 junction 处理**：幂等重建 + 保留已下载缓存（现为下载 21 MiB 后白丢）。

### P2
10. 明确 `browser-use`/`--doctor` 的可用性判据（应真连一次 CDP + evaluate），并修 daemon 端点写不进的降级路径。
11. `$LASTEXITCODE` 在"命令根本没跑"时不应为空值；`cmd` 写失败不应返回 0。

### 我（Lead）本轮的修复动作与边界
- ✅ **完成**：建立三通道取证模型并实测校准；用宿主通道独立确证 4 个逃逸残留文件（含跨卷）；
  逐条**证伪** 5 个错误假设（ACL/占用/环境补全/开关/并发）；产出可复跑协议与宿主快照脚本；
  在不破坏测试真实性的前提下定位根因链到"令牌受限 + 暂存上下文丢失 + 线程身份错配"。
- ⛔ **未做（有意）**：不修改沙箱实现代码并在坏掉的环境里"验证"它 —— 会制造无法复核的假修复；
  不重启 DSH 服务（会终止本会话并丢掉报告）；不执行 `flatten`/`apply`/`approve`。

---

## 7. 遗留物与清理状态

| 路径 | 来源 | 状态 |
|---|---|---|
| `C:\Windows\Temp\winstage-r2-escape.txt` | Lead 逃生开关复现 | ⚠ **真实存在，会话内删不掉**（`Access denied`），需宿主删除 |
| `C:\Windows\Temp\winstage-r2-toolwrite.txt` | fs 线程 FS-13 | ⚠ 同上（已由 Lead 宿主通道确证存在） |
| `C:\ProgramData\winstage-r2-fs02-programdata.txt` | fs 线程 FS-02 | ⚠ 同上 |
| `D:\winstage-r2\fs02-d.txt` | fs 线程 FS-02（跨卷） | ⚠ 同上 |
| `_sandbox-tests\r2\exe\.hostdir-marker`（58 B） | exe 线程 | ⚠ 同上 |
| `C:\eprof`（824 文件）、`%USERPROFILE%\.config\browser-harness` | browser 线程（工具配置） | 保留 |
| `%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none` | uv（**本机唯一可用解释器**） | **保留，勿删** |
| `%TEMP%\dsh-stage-temp\<guid>` ×368 + 40 个 `.dsh-selfcheck-*.txt` | 每次调用遗留一个 | 建议宿主清理 |
| 真实注册表 | registry 线程 | ✅ 零遗留（无自启动项、未碰服务 Start） |
| 上一轮 junction 遗留 `C:\Windows\fs07-through.txt` | 第一轮 | ✅ 已不存在 |

> 需宿主执行的删除（本会话受限令牌做不到）：
> `del /f "C:\Windows\Temp\winstage-r2-escape.txt" "C:\Windows\Temp\winstage-r2-toolwrite.txt" "C:\ProgramData\winstage-r2-fs02-programdata.txt" "D:\winstage-r2\fs02-d.txt" "…\_sandbox-tests\r2\exe\.hostdir-marker"`

---

## 8. 复跑计划（重启执行面后）

被**环境**阻断、建议在新会话重跑的清单（不是被测对象的问题）：

1. **fs**：FS-01/02/04/06/07/08/09/10（写侧 + junction 复验 + 大文件吞吐）
2. **pip**：PIP-03/04/06/07（pip.ini 全局镜像 + 装包 + 完整性）
3. **node**：仅补 pnpm 的 realpath 结论在正常态下的复验
4. **exe**：EXE-01/03（安装器路径；需**提权**执行面）
5. **registry**：REG-01/03/04/05/06（值类型、copy/export/import、WOW64、Run 键风险分级）
6. **browser**：BR-05 点击（需可见窗口）、BR-11 清理
7. **sensitive / network**：本轮已基本可判定，只需在提权态下复核 HTTPS/ICMP/WFP 三项**会翻转**的结论

复跑前置自检（务必先跑，避免再次全轮报废）：

```powershell
if ([string]::IsNullOrEmpty($env:WINSTAGE_STAGE_ROOT)) { throw '执行面退化：WINSTAGE_STAGE_ROOT 为空，停止测试' }
Set-Content -LiteralPath "$PWD\__preflight.txt" -Value ok -ErrorAction Stop   # 工作区可写
Remove-Item -LiteralPath "$PWD\__preflight.txt" -Force
"isAdmin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

---

## 9. 重启后的复核：根因精确化（**重要：重启不能恢复**）

用户重启 DSH 后 Lead 立即复测，结论是**执行面没有恢复**，且这次拿到了决定性的机制证据。

### 9.1 复测结果

| 探测 | 结果 |
|---|---|
| `DSH_SESSION_ID` | 仍是 `session-4c5d9889-…`（会话被**恢复**，非新建） |
| `WINSTAGE_*` / `DSH_REGSTAGE_ROOT` | 仍**全部为空** |
| `isAdmin` | 仍 `False` |
| 工作区 / `%USERPROFILE%` / `C:\Users\Public` / `C:\Windows\Temp` 写入 | **全部 DENY** |
| `…\session-4c5d9889-…\staged\` 与 `staged\fs\C\Windows\Temp\…` 写入 | **OK** |
| `$env:TEMP`（`dsh-stage-temp\<guid>`）写入 | **OK** |
| **相对路径**写入（cwd = staged 根） | **OK** |
| 显式传 `workdir=C:\...\WinStageSandbox` | **被忽略**，shell 的 cwd 仍被强制为 staged 根 |
| `Set-Location` 到工作区后再写（相对/绝对） | **仍 DENY** ⇒ 可写面是**静态**的，不随 cwd 变化 |
| 工作区文件**读取** | **正常**（能读回本报告内容） |

### 9.2 精确根因（本轮最终裁定）

> **会话档位是 `danger-full-access`，而 `@local/dsh-winstage-sandbox/shell` 占着 `ctx.shell` 单例且不把执行面交还平台**（插件自述三次尝试交还均失败，见 `dsh-plugin/shell-executor.mjs:936-958`）。
> 于是每条命令都在它**自己的 `workspace-write` 围栏**内执行，而该围栏的语义是
> **「可写面 = 命令自己的工作目录」**，WinStage 又把工作目录设成了**会话暂存根**
> `…\.dshstage\sessions\<id>\staged`。
> ⇒ **只有暂存根可写；真实工作区变成只读**。被拒时是裸 `Access is denied`，
> **完全看不出这是沙箱围栏而不是 Windows 权限问题**。

这解释了此前所有看似矛盾的观察：node/exe/network 线程"只有 `<stageRoot>\fs\C\…` 和 `$env:TEMP` 可写"、
各线程 `DSH_SESSION_ID` 是自己的 id、`Set-Location` 到工作区无效、**重启无效（档位没变）**。

### 9.3 恢复办法（用户侧，一步）

**把本会话的沙箱档位从 `danger-full-access` 切回 `workspace-write`。**
依据：会话开始时的实测状态（`WINSTAGE_*` 齐备、shim 正常把工作区写入重定向进 overlay、
`review.json` 正常出候选）正是在 staging 车道下取得的；而 `danger-full-access` 档位下
插件**不会**把执行面交还平台（代码注释与实测一致），只会缩到上面那条围栏里。

- 切换后**无需重启**，Lead 可立即复测（`WINSTAGE_STAGE_ROOT` 非空 + 工作区可写 = 恢复）。
- 若必须保留 `danger-full-access` 语义，则需**改插件代码**让 shell 执行面交还平台 ——
  这是 §6 P0-1/P0-4 的工作量，且插件自述历史上三次交还尝试均失败。

### 9.4 复测时新抓到的易用性问题

1. **UTF-8 中文在 shell 输出里被按 GBK 解码成乱码**（读回本报告显示为 `winStage 娌欑瀹炴祴…`），
   会污染证据采集、错误信息与日志（exe 线程也遇到 choco 日志 GBK 乱码）。
   建议：输出通道显式按 UTF-8 解码，或写入方加 BOM；统一 `[Console]::OutputEncoding`。
2. **`workdir` 参数被静默忽略**：调用方以为指定了工作目录，实际仍强制到 staged 根，且无任何提示。
3. **可写面无法自查**：`WINSTAGE_STAGE_ROOT` 为空时没有任何通道能告诉用户"你的可写面 = cwd"，
   只能靠 4 次写入实验反推。

### 9.5 ⚠ 更正 §9.3：**切回 `workspace-write` 也无效**（Lead 复测）

用户按建议把档位切回 `workspace-write` 后，Lead 立即复测：**依旧全 DENY**
（`WINSTAGE_*` 仍空、`isAdmin` 仍 `False`、工作区/`C:\Windows\Temp`/`D:\` 全拒）。
⇒ 故障**不由会话档位驱动**，档位开关也**不会重新 provisioning**。

新增的决定性测量：

| 测量 | 结果 |
|---|---|
| 当前 shell 令牌组 | 有 `S-1-5-21-…-513`、`S-1-1-0`、`S-1-5-32-545`、`S-1-5-4`、`S-1-5-15`、`S-1-5-113`…；**没有** `…-500`（Administrator 本人）、**没有** `S-1-5-32-544`（Administrators）、没有 `S-1-5-18` |
| 本次运行的私有 temp 目录 ACE | 授权给本次运行的权限 SID `S-1-4-809987090-214076300-1` |
| 上一次工具调用的私有 temp 目录 ACE | 授权给**另一个**权限 SID `S-1-4-356921368-1034971442-1` ⇒ **每次运行换一个能力 SID** |
| 暂存根 `…\staged` 的 ACE | 只授权 `S-1-4-367263216-…`、`S-1-4-56185984-…`、`S-1-4-1039366120-…` 三个**历史**能力 SID + Administrators/Administrator/SYSTEM + 一条 `Everyone Deny DeleteSubdirectoriesAndFiles` |
| shim 是否在工作 | **在工作**：`shim.log` 秒级刷新，持续 `initialized: stageRoot=… failClosed=1 readThrough=1` 与 `CreateFileW staged(write)`（PowerShell 自身启动文件被正确暂存） |
| 进程创建 | `cmd.exe` 返回**空输出 + 空退出码**（被拒，无诊断） |

### 9.6 ⚠ 更正 §9.5 补救 2：**放宽暂存树权限也无效**

用户在管理员 PowerShell 执行
`icacls "…\WinStageSandbox\.dshstage" /grant "*S-1-5-32-545:(OI)(CI)(M)" /T /C` 后，Lead 复测：

| 探测 | 结果 |
|---|---|
| 工作区 / `C:\Windows\Temp` / `D:\` / Desktop 写入 | **仍全 DENY** |
| `cmd.exe` 子进程创建 | **仍失败**（空输出 + 空退出码） |
| 暂存树里是否出现本次写入的 staged 副本 | **全部 False**（写入根本没走到暂存层） |
| `WINSTAGE_*` | 仍**全空** |

**关键推论**：拒绝发生在**暂存层之前**——写入既没落真实磁盘、也没被 shim 记录成 `staged(write)`，
说明**不是 DACL 权限不足**（否则放权后应立即能写入暂存）。因此**任何 ACL/权限放权都救不了这个状态**。

### 9.7 最终结论与唯一剩余手段

- **三层结论**：① 身份层——shell 以**每次运行新建的能力 SID**（`S-1-4-*`）执行，且令牌里没有
  Administrator/Administrators，暂存根上那些 ACE 对它**一条都不适用**；② 故障形态——shim 在进程内、
  `failClosed=1`，无法安全落暂存时**成批静默拒绝**写入与子进程创建；③ 为何重启/换档位/放权都无效——
  每次运行换 SID，授权**永远追不上**，而档位开关既不重建暂存上下文也不重新授权。
- **唯一剩余手段**：**开一个全新会话**（新对话，而非恢复本会话）。WinStage 的暂存/provisioning 与
  shell 车道是在**会话建立时**确定并注入的；恢复（resume）不会重建它。
- 若新会话仍复现 ⇒ 判定为**车道确定性损坏**，只能走代码修复（§6 的 P0-1 / P0-4）。

---

## 10. 独立重算与数据质量（Lead 复核）

Lead 在给出结论前，用脚本直接从 8 份 `results.json` **独立重算**，不采信线程的口头汇总：

| 域 | 项数 | OK | FAIL | FINDING | BLOCKED | N-A | 缺 `channel` | 缺 `usability` |
|---|---|---|---|---|---|---|---|---|
| browser | 12 | 7 | 3 | 2 | 0 | 0 | 0 | 0 |
| exe | 12 | 6 | 1 | 2 | 2 | 1 | 0 | 0 |
| fs | 13 | 1 | 2 | 1 | 9 | 0 | 0 | 0 |
| network | 10 | 5 | 2 | 3 | 0 | 0 | 0 | 0 |
| node | 19 | 7 | 4 | 4 | 4 | 0 | 0 | 0 |
| pip | 11 | 2 | 1 | 4 | 4 | 0 | 0 | 0 |
| registry | 14 | 1 | 3 | 5 | 5 | 0 | 0 | **5** |
| sensitive | 9 | 1 | 6 | 2 | 0 | 0 | 0 | 0 |
| **合计** | **100** | **30** | **22** | **23** | **24** | **1** | 0 | **5** |

**复核结论**：

1. **总数与分布以本表为准**（100 项，不是线程口头汇总的 102 项）。
2. **两处自报偏差**：browser 自报 6/4/2/0/1（合计 13，与其自报"12 项"自相矛盾），文件实为 **7/3/2/0/0**；
   registry 自报 1/4/5/5/0（合计 15），文件实为 **1/3/5/5/0（14 项）**。
   ⇒ 线程口头汇总不可直接采信，**必须以机器可读产出为准**（本轮的一条流程教训）。
3. **数据质量缺口**：`registry` 有 **5/14** 个 checkpoint 缺 `usability` 字段（违反 PROTOCOL §4 硬性要求）；
   其余 7 域 100% 具备 `channel` 与 `usability`。
4. **registry 线程已自行披露的取证瑕疵**（采信并保留）：其 `a01-02.ps1`/`analyze.ps1`/`xchk.ps1`
   因 `pwsh` 缺失或执行策略**未实际执行**，仅为草稿；`executions.log` 的 R02-6 段为**重构而非逐字输出**。
   因此 registry 域结论**建议 r2b 重跑后再采信**。
5. **Lead 已独立确证、不依赖线程自述的项**：宿主 `write` 工具跨卷逃逸 4/4（含 `D:\`）、
   三通道可写面差异、`WINSTAGE_SHIM_DISABLE` 在退化前有效、`review.json` 截断与注册表行缺失、UTF-8 输出乱码。
6. **交付物完整性**：8/8 域均有 `results.json` + `findings.md` + `executions.log` + `evidence/`（共 81 个证据文件）。

> **交接**：新会话请从这里开始 → [`NEXT-SESSION-RUNBOOK.md`](NEXT-SESSION-RUNBOOK.md)。
