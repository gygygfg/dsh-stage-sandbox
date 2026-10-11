# R12 修复报告 · `dsh-plugin/**` + `src/**`（D2 / D7-a / D5-N1）

> 执行者：R12 teammate（`dsh-plugin/**` 与 `src/**` 唯一写者；**未碰** `src/registry-bindings.mjs`、**未碰** `shim/**`）
> 时间窗：2026-10-11 02:22–03:30（+08:00）
> 证据根：`.t\r12\plugin/**`；GUI 另见 `.t\r12\plugin-gui/**` 与 `docs/round12/plugin-GUI-修复.md`
> 纪律：**未改** `~/.dsh/**` 与 `profiles/web`；**未杀 3080 宿主**（验收见 §5）；未重封源码基线（`tests/baseline-integrity.mjs` 红属预期）

---

## 0. TL;DR（四条，按优先级）

| # | 缺陷 | 状态 | 一句话 |
|---|---|---|---|
| 1 | **D2** `review.json` 内嵌明文凭据 | **已修（实测闭环）** | 根因不是"没掩码"，而是"只对 `safety==='danger'` 清空 diff"；`.dsh/.credentials.yaml` 命中的是更宽的 `dsh-home` 规则（`safety:'risk'`）⇒ 整份明文照写。现在**值级掩码**：结构/键名/长度保留、值换 `<REDACTED len=N>`，哈希语义一字不动 |
| 2 | **D7-a** 提权后 `write` 绕过暂存直落真实盘 | **已修（机制 + 记账，实测部分）** | 旧实现的"会话根不一致 ⇒ 直接 `super.*` 且不记账"被删掉：**暂存优先**，另三条真退出暂存的路径全部落账到 `review.json.unstaged` |
| 3 | **D5-N1** 沙箱内 `stdio:'pipe'` 崩溃 | **已修（机制 + 单元自证；本轮未复现原崩）** | 新增 `src/child-capture.mjs`：管道被拒 ⇒ **自动回退文件重定向** + 可读注记；并有全局守卫让同类未捕获错误**不再整进程死亡** |
| 4 | **D7-b/c/d** GUI 面板/开关/状态词 | **部分修（代码完成，GUI 只验到旧代码）** | 服务端快照新增 `staging`（配置值/生效值/环境强制），客户端两处闸门改按**生效值**；GUI 实测那一次**跑的是启动即加载的旧代码**，结论见 GUI 报告 |

---

## 1. D2 · `review.json` 敏感内容值级掩码

### 1.1 根因（读码 + 实测双重定位）

* `dsh-plugin/review-service.mjs::renderChange()` 只在 `safety === 'danger'` 时清空 `diff`；
* `safety` 由命中 mask 的 **id** 决定（`isDangerMask` / `DANGER_MASK_IDS`）；
* `src/paths.mjs::MASK_CLASSES` 里 **更宽的 `dsh-home`（`\\\.dsh(\\|$)`）排在更窄的
  `dsh-credentials` 之前**，`maskReason()` 返回第一个命中项 ⇒ `.dsh/.credentials.yaml`
  拿到的是 `dsh-home`，而它**不在** `DANGER_MASK_IDS` 里 ⇒ `safety:'risk'` ⇒ diff 原样写。

**R11 泄漏的机器复现**（`.t\r12\plugin\scans/**`）：

```
# 1) 从 R11 的 review.json 自身把那段明文抽出来（不读真实凭据文件）
node .t\r12\plugin\scans\extract-diff-plaintext.mjs \
     .t\r11\sensitive\run1\out\stage-root\review.json credentials.yaml \
     .t\r12\plugin\scans\r11-run1-credentials-from-review.txt
# → risk=sensitive safety=risk diffLines=10 extractedBytes=210 hasSkMarker=true

# 2) 扫描：最长连续共享片段 57 B（R11 报告记的是 53 B，同一现象）
node .t\r12\plugin\scans\scan-review.mjs \
     .t\r11\sensitive\run1\out\stage-root\review.json \
     .t\r12\plugin\scans\r11-run1-credentials-from-review.txt
# → maxRun=57 reviewOffset=23430 secretOffset=109 verdict=LEAK
```

证据：`.t\r12\plugin\scans\baseline-r11-run1-selfref.json`、`r11-run1-extract.json`。

### 1.2 改动

