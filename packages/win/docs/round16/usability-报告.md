# R16 域七（D7）报告：操作设计易用性 —— browser-use 驱动 GUI 实测 + CLI 全链路 + headless 对照

> 任务：`task-7`（域7 owner = teammate `usability`）。实测窗口：2026-10-11 17:46 – 18:26；**18:28–18:35 按 Lead 裁定改写 U16-1 口径并补 §8.1**（+08:00）。
> 交付：本文件 + `docs/round16/usability-缺陷.md` + 原始证据 `.t\r16\usability/**`（`shots/` 11 张截图、`logs/` 逐字文本与轮询 JSONL、`scripts/` 可复跑脚本、`stage-root-a|b/` 宿主侧原始数据、`cli/` CLI 原始输出、`run-sbx/` headless 抽取物）。
> 铁律遵守：**未改产品代码**（`src/**`、`dsh-plugin/**`、`tests/**`、`tools/**` 只读）；**未改 `%DSH_HOME%\profiles\web\**`**（前后 sha256 逐字相同，§1.3）；**未杀 3080 宿主**（全程 `3080 → pid 9144` LISTEN）；本会话**未加载沙箱**；只写 `.t\r16\usability/**` 与 `docs/round16/usability-*.md`。
> 标签：`[实测]` = 本轮真实读数（截图 / DOM / HTTP / 磁盘 / 原始输出）；`[读码/推断]` = 只读代码或由读数推断；`not-run` = 未做。
> 上一轮同域基线：`docs/archive/round11/usability-报告.md`、`docs/archive/round11/usability-缺陷.md`、`docs/archive/round12/plugin-GUI-修复.md`、`docs/archive/round13/GUI-复验.md`。

---

## 0. TL;DR（本轮最重要的四条）

1. **`[实测]` 文档配方（`WINSTAGE_SHELL=1` + profile `enabled:false`）下，GUI 里没有审阅面板，但宿主侧已经有一个 pending 候选**：
   `review.json` = `pending=true / files=7 / candidateId=cs_0003_88856528 / source="shell"`，`/winstage-panel/snapshot` = **503 disabled**，
   8 拍 × 15 s 的 DOM 快照里 `[data-winstage-panel]` **始终不存在**。同一 run 里 `write` 工具写的 `gui-a-fs.txt`
   **直接落在真实盘**（8 B，sha256 `2AC4CD97…6127`），对话里只显示"已编辑 gui-a-fs.txt"。
   ⇒ R11 `D7-b`（拿到暂存却没有批准权）**复现**，并首次拿到"候选确实已发布、只是面板按闸门不显示"的宿主侧证据 → **U16-1（P1）**。
   **口径（Lead 18:2x 裁定）**：混合态是 `host-plugin.mjs:808/:865-875` **明写的既定语义**（`WINSTAGE_SHELL` 只管命令面），
   缺陷在"该语义没有配套的可见性/失败保护"；本轮**不改 `stagingEnabledRaw()`**，两条候选修法记在 `usability-缺陷.md` U16-1 与本文 §8.1。
2. **`[实测]` 面板的"批准全部"无视工作区内行的勾选**：只勾了 `gui-b-one.txt` 一个 checkbox，点"批准全部"后 **两个文件都写进真实盘**；
   面板里 **没有"批准所选"按钮**。工作区内行却渲染了 per-file checkbox（`aria-label=<路径>`）⇒ 任务要求的"选择路径 → apply"在
   工作区内改动上不可达，且勾选是误导性可供性 → **U16-2（P1）**。
3. **`[实测]` 健康会话里面板报红**：Phase B（`enabled:true`，纯文件写入）面板可信性卡片逐字为
   `可信性：⚠ 沙箱档位信息不完整…`、`档位 ? · 掉档 0 次 · 失根 81 次…`、`判据：宿主 level=lost · tierEffective=? · degraded=no`，
   DOM 锚点 `data-winstage-trust="lost"`；而同 run 的 `sandbox-lane.json` **整体没有 `tierEffective` 字段**（只有 `kind` + `history.rootLoss{count:104,lastReason:"marker-missing",lastPhase:"status"}`）。
   ⇒ "档位不可见"在 R16 的形态是"面板拿不到档位 → 报红灯"，**不是**给出可判定的档位值 → **U16-3（P1）**。
4. **`[实测]` headless(sbx) 面反而更可判定**：同一个仓库、同一天跑 `sbx-thread.cmd`，四条判据全绿
   （`stderr.txt` 0 B、暂存树 40 件含 `candidates\cs_0004_be65ef25.json`、真实工作区只剩 `seed.txt`、**`lane.txt LANE_OK=true` / `tierEffective=TS`**），
   且**文件工具与命令产出都进暂存**；GUI 面在文档配方下文件工具**不进暂存**、档位**不可见**。⇒ "GUI 两张脸 + 档位不进面板"是本轮最突出的可用性缺口。

---

## 1. 装配与隔离台账

### 1.1 两次 GUI 宿主（顺序执行，**全程只有 3080 + 一个 3091**，未同时开两个以上）

| 项 | Phase A（**文档配方**） | Phase B（**受控开面板**） |
|---|---|---|
| `DSH_HOME` | `C:\Users\Administrator\.dsh`（共享，**只读使用**） | 同上（**未复制凭据**） |
| profile 层 | `profiles\web` 原样（`winstage-sandbox.enabled=false`） | 同上 + **`--patch` 叠加**（见下） |
| 进程级注入 | `WINSTAGE_SHELL=1`、`WINSTAGE_STAGE_ROOT=<REPO>\.t\r16\usability\stage-root-a`、`DSH_SESSION_ID=`（清空） | 同上，`…stage-root-b` |
| 命令 | `cmd /c "set DSH_HOME=…&& set WINSTAGE_SHELL=1&& set WINSTAGE_STAGE_ROOT=…&& set DSH_SESSION_ID=&& dsh web --port 3091 --no-open"`（**逐字按任务给的配方**，仅补 `WINSTAGE_STAGE_ROOT`） | `dsh web --patch .t\r16\usability\scripts\overlay-enable.yml --port 3091 --no-open` |
| 宿主 pid / URL | 2936 / `http://127.0.0.1:3091/?token=XUoa…`（只记前缀）→ `logs/host-3091-a.log` | 9480 / `?token=-vC7…` → `logs/host-3091-b.log` |
| 证据 | `stage-root-a/**`、`shots/a0*.png`、`logs/bu-a*.txt` | `stage-root-b/**`、`shots/b1*.png`、`logs/bu-b*.txt` |

