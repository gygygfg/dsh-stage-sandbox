# R16 域七（易用性）缺陷台账：GUI 操作设计 + CLI 全链路

> **修复状态（第三轮 · 见 [`修复记录-第三轮.md`](修复记录-第三轮.md)）**：
> - ✅ **已修**：`U16-5`（`--help` 退出码 / 子命令真实参数）、`U16-6`（未知候选 id 不再抛栈）、
>   `U16-7`（`--workspace` 校验 / 不静默读别的 store / `status` 打印 store 根）、
>   `U16-8`（`exec` 文本补档位行）、`U16-9`（字典串 markdown `**`）。回归钉 = `tests/cli-contract.ts`。
> - ⏳ **未修**：`U16-1`（产品决策）、`U16-2`/`U16-3` 在后续轮次已由 GUI 侧修复（`approveSelected` /
>   `tierEffective` 进面板，见 `dsh-plugin/client.ts` 与 `shell-executor.ts`）；`U16-4`（web 宿主 `/health`）属平台侧。
>
> 执行者：teammate `usability`（`task-7`）。实测窗口：2026-10-11 17:46 – 18:26；**U16-1 口径于 18:28 按 Lead 裁定改写为"既定语义 + 安全缺口"**（+08:00）。
> 报告：`docs/round16/usability-报告.md`；证据：`.t\r16\usability/**`（截图 `shots/`、逐字文本 `logs/`、可复跑脚本 `scripts/`、宿主侧原始数据 `stage-root-a|b/`、CLI 原始输出 `cli/`）。
> 严重级：**P0 阻断 / P1 重要 / P2 次要**。每条标 `[实测]` / `[读码/推断]`。**本轮未改任何产品代码**（`src/**`、`dsh-plugin/**`、`tests/**` 只读）。
> 与 R11 同域缺陷的对应关系逐条标注（复现 / 形态变化 / 本轮未触发）。

---

## U16-1【P1 · **既定语义 + 安全缺口**｜`[实测]`】混合态（`enabled:false` + `WINSTAGE_SHELL=1`）：命令面已在产生待审候选，审阅面板却不出现；文件面写入直落真实盘且无任何提示

> **口径（R16 Lead 裁定，2026-10-11）**：这不是"漏改一处门控"。
> `dsh-plugin/host-plugin.mjs:799-843`（`panelStagingFaces()`）与 `:845-875`（`buildPanelPayload()` 的闸门注释）**明写**了这条语义：
> - `host-plugin.mjs:808`：本次修复"**不改语义**（`WINSTAGE_SHELL` 仍然只管命令面、不去翻 fs 面的配置值）"，只把两条事实分别报出来（`faces.file` / `faces.shell`）；
> - `host-plugin.mjs:865-875`：记录 R12 曾以为 `WINSTAGE_SHELL=1` 能让 fs 面也在跑、R13 实测推翻该前提（`staging-fs.mjs::stagingEnabledRaw()` 只读 loader 行 `config.enabled`，全仓只有 `cordis.patch.yml` 的 **shell 行**读 `WINSTAGE_SHELL`）；因此路由闸门**保持只看配置值**，`:852-853` 明确"关闭态返回 `503 disabled`"是刻意的；
> - `dsh-plugin/review-service.mjs:96-106`（`shellEnvOverride()`）：把 `WINSTAGE_SHELL` 定义成"是否**强制**了 shell/fs 半边"的**进程级三态**（`'1'` 强制接管 / `'0'` 强制交还 / 其它=未设）。
>
> ⇒ 混合态是**既定语义**；真正的缺口是：**该语义没有配套的可见性 / 失败保护** —— 面板静默不出现、文件面写入静默落真实盘。
> Lead 明确**本轮不改 `stagingEnabledRaw()`**：改它等于推翻既定语义，并可能打破 `tests/dsh2-select-shell-verify.mjs`、`tests/assembly-toggle-selftest.mjs` 的断言。
>
> **两条候选修法（择一，本轮不实施，属产品决策点）**：
> **(a) 双面强制**：把 `WINSTAGE_SHELL` 提升为同时对 fs 面生效 —— 改 `staging-fs.mjs::stagingEnabledRaw()`，并把 `dsh-plugin/cordis.patch.yml` 的 `pwsh-sandbox` / `winstage-shell` 两行门控表达式同步成同一判据（表达式必须逐字成对取反）；**必须重跑** `dsh2-select-shell-verify` 与 `assembly-toggle-selftest` 两套件。
> **(b) 保持单面语义，但让混合态"响亮"**：宿主启动时 `warn` + GUI 常驻横幅/红标"文件面未接管：写入直落真实盘"，并让面板可用（只读审阅也可），而不是静默不出现。

