# R11 · D3「exe 安装完整性与沙箱隔离」实测报告

> 执行者：teammate `t3-exe` · 时间盒内共 **3 次嵌套 run**（`d3-run1` winstage / `d3-run2` platform 对照 / `d3-run3` winstage MSI 复测）
> 宿主：Windows Server 2025 Datacenter build 26100（10.0.26100）· 常驻宿主 `supervisor.mjs` pid 9452（`.t\r11\supervisor.pid.txt`）
> 沙箱档位原始判据：`.t\r11\exe\run1\out\lane.txt` → `tierEffective=TS / degraded=false / launchMode=shim / shimCount=38 / LANE_OK=true`
> 纪律：每条结论附原始证据路径；未跑的一律 `not-run`；推断标 `[推断]`；引用外部页面均给 URL。

---

## 0. 结论速览

| # | 请求项 | 上一轮（R10）判定 | **本轮（R11）实测判定** |
|---|---|---|---|
| 1 | 发行包完整性 | 通过（GitHub digest 比对） | **通过（换权威通道）**：4/5 与独立公开清单逐字节 MATCH；`7zr.exe` 无公开清单（厂商 `.sha256` 404）⇒ `no-published-digest`；GitHub API 通道本轮**网络不可达（not-run）** |
| 2 | 可运行性 | `7zr.exe i` → 退出码 0 | **推翻**：`7zr.exe i` → **退出码 1 / `Access is denied.`**；根因强相关于**32 位（i386）镜像**（见 §3，宿主侧 PE 解析 + 4 组 A/B 对照） |
| 3 | 安装器能否装成 | 一律被拒（5 / 1601 / 0x8A150001） | **部分推翻**：AMD64 的 `7z2604-x64.exe /S /D=<ws>\app2604` **退出码 0 且产出 107 个文件**——但**全部落进暂存 overlay，真实盘零文件**；i386 的 `7z1900-x64.exe` 仍 `Access is denied.`（退出码 1，并崩溃留下 WER 报告）；MSI 改到真实日志目录后仍失败：`/L*v`→**1622**、去掉 `/L*v`→**1601**，且 `MsiInstaller` 事件日志**无本次任何事务**、overlay `journal` **0 字节**、产物两边都没有（§4.3）；winget `0x8A150001`、choco `0xE0434352` 复现 |
| 4 | 安装后隔离复核 | 零残留 | **主体复现、但有真实盘副作用（本轮新发现）**：Program Files 20,513→20,513、Program Files (x86) 4,077→4,077、Uninstall 45/18/0、Run 值集合、开始菜单 80/19 全部不变；4 个越界探针文件真实盘不可见（overlay 内 5 B）。**但**：ProgramData 3,141→**3,154** 文件 / 1,130→**1,131** 目录，其中 `WER\ReportArchive` 下 **20 个 `AppCrash_{7zr,7z1900-x64,7zr_copy,choco,cmd}.exe_*` 崩溃报告**（真实盘，时间戳 23:59:32–00:08:36，正落在 run1/run3 窗口内）；另残留 **1 个 `msiexec /V` 进程**（pid 5596，00:08:46 起，由我在收尾时 kill） |
| 5 | 暂存面 | 未细分 | **明确**：文件写→`stage-root\staged\fs\…`，注册表写→`registry\overlay.journal` + `overlay.hive`；越界写进 `candidates\cs_00xx_*.json` 待批队列；安装产物**只进 overlay** |
| 6 | 拒绝归因 | "路径级策略，不是 ACL" | **修正为两段式**：① 越界**写**不是拒绝而是 **透明重定向进 overlay**（shim 通道，`failClosed:true` 未触发）；② 真正的硬拒只出现在 **i386 镜像执行**（进程启动后被拒并崩溃→WER）与 **MSI 服务通道**（1622/1601）上，且二者在 **platform 对照（`WINSTAGE_SHELL=0`）下均成功**（`7zr.exe i` EXIT 0、`Program Files` 与 `HKLM` 写成功且真实落盘）⇒ 拒绝来自 WinStage shim 层，**不是** Windows ACL |

**一句话**：WinStage TS 档对 exe 的隔离是"**改写为暂存 + 真实盘零改动**"，不是"拒绝一切安装"；本轮真正的功能性缺陷是 **32 位（i386）可执行文件在该通道下被 `ERROR_ACCESS_DENIED` 硬拒**（`7zr.exe` 因此完全不可用），以及 **MSI 因日志路径耦合 overlay 而 1622 失败**。

---

## 1. 环境与判据

