# WinStage 沙箱实测协议 v2（第二轮，8 线程并行）

本文件是第二轮所有测试线程的唯一共同契约。**先完整读一遍，再动手。**
第一轮（会话 `session-eb7c901d-…`）的结论见 `_sandbox-tests\FINAL-REPORT.md`，可作为对照与线索，
但**不要**把它当成本轮的结论——本轮要独立复验，且环境已变化（见 §2）。

---

## 1. 本轮任务

对 DSH WinStage 沙箱做端到端并行实测（8 域）：**文件读写 · 浏览器 · pip · node/npm · exe 安装 ·
注册表 · 网络 · 个人敏感文件保护**，并额外贯穿一条主线：**测试操作设计的易用性**
（一件事要几步、坑在哪、报错是否可理解、文档是否缺失、是否容易误判）。

## 2. 被测对象与环境事实

- 被测对象：`C:\Users\Administrator\Desktop\WinStageSandbox`
  —— WinStage「暂存 → 候选 → 人工批准 → 选择性提交」沙箱，Windows + DSH 插件层。
- 本会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- **DSH 文件策略：`danger-full-access`**（DSH 自身不再限制文件操作）；
  **审批策略：`never`**（不会有审批弹窗，被拒即自动拒绝）。这与第一轮的
  `workspace-write` + `ask` **不同**，是本轮要重点观察的变量。
- WinStage shim **仍然生效**：向受控子进程注入 `winstage-shim.dll`，写操作重定向到 staged，
  读走 read-through。shim 配置（只读参考 `$env:WINSTAGE_SHIM_CONFIG`）：
  `failClosed=true`、`readThrough=true`、`passthrough=[stageRoot]`。
- 关键路径（**全部来自环境变量，不要硬编码**）：
  - `$env:WINSTAGE_STAGE_ROOT` = `…\.dshstage\sessions\session-4c5d9889-…\staged`（overlay 根）
  - `$env:DSH_REGSTAGE_ROOT` = 会话目录（其下有 `staged/`、`candidates/`、`review.json`、`queue.json`、`manifest.json`）
  - `$env:WINSTAGE_SHIM_LOG` = shim 日志
  - workspaceRoot = `C:\Users\Administrator\Desktop\WinStageSandbox`
- 平台：Windows Server 2025 Datacenter 10.0.26100，用户 `administrator`（管理员），C: 约 63 GB 可用，D: 约 362 GB 可用。
- 工具链：`node v24.21.0`、`npm 11.19.0`、`pnpm`、`git`、`curl.exe`、`winget`、`choco`、`reg.exe`、`tar.exe`；**无 7z**。
- `python`/`python3` = `WindowsApps` 里的 **0 字节 Microsoft Store 存根**（不可用）；`pip` 不存在；
  **`uv` 在 `C:\Users\Administrator\.local\bin\uv.exe`（可用它装真 Python）**。
- 全局 `.npmrc` = `registry=https://registry.npmmirror.com`；`pip.ini` 尚不存在。
- 浏览器：**无 Chrome**；Edge `154.0.4258.53` =
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
- 网络：`registry.npmmirror.com`、`pypi.tuna.tsinghua.edu.cn`、`nodejs.org` 均 HTTP 200 可达。
- 上一轮已验证的 `browser-use` 修复（本轮可直接用）：`C:\Users\Administrator\.local\bin\browser-use.cmd`
  与其前置脚本 `browser-use-preflight.py`；浏览器 profile 在 `C:\eprof`，
  只给**浏览器进程树**加 `WINSTAGE_SHIM_DISABLE=1`。说明文档：`_sandbox-tests\FIX-BROWSER-USE.md`。

## 3. 三条取证通道（本协议的核心，必须严格执行）

| 通道 | 是什么 | 能证明什么 |
|---|---|---|
| `PS` / `CMD` | 被 shim hook 的进程视角：PowerShell cmdlet、`cmd /c dir`、`reg.exe` | 只能证明「沙箱内看到了什么」 |
| `STAGE` | 直接读 `$env:WINSTAGE_STAGE_ROOT` 下的 overlay、`$env:DSH_REGSTAGE_ROOT\candidates\*`、`review.json`（该路径在 passthrough 列表里，是物理真实文件） | overlay 里有什么、候选/风险分级是什么 |
| `HOST` | **地面真值**。DSH 宿主进程不在 shim 内，因此：① `read`/`glob`/`grep` **工具**读的是真实磁盘；② 子进程加环境变量 `WINSTAGE_SHIM_DISABLE=1`（shim 官方逃生开关）后该子进程直连真实磁盘与真实注册表 | 「到底有没有落到宿主真实磁盘/真实注册表」 |

**Lead 已实测确认（可直接引用，也欢迎复核）**：

