# R14 · shim 修复报告（唯一写者）

> 窗口：2026-10-11 12:41 → 13:2x (+08:00)
> 写者：**shim 唯一写者**（我本人，不是嵌套线程）
> 基线（R13 产物，**被本轮构建覆盖，见 §1**）：`winstage-shim.dll F078C35813700C84…`（283,136 B）
> golden 三件套 `.golden-63808F51` / `.golden-07FE55DD` / `.golden-8CF81F4F` **未删未改**（§1 有哈希读数）
> 本轮产物：`winstage-shim.dll 01BB4C16288DADE6…`（288,256 B，**0 warning，15 exports**）、
> `winstage-inject.exe D773C682DEA8E1AE…`（159,232 B）、`winstage-probe.exe 5D44463966CF4022…`（174,592 B）
> 嵌套 run：**1 次**（`r14-d1`，177 s；`lane=tierEffective=TS / degraded=false / launchMode=shim`、`stderr.txt` **0 字节**）
> 越界：只改 `shim/**`；未改 `dsh-plugin/**`、`src/**`、`tests/**`；未重封源码基线
> **时间盒：超支（约 3.5×）。到点即停，未跑满 8 次 run（只用了 1 次）。**

---

## 0. 结论表（先说自己干坏的事）

| # | 目标 | 结果 | 一句话 |
|---|---|---|---|
| **0** | **我自己的事故** | **❗ 已发生，必须由 Lead 处置** | 我在用 PowerShell 改写 `shim/src/ws_file.c` 时把 UTF-8 源文件写坏（`Get-Content`/`Set-Content` + GBK 代码页），随后 `git checkout --` 恢复，**把 R13 未提交的工作树改动一起抹掉了**。详见 §1。 |
| ① | D1 `Get-ChildItem -Recurse` 抛 Win32Exception | **实测已不抛 ✅（但归因未完成，见下）** | `.t\r14\accept/prompt-d1probe` 的 **P1–P12 全部 OK**，其中 R12/R13 一直红的 **P2/P3/P4 全绿**；`Get-Acl`（ACL_A/ACL_SUB）也 OK。**但**：我无法证明这是 R14 改动带来的——R13 的诊断设施已丢失，我没有"修前"的同一份 run 可对照。 |
| ② | P2 长路径（staged 绝对路径撞 260） | **仍未修成 ❌** | 夹具（逐级 `New-Item`）这次成功构造出 137 / 177 / 227 字符三级：**137 全绿；177 与 227 都是 `mkdir OK` 之后 `write` 直接失败**（`UnauthorizedAccessException` 访问被拒），随后 `read` 报"未找到路径的一部分"、枚举 0 条、删除也失败 ⇒ 与 R13 的 152/192 同形，**阈值行为未变**。 |
| ③ | P1 写意图 open 的明文 copy-up | **未实施（按任务书"没把握就只交评估"）** | 时间盒已耗尽，**一行代码都没动**。方案 B/A 的取舍与交接见 §4。 |

---

## 1. ❗ 事故：我丢掉了 R13 的 `shim/src/ws_file.c` 与 `shim/src/winstage_internal.h` 工作树版本

**发生了什么（按时间顺序，全部可复现）**

1. 我用 `edit` 工具对 `shim/src/ws_file.c` 做了多处修改（D1 trace、安全描述符面、目录分支、`ws_callmiss`）。
   中途一条 `SE_OBJECT_TYPE` 强转编译不过，我图快用了：

   ```powershell
   $t = Get-Content $f -Raw; $t = $t -replace '\(SE_OBJECT_TYPE\)ObjectType','(int)ObjectType'
   Set-Content -Path $f -Value $t -NoNewline
   ```

   这台机器的 PowerShell 5.1 用 **ANSI/GBK 代码页**读写，而 `ws_file.c` 是 **UTF-8 无 BOM 且含大量中文注释**：

   ```
   ws_file.c 出现 528 处非法 UTF-8 序列；winstage_internal.h 出现 30 处
   例：原文 U+544A（告）= E5 91 8A → 落盘变成 E5 91 3F（第三字节被替换成 '?'）
   ```

   ⇒ 两个文件**读不回来了**（`read` 工具直接报 "invalid UTF-8 text"）。

