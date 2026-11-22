# NT 内核视图隔离沙箱（ProjFS + minifilter）

> 状态：**M1 已完成（功能 GO；性能门禁未达标）**。产品驱动/provider/launcher 在
> Windows 10 19041 上跑通端到端；DSH 侧目前只接入了只读诊断命令
> `/winstage nt status|doctor`，默认 `enforcement` 仍是 legacy（M2 才切换路径）。
> 诚实状态见 [`STATUS.md`](./STATUS.md)；M1 证据见 [`M1-REPORT.md`](./M1-REPORT.md)
> 与 [`M1-PERF.md`](./M1-PERF.md)；威胁模型见 [`THREAT-MODEL.md`](./THREAT-MODEL.md)；
> 策略格式见 [`POLICY.md`](./POLICY.md)；Windows spike 步骤见 [`M0-SPIKE.md`](./M0-SPIKE.md)。

## 1. 目标

在 `packages/win` 内把隔离数据面从**用户态 IAT shim** 换成 **NT 内核路径**：

```text
DSH / Cordis
  plugin/index.ts
  dsh-plugin/host-plugin.ts     /winstage 命令、状态卡、设置
  dsh-plugin/staging-fs.ts      ctx.fs：逻辑路径 → 视图根
  dsh-plugin/shell-executor.ts  ctx.shell：经 ctx.sandbox.confine 进域
  dsh-plugin/provider.ts        ctx.sandbox：返回 launcher argv
                │
                ▼
        Control plane (TypeScript)
        src/nt/policy.ts        域/类型/规则 → 编译/校验/判定
        src/nt/paths.ts         路径规范化/视图映射/输出还原
        src/nt/view.ts          ProjFS 视图 diff（placeholder/full/tombstone）
        src/nt/driver.ts        驱动通信端口契约（真实 FFI 在 M1）
        src/nt/status.ts        fail-closed / 写屏障 / 失败分类
        src/nt/executor.ts      K0 档执行链
        src/nt/apply.ts         apply helper 客户端（控制面 journal/undo）
        src/nt/runtime.ts       诊断装配（驱动/状态/provider/策略校验）
        src/nt/supervisor.ts    数据面生命周期（provider/策略/域；失败回滚）
                │
                ▼
        NT kernel data plane
        native/driver/          dshnt.sys：minifilter 重定向 + allow/deny/mask
        native/projfs/          ProjFS provider：lower=真实工作区，upper=视图根
        native/launcher/        token / Job / mitigation / 环境 / 域注册
        native/apply/           CAS 写入真实工作区 + undo
```

## 2. 为什么是 ProjFS + 小型 minifilter

| 方案 | 同路径透明 | 内核强制 | copy-up/whiteout/目录合并 | 风险 |
|---|---|---|---|---|
| 用户态 IAT shim（现状） | 部分 | 否 | 自己做 | 已被 raw syscall/子进程绕过 |
| 完整 minifilter overlay | 是 | 是 | 全部自己做 | 极高，容易 BSOD |
| **ProjFS + 小型 minifilter** | **是** | **是** | **ProjFS 内置** | **驱动只做重定向/策略** |
| ProjFS + AppContainer（无驱动） | 否（视图根是独立路径） | 是 | ProjFS 内置 | 绝对路径不透明 |
| Windows 容器 / HCS | 是（命名空间） | 是 | 容器层 | 依赖重、镜像/虚拟化 |

本方案把最容易写错的 copy-up、whiteout、目录枚举合并交给系统内置的 `ProjFS.sys`；
自研 minifilter 只负责：

1. 把域内进程的 `C:\ws\**` 打开重定向到视图根（SimRep 的 `IoReplaceFileObjectName` +
   `STATUS_REPARSE` 模式）；
2. 拒绝直接访问 store/view 根、设备、危险路径；
3. 按域/路径类型执行 allow/deny/mask；
4. 域继承与审计事件。

这样仍然是**内核强制、同路径透明**，但驱动规模与崩溃面远小于完整 overlay。

## 3. 三条硬不变量

1. **暂存期间真实工作区绝不被写**：沙箱/宿主对真实工作区的写都由驱动拒绝；唯一写者是
   apply helper，且只在批准后按 CAS 写。
2. **删除是权威逻辑状态**：ProjFS tombstone 是删除；base 存在但视图既无 tombstone 也无
   full/placeholder ⇒ `corrupted`，绝不按“真实盘还在”推断为未删除。
3. **失败关闭**：驱动/ProjFS/策略/网络/apply 任一缺失 ⇒ 抛带机读码的 `NtError`，
   不静默退回主机直跑。

## 4. 域/类型/策略（SELinux 风格）

- domain = 沙箱域（会话/尝试）；
- type = 规则里的对象类型（`workspace` / `system` / `secret` / `store` / ...）；
- rule = 某域对某类路径的某组访问允许/拒绝/暂存/遮蔽；
- 默认：读按 `defaultRead`，写/删/改名/执行/属性一律拒绝；
- 工作区内写/删/改名**只能** `stage`；出现 `allow` 直接判策略非法。

详见 [`POLICY.md`](./POLICY.md)。

## 5. v1 边界（已确认）

| 面 | v1 | 说明 |
|---|---|---|
| 文件视图 + 暂存写入 | ✅ | ProjFS + minifilter；工作区同路径透明 |
| 令牌 / Job / 进程缓解 | ✅ | AppContainer/受限令牌 + Job limits + mitigation profile |
| 网络 WFP 断网/白名单 | ✅ | 按 AppContainer SID；默认 offline |
| 注册表暂存 | ❌（阶段 2） | v1 对敏感 HKLM 写拒绝；HKCU 不暂存 |
| GUI/IPC/进程视图 | ❌（阶段 3） | 窗口站/桌面、命名管道/ALPC、跨域句柄 |
| 正式签名 | ❌（先测试签名） | 个人机 `testsigning`；分发再走 EV + attestation |
| `/winstage` UX | ✅ 保留 | 命令、面板、设置项不变 |

