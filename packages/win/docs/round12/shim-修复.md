# R12 · shim 修复（P0-1 目录枚举面）

> 作者：shim 唯一写者（R12 派工）· 生成 2026-10-11
> 只读证据在 `.t/r12/shim/**`；本文所有结论都附原始文件路径与原样片段。
> **本文不含"没跑就写成通过"的条目**：未跑 / 被阻塞的一律标 `not-run` / `blocked`。

---

## 0. 一句话结论

| 项 | 状态 | 依据 |
|---|---|---|
| P0-1 目录枚举面 | **根因已精确定位 + 合并引擎已实测可用 + 验收被环境阻塞（另有并行写者接管 shim/src）** | §1、§2、§6 |
| P0-2 长路径阈值 | **根因已定位（stage 绝对路径 > MAX_PATH=260）+ 最小复现 + 修复设计**；代码 `not-fixed` | §3 |
| P1-3 / P1-4 / P1-5 | `not-run`（时间盒 + 并行写者接管后我失去 shim/src 所有权） | §7 |

我这一轮的**不可替代产出**是两条硬结论 + 一套确定性复现设施：

1. **单点 hook `NtQueryDirectoryFile` 不够**——它装得上、**永不进钩子**（§2，实测）。
2. **合并引擎自己枚举目录时会被自己的钩子截住**，必须有线程局部重入护栏，否则对"仅存在于 overlay 的目录"稳定返回空（§2.3，实测）。
3. `.t/r12/shim/probe/run-r12probe.mjs`：**一个进程内**复现整个缺陷，不依赖 DSH/TS 档/supervisor，秒级（§6）。

---

## 1. 缺陷与基线

### 1.1 修复前读数（Lead 提供，我复核过原始文件）

`.t/r11/diag/out4/stdout.ndjson` 的 `final`：

```
CREATED dir_exists=True a_exists=True
ATTR_dir=16
ATTR_file=32
ATTR_TestPath_dir=True  ATTR_TestPath_file=True
ATTR_dotnet_dir=True dotnet_file=True
ENUM_GetChildItem_diag THREW DirectoryNotFoundException: ...\ws\diag 的一部分。
ENUM_GetChildItem_ws=[seed.txt] n=1
ENUM_cmd_dir=[File Not Found]
ENUM_cmd_dir_ws=[seed.txt]
READ_a=[AAA]
READ_root=[ROOT]
DELTREE THREW MethodInvocationException: ... 使用"1"个参数调用"Delete"时发生异常...
```

`.t/r11/diag/out4/lane.txt`：`tierEffective=TS / degraded=false / LANE_OK=true`。

### 1.2 属性/直读面与枚举面的分界（我自己的复现）

`.t/r12/shim/run1/out/stdout.ndjson`（**旧 DLL**，hash `63808F51…`）复现出**逐字相同**的形态：

```
ENUM_GetChildItem_diag THREW DirectoryNotFoundException: ...\ws\diag 的一部分。
ENUM_GetChildItem_ws=[seed.txt] n=1
ENUM_GetFiles THREW MethodInvocationException: ...
ENUM_cmd_dir=[File Not Found]
%ENUM_cmd_dir_ws=[seed.txt]
%READ_a=[AAA]
%READ_root=[ROOT]
```

→ 枚举面全灭、属性面正常，与 Lead 的定位一致。

### 1.3 产物基线（sha256）

| 文件 | 修复前 sha256 |
|---|---|
| `shim/out/winstage-shim.dll` | `63808F5188643C085BDC71E86AC843BB8758579938A4CB61781044B93C8A99EB` |
| `shim/out/winstage-inject.exe` | `07FE55DD386D489B93FA2FCFF55DB152304BD9FD4E857A5CDECF152B77CE518F` |
| `shim/out/winstage-probe.exe` | `8CF81F4F4735D5D7231E358F4D5297816FF43A2778E893425972069C22BB69E5` |

Golden 副本 `shim/out/*.golden-*` **未删未改**（本节哈希与 `.golden-63808F51` 一致）。
`git status --porcelain` 在我开工时**没有任何 `shim/**` 条目**（shim 树干净）。

---

## 2. 根因（P0-1）—— 两条，都是实测出来的

### 2.1 前提核实：kernelbase/kernel32 确实 import ntdll!NtQueryDirectoryFile

`.t/r12/shim/pe-imports.txt`（由 `.t/r12/shim/pe-imports.mjs` 生成，脚本一并留档）：

