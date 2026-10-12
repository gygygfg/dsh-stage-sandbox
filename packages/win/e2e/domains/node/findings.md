# WinStage 沙箱测试 —— Node/npm 域（node-tester）findings

- 会话：`session-eb7c901d-97ed-4f83-9096-33c97138c361`
- 工作区：`C:\Users\Administrator\Desktop\WinStageSandbox`
- 环境：node v24.21.0（`C:\Program Files\nodejs\node.exe`）、npm 11.19.0（`npm.ps1` shim）
- 状态计数：**OK 2 / FAIL 4 / BLOCKED 3 / FINDING 4 / N-A 0**（共 13 条，含 NODE-02b、NODE-F1、EX-01~03）
- 产物：`results.json`、`findings.md`、`executions.log`、`evidence/`

## 1. 一句话结论

**npm 域在本沙箱中不可用，但原因不是网络、不是国内镜像、也不是权限拒绝，而是「Node/libuv 的目录创建与元数据查询没有走 overlay」。**
镜像与 sha512 完整性链路经异通道验证是**健康**的（tarball 实际哈希与 registry 声明的 `integrity`/`shasum` 完全一致）；
npm 崩在 `cacache` 的 `mkdir`/`stat` 上，而这只是底层缺陷的第一个受害者。

## 2. 证据链（按重要性）

### F1【严重】沙箱内新建目录不能作任何子进程的 CWD
- `Test-Path <proj1>` = True（PS 通道看得见），但
  - PS 启动子进程 → `Program 'node.exe' failed to run: The directory name is invalid`
  - `cmd /c cd /d <proj1>` → `The system cannot find the file specified.`（exit 1）
  - `Start-Process -WorkingDirectory <new>` → `This command cannot be run due to the error: The directory name is invalid.`
  - Node `spawn(...,{cwd:<new>,stdio:'inherit'})` → statSync ENOENT + `process.chdir FAILED ENOENT`
- 矩阵（含工作区外 `%LOCALAPPDATA%\Temp\<new>`、真实已存在但本会话有 overlay 改动的目录）见
  `evidence/f1-cwd-matrix.md`。
- 根因假设：`CreateProcessW` 的 `lpCurrentDirectory` 由内核在**真实文件系统**上解析；overlay 只虚拟化文件
  API，既未为新目录建立真实目录项，也未 hook CWD 校验。
- 规避法：**CWD 留在真实存在的目录**，用 `npm --prefix <dir> install` / 绝对路径执行。**该规避法已实测有效**
  （npm 真的联网并命中镜像），但它只解决 F1，不解决下面 F2。

### F2【严重】Node 的 `stat` 家族看不见 overlay，`mkdir` 静默假成功
同一 Node 进程内：

| 操作 | 结果 |
|---|---|
| `fs.writeFileSync(overlay 新文件)` | OK |
| `fs.readFileSync(同一文件)` | OK |
| `fs.existsSync(同一文件)` | **false** |
| `fs.statSync/lstatSync/realpathSync(同一文件)` | **ENOENT** |
| `fs.statSync(真实磁盘的 PROTOCOL.md)` | OK（6275 字节） |
| `fs.promises.mkdir(tmp,{recursive:true})` | **返回 ok，但目录不存在** |
| 非递归 `mkdir` 于同一路径 | **EEXIST**（与上一条的 ENOENT 自相矛盾） |
| `fs.mkdtempSync(...)` | 返回路径，`existsSync` = false |
| `require(overlay 内的包目录)` | **OK** |

解释：写入族（`CreateFileW`）的调用被 hook，所以内容 I/O 走 overlay；
而元数据族（`GetFileAttributesExW` / `GetFileInformationByHandleEx`，libuv 经 `GetProcAddress` 动态解析）
未被 hook，于是 stat 查的是真实磁盘 → overlay 条目一律 ENOENT。
`cacache` 的写入流程正是 `mkdir(recursive) → stat → writeFile(tmp) → rename`，
两个环节都要求 `mkdir`/`stat` 语义一致，因此 npm 必然抛出
`EEXIST ... mkdir ...\_cacache\content-v2\sha512\6d\93` 紧跟 `ENOENT ... mkdir 同一路径`。

### F3【严重】执行门自检子进程崩溃导致全量拒绝 + 后端其它异常
`STAGING_WRITE_UNVERIFIED: ... outside-write-staged-not-real=fail (child-reported-ok=false
real-disk-has-file=false staged=not-found exit=<X>)`，其中 X 在不同时刻是
`2` / `3221225477 (0xC0000005)` / `4294901760 (0xFFFF0000)` / `3762504530 (0xE0434352)`
—— 探针自身在崩。另有 `EBUSY ... staged\fs\%ALLUSERSPROFILE%\...\WER\ReportArchive\...`
（staged 树中出现**未展开的字面量 `%ALLUSERSPROFILE%` 目录名**）与 2 次静默空输出。

