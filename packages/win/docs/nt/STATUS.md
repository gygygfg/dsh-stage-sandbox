# NT 沙箱实现状态（诚实口径）

> 更新：2026-11-23。只记录**代码事实**；未运行/未实测的项明确写“未开始/未实测”。
>
> **M0（GO）**：Windows 10 VM 上实测 ProjFS + SimRep 同路径重定向；C 探针 23/23。
> 证据：[`M0-RESULT.json`](./M0-RESULT.json)、[`M0-REPORT.md`](./M0-REPORT.md)。
>
> **M1（功能 GO / 性能未达标）**：产品驱动 + 产品 provider + launcher 在 guest 内跑通
> 24/24 探针、暂存写可见、lower 字节不变、网络闸门按包 SID 生效。
> 证据：[`M1-RESULT.json`](./M1-RESULT.json)、[`M1-RUN.log`](./M1-RUN.log)、
> [`M1-REPORT.md`](./M1-REPORT.md)。性能：[`M1-PERF.md`](./M1-PERF.md)
> （0.55–0.64 ms/文件、20k 11.4–12.8 s；M0 的 0.2 ms/5 s 门禁**未通过**）。
>
> **默认档位仍是 legacy**：M1 证明的是“内核数据面可用”，不是“DSH 已用它”。

## 1. 控制面：已实现 + 单测

| 文件 | 内容 | 测试 |
|---|---|---|
| `src/nt/types.ts` | domain/rule/policy/status；`NtError` 与固定错误码；ABI v2 | 间接覆盖 |
| `src/nt/paths.ts` | 路径规范化；设备/UNC/ADS/通配符拒绝；逻辑↔视图映射 | `paths`（39） |
| `src/nt/policy.ts` | 校验；编译；特异性/deny 优先；canonical JSON/SHA-256 | `policy`（41） |
| `src/nt/policy-binary.ts` | 驱动线格式编码（`DOMAIN_ENTRY=104`、消息头 16） | `policy-binary`（43） |
| `src/nt/view.ts` | ProjFS 视图 diff；placeholder/full/tombstone；corruption | `view`（15） |
| `src/nt/status.ts` | fail-closed；写屏障；逐项缺失机读码；失败分类 | `status`（32） |
| `src/nt/status-probe.ts` | `fltmc`/`sc`/ProjFS/provider 事实 → `NtStatus` | `status-probe`（36） |
| `src/nt/driver.ts` | 端口契约；Fake/Unavailable；默认 fail-closed | `driver`（27） |
| `src/nt/driver-wire.ts` | ABI v2 消息编解码（hello/policy/domain/stats/events） | `driver-wire`（50） |
| `src/nt/driver-client.ts` | koffi → fltlib 真实端口（仅 Windows） | 由 `driver-wire` 覆盖格式 |
| `src/nt/launcher-args.ts` | launcher argv；环境白名单/凭据拒绝；路径/Job/网络校验 | `launcher-args`（26） |
| `src/nt/session.ts` | 策略下发（二进制）/域注册/launcher 包装/幂等清理 | `session`（23） |
| `src/nt/executor.ts` | K0 执行链：confine→spawn→超时/输出上限/失败分类 | `executor`（36） |
| `src/nt/provider.ts` | `ctx.sandbox` 的 NT provider（构造即校验，init 才下发） | 由 `executor`/`session` 覆盖 |
| `src/nt/apply.ts` + `apply-manifest.ts` | 控制面 apply：CAS/journal/undo/冲突零写 | `apply`（24）、`apply-manifest`（23） |
| `src/nt/runtime.ts` | 诊断装配：驱动端口 + 状态探测 + provider 管道 + 域策略校验 | `runtime`（54） |
| `src/nt/provider-protocol.ts` | provider 管道常量 / 回复解析 | `supervisor`（57） |
| `src/nt/provider-client.ts` | provider 控制客户端（一请求一连接、超时、id 校验） | `supervisor`（57） |
| `src/nt/supervisor.ts` | M2 数据面生命周期：校验→探测→spawn provider→start/protect→二进制策略→注册域→复核；失败回滚 | `supervisor`（57） |
| `dsh-plugin/nt-command.ts` | `/winstage nt status` / `doctor` / `up` / `down` | `runtime` + `supervisor` |
| `tests/nt/run-all.ts` | 15 个套件独立子进程运行 | `node tests/nt/run-all.ts` |