> **为什么补 `WINSTAGE_STAGE_ROOT`**：不钉根时 `resolveStageRoot()` 会落到 `%LOCALAPPDATA%\Temp\winstage-stage\dsh-host`
> ——那正是 **3080 宿主**的暂存根（协议 §0.5 明令不得触碰；R10 §5.1 记录过第二个宿主在此 fail-closed）。这是**为了遵守硬约束而必须加的**一项，
> 也是配方文档本身缺的一项（见 §7 诚实边界）。
> **为什么 Phase B 用 `--patch` 而不是独立的 `DSH_HOME`**：本轮硬约束禁止改共享 profile，而设置页写回会重写
> `%DSH_HOME%\profiles\web\cordis.patch.yml`；`--patch` 是启动参数、不落任何 profile 文件，且 `--dump-config` 已实测有效
> （`logs/b00-dump-config.txt`：`# == dsh-winstage-sandbox, patched by …\profiles\web\cordis.patch.yml, …\scripts\overlay-enable.yml`
> → `enabled: true`）。代价：**设置页开关的"点击"测试本轮 not-run**（点击会写共享 profile）。

### 1.2 独立浏览器（CDP 9223，**未触碰用户浏览器**）

| 项 | 值 |
|---|---|
| 浏览器 | Edge `Edg/155.0.4283.45`，`--remote-debugging-port=9223 --user-data-dir=<REPO>\.t\r16\usability\edge-profile`，`cmd /c start` 分离启动 |
| 连接 | `BU_CDP_URL=http://127.0.0.1:9223` + `BU_NAME=r16gui` + `browser-use.exe < script.py`（脚本纯 ASCII，中文一律 `\uXXXX`） |
| 收尾 | 按 `CommandLine -like '*usability\edge-profile*'` 精确匹配停止 **11** 个进程；`remaining = 0`；**用户的 13 个 Edge 进程全程未动**（前后各 13） |

### 1.3 隔离性硬证据

| 文件 / 资源 | 测试前 | 全部测试后 | 结论 |
|---|---|---|---|
| `~/.dsh\profiles\web\cordis.patch.yml`（**共享，绝对不可变**） | `7B33AB252BC3FC69CB870DC8E0F46E3BB2870220343145ED23234C371EB192BB`，1348 B | **同 sha256 / 1348 B** | 共享 profile **零污染** |
| `~/.dsh\profiles\web\package.json` | `17C5FA91881093D76793BACBC7900A4BD385E817E5F4A976C420B6BB60E7D6CE`，528 B | **同 sha256** | 同上 |
| `3080`（本线程 GUI） | LISTEN pid 9144 | **LISTEN pid 9144**；`GET /` → 401（token 门禁，服务存活） | 全程未动 |
| `3091` / `9223` / `8737` | 均未监听 | **均 not listening** | 收尾干净 |
| 凭据副本 | — | **未产生**（本轮不做独立 `DSH_HOME`，没有复制 `.credentials.yaml`） | 无敏感副本需清理 |

> 补充读数：`%LOCALAPPDATA%\Temp\winstage-stage\dsh-host`（3080 的暂存根）`manifest.json` mtime 仍是 **2026-10-09 21:40:01**（本轮未写入）；
> 本轮唯一"未钉根"的两条 CLI 调用解析到的是按 `DSH_SESSION_ID` 派生的另一个 store
> ——`%LOCALAPPDATA%\Temp\winstage-stage\4e380002-57b9-4e9a-b1ff-ff69f6a70f17`（`manifest.workspaceRoot=…\cli\ws`、`revision=0`、会话 `c2bdc405…`，即 §5.4 那次误读的落点），**没有**落到 `dsh-host`；
> 该临时 store 已按 Lead 指示留档后删除（见 §8.1 附注、§9）。

---

## 2. GUI 用例 A：文档配方（`enabled:false` + `WINSTAGE_SHELL=1`）

**发的原文**（逐字，纯 ASCII，`scripts/s05_send.py`）：

```
do not ask questions, do not explain, be brief. Do exactly two things:
1) use the write-file tool to create .t/r16/usability/ws/gui-a-fs.txt with content D16-A-FS
2) use the pwsh tool to run: Set-Content -Path '.t\r16\usability\ws\gui-a-pwsh.txt' -Value 'D16-A-PWSH'
Then reply with one line per item stating whether the file exists.
```

**操作路径与点击数**：选工作区（`选择工作区` → 菜单项 `dsh-winstage-sandbox` = **2 次点击**）→ 输入提示（0 次）→ 点发送（**1 次**）= **3 次点击**。会话用时 1 分 3 秒（`shots/a04-mid.png`）。

### 2.1 界面读数