**最小复现（两条命令 + 一条提示，全程未改任何 profile 文件）**

```cmd
set DSH_HOME=C:\Users\Administrator\.dsh
set WINSTAGE_SHELL=1
set WINSTAGE_STAGE_ROOT=<REPO>\.t\r16\usability\stage-root-a
set DSH_SESSION_ID=
dsh web --port 3091 --no-open
:: 浏览器打开 http://127.0.0.1:3091/?token=… → 选工作区 dsh-winstage-sandbox → 发以下提示
:: "use the write-file tool to create .t/r16/usability/ws/gui-a-fs.txt with content D16-A-FS"
:: "use the pwsh tool to run: Set-Content -Path '.t\r16\usability\ws\gui-a-pwsh.txt' -Value 'D16-A-PWSH'"
```

**观测（同一 run 的宿主未受限侧原始输出）**

| 事实 | 值 | 证据 |
|---|---|---|
| 面板/常驻 chip | **全程不存在**（8 拍 × 15 s，`panel=False chip=False`） | `logs/a06-polls.jsonl`、`logs/bu-a06-poll.txt` |
| 路由 | `GET /winstage-panel/snapshot → 503 {"ok":false,"code":"disabled",…,"staging":{"effective":false,"configValue":false,…,"faces":{"file":"off","shell":"win-stage","shellForcedByEnv":true}}}` | `logs/a09-snapshot-route.txt` |
| 但候选**已生成** | `review.json`：`pending=true`、`counts.files=7`、`candidateId=cs_0003_88856528`，候选 `source="shell"`；`sandbox-lane.json`：`launchMode=shim / tierEffective=TS / degraded=false / winStageEnabled=false` | `stage-root-a/review.json`、`stage-root-a/candidates/cs_0003_88856528.json`、`stage-root-a/sandbox-lane.json` |
| 候选内容 | 6 条 `__PSScriptPolicyTest_*` 探针 + `shim.log`（3,819,848 B / 4000 行）；**用户真正的产物 `gui-a-fs.txt` 不在候选里** | 同上 |
| 文件面落点 | `write` 工具产物**真实落盘**：`.t\r16\usability\ws\gui-a-fs.txt`，8 B，`D16-A-FS`，sha256 `2AC4CD97A5080C3BC8152BC34839B875A165184A168B4EC7701F4F1B36EA6127`；对话里只显示"已编辑 gui-a-fs.txt" | `ws/gui-a-fs.txt`、`shots/a04-mid.png` |
| 档位在界面上 | **无**：会话视图没有任何 lane/档位字串；设置行只写两面（见 §U16-3 与报告 §4） | `shots/a04-mid.png`、`shots/a05-settings.png` |
| 设置行文案 | `WinStage 沙箱 已关闭` + `已关闭 · 文件面（暂存/候选）：已关闭 · 命令面（pwsh）：由 WINSTAGE_SHELL=1 强制接管` + 出路（`/winstage status`、`WINSTAGE_SHELL=0` 重启） | `logs/bu-a07-settings.txt` |

**影响**：按文档配方起宿主的人**拿到一个待审候选却没有任何界面可以批准/拒绝**（面板闸门只看 `config.enabled`，**这是既定语义**，见上），而"文件工具"这一侧的写入已经直接落真实盘；用户看到的是"已编辑"卡片，会以为两件事都正常。R11 `D7-b` 的形态（"拿到暂存却没有批准权"）在本轮**被复现**，且新增了 R13 未观测到的证据：候选确实已发布（`source=shell`），只是面板按闸门不显示。**缺的是可见性/失败保护，不是门控逻辑**。

