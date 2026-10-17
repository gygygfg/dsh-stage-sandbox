# R11 / D4：注册表域缺陷清单

> 责任：teammate `t4-registry`（task-4）· 2026-10-10
> 每条都附**原始证据路径**与**最小复现**；产品代码未改动（只报告，不修）。
> 主报告：[registry-报告.md](./registry-报告.md)

---

## D4-R1 【P0 / 高】注册表候选 `values=0`：审批面板拿不到任何"值"变更

**现象**（`run3`）：
WAL 有 **126 条**记录、其中 `SET_VALUE` **109 条**，但冻结出来的注册表候选只有
`changes=2`（`op=mkdir`）、`summary={"keys":2,"values":0}`，另外 **13 条路径进 `unfrozen`**。
shim 自报 `host-capture.json` 也是 `"records":2`。

```
# .t\r11\registry\run3\out\stage-root\registry\host-capture.json
{"bytes":12312,"records":2,"enqueued":true,"candidateId":"cs_0002_1ffd1242"}
# .t\r11\registry\run3\out\stage-root\candidates\cs_0002_1ffd1242.json
"summary": {"files":2,"hostOperations":0,"byOp":{"mkdir":2},"bytes":0,"keys":2,"values":0,"unsupported":0}
```

**根因（由被测自己的 warning 指出，原文见 `run3/candidate-quote.txt`）**：

```
HKCR\WSP4T4_CLS: 基线读取失败（reg query HKCR\WSP4T4_CLS did not run or failed unrecognizably
(status=1, via=pipe, error=none, stderr="<乱码>: 系统找不到指定的注册表项或值。"）: refusing to
translate "we could not read it" into "the key does not exist"，该路径**不**进入候选 ——
候选必须冻结一个可验证的 before（手册 #12.6），读不到就不许假装读到
```

即：**基线读取器把"键不存在"（`reg query` rc=1 / `ERROR_FILE_NOT_FOUND=2`）当成"读不到（accessDenied）"**，
于是所有"新建键下的值写"都没有可验证的 `before` ⇒ 一律 `unfrozen` ⇒ 候选只剩两条"父键 mkdir"
（父键的基线 `HKCU\Software`、`HKLM\SOFTWARE` 可读，所以只有它们进了 diff）。

**影响**：本域的**核心交付物（审批面板）实际不可用**。即使点了"批准全部"，也只有 2 个建键动作被应用，
109 个值写入**永远不会落真实 hive**。这直接推翻"注册表暂存审批这条设计生效"的上半句。

**最小复现**：干净起点 → `New-Item HKCU:\Software\X` + `New-ItemProperty -Name V` →
`reg query HKCU\Software\X` 返回 `rc=1 "系统找不到指定的注册表项或值"` →
候选中 `X\V` 不在 `changes` 里、而在 `unfrozen` + `warnings` 里。

**建议方向（交 Lead 决定，未改代码）**：
读基线时要**区分** `ERROR_FILE_NOT_FOUND(2)` / "系统找不到指定的注册表项或值" 与真正的 `ERROR_ACCESS_DENIED(5)`：
前者应产出 `before = absent`（这正是"新建键"的语义），只有后者才按手册 #12.6 拒绝冻结。
至少应把两条计数分开上报（`unreadable` vs `absent-baseline`），别让 `values=0` 看起来像"没有值变更"。

**回归性**：与 R10 `D-R3`（`values 0/16`）同族；本轮给出了**可执行的根因**（R10 当时只有现象）。

---

## D4-R2 【P1 / 中】往"真实 hive 里已存在"的键写：内核硬拒 + **WAL 零记录**（三分类不成立）

**现象**（`run3`，干净起点；`run1` 独立复现）：对 3 个**已存在**的键写，调用方看到硬拒，WAL 里**什么都没有**。

| 探针 | 目标（已存在） | 调用方看到 | WAL |
|---|---|---|---|
| W03 | `HKCU:\Console` + 值 | `System.Security.SecurityException \| Requested registry access is not allowed.` | **无** |
| W04 | `HKCU:\Environment` + 值 | 同上 | **无** |
| W14 | `HKCU\…\Run` 值（`reg.exe add`） | `reg.exe : ERROR: Access is denied.`（exit=1） | **无** |

对比：`HARD_DENY` 记录在整份 126 条 WAL 里 **0 条**；`UNSTAGED` 只有 2 条且都是 32 位视图。