| 项 | 实测值 | 证据 |
|---|---|---|
| 沙箱档位 | `launchMode=shim`、`tierEffective=TS`、`degraded=false`、`winStageEnabled=true`、`shimCount=38`、`degradeCount=0` | `.t\r11\exe\run1\out\lane.txt`、`…\stage-root\sandbox-lane.json` |
| shim 配置 | `failClosed=true`、`readThrough=true`、`stageRoot=<out>\stage-root\staged` | `.t\r11\exe\run1\out\stage-root\staged\winstage-shim.config.json` |
| 子线程 env | `WINSTAGE_STAGE_ROOT=<out>\stage-root\staged`；`$PWD` = 该 staged 目录（**不是**声明的 ws） | run1 最终答复 §前置说明；`…/staged/winstage-shim.config.json` |
| stderr（沙箱装配） | **0 字节** | `.t\r11\exe\run1\out\stderr.txt`（run2、run3 亦为 0） |
| 宿主盘余量 | 41.0 GB free（下载 5 个候选共 ≈68 MB） | `Get-PSDrive C` 原始输出见 §9 复现 |
| profile 文件策略 | `danger-full-access` + `approval: never`（`.t\r11\home\profiles\sbx\cordis.patch.yml`） | 该文件第 27–45 行 |

> 机制注（来自 `dsh-plugin` 代码通读，用于解释现象，本身不是被测结论）：
> TS 通道**不给子进程铸造受限令牌**，而是"普通令牌 + 正常完整性 + 注入 shim"；shim 把**写意图**重定向到 `<stageRoot>\fs\<盘符去冒号>\…`，注册表写入 `registry\overlay.hive` + WAL `overlay.journal`，**无法暂存时 fail-closed 返回 `ERROR_ACCESS_DENIED` 且不触碰真实系统**。证据：`dsh-plugin/shell-executor.mjs:1585-1589`、`shim/src/ws_file.c:3-6`、`shim/src/ws_stage.c:4-6`、`shim/src/ws_regstore.c:4-5`、`dsh-plugin/shell-executor.mjs:1822-1832`。

---

## 2. 发行包完整性（宿主侧 + 线程内两侧）

权威清单通道：**GitHub Release asset digest 本轮不可达**（`api.github.com`/`github.com` 443 均不通，DNS 正常；原始探测见 `evidence-provenance.md` §1）⇒ 标 `not-run`，改用**两个独立公开清单**：Chocolatey 官方包内 `legal/VERIFICATION.txt`（sha256）与 npmmirror `SHASUMS256.txt`。

| 文件 | size | sha256（宿主/线程两侧一致） | 权威来源 | 结论 |
|---|---|---|---|---|
| `7zr.exe` | 602,624 | `256feca8…d282` | 无公开清单（`https://www.7-zip.org/a/7zr.exe.sha256` → **404**） | `no-published-digest`（仅"厂商站直连 200"） |
| `7z1900-x64.exe` | 1,447,178 | `0f5d4dbb…c45e` | choco `7zip.install` 19.0 `checksum64` | **MATCH** |
| `7z-choco-x64.exe`（26.04） | 1,664,082 | `d54bf805…665d` | choco `7zip.install` 26.4.0 `checksum64` | **MATCH** |
| `node-v22.14.0-x64.msi` | 30,916,608 | `2c0cc97e…b386` | npmmirror `SHASUMS256.txt` | **MATCH** |
| `node-v22.14.0-win-x64.zip` | 34,906,389 | `55b63929…f217` | npmmirror `SHASUMS256.txt` | **MATCH** |

原始行（宿主侧 `.t\r11\exe\evidence-provenance.md` §2；线程内 `<ws>\ev\a1-hashes.txt` = 638 B，两者逐项一致）：
```
7z-choco-x64.exe	1664082	D54BF805F9F3704D1E8DB2FA3498AE7EF2DF0312B40B558E7C71C734430A665D
7z1900-x64.exe	1447178	0F5D4DBBE5E55B7AA31B91E5925ED901FDF46A367491D81381846F05AD54C45E
7zr.exe	602624	256FECA8E274E5DA655E2A284FABAFD9F554365EB164862089DACD4E8276D282
node-v22.14.0-win-x64.zip	34906389	55B639295920B219BB2ACBCFA00F90393A2789095B7323F79475C9F34795F217
node-v22.14.0-x64.msi	30916608	2C0CC97EC64C1E4111362E1E32E0547FD870E4D9C79EC844C117DA583F21B386
```
`Get-AuthenticodeSignature`：三个 exe 全部 **NotSigned**；线程内另用 PE 证书表解析交叉验证（`certVA=0 certSize=0`），并以 `C:\Windows\System32\notepad.exe`（`Valid`）作对照，排除读取通道导致的假阴性。原始：`<ws>\ev\a2-signatures.txt`（1,049 B）。

**新增观察（R10 → R11）**：`7zr.exe` 同一 URL、同一 size（602,624 B）但哈希不同（R10 `ad4c82fa…` vs 本轮 `256feca8…`）；线程内 `7zr.exe i`（platform 对照）自报 `7-Zip (r) 26.04 (x86) … 2026-10-05` ⇒ 该 URL 是**未钉版本的移动目标**，[推断] 厂商在其后更新了 7zr.exe。按 URL 做完整性比对不可复现，需钉 `26.04`/带清单的 URL。

---

## 3. 可运行性：**32 位（i386）镜像被硬拒**（本轮核心缺陷）

run1（WinStage）原始结果：

