# docs/ 导航

本目录是 `packages/win` 的设计与规范区。**判别口径的铁律**：

- **现行口径** = 本 README 第 1–3 节列出的文档 + **代码**（`src/testrunner.ts`、`docs/源码基线.sha256`）。
- `docs/archive/` 下的内容全部是**历史轮次记录与一次性结论**，写于当时，**不代表现行口径**，
  只用于追溯"为什么现在是这个样子"。
- 代码注释里引用归档文档时，一律写成完整路径 `docs/archive/roundNN/…`，避免与现行文档混淆。

---

## 1. 现行规范与入口（改动前先看这些）

| 文档 | 作用 |
|---|---|
| [`测试套件总览.md`](测试套件总览.md) | **测试的唯一入口**：离线/沙箱/治理套件清单、怎么跑、判据在哪 |
| [`项目规范-测试与修改流程.md`](项目规范-测试与修改流程.md) | 改代码前/后的流程规范（含基线封印纪律） |
| [`插件启动-环境监测与开关保证.md`](插件启动-环境监测与开关保证.md) | 启动环境监测与开关语义（`PUBLISHING.md` 引用） |
| [`Windows功能开启清单.md`](Windows功能开启清单.md) | **残余边界 R1–R20 的权威列表**（`tests/residual-baseline.ts` 会读它，删行即判红） |
| [`Agent沙箱暂存—提交架构设计手册-v3.0.md`](Agent沙箱暂存—提交架构设计手册-v3.0.md) | 设计手册 v3.0；代码注释里的"手册 #x.y"都指它 |
| `源码基线.sha256` | **硬判据**（不是文档）：受封印文件的逐条哈希，`tests/baseline-integrity.ts` 读它 |

## 2. 机制设计与接线契约

| 文档 | 主题 |
|---|---|
| [`T1-启动器修复报告.md`](T1-启动器修复报告.md) | 启动器（可执行文件解析 / 环境块注入） |
| [`T2-T0接线契约.md`](T2-T0接线契约.md)、[`T2-敏感读收敛报告.md`](T2-敏感读收敛报告.md) | T0（AppContainer）接线契约、敏感读收敛 |
| [`T3-注册表暂存设计.md`](T3-注册表暂存设计.md) | 注册表写入暂存的设计（`src/registry-stage.ts` 的实现依据） |
| [`T4-shim设计.md`](T4-shim设计.md) | C shim 的注入与 hook 设计 |
| [`T5-痕迹与根统一报告.md`](T5-痕迹与根统一报告.md) | 痕迹与工作根统一 |
| [`T6-门禁收敛与载体完整性报告.md`](T6-门禁收敛与载体完整性报告.md) | 门禁收敛与载体完整性 |
| [`T7-暂存键重开与逐载体注入报告.md`](T7-暂存键重开与逐载体注入报告.md) | 暂存键与逐载体注入 |
| [`DSH集成.md`](DSH集成.md) | DSH 装配、审阅悬浮窗、命令面、已知崩溃风险 |
| [`审批策略never-用户感知一致性-分析与实施清单.md`](审批策略never-用户感知一致性-分析与实施清单.md) | `approval:never` 的用户感知一致性 |
| [`WinStageSandbox-能力清单与差距基线.md`](WinStageSandbox-能力清单与差距基线.md) | 能力清单与差距基线 |
| [`NeoAI-沙箱能力分析与差距输入.md`](NeoAI-沙箱能力分析与差距输入.md)、[`NeoAI-差距补齐-实施与验证报告.md`](NeoAI-差距补齐-实施与验证报告.md) | 外部差距输入与补齐验证 |

## 3. 边界实测与缺陷修复（现行结论）

- [`沙箱边界实测矩阵.md`](沙箱边界实测矩阵.md)、[`DSH沙箱边界-实例侧实测.md`](DSH沙箱边界-实例侧实测.md)、[`沙箱并行实测报告-6域与独立复核.md`](沙箱并行实测报告-6域与独立复核.md)
- [`边界缺陷修复-①TS档删除绕过.md`](边界缺陷修复-①TS档删除绕过.md)、[`①b-白障候选捕获.md`](边界缺陷修复-①b-白障候选捕获.md)、[`②基线过期不可见.md`](边界缺陷修复-②基线过期不可见.md)、[`③T0污染与静默降级.md`](边界缺陷修复-③T0污染与静默降级.md)、[`④注册表暂存与子会话纳管.md`](边界缺陷修复-④注册表暂存与子会话纳管.md)、[`独立复核.md`](边界缺陷修复-独立复核.md)
- [`沙箱缺陷修复-第二轮-P0P1P2与交付限制.md`](沙箱缺陷修复-第二轮-P0P1P2与交付限制.md)
- [`实测证据记录.md`](实测证据记录.md)、[`沙箱审计-两种记录方式实测对比.md`](沙箱审计-两种记录方式实测对比.md)、[`file-modification-test-report.md`](file-modification-test-report.md)

## 4. round16 —— 现行 E2E 协议

[`round16/00-测试协议.md`](round16/00-测试协议.md) 是 Windows E2E 测试台的**现行判据**
（`e2e/README.md` 与 `tools/ebk-sandbox-test.ts` 直接引用）。同目录的 `汇总报告.md`
与各域 `报告/缺陷` 是本轮结论。

