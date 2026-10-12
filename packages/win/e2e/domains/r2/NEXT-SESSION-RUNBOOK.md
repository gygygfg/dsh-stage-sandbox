# 新会话交接手册：补跑被环境阻断的写侧域（r2b）

> **给新会话里的 agent**：本文件是**可执行**的操作手册。先做 §1 前置自检；
> **自检不通过就停下来报告，不要开测试线程**（本会话就是因为没做这一步，8 个线程的写侧结果全废）。
> 背景与完整证据见同目录 [`FINAL-REPORT.md`](FINAL-REPORT.md) 与
> [`_lead/LEAD-INCIDENT-REPORT.md`](_lead/LEAD-INCIDENT-REPORT.md)。

---

## 1. 前置自检（**必做，失败即停**）

> **r2b 修正（2026-10-04，实测）**：原判据用 `"$PWD\__pf.txt"` 判「工作区内可写」。
> 但本车道下 **`$PWD` = 本会话暂存树** `<workspaceRoot>\.dshstage\sessions\<sid>\staged`，
> **不是工作区根** ⇒ 该判据**恒为假阳性**，会把坏车道误判成好车道（r2b 已复现）。
> 现改为**工作区根绝对路径**，并新增第 5 项「真值校验」。

```powershell
$ws = 'C:\Users\Administrator\Desktop\WinStageSandbox'   # 工作区根：必须用绝对路径，不要用 $PWD
"stage_root=[$env:WINSTAGE_STAGE_ROOT]"
"cwd=[$PWD]"                                             # ≠ $ws 时，历史版 INSIDE 判据会假阳性
"isAdmin=" + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
try { Set-Content -LiteralPath "$ws\__pf.txt" -Value ok -ErrorAction Stop; "INSIDE_WRITE_OK"; Remove-Item "$ws\__pf.txt" -Force } catch { "INSIDE_WRITE_FAIL" }
try { Set-Content -LiteralPath 'C:\Windows\Temp\__pf.txt' -Value ok -ErrorAction Stop; "OUTSIDE_WRITE_OK" } catch { "OUTSIDE_WRITE_FAIL" }
& cmd.exe /c 'echo SPAWN-OK'
```

**通过线（4 项 + 1 项真值校验，全过才算通过）**：

1. `stage_root` 非空；
2. `INSIDE_WRITE_OK`（**必须**来自工作区根**绝对路径**那一条，不能来自 `$PWD`）；
3. `OUTSIDE_WRITE_OK`；
4. spawn 有输出；
5. **真值校验（新增，必做）**：紧接着用**宿主 `read` 工具**读 `C:\Windows\Temp\__pf.txt`（上面故意没删）：
   - **读不到** ⇒ ✅ 工作区外写入被正确**暂存/重定向**，WinStage 健康形态；
   - **读到** ⇒ ⚠ 写入落到了**真磁盘**（围栏未生效）：据实记录这一事实，不要当成"通过"；
   校验完再清理该文件。
   理由：仅凭命令内回读**无法区分**「真写进去」与「被 shim 重定向进暂存」——两者都报 OK。

任一不满足 ⇒ 写一段简短报告（含上面原始输出）后停止，不要启动测试线程。
若 `stage_root` 为空，**先查** profile `cordis.patch.yml` 里 `winstage-sandbox.config.enabled`
是否被关成 `false`（r2b 实测根因；此时 `winstage-shell` 仍占 `ctx.shell`，命令照样被围栏 ⇒ 全盘 DENY）。

---

## 2. 必须知道的环境事实与陷阱（本会话实测）