## 6. 当前实现进度

| 模块 | 状态 |
|---|---|
| `src/nt/types.ts` | ✅ 契约/错误码/状态类型 |
| `src/nt/paths.ts` | ✅ 规范化/边界/视图映射/输出还原 + 单测 |
| `src/nt/policy.ts` | ✅ 校验/编译/优先级/哈希 + 单测 |
| `src/nt/view.ts` | ✅ ProjFS 视图 diff（tombstone/corruption）+ 单测 |
| `src/nt/status.ts` | ✅ fail-closed/写屏障/失败分类 + 单测 |
| `src/nt/driver.ts` | ✅ 端口契约 + Fake/Unavailable + 单测；真实 FFI 待 M1 |
| `src/nt/launcher-args.ts` | ✅ 启动契约/环境白名单/路径校验 + 单测 |
| `src/nt/apply-manifest.ts` | ✅ CAS manifest/冲突零写/排序 + 单测 |
| `src/nt/session.ts` | ✅ 策略下发/域注册/launcher 包装/清理 + 单测 |
| `src/nt/policy-binary.ts` | ✅ 驱动线格式 + 单测 |
| `src/nt/driver-wire.ts` / `driver-client.ts` | ✅ ABI v2 编解码 / Windows FFI + 单测 |
| `src/nt/executor.ts` | ✅ K0 执行链 + 单测 |
| `src/nt/apply.ts` | ✅ 控制面 apply（journal/undo）+ 单测 |
| `src/nt/status-probe.ts` | ✅ 机器事实 → `NtStatus` + 单测 |
| `src/nt/provider.ts` | ✅ `ctx.sandbox` NT provider（M2 才装配） |
| `src/nt/runtime.ts` | ✅ 诊断装配 + 单测 |
| `src/nt/provider-protocol.ts` / `provider-client.ts` | ✅ 管道协议/客户端 + 单测 |
| `src/nt/supervisor.ts` | ✅ 数据面生命周期（up/down、回滚、generation 单调）+ 单测 |
| M0 Windows spike | ✅ 已通过（ProjFS + SimRep；23/23 探针；见 `M0-REPORT.md`） |
| M1 端到端 | ✅ 已通过（24/24 探针、暂存写、lower 不变、offline/allowlist、缓解/Job 回读；见 `M1-REPORT.md`） |
| M1 性能 | ⚠ 0.55–0.64 ms/文件、20k 11.4–12.8 s（门禁未过；见 `M1-PERF.md`） |
| `native/driver/` | ✅ 产品实现，已加载并挂 C: |
| `native/provider/` | ✅ 产品 ProjFS provider（C#），已运行 |
| `native/launcher/` | ✅ token/Job/环境/WFP，已运行 |
| `native/apply/` | ⏳ M2（v1 在可信控制面 apply） |
| `/winstage nt` | ✅ status/doctor/up/down（诊断 + 数据面生命周期） |
| dsh 路径切换 | ⏳ M2（默认仍 legacy） |

## 7. 常用命令（当前）

控制面单测不依赖 Windows，可在这台 Linux 上跑：

```bash
cd packages/win
node tests/nt/run-all.ts
# 或单独：
node tests/nt/policy.ts
node tests/nt/paths.ts
node tests/nt/view.ts
node tests/nt/status.ts
node tests/nt/driver.ts
node tests/nt/runtime.ts
node tests/nt/supervisor.ts
```

Windows guest 内（管理员）：`\\host.lan\Data\m1\go.bat` 跑 M1 全流程，
`goperf.bat` 跑性能；结果写 `RESULT_M1.json` / `PERF_M1.json`。

TypeScript 类型检查（本机没有 tsc 时可临时装到 /tmp，不污染仓库）：

```bash
npm i --prefix /tmp/opencode typescript@5.9 @types/node@22
node /tmp/opencode/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json \
  --typeRoots /tmp/opencode/node_modules/@types
```

2026-11-23 实测：只剩 `plugin/config.ts` / `plugin/index.ts` 的既有缺包错误
（`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`）；NT 相关源码与测试零错误。

Windows 驱动/ProjFS 的 spike 见 [`M0-SPIKE.md`](./M0-SPIKE.md)。

## 8. 与既有 WinStage 的关系

- 旧 T0/T1/T1S/TS/shim 路径**暂不删除**，作为 legacy/回退；
- `enforcement: 'kernel'` 未就绪时默认 fail-closed；诊断可显式切 legacy；
- `tests/nt/*.ts` 已通过 `tests/nt/run-all.ts` 登记进 `OFFLINE_SUITES` 与
  `verify.cmd`（`tests/suite-wiring.ts` 机器检查两处逐字一致）；
- 封印收录面已扩展：`src/**/*.ts`、`tests/**/*.ts`、`native/**` 的源码/工程文件
  都进 `docs/源码基线.sha256`（253 条）；形状断言只允许 `src/nt/`、`tests/nt/`、
  `native/` 这些显式递归面，构建产物与 vendor 排除。

## 9. 参考

- Microsoft `SimRep` minifilter sample：`IoReplaceFileObjectName` + `STATUS_REPARSE` 重定向。
- Microsoft `NameChanger` minifilter sample：名称提供者/目录枚举注入。
- Microsoft ProjFS `SimpleProvider`/`RefFS`：虚拟化根、placeholder、full file、tombstone。
- Microsoft `ProjFS-Managed-API`：provider 的非 C++ 选项。
- 本仓 `docs/NeoAI-对标与完善-2026-10-22.md`：控制面/审批/残余基线。