| 步骤 | 命令 | EXIT | 原文/结果 |
|---|---|---|---|
| B1 | `<ws>\cand\7zr.exe i` | **1** | 输出仅 19 字节：`Access is denied.`（无版本行） |
| B2 | `7zr.exe t node-v22.14.0-win-x64.zip -y` | **1** | `Access is denied.` |
| B3 | `7zr.exe e <zip> LICENSE -o<ws>\x -y` | **1** | `Access is denied.`，`<ws>\x` 无产物 |
| B4 | `7zr.exe l node-v22.14.0-x64.msi` | **1** | `Access is denied.` |
| B0 | 把 `7zr.exe` 复制到 passthrough 的 stage root 再跑 | **1** | 仍 `Access is denied.` |
| B6 | `C:\Windows\SysWOW64\cmd.exe /c echo WOW` | **1** | `Access is denied.` |

同目录对照（run1 内，同一 ACL、同一路径，仅位数不同）：

| 映像 | PE machine | WinStage(TS) 结果 | platform 对照(run2) |
|---|---|---|---|
| `7zr.exe` | `0x014C` i386 | **EXIT=1 `Access is denied.`** | **EXIT=0**，打印 `7-Zip (r) 26.04 (x86) : Igor Pavlov : Public domain : 2026-10-05` |
| `7z1900-x64.exe` | `0x014C` i386 | EXIT=1 `Access is denied.` | not-run（未在对照里跑） |
| `7z-choco-x64.exe` | `0x8664` AMD64 | **EXIT=0（安装成功，§4）** | not-run |
| `C:\Windows\System32\cmd.exe` | `0x8664` | 正常 | — |
| `C:\Windows\SysWOW64\cmd.exe` | `0x014C` | `Access is denied.` | — |

PE 位数为**宿主侧独立解析**（无沙箱介入，见 `evidence-provenance.md` §4），因此"位数 ↔ 拒绝"不是线程内自证。
证据路径：`<ws>\ev\b1-7zr-i.txt`、`b2-test-zip.txt`、`b3-extract.txt`、`b4-list-msi.txt`、`b6-wow64-err.txt`（各 19 B）、`b0-7zr-passthrough.txt`（19 B）；platform 对照：`.t\r11\exe\run2\ws\ev\p1-7zr-i.txt`（1,072 B，真实盘）。
⇒ **判定**：这是 **WinStage shim 通道对 WOW64/i386 映像的缺陷**（`[推断]` 机制为 shim 注入/重定向在 32 位子系统内未生效而 fail-closed）；不是 Windows ACL、也不是"没有管理员权限"（同一文件在 platform 模式同一账户下成功）。

---

## 4. 安装器实测

### 4.1 逐条原始退出码

| # | 命令（指向工作区内目录） | EXIT | 原文 / 结果 |
|---|---|---|---|
| C1 | `7z1900-x64.exe /S /D=<ws>\app1900` | **1** | `Access is denied.`；`Test-Path <ws>\app1900`=False |
| C2 | `7z1900-x64.exe /S`（默认安装） | **1** | `Access is denied.` |
| C3 | `7z-choco-x64.exe /S /D=<ws>\app2604` | **0** | 0 字节输出（静默成功）；`Test-Path <ws>\app2604`=**True**；overlay 内 **107 个文件** |
| C4 | `msiexec /a <msi> /qn TARGETDIR=<ws>\msiapp /L*v <ws>\ev\c4-msi-admin.log` | **1622** | `ERROR_INSTALL_LOG_FAILURE`；日志未生成；`msiapp` 不存在 |
| C5 | `msiexec /i <msi> /qn /norestart ALLUSERS=1 INSTALLDIR=<ws>\msiapp2 /L*v <ws>\ev\c5-…log` | **1622** | 同上 |
| C6a | `winget --version` | **-1978335231**（`0x8A150001`） | 输出 0 字节 |
| C6 | `winget install --id 7zip.7zip -e …` | **-1978335231** | 输出 0 字节 |
| C7a | `choco --version` | **-532462766**（`0xE0434352`） | `由于 Exception.ToString() 失败，因此无法打印异常字符串。` |
| C7 | `choco install 7zip.install -y --no-progress` | **-532462766** | 同上（79 字节） |

### 4.2 C3"装成了"到底意味着什么

