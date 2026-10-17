# R11 · D3 exe 缺陷清单（WinStage 沙箱 · 安装完整性与隔离）

> 执行者：teammate `t3-exe` · 全部条目均有原始证据；详细上下文见 `docs/archive/round111/exe-报告.md`
> 本轮共 3 次嵌套 run：`d3-run1`（winstage）/ `d3-run2`（platform 对照）/ `d3-run3`（winstage MSI 复测）；档位 `tierEffective=TS / launchMode=shim / degraded=false / LANE_OK=true`

## D3-1（高）WinStage TS 通道下 32 位（i386）可执行文件被 `ERROR_ACCESS_DENIED` 硬拒

- **现象**：沙箱内 `7zr.exe i` → 退出码 **1**，输出仅 19 字节 `Access is denied.`；同目录、同 ACL、同账户下 `7z-choco-x64.exe`（AMD64）退出码 **0**。
- **原始证据**
  - `.t\r11\exe\run1\out\stage-root\staged\fs\C\...\run1\ws\ev\b1-7zr-i.txt`（19 B，`Access is denied.`）
  - 同目录 A/B：`7zr.exe machine=0x014C` 拒 / `7z-choco-x64.exe machine=0x8664` 成功；`C:\Windows\SysWOW64\cmd.exe`(0x014C) 拒 / `System32\cmd.exe`(0x8664) 正常
  - 宿主侧独立 PE 解析：`.t\r11\exe\evidence-provenance.md` §4
  - **platform 对照**（`WINSTAGE_SHELL=0`）：同一 `7zr.exe i` → 退出码 **0**，输出 `7-Zip (r) 26.04 (x86) : Igor Pavlov : Public domain : 2026-10-05`（`.t\r11\exe\run2\ws\ev\p1-7zr-i.txt`，1,072 B，真实盘）
- **影响**：32 位工具链/安装器（含 7-Zip 官网 `7zr.exe`、`7z1900-x64.exe`）在沙箱内完全不可用；错误文本不携带 WinStage 归因码，用户无法判断是"沙箱拦截"还是"文件损坏"。
- **建议**：给 WOW64/32 位映像路径补 shim 注入（或显式降级到 T1 受限令牌档并提示），并把该失败映射到可诊断的错误码（如 `WINSTAGE_SHELL_IMAGE_BITNESS_UNSUPPORTED`），而不是裸 `ERROR_ACCESS_DENIED`。

## D3-2（中）MSI 服务通道在沙箱内整体不可用（`1622` / 去掉日志参数后 `1601`）

- **现象**：`msiexec /a|/i … /L*v <path>.log` → 退出码 **1622**（`ERROR_INSTALL_LOG_FAILURE`）且日志未生成（run1 的日志指向 overlay-only 的 `<ws>\ev\`）；**把日志改到真实目录 `C:\Windows\Temp\` 后仍然 1622**；**去掉 `/L*v`** 后同一条 `/i` 变 **1601**（`ERROR_INSTALL_SERVICE_FAILURE`）。
- **原始证据**：run1 C4/C5；run3 全量 `.t\r11\exe\run3\FINAL-run3.md` —— 含 `sc query msiserver` = `STATE: 4 RUNNING`、`Get-WinEvent ProviderName=MsiInstaller` 最新事件仍为 **2026/9/28**（本次**无任何** MsiInstaller 事务事件）、overlay `fs\C` 下**无 ProgramData**、`registry\overlay.journal` **0 字节**、`shim.log` 中 `msiexec` **0 命中**。
- **修正**：不能归因给"日志目录在 overlay"（那是 run1 的表象）；指向 **客户端 ↔ msiserver 服务通道**整体不可用（服务进程未注入 shim，看不到 overlay，事务/RPC 也无法建立）。精确机制未定（见报告 §9）。
- **影响**：任何 MSI 安装（含行政安装）在沙箱内都以**不可诊断的数字码**失败；用户无法区分"被隔离"与"服务通道断裂"。
- **建议**：为 MSI 场景显式映射错误码并给出可读原因（例如 `WINSTAGE_SHELL_MSI_SERVICE_UNAVAILABLE`），或在文档中明确"MSI 不支持"。

## D3-3（中）`readThrough` 枚举与读取不一致，导致"是否安装成功"自相矛盾

- **现象**：`Test-Path <ws>\app2604` → **True**，`Get-Item` → Directory，但 `Get-ChildItem -Recurse` → `DirectoryNotFoundException: Could not find a part of the path`，`cmd /c dir` → `File Not Found`（EXIT=1）。`<ws>` 的枚举永远只反映真实盘。
- **原始证据**：run1 最终答复 §C.补充 / §F；`c3b-dir-app2604.txt`（184 B）。
- **影响**：任何"安装后完整性校验（文件数/哈希/枚举）"在沙箱内必然误判；也是 D3-2 的根因族。
- **建议**：枚举也应合并 overlay 视图（或至少返回明确的"partial overlay view"标记）。

## D3-4（中）`winget` / `choco` 在沙箱内不可用且**零可读错误**

- **现象**：`winget --version` 与 `winget install` 均 `-1978335231`（`0x8A150001`）**0 字节输出**；`choco --version` 与 `choco install` 均 `-532462766`（`0xE0434352`），输出 `由于 Exception.ToString() 失败，因此无法打印异常字符串。`
- **原始证据**：`<ws>\ev\c6a-winget-version.txt`(0 B)、`c6-winget.txt`(0 B)、`c7a-choco-version.txt`/`c7-choco.txt`(各 79 B)。
- **补充事实**：`winget.exe` 是 `WindowsApps` 下 **0 字节 alias stub**；`choco.exe` 147,040 B。
- **影响**：包管理器安装路径在沙箱内既失败又不可诊断。

## D3-5（低）候选记录 JSON 含非法控制字符，解析失败

- **现象**：`candidates\cs_0002_e74693f8.json`、`cs_0003_0b83942a.json` 用 `ConvertFrom-Json` 失败（`Invalid object passed in, ':' or '}' expected`）；同目录 `cs_0037_35105170.json` 正常。
- **证据**：run1 F 段原文。
- **影响**：审批/复核工具链读取候选记录不稳定（含 baseline 字符串转义问题）。

## D3-6（低，非产品缺陷）厂商站 `7zr.exe` 未钉版本且无公开摘要

- **现象**：`https://www.7-zip.org/a/7zr.exe` 直连 HTTP 200（602,624 B），但 `.sha256` 返回 **404**；同一 URL 同一 size 而 sha256 与 R10 记录不同（R10 `ad4c82fa…` / 本轮 `256feca8…`），自报版本 `26.04`。
- **影响**：按 URL 的完整性验证不可复现；本域"发行包完整性"只能对带公开清单的候选（node MSI/zip、choco VERIFICATION 覆盖的两个 7-Zip 安装器）做强断言。