| 观测 | 读数 | 证据 |
|---|---|---|
| 面板 / 常驻 chip | **始终不存在**（8 拍，`panel=False chip=False`；DOM 上只有 `data-winstage-composer-unhide="1"`） | `logs/a06-polls.jsonl`、`logs/bu-a06-poll.txt` |
| 会话结果 | `1. .t/r16/usability/ws/gui-a-fs.txt — exists (True).` / `2. .t/r16/usability/ws/gui-a-pwsh.txt — does not exist (pwsh ran with cwd .t\r16\usability\stage-root-a\staged, so the relative path failed; exit code 1).` | `shots/a04-mid.png` |
| 工具卡片 | `已编辑 gui-a-fs.txt` + `+1 / −0`（**没有任何"未经过 WinStage 审批"提示**） | 同上 |
| 设置行（只读，未点击） | 见 §2.3 | `logs/bu-a07-settings.txt` |
| 路由 | `GET /winstage-panel/snapshot` → **503** `{"ok":false,"code":"disabled",…,"staging":{"effective":false,"configValue":false,"source":"staging-fs","shellOverride":{"value":"1","forced":true,…},"faces":{"file":"off","shell":"win-stage","shellForcedByEnv":true}}}` | `logs/a09-snapshot-route.txt` |

### 2.2 宿主侧读数（同一 run，未受限侧）

| 事实 | 值 |
|---|---|
| `write` 工具产物 | **真实盘存在**：`ws\gui-a-fs.txt`，8 B，`D16-A-FS`，sha256 `2AC4CD97A5080C3BC8152BC34839B875A165184A168B4EC7701F4F1B36EA6127` |
| `manifest.json` 是否含 `gui-a-fs.txt` | **否**；`review.json` 候选（7 条）里也**没有**它 |
| 候选（`cs_0003_88856528`，`source="shell"`） | 6 × `fs\C\…\__PSScriptPolicyTest_*.ps1/psm1`（各 60 B）+ `shim.log`（**3,819,848 B / 4000 行**） ⇒ 信噪比 **6:0**（用户成果为 0 条） |
| `review.json` | `pending=true`、`counts.files=7`、`additions=4006`、`staging.effective=false`、`audit.summary.filesWrittenInWorkspace=1`、`filesWrittenOutside=17` |
| `sandbox-lane.json` | `launchMode=shim / tierEffective=TS / degraded=false / fallbackClass=none / winStageEnabled=false / history{commandSeq:3, shimCount:3}` |
| 命令面落点 | 命令在**暂存 cwd**（`.t\r16\usability\stage-root-a\staged`）里执行；相对路径写入因父目录不存在而失败（`audit` 仍记到 `…\staged\.t\r16\usability\ws\gui-a-pwsh.txt` 的写意图） |

⇒ **两个面不同源**：命令面被 `WINSTAGE_SHELL=1` 强制接管并**产生了 pending 候选**；文件面（`write` 工具）按 `config.enabled=false` **退回平台面**、
在工作区内被静默允许写真实盘；而**审阅面板的闸门只看文件面**（`configValue:false`）⇒ 候选存在但用户看不见、批不了 → **U16-1**。

### 2.3 设置行逐字（Phase A，`logs/bu-a07-settings.txt`）

```
WinStage 沙箱 已关闭
启用 Windows 暂存—候选—选择性提交沙箱。关闭后：**文件工具（写文件）立即退回**平台自带的沙箱/审批模式；**命令（pwsh）需要重启宿主后**才交还平台 shell（命令面的提供方在加载期选定，不能热切换）。不确定当前生效哪一侧时，跑 /winstage status 看权威结论。
已关闭 · 文件面（暂存/候选）：已关闭 · 命令面（pwsh）：由 WINSTAGE_SHELL=1 强制接管
进程级环境变量 WINSTAGE_SHELL 的优先级高于本行开关，因此这一行的开关此刻不改变实际生效档。要看权威结论请跑 /winstage status；要真正交还平台，请用 WINSTAGE_SHELL=0 重启宿主。
默认收起：关
```

- DOM 锚点：`data-winstage-staging-effective="off"`、`data-winstage-staging-forced="1"`、`data-winstage-staging-forced-note="1"`（`logs/bu-a08-rowattrs.txt`）。
- **与 R11 的差异（改善）**：R11 的行内状态词只有 `已关闭`、与事实相反（`D7-d`）；本轮**两面分列**且写明进程级覆盖与出路 ⇒ `M3/M6` 由"差"升到"可"。
- **开关位置**：`button[aria-label="WinStage 沙箱"]` 的 rect 中心 **y=929**，而视口 `innerHeight=706` ⇒ 在视口之下（`scrollIntoView` 后 y=428）。R13 §3.2 把 R11 的"无声 no-op"归因于"自动化点击落在视口外"——本轮读数**与该归因一致**。

---

## 3. GUI 用例 B：`enabled:true`（`--patch` 叠加）+ 审阅 → 选择 → apply

**发的原文**（`scripts/s13_send_b2.py`、`s14_send_poll.py`）：

```
do not ask questions, do not explain, be brief. Do exactly two things:
1) use the write-file tool to create .t/r16/usability/ws/gui-b-one.txt with content D16-B-ONE
2) use the write-file tool to create .t/r16/usability/ws/gui-b-two.txt with content D16-B-TWO
Then reply with one line per file stating the absolute path you wrote.
```

### 3.1 面板出现，且路径可读性明显优于 R11

```
WinStage 暂存待审 · 2 个文件（L1 2） · 等待你批准后才写入真实工作区 · 2 个文件 · +2 / −0
C:\Users\Administrator\Desktop\dsh-winstage-sandbox
可信性：⚠ 沙箱档位信息不完整（面板拿到的卡片里没有档位字段）：**暂存写入此刻可用**（待审候选正常生成）；是否已降档无法据此判定，请跑 /winstage status 看权威结论。
档位 ? · 掉档 0 次 · 失根 81 次 · 未结算审批 0 · 未确认写入 0 · 敏感读 0 · 判据：宿主 level=lost · tierEffective=? · degraded=no · 卡来源=scoped(n/a) ·（"失根 81"是探测计数，不是写入失败次数，且每次查询都会 +1；本条不影响写入）
读取来源：宿主路由（存储根由宿主解析）
L1  工作区内 (2)
  新增 .t\r16\usability\ws\gui-b-one.txt   +1 / −0
  新增 .t\r16\usability\ws\gui-b-two.txt   +1 / −0
全选 · 清空选择 · 暂时收起 · 拒绝全部 · 批准全部
「批准全部」= 全部工作区内的普通项 + 你已勾选的工作区外/敏感项；未勾选的高风险项不会被写入。
```

