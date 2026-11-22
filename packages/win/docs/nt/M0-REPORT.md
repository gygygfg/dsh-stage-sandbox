# M0 报告：ProjFS + SimRep 同路径重定向

> 结论：**GO**。在一次性 Windows 10 VM 上实测通过“同路径透明 + ProjFS COW + 内核重定向”的
> 核心场景；可以进入 M1（按 `docs/nt/README.md` 的 hybrid 架构实现产品驱动）。
>
> 原始结果：[`M0-RESULT.json`](./M0-RESULT.json)（guest 写出的 `RESULT_M0.json`）。

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 Pro，Build 19041.vb_release.191206-1406（测试模式） |
| VM | dockurr/windows `win10-m0`，6G RAM / 4 vCPU / 100G，QEMU/KVM |
| ProjFS | `Client-ProjFS` 已启用 |
| 驱动 | Microsoft `SimRep` sample（WDK 10.0.26100.0，Debug x64，test-signed） |
| Provider | Microsoft `ProjFS-Managed-API` `SimpleProviderManaged`（self-contained win-x64，net8.0） |
| 视图 | lower=`C:\m0\lower`，view=`C:\m0\view`，逻辑路径=`C:\m0\ws` |
| 映射 | `OldMapping=\m0\ws` → `NewMapping=\m0\view`，`RemapRenamesAndLinks=1` |
| 驱动实例 | `fltmc filters`：`SimRep 1 371100`；`fltmc instances -f SimRep`：`C:` |

## 2. 结果矩阵（guest 实测）

| 检查 | 结果 |
|---|---|
| ProjFS 启用 | ✅ |
| test signing | ✅ |
| provider 运行 | ✅ |
| SimRep 已加载 | ✅（1 instance on C:） |
| `C:\m0\ws\a.txt` 重定向 | ✅ 读到 `hello` |
| 写 `ws\b.txt` | ✅ view=`v2`，lower=`v1` |
| 目录枚举 `ws\*` | ✅ 含 `a.txt`/`b.txt`/`dir` |
| cwd 相对打开 | ✅ `dir\c.txt` = `c` |
| 目录句柄 + `NtCreateFile` 相对打开 | ✅ = `c` |
| raw `NtCreateFile` 绝对写 | ✅ view=`raw`，lower 无 `raw.txt` |
| 删除 `a.txt` / `gone.txt` | ✅ view 不可见；lower 仍在（tombstone） |
| 改名 `dir\c.txt` → `dir\d.txt` | ✅ view 有 `d.txt`；lower 仍有 `c.txt` 且无 `d.txt` |
| 子进程写 `child.txt` | ✅ 进 view；lower 无 `child.txt` |
| `C:\m0\lower` before/after | ✅ 4 个文件 SHA-256 完全一致 |
| C 探针 | ✅ `checks=23 failures=0`，exit=0 |

原始 `RESULT_M0.json` 的 `ok: true`，`lowerDiff: []`，`clientExit: 0`。

## 3. 过程中踩到的坑与修复（对 M1 直接有用）

| 现象 | 根因 | 修复 |
|---|---|---|
| guest 内 `dotnet-install.ps1` 卡 20+ 分钟、无网络/磁盘活动 | .NET CDN 在 guest 内连接挂起（20 分钟超时） | **不在 guest 装 .NET**；在宿主用 Docker `dotnet/sdk:8.0` 交叉发布 self-contained provider（`native/m0/build-provider.sh`），只把产物放进 share |
| `MSB8020: WindowsKernelModeDriver10.0` 找不到 | WDK installer `/quiet` 没装 VSIX；Build Tools 缺少 Driver Kit 组件 | `vs_buildtools.exe --add Component.Microsoft.Windows.DriverKit.BuildTools`（34s 装好，出现 `Platforms\x64\PlatformToolsets\WindowsKernelModeDriver10.0`） |
| `MSB8040: 需要 Spectre 缓解库` | SimRep 项目要求 Spectre 库，但未安装 | 构建时 `/p:SpectreMitigation=false`（spike 用；产品可装 Spectre 组件） |
| `sc create` + 手写 `Parameters\Instances` 后 `fltmc load` 返回 `0x80070002`（FilterManager 记录 `0xC0000034`） | 手工服务注册与 INF 安装不等价；driver 的 `DriverEntry` 在 `FltRegisterFilter`/配置阶段返回 object-not-found | **用 INF 安装**：签名 `simrep.cat` → `pnputil /add-driver simrep.inf /install` → `fltmc load SimRep`；之后 `fltmc filters` 显示 `SimRep 1 371100` |
| 驱动加载成功但 `fltmc filters` 实例数为 0，`ws` 不重定向 | SimRep 的 `InstanceSetup` **刻意不自动 attach** | `fltmc attach SimRep C:`；`fltmc instances -f SimRep` 看到 `C:` |
| 改名失败（`MoveFileW` 返回 0） | `RemapRenamesAndLinks=0` 时 SimRep 不重映射 rename target；且客户端未用 replace | 设 `RemapRenamesAndLinks=1`；客户端用 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` |
| `RESULT_M0.json` 写成 `System.Collections.Specialized.OrderedDictionary` | PowerShell 变量名大小写不敏感：`$result` 覆盖了 `$Result` 路径 | 路径变量改名 `$ResultPath`，对象改名 `$payload` |

## 4. 性能

**未完成**：本次 M0 优先验证功能；性能（ProjFS 首次/二次枚举、copy-up、`git status`、`pnpm install`）
尚未采集，必须在 M1 开始前补测（`native/m0/README.md` 已列场景）。这不影响“功能 GO”，但影响
“产品性能可接受”的 Go/No-Go 结论，不能省略。

## 5. 结论与 M1 输入

**GO（有保留）**：

1. 同路径透明、ProjFS 合并视图、内核级重定向、tombstone、raw NT 写、子进程继承、rename 均实测成立。
2. 真实 lower 在全部操作后 SHA-256 不变。
3. 生产驱动必须自己实现：按域/PID 的映射（SimRep 是全局映射）、策略 allow/deny/mask、store/view 直接访问拒绝、
   通信端口、签名/安装/attach 流程；不能直接发布 SimRep。
4. 安装路径必须走 **INF + pnputil + 签名 cat + `fltmc attach`**，不能只 `sc create`。
5. 性能待补测；若 ProjFS 枚举不可接受，备选是“完整复制 + 重定向”（见 `M0-SPIKE.md` §6）。
