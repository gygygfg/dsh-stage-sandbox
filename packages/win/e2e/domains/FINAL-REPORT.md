# WinStage 沙箱实测总报告（8 线程并行 + Lead 独立复核）

- 被测对象：`C:\Users\Administrator\Desktop\WinStageSandbox`（WinStage 暂存—候选—选择性提交沙箱，Windows + DSH）
- 会话：`session-eb7c901d-97ed-4f83-9096-33c97138c361`，DSH 文件策略 `workspace-write`
- 方法：8 个独立线程（新 DSH 线程/独立上下文）按同一协议 `PROTOCOL.md` 分域实测，Lead 另做通道级独立复核
- 规模：**91 个 checkpoint**（OK 28 · FAIL 24 · FINDING 24 · BLOCKED 11 · N-A 3 · 另有 1 条因收口未执行）
- 证据：每域 `_sandbox-tests\<域>\{results.json,findings.md,executions.log,evidence\}`；Lead 复核见
  [`LEAD-independently-verified.md`](_sandbox-tests/_lead/LEAD-independently-verified.md)

> 一句话结论：**「改动不落真实磁盘」这条核心保证在 shim 覆盖到的路径上基本成立；
> 但「沙箱内一切都被暂存/都要人工批准」不成立——至少 3 类主通道逃逸，且沙箱内大量功能因此不可用。**

---

## 1. 结论速览

| # | 判定 | 说明 | 严重度 |
|---|---|---|---|
| 1 | **junction 写穿：沙箱内写入落到真实磁盘（`C:\Windows`）** | 工作区内建 `mklink /J` 指向真实 `C:\Windows`，经该链接写入 → 文件**真实出现在宿主** `C:\Windows\fs07-through.txt`，无 overlay 副本、无候选、`exit 0`。**Lead 已用宿主只读通道独立确证**（内容 `WRITTEN-THROUGH-JUNCTION`，staged 侧无该文件）。前提：junction 目标在真实磁盘上必须存在 | 🔴 严重 |
| 2 | **宿主 `write`/`edit` 文件工具直写真实磁盘** | 它们不走 shim → 真实文件被改、无 staged 副本、无候选、无人工批准。任何 agent 用 `write` 写一次文件就发生一次。**Lead 已用宿主只读通道确证**：`C:\Users\Administrator\Documents\dsh-probe-nonexistent-dir\x.txt` 真实存在 | 🔴 严重 |
| 3 | **敏感文件读面 100% 开放 + 可无阻碍外发** | `.dsh\.credentials.yaml`(223B)、`.npmrc`、`PSReadLine` 历史 8084B 均可读；假秘密经 `curl`/`Invoke-WebRequest`/`node fetch` **三通道 POST 成功**（httpbin 回显） | 🔴 严重 |
| 4 | **硬链接真实建到宿主磁盘、删除不生效** | `mklink /H` 在真实磁盘建出指向 `.npmrc` 的硬链接；`Remove-Item`/`cmd del`/`DeleteFileW` 全部 `exit 0` 但真实链接仍在 | 🟠 高 |
| 5 | **`browser-use` 配置目录写入逃逸** | `%USERPROFILE%\.config\browser-harness\**` 真实落盘、无 staged、无候选（工具自身配置目录，影响面有限但正是最坏形态） | 🟠 高 |
| 6 | **执行门 `STAGING_WRITE_UNVERIFIED` 间歇性全量拒绝命令** | 8 线程累计 ≥30 次；门自检子进程崩溃（`0xC0000005`/`0xE0434352`/`exit 2`）→ 判定 staging 不可信 → 拒绝一切命令 | 🟠 高（可用性） |
| 7 | **注册表跨进程不一致（255 个逐进程 hive）** | 父进程写的键子进程读不到；`reg add` 报成功、下次 `reg query` 找不到 | 🟠 高 |
| 8 | **Node/npm 在沙箱内完全不可用** | libuv 元数据族 API 未走 overlay：`writeFileSync` 成功但 `existsSync=false`、`statSync=ENOENT`；cacache 必然 `EEXIST`+`ENOENT` 双报错 | 🟠 高 |
| 9 | **新建目录不可作子进程 CWD** | `Test-Path` 看见、`CreateProcess` 报 `directory name is invalid`、`cmd cd` 报 not found —— 三通道三种答案；也导致下载的 exe 无法运行 | 🟠 高 |
| 10 | **审批面不可用** | `review.json` 单次达 1693–1624 个文件、`revision=4483`，被 `__PSScriptPolicyTest_*`（38k 行噪声）淹没；`listed=40`、注册表行 0 条、无实时提示 | 🟠 高（可用性） |
| 11 | **shim 未展开 `%ALLUSERSPROFILE%`** | 两棵 session 树里出现字面量目录名，内含 **7 份** `Critical_powershell.EXE` 崩溃报告（`System.AccessViolationException`） | 🟡 中 |
| 12 | **网络面零限制、无命名空间隔离** | 出站 TCP/UDP 全开、无代理无 TLS 中间人；loopback 与宿主共享（监听器出现在宿主 netstat） | 🟡 中（与设计一致） |
| 13 | **写入隔离本身成立** | 工作区外写入（`C:\Windows\Temp`、`%USERPROFILE%`、`ProgramData`）在 PS 通道报成功，但真实磁盘零改动；8 域独立复核一致 | 🟢 正面 |

