# M0 Spike：ProjFS + SimRep 同路径重定向

> 目标：在 **Windows VM** 里用微软现成 sample 证明“同路径透明 + ProjFS COW + 内核重定向”
> 可行，并拿到性能数字。**不写产品代码**，只做 go/no-go。

## 1. 环境

| 项 | 建议 |
|---|---|
| OS | Windows 11 24H2 x64（另测 Windows 10 22H2 x64） |
| VM | 4 vCPU / 8 GB / 80 GB，KVM 或 Hyper-V；**先做快照** |
| 工具 | Visual Studio 2022 Build Tools（C++ 桌面）、Windows SDK、WDK |
| 功能 | `Client-ProjFS` 可选功能 |
| 签名 | 个人机测试签名：`bcdedit /set testsigning on` + 自签证书 |
| 代码 | `microsoft/Windows-driver-samples`（SimRep / NameChanger）与 `microsoft/ProjFS-Managed-API`（SimpleProvider） |

### 开启 ProjFS 与测试签名（管理员 PowerShell）

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Client-ProjFS -NoRestart
bcdedit /set testsigning on
# 需要重启一次
Restart-Computer
```

验证：

```powershell
Get-WindowsOptionalFeature -Online -FeatureName Client-ProjFS | Select State
bcdedit /enum {current} | Select-String testsigning
fltmc filters
```

## 2. 构建 sample

> 路径按本机 clone 位置调整。WDK 的 Visual Studio 集成会把 sample 的 `.vcxproj`
> 识别为驱动工程；若用 `msbuild`，先打开 “Developer Command Prompt for VS 2022”。

```powershell
git clone https://github.com/microsoft/Windows-driver-samples.git C:\src\Windows-driver-samples
git clone https://github.com/microsoft/ProjFS-Managed-API.git C:\src\ProjFS-Managed-API

# SimRep（minifilter 名称重定向）
msbuild C:\src\Windows-driver-samples\filesys\miniFilter\simrep\simrep.vcxproj /p:Configuration=Debug /p:Platform=x64

# NameChanger（目录枚举/名称提供者，M1 目录合并时参考）
msbuild C:\src\Windows-driver-samples\filesys\miniFilter\namechanger\namechanger.vcxproj /p:Configuration=Debug /p:Platform=x64

