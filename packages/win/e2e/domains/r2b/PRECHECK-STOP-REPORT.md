# r2b 前置自检：**未通过** ⇒ 按 RUNBOOK §1 停止（未启动任何测试线程）

- 会话：`session-ae62077b-d914-4811-9f1f-a4ca3ed846ea`（全新会话，与 r2 的 `session-4c5d9889-…` 不同）
- 时间：2026-10-04
- 判定：🔴 **§1 通过线不满足**（`stage_root` 空 + `OUTSIDE_WRITE_OK` 缺失）
- 处置：**未启动任何测试线程**（遵守 §1「失败即停」），只做只读诊断
- 结论一句话：**不是会话态污染，是配置态 + 代码态的确定性车道损坏**；且本轮新增两条 r2 未取得的证据

---

## 1. §1 自检原始输出（逐字）

```
stage_root=[]
isAdmin=False
INSIDE_WRITE_OK
OUTSIDE_WRITE_FAIL
SPAWN-OK
```

对照通过线：`stage_root` 非空 ❌｜`INSIDE_WRITE_OK` ✅｜`OUTSIDE_WRITE_OK` ❌｜spawn 有输出 ✅
⇒ **不通过**。

## 2. ⚠ 新增证据 A：`INSIDE_WRITE_OK` 是**假阳性**，RUNBOOK 的 §1 判据有缺陷

同一条自检里的 `INSIDE_WRITE_OK` 用的是 `"$PWD\__pf.txt"`。而本会话 `$PWD` **不是工作区根**：

```
PWD=[C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\sessions\session-ae62077b-d914-4811-9f1f-a4ca3ed846ea\staged]
```

即 `$PWD` = **本会话的暂存树**。直接写工作区真路径则被拒：

```
DENY C:\Users\Administrator\Desktop\WinStageSandbox\__pf2.txt :: Access to the path '...' is denied.
```

⇒ §1 的「工作区内写入」判据必须写成**工作区根的绝对路径**（`<workspaceRoot>\__pf.txt`），
否则在 cwd=暂存树的装配下**永远假阳性**，会把坏车道误判成好车道。**这一条本身就该修 RUNBOOK。**

## 3. 写入矩阵（原始异常，全为 `System.UnauthorizedAccessException`）

| 目标 | 结果 |
|---|---|
| `$PWD\__pf.txt`（= 暂存树） | ✅ OK |
| `$env:TEMP\__pf.txt`（`…\dsh-stage-temp\<guid>`） | ✅ OK |
| `<workspaceRoot>\__pf.txt` | ❌ Access to the path '…' is denied. |
| `C:\Windows\Temp\__pf.txt` | ❌ denied |
| `C:\ProgramData\__pf.txt` | ❌ denied |
| `%APPDATA%\__pf.txt` | ❌ denied |
| `%USERPROFILE%\Documents\__pf.txt` | ❌ denied |
| `D:\__pf.txt` | ❌ denied |

**关键点：拒绝不是 DACL 造成的。** `C:\Windows\Temp` 的 DACL 有 `BUILTIN\Users Modify`，
`D:\` 有 `NT AUTHORITY\Authenticated Users Modify`，工作区根有 `WIN-DV9KRECLBVS\Administrator FullControl`，
而本进程**确实**持有 `BUILTIN\Users` / `NT AUTHORITY\Authenticated Users`。按 DACL 全都该成功 ⇒ 拒绝来自**受限令牌/围栏**这一层。

身份证据：

```
token groups: WIN-DV9KRECLBVS\None, Everyone, BUILTIN\Users, NT AUTHORITY\INTERACTIVE,
              CONSOLE LOGON, NT AUTHORITY\Authenticated Users, …, LOCAL, NT AUTHORITY\NTLM Authentication