| 文件 | 改动 |
|---|---|
| `dsh-plugin/sensitive-content.mjs`（**新增**） | 值级掩码器：`maskSensitiveLine(s)`、`valueNeedsMask()`、`looksSecretLike()`、`looksBinaryLine()`、`hasLongRepeat()`、`isLocationLike()`、`redactedToken()` |
| `dsh-plugin/review-service.mjs` | `renderChange()` 对 `risk==='sensitive' && safety!=='danger'` 的条目逐行掩码，并加 `contentMasked / maskedSegments / maskReasons / note`；顶层新增 `redactions` 段 |
| `dsh-plugin/review-service.mjs` | 新增 `SENSITIVE_MASK_NOTE`（与 `SENSITIVE_OMIT_NOTE` 并列的两条策略） |

掩码规则（**已知形态优先于启发式**，顺序不可颠倒）：

1. **已知密钥形态** `sk-…` / `Bearer …` ⇒ 保留标记、遮蔽随机段（`sk-<REDACTED len=31>`）；
2. **结构化行** `key: value` / `key=value` / `"key": "value"` ⇒ 只遮值；
   值是否要遮由"可读标量白名单"判（≤24 字符 / 路径 / URI / 邮箱 / 像句子 ⇒ 放行；
   其余未知形状 ⇒ **按秘密处理**，fail-closed）；
3. **裸 token**（列表项、私钥主体）⇒ 长度 + 字符类多样性 + 连续重复 ≥16 两种判据；
4. **二进制/控制字符/非 ASCII 占比过高**（`Security.evtx`、UTF-16 转储）⇒ 整行遮蔽。

### 1.3 验收证据

```
# 单元级：把 R11 实测泄漏样本喂给掩码器
node .t\r12\plugin\scans\masker-check.mjs
# → maskedSegments=2 / maskReasons=["bare-token","known-secret"]
#   structuralResidual=37  （= "  client-connection/browser-session:"，**纯结构、零秘密**）
#   secretValueResidual=5  （阈值 16）
#   structureKept=true / falsePositives=[] / missed=[]
#   residualOk=true → exit 0
```

`structuralResidual=37 > 0` 是**设计使然**（契约第 1 条"保留结构"），与 R11 报告
"打码后残余 36 B 落在两个秘密值区间之外"逐字同源；真正判红的是 `secretValueResidual`。

**端到端（真实沙箱线程，run4）**：

```
.t\r12\plugin\sandbox\run4\out\stage-root\review.json
  staging.effective=true   （本次装配）
  files[] 里 .t\r12\…\outside\.dsh\.credentials.yaml:
     risk=sensitive  safety=risk  masked=true  segments=2  reasons=["known-secret"]
     note=内容已按敏感策略掩码（保留键名/缩进/长度，值替换为 <REDACTED len=…>）
  redactions={masked:true, fields:1, segments:2, items:[…]}
```

**哈希语义**：掩码只作用于**写进 payload 的文本**；`renderCandidateDiff()` 的 `totals`
在掩码**之前**数完，`change.before.hash` / `change.after.hash` / `after.bytes` 一个字节不碰
⇒ before/after 比对语义逐字不变。离线断言 A7（`totals.added===10`）与 A11（落盘文件无明文）钉住这一点。

---

## 2. D7-a · 提权后 `write` 绕过暂存

### 2.1 根因（读码，逐字）

`dsh-plugin/staging-fs.mjs::writeTextStaged()` 旧实现：

```js
if (!this.inConfiguredWorkspace(sandboxPolicy)) {
  this.warnForeignWorkspace(sandboxPolicy)      // 只打一条 info 日志
  return super.writeText(target, content, expected, signal, sandboxPolicy)  // ← 直接落真实盘
}
```

