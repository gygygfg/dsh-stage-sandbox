# R11 域七（D7）缺陷台账：GUI 操作设计易用性

> 执行者：teammate `t7-usability`（`task-7`）。时间：2026-10-10 23:27–23:47（+08:00）。
> 报告：`docs/round11/usability-报告.md`；原始证据：`.t\r11\usability\evidence/**`。
> 严重度口径：**S1 隔离/安全** · **S2 阻塞主流程** · **S3 误导** · **S4 体验**。每条标 `[实测]` / `[读码/推断]`。
> **全部为"待 Lead 裁定"**，本轮**未改产品代码**。

---

## D7-a【S1｜`[实测]`】平台一次提权后，`write` 工具绕过 WinStage 暂存，直接落真实盘

**观测（同一会话、同一 run，宿主未受限侧原始输出）：**

| 事实 | 值 | 证据 |
|---|---|---|
| 界面上用户看到的第一个对话框 | `允许本次操作使用 danger-full-access 权限：写文件工具被 workspace-write 沙箱拒绝，需要写入会话工作区外的桌面测试路径以完成任务 1。` + `[拒绝] [允许一次]` | `evidence/05-approval-dialog-text.txt`、`evidence/05-approval-dialog.png` |
| 我点了「允许一次」 | 会话继续，`已完成，用时 4分0秒`；自报 `写文件工具：失败（workspace-write 拒绝），经一次性提权重试后成功` | `evidence/06-panel.png`、`evidence/07-settings-text.txt` |
| `write` 工具写 `…\ws\d7-fs.txt` | `manifest.json` 含 `d7-fs.txt` = **False**；`staged\…\ws\d7-fs.txt` 存在 = **False**；**真实盘 `ws\d7-fs.txt` = EXISTS**，8 B，`D7-FS-OK`，sha256 `ABAE77ADEE9299E8FA84134BBE0D457B15010AD2393CA96DC35E4D6F8C238266`，mtime `2026-10-10T23:35:43` | `evidence/11-host-facts.txt` §1–§2 |
| `pwsh` 工具写 `…\ws\d7-pwsh.txt`（**同一会话、未提权**） | `manifest.json` 含 `d7-pwsh.txt` = **True**（`origin=exec`、12 B、`stagedHash=1c6333c3…`）；真实盘 `ws\d7-pwsh.txt` = **ABSENT** | `evidence/11-host-facts.txt` §1–§2 |
| WinStage 自己的账 | `audit.summary.filesWrittenInWorkspace = 1`（= 只记了 `d7-pwsh.txt` 这一笔）；`candidates[0].paths` 的 10 条里**没有** `d7-fs.txt` | `evidence/11-host-facts.txt` §3 |
| 沙箱档位正常 | `sandbox-lane.json`：`launchMode=shim`、`tierEffective=TS`、`degraded=false`、`fallbackClass=none` | `evidence/11-host-facts.txt` §5 |

**影响**：用户以为"批准一次平台权限"只是让这一步能跑；实际上这一步的写入**既不进暂存、也不进待审，也无法被拒绝**——WinStage 的"先暂存等批准"在这条路径上**完全失效**，而界面没有任何提示（`D7-a` 与 `D7-b` 叠加时用户连审阅面都看不到）。

**这正是 R10 标注为 `not-run` 的那条**（"本会话模型侧文件策略句为 `danger-full-access`，而 WinStage 仍'先暂存等批准'"）——本轮拿到了**反例**，与 R10 的"间接证据"方向相反，需 Lead 复核判定是本轮新引入还是一直如此。

**建议**：见报告 `I-12`。`[读码/推断]` 落点疑在 `dsh-plugin/fs-entry.mjs` 的 provider 选择与平台权限层的交接处（提权可能换掉了 `ctx.fs` 的提供方），**需 host 侧定位**。

---

## D7-b【S2｜`[实测]`】`enabled:false` + `WINSTAGE_SHELL=1` 组合下，待审面板完全不出现

**观测：**

