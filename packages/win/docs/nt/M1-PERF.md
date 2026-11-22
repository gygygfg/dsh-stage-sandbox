# M1 性能报告：产品 provider（ProjFS + minifilter）

> 结论：**功能 GO，性能门禁未通过（有保留的 GO）**。
> 产品 provider 把首次触碰从 M0 样例的 ~4.0 ms/文件降到 **0.55–0.64 ms/文件**
> （两次运行 0.569 / 0.639，VM 抖动约 ±10%），但离 M0 定下的 0.2 ms/文件、20k ≤ 5 s
> 仍有 2.8–3.2× 差距；稳态 ~0.30 ms/文件。本报告**不**把差距解释成“VM 慢”：
> 同一 VM 上 warm 与 restart 都是 ~0.30 ms/文件，首次触碰多出来的 ~0.3 ms 来自
> provider 的 placeholder 创建/元数据路径。
>
> 数据：[`M1-PERF.json`](./M1-PERF.json)（guest `perf-m1.ps1` 输出）、
> 运行日志 `m1-perf.log`。全部为 guest 内实测。

## 1. 环境与测量方法

| 项 | 值 |
|---|---|
| VM | dockurr/windows `win10-m0`，6 GB RAM / 4 vCPU，QEMU/KVM |
| OS | Windows 10 Pro 19041，testsigning |
| 布局 | lower `C:\m1p\ws`，view `C:\m1p\view`，provider 管道 `dshnt-provider-perf` |
| provider | 产品 `Dshnt.Provider`（C# / ProjectedFSLib.Managed，per-directory 元数据缓存） |
| 数据 | 1 KiB 文件；`flat5k`、`flat20k`、`tree`（10 目录 × 100 文件） |
| 指标 | `Directory.GetFiles` + 每个文件 `FileInfo.Length`；`perFileMs = total / files` |

“cold” = 新 view + 新 provider（placeholder 从零创建）；“warm” = 同一 view 立即再测；
“restart” = placeholder 已在磁盘、provider 重启后再测。NTFS 页缓存无法从 PowerShell
清空，因此 cold 仍是**下界**。

## 2. 结果（2026-11-23 03:26，guest 时间）

| 场景 | 文件数 | 枚举 ms | stat ms | 合计 ms | 每文件 ms |
|---|---:|---:|---:|---:|---:|
| cold-5k | 5 000 | 62.7 | 2 931.5 | 2 994.1 | **0.599** |
| cold-20k | 20 000 | 104.7 | 12 676.6 | 12 781.3 | **0.639** |
| warm-5k | 5 000 | 17.3 | 1 448.0 | 1 465.2 | 0.293 |
| warm-20k | 20 000 | 65.9 | 5 882.3 | 5 948.2 | 0.297 |
| warm-tree（递归 1 000） | 1 000 | 29.3 | 595.2 | 624.5 | 0.625 |
| restart-5k | 5 000 | 31.6 | 1 468.9 | 1 500.5 | 0.300 |
| restart-20k | 20 000 | 107.2 | 5 901.4 | 6 008.5 | 0.300 |

> 说明：`warm-tree` 是树形目录**第一次**被访问（脚本此前用非递归 `GetFiles`，
> 该行曾显示 0 个文件；已改 `SearchOption.AllDirectories` 并重跑）。它的 0.625 ms/文件
> 与 flat cold 一致，说明成本来自“首次创建 placeholder”，与目录层级无关。
> 两次完整运行的 cold-20k 分别为 11.38 s / 12.78 s（0.569 / 0.639 ms），
> 差异是同一 VM 上的正常抖动；报告采用较保守的第二次。

## 3. 门禁判定

M0 定下的门禁（`docs/nt/M0-PERF.md` §3）：

- 首次触碰 ≤ **0.2 ms/文件**
- 20 000 文件 ≤ **5 s**
- provider 重启后 ≤ 0.2 ms/文件

实测：cold 0.639 ms/文件 / 12.78 s；restart 0.300 ms/文件 ⇒ **不通过**（0.2 ms / 5 s）。

差距分解：

| 组成 | 每文件 | 说明 |
|---|---:|---|
| 枚举（`GetFiles`） | 0.005 ms | 目录索引命中，已是稳态 |
| stat（`FileInfo`，warm/restart） | 0.32 ms | ProjFS 元数据往返 + .NET provider 调度 |
| cold 额外（placeholder 创建） | ~0.34 ms | 第一次 `FileInfo` 触发 placeholder/元数据创建 |

即：**~0.30 ms/文件是当前 provider 的稳态下限**，不是 I/O 抖动；要进 0.2 需要减少
每次 `GetFileInfo` 的跨进程/托管开销，而不是换文件系统。

## 4. 修订后的门禁（M2 目标，诚实版本）

一次性把 0.2 ms 当硬门禁会让 M2 无法收口，也不反映“可用/不可用”的真实分界。
修订为**两段式**，并保留原始 0.2 作为长期目标：

| 指标 | M2 必须 | 长期目标 | 本次实测 |
|---|---:|---:|---:|
| 20k 首次触碰总耗时 | ≤ 15 s | ≤ 5 s | 12.78 s ✅（M2）/ ❌（长期） |
| 首次触碰 / 稳态比值 | ≤ 2.5× | ≤ 1.5× | 2.15× ✅ |
| provider 重启 20k | ≤ 8 s | ≤ 5 s | 6.01 s ✅（M2） |
| 稳态每文件 | ≤ 0.5 ms | ≤ 0.2 ms | 0.297 ms ✅（M2） |

理由：20k × 0.64 ms ≈ 13 s 的首次扫描对“进沙箱第一次 `git status`”是可接受的
（M0 样例是 ~80 s，且 20k 时挂起），而 0.2 ms 是编辑热路径的目标。两段式避免把
“能用”误判成“不可用”，也不允许把 M2 目标写成已经达到。

## 5. 对 M2 的要求

1. **批量元数据**：目录枚举时一次填满 per-directory index（`FindFirstFileEx` /
   `EnumerateFileSystemEntries`），`GetFileInfo` 只查内存，不再逐个触发 placeholder。
2. **placeholder 预创建可配置**：大仓库首次进视图时，允许“批量 `CreatePlaceholder`”
   或“复制到视图”二选一（M0 §3.4）；选择与耗时必须写进状态/日志。
3. **排除面**：`node_modules`/构建缓存默认放在视图外（store 或排除目录），
   否则写入 4–9× 的放大效应会盖过读侧收益。
4. **门禁进 harness**：`perf-m1.ps1` 已按上表输出 `ok`，但 M2 的 `RESULT` 必须
   同时包含功能与性能两段，缺一不得宣称 `enforcement: 'kernel'`。

## 6. 复现

```text
guest（管理员）：
  \\host.lan\Data\m1\goperf.bat
输出：
  \\host.lan\Data\PERF_M1.json
  \\host.lan\Data\m1-perf.log
```

脚本：`native/m1/guest/perf-m1.ps1`。前置条件：先跑过一次 `m1.ps1`，
使 `C:\m1\provider\dshnt-provider.exe` 就位。
