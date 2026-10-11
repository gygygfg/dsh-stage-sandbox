# R16 · D3 exe 缺陷清单（WinStage 沙箱 · 安装完整性与隔离）

> 执行：teammate `exe` · 4 个嵌套 run（run-1 winstage 主测 / run-2 platform 对照 / run-3 最小复现 / run-4 MSI 复验），三个 winstage run 全部 `LANE_OK=true`
> 全部条目均有原始证据；上下文与证据索引见 `docs/round16/exe-报告.md`
> 纪律：本轮**未改任何仓库源码**；缺陷只报告，交 Lead 统一修复
> **后续（Lead 指派）**：WER 遥测已按 R15 口径留档后删除；两条 P0 的**机制归类与补丁点**见本条末尾的"机制 / 补丁点"小节（**只写分析，未构建 shim、未改源码**）。
> 补充证据：对 run-3/run-4 的 `shim.log` 做了定向检索（见 `docs/round16/exe-报告.md` §7）。
> **当前状态**：① `.lnk`/`NtCreateFile` 已有"下一轮可执行交接"（见 R16-D3-1 末）；② MSI 策略闸门**已获 Lead 批准、方案与离线判据脚本已就绪、等 go**（见 R16-D3-2 末 + `.t\r16\exe\msi-gate-patch.md`）。两者**均未落地**。

---

## R16-D3-1（**P0 阻断**）COM 快捷方式（`WScript.Shell.CreateShortcut().Save()`）绕过暂存，直接写真实盘

* **现象**：TS 档沙箱内创建 Windows 快捷方式 `.lnk`，返回值 SUCCESS、沙箱内 `Test-Path`=True，
  但文件**真实落在真实盘**（开始菜单 + 公共桌面各一个），overlay 里**没有**任何对应物；同一目录里用 `Set-Content` 写的普通文件却正常进 overlay。
* **最小复现**（run-3，`LANE_OK=true`，`stderr.txt`=0 B，`ws-3` 预置 5 个目标路径全不存在）：

```powershell
# 逃逸（写真实盘）
$sh = New-Object -ComObject WScript.Shell
$l  = $sh.CreateShortcut('C:\ProgramData\Microsoft\Windows\Start Menu\Programs\wst-r16d3.lnk')
$l.TargetPath = 'C:\Windows\notepad.exe'; $l.Save()
$l2 = (New-Object -ComObject WScript.Shell).CreateShortcut('C:\Users\Public\Desktop\wst-r16d3.lnk')
$l2.TargetPath = 'C:\Windows\notepad.exe'; $l2.Save()

# 对照（同一目录、同一进程、同一时刻 → 正常进 overlay）
Set-Content 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\wst-r16d3-ctl.txt' 'ctl'
Set-Content 'C:\Users\Public\Desktop\wst-r16d3-ctl.txt' 'ctl'
Set-Content 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\wst-r16d3-plain.lnk' 'not-a-real-shortcut'   # 普通文件，名字以 .lnk 结尾
```