- `[实测]` 跨 20 分钟、约 20 次 `document.body.innerText` 快照（`evidence/poll-t00..t10.txt`、`poll-a00..a08.txt`、`poll-final-poll.txt`、`04-poll-end.png`、`06-panel.png`）**从未出现** `WinStage 暂存待审` / `批准所选` / `拒绝全部` / `候选`。会话结束后界面是普通对话流，**没有面板、没有 chip**。
- `[实测]` 但插件**已加载**：插件包 URL 含 `dsh-winstage-sandbox/client.js`；页面存在 `data-winstage-composer-unhide="1"`（`evidence/session-log.txt` 的 `WIN_ATTRS`/`RESOURCES`）。
- `[实测]` 同一时刻暂存面**在工作**：`review.json` `pending=true`、`counts.files=10`、`+4010/−0`；lane `tierEffective=TS`。
- `[读码/推断]` 差异变量：本轮 profile 是 `enabled: false`（lane 亦自报 `winStageEnabled=false`），R10 两个宿主都用 `--patch` 钉成 `enabled: true`，面板正常出现。

**影响**：用户在这个配方下**拿到暂存却没有审阅/批准界面**。任务要求的"候选列表 / diff 可读性 / 批准所选 / 拒绝全部的可写集合语义"因此本轮 `not-run`（无按钮可点）。也意味着：如果用户按 README/配方（`WINSTAGE_SHELL=1`，不改 profile）起宿主，**会在完全不知情的情况下失去批准权**。

**建议**：见报告 `I-11`。并**建议 Lead 用 `--patch`（`enabled:true`）跑一次最小对照**，把"面板消失"归因定死。

---

## D7-c【S3｜`[实测]`】设置页 `WinStage 沙箱` 开关是"无声 no-op"

**观测：**

| 步骤 | 结果 | 证据 |
|---|---|---|
| 开关元素 | `<button role="switch" aria-label="WinStage 沙箱" aria-checked="false">`，`disabled=false`、`pointer-events:auto`、`38×22` @ (962.4, 882) | `evidence/10-switch-state.json` |
| 点击前 | 行文案 `WinStage 沙箱 已关闭`；`gui-home\…\cordis.patch.yml` sha256 `C5C5E8F607DB4A712282AA5C18EFDB974ADAAE827EB89DC0751FBEEA4E5C9175`、1441 B、mtime `23:40:40` | `evidence/11-host-facts.txt` §6 |
| 点击后（3 s） | `aria-checked` **仍 `false`**；行文案**不变**；全页 innerText **无任何**错误/成功提示；文件 sha256/size/mtime **三项完全不变** | `evidence/09-after-winstage-toggle-text.txt`、`evidence/11-host-facts.txt` §6 |
| 对照组（同一屏无关开关 `显示代码工作视图`，`true→false`） | 写回**成功**：1348→1441 B、sha256 `7B33AB25…192BB`→`C5C5E8F6…C9175`、mtime `12:51:41`→`23:40:40`，末尾追加 `- id: ui-settings / name: "@deepseek-ai/dsh-client-ui-settings" / config: enabled: false` | `evidence/11-host-facts.txt` §6–§7 |
| 隔离核对 | `~/.dsh\profiles\web\cordis.patch.yml` 全程 sha256 `7B33AB25…192BB` **未变** | `evidence/11-host-facts.txt` §6 |

**与 R10 的关系**：R10 的 `D1b` 是"报 `写入失败，已保留原值`，但文件已被改写"。本轮**未复现**该形态：WinStage 开关**既没写、也没报**；而写回通道本身可用（对照组已证）。⇒ 形态从"说谎"变成"装死"。

**影响**：用户**无法通过 GUI 关闭或打开 WinStage 沙箱**，且得不到任何诊断信息（连"失败"都没有）。M4 判"差"的直接原因。

**建议**：见报告 `I-13`（必须落到"已生效 / 被进程级 `WINSTAGE_SHELL` 固定 / 写入失败 `<code>`"三态之一）。

---

## D7-d【S3｜`[实测]`】设置行状态词与实测生效档相反

**观测：** 行内状态词 `已关闭`；同一宿主同一时刻 `pwsh` 写入被证实进了暂存（`staged\…\d7-pwsh.txt` 存在、真实盘 `ABSENT`）、`sandbox-lane.json` `tierEffective=TS`、`degraded=false`。进程级 `WINSTAGE_SHELL=1` 的覆盖在界面上**完全不可见**。

