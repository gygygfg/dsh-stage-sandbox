# pip / Python 安装域 实测小结（线程 pip-tester）

- 工作区：`C:\Users\Administrator\Desktop\WinStageSandbox`
- 本线程会话/写入根：`session-eb7c901d-97ed-4f83-9096-33c97138c361`
- 写入范围：仅 `_sandbox-tests\pip\`
- 结论一句话：**pip 安装链路在本机不可用**——原因不是镜像，而是**本机零可用 Python**；镜像侧（下载 + 哈希校验）实测可用。

---

## 1. 结论与证据等级

| 结论 | 证据等级 | 依据 |
|---|---|---|
| 本机没有任何真实 Python 解释器 | **3 条通道互证**（CMD `where.exe`+退出码 / PS `Get-Command`+`Test-Path` / 实际执行 `--version`） | PIP-01 |
| 国内镜像可稳定下载（get-pip.py、wheel、embeddable zip） | **2 条通道**（CMD curl 状态码+字节数 / PS `Get-FileHash` 回读） | PIP-02、PIP-03、PIP-06 |
| 下载物完整性可校验（镜像索引内联 `#sha256=` == 实测哈希） | **2 条通道**（镜像索引 / 实测 Get-FileHash），另加 2 个独立 JSON API 互证 | PIP-06 |
| `pip.ini` 只进了 staging、未落真实磁盘，且已进候选 | **2 条通道**（STAGE glob / candidates 哈希逐字符相同 + before=absent） | PIP-04、PIP-07 |
| `pip config` 确实读取该配置 | **无法验证**（0 条通道，全部 exit 9009） | PIP-04b BLOCKED |

> 强调：沙箱内任何进程观察都不能证明宿主磁盘被改动。凡涉及“是否真落宿主”的结论，本文只用 STAGE 通道（harness 侧 `glob`/`read` 直读 `.dshstage` 与真实磁盘）支撑。
> 另需注意一条方法论修正：**从沙箱内用 PS/CMD 读 `.dshstage` 会被 shim 再次重定向**，因此 PS/CMD 读 staged 树**不是**地面真值（见 §3.4）。

---

## 2. 逐检查点

### PIP-01 是否存在可用 Python —— `N-A`
- `where.exe python` → `C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe`；`where.exe python3` → 同类 `python3.exe`。
- 该存根 **Length=0**，Attributes=`Archive, ReparsePoint`（Microsoft Store 别名存根）。
- `python --version` / `-V` / `-c "print(1)"` / `-m pip --version` / `python3 --version` 全部 **exit 9009 且零输出**。
- `py`、`pip`、`pip3` 均不存在（`where.exe` exit 1；cmd 报 not recognized）。
- `AppData\Local\Programs\Python`、`C:\Python39..313`、`Anaconda3`、`miniconda3` 全部 `exists=False`。
- 判定 `N-A`：**环境完备性问题**——沙箱里没有可用的包管理入口。

### PIP-02 从国内镜像下载 get-pip.py —— `OK`
| URL | HTTP | 字节 | 耗时 | content-type |
|---|---|---|---|---|
| `https://pypi.tuna.tsinghua.edu.cn/get-pip.py`（清华） | **404** | 153 | 299 ms | text/html |
| `https://mirrors.ustc.edu.cn/pypi/get-pip.py`（中科大） | **404** | 193 | 613 ms | text/html |
| `https://mirrors.cloud.tencent.com/pypi/get-pip.py`（腾讯） | **404** | 146 | 514 ms | text/html |
| `https://mirrors.aliyun.com/pypi/get-pip.py`（阿里云） | **200** | 1,908,226 | 5.45 s (~356 KB/s) | text/x-python |
| `https://bootstrap.pypa.io/get-pip.py`（官方） | 200 | 2,230,488 | 1.94 s (~1.24 MB/s) | text/x-python |