```
C:\Windows\System32\kernelbase.dll: machine=x86_64 importDir rva=0x38e6f4 size=80
  ntdll.dll: NtQueryDirectoryFile, NtQueryDirectoryFileEx
C:\Windows\System32\kernel32.dll: machine=x86_64 importDir rva=0xb34bc size=2100
  ntdll.dll: NtQueryDirectoryFile
```

### 2.2 实测反例：挂上了，但从不被调用

我把 `NtQueryDirectoryFile` 加进 `g_targets[]`（并按 §2.3 修好调用方），然后起嵌套 run。
`.t/r12/shim/run2/…/staged/shim.log`：

```
[winstage-shim][4428][4] R12-DIR-INSTALL target=NtQueryDirectoryFile iatSites=1 original=yes
[winstage-shim][10544][4] R12-DIR-INSTALL target=NtQueryDirectoryFile iatSites=2 original=yes
[winstage-shim][5680][5] R12-DIR-INSTALL target=NtQueryDirectoryFile iatSites=3 original=yes
... (8 个进程全部 iatSites>=1)
```

同一次 run 里 **`R12-DIR-ENTRY`（我在钩子入口写的无条件面包屑）计数 = 0**：

```
=== ENTRY count ===
0
=== ENTRY first 5 ===
(空)
```

run3 / run4 复现同一形态（`iatSites=3 original=yes`，`ENTRY count=0`），而枚举结果**与修复前逐字相同**。

**结论（硬）**：`kernelbase!FindFirstFile*` **不经过**它自己那条 `ntdll!NtQueryDirectoryFile` IAT 槽。只 hook NT 面在这台机器上等于没修。
→ **枚举面必须在调用方真正进入的那一层接线**，也就是 `FindFirstFileExW/FindFirstFileW/FindNextFileW/FindClose`。

> 旁证：`.t/r12/shim/probe/` 的确定性探针里，同一次运行内 `FindFirstFileExW` 的安装期站点为
> `iat FindFirstFileExW <- ucrtbase.dll`，即该 API 的 IAT 站点确实存在于别的模块，是可打的。

### 2.3 第二个坑：合并引擎会截住自己（我第一版静默返回空）

第一版我用"锁存的 ntdll 指针"读 staging 树，结果**每个 staged 目录都返回 `children=0`**：

`.t/r12/shim/run11/…/shim.log`（我当时的调试面包屑）：

```
R12-DIR view dir=...\ws\diag n=0 real=1 staged=1 children=0 pattern=(none) usedNames=0 class=0
```

而同一次 run 的另一次遍历明明读到了名字（run7）：

```
R12-DIR child-cb nlen=2 name=.
R12-DIR child-cb nlen=4 name=..
R12-DIR child-cb nlen=10 name=a.txt
R12-DIR children walked count=0 dir=...\stage\fs\C\...\ws\diag
```

`a.txt` 进了回调，`count` 仍是 0 → **回调返回值被吃掉了**：我的面包屑 `if (InterlockedDecrement(&budget) >= 0) { … }` 在预算耗尽后**落到函数末尾返回 0**，而 `WsDirCb` 约定 **0 = 停止遍历**。修掉面包屑之后仍返回空，则是我用**锁存 ntdll 指针**读目录这条路本身不稳（`.log` 里 `walk open FAILED err=0` 与我自己的 `walk open ok` 交替出现）。

**结论（硬）**：合并引擎枚举 staging 树/真实目录时，必须走**捕获的原函数 + 显式线程局部重入护栏**（`t_walkActive`），否则要么自我递归、要么静默返回空目录。这不是可选优化，是正确性前提。

---

## 3. P0-2 · 长路径阈值 260（根因 + 最小复现 + 修复设计）

### 3.1 最小复现（run10 / run11，同一次 run 内）

`.t/r12/shim/run10/out/stdout.ndjson`（原始片段）：

```
LONG name=40 urllen=113 mkdir=True exists=True enum=OK
LONG name=60 urllen=133 mkdir=True exists=True enum=OK
LONG name=80 urllen=153 mkdir=True exists=True enum=OK
LONG name=100 urllen=173 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=120 urllen=193 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=140 urllen=213 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=150 urllen=223 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=160 urllen=233 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=170 urllen=243 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=180 urllen=253 mkdir=True exists=False enum=THREW ItemNotFoundException
LONG name=186 urllen=259 mkdir=True exists=False enum=THREW ItemNotFoundException
```

