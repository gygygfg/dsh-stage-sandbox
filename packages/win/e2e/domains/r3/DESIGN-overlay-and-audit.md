# DESIGN — overlay 命名空间归一 / 读侧可见性 / 出站内容管控

> 状态：**设计文档，零源码改动**。三节各含：方案一句话 → 实测证据 → 具体锚点 → 改动面 → 回归测试 → 风险与回滚 → 工作量。
> 证据分级：`[已确证]` = 本次在本机亲自读到/跑出的原始行；`[推断]` = 由代码结构推出、尚未实测的结论，并附验证方法。
> 环境：ws=`C:\Users\Administrator\Desktop\WinStageSandbox`；
> `$STAGE = ws\.dshstage\sessions\session-f6414871-bca6-43b5-9215-b6d475fb522a\staged`。

---

## 0. 证据基线（本次实测，含一处必须纠正的前提）

### 0.1 三套布局在磁盘上同时存在 `[已确证]`

```
=== staged ===
         1  staged\shim\out                                      ← 布局①（仅剩空目录）
         1  staged\fs\C\Users\Administrator\Desktop\WinStageSandbox\shim\out
                                                                 ← 布局②（shim 通道）
=== staged-ext ===
      6435  staged-ext\97\97f2f2a1f32731b0\WinStageSandbox-r3-修复与测试交接.md
                                                                 ← 布局③（外部键）
```

命令：`Get-ChildItem $STAGE\{staged,staged-ext} -Recurse`。

### 0.2 review.json 的实况 `[已确证]`

```
top keys: version, generatedAt, workspaceRoot, sessionId, candidateId, revision,
          pending, truncated, counts, riskCounts, alerts, candidates, files
counts     {"files":349,"listed":40,"totalFiles":349,"additions":23636,"deletions":0,"net":349}
riskCounts {"normal":348,"outside":1,"sensitive":0,"danger":0}
alerts     []
files with risk!=normal: (none)
```

命令：`node -e "…JSON.parse(review.json)…"`。
→ **写面的风险分级在本会话 349 条净变化上产出 `sensitive=0, danger=0, alerts=[]`**；唯一非 normal 的 1 条 `outside` 是本文档自身。

### 0.3 ⚠ 必须纠正的任务前提：`session-97132a99` / `session-d6e30323` 不存在 `[已确证]`

```
$ Get-ChildItem ws\.dshstage\sessions -Directory
218ed860-…, 3872ec21-…, 594158fb-…, 7b811775-…, 929b80ce-…, cb830512-…, e39356e4-…,
session-4c5d9889-…, session-7bde7fc3-…, session-8b4a07b9-…, session-ae62077b-…,
session-b7bfc9b6-…, session-c67dd71d-…, session-eb7c901d-…, session-f6414871-…
```
磁盘上**没有任何**会话目录叫 `session-97132a99` 或 `session-d6e30323`（`Test-Path` 两者皆 `False`）。
这两个 id 只能以**产物**形态出现在 review.json 的路径串里（`_r3\s_session-97132a99-9238-4b1a-8cf1-f51c7047b3aa.jsonl` 等），
即它们是被测/被记录的会话，其暂存树**已被清理**。

**因此**：任务书引用的 "CH-01 / session-97132a99 / session-d6e30323 实测" 我**无法在磁盘上复现**。
下文所有 `[已确证]` 均改用**当前仍存在的、可直接复读的证据**（本会话暂存树 + 头文件/源码 + 仍存活的 shim.log）；
凡只能靠那两个 id 支撑的，我标为 `[推断]` 并给出复现命令。这一点必须由 owner 知悉：**引用不可复现的会话 id 写进设计文档会造出第二份"声称有证据"的漂移。**

---

## 问题 1：overlay 命名空间三分裂

### 1.1 一句话方案

**选 `src/store.mjs` 的键模型为唯一 canonical（`staged/<rel>` 与 `staged-ext/<aa>/<hash16>/<leaf>`），把 shim 的 `<root>\fs\<盘符>\…` 降级为"只读的遗留镜像"：写入侧永不新增布局②，读取侧补上真正的 read-through。**

理由：布局①/③已有单一实现者（`Store.stagedPath()`），有清单键模型、有 blob 去重、有 candidate/review 摄取；布局② 是 C 侧第二套实现，**没有清单**，天生不可审批。归一方向只能是"② 收进 ①"。

### 1.2 实测证据：分裂是**双写**，不是历史残留 `[已确证]`

**写入侧两套实现，各自独立**：

1. 宿主 `write`/`edit` 工具 → `dsh-plugin/staging-fs.mjs` → `ws.store.stagedPath(key)`：

```js
// src/store.mjs:381-387
stagedPath(key) {
  if (isExternalKey(key)) {
    const digest = externalKeyDigest(key)
    return join(this.stagedExtDir, digest.slice(0, 2), digest.slice(0, 16), externalLeaf(key))
  }
  return join(this.stagedDir, normalize(key))          // ← 布局①：staged\<rel>
}
```

2. shim 注入的受限进程 → C 侧 `ws_stage.c` `ws_fs_map(norm, L"fs", out, cch)`：

```c
/* shim/src/ws_stage.c:34-45, 58-72, 75-82 */
/* Map a normalized absolute path to "<root>\<leafRoot>\<...>". */
static int ws_fs_map(const wchar_t *norm, const wchar_t *leafRoot, wchar_t *out, DWORD cch)
{ … if (!ws_append_w(out, cch, &pos, root) ||
      !ws_append_w(out, cch, &pos, L"\\") ||
      !ws_append_w(out, cch, &pos, leafRoot)) return 0;
  …
  /* "C:\a\b" -> "\C\a\b" (drive colon dropped, rest kept verbatim) */
}
static int ws_fs_path(const wchar_t *real, wchar_t *out, DWORD cch)
{ … return ws_fs_map(norm, L"fs", out, cch); }          // ← 布局②：<root>\fs\C\…
```

