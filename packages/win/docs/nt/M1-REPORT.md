# M1 报告：产品驱动 + provider 端到端（Windows 10 19041）

> 结论：**M1 功能 GO**。产品 minifilter（`dshnt.sys`）+ 产品 ProjFS provider
> （`Dshnt.Provider`）+ 产品 launcher（受限令牌/AppContainer + Job + WFP）在 guest 内
> 跑通完整链路：驱动加载并挂到 C:、视图启动、策略下发、域内进程同路径读写暂存、
> 子进程继承域、deny/mask/store 规则生效、真实工作区字节不变、网络闸门按包 SID 生效。
>
> 证据：[`M1-RESULT.json`](./M1-RESULT.json)（`ok=true`）、[`M1-RUN.log`](./M1-RUN.log)、
> 性能见 [`M1-PERF.md`](./M1-PERF.md)（**门禁未通过**，如实记录）。
>
> 一句话的保留：`enforcement` 仍**没有**在插件里默认切到 kernel（M2 才接管路径），
> 本报告证明的是“内核数据面可用”，不是“DSH 已在用它”。

## 1. 验证了什么

`native/m1/guest/m1.ps1` 在 guest 内从源码构建→签名→安装→启动，然后：

| 检查 | 结果 |
|---|---|
| `fltmc filters` 列出 dshnt，`fltmc instances` 挂到 C: | ✅ |
| `dshnt-ctl hello`：ABI=2，capabilities=0x000F | ✅ |
| `dshnt-ctl policy`：generation=1，domains=1，rules=10 | ✅ |
| provider `start` / `protect`（lower 标记为受保护） | ✅ |
| 24 项域内客户端探针（`m1-client.c`） | ✅ 24/24 |
| 写 `C:\m1\ws\b.txt` → 视图 `b=v2`，lower 仍 `v1` | ✅ |
| 删除 `a.txt` → 视图不可见，lower 仍在 | ✅ |
| 新建/改名/子目录/相对路径/句柄相对/raw `NtCreateFile` | ✅ |
| 进程内子进程继承域并写暂存 | ✅ |
| `secret` deny、全局 mask、store 拒绝 | ✅ |
| view 根直接访问 → 映射回逻辑路径后按同一规则判定 | ✅ |
| 网络：`appcontainer + offline` → `NET-BLOCKED wsa=10013` | ✅ |
| 网络：`appcontainer + observed` → `NET-CONNECTED` | ✅ |
| 网络：`appcontainer + allowlist`，端点端口不匹配 → 仍被阻断 | ✅ |
| 网络：`appcontainer + allowlist`，端点命中 → `NET-CONNECTED` | ✅ |
| 网络：`appcontainer + allowlist` 但空列表 → launcher 拒绝启动（exit 2） | ✅ |
| 网络：`restricted + offline` → launcher 拒绝启动（fail-closed） | ✅ |
| 进程缓解（DEP/ASLR/ACG/CFG/扩展点/签名）+ Job 限制回读 | ✅ 8/8 + Job 4 项 |

`RESULT_M1.json` 的机读字段：`clientChecks=24 / clientFailures=0`、`stagedWrite=true`、
`lowerUnchanged=true`、`lowerDiff=[]`、`networkGateWorks=true`、
`allowlistBlockedExit=0`、`allowlistAllowedExit=1`、`allowlistEmptyExit=2`、
`mitigateExit=0`（`MITIGATION dep=1 aslr=1 buaslr=1 win32k=1 ext=1 acg=1 cfg=1 msft=1`）。

## 2. 生产布局（与 M0 的差别）

M0 用 `C:\m0\lower` + `C:\m0\view` + SimRep 重定向到 `C:\m0\ws`。M1 固定为：

```text
逻辑工作区 = C:\m1\ws      （DSH 看到/操作的路径，同时是 ProjFS lower）
视图根     = C:\m1\view    （placeholder + 暂存写入）
store      = C:\m1\store   （候选/证据；域内进程一律拒绝）
```

驱动把域内进程的 `C:\m1\ws\**` 重定向到 `C:\m1\view\**`（`STATUS_REPARSE` 续开），
因此工作区**既是逻辑根又是 lower**，不需要“逻辑路径→另一个真实目录”的映射层。

## 3. 三个实现决策（与设计文档的差异）

### 3.1 视图根的“直接访问”按逻辑路径判定，而不是一律拒绝

问题：`STATUS_REPARSE` 之后，IO 管理器用**新名字**（视图路径）重发 create；
如果驱动拒绝所有视图路径，重定向后的续开也会被拒绝（M1 第一次运行就是这样
`read_workspace_a` 失败）。

决策：把视图路径映射回逻辑工作区路径，套用**同一套域规则**：

- 规则允许 ⇒ 放行（暂存目录本来就是该进程的数据）；
- 规则拒绝/遮蔽 ⇒ 拒绝（不能绕过 `ws` 上的 deny/mask 直接写暂存）。