**根因（`[读码/推断]`，R13 §2.3 已定到行）**：`staging-fs.mjs::stagingEnabledRaw()` 只读 loader 行 `config.enabled`；`WINSTAGE_SHELL` 只被 `dsh-plugin/cordis.patch.yml` 的 `winstage-shell`/`pwsh-sandbox` 两行读取 ⇒ **文件面与命令面的开关不同源**（这是 `host-plugin.mjs:808` 明写的既定语义）；面板挂载与 `/winstage-panel/*` 闸门都只看文件面生效值（`:865-875`）。

**建议（若走 (b) 单面语义）**：① 命令面被进程级强制接管时，会话内必须有常驻提示："命令写入会进暂存，但审阅面已关闭，你无法在此批准/拒绝"；② 或让面板闸门认 `faces.shell=win-stage`（至少给"只读审阅"入口）；③ 设置行补一句"此刻的文件写入不会进入候选"；④ 宿主启动时对混合态 `warn` 一次（与 `panelStagingFaces()` 同源，避免第二处真值）。
（若走 (a) 双面强制，则 ①–③ 不再需要，但必须重跑 `tests/dsh2-select-shell-verify.mjs` 与 `tests/assembly-toggle-selftest.mjs`，并确认 `tests/dsh-patch-guard.mjs` 对门控表达式逐字成对取反的断言仍成立。）

---

## U16-2【P1｜`[实测]`】"批准全部"无视工作区内行的勾选：勾 1 个、两个都写入真实盘；GUI 没有"批准所选"

**最小复现（Phase B：`dsh web --patch <overlay enabled:true> --port 3091 --no-open`）**

面板（`shots/b10-panel.png` / `logs/bu-b15-panel.txt`）逐字：

```
WinStage 暂存待审 · 2 个文件（L1 2） · 等待你批准后才写入真实工作区 · 2 个文件 · +2 / −0
L1 工作区内 (2)
  ☐ 新增 .t\r16\usability\ws\gui-b-one.txt   +1 / −0
  ☐ 新增 .t\r16\usability\ws\gui-b-two.txt   +1 / −0
全选 · 清空选择 · 暂时收起 · 拒绝全部 · 批准全部
「批准全部」= 全部工作区内的普通项 + 你已勾选的工作区外/敏感项；未勾选的高风险项不会被写入。
```

| 步 | 读数 | 证据 |
|---|---|---|
| 点击前 | 两个 checkbox `checked=false` | `logs/bu-b16-approve.txt` `CBS_BEFORE` |
| 只点 `gui-b-one.txt` 的 checkbox | `[{one:true},{two:false}]`（人点，非 JS） | 同上 `CBS_AFTER_CLICK` |
| 点"批准全部" | 面板消失；**真实盘出现两个文件**：`gui-b-one.txt`（9 B，`D16-B-ONE`）+ `gui-b-two.txt`（9 B，`D16-B-TWO`） | `ws/`、`queue.json` `cs_0002_d37e9d4a status=applied`、`shots/b11-after-approve.png` |
| "批准所选"按钮 | **不存在**（该行只有 全选 / 清空选择 / 暂时收起 / 拒绝全部 / 批准全部） | `bu-b15-panel.txt` 的 `PANEL_BTNS` |

**影响**：① 任务要求的"选择路径 → apply"在**工作区内**改动上不可达；② 工作区内行渲染了 per-file checkbox（`aria-label=<路径>`），用户完全有理由认为"不勾就不写"——实测**勾选状态被忽略**，这是误导性可供性；③ 唯一真正支持选择性的是工作区外/敏感项。

**建议**：加"批准所选"按钮（对工作区内项也生效）；或在工作区内行的 checkbox 上置灰 + 就地写明"工作区内普通项一律随『批准全部』写入"。

---

## U16-3【P1｜`[实测]`】健康会话里面板可信性卡片报红（`level=lost` / `档位 ?`），而权威 lane 文件里没有档位字段

**观测（Phase B，`enabled:true`，纯文件写入、未跑任何 shell 命令）**