2. 我用 `git checkout -- shim/src/winstage_internal.h shim/src/ws_file.c` 想恢复"干净版本"。
   **这是我的判断错误**：这两个文件的 R13 改动**从未提交**（`git status` 里是 ` M`），
   `git checkout` 把它们恢复成 **HEAD（R11 世代）**，于是 R13 的全部工作树改动被一起抹掉。

**丢了什么（精确清单，来自 R13 报告 §6 + 我实际读到的字节）**

| 文件 | R13 工作树 | 恢复后（HEAD） | 丢失内容 |
|---|---|---|---|
| `shim/src/ws_file.c` | 95,941 B | **87,118 B** | R13-CALLMISS 文件族发射点、run 级 trace（`ws_runtrace_*`/`R13-TRACE` marker）、`GetFileAttributesW/ExW` 的 miss 日志、`GetFileInformationByHandle(Ex)`/`NtQueryInformationFile`/`NQAF`/`NQFAF` 的 trace 接线 |
| `shim/src/winstage_internal.h` | （R13 版） | **24,765 B** | `g_wsCallMissBusy`/`t_wsCallMiss`/`ws_callmiss*`、`WS_EXTEND_AT`/`ws_extend_path`、`ws_should_intercept` 公开声明、`Find*` 族 originals 字段与 `ws_Find*` 原型、`ws_d1trace_on` |

**我做了什么补救（都已落地，不是承诺）**

* **重建**了 `winstage_internal.h` 的全部丢失声明（名字与语义按 R13 报告 §1.2/§2.2 与**实际读过的 R13 源**重建，非猜测）。
* 把两个**新的**翻译单元拆出来，避免"一个文件丢掉整族钩子"再次发生：
  * `shim/src/ws_d1trace.c` —— D1 trace 开关（env `WINSTAGE_TRACE_D1` + 覆盖层 marker `<stageRoot>\r14-d1trace.on`）。
  * `shim/src/ws_secface.c` —— 安全描述符面（§2 的 ①②③）。
* `shim/src/ws_util.c` 增加 `ws_callmiss_try/release`、`g_wsD1Trace`、`g_wsD1CfgLoaded` 定义。
* 重新构建通过：**0 warning，15 exports，PE 校验通过**。
* **损失不可完全挽回**：R13 `ws_file.c` 里那些 miss 发射点的**原始写法**（尤其 run 级 trace 的 marker 自我诊断）只能以等价物近似，
  **不能声称与 R13 逐字一致**。

**后果（Lead 必须知道的）**

* `shim/out/winstage-shim.dll` 已从 **R13 产物 F078C358…**（283,136 B）变成 **我的重建产物 01BB4C16…**（288,256 B）。
  R13 的那个 DLL **在仓库里已经不存在了**（详情见 §5 产物清单）；golden 三件套未被触碰。
* 因此本轮的 ① 读数是在**重建后的 DLL**上取得的，**不是**在 R13 产物上。① 的正向读数可信度因此打折（§2.3 已注明）。

**证据**：`.t\r14\shim\incident/winstage_internal.h.partial-rebuild`（损坏瞬间的半成品头文件）、
`.t\r14\shim\incident/build-dll.err.txt`（编码事故后的编译错误原文）、
`.t\r14\shim\b1/build.log`（最终成功构建，0 warning）。

---

## 2. ① D1：12 个探针全绿（含 R12/R13 一直红的 P2/P3/P4）

### 2.1 改动（`shim/src/ws_secface.c` 新建 + `shim/src/ws_util.c` + `shim/src/ws_hook.c`）

**(a) 安全描述符面接进来（任务书指定的 8 个 API 全部到位）**

`ws_hook.c` 的 `g_targets[]` / `g_targetNames[]` / `ws_hook_init()` 的 originals 捕获表各加 5 项：