* **原始证据（宿主侧外置观测 = 决定性）**
  * 真实盘 **存在**：`C:\ProgramData\Microsoft\Windows\Start Menu\Programs\wst-r16d3.lnk`
    （794 B，`CreationTime=LastWriteTime=2026-10-11 18:16:35`，sha256 `AAAA8CB258FE6C5B784F246D100E67115756524F00558B4B6CFE1143A8778ED2`）
  * 真实盘 **存在**：`C:\Users\Public\Desktop\wst-r16d3.lnk`
    （782 B，18:16:46，sha256 `18E6821696F374D06E849EF4673A99878856F0FF6199DF11D7282ED359655D77`）
  * 真实盘 **不存在**：`wst-r16d3-ctl.txt`（两处）、`wst-r16d3-plain.lnk`
  * overlay（`run-3\stage-root-273642102114806\staged\fs`）**只**有 3 个对照件（两个 `-ctl.txt` 5 B + `-plain.lnk` 21 B），**无** `.lnk`
  * run-1 的独立重复：`…\Start Menu\Programs\wst-r16d3.lnk`（794 B，18:11:16，sha256 `F3AD7024D3636D091EE88E6AC67699A3699F95A6D0B9A7D96B3E45D3F415BD65`）、
    `C:\Users\Public\Desktop\wst-r16d3.lnk`（782 B，18:11:16，sha256 `022B039DBD4688307DCDB2466E42163A43D4A1CD1316EACF1EAB5244C7595089`）
  * 归因排除：run-2（platform）用完即删且宿主复核为 False；两个真实 `.lnk` 的时间戳 18:11:16 落在 run-1 窗口内、run-2 清理（18:06:34）之后；run-3 是干净的前置全 False 复现
  * 候选队列**也没记录**：run-1 `candidates\cs_0021_c5b367b2.json`（167 条 shell 文件变更）对 `wst-r16d3.lnk` / `Public\Desktop` / `Start Menu` **0 命中**
  * 原件留档：`.t\r16\exe\host\realfs-lnk\`（`.lnk` 副本 + `manifest.txt`，真实盘副本已按规程删除）
* **根因（已定位到代码行，不再是纯推断）**：shim 是**用户态 IAT 钩子引擎**（`shim/src/ws_hook.c:1` 文件头自述；
  `shim/src/ws_proc.c:4`：「it only covers the process the DLL was [injected into]」），
  其挂钩目标表 `g_targets[]`（`ws_hook.c:30-106`）**含 `NtOpenFile` 却没有 `NtCreateFile`**，`shim/src` 全文 **0 处** `NtCreateFile`。
  `WScript.Shell`（`wshom.ocx`）**确实在同一个被注入进程内运行**——`run-3\…\staged\shim.log`：
  `[2784] read-branch resolved flags=0x4 mapped=C:\Windows\System32\wshom.ocx`（另 PID 10316 有同型记录），
  而这两个 PID **没有任何 `.lnk` 的写入记录**，只有：
  `[2784][4889] read-branch resolved flags=0x4 mapped=…\Start Menu\Programs\wst-r16d3.lnk` /
  `[2784][4890] read-branch real-open ok=0 err=2`（PID 10316 同型）。
  同一 run 的对照写入则是正常记录：`[6172][4317] CreateFileW staged(write) …wst-r16d3-ctl.txt` 等 3 行（`.lnk` 之外的对照件）。
  ⇒ **判定：这不是"进程外 COM 服务器"问题，而是"进程内 API 覆盖面缺口"**：OLE/shell 保存 `.lnk` 经 `ntdll!NtCreateFile` 直调，
  该入口既不在 IAT 目标表里，也不在 `GetProcAddress`/`LdrGetProcedureAddress` 的替换名字表（`g_targetNames`）里 ⇒ 拿到真实函数 ⇒ 既没暂存、也没审计。
* **机制铁证与不确定性**：`g_targets` 缺 `NtCreateFile` + 日志里"只有 read-branch、没有写入"两条互相印证；
  **未直接观测到那一次 `NtCreateFile` 调用**（shim 不挂钩它，日志里不可能有）⇒ "`.lnk` 保存经 `NtCreateFile`"仍是**强相关推断**，
  可用下节的"审计-only 版"一步确证（不改变行为）。
* **影响**：任何在沙箱内创建快捷方式的动作（安装器、部署脚本、`New-Object -ComObject WScript.Shell`）都会**污染真实开始菜单/桌面**，
  而沙箱内 `Test-Path` 会假绿给 SUCCESS。这会破坏"安装器隔离"的核心承诺，也说明**线程内自证不可信**，必须用宿主侧观测。
  同类"直调 ntdll 落盘"的写者（不止 `.lnk`）预计同样会逃逸。
* **补丁点（文件 + 函数 + 判据；未实施）**
  * **文件**：`shim/src/ws_hook.c`（注册目标+解析原函数）、`shim/src/winstage_internal.h`（声明，`NtOpenFile` 原型在 87 行旁）、`shim/src/ws_file.c`（包装器）。
  * **函数**：新增 `NTSTATUS NTAPI ws_NtCreateFile(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG)`，
    骨架**照抄现成的 `ws_NtOpenFile`（`ws_file.c:1149-1204`）**——那是本仓库为"delete 旁路"加的同类 ntdll 目标，先例就在旁边。
  * **注册**：`g_targets[]` 加 `WS_TARGET(NtCreateFile)`、`g_targetNames[]` 加 `"NtCreateFile"`、原函数表（约 `ws_hook.c:389`）加 `{ (void **)&g_orig.NtCreateFile, "NtCreateFile" }`（显式从 ntdll 解析，照 440 行 NtQuery 族写法）。
  * **判据（写意图）**：`DesiredAccess & (FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_EA|FILE_WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER|GENERIC_WRITE|GENERIC_ALL|MAXIMUM_ALLOWED)`
    **或** `CreateDisposition ∈ {FILE_SUPERSEDE(0),FILE_CREATE(2),FILE_OPEN_IF(3),FILE_OVERWRITE(4),FILE_OVERWRITE_IF(5)}` ⇒ 拦截；否则原样透传。
  * **动作**：`t_wsFileBusy` 早退 → 从 `ObjectAttributes->ObjectName` 取宽串、去 `\??\`、`ws_should_intercept()` → 写意图则
    `ws_resolve_file(norm, WINSTAGE_IO_WRITE, staged, &wflags)`（同 `ws_file.c:368`）→ 失败 `IoStatusBlock->Status=0xC0000022` + `fail-closed NtCreateFile` 日志 + 返回 `STATUS_ACCESS_DENIED`；
    成功则必要时 `ws_ensure_dirs` / 按 `ws_CreateFileW` 的 CoW 分支复制，然后对 **staged 路径**调真函数，并记 `NtCreateFile staged(write)`。
  * **已知坑**：`ObjectAttributes->RootDirectory != NULL`（相对打开）建议照 `ws_NtOpenFile` 保守放行+计数；`\??\`/`\\?\`/卷 GUID 前缀要与既有口径一致；这是**每次文件创建的热路径**，重入必须靠 `t_wsFileBusy`；passthrough（stage root 与 `winstage-shim.config.json` 的 `passthrough[]`）必须继续透传，否则 shim 自身写入会递归。
  * **风险与次序（重要）**：Lead 已明确**现在不换 DLL**（其他域在跑沙箱线程，且 R15 证明非 golden 重建件会把 lane 打到 T1）。
    建议**两步走**：第 1 步只加"**审计-only**"包装（新目标 + 仅记录 raw/normalized/disposition 后原样调真函数，不改行为）拿到命中铁证；
    第 2 步再接 staging。任何 shim 产物启用前仍必须过 lane 判据（必须 TS）。
* **下一轮可执行交接（Lead 2026-10-11 裁定：本轮不构建 shim ⇒ 此节就是交接件，照做即可）**
  1. **注册（`shim/src/ws_hook.c`）**：`g_targets[]`（30–106 行）**紧跟 `WS_TARGET(NtOpenFile)`（第 60 行）**加 `WS_TARGET(NtCreateFile)`；
     `g_targetNames[]`（109–135 行）**紧随 `"NtOpenFile"`** 加 `"NtCreateFile"`。
     ★ 两张表**必须同序等长**（`WS_TARGET_COUNT` 与 `g_targetNames` 的平行性是引擎硬前提）。
  2. **解析原函数（`ws_hook.c`）**：`{ (void **)&g_orig.NtOpenFile, "NtOpenFile" }`（约 389 行）旁加 `{ (void **)&g_orig.NtCreateFile, "NtCreateFile" }`，
     **显式从 ntdll 解析**（照 440 行 NtQuery 族写法）——不要走 `GetModuleHandle`+`GetProcAddress` 的间接路径，否则 `0xC0000002` 哨兵含义会漂移。
  3. **声明（`winstage_internal.h`）**：第 87 行 `NtOpenFile` 原型旁加
     `NTSTATUS(NTAPI *NtCreateFile)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);` + 包装器声明。
  4. **包装器（`shim/src/ws_file.c`）**：新增 `ws_NtCreateFile`，**骨架逐段照抄 `ws_NtOpenFile`（1149–1204 行）**：
     `ws_attr_log_nt` / `ws_callhit_named` → `t_wsFileBusy` 早退 → 取 `ObjectName->Buffer`（`cch = Length/sizeof(wchar_t)`，越界截到 `WS_PATH_MAX-1`）
     → 去 `\??\` → `ws_should_intercept(raw, norm, WS_PATH_MAX)` → 写意图分流。
  5. **两条判据（同时成立才动手，否则原样透传 = 默认零行为变化）**：
     * **写意图**：`DesiredAccess & (FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_EA|FILE_WRITE_ATTRIBUTES|DELETE|WRITE_DAC|WRITE_OWNER|GENERIC_WRITE|GENERIC_ALL|MAXIMUM_ALLOWED)`
       **或** `CreateDisposition ∈ {FILE_SUPERSEDE(0), FILE_CREATE(2), FILE_OPEN_IF(3), FILE_OVERWRITE(4), FILE_OVERWRITE_IF(5)}`；
     * **路径需拦截**：`ws_should_intercept()` 为真（它已统一处理 stage root / passthrough / 系统路径豁免）。
  6. **四个已知坑（逐条都有先例，别自创）**：
     ① `ObjectAttributes->RootDirectory != NULL`（相对目录句柄打开）——`ws_NtOpenFile` 直接放弃拦截，本补丁**照抄保守做法 + 计数**，不解析相对句柄；
     ② 前缀形态 `\??\` / `\\?\` / 卷 GUID 三种都要与 `ws_should_intercept` 既有口径一致，交回真函数时保持 NT 原名；
     ③ **热路径重入**：这是每次文件创建都要过的入口，递归必须靠 `t_wsFileBusy` 挡住（kernelbase 内部也会回到我们的钩子）；
     ④ **passthrough 必须继续透传**（stage root 自身 + `winstage-shim.config.json` 的 `passthrough[]`），否则 shim 自己的写入自递归。
  7. **启用次序（Lead 已裁定）**：先合 **审计-only** 版（只记录 `raw`/`norm`/`Disposition`/`DesiredAccess` 后原样调真函数），
     用 run-3 夹具把"`.lnk` 保存确实经 `NtCreateFile`"从**强推断**升级为**确证**；**再**合接 staging 的版本。
     任何 shim 产物上线前必须同时过 `lane=TS`（`LANE_OK=true`）与"真实盘零落盘"两条硬门禁。
  8. **回归夹具（现成，直接复用）**：run-3 差动（COM 建 `.lnk` + 同目录 `Set-Content` 普通 txt + 普通 `.lnk` 文件）。
     第 1 步期望：`shim.log` 多出 `NtCreateFile` 审计行、真实盘仍 True（未修）；第 2 步期望：真实盘 False 且台账出现 `NtCreateFile staged(write)`；
     platform 对照（`WINSTAGE_SHELL=0`）维持真实落盘不变。

---

## R16-D3-2（**P0 阻断**）MSI 管理员安装经未注入的 `msiserver` 在真实盘写出完整产品（2,449 文件 / 134 MB）

> **✅ 状态：已修**（2026-10-11，Lead 裁定 D1=`POLICY` / D2=fail-closed / D3=保守触发面后 GO）
> **落地面**：**只有** `dsh-plugin/shell-executor.mjs`（MSI 闸门 4 个插入点，`+131` 行 / `-0` 行）
> ＋同文件 `this.networkTier` **env 优先级修复**（Lead 的 D5-R16-2，见本节末）。未碰 `cordis.patch.yml` / `staging-fs.mjs` / 任何 `shim/` 文件。
>
> **判据（全绿，原始输出）**
> * `node .t\r16\exe\msi-gate-check.mjs --mode=present --strict --import` → **`RESULT: ALL PASS (30/30)`**，`verdict_source=extracted-vm`（把纯函数标记区抽出来在 `node:vm` 空上下文求值 ⇒ 零依赖已证明）；含闸门在 `executeConfined()` 内且**早于** `loadBaseClass()`、语义码 `POLICY + presetMessage`、闸门**不读** `WINSTAGE_SHELL`（仅对**代码**断言，注释不算）、模型可见文案 **0** 违规、`semanticShellFailure()` 端到端字段（`technicalCode` / `category=policy` / `retryable=false` / `executed=false`）。
> * `node tests\executor-stub.mjs` / `tests\integration-wiring.mjs`（144/144）/ `tests\selftest.mjs` / `tests\suite-wiring.mjs`（29/29）/ `tests\baseline-integrity.mjs`（14/14）→ **全部 exit 0**（重封后复跑）。
> * **`autotest.cmd --skip-audit` → exit 0：33 套通过 / 0 失败 / 0 跳过，2077 checks ok / 0 bad**（`.t\r16\exe\host\autotest-post-fix.txt`）。
> * `node tools\baseline-sha256.mjs --write` → **119 条**；`--check` → **exit 0**。
>
> **用户可见文案（模型面，0 违规）**
> ```
> DENIED_ACTION_NOT_PERMITTED: MSI 安装（msiexec / msiserver）在当前模式下不被允许，本次未执行；
> 该方式依赖系统级安装服务，请改用便携式/免安装分发方式，或改用不依赖 MSI 服务的安装方式
> （见 docs/round16/exe-缺陷.md 的 R16-D3-2）。
> ```
> 人工侧另有 `error.winstage = {msiGate, matched, matchedHead, reason, doc, evidence}` ＋ error 级日志
> （保留"进程外 `msiserver` / 无法进入暂存与覆盖层"的机制原文）。**未改** `TRANSPARENCY_FORBIDDEN_TOKENS`（Lead 裁定）。
>
> **残余风险**
> 1. **策略而非根治**：只挡"经 shell 工具发起的 MSI 命令"。已注入进程内的原生 API 调用、计划任务、服务侧仍可绕过；
>    根治需服务级注入或文件系统 minifilter（设计级，本轮未做）。
> 2. 按 D3 裁定，`sc query msiserver` / `taskkill /im msiexec.exe` 这类"提到名字但不运行安装"的命令**故意放行**（扩面加一行即可）。
> 3. `/i` 的 `1603` 曾由"本机已装更新版 Node"造成（产品级原因），本闸门**不依赖** R11/R16 的 `msiserver` 状态差异。
> 4. 平台档不受影响是**结构保证**（`WINSTAGE_SHELL=0` ⇒ `cordis.patch.yml:157-166` 的行 disabled ⇒ 本模块不装载），
>    因此闸门**刻意不读** `WINSTAGE_SHELL`（避免双真源）；该性质由离线脚本 S03 断言。
> 5. 真机 TS 档端到端复验 **已跑，三条判据全绿** —— 见本节末"修复后复验（run-5）"。
>
> **方法学注记（判据脚本与被测实现互为对手）**
> * **准备阶段**：离线脚本抓到候选实现一个**真 bug** —— `basename('/c')` 会把 `/c` 按路径分隔符剥成 `c`，导致 `cmd /c msiexec …` **漏拦**；
>   修法：对**原始 token** 判旗标（`-x` / 短形 `/c` 是旗标；`/usr/bin/x` 这种含分隔符的按**路径**处理）。这条只有在"先写判据、后落地"的次序下才抓得到。
> * **落地后**：同一脚本又抓到两处自身问题 —— ① 标记区按 tag 位置切会把注释行切成裸代码（`vm` 报 `Unexpected identifier 'MSI'`），改为**按整行切**；
>   ② `S03` 把闸门注释里"刻意不读 `process.env.WINSTAGE_SHELL`"这句话当成代码而误报，改为**剥离注释后再断言**。两处均已修，脚本自身也在版本内留下说明。
> * **不在 `OFFLINE_SUITES` 的两个红套件（与本改动无因果，交 Lead 判定）**：`tests\dsh2-select-shell-verify.mjs`（22 ok / 3 bad：`enabled=false ⇒ 平台让位` 三条）
>   与 `tests\acceptance-transparent.mjs`（T5–T8）。前者**只解析 `dsh-plugin/cordis.patch.yml`**、对 `shell-executor.mjs` **0 引用**；后者是"需真沙箱会话"的验收台。两者都不在离线全量里。
>
> **本节末 · 同文件第二处落地（Lead 的 D5-R16-2，非域 3 缺陷）**
> `this.networkTier` 改为 **env 优先**：`stringOption(process.env,'WINSTAGE_NETWORK_TIER') ?? stringOption(raw,'networkTier')`，
> 注释写明"env > 行 > 代码默认；非法值一律回落 `OBSERVED_ONLINE`"。
> 离线 A/B（`.t\r16\exe\networktier-env-ab.mjs`，**从源码文本抽出实际语句**求值）**8/8 PASS**，含
> `env 未设 + 行=OBSERVED_ONLINE ⇒ OBSERVED_ONLINE`（默认行为不变）、`env=OFFLINE + 行=OBSERVED_ONLINE ⇒ OFFLINE`（逃生口恢复）、`env=GARBAGE ⇒ OBSERVED_ONLINE`。

### 修复后复验（run-5 · 真机 TS 档端到端 · 单 run，Lead GO）

**run 三件套**：`session-b8cdd456-e80c-4ba8-b0e1-9fddac61e0dc` ·
`stage-root=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r16\exe\run-5\stage-root-22152953311022` ·
`lane.txt`：`tierEffective=TS / degraded=false / launchMode=shim / shimCount=13 / degradeCount=0 / LANE_OK=true`；
`exitcode=0`、`stderr.txt=0 B`。夹具 = run-3 最小复现改造（`ws-5`，预置 `cand\msi\node.msi` = 30,916,608 B / sha256 `2C0CC97EC64C…` + `seed.txt`）。

**(A) 返回专用语义码 —— 原始读数**（`run-5\stdout.ndjson` 第 21 行的 `tool_result`，`status":"error"`）：
```
Error: DENIED_ACTION_NOT_PERMITTED: MSI 安装（msiexec / msiserver）在当前模式下不被允许，本次未执行；该方式依赖系统级安装服务，
请改用便携式/免安装分发方式，或改用不依赖 MSI 服务的安装方式（见 docs/round16/exe-缺陷.md 的 R16-D3-2）。
```
* `S5_HAS_DENIED_ACTION_NOT_PERMITTED=True`、`S5_HAS_MSI_TEXT=True`、**`S5_HAS_COMMAND_FAILED=False`**（子代理另标注：其后一次 `True` 是分类器自匹配回声的伪影，已排除）。
* **`WINSTAGE_SHELL_MSI_UNSUPPORTED` 不出现在模型可见面，是设计如此**：技术码与 `error.winstage.*` 走人工侧通道；
  该字段由离线判据 `S05-semanticShellFailure`（`category=policy` / `retryable=false` / `executed=false`）断言，本轮离线 **30/30**。
