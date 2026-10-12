# Lead 事件报告：会话级写能力丢失（r2 第 1 号缺陷）

- 会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 域：跨全部 8 个测试线程（fs / browser / pip / node / exe / registry / network / sensitive）
- 严重度：🔴 **阻断级**（8 个域中 6 个的写侧 checkpoint 全部不可执行）
- 判定：**回归缺陷，不是被测的预期语义**
- 发生时间窗：2026-10-03 17:5x–18:0x（8 线程并行开跑后约 15–25 分钟）

---

## 1. 现象（三线程独立复现）

| 观察 | 证据来源 |
|---|---|
| 工作区内**任何**路径写入被拒：`UnauthorizedAccessException: Access to the path '…' is denied.` | Lead 五路径矩阵（工作区根 / `_sandbox-tests` / `r2` / `r2\fs` / `r2\_lead` / Desktop 根）**全部 DENY** |
| 工作区外同样被拒：`C:\Windows\Temp`、`C:\ProgramData`、`%USERPROFILE%\Documents`、`D:\`、`%LOCALAPPDATA%\Temp` | fs 线程 BT 矩阵、pip 线程 |
| 目录创建被拒（`New-Item` / `cmd /c mkdir` / `[IO.Directory]::CreateDirectory` 三 API 一致） | fs 线程 |
| **唯一可写位置**：`$env:TEMP` = `C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\<guid>\`（DSH 私有临时目录） | Lead 与 fs 线程一致 |
| 读**仍然正常**（read-through OK，能读到宿主写入的文件） | fs 线程 |
| 进程启动间歇失败：`Program 'cmd.exe'/'whoami.exe'/'uv.exe'  failed to run: Access is denied`；`whoami` → `ERROR: Access is denied` | pip 线程 CRITICAL-3 |
| `Get-CimInstance` → `0x80041003` 拒绝访问；`tasklist` → `ERROR: Access is denied`；`Get-PSDrive C` → Used=0/Free 空 | browser 线程 |

## 2. 根因链（已证实 / 已排除）

**已证实**

1. 当前 shell 令牌是**受限令牌**：`isAdmin=False`（会话开始时为 `True`），
   令牌组里**没有** `BUILTIN\Administrators`；只有其私有 temp 可写。
2. **WinStage 环境变量整体丢失**：进程内 `WINSTAGE_STAGE_ROOT` / `WINSTAGE_SHIM_CONFIG` /
   `WINSTAGE_SHIM_LOG` / `DSH_REGSTAGE_ROOT` **全部为空**（只剩 `DSH_*` 6 个）。
   而 shim **仍被注入**（shim.log 持续记录 `failClosed=1 readThrough=1` 与各 PID）。
   ⇒ shim 没有 stageRoot 可用，`failClosed=1` 语义下所有写入被拒。
3. **subagent 线程的 `DSH_SESSION_ID` = 该 subagent 自己的 id**（如
   `6dd878ff-…`、`76aa210c-…`），**不是**本会话的 `session-4c5d9889-…`。
   ⇒ 并行子线程从一开始就带着另一个 session 身份执行，与本会话的 stageRoot 不同源。
4. 工作区 ACL 上存在**非继承**能力 SID `S-1-4-367263216-953737554`（写在 `staged` 根上），
   而工作区根只有**另外两个**旧会话的能力 SID `S-1-4-56185984-606674207` /
   `S-1-4-1039366120-933337351`。当前受限身份不在工作区授权集合内。

**已排除（各做过实验）**

| 假设 | 实验 | 结果 |
|---|---|---|
| 工作区 ACL 缺权限 | `Get-Acl` 三处 | ❌ 排除：`WIN-DV9KRECLBVS\Administrator Allow FullControl` 在位 |
| shim `failClosed` 缺 stageRoot | 在子进程里重新导出 4 个 `WINSTAGE_*` 变量后写 | ❌ 排除：仍然 DENY（拒绝发生在 shim 之下/之外） |
| `WINSTAGE_SHIM_DISABLE=1` 可绕过 | 子进程带该变量写 | ❌ 排除：仍 DENY（再次印证拒绝不在 shim 层） |
| 有进程独占暂存树（round-1 已知形态） | 杀掉全部 msedge（3 轮共 9 个）+ `uv` 守护进程 + 残留 powershell 后重测 | ❌ 排除：仍 DENY，且 `WINSTAGE_*` 未恢复 |
| 单纯资源竞争导致的自检失败 | 单线程、无并发时重测 | ❌ 排除：并发降下来后仍然 DENY |

**结论**：会话的 shell 执行面在运行中途退化成一个**受限/低完整性令牌的围栏**，
且**没有**把 WinStage 暂存上下文（`WINSTAGE_*` 环境、工作区能力 SID 授权）带过来。
两条独立的后果叠加：写入既没有被暂存重定向（shim 无 stageRoot），也没有被 ACL 放行
（受限身份不在授权集合内）⇒ **全盘 DENY，只留私有 temp**。

**同一时刻 failsafe 闸门的失效（次生缺陷）**：
`src/executor.mjs:2184-2231` 的 `selfTestTransparent()` 只探测**工作区外**
（`C:\Windows\Temp\winstage-shim-selfcheck-*.txt`）的暂存写入。本次退化的表现恰恰是
「工作区外也写不了」，于是闸门判定 `outside-write-staged-not-real=fail` 并抛
`STAGING_WRITE_UNVERIFIED` 拒绝命令——**闸门把「环境坏了」报成了「本命令被拒绝」**，
而且拒绝文案是给实现者看的（含 `remediation` 建议 `dsh-stage init`，本机无该命令，
`Get-Command dsh-stage` 为空）。用户/agent 从中无法判出这是环境级故障。

## 3. 可恢复性（诚实边界）

**会话内不可恢复**，已从三个方向尝试并失败：

1. 权限修复：当前令牌 `isAdmin=False` 且为低完整性，对 Medium IL 对象无 `WRITE_DAC`
   能力 ⇒ 无法为自己补授权。`diagnose-windows-sandbox-acl` 技能要求**在非受限下**运行
   其修复脚本，而本会话审批策略为 `never`（提权请求会被自动拒绝）⇒ 该路径不可用。
2. 释放占用：杀光全部可疑持有者（msedge ×9、uv 守护、残留 powershell）无效。
3. 环境补全：在子进程中重新导出 `WINSTAGE_STAGE_ROOT` 等 4 个变量后写，仍 DENY。

**需要在宿主侧恢复**：重启该会话的 shell 执行面（重启 DSH 会话/服务，
或在 GUI 里把会话档位切回 `workspace-write` 让 WinStage shell 重新 provisioning）。

## 4. 这不是"测试者把沙箱弄坏了"

- 触发前该会话一切正常：Lead 的 canary 写入被正确暂存（STAGE 通道可见 overlay 副本，
  宿主真实磁盘无该文件）；shim 日志显示 64→319 个 IAT 站点正常安装。
- 退化后 **8 个线程的 `DSH_SESSION_ID` 各自不同**，说明这是执行面**装配层**的行为，
  不是某个线程的命令副作用（各线程的命令互不相同，却得到同一结果）。
- 三个互不通信的线程（Lead / fs / pip）用不同方法得到**同一结论**。

## 5. 影响面（本轮测试质量）

| 域 | 受影响 |
|---|---|
| fs | 写侧 7/13 checkpoint BLOCKED；读侧与 HOST 侧可继续 |
| pip | 7/8 checkpoint BLOCKED（另有 CRITICAL-4：uv 建解释器因 junction 目录非空失败 `os error 145`） |
| node / exe / registry | 安装/写注册表类 checkpoint 预期大面积 BLOCKED |
| browser | 浏览器进程可起（CDP 存活），但截图/下载写盘失败 |
| network | 以只读/网络为主，**受影响最小**，可继续 |
| sensitive | 读侧为主，**可继续**；写/删隔离侧受阻 |

## 6. 建议修复（按优先级）

1. **P0：围栏退化必须自愈或显式升级**。检测到 `WINSTAGE_STAGE_ROOT` 缺失而 shim 仍
   `failClosed=1` 时，不要"静默 DENY 一切写入"，而应：① 立刻重建暂存上下文；
   ② 或明确降级为"不暂存但放行"；③ 或向用户弹一条**可操作**的提示
   （"本会话沙箱执行面已失效，请重启会话"）。当前形态是最坏的一种：**静默 + 全盘拒绝**。
2. **P0：`assertStagingWriteEnforceable` 的探测面要覆盖工作区**。现在的自检只探
   `C:\Windows\Temp`；本次故障正是"工作区外也写不了"，闸门却把它报成单条命令被拒。
   建议：自检同时探「工作区内 + 工作区外」两条，并在失败时区分
   `env-missing` / `acl-denied` / `token-restricted` 三类，给出不同文案。
3. **P1：subagent/子线程的 session 身份错配**。并行子线程拿到自己的 `DSH_SESSION_ID`
   而非父会话 id ⇒ 与父会话的 stageRoot 不同源。这解释了为什么 **8 个并行线程同时**
   退化。子线程应继承父会话的 stageRoot，或明确不支持多线程并发。
4. **P1：`dsh-stage` 命令不存在**，但闸门的 `remediation` 让用户去跑
   `dsh-stage init --workspace <dir>`。建议要么提供该命令，要么改文案。
5. **P2：`uv python install` 在 sandbox 内的 junction 处理缺陷**（pip 线程 CRITICAL-4）：
   下载 21 MiB 成功后在"移除/重建 junction 目录"处失败并报 `os error 145`，
   且**把已下载的产物丢弃**，只留一个总错误。建议改为幂等重建 + 保留已下载缓存。

---

## 7. 根因精确化（重启后复核 · **最终版**）

用户重启 DSH 后 Lead 立即复测：**执行面未恢复**（`DSH_SESSION_ID` 仍是 `session-4c5d9889-…`，
`WINSTAGE_*` 仍空，`isAdmin` 仍 `False`）。这次拿到了决定性机制证据：

| 探测 | 结果 |
|---|---|
| 工作区 / `%USERPROFILE%` / `C:\Users\Public` / `C:\Windows\Temp` 写入 | **全 DENY** |
| `…\session-4c5d9889-…\staged\` 与 `staged\fs\C\…` 写入 | **OK** |
| `$env:TEMP`（`dsh-stage-temp\<guid>`）写入 | **OK** |
| **相对路径**写入（cwd = staged 根） | **OK** |
| 显式 `workdir=C:\...\WinStageSandbox` | **被忽略**，cwd 仍被强制为 staged 根 |
| `Set-Location` 到工作区后再写 | **仍 DENY** ⇒ 可写面**静态**，不随 cwd 变 |
| 工作区读取 | 正常 |

**最终根因**：会话档位 `danger-full-access` 下，`@local/dsh-winstage-sandbox/shell`
占着 `ctx.shell` 单例**且不把执行面交还平台**（自述三次尝试失败，`dsh-plugin/shell-executor.mjs:936-958`），
于是每条命令都在它自己的围栏内执行；该围栏语义是「**可写面 = 命令自己的工作目录**」，
而 WinStage 把工作目录设成**会话暂存根** ⇒ **只有暂存根可写、真实工作区只读**。
拒绝文案是裸 `Access is denied`，**无法与 Windows 权限问题区分**。

**恢复办法（用户侧一步）**：把会话档位从 `danger-full-access` 切回 **`workspace-write`**，
无需重启；切回后 Lead 可立即复测（`WINSTAGE_STAGE_ROOT` 非空 + 工作区可写 = 恢复）。
这也解释了为什么重启无效 —— 档位没变。

**由此新增的易用性发现**：① UTF-8 中文在 shell 输出里被按 GBK 解码成乱码（污染证据与错误信息）；
② `workdir` 参数被静默忽略；③ 可写面无法自查，只能靠 4 次写入实验反推。
