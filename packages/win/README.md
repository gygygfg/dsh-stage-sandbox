# WinStageSandbox — Windows 暂存—候选—选择性提交沙箱

按《Agent 沙箱暂存—提交架构设计手册 v3.0》实现，面向 Windows + DeepSeek Harness（DSH）。

**核心思路**：把"隔离"和"暂存"合并成同一件事 —— 沙箱唯一可写根是**暂存树**，
真实工作区始终不被写入；沙箱内产生的变化冻结为**候选**，用户批准后才**逐文件**提交。

> **口径以代码为准**：测试套件的唯一权威是 `src/testrunner.ts`
> （现为 **58 个离线套件 + 4 个沙箱套件 + 1 段 `audit`**），全部以 `.ts` 为准，
> 遗留的 `.mjs` 已全部删除。完整入口见 [`docs/测试套件总览.md`](docs/测试套件总览.md)。

---

## 安装（DSH 插件）

```bash
dsh plugin --profile web add dsh-winstage-sandbox                  # npm（已发布时）
dsh plugin --profile web add github:gygygfg/dsh-winstage-sandbox   # 或直接从 GitHub
```

- **前置**：Windows 10/11；启动时做**环境监测**（非 Windows 或本会话无法建立受限令牌 ⇒
  **拒绝启动**，逃生口 `WINSTAGE_SKIP_ENV_GATE=1`）。
- **开关**：设置页可开关。关闭时文件面退回平台 `SandboxedFileSystem`，命令面在**装配期**
  交还平台 `pwsh-sandbox`（运行中切换需重启宿主）。详见 [`docs/插件启动-环境监测与开关保证.md`](docs/插件启动-环境监测与开关保证.md)。
- **shim**：发行包只带 C 源码；需要透明模式先 `node tools/fetch-toolchain.ts` 再 `node tools/build-shim.ts`。
- 发布说明见 [`PUBLISHING.md`](PUBLISHING.md)。

### 安装到非本仓工作区时：只配置 host 行的根（R41-G04 单源）

bundle patch（`dsh-plugin/cordis.patch.yml`）里的 `workspaceRoot` 现在是**空值**，不再带
任何开发机绝对路径。安装到别的机器/工作区时，profile 覆盖层**只需设置 host 行**：

```yaml
- id: winstage-sandbox
  config: { workspaceRoot: <你的工作区> }       # 唯一配置入口
```

`winstage-fs` / `winstage-shell` 没有显式写根时会从 host 行派生；显式覆盖仍然权威，但
显式值之间冲突会 fail-closed（`FS_STAGE_ROOT_DRIFT` / `WINSTAGE_SHELL_ROOT_CONFLICT`），
不会静默挑一个造成"暂存写到 A、快照发布在 B"。

根**缺失或不存在**同样 fail-closed：host 行抛 `WINSTAGE_WORKSPACE_ROOT_MISSING` /
`WINSTAGE_WORKSPACE_ROOT_NOT_FOUND`，fs 行抛 `FS_STAGE_ROOT_NOT_FOUND`；
不会回退插件安装目录或宿主 cwd。

---

## 1. 三条命令

```powershell
.\verify.cmd                   # 58 个离线套件关口（轻量、无报告；清单 = OFFLINE_SUITES）
.\autotest.cmd                 # 全量：离线 58 + 沙箱 4 + audit，写出 .t/test-report.json
.\autotest.cmd --skip-audit    # 只跑离线确定性测试（不需要未受限会话）
.\diag.cmd                     # 绑定表契约 + 完整 init（需未受限会话）
node tools\ebk-sandbox-test.ts # Windows E2E 测试台（需 docker + KVM，见 e2e/README.md）
```

**退出码**：`0` 无失败（含因机制边界跳过 audit）｜`1` 存在失败｜`2` 环境错误。

**运行时候选（R27 起显式化）**：sandbox 段需要 **DSH-as-node**（`ELECTRON_RUN_AS_NODE=1 <Harness.exe> autotest.ts`），
因为 ACL 后端 `@deepseek-ai/dsh-sandbox-windows-acl` 只在 Harness 的 node_modules 里。plain node 下 `autotest` 会
**显式跳过 sandbox 段**（打印跳过清单与原因）、离线照跑、退出码 **2（环境错误）** —— 不再产生 3 个"ACL 后端加载不到"的假红。