---

## 2. 沙箱实际机制（实测骨架）

1. `winstage-shim.dll` 注入受控子进程，hook 文件/注册表 IAT（`file=on reg=on`，64~319 个站点）。
2. 写入被重定向到 `staged\fs\<盘符>\<路径>`；读走 read-through（先 overlay 后真实盘）。
3. 改动汇聚为候选 `candidates\cs_*.json`，聚合成 `review.json`，标注 `normal/outside/sensitive/danger`，
   需人工批准才由宿主写盘。
4. **关键漏洞：外层的 DSH 宿主进程本身不在沙箱内**（shim 只注入 shell 派生的子进程）。
   因此「宿主进程直接写盘」的工具（`write`/`edit`、`browser-use` 配置）完全不经过 staging。
5. **重解析点（junction/symlink）在真实磁盘上被真实创建**，shim 只做了路径字符串映射、
   未在打开前解析 reparse point → 经 junction 的写入被 NTFS 重解析到真实目标。

第 4、5 点是本次最重要的结构性发现：**沙箱保护的是「命令」而不是「会话」**，
且**「路径映射」不等于「重解析点解析」**。

---

## 3. 分域判定矩阵

| 域 | checkpoint 结论 | 最关键的 1–2 条 |
|---|---|---|
| **文件读写** `fs` (16) | OK 7 · FAIL 6 · BLOCKED 1 · FINDING 2 | **FS-07 junction 写穿真实磁盘（已确证）**；FS-11 staged-only 文件对所有目录枚举 API 不可见；FS-12 覆盖真实文件丢失 base 基线；FS-13 1657 条只展示 40 条且 `riskCounts` 与 `alerts` 自相矛盾（danger=0 vs 17 条 danger-change） |
| **浏览器** `browser` (9) | OK 1 · BLOCKED 6 · FINDING 2 | 本机无 Chrome、Edge 在开 DevTools 端口前崩溃（与 README「沙箱内起不了 Chromium」一致）；**BR-07 下载逃逸未验证 = 盲区** |
| **pip** `pip` (16) | OK 3 · N-A 4 · BLOCKED 2 · FAIL 3 · FINDING 4 | 镜像链路健康（阿里云 get-pip 200/1.9MB、`six` wheel 内联 sha256 与实测一致）；**根因是本机零可用 Python**（0 字节 Store 存根） |
| **node/npm** `node` (13) | OK 2 · FAIL 4 · BLOCKED 3 · FINDING 4 | npm 100% 不可用（元数据族 API 未走 overlay）；镜像与完整性链路本身正确（sha512/sha1 与 registry 一致） |
| **exe 安装** `exe` (8) | OK 2 · FAIL 2 · BLOCKED 2 · N-A 1 · FINDING 1 | 发行包可下载校验（sigcheck Authenticode Valid）；**进程创建不认工作区路径 → 装好的 exe 跑不起来**；宿主零改动 |
| **注册表** `registry` (11) | OK 3 · FAIL 5 · FINDING 3 | 255 个逐进程 hive → 跨进程不可见；`reg add` 成功但读不回；真实 hive 零写入 |
| **网络** `network` (9) | OK 6 · FINDING 2 · FAIL 1 | 出站/监听/端口全部开放、无 TLS 中间人；无网络命名空间隔离；FAIL 项是 staging 门而非网络 |
| **敏感文件** `sensitive` (9) | FAIL 4 · FINDING 5 | 读面全开放 + 三通道外发成功；写入隔离成立但**无任何实时提示** |