代价：域内进程可以显式打开 `C:\m1\view\...`（等价于打开 `C:\m1\ws\...`）。
这**不是**绕过，因为视图内容与工作区内容在规则意义上是同一对象；store 仍然是硬拒绝。
副作用：`view-deny` 这类“按视图路径写的规则”永远匹配不到逻辑路径，因此
`defaultRulesForDomain()` 已移除它（首次 M1 跑记录的 11 条含该条；移除后复跑为 10 条，结果仍 24/24）。
`store-deny` 保留：控制面 `decide()` 用它，驱动另有更早的硬拒绝（`POLICY.md` 已注明）。

### 3.2 策略线格式是二进制，且顺序有语义

驱动只接受 `DSHNT_POLICY_MAGIC` 的二进制 payload（`src/nt/policy-binary.ts` 编码，
`native/driver/src/dshnt.c` 解析）；规则数组顺序即优先级，驱动取**第一条**命中。
JSON 只出现在控制面/CLI 的参数里，永远不进内核。

M1 修掉的三个线格式 bug：

1. `DOMAIN_ENTRY` 是 **104** 字节（含 `JOB_LIMITS` 24），不是 112；
2. 消息头是 **16** 字节，不是 24；
3. `STRING_REF` 不是 `UNICODE_STRING`，必须先 `DshntRefString` 转视图再 `Strdup`
   （直接 type pun 会把 `Bytes` 当 `MaximumLength`，解析返回 `0xC000000D`）。

### 3.3 安装：`Services\<name>\Instances` 才是 Filter Manager 读的键

`sc create` + INF 示例里的 `Parameters\Instances` **不够**：`FltRegisterFilter`
读的是 `HKLM\SYSTEM\CurrentControlSet\Services\dshnt\Instances`。缺它时
`fltmc load` 报 `0x80070002`、`sc start` 报 `0xC0000034`。
M1 的 harness/INF 现在同时写 `Instances` 与 `Parameters\Instances`。

另：本机 WDK 的 `Inf2Cat` 缺 `x86\InfVerif.dll`（exit -2），无法生成 catalog。
v1 安装走“签名 sys + `sc create` + 双 Instances + `fltmc load`”，INF 仍保留给
`pnputil` 路径；这是测试签名环境下的**有意简化**，不是“签名已验证”。

## 4. 令牌 / 网络（实测得到的硬约束）

### 4.1 AppContainer 创建进程走 `CreateProcessW` + `SECURITY_CAPABILITIES`

- `CreateProcessAsUser` + `CreateAppContainerToken` 在 19041 上返回
  `ERROR_ENVVAR_NOT_FOUND (203)`；