### 本机实测结果

```text
node tests/nt/run-all.ts
nt 控制面套件：15 个，失败 0 个
RESULT: ALL PASS
```

共 **546** 条断言（paths=47、policy=45、policy-binary=43、view=15、status=32、
status-probe=36、driver=27、driver-wire=50、launcher-args=34、session=23、executor=36、
apply=24、apply-manifest=23、runtime=54、supervisor=57）。

### 与 DSH 的接线（v1）

- `/winstage nt status` —— 与 `ctx.sandbox` 同一判据的只读状态卡；
- `/winstage nt doctor` —— 逐项检查驱动/ABI/ProjFS/provider/策略/网络，并给修复动作；
- `/winstage nt up` —— **M2 数据面生命周期**：校验策略 → 探测驱动/ProjFS → spawn
  provider → `start`/`protect` → 用 `generation+1` 编码二进制策略并下发 → 注册域 →
  重新探测必须到 `kernel-projfs-minifilter`；任一步失败**先回滚再报错**；
- `/winstage nt down` —— 注销域 → provider `stop`/`shutdown` → kill（幂等，清理不抛）；
- 装配是**惰性**的：只有执行命令才碰驱动端口/命名管道；加载期零内核交互；
- 命令在 WinStage 关闭时与其他 `/winstage*` 一样被开关挡住（行为未变）；
- `ctx.fs`/`ctx.shell` 的路径切换**仍未接管**：当前只到“数据面可拉起/可诊断”，
  默认执行链仍是 legacy；`NtSandboxProvider` 尚未注册成 `ctx.sandbox`。

## 2. 原生实现：M1 已实测

| 项 | 状态 | 说明 |
|---|---|---|
| `native/driver/` | ✅ 已加载 | 重定向 + 规则 + PID 域映射 + 审计计数 + 通信端口；装 C: 实例 |
| `native/provider/` | ✅ 已运行 | ProjFS provider + 管道协议（start/stop/stats/protect/shutdown） |
| `native/launcher/` | ✅ 已运行 | 受限令牌/AppContainer + Job + 环境块 + 域注册 + WFP |
| `native/ctl/` | ✅ | policy/register-domain/stats/hello（测试与控制用） |
| `native/m1/` | ✅ | guest harness：构建→签名→安装→E2E→结果 JSON |
| `native/apply/` | ❌ 未开始 | v1 的 apply 在可信控制面（`src/nt/apply.ts`） |
| 注册表暂存 | ❌ 阶段 2 | v1 拒绝敏感 HKLM 写 |
| 正式签名 | ❌ | 测试签名；本机 Inf2Cat 缺 `InfVerif.dll`，安装走 sys+sc+Instances |

### M1 的硬结论（详见 `M1-REPORT.md`）

- Filter Manager 读 `Services\<name>\Instances`；只写 `Parameters\Instances` 会
  `0xC0000034`。
- 线格式：`DOMAIN_ENTRY=104`、消息头 `16`、`STRING_REF` 不是 `UNICODE_STRING`。
- 视图根直接访问 = 映射回逻辑路径后按同一规则判定（重定向续开无法与显式打开区分）。
- AppContainer 创建进程走 `CreateProcessW` + `SECURITY_CAPABILITIES` + `CreateEnvironmentBlock`；
  能力必须含 `S-1-15-3-1` 与 `S-1-15-3-3`。