`inConfiguredWorkspace()` 比较的是**会话工作区**与**插件配置的暂存根**（`sameRoot`）。
两者不一致（`sandboxPolicy.workspaceRoot` 与会话根来源不同、或短名/大小写/链接拼法不同）时，
写入被**静默**交给平台面：不进 `manifest.json`、不进 `staged\`、不进待审面板，
而它**确实落到真实磁盘** —— 正是 R11 D7-a 的实测形态，且界面与审计零提示。

### 2.2 改动（取任务书第 ① 条：暂存优先）

| 文件 | 改动 |
|---|---|
| `dsh-plugin/unstaged-ledger.mjs`（**新增**） | "没有走暂存"的账本：`recordUnstaged()` / `readUnstagedLedger()` / `unstagedSnapshot()` / `UNSTAGED_REASONS`。原子写（tmp+rename）、有界（≤200 条）、**绝不抛**（记账失败不影响本次写入） |
| `dsh-plugin/staging-fs.mjs` | ① 删掉"会话根不一致 ⇒ 直接 `super.*`"早退，改为 `stageOverForeignWorkspace()`：**仍然进暂存** + 记一条 `foreign-session-workspace`；② `keyOf()` 为 `undefined`（无法归一）与 `stageOutside==='direct'` 两条真退出路径**同样落账**；③ `warnForeignWorkspace()` 从 `log` 升级为 `logError`，文案改成"仍然进暂存" |
| `dsh-plugin/review-service.mjs` | `snapshot()` 新增 `unstaged` 段（来源 = 与 `review.json` **同一存储根**的 `unstaged.json`） |

账本落点与 `review.json` 同源是**结构性**的：`this.unstagedLedgerDir = this.staging?.storeDir`，
而 `ReviewService.publish()` 写 `join(this.workspace.store.dir, 'review.json')`，
两者都由 `resolveReviewStoreDir()` 解析同一个 `(workspaceRoot, sessionId)`。

### 2.3 验收证据

```
# 离线（25 项断言，含"绕过必落账""账本进快照""旧分支已消失"的静态判据）
node .t\r12\plugin\selftest-masking-and-ledger.mjs     → exit 0
  B3 绕过动作被落账  foreign-session-workspace
  B4 下一次快照里 unstaged.any=true（界面/审计必然看得到）  1
  B5 标出"真的落到真实磁盘"的条数  1
  B6 原因可机读  {"foreign-session-workspace":1}
  B7 **落盘的 review.json** 里也带 unstaged 段
  C1 writeTextStaged 里"会话根不一致 ⇒ 直接 super"的旧分支已消失
  C2 write/edit 两条路径都改为"仍然进暂存 + 记账"
  C3 另外两条真退出暂存的路径（无法归一 / direct 逃生口）也落账
  C5 账本目录与 review.json **同源**
```

```
# 端到端（真实沙箱线程 run4，写的是工作区**外**的绝对路径）
.t\r12\plugin\sandbox\run4\out\stage-root\review.json
  staging.effective=true
  unstaged={"any":false,"count":0,"appliedToDisk":0,…}
  真实盘 .t\r12\plugin\sandbox\outside\.dsh\.credentials.yaml → 写入被暂存（宿主侧该目录为空）