**三种总判定**：`PASS` ｜ `PASS-OFFLINE-ONLY`（离线全通过，audit 因当前会话受限而跳过 ——
是机制边界不是失败，报告中写入 `guaranteesNotProvided`）｜`FAIL`。

> **为什么是 `.cmd` 包装**：受限令牌下 `stdio:'pipe'` 走命名管道，客户端打开请求需要受限 SID
> 未被授予的写权限，子进程创建直接 EPERM。运行器改用**文件描述符重定向**捕获输出绕开命名管道，
> 这正是 `run.cmd` 存在的原因（残余边界 R10）。

### 1.1 手动调用

```powershell
.\run.cmd src\cli.ts init    --workspace .\.t\ws
.\run.cmd src\cli.ts exec    --workspace .\.t\ws -- powershell -NoProfile -Command "ni new.txt"
.\run.cmd src\cli.ts status  --workspace .\.t\ws      # 状态 / 待审 / diff
.\run.cmd src\cli.ts apply   --workspace .\.t\ws --paths new.txt   # 选择性提交
.\run.cmd src\cli.ts audit   --workspace .\.t\ws      # 从沙箱内部发起真实攻击探针
```

### 1.2 自动测试服务（`testservice.cmd`）

收到 HTTP 请求就跑一轮测试并返回结果。**它是本机代码执行入口**，安全边界不是可选项：

| 边界 | 实现 |
|---|---|
| 只监听回环 | 默认 `127.0.0.1` 并校验 `remoteAddress`，否则 403 |
| 强制令牌 | 启动时打印随机令牌；除 `/health` 外全部要求 `Bearer` |
| 套件白名单 | 只接受固定套件 id，**绝不接受任意命令或脚本路径** |
| 串行执行 | FIFO 队列 + 单一泵，避免两轮争用同一份 `.t` 工作区 |

端点：`GET /health` `/suites` `/jobs` `/jobs/<id>` `/jobs/<id>/log` `/report/latest`、
`POST /run` `/jobs`、`DELETE /jobs/<id>`。客户端：`node src\testclient.ts --token <令牌> [--only …]`。

---

## 2. 架构

```
┌────────────────────────────────────────────────────────────────────┐
│ 逻辑视图（对 AI 唯一可见的世界）                                     │
│   read_file / write_file / edit_file / delete_file / list_files     │
│   / search_files                            → src/tools.ts          │
├────────────────────────────────────────────────────────────────────┤
│ 统一工作区服务                                 → src/workspace.ts    │
│   基线快照 · 逻辑状态(暂存/删除/损坏) · 目录合成 · 路径映射          │
│   候选冻结(before+after) · 选择性应用 · 陈旧基线保护                 │
│                                              ↓ src/store.ts         │
│   内容寻址 blob 存储（自动去重，候选两侧不可变）                     │
├────────────────────────────────────────────────────────────────────┤
│ 受信启动器（Windows 原生隔离）                  → src/executor.ts    │
│   WRITE_RESTRICTED 受限令牌（限制 SID 交集 = 唯一可写根）            │
│   + Low 完整性标签（no-write-up 兜底）                              │
│   + deny FILE_DELETE_CHILD（关闭父目录删除权旁路）                  │
│   + Job Object KILL_ON_JOB_CLOSE（进程树回收）                      │
│   + 环境变量从允许清单重建（绝不 merge 父环境）                     │
├────────────────────────────────────────────────────────────────────┤
│ 能力探测 / 网络策略 / 进程缓解 / 资源上限 / 注册表暂存 / 审计        │
│   capability.ts · netpolicy.ts+wfp.ts · mitigations.ts · limits.ts  │
│   registry-stage.ts · registry-guard.ts · audit.ts                  │
└────────────────────────────────────────────────────────────────────┘
```

### 目录地图

| 目录 | 职责 |
|---|---|
| `src/` | 引擎：工作区/存储/启动器/能力探测/网络/缓解/上限/注册表暂存/审计/测试运行器 |
| `plugin/` | **Cordis 规范入口**（真 schemastery Config + 命令/审批/策略接线）—— 重构目标形态 |
| `dsh-plugin/` | DSH 接入实现：`ctx.fs` / `ctx.shell` / 审阅服务 / 客户端悬浮窗 / `cordis.patch.yml` |
| `shim/` | C 注入层源码（`src`/`include`/`injector`/`probe`/`audit`）；构建产物在 `shim/out/`（不入库） |
| `patches/` | DSH 宿主的可重放补丁包（P1/P2/P3，**默认不应用**）+ 原样副本 `pristine/` |
| `tools/` | 构建/基线封印/补丁工具/shim 闭环节（受源码封印，见 §5） |
| `tests/` | 离线关口 58 套件 + 沙箱 4 套件 + 元测试与治理套件 |
| `e2e/` | Windows 实测台（docker + KVM + Windows guest）；`e2e/domains/` 是一次性归档 |
| `docs/` | 设计与规范（历史轮次报告已在 R33 后清理，git 历史可追溯；见 `docs/README.md`） |