面板可信性卡片逐字（`logs/bu-b15-panel.txt`、`shots/b10-panel.png`）：

```
可信性：
⚠ 沙箱档位信息不完整（面板拿到的卡片里没有档位字段）：**暂存写入此刻可用**（待审候选正常生成）；
是否已降档无法据此判定，请跑 /winstage status 看权威结论。
档位 ? · 掉档 0 次 · 失根 81 次 · 未结算审批 0 · 未确认写入 0 · 敏感读 0 ·
判据：宿主 level=lost · tierEffective=? · degraded=no · 卡来源=scoped(n/a) ·
（"失根 81"是探测计数，不是写入失败次数，且每次查询都会 +1；本条不影响写入）
```

DOM 锚点：`data-winstage-trust="lost"`、`data-winstage-trust-basis-notice="1"`、`data-winstage-store-source="host-route"`（`logs/bu-b14-sendpoll.txt`）。

同 run 的 `stage-root-b/sandbox-lane.json` 原文（**只有 kind + history.rootLoss，没有 `tierEffective`/`launchMode`/`degraded`**）：

```json
{ "kind": "winstage-sandbox-lane",
  "history": { "commandSeq": null, "shimCount": 0, "degradeCount": 0, "everDegraded": false,
    "rootLoss": { "everLost": true, "count": 104, "lastReason": "marker-missing",
                  "lastAt": "2026-10-11T10:19:39.780Z", "lastPhase": "status" } } }
```

对照 Phase A（跑过一次 pwsh）的同名文件：`launchMode=shim / tierEffective=TS / degraded=false / fallbackClass=none / history.commandSeq=3, shimCount=3`（`stage-root-a/sandbox-lane.json`）。

**影响**：用户在一个**暂存与候选都正常**的会话里，第一眼看到的是红色"可信性"+"档位 ?"+"宿主 level=lost"；唯一的出路是自己去 `/winstage status`。这与 R11 `D7-d`（界面与事实相反/档位不可见）是**同一族问题的残余形态**：这次不是"说反了"，而是"档位值根本没进面板，面板诚实地说不知道"——对用户的可判定性没有改善。

**根因（`[读码/推断]`）**：面板档位只能取自该 store 的 lane 快照；本轮该快照被"status/失根探测"路径写成了只有 `history.rootLoss` 的形态（`lastPhase=status`），tier 字段整体丢失。

**建议**：① lane 快照**分字段更新**（或把 `tier` 段与 `rootLoss` 段拆成两份文件），任何写入者都不得清掉 tier 段；② 面板在"本 store 尚未产生命令面档位读数"时显示"尚无命令面读数（文件写入未受影响）"，而不是 `level=lost`；③ 把 `/winstage status` 的权威结论直接注入卡片（面板已经在指路，但没给入口）。

---

## U16-4【P2｜`[实测]`】web 宿主没有 `/health`：按 `/health` 判活会得到 404

| 请求 | 3080（用户宿主） | testservice 8737（对照） |
|---|---|---|
| `GET /` | **401**（token 门禁，服务存活） | — |
| `GET /health` | **404** | **200** + JSON（免 token） |
| `GET /healthz`、`/api/health` | 404 / 401 | — |

证据：本轮探测输出（见报告 §7 与 §1）；`src/testservice.mjs:334` 的 `/health` 是免 token 的。

**影响**：运维/脚本用 `/health` 探活本仓库的 web 宿主会得到"服务不存在"的假结论（本轮收尾只能改用 `Get-NetTCPConnection -State Listen` + `/` 的 401 作为存活证据）。

**建议**：web 宿主也提供免 token 的 `/health`（返回版本 + 监听端口即可），或在本仓库文档里删掉用 `/health` 判活的写法。

---

## U16-5【P2｜`[实测]`】CLI `--help` 退出码 2；子命令 help 不覆盖真实参数

