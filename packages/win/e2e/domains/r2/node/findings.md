# WinStage 沙箱第二轮实测 —— 域：node（Node / npm / pnpm 安装 + 完整性 + 国内镜像）

- 会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 测试线程：node 域（独立复验，8 线程并行）
- 时间：2026-10-03 17:45 – 20:20 (+08:00)
- 上一轮对照：`_sandbox-tests\node\`
- 产出目录：`_sandbox-tests\r2\node\`

---

## 0. 一句话结论

**npm 不是「100% 不可用」，而是「可用面很窄且默认配置必失败」。** 本轮把上一轮的
`writeFileSync 成功但 existsSync=false` + `cacache EEXIST/ENOENT 双错` **判定为已不复现**
（现在是干净的 fail-closed EPERM）。真正的阻塞点收敛为三条：

1. **shim 化进程的 CWD 被强制重定向到 stageRoot**（overlay 根，且是唯一可写区）；
2. **工作区绝对路径 / 工作区外路径一律 EPERM**，而 `%LOCALAPPDATA%\npm-cache` 正是工作区外；
3. **`fs.realpath` 未解析 reparse point** → pnpm 的 symlink 布局对 node 不可用（静默降级）。

| 目标 | 判定 |
|---|---|
| npm 连通性 / 镜像 | **OK**（npmmirror，ping 278ms，tarball integrity 与官方一致） |
| npm 默认配置可用性 | **FAIL/BLOCKED**（EPERM on `npm-cache\_cacache\tmp`） |
| npm 重定向 cache 后 | **OK**（view / install / ci / cache verify 全通） |
| 装进**用户项目目录** | **BLOCKED**（EPERM，工作区绝对路径不可写） |
| 装进 **stageRoot（cwd）** | **OK**（`npm install ms` → added 1 package，require 可用） |
| pnpm | **FAIL**（报成功，require 失败：junction realpath 未解析） |
| 隔离（真实工作区污染） | **OK**（零污染，仅进候选，全部 risk=normal） |
| 逃逸 | **未观察到** |

---

## 1. 结论表

| ID | 标题 | 状态 | 通道 | 关键证据 |
|---|---|---|---|---|
| ND-01 | npm 配置 / 镜像 / ping | OK | PS | ping PONG 278ms；registry=npmmirror |
| ND-01b | `npm view`（默认 cache） | BLOCKED | PS | `EPERM ... npm-cache\_cacache\tmp\***` |
| ND-01c | `npm view --cache=<可写>` | OK | PS | `version=2.1.3` + integrity |
| ND-02 | Node FS 语义矩阵（工作区绝对路径） | BLOCKED | PS/STAGE/HOST | 读全通、写全 EPERM(-4048) |
| ND-02b | 复验上一轮结论 | OK（**已改善**） | PS/STAGE/HOST | 未复现幻影写；无 EEXIST+ENOENT |
| ND-02c | CWD 被重定向到 stageRoot | FAIL | PS/HOST | `process.cwd()`=stageRoot |
| ND-02d | stageRoot = 唯一可写面 | FINDING | PS/STAGE/HOST | stageRoot 写成功；其余 EPERM |
| ND-02e | overlay 元数据不一致 | FINDING | PS/STAGE | Test-Path=False 但已暂存且在候选 |
| ND-03 | child_process stdio 矩阵 | FAIL | PS | pipe/exec* EPERM；inherit/ignore OK |
| ND-04 | npm install → 工作区 | BLOCKED | PS/HOST | EPERM on `app\package-lock.json` |
| ND-04b | npm install → cwd(stageRoot) | OK | PS/STAGE/HOST | added 1 package；require=2s |
| ND-04c | npm 全链路（可写 temp） | OK | PS/HOST | lock+require 均可用 |
| ND-05 | 完整性独立校验 | OK | PS/STAGE | sha512 三方一致；sha256 记录 |
| ND-06 | cache verify / npm ci / --prefix | FAIL（默认） | PS | 默认 cache EPERM unlink |
| ND-07 | pnpm 对比 | FAIL | PS/STAGE/HOST | 报 +3 成功，require MODULE_NOT_FOUND |
| ND-08 | 隔离面 / 候选面 / 风险分级 | OK | STAGE/HOST | normal 2879 / outside 15 / sensitive 1 |
| ND-09 | 工作区外安装（D:、%TEMP%） | BLOCKED | PS/HOST | Access denied；无逃逸 |
| ND-10 | 易用性总评 | FINDING | 全部 | 理想 1 步，实际 3 步 |
| ND-11 | 环境不稳定（gate/env/会话 ID） | FINDING | PS | env 变量中途变空 |

状态统计：**OK 7 · FAIL 4 · BLOCKED 4 · FINDING 4 · N-A 0**（共 19 项）

---

## 2. 三条通道各自的真相

本轮 `read`/`glob` 工具（HOST）与 `$env:WINSTAGE_STAGE_ROOT` 下 overlay（STAGE）同时可用，
交叉验证得到一份一致的沙箱模型（**这一模型是理解全部 node 现象的关键**）：

```
shim 化进程（pwsh / cmd / node / npm / pnpm）
  ├─ CWD            = <stageRoot>          ← 被强制重定向，无论调用者 cwd 是什么
  ├─ 相对路径        → 解析到 <stageRoot>\\<rel>       ⇒ 可写，落 overlay
  ├─ 绝对·工作区内路径 → 解析到真实工作区                ⇒ 读 OK(read-through)，写 EPERM
  ├─ 绝对·工作区外路径 → 真实绝对路径                    ⇒ 写 EPERM
  └─ %TEMP%         = ...\\Temp\\dsh-stage-temp\\<每命令唯一 uuid>  ⇒ 仅本命令可写