* 触发面**保守性**当场对照（同 run，均**未**被拦）：`echo GATE_CONTROL_OK` → `S1_EXIT=0`；`sc query msiserver` → `S2_EXIT=0`（只读提到服务名不拦，符合 D3 裁定）。

**(B) 宿主侧真实盘零新增**（`host\e2e-before.txt` 18:54 → `host\e2e-after.txt` 19:0x，**不受限宿主 pwsh**）：

| 复核项 | before | after | delta |
|---|---|---|---|
| `DIR` 全部 7 行（`Program Files` / `Program Files (x86)` / `%LOCALAPPDATA%\Programs` / 两处开始菜单 / Public Desktop / Desktop） | 7 行 | 7 行 | **逐行相同（diff=0）** |
| `REG` 6 行（Uninstall ×3 + Run ×3） | 6 行 | 6 行 | **逐行相同** |
| `UNINST` 子键/DisplayName | 64 行 | 64 行 | **逐行相同** |
| `REGV` Run 值 | 3 行 | 3 行 | **逐行相同** |
| `WER\ReportArchive` | 8 条 | **8 条** | **0**（拒绝发生在 spawn 之前 ⇒ 无崩溃遥测，优于未修前 +9） |
| `PROCS` | 8 | 4 | 无遗留 |
| `C:\Windows\Temp\r16d3-msi.log`（未修前曾被写出 46,556 B） | False | **False** | 0 |
| `C:\Program Files\wst-r16d3-ctl` / `%LOCALAPPDATA%\Programs\wst-r16d3-ctl` / `HKLM\…\Uninstall\wst-r16d3` | False | **False** | 0 |
| `msiexec` 进程 | 0 | **0** | 0 |
| 真实 `ws-5` | `seed.txt`(21 B) + `cand\msi\node.msi`(30,916,608 B) | **同样 2 文件 / 3 目录，sha256 不变** | 0；**`ws-5\msiapp` = False** |