| 命令 | 退出码 | 输出 |
|---|---|---|
| `run.cmd src\cli.mjs`（无参） | **2** | 全局 usage（447 B） |
| `run.cmd src\cli.mjs --help` | **2** | 同上（447 B） |
| `run.cmd src\cli.mjs apply --help` | 0 | **同一份全局 usage**，不含 `--paths/--force` |
| `run.cmd src\cli.mjs frobnicate` | 2 | `未知命令: frobnicate` + usage |

`USAGE` 里只列 `--workspace/--json/--session`；代码实际支持且**未在 help 中出现**的：`--candidate`、`--paths`、`--force`、`--max-lines`、`--timeout`、`--tier`、`--read-only`、`--no-cache`、`--use-cache`、`--reason`（`src/cli.mjs:56-95` 与各 case）。证据：`cli/20-noargs.*`、`cli/21-help.*`、`cli/22-apply-help.*`（三者同 447 B）。

**影响**：`--help` 在脚本里等于错误；"怎么只应用一个路径/怎么改档位/怎么看更长 diff"必须读源码。对照：`testservice.cmd --help` / `src\testclient.mjs --help` 既列全部开关又列全部 suite 名，退出码 0。

**建议**：`--help` 一律 exit 0；为每个子命令写 usage（或至少在全局 usage 里补齐真实参数）。

---

## U16-6【P2｜`[实测]`】CLI 错误路径风格不一致：候选不存在时抛未捕获堆栈

```
> run.cmd src\cli.mjs apply --workspace <ws> --candidate cs_9999_deadbeef
未捕获错误: SandboxError: candidate cs_9999_deadbeef does not exist
    at Workspace.resolveCandidate (file:///C:/…/src/workspace.mjs:1424:15)
    at Workspace.applyCandidate (file:///C:/…/src/workspace.mjs:1463:44)
    at main (file:///C:/…/src/cli.mjs:336:32)
… exit=1
```
（`diff --candidate cs_9999_deadbeef` 同形，`src/cli.mjs:302`。证据：`cli/25-apply-badid.txt`、`cli/26-diff-badid.txt`。）

同仓的其它用法错误都是 `CODE: message` 风格且带出路：`USAGE: exec 需要命令，例如: exec -- pwsh -c "ni a.txt"`（exit 1）、`USAGE: discard 需要 --candidate <id>`（exit 1）。文件头声明的退出码契约里也没有"堆栈"这一档。

**建议**：`resolveCandidate` 的错误走 `fail('CANDIDATE_NOT_FOUND', …)`，正文加"先跑 `review` 看可用 id"。

---

## U16-7【P2｜`[实测]`】`status` 不打印 store 根、不校验 `--workspace`，路径/环境不一致时静默给出别的 store 的读数

```
> run.cmd src\cli.mjs status --workspace <REPO>\.t\r16\usability\cli\no-such-ws
工作区      : C:\…\.t\r16\usability\cli\no-such-ws     ← 原样回显入参（该目录不存在）
会话        : 3a365887-…  revision=3                  ← 实际读的是 WINSTAGE_STAGE_ROOT 指向的 store
暂存条目    : 1
待审文件数  : 0（0 份候选）
… exit=0
```
证据：`cli/27-status-badws.txt`（exit 0）。

本轮我还实测到该形态的**真实代价**：两条 `run.cmd` 调用若环境变量不一致（一条钉了 `WINSTAGE_STAGE_ROOT`、另一条没有），`exec` 冻结了候选而随后的 `review` 打印 **"待审队列为空"**、`status` 报 revision=0 —— 用户会以为"exec 没有产出变更"。`init` 会打印 `store = …`，但 `status/review/diff/apply` **都不打印 store 根**，也没有任何"解析到的 store 与上次不同"的告警。

**建议**：① `status`（及其它命令）打印解析后的 store 根；② `--workspace` 指向不存在目录或与 `manifest.workspaceRoot` 不一致时 fail-fast（非 0 退出 + 明确文案）。

---

## U16-8【P2｜`[实测]`】CLI `exec` 文本输出不显示档位；JSON 里才有，且默认档位与插件面不同源

```json
"execution": { … "tier": "T1", "enforcement": "partial",
  "sandboxInit": { "tierRequested": "T1", "tierEffective": "T1", "launchMode": "restricted-token", … } }
```
而文本模式只打印 `退出码=0 分类=ok 用时=63ms` + "提取到 N 项变化"（`cli/02-exec.json` 与 `cli-chain` 的文本输出）。

