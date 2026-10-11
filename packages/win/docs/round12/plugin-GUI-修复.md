# R12 修复报告 · GUI（D7-b / D7-c / D7-d）

> 执行者：R12 teammate（`dsh-plugin/**` 与 `src/**` 写者）
> 隔离宿主配方：独立 `DSH_HOME` = `.t\r12\plugin-gui\gui-home`；`WINSTAGE_SHELL=1`；
> `dsh --profile web --port 3091 --no-open`；Edge CDP **9223** + `BU_CDP_URL`；`3080` 全程未动
> 结论标签：`[实测]` = 本轮真实读数；`[读码]` = 只读代码/契约得出的结论

---

## 0. TL;DR（**最重要的一条先说**）

> **本轮 GUI 实测跑的是"宿主启动时加载的那份旧代码"。**
> 3091 宿主在我修改 `dsh-plugin/client.js` / `host-plugin.mjs` **之前**启动，
> 且该 profile 没有插件热重载（`--profile web` 无 HMR 重建），
> 因此会话中途的修改**没有进入那个进程**（服务端 `host-plugin.mjs` 同样如此）。
> ⇒ 下面 `[实测]` 的读数**只对旧代码有效**；`[读码]` 部分给出修复后的预期行为与
> **可复跑的验收步骤**。**我不把旧代码的读数当成"修复失败"，也不把新代码当"已验过"。**

| 缺陷 | 本轮状态 | 依据 |
|---|---|---|
| **D7-b** `enabled:false` + `WINSTAGE_SHELL=1` ⇒ 面板不出现 | **根因已定死（两道闸门）**，代码已修，**GUI 未验新码** | §2 |
| **D7-c** 开关点击无声 no-op | **实测复现（旧码）**：`aria-checked` 不变、零提示；代码已加"结果回执 + 出路"，**GUI 未验新码** | §3 |
| **D7-d** 状态词与事实相反 | **实测复现（旧码）**：行内仍只有 `已关闭`，`data-winstage-staging-effective=unknown`；代码已加"配置值/生效值分列"，**GUI 未验新码** | §3 |
| D7-e 描述里的 `**` 原样显示 | **未修**（不在本轮任务四条内，本轮未动该字段） | — |

---

## 1. 装配与隔离台账

| 项 | 值 |
|---|---|
| 独立 `DSH_HOME` | `C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r12\plugin-gui\gui-home` |
| profile 内容 | 从 `~/.dsh\profiles\web` 复制 `cordis.yml` / `cordis.patch.yml`（1348 B，含 `winstage-sandbox: enabled:false`）/ `package.json` / `pnpm-workspace.yaml` / `pnpm-lock.yaml`；`node_modules\{.pnpm\lock.yaml,.modules.yaml,.pnpm-workspace-state-v1.json,@local}`；`node_modules\dsh-winstage-sandbox` 用 `mklink /J` 指回仓库根 |
| 环境变量 | `WINSTAGE_SHELL=1`、`DSH_SESSION_ID=`（清空）、`WINSTAGE_STAGE_ROOT=.t\r12\plugin-gui\stage-root` |
| 宿主命令 | `dsh --profile web --port 3091 --no-open`（cwd = 仓库根，无 `--patch`） |
| 宿主 stdout | `dsh web: http://127.0.0.1:3091/?token=00tr4Mwh…XwM` → `.t\r12\plugin-gui\logs\host3091.out.txt`；stderr 空 |
| 浏览器 | Edge，`--remote-debugging-port=9223 --user-data-dir=.t\r12\plugin-gui\edge-profile`（`Start-Process` 分离启动后稳定） |
| 连接 | `BU_CDP_URL=http://127.0.0.1:9223`、`BU_NAME=r12gui`、`browser-use`（脚本走 stdin；**纯 ASCII**，中文一律 `\uXXXX`） |
| 收尾 | 3091 pid 5744 → killed；9223（pid 3452 及其 9 个子进程）→ 全部停止；**`3080` 仍 `LISTEN` pid 8960**；`.t/r11` 宿主 pid 14220 存活 |

**隔离有效性**：插件包确实从孤立 home 的 junction 加载 ——
`performance.getEntriesByType('resource')` 里含
`http://127.0.0.1:3091/plugins/??…,dsh-winstage-sandbox/client.js,@deepseek-ai/dsh-typert-registry/client.js…&rev=7bf6ebb6c3ea`，
页面存在 `data-winstage-composer-unhide="1"`（`[实测]`，`.t\r12\plugin-gui\logs\bu-bundle.txt`）。

---

## 2. D7-b · 面板不出现：根因定死为**两道闸门**（`[实测]` + `[读码]`）

### 2.1 `[实测]` 宿主路由被闸门挡住

```
GET /winstage-panel/snapshot?session=session-e0b337a4-78b6-403b-b167-07e2da60c7f6
→ status 503
  {"ok":false,"code":"disabled","route":"/winstage-panel/snapshot"}
```
（原始读数：`.t\r12\plugin-gui\logs\bu-route.txt`）

### 2.2 `[读码]` 两道闸门分别在