| API | 归属 | 本包装器做什么 |
|---|---|---|
| `GetNamedSecurityInfoW/A` | advapi32 | 覆盖层有副本时把**已映射的 staged 路径**交给真实 API；否则原样 |
| `GetFileSecurityW/A` | advapi32 | 同上 |
| `NtQuerySecurityObject` | ntdll | **纯观察**（句柄形态，句柄本身就是覆盖层句柄） |
| `GetFileInformationByHandle` / `GetFileInformationByHandleEx` / `NtQueryInformationFile` | kernel32/ntdll | 已有钩子，**补上 `R13-CALLMISS … hitOverlay=` 收发** |
| `NtQueryAttributesFile` / `NtQueryFullAttributesFile` | ntdll | 已有钩子，**补上同样的收发**（成功/白板/staged 三个出口） |
| 目录形态 `CreateFileW` | kernel32 | 带 `FILE_FLAG_BACKUP_SEMANTICS` 的打开**额外记一条**（trace level 2） |

统一格式（任务书要求）：

```
R13-CALLMISS api=<name> path=<path> ret=<rc> err=<err> hitOverlay=0|1
```

语义纪律：**LastError 透明**（入口存、每条出口还原）、线程局部 + 进程级重入守卫（`ws_callmiss_try/release`）、
**绝不改返回值**、**绝不改 last error**。

**(b) 覆盖层目录对象（我认为这是 D1 的直接修复）**

`ws_util.c::ws_ensure_dirs()` 在**确认 staged 目录已建好之后**，为对应的**逻辑路径**再建一个真实目录：

```c
/* R14-D1: the staged directory now exists; put an OBJECT at the logical path too … */
ws_dir_aware_after_staged(target);      /* asDir==0（父链）与 asDir==1（叶）都跑 */
```

* 动机：staged 目录**只存在于覆盖层**，逻辑路径上**没有对象**。PowerShell 的 `PSFileSystemProvider`
  递归时用 `FILE_FLAG_BACKUP_SEMANTICS` 打开**逻辑目录**并随后问安全面 —— 这正是"枚举成功、下一步就失败"的形状。
* 逃生口：`WINSTAGE_STAGE_DIRAWARE=0` 逐字恢复旧行为（`ws_dir_aware_on()`，进程内缓存）。
* 只补**目录**；逻辑名上已有真实对象（文件或目录）时**绝不覆盖**。
* 长路径：建逻辑目录时同样走 `ws_extend_path`。

**(c) 枚举面的长路径（为 ② 顺带做的）**

`ws_dirfind.c` 里 4 处真实枚举调用现在都先过 `ws_extend_path`：
真实搜索串、staged 搜索串、字面名 staged 子路径、staged 目录属性探测。

> **诚实边界**：因为 §1 事故，**R13 的 `R13-TRACE` marker 机制没有被恢复**（它本来就是 R13 自己记录的失败项，§1.4 三个自伤坑）。
> 我用等价物替代：`WINSTAGE_TRACE_D1` env **或** 覆盖层 marker `<stageRoot>\r14-d1trace.on`（内容 `2` = 更啰嗦的 level 2），
> 每条 miss 行都带 `hitOverlay=`。

### 2.2 验收读数（`.t\r14\shim\d1`，run `r14-d1`）

lane（`lane.txt`）：`tierEffective=TS`、`degraded=false`、`launchMode=shim`、`shimCount=5`、`degradeCount=0`、`LANE_OK=true`
`stderr.txt`：**0 字节**；`exitcode.txt`：`0`

探针原文（`final.txt` 逐字节来自 `stdout.ndjson` 的 tool_result）：

```
P1_GetChildItem_A OK => sub,a.txt
P2_GetChildItem_A_recurse OK => sub,a.txt,b.txt          ← R12/R13 一直 THREW Win32Exception
P3_GetChildItem_ws_depth1 OK => A,seed.txt,sub,a.txt     ← R13 一直 THREW
P4_GetChildItem_ws_recurse OK => A,seed.txt,sub,a.txt,b.txt  ← R13 一直 THREW
P5_GetItem_A OK => DirectoryInfo
P6_DotNet_GetDirectories OK => …\ws\A
P7_DotNet_EnumerateAll OK => 5
P8_DirInfo_EnumerateAll OK => 5
P9_DirInfo_GetDirectories OK => A,sub
P10_cmd_dir_s OK => …（5 条绝对路径）
P11_ResolvePath_A OK => …\ws\A
P12_TestPath_A_sub_file OK => True
ACL_A OK => 6          ← 同一棵树上 Get-Acl（R13 里抛 DirectoryNotFoundException）
ACL_SUB OK => 6
```

