# R30 · NT 上限长路径专项（>4095 → ≤分辨率上限）（第九批）

> 范围：`packages/win`。执行：Lead + 2 个 teammate（file-shim / gate-runner），2026-10-21。
> 前置：R19–R29 已提交（`80a7764`）。用户要求"继续修复剩下所有，每阶段 commit 后自动继续"⇒ 本批第 ① 项：
> **NT 上限长路径专项**。

---

## 0. 一句话结论

| 项 | 内容 | 结果 |
|---|---|---|
| **R30-A（NT 长路径）** | R27-A 方案 A：`WS_PATH_MAX=4096`，>4095 显式 fail-closed（支持上限 ≈ `4096 - len(stageRoot) - 24`） | **已扩展到物理布局上限**：`WS_PATH_MAX 4096→32768` + 路径/转义缓冲全部改**堆缓冲（cleanup 自动释放）**，无 64KB 栈数组；**≤32000 全支持**（建/写/读/stat/枚举/rename/delete，视图读回+真实盘零写）；**32760 在默认长 stageRoot 下 fail-closed + `R30 edge` 归因**（staged 物理路径 >32767，按 Lead 拍板方案 b 不重写 staging 布局）；>32767（33000）fail-closed；短路径不回退 |
| 栈安全 | 直接整体 32768 有栈溢出风险（单帧可达 ~640KB） | **有证据**：`-Wframe-larger-than=8192` 0 warning（最大帧 4.9KB）；压测 `200 长路径写读删 + 40 层深目录 + 300 枚举 + rename` = `STRESS-OK`、无崩溃 |

最终树：shim 已变（dll `5AAB28F3…` **331776 B**）；dist 不变（`75ACBB6E…` 176497 B）；基线 **166 条**；verify **54 套件**。

---

## 1. 修前红（gate-runner 独立）