```

- **STAGE**：overlay 有两种布局 —— 工作区相对写入镜像到 `<stageRoot>\<rel>`；
  绝对路径写入镜像到 `<stageRoot>\fs\<drive>\<abspath>`（shim 日志逐条记录
  `CreateFileW staged(write) <stageRoot>\fs\C\...`）。
- **HOST**：`<stageRoot>` 在 `passthrough` 列表中 → 其内容**直接落真实磁盘**。
  因此 stageRoot 内的 `node_modules` 是真实文件，但位于 `.dshstage` 内，不算工作区污染。
- **通道矛盾（如实记录）**：`...\r2\network\probe-x.txt` 已暂存且在 review.json 候选中，
  但 `Test-Path` 对其真实路径返回 **False**（ND-02e）。会话早期还有一个约 5 分钟的窗口，
  existence API 与 enumeration API 结论相反（现已不可复现，重试变为 Access denied）。

---

## 3. 核心复验：上一轮结论是否仍成立

| 上一轮结论 | 本轮复验 |
|---|---|
| `writeFileSync` 返回成功但 `existsSync=false`、`statSync=ENOENT` | **不复现**。写失败现在明确抛 `EPERM: operation not permitted`（errno -4048），随后 `existsSync=false` 与之一致，无幻影状态。 |
| cacache 必报 `EEXIST` + `ENOENT` 双错 | **不复现**。本轮是单一错误 `EPERM ... npm-cache\_cacache\tmp\***`，不再自相矛盾。 |
| npm 在沙箱内 100% 不可用 | **不成立（重要修正）**。`npm ping`、`npm config *`、`npm view`（带 --cache）、`npm install`（带 --cache 且目标可写）、`npm ci`、`npm cache verify`、`npm pack` **全部成功**。不可用的是**默认配置**与**工作区目标**。 |

结论：上一轮描述的缺陷在**当前环境已收敛为 fail-closed**，这是一个明确改善；
但可写面收缩到「stageRoot + 本命令 temp」，导致默认配置下的 npm/pnpm 仍然不可用。

---

## 4. TOP 发现（含根因链）

### 4.1 【最高价值】`fs.realpath` 未 hook → pnpm 静默降级（FAIL）

```
pnpm add is-odd@3.0.1   →  ✅ "Packages: +3 ... Done in 2.8s" exit=0
node -e require('is-odd')(3)
                        →  ❌ MODULE_NOT_FOUND: Cannot find module 'is-number'
                             requireStack: ...\node_modules\is-odd\index.js