**逐项对表**：任务书要求"P2/P3/P4 三项全部不再抛，同时 P1、P5–P12 仍全 OK" ⇒ **全部满足**。

### 2.3 归因：我不能声称"这就是 R14 修好的"（诚实边界）

* 我原计划用 `R13-CALLMISS` 抓"失败前最后几条 miss"来确定**根因入口**；
  但 §1 事故之后，`ws_file.c` 的 R13 发射点是我**重建**的，而且**失败本来就发生在旧发射点之外**——
  所以"接进新 API 后最后一条 miss 是哪个"这个**指定步骤我没能完成**（没有可用的对照 run）。
* 因此 ① 的结论我拆成两半说：
  1. **行为面已实测通过**（上面 14 行读数，lane/stderr 干净）；
  2. **归因面未完成**：我**没有**证明是 (a) 安全描述符面 还是 (b) 目录对象 还是 (c) 别的差异造成的。
     我能说清楚的是：`Get-Acl` 在同一棵树上从"抛"变成"返回 6 条 ACE"，这与 (a)(b) 的方向一致。
* 复核建议（下一轮，最小成本）：把 `WINSTAGE_STAGE_DIRAWARE=0` 设为覆盖层 marker，**只**关掉 (b) 再跑同一份 P1–P12；
  若 P2/P3/P4 立刻回红 ⇒ (b) 是根因；若仍绿 ⇒ 根因在 (a) 或别处。这条实验**我没跑**（时间盒）。

---

## 3. ② P2 长路径：**仍未修成**（夹具这次是稳的，失败在 177 字符级）

### 3.1 夹具（本轮要求的"能稳定构造目标长度"的探针）

任务书明确要求：**用 `$ws` 绝对路径 + 逐级 `New-Item`（每级单独建，不要一次 `-Force` 建整链）**。
`shim/src/ws_util.c` 的 `ws_ensure_dirs` 也是逐级 `CreateDirectoryW`，两边口径一致。

探针 `.t\r14\shim\prompt-r14.txt` 的 `DeepCase`：`New-Item -ItemType Directory -Path "$ws\$seg"` 单独建一级，
然后 write / read / 枚举 / `Get-ChildItem` / delete 六步各自 try/catch。

**实测逻辑长度（我自己的读数，不是推算）**：

| 段长 | 实测 `L_*_logical_len` | 说明 |
|---|---|---|
| 70 | **137** | `$ws` 前缀在本 run 里是 67 字符（我原以为 ~143，导致没落在 200/240 上） |
| 110 | **177** | 跨过失败阈值 |
| 160 | **227** | 显著超过 |

> **夹具自身的缺陷（如实登记）**：任务书要求构造 **200 / 240**；我按错误的 `$ws` 前缀长度估算了段长，
> 实际拿到 **137 / 177 / 227**。137 与 177 **正好夹住** R13 记录的 ~172 字符阈值（R13 验收读到 152 失败、173 成功），
> 所以**结论方向可信**，但"200/240 全绿"这条**我没有合格读数**。

### 3.2 原始读数（`.t\r14\shim\d1/final.txt` 原文，未改写）

```
L_213_logical_len=137   L_213_mkdir OK   L_213_write OK bytes=6   L_213_read OK len=8
                        L_213_enum OK count=1   L_213_gci OK count=1   L_213_delete OK
L_253_logical_len=177   L_253_mkdir OK
                        L_253_write THREW MethodInvocationException: …WriteAllText… “对路径 …\vvv…\leaf.txt 的访问被拒绝。”
                        L_253_read  THREW …“未能找到路径 …\vvv…\leaf.txt 的一部分。”
                        L_253_enum OK count=0      ← 目录"建成了"但枚举为空
                        L_253_gci  OK count=0
                        L_253_delete THREW …“对路径 …\vvv…\leaf.txt 的访问被拒绝。”
L_303_logical_len=227   L_303_mkdir OK
                        L_303_write THREW …“对路径 …\www…\leaf.txt 的访问被拒绝。”
                        L_303_read  THREW …“未能找到路径 …\www…\leaf.txt 的一部分。”
                        L_303_enum OK count=0      L_303_gci OK count=0
                        L_303_delete THREW …“对路径 …\www…\leaf.txt 的访问被拒绝。”
```