- 改为 `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，
  由内核派生 LowBox 令牌；
- 环境块必须用 `CreateEnvironmentBlock(profileToken)`，自定义环境块同样得到 203；
- `CreateAppContainerToken` 的导出在 **kernelbase.dll**（6.3+），不是 userenv；
  签名是 `HRESULT(baseToken, PSECURITY_CAPABILITIES, PHANDLE)`。

### 4.2 AppContainer 能力：必须显式给 `internetClient` + `privateNetworkClientServer`

只给 package SID 时所有 connect 都是 `WSAEACCES 10013`（包括 observed 对照组）。
M1 给令牌与属性列表都加：

- `S-1-15-3-1`（internetClient）
- `S-1-15-3-3`（privateNetworkClientServer）

offline/allowlist 仍由 WFP 按包 SID 拦截，能力只决定“能不能走到 WFP 判定”。

### 4.3 WFP：`ALE_PACKAGE_ID` 必须用 `FWP_SID`，层 GUID 内置

- `FWP_BYTE_BLOB_TYPE` 作为 `FWPM_CONDITION_ALE_PACKAGE_ID` 的值返回
  `FWP_E_TYPE_MISMATCH (0x80320027)`；正确类型是 `FWP_SID`（独立探针 `wfptest.c` 复现）；
- `FwpmLayerGetByName0` 在 19041 的 `fwpuclnt.dll` **不导出**；层 GUID 直接内置
  （取自 SDK `fwpmu.h`）；
- WFP 会话是 **DYNAMIC**，launcher 持有句柄直到子进程退出（`WfpInstall(..., &gate)` /
  `WfpClose(gate)`），不做“装完就关会话”的伪持久化。
- allowlist 的 permit 条件必须用**主机字节序**：`FWPM_CONDITION_IP_REMOTE_ADDRESS`
  的 `FWP_UINT32` 按 MS 文档要 `ntohl`（SOCKADDR 是网络序，过滤引擎要主机序；
  端口同理）。写成网络序时条件永远不匹配，表现为“放行了端点却仍被阻断”
  （M1 第一次 allowlist 跑就是这样）。空 allowlist 在 launcher 与策略校验两处都
  直接拒绝，**不会**静默退化成 offline。

### 4.4 `restricted + offline` 是**按设计** fail-closed

受限令牌没有 package SID，WFP 无法按包过滤；launcher 直接拒绝启动并返回
`NT_NETWORK_UNSUPPORTED`/非零退出。M1 的 `restrictedOfflineFailClosed=true`
是期望行为，不是缺陷。需要 offline/allowlist ⇒ 用 AppContainer。

### 4.5 进程缓解位序：一档错位（已修，并加了回读探针）

`UpdateProcThreadAttribute(PROCESS_CREATION_MITIGATION_POLICY)` 的位序容易记错。
M1 之前的代码把 28 当 CFG、36 当扩展点、40 当“只允许 Microsoft 签名”——实际
winnt.h 的顺序是：28 Win32k 禁用、32 扩展点、36 ACG、40 CFG、44 签名策略。
结果是“以为设了缓解，其实设成了别的（且 Win32k 的值 2 是保留值）”。

修复后由 `native/m1/guest/m1-mitigate.c` 在域内用 `GetProcessMitigationPolicy`
回读，全部命中才退出 0：

```text
MITIGATION dep=1 aslr=1 buaslr=1 win32k=1 ext=1 acg=1 cfg=1 msft=1
JOB injob=1 active=16 memmb=1024 kill=1 cpu=5000
```

同一探针还验证 Job：在 Job 内、ActiveProcessLimit=16、内存 1024 MB、
kill-on-close、CPU 硬上限 50%（`CpuRate=5000`）。这些是内核回读值，不是 launcher
自述。注意 `Block non-Microsoft binaries` 不会阻止本进程启动（主映像在策略生效前
已映射）；它约束的是之后加载的模块。

## 5. 完整性标签：本 VM 上写不进去（已定位，未绕过）

`SetNamedSecurityInfoW(..., LABEL_SECURITY_INFORMATION, ...)` 返回 0，但回读的 SACL
是 `S:AINO_ACCESS_CONTROL`（空）。独立探针（`labeltest.c`，不经过 launcher）在
`C:\m1` 上复现：LABEL 与 SACL 两条路径都“成功但读回为空”。
对照 `icacls /setintegritylevel Low` 也是同一结果。

因此：

- M1 端到端用 `--integrity medium`（显式写在输出里，不静默）；
- `--integrity low` 会在 launcher 里**回读校验**，失败即 `NT_CAPABILITY_MISSING`
  （fail-closed），不会“以为设了 Low 其实没设”；
- 这是**宿主环境限制**，不是代码路径被删除：在正常的 Windows 10/11 上
  `LABEL_SECURITY_INFORMATION` 应能写入；M2 要在 CI 机器上重新验证并把它作为
  硬门禁（Low IL 是“域内进程不能写真实工作区”的第二道保险，主保险仍是驱动拒绝）。

## 6. 与设计文档的偏差（明确列出）

| 项 | 设计 | M1 实测/实现 | 影响 |
|---|---|---|---|
| 视图直接访问 | 拒绝 | 映射回逻辑路径后按同一规则判定 | 规则等价；store 仍硬拒绝 |
| `view-deny` 规则 | 可用 | 已从默认规则移除（永不命中） | 视图访问按逻辑路径判定 |
| `store-deny` 规则 | 可用 | 保留（控制面判定 + 纵深防御；驱动更早硬拒绝） | 无行为差异 |
| WFP 层名解析 | `FwpmLayerGetByName0` | 内置 GUID | 无行为差异 |
| `CreateAppContainerToken` | userenv | kernelbase + `SECURITY_CAPABILITIES` | 无行为差异 |
| 完整性标签 low | 默认 | 本 VM 不可用；显式 medium | 需在正常机器复验 |
| mitigation 位序 | 28/36/40 | 28/32/36/40/44（回读验证） | 修正了错位；行为已实测 |
| 性能门禁 | 0.2 ms/文件、20k ≤ 5 s | 0.55–0.64 / 11.4–12.8 s | 未达标，见 `M1-PERF.md` |
| apply helper | 内核授权写 | v1 在可信控制面执行（journal/undo） | `grantApply` 留给 M2 |

## 7. M2 待办（按依赖排序）

1. **插件接管**：`enforcement: 'kernel'` 时才装配 `NtSandboxProvider`；启动 provider、
   `start`/`protect`、下发策略、注册域，全部失败即 fail-closed。
2. **路径切换**：`ctx.fs` 的逻辑根指向工作区（驱动已透明重定向），`ctx.shell` 经
   launcher 进域；legacy 路径保留为显式回退。
3. **apply helper**：`grantApply` + CAS/journal/undo 控制面接线（`src/nt/apply.ts` 已有）。
4. **性能**：provider 批量元数据 / placeholder 预创建 / 排除面（`M1-PERF.md` §5）。
5. **注册表面**：阶段 2，先维持“敏感 HKLM 写拒绝”。
6. **稳定性**：24 h soak；驱动卸载/重装、provider 崩溃后的状态卡必须如实显示。

## 8. 复现

```text
guest（管理员）：
  \\host.lan\Data\m1\go.bat          # 全流程 → RESULT_M1.json
  \\host.lan\Data\m1\goperf.bat      # 性能 → PERF_M1.json
```

源码：`native/driver/`、`native/provider/`、`native/launcher/`、`native/ctl/`、
`native/m1/guest/`。控制面：`src/nt/`（14 个离线套件，`node tests/nt/run-all.ts`）。