> A/B 意义：**同一个命令**在未修前（run-4）真实盘产出 **2,449 文件 / 574 目录 / 134,868,847 B** 并留下真实盘日志；现在同一命令真实盘 **零新增**。

**(C) 协议 §1.1 四条判据 + 暂存树无产物**
* ① `stderr.txt` **0 B**；② 暂存面工作（`stage-root-inventory.txt` 含我让它写的 `ws-5\ev\*`，`candidates\cs_0016_1e0d7b22.json` 在）；③ 真实工作区只有预放种子（`workspace-inventory.txt`：`files=2 dirs=3`，仅 `seed.txt` + `cand\msi\node.msi`）；④ **`LANE_OK=true`（TS / degraded=false）**。
* **暂存树里没有 `msiapp` 产物**：对 `stage-root\staged` 全树检索 `msiapp` → **0 命中**；`node.msi` → 0 命中（种子在真实盘，只读透传）。
* 子代理线程内自证：`S4_MSIAPP_EXISTS=False`、`S4_WS_FILES=2`、`S4_MSIEXEC_PROCS=0`。

**现场观察（值得留档的边界，非缺陷）**
* 闸门判的是 **`spec.command`（pwsh 命令文本）**，所以**整条脚本在 pwsh 启动前就被拒** ⇒ 脚本内的 `try/catch` 根本不会执行（子代理实测：`S3_NOTE=…denied BEFORE pwsh started`）。
* 推论：**命令文本里"原样嵌入"该调用形态也会被拒**（子代理报告连"把原始错误写进文档字符串"都被拒）。方向是**安全侧**（宁可多拒、绝不漏放），代价是"逐字记录错误文本"这类工作流需要绕行。
  若要收窄，需要改为"只在 PowerShell 解析后的**命令位置**匹配"（复杂度和误放风险都会上升）—— 本轮**不做**，仅记录。