### F4【中】网上通用的国内镜像配方在本机 npm 11.19.0 已失效
`npm config set disturl ...` / `npm config set electron_mirror ...` 均 exit=1：
``npm error `disturl` is not a valid npm option``。只能用「手写 `%USERPROFILE%\.npmrc`」的退路，
而 `.npmrc` 在**工作区外**，写完还要自己去做 staging 取证。

### F5【中】`review.json` 陈旧，人工批准界面看不到本会话改动
`review.json` 仍是 `generatedAt=2026-10-02T10:36:21Z`、`sessionId=dsh-host`、`candidates=[]`、
`riskCounts` 全 0；而 `sessions\<本会话>\candidates\` 已有 120+ 条候选（含 `.npmrc`、
`%USERPROFILE%\.dsh\.credentials.yaml`）。**协议第 4 条要求的风险分级（normal/outside/sensitive/danger）
在本次测试中取不到值。**

### 附带更正
`PROTOCOL.md` 记载「`stdio:'pipe'` 会 `EPERM`」；本机 Node v24.21.0 实测原始文本为
`ENOENT spawnSync C:\Program Files\nodejs\node.exe ENOENT`（`status=null`，`stdout` 未定义）。
`stdio:'inherit'` 与 `'ignore'` 均 `status=0` 正常。建议把文档里的 errno 改为「EPERM/ENOENT 视版本」。

## 3. 通过的部分（不要因为上面的结论就认为 npm 域全废）

| 项 | 结果 |
|---|---|
| NODE-01 环境取证 | OK：版本、registry/cache/prefix/globalconfig 全部拿到 |
| NODE-02 registry 镜像写入 + staging 捕获 | OK：staged `.npmrc` 出现（40 字节，mtime 1:19:06），candidates 记录 `op=create / before=absent / after=sha256:3fc62c79…`；宿主 2026/9/11 的文件未被覆盖 |
| 镜像域名 | OK：`npm http fetch GET 200 https://registry.npmmirror.com/is-odd 279ms`；`--prefix` 下也命中镜像 |
| 完整性链路（sha512/sha1） | OK（异通道）：tarball `https://registry.npmmirror.com/is-odd/-/is-odd-3.0.1.tgz`，2774 字节，实际 sha512-base64 == registry `dist.integrity`，sha1 == `dist.shasum` |
| Node 读取/写入 overlay 文件 | OK |
| `require` overlay 内的包目录 | OK（`{"ok":true,"tag":"reqprobe-from-staging"}`） |
| `spawn` + `stdio:'inherit'/'ignore'` | OK（status 0） |
| 不落缓存的 npm 命令 | OK：`npm -v` / `npm config get|list` / `npm ls -g` |

## 4. 易用性汇总表（本域）

| # | 摩擦点 | 严重度 | 表现 | 需要几步／多久 |
|---|---|---|---|---|
| 1 | 新建目录不能作 CWD | 极高 | 报错不提沙箱；`Test-Path` 却看得见该目录 | 正常 3 步流程在第 1 步断；需自行悟出 `--prefix` |
| 2 | Node stat 对 overlay 失明 / mkdir 假成功 | 极高 | `existsSync=false`、`mkdir` 返回 ok 但无目录、EEXIST 与 ENOENT 并存 | 需读 libuv 实现才能串联，7+ 步仍未装成 |
| 3 | npm 报错误导 | 高 | `Remove the existing file and try again, or run npm with --force` —— 照做只是换错误 | 额外 2~3 次无效尝试 |
| 4 | 门拒绝不可预期且无退出码 | 高 | 同一命令有时成功有时被拒；探针 0xC0000005 等 | 每次都要重试，无法区分「被拒」与「坏了」 |
| 5 | 国内镜像通用配方失效（npm 11） | 中 | `` `disturl` is not a valid npm option ``，不提示替代方案 | 需自行改手写 `.npmrc`（工作区外，还要取证） |
| 6 | `review.json` 陈旧、无风险分级 | 高 | 批准界面显示 0 改动，candidates 里却有 120+ | 无法完成协议第 4 条 |
| 7 | 假象：轻量 npm 命令全好 | 中 | `npm -v` / `config` / `ls -g` 正常，一 `install` 就崩 | 容易得出「npm 没问题，是网络/镜像的问题」 |
| 8 | PowerShell 把 npm 的 stderr 记成 NativeCommandError 红字 | 低 | `npm http fetch ...` 被当成错误渲染 | 干扰判断 |
| 9 | 取证本身无工具 | 中 | 要判定「有没有落宿主」，得手工比对 staged 路径 + candidates JSON | 每个结论多花 2~3 条命令 |