- 证据：`logs/bu-b15-panel.txt`、`shots/b10-panel.png`、`logs/bu-b14-sendpoll.txt`（`data-winstage-panel="1"`、`data-winstage-trust="lost"`、`data-winstage-store-source="host-route"`）。
- **路径写法是工作区相对路径**（`新增` 标签 + `+1 / −0`），**不再是** R11 的内部键 `fs\C\…` ⇒ `M5` 的"路径可读性"一半**已改善**（仅当面板能渲染时）。
- composer 左侧出现 `W WinStage 暂存` 芯片（title 逐字：`WinStage 沙箱：文件写入先落暂存、批准后才写真实工作区（已替代平台的访问模式选择器）`，`data-winstage-permission="1"`）⇒ R11 `D7-g` **部分改善**（没有直说"平台审批 ≠ WinStage 审批"）。

### 3.2 选择性 apply 实测（**本轮最重要的交互发现**）

| 步 | 读数 | 证据 |
|---|---|---|
| 点击前 | `[{one:false},{two:false}]` | `logs/bu-b16-approve.txt` |
| 人点 `gui-b-one.txt` 的 checkbox | `[{one:true},{two:false}]`（**1 次点击**，非 JS 触发） | 同上 |
| 点"批准全部"（**1 次点击**） | 面板消失；**真实盘两个文件都在**：`gui-b-one.txt` 9 B `D16-B-ONE`（sha256 `89AE5FBC…`）、`gui-b-two.txt` 9 B `D16-B-TWO`（`6B3F875D…`） | `ws/`、`shots/b11-after-approve.png` |
| 候选终态 | `queue.json`：`cs_0002_d37e9d4a { status: "applied", at: 10:18:51 }`；`review.json` `pending=false / files=0` | `stage-root-b/queue.json`、`stage-root-b/review.json` |
| "批准所选"按钮 | **不存在**（行内只有 全选 / 清空选择 / 暂时收起 / 拒绝全部 / 批准全部） | `logs/bu-b15-panel.txt` |

⇒ 勾选**被忽略**（对工作区内普通项），且没有任何"批准所选"⇒ **U16-2**。

### 3.3 点击次数与必知概念（量化）

| 指标 | Phase A（文档配方） | Phase B（`enabled:true`） |
|---|---|---|
| GUI 点击数（到"能看见/批准候选"） | 3（选工作区 2 + 发送 1）→ **看不到候选** | 5（选工作区 2 + 发送 1 + 勾选 1 + 批准全部 1）；若工作区已预选，最小 **2 次**（发送 + 批准全部） |
| 到"能判定的隔离结论" | GUI **不可判定**（无面板、无档位）⇒ 必须去宿主侧读 `review.json`/`sandbox-lane.json` | 面板给出待审清单与落盘结果，但**档位仍不可判定**（卡片报 `?`/`lost`）⇒ 仍需 `/winstage status` 或读 lane |
| 必须理解的新概念 | 1) 暂存/候选 2) 文件面 vs 命令面 3) `WINSTAGE_SHELL` 优先级 4) 为什么"已编辑"却无审批 5) 为什么设置说关而命令面在跑 | 1) 候选 2) L1 工作区内 / L2 工作区外 3) 批准全部 vs 拒绝全部 4) checkbox 语义（**误导**）5) 可信性卡片 6) 档位/降档/失根 7) 读取来源=宿主路由 8) 两面 9) `WINSTAGE_SHELL` 10) 平台审批 vs WinStage 审批 11) apply 后落盘 |

---

## 4. M1–M7 量化（沿用 `docs/archive/round10/gui/评分表.md` §0 口径：优/可/差；"差"必须给改进项）

| 指标 | R16 判定 | 实测值 / 依据 | 与 R11 对照 |
|---|---|---|---|
| **M1 到"能判定的隔离结论"的步骤数** | **差**（R11=差） | 判据 ≤5 优 / 6–8 可 / ≥9 差。最小可判定路径 = **≥9 步**：起独立宿主（带 `WINSTAGE_STAGE_ROOT`，否则撞 3080 的 `dsh-host`）→ 取 token → 起独立 Edge + CDP → 选工作区 → 发提示 → **发现没有面板** → 去宿主侧读 `review.json` → 读 `sandbox-lane.json` → 结论；且 Phase B 还要额外造 `--patch` 才能看到面板。改进项 **U16-1 / U16-3** | 与 R11 同为"差"；R10 的功能面（面板）在本轮 Phase B 可见，但**默认配方**仍不可判定 |
| **M2 必知概念数** | **差**（R11=差，9 个） | ≥7 即差。本轮 Phase B 一个会话就需要 **11** 个（§3.3），其中"checkbox 语义"是**错误知识**（勾了不算）、"档位"是**无法从 GUI 得到**的 | 未改善 |
| **M3 开关语义是否易误解** | **可**（R11=可） | 好的一半 `[实测]`：两面分列 + 出路（`/winstage status`、`WINSTAGE_SHELL=0` 重启）；差的一半：`**` 未渲染、点击未测（not-run）、开关在视口外需滚动 | R11 的新缺口（`**`）**仍在**；"状态词与事实相反"在**分列**后不再成立 |
| **M4 报错可自救性** | **差**（R11=差） | GUI Phase A：**没有任何**错误/警告文案（静默丢审阅权）；Phase B：可信性卡片给了出路，但报的是**红灯**且未给可点入口；CLI：3/9 错误路径可行动（`USAGE:`/`HTTP 401`/`unknown suite id(s)+allowed`），2 条是原始堆栈（U16-6），1 条静默误读（U16-7）。改进项 **U16-1 / U16-3 / U16-6 / U16-7** | 有改善（宿主/设置行文案），但 GUI 默认配方下"连话都没有"这条**复现** |
| **M5 候选 / diff 可读性** | **可（仅面板可见时）/ 差（默认配方）** | Phase B 面板：工作区相对路径 + `新增` + `+1/−0`，逐文件行；Phase A（无面板）：原始数据仍 `fs\C\…` 内部键 + **6/7 条 AppLocker 探针** + `shim.log` **3.82 MB / 4000 行**（`additions=4006` 里 4000 行是它）。改进项 **U16-1** | R11 "差"；本轮面板侧明显改善，默认侧**原样** |
| **M6 是否必须重启宿主** | **可**（R11=可） | 文案显式写明"命令面要重启宿主才交还平台"+"行级 `disabled` 只在加载期求值"，并给 `WINSTAGE_SHELL=0` 出路 | 与 R11 一致 |
| **M7 是否有误导性文案** | **差**（R11=差） | ① 面板可信性**红灯**（`level=lost / 档位 ?`）出现在暂存与候选都正常的会话里（U16-3）；② 工作区内 checkbox 的**行为与可供性不符**（U16-2）；③ `**` 原样显示（U16-9）；④ Phase A 的"已编辑"卡片不提"该写入未经 WinStage 审批"（U16-1） | R11 的头号误导（"写入会失败"）本轮未出现；换成了上面四条 |