---

## 3. 档位与实现状态（诚实区分"已实现 / 已探测 / 未实现"）

| 档位 | 机制 | 读取面 | 网络面 | 实现状态 |
|---|---|---|---|---|
| `T0` appcontainer | AppContainer 能力令牌 + Job + Low IL + ACL | ✅ 收敛 | ✅ 默认阻断 | 隔离已 `[实测]` 生效（`proven=true`）**且已接进执行器**；但默认档位是 `T1`，只有显式 `tier:'T0'` 才走 T0 |
| `T1` restricted-token | WRITE_RESTRICTED + Job + Low IL + ACL | ❌ | ❌ | ✅ **已实现并实测**（默认档位） |
| `T2` acl-only | 仅 ACL 写边界 | ❌ | ❌ | ✅ 已实现（降级路径） |
| `T3` none | 无可用原语 | — | — | ✅ **拒绝执行**（fail-closed） |

档位由 `selectTier()` 依据**真实 Win32 调用结果**选择，不据文档推断。

| Windows 原语 | 状态 |
|---|---|
| **Restricted Token**（WRITE_RESTRICTED） | ✅ 已实现并实测 |
| **ACL**（DACL + deny `FILE_DELETE_CHILD` + Low IL） | ✅ 已实现并实测 |
| **Job Object**（`KILL_ON_JOB_CLOSE`） | ✅ 已实现并实测 |
| **AppContainer** | ✅ 运行期实测生效并已接线；默认档位仍 `T1`（见上表） |
| **WFP**（网络过滤） | ⚠️ 结构/策略层已实现且 OFFLINE 档位 fail-closed；**真实安装 `[未实测]`** |

---

## 4. 已知残余边界（必须与任何"通过"一起读）

完整清单见 [`docs/Windows功能开启清单.md`](docs/Windows功能开启清单.md)（R1–R17 与 R42）。最关键几条：

- **R1 读取面不收敛**：本后端限制写/删，**不限制读**。读取收敛只能靠 AppContainer（默认档位是 `T1`）或工具层硬拒绝清单。
- **R2 网络面不收敛**：网络策略层存在且 OFFLINE fail-closed，但本机未安装真实过滤器 ⇒ 沙箱内仍可开 socket。
- **R6 嵌套隔离不可用**：已受限进程无法再建受限令牌 ⇒ 沙箱**必须由未受限宿主进程建立**。
- **R7 环境块需运行时注入**：依赖包的受限 spawn 固定传 `lpEnvironment=NULL`（违反手册 #8.3）；本实现替换绑定表注入显式环境块，结构不符时 **fail-closed 拒绝启动**。
- **R42-GIT（日常可用性）**：`.git`/`.hg`/`.svn`/`node_modules`/`.venv` 以 **junction 直连真实盘**（不复制内容）—— 否则沙箱内 `git status` 报 `fatal: not a git repository`、node/pnpm/测试解析不到依赖。代价：沙箱内 `git add/commit`、`pnpm install` 会**直接写真实** `.git`/`node_modules`/`.venv`，不经过暂存/候选/审批；用户内容（源码、数据）仍走暂存。命令 cwd 仍是工作副本路径（`Get-Location` 可见），这是透明暂存的残余。另：沙箱 shell 通过 `GIT_CONFIG_PARAMETERS` 注入 `core.excludesFile`，把 `fs/`、`wo/`、`reg/`、`.winstage-*`、`shim.log` 等**沙箱内部条目**从 git 视图排除，`git add -A` 不会把它们提交进用户仓库。
- **R42-DNS（网络设备放行）**：shim 的 `NtCreateFile` 对非文件系统设备命名空间（`\Device\Afd`/`Nsi`/`KsecDD`/`CNG`/`Tcp`/`Udp`/`Ip`/`RawIp`/`RasAcd`）放行；否则 `getaddrinfo`、socket、TLS 会在沙箱内失败。磁盘/卷/文件系统设备仍 fail-closed，普通文件路径的暂存/遮蔽规则不变。
- **R43（shell cwd 虚拟化，PowerShell 层）**：命令实际仍在暂存工作副本执行，但 `Get-Location` / `pwd` / `$PWD` / `Set-Location` / `Push-Location` / `Pop-Location` 都以**真实工作区根**呈现；`cd <真实工作区绝对路径>` 会被映射回暂存副本，不会逃出暂存树。残余：`cmd /c cd`、Python `os.getcwd()`、Node `process.cwd()`、`Resolve-Path`/`Get-Item .FullName` 与子进程里的绝对路径仍会看到暂存路径；嵌套 `powershell -File` 不会继承这层包装（它只包住 DSH 直接执行的那一个 PowerShell 进程）。

