# R28 · R21-FS-08 apply 属性面 + R21-FS-07 口径更新（第七批）

> 范围：`packages/win`。执行：Lead + 2 个 teammate（file-shim / gate-runner），2026-10-21。
> 前置：R19–R27 已提交（`310157f`）。本批：**R21-FS-08（apply 属性面：hidden/system 不还原、ACL 继承）** +
> **R21-FS-07（跨进程 apply 锁口径更新）**。

---

## 0. 一句话结论

| 项 | 内容 | 结果 |
|---|---|---|
| **R28-A（R21-FS-08）** | apply 修改/新建真实文件时 `FILE_ATTRIBUTE_HIDDEN/SYSTEM` 丢失（只读位已由 R21 保留） | **已修**：staged 属性优先（overlay `SetFileAttributesW` 落点）→ `entry.baseWin32` → apply 前真实值；短路径 `attrib.exe`、长路径 PowerShell `[int][IO.File]::Get/SetAttributes` + `\\?\`；失败 `attributeWarnings` **不吞错**；R24 回滚快照同步恢复 H/S |
| **R28-B（ACL 口径）** | 显式 ACE 经 rename-replace 不保留（新文件继承父目录 ACL） | **不修，如实登记**：ACL 继承不是暂存语义；默认继承前后 `icacls` 文本不变（A11）、显式 ACE 不保留（A12） |
| **R28-C（R21-FS-07）** | 跨进程 apply 无锁 | **口径更新**：R24/R25 已加同 store `<store.dir>/apply.lock`（O_EXCL、30s 等待、崩溃锁 120s 清理、`APPLY_LOCK_TIMEOUT`）；残余只剩不同 store 并发（B4.2）× 崩溃恢复无 WAL |

最终树：shim 未变（dll `8BF34D53…` 329728 B）；dist `40517301…`（176497 B）；基线 **166 条**；verify **54 套件**。

---

## 1. 修前红（gate-runner 独立，不依赖注入器）

驱动 `.t\r28-gate\run-r28-attr.ts`：进程内真实 `src/workspace.ts` apply 路径 + 未注入进程用 PowerShell `[IO.File]`/`icacls`
读真实盘（因此不受 R27 CodeIntegrity 探针窗口影响）。证据 `.lead/logs/gate-runner-r28/attr-pre-r27canonical/`。**10 断言 / 0 失败（pre 口径）**。

| 场景 | 修前读数 |
|---|---|
| A 修改既有 `HIDDEN\|SYSTEM` 文件 | 属性 `6`(H\|S) → apply 后 `32`(NORMAL)：**hidden/system 丢失**；内容正确 ⇒ **R21-FS-08 红基线** |
| B 修改既有只读文件 | apply 后 readonly 仍 true、内容正确 ⇒ 只读位不回退（回归对照绿） |
| C 新建文件 | 默认 NORMAL；**ACL 带继承 ACE `(I)`**（Everyone/SYSTEM/Administrators/用户继承自父目录）⇒ 普通文件不误设；ACL 继承口径如实 |
| D apply 失败（blob 缺失） | `status=rolled-back` + `failed=[{code:'BLOB_MISSING'}]`（不谎报）；原内容与原 H/S 属性**均未变** |
| E 口径 | host `Workspace.writeFile` 候选不带属性元数据；shim overlay 的 `SetFileAttributesW` 才把 H/S 落在暂存文件上 ⇒ 修后"staged 属性→apply"由 file-shim 套件/注入通道覆盖 |

## 2. 修复（file-shim，`src/workspace.ts` 160748 B）

- **hidden/system 还原**：短/中路径用 `attrib.exe` 读/写；长路径（≥248 字，≤4095）用 PowerShell
  `[int][IO.File]::Get/SetAttributes` + `\\?\`（**必须 `[int]`**：直接输出是 "Hidden, System" 枚举名，实测坑）；
  参数按数组传递 ⇒ 空格路径安全。
- **来源优先级**：暂存态（`store.stagedPath(change.path)`，沙箱内 `SetFileAttributes` 改的就是它）显式 H/S →
  用 staged；否则 `entry.baseWin32`（`writeFile` 首次暂存时从真实文件捕获）；再否则读 apply 前真实值。
  **created** 按 staged H/S（+ staged readonly mode）；普通文件不误加。
- **失败不吞错**：`attributeWarnings` 随 `applyCandidate` 结果与 `candidate.lastApply` 返回
  （`ATTRIB_SET_FAILED/READ_FAILED`）——内容照常落盘但**绝不**声称"已还原"。
- **R24 回滚**：快照同时保存/恢复 H/S，失败报 `ROLLBACK_ATTRIBUTE_FAILED`（不谎称 rolled-back）。
- **ACL（不修）**：A11 验证默认继承 ACL 前后 `icacls` 文本不变；A12 钉住显式 ACE 经 rename-replace **不保留**
  （新文件继承父目录）⇒ findings/§13 写清"ACL 继承不是暂存语义"，不声称 ACL 已还原。

### 读数
- 新套件 `tests/r28-apply-attributes.ts` = **12 断言**：HEAD 基线（修前）**FAIL 12/7**（A1–A4/A7/A8 hidden/system 丢、
  A9 无 warnings）；修后 **PASS 12/0/0**。
- 回归（真机，隔离 stage 根）：`r24-atomic-apply` 13/0、`r21-file-adversarial` 24/0、`e2e-flow` 通过、
  `workspace-regressions` 29/0、`r19-file` 17/0、`r20-file` 22/0、`r22-file-advex` 12/0、`r23-long-path` 13/0、`selftest` 通过；
  `tsc=0`；本轮未改 shim C（私有 out 沿用 R27 329728 B，0 warnings）。
- 最终 canonical（Lead 复跑）：`r28-apply-attributes` 12/0、`r24-atomic-apply` 13/0、`r21-file-adversarial` 24/0、
  `workspace-regressions` 29/0。

### 残余（R28）
1. 显式**清除** hidden/system 的暂存态语义未支持（staged A 与"从未设置"不可区分 ⇒ 回退保留原值，不误清）。
2. 目录树回滚只恢复目录根 H/S（子项属性未逐项）。
3. >4095 路径按 R27-A 方案 A fail-closed。
4. ACL 继承不是暂存语义（新文件继承父目录 ACL；显式 ACE 不保留）。

## 3. R21-FS-07 口径更新（Lead）

§13 行更新：R24/R25 已加同 store `<store.dir>/apply.lock`（O_EXCL；等待 30s 后重读候选 ⇒ `ALREADY_APPLIED`；
超时 `APPLY_LOCK_TIMEOUT`；崩溃遗留锁 mtime>120s 清理）+ 回滚只恢复本进程写过的路径；
**残余只剩不同 store 并发（B4.2，last-writer-wins）× 崩溃恢复无 WAL**。

## 4. 测试与最终门禁

最终树：shim **未变**（dll `8BF34D53…` 329728 B）；dist **`40517301…`**（176497 B）；源码基线 **166 条**；**54 套件**。

| 关口 | 读数 | 证据 |
|---|---|---|
| `tsc --noEmit` | **0** | `phase3-final-all.log` |
| suite-wiring / baseline-integrity / baseline `--check` | **22/0** / **14/0** / **166 条逐字相符** | 同上 |
| residual 正常 / `--plant` | **54/0** / 55/9（自证） | 同上 |
| **R28 post 属性独立复核** | **11/11**：修改既有 H\|S 文件 → 属性 `6`→**`38`(A\|H\|S) 保留/还原**；只读 apply 后仍 true；普通 created=NORMAL、ACL 带继承 `(I)`；apply 失败 `rolled-back`+`BLOB_MISSING` 如实、原内容与原 H/S 不变 | `attr-post-*` |
| **verify 54** | **51 套件全绿**（含 `r28-apply-attributes` **12/0**、`r24-atomic-apply` 13/0、`r21-file` 24/0、`workspace-regressions` 29/0、`e2e-flow` 21/0、`r27-edge` 15/0）；**3 个注入/探针套件被本机 CodeIntegrity 策略拦**（见下）⇒ 3110 ok / 21 fail / 15 SKIP | `phase2-verify.log` |
| 46 矩阵 / managed / TS lane / T1 lane | **46/46** / **7/7** / **14/14** / **14/14** | `phase3-final-all.log` |
| G1 / G2 / G3 / G4 | 52/52 / 22/22 / 15/15（1 SKIP） / 27/27 | 同上 |
| R26A / R27A / R28A | 24/24 / 41/41 / **11/11** | 同上 |
| 4 沙箱 / lane / 生产 lane / 闭环节 | diag 22/0、file-cow 16/19（carrier）、registry-unstaged 38/0、delete PASS(36)；lane/生产 lane 9/9；闭环节 30/30 | 同上 |

### 本机 CI 策略阻断（单列，非产品；R27 起持续）

- verify 54 中 3 个**注入器/探针**套件被拦：`r20-file-boundaries` B8.4、`r20-managed-carrier`（8 断言）、`r23-long-path`（12 断言）；
  证据 `win32Error=4551`（"An Application Control policy has blocked this file."）+
  `Microsoft-Windows-CodeIntegrity/Operational` 事件 **3077/3033**、Policy ID `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`
  （命中 `.t\r20-suite\file-boundaries\r20-devprobe.exe`、`.t\r20-managed-carrier\hello-x64.exe`、
  `.t\r23-long-path-*\probe-longfs.exe`）。
- R27 已记录同一策略；末次 attest 仍活跃（`r20-managed-carrier` 11:37 新事件）⇒ 按 R27 拍板**不再硬绕/改构建位置**。
  **产品面权威对照**：R27 策略窗口前 **verify 53 ALL PASS（✓=3119 / ✗=0 / SKIP=15，10:08）**；R28 非注入套件全绿、
  R28 post 11/11、autotest clean 中 r27-edge/r28-apply/r20/r23 均 PASS。
- 建议：CI 给探针签名或对 `.t` 构建物做受控策略排除（属测试基建/机器策略，非产品）。

### autotest clean（DSH-as-node）

`exit=1；套件 52 通过 / 2 失败 / 0 SKIP；断言 3062 ok / 9 bad`。三类口径：
①真红 **0**；②已登记环境：`r21-fs-policy` 8（模块身份）、`r24-atomic-apply` 1（E2 只读回滚），
sandbox 段 file-cow 16/19、audit evtx 单列；③CI 阻断本轮未命中（探针已预热：r27-edge 15/0、r28-apply 12/0、r20/r23 PASS）。
plain-node 沿用 R27 口径（环境文案 + sandbox 跳过；`--only diag-bindings` exit=2、`--only selftest` exit=0）。ebk 未跑（无 docker/KVM）。

---

## 5. 残余（R28 全局）

- 属性面：显式清除 H/S 不支持；目录树子项回滚属性不恢复；ACL 继承非暂存语义。
- 继承 R27 及更早残余：>4095 路径（方案 A fail-closed）、跨卷 rename=copy-up、真实远端 SMB 未验证、
  CodeIntegrity 策略环境、R21-LC-05 宿主 CLI、结构性残余（raw syscall/未 hook 面/默认 T1·T0 无 WAL）。

## 6. 后续

- 结构性残余按既有口径保留；
- NT 上限长路径（header/栈审计）专项；
- CI CodeIntegrity 探针签名/策略排除（基建）；
- ebk/真实远端 SMB 环境缺口。