| 事实 | 含义 / 对策 |
|---|---|
| **`WINSTAGE_*` 非空是硬前提** | 为空时 shim 无 stageRoot → `failClosed` 拒绝一切写入**与子进程创建**。此时 `isAdmin=False`、唯一可写是 `$env:TEMP`（`dsh-stage-temp\<guid>`）；**ACL 放权、重启、换档位都无效**（已逐一证伪） |
| `isAdmin` 本轮为 `False`（会话开始时为 `True`） | 非提权令牌下：Schannel 全挂、ICMP 拒、`netsh wfp` 取证失败、`requireAdministrator` 安装器静默挂死 |
| **HTTPS 分裂** | `curl.exe`（exit 35）/`Invoke-WebRequest`/`HttpClient`/`SslStream` → `SEC_E_NO_CREDENTIALS`；**`node.exe` 的 fetch（OpenSSL）是唯一可用 HTTPS 通道**；纯 HTTP 正常。下载请用 node |
| `pwsh`（PowerShell 7）**未安装** | 只有 `powershell.exe` 5.1；写 .ps1 用 `powershell -NoProfile -ExecutionPolicy Bypass -File` |
| PowerShell 管道接原生命令会 `Access is denied` | 必须让子进程**自己重定向到文件**再读；孙进程用管道 stdio 时 `spawnSync` 会**静默返回空** |
| `cmd` 写不进时**仍返回 exit 0** | 不要用退出码判断写入成功，必须回读 |
| **UTF-8 中文在 shell 输出里被按 GBK 解码成乱码** | 证据/日志写入用宿主 `write` 工具，或显式指定 UTF-8 |
| `Get-CimInstance` / `tasklist` 可能被拒（`0x80041003`） | 用 `Get-Process` 代替 |
| **宿主 `write`/`read` 工具是唯一可靠的"真值 + 落盘"通道** | `read`/`glob`/`grep` 工具读的是**真实磁盘**；`write` 工具直写真实磁盘（**这也是一个逃逸面，见 FINAL-REPORT §1.2**）。产出用它写 |
| `review.json` `totalFiles≫listed`（本轮 2883 vs 40，98.6% 截断） | 不要用 `review.json` 判断"某个改动在不在候选里"，直接看 `candidates\*.json` 与 `manifest.json` |
| `workdir` 参数被静默忽略、`Set-Location` 不改变可写面 | 不要依赖它 |

---

## 3. 并发纪律（**吸取本轮教训**）

- **最多 3 个线程并行**（本轮 8 个，约 15–25 分钟后执行面退化，整轮写侧报废）。
- 每线程命令数控制在 40–60；单条命令必须加 `timeoutMs`。
- **任何线程一旦遇到写入失败 / `WINSTAGE_STAGE_ROOT` 为空 / 子进程启动被拒**：
  **立即停止该线程并上报**，不要"重试后继续"。
- 每 20 条命令复查一次 §1 的 4 项自检。

---

## 4. 复跑清单（本次目标：写侧被阻断项）

| 域 | 要补的 checkpoint | 目标 | 关键命令要点 |
|---|---|---|---|
| **fs** | FS-01/02/04/06/07/08/09/10 | 工作区+工作区外（含 D:）写入回读 SHA256；文件操作语义；新目录作 CWD；junction/hardlink 写穿；长路径/Unicode/ADS；≥64MB 大文件 | 每条写后 `Get-FileHash` 对比；**junction 目标必须在真实磁盘上真实存在**（本轮 `mklink /J` 静默失败，需先确认链接真的建成） |
| **pip** | PIP-03/04/06/07 | 全局 `%APPDATA%\pip\pip.ini` 写清华镜像并验证生效；`pip install` 小包；wheel sha256 与镜像元数据逐字节对比；`pip check`/`list`/`uninstall` | 镜像：`https://pypi.tuna.tsinghua.edu.cn/simple`；本机唯一可用解释器是 `%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none\python.exe`（3.12.14 + pip 26.2.1，**勿删**）；`uv python install` 在沙箱内会因 junction 而失败（`os error 145`），**不要重试装新解释器** |
| **node** | pnpm realpath 复验 | 正常态下 `pnpm add` 后 `require()` 是否可用（本轮 shim 未 hook `fs.realpath` ⇒ 静默 `MODULE_NOT_FOUND`） | 同时复验 npm 装进**用户项目目录**（本轮 `--cache=<可写>` 才通） |
| **exe** | EXE-01/03 | 下载 7z 安装器 + Authenticode/SHA256 + 静默安装 + 隔离判定 | **需提权**；`https://www.7-zip.org/a/7z2408-x64.exe`（1624144 B，SHA256 `67CB9D34…B099B`，NotSigned）；含 `requireAdministrator` 时非提权会**静默挂死** |
| **registry** | REG-01/03/04/05/06 | HKCU/HKLM 写读、6 种值类型、`reg copy/export/import`、WOW64 `/reg:32\|64`、Run 键风险分级 | **HOST 真值通道** = 带 `WINSTAGE_SHIM_DISABLE=1` 的子进程跑 `reg query`；真实 HKCU hive = `C:\Users\Administrator\NTUSER.DAT` 的 mtime/SHA |
| **browser** | BR-05 / BR-11 | 点击是否生效（本轮 `visibilityState` 恒 `hidden`）、收尾清理 | 复用 [`FIX-BROWSER-USE.md`](../FIX-BROWSER-USE.md)；若 daemon 端点写不进，可像本轮一样用自建 CDP 客户端直连 9222 |
| **network / sensitive** | 提权态复核 | HTTPS(Schannel)/ICMP/WFP 三项在 `isAdmin=True` 下**会翻转**，必须复核 | 本轮结论只在非提权态成立，已在 FINAL-REPORT §2 标注 |