## D3-7（中，与 D3-3 同源）装入 overlay 的产物无法按逻辑路径做安装后完整性校验

- **现象**：`7z2604-x64.exe /S /D=<ws>\app2604` 退出码 0、overlay 内 107 个文件，但真实盘 `ws` 仍只有 `cand\` + `seed.txt`，且 `<ws>\app2604` 无法枚举（即 D3-3 现象）。
- **影响**：直接冲击本测试域目标"安装后完整性"——沙箱内无法自证，必须靠宿主侧对 `stage-root` 盘点。本轮已按此方式取证（`.t\r11\exe\run1\stage-root-inventory-host.txt`，506 行）。

## D3-8（中高）"零残留"不成立：被拒进程崩溃留下真实盘 WER 报告；MSI 失败遗留存活 `msiexec /V`

- **现象 1（真实盘写副作用）**：宿主侧定向扫描发现 `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\` 下 **20 个崩溃报告目录**，时间戳 23:59:32–00:08:36，全部落在 `d3-run1`（23:57:53 起）与 `d3-run3`（00:07:23 起）窗口内，对象正是我的候选/探测二进制：
  `AppCrash_7zr.exe_…`×9、`AppCrash_7z1900-x64.exe_…`×3、`AppCrash_7zr_copy.exe_…`×1、`AppCrash_choco.exe_…`×4、`AppCrash_cmd.exe_…`×3。
- **现象 2（遗留进程）**：终态快照抓到 `msiexec` pid **5596**，命令行 `C:\WINDOWS\system32\msiexec.exe /V`，起始 00:08:46；run3（00:07:23–00:10）结束后仍存活。我已 `Stop-Process -Force`，复核 `Get-Process msiexec` = 0。
- **计数**：`C:\ProgramData` 3,141→**3,154** 文件 / 1,130→**1,131** 目录；同一次差分中 `Program Files`(20,513)、`Program Files (x86)`(4,077)、`Uninstall`(45/18/0)、`Run`、开始菜单(80/19) **全部 delta=0**。
- **影响**：隔离面存在**真实副作用**——安装产物/注册表/快捷方式确实零残留，但**崩溃遥测文件**与**残活服务进程**会落真实盘/真实进程表。用 `Test-Path` 或线程内 `tasklist` 得出的"零残留"结论**不可靠**；必须以宿主侧 before/after 差分 + 定向 `LastWriteTime` 扫描为准。
- **建议**：① 32 位拒绝不应表现为进程崩溃（对应 D3-1）；② MSI 失败应清理其服务实例；③ 产品文档/测试口径把"WER 遥测 + 残活服务进程"纳入残留清单。

## 环境/工具类观察（非产品缺陷，供 Lead 参考）

- 上一轮 R10 的 `Test-Path` 式"零残留"复核**强度不足**：本轮证明 overlay 会让 `Test-Path` 返回 True 而真实盘无文件；`stage-root-inventory` 才是判据。
- `docs/archive/round110/env/scripts/sbx-extract.mjs` 在 `stage-root-path.txt` 缺失时会给出 `LANE_OK=false` 与全 0 清单（probe3 即如此）：属提取器对缺文件的软失败，易被误读为"沙箱没生效"。本轮 run1 的 `stage-root-path.txt` 存在 ⇒ `lane.txt` 为 `LANE_OK=true`，两处可对照。

> **R11 Lead 更正（2026-10-11）**：probe3 的缺失是 Lead 早期探针的**设施时序问题**，事后已补 `stage-root-path.txt`（82 B）并重抽，
> 现在 `probe3/out/lane.txt` = **`LANE_OK=true`**；且复核者 `v-verify` 独立复算 22 个 raw lane 全部 `TS / degraded=false / degradeCount=0`。
> 本域 run1 的对照读数不受影响。