- WFP `ALE_PACKAGE_ID` 用 `FWP_SID`；层 GUID 内置（`FwpmLayerGetByName0` 不导出）。
- `restricted + offline` 按设计 fail-closed（无 package SID）。
- allowlist 已实测：错端口仍阻断、命中端点放行、空列表 launcher 拒绝启动
  （`allowlistBlockedExit=0 / allowlistAllowedExit=1 / allowlistEmptyExit=2`）。
- allowlist 的 permit 地址条件必须用**主机字节序**（WFP 文档：SOCKADDR 是网络序，
  过滤引擎要主机序）；写成网络序会永远不匹配。
- 进程缓解/Job 由 `m1-mitigate.exe` 回读验证：DEP/ASLR/ACG/CFG/扩展点/签名 8/8，
  Job（in-job、ActiveProcessLimit=16、1024 MB、kill-on-close、CPU 50%）全部命中。
  修掉了 mitigation 位序一档错位（28/32/36/40/44）。

## 3. 本机限制（如实）

- 开发机是 **Linux**：不能构建/加载驱动，也不能启用 ProjFS；M0/M1 都在 Windows VM 里跑。
- **完整性标签写不进去**：`SetNamedSecurityInfoW(LABEL_SECURITY_INFORMATION)` 返回 0，
  回读 SACL 为空（独立探针复现）。M1 用 `--integrity medium`；`--integrity low`
  在 launcher 里回读校验失败即 fail-closed。
- **性能门禁未过**：20k 首次触碰 11.4–12.8 s / 0.55–0.64 ms 每文件（目标 5 s / 0.2 ms）。
  修订后的两段式门禁见 `M1-PERF.md` §4。
- 本机没有 TypeScript 编译器。可临时装到 /tmp 后跑（不污染仓库）：
  `npm i --prefix /tmp/opencode typescript@5.9 @types/node@22`，再
  `node /tmp/opencode/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --typeRoots /tmp/opencode/node_modules/@types`。
  2026-11-23 实测：**只剩两个既有缺包错误**（`@deepseek-ai/schemastery`、
  `@deepseek-ai/cordis` 在 `plugin/`），`src/nt/`、`tests/nt/`、`dsh-plugin/nt-command.ts`
  均无类型错误。

## 4. 与封印/套件的关系

- `tests/nt/*.ts` 已通过 `tests/nt/run-all.ts` **登记进** `OFFLINE_SUITES` 与
  `verify.cmd`（两处逐字一致，`tests/suite-wiring.ts` 机器检查）。
- 封印收录面已扩展（M1 收口治理）：`src/**/*.ts`、`tests/**/*.ts`、`native/**` 的
  c/h/cpp/cs/ps1/ts/inf/vcxproj/csproj 全部进 `docs/源码基线.sha256`（188 → **253** 条）。
  构建产物与第三方 vendored 源显式排除（`vendor`/`obj`/`bin`/`out`/`pkg`/`x64`）。
  `tests/baseline-integrity.ts` 增加形状断言（只允许 `src/nt/`、`tests/nt/`、`native/`
  这些显式递归面）与 M1 文件必封印检查，防止收录面被顺手放宽。哈希前把 CRLF 归一为
  LF（与 `.gitattributes` 的 eol 设置解耦，fresh checkout 不因换行变红）。
- `enforcement` 默认保持 `legacy`；生产路径不会因为本轮代码改变行为。

## 5. 下一步（M2）

1. ~~数据面拉起~~ ✅ 已完成（`NtSupervisor` + `/winstage nt up|down`，单测覆盖；
   失败回滚、generation 单调、二进制策略）。
2. 插件接管：`enforcement='kernel'` 时装配 `NtSandboxProvider`，由 supervisor 提供
   已就绪的会话；`ctx.fs`/`ctx.shell` 走视图/launcher；legacy 保留为显式回退。
3. apply helper：`grantApply` + CAS/journal/undo 接线。
4. 性能：批量元数据 / placeholder 预创建 / 排除面（`M1-PERF.md` §5）。
5. 治理：扩展封印收录面；CI 机器上复验 Low IL；24 h soak。
6. 注册表面（阶段 2）：先维持敏感 HKLM 写拒绝。
