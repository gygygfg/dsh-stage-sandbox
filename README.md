# dsh-stage-sandbox

> 跨平台 **dsh 暂存沙箱** monorepo：让 AI 的写操作先落进**暂存区**、冻结成**候选**，
> 经用户**逐文件审批**后才提交到真实工作区。

本仓把两个**独立实现**的 dsh 沙箱插件合并进同一个工作区（**各自 git 历史完整保留**）：

| 包 | 平台 | 隔离机制 | 状态 |
|---|---|---|---|
| [`packages/win`](packages/win) | Windows | 受限令牌（WRITE_RESTRICTED）+ ACL + Job Object + AppContainer + C shim（file/reg IAT hook）+ 注册表暂存；DSH 审阅悬浮窗 | ✅ 已实现并实测 |
| [`packages/linux`](packages/linux) | Linux | bubblewrap + Landlock + seccomp + cgroup v2 + overlayfs；dry-run/commit 控制面 + CAS 发布 | ✅ v2.3 已实现 |
| [`packages/core`](packages/core) | 跨平台 | 共享 PAL（平台抽象层）契约与控制面接口 | ⚠️ **起步为占位**：真正的共享层抽取是后续独立任务 |

两个平台后端**完全不同**，但共享同一套架构语义。本仓的长期目标即按后端边界把共享控制面
收敛进 `packages/core`（`packages/linux/src/pal/` 已声明"平台差异在 PAL 收敛、按 host 平台选后端、
永不按 OS 名分支"）。

---

## 1. 它解决什么问题

AI Agent 直接在工作区里执行命令，一次误操作就是一次不可逆的破坏。`dsh-stage-sandbox` 把
**隔离**和**暂存**合并成同一件事：

```
      AI 发起写操作
            │
            ▼
   ┌─────────────────┐
   │  沙箱内的命令    │   唯一可写根 = 暂存树
   │  真实工作区只读  │   真实工作区始终不被写入
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  冻结成候选      │   before / after 两侧内容寻址，不可变
   └────────┬────────┘
            ▼
   ┌─────────────────┐
   │  用户逐文件审批  │   批准 / 拒绝 / 部分应用
   └────────┬────────┘
            ▼
      提交到真实工作区（compare-and-swap）
```

**三条核心不变量**（两个平台共同遵守）：

1. **暂存期间真实工作区绝不被写** —— 沙箱唯一可写根是暂存树。
2. **发布是 compare-and-swap** —— 带 fencing token 与 `expectedBase`，冲突即失败，绝不覆盖。
3. **删除是权威的逻辑状态** —— 暂存副本缺失报"损坏"，绝不从真实磁盘回退推断。

---

## 2. 功能架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         DSH（DeepSeek Harness）                          │
│                    cordis 插件装配层 / profile patch                      │
└───────────────┬──────────────────────────────────┬───────────────────────┘
                │                                  │
      ┌─────────▼──────────┐            ┌──────────▼─────────┐
      │  packages/win      │            │  packages/linux    │
      │  Windows 后端      │            │  Linux 后端        │
      ├────────────────────┤            ├────────────────────┤
      │ plugin/    规范入口 │            │ src/index.ts       │
      │ dsh-plugin/ DSH接入 │            │   ctx.sandbox      │
      │ src/       引擎     │            │ src/pal/    PAL    │
      │  workspace  store   │            │ src/control/ 控制面 │
      │  executor   paths   │            │ src/candidate/ 候选 │
      │  capability  audit  │            │ src/stage/   暂存   │
      │  netpolicy   wfp    │            │ src/publish/ CAS   │
      │  registry-*  暂存   │            │ src/policy/  策略   │
      │  mitigations limits │            │ src/runtime/ 隔离   │
      │ shim/  C 注入层     │            │ src/broker/  副作用 │
      │ tests/ 56离线+4沙箱 │            │ tests/  51 spec    │
      └────────────────────┘            └────────────────────┘
                │                                  │
                └──────────────┬───────────────────┘
                               ▼
                  ┌────────────────────────────┐
                  │      packages/core         │
                  │  共享 PAL 契约 + 控制面接口 │
                  │        （占位）             │
                  └────────────────────────────┘