* 技术码在 run 产物里不可观测（`tool_result` 只到语义码；`audit.jsonl`/`sandbox-audit.json` 对 `WINSTAGE_SHELL_MSI_UNSUPPORTED` **0 命中**），因此 (A) 的"专用码"以**模型可见语义码**为准 + 离线 `S05` 断言技术码。

* **现象**：TS 档沙箱内 `msiexec /a node.msi /qn TARGETDIR=<ws>\msiapp` **EXIT=0**，
  产品**完整落真实盘**；而同一 run 里嵌套 agent 自己写的 `ev\m-msi.txt` 正常进 overlay。
* **最小复现**（run-4，`LANE_OK=true`，`stderr.txt`=0 B）：

```powershell
$p = Start-Process -FilePath 'C:\Windows\System32\msiexec.exe' -PassThru -ArgumentList @(
  '/a','<ws>\cand\msi\node.msi','/qn','TARGETDIR=<ws>\msiapp','/L*v','<ws>\ev\m1-admin.log')
$p | Wait-Process -Timeout 120; "EXIT=$($p.ExitCode)"     # → EXIT=0
```

* **原始证据**
  * 真实盘 `<ws>\msiapp` = **2,449 文件 / 574 目录 / 134,868,847 B**（`run-4\workspace-inventory.txt`；
    `…\PFiles64\nodejs\node.exe` 83,344,536 B、`npm`、`corepack`、`node_modules` 等）
  * 真实盘日志 `ws-4\ev\m1-admin.log` = **5,604,484 B**；而 agent 自己的 `ws-4\ev\m-msi.txt`（1,768 B）
    在 overlay（`run-4\stage-root-273642102114806\staged\fs\C\…\ws-4\ev\m-msi.txt`）
  * `/i` + `/L*v C:\Windows\Temp\r16d3-msi.log`：`/L*v` 的日志**写进真实盘**（46,556 B，sha256 `2BA0193360E47D130F72D3F2464BA2D70C303A7EFA50499396EE40BFF25C55BA`），
    安装本身 **EXIT=1603**，事件日志 `MsiInstaller` 1033/11708/10005 明确写 `Installation success or error status: 1603`
    与 `A later version of Node.js is already installed`（**产品级原因**，不是沙箱路径原因）
  * overlay 侧完全干净：`registry\overlay.journal` **0 字节**；`candidates\cs_0006_73e7f670.json` 只有 15 条 PowerShell 临时文件