## 4.1 round17 / round18 —— 独立验收与残余收口（现行结论）

- [`round17/R17-独立验收报告.md`](round17/R17-独立验收报告.md)：独立验收轮（2 条 P0 + 6 条 P1/P2 修复，
  含"开关关仍接管 shell"与"凭据明文进 review.json"；§3 为 9 条残余清单）。
- [`round18/R18-残余修复与验收报告.md`](round18/R18-残余修复与验收报告.md)：把 R17 §3 的 9 条残余全部闭环
  （WOW64 32KEY fail-closed、注册表候选 appliable:false、真实文件物化、目录↔文件 apply、--read-only、
  shim 读遮蔽、零写 CoW、白障祖先目录、关态停轮询/限制日志/双层卸载/apply 幂等/判定面），
  并记录 canonical shim 重建、TS 车道判据、最终门禁与诚实残余。
- [`round19/R19-独立测试与边界修复报告.md`](round19/R19-独立测试与边界修复报告.md)：Windows 侧独立测试与边界修复轮
  （4 个 P0 + 4 个 P1/P2 修复；§3 为 R16–R20 残余清单）。
- [`round20/R20-残余修复报告.md`](round20/R20-残余修复报告.md)：把 R19 §3 的 R16–R20 残余收口
  （ntdll/Zw 注册表写 fail-closed+WAL、ReplaceFileW/NtCreateFile/FindFirst*/NtQueryDirectoryFile 接线、
  硬链接遮蔽读写双面收口、目录枚举过滤、托管 exe 注入根因与延迟初始化、T1 归因结构化声明），
  并记录 canonical shim/dist 重建、新测试套件与最终门禁/诚实残余。
- [`round21/R21-证据缺口收口报告.md`](round21/R21-证据缺口收口报告.md)：收口 R19 汇总里的 **5 项"未验证/证据缺口"**
  （RegCopyTree/RegRenameKey 生产 lane 复验、注册表 apply 对抗样本、文件侧对抗审计、readPolicy 双档 +
  sensitive-content 端到端脱敏、GUI/DOM 实况与 `dsh plugin remove` 实跑、`build-shim --help` 工具链修复），
  过程中新修 13 处缺陷；附 3 项非产品口径的独立复核结论与 R21 新登记残余。
- [`round22/R22-剩余项修复报告.md`](round22/R22-剩余项修复报告.md)：逐项修复剩余可修项（第一批）——
  R15 最后 6 个可 hook 注册表变体接入拦截面、`NtQueryDirectoryFileEx` 枚举过滤、
  三件套版本握手（`shimInitRc` 三态 fail-closed）、根 README/§13 文档同步；附残余与下一批建议。
- [round23/R23-剩余项修复报告.md](round23/R23-剩余项修复报告.md)：第二批 —— 面板路由本机鉴权（R21-LC-01：命名前缀路由接入宿主 connection.authorizeIndex，裸请求 401 / 带 cookie 正常 / 关态 503 不泄快照）、>MAX_PATH 写面（R21-FS-06）；附残余与下一批。
- [`round24/R24-剩余项修复报告.md`](round24/R24-剩余项修复报告.md)：第三批 —— 生产接线（`WINSTAGE_READ_POLICY` 通道 + host config `masks`，默认行为 deep-equal 不变）、R14 批量 apply 收窄为"全有或全无 + 回滚快照"、R16 hive-file ntdll 独立探针 104/0 + autotest 全量；附残余与下一批。
- [`round25/R25-剩余项修复报告.md`](round25/R25-剩余项修复报告.md)：第四批 —— T1 真归因（opt-in **T1S** 档：受限令牌 + shim，WAL/audit 归因与 TS 同口径；默认 T1 不变）、`dsh plugin remove` 残留清理工具（R21-LC-04：dry-run/apply/幂等/护栏，隔离 e2e）；附残余与下一批。
- [`round26/R26-32位视图暂存报告.md`](round26/R26-32位视图暂存报告.md)：第五批 —— R13 32 位注册表视图暂存化（`/reg:32` 写/删进 overlay，合成命名空间 + WAL `reserved`=view，apply 带 `/reg:32` 只改 32 视图；审阅面 `[32]`；读仍透传）；附修前红/修后绿与残余。

## 5. archive —— 历史归档（不代表现行口径）

| 目录 | 内容 |
|---|---|
| `archive/round10/` | 第 10 轮：7 域缺陷与修复（含 `fileio/13d/` 的分档实验）。证据目录 `evidence/` 不入库 |
| `archive/round11/` | 第 11 轮：7 域报告 + 缺陷 + 独立复核 |
| `archive/round12/`–`archive/round14/` | 第 12–14 轮：plugin / GUI / shim 修复与汇总 |
| `archive/round15/` | 第 15 轮收口报告 + shim WIP 源码快照（与 `shim/src/` 重复，仅存档） |
| `archive/dsh2/` | 第二 DSH 实例 + 真实浏览器（CDP）验收轮次的发现与修复 |
| `archive/重构-*.md`、`archive/沙箱测试-交接单.md` | 重构四阶段记录与交接单；重构目标已落地为 `plugin/` |
