# M0 spike：Windows VM（ProjFS + SimRep）

> **结果：GO（2026-11-22）**。详见 [`../../docs/nt/M0-REPORT.md`](../../docs/nt/M0-REPORT.md)
> 与 [`../../docs/nt/M0-RESULT.json`](../../docs/nt/M0-RESULT.json)：同路径读/写/枚举/相对打开/
> 目录句柄/raw NT/删除 tombstone/rename/子进程全部通过，lower SHA-256 不变。
>
> ⚠ **当前脚本是第一轮尝试的记录，不要直接用于新 VM**：`m0-phase1.ps1` 会在
> guest 内 `dotnet-install` 处挂起（.NET CDN 连接超时）。成功路径是：
> 宿主用 `build-provider.sh` 交叉构建 self-contained ProjFS provider →
> VS Build Tools 加 `Component.Microsoft.Windows.DriverKit.BuildTools` →
> SimRep 用 `/p:SpectreMitigation=false` 构建 → 签名 `simrep.cat` →
> `pnputil /add-driver ... /install` → `fltmc load` + `fltmc attach SimRep C:` →
> `RemapRenamesAndLinks=1`。逐条踩坑与修复见 M0 报告 §3。
>
> 这不是产品代码：**只应在一次性 VM 里运行。**

## 组成

| 文件 | 作用 |
|---|---|
| `run-host.sh` | 宿主机：生成 compose、seed `custom.iso`、启动 VM、轮询 `RESULT_M0.json` |
| `guest/install.bat` | dockur `/oem` 首次登录钩子；调用 phase1 |
| `guest/m0-phase1.ps1` | 启用 ProjFS/test signing；装 VS Build Tools + WDK + .NET 10；构建 SimRep + ProjFS provider；签名；排 phase2；重启 |
| `guest/m0-phase2.ps1` | 启动 ProjFS provider；加载 SimRep（`\m0\ws` → `\m0\view`）；编译/运行 C 探针；校验 lower 未变；写 `RESULT_M0.json` |
| `guest/m0-client.c` | 探针：Win32 读写/枚举、cwd 相对、目录句柄相对 `NtCreateFile`、raw `NtCreateFile`、删除/改名、子进程 |

## 运行

```bash
cd packages/win
./native/m0/run-host.sh
# 或指定 ISO / 端口 / 超时：
./native/m0/run-host.sh --iso /path/to/Win10.iso --web-port 8077 --timeout-min 180
```

- 默认工作目录 `/srv/ebk/dshnt-m0`；共享目录 `$WORK/shared` 会挂到 guest 的 `\\host.lan\Data`。
- VM 观看：`http://127.0.0.1:8077/`（noVNC）。
- 结果：`$WORK/shared/RESULT_M0.json`、`m0-phase1.log`、`m0-phase2.log`、`client.log`。
- 默认保留 VM（方便排查）；加 `--cleanup` 在拿到结果后 `docker compose down -v`。

## 判据（必须全绿才进入 M1）

- ProjFS 可选功能已启用；test signing 已生效；provider 运行；SimRep 已加载。
- `C:\m0\ws\a.txt` 被重定向到 `C:\m0\view\a.txt`（读到 `hello`）。
- 写 `C:\m0\ws\b.txt` 后 view=`v2`、lower=`v1`。
- 删除 `a.txt`/`gone.txt` 后 view 不可见、lower 仍在。
- 改名 `dir\c.txt` → `dir\d.txt` 后 view 有 d、lower 仍有 c 且无 d。
- 子进程写 `child.txt` 进 view，lower 无 child。
- raw `NtCreateFile` 写 `raw.txt` 进 view，lower 无 raw。
- `C:\m0\lower` 的 before/after SHA-256 完全一致。
- C 探针 `failures=0`。

## 已知风险

- VM 只有 6G/4vCPU；VS/WDK 安装可能很慢，甚至因宿主内存压力失败。
- WDK/VS 的下载 URL/组件 ID 可能随版本漂移；失败时看 `m0-phase1.log`。
- Secure Boot 可能阻止 test signing（Win10 通常关闭；若失败需改 VM 固件设置）。
- SimRep 是**全局**映射（不按 PID）；本 spike 用 `lower` 作为 ProjFS backing store，避免
  provider 读取被重定向的 `ws` 造成递归。这是 spike 的取舍，不是产品设计。
- ProjFS 的目录枚举/水合性能需在 `RESULT_M0.json` 之外另行记录；M0 报告要写清楚。