---

## 5. 通道与产出契约

沿用 [`PROTOCOL.md`](PROTOCOL.md)：状态码 `OK/FAIL/BLOCKED/N-A/FINDING`；每条 checkpoint 必须标通道
`PS`/`CMD`/`STAGE`/`HOST`；写后回读 SHA256；每条写一句易用性。

- 产出目录：`_sandbox-tests\r2b\<域>\{results.json, findings.md, executions.log, evidence\}`（**新目录，不要覆盖 r2**）。
- 汇总：`_sandbox-tests\r2b\FINAL-REPORT-r2b.md`，最后把写侧结论**合并回** `_sandbox-tests\r2\FINAL-REPORT.md`（补一节 §10）。
- 交付物一律用**宿主 `write` 工具**写（真实磁盘、可被 `read` 复核）。

---

## 6. 可直接复制的线程 prompt 模板

```
你是 WinStage 沙箱实测（r2b 补跑）的独立线程，域=<AREA>。
第一步：read 三份文件并严格遵守：
  C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\NEXT-SESSION-RUNBOOK.md
  C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\PROTOCOL.md
  C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\FINAL-REPORT.md（重点 §1.2 逃逸面、§8 复跑清单、§9 故障链）
产出目录（只写这里）：_sandbox-tests\r2b\<AREA>\；用宿主 write 工具落盘。
纪律：先跑 RUNBOOK §1 自检；不通过立即停止并报告。命令 40–60 条，单条加 timeoutMs。
遇到写入失败 / stage_root 为空 / 子进程启动被拒 ⇒ 立即停止并上报，不要继续。
完成后按 PROTOCOL §7 返回 ≤500 字摘要。
你的 checkpoint 清单：<把 §4 里对应行粘过来>
```

---

## 7. 如果新会话**仍然**复现同一故障

那就不是会话态污染，而是**车道确定性损坏**，需要代码修复（正确性优先，先写测试再改）：

- `dsh-plugin/shell-executor.mjs:936-958` —— 档位不匹配时不交还平台、只缩围栏的执行策略；
  以及 shell 执行面的 cwd/身份装配。
- `src/executor.mjs:2184-2231` —— `selfTestTransparent()` 只探**工作区外**写入；
  应在"暂存不可写"时**显式降级并告警**，而不是静默 `failClosed` 全拒；并按
  `env-missing` / `acl-denied` / `token-restricted` 分类给文案。
- 暂存根的授权应在**每次运行开始时**授予**当次能力 SID**（本轮实测：每次工具调用分配
  一个新的 `S-1-4-*` SID，而暂存根只授权了三个**历史** SID）。

改完必须：重新装配插件 → 跑 §1 自检 → 跑 `tests/*.mjs` 里与 shell/暂存相关的套件 → 再复跑 §4。