---

## 5. CLI 面实测（`run.cmd src\cli.mjs` 全链路 + `testservice.cmd`/`src\testclient.mjs`）

所有 CLI 命令都**钉住** `WINSTAGE_STAGE_ROOT=.t\r16\usability\cli\stage-root`，workspace = `.t\r16\usability\cli\ws`（种子 `seed.txt`），脚本 `scripts\cli-chain.cmd` / `cli-probes.cmd` / `cli-select.cmd`。

### 5.1 文档链路全绿（8 条命令，exit 0）

| 步 | 命令 | 退出 | 关键读数（证据 `cli/1*.json|txt`） |
|---|---|---|---|
| 1 | `init --json` | 0 | `tier=T0/appcontainer`、`instanceChecks` 3 项全 pass、`storeDir=…\cli\stage-root` |
| 2 | `exec --json -- cmd /c "echo D16-CLI>d16-cli.txt"` | 0 | `exitCode=0`、`tier=T1`、`launchMode=restricted-token`、`enforcement=partial`、`capturedChanges=1`、`candidate.frozen=true id=cs_0001_3c4ea3db` |
| 3 | `status --json` | 0 | `revision`、`stagedEntries`、`pendingFiles` 一致 |
| 4 | `review --json` | 0 | `[{id:cs_0001_3c4ea3db,status:pending,files:1,changes:[create d16-cli.txt]}]` |
| 5 | `diff` | 0 | `候选 cs_0001_3c4ea3db [pending] — before/after 均冻结在候选内` + `+ D16-CLI` |
| 6 | `apply` | 0 | `候选 cs_0001_3c4ea3db → 状态 applied / 已应用 1 项，失败 0 项` |
| 7 | 真实盘 | — | `ws\d16-cli.txt` 9 B（`D16-CLI`）**已落盘**；`seed.txt` 未变 |
| 8 | `review`（after） | 0 | `待审队列为空…`（已结案） |

**选择性 apply（CLI 面可达）**：`exec` 造 2 个文件 → `apply --paths "sel-a.txt"` ⇒ `status: partially-applied`、`applied=[sel-a.txt]`、`remaining=[sel-b.txt]`、`requeued=true`；真实盘只有 `sel-a.txt`（`cli/30–35`）。
⇒ **CLI 支持路径级选择，GUI 面板不支持（U16-2）**，两面能力不一致。

### 5.2 `audit`（exit 1，但文案可行动）

`audit --json` = `{sandboxUsable:true, coverage:55, verdict:"fail", summary:{pass:13,fail:3,residual:13,informational:2,"not-run":25}}`；
3 条 fail 均为**读取面无法归因**（`read-sam-hive` / `read-system-hive` / `read-security-evtx`：对象存在但内容读不出，探针按纪律记 fail）。
文本模式末行逐字：`覆盖度: 55%  判定: fail` / `结论: 存在 fail 项，按手册第 17 章要求不得作为版本出口。` ⇒ 这是**可行动**的文案（与 U16-6 的堆栈形成对照），但 exit 1 会让"沙箱不可用"和"审计有不可归因项"在 CI 里无法区分。

### 5.3 `--help` 覆盖度（U16-5）

| 命令 | exit | 输出长度 |
|---|---|---|
| `cli.mjs`（无参）/ `cli.mjs --help` | **2** / **2** | 447 B（同一份 usage） |
| `cli.mjs apply --help` | 0 | **447 B，与全局 usage 逐字相同** |
| `cli.mjs frobnicate` | 2 | `未知命令: frobnicate` + usage |

usage 里只出现 `--workspace/--json/--session`；**未记录**但代码支持的：`--candidate`、`--paths`、`--force`、`--max-lines`、`--timeout`、`--tier`、`--read-only`、`--no-cache`、`--use-cache`、`--reason`。

### 5.4 CLI 错误信息质量（U16-6 / U16-7）

| 输入 | exit | 文案质量 |
|---|---|---|
| `exec`（无命令） | 1 | `USAGE: exec 需要命令，例如: exec -- pwsh -c "ni a.txt"` ✅ 可行动 |
| `discard`（无 `--candidate`） | 1 | `USAGE: discard 需要 --candidate <id>` ✅ |
| `apply --candidate cs_9999_deadbeef` | 1 | `未捕获错误: SandboxError: candidate … does not exist` + **7 行堆栈** ❌ |
| `diff --candidate cs_9999_deadbeef` | 1 | 同上（`src/cli.mjs:302`）❌ |
| `status --workspace <不存在的目录>` | **0** | 正常输出 + 回显不存在的工作区，**实际打印的是钉住 store 的数据**（`revision=3 / stagedEntries=1`）❌ 静默误读 |