- 实际 URL：`https://mirrors.aliyun.com/pypi/get-pip.py`
- SHA256 = `40EE07EAC6674B8D60FCE2BBABC148CF0E2F1408C167683F110FD608B8D6F416`，首行 `#!/usr/bin/env python`。
- **清华镜像不托管 get-pip.py**（Lead 指定源实测 404）；国内实际可用的是阿里云。

### PIP-03 独立解释器 —— `N-A`（按 Lead 裁定主动降级）
- 未安装、未解压、未污染系统，也无未签名/提权操作。
- 旁证（镜像可达性，仅下载）：embeddable 3.12.7 三方同尺寸 **11,062,583 B** — 清华 1.64 s (~7.25 MB/s)、华为云 1.35 s (~8.67 MB/s)、python.org 5.24 s (~2.14 MB/s)。
- 测试遗留物：`dl/py-embed-{tuna,hw,org}.zip`（各 ~11 MB，仅下载未使用，位于 staging）。
- 若要真正验收 PIP-03/05，需要：解压 → 改 `python312._pth` 取消注释 `import site` → 在该目录内执行 `get-pip.py`。
  **未验证的风险**：仅有 staging 副本的 `python.exe` 能否被 `CreateProcess` 直接加载——若不能，则是比“没有 Python”更深的沙箱可用性天花板。

### PIP-04 配置国内全局镜像 —— `OK`（写入与落点），`PIP-04b` `BLOCKED`（生效验证）
- 写入 `%APPDATA%\pip\pip.ini`（APPDATA = `C:\Users\Administrator\AppData\Roaming`）+ 本地副本 `_sandbox-tests\pip\mirror-conf\pip.ini`。
- 两份：`WRITE_SHA256 == READBACK_SHA256 == 47A20A5F888005D03BCBD058C42E3A4DAA8A823B2B7728689B57C18D05CF1D01`（143 字节）。
- 内容：
  ```ini
  [global]
  index-url = https://pypi.tuna.tsinghua.edu.cn/simple
  trusted-host = pypi.tuna.tsinghua.edu.cn
                 mirrors.aliyun.com
  ```
- STAGE 确认落点：staged 存在，真实磁盘不存在（见 PIP-07）。
- **`pip config list` / `pip config debug` / `python -m pip config list` 全部 exit 9009** → 无法证明 pip 会加载它。

### PIP-05 实际安装一个包 —— `N-A`
- 无解释器，无法执行 `pip install six`。镜像侧已就绪（见 PIP-02/06），只缺解释器。
- 若有 Python，验收步骤（约 1 条命令 + 3 次核对）：
  1. `pip install six --index-url https://pypi.tuna.tsinghua.edu.cn/simple -v`
  2. 从 `-v` 输出确认 `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple`，且 `Downloading https://pypi.tuna.tsinghua.edu.cn/...`（**不是** `files.pythonhosted.org`）
  3. `pip show six` 记录版本；`pip download --no-deps six -d .` 单独计时

### PIP-06 完整性校验 —— `OK`
- TUNA simple 索引（11,625 B）中 `six-1.10.0-py2.py3-none-any.whl` 内联声明 `#sha256=0ff78c403d9bccf5a425a6d31a12aa6b47f1c21ca4dc2573a7e2f32a97335eb1`。
- 实测下载（HTTP 200, 10,341 B, 288 ms）→ `Get-FileHash` = **完全一致**：`HASH_MATCH_MIRROR_INDEX=True`。
- 双 API 互证（`pypi.org/pypi/six/json` 与 `pypi.tuna.tsinghua.edu.cn/pypi/six/json` 结果一致）：version=**1.17.0**，
  `six-1.17.0-py2.py3-none-any.whl` sha256=`4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274` (11,050 B)，
  `six-1.17.0.tar.gz` sha256=`ff70335d468e7eb6ec65b95b99d3a2836546063f63acc5171de367e834932a81` (34,031 B)。