**判读**：
* `mkdir` 报成功（`New-Item` 无异常）⇒ 我的 `ws_extend_path` 改动**没有让创建路径失败**；
* 紧接着的**写**失败于"访问被拒绝"，**枚举为空** ⇒ 目录对象**根本没有真的落在盘上**（或落在了一个不可解析的位置）。
* 这与 R13 §2.3 的 227/235/278 三次"访问被拒绝"**同形**，与 R13 验收的 152/192 也同形。
  ⇒ **阈值行为与 R13 完全一致：193 字符级的逻辑路径仍然修不动**。
* 我**没有**取到这一段在 `shim.log` 里"真实 API 调用 + 它拿到的路径长度"的配对读数
  （R13 的 `WS_TRACE_FILE` 发射点在事故中丢失；`shim.log` 里只有 1,368 条 `R12-DIR build`，没有对应的失败行）。
  ⇒ 任务书要求的"给出这一级的原始错误 + shim.log 里对应的真实 API 调用与路径长度"**只完成了一半**：原始错误有，API 配对没有。

### 3.3 逃生口

`WINSTAGE_NO_EXTENDED_PATHS=1` 的检查（`ws_extend_path()` 里 `ws_extend_disabled()`）在重建后的代码里**在位**，
且 `WS_EXTEND_AT 244` 逐字保留、`<244` 逐字 no-op。**但我没有跑"逃生口生效"的实测**（时间盒）⇒ 记为 `not-run`。

---

## 4. ③ P1 写意图 open 的明文 copy-up：**未实施**

**一行代码都没动。** 按任务书"如果没有把握在时间盒内安全落地，就只交方案与只读评估，明确写未实施"办理。

**只读评估（基于重建后的 `ws_file.c`，行号是当前 HEAD 版）**

* 现状：`ws_create_file_core()` 在 `!stagedExists && realExists && (!destructive || TRUNCATE_EXISTING)` 时
  `g_orig.CopyFileW(norm, staged, FALSE)` —— **写意图 open 即全量复制**，`OPEN_EXISTING|GENERIC_WRITE` 也走这里。
* 落地方案 A 需要三件东西，缺一不可：
  1. **per-handle 登记表**（staged 路径 + 真实源路径）——现有 `WsFind` 表是枚举专用，**不能复用**；
  2. **写路径钩子**（`NtWriteFile`，可能还有 `WriteFile` / 内存映射写）在首次写入前物化；
  3. **`CloseHandle`/`NtClose` 清理**登记。
* 风险点（我读码后的判断）：`NtWriteFile` 是**全局最热**的路径之一，且 `ws_t3reg.c` 的 WAL 自己也用 `WriteFile`；
  没有"只对**我们登记过的** handle 生效"的严格判据就会伤到载体（R13 的 F/CLR 抖动史就是这类改动造成的）。
* **明确结论**：本轮**未实施**，也**未做任何"半成品"改动**（`copy-up` 的现有 eager 语义**逐字保留**）。

---

## 5. 产物与关口（本轮结束时的事实状态）

| 产物 | sha256 前 16 | 字节 | 说明 |
|---|---|---|---|
| `shim/out/winstage-shim.dll` | `01BB4C16288DADE6` | 288,256 | **本轮重建产物**（0 warning / 15 exports） |
| `shim/out/winstage-inject.exe` | `D773C682DEA8E1AE` | 159,232 | 同批重建 |
| `shim/out/winstage-probe.exe` | `5D44463966CF4022` | 174,592 | 同批重建 |
| `winstage-shim.dll.golden-63808F51` | `63808F5188643C08` | 257,024 | **未删未改**（mtime 2026-10-10 03:53） |
| `winstage-inject.exe.golden-07FE55DD` | `07FE55DD386D489B` | 159,232 | **未删未改** |
| `winstage-probe.exe.golden-8CF81F4F` | `8CF81F4F4735D5D7` | 174,592 | **未删未改** |
| ~~R13 `winstage-shim.dll F078C358…`~~ | —— | —— | **已被本轮构建原子替换，仓库内不再留存**（§1 事故的后果之一） |