* **根因（已定位）**：MSI 的实际落盘由**未被注入 shim 的 `msiserver` 服务进程**执行。
  `shim.log` 证明 **MSI 客户端 pid 4328 确实被注入了**：
  `[4328][1] DshRegStageAttach …`、`[4328][4] hooks installed: 220 IAT sites across 20 modules … failClosed=1 readThrough=1`（事件日志也写 `Client Process Id: 4328`），
  但该 run 的 `shim.log`（5,790,463 B / 49,744 行）里 `node.msi` / `msiapp` / `r16d3-msi` **各 0 命中**、也没有任何产品文件的 `staged(write)` 记录
  ⇒ 产品写入（以及 `/L*v` 日志）都由**服务侧**完成，客户端被注入也无济于事。
  ⇒ **判定：这是"跨进程写者"类缺陷**（`msiserver` 由 SCM 启动，不在 `ws_proc.c` 的 `CreateProcessW/CreateProcessAsUserW` 注入链上）；
  它**与 R16-D3-1 不是同一类**，且**不能**靠"加 `NtCreateFile` 钩子"解决（钩子只在自己进程内生效）。
  *不确定项*：`/L*v` 日志究竟由客户端还是服务写，未定；R11（`msiserver` RUNNING→1622/1601）与 R16（STOPPED→`/a` 成功）的环境差异亦未定因。
* **与 R11 的关系**：R11 D3-2 记录的是同一族问题的另一面（`msiserver` RUNNING 时 1622/1601，"两边都没有产物"）。
  本轮形态**变了**：`msiserver` STOPPED、按需启动，`/a` 直接成功并真实落盘 ⇒ **"MSI 不会落真实盘"不成立**。R11 的判定需要更新。
* **影响**：MSI 是 Windows 上最主流的安装形态；一旦 `/a`（或环境合适的 `/i`）成功，隔离承诺被完全绕过，且沙箱内读数无法察觉。
* **补丁点（文件 + 位置 + 判据；未实施）**
  * **没有可拦的同步文件点**：真正写盘的进程里没有 shim DLL，用户态 IAT 钩子无法跨进程覆盖内核调用。
  * **立即可做的 policy（建议 P0 级，与 shim 无关）**：在 `dsh-plugin/shell-executor.mjs` 的 **TS 档命令闸门（spawn 之前的命令分类处）**
    把 `msiexec`/`msiexec.exe`（以及 `sc start msiserver` 这类服务代写工具）判为 **TS 档不可用**：fail-closed 并回专用错误码
    （建议 `WINSTAGE_SHELL_MSI_UNSUPPORTED`），同时把该判定写进 lane/审计。理由：现在的形态是"有时成功、有时 1622/1601/1603，
    成功时静默逃逸"，比明确拒绝更危险。
  * **若要真正支持 MSI（设计级，非单点补丁）**：① 让 `msiserver` 也被注入（SYSTEM/服务启动期注入，改动面与风险大）；
    ② 或改用文件系统 minifilter + 事后检测/隔离（脱离现有用户态 IAT 架构）；③ 或明确"TS 档不支持 MSI"并写进产品文档。
  * **验收判据**：TS 档下 `msiexec /a` **要么**被明确拒绝且带专用错误码，**要么**真实盘零新增；**不允许**"EXIT=0 且真实盘 +2,449 文件"。
