# R11 域七（D7）报告：browser-use 驱动的 GUI 操作设计易用性实测

> 任务：`task-7`（D7 操作设计易用性，必须用 browser-use 技能驱动真实浏览器）。执行者：teammate `t7-usability`。
> 时间窗：2026-10-10 23:27 – 23:47（+08:00）。
> 交付：本文件 + `usability-缺陷.md` + `.t/r11/usability/evidence/**`（截图 / 逐字文案 / 宿主侧原始事实）+ `.t/r11/usability/logs/**`（宿主与 browser-use 日志）+ `.t/r11/usability/scripts/**`（可复跑脚本）。
> 铁律遵守：**未改产品代码**；**未碰 `~/.dsh/**` 与 `profiles\web`**（同文件 sha256 前后一致，见 §1.3）；**未杀 3080 宿主**（全程 `3080 → pid 8960` 存活）；只写 `.t/r11/usability/**` 与 `docs/round11/usability-*.md`。
> 上一轮对照基线：`docs/round10/gui/报告.md`、`docs/round10/gui/评分表.md`（含 task-15 修复轮重打分）。

---

## 0. TL;DR（本轮最重要的三条）

1. **`[实测]` 文件工具在"一次性提权到 `danger-full-access`"之后绕过了 WinStage 暂存，直接落真实盘。**
   同一个会话里：`pwsh` 写的 `ws\d7-pwsh.txt` **只出现在暂存树**（真实工作区 `ABSENT`）；而 `write` 工具写的 `ws\d7-fs.txt` **不在 `manifest.json`、不在 `staged\`**，却**真实存在于工作区**（8 B、`D7-FS-OK`、sha256 `ABAE77AD…8266`、mtime 23:35:43）。
   用户点的是界面上的「允许一次」，界面上看不到任何"这会绕过沙箱暂存"的提示。证据：`evidence/11-host-facts.txt` §1–§2、`evidence/05-approval-dialog-text.txt`。
2. **`[实测]` 本轮 GUI 里 WinStage 审阅面板从未出现**（约 20 次 `document.body.innerText` 快照跨整个会话与事后，均无 `暂存待审`/`批准所选`/`拒绝全部`），而 WinStage 客户端插件**确实已加载**（插件包 URL 含 `dsh-winstage-sandbox/client.js`；页面上有 `data-winstage-composer-unhide="1"`）。同一时刻 `review.json` 是 `pending=true / files=10`、lane 是 `tierEffective=TS / degraded=false`。
   ⇒ **待审面板的"候选列表 / diff 可读性 / 批准所选 / 拒绝全部"四项目标本轮无法在界面上实测**（无按钮可点），只能从 `review.json` + `staged\` 原始数据侧面判读。
3. **`[实测]` 设置页 `WinStage 沙箱` 开关点击是"无声 no-op"**：`aria-checked` 保持 `false`、行文案不变、**没有任何错误/成功提示**、profile 文件**一个字节都没动**。而同一屏里点**另一个无关开关**（`显示代码工作视图`）却成功把 `gui-home\profiles\web\cordis.patch.yml` 从 1348 B 改写为 1441 B —— 反证写回通道本身是好的，**坏的是这一行**。

---

## 1. 装配与隔离台账

### 1.1 隔离 GUI 宿主（配方逐条照做）

| 项 | 值 |
|---|---|
| `DSH_HOME` | `.t\r11\usability\gui-home`（独立，**不是** `~/.dsh`） |
| profile 内容 | 从 `~/.dsh` 复制 `.credentials.yaml` + `profiles\web\{cordis.yml, cordis.patch.yml, package.json, pnpm-workspace.yaml, pnpm-lock.yaml}`；`node_modules\{.pnpm\lock.yaml, .modules.yaml, .pnpm-workspace-state-v1.json, @local\**}` 逐项复制；`node_modules\dsh-winstage-sandbox` 用 `cmd /c mklink /J` 指回仓库根 |
| 环境变量 | `WINSTAGE_SHELL=1`、`DSH_SESSION_ID=`（清空）、`WINSTAGE_STAGE_ROOT=.t\r11\usability\stage-root` |
| 命令 | `dsh --profile web --port 3091 --no-open`（cwd = 仓库根，**未用 `--patch`**） |
| 宿主 PID | 9620（收尾已 `Stop-Process -Force`；后台作业 `pwsh-782` 退出码 1 = 被杀） |
| 宿主 stdout | `dsh web: http://127.0.0.1:3091/?token=` + token（43 字符，已打码）→ `logs/host3091.out.txt`；stderr 为空 |