| 闸门 | 位置 | 判据 |
|---|---|---|
| ① HTTP 路由 | `dsh-plugin/host-plugin.mjs::buildPanelPayload()` | `if (!isEnabled()) return 503`，而 `isEnabled = () => config.enabled !== false`（:1384） |
| ② 客户端轮询器 | `dsh-plugin/client.js::createPoller().tick()` | `if (readSwitch(configForm) !== 'on') { publish(idle); return }` |
| ③ （连带的）读法 | `readReviewViaLegacyPath()` | 路由失败后回退 `.dshstage\…\review.json` **旧布局**；本轮真实存储根不在那里 ⇒ 读不到 |

⇒ 三道都只认**配置值**，而进程级 `WINSTAGE_SHELL=1` 让宿主侧暂存**真的在跑**
（`staging-fs.stagingEnabled()` 为真）。于是"拿到暂存却没有批准权"，界面一字不提 —— R11 D7-b 的完整形态。

### 2.3 改动（两处闸门 + 一个可机读字段）

| 文件 | 改动 |
|---|---|
| `dsh-plugin/review-service.mjs` | 快照新增 `staging` 段：`{workspaceRoot, effective, configValue, observedAt, source, shellOverride, mismatch}`；新增 `noteEffectiveStaging()` / `effectiveStagingOf()` / `effectiveStagingSnapshot()` / `shellEnvOverride()`；`ReviewService` 接受 `effectiveStaging` 注入（getter ⇒ 热切换仍现读） |
| `dsh-plugin/staging-fs.mjs` | `stagingEnabled()` 顺手登记生效值；`stagingFor()` 把 `get effectiveStaging()` 注入审阅服务（与 `stagingEnabled()` **同一处真值**） |
| `dsh-plugin/client.js` | 新增 `stagingFacts(snapshot)`；`winstageElection()` 判据由"只认 `store.state.enabled===true`"改为"**配置值或生效值任一为真**（`unknown` 仍不接管）"；轮询器在 `readSwitch()!=='on'` 时先**探一次**快照，仅当 `staging.effective===true` 才按 ready 处理 |
| `dsh-plugin/host-plugin.mjs` | `buildPanelPayload()` 的闸门改为"配置值 **或** 已发布快照的 `staging.effective===true`"（配置说开时零额外 IO；读不到照旧按关处理，**绝不因读不到而放行**） |

### 2.4 验收（修复后应看到什么 —— 可复跑）

```powershell
# 1) 起宿主（务必用改完代码之后的仓库；宿主启动即加载插件，中途改代码不会生效）
$env:DSH_HOME='…\.t\r12\plugin-gui\gui-home'; $env:WINSTAGE_SHELL='1'; $env:DSH_SESSION_ID=''
$env:WINSTAGE_STAGE_ROOT='…\.t\r12\plugin-gui\stage-root'
dsh --profile web --port 3091 --no-open
# 2) 在会话里让 agent 写一个文件（产生待审）后：
#    期望 ① 路由 200（不再是 503 disabled）
#    期望 ② 页面出现 [data-winstage-panel="1"] 或常驻 chip [data-winstage-chip="1"]
#    期望 ③ 设置行 data-winstage-staging-effective 从 unknown 变为 on
```

**本轮未完成这一步**：3091 宿主加载的是旧代码（见 §0），
且我没有重启宿主（重启会把这次会话的证据窗口关掉，而时间盒只剩个位数分钟）。

---

## 3. D7-c / D7-d · 开关无声 no-op 与状态词相反（`[实测]`旧码 + `[读码]`新码）

### 3.1 `[实测]` 旧代码读数（逐字）

| 步骤 | 读数（原始：`.t\r12\plugin-gui\logs\bu-toggle.txt`、`bu-row3.txt`） |
|---|---|
| 打开 设置 → 通用 | `switchCount=3`；`WinStage 沙箱` 开关 `aria-checked="false"`、`disabled=false`；同屏另外两个开关 `true/false` 正常 |
| 行内文案 | `WinStage 沙箱 已关闭` + 描述 + `默认收起：关` |
| 行内数据属性 | `data-winstage-staging-effective="unknown"`、`data-winstage-staging-forced="0"` |
| 点击开关（坐标 866,894）后 3 s | `aria-checked` **仍 `false`**；`data-winstage-toggle-attempt` **不存在**；全页无任何错误/成功提示；`data-winstage-staging-effective` 仍 `unknown` |
| 待审面板 | `bodyHasPanelText=false`（`暂存待审` / `批准所选` / `拒绝全部` 一个都不出现） |

⇒ **旧代码同时复现 D7-c（无声 no-op）与 D7-d（状态词只反映配置值）**，与 R11 台账逐字一致。
⇒ 注意：这份读数**没有**包含我新加的 `data-winstage-toggle-attempt` 与
`data-winstage-staging-*` 的"新行为"，只包含它们的**存在性**（`staging-effective=unknown` 说明
旧进程里根本没有 `staging` 字段）—— **不能当作新代码的验收**。

### 3.2 `[读码]` 根因

