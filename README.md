# dsh-stage-sandbox — 跨平台 dsh 沙箱 monorepo

本仓把两个**独立实现**的 dsh 沙箱插件合并为一个跨平台工作区，**保留两者各自的 git 历史**：

| 包 | 来源 | 平台 | 隔离机制 |
|---|---|---|---|
| [`packages/win`](packages/win) | `dsh-winstage-sandbox`（原 `dsh-sandbox-windows`） | Windows | 受限令牌（WRITE_RESTRICTED）+ ACL + Job Object + AppContainer + shim（file/reg IAT hook）+ 注册表暂存；DSH 审阅悬浮窗 |
| [`packages/linux`](packages/linux) | `dsh-sandbox-linux` v2.3 | Linux | bubblewrap + Landlock + seccomp + cgroup v2 + overlayfs；dry-run/commit 控制面 + CAS 发布 |
| [`packages/core`](packages/core) | 本仓新增 | 跨平台 | **起步为占位**：PAL（平台抽象层）契约 + 控制面共享接口的类型占位。真正的共享层抽取是后续独立任务。 |

两者共享同一架构语义（**暂存 → 候选冻结 → 选择性提交/审批**），但平台后端完全不同。
`packages/linux` 的 `src/pal/` 已声明"平台差异在 PAL 收敛、按 host 平台选后端、永不按 OS 名分支"，
本 monorepo 即以此为目标逐步把共享控制面收敛进 `packages/core`。

## 工作区

```bash
pnpm install
pnpm -r run typecheck        # 两包各自 tsc --noEmit
pnpm -C packages/linux test  # Linux：vitest
pnpm -C packages/win exec node tests/suite-wiring.ts   # Windows：离线治理套件（可在任意会话跑）
```

> `packages/win` 的 Windows 专属套件（受限令牌/ACL/AppContainer/shim）必须在 **Windows** 上跑；
> 离线确定性与治理套件可在任意平台跑。见 `packages/win/docs/测试套件总览.md`。
> `packages/linux` 的 bubblewrap/Landlock 用例在缺能力的宿主上会如实 SKIP。

## 加载方式（各自）

- **Windows**：`packages/win/dsh-plugin/cordis.patch.yml`（详见 `packages/win/README.md`）。
- **Linux**：`packages/linux` 的 profile patch（见 `packages/linux/README.md`）。

## 历史与合并

见 [`MERGE-NOTES.md`](MERGE-NOTES.md)。