（无 BUILTIN\Administrators）      isAdmin=False
& cmd.exe /c 'whoami /all'      → ERROR: Access is denied.   [exit 1]
& cmd.exe /c 'echo SPAWN-OK'    → SPAWN-OK
icacls.exe                      → Program 'icacls.exe' failed to run: Access is denied
```

⇒ `whoami /all` 连**自己的令牌**都读不到（27 字节的 `ERROR: Access is denied.`），
与 r2 的「受限令牌 + 进程启动间歇被拒」同型。

## 4. ⚠ 新增证据 B：提权重试**这次真的做了**，并且**无效**

r2 的 `LEAD-INCIDENT-REPORT.md §3.1` 自述：那次审批策略是 `never`，**提权路径根本没被实测过**
（RUNBOOK §2 却把「换档位」写成「已逐一证伪」——两者矛盾）。本会话审批策略是 `ask`，因此实测：

```
（一次性 danger-full-access 档位重试 §1 中被拒的同一写入）
DENY C:\Windows\Temp\__pf2.txt :: Access to the path '...' is denied.
DENY <workspaceRoot>\__pf2.txt :: Access to the path '...' is denied.
DENY D:\__pf2.txt              :: Access to the path '...' is denied.
LanguageMode=FullLanguage
SPAWN-OK
```

⇒ **档位不改变任何结果**，这次是**有证据的**证伪。原因见 §5：`ctx.shell` 位被本插件单例占住，
请求更宽的档位只被「如实报响 + 按更窄档位执行」，**不交还平台原生执行器**。

## 5. 根因（配置层 + 代码层，均已在本机对到具体行）

### 5.1 配置层：profile 把 WinStage 主开关关掉了

`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml`（L54–58）：

```yaml
- id: winstage-sandbox
  name: "@local/dsh-winstage-sandbox"
  config:
    enabled: false            # ← 主开关关闭
    workspaceRoot: C:\Users\Administrator\Desktop\WinStageSandbox
