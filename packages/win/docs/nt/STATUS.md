# NT 沙箱实现状态（诚实口径）

> 更新：2026-11-22。只记录**代码事实**；未运行/未实测的项明确写“未开始/未实测”。

## 1. 已完成（控制面契约 + 单测）

| 文件 | 内容 | 测试 |
|---|---|---|
| `src/nt/types.ts` | domain/rule/policy/status 类型；`NtError` 与固定错误码；ABI/端口常量 | 被其它套件间接覆盖 |
| `src/nt/paths.ts` | Windows 路径规范化；设备/UNC/ADS/通配符拒绝；`..` 逃逸拒绝；逻辑↔视图映射；输出还原 | `tests/nt/paths.ts`（39 断言） |
| `src/nt/policy.ts` | 校验；编译；特异性/deny 优先；默认拒绝；全局 mask；canonical JSON/SHA-256；默认规则/凭据 mask | `tests/nt/policy.ts`（41 断言） |
| `src/nt/view.ts` | ProjFS 视图 diff；placeholder/full/tombstone；目录删除；缺失=corruption；hash unverified | `tests/nt/view.ts`（15 断言） |
| `src/nt/status.ts` | fail-closed；写屏障；逐项缺失机读码；失败分类；状态卡 | `tests/nt/status.ts`（32 断言） |
| `src/nt/driver.ts` | 端口契约；Fake/Unavailable；策略/域/apply/事件；默认 fail-closed | `tests/nt/driver.ts`（24 断言） |
| `src/nt/launcher-args.ts` | launcher 启动契约；环境白名单/凭据拒绝；路径/Job/网络校验 | `tests/nt/launcher-args.ts`（26 断言） |
| `src/nt/apply-manifest.ts` | CAS manifest 校验；冲突零写；写入/删除排序 | `tests/nt/apply-manifest.ts`（23 断言） |
| `src/nt/session.ts` | 策略下发/域注册/launcher 包装/幂等清理 | `tests/nt/session.ts`（21 断言） |
| `tests/nt/run-all.ts` | 8 个控制面套件独立子进程运行 | `node tests/nt/run-all.ts` |
| `native/include/dshnt_abi.h` | 驱动/launcher/apply 的共享 ABI 草案 | 仅头文件，未编译 |
| `docs/nt/*` | 设计/威胁模型/策略/M0 spike | — |

### 本机实测结果

```text
node tests/nt/run-all.ts
nt 控制面套件：8 个，失败 0 个
RESULT: ALL PASS
```

单套件断言数：paths=39、policy=41、view=15、status=32、driver=27、launcher-args=26、
apply-manifest=23、session=21。

## 2. 未开始（M0/M1）

| 项 | 状态 | 说明 |
|---|---|---|
| `native/driver/` | 未开始 | minifilter 源码/INF/构建脚本；需 Windows + WDK |
| `native/projfs/` | 未开始 | ProjFS provider helper；需 Windows + ProjFS |
| `native/launcher/` | 未开始 | token/Job/mitigation/域注册 |
| `native/apply/` | 未开始 | CAS + journal + undo |
| `src/nt/executor.ts` | 未开始 | K0 执行链；依赖 launcher/driver |
| `src/nt/provider.ts` | 未开始 | `ctx.sandbox` provider |
| dsh 接线 | 未开始 | `ctx.fs`/`ctx.shell` 切视图；默认仍 legacy |
| WFP 实测 | 未开始 | 按 AppContainer SID 的 offline/allowlist |
| 注册表 | 未开始（阶段 2） | v1 只拒绝敏感 HKLM 写 |
| 正式签名 | 未开始 | 先测试签名 |

## 3. 本机限制

- 当前开发机是 **Linux**：不能构建/加载 Windows 驱动，也不能启用 ProjFS。
- `pnpm -C packages/win typecheck` 因 `.dsh-vendor` 缺失无法在根上跑通；用
  `node /path/to/typescript/bin/tsc --noEmit -p tsconfig.json --typeRoots ...` 时，
  新代码无类型错误，仅剩既有 `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` 缺包错误。
- 驱动/ProjFS 的 M0 spike 必须在 Windows VM 上执行，见 `M0-SPIKE.md`。

## 4. 与封印/套件的关系

- 新代码在 `src/nt/*.ts` 与 `tests/nt/*.ts`（子目录）。当前收录面是 `src/*.ts` /
  `tests/*.ts`（深度 1），所以**尚未进入** `docs/源码基线.sha256`，也不会让现有
  `baseline-integrity` 变红。
- M1 收口时必须：
  1. 把 `tests/nt/*.ts` 提升/登记到 `OFFLINE_SUITES` 与 `verify.cmd`（或保持子目录，
     但必须让 CI 明确运行 `run-all`）；
  2. 扩展封印收录面到 `src/**/*.ts`（以及 native 源），并**有意识刷新**基线；
  3. 复核 `docs/源码基线.sha256` diff。
- 在翻默认档位前，`enforcement` 默认保持 `legacy`/不可用，生产路径不会因为新代码改变行为。
- 本分支顺带修正了一处**既有**陈旧基线：`tests/r46-undo.ts` 在 HEAD 上清单哈希与磁盘不一致；
  `node tools/baseline-sha256.ts --write` 只改了这一行（`21c8…` → `39e8…`），不是本轮源码改动。

## 5. 下一步（M1）

1. Windows VM：按 `M0-SPIKE.md` 跑 SimRep + ProjFS，出 `M0-REPORT.md`。
2. 驱动：域注册 + `PreCreate` 重定向 + store/view 拒绝 + 审计计数。
3. Launcher：AppContainer/受限令牌 + Job + mitigation + 环境白名单 + 域注册。
4. ProjFS helper：投影/水合/通知 + 命名管道状态。
5. `src/nt/executor.ts`：`K0` 档在 `enforcement='kernel'` 下可用；默认 legacy。
6. 测试：raw `NtCreateFile`、子进程、目录枚举、删除/改名、长路径、跨卷、性能。