```

### 2.1 `packages/win` —— Windows 暂存沙箱

按《Agent 沙箱暂存—提交架构设计手册 v3.0》实现，把"隔离"和"暂存"合并成同一件事：

| 层 | 模块 | 职责 |
|---|---|---|
| 逻辑视图 | `src/tools.ts` | 对 AI 唯一可见的工具面（read/write/edit/delete/list/search），结构化返回 |
| 工作区 | `src/workspace.ts`、`src/store.ts` | 统一工作区：逻辑状态（暂存/删除/损坏）、目录合成、候选冻结、选择性应用；内容寻址 blob |
| 隔离 | `src/executor.ts`、`src/appcontainer*.ts` | 受信启动器：受限令牌 + Low IL + deny `FILE_DELETE_CHILD` + Job Object；AppContainer（T0） |
| 能力 | `src/capability.ts` | 真实 Win32 调用探测 + 环境指纹 + 档位选择 + fail-closed |
| 网络 | `src/netpolicy.ts`、`src/wfp.ts` | WFP 过滤器策略层（四态互斥，OFFLINE 档位 fail-closed） |
| 缓解/上限 | `src/mitigations.ts`、`src/limits.ts` | 进程缓解（ACG/CIG/禁 Win32k）= seccomp 等价物；暂存配额与输出上限 |
| 注册表 | `src/registry-stage.ts`、`registry-guard.ts`、`registry-bindings.ts` | 注册表写入暂存（覆盖 hive + WAL）+ 差异检测 |
| 审计 | `src/audit.ts`、`src/audit-report.ts` | 从沙箱**内部**发起真实攻击探针，出证据报告 |
| 接入 | `plugin/`、`dsh-plugin/` | Cordis 规范入口 / DSH 接入（`ctx.fs`、`ctx.shell`、审阅悬浮窗） |
| 注入 | `shim/` | C 源码（`ws_*.c`）：file/registry IAT hook，实现透明暂存 |

**档位**：`T0` AppContainer（隔离已实测生效、已接线，但默认档位是 `T1`）→
`T1` 受限令牌（默认）→ `T2` 仅 ACL → `T3` 拒绝执行（fail-closed）。

### 2.2 `packages/linux` —— Linux dry-run / commit 沙箱（v2.3）

替换内置 `@deepseek-ai/dsh-sandbox-local`，在工作区**私有副本**上暂存命令 → 冻结候选 →
compare-and-swap 发布。

| 层 | 模块 | 职责 |
|---|---|---|
| 入口 | `src/index.ts`、`src/backends.ts` | `ctx.sandbox` provider；运行器链与静态能力表 |
| PAL | `src/pal/` | 能力报告 / 后端注册 / 实际执行能力探测 + 环境指纹 |
| 控制面 | `src/control/` | 状态机、意图哈希、租约 + fencing token、持久化 store、授权、清理闭环 |
| 候选 | `src/candidate/` | manifest / 冻结 / diff / 危险分级 L1–L3 / 特权分级 T0–T2 / 脚本静态扫描 / git 守卫 |
| 暂存 | `src/stage/` | 复制式暂存执行、挂起审批持久化、工作区暂存服务 |
| 发布 | `src/publish/` | CAS 目录后端、publisher（conflict 检测）、回执、越权写提权 |
| 运行时 | `src/runtime/` | 加固 bwrap profile、网络模式、seccomp、cgroup v2、overlay、常驻命令服务器、观测后端 |
| 策略 | `src/policy/` | 签名规则包 + JS（`node:vm`）/ Python（`python3 -I` + AST 白名单 + `sys.audit`）执行器 |
| 副作用 | `src/broker/` | 外部操作代理、网络网关（默认拒绝、租约、五元组、字节计量） |
| 证据 | `src/evidence/` | 追加式分页证据（脱敏）+ 越界访问追踪 |

**状态机**：`PARSED → PREFLIGHTED → AWAITING_EXECUTION_AUTH → STAGING → CANDIDATE_READY →
READY_TO_PUBLISH → PUBLISHING → VERIFYING → COMMITTED`（只读路径 `COMPLETED_READ_ONLY`）。

### 2.3 `packages/core` —— 共享层（占位）

只有契约签名，没有实现。抽取路线（未执行）：`PalContract` → `ControlPlane` → `Candidate` →
`Publish`，每抽一层两包改为依赖 `dsh-sandbox-core` 并保留原实现作为后端。
理由：立即抽取需要同时改动两个成熟实现（win 有几十次提交的 Windows 语义与治理套件，
linux 有 v2.3 控制面与 51 个 vitest 用例），风险高、无法二分。

---

## 3. 工作区与常用命令

```bash
pnpm install
pnpm -r run typecheck          # 三包各自 tsc --noEmit
pnpm test:linux                # Linux：vitest（51 个 spec）
pnpm win:verify                # Windows：套件接线治理 + 源码基线封印（可在任意会话跑）
```

**Windows 全套**（必须在 Windows 上跑受限令牌/ACL/AppContainer/shim 相关套件）：

```powershell
cd packages/win
.\verify.cmd                   # 56 个离线套件关口
.\autotest.cmd                 # 全量：离线 56 + 沙箱 4 + audit，写出 .t/test-report.json
node tools\ebk-sandbox-test.ts # Windows E2E（需 docker + KVM），见 e2e/README.md
```

**Linux 真机验证**（bubblewrap/Landlock 用例在缺能力的宿主上会如实 SKIP）：

```bash
pnpm -C packages/linux exec tsx scripts/smoke.ts
pnpm -C packages/linux exec tsx scripts/e2e.ts
pnpm -C packages/linux exec tsx scripts/runtime-conformance.ts
pnpm -C packages/linux exec tsx scripts/security-conformance.ts
./packages/linux/scripts/test-in-container.sh     # Docker 内跑全量并收集日志
```

### 依赖来源：安装时自动备齐

本仓依赖的 `@deepseek-ai/*` 全部是**私有包**（实测 `registry.npmjs.org` 与
`registry.npmmirror.com` 均 404）。可用的实体在本机 DSH 安装目录的
`resources/app.asar` 里，所以"能装成功"取决于两个磁盘上的东西是否齐备：
`.dsh-vendor/`（提取出来的依赖树，不入库）与 `pnpm-workspace.yaml` 的 `overrides`
（把依赖指过去）。

这两样都由 `preinstall` 自动生成，因此**新机器上只要装过 DSH 桌面端，`pnpm install`
一条命令就够**：

```
pnpm install
  └─ preinstall: node scripts/vendor/bootstrap.mjs
       ├─ .dsh-vendor 已有包？→ 跳过（幂等；--force 强制重建）
       ├─ 否则 → asar-extract.mjs   从 app.asar 按依赖闭包提取
       └─ make-overrides.mjs        建 4 个占位包 + 重写 overrides 段
```

- 手动触发：`pnpm vendor` ／ `pnpm vendor:force`。
- 环境变量：`DSH_APP_ASAR=<路径>` 指定 asar 位置；`DSH_VENDOR_SKIP=1` 跳过引导。
- 详见 [`scripts/vendor/README.md`](scripts/vendor/README.md)。

**诚实声明**：asar 里取不到实体的包会被建成**占位包**（导出空对象）。占位集合是
**按需推导**的，不是固定名单 —— 目前只有 `dsh-approval` 一个（asar 与
`app.asar.unpacked` 里都没有它）。占位包被真实引用时运行期立刻报错、tsc 报
TS2307，**不会静默假绿**。

> 这里踩过一次坑并已修：旧脚本按**固定名单**无条件建占位，把 asar 里其实**有真实实体**
> 的 `dsh-bash-local` / `dsh-bash-sandbox` / `node-addon-system` 的 `lib/index.js`
> 覆盖成了空对象，结果 `packages/linux/src/shell/staged-shell.ts` 继承的
> `SandboxBashExecutor` 变 `undefined`，vitest 以 `Class extends value undefined`
> 挂掉两个 spec。占位是"没有实体时的退路"，不能反过来销毁实体。

若将来拿到内网 registry：删掉 overrides 段与 `preinstall`，在仓库根加
`.npmrc`（`@deepseek-ai:registry=…`）即可回到正常依赖来源。

---

## 4. 加载方式

- **Windows**：`packages/win/dsh-plugin/cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它）。
  ```bash
  dsh plugin --profile web add dsh-winstage-sandbox
  ```
- **Linux**：`packages/linux` 的 profile patch（`~/.dsh/cordis.patch.yml`）：禁用内置
  `sandbox` / `fs-sandbox` / `bash-sandbox` / `subprocess` / `web` 行，插入本插件的 10 行
  （provider、workspace、policy、broker、control、fs、shell、subprocess、web、review）。

---

## 5. 已知限制（诚实声明）

这些内容必须与任何"测试通过"一起读。完整清单见各包文档。

**Windows**（[`packages/win/docs/Windows功能开启清单.md`](packages/win/docs/Windows功能开启清单.md) 的 **R1–R20**，
R19 新增 R16–R20 已由 R20 修复轮收口；R21 另登记若干"证据缺口收口后"的新残余，见
[`R33-最终残余清单`](packages/win/docs/round33/R33-最终残余清单.md) 与
[`Windows功能开启清单.md`](packages/win/docs/Windows功能开启清单.md) §13）：

- **R1 读取面不收敛**：后端限制写/删，**不限制读**。读取收敛只能靠 AppContainer（默认档位是 `T1`）或工具层硬拒绝清单。
- **R2 网络面不收敛**：网络策略层存在且 OFFLINE 档位 fail-closed，但本机未安装真实 WFP 过滤器 ⇒ 沙箱内仍可开 socket。
- **R6 嵌套隔离不可用**：已受限进程无法再建受限令牌 ⇒ 沙箱必须由**未受限宿主进程**建立。
- **R7 环境块需运行时注入**：依赖包受限 spawn 固定传 `lpEnvironment=NULL`；本实现注入显式环境块，结构不符时 fail-closed。
- **R13 已修**（32 位注册表视图可暂存、apply 落 32 视图）；**R14 已收窄**（批量 apply 全有或全无 + 回滚快照 + WAL 崩溃恢复；跨 store 并发仍 last-writer-wins）。
- **RAW `syscall` / 未 hook 面 / T1·T0 无 WAL**：IAT 钩子模型的结构性上限，只有 T1 受限令牌 / T0 AppContainer 兜底；
  实际残余清单（含 R21 新登记项）以 `Windows功能开启清单.md` §13 为准。
- **shim 未随包发布**：发行包只带 C 源码，未构建时退化为受限令牌档（透明暂存不可用）。

**Linux**：

- 仅 Linux，无 Windows/macOS 后端；缺能力的宿主上 bwrap/Landlock 用例如实 SKIP（不是 PASS）。
- 缓存、策略重放、Hyper-V/microVM 后端尚未实现（phase 4）。
- ebk VM 路径无法无人值守跑完整套件（qemu 镜像是交互式 ISO 安装器），已改用 `scripts/test-in-container.sh`。

---

## 6. 文档导航

| 想看什么 | 去哪 |
|---|---|
| Windows 包总览、架构、命令、闸门 | [`packages/win/README.md`](packages/win/README.md) |
| Windows 文档索引（现行 vs 历史） | [`packages/win/docs/README.md`](packages/win/docs/README.md) |
| Windows 测试入口与套件清单 | [`packages/win/docs/测试套件总览.md`](packages/win/docs/测试套件总览.md) |
| Windows E2E 测试台 | [`packages/win/e2e/README.md`](packages/win/e2e/README.md) |
| Linux 包总览、架构与状态表 | [`packages/linux/README.md`](packages/linux/README.md) |
| 共享层抽取路线 | [`packages/core/README.md`](packages/core/README.md) |

历史轮次记录（round10–round32、archive）已在 **R33 收口后清理**，
需要追溯时以 git 历史为准（`git log -- packages/win/docs/roundNN`），它们**不代表现行口径**。

---

## 7. 改动纪律

**Windows 包**有一层额外的硬约束 —— **源码封印**：

- 收录面：`src/*.ts`、`tests/*.ts`、`dsh-plugin/*.ts`、`plugin/*.ts`、`tools/*.ts`、
  `e2e/**/*.ts` 与四个根入口（`autotest.ts`、`verify.cmd`、`run.cmd`、`testservice.cmd`）。
- 改动任一受封印文件 ⇒ 关口变红，直到有人**有意识地**重新生成清单
  （`node tools\baseline-sha256.ts --write`）；**清单 diff 就是"改了什么"的可复核记录**。
- 新增测试套件必须**同时**登记进 `src/testrunner.ts::OFFLINE_SUITES` 与 `verify.cmd` 的 `for` 列表
  （由 `tests/suite-wiring.ts` 机器校验）。

---

## 附录：仓库历史

本仓由两个独立仓库合并而成，**保留两者全部 git 历史**：用 `git-filter-repo --to-subdirectory-filter`
把各自内容移入子目录，再 `merge --allow-unrelated-histories`。因此 **commit 哈希被重写**。

| 源仓库 | 源 HEAD（合并前） | 合并后等价 HEAD |
|---|---|---|
| `dsh-sandbox-windows`（`dsh-winstage-sandbox`） | `42ce094494ac2440d9e0144be9fab7a773f7db05` | `7bd05a2bed217fea559fb0f28f4c4680a4da9c61`（→ `packages/win`） |
| `dsh-sandbox-linux` v0.2.0 / v2.3 | `d6a598581111ca6039d6fac5bfbda2ac2cbf403f` | `282bc4b841bb9454f126b8eb47d9b7cd7bab1ad7`（→ `packages/linux`） |
| （合并提交） | — | `52f8cc81aa088add6b64d2643415258671758012` |

```bash
git clone <A> win && git clone <C> linux
git -C win   filter-repo --to-subdirectory-filter packages/win   --force
git -C linux filter-repo --to-subdirectory-filter packages/linux --force
git init dsh-stage-sandbox
git fetch <win>   && git checkout -b master FETCH_HEAD        # A 历史
git fetch <linux> && git merge --allow-unrelated-histories FETCH_HEAD
```

**未入库资产**（`filter-repo` 只带已提交内容；以下为文件系统级拷入，仍 gitignore）：
`packages/win/shim/out/`（13M，已构建的 shim DLL）、`tools/toolchain/`（526M，zig 工具链）、
`esc/`、`filemod/`（被文档表格引用的证据）。

**未搬运**（如需可回溯原目录）：Windows 侧的 `.t/`（17G 运行期证据）、`.dshstage/`、`.lead/`、
`retest/`、`.recon/`；Linux 侧的 `ebk/container-artifacts/` 等运行产物。

> 原 A 的 GitHub 远端（`gygygfg/dsh-winstage-sandbox`）未带入本仓；如需推送请新加 remote，
> 并注意历史已重写。
