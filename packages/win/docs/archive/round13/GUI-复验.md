# R13 独立复验报告 · GUI 三项（D7-b / D7-c / D7-d）

> 角色：R13 **独立验证者**（只读产品代码，未改 `shim/**`、`src/**`、`dsh-plugin/**`）
> 时间窗：2026-10-11 09:32 – 09:53（+08:00，时间盒内）
> 隔离配方：独立 `DSH_HOME=.t\r13\gui\gui-home`（复制 `~/.dsh/profiles/web` 四文件 + `.credentials.yaml` + `node_modules` junction）
> 宿主：`node <npm>\@deepseek-ai\dsh\lib\bin.js --profile web --port 3091 --no-open`（`WINSTAGE_SHELL=1`、`DSH_SESSION_ID=`、`WINSTAGE_STAGE_ROOT=.t\r13\gui\stage-root`）
> 浏览器：独立 Edge `--remote-debugging-port=9223 --user-data-dir=.t\r13\gui\edge-profile` + `browser-use`（`BU_CDP_URL`）
> 标签：`[实测]` = 本轮真实读数（截图 / DOM / HTTP / 磁盘）；`[读码]` = 只读代码得出；`not-run` = 未做
> **两相复验**：Phase-1 = 宿主启动时 config `enabled:false`；Phase-2 = 经由设置页开关把 config 改成 `true` 后（宿主热读 patch），用于检验"配置开"路径。

---

## 0. TL;DR（先说结论）

| 缺陷 | R12 声称 | R13 判定 | 依据 |
|---|---|---|---|
| **D7-b** `enabled:false` + `WINSTAGE_SHELL=1` ⇒ 面板出现 | 两道闸门已修（路由改看生效值） | **refuted（目标配方下仍不出现）** | §2：`/winstage-panel/snapshot` 仍 **503 disabled**；根因是 `staging.effective` 恒 false |
| **D7-c** 开关无声 no-op ⇒ 有回执 + 出路 | 已加 `data-winstage-toggle-attempt` 与出路文案 | **confirmed（旧读数被推翻）** | §3：点击写入成功、回执 `accepted`、文件 1173/1348 B 两态可逆、逐字恢复 |
| **D7-d** 状态词与事实相反 ⇒ 配置值/生效值分列 | 已加 `staging` 段与 `data-winstage-staging-*` 锚点 | **confirmed（锚点与分列已生效）**，但**目标配方下仍看不出 shell 面接管** | §4：`effective=off` 锚点真实；Phase-2 面板立起；`enabled:false`+env=1 时仍 `unknown/forced=0` |
| D7-e（markdown 星号） | R12 明确"未修" | **未改善（与 R12 自述一致）** | §5 |
| D7-g（两层审批关系文案） | 未声称修 | **未见新文案** | §5 |