> 说明：R10 为"不改 `profiles\web`"用了 `--patch` overlay；本轮按任务给的**独立 `DSH_HOME`** 配方，因此**不需要** `--patch`，profile 层的写回天然只落在 `gui-home`（§1.3 已证）。这是本轮与 R10 在装配上的**关键差异**，也是 §3 结论与 R10 不同的原因之一。

### 1.2 独立浏览器（CDP 9223，不抢默认浏览器）

| 项 | 值 |
|---|---|
| 浏览器 | Edge `Edg/155.0.4283.45`，`--remote-debugging-port=9223 --user-data-dir=.t\r11\usability\edge-profile` |
| 连接方式 | `BU_CDP_URL=http://127.0.0.1:9223` + `browser-use`（脚本走 stdin；**脚本必须纯 ASCII**，中文一律 `\uXXXX`，否则 `browser-harness/run.py:406` 抛 `UnicodeEncodeError: surrogates not allowed`） |
| 操作注意 | 用 `Start-Process` 起的首个 Edge 实例 ~3 分钟内自行退出；改用 `cmd /c start "" msedge.exe …` **分离启动**后全程稳定 ⇒ 记为操作经验，非产品缺陷 |
| 收尾 | 按 `CommandLine -like '*usability\edge-profile*'` 精确匹配，9 个进程全部停止（`my edge processes remaining = 0`） |

### 1.3 隔离性硬证据

| 文件 | 测试前 | 全部测试后 | 结论 |
|---|---|---|---|
| `~/.dsh\profiles\web\cordis.patch.yml`（**共享，绝对不可变**） | sha256 `7B33AB252BC3FC69CB870DC8E0F46E3BB2870220343145ED23234C371EB192BB`，1348 B | **同一 sha256 / 1348 B** | 用户 GUI 与 `profiles/web` **零污染** |
| `gui-home\profiles\web\cordis.patch.yml`（我的隔离 home） | sha256 `7B33AB25…192BB`，1348 B，mtime `12:51:41` | sha256 `C5C5E8F6…C9175`，1441 B，mtime `23:40:40` | 设置写回**只落在隔离 home** ⇒ 配方有效 |
| `3080`（用户 GUI，pid 8960） | LISTEN | **LISTEN**（node，start 16:33:28） | 全程未动 |
| `3091` / `9223` | LISTEN（9620 / 8056） | **not listening** | 收尾干净 |
| `9222` | LISTEN pid 10340 | **LISTEN pid 10340** | 别人的 CDP，**未触碰**（R10 遗留态，非本轮） |

---

## 2. 用例 A：新会话 + 一条短提示（write 工具 / pwsh 工具 / pwd）

**发出的原文**（逐字，`scripts/prompt-1.txt`）：

```
请做 3 件事，不要提问，不要解释，尽量简短。
1) 用写文件工具创建文件 C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r11\usability\ws\d7-fs.txt，内容写 D7-FS-OK
2) 用 pwsh 工具执行：Set-Content -Path 'C:\...\ws\d7-pwsh.txt' -Value 'D7-PWSH-OK'
3) 用 pwsh 工具执行 (Get-Location).Path 并把输出原样贴出来
完成后最后一行列出这三个结果。
```

### 2.1 第一跳不是 WinStage 面板，而是**平台自己的提权对话框**

`[实测]` 界面逐字（`evidence/05-approval-dialog-text.txt`、截图 `evidence/05-approval-dialog.png`）：