驱动 `.t\r30-gate\run-r30-long.ts`（`\\?\` 绝对路径，注入 **signed node** 经 canonical shim，避免 CI 未签名探针 4551；
每档建目录/建目标目录/写/stat/枚举/读回/rename/读回/delete；真实盘由未注入进程核对零写）：

| 长度 | HEAD（R29 canonical）读数 |
|---|---|
| 1000 / 3000 | 全成功、真盘零写（短路径不回退） |
| **4096 / 8192 / 16000 / 32000 / 32760** | **全部 fail-closed（EPERM/ENAMETOOLONG 类）**、真盘零写、无挂起 ⇒ **红基线** |
| 33000（>32767） | mkdir/write fail-closed、真盘零写（修后保持） |

## 2. 修复（file-shim，路线 ②）

- `winstage_internal.h`：`WS_PATH_MAX 32768` + `ws_path_buf_alloc/cleanup` + `WS_PATH_BUF(name)`；
  以及 `WS_WCHAR_BUF/WS_CHAR_BUF/WS_HEAP_PTR`（ws_regstore 二维 levels 等）。
- **关键实测**：最初用 FLS 线程池 ⇒ **注入进程退出必 `0xC0000005`**（FLS 析构经已卸载 CRT 释放）；
  改为**直接 malloc/free（cleanup 自动释放）**后注入/干净进程均正常（findings 记录此教训）。
- 机械转换约 **280 处**局部缓冲（ws_file 158、ws_reg 55、ws_mask 17、ws_regstore 16、ws_util 14、ws_stage 9、
  ws_entry 8、ws_t3reg 4、ws_hook 1），短路径逻辑未改；12 处 `sizeof(heapPtr)` 改为显式尺寸。
- 超限 guard 日志改为 `R30 edge`；支持上限 = `min(32767, WS_PATH_MAX - (len(stageRoot)+24))`；
  **不实现 hashed/短名 staging**（32760–32767 需同步枚举/apply 反向映射，登记残余）。
- ABI：DLL exports 仍 15、0 warnings；私有 DLL 331776 B；canonical 331776 B `5AAB28F3…`。

### 读数
- `tests/r27-edge-paths.ts` 扩到 **16 断言**：4096/8192/16000/32000 的 write/mkdir/read/stat/rename/delete **全支持**
  （暂存+视图读回+真盘零写）；33000/>32767 与 32760 fail-closed+`R30 edge`；近边界 1k–4k 支持。
  **canonical R29 红 16/7 → 私有/最终 canonical 绿 16/0**。
- 回归（真机，隔离 stage 根，私有 out）：r23 13/0、r21 24/0、r20 22/0、r19 17/0、r22 12/0、r28 19/0、r24 13/0、
  e2e-flow、workspace-regressions 29/0；hello64 `HELLO-MANAGED`；批量枚举 130/130；0 warnings。
- 栈证据：`-Wframe-larger-than=8192` 0 warning（=4096 仅 3 帧 4.2–4.9KB ⇒ 全部帧 <8KB）；
  压测 STRESS-OK（200 长路径写读删 + 40 层深目录 + 300 枚举 + rename，无崩溃）。

## 3. 最终门禁

| 关口 | 读数 | 证据 |
|---|---|---|
| `tsc` / 基线 | **0** / **166 条逐字相符** | `phase3-final-all.log` |
| **verify 54** | **ALL PASS / EXIT=0；✓=3139 / ✗=0 / SKIP=15**（r27-edge 16/0、r23 13/0、r21-file 24/0、r28 19/0、r24 13/0） | `verify-*` |
| **R30 post 独立复核** | **32/32**：≤32000 建/写/stat/枚举/读回/rename/delete 全绿 + 真盘零写；32760/33000 fail-closed+归因+零写；短路径不回退；栈/压测独立跑 STRESS-OK | `long-post-*` |
| gates | tsc 0、suite-wiring 22/0、baseline-integrity 14/0、166 条相符、residual 54/0 + plant 55/9 | 同上 |
| 矩阵 / managed / TS / T1 lane | 46/46 / 7/7 / 14/14 / 14/14 | 同上 |
| G1–G4 / R26A / R28A / R29A | 52/52 / 22/22 / 15/15 / 27/27；24/24；11/11；20/20 | 同上 |
| 4 沙箱 / lane / 生产 lane / 闭环节 | 按口径（file-cow 16/19 carrier）/ 9/9 / 9/9 / 30/30 | 同上 |

### autotest clean（DSH-as-node）

`exit=1；套件 51 通过 / 3 失败 / 0 SKIP；3069 ok / 10 bad`：①产品红 **0**；②已登记/环境：`r21-fs-policy` 8（模块身份）、
`r24-atomic` 1（E2）、`r28-apply-attributes` 19/1（仅 DSH-as-node，plain 19/0 可复现差异；非产品）、
sandbox 段 file-cow 16/19、audit 单列；③CI CodeIntegrity 本轮未命中（r20/r23/r27 均 PASS）；ebk 未跑（无 docker/KVM）。

---

## 4. 残余（R30）

1. **32760–32767 不支持**（物理 staged 路径 >32767；需要 hashed/短名 staging + 枚举/apply 反向映射，本批不做）。
2. 路径缓冲按需 malloc/free（高频 API 分配开销；OOM 下 alloc NULL 未逐点检查）。
3. 目录属性 provider 既有边界不变；继承 R27–R29 其余残余（CI 签名/策略、真实远端 SMB/ebk、R21-LC-05、
   DSH-as-node 运行时差异、ACL 非暂存语义、结构性残余 raw syscall/未 hook/默认 T1·T0 无 WAL）。

## 5. 后续（自动继续）

R31：R21-FS-07 崩溃恢复 WAL（apply 意图日志 + 下次启动/apply 检测并恢复/回滚）→ 自动进入 R32（autotest DSH-as-node
运行时差异）→ R33（环境/宿主残余文档收尾）。