* **已批准的实施方案（Lead 2026-10-11 批准，**等 go** 后落地；当前**未改一行**）**：
  * **精确 diff 级方案**：`.t\r16\exe\msi-gate-patch.md` —— 单文件 `dsh-plugin/shell-executor.mjs`，4 个插入点（常量 / 语义码登记 / 纯函数 / 闸门调用），
    每处给出当前行号 + 锚点文本 + **完整可直接粘贴的代码**；含触发矩阵（15 条必拦 / 9 条必放行）、不变量 I1–I5、验收 A1–A4、回滚步骤、残余风险。
  * **语义码**：`WINSTAGE_SHELL_MSI_UNSUPPORTED` 登记进 `SHELL_FAILURE_CLASSIFICATION`（`shell-executor.mjs:803`，**不是** `SEMANTIC_CODES`——那只是三类别名映射，不得加条目）；
    **category 建议 `POLICY`**（"该操作在当前模式下不被允许"，`src/executor.mjs:4188` 的定义；且 `CLEARTEXT_CREDENTIAL_IN_REQUEST` 已有先例）。
    **不要用 `ENVIRONMENT`**（会让 `retryable=true`，把"重试也不会成功"说成"可重试的环境故障"）；`COMMAND` 是次选（文案"命令失败"会被读成"跑了但失败"，而闸门是**未执行**）。
  * **平台档不受影响是结构保证**：`WINSTAGE_SHELL=0`（或开关关且未 `WINSTAGE_SHELL=1`）⇒ `dsh-plugin/cordis.patch.yml:157-166` 的 `winstage-shell` 行 `disabled: true`
    ⇒ 本模块根本不装载 ⇒ 闸门**不可达**；因此闸门**刻意不读** `process.env.WINSTAGE_SHELL`（避免把"行是否装载"这一真源复制成第二份）。
  * **文案透明性（重要，Lead 原始要求需据此微调）**：模型可见句子**不能**包含 `沙箱/暂存/替代路径/sandbox/staging/stage/overlay`——
    `transparencyViolations()`（`src/executor.mjs:4252-4274`）会做大小写不敏感**子串**机检。因此"MSI 由进程外 msiserver 写入真实盘、无法暂存 ⇒ 已 fail-closed"这段**机制措辞
    只进人工侧**（error 级日志 + `error.winstage.{technicalCode,matched,reason,doc,evidence}`），模型可见面用中性且可行动的一句话（含文档指针 `docs/round16/exe-缺陷.md` 的 R16-D3-2）。
    已实测：该中性句在 `transparencyViolations()` 下 **0 命中**，`code=DENIED_ACTION_NOT_PERMITTED`、`retryable=false`。
  * **离线判据脚本（已就绪、已跑）**：`.t\r16\exe\msi-gate-check.mjs` —— 不依赖真沙箱：24 条行为矩阵 + 静态断言（闸门位置在 `executeConfined` 内且在 `loadBaseClass()` 之前、
    语义码登记与类别、不读 `WINSTAGE_SHELL`、文案 0 违规）+ **纯度证明**（把纯函数标记区抽出来在 `node:vm` 空上下文里求值，证明零依赖）。
    当前（未落地）跑法 `node .t\r16\exe\msi-gate-check.mjs` → `GATE=absent`、**29/29 PASS、exit 0**；
    落地后用 `--mode=present --strict --import` 复跑。★ 该脚本在准备阶段已**抓到并修掉一个真实实现 bug**（`basename('/c')` 会把 `/c` 剥成 `c`，
    导致 `cmd /c msiexec …` 漏拦）——这正是它存在的意义。

---

## R16-D3-3（P1 重要）32 位（i386）映像被硬拒，且失败形态比 R11 更差、还会在真实盘留下 WER 崩溃遥测

* **现象**：TS 档下 i386 映像**启动即失败**，`pwsh` 抛 `ApplicationFailedException: Program '…' failed to run: Access is denied`，
  `$LASTEXITCODE` **为空**（连数字退出码都没有）；`platform` 对照下同一文件 EXIT=0。
* **原始证据**
  * `<overlay ws-1\ev\a2-7zr-i.txt>`：`Access is denied`（`7zr.exe`，PE machine `0x014C`）；同一文件在 run-2：`EXIT=0` + 完整 7-Zip 26.04 版本行（`ws-2\ev\p2-7zr-i.txt`，2,162 B）
  * `<overlay ws-1\ev\a3-wow64.txt>`：`%WINDIR%\SysWOW64\cmd.exe /c echo WOW`（i386）→ `Access is denied`；`SysWOW64Exists=True`
  * 同 run 64 位对照：`%WINDIR%\System32\cmd.exe /c echo SYS32CMD` → `C0_SYS32_EXIT=0`；`rg.exe`（x86_64）EXIT=0
  * 真实盘副作用：`C:\ProgramData\Microsoft\Windows\WER\ReportArchive` **8→17**（+9）：
    `AppCrash_7zr.exe_…` ×4（18:07:17 / 18:07:56 / 18:08:00 ×2）、`AppCrash_cmd.exe_…` ×5（18:07:33–18:08:10）
* **影响**：32 位工具链/安装器在沙箱内完全不可用，且**错误文本无 WinStage 归因码**；失败以进程崩溃收场，WER 服务（在沙箱外）把崩溃报告写进真实盘。
* **建议**：补 WOW64/32 位注入路径，或显式降级并给出可诊断错误码（如 `WINSTAGE_SHELL_IMAGE_BITNESS_UNSUPPORTED`）；
  并让拒绝**不发生崩溃**（否则残留真实盘 WER）。

---

## R16-D3-4（P1 重要）`readThrough` 枚举与 `Test-Path`/`Get-Item` 不一致，导致"装没装上"自相矛盾

* **现象**：`Test-Path <ws>\app2604` → **True**；`(Get-ChildItem <ws>\app2604 -Recurse).Count` → **0**；`cmd /c dir /b` → `File Not Found`（EXIT=1）。
* **原始证据**：overlay `ws-1\ev\b2-installer-post.txt`（`TestPath=True` / `ChildItemCount=0` / `DIR_EXIT=1` / `File Not Found`）；
  `ws-1\ev\b3-ws-enum.txt` 与 `e-ws-list.txt` 只列 `cand`、`seed.txt`；宿主侧盘点同一目录有 **107 个文件**（`host\staged-ws1-list.txt`）
