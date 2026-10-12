# WinStage 沙箱 r2 实测 — DOMAIN: pip（Python 包安装 + 完整性 + 国内镜像）

会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
上一轮对照：`_sandbox-tests\pip\`（结论：本机零可用 Python，pip 不存在）
本轮结论：**能拿到真 Python，但装不出新 Python，也装不成任何 pip 包——根因是沙箱本身在运行中退化，而非缺 Python。**

---

## 1. 结论表

| id | 标题 | 状态 | 通道 |
|---|---|---|---|
| PIP-01 | 判定解释器现状 | **OK** | PS / CMD / HOST |
| PIP-02 | 装出真 Python（uv 优先） | **FAIL** | PS / STAGE / HOST |
| PIP-03 | 配置全局国内镜像 | **BLOCKED** | PS / STAGE |
| PIP-04 | 安装包 + wheel sha256 校验 | **BLOCKED** | PS |
| PIP-05 | 隔离面判定 + review.json | **FINDING** | PS / STAGE / HOST |
| PIP-06 | 可用性闭环 | **BLOCKED** | PS |
| PIP-07 | 镜像链路独立校验 | **BLOCKED** | PS |
| PIP-08 | 易用性 | **OK** | PS / STAGE / HOST |
| PIP-X1 | gate 随机拒绝只读命令 | FINDING | PS |
| PIP-X2 | 运行中沙箱退化（全局写入/启动拒绝） | FINDING | PS / HOST |
| PIP-X3 | 遗留物污染候选 | FINDING | STAGE / PS |

**状态统计：OK 2 · FAIL 1 · FINDING 4 · BLOCKED 4 · N-A 0**

---

## 2. 直接回答本轮的必答问题

> 上一轮说"本机零可用 Python"。本轮能不能装出来？

**能——而且它已经在机器上了。** `C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe`

- `python -V` → `Python 3.12.14`（exit 0）
- `python -m pip --version` → `pip 26.2.1 from ...\cpython-3.12-windows-x86_64-none\Lib\site-packages\pip (python 3.12)`（exit 0）
- HOST 通道（`WINSTAGE_SHIM_DISABLE=1`）同样输出 `Python 3.12.14` → **在真实磁盘上**，不是 overlay。

但 `python`/`pip` 不在 PATH 上：`where python` 命中的仍是 0 字节 Store 存根，`python --version` 退出码 9009 且零输出。所以"装不出 Python"的表象来自两点：**PATH 里是存根**，以及 **uv 已经装不好新的 Python**。

> uv 能装吗？

**不能，本轮明确 FAIL。** 见第 3 节。

> 能不能装 pip 包？

**不能。** 沙箱在本次运行中途变为"拒绝一切写入 + 拒绝启动孙进程"，因此 `pip install` / `pip download` 全部无法执行，只读的 `pip list` 也一起失效。

---

## 3. 最高价值发现：uv 装 Python 失败的完整根因链

```
uv python install 3.12      -> exit 2 (669 ms)
uv python install 3.13      -> exit 2 (26696 ms)

error: Failed to create Python minor version link directory
  cause: failed to remove directory
  `C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none`
  : 目录不是空的。 (os error 145)
