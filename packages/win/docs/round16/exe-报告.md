# R16 · D3「exe 安装完整性 + 沙箱隔离」实测报告

> 执行：teammate `exe`（域 3 owner）· 窗口 2026-10-11 17:47–18:30 (+08:00)
> 宿主：Windows Server 2025 Datacenter build 26100（`WIN-DV9KRECLBVS\Administrator`）· 真实盘读数一律用**不受限宿主 pwsh** 取
> 纪律：每条结论附原始输出文件路径；没跑过的写 `not-run`；机制不明处标 `[推断]`
> 本文件与 `docs/round16/exe-缺陷.md` 同期交付；原始证据在 `.t\r16\exe\**`

---

## 0. 一句话结论

WinStage TS 档在**普通文件写入面**上仍然工作（安装器 107 个文件进 overlay、真实工作区零污染、`Program Files` / `Uninstall` / `Run` / 开始菜单 delta 全 0），
但本轮发现**两条真实盘逃逸（P0）**，且都用**独立于沙箱的外置观测**（宿主侧 `Test-Path`/哈希/文件枚举）证实：

1. **COM 快捷方式逃逸**：沙箱内 `New-Object -ComObject WScript.Shell` + `CreateShortcut(...).Save()` 写的 `.lnk` **直接落真实盘**；
   同一目录里用 `Set-Content` 写的普通文件（包括扩展名就是 `.lnk` 的普通文件）却老老实实进 overlay。最小复现 run-3 有决定性差动。