**归因**：契约 v1.4 的净变化原则（§11.2）规定"真实 hive 已存在的键 ⇒ `create/open` 是 no-op、不写 WAL"，
于是这类调用被**转发真实 API**；受限令牌下真实 ACL 直拒。**但**：调用方拿到的是**权限错误**，
而审计面既没有 `HARD_DENY`（不是 shim 拒的）、也没有 `UNSTAGED`（不是有意的透传）、更没有操作记录
⇒ **R10 D-R2 的"不可归因"原样复发**。对用户而言，"我写 `HKCU\Console` 被拒"无法区分"沙箱策略"还是"没有权限"。

**最小复现**：`Set-ItemProperty -Path 'HKCU:\Console' -Name X -Value y`（沙箱线程内）⇒ `SecurityException`；
宿主侧 `reg query HKCU\Console /v X` ⇒ 不存在；解码 `<out>/stage-root/registry/overlay.journal` ⇒ 无对应记录。

**建议方向**：透传真实 API 时按契约补一条 `UNSTAGED`（原因码如 `REAL_KEY_WRITE_NOT_REPRESENTABLE`），
或对"真实键上的写"给出显式的 fail-closed 分类；两种都比"静默转发 + 权限错误 + 零记录"可解释。

---

## D4-R3 【中】32 位视图与 WMI：两条通道**不可用于对照**，且其中一条**绕过 shim**

**(a) 32 位视图（契约正确，但功能不可用）**
`W09`（.NET `Registry32`）与 `W12`（`reg add /reg:32`）都按契约 v1.4 记 `UNSTAGED(reason=1)` 并透传，
但真实 API 一律 `Access is denied`：

```
[winstage-shim][8260][7] unstaged passthrough: HKCU\Software\WSP4T4\reg32 (reason=1) -> real API
[winstage-shim][8796][31695] unstaged passthrough: HKLM\SOFTWARE\WSP4T4\net32 (reason=1) -> real API
```
⇒ **WOW64 视图对照在本装配下无法做**（与 R10 D-R4 同形）。契约行为是对的，问题在"透传目标必拒"。

**(b) WMI `StdRegProv` 绕过注入链（需按隔离缺口记账）**
`W16`：`CreateKey rc = "Access denied"`。WMI 的注册表提供程序在 **`WmiPrvSE.exe`** 里执行，
**不在 shim 的注入链**（`shim.log` 只有 32 个被注入进程，无 `WmiPrvSE` 相关记录）。
⇒ 这是**未被 hook 的旁路**（契约 §8.6 第 1 条已声明"未注入的通道照样命中真实 hive"）。
⚠️ 判读纪律：**不要把这条"Access denied"读成"暂存失败"或"沙箱生效"** —— 它只是"用错令牌的进程去写真实键"。
在**非受限**装配下它很可能是**真实写入**（本轮 platform 模式没能单独验证 WMI 通道，记 `not-run`）。

---

## D4-R4 【低】`reg import` 在沙箱内打不开 `.reg` 文件

`run3` W15：`reg.exe import <TEMP>\wsp4t4-imp.reg` → `exit=1`：

```
ERROR: Error opening the file. There may be a disk or file system error.
file=C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\218d2fb2-…\wsp4t4-imp.reg bytes=330 hex=fffe570069006e00
```

文件是**探针自己刚写的、字节正常的 UTF-16LE `.reg`**（`bytes=330`，`ff fe 57 00 69 00…`），
且同一脚本在**宿主**上 `reg import` 成功（`host/smoke/probe-reg-out.json` W15 `readback=imp-sz-r11`）。
⇒ 失败点在**沙箱文件映射**（暂存路径对 `reg.exe` 子进程不可读），不是 `.reg` 内容。
影响：`.reg` 导入这条常见通道在沙箱内**不可用**，且报错文案（"disk or file system error"）不具备自救性。

---

## D4-R5 【低】共享覆盖 hive 频繁不可用 → 逐进程 hive（靠 journal 重放兜住）

`run3/shim.log` 的 attach 分布：`tier=1`（共享可用）**4** / `tier=2`（`overlay.local.hive`）**6** /
`tier=3`（`overlay.<pid>.hive`）**22**，共 32 次 attach；`shared hive unusable (32)` 即 `ERROR_SHARING_VIOLATION`。

本轮**跨进程读写没有丢**（`t3_replay_journal: applied=11/13 rc=0`，21 次重放；reg.exe 子进程 8/15 读到正确值），
所以 R10 的 D-R1 **在本装配下不成立**。但语义仍不干净：
* 会话视图由"WAL 重放"拼出来，**WAL 一旦被截断/不可读，跨进程视图就不完整**（contract §4.3 的撕裂尾部处理只覆盖解析）；
* 同一会话内不同进程的"私有 hive 视图 + 重放"是否与 `RegQueryInfoKeyW` 同源，本轮**未验证**（`REGDBG qik-unionfail` 在 `run1` 出现 33 次，值得下一轮单独查）。

