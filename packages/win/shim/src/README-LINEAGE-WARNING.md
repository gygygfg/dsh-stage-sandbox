# ⚠ shim/src 血统警告 —— 本目录当前**不是**在用 DLL 的源码

> 写入者：Lead · 时间：2026-10-09 18:2x（+08:00）· 依据：`docs/round10/LEAD-修复记录.md` §V5、
> `docs/round10/shim/evidence/D39/D44/D45/D46-*`、`docs/round10/汇总报告.md` §8.5/§8.5.1

## 事实

| 项 | 现值 |
|---|---|
| **在用件** `shim/out/winstage-shim.dll` | `02C7418FF0F11AFD45FEEA601733E848ECB697FD393915565420F7A41248B76F`（246,784 B）= **只含 R 修复**（`LdrLoadDll` 单模块补丁），已通过 `carrier-flake 100 = 0/100`、回归驱动两 mode 宿主真实盘零写、5 套件绿 |
| `shim/src/ws_hook.c` | **task-11c 血统**（`ws_hook_converge`×6、`g_patchedBases`×7、`LdrLoadDll`×0 ⇒ 实测 70/100 崩），且**源码 ≠ 在用件** |
| `shim/src/ws_t3reg.c` / `ws_regstore.c` | 含 **registry 的 D-R1 改动** —— 该改动在受控替换窗口（候选 `5E7A010E…`）中被**并集门禁否决**：`reg delete /reg:32` 由 `ACCESS_DENIED(5)` 变为**返回 0**、**真实 hive 键真的消失**、UNSTAGED journal 记录缺失（`D46-2` §红项分类）⇒ **不得进入在用件** |
| 其余 `shim/src/*`（`ws_file.c` 等） | 含 13c 的**未采纳**目录面钩子（`NtQuery*File`，假设已被否证） |

## 禁令

1. **禁止**用当前工作树执行 `node tools/build-shim.mjs`（或任何重建）后**替换** `shim/out/**` ——
   产出会是"11c 血统 + 已否决的 D-R1 + 已否证的目录面钩子"，属**未验证/已否决件**。
2. 需要候选时：构建到隔离目录（如 `.t/round10/shim/out-<rev>`），用 `WINSTAGE_SHIM_DLL`/`WINSTAGE_SHIM_DIR` 指路
   仅能验证**宿主**侧行为；**注入态端到端必须走受控替换窗口**（见下方协议）。
3. 任何替换都必须：备份现值并记 sha256 → 冻结广播 → 只复制 DLL、**绝不覆盖** `winstage-inject.exe`/`winstage-probe.exe`
   → 跑完整门禁（血统三判据 + 并集门禁 + 相应的注入态用例）→ **全过保留 / 任一不过立刻回滚**。
4. 改 `shim/src` 前先备份到 `.t\round10\shim\backup-<ts>\` 并记 sha256；**禁止**定义与内置别名同名的函数
   （`rd`/`rm`/`ls`/`cp`/`mv`/`cat`…），删除/回退一律 `Remove-Item -LiteralPath <绝对路径>` 且先打印断言。

## 恢复到"源码 = 在用件"的可靠路径（见 §V5 的**签名锚点**，不要用注释文本定位）

削掉 11c 的 `g_patchedBases` 三件套与 `ws_hook_converge`、把 4 处 `ws_hook_converge(h)` 改回 `ws_hook_refresh_module(h)`、
重放 R 的 4 处增量（`WS_TARGET(LdrLoadDll)` / `"LdrLoadDll"` / map 行 / `ws_LdrLoadDll` 实现），
删掉 13c 的 NtQuery 残留；**并决定 D-R1 的处置**（修复 `/reg:32` 逃逸后再谈采纳，或整体回退）。
判据不是"看起来对"，而是**功能门禁**：`carrier-flake 100 = 0/100`、回归驱动两 mode 宿主真实盘零写、
15 exports + 0 warning + 注入器/探针原件未覆盖。

---

# ⚠⚠ R15 追加：R12–R14 的 shim 工作**整体撤出**（2026-10-11 15:0x）

## 现状（已生效）

| 项 | 现值 |
|---|---|
| **在用件** `shim/out/winstage-shim.dll` | `63808F5188643C08…`（257,024 B）= **golden**；注入器 `07FE55DD…`、探针 `8CF81F4F…` 同为 golden |
| `shim/src/**` | **已 `git checkout` 回到提交基线**（工作树干净）——即**不含** R12 枚举面、R13 32 位/注册表、R14 安全描述符面 |
| R12–R14 的 shim 源代码与产物 | 全部留档在 **`.t/r15/lead/shim-wip/`**（`src/` 17 个文件 + `installed-F544AE15.dll` + `r14-reconstruction-C6540A37.dll`） |

## 为什么撤出（每条都是实测，不是推断）

1. **R14 重建件破坏 TS 档**：装 R14 重建版（`C6540A37…` / `01BB4C16…`）时沙箱 lane 落到
   `tierEffective=T1 / launchMode=restricted-token`，`fallbackReason` =
   `transparent shim unavailable … report.ok=false & : The term 'whoami.exe' is not recognized …`
   —— 载体 PowerShell 在**注入态**里连 `whoami.exe` 都解析不到，透明垫片探测因此 fail-closed。
   **决定性对照**：同一宿主、同一环境，三件套换回 golden ⇒ lane 立刻回到 `TS / degraded=false`。
2. **R14 的"修 D1"靠真实盘建目录**：`ws_util.c::ws_dir_aware_after_staged()` 在 staged 目录建好后
   `CreateDirectoryW(logical)` 顺手在**真实盘**建同名目录。Lead 复验：一次验收真实工作区多出 **124 个目录**
   （`workspace-inventory` `dirs=124`），而 R12/R13 同型验收均为 `dirs=0` ⇒ 破坏"写入只进暂存"的核心承诺。
3. **配对约束**：`F544AE15…`（R12 用过、当时 TS）单独配 golden 注入器也掉 T1 ⇒ 注入器与 DLL **必须成对**使用；
   而 R14 的事故让 R13 的原对丢失。
4. **R14 事故**：R14 写者用 PowerShell `Get-Content`/`Set-Content` 改 UTF-8 源文件（528 处非法字节），
   随后 `git checkout --` 恢复，**连带抹掉 R13 未提交的 `shim/src/ws_file.c` 与 `winstage_internal.h`**；
   它重建了等价物但不是逐字源码，`shim/out` 的 R13 产物（`F078C358…`）也随之丢失。

## 禁令（R15 起）

1. **禁止**把 R12–R14 的重建产物装进 `shim/out`；做实验请构建到隔离目录并用 `WINSTAGE_SHIM_DIR`/`WINSTAGE_SHIM_DLL` 指路。
2. 任何 shim 改动都要**以 `.t/r15/lead/shim-wip/` 为起点重做**，且每一步**先过 lane 判据**
   （`<out>/lane.txt` 必须 `tierEffective=TS && degraded=false`）**再**谈功能；lane 一退化立刻回滚 golden 三件套。
3. 修 D1 若再走"真实盘建目录"的路子，**默认必须关**（本轮起 `WINSTAGE_STAGE_DIRAWARE` 已改为 opt-in：只有显式设 `1` 才启用）。
4. 改 `shim/src` 一律用编辑工具（`edit`/`write`），**绝不用 PowerShell `Get-Content`/`Set-Content` 回写源码**（第 4 条事故的成因）。