* **与 R11**：R11 D3-3 同型，**复现**（golden 不含 R12 的 P0 枚举修复，属 R15 已知取舍）
* **影响**：安装后完整性校验（文件数/哈希/枚举）在沙箱内必然误判；run-4 的 MSI 更极端——overlay 空、真实盘有 2,449 文件，而线程内完全看不出来。
* **建议**：枚举合并 overlay 视图，或返回显式 `partial-overlay-view` 标记。

---

## R16-D3-5（P2 次要）候选 JSON 含非法控制字符，`ConvertFrom-Json` 解析失败

* **现象**：`candidates\cs_0002_8d1f0a9f.json`（registry-stage，4,252 B）解析失败：
  `Invalid object passed in, ':' or '}' expected. (4158)`；同一目录 `cs_0021_c5b367b2.json` 解析正常。
* **证据**：`.t\r16\exe\run-1\stage-root-25477159411235\candidates\cs_0002_8d1f0a9f.json`（含 `baselines` 内嵌 JSON 字符串与真实 hive 清单）
* **与 R11**：D3-5 **复现**（R11 也是 2 个失败 1 个成功）
* **影响**：审批/复核工具链无法稳定读取候选记录（尤其含 `baselines` 的注册表候选）。
* **建议**：候选写入前对嵌套字符串做严格 JSON 转义/编码校验。

---

## R16-D3-6（P2 次要）MSI 失败会遗留存活的 `msiexec` 进程

* **现象**：run-4 结束前抓到 `msiexec` pid 11836（`StartTime 2026-10-11 18:16:36`，`/V` 形态）；线程内 `Stop-Process -Force` 后宿主复核 `msiexec`=0。
* **证据**：overlay `ws-4\ev\m-msi.txt`（`msiexec_at_M5=1` / `msiexec_proc id=11836 start=…` / `msiexec_after_kill=0`）；宿主 `snap-after.txt` `PROCS|count=10`
* **与 R11**：D3-8 现象 2 **复现**
* **建议**：失败路径清理服务实例；测试口径把"残活服务进程"纳入残留清单。

---

## 观察项（非产品缺陷）

* **同机窗口内两个真实盘对象——已归因，非本域、非缺陷（未删除）**：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\`（新建空目录，18:10:52）与
  `C:\Users\Administrator\Desktop\DeepSeek Harness.lnk`（18:14:58，2,055 B，sha256 `F66FAF4B6FAC5CC2E1368406A09EE3C6F4DA5C2FD5B1725E430DFD4CE3CFA8FA`，隐藏）。
  归因证据：`.lnk` 目标（COM 读，未执行）= `C:\Users\Administrator\Downloads\dsh-silent-target\DeepSeek Harness.exe`，
  `WorkingDir=…\Downloads\dsh-silent-target`，`Description="Electron desktop shell for a bundled dsh runtime and external plugins"`，UTF-16 串含 `com.deepseek.dsh`；
  该目录是**已解压的 Electron 应用**（`DeepSeek Harness.exe` 244,481,512 B、`Uninstall DeepSeek Harness.exe`、`7zip-installer-*.txt`），
  时间线 `resources.pak` 18:14:57 → `.lnk` 18:14:58；同时 `Downloads\` 下有 **`dsh-matrix2.ps1`/`dsh-matrix3.ps1`（18:22–18:24）**
  驱动 `dsh-setup-probe.exe` 逐个路径跑 `"/S /D=$path"`（`dsh-matrix2.log` 里显式含 `%LOCALAPPDATA%\Programs\DeepSeek Harness` 的预检与 `Probe`），
  进程表有 `dsh-setup-probe`（pid 9912）；端口只有 `127.0.0.1:3080`（**3091/9223 未监听**）。
  ⇒ 判定为**另一条并行的"DSH 静默安装器矩阵"实测流**（platform 真实盘安装），与本域两条逃逸无关；**按 Lead 指示未删除**。
* **WER 遥测（R16-D3-3 的副作用）已按 R15 口径处置**：9 条目录路径 + 各 `Report.wer` sha256 留档于
  `.t\r16\exe\host\wer-removed-manifest.txt`，随后删除，逐条 `AUDIT exists=False`；WER 条目 17→8（回基线）。
* **`manifest.json.sessionId = "dsh-host"`**（run-1）：R10 D1 的"按会话隔离的审批面在嵌套线程里退化"仍在。
* **`registry\overlay.journal` 含 `<unstaged:RegCreateKeyExW:unresolvable-base-handle>` / `<unstaged:RegSetValueExW:…>` 记录**
  （run-1，2,508 B）：说明有注册表操作走了"无法解析基句柄"的 unstaged 分支；真实 hive 最终未被改（`HKLM\…\wst-r16d3` = False，候选 `pending`），
  但该分支的存在值得单独查（是否所有 unstaged 都 fail-closed 未验证）。
* **stage-root 命名碰撞**：run-3 与 run-4 并发时 `%RANDOM%` 生成同名 `stage-root-273642102114806`（因 outDir 不同而未冲突）。
  当前脚本用 `%RANDOM%%RANDOM%%RANDOM%` 且并行由同一秒启动 ⇒ 存在同 outDir 下撞名的理论风险（本轮**未**复现故障）。