---

## D4-R6 【低】候选 warning 文本把 `reg.exe` 的中文 stderr 解码成乱码（U+FFFD ×260）

`run3` 候选 JSON 里 `U+FFFD` 出现 **260** 次；`reg.exe` 的中文 stderr（`错误: 系统找不到指定的注册表项或值。`）
被错误编码解码后再拼进 warning（校验：`U+FFFD_count=260`，`has_zh_label=true`）。
影响：审批面板上的"为什么不能冻结"这段说明**对中文用户不可读**（而它恰好是 D4-R1 的唯一解释）。

---

## D4-R7 【信息】`lane.txt` 可能是假红（口径提醒，非本域缺陷）

`docs/archive/round110/env/scripts/sbx-extract.mjs` 依赖 `<out>/stage-root-path.txt`。Lead 的 `probe3/out` 缺该文件
（且 `stage-root-inventory.txt` 记为 `missing`），于是 `lane.txt` 输出 `LANE_OK=false`，
而 raw `stage-root/sandbox-lane.json` 明确是 `tierEffective=TS, degraded=false, shimCount=1`。
本域 R1/R3 的 `stage-root-path.txt` 存在，`lane_ok=true`，与 raw 一致。
⇒ 判 lane 时**只认 raw `sandbox-lane.json`**；`lane.txt` 的 `missing` 分支应区分"文件缺失"与"档位不达标"。

> **R11 Lead 更正（2026-10-11 01:2x）**：`probe3/out/stage-root-path.txt` 缺失是 Lead 早期探针的**设施时序问题**，
> 事后已补该文件并重抽：现在 `.t\r11\probe3\out/stage-root-path.txt` 存在（82 B），`lane.txt` = **`LANE_OK=true`**。
> 所以"probe3 缺文件 / LANE_OK=false"的表述**与当前盘面不符**；"只认 raw `sandbox-lane.json`"这条口径仍然正确且被复核者独立复算确认。

---

## 探针侧缺陷（我自己的，P3，已修/已标注）

| # | 缺陷 | 后果 | 处置 |
|---|---|---|---|
| P1 | PS 函数名 `R` 被内建别名 `r`（`Invoke-History`）遮蔽（别名优先于函数） | 第一次宿主冒烟读面 8 条全未执行 | 改名 `DoRead/DoWrite/DoXp`（`payload/probe-reg.ps1`） |
| P2 | `& reg.exe query $q`（整串含空格当一个参数） | 我的 `/s`、`/f … /k /s` 转储与 `regstate.ps1` 的 `search` 段**无效**（假 rc=1） | 改为数组传参 `& reg.exe query @a`（`host/regstate.ps1`）；`host/platform-real-writes.txt` 因此作废，已如实登记 |
| P3 | PowerShell **逗号优先级高于 `+`**：`@(…, '[' + 'path' + ']', …)` 把 `[` / path / `]` 拆成 3 个数组元素 | 生成的 `.reg` 每行被拆开 ⇒ `reg import` exit=0 **静默不导入**（差点被误读成"暂存没捕获值写"） | 加括号：`('[' + 'path' + ']')`；验证 `elements=7` + 内容正确 |
| P4 | `contaminated` 判据写成"任何 preexist 命中"，把 3 个**故意存在的系统键**（`Console`/`Environment`/`Run`）算成污染 | R3 的 `DIGEST` 显示 `contaminated=True`、`preexist=3`，易被误读 | 正确口径 = 仅探针自有的 `WSP4T4*` 键；宿主侧从 raw 数组重算 ⇒ R3 **探针自有污染 = 0**（13/13 `keyExists=false`） |
| P5 | R1 与 R2 时间重叠（上一轮的真实写入仍在盘上） | R1 的 readback/读面被污染，出现"写报失败却能读到"的假象 | 判 R1 为**污染运行**，用干净起点**重跑 R3** 作主证据；R1 只保留"写尝试 + WAL"结论，且该结论已由 R3 独立复现 |

> P3 值得单独强调：**"坏 `.reg` + `reg import` 返回 0"** 会让"暂存没捕获"和"文件根本没导进去"无法区分。
> 任何用 `reg import` 做暂存证据的测试，都必须先自证 `.reg` 字节（本轮已把 file bytes/hex 写进探针输出）。