```
等待审批
允许本次操作使用 danger-full-access 权限：写文件工具被 workspace-write 沙箱拒绝，需要写入会话工作区外的桌面测试路径以完成任务 1。
[拒绝]  [允许一次]
```

`[实测]` 我点「允许一次」后，agent 继续并跑完：`已完成，用时 4分0秒`（截图 `evidence/06-panel.png`）。会话逐字（`evidence/07-settings-text.txt` 含同一文本）：

```
写文件工具：失败（workspace-write 拒绝），经一次性提权重试后成功，内容 D7-FS-OK
pwsh Set-Content：成功，d7-pwsh.txt = D7-PWSH-OK
(Get-Location).Path 原样输出：
C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r11\usability\stage-root\staged
已编辑 d7-fs.txt  +1  -0
```

`[读码/推断]` 该会话的默认权限预设是 profile 里的 `defaultPreset: workspace-write`（`approval: ask`），所以**先**弹 DSH 自己的审批；这次弹出的原因是它认为目标路径不在会话工作区内。**确切的"会话工作区根"本轮未取到定论**（递归检索一次误触发了全仓扫描，已中止，记为未决）——但**这不影响下面的实测事实**：用户点了「允许一次」之后，`write` 工具的内容落在了真实磁盘上，而 WinStage 的暂存树里没有它。

### 2.2 宿主侧判定（同一 run、宿主未受限侧原始输出）

证据文件：`evidence/11-host-facts.txt`（§1–§5）。

| 事实 | 值 | 判读 |
|---|---|---|
| `manifest.json` 是否含 `d7-fs.txt` | **False** | `write` 工具**没进暂存账本** |
| `staged\...\ws\d7-fs.txt` 是否存在 | **False** | 暂存树里没有它 |
| 真实 `ws\d7-fs.txt` | **EXISTS**，8 B，`D7-FS-OK`，sha256 `ABAE77ADEE9299E8FA84134BBE0D457B15010AD2393CA96DC35E4D6F8C238266`，mtime `23:35:43` | **提权后直接落真实盘** |
| `manifest.json` 是否含 `d7-pwsh.txt` | **True**（`origin=exec`，12 B，`stagedHash=1c6333c3…`） | 命令面**正常进暂存** |
| 真实 `ws\d7-pwsh.txt` | **ABSENT** | 命令面**未落真实盘**（暂存面生效） |
| `review.json` | `candidateId=cs_0004_1fe8cd62`、`pending=true`、`counts.files=10`、`+4010 / −0`、`riskCounts.normal=10`、`alerts=[]` | 暂存树里有 10 个待决条目 |
| `review.json.audit.summary` | `filesWrittenInWorkspace=1`、`filesWrittenOutside=22`、`filesRead=54` | WinStage 只把 **1 次**工作区内写入记进了自己的账（= `d7-pwsh.txt`） |
| `candidates[0].paths` | 9×`fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\…\__PSScriptPolicyTest_*` + `fs\…\ws\d7-pwsh.txt` + `shim.log` | 信噪比 9:1 |
| `sandbox-lane.json` | `launchMode=shim`、`tierEffective=TS`、`degraded=false`、`fallbackClass=none`、`shimCount=4`、`degradeCount=0`、**`winStageEnabled=false`** | **沙箱确实按 TS 档在跑**（命令面结论可判定）；同时"界面开关值是 false" |

⇒ **隔离结论（命令面）成立**：`pwsh` 的写入进暂存、批准前 0 命中真实盘。
⇒ **隔离结论（文件工具面）不成立**：一次平台提权就把 `write` 工具的落点从暂存面换成了真实盘，且界面不提示。

### 2.3 待审面板：本轮**没有出现**

`[实测]` 约 20 次跨 20 分钟的快照（`evidence/poll-*.txt`）里 **从未出现** `WinStage 暂存待审`、`批准所选`、`拒绝全部`、`候选` 等任一字符串；会话结束后 `06-panel.png` 显示的是普通对话流（没有面板、没有 chip）。