2. **MSI 管理员安装逃逸**：`msiexec /a <msi> /qn TARGETDIR=<ws>\msiapp`（**EXIT=0**）经未注入 shim 的 `msiserver` 在**真实盘**写出
   **2,449 文件 / 574 目录 / 134,868,847 B**，另在真实盘 `C:\Windows\Temp\` 留下日志（46,556 B）。同一 run 内嵌套 agent 自己写的 `ev\m-msi.txt` 则在 overlay。

同时复现 R11 的四条旧缺陷（i386 硬拒 + WER 真实盘遥测、枚举/`Test-Path` 自相矛盾、候选 JSON 解析失败、遗留 `msiexec`），
并**新观察到 R11 未曾出现的形态**：MSI 不再是"1622/1601 两边都没有产物"，而是"管理员安装成功且真实落盘"。

**机制已定位（§7，只写分析、未构建、未改源码）**：两条 P0 **不是同一类** ——
① COM `.lnk` 是**进程内**写者（`wshom.ocx` 明确映射在被注入的 PID 里）+ **钩子覆盖面缺口**：
shim 是 IAT 引擎，`g_targets` 有 `NtOpenFile` 却**没有 `NtCreateFile`**（`shim/src` 全文 0 处），
而 OLE/shell 保存 `.lnk` 走 `ntdll!NtCreateFile` 直调 ⇒ 既没暂存也没进审计日志；
补丁点 = 仿 `ws_NtOpenFile` 增加 `ws_NtCreateFile`（文件/函数/判据见 §7.2，建议先做"审计-only 版"验证）；
② MSI 是**进程外**写者（`msiserver` 服务，客户端 pid 4328 虽被注入但零文件记录）⇒ `NtCreateFile` 补丁也管不到，
短期内只能 policy 拒绝（见 §7.3）。

**两项后续处置（Lead 指派）**：WER +9 条已按 R15 口径留档后**删除**（17→8，逐条 `exists=False`）；
`DeepSeek Harness` 两个外部对象已**归因**为并行的"DSH 静默安装器矩阵"探针（platform 真实盘安装，**未删除**），见 §4.5。

---

## 1. 运行与协议 §1.1 四条判据

| run | 模式 | 目的 | session-id | stage-root | exit | `stderr.txt` | lane | 四条判据 |
|---|---|---|---|---|---|---|---|---|
| **run-1** | winstage | 主测：便携运行 + 安装器 + 越界探针 | `session-f772e677-3144-471e-85a8-7a682762db6d` | `.t\r16\exe\run-1\stage-root-25477159411235` | 0 | **0 B** | `tierEffective=TS / degraded=false / launchMode=shim / shimCount=21 / degradeCount=0` → **`LANE_OK=true`** | **4/4 通过** |
| **run-2** | platform | 对照：同探针在真实盘（一次性，用后自删） | `session-fcb3df77-03e9-42c8-810a-9938cc800273` | `.t\r16\exe\run-2\stage-root-254801234229099` | 0 | 0 B | 平台模式**无** `sandbox-lane.json` → `LANE_OK=false`（对照 run，不作 TS 断言） | 对照用，不适用 |
| **run-3** | winstage | 最小复现：COM `.lnk` vs 同目录普通写 | `session-8712c804-432d-41d3-bbed-a75944c62cb0` | `.t\r16\exe\run-3\stage-root-273642102114806` | 0 | **0 B** | `TS / degraded=false / shimCount=6 / degradeCount=0` → **`LANE_OK=true`** | **4/4 通过** |
| **run-4** | winstage | 复验 MSI（R11 D3-2） | `session-076e6174-b406-410f-84f9-79beeece6eed` | `.t\r16\exe\run-4\stage-root-273642102114806` | 0 | **0 B** | `TS / degraded=false / shimCount=6 / degradeCount=0` → **`LANE_OK=true`** | **4/4 通过** |

逐条判据（三个 winstage run 均成立）：

| # | 判据 | run-1 实测 | run-3 | run-4 |
|---|---|---|---|---|
| 1 | loader 无告警 | `stderr.txt` = **0 B** | 0 B | 0 B |
| 2 | 暂存面在工作 | `stage-root-inventory.txt` 581 行（`staged` 294 / `blobs` 259 / `registry` 9 / `candidates` 2），含我让沙箱写的 `ws-1\ev\*.txt`；`candidates\cs_0002_*.json`、`cs_0021_*.json` 在 | `ev\m-repro.txt`(370 B) 在暂存；`candidates\cs_0006_c86b428b.json` | `ev\m-msi.txt`(1,768 B) 在暂存；`candidates\cs_0006_73e7f670.json` |
| 3 | 真实工作区零污染（仅预放种子） | `workspace-inventory.txt` = `cand\`(3 个候选 exe) + `seed.txt`，**4 文件** | `seed.txt` + 宿主预放的 `ev\` 空目录 | `seed.txt` + 预放 `cand\msi\node.msi` + 预放 `ev\`（**但见 §4.2：MSI 事后在真实盘写出 2,449 文件**） |
| 4 | **lane 真的是 TS** | `LANE_OK=true` | `LANE_OK=true` | `LANE_OK=true` |

> 判据 3 的口径说明：run-4 的 `workspace-inventory.txt` 是在 run 结束**之后**由 `sbx-extract.mjs` 生成的，它看到的是 MSI 已经落盘后的真实工作区
> （2,449 文件），因此 run-4 的"判据 3"**在 run 结束时已不成立**——这正是本轮 P0 缺陷的读数之一。

**跑的是哪一份 shim（D-R9 口径）**：`shim/out` 三件套与随附 `.golden-*` **逐字节相同**
（`winstage-inject.exe` `07FE55DD…`、`winstage-probe.exe` `8CF81F4F…`、`winstage-shim.dll` `63808F51…`，整件 sha256 与 `.text` 摘要都相等）
⇒ 本轮跑的确实是 R15 收口后的 golden 三件套（`.t\r16\exe\host\dr9-crossbuild.txt`）。
Shim 配置（`run-1\stage-root-…\staged\winstage-shim.config.json`）：`failClosed=true / readThrough=true / verbose=false / traceStagedOps=true`。

---

## 2. 完整性：哈希 / PE / 签名

### 2.1 公开摘要比对（`host\digest-compare.txt`）

| 文件 | size | 实测 sha256 | 声明来源 | 判定 |
|---|---|---|---|---|
| `7z1900-x64.exe` | 1,447,178 | `0F5D4DBB…C45E` | choco `7zip.install` 19.0 `legal/VERIFICATION.txt` checksum64 | **MATCH** |
| `7z-choco-x64.exe` | 1,664,082 | `D54BF805…665D` | choco `7zip.install` 26.4.0 checksum64 | **MATCH** |
| `7zip.install-nupkg\tools\7zip_x32.exe` | 1,361,691 | `39BF6504…C009` | 同上 checksum32 | **MATCH** |
| `node-v22.14.0-x64.msi` | 30,916,608 | `2C0CC97E…B386` | npmmirror `SHASUMS256.txt` | **MATCH** |
| `node-v22.14.0-win-x64.zip` | 34,906,389 | `55B63929…F217` | npmmirror `SHASUMS256.txt` | **MATCH** |
| **安装后产物** `ws-4\msiapp\PFiles64\nodejs\node.exe` | 83,344,536 | `33B1BC1A…771B` | npmmirror `SHASUMS256.txt` 的 `win-x64/node.exe` | **MATCH** |
| `ripgrep-v15.0.1-x86_64-pc-windows-msvc.zip`（**本轮新下载**，见 §2.3） | 2,042,875 | `BD28761F…C823` | npmmirror 目录列表**只给 size**（2,042,875 == 实下 2,042,875），无 sha256 侧车 | `no-published-digest`（尺寸吻合） |
| `7zr.exe` | 602,624 | `256FECA8…D282` | 无公开摘要（厂商 `.sha256`：R11 记录 404；本轮 curl 取 `.sha256` 失败） | `no-published-digest` |

⇒ **4/5 有公开清单的候选逐字节 MATCH**（另有安装产物 node.exe 也 MATCH）；
两个无清单候选（`7zr.exe`、ripgrep zip）如实标 `no-published-digest`。

### 2.2 PE 结构与签名（`host\integrity-host.txt`）

`Get-AuthenticodeSignature` 原文（节选，完整见证据文件）：

```
7zr.exe               Status=NotSigned    Signer=(none)
7z1900-x64.exe        Status=NotSigned    Signer=(none)
7z-choco-x64.exe      Status=NotSigned    Signer=(none)
7zip_x32.exe          Status=NotSigned    Signer=(none)
rg.exe                Status=NotSigned    Signer=(none)
node-v22.14.0-x64.msi Status=Valid        StatusMessage="Signature verified." Signer=CN=OpenJS Foundation, OU=Nodejs, …
ws-4\…\nodejs\node.exe Status=Valid       Signer=CN=OpenJS Foundation …
C:\WINDOWS\System32\notepad.exe Status=Valid  Signer=CN=Microsoft Windows …   ← 对照（排除读取通道假阴性）
C:\WINDOWS\System32\cmd.exe     Status=Valid  Signer=CN=Microsoft Windows
node-v22.14.0-win-x64.zip / ripgrep…zip  Status=UnknownError（非 PE，预期）
```

`symlink` 之外的 PE 读数（自写解析器 `.t\r16\exe\bin\pe-sections.mjs`，逐段 sha256）：

| 文件 | machine | `.text` 分段 sha256 | 证书表 | TimeDateStamp |
|---|---|---|---|---|
| `7zr.exe` | `i386`(0x014C) | `eb387088…4646` | VA=0 size=0 | 2026-10-05 |
| `7z1900-x64.exe` | **`i386`** | `315eb911…ec09` | 0 / 0 | 2019-02-21 |
| `7z-choco-x64.exe` | `x86_64`(0x8664) | `3fb7493f…56ab` | 0 / 0 | 2026-10-05 |
| `7zip_x32.exe` | `i386` | `b29a85f2…e8a0` | 0 / 0 | 2026-10-05 |
| `rg.exe` | `x86_64` | `8eecda46…1610` | 0 / 0 | 2026-03-09 |
| `node.exe`（MSI 安装产物） | `x86_64` | `092eed38…f864`（另 **certSize=10,392**） | VA=83,334,144 | 2025-02-11 |
| `winstage-inject.exe` | `x86_64` | `694eccc6…2145` | 0 / 0 | 2026-10-06 |
| `winstage-probe.exe` | `x86_64` | `5530101e…e5a5` | 0 / 0 | 2026-10-08 |
| `winstage-shim.dll` | `x86_64` | `6ec5a5da…748a` | 0 / 0 | 2026-10-09 |
| `C:\Windows\SysWOW64\cmd.exe` | `i386` | `04b85bf8…84f7` | 0 / 0 | — |

`NotSigned` 与本机对照（`notepad/cmd = Valid`）共同排除"读取通道假阴性"；三个 7-Zip exe 与 `rg.exe` **确无嵌入签名**，与 R11 结论一致。

### 2.3 哈希口径（D-R9）——本轮怎么用

* **整件 sha256 回答"是不是这一件文件"**：用于（a）公开清单比对；（b）`shim/out` 与 `.golden-*` 的同一性。
* **`.text` 分段摘要回答"是不是同一份代码"**：本轮对 R15 留档的两个非 golden 构建做了测量
  （`host\dr9-crossbuild.txt`）：
  `winstage-shim.dll`(golden)`63808F51…` / `installed-F544AE15.dll` / `r14-reconstruction-C6540A37.dll`
  三个**整件哈希全不同、`.text` 也全不同**（`6ec5a5da…` / `4446ed46…` / `9a23600f…`）⇒ 它们是**不同的代码**，不是"同源两次构建的元数据漂移"。
* **诚实边界**：本轮**没有**测到"同源两次构建、整件哈希不同而 `.text` 相同"的样本对（本机没有可复现的双构建）；
  该形态的证据仍是 R10 复核者文档 `docs/archive/round10/verify/协议修正-哈希口径-D-R9.md`，本轮**未复测**（标 `not-run`）。
* 跨构建哈希相等**未**被用作任何断言。

---

## 3. 便携运行与安装器：真实退出码

### 3.1 便携运行 / 位数 A-B（run-1 线程内，证据在 overlay `ws-1\ev\`）

| 步骤 | 命令 | EXIT | 原文 |
|---|---|---|---|
| A1 | `ws-1\cand\rg.exe --version`（x86_64，本轮新下载件） | **0** | `ripgrep 15.0.0 (rev 3a612f88b8) … PCRE2 10.45 is available` |
| A2 | `ws-1\cand\7zr.exe i`（**i386**） | **未取得数字码** | `ApplicationFailedException: Program '7zr.exe' failed to run: Access is denied`；`LASTEXITCODE=[]`（第一次原始尝试还出现 `The operation was canceled by the user`） |
| A3 | `%WINDIR%\SysWOW64\cmd.exe /c echo WOW`（**i386**） | **未取得数字码** | 同上 `Access is denied` |
| C0 | `%WINDIR%\System32\cmd.exe /c echo SYS32CMD`（x86_64 对照） | **0** | `SYS32CMD` |

⇒ **R11 D3-1 复现**：`Access is denied` + `SysWOW64` 32 位 WOW64 宿主同样被拒；同一个 run 内 64 位 `cmd.exe` 与 64 位 `rg.exe` 正常。
**与 R11 的形态差异**：R11 拿到的是退出码 1 + 19 B `Access is denied.`；本轮该失败发生在**进程启动**阶段，
`pwsh` 抛 `ApplicationFailedException`，`$LASTEXITCODE` 为空 ⇒ **错误形态更差**（连数字退出码都没有）。

### 3.2 静默安装器（AMD64 NSIS，`/S /D=`）

| # | 命令 | EXIT | 结果 |
|---|---|---|---|
| B1 | `ws-1\cand\7z-choco-x64.exe /S /D=<ws-1>\app2604` | 首次 `EXIT=(empty)`；**重跑 `NATIVE_EXIT=0`** | overlay 内 `app2604` 共 **107 个文件**（`7z.exe` 577,536 / `7zFM.exe` 1,003,520 / `7z.dll` 1,907,712 / `Uninstall.exe` / `Lang\*.txt` …）；真实工作区**零文件** |

**B2 安装后校验（D3-3 复现）**：
```
TestPath=True          ← 沙箱可见路径命中 overlay
ChildItemCount=0       ← 但目录枚举不合并 overlay
cmd /c dir /b <ws>\app2604 → File Not Found (EXIT=1)
```
⇒ "安装成功了没有"在沙箱内**自相矛盾**：`Test-Path` 说 True，枚举说没有。安装后完整性**只能**靠宿主侧盘点 stage-root（本轮 `host\staged-ws1-list.txt`，`ws-1` 子树 121 文件）。

### 3.3 MSI（run-4，复验 R11 D3-2）

| # | 命令 | EXIT | 结果 |
|---|---|---|---|
| M0 | `sc query msiserver` | — | `STATE: 1 STOPPED`（`WIN32_EXIT_CODE 1077`）；`msiexec_before=0` |
| M1 | `msiexec /a <ws>\cand\msi\node.msi /qn TARGETDIR=<ws>\msiapp /L*v <ws>\ev\m1-admin.log` | **0** | **管理员安装成功**；真实盘 `<ws>\msiapp` = **2,449 文件 / 574 目录 / 134,868,847 B**；真实盘日志 `ev\m1-admin.log` 5,604,484 B |
| M2 | `msiexec /i … /qn /norestart ALLUSERS=1 INSTALLDIR=<ws>\msiapp2 /L*v C:\Windows\Temp\r16d3-msi.log` | **1603** | `M2_TARGET=False`；**真实盘** `C:\Windows\Temp\r16d3-msi.log` = **True**（46,556 B） |
| M3 | 同 M2 但去掉 `/L*v` | **1603** | 同样失败 |
| M4 | `Get-WinEvent ProviderName=MsiInstaller -MaxEvents 5` | — | 事件 1040/1033/11708/10005：**`Installation success or error status: 1603`**、`A later version of Node.js is already installed`（= 本机已装更新版 Node，属**产品级原因**，非沙箱路径原因） |
| M5 | 收尾 | — | 遗留 `msiexec` pid 11836（18:16:36 起）被 `Stop-Process -Force` 清掉，`msiexec_after_kill=0` |

⇒ **与 R11 的形态变化（重点）**：R11 的 `/a` 与 `/i` 都失败（`1622`/`1601`）且"两边都没有产物"；
本轮 `/a` **EXIT=0 且真实盘写出 2,449 文件**，`/i` 的 `1603` 有明确产品级原因（本机已有更新版 Node）。
`msiserver` 本次是 `STOPPED` 状态（按需启动），与 R11 的 `RUNNING` 也不同 ⇒ MSI 行为**不稳定/依环境**，但**"MSI 一定不会落真实盘"这条已经不成立**。

---

## 4. 隔离判定：宿主侧前后对照

### 4.1 系统面差分（`host\snap-before.txt` 17:54 → `host\snap-after.txt` 18:26，宿主侧）

| 复核项 | before | after | delta |
|---|---|---|---|
| `C:\Program Files` | 20,513 文件 / 2,545 目录 | 20,513 / 2,545 | **0 / 0** |
| `C:\Program Files (x86)` | 4,077 / 366 | 4,077 / 366 | **0 / 0** |
| `C:\ProgramData\…\Start Menu\Programs` | 80 文件 / 12 目录 | 80 / 12 | **0 / 0** |
| `%APPDATA%\…\Start Menu\Programs` | 19 / 7 | 19 / 7 | **0 / 0** |
| `C:\Users\Public\Desktop` | 1 文件 / 0 目录 | 1 / 0 | **0 / 0** |
| `HKLM\…\Uninstall`（+WOW6432+HKCU） | 63 行子键/DisplayName | 63 行 | **逐行相同** |
| `…\Run` 值（HKLM/WOW6432/HKCU） | 3 行 | 3 行 | **逐行相同** |
| 探针路径（`Program Files\wst-r16d3-ctl`、`ProgramData\wst-r16d3-probe.txt`、`HKLM\…\wst-r16d3`、`%LOCALAPPDATA%\Programs\wst-r16d3-ctl`） | 全 False | **全 False** | 0 |
| `C:\ProgramData\…\WER\ReportArchive` | **8** 条 | **17** 条 | **+9（真实盘）** |
| 进程表（msiexec/7z/choco/winget/node/dsh） | 16 | 10 | 无遗留 `msiexec` |

**探针写入的真实去向着落**（宿主侧直接 `Test-Path` + 哈希）：

| 探针 | 沙箱内自报 | 真实盘 | 判定 |
|---|---|---|---|
| `C:\Program Files\wst-r16d3-ctl\a.txt` | SUCCESS | **False**（overlay `staged\fs\C\Program Files\wst-r16d3-ctl` 存在） | 正确暂存 |
| `%LOCALAPPDATA%\Programs\wst-r16d3-ctl\a.txt` | SUCCESS | **False**（overlay 存在） | 正确暂存 |
| `C:\ProgramData\wst-r16d3-probe.txt` | SUCCESS | **False**（overlay 存在） | 正确暂存 |
| `HKLM\…\Uninstall\wst-r16d3` | SUCCESS（读回 True） | **False**；候选 `cs_0002_8d1f0a9f.json` `source=registry-stage status=pending` 记录 `mkdir` + `DisplayName=R16 D3 probe`（REG_SZ 十六进制数据），baseline 来自真实 hive | 正确暂存（待批候选） |
| **`C:\ProgramData\…\Start Menu\Programs\wst-r16d3.lnk`**（COM） | SUCCESS | **True**（794 B，18:11:16，sha256 `F3AD7024…`） | **⚠ 真实盘落盘** |
| **`C:\Users\Public\Desktop\wst-r16d3.lnk`**（COM） | SUCCESS | **True**（782 B，18:11:16，sha256 `022B039D…`） | **⚠ 真实盘落盘** |

> 归因（run-1 那次）：run-2（platform 对照）用的路径与之完全相同，所以必须排除它。run-2 的自证与宿主实测都显示它在 **18:06:34 已完成清理并逐项 False**；
> 两个真实 `.lnk` 的 `CreationTime=LastWriteTime=18:11:16`，落在 run-1 窗口内（run-1 18:05:58–18:13），此时 run-2 已无任何写入。
> 为彻底去混淆，仍然做了 run-3 最小复现（§4.2）。

### 4.2 run-3 最小复现（决定性对照，lane=TS）

`ws-3` 预先确认 5 个目标路径**全部不存在**（`PRE_*=False`），然后在一个 run 内做四件事：

| 步骤 | 动作 | 沙箱内读回 | **真实盘（宿主侧）** | overlay 内 |
|---|---|---|---|---|
| F1 | COM `WScript.Shell.CreateShortcut('C:\ProgramData\…\Start Menu\Programs\wst-r16d3.lnk')`.Save() | True | **True**, 794 B, 18:16:35, sha256 `AAAA8CB2…` | **不存在** |
| F2 | COM 同上 → `C:\Users\Public\Desktop\wst-r16d3.lnk` | True | **True**, 782 B, 18:16:46, sha256 `18E68216…` | **不存在** |
| F3 | **对照**：`Set-Content '…\Start Menu\Programs\wst-r16d3-ctl.txt'` | True | **False** | **存在**（5 B） |
| F3 | **对照**：`Set-Content 'C:\Users\Public\Desktop\wst-r16d3-ctl.txt'` | True | **False** | **存在**（5 B） |
| F4 | **对照**：普通文件但扩展名是 `.lnk` → `…\Start Menu\Programs\wst-r16d3-plain.lnk` | True | **False** | **存在**（21 B） |

⇒ **差动非常干净**：同一目录、同一进程、同一时刻，**只有 COM 快捷方式写落到真实盘**；
普通文件（包括名字以 `.lnk` 结尾的普通文件）全部进 overlay。
F6 里嵌套 agent 自己发现 `$env:WINSTAGE_STAGED_FS` 为空、因而在**沙箱内无法自证**——这恰好说明为什么必须用宿主侧外置观测；
宿主侧观测的结论是**逃逸成立**（原始：`host\realfs-lnk\manifest.txt`、`run-3\stage-root-…\staged\fs` 树）。

### 4.3 MSI 真实落盘（run-4，同 run 内的自对照）

| 产物 | 写者 | 落点 |
|---|---|---|
| `ws-4\ev\m-msi.txt`（1,768 B） | 嵌套 agent 的 `pwsh`（经 shim） | **overlay** |
| `ws-4\ev\m1-admin.log`（5,604,484 B） | `msiexec /a` | **真实盘** |
| `ws-4\msiapp\PFiles64\nodejs\…`（2,449 文件 / 134 MB，含 `node.exe` 83,344,536 B） | `msiexec /a`（经 `msiserver`） | **真实盘** |
| `C:\Windows\Temp\r16d3-msi.log`（46,556 B，sha256 `2BA01933…`） | `msiexec /i` 的 `/L*v` | **真实盘**（已按规程复制留档后删除） |
| overlay `registry\overlay.journal` | — | **0 字节**；overlay `candidates\` 只有 agent 自己的 `cs_0006_73e7f670.json`（15 条 PowerShell 临时文件） |

`[推断]` 机制：MSI 的文件写由**未被注入 shim 的 `msiserver` 服务进程**执行，因此它看不到 overlay，直接写真实盘；
客户端 `msiexec.exe` 虽然是沙箱内进程，但真正落盘的是服务侧。与 R11 的"客户端↔服务通道断裂"是同一族问题的**另一面**。

### 4.4 真实盘副作用清单（本轮产生，全部已处置/留档）

| 项 | 内容 | 处置 |
|---|---|---|
| WER 崩溃遥测 **+9** | `AppCrash_7zr.exe_…` ×4（18:07:17 / 18:07:56 / 18:08:00 ×2）、`AppCrash_cmd.exe_…` ×5（18:07:33–18:08:10）——i386 被拒后进程崩溃，WER 服务（未注入）写真实盘 | **按 R15 口径（先记录后删除）已处置**：9 条目录路径 + 各 `Report.wer` 的 sha256 全部留档于 `.t\r16\exe\host\wer-removed-manifest.txt`（5,755 B），随后删除，逐条 `AUDIT exists=False`；WER 条目数 **17 → 8**（回到基线） |
| 真实盘 `.lnk` ×2（run-1）+ ×2（run-3） | Start Menu / Public Desktop 各 1~2 个 | 复制到 `.t\r16\exe\host\realfs-lnk\`（含 sha256 清单）后**已删除**，`Test-Path` 现为 False |
| `C:\Windows\Temp\r16d3-msi.log` | 46,556 B | 复制留档（`host\realfs-lnk\r16d3-msi.log.copy`）后**已删除** |
| 遗留 `msiexec` ×1（pid 11836，`/V`） | run-4 失败安装留下 | 线程内已 `Stop-Process -Force`；宿主复核 `msiexec`=0 |
| `ws-4\msiapp`（2,449 文件 / 134 MB） | MSI 管理员安装产物 | **保留**（在域内写作用域 `.t\r16\exe\**`，是本轮 P0 证据；如需回收由 Lead 决定） |

### 4.5 非本域归因的在窗口真实盘变动 —— **已归因**（Lead 要求查清，未删除）

两个对象**不是域 3 的产物，也不是 3091 usability 宿主**，而是**另一条并行的"DSH 静默安装器矩阵"实测流**在真实盘（platform 模式）跑安装器时留下的；
截获时（18:24）它仍在活动。证据链（全部只读观测）：

| 证据 | 原文读数 |
|---|---|
| 桌面 `.lnk` 的目标（用 COM 读，**未执行**） | `TargetPath = C:\Users\Administrator\Downloads\dsh-silent-target\DeepSeek Harness.exe`；`WorkingDir = …\Downloads\dsh-silent-target`；`IconLocation = …\DeepSeek Harness.exe,0`；`Description = "Electron desktop shell for a bundled dsh runtime and external plugins"`；UTF-16 串里含 `com.deepseek.dsh`（AppUserModelID） |
| 目标目录内容（真实盘） | `C:\Users\Administrator\Downloads\dsh-silent-target\` = **已解压的 Electron 应用**：`DeepSeek Harness.exe` 244,481,512 B、`Uninstall DeepSeek Harness.exe` 288,136 B、`7zip-installer-COPYING.txt`/`-LICENSE.txt`（⇒ NSIS/7z 自解压安装器产物）、`resources.pak`（18:14:57）… 目录创建 18:13:46 |
| 时间对应 | `resources.pak` 18:14:57 → 桌面 `.lnk` **18:14:58**；`%LOCALAPPDATA%\Programs\DeepSeek Harness\` 18:10:52 创建（LastWrite 18:23:11，说明仍在被访问） |
| 驱动脚本与日志（真实盘） | `C:\Users\Administrator\Downloads\dsh-matrix2.ps1` / `dsh-matrix3.ps1`（18:22–18:24）：`$exe='…\dsh-setup-probe.exe'`，逐个路径跑 `"/S /D=$path"`；`dsh-matrix2.log` 里显式含 `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness` 的 `GetTempFileNameW` 预检与 `Probe`（`FAIL exit=2` / `[created] FAIL exit=2` / `[created] PASS <- …\Downloads\DSHProbe4`） |
| 进程 | `dsh-setup-probe`（pid 9912，`C:\Users\Administrator\Downloads\dsh-setup-probe.exe`）在跑；另有 2 个 `winstage-inject`（其他域的沙箱线程） |
| 端口 | 只有 `127.0.0.1:3080`（本 GUI）；**3091/9223 未监听** ⇒ 排除"usability 起的 3091 宿主"假设 |

⇒ 判定：**另一域/另一条 R16 工作流的"DSH 安装器静默装机矩阵"探针**（platform 真实盘安装，故文件、快捷方式、`%LOCALAPPDATA%\Programs` 目录都是真实落盘，与本域两条逃逸无关）。
**按 Lead 指示未删除**（可能是别人的证据）；`%LOCALAPPDATA%\Programs` 目录数 1→2 亦由此解释。
副产品：它证明"真实（非沙箱）安装确实会生成这样的桌面快捷方式"，可作为 §4.2 差分的一个旁证。

### 4.6 platform 对照（run-2）：差异确实由沙箱造成

| 探测 | run-1/3/4（WinStage TS） | run-2（platform，`WINSTAGE_SHELL=0`） |
|---|---|---|
| `rg.exe --version` | EXIT=0 | EXIT=0 |
| **`7zr.exe i`（i386）** | `Access is denied`（启动即失败） | **EXIT=0**，完整 7-Zip 26.04 版本与格式表（2,162 B，真实盘 `ws-2\ev\p2-7zr-i.txt`） |
| `C:\Program Files\wst-r16d3-ctl\a.txt` | 真实盘 False（进 overlay） | **C1=SUCCESS，真实盘 True** |
| `%LOCALAPPDATA%\Programs\wst-r16d3-ctl\a.txt` | 真实盘 False | **C2=SUCCESS，True** |
| Start Menu `.lnk`（COM） | **真实盘 True（逃逸）** | C3=SUCCESS，True |
| Public Desktop `.lnk`（COM） | **真实盘 True（逃逸）** | C4=SUCCESS，True |
| `HKLM\…\Uninstall\wst-r16d3` | 真实盘 False（待批候选） | **C5=SUCCESS，真实盘 True** |
| `C:\ProgramData\wst-r16d3-probe.txt` | 真实盘 False | **C6=SUCCESS，True** |
| run-2 自清理复核 | — | `p5` 六项**全 False**，`LEFTOVERS=NONE`；宿主复核一致 |

⇒ **同机、同账户、同 profile、同一批候选**，唯一变量 `WINSTAGE_SHELL`：
i386 拒绝与所有"暂存"行为都来自 **WinStage shim 层**，不是 Windows ACL、也不是权限不足。

---

## 5. 与 R11 同域结论的对照

| R11 条目 | R11 判定 | **R16 实测** | 归类 |
|---|---|---|---|
| §4 安装器能否装成 | "AMD64 `/S /D=` 退出码 0，107 文件全进 overlay" | **复现**：`NATIVE_EXIT=0`，overlay 107 文件，真实盘零文件 | **复现** |
| D3-1 i386 被 `ERROR_ACCESS_DENIED` 硬拒 | 退出码 1 + 19 B 文本 | **复现且更差**：进程启动即失败（`ApplicationFailedException`，无数字退出码）；`SysWOW64\cmd.exe` 同拒；64 位对照正常；platform 下 EXIT=0 | **复现（形态变差）** |
| D3-2 MSI 服务通道整体不可用（1622/1601），"两边都没有产物" | 失败且零落盘 | **形态变化 / 部分推翻**：`/a` **EXIT=0 且真实盘写出 2,449 文件 / 134 MB**；`/i` 得 1603 且事件日志给的是"已装更新版 Node"（产品级原因）；`msiserver` 本次为 `STOPPED` | **变化（新 P0）** |
| D3-3 `readThrough` 枚举与读取不一致 | `Test-Path=True` 而 `dir` File Not Found | **复现**：`ChildItemCount=0`、`DIR_EXIT=1`、`File Not Found` | **复现** |
| D3-4 `winget`/`choco` 不可用且零错误文本 | `0x8A150001` / `0xE0434352` | **not-run**（本轮未测） | not-run |
| D3-5 候选 JSON 含非法控制字符 | `cs_0002/cs_0003` 解析失败 | **复现**：`cs_0002_8d1f0a9f.json` `ConvertFrom-Json` 失败（`Invalid object passed in, ':' or '}' expected`），同 run 的 `cs_0021_c5b367b2.json` 正常 | **复现** |
| D3-6 `7zr.exe` 未钉版本、无公开摘要 | 同 URL 同 size 不同哈希 | **复现（弱）**：本轮盘上件仍是 R11 记录值 `256FECA8…`（未再变），厂商 `.sha256` 本轮仍取不到 ⇒ `no-published-digest`；**未做**新的同 URL 重复下载对比 | **复现（无新下载对照）** |
| D3-7 overlay 产物无法按逻辑路径枚举 ⇒ 安装后完整性只能宿主侧盘点 | — | **复现**：`app2604` / `msiapp` 两例都只能靠宿主侧 `stage-root-inventory` / 真实盘盘点 | **复现** |
| D3-8 零残留不成立（WER 遥测 + 遗留 `msiexec /V`） | 20 个 WER 目录 + 1 个 msiexec | **复现**：WER **+9**（7zr ×4 / cmd ×5）；run-4 遗留 `msiexec` ×1（已 kill，复核 0） | **复现** |
| R11 §6 "拒绝来自 WinStage shim，不是 ACL" | — | **复现**：platform 对照下 6/6 探针全部真实落盘成功 | **复现** |
| R11 未报：**COM 快捷方式逃逸** | — | **全新**：最小复现 run-3 差动干净 | **新缺陷 P0** |

---

## 6. 不确定项与 not-run（诚实边界）

* **归因机制未定（标 `[推断]`）**：COM `WScript.Shell.CreateShortcut().Save()` 为何绕过 staging 未定因
  （可能路径：`ole32`/`shell32` 走 `NtCreateSection`+`NtMapViewOfSection` 或经过未被 hook 的转发层）。
  本轮**没有**取到 shim 侧对该次写入的日志分支；`cs_0021` 候选里 0 命中 `.lnk` 路径，说明连候选队列都没记录。
* **MSI 机制已定到"进程外写者"（见 §7）：**`msiserver` 未注入是主因；本轮**已确认 MSI 客户端 pid 4328 被注入了**
  （`shim.log`：`[4328][1] DshRegStageAttach` … `[4328][4] hooks installed: 220 IAT sites across 20 modules … failClosed=1 readThrough=1`），
  但它对 `node.msi`/`msiapp`/`r16d3-msi` **零文件记录** ⇒ 产品写入与 `/L*v` 日志都由**服务侧**完成。
  仍存的不确定项：`/L*v` 日志究竟由客户端还是服务写（未定），以及 R11（RUNNING→1622/1601）与 R16（STOPPED→`/a` 成功）的环境差异**未定因**。
* **`shim.log` 已做定向检索**（本条为上一版"not-run"的更新）：run-3 的 `shim.log`（5,546,796 B / 47,738 行）中，
  `.lnk` 只出现 **7 行、全部是 `read-branch`**，`shell32`/`ole32` 各 **0 行**，`wshom` **2 行**（`mapped=C:\Windows\System32\wshom.ocx`，PID 2784/10316）；
  同一 run 的对照写入则正常出现 3 行 `CreateFileW staged(write)`（PID 6172）⇒ 结论见 §7。
* **not-run 清单**：`winget`/`choco`（D3-4）；`%LOCALAPPDATA%` 全量逐文件差分；MSI `/S` 之外变体、`DISM`/`pkgmgr`、`.nupkg` 直装、
  服务安装（`sc create`）、驱动安装；同源双构建的"整件哈希不同 / `.text` 相同"演示（D-R9）；GitHub Release asset digest 通道；
  `7zr.exe` 的同 URL 重复下载对比；`ftp/7z1900` 之外的 32 位工具链。
* **run-4 判据 3 的时间口径**：`workspace-inventory.txt` 在 run 结束之后生成，读到的是**逃逸之后**的真实工作区（2,449 文件）；
  这不代表 run 开始时的工作区不干净（run 开始前只有种子）。
* **平台对照 run-2 是"会写真实盘"的 run**：其产物在 run 内自删，宿主侧复核为 False/None；对照组本身不作 TS 断言。

---

## 7. P0 机制与补丁点（**只写分析，未构建、未改源码**）

> Lead 指示：其他域仍在跑沙箱线程，**禁止换 DLL/重建 shim**。本节只给到"文件 + 函数 + 判据"的可执行程度。

### 7.1 两条 P0 是否同一类？—— **不是**，必须分开修

| | COM `.lnk` 逃逸（R16-D3-1） | MSI 逃逸（R16-D3-2） |
|---|---|---|
| **写者位置** | **进程内**：`wshom.ocx` 明确映射在被注入的 PID 2784/10316 里（`shim.log` `read-branch … mapped=C:\Windows\System32\wshom.ocx`）⇒ 不是"进程外 COM 服务器" | **进程外**：写者是 `msiserver` 服务（客户端 pid 4328 已被注入，见 §6，但零文件记录；服务由 SCM 启动，不在 `CreateProcessW` 注入链上） |
| **为何没被拦** | shim 是 **IAT 钩子引擎**（`ws_hook.c:1`），而 `g_targets`（`ws_hook.c:30-106`）里有 `NtOpenFile`、**没有 `NtCreateFile`**；`shim/src` 全文 **0 处** `NtCreateFile`。OLE/shell 保存 `.lnk` 走的是 `ntdll!NtCreateFile` 直调 ⇒ 既没进 staging，**也没进审计日志**（该路径一个写入记录都没有，只有 `read-branch`） | 服务进程里根本没有 shim DLL ⇒ 同一条 `NtCreateFile` 补丁**也管不到它**；客户端侧只能拦"启动意图" |
| **类别** | **钩子覆盖面缺口（同类内进程写者都会中）** | **跨进程写者（同类：任何系统服务代写）** |

**直接证据索引**：`run-3\stage-root-273642102114806\staged\shim.log` L28833/L29048（`wshom.ocx` mapped + `.lnk` 仅 read-branch）、
L39036–L39040（对照写入 `staged(write)`）；`shim/src/ws_hook.c:1,16-17,30-106`（IAT 引擎 + 目标表 + 自述局限）；
`shim/src/ws_proc.c:4`（"user-mode IAT patch: it only covers the process the DLL was [injected into]"）；
`run-4\stage-root-273642102114806\staged\shim.log` L39268–L39272（`[4328]` 注入了）+ 全文 `node.msi`/`msiapp`/`r16d3-msi` **0 命中**。

### 7.2 补丁点 A（对应 R16-D3-1，**有同步点可拦**，优先级最高）

| 项 | 内容 |
|---|---|
| 目标文件 | `shim/src/ws_hook.c`、`shim/src/winstage_internal.h`、`shim/src/ws_file.c` |
| 1) 注册目标 | `ws_hook.c` `g_targets[]`（第 30–106 行）加 `WS_TARGET(NtCreateFile)`；`g_targetNames[]`（109–135 行）加 `"NtCreateFile"`。**先例就在旁边**：`WS_TARGET(NtOpenFile)` 与 `WS_TARGET(NtSetInformationFile)` 正是为"delete 旁路"加的（见 `ws_hook.c:52-62` 注释） |
| 2) 解析原函数 | `ws_hook.c` 原函数表（`{ (void **)&g_orig.NtOpenFile, "NtOpenFile" }`，约 389 行）旁加 `{ (void **)&g_orig.NtCreateFile, "NtCreateFile" }`，**必须显式从 ntdll 解析**（照 440 行 NtQuery 族的写法），不要依赖 `GetModuleHandle`+`GetProcAddress` 的间接路径 |
| 3) 声明 | `winstage_internal.h`（`NtOpenFile` 在 87 行）加 `NTSTATUS(NTAPI *NtCreateFile)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);` + 包装器声明 |
| 4) 包装器 | `ws_file.c` 新增 `NTSTATUS NTAPI ws_NtCreateFile(...)`，**照抄 `ws_NtOpenFile`（1149–1204 行）的骨架**：`t_wsFileBusy` 早退 → 取 `ObjectAttributes->ObjectName->Buffer` → 去 `\??\` 前缀 → `ws_should_intercept(raw, norm, WS_PATH_MAX)` → 分流 |
| 5) **判据（写意图）** | 仅当 `DesiredAccess & (FILE_WRITE_DATA\|FILE_APPEND_DATA\|FILE_WRITE_EA\|FILE_WRITE_ATTRIBUTES\|DELETE\|WRITE_DAC\|WRITE_OWNER\|GENERIC_WRITE\|GENERIC_ALL\|MAXIMUM_ALLOWED)` **或** `CreateDisposition ∈ {FILE_SUPERSEDE(0), FILE_CREATE(2), FILE_OPEN_IF(3), FILE_OVERWRITE(4), FILE_OVERWRITE_IF(5)}` 才视为写意图；否则原样透传 |
| 6) 暂存动作 | 写意图 → 复用 `ws_resolve_file(norm, WINSTAGE_IO_WRITE, staged, &wflags)`（`ws_file.c:368` 同款）；失败 ⇒ `IoStatusBlock->Status = 0xC0000022` + `ws_log_w(L"fail-closed NtCreateFile", norm)` + 返回 `STATUS_ACCESS_DENIED`（与 `failClosed=true` 一致）；成功 ⇒ 需要时 `ws_ensure_dirs(staged,1)`、已有真实文件时按 `ws_CreateFileW` 的 CoW 分支复制，然后对 **staged 路径**（转回 `\??\` 形式）调 `g_orig.NtCreateFile`，并记 `ws_log_w(L"NtCreateFile staged(write)", staged)` |
| 7) 已知坑 | ① `ObjectAttributes->RootDirectory != NULL`（相对目录句柄）——`ws_NtOpenFile` 直接放弃拦截，本补丁**建议同样保守放行 + 计数**，否则会打断大量合法相对打开；② `\??\`/`\\?\`/卷 GUID 前缀与 `ws_should_intercept` 的既有口径必须一致；③ 路径经 `NtCreateFile` 是**每次文件创建的热路径**，重入/递归必须靠 `t_wsFileBusy` 挡住；④ passthrough（stage root 自身、`winstage-shim.config.json` 的 `passthrough[]`）必须继续透传，否则 shim 自己的写入会递归 |
| 8) **低风险的两步走（强烈建议）** | **第 1 步只加"计数+审计"包装**（新目标，仅记录 raw/normalized/disposition 后原样调用真函数）——不改行为、可拿到"到底有多少 `.lnk`/OLE 写入走这条路"的实测，再决定第 2 步接 staging。这样既拿到机制铁证，又避免 R15 那种"重建件把 lane 打到 T1"的风险 |
| 9) 回归夹具 | 直接复用 run-3 差动：COM 建 `.lnk`（Start Menu + Public Desktop）**必须**出现 `NtCreateFile staged(write)` 且真实盘 False；同目录 `Set-Content`（普通 txt 与普通 `.lnk`）维持现状；platform 对照维持真实落盘 |
| 10) 备用（不作为主修） | 也可挂 `ole32!StgCreateStorageEx`/`shell32` 的保存 API，但覆盖面窄于 `NtCreateFile`，且 shell 内部实现可能变更 ⇒ 只适合作纵深防御 |

### 7.3 补丁点 B（对应 R16-D3-2，**没有可拦的同步文件点**）

| 项 | 内容 |
|---|---|
| 为什么没有同步点 | 真正写盘的是 `msiserver` 服务进程（未注入）；补丁 A 完成后，客户端侧的 MSI 缓存/日志写入会被暂存，但 `TARGETDIR` 里的产品文件仍会由服务写真实盘。**进程内挂钩无法覆盖另一个进程的系统调用。** |
| 立即可做的（建议 P0 级 policy，不碰 shim） | 在 `dsh-plugin/shell-executor.mjs` 的 **TS 档命令闸门**（spawn 之前那处分类逻辑）把 `msiexec`/`msiexec.exe`（以及 `sc start msiserver`、`Dism /Add-*` 之类服务代写工具）判为 **TS 档不可用**：fail-closed，返回专门错误码（如 `WINSTAGE_SHELL_MSI_UNSUPPORTED`），并把该判定写进 lane/审计。理由：现在的结果是"有时成功、有时 1622/1601/1603，成功时静默逃逸"，比明确拒绝更危险 |
| 若要真正支持 MSI（设计级，非单点补丁） | ① 注入 `msiserver`（服务由 SCM 启动，需要 SYSTEM 级/服务启动期注入，改动面与风险都大）；② 或上文件系统 minifilter + 事后检测/隔离（脱离现有用户态 IAT 架构）；③ 或接受"MSI 在 TS 档不支持"并写进产品文档 |
| 验收判据 | `msiexec /a` 在 TS 档**要么**被明确拒绝且带专用错误码（推荐），**要么**真实盘零新增（需要 ①②）——**不允许**"EXIT=0 且真实盘 +2,449 文件" |

### 7.4 待 Lead 决策的次序（我的建议）

1. 先做 **7.2 第 8 步的"审计-only 版本"**（单独一次构建 + 一轮 run-3 夹具），拿到 `NtCreateFile` 的命中铁证 —— 这是唯一能把"机制推断"升级为"机制确证"的低风险实验；
2. 再做 **7.3 的 policy 拒绝**（不依赖 shim 构建，可与其他域并行推进）；
3. 最后再谈 7.2 第 2 步（真正接 staging）与 MSI 的服务级方案；**任何 shim 产物的启用仍先过 lane 判据（必须 TS）**。

---

## 8. 证据索引（全部相对仓库根）

| 证据 | 路径 |
|---|---|
| 宿主侧完整性（哈希/PE/签名原始输出） | `.t\r16\exe\host\integrity-host.txt` |
| 公开摘要比对表 | `.t\r16\exe\host\digest-compare.txt` |
| D-R9 代码身份（三个 DLL 的 `.text`） | `.t\r16\exe\host\dr9-crossbuild.txt` |
| 系统面前后快照 | `.t\r16\exe\host\snap-before.txt`、`.t\r16\exe\host\snap-after.txt` |
| WER 遥测留档（9 条路径 + Report.wer sha256 + 删除后 `exists=False`） | `.t\r16\exe\host\wer-removed-manifest.txt` |
| 真实盘逃逸件留档 + sha256 清单 | `.t\r16\exe\host\realfs-lnk\`（`.lnk` ×4 副本、`manifest.txt`、`r16d3-msi.log.copy`） |
| run-1 判据三件套 | `.t\r16\exe\run-1\{session-id.txt,stage-root-path.txt,lane.txt}`、`stderr.txt`(0 B)、`exitcode.txt`(0) |
| run-1 线程内原始读数（overlay） | `.t\r16\exe\run-1\stage-root-25477159411235\staged\fs\C\…\ws-1\ev\{a0,a1,a2,a3,b1,b2,b3,c-probes,d-readback,e-ws-list,f-staged-mirror,g-outofstage-check,zz-final-summary}.txt` |
| run-1 暂存盘点 / 候选 / 注册表 journal | `.t\r16\exe\run-1\stage-root-inventory.txt`(581 行)、`…\candidates\{cs_0002_8d1f0a9f,cs_0021_c5b367b2}.json`、`…\registry\overlay.journal`(2,508 B) |
| run-1 暂存 ws-1 清单（121 文件） | `.t\r16\exe\host\staged-ws1-list.txt` |
| run-1 最终答复 | `.t\r16\exe\run-1\FINAL-run1.md` |
| run-2（platform 对照） | `.t\r16\exe\run-2\lane.txt`、`.t\r16\exe\ws-2\ev\{p0..p5}`、`.t\r16\exe\run-2\workspace-inventory.txt`、`FINAL-run2.md` |
| run-3 最小复现 | `.t\r16\exe\run-3\lane.txt`、`.t\r16\exe\ws-3\ev\m-repro.txt`（overlay 内 370 B）、`run-3\stage-root-…\staged\fs`（overlay 只含 3 个对照件）、`FINAL-run3.md` |
| run-4 MSI | `.t\r16\exe\run-4\lane.txt`、`.t\r16\exe\ws-4\ev\m-msi.txt`（overlay）/ `m1-admin.log`（真实盘 5.6 MB）、`run-4\workspace-inventory.txt`（真实盘 2,449 文件）、`FINAL-run4.md` |
| 自写 PE 解析器 / 快照脚本 | `.t\r16\exe\bin\pe-sections.mjs`、`.t\r16\exe\bin\snapshot.ps1` |
| 本轮新下载件 | `.t\r16\exe\downloads\ripgrep-v15.0.1-x86_64-pc-windows-msvc.zip`（BD28761F…）、`downloads\rg-extract\rg.exe`（F9DDE634…） |

**敏感材料清理（协议 §5）**：本域**未**接触任何凭据/密钥文件；`.t\r16\exe\**` 关键字扫描
（`credential|.env|id_rsa|token|secret|.pem|.key|password`）仅命中 MSI 安装产物里 **npm 自带的文档/源码文件**（`ws-4\msiapp\…\npm\…`），
无宿主凭据副本 ⇒ 无需删除、无 sha256 待登记项。真实盘 `C:\Windows\Temp\r16d3-msi.log` 与 4 个 `.lnk` 已按 §4.4 留档后删除。