**影响**：用户读到"已关闭"，事实是"已在跑"。与 R10 的 `M7` 同源（"界面说的与事实相反"），只是方向更直白。

**建议**：见报告 `I-14`（状态词改读服务端 lane 快照，把"配置值"与"生效值"分列）。

---

## D7-e【S4｜`[实测]`】描述字段的 markdown 星号原样显示

**观测（`evidence/10-switch-state.json` 的 `rowHTML` 逐字）：**

```
…关闭后：**文件工具（写文件）立即退回**平台自带的沙箱/审批模式；**命令（pwsh）需要重启宿主后**才交还平台 shell…
```

`**` 被当作普通文本渲染出来，用户看到裸星号。

**建议**：见报告 `I-15`（走 markdown 渲染或去掉星号）。

---

## D7-f【S4｜`[实测]`】候选集信噪比与路径可读性（沿用 R10 `D5/D7/D8`，本轮换到 GUI 场景复核）

**观测（`evidence/11-host-facts.txt` §3–§4）：**

- 10 条候选里 **9 条**是 `fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\<guid>\__PSScriptPolicyTest_*`（PowerShell AppLocker 探针，各 60 B）；
- `shim.log` = **4,419,672 B / 4000 行**，占 `additions=4010` 里的 4000（用户真实成果只有 `d7-pwsh.txt` 的 2 行）；
- 路径写法为内部键 `fs\C\…`，不是工作区相对路径；
- 会话里 `pwd` 回显 `…\.t\r11\usability\stage-root\staged`——**内部暂存路径直接显示给用户**（与 R10 `D5` 同）。

**注意**：以上全部取自 `review.json` / `staged\` 原始数据，**不是用户实际看到的界面**（面板未渲染，见 `D7-b`）；因此"面板能否折叠噪声"这一半**本轮未能在界面上核验**。

**建议**：见报告 `I-16` / `I-17`。

---

## D7-g【S2｜`[实测]`】两个审批层的关系在界面上没有一句话说清（M2 第⑧个必知概念）

**观测：** 用户在新会话里发的第一条提示，遇到的**第一个**对话框是**平台**的：`允许本次操作使用 danger-full-access 权限：…` + `[拒绝] [允许一次]`；而"WinStage 待审 / 批准所选 / 拒绝全部"是**另一个**完全不同的批准界面。两者在 UI 上没有任何交叉说明；`允许一次` 是**平台权限**，不等于批准 WinStage 候选（在 `D7-a` 里它甚至让写入绕过了候选）。

**影响**：本轮我因此多花约 4 分钟、并改变了落点；对普通用户更甚——很容易把"允许一次"理解成"批准这次文件改动"。

**建议**：见报告 `I-18`。

---

## 附：本轮**未复现**的 R10 缺陷（不算已修，只记"本轮环境未触发"）

| R10 缺陷 | 本轮状态 |
|---|---|
| `D1b` 报 `写入失败，已保留原值` 但 profile 已被改写 | **未复现**：WinStage 开关本轮 0 写入 0 提示（形态变为 `D7-c`）；写回通道本身可用（对照组成功写隔离 home）。**R10 修复轮改过的错误文案本轮因此未被触发**，其质量仍 `not-run` |
| `D3/D4` 降档不可见 / 误导头条 | **未复现**：本轮 lane `degraded=false`、`degradeCount=0`，面板也未渲染 ⇒ 该文案未出现在界面上（`not-run`） |
| `D2` 面板展开时 composer 被移出 DOM | **未复现**：面板从未渲染 ⇒ 无法复核 R10 修复轮那条 `data-chain-overlay-fallback` 的实效 |
| `D9` 宿主静默退出 | **未复现**：3091 宿主全程存活，`host3091.out.txt` 只有一行 URL、stderr 为空，直到我主动停止 |
| `D10` UI 类声明缺宿主侧原始输出 | **本轮已按 R10 §3.3 方法论执行**：所有"落盘/零残留/绕过"类声明都附同 run 宿主未受限侧原始输出（`evidence/11-host-facts.txt`），且**未在留证前删除证据物**（`ws\d7-fs.txt` 刻意保留） |