## 5. 建议

**给 DSH / WinStage（优先级从高到低）**
1. **补齐 hook 覆盖度**：除 `CreateFileW` 外，必须覆盖 `CreateDirectoryW` /
   `GetFileAttributesExW` / `GetFileInformationByHandleEx` / `SetFileAttributesW` / `MoveFileExW`，
   并且要覆盖 **动态解析（`GetProcAddress`）** 得到的函数指针 —— libuv 正是这么用的。
   否则 Node/Electron/大量工具会「写进去、看不见」。
2. **CWD 虚拟化**：`CreateProcessW` 的 `lpCurrentDirectory` 若指向 overlay-only 目录，应自动映射到
   真实可用的目录（例如 staging 的根），或至少在启动前把该目录在真实盘上**物化**出来。
   当前表现（进程直接起不来、报错不提沙箱）是最坏的形态。
3. **启动自检 + 显式告警**：探测被 hook 的 API 家族覆盖度，对已知不兼容的运行时给出
   「本沙箱不支持 Node/npm 的目录创建」这类明确提示，而不是让用户在 npm 的 EEXIST/ENOENT 里绕圈。
4. **修 review.json 的生成时机**：本会话 120+ 候选却 0 呈现，人工批准这条安全语义事实上是空的；
   并让候选带 `risk` 字段或让 review 能按需重建。
5. **修门的自检探针**：探针崩溃应降级为告警而不是全量拒绝；`%ALLUSERSPROFILE%` 字面量目录名说明
   路径展开有 bug；`EBUSY` 应跳过锁定的 WER 目录。
6. **提供取证工具**：`dsh stage ls <path>` / `dsh stage why <path>`，直接回答
   「这个路径在哪个通道可见、是 staged 还是 real、进了哪个 candidate」。

**给使用者（在 1~3 修好之前）**
- 需要跑 Node 脚本时：**CWD 保持在真实存在的目录**，文件用绝对路径传参，不要 `cd` 进新建目录。
- 不要用 `npm install`（会失败）；如果必须验证包完整性，绕开 npm：镜像取 packument 的
  `dist.integrity`，下载 tarball 后自己算 sha512-base64 比对（本报告已给出可复现步骤）。
- `npm config set disturl/electron_mirror` 在 npm 11 上无效，直接手写 `%USERPROFILE%\.npmrc`。

## 6. 测试遗留物与清理

| 遗留物 | 位置 | 是否落宿主 | 清理 |
|---|---|---|---|
| `.npmrc`（内容与原值相同） | `%USERPROFILE%\.npmrc` 的 overlay 版本 | 否（staged，candidates `op=create`） | 丢弃会话 overlay 即恢复；宿主文件未被改写 |
| is-odd tarball（2774 B） | `_sandbox-tests\node\evidence\is-odd-3.0.1.tgz` | 工作区内 | 可删 |
| npm 失败日志 ×2 | `%LOCALAPPDATA%\npm-cache\_logs\*.log` 的 overlay 版本 | 否（staged） | 丢弃会话 overlay |
| 探测目录/文件 | `_sandbox-tests\node\{proj1,reqprobe,mkprobe,cwdprobe-new,evidence,pnpm-cache?}` 及 `_sandbox-tests\{nodeprobe-*,psonly-dir,psdeep,psside-precreated,psside-precreated,written-by-node.txt,nodestat-probe.txt,mkdtemp-*,anodeprobe-*}`、`%LOCALAPPDATA%\Temp\winstage-cwd-probe` | 否（staged overlay）+ 部分由 write 工具直写真实工作区 | 工作区内的可删；staged 的随会话丢弃 |
| 全局安装 | 无 | 否 | **零遗留**（未写出任何 shim） |

> 说明：`_sandbox-tests\` 下的 `nodeprobe-*` / `psonly-dir` / `psdeep` / `psside-precreated` /
> `written-by-node.txt` / `nodestat-probe.txt` / `mkdtemp-*` 是 F1/F2 与目录探针**故意放在工作区根下一级**
> 的对照物（用来区分「真实父目录」与「staged 父目录」），超出 `_sandbox-tests\node\` 一条父级路径，
> 已在报告中逐条列出，可安全删除。
