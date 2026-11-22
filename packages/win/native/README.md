# native/ — NT 内核组件（M0/M1）

> 当前只有 ABI 头文件与设计文档；驱动/helper 源码在 M1 落地。
> 共享 ABI：`include/dshnt_abi.h`（草案，版本 `DSHNT_ABI_VERSION`）。

## 目录

```text
native/
  include/dshnt_abi.h     驱动/launcher/apply 共享 ABI（草案）
  driver/                 dshnt.sys：minifilter 重定向 + 策略 + 审计
  projfs/                 ProjFS provider helper：lower=工作区，upper=视图根
  launcher/               dshnt-launch.exe：token/Job/mitigation/域注册
  apply/                  dshnt-apply.exe：CAS 写真实工作区 + undo
  m0/                     Windows spike 记录/脚本（不发布）
```

## 构建要求

| 组件 | 工具链 |
|---|---|
| driver | Visual Studio 2022 + WDK（KMDF/WDM minifilter） |
| projfs | MSVC 或 .NET（ProjFS-Managed-API）；C++ 推荐 |
| launcher | MSVC/CMake 或 Rust（`windows` crate） |
| apply | 同 launcher；最小依赖 |

## 测试签名（个人机）

```powershell
# 管理员
bcdedit /set testsigning on
# 生成自签证书并导入受信任根/受信任发布者
New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=dshnt-test" -CertStoreLocation Cert:\CurrentUser\My
# 给 .sys/.exe 签名
signtool sign /fd SHA256 /a /n "dshnt-test" <file>
# 安装/加载
sc.exe create dshnt type= kernel binPath= C:\path\dshnt.sys
fltmc load dshnt
fltmc filters | findstr dshnt
```

> 分发必须走 EV 代码签名 + Microsoft attestation/HLK；测试签名只用于个人机/VM。
> **BSOD 风险**：先在 VM 快照 + Driver Verifier 下迭代，不要在生产机直接加载新驱动。

## 版本与失败关闭

- `DSHNT_ABI_VERSION` 不匹配 ⇒ 控制面 `NT_DRIVER_VERSION_MISMATCH` / 驱动拒绝策略。
- 策略 `generation` 必须单调递增；同 generation 幂等。
- 驱动/ProjFS/launcher 任一缺失 ⇒ `src/nt/status.ts` 的 `assertKernelReady()` 抛错，
  命令不执行。
- 驱动卸载前必须确保无活动域/上下文；卸载/重载要测。

## 安全

- 通信端口 ACL：只允许控制面/launcher；沙箱进程不得持有端口句柄。
- 驱动不记录文件内容；审计只记域/路径/访问/动作/PID/时间。
- 驱动自己的文件操作必须绕过自身过滤（thread flag / callback data flag），避免递归。
- 视图根/store 对沙箱直接访问一律 deny；只有重定向请求/受信 PID 放行。