- 诚实说明：我解析的是索引里**第一个** href，因此拿到 1.10.0（非最新 1.17.0）；1.10.0 的哈希只与镜像索引比对成功，未与 1.17.0 的 JSON 摘要混用。这是脚本设计缺陷，不是校验失败。

### PIP-07 安装产物落点取证 —— `N-A`（无安装产物）+ 配置产物已完整取证
- 没有 site-packages 产物（无解释器 → 无安装）。
- `pip.ini` 取证（STAGE）：
  - staged 命中：`session-eb7c901d/staged/fs/C/Users/Administrator/AppData/Roaming/pip/pip.ini`；真实磁盘 `%APPDATA%\pip` 不存在。
  - candidates 命中（`cs_0204`…`cs_0228` 等）：`{"path":"fs\\C\\Users\\Administrator\\AppData\\Roaming\\pip\\pip.ini","op":"create","kind":"file","before":{"hash":"absent"},"after":{"hash":"47a20a5f888005d03bcbd058c42e3a4daa8a823b2b7728689b57c18d05cf1d01","bytes":143},"frozen":true}`
    → `after.hash` 与我写入的 SHA256 **逐字符相同**，`before=absent` 证明真实磁盘原本没有该文件。
  - `review.json`：`candidateId=cs_0235_b355a022`, `revision=4688`, `pending=true`, `truncated=true`, `counts.totalFiles=1695`, `riskCounts={normal:1639, **outside:29**, sensitive:27, danger:20}`。该路径位于 `workspaceRoot` 之外，按路径语义属 **outside** 桶。
  - **缺口**：candidates 条目只有 `path/op/kind/before/after/frozen`，**没有逐条 risk 字段**；风险只以 review.json 的聚合 `riskCounts` + `alerts` 呈现，而 review.json 本次 `truncated=true` 且只列 40/1695 条 → 用户无法针对单个文件拿到逐条风险判定。

### PIP-08 易用性 —— 见 §4。

---

## 3. 独立小节：`%ALLUSERSPROFILE%` 字面量目录 + powershell.exe 反复崩溃

> 严重度：**中—高**。这是本线程最有价值的发现。

### 3.1 现象（STAGE 通道，harness `glob`/`read` 直读）
两个 session 的 staging 里都存在一个**名为 `%ALLUSERSPROFILE%` 的字面量目录**（环境变量未被展开），结构为：

```
.dshstage\sessions\<sid>\staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive\
    Critical_powershell.EXE_<fault-hash>_00000000_<guid>\Report.wer
```

- `session-eb7c901d-97ed-4f83-9096-33c97138c361`：**5** 个 `Critical_powershell.EXE_*` 报告
  （fault hash `b8b99381...`，guid 尾号 `41f65ee5` / `0f1c0fd3` / `c6ac52b2` / `456eaefb` / `fd1ef1a8`）。
- `session-8b4a07b9-2dc4-412f-9714-cad55c37708f`：**3** 个报告（`b8b99381...` × 1 于 19:13:07；`ddebabc3...` × 2 于 18:57:32、19:59:29）。
- 合计 **8** 份 powershell.exe 严重崩溃报告（Lead 独立复核为 6 份，差异应为统计时点/条数口径不同）。
- 该字面量目录 `Get-ChildItem -LiteralPath ... -Recurse` 共 9 个条目（含 `ReportArchive` / `ReportQueue` / `Temp` 三个空目录）。
- 只列了元数据（名字/大小/时间），**未读 Report.wer 正文**。

### 3.2 对照实验，证明是“部分展开失败”而非“完全不展开”
同一 session-8b4a07b9 下，WER 的 Temp 目录**被正确展开**为：

```
.dshstage\sessions\session-8b4a07b9-...\staged\fs\C\ProgramData\Microsoft\Windows\WER\Temp\WER.<guid>.tmp.csv|txt
```