> **自证**：本轮我先按"两条独立 pwsh 调用"跑链路，第二条忘了带 `WINSTAGE_STAGE_ROOT`，于是 `review` 打印"待审队列为空"——
> 而 `exec` 明明冻结了候选。这是 U16-7 的**真实代价**（`cli/01–05` 那组读数即该误读的原始记录）。

### 5.5 CLI exec 的档位可见性（U16-8）

JSON 有 `tier=T1 / tierRequested=T1 / tierEffective=T1 / launchMode=restricted-token / enforcement=partial`；
**文本模式只打印** `退出码=0 分类=ok 用时=63ms` + `沙箱内提取到 1 项变化…` ⇒ 文本用户看不到档位。对照插件/GUI 面同日的 lane = `TS / shim`。

### 5.6 `testservice.cmd` + `src\testclient.mjs`（health / run / jobs 三态全通）

| 项 | 读数 | 证据 |
|---|---|---|
| `GET /health`（**免 token**） | 200 + JSON（`running/queueDepth/jobs/uptimeMs/suites` 34 个 suite 全列） | `cli/40-health.json` |
| `GET /jobs`（无 token） | **401** + `unauthorized: pass "Authorization: Bearer <token>"` ✅ 可行动 | 终端输出 |
| `GET /jobs`（token） | 200 `{count:0,jobs:[]}`；跑完 2 个 job 后 `count:2` | `cli/45-jobs-after.json` |
| 同步 `--only selftest` | exit 0，`job_0001_b8f025 status=done`、`selftest PASS 51 ok / 0 bad` | `cli/41-client-sync.json` |
| 异步 `--async` → `--watch` → `--log` | 202 `job_0002_2e958a status=queued` → `watch` exit 0 `overall=PASS 51 ok` → `log` 打印同一报告 + "仍未提供的保证"5 条 | `cli/42–44` |
| 错 token | exit **2** + `HTTP 401: {"error":"unauthorized: pass \"Authorization: Bearer <token>\""}` ✅ | `cli/46-badtoken.txt` |
| 不存在的 suite | exit **2** + `HTTP 400: {"error":"unknown suite id(s): nosuchsuite","allowed":[…34 个…]}` ✅ | `cli/47-badsuite.txt` |

⇒ **测试服务面（testservice/testclient）的错误信息质量明显优于沙箱 CLI**（有 status code + 原因 + 允许集合 + 稳定退出码）。
收尾：8737 已关闭（`job_kill` + `Get-NetTCPConnection` 复核）。

---

## 6. GUI 面 vs headless(sbx) 面（任务第 5 项）

**headless run**：`docs\archive\round10\env\scripts\sbx-thread.cmd .t\r16\usability\ws-sbx .t\r16\usability\scripts\prompt-sbx.txt .t\r16\usability\run-sbx winstage`
⇒ `[sbx-extract] session=session-64b963fa-995e-4d33-82fc-fddd1ddbc438 stage_files=40 stage_bytes=15367515 ws_files=1 lane_ok=true`，`exit=0`。

**四条判据（协议 §1.1）全绿**：

| # | 判据 | 读数 | 证据 |
|---|---|---|---|
| 1 | loader 无告警 | `stderr.txt` = **0 B** | `run-sbx\stderr.txt` |
| 2 | 暂存面在工作 | 40 件含 `candidates\cs_0004_be65ef25.json`；`staged\r16-usability-sbx.txt` 10 B、`staged\r16-usability-sbx-pwsh.txt` 14 B | `run-sbx\stage-root-inventory.txt` |
| 3 | 真实工作区零污染 | `workspace-inventory.txt` **只有 `seed.txt`（4 B）** | `run-sbx\workspace-inventory.txt` |
| 4 | lane 真是 TS | `tierEffective=TS / degraded=false / launchMode=shim / shimCount=3` + `LANE_OK=true` | `run-sbx\lane.txt` |

**逐面对照（同日、同仓库、同机）**