```

⇒ 本轮 run4 里**没有发生绕过**（`unstaged.any=false`），这与"暂存优先"一致；
`foreign-session-workspace` 这一条的真实触发仍**未在沙箱里复现**（见 §4 诚实边界）。

---

## 3. D5-N1 · 沙箱内 `stdio:'pipe'` 崩溃 ⇒ 降级到文件重定向

### 3.1 本轮**未能复现**原崩（先说这一条）

| run | 形态 | 读数 |
|---|---|---|
| run2 | 脚本内 `spawnSync(node, ['-e','console.log(42)'], {encoding:'utf8'})`（默认管道） | `PIPEPROBE status=null stdout="" error=ENOENT`，脚本**跑完**（`PIPEPROBE reached-end-of-script`）、进程存活 |
| run3 | `spawn(..., {stdio:['ignore','pipe','pipe']})` 异步版 + 事件监听 | 见 `.t\r12\plugin\sandbox\run3\out/**`；**未观察到整进程死亡** |

R11 的 `read ENOTCONN`（`errno:-4053`）本轮**没有**在 TS 档复现。因此下面的修复**不能声称
"已把实测崩溃修好"**，只能声称"降级机制已就位并有单元级自证"。

### 3.2 改动

| 文件 | 改动 |
|---|---|
| `src/child-capture.mjs`（**新增**） | `spawnCaptured()`：管道优先、被拒即**粘性**回退文件重定向；返回 `via/pipeError/note`；`installChildProcessPipeGuard()`：把这一族未捕获错误降级为**可读注记 + 非零退出码**（进程不死）；`__setPipeRunnerForTest()` 注入缝 |
| `src/testrunner.mjs` | 惰性接线：`runCaptured()` 首次拉子进程前装一次守卫（套件进程不再因同类错误丢掉整条证据链） |

覆盖的错误族：`EPERM / ENOTCONN / EACCES / EPIPE / EINVAL / UNKNOWN / ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
（与 `src/registry-bindings.mjs::runReg()` 的 pipe→file 回退同族口径；该文件**未改动**）。

### 3.3 验收证据

```
node .t\r12\plugin\selftest-child-capture.mjs      → exit 0（17 项）
  A1–A4  真实子进程：stdout/stderr 都拿到、via=pipe
  B1 回退后 via=file（不是静默用管道）
  B2 回退后真的跑起来了（status=0）
  B3 回退后 stdout 仍然拿到
  B4 如实带 pipeError（不吞）  ENOTCONN: read ENOTCONN
  B5 带**可读降级注记**  piped stdio was refused (ENOTCONN: read ENOTCONN); retried with file redirection
      (residual boundary D5-N1: a confined host cannot open named pipes)
  B6/B7 粘性记忆：第二次调用没有再走管道（pipeCalls=1）
  B8 mode:'pipe' 显式档不回退（语义不被偷改）
  B9 同步抛出同样回退且拿到输出
  C1 装了守卫：ENOTCONN 之后进程**仍然活着**（跑到了 STILL-ALIVE）  status=0
  C2 装了守卫：给出可读注记（不是静默）
  C3 对照（不装守卫）：同一错误**确实**会让进程死掉（证明 C1 有牙齿）  status=1
  C4 对照的 stderr 里能看到 ENOTCONN（与 R11 原始栈同形）
```

---

## 4. 诚实边界与未完成项

1. **D5-N1 的原始崩溃本轮未复现**（沙箱内管道这次返回 `ENOENT` 而不是 `ENOTCONN`）。
   因此"崩溃已修"这句话**不成立**；成立的是"降级与兜底已实现，注入式单元自证齐全"。
2. **D7-a 的 `foreign-session-workspace` 分支未在真实沙箱里触发**：本轮三次沙箱 run 的
   `sandboxPolicy.workspaceRoot` 与配置暂存根都一致（`ws` 目录），走的是正常暂存路径。
   该分支的验收目前是**静态判据 + 账本单元测试**（`selftest` C1–C5）。
3. **D7-b/c/d 的 GUI 实测跑的是旧代码**：3091 宿主的插件在启动时加载
   （`--profile web`，无 HMR 重载），我在会话中途修改的 `dsh-plugin/client.js` /
   `host-plugin.mjs` **没有进入那个进程**。GUI 那一次的读数（开关点击 `aria-checked` 不变、
   零提示、`data-winstage-staging-effective=unknown`）**只对旧代码有效**，不能当作
   修复后的验收。详见 `docs/round12/plugin-GUI-修复.md`。
4. **`tests/baseline-integrity.mjs` 预期红**（本轮不重封源码基线，Lead 统一做）。
5. 新增两个 `src/**` / `dsh-plugin/**` 模块（`src/child-capture.mjs`、`dsh-plugin/sensitive-content.mjs`、
   `dsh-plugin/unstaged-ledger.mjs`）；`src/child-capture.mjs` 已接线进 `src/testrunner.mjs`
   （`runCaptured()` 装守卫）。`dsh-plugin/unstaged-ledger.mjs` 与 `sensitive-content.mjs`
   都被 `review-service.mjs` / `staging-fs.mjs` 在运行期引用。

---

## 5. 纪律验收（收尾）

| 项 | 结果 |
|---|---|
| `~/.dsh/**`、`profiles/web` | 未改（GUI 用独立 `DSH_HOME`：`.t\r12\plugin-gui\gui-home`） |
| `src/registry-bindings.mjs` | **未改**（只在 `src/child-capture.mjs` 里抄了它的 pipe→file 回退范式） |
| `shim/**` | **未改** |
| 3080 宿主（用户 GUI） | **全程存活**（收尾 `Get-NetTCPConnection 3080 → LISTEN pid 8960`） |
| 3091 / 9223 | 收尾已停（`not listening`） |
| `.t/r11` 常驻线程宿主 | 未起第二个（pid 14220 全程存活） |
| 离线套件 | `integration-wiring` 144/0 · `session-enclosure-selftest` 17/0 · `policy-never-consistency` 29/0(1 SKIP) · `assembly-toggle-selftest` 26/0 · `suite-wiring` 29/0 · `whiteout-candidate-capture` 29/0（**需先清 `%LOCALAPPDATA%\Temp\winstage-stage\bec0223a-*` 与该套件的 `.t` 输出目录**，否则第二次运行必红：套件复用同一存储根且不复位 —— 本轮亲测，非本轮改动引入） |

## 6. 证据索引

| 内容 | 路径 |
|---|---|
| D2 基线泄漏度量（57 B） | `.t\r12\plugin\scans\baseline-r11-run1-selfref.json` |
| D2 从 review.json 抽出的泄漏样本（**非真实凭据文件**） | `.t\r12\plugin\scans\r11-run1-credentials-from-review.txt` |
| D2 掩码单元自证 | `.t\r12\plugin\scans\masker-check.txt` |
| D2+D7-a 离线自测（25 项） | `.t\r12\plugin\selftest-masking-and-ledger.{mjs,txt}` |
| D5-N1 离线自测（17 项） | `.t\r12\plugin\selftest-child-capture.{mjs,txt}` |
| 沙箱 run1–run4（含 `review.json` / `lane.txt` / `workspace-inventory.txt`） | `.t\r12\plugin\sandbox\run{1..4}\out\**` |
| 离线套件原始输出 | `.t\r12\plugin\suite-*.txt` |
| GUI 证据 | `.t\r12\plugin-gui\**`（见 `docs/round12/plugin-GUI-修复.md`） |