**最重要的一条**：R12 的修复前提（"进程级 `WINSTAGE_SHELL=1` 让宿主侧**暂存面**真的在跑"）**不成立**。
`WINSTAGE_SHELL` 只门控 `dsh-plugin/cordis.patch.yml` 里的 **shell / pwsh 行**，
`staging-fs.mjs::stagingEnabledRaw()` 只读 loader 行 `config.enabled`（§2.3 `[读码]`）。
因此"配置值 **或** 生效值"的判据里，生效值永远不可能越过配置值 ⇒ **D7-b 目标配方下修复不可达**。
但同配方下 **pwsh 面确实被接管**（写入进 `staged\`），这才是 R11 观测到"写入进暂存"的真实来源（§2.4）。

---

## 1. 装配与隔离台账

| 项 | 值 | 证据 |
|---|---|---|
| 独立 `DSH_HOME` | `.t\r13\gui\gui-home`（`profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml}` + `.credentials.yaml`） | `.t\r13\gui\launch-host.cmd` |
| `node_modules` | `.pnpm` / `@local` / `.modules.yaml` / `.pnpm-workspace-state-v1.json` 复制；`dsh-winstage-sandbox` 用 `cmd /c mklink /J` 指回仓库根 | 同上 |
| 宿主启动 | **`pwsh` 在本机不存在**（`$PSVersionTable` 为 Windows PowerShell 5.1，`C:\Program Files\PowerShell\7\pwsh.exe` 不存在）⇒ `dsh.ps1` 不可用；改用 `node <npm>\...\dsh\lib\bin.js` | `.t\r13\gui\logs\host.log` |
| 宿主 URL | `http://127.0.0.1:3091/?token=WKcGWUF9…`（Phase-1）/ `…token=Fe7gUMcX…`（Phase-2），token 只记前缀 | `.t\r13\gui\logs\host.log` |
| 浏览器 | Edge `Edg/155.0.4283.45`，CDP 9223（`/json/version` 实测）；`BU_CDP_URL=http://127.0.0.1:9223`、`BU_NAME=r13gui` | `.t\r13\gui\logs\bu-s01.txt` |
| 插件确实从孤立 home 加载 | 资源 URL 含 `…/plugins/??…,dsh-winstage-sandbox/client.js…&rev=69663258994d`；页面有 `data-winstage-composer-unhide="1"` | `.t\r13\gui\logs\bu-s02.txt` |
| 运行的代码 = 当前仓库 | 运行期出现 `data-winstage-toggle-attempt` / `data-winstage-staging-effective` / `data-winstage-staging-forced-note`（R12 新增锚点），宿主启动于 `dsh-plugin/client.js` mtime 03:17 之后 | `.t\r13\gui\logs\bu-s09-toggle2.txt` |

**截图口径（可复跑）**：`capture_screenshot()` 在本环境**仍 60 s 超时**
（`RuntimeError: Page.captureScreenshot timed out`，R12 同）；改用
`cdp("Page.captureScreenshot", format="png")` + `activate_tab(<3091 tab>)` **成功**：

* `logs/shot-settings-modal-phase2.png`（Phase-2 设置弹窗，WinStage 行在下沿）
* `logs/shot-settings-row-unknown.png`（**Phase-1** 设置页 WinStage 行 + 开关；`effective=off/forced=1` 那一版）
* `logs/shot-panel-phase1.png`（Phase-1 会话 `Create r13-d7b-probe.txt`；面板此刻已"暂时收起"，故画面里只有对话流）
* `logs/shot-settings-phase2.png` / `shot-settings-phase2b.png`（`fromSurface=False` 时抓到的是空白前台标签，**不作为证据**，仅留证）

---

## 2. D7-b · `enabled:false` + `WINSTAGE_SHELL=1` ⇒ 面板是否出现

### 2.1 `[实测]` 路由仍 503（Phase-1 与 Phase-2 各测一次）

```
Phase-1（宿主启动时 profile enabled:false；读次数 5 次，跨约 3 分钟）
GET /winstage-panel/snapshot?session=session-530b728f-…  → 503
{"ok":false,"code":"disabled","route":"/winstage-panel/snapshot"}
原始读数：.t\r13\gui\logs\snapshot-direct.txt

Phase-2（把 patch 恢复 enabled:false 后重启宿主，新建会话用 pwsh 写文件后再测）
GET /winstage-panel/snapshot?session=…  → 503 ；?session=nonexistent → 503
原始读数：.t\r13\gui\logs\snapshot-phase2.txt
```

### 2.2 `[实测]` 面板不出现（两相）

| 相 | 会话动作 | `data-winstage-panel` | 面板文案 | 证据 |
|---|---|---|---|---|
| Phase-1（config=false） | agent 用 **write** 写 `r13-d7b-probe.txt` | 始终**不存在** | `暂存待审`/`批准所选`/`拒绝全部` 全不出现 | `.t\r13\gui\logs\bu-s13-prompt.txt` |
| Phase-2（config=false 重启后） | agent 用 **pwsh** 写 `r13-d7b-pwsh.txt` | 始终**不存在**（T+3…T+42 s 共 14 拍） | 同上 | `.t\r13\gui\logs\bu-s17-phase2.txt` |
| 对照 Phase-2b（config=**true**） | agent 用 write 写同名文件 | **出现** `data-winstage-panel="1"` | `WinStage 暂存待审`、`1 个文件`、`+1 / −0`、`批准全部`、`拒绝全部` | `.t\r13\gui\logs\panel-decoded.txt`、`shot-panel-phase1.png` |