文件头自述布局（`shim/src/ws_stage.c:3-6`）：

```c
 *   <root>\fs\C\Windows\Temp\probe.txt   staged file content (drive colon dropped)
 *   <root>\fs\_unc\server\share\file     staged UNC content
 *   <root>\wo\C\Windows\Temp\probe.txt   whiteout marker (empty file)
```

**注**：布局②对**工作区内**目标也生效（`ws_fs_path` 收的是绝对路径，不区分内外）。而布局①对工作区内目标用**相对键**。
⇒ **同一逻辑文件 `ws\shim\out\x.txt`**：宿主写 → `staged\shim\out\x.txt`；shell 写 → `staged\fs\C\Users\Administrator\Desktop\WinStageSandbox\shim\out\x.txt`。
这正是 0.1 中 `staged\shim\out` 与 `staged\fs\…\shim\out` **同时存在**的原因。

**存在 splitor 的显式代码承认** `[已确证]`：

```js
// dsh-plugin/staging-fs.mjs:869-880
/** 分裂告警：同一逻辑目标在两套布局里都有落点时，报**一条**（不刷屏、也不静默） */
warnSplitOnce(abs, stagedPath, foreign) {
  …
  this.logError(
    `暂存落点分裂（BUG-2）：同一逻辑目标 ${abs} 同时存在于两套互不可见的布局 —— ` +
      `本插件落点 ${stagedPath}（本次写入已归一到这里，读取时两边都看）；` +
      `shim/shell 通道落点 ${foreign}。清单/审批/快照只认前者，后者不会被自动清理。`,
  )
}
```

**并且 `src/workspace.mjs` 的 C-8 漂移守卫在 3081 上认定为空转** `[已确证]`：

```js
// dsh-plugin/staging-fs.mjs:334-347
const drift =
  config?.workspaceRoot !== undefined && …          // ← 要求 workspaceRoot 被显式重述
  !sameRoot(config.cwd, config.workspaceRoot)
if (drift) { … error.code = 'FS_STAGE_ROOT_DRIFT'; throw error }
```
同一文件 326-333 行自述：profile 覆盖层只重述 `cwd` 时该项恒假 ⇒ 守卫不触发。
**任务书所指的 "staging-fs.mjs:155-160"** 实际是 `isStoreStatePath()` 的 `STORE_METADATA_FILES` / `STORE_STATE_DIRS` 分支（本文件 210-225 行，任务书行号对应旧版）；它与漂移无关，是 P0-8 自指写入守卫。

### 1.3 读取侧：声称的 read-through **是死代码** `[已确证]`

`staging-fs.mjs:555-597` 有一个 `shimContentOf()`，注释明确写"读取时两边都看（BUG-2）……命中就返回与 `currentOf()` 同形状的结果"，返回体还带 `layout:'shim-fs'` / `physical`。**但全仓库它只被声明、从无调用**：

```
$ grep -rn "shimContentOf" dsh-plugin/
dsh-plugin\staging-fs.mjs:530:     //      （`shimContentOf()` / `locationReceipt()` / `warnSplitOnce()`）；
dsh-plugin\staging-fs.mjs:562:     shimContentOf(ws, target, abs) {
```

同理 `hasStagedContent()`（`:610-625`，注释"读取面据此决定要不要走暂存投影"）也**零调用**：

```
$ grep -rn "hasStagedContent" dsh-plugin/
dsh-plugin\staging-fs.mjs:614:     hasStagedContent(ws, key, abs) {
```

实际读路径走的是另一条，**只在清单有条目时才看暂存，否则直接回落真实磁盘**：

```js
// dsh-plugin/staging-fs.mjs:1283-1297
async readText(target, signal) {
  …
  const place = this.keyOf(target)
  if (place === undefined) return super.readText(target, signal)
  const ws = this.stagingFor(this.sessionIdOf()).fresh()
  if (!this.hasEntry(ws, place.key)) return super.readText(target, signal)   // ← shim 镜像被跳过
  const current = await this.currentOf(ws, target, place.key, signal)
  …
}
// :970-972  hasEntry —— 只看清单净变化
hasEntry(ws, rel) { return this.projectsEntry(ws.entryOf(rel)) }
```

`listDir` 同病（`:1368-1399`），只合并 `ws.manifest.entries`，**不合并 `fs\` 布局**：

```js
// :1394-1399
for (const [key, entry] of Object.entries(ws.manifest.entries)) {
  if ((entry.external === true) !== external) continue
  if (!this.projectsEntry(entry)) continue
  …
}
```

**结论**：`warnSplitOnce` 的执行条件挂在 `locationReceipt()`（`:887-909`）上，而 `locationReceipt` 只在**写**回执里调用 ⇒
**纯 shell 写入的文件对宿主读面完全不可见，且不产生任何告警。**
`staged\shim\out`（宿主侧空目录）与 `staged\fs\…\shim\out`（shell 侧）就是这条断言的两半。`[已确证]`

### 1.4 摄取侧：`run-capture` 读**真实磁盘**，不是暂存树 `[已确证]`

```js
// dsh-plugin/run-capture.mjs:78
const DEFAULT_ROOTS = (workspaceRoot) => [workspaceRoot]        // ← 真实工作区
// :365
const roots = (Array.isArray(options.roots) && options.roots.length > 0
  ? options.roots : DEFAULT_ROOTS(workspaceRoot)).map((root) => canonical(root))
