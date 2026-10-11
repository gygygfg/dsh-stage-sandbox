# R15 · 撤出的 shim 工作（源码留档）

> 来源：`.t/r15/lead/shim-wip/src/`（该目录被 `.gitignore` 的 `.t/` 忽略，因此副本入库以保证交接不随工作区丢失）

## 这是什么

R12–R14 三轮 shim 修复的**源代码快照**，共 15 个文件（含 R12 新增的 `ws_dirfind.c`、R14 新增的 `ws_secface.c`/`ws_d1trace.c`）。
**它不是当前在用件的源码**，也**不允许**直接构建后覆盖 `shim/out/**`。

## 为什么被撤出（详见 `shim/src/README-LINEAGE-WARNING.md` 的 R15 追加节）

| 事实 | 证据 |
|---|---|
| 用 R14 重建的 DLL 时，沙箱 lane 落到 `T1/restricted-token`（`fallbackReason` 里载体 PowerShell 解析不到 `whoami.exe`） | `.t\r14\lead` 的 A/B 读数；`docs/round15/R15-收口报告.md` §2.1 |
| 三件套换回 golden ⇒ lane 立刻回到 `TS/degraded=false` | 同上（决定性对照） |
| R14 的"修 D1"靠**真实盘建目录**：一次验收真实工作区多出 124 个目录（R12/R13 均为 0） | `workspace-inventory` 的 `dirs=124` |
| R14 写者用 PowerShell 回写 UTF-8 源码致 528 处非法字节，`git checkout --` 又抹掉 R13 未提交的 `ws_file.c`/`winstage_internal.h` | `.t\r14\shim\incident/**` |

## 允许的用法

1. **只作为起点**：要重做 shim 修复，从这里取代码，构建到**隔离目录**（用 `WINSTAGE_SHIM_DIR`/`WINSTAGE_SHIM_DLL` 指路），
   **不要**装进 `shim/out`。
2. 每个候选**先过 lane 判据**（`<out>/lane.txt` 必须 `tierEffective=TS && degraded=false`）**再**谈功能；
   lane 一退化立刻回滚 golden 三件套。
3. 修 D1 不得再默认牺牲隔离（`WINSTAGE_STAGE_DIRAWARE` 现为 opt-in，只有显式设 `1` 才启用）。

## 禁令

* 禁止用 PowerShell `Get-Content`/`Set-Content` 回写 `shim/src/**`（第 4 条事故的成因）；一律用编辑工具。
* 禁止把这里的产物当作"R13 的下一版"。