Phase-2b 的原始 DOM（可复制界面文本）：

```
WinStage 暂存待审 · 1 个文件（L2 1） · 等待你批准后才写入真实工作区 · +1 / −0
读取来源：宿主路由（存储根由宿主解析）        ← data-winstage-store-source="host-route"
L2 工作区外 (1) 新增工作区外 …\default-workspace\r13-d7b-probe.txt
全选 · 清空选择 · 暂时收起 · 拒绝全部 · 批准全部
```

同时磁盘侧（`stage-root`）：

```
review.json: pending=true, counts.files=1, additions=1,
             staging={effective:true, configValue:true, source:"config",
                      shellOverride:{value:"1",forced:true}, mismatch:null}
candidates/cs_0001_737543d8.json → changes[0].after.hash=174abae7…  bytes=9
blobs/17/174abae7…  ← 候选内容在暂存里
真实盘 …\default-workspace\r13-d7b-probe.txt → ABSENT
```

⇒ **面板链路本身（路由 → 快照 → 候选渲染 → 批准/拒绝按钮）在新码下是通的**，
但**只在 `staging.effective===true` 时通**；而 `effective` 的来源是
`stagingEnabledRaw()`（只读 `config.enabled`）。

### 2.3 `[读码]` 为什么目标配方下修复不可达

| 事实 | 位置 |
|---|---|
| 路由闸门："配置值 **或** 已发布快照 `staging.effective===true`" | `dsh-plugin/host-plugin.mjs:856-867` |
| `staging.effective` 的生产来源 = `staging-fs` 注入的 `get effectiveStaging(){ return {enabled: self.stagingEnabled()} }` | `dsh-plugin/staging-fs.mjs:842-851` |
| `stagingEnabled()` → `stagingEnabledRaw()`：**只看 loader 行 `row.config.enabled !== false`**；读不到才默认 true | `dsh-plugin/staging-fs.mjs:870-900` |
| `WINSTAGE_SHELL` 只被 `dsh-plugin/cordis.patch.yml:122,155` 的 `!!js` 门控读取（`winstage-shell` / `pwsh-sandbox` 行）；`fs-entry.mjs`、`src/**` 里**没有任何** `WINSTAGE_SHELL` 引用 | `grep WINSTAGE_SHELL`（§1 证据） |

⇒ `config.enabled=false` 时 `stagingEnabledRaw()` 返回 false ⇒ `effective=false`
⇒ 路由"或"分支**不可能**为真 ⇒ 503。**客户端 `winstageElection()` 的同款"或"判据同样不可达**
（`client.js:549-578`）。R12 §2.3 的注入点确实接上了，但它接的是**同一个只读配置值的真源**，
所以"生效值越过配置值"这一语义**在 fs 面从未实现**。

### 2.4 `[实测]` 但 shell/pwsh 面**确实**在接管（R11 观测的真实来源）

Phase-2（`enabled:false` + `WINSTAGE_SHELL=1`）里 agent 执行
`Set-Content -Path r13-d7b-pwsh.txt -Value PWshProbe` 后：

```
.t\r13\gui\stage-root\staged\r13-d7b-pwsh.txt            9 B     ← 文件在"暂存区"
真实盘 \.t\r13\gui\stage-root 之外：repo 根 / default-workspace 均无 r13-d7b-pwsh.txt
.t\r13\gui\stage-root\staged\shim.log                     56,232,079 B
.t\r13\gui\stage-root\registry\overlay.hive(.LOG1/2)      存在
.t\r13\gui\stage-root\review.json                         **不存在**（fs 审阅面没跑）
```

⇒ shell 行被 `WINSTAGE_SHELL=1` 强制接管（与 `cordis.patch.yml` 注释"`=1` ⇒ 强制 WinStage 接管（诊断用，可越过'开关关'）"一致），
写入进了 shim 的暂存树；**但这是 fs 暂存面之外的第二个机制**，不产生 candidate、不发布 `review.json`。
R12 把 R11 的"写入进暂存"读成"fs 暂存面在跑"，**两者不同源**。