```

证据链（三条通道交叉）：

1. **HOST / PS**：真实磁盘上 `cpython-3.12-windows-x86_64-none` 是
   `<JUNCTION> → cpython-3.12.14-windows-x86_64-none`。
2. **STAGE**：overlay 里同一路径 `staged\fs\C\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none`
   的 `Mode = d-----`，**是普通目录，不是重解析点**。
3. shim 把 junction 实体化成真实目录后，uv 删除/重建 minor-version link 时命中的是"真正的非空目录"，
   Windows 返回 `ERROR_DIR_NOT_EMPTY (145)`，uv 中止整个安装。

**静默部分成功**：3.13 已经下载 21.0 MiB 并打印 `Downloaded cpython-3.13.15-windows-x86_64-none (download)`，
解压也完整完成了，但停在 `.temp\.tmpH5THDA\python\`（含 `python.exe` 91648、`python313.dll`、`Lib`、`libs`、`Scripts`、`tcl`），
**从未改名为 `cpython-3.13.15-windows-x86_64-none`**。virtual 与 HOST 两个通道都报 File Not Found。
约 20 MiB 白下载，且只在 overlay 里留了一份不可用的残骸。

交叉印证 3.12 是怎么装上的：`review.json` 候选 `cs_0045_61ebdd8a`（pending）里是
`HKCU\Software\Python\Astral\CPython3.12.14\{...}` 共 14 条注册表路径 —— uv 确实在本会话内成功注册过一次
3.12.14 安装。**装第一次能成，重装/装新版本就失败**，与"已存在的 junction 被删除"这个触发条件一致。

---

## 4. 第二条主线发现：overlay 写入读不回来（通道矛盾）

| 路径 | virtual (`Test-Path`) | STAGE (`<staged>\fs\...`) | HOST |
|---|---|---|---|
| `C:\Users\Administrator\.local\bin\python3.12.exe` | **False**，且不在目录列表里 | **True**，47104 字节，SHA256 `9BFA2E54…2433EAD` | 目录在，该文件不在 |
| `C:\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\<guid>\pipwork\hostcheck.txt` | True（shim 内可读回） | 存在 | **not found** |

即：**shim 把写入 staged 成功了，但读穿透路径解析不到它**。这正是任务简报里点名的
"写成功但 stat 报 ENOENT / metadata 族 API 未走 overlay"这一类缺陷，本轮在 Python/uv 上复现。
三个通道给出三个不同答案，而沙箱内没有任何提示。

同时 STAGE 通道确认：写入**没有**落到真实磁盘（HOST `read` 对 shim scratch 报 not found），
隔离语义在"写入"方向上是成立的——问题只在"回读"方向。

---

## 5. 第三条主线发现：运行中沙箱退化为全拒（CRITICAL 级）

前半程一切正常（写 staged 成功、python 启动成功），后半程：

- **所有写入被拒**：workspace 根、`_sandbox-tests`、`r2` 及全部子目录、`C:\Windows\Temp`、
  Desktop、`D:\`、`%APPDATA%\uv`、`%APPDATA%\pip`、`site-packages` —— 一律
  `UnauthorizedAccessException: Access to the path '...' is denied.`
- **孙进程启动被拒**：`cmd.exe`、`whoami.exe`、`uv.exe`、`python.exe` →
  `Program '<x>' failed to run: Access is denied`；`whoami` → `ERROR: Access is denied.`
- **shim 环境变量从子进程消失**：`WINSTAGE_STAGE_ROOT` / `WINSTAGE_SHIM_LOG` /
  `WINSTAGE_SHIM_CONFIG` / `DSH_REGSTAGE_ROOT` 全为空；
  `DSH_SESSION_ID = 76aa210c-fff6-4268-9969-b71f2897b121`，
  而本线程 agent 会话是 `session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`。
- 工作区 ACL 为 `Everyone:(CI)(DENY)(DC)` + `S-1-4-56185984-606674207` /
  `S-1-4-1039366120-933337351` 的 `(W,D,DC)` 授权 + Low Mandatory Level ——
  **身份与 capability SID 错配可以直接解释全量拒绝**。
- 期间还有一次 `dsh-stage: sandbox launch failed: spawn UNKNOWN`（exit 127）。
- 逃逸开关不再有效：`WINSTAGE_SHIM_DISABLE=1` 下写入仍被拒，只是报错从
  `Access is denied` 变成 `Could not find a part of the path`。
- **shim 日志里对被拒路径一条记录都没有**（成功路径有 `CreateFileW staged(write)` 行），
  沙箱内完全无法自查。

另有一条 gate 不稳定证据：`uv python list`（纯只读）第一次被
`STAGING_WRITE_UNVERIFIED` 拒绝，原文含
`outside-write-staged-not-real=fail (child-reported-ok=false real-disk-has-file=false staged=...\session)`，
**同一命令原样重试即成功，中间没有任何状态改变**。

---

## 6. 隔离面与 review.json（PIP-05）

```
sessionId  = session-4c5d9889-7b7f-4132-931b-a26a3c1d924d   (与本会话一致)
pending    = true      truncated = true      revision = 4628
counts     = files 2875, additions 474729, deletions 1
riskCounts = normal 2859 | outside 15 | sensitive 1 | danger 0
candidates = cs_0045_61ebdd8a (14 条, HKCU\Software\Python\Astral\CPython3.12.14\*)
             cs_0095_e86af636 (2861 条, 含 .local\bin\python3.12.exe、uv cache、
                               dsh-stage-temp\__PSScriptPolicyTest_*.psm1)