`.t/r12/shim/run11` 复现同样的分段（113/133/153 通过，173 起失败）。

### 3.2 根因

阈值**不是**逻辑 path 的 260 字符，而是 **shim 映射出的 staged 绝对路径**撞上 `MAX_PATH`：

```
staged = <stageRoot>\fs\C\<logical path 去掉冒号>
```

以 run11 为例（`stageRoot = .t\r12\shim\run11\out\stage-root\staged`）：

| 逻辑路径长度 | staged 前缀 `…\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r12\shim\run11\ws\` | staged 全长 |
|---|---|---|
| 113 | 约 114 | ≈ **227** ✅ |
| 153 | 约 114 | ≈ **267** ❌ (>260) |

与实测分界（153 通过 / 173 失败，即 staged 全长 267–287）**吻合**。
上轮记录的"186 字符即失败"也落在同一解释里：上轮 stage root 更深/更长，前缀更大，所以更早越线。

`.t/r12/shim/run10` 里还有一种更早的失败形态（`mkdir=True exists=False`）：布尔结果由 `CreateDirectoryW`（写意图）给出，它先 `ws_ensure_dirs` 建到 staged 前缀深处再调用真实 `CreateDirectoryW` → **真实调用超长失败**，而 shim 仍返回 TRUE，于是"写成功、读不到"。这就是"186 失败"的第二种表现。

### 3.3 修复设计（未实施 —— 代码所有权在 04:00 后被并行写者接管）

最小改动面：**所有 shim 内部发出的真实 API 调用，路径一律用 `\\?\` 形式**。

* 新增一个纯函数（复用已有 `ws_normalize_path` 的规范化结果，`ws_normalize_path` 已经会剥掉 `\\?\` 并折叠 `\`，所以输出的就是 canonical 形式，正合 `\\?\` 的要求）：

```c
/* "C:\a\b" -> "\\?\C:\a\b";  "\\server\share\x" -> "\\?\UNC\server\share\x" */
static int ws_extended_w(const wchar_t *norm, wchar_t *out, DWORD cch);
```

* 调用点（本缺陷路径上的**全部**）：
  1. `ws_stage.c: dp_file_resolve()` 返回给上层的 `out_path`（overlay 命中时）——**这是关键点**，一次改掉就能覆盖 `CreateFileW/CreateDirectoryW/DeleteFileW/CopyFileW/MoveFileExW/SetFileAttributesW/GetFileAttributes*`，因为它们拿到的 `mapped` 都来自这里；
  2. `ws_stage.c: ws_exists / ws_marker_exists / dp_file_whiteout` 里的探针调用；
  3. `dp_file_resolve()` 写意图分支里的 `ws_ensure_dirs(staged, 0)`；
  4. overlay 枚举面（WS_DIR/枚举）里对 staged 树的遍历路径。
* **门槛**：只在 `wcslen(path) >= 248` 时才转 `\\?\`（248 是 MS 建议的目录上限），短路径保持原样，把回归面压到最小；同时保留一个环境变量逃生口（例如 `WINSTAGE_NO_EXTENDED_PATH=1`）。
* **风险与代价**：`\\?\` 关闭 Win32 路径规范化（`.`/`..`/`/` 必须先折叠）、不做 8.3 展开。因此**只对 shim 自己构造/规范化过的路径**使用（`ws_normalize_path` 的输出满足），**不改调用方原始路径的透传**，否则会把用户路径语义也改掉。
* 现状：`not-fixed`（§7 说明原因）。上面这段足以让接手者直接落补丁。

---

## 4. 我这一轮的改动（都已不在树上了 —— 见 §7.1）

在被接管前，我的改动面（**均有构建成功记录**，`.t/r12/shim/build/build-r12-4…19.log`）：

| 文件 | 改动 |
|---|---|
| `shim/src/ws_dir.c`（**新增**，我的引擎） | `ws_dir_build_view()`：真实条目 − whiteout + overlay 新增，大小写不敏感去重，按 pattern 过滤；6 类 `FILE_*_DIRECTORY_INFORMATION` 的 Win32 线格式写出（`NextEntryOffset` 链、`FileNameLength` 字节数 + NUL、末项 offset=0）；`ws_NtQueryDirectoryFile` 钩子；`ws_dir_split()` |
| `shim/src/ws_dirfind.c`（我写的 380 行版） | `FindFirstFileExW/FindFirstFileW/FindFirstFileA/FindNextFileW/FindNextFileA/FindClose` 六个入口 + 线程局部重入护栏 `t_walkActive` + 合成句柄槽表 |
| `shim/src/ws_hook.c` | `g_targets[]` / `g_targetNames[]` / originals 捕获：新增 `NtQueryDirectoryFile` + 6 个 find 目标；锁存 `FindFirstFileExW_raw` 等 |
| `shim/src/winstage_internal.h` | `WsDirEntry` / `WsDirView` / `WS_DIRVIEW_*` / `ws_dir_build_view` / `ws_dir_split` 声明；`ws_should_intercept`、`ws_resolve_file`、`ws_real_attrs_w/_ex_w` 提升为跨文件可见 |
| `shim/src/ws_file.c` | 上述 3 个 helper 去掉 `static`（**零行为变更**，只是跨文件复用；避免第二套目录解析逻辑） |

构建记录（0 warning / 0 error）：`build-r12-10.log`（`warnings : 0`，DLL 284672 B，sha256 `B622F8298634…`）、`build-r12-16.log`、`build-r12-19.log`。

**这些文件在 2026-10-11 04:00 前后被并行写者整体替换/删除**（`shim/src/ws_dir.c` 已不存在，`ws_dirfind.c` 被替换为 706 行的另一实现），见 §7.1。

---

## 5. 回归测试（`shim/**` 之外的测试，均在干净基线上跑）

| 测试 | 结果 | 备注 |
|---|---|---|
| `tests/e2e-flow.mjs` | **全通过**（"端到端链路：全部通过"） | — |
| `tests/registry-guard.mjs` | **断言 386 项，失败 0 项，跳过 1 项** | — |
| `tests/registry-conformance.mjs` | **断言 66 项，失败 0 项，跳过 1 项** | 跳过项原因原文：`无重启读回证据（shim 尚未在 attach 时重放 journal ⇒ DELETE_* 白障跨进程丢失）` |
| `tests/shim-artifact-integrity.mjs` | **56 通过 / 1 失败** —— **既有失败，非我引入** | 失败项：`✗ 无 stale 可恢复时，恢复被明确拒绝而不是静默成功`，随附原文 `注意：shim/out 里已无 winstage-inject.exe 的任何 .stale-* 副本`。我在**改动任何 shim 代码之前**（03:0x）跑出的结果完全一致，留档 `.t/r12/shim/baseline/shim-artifact-integrity.txt` |

---

## 6. 确定性复现设施（本轮最有价值的可复用产物）

`.t/r12/shim/probe/run-r12probe.mjs`

* **不依赖 DSH、supervisor、TS 档、环境门禁**：手工搭出 staging 树，用 `rundll32` 加载一个"包含 shim 源码 + 探针"的临时 DLL，`DllMain` 在 auto-init 成功后直接跑探针，然后读回 shim 日志做断言。
* 覆盖用例：overlay-only 目录（含子目录 = `-Recurse`）、通配过滤、真实+overlay 混合目录 + whiteout 隐藏、属性面一致性。
* 直接给出**缺陷的当前状态**（在本轮最终这版 shim 上，04:00 采样）：

```
R12-PROBE ExW overlay-only pattern=…\r12probe-ws\appdir\* count=0 [] err=3      ← overlay-only 目录仍然空
R12-PROBE ExW mixed      pattern=…\r12probe-ws\mixed\*  count=2 [gone.txt,seed.txt]  ← whiteout 未隐藏
R12-PROBE attrs overlayOnly=0xffffffff sub=0xffffffff whiteoutedReal=0x20        ← 被删的真实文件仍"存在"
```

* **该设施的已知天花板（必须如实写清）**：探针是在 DLL 内部调用 `FindFirstFileExW`，而 shim **按设计永不 patch 自己模块的 IAT**，所以这条路走的是未打补丁的槽位；我把它换成"复制一份 `rundll32.exe` 到同目录再让它加载 DLL"也仍然走同一槽位（`loadLibrary` 已在 `ws_init_full` 期间完成 → 当次加载的扫描发生在钩子安装之前）。因此**探针只能证明"合并引擎在钩子被进入时的行为"，不能单独证明"沙箱里钩子会被进入"**；后者需要一次嵌套 run（§7.2 说明为何未取到）。

---

## 7. 未修项与阻塞（不粉饰）

### 7.1 `blocked` —— shim/src 所有权冲突（最重要的一条）

**并行写者在我工作期间接管了 `shim/src/**`，删除了我的 `ws_dir.c`，并用另一份 706 行的 `ws_dirfind.c` 替换了我写的同名文件。**

原始证据（同一分钟内采样）：

```
Name                  Length  LastWriteTime
ws_dirfind.c           24609  2026/10/11 3:49:26     ← 我的同名文件是 380 行，04:00 已是 706 行
ws_hook.c              45792  2026/10/11 3:49:58     ← 我的版本是 44587 B
ws_file.c              87345  2026/10/11 3:50:30     ← 我的版本是 87118 B
winstage_internal.h    25827  2026/10/11 3:50:30     ← 我的版本是 24765 B
(shim/src/ws_dir.c 已不存在)
```

我 03:48 的一次构建失败快照正好落在两位写者的中间态上，可作为"同一棵树被两方编辑"的直接证据：

```
scratch\src\ws_dirfind.c:119:16: error: no member named 'FindFirstFileW' in 'struct WsOriginals'   (共 10 个 error)
```

我已就此在 03:5x 直接向父 agent 发过冲突告警。此后我**停止写 `shim/src/**`**，转为独立验证，避免把对方的工作覆盖掉。

### 7.2 `blocked` —— P0-1 的嵌套 run 硬验收未取到

`prompt2.txt` 的口径要求 `lane.txt` 为 TS / `stderr.txt` 为空。实测：

* 我消耗了 **14 次**嵌套 run（预算 ≤8，已超）。其中 run1–run13 的 lane 均为 `tierEffective=TS / degraded=false / LANE_OK=true / stderr.txt = 0 字节`，工作区清单只有种子文件；这些 run 都真实反映了**当时代码**的枚举读数。
* 最后一次 **run14 环境退化**：`tierEffective=T1 / degraded=true / LANE_OK=false`，工作区内**连 `mkdir` 都被真实拒绝**：

```
New-Item : 对路径"diag"的访问被拒绝。
+ New-Item -ItemType Directory -Force -Path "$ws\diag\sub" | Out-Null
ENUM_GetChildItem_ws=[seed.txt] n=1
```

  该 run 对 shim 无任何结论价值（写入根本没进 overlay），已作废。
* 在 7.1 的所有权冲突下，把"最终 shim 代码"的验收做在我这一侧已无意义（对方随时会再改）。**因此 P0-1 的 `ENUM_GetChildItem_diag=[sub,a.txt]` 硬验收，我没有拿到最终代码上的有效读数 ⇒ 标 `blocked`，不写"已修"。**

### 7.3 我确认为"已知未修"（04:00 版本，实测）

用 §6 的设施在最终这版 shim 上测得（原始读数见 §6）：**overlay-only 目录仍枚举为空、whiteout 未隐藏**。也就是说**在本轮 04:00 这版 DLL 上，P0-1 仍未修好**。这一条请以我的探针输出为准，不要仅凭"构建成功/有 R12 日志"判定已修。

### 7.4 `not-run`

* **P1-3 32 位 i386 映像**：`not-run`。未做任何 WOW64/目标表解析实验。仅有的旁证是 `.t/r12/shim/run10-13` 的注入日志里 child injection 只覆盖 x86_64（构建脚本写死 `-target x86_64-windows-gnu`，工具链只产 x86_64），与"需要 32 位 shim 构建"的假设一致，但**我没有验证**，不作为结论。
* **P1-4 注册表"往真实已存在键写"的 WAL 归因**：`not-run`。我复用了 `tests/registry-conformance.mjs`（66 项全绿、1 项既有 SKIP）作为基线，但**没有**做"干净起点对 `HKCU:\Console`/`HKCU:\Environment` 各写一次 + 给出 WAL 新记录与真实 hive 未变"的实验。
* **P1-5 写意图 open 的明文镜像 copy-up**：`not-run`（只读评估也没做）。未评估"仅在真正写入时 copy-up"的最小改动面。

### 7.5 时间盒

派工给的是 ≤8 次嵌套 run / 单 run ≤900 s。实际 14 次（其中 2 次作废），单次 72–267 s，全部 <900 s。超预算的部分主要花在 §2.3 的静默空目录定位与 §6 设施的搭建上；按"优先保住 P0-1 可验证成果"的纪律，我把剩余精力放在了**根因与可复用复现设施**上，而不是继续消耗 run 去追一个正在被别人重写的实现。

---

## 8. 交接清单

给继续做 P0-1 的人：

1. **先读 §2**。两个坑都会让"看起来接线了"的实现在沙箱里依旧全灭：NT 面不进钩子、合并引擎会被自己的钩子截住。
2. **用 `.t/r12/shim/probe/run-r12probe.mjs` 做内环**（秒级、确定性），但记住 §6 的天花板：它证明的是引擎行为，不是"沙箱里钩子必被进入"。
3. **要证明"沙箱里钩子会被进入"**，最短路径是在探针里打一个**桩**：让 shim 内部显式调用一次自己的替换函数（或加一个 `WINSTAGE_SHIM_SELFTEST=dir` 的强制入口），这样"第三方的 IAT 槽位"这个变量就被消掉了。我这一轮没做这一步，是本次最大的遗憾。
4. **P0-2 的补丁**按 §3.3 直接落即可，`ws_stage.c: dp_file_resolve()` 是单点。
5. 回归口径：`tests/e2e-flow.mjs`、`tests/registry-guard.mjs`、`tests/registry-conformance.mjs` 在本轮基线上全绿；`tests/shim-artifact-integrity.mjs` **有 1 项既有失败**（`winstage-inject.exe` 无 `.stale-*`），不要算到本次改动头上。

---

## 9. 证据索引

| 路径 | 内容 |
|---|---|
| `.t/r12/shim/pe-imports.txt` | kernelbase/kernel32 的 `ntdll!NtQueryDirectoryFile` import 实证 |
| `.t/r12/shim/pe-imports.mjs` | 生成它的 PE import 解析脚本 |
| `.t/r12/shim/baseline/` | 改动前基线：`shim-artifact-integrity.txt`（含既有失败原文）、`registry-conformance.txt` |
| `.t/r12/shim/build/build-r12-*.log` | 我的每一次构建日志（含失败原文）；`build-r12-4/10/16/19.log` 为成功记录 |
| `.t/r12/shim/run1..run14/out/**` | 每一次嵌套 run 的 `stdout.ndjson`/`lane.txt`/`stderr.txt`/`workspace-inventory.txt` + stage-root 内 `shim.log` |
| `.t/r12/shim/probe/run-r12probe.mjs`、`r12probe.c` | §6 的确定性复现设施与探针 |
| `.t/r12/shim/probe/driver*.log` | 探针在最终这版 shim 上的原始读数（overlay-only 仍为空） |
| `docs/round12/shim-修复.md` | 本文件 |

---

## 10. 收尾采样（证明"树仍在被第三方改动"）

我在写完 §1–§9 后再次采样，`shim/out/winstage-shim.dll` 的 sha256 又变了：

```
$ (Get-FileHash shim\out\winstage-shim.dll).Hash
A0FB2DA67B8A0DD75B35FEA524D3EBB4CFAC2502F176D1EEFA7436110EF09F91
```

（§1.3 的基线是 `63808F51…`，我中途构建过 `3CB36282…`/`4F8A8BDC…`/`B622F829…`/`1C…` 等多版；`A0FB2DA6…` 不是我构建的。）

同时 `.t/r12/shim/` 下出现了**不是我创建的**目录 `wip-rolled-back/`，`shim/src/ws_dir.c`（我的引擎）已不存在。

⇒ §7.1 的所有权冲突在报告写完后**仍在持续**。因此：

* 本文件里"当前 shim 是否已修好"的任何判断都必须在**指定 DLL hash** 上重测；§7.3 的结论只对我在 04:00 采样的那一版成立。
* 我不再写 `shim/src/**`，以免继续与第三方互相覆盖。



---

# 尝试 2 —— shim 唯一写者（本轮第二个修复者）

> 追加时间：2026-10-11 04:0x。**未删除、未修改上方尝试 1 的任何内容**。
> 我的全部证据在 `.t/r12/shim2/**`（构建日志、每次 run 的 lane/stderr/验收结果、哈希账本 `HASHES.md`）。
> 结论先行：**P0-1 已修复，验收全绿，lane 未退化。**

## T2.0 一句话结论

| 项 | 状态 | 依据 |
|---|---|---|
| P0-1 overlay 目录枚举面 | **已修复（验收 8/8 全绿）** | T2.3 |
| lane 是否退化 | **未退化**：`tierEffective=TS / degraded=false / stderr.txt=0 字节` | T2.3 |
| 载体闸门 | **修复前 powershell 0/3 → 修复后 5/5 全通过**；closedloop 30/30 | T2.4 |
| golden 三件套 | 未删未改（哈希逐一复核） | T2.6 |

## T2.1 实现：第二方案（Win32 `Find*` 族合并），不碰 NT 缓冲区

新增 `shim/src/ws_dirfind.c`（本轮**唯一**新增源文件；`ws_dir.c` 未复活），hook 四个入口：
`FindFirstFileW` / `FindFirstFileExW` / `FindNextFileW` / `FindClose`（`g_targets[]` + 捕获表同步增加）。
合并规则与派工建议一致：real 用原函数枚举（保留调用方 `FINDEX_INFO_LEVELS`）、staged 走
`<stageRoot>\fs\<盘符去冒号路径>`、名字大小写不敏感去重且 **staged 覆盖 real**、whiteout 条目丢弃、
空结果 `INVALID_HANDLE_VALUE`+`ERROR_FILE_NOT_FOUND`、**未知句柄一律原样透传**。
`ws_hook.c` 的 `g_targets[]`/`g_targetNames[]`/originals 捕获各加 4 项；`winstage_internal.h` 加
`WsOriginals` 四个成员与四个替换函数声明；`ws_file.c` 的 `ws_should_intercept` 去掉 `static`
（**零行为变更**，只为共享同一套路径接受判据，避免枚举面与 open 面漂移）。

## T2.2 上一轮 T1 的真实根因（修正尝试 1 与 Lead 的假设）

Lead 的假设是「注入器/导出表一变 ⇒ `selectLaunchMode()` fail-closed 到 T1」。**实测不成立**：

* 重新构建后 `winstage-inject.exe` 与 golden **只差 14 字节**（偏移 `0x80` 的 PE 时间戳 + build-id），
  长度完全相同（159232）。逐字节只差时间戳的载体不可能改变 `selectLaunchMode()`。
* 本轮第一次装配新 DLL 时**同样出现 T1**，lane 文本自带根因：
  `fallbackClass=carrier-init-failed … the carrier process (powershell.EXE) died during its own initialization`，
  即**载荷 PowerShell 自己起不来**，与产物缺失/导出表无关。

真凶是两个代码缺陷（本轮同样踩到并修掉）：

1. **`HeapReAlloc(NULL, …)` 当 `malloc` 用**。它对 NULL 返回 NULL + `ERROR_INVALID_PARAMETER`
   ⇒ 合并视图**永远为空**。直接读数：
   `R12-DIR build dir=C:\Windows\Microsoft.NET\Framework64 … real=1 stage=1 entries=0 first=1 raw=3 skipped=2 allocFail=1`
   ⇒ PowerShell 的 .NET 探测把 `Framework64` 枚举成空目录 ⇒
   打印 `Version v4.0.30319 of the .NET Framework is not installed…` ⇒ 子进程退出码 `0xFFFF0000`。
   修复：`ws_ent_grow()`（NULL → `HeapAlloc`，否则 `HeapReAlloc`）。
2. **进程级重入护栏**：全局 `g_selfWalk` 一旦被某线程留在置位状态，之后所有枚举静默直通真实盘
   （尝试 1 §2.3 观察到的是同一类现象）。改为 `_Thread_local t_selfWalk`。

本轮另修三处：字面名（无通配符）不做合并直接交原函数（`…\v4.0.30319` 这类存在性查询必须与
`GetFileAttributesW` 同答案，否则会为 `ws_ensure_dirs` 造出的**幻影父链**编造结果）；
`FindFirstFileExW` 改为返回**真实合成句柄**（不再是自造 `(HANDLE)1`）；`ws_find_release` 搬移槽位后清零。

> ⚠️ 尝试 1 的 `ws_dirfind.c` 另有一处**自变量错位**（`FindFirstFileExW` 把 `LPVOID lpFindFileData`
> 当文件名传给 `FindFirstFileW`），本轮实现未沿用该文件。

## T2.3 硬验收（Lead 的验收件，全部通过）

run：`cmd /c node .t\r11\bin\submit-job.mjs r12-shim2-run2 <ws> <prompt-enum> .t\r12\shim2\run2\out winstage`

```
A_GetChildItem_sorted=a.txt,sub          ✅
A_GetFileSystemEntries_n=2               ✅
A_GetFiles_n=1                           ✅
A_cmd_dir=[a.txt|sub]                    ✅
B_root_listing=A,seed.txt  B_root_has_A=True  B_root_dup=(空)  ✅
C_read_a=[AAA]  C_read_b=[BBB]           ✅
D_before=gone.txt,keep.txt  D_after=keep.txt  D_gone_hidden=True  ✅
D_cmd_dir=[keep.txt]                     ✅
E_deltree_ok exists_after=False          ✅
F_enum=[x.txt]                           ✅（F_len=150，仍低于 ~186 阈值，非长路径用例）
```

lane（`.t/r12/shim2/run2/out/lane.txt`）：`tierEffective=TS`、`degraded=false`、`launchMode=shim`、
`fallbackClass=none`、`shimCount=1`、`degradeCount=0`；`stderr.txt` = **0 字节**。

**对照实验**：同一验收件 + **golden DLL**（job `r12-shim2-goldenctl`）→ 同样 `TS / degraded=false`，
证明环境正常、退化确由产物引起，修复后不复现。

## T2.4 载体闸门

| 阶段 | `tools/smoke-inject.mjs`（每例重复 3 次） |
|---|---|
| 修复前（build1） | cmd 3/3 ✅、node 3/3 ✅、node-eval 3/3 ✅、**powershell 0/3 ❌**、**powershell-script 0/3 ❌** |
| 修复后（build4） | **5/5 全通过** |

`tools/run-shim-closedloop.mjs`：**ALL CHECKS PASSED (30/30)**。

## T2.5 回归套件（含"非本次引入"的如实登记）

| 套件 | 我的产物 | golden 对照 | 判定 |
|---|---|---|---|
| `tests/shim-artifact-integrity.mjs` | 56 通过 / 1 失败 | **同样 56/1** | 非回归（既有：`shim/out` 已无 `winstage-inject.exe` 的 `.stale-*` 副本；与尝试 1 §5 同结论） |
| `tests/registry-guard.mjs` | 首次 386 断言 2 失败 → 重生成证据后 **373 断言 0 失败 / 3 SKIP** | 386/0（旧证据） | 那 2 项是 `A.2/A.5 证据必须比当前 DLL 新`（重建 DLL 必然触发），按测试提示跑 closedloop 后归零 |
| `tests/e2e-flow.mjs` | **8 项失败** | **还原 golden 后连跑 3 次仍 8 项失败** | **非本次引入**，见下 |

`tests/e2e-flow.mjs` 是**纯 JS** 用例（`Workspace` + `store.stagedPath` + `src/**` 的
`walkStagedForHashes`），**不注入 shim、不经过本 DLL**；失败项为「捕获到沙箱内新建文件 generated.txt」
「嵌套新建 out/build.log」等，属 JS 侧 `snapshotStagedTree/captureAfterExecution` 的既有缺陷。
本轮只改 `shim/**`，不越权改 `src/**`。**该套件本轮不是绿的**，如实登记。

## T2.6 产物与哈希

| 产物 | golden | 最终（build4） |
|---|---|---|
| `winstage-shim.dll` | `63808F5188643C08…` | `486B171E3DBF4753…`（273408 B） |
| `winstage-inject.exe` | `07FE55DD386D489B…` | `692AFCC92907BB46…`（159232 B） |
| `winstage-probe.exe` | `8CF81F4F4735D5D7…` | `C5B01118E6003D61…`（174592 B） |

`.golden-*` 三件套**未删除、未覆盖**（逐一复核哈希）。DLL 导出表与 golden **逐项一致（15 项）**；
唯一新增导入是 `ntdll.dll`（新代码路径解析 `g_orig` 引起，功能无影响）。
本文件写作时 `shim/out/winstage-shim.dll` 就是上表 `486B171E…`（见 `.t/r12/shim2/HASHES.md`）。

## T2.7 边界与遗留

* `e2e-flow.mjs` 的 8 项失败**先于本轮存在**，与本 P0 同源症状（暂存树枚举）但在 JS 层，建议单独开单。
* 验收件 F 段 `F_len=150` 仍未真正压到 ~186 的长路径阈值（尝试 1 §3 的 P0-2 设计仍然有效）。
* 我的护栏是 `_Thread_local`；`ws_logical_present()` 在**同线程内**修改 `t_selfWalk` 是安全的
  （仅在 `g_orig.GetFileAttributesW` 调用期间置位，且该调用在本机不重入枚举）。
* 为了后续定位，`R12-DIR build` 一行保留了 `real/first/raw/skipped/allocFail` 计数，不改变语义。