* **D7-c**：`WinStageRow` 的点击回调 `setEnabled(!enabled)` 若返回假值/未回值，
  旧实现只 `setFailed(true)` 或**什么都不显示** ⇒ 界面既不改变也不解释（`[实测]` 佐证）。
  成因只有三类，且都能给用户出路：被 profile 覆盖层固定 / 被进程级 `WINSTAGE_SHELL` 强制 /
  设置面不可写（`snapshot.writable===false`）。
* **D7-d**：行内状态词只读 `configForms` 快照的 `enabled`（配置值），
  进程级 `WINSTAGE_SHELL` 覆盖在界面上**完全不可见**。

### 3.3 改动

| 文件 | 改动 |
|---|---|
| `dsh-plugin/client.js` · 设置行 | ① 状态词与"生效值"合并在同一行：`已关闭 · 当前生效：WinStage 接管中` / `已关闭 · 当前由环境变量强制：WinStage 接管中 · WINSTAGE_SHELL=1（强制 WinStage 接管）`；② 新增逐字可读的**点击结果回执** `data-winstage-toggle-attempt ∈ {accepted, rejected, threw:<原文>}`；③ 强制时行内给出**出路**（`WINSTAGE_SHELL=0` 重启宿主 / 改 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml` / 跑 `/winstage status`）；④ 新增 `readStaging` 注入：设置行自己用**与面板同一个** `readReview()` 读生效值（带轮询器已解析出的 `sessionId`，这是关键 —— 不带 session 会解析到另一个存储根，R12 实测该次调用拿到空快照） |
| `dsh-plugin/client.js` · 字典 | 新增 `effectivePrefix / effectiveOn / effectiveOff / forcedPrefix / forcedHint / toggleAccepted / toggleRejected / toggleThrew`（中英各一套） |

### 3.4 验收（修复后应看到什么 —— 可复跑）

```
设置 → 通用 → WinStage 沙箱
  期望 ① data-winstage-staging-effective="on"（本配方：配置=false / 生效=true）
  期望 ② 行内同时出现 "已关闭" 与 "当前由环境变量强制：WinStage 接管中 · WINSTAGE_SHELL=1（强制 WinStage 接管）"
  期望 ③ data-winstage-staging-forced="1"、data-winstage-staging-mismatch="1"
  期望 ④ 点击开关：data-winstage-toggle-attempt 出现（accepted 或 rejected），
          rejected 时行内给出 `toggleRejected` 文案（含 profile 覆盖层的核对路径）
```

**本轮未完成 ①②③④ 的新码验收**（宿主加载旧代码，见 §0）。离线侧
`node .t\r12\plugin\selftest-masking-and-ledger.mjs` 覆盖了 `staging` 段的形状与
`configValue/effective/shellOverride/mismatch` 的产生逻辑（A/B 段），但**不含客户端渲染**。

---

## 4. 诚实边界

1. **GUI 那一轮的所有 `[实测]` 读数都来自旧代码**（宿主启动即加载 + 无 HMR）。
   我不据此声明"修好了"，也不据此声明"没修好" —— 只声明**根因已定死到具体两道闸门**，
   以及**修复代码已落地并可离线断言其数据来源**。
2. **未能复跑一次"改码之后重启宿主"的 GUI 验收**：本轮时间盒已耗尽
   （4 次嵌套沙箱 run + 1 次 GUI 会话），且重启宿主会关闭本次证据窗口。
   建议 Lead 在下一轮用 §2.4/§3.4 的步骤复跑（配方、token 获取方式、CDP 端口、
   需要的 `data-winstage-*` 锚点都已写在本文件里）。
3. **D7-c 的真实成因本轮未在服务端日志里定案**：`[实测]` 只证明了"点击无可见结果"，
   没证明"是覆盖层拒绝还是通道未回值"。新代码把这两类**分别**呈现
   （`rejected` vs `threw`），并在强制场景下显式写出"由环境变量强制" ——
   下一次 GUI 会话只要读 `data-winstage-toggle-attempt` 即可定案。
4. 截图：`capture_screenshot()` 在 attach 的后台标签页上 **60 s 超时**
   （`RuntimeError: Page.captureScreenshot timed out`），本轮因此**没有截图**，
   全部以**可复制界面文本 + DOM 属性**留证（`.t\r12\plugin-gui\logs\bu-*.txt`）。

## 5. 证据索引

| 内容 | 路径 |
|---|---|
| 宿主 3091 stdout/stderr | `.t\r12\plugin-gui\logs\host3091.out.txt`、`host3091.err.txt` |
| 插件确实加载（资源 URL） | `.t\r12\plugin-gui\logs\bu-bundle.txt` |
| 面板路由 503（D7-b 实测） | `.t\r12\plugin-gui\logs\bu-route.txt` |
| 设置行读数（D7-c/d 实测） | `.t\r12\plugin-gui\logs\bu-toggle.txt`、`bu-row3.txt`、`bu-settings2.txt` |
| GUI 脚本（可复跑） | `.t\r12\plugin-gui\scripts\*.py` |
| 隔离 home / 独立 Edge profile | `.t\r12\plugin-gui\gui-home\**`、`.t\r12\plugin-gui\edge-profile\**` |