overlay 内 `<ws>\app2604` 产物（前 25 条，`<ws>\ev\c3b-dir-app2604.txt` 184 B + F 段计数）：
```
7-zip.chm 127442 / 7-zip.dll 101888 / 7-zip32.dll 67584 / 7z.dll 1907712 / 7z.exe 577536 /
7z.sfx 215552 / 7zCon.sfx 194560 / 7zFM.exe 1003520 / 7zG.exe 725504 / History.txt 12112 /
License.txt 6031 / readme.txt 1711 / Uninstall.exe 17408 / Lang\af.txt 4621 … （共 107 个文件）
```
真实盘交叉验证（同一 ws，宿主侧与线程内两侧一致）：
```
Get-ChildItem <ws> -Force            -> 只有 cand\ 与 seed.txt（看不到 ev\、app2604、inws-probe.txt）
Test-Path <ws>\app1900               -> False（0 条目）
Test-Path <ws>\app2604               -> True（但是 overlay 命中）
Get-ChildItem <ws>\app2604 -Recurse  -> DirectoryNotFoundException: Could not find a part of the path…
cmd /c dir <ws>\app2604              -> File Not Found (EXIT=1)
```
⇒ **安装器"成功"只发生在 overlay 命名空间内；真实盘 `C:\…\exe\run1\ws` 仍只有 `cand\` + `seed.txt`。** 这与 §5 的安装后系统面差分（delta=0）互相独立地互证。

### 4.3 MSI 1622/1601：不是（只）日志路径问题，而是 MSI 服务通道整体不可用

- run1 的日志路径是 `<ws>\ev\…log`，而 `<ws>\ev\` **只存在于 overlay**；`msiexec` 的 `msiserver` 服务进程未注入 shim，看不到 overlay，日志无法创建 ⇒ `1622 ERROR_INSTALL_LOG_FAILURE`。此为最初假设。
- **run3 复测推翻了"仅日志问题"**（`run3` 全量原文：`.t\r11\exe\run3\FINAL-run3.md`）：
  - `/a … TARGETDIR=<ws>\msiapp3 /L*v C:\Windows\Temp\r11d3-msi-admin.log` → `EXIT=1622`；日志**仍未生成**（`Test-Path C:\Windows\Temp\r11d3-msi-admin.log` = False）
  - `/i … INSTALLDIR=C:\ProgramData\wst-r11-d3-msi\app /L*v …` → `EXIT=1622`；目标目录 False
  - **去掉 `/L*v`** 同一条 `/i` → `EXIT=1601`（`ERROR_INSTALL_SERVICE_FAILURE`）
  - `sc query msiserver` → `STATE: 4 RUNNING`，但 `Get-WinEvent ProviderName=MsiInstaller` 最新事件仍是 **2026/9/28**：本次 1622/1601 **完全没有产生任何 MsiInstaller 事务事件**
  - 产物落点：overlay `fs\C` 下**没有 ProgramData**（计数 0），真实盘 `C:\ProgramData\wst-r11-d3-msi` = False ⇒ **两边都没有**
  - `shim.log`（≈12 MB）里 `msiexec` / `r11d3-msi` / `wst-r11-d3-msi` **0 命中**；`registry\overlay.journal` **0 字节 / 0 行**
- **修正后的判定**：MSI 失败源于 **客户端 ↔ msiserver 服务通道在沙箱内不可用**（`1601`），日志路径只是把同一失败表现成 `1622`。`[推断]` 服务进程未注入 shim 后既看不到 overlay 路径、其 RPC/事务也无法建立；**精确机制未定**（见 §9）。
- **安全面**：无论哪种失败形式，after 差分（§5）证明 `Program Files*` / `Uninstall` / `Run` / 开始菜单 **delta=0**，且 overlay `journal` 为空 ⇒ 本轮**没有任何 MSI 落盘**。

---

## 5. 安装后隔离复核（前后系统面差分）

快照方法：`snapshot3.ps1`（原生 `dir /s /b /a-d|/ad` 行计数 + 注册表 provider；**逐行 append**，任何超时都保留部分证据）。基线 `2026-10-10T23:58:06`，终态见 §5.3。

### 5.1 基线（`snap-before.txt`，原样）

```
DIR|C:\Program Files|files=20513|dirs=2544|top=25
DIR|C:\Program Files (x86)|files=4077|dirs=366|top=18
DIR|C:\ProgramData|files=3141|dirs=1130|top=19
STARTMENU|C:\ProgramData\Microsoft\Windows\Start Menu\Programs|files=80
STARTMENU|C:\Users\Administrator\AppData\Roaming\Microsoft\Windows\Start Menu\Programs|files=19
UNINSTALL|HKLM:\…\Uninstall|subkeys=45|names=7-Zip 24.09 (x64); Git; LocalSend…; Node.js; Tailscale; (Office 一批)
UNINSTALL|HKLM:\…\WOW6432Node\…\Uninstall|subkeys=18
UNINSTALL|HKCU:\…\Uninstall|subkeys=0
RUN|HKLM:\…\Run|values=AzureArcSetup,SecurityHealth
RUN|HKLM:\…\WOW6432Node\…\Run|values=
RUN|HKCU:\…\Run|values=LocalSend
KEY|HKLM:\SOFTWARE\7-Zip|exists=True|subkeys=0
KEY|HKCU:\SOFTWARE\7-Zip|exists=True|subkeys=0
KEY|HKLM:\SOFTWARE\Node.js|exists=True|subkeys=1
PATH|C:\Program Files\7-Zip|exists=False
PATH|C:\Program Files\nodejs|exists=True
PATH|C:\ProgramData\chocolatey|exists=True
PROCS|count=16|node|…; powershell|…（仅宿主/室友线程进程）
```
注意两处**基线既有状态**（避免误判为残留）：`Uninstall` 里有 `7-Zip 24.09 (x64)` / `Node.js`，但 **`C:\Program Files\7-Zip` 基线不存在**；`C:\Program Files\nodejs` 已存在。

### 5.2 终态与差分（`snap-after.txt`，2026-10-11T00:12:10，即 3 个 run 全部结束之后）

| 复核项 | 基线（23:58:06） | 终态（00:12:10） | delta |
|---|---|---|---|
| `C:\Program Files` | 20,513 文件 / 2,544 目录 / top 25 | **20,513 / 2,544 / 25** | **0 / 0 / 0** |
| `C:\Program Files (x86)` | 4,077 / 366 / top 18 | **4,077 / 366 / 18** | **0 / 0 / 0** |
| `C:\ProgramData` | 3,141 / 1,130 / top 19 | **3,154 / 1,131 / 19** | **+13 / +1 / 0**（见下） |
| 开始菜单（公用 / 用户） | 80 / 19 | **80 / 19** | **0 / 0** |
| `Uninstall` 子键 HKLM / WOW6432 / HKCU | 45 / 18 / 0 | **45 / 18 / 0** | **0 / 0 / 0** |
| `Uninstall` DisplayName 集合 | 见 §5.1 | **逐项相同** | **0** |
| `Run` 值集合 HKLM / WOW6432 / HKCU | `AzureArcSetup,SecurityHealth` / 空 / `LocalSend` | **完全相同** | **0** |
| `HKLM\SOFTWARE\7-Zip`、`HKCU\SOFTWARE\7-Zip` | True/0、True/0 | True/0、True/0 | 0 |
| `HKLM\SOFTWARE\Node.js` | True / 1 子键 | True / 1 子键 | 0 |
| `C:\Program Files\7-Zip` | False | **False** | 0（**未装成**） |
| 4 个越界探针路径（文件/目录） | 全 False | **全 False** | 0 |
| 探针注册表键 `wst-r11d3-probe` / `wst-r11d3-ctl` | 全 False | **全 False** | 0 |
| 遗留进程 | count=16（全宿主/室友 node+powershell） | count=14，但含 **`msiexec|5596|00:08:46`** | 见 §5.3 |

**`C:\ProgramData` 的 +13/+1 归因（本轮最重要的"非零残留"发现）**：定向扫描 `LastWriteTime > 2026-10-10T23:57` 发现**20 个真实盘 WER 崩溃报告目录**：
```
C:\ProgramData\Microsoft\Windows\WER\ReportArchive\
  AppCrash_7zr.exe_91309f8cd6966bf4...    x9  (23:59:32 / 23:59:34 / 23:59:38 / 23:59:39 / 00:00:13 / 00:00:15 / 00:08:15 / 00:08:23 / 00:08:25)
  AppCrash_7z1900-x64.exe_13cc8248efeb... x3  (00:00:42 / 00:00:44 / 00:01:26)
  AppCrash_7zr_copy.exe_166223e21723a1... x1  (00:00:20)
  AppCrash_choco.exe_a3d8ad66acbe3b06...  x2  (00:02:56 / 00:03:04)
  AppCrash_choco.exe_c56a52f685e27b7f...  x2  (00:02:58 / 00:03:04)
  AppCrash_cmd.exe_c63fe4598fbb9abb67...  x3  (00:01:19 / 00:05:26 / 00:08:36)