各域原始证据：[`fs`](_sandbox-tests/fs/results.json) · [`browser`](_sandbox-tests/browser/results.json) ·
[`pip`](_sandbox-tests/pip/results.json) · [`node`](_sandbox-tests/node/results.json) ·
[`exe`](_sandbox-tests/exe/results.json) · [`registry`](_sandbox-tests/registry/results.json) ·
[`network`](_sandbox-tests/network/results.json) · [`sensitive`](_sandbox-tests/sensitive/results.json)

---

## 4. 与项目自带测试的交叉验证

- `autotest.cmd --skip-audit`（本会话实测）：**12 套件通过 / 19 失败 / 1230 ok / 22 bad**。
  失败集中在「需要未受限会话」的沙箱段，根因是嵌套沙箱初始化 `EPERM mkdir` / `ENOENT copyfile`
  （`%TEMP%\dsh-stage-temp\…`）——与项目自身记录的残余 **R6「嵌套隔离不可用」**一致。
- 项目文档 `docs/沙箱边界实测矩阵.md` 已记录本次复现的**同类**残余：
  W5 硬链接（真实磁盘被改且不入审批面）。我的独立复核**证实 W5 与 W8 均存在**：
  文档 W8 记 junction 穿透「PASS（真实磁盘无产物）」，而本次实测**junction 写穿真实磁盘成立**
  （`C:\Windows\fs07-through.txt` 真实存在且无 overlay 副本）——**这是文档结论的实质性反转**，
  可能因早期测试用的 junction 目标在真实磁盘上不存在（我最初的复测即因此「看起来安全」）。
- 结论：本次 8 线程的发现与项目自身文档**方向一致**，但本次额外定位到
  **宿主写工具逃逸**与**执行门自检崩溃**两条文档未记录的缺陷。

---

## 5. 易用性评估（用户的第二个诉求）

按「一件事要几步 / 坑在哪 / 报错是否可理解」打分，★=好，✕=差。

| 操作 | 步骤数 | 报错可理解度 | 主要问题 |
|---|---|---|---|
| 确认「文件到底写没写进真实磁盘」 | 3 条命令 + 3 条通道 | ✕ | 沙箱内**无法自证**：PS 说成功、`cmd dir` 说没有、真实盘第三种答案。必须去读 `.dshstage\...\candidates\*.json` 才算地面真值 |
| 跑一条普通命令 | 1 | ✕ | `STAGING_WRITE_UNVERIFIED` 随机全量拒绝（约每 2 条 1 次），文案面向实现者，极易误判为「我的命令写错了」；建议：加锁/只探测本会话路径 + 文案改为「沙箱自检失败，请重试」 |
| 装一个 pip 包 | 不可能 | ✕ | 本机无 Python，但错误只表现为 `exit 9009`，没有「未安装 Python」的明确提示 |
| 装一个 npm 包 | 不可能 | ✕ | 报 `EEXIST`+`ENOENT` 自相矛盾（同一路径既存在又不存在），根因在 overlay 未覆盖 `stat`/`exists` |
| 在新目录里跑 npm | ≥3 | ✕ | 新建目录不能作 CWD，需 `npm --prefix` 绕过，且要知道这个「偏方」 |
| 装一个 exe | 不可能 | ✕ | 下载能成功，但进程创建不认工作区路径，必须手拼 `.dshstage\sessions\<id>\staged\fs\C\...` 才能执行 |
| 审批一次改动 | ≥4 | ✕ | `review.json` 1600+ 文件、`listed=40`、注册表行 0 条；混入 3.8 万行自噪声，人无法在其中找到需要决策的那几条 |
| 起浏览器做验收 | 不可能 | ✓ | `--doctor` 输出清晰（`DevToolsActivePort not found` + 路径清单），是本次唯一「报错好用」的地方 |
| 配国内镜像 | 1–2 | ✓ | `pip.ini`/`.npmrc` 直写有效且被 staging 捕获；但 npm 11 已不支持常用的 `disturl`/`electron_mirror`，网上通用配方失效 |
| 判断沙箱是否隔离成功 | ✕ | ✕ | 「PS 成功 + 真实盘无」这个信号被 3 类逃逸和多种静默失败污染，用户无法自己得出结论 |