// :424-434  stage(change)
workspace.writeFile(abs, readFileSync(abs), { origin: 'run-capture' })   // ← readFileSync(真实 abs)
```
即：捕获器把**执行后真实磁盘**的内容 `writeFile` 进暂存，落点是 `store.stagedPath(key)` = 布局①。
若 shell 因某种原因直写了真实磁盘（逃生口/未注入），这里会把它归一到布局①；**但 shell 写进布局②的内容永远不会被这里看见**（roots 是真实磁盘）。
⇒ 同路径双份内容会**同时进同一个 review.json**：布局①那份由 `run-capture`/`ctx.fs` 摄取，布局②那份不进摄取、却仍是 shell 眼中的"刚写的文件"。`[已确证]`（机制）／`[推断]`（"同时在 review.json 出现两条"这一**具体**形态需在 3081 上按 §1.6 复现）

### 1.5 具体锚点汇总

| # | 文件:行 / 函数 | 现状 | 归一后应做 |
|---|---|---|---|
| A1 | `src/store.mjs:381-387` `stagedPath()` | canonical 唯一实现 | **不动**（确立为 canonical） |
| A2 | `shim/src/ws_stage.c:34-73` `ws_fs_map()` / `:75-82` `ws_fs_path()` | 造出 `\fs\<盘符>` | 新增 leaf 切换：工作区内目标改用**相对键**同构映射（见 §1.7 方案 B'） |
| A3 | `shim/src/ws_file.c:837-866` `ws_logical_from_staged()` | 硬编码 `g_ws.stageRoot + L"\\fs\\"` 反解 | 必须与 A2 **同源**，否则 delete 指令反解错路径 |
| A4 | `dsh-plugin/staging-fs.mjs:168-173` `shimLayoutPathOf()` | 布局②的映射 | 保留为 legacy 读取器 |
| A5 | `dsh-plugin/staging-fs.mjs:176-191` `logicalFromShimLayout()` | 布局②反解 | 保留为 legacy 读取器 |
| A6 | `dsh-plugin/staging-fs.mjs:562-597` `shimContentOf()` | **死代码** | **接进 `readText`/`readByteRange`** |
| A7 | `dsh-plugin/staging-fs.mjs:614-625` `hasStagedContent()` | **死代码** | **接进 `readText` 的 `hasEntry` 判据** |
| A8 | `dsh-plugin/staging-fs.mjs:1283-1297` `readText()` | 只看清单 | `hasEntry \|\| hasStagedContent` |
| A9 | `dsh-plugin/staging-fs.mjs:1368-1399` `listDir()` | 只合并清单 | 追加合并 `shimChildrenOf()` |
| A10 | `dsh-plugin/staging-fs.mjs:334-347` 漂移守卫 | 3081 上空转 | 见 §1.8（owner 决策） |
| A11 | `dsh-plugin/run-capture.mjs:365,424-434` | roots=真实磁盘 | 摄取后对同键做**布局② 存在性检查**，有则记 `splitDetected` |

### 1.6 回归测试（本机受限车道内的可做法）

全部**离线、只读源码 + 只写 `$STAGE`**，不需要 3081：

1. **映射同构测试**（纯函数，零沙箱）：新建 `$STAGE\_r3\overlay-map-test.mjs`，
   `import { Store } from 'src/store.mjs'`，对同一逻辑目标同时算 `stagedPath(key)` 与
   `shimLayoutPathOf(stagedDir, abs)`，断言二者**逐字符相等**（归一后的目标态）。
   现在跑应当**红**（`staged\shim\out\x.txt` ≠ `staged\fs\C\…\shim\out\x.txt`）——这条红就是回归基线。
2. **读写互见测试**（用替身基类，不碰真沙箱）：`createStagingFileSystem({ base })` 已有离线自测范式
   （`options.base` 仅供自测替换基类，见 `staging-fs.mjs:184-188`）。用替身基类构造一个"只有 `fs\` 布局文件"的磁盘，
   断言 `ctx.fs.readText()` 能读到它；当前应当**红**。
3. **摄取分裂测试**：对 `run-capture` 用 `options.roots` 指向 `$STAGE\_r3\…` 临时树，造出"真实磁盘有 A、`fs\` 布局也有 A 且内容不同"，
   断言 `stage()` 之后 `review.json` 的该条目带 `splitDetected`。当前**红**。
4. **反解对称测试**：`ws_logical_from_staged(ws_fs_map(x)) === x`，覆盖 `C:\a\b`、`C:\`、`\\server\share\x`、UNC 深路径。
   这是 A2/A3 改动时**唯一**能拦住"delete 反解错路径"的离线防线。
5. **端到端**（需 owner 批准用 3081）：shell 写 `ws\_probe\o1.txt` → 宿主 `read` 必须读到**同一内容**；反向亦然；`listDir` 两侧都出现。

### 1.7 向后兼容：不迁移，读取侧双识别

**磁盘上已有三套布局，我不建议迁移。** 理由与做法：

- **不迁移的理由**：`staged/**` 是**有主**的（每个会话一棵树，且 `review.json`/`manifest.json` 里的
  `stagedHash` 是**内容寻址**的，物化对象只是投影）。改写物化对象路径会与清单里的 `stagedHash` 不一致，
  触发 `verifyProjection()` 的 `'staged tree object missing'`（`src/workspace.mjs:397-419`）⇒ 把好数据判成 CORRUPT。
  这条正是"删除是持久逻辑状态，不能靠真实磁盘回填"（`src/store.mjs:6`）的同族风险。
- **读取侧双识别（推荐）**：canonical 写 = 布局①；读 = ① ∪ ② ∪（③ 由键模型天然覆盖）。
  - 优先级：**清单条目 > 布局①物化对象 > 布局② 镜像 > 真实磁盘**。与 `currentOf()`（`:1211-1244`）现有分支顺序一致，只在"清单未命中"与"回落 `super`"之间**插入**布局②这一档。
  - 布局②命中时**必须**同时看 `wo\` 白障（`shimWhiteoutOf()`，`:599-608`），否则 shell 删过的文件会被布局②"复活"。
  - 读取命中布局②时**打一条 `layout:'shim-fs'` 到写入回执/审计**，让"我在读一份非 canonical 的字节"这件事可见。
- **③ 的兼容**：`staged-ext` 的键是**规范化绝对路径**（`isExternalKey()`，`store.mjs:93-95`），与相对键键空间天然不相交，**无需迁移**。
- **② 的清理**：**不做自动删除**。它是 shell 侧"刚写的文件"的唯一副本，删了就丢数据。
  改为在 review 里以 `splitDetected` 呈现，由人决定 `apply` 后清理（owner 决策，见 §4）。

### 1.8 C-8 漂移守卫（A10）：本设计**不改**，但要指出它当前是空转

守卫条件是"`config.workspaceRoot` 非空且与 `cwd` 不同根"。3081 的 profile 覆盖层只重述 `cwd`（`staging-fs.mjs:326-333` 自述），
⇒ `workspaceRoot === undefined` ⇒ **守卫永不触发**。这**必须**由 owner 决策，因为修它要动 profile/bundle（4 人改动区），
不是本设计能落的源码改动。三选一：(a) profile 同时重述两者（推荐，最小）；(b) 条件退化为 `cwd` 与 shell 行 `workspaceRoot` 的一致性比较（`dsh-plugin/shell-executor.mjs:766-782` 已有 `workspaceRootsOfLoaderRows`）；(c) 明确记入"已知空转"并**在 README 写明**，不再声称该守卫在 3081 生效。

### 1.9 风险与回滚

- **最大风险**：把布局②接进 `readText` 会**改变既有读语义**——原先"清单没有就回落真实磁盘"变成"可能读到 shell 的暂存副本"。
  对**已批准、随后被外部改过**的文件，`:961-969` 的 `hasEntry` 注释明确警告过这种"净 diff 为空但 read 是陈旧内容"的形态。
  ⇒ 缓解：布局②必须在**清单净变化判定之后**才参与，且**仅**在"清单未命中"时；不得覆盖 `projectsEntry` 的结论。
- **次风险**：`ws_logical_from_staged`（A3）与 `ws_fs_map`（A2）改不同步 ⇒ `SetFileInformationByHandle` 删除反解错，
  产生"删了 A 却白障 B"。⇒ 缓解：§1.6 测试 4 作为**必过门**，且两处改为共享同一张叶子表。
- **回滚**：归一改动**全部**是"读取侧新增分支 + C 侧映射函数"。
  回滚 = 回退 `staging-fs.mjs` 的两个读函数 + `ws_stage.c`/`ws_file.c` 的两个映射函数；**不需回滚任何磁盘数据**（§1.7 未迁移）。
  ⇒ 这是**选择不迁移**的最大好处：回滚成本 = 一次 `git revert`，无数据修复。

### 1.10 工作量：**L**（C 侧映射 + JS 读面 + 摄取 + 4 项离线测试；其中 C 侧需重编 shim）

---

## 问题 2：读面零审计（安全不对称）

### 2.1 一句话方案

**不新增黑名单保护，只加"读侧可见性"：把 `maskReason()` 的命中结果从"仅写侧硬拒"扩展为三件事——(1) `ctx.fs` 读路径接入既有的 `assertReadable()` 硬拒；(2) 会话级敏感读计数（去重、非逐次）落 `review.json` 新 section `readVisibility`；(3) 一条合并提示。** 并对"读很频繁"用**每 (路径,会话) 只记一次**的方式解决。

### 2.2 实测证据：不对称是**结构性**的 `[已确证]`

**(a) 遮蔽表读侧**只在一个函数里生效，而该函数**只被调用一次**：

```
$ grep -rn "maskEnforcement|assertReadable" ws/
docs\archive\dsh2\发现记录.md:270:  - [引用] **`hard` 字段此前没有任何消费者**：全仓库 `grep` 只有 `workspace.mjs:141 assertReadable`
docs\archive\dsh2\冲突诊断-插件侧.md:951: | `dsh-plugin/staging-fs.mjs`（全文 835 行） | `maskOf`/`assertReadable`/`Workspace.readFile` **出现 0 次**（grep 复核） | ⇒ **`ctx.fs` 的读路径根本不走遮蔽** |
src\workspace.mjs:369:    this.maskEnforcement = true
src\workspace.mjs:445:  assertReadable(absolutePath) {
src\workspace.mjs:446:    if (!this.maskEnforcement) return
src\workspace.mjs:664:    this.assertReadable(abs)
```

即 `assertReadable()` **唯一**调用点在 `Workspace.readFile()`（`src/workspace.mjs:646-668`）的第 664 行。
而 agent 的实际读通道是 `ctx.fs.readText` → `dsh-plugin/staging-fs.mjs:1283-1297`，
该文件对 `maskOf`/`maskReason`/`assertReadable` **零引用**（§2.2 的 grep 与本次复核一致）。
⇒ **宿主 `read` 工具读 `.dsh\.credentials.yaml` 不经过任何遮蔽判定。** `[已确证]`（代码路径）

**(b) 遮蔽表本身**已经把目标路径全部覆盖，缺的**不是表，是接线** `[已确证]`：

```js
// src/paths.mjs:207
{ id: 'dsh-credentials', category: '本工具自身凭据文件',
  pattern: /\\\.dsh\\\.credentials\.yaml$/i, reason: 'DSH 凭据文件（明文会话凭据）' },
// :318  含 \.npmrc
/\\(\.npmrc|\.yarnrc|…|\.netrc|_netrc|…)(\\|$)/i,
// :505  PSReadLine
{ id: 'probe-psreadline-history', maskClass: 'editor-token-state',
  path: join(APPDATA(),'Microsoft','Windows','PowerShell','PSReadLine','ConsoleHost_history.txt'),
  label: 'PSReadLine 命令历史（[实测] 7950 B 可读；修复前 mask=(none)）' },
```
`MASK_CLASSES` 现有 29 条规则（`src/paths.mjs:192-…`），**已**覆盖 `.credentials.yaml` / `.npmrc` / PSReadLine / Edge `Login Data`。

**(c) 只读探针在 `src/audit.mjs` 里其实是"有"的，但它**不构成读审计** `[已确证]`：

```js
// src/audit.mjs:749-764
if (verdict === 'readable') {
  findings.push({
    area: 'read', id: `read-${probe.id}`,
    status: probe.maskClass ? 'residual' : 'informational',       // ← 可读 + 有遮蔽类 ⇒ residual
    evidence: '[实测] 从沙箱内部发起',
    detail: (probe.kind === 'directory' ? '可枚举' : '可读') + `（${sizeNote}，${headNote}）` +
      (probe.maskClass
        ? ` —— 属**残余边界**：本后端的 WRITE_RESTRICTED 与 Low 完整性标签都不限制读取。` +
          `DSH 侧只能靠遮蔽清单（mask class "${probe.maskClass}"）收敛，而**遮蔽清单不是硬边界**。`
        : '（对照项，符合预期）'),
    data,
  })
```
这是**静态能力普查**（跑一次探针脚本，判"读得到/读不到/不存在"），
**不是**"谁在什么时候读了什么"的审计，且产出为 `residual`（残余边界声明）而非告警。
另一个不对称证据：`review.json` 有 `riskCounts{normal,outside,sensitive,danger}` 与 `alerts`，
**没有任何 read 侧对应物**（§0.2：`alerts: []`，顶层无 read section）。`[已确证]`

**(d) shim 侧读遮蔽是**真的**在跑，但有边界** `[已确证]`：

```c
// shim/src/ws_file.c:206-221
/* Read masking (task-10) runs before anything else, so a sensitive path is
 * denied even if it would otherwise pass through … Only read-class access is
 * subject to the mask; writes keep the staging behaviour. */