# ProjFS SimpleProvider（托管 API；需要 .NET）
dotnet build C:\src\ProjFS-Managed-API\SimpleProviderManaged\SimpleProviderManaged.csproj -c Debug
```

安装/加载 SimRep（按 sample README 的 INF 名称调整）：

```powershell
# 测试签名示例：先给 .sys 签名（自签证书需先导入受信任根）
# signtool sign /fd SHA256 /a /f C:\certs\dshnt-test.pfx /p <password> C:\path\simrep.sys
# 用 INF 安装，或：
sc.exe create SimRep type= kernel binPath= C:\path\simrep.sys
fltmc load SimRep
fltmc filters
```

## 3. Spike 场景

准备：

```powershell
$ws   = 'C:\spike\ws'
$view = 'C:\spike\view'
New-Item -ItemType Directory -Force $ws, $view | Out-Null
'hello' | Set-Content "$ws\a.txt"
'v1'    | Set-Content "$ws\b.txt"
New-Item -ItemType Directory -Force "$ws\dir" | Out-Null
'c'     | Set-Content "$ws\dir\c.txt"
```

### 3.1 ProjFS 投影

用 SimpleProvider 把 `$ws` 投影到 `$view`（按 sample 的参数格式）：

```powershell
# 示例形态；实际参数以 SimpleProviderManaged 的 README 为准
.\SimpleProviderManaged.exe $ws $view
```

验证：

```powershell
Get-ChildItem $view -Recurse | Select FullName, Length
Get-Content "$view\a.txt"
# 写 view 里的文件，确认 ws 不变
'changed' | Set-Content "$view\a.txt"
Get-Content "$ws\a.txt"      # 应为 hello
Get-Content "$view\a.txt"    # 应为 changed
# 删除 view 里的文件，确认 ws 仍在
Remove-Item "$view\b.txt"
Test-Path "$ws\b.txt"        # True
Test-Path "$view\b.txt"      # False（tombstone）
```

### 3.2 SimRep 同路径重定向

目标：让一个**指定进程**打开 `C:\spike\ws\a.txt` 时实际打开 `C:\spike\view\a.txt`，
且 `Get-ChildItem C:\spike\ws` 看到的是 ProjFS 合并视图。

建议的最小改动（在 SimRep sample 上）：

1. 用 `PsSetCreateProcessNotifyRoutineEx` 或 IOCTL 注册一个测试 PID；
2. 在 `PreCreate` 中只对已注册 PID + `C:\spike\ws` 前缀做 `IoReplaceFileObjectName` +
   `STATUS_REPARSE`；
3. 对未注册 PID 原样放行；
4. 记录 `redirects/denies` 计数。

测试进程（PowerShell 本身也可，但最好用一个小的 C/C++ 测试 exe，避免 PowerShell 自身
的复杂 I/O）：

```powershell
# 启动测试进程后，从另一个管理员窗口注册 PID，或在驱动里硬编码测试 exe 名
.\spike-client.exe
```

`spike-client.exe` 依次执行：

```c
// 伪代码
CreateFileW(L"C:\\spike\\ws\\a.txt", GENERIC_READ, ...);      // 应读到 view 的 changed
CreateFileW(L"C:\\spike\\ws\\b.txt", GENERIC_WRITE, ...);     // 应写 view；ws 不变
FindFirstFileW(L"C:\\spike\\ws\\*", ...);                     // 应看到 a.txt + dir，不应看到 b.txt
CreateFileW(L"C:\\spike\\ws\\dir", FILE_LIST_DIRECTORY, ...); // 目录句柄
// 相对打开：SetCurrentDirectoryW(L"C:\\spike\\ws"); CreateFileW(L"dir\\c.txt", ...)
// 删除：DeleteFileW(L"C:\\spike\\ws\\a.txt");  -> view tombstone; ws 仍在
// 改名：MoveFileW(L"C:\\spike\\ws\\c.txt", L"C:\\spike\\ws\\d.txt");
// 子进程：CreateProcessW(child) -> 子进程继承域；child 写 ws 仍进 view
```

## 4. 验收矩阵

| 编号 | 场景 | 期望 |
|---|---|---|
| S1 | 读 `ws\a.txt` | 读到 view 内容 |
| S2 | 写 `ws\b.txt` | view 变；ws 不变 |
| S3 | `dir ws` | 合并视图；tombstone 不出现 |
| S4 | 相对路径（cwd=ws） | 仍走 view |
| S5 | 目录句柄 + 相对打开 | 仍走 view |
| S6 | 删除 | view tombstone；ws 文件仍在 |
| S7 | 改名 | view 内改名；ws 不变 |
| S8 | 子进程 | 继承域；写仍进 view |
| S9 | 绝对路径 `C:\spike\ws\...` | 透明 |
| S10 | `\\?\C:\spike\ws\...` | 透明 |
| S11 | 长路径（>260） | 透明 |
| S12 | ADS / 硬链接 | v1 明确拒绝，不得静默写真实盘 |
| S13 | 未注册进程 | 原样访问真实盘（不拦截） |
| S14 | 跨卷 view（`D:\view`） | 明确结果：支持或拒绝；不得半成功 |
| S15 | `git status` / `pnpm install` / `tsc` | 能跑；真实工作区不被写 |

## 5. 性能

在同一台 VM、同一仓库上测：

```powershell
Measure-Command { git -C $ws status }
Measure-Command { pnpm -C $ws install --offline }
Measure-Command { pnpm -C $ws exec tsc --noEmit }
Measure-Command { Get-ChildItem $ws -Recurse | Measure-Object } # 10k/50k 文件
```

记录：

- 首次枚举/水合耗时；
- 二次枚举（ProjFS 缓存）耗时；
- 单文件首次写（copy-up）耗时；
- 1k/10k/50k 文件目录枚举；
- 与未启用驱动的基线对比。

**Go 条件（建议）**：

- S1–S11、S13、S15 全部通过；
- 真实工作区在 S2/S6/S7/S8 后 hash 不变；
- 10k 文件 `Get-ChildItem` 额外开销 < 2x，二次枚举 < 1.3x；
- `git status` 额外开销 < 30%（可接受上限由你定）。

**No-go 条件**：

- 相对路径/目录句柄无法稳定重定向；
- 跨卷 view 只能半成功；
- ProjFS 枚举性能不可接受且无缓存策略；
- 驱动在压力/卸载时蓝屏（先修，不进入 M1）。

## 6. 失败后的备选

| 失败点 | 备选 |
|---|---|
| SimRep 重定向不稳定 | 放弃同路径透明：cwd=view + AppContainer，绝对路径真实盘写由 token 拒绝（无自研驱动） |
| ProjFS 性能差 | 完整复制工作区到 view + 重定向（目录枚举原生，仍无 overlay 驱动） |
| ProjFS 不可用 | 完整 minifilter overlay（工期/风险显著上升） |
| 驱动签名/加载被拦 | 个人机测试签名排障；否则退到 ProjFS+AppContainer |

## 7. 产物

M0 结束后写 `docs/nt/M0-REPORT.md`，至少包含：

- 环境/版本/签名方式；
- 逐项 S1–S15 的结果与证据（命令 + 输出摘要）；
- 性能表；
- 是否进入 M1 的结论；
- 若 No-go，选哪条备选、为什么。