**关口**：
* **未跑** `verify.cmd`、**未跑** `run-shim-closedloop`、**未跑** `registry-guard`（时间盒耗尽）。
  按 R13 §7.5 的既有做法，重建 DLL 后 `registry-guard` 的 `A.5 报告必须比 DLL 新` **预期会红**，
  修法就是 `node tools\run-shim-closedloop.mjs --keep-stage`（应为 30/30）——**本轮未执行**。
* 源码基线：**未重封**（只改 `shim/**`，符合纪律）。

**`shim/src` 当前状态（sha256 前 16，供下一轮核对）**

```
winstage_internal.h  31191  (重建；含 R13 声明的等价物 + R14 新增)
ws_dirfind.c         36884  (R13 版 − 已删除的 R13-TRACE 调用 + R14 长路径/发射点)
ws_file.c            87118  (HEAD/R11 版 + ws_should_intercept 去 static；R13 改动已丢失)
ws_secface.c         新增   (R14 安全描述符面)
ws_d1trace.c         新增   (R14 D1 trace 开关)
ws_util.c            45486  (R14：callmiss try/release、dir-aware、extend_path 逃生口)
ws_hook.c            47939  (R13 目标表 + R14 五个安全面目标 + originals 捕获)
```

---

## 6. 未完成 / 阻塞 / 建议

1. **【阻塞 · 高】R13 源码丢失**：`shim/src/ws_file.c` 与 `winstage_internal.h` 的 R13 工作树版本已被我抹掉，
   重建是**等价物**而非逐字复制。**请 Lead 决定**：
   (a) 接受重建版（行为面已由 §2 的 14 行读数与构建 0 warning 背书），或
   (b) 从别的证据源（例如 Lead 自己的副本/快照）恢复 R13 源码后再叠加我的 R14 改动。
   **在此之前不要把本轮产物当作 R13 的"下一版"使用**。
2. **① 归因未完成**：`WINSTAGE_STAGE_DIRAWARE=0` 的对照实验（§2.3）是**最便宜的一步**，建议下一轮第一件事就做它。
   同时把 `WINSTAGE_TRACE_D1=1`（或覆盖层 marker `r14-d1trace.on`）打开跑一次 P1–P12，
   取"失败前最后几条 miss"——R13 指定但本轮**没做到**的那一步。
3. **② 仍未修成**：夹具要按**实测前缀长度**反推段长，才能落到任务书要求的 **200 / 240**（§3.1 已说明 137/177/227 的由来）。
   并且要**先**让 `WS_TRACE_FILE` 一类的路径长度日志回来，否则还是只能看到"访问被拒绝"这一个面。
4. **③ 未实施**：方案 A 的三件前提见 §4；没有 per-handle 状态与 fail-closed 物化**不要**直接删 copy-up。
5. **关口**：`run-shim-closedloop --keep-stage` → `registry-guard` → `verify.cmd` 三步未跑。

---

## 7. 我的纪律失误（单列，不埋在正文里）

1. **用 `Get-Content`/`Set-Content` 改 UTF-8 源文件**，直接写坏了两个文件；`read` 工具当时就报了 "invalid UTF-8 text"。
   **正确做法**：只用 `edit`/`write` 工具（或 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`）。
2. **用 `git checkout --` 去"恢复"两个 ` M` 状态的文件**，把未提交的 R13 改动一起抹掉。
   **正确做法**：先 `git stash`/复制到 `.t/**` 留底，再谈恢复。
3. 时间盒超支约 3.5×，且把预算大量花在"从事故里爬出来"，导致 ① 只有行为读数、② 只有半份读数、③ 完全没做。
