# NT 内核视图隔离沙箱（ProjFS + minifilter）

> 状态：**M0/M1 之间**。控制面契约与单测已落地；驱动/ProjFS helper/launcher 尚未接线。
> 诚实状态见 [`STATUS.md`](./STATUS.md)；威胁模型见 [`THREAT-MODEL.md`](./THREAT-MODEL.md)；
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
        src/nt/executor.ts      K0 档执行链（下一步）
        src/nt/apply.ts         apply helper 客户端（下一步）
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
| `src/nt/executor.ts` | ⏳ M1 |
| `src/nt/apply.ts` | ⏳ M1 |
| `src/nt/provider.ts` | ⏳ M2 |
| `native/driver/` | ⏳ M0/M1 |
| `native/projfs/` | ⏳ M1 |
| `native/launcher/` | ⏳ M1 |
| `native/apply/` | ⏳ M1 |
| dsh 接线 | ⏳ M2（默认仍 legacy） |

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
```

TypeScript 类型检查（本机 vendor 缺 `@deepseek-ai/*` 时，先只检查 `src/nt` 与 `tests/nt`；
完整 `tsc` 需要先备齐 `.dsh-vendor`）：

```bash
# 有完整 node_modules 时
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Windows 驱动/ProjFS 的 spike 见 [`M0-SPIKE.md`](./M0-SPIKE.md)。

## 8. 与既有 WinStage 的关系

- 旧 T0/T1/T1S/TS/shim 路径**暂不删除**，作为 legacy/回退；
- `enforcement: 'kernel'` 未就绪时默认 fail-closed；诊断可显式切 legacy；
- 新套件在 `tests/nt/` 先以“开发期未封印”目录存在，M1 收口时提升到 `tests/*.ts`、
  登记 `OFFLINE_SUITES` 与 `verify.cmd`，并刷新 `docs/源码基线.sha256`。

## 9. 参考

- Microsoft `SimRep` minifilter sample：`IoReplaceFileObjectName` + `STATUS_REPARSE` 重定向。
- Microsoft `NameChanger` minifilter sample：名称提供者/目录枚举注入。
- Microsoft ProjFS `SimpleProvider`/`RefFS`：虚拟化根、placeholder、full file、tombstone。
- Microsoft `ProjFS-Managed-API`：provider 的非 C++ 选项。
- 本仓 `docs/NeoAI-对标与完善-2026-10-22.md`：控制面/审批/残余基线。