**易用性结论**：当前设计把「暂存/候选」的复杂度**全部转嫁给了用户与 agent**——
用户看不到实时提示，取证要靠读内部目录，且失败模式（静默降级、通道矛盾、门误拒）
无法从错误信息中区分。这是本次最一致、跨全部 8 个域复现的问题。

---

## 6. 建议（按优先级）

1. **把宿主文件工具纳入通道判定**：`write`/`edit`/插件 FS 层必须与 shell 走同一 staging，
   否则「人工批准」语义在主通道上失效。同一问题适用于 `browser-use` 的配置写入。
2. **修 `review.json` 信噪比**：默认过滤 `__PSScriptPolicyTest_*`、`winstage-shim-selfcheck-*`、
   `.winstage-inject-*`、`shim.log`；`listed` 与 `totalFiles` 必须一致且可翻页；注册表行必须渲染出来。
3. **稳定执行门**：定位 PowerShell `TargetInvocation`→`AccessViolationException` 崩溃
   （7 份 WER 报告、签名一致）；门探测加会话级锁，失败时给出可重试的明确文案。
4. **补 overlay 语义**：`existsSync`/`statSync`/`lstat`/CWD 解析/`CreateProcess` 路径解析
   都要走 staging；修 `%ALLUSERSPROFILE%` 未展开。
5. **注册表 overlay 必须跨进程共享**（当前回退逐进程 hive 导致父子不可见）。
6. **明确写下「不提供的保证」**：读面全开放、敏感内容可外发、网络零限制、
   真实硬链接可建、宿主级工具不受管——这些必须写进用户可见的安全说明，不能只存在于代码注释。

---

## 7. 遗留物与盲区（诚实边界）

**真实磁盘残留（需宿主侧清理，沙箱内删不掉）**

| 路径 | 来源 | 清理方式 |
|---|---|---|
| `_sandbox-tests\_lead\hardlink-alias.txt` | Lead 硬链接复现（指向 `C:\Users\Administrator\.npmrc` 的真实硬链接） | 宿主 `cmd /c del /f "<该路径>"`（无害，不改 `.npmrc` 内容） |
| `C:\Users\Administrator\Documents\dsh-probe-nonexistent-dir\x.txt` | sensitive-tester 探针；**Lead 已用宿主只读通道确认真实存在**（内容 `probe`） | 宿主手动删除该文件与其父目录 |
| `C:\Windows\fs07-through.txt` | fs-tester junction 写穿探针；**Lead 已用宿主只读通道确认真实存在**（内容 `WRITTEN-THROUGH-JUNCTION`，24 字节，SHA256 `937E12F9…8876`） | 宿主手动删除（沙箱内经同一 junction 删除会崩溃 `exit 3762504530`，未生效） |
| `%USERPROFILE%\.config\browser-harness\**` | browser-use 自身写入（真实落盘，Lead 已复核） | 工具配置，可保留 |

**盲区（本轮未验证，不得当作通过）**

- BR-07「浏览器下载是否绕过文件沙箱」——因 Edge 起不来而**未验证**。
- junction 逃逸的**完整利用面**未穷尽：已确证「指向真实存在的目录」可写穿；写 System32、
  以及经 junction 的删除/重命名未测。
- WFP/网络策略层是否真的装过滤器——项目文档自述 `[未实测]`，本轮仅确认「实际仍可开 socket」。
- 嵌套沙箱（沙箱内再开沙箱）——本会话不可用（R6），所有依赖它的 19 个套件无法验收。
- `%ALLUSERSPROFILE%` 崩溃与执行门误拒的**因果链为推断**（证据充分但未用调试器确认）。