`[实测]` 但客户端插件**已加载**：
- `performance.getEntriesByType('resource')` 的插件包 URL 里含 `dsh-winstage-sandbox/client.js`（`evidence/session-log.txt` 的 `RESOURCES:` 行）；
- 页面存在 `data-winstage-composer-unhide="1"` 属性（`WIN_ATTRS`）。

`[读码/推断]` 面板的挂载条件与 `winstage-sandbox.config.enabled` 有关：本轮 profile 是 `enabled: false`，lane 快照也自报 `winStageEnabled: false`。R10 的两个宿主都是 `--patch` 把 `enabled` 钉成 `true`，面板正常出现。**所以本轮"面板不出现"极可能就是 `enabled:false` + 进程级 `WINSTAGE_SHELL=1` 这个组合的直接后果**——即：**命令面的暂存仍然生效，但用户拿不到审阅/批准的界面**。这条已升级为缺陷 `D7-b`（见 `usability-缺陷.md`），并建议 Lead 用一次 `--patch` 对照 run 复核（R10 已证 `enabled:true` 时面板会出现）。

⇒ 因此任务要求的"候选列表 / diff 可读性 / 批准所选 / 拒绝全部的可写集合语义"**本轮 `not-run`**（界面无按钮）。可用于替代的、**同样是实测**的旁证是：