```

根因链（逐环取证）：

1. `is-number` **确实在真实磁盘上**：HOST glob 命中
   `.pnpm\is-number@6.0.0\node_modules\is-number\package.json`；
2. `require` 该目录 → `D1_OK_isnumber_direct`；经 junction 路径 require → `D2_OK_via_junction`；
3. PS 侧能看到 junction 目标：`Get-Item node_modules\is-odd` → `.Target = ...\.pnpm\is-odd@3.0.1\node_modules\is-odd`；
4. **但 node 侧 `fs.realpathSync(node_modules\is-odd)` 返回自身**，未解析 reparse point
   （`D4_REALPATH=...\staged\node_modules\is-odd`，D5 同）；
5. 于是 node 的模块解析把 `is-odd` 当作真实目录，转去
   `<stageRoot>\node_modules\is-number` 找依赖 —— 该路径不存在（顶层只有 `is-odd`、`ms` 两个 junction）
   → `MODULE_NOT_FOUND`。

**为什么 npm 没事**：npm 的常规安装使用扁平的真实目录 `node_modules`，不依赖 reparse point；
pnpm 的核心设计恰恰是 `.pnpm\<ver>\node_modules\...` 虚拟存储 + junction，因此首当其冲。
**危害**：用户拿到的是「安装成功」的假象，故障推迟到运行时才爆，且报错完全不指向沙箱。

### 4.2 CWD 被强制重定向为 stageRoot（FAIL，兼具「能用」与「误导」两重性）

`process.cwd()` 与 `[Environment]::CurrentDirectory` 都返回 stageRoot，即便调用者 cwd 是工作区；
且 node 子进程内 `process.env.WINSTAGE_STAGE_ROOT === null`（无法自查）。
副作用是：
- ❌ 用户在项目目录里 `npm install` → npm 把 stageRoot 当项目根；
- ✅ 意外好处 —— 因为 stageRoot 可写，**裸 `npm install ms` 反而成功**（ND-04b），
  但包装进了 overlay，用户的目录里什么都没有。

### 4.3 默认 npm cache 只读 → 默认体验 100% 失败（BLOCKED）

`npm ping` 通（PONG 278ms）会强烈暗示「npm 可用」，但紧接着 `npm view` / `npm install`
即 `EPERM ... npm-cache\_cacache\tmp\***`。`%LOCALAPPDATA%\npm-cache\_cacache` 可读、不可写。
最自然的自救手段 `npm config set cache <path>` **也失败**（要写工作区外的 `.npmrc`）。
唯一出路是每条命令显式 `--cache=<可写路径>`，且该路径每命令 uuid 都变（缓存永远冷）。

### 4.4 child_process：pipe 全灭，exec 家族整体不可用（FAIL）

| API | 结果 |
|---|---|
| `spawn` stdio:'pipe' | ❌ `EPERM: spawn EPERM` |
| `spawn` stdio:'inherit' | ✅ code=0（子进程确实执行，'CHILD-OUT'/'CHILD-ERR' 出现） |
| `spawn` stdio:'ignore' | ✅ code=0 |
| `spawnSync` 'pipe' | ❌ `error=EPERM` |
| `spawnSync` 'inherit' | ✅ status=0 |
| `execSync` | ❌ `EPERM: spawnSync C:\WINDOWS\system32\cmd.exe EPERM` |
| `exec` / `execFile` | ❌ `EPERM` |

`exec*` 硬编码 pipe ⇒ **整体不可用**。大量构建工具、`postinstall`、`node-gyp`、
以及任何 `execSync('git ...')` 都会挂。另：PowerShell 侧 `node ... | ForEach-Object`、
`cmd /c ... | Select-Object`、`Get-Location`/`$PWD.Path` 多次**挂起到超时**，
`cmd.exe` 多次 `failed to run: Access is denied`。

### 4.5 完整性校验：镜像可信（OK）

三方一致，是本次最干净的一条链路：

```
registry dist.integrity  sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==
package-lock integrity   同值
本地重算 ms-2.1.3.tgz     同值  (2967 bytes, from registry.npmmirror.com)
SHA256                   f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6
```

npmmirror 提供的 tarball 与官方 `dist.integrity` 完全吻合 → **国内镜像可信**。

### 4.6 隔离有效，但审批面噪音极大（FINDING）

- 真实工作区**零污染**：`ws\node_modules` / `package.json` / `package-lock.json` 在 HOST 侧均为 False；
- 一次 `npm install ms` 往审批面塞 **5 条 node_modules + 1 条 package-lock.json**，全部 `risk=normal`；
- review.json：`normal 2879 / outside 15 / sensitive 1 / danger 0`，`alerts=[]`；
- 噪音来源：`__PSScriptPolicyTest_*.ps1/.psm1` **188 条**（每次 pwsh 调用都产生）、
  `.dsh-selfcheck-*` 44 条、`Windows\Temp` 40 条。

### 4.7 无逃逸（OK）

`D:\winstage-r2-node` 与 `%TEMP%` 固定路径写入均 `Access denied`，HOST 侧确认文件不存在。
跨卷写入被 fail-closed 正确拦截，未观察到上一轮担心的逃逸形态。

---

## 5. 易用性 TOP 3

1. **「成功」不可信（最严重）**
   pnpm 打印 `+3 packages / Done in 2.8s` 却产出不可用的 node_modules；npm 打印
   `added 1 package` 但装进了 overlay，用户项目里没有。**两种包管理器都会给出误导性的成功信号。**
   → 建议 DSH 在 install 类命令后校验 `require` 可达性，或至少提示「安装目标 = 暂存根」。

2. **根因提示缺失**
   所有失败都是裸 `EPERM ... 你可能没有权限 / 被杀毒软件锁住`（npm 自带文案），
   完全没提「沙箱不允许写工作区外路径」「CWD 已被重定向」「请用 --cache=」。
   与上一轮相比报错**文本本身**更清晰了（单一 EPERM + 明确 path，不再是 EEXIST+ENOENT 自相矛盾），
   但**指向根因**这一步仍然缺失。→ 建议在 EPERM / errno -4048 上追加一句根因与修法。

3. **可写面与 CWD 全靠试错**
   定位「哪里能写」用了 4 次不同路径的写入实验；`WINSTAGE_STAGE_ROOT` 中途还变成空。
   → 建议 `dsh stage paths`（列出可写根）、`dsh stage ls`（列出 overlay 改动）、
   并保证 shim 环境变量在子进程全生命周期稳定。

**步数对比**：协议问「从想装一个 npm 包到成功共几步」——
理想 **1 步**（`npm install ms`，确实成功）；用户预期的 1 步 **必然失败**；
可预期的成功需要 **3 步**（换目标 → 重定向 cache → 接受装在 overlay）。

---

## 6. 建议（按优先级）

1. **修 `fs.realpath`/`GetFinalPathNameByHandle` 的 hook**，让 reparse point 正确解析 —— 这是
   pnpm（以及一切 symlink 型包管理器 / monorepo link / `npm link`）能否工作的前提。
2. **显式化 CWD 语义**：要么不要把 CWD 重定向到 stageRoot，要么在文档与 `npm config list` 式输出中
   明确提示；最好提供 `dsh stage pwd`。
3. **默认把 npm/pnpm cache 指到会话 overlay**（`npm_config_cache` / `pnpm_config_store_dir` 环境变量），
   消除「默认必失败、必须手工 --cache」这一硬伤。
4. **在 EPERM/errno -4048 上追加根因提示**，避免用户按 npm 文案去查权限/杀毒。
5. **过滤审批面噪音**（PowerShell policy-probe、.dsh-selfcheck、.winstage-run-*）。
6. **统一 existence 与 enumeration 的 overlay 视图**（ND-02e 的矛盾）。
7. 清理 `%TEMP%\dsh-stage-temp` 下的陈留目录（本轮观察到 **368 个**，最老 09/28）。

---

## 7. 测试遗留物

| 位置 | 内容 | 是否真实磁盘 | 清理状态 |
|---|---|---|---|
| `<stageRoot>\node_modules\ms\`、`package.json`、`package-lock.json` | ND-04b 的 npm 安装产物 | 是（passthrough） | 未清理，已进入 review.json 候选（risk=normal），**未 apply** |
| `<stageRoot>\node_modules\is-odd\`、`.pnpm\`、`.pnpm-store\v10`、`.ignored\` | ND-07 的 pnpm 安装产物 | 是（passthrough） | 未清理，同上 |
| `<stageRoot>\nm\`、`writetest.txt` | ND-02d 可写面探针 | 是（passthrough） | 未清理 |
| `<stageRoot>\fs\C\Users\...\_sandbox-tests\r2\node\{app,evidence}\` | 会话早期 `New-Item` 的 overlay 镜像 | 仅 overlay | 未清理 |
| `%LOCALAPPDATA%\Temp\dsh-stage-temp\<uuid>\*` | 各次 npm/pnpm 安装与脚本产物 | 是 | 未清理（uuid 目录共 368 个，非本线程独有） |
| `_sandbox-tests\r2\node\{fsmatrix.mjs, childproc.mjs, results.json, findings.md, executions.log, evidence\}` | 本线程产出 | 是（HOST write 工具） | **保留（交付物）** |
| `_sandbox-tests\r2\node\{app,probe,evidence}\.host-created`、`evidence\host-marker.txt` | 用于在真实磁盘建立目录的 HOST 标记 | 是 | 保留（说明用） |

**未执行**：`flatten` / `apply` / `approve` 或任何把改动提交到宿主真实工作区的操作。
**未修改**：`.dshstage` 的任何 bookkeeping 文件（review.json / queue.json / manifest.json 只读）。

---

## 8. 相关文件

- `results.json` —— 机器可读，19 项 checkpoint
- `executions.log` —— 逐条命令 + 退出码 + 关键原始输出
- `evidence/nd01-npm-config.txt`、`evidence/nd01b-view-default-cache.txt`、`evidence/nd01c-view-with-cache.txt`
- `evidence/nd02-fsmatrix-absolute.json`、`evidence/nd02-pwsh-fs-apis.txt`、`evidence/nd02d-writable-surface.txt`、`evidence/nd02e-overlay-inconsistency.txt`
- `evidence/nd03-childproc.json`
- `evidence/nd04-workspace-install.txt`、`evidence/nd04b-natural-install.txt`、`evidence/nd04-install-integrity.txt`
- `evidence/nd05-hashes.txt`
- `evidence/nd06-cache-ci.txt`
- `evidence/nd07-pnpm.txt`
- `evidence/nd08-review-surface.txt`
- `evidence/nd09-outside.txt`
- `evidence/nd10-usability.txt`
- `evidence/nd11-env-instability.txt`
- 脚本：`fsmatrix.mjs`（ND-02 矩阵）、`childproc.mjs`（ND-03 矩阵）