即 `%ProgramData%` 类路径展开正常，只有 WER 从注册表读到的 **`ReportArchive`/`ReportQueue` 值（其内容为字面 `%ALLUSERSPROFILE%\Microsoft\Windows\WER\...`）** 未被展开，被 shim 当普通路径拼进了 staging。
→ 结论：**shim 在映射前未对含环境变量的路径做统一展开**，属功能缺陷；且这种“看起来像路径的目录名”会污染候选列表与按路径的语义判定。

### 3.3 隔离仍然有效（重要反证）
真实磁盘 `C:\ProgramData\Microsoft\Windows\WER\ReportArchive` **存在**，含大量 `AppCrash_*`（`choco.exe`、`7z2408-x64.exe`、`cmd.exe`、`msedge.exe` 等），但**不存在任何 `Critical_powershell*`**。
→ 这 8 份 powershell 崩溃报告只进了 staging，**从未落到宿主**。文件隔离本身按设计生效。

### 3.4 与本线程阻塞的关联（时间对齐 + 归因）
- 崩溃报告时间：`2026-10-02T18:57:32`、`19:13:07`、`19:59:29`（session-8b4a07b9）。
- 本线程遭遇的 `STAGING_WRITE_UNVERIFIED` 门拒绝，其自检子进程退出码观测到 **`0xE0434352`（.NET CLR 未处理异常）**、`0xFFFF0000`、`exit=1/2`，并伴随 `staged=not-found`。
- 归因：**门用于自证 staging 可写的探针子进程自身崩溃**（CLR 异常），使门判定 staging 不可信而拒绝执行一切命令。这与“同环境下 powershell 反复 Critical 崩溃”高度可能是同一根因（shim 注入导致进程崩溃 + env-var 路径处理缺陷）。
- 需要 Lead 注意的口径：崩溃报告的时间戳早于本线程的门失败（我这边门失败发生在 `2026-10-03T01:4x` 前后），因此**不能简单说“本次崩溃直接导致本次门失败”**；更稳妥的表述是：**shim 环境变量展开缺陷与 powershell.exe 崩溃是同源的两个表现，而门自检探针的 CLR 崩溃是门全量拒绝的直接原因**。

### 3.5 另两处相关通道问题（同源观察）
1. **EBUSY 竞争**：harness 曾报 `EBUSY: resource busy or locked`，指向
   - `...\staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive\938209ac-3286-4224-8ad3-b330ae4c553c`（WER 清理前的临时 GUID 目录，现已不存在）；
   - 以及 `...\session-eb7c901d\staged\fs\C\...\_sandbox-tests\registry\executions.log` —— 后者是**队友正在并发写入**的文件。
   → EBUSY 至少部分来自**同一 stageRoot 下的多线程并发写竞争**（PROTOCOL 已写明并行线程共享 staging 不隔离）。建议对大文件写入加锁或让各线程用独立文件。
2. **`-Recurse` 触发门**：本线程用 `Get-ChildItem -Recurse` 列目录后立即出现 harness 级 EBUSY/门拒绝，复现了 PROTOCOL §1 的已知坑。全线程应禁用 `-Recurse`。

---

## 4. 易用性小结（一张表）