| 维度 | GUI（文档配方 `enabled:false` + env=1，§2） | GUI（`--patch` `enabled:true`，§3） | headless sbx（`sbx-thread.cmd`） |
|---|---|---|---|
| 文件工具写入 | **真实盘**（不进候选） | **暂存 → 候选 → 批准后落盘** | **暂存 → 候选**（批准面不存在，headless 永不提交） |
| 命令写入 | 暂存（进候选，`source=shell`） | 暂存（进候选） | 暂存（进候选） |
| 审阅/批准界面 | **无**（路由 503 disabled） | 面板可用（但选择性 apply 不可用） | 无（headless 无应答者；候选留在 `candidates\`） |
| 档位可见性 | GUI **完全没有**；宿主 lane 有 `TS` 但界面不显示 | 面板显示 `档位 ? / level=lost`（**不是值**） | **一等公民**：`lane.txt` `LANE_OK=true` + `tierEffective=TS` |
| 结论可判定性 | 界面不可判定；需读宿主文件 | 落盘结果可判定；档位不可判定 | 四条判据 + `lane.txt` **机器可判**（脚本直接打印 `lane_ok=`） |
| 内部路径泄漏 | 会话里出现 `…\stage-root-a\staged`（agent 自报 cwd） | 面板路径已是工作区相对路径 | `(Get-Location).Path` 回显 `…\run-sbx\stage-root-…\staged`（R10 D3 / R11 I-17 **复现**） |
| 候选信噪比 | 原始数据 6/7 探针 + `shim.log` 3.82 MB | 面板只显示用户产物（2 条） | 候选 9 条 = 6 探针 + `shim.log` + 2 条用户产物 |

⇒ **结论**：**档位可见性与"能判定的结论"在 headless 面已经是一等公民，在 GUI 面反而是最弱的一环**（U16-3）；
而 **fs 面写入是否进暂存**在 GUI 面取决于"哪个开关生效"，在 headless 面是稳定的。

---

## 7. 证据索引

| 内容 | 路径 |
|---|---|
| GUI 截图（11 张） | `.t\r16\usability\shots\a01-landing.png`、`a02-wsmenu.png`、`a04-mid.png`、`a05-settings.png`、`a06-settings-row.png`、`b01-poll.png`、`b01-sent.png`、`b08-poll.png`、`b10-panel.png`、`b11-after-approve.png`、`b12-settings-on.png` |
| 宿主启动/URL/token | `.t\r16\usability\logs\host-3091-a.log`、`host-3091-b.log` |
| 面板不出现（Phase A，逐拍） | `.t\r16\usability\logs\a06-polls.jsonl`、`bu-a06-poll.txt` |
| 面板出现 + 可信性红灯（Phase B，逐拍） | `.t\r16\usability\logs\b14-polls.jsonl`、`bu-b14-sendpoll.txt` |
| 面板 DOM/逐字文本/按钮矩形 | `.t\r16\usability\logs\bu-b15-panel.txt`、`shots\b10-panel.png` |
| 选择性 apply 逐次读数 | `.t\r16\usability\logs\bu-b16-approve.txt`、`shots\b11-after-approve.png` |
| 设置行（A/B 两态） | `.t\r16\usability\logs\bu-a07-settings.txt`、`bu-a08-rowattrs.txt`、`bu-b17-settings.txt`、`bu-b18-rowfull.txt` |
| 路由 503 + faces | `.t\r16\usability\logs\a09-snapshot-route.txt` |
| `--patch` 组合自检 | `.t\r16\usability\logs\b00-dump-config.txt` |
| 宿主侧原始数据（A/B） | `.t\r16\usability\stage-root-a\{review.json,candidates\cs_0003_88856528.json,manifest.json,queue.json,sandbox-lane.json}`、`…stage-root-b\{review.json,queue.json,manifest.json,sandbox-lane.json}` |
| 真实工作区产物 | `.t\r16\usability\ws\{gui-a-fs.txt,gui-b-one.txt,gui-b-two.txt}` |
| CLI 全链路/错误/选择 | `.t\r16\usability\cli\10–17-*`、`20–29-*`、`30–36-*` |
| testservice/testclient | `.t\r16\usability\cli\40–47-*`、`logs\testservice.log`（`--quiet`，0 B） |
| headless sbx run | `.t\r16\usability\run-sbx\{session-id.txt,lane.txt,stderr.txt,stage-root-inventory.txt,workspace-inventory.txt,stdout.ndjson}` |
| 可复跑脚本（纯 ASCII） | `.t\r16\usability\scripts\{s01…s18_*.py, cli-*.cmd, overlay-enable.yml, prompt-sbx.txt}` |

---

## 8. 诚实边界 / 未做到（`not-run`）

| 项 | 状态 | 原因 |
|---|---|---|
| **设置页开关的"点击"测试**（R11 `D7-c` 是否仍 no-op） | **not-run** | 本轮硬约束禁止改 `%DSH_HOME%\profiles\web\**`，而该开关的写回目标就是它；用 `--patch` 起的宿主点它仍会写共享 profile。只取了**只读**读数（`aria-checked`、`data-winstage-staging-effective=on/off`、`forced=1`）。R12/R13 已实测 accepted + 回执 |
| **工作区外/敏感项的勾选语义**（真正的选择性 apply 分支） | **not-run** | 需要把文件写到真实写作用域（`.t\r16\usability/**`）之外才能触发 L2/敏感；本轮写作用域被限定，故只测了工作区内项（结论只覆盖 L1） |
| **"拒绝全部"/"暂时收起"的落盘效果** | **not-run** | 时间盒；面板按钮存在且带 title，但未点 |
| **R11 `D7-a`（平台一次提权后 `write` 绕过暂存）** | **not-run** | 同上：需要写到会话工作区之外的桌面路径才会弹平台提权对话框 |
| 降档/Defender 隔离后的界面可见性 | **not-run** | 本轮 lane `degraded=false`、`shimCount=3`、`degradeCount=0`，未构造降档；面板的 `level=lost` 是"没拿到档位"，**不等于**实测降档 |
| `/winstage status` 命令面在 GUI 的可用性 | **not-run** | 面板/设置行都把它当出路，但本轮未在 composer 里执行该命令 |
| 配方文档缺 `WINSTAGE_STAGE_ROOT` | 记为**流程/文档问题**（报告 §1.1）。未贴根会撞 3080 的 `dsh-host`；本轮为了不违反硬约束而自行补上。建议 Lead 把该项写进配方（协议的 §1 已有，任务给的命令没有） | — |
| `capture_screenshot()` 60 s 超时 | **未复现/未使用** | 全程用 `cdp("Page.captureScreenshot")`：11 张里 1 次 5 s 超时，重试后成功 |

### 8.1【Lead 裁定】U16-1 按"既定语义 + 产品决策"收口（本轮不实施）

Lead 2026-10-11 读码裁定（原文要点，逐字引其结论）：**"`WINSTAGE_SHELL` 只管命令面、不去翻 fs 面的配置值"是项目里已经明写的既定语义**
（`dsh-plugin/host-plugin.mjs:808` "本次修复不改语义"；`:867-870` 明确说 R12 曾误以为 `=1` 能让 fs 面也在跑，那个前提不成立）。
本轮补充的行号核对（只读取证，未改码）：

| 位置 | 逐字要点 |
|---|---|
| `dsh-plugin/host-plugin.mjs:799-843`（`panelStagingFaces()`） | 只把两条事实分别报出来：`faces.file`（fs 面）、`faces.shell`（命令面）+ `shellForcedByEnv` |
| `dsh-plugin/host-plugin.mjs:808` | "本次修复**不改语义**（`WINSTAGE_SHELL` 仍然只管命令面、不去翻 fs 面的配置值）" |
| `dsh-plugin/host-plugin.mjs:852-853` | "关闭态返回 `503 disabled`：面板在关闭时本来就不该看到任何暂存内容" |
| `dsh-plugin/host-plugin.mjs:865-875` | R12 的"读快照 `staging.effective` 就放行"分支**不可达**（`stagingEnabledRaw()` 只读 loader 行 `config.enabled`；全仓只有 shell 行读 `WINSTAGE_SHELL`）⇒ 闸门**保持只看配置值** |
| `dsh-plugin/review-service.mjs:96-106`（`shellEnvOverride()`） | 把 `WINSTAGE_SHELL` 定义成"是否强制了 shell/fs 半边"的**进程级三态**（`'1'` 强制接管 / `'0'` 强制交还 / 其它=未设） |

⇒ **U16-1 的口径 = 既定语义 + 安全缺口**（不是"漏改一处门控"）：混合态下 fs 面写入直落真实盘、GUI 无任何提示、面板也不出现，
即"既定语义"没有配套的**可见性 / 失败保护**。**Lead 明确本轮不改 `stagingEnabledRaw()`**（改它会推翻既定语义，并可能打破
`tests/dsh2-select-shell-verify.mjs`、`tests/assembly-toggle-selftest.mjs` 的断言）。
两条候选修法（择一，**本轮不实施**，属产品决策点）：**(a)** 把 `WINSTAGE_SHELL` 提升为**双面强制**（改 `stagingEnabledRaw()` + 同步 `cordis.patch.yml` 两行门控表达式，需重跑 select-shell / assembly-toggle 两套件）；
**(b)** 保持单面语义，但**混合态必须响亮** —— 宿主启动 `warn` + GUI 常驻横幅/红标"文件面未接管：写入直落真实盘"，并让面板可用（只读审阅亦可）。
本报告与 `usability-缺陷.md` U16-1 已按此口径改写，其余读数与证据不变。

> 附：离场清理（Lead 指示）——我自己的未钉根临时 store
> `%LOCALAPPDATA%\Temp\winstage-stage\4e380002-57b9-4e9a-b1ff-ff69f6a70f17`
> 已先留档（`.t\r16\usability\logs\c-tempstore-4e380002.txt`：inventory 4 文件 / 839 B、`manifest.sessionId=c2bdc405…`、
> `workspaceRoot=…\.t\r16\usability\cli\ws`、`revision=0`、`.winstage-owner.json` 的 keeperPid=3380/parentPid=11144 **均已退出**），
> 再用 `cmd /c rmdir /s /q`（**未**用 `-Recurse`，按 R10 §6 避免误删 junction）删除：**`exists=false`**；
> 同时复核 `…\winstage-stage\dsh-host`（3080 的暂存根）**未被触碰**（`exists=true`，mtime 2026-10-11 17:24:23）。

---

## 9. 收尾台账

| 动作 | 结果 | 证据 |
|---|---|---|
| 停 3091（Phase A / B 宿主） | pid 2936 / 9480 → 停止；`Get-NetTCPConnection -State Listen` 中 **无 3091** | `Get-NetTCPConnection` 读数 |
| 停 testservice | `job_kill` + 8737 无监听 | 同上 |
| 停自起浏览器 | 按 `usability\edge-profile` 匹配的 **11** 个 msedge 全部停止；`remaining = 0`、9223 无监听 | `Get-CimInstance Win32_Process` 读数 |
| **3080 仍存活** | `LISTEN 3080 → pid 9144`；`GET /` → **401**（token 门禁 ⇒ 服务在跑）；`/health` 在本宿主 **404**（U16-4） | `Get-NetTCPConnection` + `Invoke-WebRequest` |
| 用户浏览器 | 13 个 msedge（默认 `User Data`）全程未动（前后各 13） | `Get-CimInstance` |
| 共享 profile | `cordis.patch.yml` `7B33AB25…192BB`、`package.json` `17C5FA91…7D6CE`，与基线逐字相同 | `Get-FileHash` |
| 敏感材料 | **未产生任何凭据副本**（未建独立 `DSH_HOME`）；`.t\r16\usability/**` 扫描无 credential/token 文件（唯一命中 `cli\46-badtoken.txt` 是"错误 token 的报错输出"） | 见 §1.3 / 缺陷附表 |
| 真实工作区残留 | 本轮落在真实盘的产品外测试物**全部在 `.t\r16\usability\ws\`**（`gui-a-fs.txt` / `gui-b-one.txt` / `gui-b-two.txt`）与 `cli\ws\`（`d16-cli.txt` / `sel-a.txt` / `seed.txt`），首轮证据物保留；`no-such-ws` 目录不存在（U16-7 的输入） | §2.2 / §3.2 / §5.1 |
| **临时 store 清理**（Lead 指示） | `%LOCALAPPDATA%\Temp\winstage-stage\4e380002-57b9-4e9a-b1ff-ff69f6a70f17`：先留档 → `cmd /c rmdir /s /q` → **`exists=false`**；`dsh-host` **未触碰**（`exists=true`） | `.t\r16\usability\logs\c-tempstore-4e380002.txt`、§8.1 附注 |
| 产品代码 | **本域未修改** | 本轮我只写 `.t\r16\usability/**` 与两份 `docs\round16\usability-*.md`。`git status` 里唯一的源码改动 `dsh-plugin/cordis.patch.yml`（mtime **18:21:14**，R16 的 `networkTier` 死键修正）**经 Lead 确认是 Lead 本人所做**（另有 `%DSH_HOME%\profiles\sbx\cordis.patch.yml`），与本域无关 |