`[实测]` 从原始数据看到的候选集可读性（**这不是用户看到的界面**，是 `review.json`/`staged\` 的原文）：

| 项 | 值 |
|---|---|
| 路径写法 | 内部键 `fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\<guid>\__PSScriptPolicyTest_xxx.psm1`，**不是**工作区相对路径 |
| 噪声占比 | 10 条里 **9 条**是 PowerShell AppLocker 探针文件，真正的"工作成果"只有 1 条 |
| 大块头 | `shim.log` **4,419,672 B / 4000 行**，占 `+4010` 里的 4000 ⇒ 仅看 `+n` 会以为是"用户改了 4000 行" |
| `pwd` 回显 | `…\stage-root\staged`（内部暂存路径**直接显示给用户**，与 R10 `D5` 同） |

---

## 3. 用例 B：设置页 `WinStage 沙箱` 行的开关

### 3.1 逐字文案（`[实测]`，`evidence/07-settings-text.txt` + `evidence/10-switch-state.json` 的 `rowHTML`）

```
WinStage 沙箱  已关闭
启用 Windows 暂存—候选—选择性提交沙箱。关闭后：**文件工具（写文件）立即退回**平台自带的沙箱/审批模式；**命令（pwsh）需要重启宿主后**才交还平台 shell（命令面的提供方在加载期选定，不能热切换）。不确定当前生效哪一侧时，跑 /winstage status 看权威结论。
默认收起：关
```
子开关 tooltip 逐字：`开启后只在页面加载后的第一版待审快照上默认收起；之后各轮的新快照按你的手势走（chip 可随时收起/展开）`
开关元素：`<button role="switch" aria-label="WinStage 沙箱" aria-checked="false">`，`disabled=false`、`pointer-events:auto`、`38×22`。

**结论（M3/M6 的核心误解）**：R10 判"差"的那一点——**界面一字不提"命令面要重启宿主"**——**本轮已修好并被实测确认**：描述里明确写了 `**命令（pwsh）需要重启宿主后**才交还平台 shell（命令面的提供方在加载期选定，不能热切换）`，还给了 `跑 /winstage status` 这个出路。这与 task-15 修复轮 `client.js:113` 的代码一致。

**但发现两条新问题（均 `[实测]`）**：
1. **界面状态与事实相反**：行显示 `已关闭`，而同一宿主内 `pwsh` 写入被证实进了暂存、lane `tierEffective=TS`。`WINSTAGE_SHELL=1` 这个进程级覆盖在界面上**完全不可见** ⇒ 用户读到的"已关闭"是错的。R10 的误导方向是"关闭态里命令面还在跑"，本轮同源，只是发生在"界面说关、实际在跑"的更直白形态。
2. **描述里的 `**…**` markdown 星号原样显示**（`rowHTML` 逐字可证）⇒ 描述字段没走 markdown 渲染。

### 3.2 翻转实测

`[实测]` 记录：

| 步骤 | 观测 |
|---|---|
| 点击前 | `aria-checked="false"`；行文案 `WinStage 沙箱 已关闭`；`gui-home\…\cordis.patch.yml` sha256 `C5C5E8F6…C9175`，1441 B，mtime `23:40:40` |
| 点击 `WinStage 沙箱` 开关 | 位于 `(962.4, 882)`，`click_at_xy` 命中 |
| 点击后（3 s） | `aria-checked` **仍是 `"false"`**；行文案 **不变**；全页 innerText **没有任何**错误/成功提示；profile 文件 sha256 / size / mtime **三项完全不变** |
| 结论 | **点击 = 无声 no-op**。比 R10 的"报 `写入失败，已保留原值`"更差：连"失败"都不说 |

`[实测]` **对照组**（证明写回通道本身可用、且只写隔离 home）：点击同一屏的无关开关 `显示代码工作视图`（`aria-checked` `true → false`）⇒ `gui-home\…\cordis.patch.yml` **1348 → 1441 B**、sha256 `7B33AB25…192BB → C5C5E8F6…C9175`、mtime `12:51:41 → 23:40:40`，末尾**追加**：

```yaml
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
```
而 `~/.dsh\profiles\web\cordis.patch.yml` **全程未变**（同 sha256）⇒ ① 隔离配方有效；② 任意开关都会**重写整个 profile patch 文件**（本轮是追加，未见 R10 描述的"引号风格被打平"）；③ **`WinStage 沙箱` 这一行自己写不进去**。

`[实测]` 本轮**没有**复现 R10 的 `D1b`（"报失败但文件已被改写"）：WinStage 开关这次**什么都没写、也什么都没说**。因此 `D1b` 在本轮的形态是**新的**：不是"说谎"，而是"装死"。

---

## 4. M1–M7 量化（沿用 R10 口径）

> 判据沿用 `docs/round10/gui/评分表.md` §0：`优 / 可 / 差 / not-run`；`差` 必须给出改进项编号。

| 指标 | 判定 | 实测值 / 依据 |
|---|---|---|
| **M1 到"能判定的隔离结论"的步骤数** | **差**（R10 = 可） | 判据 ≤5 优 / 6–8 可 / ≥9 差。本轮最小路径 = **7 个阶段 / 14 条命令**：① 建 `gui-home` 并复制 profile 5 个文件 ② 复制 `node_modules` 骨架 ③ `mklink /J` 重建 `dsh-winstage-sandbox` junction ④ 设 4 个环境变量（`DSH_HOME`/`WINSTAGE_SHELL`/`DSH_SESSION_ID=`/`WINSTAGE_STAGE_ROOT`）⑤ 起宿主 3091 并读 token ⑥ 另起独立 CDP 浏览器 + `BU_CDP_URL` ⑦ 新会话 + 发提示 + **再点一次平台提权对话框**。比 R10（9 条 / 5 阶段）**更长**，因为"独立 `DSH_HOME`"本身是额外必做项；而且**走完这条路仍拿不到 GUI 内的可判定结论**（§2.3 面板不出现、§2.2 文件工具绕过暂存）。可改进度 **1/5**（改进项 `I-11`/`I-12`）。 |
| **M2 必知概念数** | **差**（R10 = 可，6 个） | 判据 ≤3 优 / 4–6 可 / ≥7 差。R10 的 6 个本轮**全部仍然必要**（① `WINSTAGE_SHELL` 三态 ② profile `enabled:false` 的含义 ③ 行级 `disabled` 只在加载期求值 ④ 暂存根与 `WINSTAGE_STAGE_ROOT` ⑤ L1/L2/L3 与"批准所选 vs 批准全部" ⑥ 基线过期/rebase），**新增 3 个**：⑦ 独立 `DSH_HOME` 的 profile **必须自带** `node_modules` junction，否则插件悬空；⑧ `--profile web` 默认预设 `workspace-write + approval: ask` ⇒ 会先弹**平台**的提权对话框，"允许一次"是**平台**权限、不是 **WinStage** 待审，两者关系界面上没有一句话说清；⑨ `WINSTAGE_SHELL` 与设置页开关的优先级（界面说关、实际生效）。合计 **9 个**。没懂⑧的症状本轮**实际发生了**（多花 ~4 分钟并改变落点，§2.2）。可改进度 **1/5**（`I-12`/`I-18`）。 |
| **M3 开关语义是否易误解** | **可**（R10 = 差 → 修复轮判可；本轮与修复轮一致但有新缺口） | 好的一半（`[实测]`）：文案已写清"文件工具**立即**退回 / 命令（pwsh）**需要重启宿主**"+ 出路 `/winstage status`。差的一半（`[实测]`）：① 点开关**零反馈**（无成功态、无失败文案、无 aria 变化）；② 状态词 `已关闭` 与实测 `TS 档在跑` 相反；③ `**` 星号原样显示。可改进度 **3/5**（`I-13`/`I-14`/`I-15`）。 |
| **M4 报错可自救性** | **差**（R10 = 差） | 判据：三类失败都要有"原因 + 出路"。本轮 WinStage 侧**根本没有错误文案**（开关 no-op 不报、面板不出现不报）⇒ 不是"写得不好"，是"没有话"。反证：**平台侧**那条提权对话框写得很清楚（`允许本次操作使用 danger-full-access 权限：<原因>` + `[拒绝]/[允许一次]`）⇒ 说明有能力写清，缺的是把同一待遇给设置行与面板。可改进度 **1/5**（`I-13`）。 |
| **M5 候选 / diff 可读性** | **差**（R10 = 差 → 修复轮部分改善；本轮面板未渲染，只能从原始数据判读） | 见 §2.3 表：10 条候选里 **9 条**是 `__PSScriptPolicyTest_*` 探针；`shim.log` 4419672 B / 4000 行；路径是内部键 `fs\C\…`；`pwd` 回显 `…\stage-root\staged`。可改进度 **2/5**（`I-16`/`I-17`）。**注意**：本轮没能在界面上核验 R10 修复轮"噪声默认折叠"的离线自测结论，因为噪声源在 `review.json` 里依然存在。 |
| **M6 是否必须重启宿主** | **可**（R10 = 差 → 修复轮判可） | `[实测]` 设置行已**显式**写明两侧时延（本轮逐字见 §3.1）⇒ 满足"需要重启但界面明确写出 = 可"。但"能否通过 GUI 自行开关沙箱"仍是**不能**：本轮开关 no-op（§3.2），且没有"当前生效哪一侧"的运行期指示（`WINSTAGE_SHELL` 覆盖不可见）。可改进度 **3/5**（`I-14`）。 |
| **M7 是否有误导性文案** | **差**（R10 修复轮判优；本轮出现**新的**高严重度误导） | 证实 1 条（高）：`WinStage 沙箱已关闭` 出现在 `tierEffective=TS`、`pwsh` 写入确实进暂存的会话里 ⇒ 文案说 ¬A，宿主是 A。另 1 条（低）：描述里 `**…**` 未渲染。**未复现** R10 的头号误导（"写入会失败"那条本来就没出现，因为面板没渲染）。可改进度 **1/5**（`I-14`）。 |

### 4.1 与 R10 的差异归因（避免误读）

| R10（`--patch` + 共享 `profiles\web`） | 本轮（独立 `DSH_HOME`、无 `--patch`） |
|---|---|
| `enabled: true`（overlay 钉死） ⇒ **面板出现**、批准/拒绝路径可测 | `enabled: false`（profile 原值）+ `WINSTAGE_SHELL=1` ⇒ **命令面暂存生效但面板不出现** |
| 设置页报 `写入失败，已保留原值`，但文件已被序列化重写（`D1b`） | 设置页 `WinStage 沙箱` 开关**完全不写也不报**（`D7-c`）；无关开关**正常写回**隔离 home |
| 文件工具写入**进暂存**，批准前 0 命中 | 文件工具在**平台一次提权后绕过暂存**（`D7-a`，本轮新发现） |

⇒ 建议 Lead 后续按 R10 的 `--patch overlay`（`enabled:true`）再跑一次对照，以分离"`enabled:false` 导致面板消失"与"独立 `DSH_HOME` 导致面板消失"这两个假设（本轮证据支持前者）。

---

## 5. 可执行的改进项清单（含实现位置建议）

| 编号 | 现状证据 | 建议 | 实现位置建议 | 收益 | 成本 |
|---|---|---|---|---|---|
| **I-11** | 面板全轮不出现；`lane.winStageEnabled=false` 而 `tierEffective=TS`；`review.json pending=true/files=10` | `enabled:false` 但暂存面因进程级覆盖仍在工作时，会话内必须有**常驻 chip + 一句话**：`WinStage 暂存已开启但审阅面已关闭：命令写入会进暂存，无法在此批准/拒绝`（并给"如何打开审阅面/是否需要重启"）。**绝不静默** | `dsh-plugin/client.js` 面板挂载条件 + `dsh-plugin/host-plugin.mjs` 的 `winStageEnabled` 计算与快照 | 把"看起来没装"变成"看得见但可用性受限" | 小～中 |
| **I-12** | §2.2：`write` 工具在「允许一次（danger-full-access）」之后落真实盘，`manifest.json`/`staged\` 均无它；同一会话 `pwsh` 正常进暂存 | 一次性提权不得改变**暂存面归属**：提权应只放宽 DSH 自身的沙箱判定，WinStage 的 fs overlay 仍须拦截；若技术上做不到，**必须在授权对话框的正文里写明**"此授权会让文件工具绕过 WinStage 暂存" | `dsh-plugin/fs-entry.mjs`（provider 选择）+ 平台权限层交接点（**需 host 侧修**） | **消除最高危的隔离缺口** | 中～大 |
| **I-13** | §3.2：点开关 `aria-checked` 不变、无任何提示、文件 0 字节变化 | 点击后必须落到三态之一：`已生效` / `被进程级 WINSTAGE_SHELL 固定，改这里无效（去掉该环境变量并重启宿主）` / `写入失败：<code>` + 出路；不可生效时把开关置灰并给原因 | `dsh-plugin/client.js` 设置行 + `host-plugin.mjs` 设置写回响应 | 消除"死开关+装死" | 小 |
| **I-14** | §3.1：行显示 `已关闭`，实测 `TS` 在跑 | 状态词改为显示**实际生效档**（读 lane 快照 / `/winstage status` 同源），例如 `已关闭（进程级 WINSTAGE_SHELL=1 仍在生效）`；把"配置值"与"生效值"分列 | `client.js` 设置行状态来源改为服务端 lane 快照 | 消除 M7 级误导 | 小～中 |
| **I-15** | `rowHTML` 逐字：`**文件工具（写文件）立即退回**` 带原样星号 | 描述字段走 markdown 渲染，或去掉 `**` | `client.js` 描述字符串 | 观感/可读性 | 小 |
| **I-16** | `review.json`：9/10 条是 `__PSScriptPolicyTest_*`；`shim.log` 4000 行 / 4.4 MB | ① `__PSScriptPolicyTest_*` 一类探针默认折叠（或"只看工作成果"开关）；② 沙箱自身副作用日志（`shim.log`/`winstage-shim.config.json`）单独分区或默认移出候选 | `dsh-plugin/review-service.mjs` 候选分类 + `client.js` 分组 | 批准前可判断影响面 | 中 |
| **I-17** | 会话里 `pwd` 回显 `…\stage-root\staged`；候选路径用 `fs\C\…` 内部键 | 工具输出与面板路径一律映射为**工作区相对路径**；内部暂存键折叠进"详情" | `dsh-plugin/shell-executor.mjs` 输出后处理 + `client.js` 路径渲染 | 少泄漏内部布局 | 小～中 |
| **I-18** | §2.1：用户第一个遇到的是**平台**提权对话框，不是 WinStage 待审 | 面板/设置页各加一句关系说明：`本插件的"待审"在平台沙箱判定之后；平台弹的"允许一次"是平台权限，不等于批准 WinStage 候选` | `client.js` 面板头部 + 设置行 | 消除 M2 第⑧个必知概念 | 小 |

---

## 6. 未做 / 做不到（诚实清单）

| 项 | 状态 | 原因 |
|---|---|---|
| 待审面板的"候选列表 / diff 可读性 / **批准所选** / **拒绝全部** 的可写集合语义" | **not-run** | `[实测]` 面板全轮未渲染（§2.3），界面无按钮可点。已用 `staged\` vs 真实盘的存在性差异（§2.2）作为**命令面**暂存生效的等价实测证据；**批准/拒绝路径本轮无法实测**，需 `enabled:true` 的对照 run（建议 `--patch`，同 R10） |
| 降档/Defender 隔离后的可见性（R10 的 `D4`） | **not-run** | 本轮 lane `degraded=false`、`shimCount=4`、`degradeCount=0`，未构造 T1/降档；`shim\out\winstage-inject.exe` 未被隔离 |
| 设置页"写入失败"错误文案可自救性 | **not-run（未产生文案）** | 开关 no-op **不产生**任何错误文案；`写入失败，已保留原值` 一类的自检未触发 ⇒ 只能记"连话都没有"（§4 M4） |
| 独立 `DSH_HOME` 下客户端插件能否被宿主正确服务 | **可**（间接） | 插件包 URL 含 `dsh-winstage-sandbox/client.js`、页面有 `data-winstage-composer-unhide="1"` ⇒ **已加载**；但面板未挂载，故只到"已加载"这一层 |
| DSH 会话工作区根的确切路径 | **未决** | 递归检索一次误触发全仓扫描（经 `node_modules` junction），已中止；不影响 §2.2 的实测事实 |
| 首例 Edge 3 分钟自行退出 | **未定位** | `Start-Process` 起的实例退出；`cmd /c start` 分离启动后稳定。记为操作经验，不主张是产品缺陷 |

---

## 7. 收尾

| 动作 | 结果 |
|---|---|
| 停 3091 宿主 | pid 9620 → `Stop-Process -Force`；后台作业 `pwsh-782` 完成（exit 1 = 被杀） |
| 停自起浏览器 | 按 `usability\edge-profile` 匹配的 9 个 msedge 进程全部停止；`remaining = 0` |
| 端口终态 | `3091 → not listening`、`9223 → not listening`；**`3080 → LISTEN pid 8960`（node，用户 GUI，全程存活）**；`9222 → LISTEN pid 10340`（**别人的**，未触碰） |
| 共享 profile | `~/.dsh\profiles\web\cordis.patch.yml` sha256 前后同为 `7B33AB25…192BB`（未变）；`~/.dsh/**` 只读使用 |
| 真实工作区残留 | 本轮唯一落在真实盘的测试物 = `.t\r11\usability\ws\d7-fs.txt`（在**本域自己的目录内**，非仓库根、非产品路径）；**刻意保留**作为 `D7-a` 的证据物，Lead 可直接 `Get-FileHash` 复核（期望 `ABAE77AD…8266`）。其余测试文件均在 `stage-root` 暂存树内 |
| 证据位置 | `.t\r11\usability\evidence/**`（截图/逐字文本/宿主侧事实）、`.t\r11\usability/logs/**`（宿主 stdout 与每次 `browser-use` 调用日志）、`.t\r11\usability/scripts/**`（可复跑，**必须保持 ASCII**） |