### 2.5 判定

**D7-b：`refuted`**（就"R12 声称的修复让该配方下面板出现"而言）。
子结论 `[实测]`：新码在 **config.enabled=true** 时面板/路由/候选/按钮全部正常（§2.2），
所以这是**可达性缺陷**，不是渲染缺陷。

---

## 3. D7-c · 开关点击：无声 no-op 是否已修

### 3.1 `[实测]` 逐次点击的完整读数（新码）

| 步 | `aria-checked` | `data-winstage-toggle-attempt` | 隔离 patch 文件 | 证据 |
|---|---|---|---|---|
| 起始 | `false` | 不存在 | `7B33AB25…192BB` / 1348 B / mtime 2026-10-10T12:51:41 | `log bu-s07-row-before.txt` |
| 第 1 次点击（坐标 866,894） | **仍 `false`** | **仍不存在** | **未变** | `log bu-s08-toggle.txt` |
| 第 2 次点击（JS `sw.click()`） | `false → true` | **`accepted`** | `6391F94C…78F0` / **1173 B** / mtime 09:39:39（`enabled:false` 整段被移除） | `log bu-s09-toggle2.txt` |
| 第 3 次点击（关回） | `true → false` | **`accepted`** | `9093D611…F929` → 再次复制后 **`7B33AB25…192BB` / 1348 B**（逐字还原） | `log bu-s11-toggleoff.txt` |

行内回执文案（Phase-2，`row-decoded.json`）：

```
本次开关已写入（生效时机见上面的说明）。      ← data-winstage-toggle-attempt="accepted"
```

### 3.2 `[实测]` 关于"第 1 次点击落空"的定案（重要）

第 1 次点击前，开关的 `getBoundingClientRect()` 给出 **y=894**，而视口高度只有 **706**
（`vh=706`）⇒ 该坐标在视口外，但 `elementFromPoint` 不在视口内不成立，
R11/R12 的录像坐标正是 **866,894**（`docs/archive/round131/usability-缺陷.md` D7-c 表）。
⇒ **"无声 no-op"的最可能成因是自动化点击落点错误（off-viewport），不是产品缺陷**。
本报告不据此宣称"R11 观测有误"，但明确：**本轮在新码上无法复现 handler 层面的 no-op**。
（`[读码]`：`WinStageRow` 的 onClick 只会 `accepted/rejected/threw:<原文>` 三态之一，不存在"静默"分支 ——
`client.js:3130-3144`；Phase-1 里出现的 `accepted` 与文件写入互相印证。）

### 3.3 判定