DWORD writeAccessMask = dwDesiredAccess & WS_FILE_WRITE_ACCESS_MASK;
if (ws_mask_declared() && !writeAccessMask && !destructiveMask && lpFileName && lpFileName[0]) {
    wchar_t maskedBy[256];
    if (ws_mask_decide_read(lpFileName, maskedBy, 256)) {
        ws_log_w(L"read masked", lpFileName);                 // ← 会写 shim.log
        WS_TRACE_FILE("CreateFile read denied by mask rule %ls", maskedBy);
        SetLastError(ERROR_ACCESS_DENIED);
        return INVALID_HANDLE_VALUE;
    }
}
```
存活日志确认规则**真的装载**了：

```
[winstage-shim][12996][3] read mask: declared=1 loaded=1 denyRules=29 allowRules=0 caseSensitive=0
[winstage-shim][12996][8] CreateFile overlay(read) …\fs\C\Users\Administrator\AppData\Local\Temp\__PSScriptPolicyTest_ztts3ibt.hxx.ps1
```

⚠ **纠偏任务书的一处措辞**："shim.log 里 read/open 命中 0" 若指**遮蔽拒绝行**，则实测是"没有出现 `read masked` 行"，
而**不是**"没有读事件"——`CreateFile overlay(read)` 行大量存在（上面第 8 行）。
两者含义完全不同：前者=没有敏感路径被子进程读；后者=读日志根本没开。
**owner 在引用这条证据时必须写清是哪一种。**

### 2.3 具体锚点

| # | 文件:行 / 函数 | 改动 |
|---|---|---|
| B1 | `dsh-plugin/staging-fs.mjs:1283-1297` `readText()` | 入口处加 `assert` 遮蔽判定（与写侧同源） |
| B2 | `dsh-plugin/staging-fs.mjs:1345-1366` `readByteRange()` | 同上（否则可绕过分片读） |
| B3 | `dsh-plugin/staging-fs.mjs:1262-1281` `lstat()` / `:1246-1260` `stat()` | 只记**计数**，不拒绝（元数据可读是既有残余边界，`audit.mjs:105` 已定义 `read-metadata-only`） |
| B4 | `src/workspace.mjs:434-455` `maskOf()`/`assertReadable()` | 抽出「判 + 记」两步：`maskOf()` 不变，新增 `noteSensitiveRead()` |
| B5 | `src/paths.mjs:192-…` `MASK_CLASSES` | **不改**（已覆盖，见 §2.2b）；仅在需要区分"该拦读"与"只记"时**新增一个字段** `readPolicy: 'deny'\|'note'` |
| B6 | `dsh-plugin/review-service.mjs`（`review.json` 组装处） | 新增顶层 `readVisibility` section |
| B7 | `src/audit.mjs:111-175` `READ_PROBES` / `:749-764` | `residual` 的措辞改为"读侧已可见（计数 N）"，与 B6 对齐 |

**`readVisibility` 建议形状**（新 section，与 `riskCounts` 并列）：

```json
"readVisibility": {
  "version": 1,
  "sensitiveReads": [ { "maskId": "dsh-credentials", "path": "…\\.dsh\\.credentials.yaml",
                        "count": 1, "firstAt": "…", "lastAt": "…", "channel": "ctx.fs" } ],
  "notified": { "inSession": true, "at": "…" },
  "limits": "黑名单式：只覆盖 MASK_CLASSES 命中的路径；未命中不等于安全"
}
```

### 2.4 如何避免刷屏与性能

- **去重键 = (maskId, maskKey(path))**，会话内每键**只累积计数**，`readVisibility` 只在 review 物化时写一次。
  与既有 `warnSplitOnce` 的 `warnedSplits` Set（`staging-fs.mjs:366, 869-880`，上限 200、超限 `clear()`）**同一范式**，
  但**改为计数**而非仅布尔，以便回答"读了几次"。
- **性能**：`maskReason()` 是一次 `canonical()` + 最多 29 条正则（`paths.mjs:561-570`）。
  实测代价必须量：`canonical()` 内部走 `realpathSync.native`（`paths.mjs:607` 注释自述），是**syscall**。
  ⇒ 读热路径上必须**先**做便宜的"路径前缀预筛"再 `canonical()`；或对同一 `(sessionId, path)` 的结果做**进程内 LRU 缓存**。
  这条不实测不得下结论：`[推断]` 缓存/预筛能把它压到可接受，**验证方法**见 §2.5 测试 4。
- **一次合并提示**：会话内**第一次**命中敏感读时，经 `logError`（`staging-fs.mjs:303-315`，会进 DSH 实例日志）
  发**一条**汇总语，其后只计数。绝不逐次发。

### 2.5 回归测试

1. **对拍测试**（离线）：对 `MASK_PROBES` 每一条（`paths.mjs:418-525`）断言
   `maskOf(path)` 与"从 `ctx.fs` 读是否被拒"**一致**。当前应**红**（`ctx.fs` 一律放行）。
2. **不破坏零痕迹**：断言正常态（未命中任何 `MASK_CLASSES`）下 `readVisibility.sensitiveReads` 为 `[]`
   且 review 字节与改动前**逐一相等**——这是"正常态零痕迹"契约的机器化表达。
3. **计数正确**：同路径读 N 次 ⇒ `count === N`，且 `readVisibility` 条目**只有 1 条**。
4. **性能门**：`$STAGE\_r3\` 内跑 N=10000 次 `readText`（替身基类），记录 p50/p99 增量；
   **门限由 owner 定**（我不擅自定阈值）。若 p99 增量超门限 ⇒ 强制启用 LRU 缓存。
5. **反绕过**：`readByteRange`（B2）与 `streamText` 必须与 `readText` 同判据——用 §2.2 的 grep 式断言：
   对 `staging-fs.mjs` 断言"每个读入口都出现遮蔽调用"，缺一个即红。

### 2.6 明确**不承诺**什么（必须写进 README）

1. **`MASK_CLASSES` 是黑名单，不是边界。** 不在表里的路径（自建 `secrets.env`、改名后的副本、压缩包内的凭据）**读得到**。
2. **不承诺防泄漏。** 读侧可见性是**审计**，不是**阻断**；一旦 `ctx.fs` 读到内容，模型上下文里就已经有了。
3. **不覆盖子进程之外的通道。** shim 的 C 侧读遮蔽（`ws_file.c:213`）只作用于**注入的 shell 子进程**；
   `src/store.mjs`、`src/audit.mjs` 等走 `node:fs` 直读的代码**不受任何遮蔽约束**（`staging-fs.mjs:205-208` 已自述同族边界）。
4. **不承诺 DPAPI 强度。** 实测 DPAPI 在本令牌下可往返（任务书证据）；本设计**不改**这一点，也不声称改善了它。
5. **计数可被绕过。** 若读发生在未注入的载体、或经 `node:fs` 直读，则不计数；`readVisibility` 的**缺席不等于没发生**。

### 2.7 风险与回滚

- **最大风险**：在 `ctx.fs` 读路径上加**硬拒**（B1/B2）会**改变既有可用性**——
  DSH 自身或工具可能读 `.dsh` 下文件（`web-url.txt`、`settings.yaml.imported` 都在 `dsh-home` 类里，`paths.mjs:492-494`）。
  一旦误伤，宿主可能**起不来**。⇒ 缓解：**分两步落**——先只**记**（`readPolicy:'note'`，B5 的新字段默认 note），
  观察一个会话的 `readVisibility` 命中面，**再由 owner 决定**哪些 maskId 升为 `deny`。
  这是本设计里**最需要 owner 决策**的一处（§4）。
- **次风险**：`canonical()` 的 syscall 进入读热路径导致读变慢 ⇒ 见 §2.4 性能门。
- **回滚**：纯新增 section + 新增调用点，回滚 = 回退 `staging-fs.mjs` 的读入口 + `review-service.mjs` 的 section。
  `readVisibility` 是**新增顶层键**，旧消费者按"未知键忽略"处理（`review.json` 现无 schema 校验，`[推断]`：
  需按 §2.5 测试 2 断言逐字节相等来确认无消费者受影响）。

### 2.8 工作量：**M**（B1-B3 小，B6 的 section 物化 + 5 项测试占大头；**不含**升为 deny 的策略决策）

---

## 问题 3：出站内容管控（当前为零）

### 3.1 一句话方案

**分层做、且如实收窄承诺**：能在**用户态明文**上拦的（shim 的 `ws2_32` 发送 hook，进程内加密前）就拦；
WFP 层**只能**做"目的地/端口/进程"维度的管控，**对 HTTPS 正文天然不可见**；
`netpolicy.mjs` 当前**只实现 OFFLINE**，`CONTROLLED_ONLINE`/`OBSERVED_ONLINE` 一律 `WFP_TIER_NOT_IMPLEMENTED`，
**因此"出站内容管控"的第一步不是加正则，而是先有一个能装的非 OFFLINE 档位**。若不做内核驱动/中间人证书，**正文级拦截在 HTTPS 下不可行**。

### 3.2 实测证据 `[已确证]`

**(a) shim 完全没有网络 hook**：`grep -rn "WSASend|ws2_32|WSAConnect|sendto|WSASocket|winhttp|InternetOpen" shim/src/` ⇒ **0 命中**。
IAT 目标表也确认只有文件/进程/注册表（`shim/src/ws_hook.c:30-84`）：

```c
static const WsHookTarget g_targets[] = {
    WS_TARGET(CreateFileW), … WS_TARGET(SetFileAttributesW),
    WS_TARGET(GetFileAttributesW), …          /* A1: existence/stat */
    WS_TARGET(NtOpenFile), WS_TARGET(NtSetInformationFile),
    WS_TARGET(MoveFileWithProgressW), WS_TARGET(CreateProcessW), WS_TARGET(CreateProcessAsUserW),
    WS_TARGET(RegCreateKeyExW), …             /* 注册表族 */
```
存活日志的 `families=` 也只有两个族：

```
[winstage-shim][12996][4] hooks installed: 180 IAT sites across 19 modules … families: file=on reg=on
```
⇒ **`net` 族不存在**。这与"伪造 AWS key 经 `node` HTTPS POST 被原样回显、零告警"完全一致。`[已确证]`（能力面）

**(b) `netpolicy.mjs` 只有 OFFLINE 一条路**：

```js
// src/netpolicy.mjs:436-437, 456-458
 * @param {'OFFLINE'|'CONTROLLED_ONLINE'|'OBSERVED_ONLINE'} [options.requested='OBSERVED_ONLINE']
 *   请求的档位；**默认 `OBSERVED_ONLINE`**，与现状一致（现状不阻断网络，默认不得回归成"阻断"）
export function resolveNetworkPolicy(options = {}) {
  requested = 'OBSERVED_ONLINE',
```
```js
// :546-563
// 非 OFFLINE 档位：planOfflineRules 以 WFP_TIER_NOT_IMPLEMENTED 明确拒绝构造计划。
if (planError.code === 'WFP_TIER_NOT_IMPLEMENTED' || !isOffline) { … }
```
⇒ **默认档位就是"不阻断"**，且非 OFFLINE 档位连**计划**都构造不出来。
全仓库**零**密钥形态检测：`grep -rn "BEGIN [A-Z ]*PRIVATE KEY|AKIA|ghp_|sk-ant" --include=*.mjs` ⇒ **0 命中**。
`wfp.mjs` 的导出全是结构常量（`FWP_DATA_TYPE`/`FWPM_FILTER_CONDITION0_SIZE`…，`src/wfp.mjs:68-216`），
即"能装过滤器"的机器在，**但没有任何正文条件**（WFP 的 condition 也没有"HTTP 正文"这一维度）。

### 3.3 方案（分三层，按可行性排序）

**L1（可行，推荐先做）— shim 用户态发送 hook**
在 `shim/src/ws_hook.c:30` 的 `g_targets[]` 增加 `net` 族：`send`/`WSASend`/`WSASendTo`/`connect`/`WSAConnect`/`WinHttpSendRequest`/`HttpSendRequestW`。
在 `send`/`WSASend` 的**明文缓冲区**上跑规则（此时 TLS 尚未加密，**内容可见**）。
命中的处理只能是 **fail-closed 阻断本次发送 + 记一条审计**（不能"改写内容"，会破坏 TLS/HTTP 语义）。
- 锚点：新文件 `shim/src/ws_net.c` + `winstage_internal.h:249-252` 旁新增 `ws_net_decide_send()`；
  `ws_hook.c:30` 的 `g_targets` 表；`ws_file.c:213` 的既有一致性范式（先判、再 `ws_log_w`、再 `SetLastError`）。
- **成本诚实说明**：IAT hook 只覆盖**静态导入** `ws2_32` 的模块。`node.exe` 经 libuv 用 `WSASend`，
  但**动态 `LoadLibrary("ws2_32.dll")+GetProcAddress`** 的载体（部分 .NET/Go/Rust 运行时、内嵌 TLS 栈）**绕过**。
  这是 IAT 方案的固有上限，不是实现缺陷。`[推断]`（需按 §3.5 测试 3 实测 node/curl/.NET 三载体的覆盖率）

**L2（部分可行）— `netpolicy.mjs` 的策略层**
新增 `CONTROLLED_ONLINE` 档位的**计划**：WFP 条件只能是
`FWPM_CONDITION_IP_REMOTE_ADDRESS` / `_REMOTE_PORT` / `_ALE_APP_ID`（进程）。
即能做"**只允许某进程访问某网段/端口**""**禁止明文 25/445 出站**"这类**目的地**管控。
- 锚点：`src/netpolicy.mjs:456` `resolveNetworkPolicy()` 的 `plan` 分支（`:540`）、`src/wfp.mjs` 的 `planOfflineRules`。
- **明确做不到**：**正文内容**。WFP 在 TCP/UDP 层，HTTPS 到那时已是密文；
  没有 TLS 中间人（自签根 + 信任库注入）就**不可能**看到 `AKIA…`。

**L3（不可行，必须写明）— "在传输层拦下 HTTPS 正文"**
**不可行 + 为什么**：正文在 TLS 记录层内，仅 `connect()` 的**目标主机名**（SNI，且仅当 hook 在明文 ClientHello 时可见）
对中间层可见。要拦正文只有两条路：(i) TLS 中间人（需改信任库 ⇒ 改 profile/系统，**超出本设计授权**且破坏"零痕迹"）；
(ii) 内核驱动做 TLS 解析（重资本、且 Win 版本脆弱）。
⇒ **退而求其次（推荐）**：只承诺 **L1 明文 hook + L2 目的地管控 + L3 的"承诺收窄"**，
并在 README 用一句话把边界写死（§3.4）。
- 补充：`L1` 之外还有一个**低成本高收益**的落点——**对 shim 已注入进程的 `connect()` 目标做 DNS/SNI 审计**（不阻断，只记），
  这能在**不解密**的前提下回答"哪个进程在往哪发东西"，是"出站可见性"的最小可用版本。

### 3.4 README 必须写明的"不提供的保证"（建议原文，供 owner 取用）

> ### 网络：我们**不**提供什么保证
> - **不提供 HTTPS 正文级内容管控。** WinStage 在传输层看不到 TLS 之内的任何字节。
>   任何"私钥/密钥不会外发"的说法都是**错的**：正文加密后仅端点可见。
> - **不提供网络隔离。** 默认档位是 `OBSERVED_ONLINE`（`src/netpolicy.mjs:437`），即**不阻断**。
>   只有显式请求 `OFFLINE` 且在绑定表/引擎/探针/GUID 全都可用时，才会装 WFP 过滤器；
>   任一前置缺失一律 `REFUSED`（fail-closed），**绝不**报 `enforced:true`。
> - **不提供全载体覆盖。** 出站 hook 基于 IAT 打补丁，**只覆盖静态导入网络 API 的模块**；
>   动态解析或自带 TLS 栈的载体绕过。审计的**缺席不等于没发生**。
> - **不提供内容改写。** 命中规则时只能**拒绝本次发送**并记录，不会"脱敏后转发"。

### 3.5 回归测试

1. **对照组必红**：复现 `echoedSecret` —— 在 `$STAGE\_r3\` 用 node 向 httpbin 发伪造 key。
   **本机受限车道约束**：若无出网，改用 `$STAGE\_r3\` 内一个**本机 listener**（`node:http` 绑定 127.0.0.1）
   作为"服务器原样回显"的等价物，断言 `echoedSecret===true`。当前必为 true（零管控）。
2. **L1 命中**：同一 listener，正文含 `-----BEGIN … PRIVATE KEY-----` 与 `AKIA[0-9A-Z]{16}`，
   断言 `send` 被拒 + 审计行出现。用**明文字段**确保在 hook 可见面内。
3. **L1 覆盖率实测**（关键，决定承诺措辞）：对 `node` / `curl` / `powershell -Command Invoke-WebRequest` / 一个 .NET 小程序
   各跑一次到同一 listener，逐载体记录"send 是否可见"。**这一步的产出直接决定 README 那句"全载体覆盖"能不能写。**
4. **L2 计划测试**（已存在的离线范式）：`tests\netpolicy.mjs`（81KB）已有 fail-closed 逐条断言；
   新增 `CONTROLLED_ONLINE` 时**必须**先让它的 `WFP_TIER_NOT_IMPLEMENTED` 断言红→改→绿，禁止绕过。
5. **fail-closed 不回归**：断言 `CONTROLLED_ONLINE` 在缺任何前置时仍 `REFUSED`，
   且**绝不**出现 `enforced:true`（对齐 `netpolicy.mjs:16-18` 的设计不变量）。

### 3.6 风险与回滚

- **最大风险**：L1 在 `send` 上做阻断会**误伤正常流量**（TLS 握手包、分片的 base64 恰好命中正则），
  且阻断点在任何重试之上 ⇒ 可能把"偶发失败"变成"永久失败"。
  ⇒ 缓解：正则必须**锚定且高精度**（PEM 块头、`AKIA[0-9A-Z]{16}` 这类定长前缀），先**只记不拦**跑一个会话，
  再按 owner 决策开拦。**不要把"检测"和"阻断"一次性上。**
- **次风险**：L2 装 WFP 过滤器是**系统级**状态（`FwpmFilterAdd0`），失败残留会污染宿主网络栈。
  ⇒ 必须依赖既有的 `tools\wmi-integrity-isolation.mjs` / `netpolicy` 回读核对（`netpolicy.mjs:649` 的 audit 分支）。
- **回滚**：L1 = 从 `g_targets[]` 摘掉 `net` 族 + 删 `ws_net.c`（重编 shim）；L3 无代码。
  **承诺层不可回滚**：一旦 README 写下"我们拦私钥"，事后的任何漏网都是**失信**而非缺陷 ⇒ 所以 §3.4 必须**先**写。

### 3.7 工作量：L1 **M**（新 C 文件 + 重编 + 覆盖率实测）；L2 **L**（WFP 计划 + GUI/策略）；L3 **0**（只是诚实声明）

---

## 4. 必须由 owner 决策的清单

1. **归一方向与布局②的存废**（§1.1/§1.7）：选 canonical=布局① 是否认可？**布局② 是"只读遗留"还是彻底废弃**？
   废弃要 owner 接受"shell 历史上写的文件从此只在 review 里可见、不再被 shell 看见"这一**行为变更**。
2. **`staged-ext` 是否也要归一**（§1.7）：现方案是"不迁移、按绝对键继续用"。若 owner 想统一成一种路径形状，**成本翻倍**且要动 `manifest` 的键模型。
3. **C-8 漂移守卫空转怎么处置**（§1.8）：改 profile（动 4 人改动区）／改判据／还是只记入 README？
4. **读侧先"记"还是直接"拦"**（§2.7）：这是**唯一可能让宿主起不来**的一处。我建议先只记一个会话，owner 看命中面再定。
5. **哪些 maskId 升为 `readPolicy:'deny'`**（§2.3 B5）：`.credentials.yaml` 与 `web-url.txt`/`settings.yaml.imported` 风险不同，
   但都在 `dsh-home` 类里——**粗粒度拒绝会误伤 DSH 自身**。
6. **性能门限**（§2.5 测试 4）：p99 增量容许多少？我不擅自定。
7. **`readVisibility` 的消费者**（§2.3 B6）：谁读这个 section？GUI 面板？还是只进 review 文件？决定它值不值得做。
8. **L1 是"先记"还是"直接拦"**（§3.6）：同上，建议先记一个会话。
9. **是否接受"不提供 HTTPS 正文管控"这个承诺**（§3.3 L3 / §3.4）：若 owner 要求正文级保证，
   **必须**上 TLS 中间人 ⇒ 要改信任库 ⇒ **超出本设计授权**，需单独立项。
10. **`session-97132a99` / `session-d6e30323` 的引用处置**（§0.3）：这两个会话树**已不在磁盘**。
    请 owner 决定是"从设计文档与 README 里撤掉这些 id"，还是"补一份可从现存证据复现的替代证据"。
    **不建议**保留不可复现的 id 作为唯一证据。

---

## 附：本文档的产出位置与真实性声明

- 首选落点 `ws\_sandbox-tests\r3\DESIGN-overlay-and-audit.md`（本文件）。
- 若宿主 `write` 只进了暂存而未落真实磁盘，则同一份内容另写 `$STAGE\_r3\DESIGN-overlay-and-audit.md`，
  并在交付说明里写明实际落点（见交付消息）。
- 本文档**未**启动/停止任何 3080/3081 服务，**未**改 profile，**未** approve/apply 任何候选，**未**改任何源码。
