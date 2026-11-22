# M0 性能报告：ProjFS + SimRep（同路径视图）

> 目的：回答“M0 的功能 GO 是否也成立为**性能** GO”。结论：**混合（有保留）**——
> 稳态可接受，但**首次触碰每个文件的成本（~4 ms/文件，样例 provider）不可接受**；
> 产品 provider 必须批量提供元数据，并在 M1 重新测。
>
> 数据：[`M0-PERF.json`](./M0-PERF.json)（`perf.ps1` 输出）、`perf.log`、
> `probe2.log`（`probe2.ps1` 输出）。全部为 guest 内实测。

## 1. 环境

| 项 | 值 |
|---|---|
| VM | dockurr/windows `win10-m0`，6 GB RAM / 4 vCPU，QEMU/KVM |
| OS | Windows 10 Pro 19041，testsigning |
| 视图 | lower `C:\m0\lower` → view `C:\m0\view`；逻辑路径 `C:\m0\ws`（SimRep 重定向） |
| provider | 微软 `SimpleProviderManaged`（self-contained，net8.0） |
| 数据 | 1 KiB 文件；`flat1000/5000/20000`、`tree`（10 目录 × 100 文件） |

测量方法：`Stopwatch` 包住 `[IO.Directory]::GetFiles` / `FileInfo` / `ReadAllBytes` /
`WriteAllBytes`；“cold” = 重启 provider 后立即测（NTFS 页缓存无法从 PowerShell 清空，
所以 cold 是**下界**）。

## 2. 结果

### 2.1 稳态（占位符已存在）

| 操作 | NTFS (lower) | ProjFS (view) | 同路径 (ws) | ws/NTFS |
|---|---:|---:|---:|---:|
| 枚举 1 000 | 11.8 ms | 37.2 ms | 24.1 ms | 2.0× |
| 枚举 5 000 | 3.3 ms | 124.8 ms | 99.4 ms | 30× |
| 枚举 20 000 | 17.3 ms | 394.2 ms | 394.9 ms | 23× |
| 递归枚举 1 000 (10 目录) | 11.5 ms | 91.2 ms | 90.0 ms | 7.8× |
| 5 000 × `FileInfo` | 507 ms | 1 000 ms | 1 003 ms | 2.0× |
| 读 1 KiB（首次） | 10.9 ms | 15.9 ms | 6.2 ms | 0.6× |
| 读 1 KiB（热） | 2.3 ms | 2.6 ms | 2.0 ms | 0.9× |
| 建 1 000 个文件 | 712 ms | — | 2 635 ms | 3.7× |
| 改名 100 | 64 ms | — | 302 ms | 4.7× |
| 删除 500 | 64 ms | — | 581 ms | 9.0× |

枚举的 `ws` 与 `view` 基本一致 ⇒ **SimRep 重定向几乎没有额外成本**；成本都在 ProjFS。
枚举约 **20 µs/文件**（20 000 个 395 ms），对 2 万文件的 `node_modules` 扫描是可接受的
（约 0.4 s）。

### 2.2 首次触碰（关键）

| 场景 | 5 000 文件 | 每文件 |
|---|---:|---:|
| 全新 ProjFS 实例（`view2`，占位符从零创建） | **20 059 ms** | **4.0 ms** |
| 同一 view，provider 重启后（占位符已在） | 1 590 ms | 0.32 ms |
| 之后的热测 | 957–1 000 ms | 0.19 ms |
| 同一目录在 `ws`（经重定向）再测 | 1 022 ms | 0.20 ms |

即：**每个文件第一次被枚举/stat 时，ProjFS 会向 provider 要元数据；
SimpleProviderManaged 每次 `GetFileInfo` 都重新打开源文件，约 4 ms/文件。**
对 2 万文件仓库 = **约 80 秒**（`git status` / `pnpm install` 首次扫描）。
这不是 VM 慢的问题：稳态 `FileInfo` 只有 0.2 ms/文件，差距来自 provider 实现。

### 2.3 稳定性事件

- 全新实例对 **20 000** 文件做首次枚举 + `FileInfo` 时，**超过 10 分钟未完成**，
  guest CPU 归零（QEMU 主循环也不再响应 monitor）⇒ 判定为 provider/ProjFS 侧挂起，
  不是单纯慢。样例 provider 的首次触碰路径在 2 万文件规模上不可用。
- 期间 guest 于 16:12:53（guest 时间）异常关机一次（`Power 41/6008`，**无 BugCheck 1001**）；
  当时正运行 `stat.ps1`（反复 stop/start provider）。无法归因到具体组件，
  列为 M1 稳定性风险（驱动上线后必须做 24 h soak）。

## 3. 结论与对 M1 的要求

**功能 GO 不变，性能 GO 有条件**：

1. 稳态（枚举/读/元数据）在 2× 以内，读路径甚至与 NTFS 持平 ⇒ 方案本身可用。
2. **产品 provider 必须批量取元数据**：
   - 目录枚举时一次性读取 lower 目录（`FindFirstFileEx` / `Directory.EnumerateFileSystemEntries`）
     建立 per-directory index，`GetFileInfo` 只查内存，不再 open 源文件；
   - 目标：首次触碰 ≤ 0.2 ms/文件（与稳态一致），2 万文件 ≤ 5 s。
3. 写/改名/删除是 4–9× 慢（ProjFS 回调 + 占位符状态机）。工作区写入是**有限**的
   （agent 改文件），可接受；但 `pnpm install` 这类数万小文件写入会明显变慢，
   应把 `node_modules`/构建缓存放在视图**外**（store 或 workspace 的排除目录）。
4. 保留“**完整复制 + 重定向**”作为配置开关：大仓库首次进入视图若仍超过阈值，
   直接复制到视图（20 000 × 1 KiB ≈ 15 s）比 ProjFS 首次触碰更快；代价是磁盘与
   “复制后与 lower 的漂移”必须由 view diff 显式管理。
5. 在 M1 的验收里加入**性能门禁**（本报告 §2.1/§2.2 的同一场景），不达标不得宣称
   `enforcement: 'kernel'`。

## 4. 复现

```bash
# 宿主：provider 交叉构建
packages/win/native/m0/build-provider.sh --work /srv/ebk/dshnt-m0 --sdk 8.0
# guest：perf.ps1（功能 + 稳态）与 probe2.ps1（首次触碰 + 关机取证）
#   见 native/m0/guest/perf.ps1、native/m0/guest/probe2.ps1
```

`perf.ps1` 会重建 `C:\m0\lower`、重启 provider、加载/attach SimRep；
`probe2.ps1` 复用已有 lower/view，并读 System 事件日志。