对照：本仓库 GUI/插件面同 run 的 lane 是 `launchMode=shim / tierEffective=TS`（`stage-root-a/sandbox-lane.json`）。⇒ 两面**默认执行档位不同源**，而 CLI 文本用户看不到自己处在哪一档。

**建议**：exec 文本模式补一行 `档位=<tierEffective>(<launchMode>)`（与 lane 同源）；并明确文档说明 CLI 默认 T1 与插件面 TS 的差异是否预期。

---

## U16-9【P2｜`[实测]`】描述字段的 markdown `**` 原样显示（R11 `D7-e` 复现，未修）

- 设置行（Phase A）逐字：`关闭后：**文件工具（写文件）立即退回**平台自带的沙箱/审批模式；**命令（pwsh）需要重启宿主后**才交还平台 shell…`（`logs/bu-a07-settings.txt`）
- 面板可信性卡片（Phase B）逐字：`**暂存写入此刻可用**（待审候选正常生成）`（`logs/bu-b15-panel.txt`）
- `DESC_HAS_MD_STARS=True`（`logs/bu-b18-rowfull.txt`）

**建议**：走 markdown 渲染，或去掉星号（`dsh-plugin/client.js` 的字典串）。

---

## 附：本轮**未复现 / 未触发**的 R11–R13 缺陷（不算已修，只记状态）

| 项 | 本轮状态 | 依据 |
|---|---|---|
| R11 `D7-c` 开关点击无声 no-op | **not-run**（本轮**刻意不点**：点击会把 `%DSH_HOME%\profiles\web\cordis.patch.yml` 写回，违反本轮硬约束"不许改 `profiles\web\**`"）。锚点存在（`aria-checked`、`data-winstage-staging-effective=on/off`、`data-winstage-staging-forced=1`） | `logs/bu-b17-settings.txt`、`logs/bu-a08-rowattrs.txt` |
| R11 `D1b` 报"写入失败"但文件已改 | 本轮未触发（未点击任何设置开关） | 同上 |
| R13 §3.2 "开关坐标在视口外导致假 no-op" | **间接复现**：Phase A 开关 `getBoundingClientRect` 中心 y=**929** 而 `innerHeight=706`；`scrollIntoView` 后 y=428。自动化/键盘用户必须先滚动 | `logs/bu-a07-settings.txt`、`logs/bu-a08-rowattrs.txt` |
| R11 `D7-f` 候选信噪比（`__PSScriptPolicyTest_*` + `shim.log`） | **复现（原始数据侧）**：7 条里 6 条探针 + `shim.log` 3.82 MB/4000 行（Phase A）；Phase B 的**面板**则只显示用户产物（工作区相对路径 + `新增` 标签 + `+1/−0`） | `stage-root-a/candidates/cs_0003_88856528.json`、`shots/b10-panel.png` |
| R11 `D7-a` 平台提权后 `write` 工具绕过暂存 | **not-run**（需要写到真实写作用域之外才能触发平台提权，本轮写作用域被限定在 `.t\r16\usability/**`；Phase A 的直写真实盘**不是**提权形态，而是"文件面已关闭"） | — |
| R11 `D7-g` 两层审批关系无交叉说明 | **部分改善**：composer 的 `data-winstage-permission="1"` 芯片 title 逐字含"WinStage 沙箱：文件写入先落暂存、批准后才写真实工作区（已替代平台的访问模式选择器）"；但仍无"平台审批 ≠ WinStage 审批"的直接表述 | `logs/bu-b17-settings.txt` |
| R11 `D2` 面板展开时 composer 被移出 DOM | 本轮**未观测到**（面板出现时 composer 仍在，输入框可用） | `shots/b10-panel.png` |
| R11/R13 截图 60 s 超时 | 本轮用 `cdp("Page.captureScreenshot")`：11 张截图里 1 次 5 s 超时（重试后成功），`capture_screenshot()` 未使用 | `shots/*.png` |