```
- 时间戳全部落在 `d3-run1`（23:57:53 起）与 `d3-run3`（00:07:23 起）窗口内，崩溃对象正是**我的候选/探测二进制** ⇒ **可归因于本轮沙箱内尝试**，而不是宿主既有状态。
- 含义：`7zr.exe`/`7z1900`/`choco`/`cmd` 的"被拒"其实是**进程在启动后被拒/崩溃**，而 **WER 服务（未注入 shim）把崩溃报告写进了真实盘**——这是隔离面上的一个**真实副作用**（安装产物与注册表仍零残留）。
- 计数口径不一致（`dir /s /b /ad` 报 +1 目录，而定向扫描找到 20 个新目录）**如实记录为未解释项**：`[推断]` WER 归档在写入时对旧目录做了回收/复用，或该子树未被 `dir /s` 完整遍历；两种口径都保留原始输出。
- 其余 ProgramData 变动（ASUS `*.etl`、Defender `MPLog/Scans`、`Diagnosis`、`Tailscale`、`USOShared`、`AppRepository`、`regid.1991-06…`）时间戳与本轮无关，属**后台系统活动**，不计入本次残留。

### 5.3 遗留进程与收尾

- run1 的 E 段（线程内）：`tasklist` → `INFO: No tasks are running which match the specified criteria.`；`Get-Process`（`7z|msiexec|choco|winget|node`）为空 ⇒ 那一刻 0 遗留。
- **但**终态快照（00:12）抓到 **`msiexec` pid 5596，`C:\WINDOWS\system32\msiexec.exe /V`，起始 00:08:46**（run3 的 MSI 尝试留下的服务实例，run3 于 00:10 结束仍在）。
- 我已在收尾时 `Stop-Process -Id 5596 -Force`，复核 `Get-Process msiexec` → **0**（原始：`before: 1 msiexec / after: 0 msiexec`）。
- ⇒ **"零遗留进程"不成立**：MSI 失败会留下存活的 `msiexec /V`。WER 崩溃目录**未清理**（不在我的写入范围 `.t/r11/exe/**` 内，且属证据）；已在上表逐条列出，建议由 Lead 决定是否清理。

### 5.4 越界探针与残留进程

| 目标 | run1（WinStage） | 真实盘可见性 | run2（platform 对照） | 真实盘可见性 |
|---|---|---|---|---|
| `C:\Windows\Temp\wst-r11d3-*.txt` | SUCCESS | **False**（仅 overlay `fs\C\Windows\Temp\…` 5 B） | SUCCESS | **True**（实测 5 B，已由我删除） |
| `C:\ProgramData\wst-r11d3-probe.txt` / `…\wst-r11-d3-ctl\a.txt` | SUCCESS | **False**（overlay 5 B） | SUCCESS | **True**（已删除） |
| `C:\Program Files\wst-r11d3-probe.txt` / `…\wst-r11-d3-ctl\a.txt` | SUCCESS | **False**（overlay 5 B） | SUCCESS | **True**（已删除） |
| `C:\Users\Administrator\Desktop\wst-r11d3-probe.txt` | SUCCESS | **False**（overlay 5 B） | SUCCESS | **True**（已删除） |
| `<ws>\inws-probe.txt` / `inws-ctl.txt` | SUCCESS | False（overlay） | SUCCESS | **True** |
| `HKCU\Software\wst-r11d3-probe`（PS 与 `reg.exe` 双通道） | EXIT=0 / SUCCESS | **真实 hive 读不到**（候选记录原文：`系统找不到指定的注册表项或值…refusing to translate "we could not read it" into "the key does not exist"`） | SUCCESS | **True** |
| `HKLM\Software\wst-r11d3-probe`（`reg.exe`） | EXIT=0 / SUCCESS | 真实 hive 读不到 | `reg add HKLM…` **EXIT=0 / The operation completed successfully.** | **True** |

进程残留（run1 E 段）：`tasklist` 原文 `INFO: No tasks are running which match the specified criteria.`；`Get-Process` 过滤 `7z|msiexec|choco|winget|node` 为空 ⇒ **0 遗留进程**（`<ws>\ev\e1-tasklist.txt` 64 B）。

---

## 6. 归因：拒绝来自 WinStage shim，不是 Windows ACL

同机、同账户（`win-dv9kreclbvs\administrator`）、同 profile（`sbx`）、同候选二进制，**唯一变量 = `WINSTAGE_SHELL`**：

| 探测 | WinStage（run1，WINSTAGE_SHELL=1） | platform 对照（run2，WINSTAGE_SHELL=0） |
|---|---|---|
| 32 位 exe 执行 | `7zr.exe i` → EXIT=1 `Access is denied.` | `7zr.exe i` → **EXIT=0**，输出 1,072 B 版本行 |
| `C:\Program Files\wst-r11-d3-ctl\a.txt` 写 | 报告 SUCCESS，真实盘无文件 | **EXIT=0，真实盘有文件** |
| `reg add HKLM\Software\wst-r11d3-ctl` | EXIT=0，真实 hive 不可见 | **EXIT=0，真实 hive 可见** |
| 越界读 `C:\Windows\win.ini` | 成功 | 成功 |

- 对照 run 的产物是**真实盘实体**：`.t\r11\exe\run2\ws\ev\p1-7zr-i.txt`（1,072 B）、`p3-reg-hklm.txt`（40 B，`The operation completed successfully.`），以及我事后逐条实测存在并已删除的 `C:\Program Files\wst-r11-d3-ctl\a.txt` 等（清理前后 `Test-Path` 原样记录在会话与 §5.3）。
- 因此：**ACL / 管理员权限不是本轮的拒绝原因**（同一进程在无 WinStage 时能写 `Program Files` 与 `HKLM`）；拒绝面 = WinStage shim 层（i386 注入缺口 + `failClosed`）。
- 同时 **写路径的"正常"行为不是拒绝而是暂存**：`sandbox-lane.json` 原文 `conclusion="沙箱已生效：命令走透明垫片（去令牌化）通道（tier=TS），文件与注册表写入进暂存。"`，`winstage-shim.config.json`：`"failClosed": true, "readThrough": true`。
- R10 §4.4 的"拒绝来自 DSH 路径级策略"在本轮**不成立**（当前 profile 是 `danger-full-access`，无路径级拒绝策略参与；见 `dsh-plugin/staging-fs.mjs` 的 `stageOutside` 仅在 deny 档才拒绝，且默认是 `'stage'`）。

---

## 7. 暂存面清单（哪些写进了暂存）

run1 终态（宿主侧盘点，`stage-root-inventory-host.txt` = 506 行，含 path/size/sha256[0:12]）：
```
stage-root 合计 files=506 bytes=559,262,860
  staged\     files=330 bytes=30,783,314     <- 文件族重定向根
  registry\   files=9   bytes=34,482         <- overlay.hive / overlay.local.hive / overlay.journal(+LOG1/2)
  candidates\ files=3   bytes=90,915         <- 待批候选
  blobs\      files=158 bytes=507,487,507    <- 内容寻址（含我投喂的候选副本）
  real\       files=0     private\ files=0
staged\ 下顶层：fs\  reg\  wo\  ev\  cand\  .canary-temp\  shim.log  winstage-shim.config.json
```
- **文件写** → `staged\fs\<盘符>\…`：run1 的 `ev\*.txt`、`app2604\*`（107 文件）、4 个越界探针文件都在这里（例：`staged\fs\C\Program Files\wst-r11d3-probe.txt` 5 B）。
- **注册表写** → `registry\overlay.journal`（1436 B，UTF-16 单行）+ `overlay.hive`；原文节选：`HKCR\CLSID\{23170F69-…}`、`HKCU\Software\wst-r11d3-probe`、`HKLM\Software\wst-r11d3-probe`（含 `m v` 值写入）。
- **候选记录** `candidates\`：
  - `cs_0002_e74693f8.json` `source=registry-stage` `status=superseded`
  - `cs_0003_0b83942a.json` `source=registry-stage` `status=pending`
  - `cs_0037_35105170.json` `source=shell` `status=pending`，`changes[0].path = fs\C\Program Files\wst-r11d3-probe.txt`，`after.bytes=5`
  ⇒ **越界写确实进了"批准后才落真实系统"的暂存/候选队列**（与 `shell-executor.mjs:1830-1832` 的模型可见提示一致）。
- **明确结论**：安装器写的东西**全部进暂存，没有落真实盘**；`Test-Path` 返回 True 是 shim `readThrough` 命中 overlay，**不能**当作真实盘证据（R10 的 `Test-Path` 式复核在本轮被证明不足）。

---

## 8. 缺陷与设计缺口

| ID | 现象 | 原始依据 | 影响 |
|---|---|---|---|
| **D3-1** | **WinStage TS 通道下 32 位（i386）可执行文件一律 `ERROR_ACCESS_DENIED`** | `7zr.exe`(0x014C) EXIT=1 vs `7z-choco-x64.exe`(0x8664) EXIT=0；`SysWOW64\cmd.exe`(0x014C) 拒 vs `System32\cmd.exe`(0x8664) 正常；platform 对照下同一 `7zr.exe` EXIT=0 | 32 位工具链/安装器（含 7-Zip 官网 `7zr.exe`、7z1900 安装器）在沙箱内**完全不可用**，且报错文本只有 `Access is denied.`，无 WinStage 归因码 |
| **D3-2** | MSI 因日志路径落在 overlay-only 目录而 `1622 ERROR_INSTALL_LOG_FAILURE`（`msiserver` 未注入 shim，看不到 overlay） | C4/C5 EXIT=1622 + 日志未生成 + `<ws>\ev` 真实盘不存在 | 任何"安装日志/临时目录写在工作区内"的 MSI 流程都会假失败；用户无法区分"被隔离"与"路径耦合" |
| **D3-3** | `readThrough` **枚举/读取不一致**：`Test-Path`/`Get-Item` 命中 overlay，而 `Get-ChildItem`/`dir` 只列真实盘 | `<ws>\app2604`：`Test-Path`=True 但 `Get-ChildItem -Recurse`→`DirectoryNotFoundException`；`dir`→`File Not Found`（EXIT=1）；`<ws>` 枚举看不到 `ev\`、`app2604` | 会让"安装是否成功"的判定自相矛盾；也让"安装后校验"脚本必然误判 |
| **D3-4** | `winget`/`choco` 在沙箱内不可用（`0x8A150001` / `0xE0434352`），且**零可读错误文本** | C6/C7 原始退出码 + 0/79 字节输出；`winget.exe` 是 0 字节 alias stub | 包管理器安装路径在沙箱内既失败又不可诊断 |
| **D3-5** | `candidates\cs_0002/cs_0003*.json` 含非法控制字符，`ConvertFrom-Json` 解析失败 | run1 F 段：`Invalid object passed in, ':' or '}' expected`（仅 `cs_0037` 可解析） | 审批/复核工具链无法稳定读取候选记录 |
| **D3-6** | 厂商站 `7zr.exe` 未钉版本、无公开摘要（`.sha256` 404），同 URL 同 size 不同哈希 | 本轮 `256feca8…` vs R10 `ad4c82fa…`，两者 size 均 602,624 | 按 URL 的完整性验证不可复现（沙箱无关，但影响本域结论强度） |
| **D3-7** | MSI 装入 overlay 的产物**无法通过其逻辑路径枚举**（同 D3-3），因此"安装后完整性校验"（哈希/文件数）在沙箱内做不到 | §4.2 三路复核 | 与任务目标直接冲突：安装后完整性只能靠宿主侧 overlay 盘点 |
| **D3-8** | **"零残留"不成立**：沙箱内被拒的进程崩溃后，**WER 把崩溃报告写进真实盘**；失败的 MSI 还遗留**存活的 `msiexec /V` 进程** | ProgramData 3,141→3,154；`WER\ReportArchive` 下 **20 个** `AppCrash_{7zr,7z1900-x64,7zr_copy,choco,cmd}.exe_*`（23:59:32–00:08:36）；`msiexec` pid 5596 `/V` 起始 00:08:46（我已 kill，复核 0） | 隔离面存在真实副作用：安装产物/注册表/快捷方式确实零残留，但**崩溃遥测与残活服务进程**会落真实盘/真实进程表；以 `Test-Path`/线程内 `tasklist` 做的"零残留"结论不可靠 |

---

## 9. 不确定项（诚实边界）

- **MSI 精确失败机制未定**（run3 结论原话）：`msiserver` 处于 RUNNING，但事件日志无本次事务、`shim.log` 无 `msiexec` 记录 ⇒ 无法区分"服务进程未注入导致写日志/写目标被拒"、"客户端↔服务 RPC 被阻断"还是"msiexec 启动即被拒"。把日志改到真实目录后失败形式由 1622 变为 1601（无日志时），说明 run1 的"日志目录只在 overlay"**并非根因或非唯一根因**，失败指向 MSI 服务通道整体不可用。
- **ProgramData 计数口径不一致**：`dir /s /b /ad` 只报 +1 目录，定向扫描却有 20 个新 WER 崩溃目录（§5.2）；未查明是 WER 回收复用还是遍历漏计。
- **WER 崩溃与本线程"Access is denied."的关系**：两者时间吻合且对象一致，但未取到同一 PID 的崩溃转储做直接对应（`Report.wer` 未逐份解析）；"进程启动后崩溃"标 `[推断]`。
- "i386 被拒"是 4 组相关对照 + 宿主 PE 解析的强相关证据；**没有**拿到策略/日志原文解释机制（`shim.log` 中未见 32 位分支明文）⇒ 机制标 `[推断]`。
- 三个 exe `NotSigned` 与"7-Zip 官方安装器通常带签名"的常识不符；PE 证书表为 0 支持"确无嵌入签名"，但不能排除候选在宿主侧被重打包/剥签名（`bin\` 内文件 sha256 与上游清单 MATCH 已排除我这一侧篡改）。
- 本次线程内无法旁路 shim 直接观察真实盘，"真实盘零改动"由**宿主侧 after 差分**（§5）与 overlay 落点两侧互证；WER 项即由宿主侧才发现，说明**必须**用宿主侧差分，不能只信线程内。
- `C:\Users\Administrator\AppData\Local` 的逐文件差分本轮 **not-run**（上一轮已测 +90 文件全在 `Temp\dsh-*`；本轮时间盒内未复测）。
- GitHub Release asset digest 比对 **not-run（网络不可达）**，已用 choco VERIFICATION + npmmirror SHASUMS256 替代。
- 未测：`/S` 之外的 7-Zip 静默参数变体、`DISM`/`pkgmgr`、`.nupkg` 直接安装、服务安装（`sc create`）、驱动安装、x64 版 7z.exe 的位数正对照（run3 报告本机无 x64 `7z.exe` 可用）。

---

## 10. 复现与证据索引（全部相对工作区）

```powershell
# 宿主侧：投递 + 等待（必须 cmd /c + 重定向）
cmd /c "node .t\r11\bin\submit-job.mjs d3-run1 .t\r11\exe\run1\ws .t\r11\exe\run1\prompt.txt .t\r11\exe\run1\out winstage > .t\r11\exe\run1\submit.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d3-run1 900 > .t\r11\exe\run1\wait.log 2>&1"
# 对照（platform，WINSTAGE_SHELL=0）：同上，第 5 参数改 platform，ws/prompt/out 用 run2
# 基线/终态系统面快照（增量落盘）
$env:R11D3_SNAP='.t\r11\exe\snap-before.txt'; powershell -NoProfile -ExecutionPolicy Bypass -File .t\r11\exe\bin\snapshot3.ps1
```

| 证据 | 路径 |
|---|---|
| 档位判据（LANE_OK=true） | `.t\r11\exe\run1\out\lane.txt`、`…\stage-root\sandbox-lane.json` |
| run1 原始事件流 / 最终答复 | `.t\r11\exe\run1\out\stdout.ndjson`、`.t\r11\exe\run1\FINAL-run1.md` |
| run1 暂存树盘点（宿主侧 506 行） | `.t\r11\exe\run1\stage-root-inventory-host.txt` |
| run1 线程内证据文件（overlay） | `.t\r11\exe\run1\out\stage-root\staged\fs\C\…\run1\ws\ev\*.txt`（23 个，3,044 B） |
| run2 对照最终答复 / 真实盘证据 | `.t\r11\exe\run2\FINAL-run2.md`、`.t\r11\exe\run2\ws\ev\p1-7zr-i.txt`、`…\p3-reg-hklm.txt` |
| run3 最终答复 / 证据 | `.t\r11\exe\run3\FINAL-run3.md`、`.t\r11\exe\run3\out\stage-root\…` |
| 溯源与哈希原始记录 | `.t\r11\exe\evidence-provenance.md`、`.t\r11\exe\bin\{SHASUMS256.txt,github-release-2603.json(不可达),7zip.install-nupkg\legal\VERIFICATION.txt}` |
| 系统面差分 | `.t\r11\exe\snap-before.txt`、`.t\r11\exe\snap-after.txt`、`bin\snapshot3.ps1` |
| 候选清单（宿主侧投放） | `.t\r11\exe\run*\ws\cand\AUTHORITATIVE.json` |