---

## 5. 改动闸门（改任何受封印文件前必读）

1. `tsc --noEmit -p tsconfig.json`
2. 跑 `node tests\suite-wiring.ts` 与 `node tests\baseline-integrity.ts`
3. 增删受封印文件后：`node tools\baseline-sha256.ts --write` → **复核清单 diff** → `--check`
4. 新增套件必须**同时**登记进 `src/testrunner.ts::OFFLINE_SUITES` 与 `verify.cmd` 的 `for` 列表

**源码封印**（`docs/源码基线.sha256`）：收录面是 `src/*.ts`、`tests/*.ts`、`dsh-plugin/*.ts`、
`plugin/*.ts`、`tools/*.ts`、`e2e/**/*.ts` 与四个根入口（`autotest.ts`/`verify.cmd`/`run.cmd`/`testservice.cmd`）。
改了任一受封印文件 ⇒ 关口变红，直到有人**有意识地**重新生成清单；**清单 diff 就是"改了什么"的可复核记录**。
清单缺失/为空**默认判红**（fail-closed），只有显式逃生口 `WINSTAGE_ALLOW_UNSEALED=1` 才 SKIP，且关口一律剥掉它。

**两个治理套件**（不可删，删了关口就塌）：
- `tests/suite-wiring.ts` —— 把"注册表漂移"变成断言：解析 `verify.cmd` 的 `for` 列表并与 `OFFLINE_SUITES` 逐项比对、检查所有 `.cmd` 纯 ASCII（R11）、`KNOWN_UNREGISTERED` 无僵尸条目。
- `tests/baseline-integrity.ts` —— 源码封印守门：清单与磁盘逐条哈希；**无豁免**。

---

## 6. DSH 集成：暂存审批悬浮窗

把本沙箱接进 DSH，使 **DSH 自己的 `write`/`edit` 工具也落暂存树**，并在输入框上方给出
「待审文件 + 逐文件 diff + 批准/拒绝」的悬浮窗。装配与数据通路、实测证据、已知崩溃风险
（在线切换该 bundle 会让宿主进程退出）见 [`docs/DSH集成.md`](docs/DSH集成.md)。
`/winstage [list|diff|approve|reject|refresh]` 是人工侧的批准入口。

## 7. DSH 补丁工具包（`patches/dsh/`）：**默认不应用**

本机 DSH 是安装版（运行时在 `resources/app.asar`），手工改它必然**不持久 / 会错位 / 不可证伪**。
因此三处修复被做成"**机器可读清单 → 可重放工具 → 会红的守门测试**"三段式：

```powershell
node tools\dsh-patches.ts --check         # 默认动作：逐条判定"未应用/已应用"
node tools\dsh-patches.ts --emit-patches  # 由清单重新生成 patches\dsh\*.patch
node tests\dsh-patch-guard.ts             # 守门：现场哈希必须恰好是 before 或 after
```

每条补丁的完整说明（问题 / 精确锚点 / 改法 / 上游包路径 / 已验证 vs `[未验证]`）见
[`patches/dsh/README.md`](patches/dsh/README.md)。

---

## 8. 文档导航

- 现行设计与规范：[`docs/README.md`](docs/README.md)
- 测试入口与套件清单：[`docs/测试套件总览.md`](docs/测试套件总览.md)
- 修改流程规范：[`docs/项目规范-测试与修改流程.md`](docs/项目规范-测试与修改流程.md)
- Windows E2E 测试台：[`e2e/README.md`](e2e/README.md)
- 历史轮次与一次性记录（**不代表现行口径**）：git 历史（round10–round32/archive 已在 R33 后清理）