staged\fs  = 2781 个文件
```

- `outside`（15）与 `sensitive`（1）**都出现了**，`danger`（0）未出现。
- 但 `review.json` **只给聚合 riskCounts，没有 per-path risk 字段** —— 用户知道"有 1 个敏感、15 个越界"，
  却无法从文件里知道是哪一个，必须在 GUI 里翻 2861 条。
- 噪声很大：40 个 `.dsh-selfcheck-*.txt`（各 3 字节）、PowerShell 自己的
  `__PSScriptPolicyTest_*.ps1/.psm1`、`StartupProfileData-NonInteractive`、uv cache 的 `.lock`/`sdists-v9\.git`
  都被当成工作区改动送审。
- `%LOCALAPPDATA%\Temp\dsh-stage-temp\` 下累积了**数百个** `<guid>` 目录（每次 shim 调用一个），未见清理。

---

## 7. 易用性（PIP-08）

从"想装一个 pip 包"到被拦住为止共约 **10 步**，其中 4 步需要用户具备深层 Windows 知识
（读 os error 145、查 junction 属性、查 overlay 条目类型、判断 SID 错配）。

**TOP 3 坑**

1. **存根 Python 的失败完全不可读**：`python --version` 只有退出码 9009、零文字；
   偏偏 `where python` 返回 exit 0（"找到了"）。两个信号互相矛盾，用户会以为 Python 装坏了。
   真 Python 其实就在 `%APPDATA%\uv\python` 里，但不在 PATH 上，也没有任何一条命令提示它在那儿。
2. **"Access is denied" 不区分沙箱拦截与 Windows ACL**，且 `pip config list` / `pip config debug`
   会以 **exit 0 + 零输出** 返回（命令实际没能给出结果），"成功退出码 + 空结果"是最难排查的组合。
3. **gate 与能力的判定不稳定、不可学**：只读命令被 `STAGING_WRITE_UNVERIFIED` 拒一次、
   重试就过；写入能力在同一会话中途从"staged 成功"静默切到"全拒"；被拒时 shim 日志无记录，
   逃逸开关也不恢复能力。

**建议**

- 新增 `dsh python status`，显式报告存根/PATH/可用的 uv Python 目录；
- 把 uv 的 `%APPDATA%\uv\python`（及其 `.local\bin` shims）加入 PATH 或至少提示；
- 写入被 failClosed 拒绝时给出可操作信息（含 staged 路径、候选 id、如何逃生），并在 shim 日志留痕；
- `review.json` 增加 per-path risk 字段；
- 忽略名单：`__PSScriptPolicyTest_*`、`StartupProfileData-*`、`.dsh-selfcheck-*`、shim scratch 路径；
- 清理 `dsh-stage-temp\<guid>` 遗留目录。

---

## 8. 遗留物（真实磁盘 / overlay）

| 遗留物 | 位置 | 真实性 | 清理状态 |
|---|---|---|---|
| cpython 3.12.14 + pip 26.2.1 | `%APPDATA%\uv\python\cpython-3.12.14-…\` | 真实磁盘 | **保留**（本轮唯一可用的解释器，勿删） |
| cpython-3.12 junction | `%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none` | 真实磁盘 | 保留 |
| 3.13 解压残骸（≈20 MiB） | `<session>\staged\fs\…\uv\python\.temp\.tmpH5THDA\` | overlay（真实磁盘上的 .dshstage 内） | 未清理 |
| staged `python3.12.exe`（47104 B） | `<session>\staged\fs\…\.local\bin\` | overlay | 未清理 |
| 数百个 `dsh-stage-temp\<guid>` | `%LOCALAPPDATA%\Temp\` | 真实磁盘 | 未清理（非本次独有） |
| 40 个 `.dsh-selfcheck-*.txt` | workspace 根 + 候选 | overlay | 未清理 |
| 本线程产出 | `_sandbox-tests\r2\pip\` | 真实磁盘（经 HOST `write` 工具） | 保留为交付物 |

未做任何 `flatten` / `apply` / `approve` / 破坏性操作；未改 `.dshstage` 内容；
未安装任何 pip 包（一次都没装成）；未改系统安全设置。

---

## 9. 证据文件

- `evidence/01-interpreter-state.txt` — PIP-01 全量原始输出（含 CWD 异常）
- `evidence/02-uv-python-install-failure.txt` — uv 失败原文 + HOST/STAGE junction 对比 + 根因
- `evidence/03-write-denial-matrix.txt` — gate 原文、全路径写入拒绝矩阵、进程启动拒绝、env 丢失
- `evidence/04-overlay-vs-virtual.txt` — staged 写入读不回来的通道矛盾 + 遗留物
- `evidence/05-review-json.json` — review.json 结构化摘要（riskCounts / 候选 / 路径）
- `evidence/06-shim-config-and-log.txt` — shim 配置与日志（含"被拒路径无日志"的证据）
- `executions.log` — 36 条命令逐条记录
- `results.json` — 机器可读结果
