# packages/core（占位）

本包是跨平台共享层的**目标位置**，当前**只有契约占位**。真正的抽取（把 `packages/win` 与
`packages/linux` 里重复的*暂存 → 候选 → 选择性提交/审批*控制面收敛到这里）是**后续独立任务**，
本轮合并**不做** big-bang 重写。

## 为什么先占位

- `packages/linux/src/pal/` 已声明"平台差异在 PAL 收敛、provider 与控制面按 host 平台选后端、
  永不按 OS 名分支"；`packages/win` 的 Windows 机制是另一套后端。
- 立即抽取需要同时改动两个成熟实现（A 有 41 次提交的 Windows 语义与封印/治理套件；
  C 有 2 次提交的 v2.3 控制面与 51 个 vitest 用例），风险高、无法二分。
- 因此：**先建立工作区与历史，再按后端边界逐一抽取**。

## 抽取路线（建议，未执行）

1. `PalContract`：统一 `RuntimeBackend` 选择契约（现 C 的 `pal/types.ts` 已是雏形）；
2. `ControlPlane`：状态机 / intent 哈希 / lease / 持久化 store 的接口（现 C 的 `src/control/`）；
3. `Candidate`：冻结 / manifest / diff 的接口（现 C 的 `src/candidate/`，与 A 的 `src/store.ts`+`src/workspace.ts` 对齐语义）；
4. `Publish`：CAS 发布 + 回执（现 C 的 `src/publish/`）。
5. 每抽一层：两包改为依赖 `dsh-sandbox-core`，并保留原实现作为后端，测试各自仍绿。

`src/index.ts` 里的类型即为上述边界的占位签名。