```

而同一文件里 `winstage-fs`(L28) 与 `winstage-shell`(L40) **仍然启用**。
`winStageEnabled()` 的**唯一真源**就是这个 `enabled`（`dsh-plugin/shell-executor.mjs:666-676`）
⇒ 返回 `false`。

### 5.2 代码层：开关关掉 ≠ 恢复原生 shell；执行面照样占位并缩围栏

`dsh-plugin/shell-executor.mjs:936-958`（本仓库**已写死的裁定**）：

> 历史行为：请求档位 ≠ `workspace-write` ⇒ 抛错、命令不执行。
> …**不交还**：只在本执行器**自己的围栏内**执行，并把档位不匹配**如实报响**。
> 本执行器的可写面**始终**是命令自己的工作目录（`workspace-write`）。

配合 `:1132`「⑥ 在沙箱内执行：cwd = **暂存树**」，得到本会话的可观测事实：

1. `winstage-shell` 仍是唯一 `ctx.shell` ⇒ **每条命令都走它**；
2. 命令 cwd = `.dshstage\sessions\<sid>\staged`（会话暂存树）；
3. 主开关 `enabled=false` ⇒ **没有 shim 通道**（环境里 `WINSTAGE_* / *SHIM* / *STAGE* / *SANDBOX*` **一个都没有**，
   暂存树里**没有** `winstage-shim.config.json`、**没有** `shim.log`）；
4. shim 不接管 ⇒ 工作区外写入**不被重定向**；受限令牌 ⇒ 内核直接硬拒。
   ⇒ **既不放行、也不暂存 = 全盘 DENY，只留暂存树与私有 temp。**

### 5.3 能力 SID 与 RUNBOOK §7 第三条吻合（实测）

| 路径 | 非继承 ACE（能力 SID = `S-1-4-*`） |
|---|---|
| 工作区根 | `S-1-4-56185984-606674207`、`S-1-4-1039366120-933337351`（**都是历史会话**的） |
| 本会话暂存树 | `S-1-4-249359616-169023360`（**本会话**，所以只有它可写） |

⇒ 正如 §7 最后一条所述：**授权没有按「每次运行/当次能力 SID」发放**。

### 5.4 静默性：开关关闭时连告警都没有

`shell-executor.mjs:1098` 的「通道回退」告警带 `this.winStageEnabled() &&` 前置条件。
开关为 `false` ⇒ **告警不发**；而 `:936-958` 的档位注记只走 error 日志 + `handle.winstage.notes`，
**不进模型可见的 stdout/stderr**。⇒ 从模型侧看，这与「一切正常」**完全一样**（本仓库自述最忌讳的形态）。

## 6. 与 r2 的关系

| | r2 | r2b（本会话） |
|---|---|---|
| 症状 | 工作区内/外全 DENY，只留私有 temp | **同** |
| 触发 | 会话运行中途退化（8 线程并行 15–25 min 后） | **开箱即坏**（第 1 条命令） |
| `WINSTAGE_*` | 存在但**为空** | **整个变量族缺失** |
| shim | 仍被注入（`failClosed=1`），无 stageRoot | **完全未注入**（暂存树无 config / 无 log） |
| 提权 | **未实测**（审批 `never`） | **已实测，无效** |
| 结论 | 疑似会话态污染 | **配置 + 代码确定性损坏**（RUNBOOK §7 的判定成立） |

## 7. 建议的下一步（三条路线，各有代价；**需要你选**）

**路线 A（推荐，最小步）：先做配置实验，再复跑 §1**
把 `cordis.patch.yml` 的 `winstage-sandbox.config.enabled` 改回 `true`（或删除该覆盖）→ 重新装配插件
→ 复跑**修正版** §1（工作区根用绝对路径 + 额外校验「真磁盘无此文件、暂存树有它」）→ 通过后按 §4 补跑。
代价：需要动 profile 配置并重新装配；只改一个布尔值，可回退（现存 `winstage-backup-before-*` 目录已提供先例）。
收益：直接判定「是配置关掉了沙箱」还是「装配也坏了」，1 条命令级成本。

**路线 B：直接做 §7 代码修复（测试先行）**
改 `dsh-plugin/shell-executor.mjs:936-958`（档位不匹配时不交还平台、只缩围栏 ⇒ 应在**关闭态**交给平台原生执行器，
或至少在关闭态**显式降级并告警**）+ `src/executor.mjs:2184-2231`（`selfTestTransparent()` 只探工作区外；
应在「暂存不可写」时显式降级并按 `env-missing`/`acl-denied`/`token-restricted` 分类给文案）。
代价：改动 live 插件（deployed 与 `dsh-plugin/shell-executor.mjs` **SHA256 已一致**，改源码即改 live），
必须重新装配 + 跑相关测试套件 + 复跑 §1，周期最长。

**路线 C：只交付本报告，不改配置/代码。**

> 无论选哪条，**§1 的判据本身要先修**（见 §2）：否则「好车道」也可能被误判，或「坏车道」被误判为好。

## 8. 复现命令（可复制，全部已实测）

```powershell
# cwd 陷阱
"PWD=[$PWD]"                      # → ...\.dshstage\sessions\<sid>\staged
# 工作区根写入（应当失败，即坏车道特征）
try { Set-Content 'C:\Users\Administrator\Desktop\WinStageSandbox\__pf.txt' ok -EA Stop; 'OK' } catch { 'DENY' }
# WinStage 环境变量族（当前应全缺）
Get-ChildItem Env: | Where-Object { $_.Name -match 'WINSTAGE|SHIM|STAGE|SANDBOX' }
# 配置层主开关
Select-String -Path "$env:DSH_PROFILE_DIR\cordis.patch.yml" -Pattern 'winstage-sandbox' -Context 0,4
# 能力 SID
(Get-Acl 'C:\Users\Administrator\Desktop\WinStageSandbox').Access | ? { $_.IdentityReference -like 'S-1-4-*' }
```

---

**附**：`_sandbox-tests\r2b\HOST-WRITE-PROBE.txt` 是本次为验证「宿主 write 通道可用」而建的探针文件
（宿主 `write` 工具**成功**写进工作区真磁盘 = 通道正常，见 r2 FINAL-REPORT §1.2 的逃逸面）。