**D7-c：`confirmed`** —— 点击有可见回执、文件真的被改写、失败态有出路文案
（`forcedHint`：`WINSTAGE_SHELL=0` 重启宿主 / 改 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` / 跑 `/winstage status`）。
**R12 §3.1 的旧码读数（`aria-checked` 不变 + 零提示）本轮未复现**，成因见 §3.2。

---

## 4. D7-d · 界面显示"配置值"还是"实际生效值"

### 4.1 `[实测]` 锚点存在且读数真实（Phase-1：config=true + env=1）

```
data-winstage-staging-effective="off"
data-winstage-staging-forced="1"
data-winstage-staging-forced-note="1"
aria-checked="false"
attrLineText="已关闭 · 当前由环境变量强制： 平台面 · WINSTAGE_SHELL=1（强制 WinStage 接管）"
（原始：logs/row-decoded.json；截图 logs/shot-settings-row-unknown.png）
```

### 4.2 `[实测]` 目标配方（`enabled:false` + env=1）下**仍看不出接管**（Phase-2）

```
data-winstage-staging-effective="unknown"
data-winstage-staging-forced="0"
attrLineText=""      （生效值行整行为空）
forcedNote=null      attempt=null
（原始：logs/row-phase2.decoded.json；截图 logs/shot-settings-modal-phase2.png）
```

界面逐字（Phase-2，config=false，env=1，同一宿主里 pwsh 面**确实在接管**）：

```
WinStage 沙箱 已关闭
启用 Windows 暂存—候选—选择性提交沙箱。关闭后：**文件工具（写文件）立即退回**平台自带的沙箱/审批模式；
**命令（pwsh）需要重启宿主后**才交还平台 shell（命令面的提供方在加载期选定，不能热切换）。
不确定当前生效哪一侧时，跑 /winstage status 看权威结论。
默认收起：关
```

⇒ 读到的 `effective=unknown` 是**诚实**的（fs 审阅面拿不到），
但用户**依然看不出"命令面此刻由 WinStage 接管"**（事实：`stage-root\staged\r13-d7b-pwsh.txt` 存在、真实盘无）。
这与 R11 D7-d 是**同一形态的残余**：界面缺一个"shell 面生效值"的权威；
`staging.effective` 只覆盖 fs 面，且在 **503 路径下拿不到 `staging` 段**（`readReview` 走路由失败 + legacy 回退读不到 ⇒ 行内落回 `unknown/0`）。

### 4.3 `[读码]` + `[实测]` 一处**自相矛盾**的新文案（Phase-1）

`effectiveText` 的构造（`client.js:3026-3031`）用了 `liveOverride`（进程有 `WINSTAGE_SHELL`）
+ `liveEffective`（fs 面生效值）拼接：

```
已关闭 · 当前由环境变量强制： 平台面 · WINSTAGE_SHELL=1（强制 WinStage 接管）
                     ↑ t('effectiveOff')      ↑ 强制文本