| 环节 | 步数 | 耗时 | 顺不顺 | 坑在哪 |
|---|---|---|---|---|
| 判断有没有 Python | 1 条命令 | <1 s | ✗ 误导 | `where.exe python` exit 0 且列出 python.exe，看着像装了；只有真跑 `--version` 才暴露 exit 9009 的 0 字节 Store 存根 |
| 配国内镜像 pip.ini | 1 步写入 | <1 s | ✓ 写入顺 / ✗ 无法自证 | 两份 + 哈希可复现，但没有任何本地手段证明 pip 会读它（`pip config` 全 9009） |
| 找可用的 get-pip.py 源 | 试 4 个源 | 5.7 s | ✗ 需试错 | 清华（文档常推荐）404；实际可用是阿里云；且 404 时 curl 仍 exit 0 |
| 下载 + 校验一个包 | 3 步 | <1 s | ✓ | 镜像索引自带 `#sha256=`，无需解释器即可闭环——做得好 |
| 核对安装产物落点 | 2 条通道 | 数秒 | ✗ 费力 | 要看 STAGE 必须用 harness 文件工具；从沙箱内 PS/CMD 读 `.dshstage` 会被 shim 重定向，得到假阳性 |
| 查某个文件的 review 风险 | 无可用路径 | — | ✗ 缺口 | candidates 条目无逐条 risk；review.json `truncated=true`，只列 40/1695 条 |
| 运行自己的 .ps1 测试脚本 | 1 步 | — | ✗ 阻塞 | 未签名 `.ps1` 被拒，报错指向“数字签名”，不提示改用 `iex`/`-ExecutionPolicy Bypass` |

### 建议（按优先级）
1. **修 shim 的 env-var 展开**（`%ALLUSERSPROFILE%` 字面量目录），并排查 shim 注入导致 `powershell.exe` Critical 崩溃。
2. **修 `STAGING_WRITE_UNVERIFIED` 门的失败语义**：区分“探针基础设施故障”与“真实隔离失效”；前者应带退避重试 + 可操作提示，而不是拒绝一切命令。当前它把本线程几乎全部检查点直接打掉。
3. **统一审批面**：harness 文件工具（`write`/`edit`）目前直写真实磁盘、不进候选（见 §5），与“所有改动需人工批准”的语义不一致。
4. **提供逐条风险解释**：`dsh stage explain <path>`；并让 review.json 不截断或支持按路径查询。
5. **环境自检显式报告**：本机无 Python（Store 存根）、pip 域不可测；内置可用的国内镜像模板（含 get-pip 可用源与可信摘要）。
6. **文档补两条**：如何正确执行自写脚本（`iex`/`-ExecutionPolicy Bypass`）；`.dshstage` 历史 session 树的清理方式。

---

## 5. 跨域附带发现：harness 文件工具直接写真实磁盘（绕过 staging）

虽属 fs 域，但直接影响本域交付物的可信度，故记录：
- `write` 工具写入 `_sandbox-tests\pip\evidence\write-tool-marker.txt` → **仅出现在真实磁盘**（真实磁盘 glob 命中），
  两棵 session 的 staged 树中均**无**此文件，`candidates/*.json` 中 grep `write-tool-marker` **无命中**。
- 对照：pwsh `Set-Content` 的写入**进 staging**（staged glob 命中 `pip01_recon_raw.txt`，并出现在候选面）。
- 含义：同一会话内“进程写入受管治、agent 文件工具写入不受管治”，审批面存在盲区。严重度：高（安全语义一致性）。
- 本线程的 `results.json` / `findings.md` / `executions.log` 因此均通过 harness 文件工具写成，**位于真实磁盘**。

---

## 6. 测试遗留物清单

| 位置 | 内容 | 是否落真实磁盘 |
|---|---|---|
| staging `_sandbox-tests\pip\dl\` | `get-pip.py`(1.9 MB)、`get-pip_{tuna,aliyun,ustc,tencent,official}.py`、`py-embed-{tuna,hw,org}.zip`(各 11 MB)、`six.whl`、2 个 JSON | 否（仅 staging） |
| staging `_sandbox-tests\pip\mirror-conf\pip.ini` | 本地镜像配置副本 | 否 |
| staging `%APPDATA%\pip\pip.ini` | 全局镜像配置（**工作区外**，已进候选，属 outside） | 否 |
| 真实磁盘 `_sandbox-tests\pip\` | `results.json` / `findings.md` / `executions.log` / 各 `.ps1` / `evidence\write-tool-marker.txt` | **是**（经 harness 文件工具） |
| 未产生 | 无 site-packages、未安装任何包、未提取任何解释器、未改注册表、未提权 | — |