1. 用 PS 写 `C:\Windows\Temp\winstage-r2-canary-out.txt` 与工作区内文件后，`read` 工具
   对两处均报 `not found` → 两处都**没有**落到真实磁盘；STAGE 通道能看到 overlay 副本。
2. `cmd /c "echo …> C:\Windows\Temp\winstage-r2-escape.txt"` 在
   `$env:WINSTAGE_SHIM_DISABLE='1'` 下执行后，`read` 工具**能读到该文件** →
   逃生开关有效，可作 HOST 通道，同时本身就是一个安全发现。
3. `write`/`edit` 工具属于宿主进程 → **直写真实磁盘、不走 staging、不进候选**（上一轮发现，可复验）。

**规则**：凡涉及「是否真的落到宿主」的结论，**只能**用 `STAGE` 或 `HOST` 通道支撑，
并写明依据（overlay 路径是否存在 + 真实磁盘是否存在 + 候选记录 + 风险分级）。
**同一条观察尽量用两条通道交叉验证，不一致时如实记录「通道矛盾」——矛盾本身就是最高价值发现。**

## 4. 状态码与记录规则

| 状态 | 含义 |
|---|---|
| `OK` | 行为符合沙箱设计语义，且已取证 |
| `FAIL` | 明确缺陷/不一致/崩溃/静默降级/逃逸 |
| `BLOCKED` | 被沙箱或环境拒绝（必须记录原始错误文本） |
| `N-A` | 环境不具备（说明原因） |
| `FINDING` | 补充的安全/易用性观察，非通过/失败判定 |

1. **每次写操作后必须回读并记录 SHA256**：`写入 SHA256 == 回读 SHA256`（完整性校验）。
2. 每条 checkpoint 标注通道（`PS`/`CMD`/`STAGE`/`HOST`）。
3. 记录 `review.json` 的风险分级（`normal/outside/sensitive/danger`）与候选 id —— 这是隔离能力的直接证据。
4. 每执行一条命令，把**命令行 + 退出码 + 关键原始输出**追加到自己的 `executions.log`。
5. **沙箱放行了本应拦住的操作（逃逸）= 最高优先级发现**，请在最后汇报里用
   `CRITICAL:` 前缀单列。
6. 易用性是硬性要求：每条 checkpoint 都要写一句「这一步顺不顺、坑在哪、需要几步、报错是否可理解」。

## 5. 你的产出（只写自己目录，绝不碰别人的目录）

目录：`C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\<your-area>\`

1. `results.json` —— 机器可读数组，每 checkpoint 一项：
```json
{
  "id": "FS-03", "title": "工作区内写入并回读", "status": "OK",
  "channel": ["PS", "STAGE"],
  "command": "Set-Content …; Get-FileHash …",
  "expected": "写入成功且回读哈希一致，改动进入候选列表",
  "observed": "写入成功，SHA256 一致；candidates 记录 risk=normal",
  "hostTruth": "read 工具对该真实路径 not found → 未落真实磁盘",
  "evidence": ["evidence/fs03.txt"],
  "usability": "需要手工拼 3 条命令才能确认落盘位置；建议 DSH 提供 `dsh stage ls`"
}
```
2. `findings.md` —— 人类可读小结：结论表、证据、**易用性**、建议、遗留物。
3. `executions.log` —— 逐条命令记录。
4. `evidence/` —— 原始输出、staged 路径清单、哈希、截图、下载物等。

## 6. 纪律（硬约束）

- **只写自己的 `_sandbox-tests\r2\<your-area>\`**；不要改别人的目录、不要动 `.dshstage` 内容。
- **禁止**执行 `flatten` / `apply` / `approve` / 把改动提交到宿主真实磁盘的操作。
- 破坏性动作（改 HKLM 服务、删系统文件、真实提权、写 Run 启动项）先做**最小无害变体**；
  确实必要才做，并在 findings 里标注「测试遗留物」。
- 不装驱动、不改系统安全设置、不读取真实凭据的**内容**用于外发以外的用途；
  敏感文件测试只用**伪造秘密**做外发实验。
- 单条命令必须加 `timeoutMs`（建议 30000–120000）；失败就记录并继续，不要卡死。
- 命令总数控制在**合理范围**（约 40–90 条），优先做高信息量的 checkpoint。
- 遇到 `STAGING_WRITE_UNVERIFIED` 之类的门拒绝：重试 1–2 次并记录发生次数与原文。

## 7. 汇报格式（返回给 Lead，≤500 字）

```
DOMAIN: <area>
状态统计：OK x · FAIL y · FINDING z · BLOCKED w · N-A v
CRITICAL: <逃逸/静默降级，一行一条>
TOP FINDINGS: <3–6 条，每条一句 + 通道 + 证据文件>
易用性 TOP3: <…>
遗留物: <测试在真实磁盘/注册表留下的东西 + 清理状态>
产出: <results.json / findings.md / executions.log / evidence 路径>
```