```

"强制：**平台面**"与"**强制 WinStage 接管**"在同一行互相否定。
`[读码]` 成因：`shellOverride.text` 是"环境变量说了什么"，而 `effective` 是"fs 面实际怎样"，
两者被拼成一句；在 fs 面被关、shell 面被强制的组合下必然自相矛盾。
这是 R11 D7-d（界面与事实相反）**换了一个成因的同类形态**。

### 4.4 判定

**D7-d：`confirmed`（分列与锚点已落地、`effective` 读数真实）**，
但附一条 **`refuted`**：R12 §3.4 的验收期望②"行内同时出现'已关闭'与'当前由环境变量强制：WinStage 接管中'"
在**本配方**下**未出现**（Phase-1 出现的是自相矛盾的"平台面"版本；Phase-2 该行整行为空）。

---

## 5. D7-e / D7-g（顺带）

| 缺陷 | R13 判定 | 原始读数 |
|---|---|---|
| D7-e（描述里的 `**` 原样显示） | **未改善** | 截图 `logs/shot-settings-row-unknown.png` 可见 `关闭后：**文件工具（写文件）立即退回**平台自带…**命令（pwsh）需要重启宿主后**才交还平台 shell`；文本见 `row-decoded.json` 的 `rowText` |
| D7-g（两层审批关系文案） | **未见新文案** | 本轮设置行/面板/可信性卡里没有任何"平台审批 vs WinStage 审批"的交叉说明；面板只写"等待你批准后才写入真实工作区"，平台侧只有 `data-winstage-permission="1"` 锚点 |

---

## 6. 收尾台账

| 项 | 结果 | 证据 |
|---|---|---|
| 3091 宿主停止 | `LISTEN 3091` 无；node pid 2200 / cmd wrapper 已停 | `Get-NetTCPConnection` 读数：仅剩 3080 |
| 9223 浏览器停止 | 12 个 `--user-data-dir=…r13\gui\edge-profile` 进程全部停止，剩余 0 | 同上 |
| **3080 仍存活** | `LISTEN 3080 → pid 8960`（全程未动） | 同上 |
| 未触碰的用户浏览器 | 另 14 个 msedge（`--user-data-dir=…AppData\Local\Microsoft\Edge\User Data` 及其子进程）**未动** | `Get-CimInstance` 读数 |
| `~/.dsh` 基线完整性 | `cordis.patch.yml 7B33AB25…192BB`、`package.json 17C5FA91…7D6CE`、`settings.yaml.imported EA6BFBB7…647C7` **与 R13 要求逐字一致** | 见 §6 命令输出 |
| 活凭据副本 | `.t\r13\gui\gui-home\.credentials.yaml` 已删除；删除前 `sha256=DBA8A7BC4C002B79B0AA4AEFCF9021C009D72DA05233E92FC5ADC7256352DBED`、223 B | `logs/credentials-copy.sha256.txt` |
| 真实盘残留 | repo 根与 `default-workspace` 均**无** `r13-d7b*` 文件；`stage-root*` 里的 `staged\r13-d7b-pwsh.txt` 与候选 blob 刻意保留为证据 | §2.2 / §2.4 |
| 产品代码 | **未修改**（`dsh-plugin/**` mtime 仍是 03:17/03:19；本轮只写 `.t\r13\gui/**` 与本文） | `Get-Item` 读数 |

---

## 7. 证据索引

| 内容 | 路径 |
|---|---|
| 宿主 stdout | `.t\r13\gui\logs\host.log`、`host-phase1.log` |
| 路由 503（Phase-1 / Phase-2） | `logs/snapshot-direct.txt`、`logs/snapshot-phase2.txt` |
| 路由 200 + 快照（config=true） | `logs/snapshot-after-enable.txt` |
| 面板 DOM / 可复制文本 | `logs/panel-decoded.txt`、`logs/panel-utf8.hex` |
| 设置行读数（Phase-1） | `logs/row-decoded.json`、`logs/bu-s07-row-before.txt`、`logs/bu-s09-toggle2.txt`、`logs/bu-s11-toggleoff.txt` |
| 设置行读数（Phase-2，目标配方） | `logs/row-phase2.decoded.json`、`logs/bu-s18-row2.txt` |
| 面板不出现（Phase-1 / Phase-2，逐拍） | `logs/bu-s13-prompt.txt`、`logs/bu-s17-phase2.txt` |
| 候选 / 暂存证据 | `stage-root/review.json`、`stage-root/candidates/cs_0001_737543d8.json`、`stage-root/blobs/17/174abae7…`、`stage-root/staged/r13-d7b-pwsh.txt` |
| 截图 | `logs/shot-settings-row-unknown.png`（Phase-1 行）、`logs/shot-settings-modal-phase2.png`（Phase-2 设置弹窗）、`logs/shot-panel-phase1.png`（Phase-1 会话，面板已收起） |
| 脚本（可复跑，纯 ASCII + `\uXXXX`） | `.t\r13\gui\scripts\*.py`、`*.mjs` |

---

## 8. 诚实边界 / 未做到

1. **`not-run`：未测 `enabled:true` 且 `WINSTAGE_SHELL=1` 时"点击开关关掉 config 后面板是否立刻消失"的时序**；也未测批准/拒绝按钮的**写盘**效果（只验到候选渲染与按钮存在）。
2. **`not-run`：未用 `/winstage status` 交叉核对**（会消耗另一轮 GUI 交互）；所有"生效值"结论仅基于 `review.json.staging`、`/winstage-panel/*` 与磁盘事实。
3. **`[读码]` 部分**（§2.3、§4.3）未做运行时注入验证（例如强行把 `staging.effective` 置 true 观察闸门）；它只声明代码路径与数据来源。
4. **截图仍依赖 `cdp("Page.captureScreenshot")` + `activate_tab`**；`capture_screenshot()` 在本机 60 s 超时（与 R12 同），因此首批设置页 DOM 证据为文本而非图像（后补了截图）。
5. **Phase-1 的 `data-winstage-staging-effective="off"` 与 Phase-2 的 `"unknown"` 不同**：Phase-2 宿主是新进程、没有成功的 200 快照可读 ⇒ 行内落回 unknown。这是**同一份代码的两种状态**，不是代码差异。
6. 本轮**未**就"是否应把 `WINSTAGE_SHELL` 纳入 `stagingEnabledRaw()` 的判据"或"是否应新增 shell 面生效值字段"给实现建议 —— 那属于 Lead/写者的产品决策，我只交事实。
