# 域1 · 文件读写（多目录）与保存后完整性 + 隔离 —— R16 沙箱实测报告

> 域：`fileio`（共享任务 `task-1`，owner=fileio） · 日期：2026-10-11 17:46–18:06 (+08:00)
> 执行方式：**新开的 6 个带 WinStage 沙箱的独立 DSH 线程**（唯一入口 `docs\archive\round10\env\scripts\sbx-thread.cmd`），
> 宿主侧（本线程，**未加载沙箱**、`WINSTAGE_SHELL` 继承值为 0）做不受限的真实盘反证。
> 所有结论均附原始文件路径；未跑项标 `not-run`；推断项标 `[推断]`。
> 公共协议：`docs/round16/00-测试协议.md`（§1.1 四条判据逐 run 校验，见 §1）。

---

## 0. 一句话结论

**工作区内外的按路径读写与落盘字节完整性完全可信**（1B/4KiB/2MiB/空文件、UTF-8 中文+emoji、GBK 非 UTF-8、非法 UTF-8、覆盖写、
8 层深路径、中文/空格文件名、50 并发、node 子进程通道，宿主侧逐字节 sha256 全部一致；工作区外 14 个目标全部进暂存、
真实盘 15 处 `Test-Path=False` 零残留）；**并行 A/B 隔离成立**（两个沙箱线程同时跑，暂存树互不包含对方文件）。
但 `R15` 交接的三个已知功能缺陷（**overlay 新建目录枚举、递归删除、长路径阈值**）**全部复现**，
并且本轮在 **node 子进程通道**上发现 4 项此前未记录的行为：**`fs.existsSync` 对新建路径一律假阴性**、
**`fs.rmSync(recursive,force)` 静默成功但并未删除**、**ADS 写被静默改写为去冒号的兄弟文件**、
**`mkdirSync(recursive)` 对已存在 overlay 目录返回 ENOENT**；另有一条启动器（工具侧）P2：同刻度并发时
`sbx-thread.cmd` 的 `%RANDOM%` 三连产生**相同**后缀（隔离实际只靠 `<outDir>` 不同）。

---

## 1. 执行清单与 §1.1 四条判据（逐 run）

| run | 目的 | 模式 | session-id | 暂存根（叶子） | ①stderr 0B | ②暂存面 | ③真实 ws 只有种子 | ④lane=TS | exit |
|---|---|---|---|---|---|---|---|---|---|
| `run1` | 工作区内核心矩阵 + 边界名 + 枚举/删除 + 长路径扫描 + **50 并发** | winstage | `session-af7b9fb0-f372-4cc3-af82-f2f5d68dbabe` | `stage-root-22498294474807` | ✅ 0 | ✅ staged 80 文件 / candidates×1 | ✅ files=3 dirs=0 | ✅ `TS/degraded=false` | 0 |
| `run2` | 工作区外目录矩阵 + `..\`/UNC/`\\?\` + 逻辑 158/248/300 | winstage | `session-3e4cea5a-4c84-4c0b-82dd-917d10ea7c23` | `stage-root-22498294474807` | ✅ 0 | ✅ staged / candidates×1 | ✅ files=3 dirs=0 | ✅ `TS/degraded=false` | 0 |
| `pA` | **并行 A**（与 pB 同时发） | winstage | `session-a5b5c337-13e9-43ab-b412-232b269891f4` | `stage-root-231352823414912` | ✅ 0 | ✅ / candidates×1 | ✅ files=3 dirs=0 | ✅ `TS/degraded=false` | 0 |
| `pB` | **并行 B**（与 pA 同时发） | winstage | `session-c9647d61-a7b4-4c4d-b3a6-d1263f269db4` | `stage-root-231352823414912` | ✅ 0 | ✅ / candidates×1 | ✅ files=3 dirs=0 | ✅ `TS/degraded=false` | 0 |
| `platform` | **对照**：`WINSTAGE_SHELL=0`（平台 shell） | platform | `session-a72a12db-b9ea-453f-ab29-58c79d69b1f0` | `stage-root-23498889131755` | ✅ 0 | ✅ / candidates×1 | ❌ files=6 dirs=1（**对照有意如此**） | ❌ `LANE_OK=false`（无 `sandbox-lane.json`） | 0 |
| `run6` | **node 子进程通道**：边界 + 50 并发 + 工作区外 | winstage | `session-5bf40f78-4ea9-4e2d-94f9-216afd37820f` | `stage-root-23498889131755` | ✅ 0 | ✅ staged 178 文件 / candidates×1 | ✅ files=3 dirs=0 | ✅ `TS/degraded=false` | 0 |

* 判据④原文（`run1/out/lane.txt`）：`tierEffective=TS` / `degraded=false` / `shimCount=2` / `degradeCount=0` / `LANE_OK=true`；
  五个 winstage run **全部 `LANE_OK=true`**（原始读数：`.t/r16/fileio/host/host-verify.txt:7-12`，逐 run `lane.txt`）。
* `platform` run 按协议 §1.1 判据④**标 `LANE_OK=false`**，因此**不用于**任何"隔离生效"的断言，只作"关 shell 沙箱 ≠ 关沙箱"的对照。
* 单 run 并发上限 2、总 run 数 6（= 协议上限）；无失败重跑、无无效 run。

---

## 2. 结论速览

| # | 判定项 | 结论 | 决定性原始证据 |
|---|---|---|---|
| 1 | 沙箱装配（6/6 run 装配成功；5/5 winstage lane=TS） | **通过** | `.t/r16/fileio/*/out/lane.txt`；`host/host-verify.txt:7-12` |
| 2 | 工作区内写后回读（1B / 4KiB / 2MiB 随机 / 空 / UTF-8 中文+emoji / GBK / 非法 UTF-8 / 覆盖写） | **通过**：`RT_TOTAL=23 RT_MATCH=16 RT_ERROR=7`（7 个 ERROR 全是保留设备名），宿主重算 payload **逐字节一致** | `run1/out/stage-root-*/staged/fs/C/.../run1/ws/_res/p1-raw.txt`；`host/host-verify.txt:15-29` |
| 3 | 文件名含空格+中文、中文目录+中文文件、大小写、尾点/尾空格 | **通过（含平台一致行为）**：`a b 文件.txt`(7B)、`中文目录\测试.txt`(10B) 一致；`casetest.txt` 读到 `CASE-UPPER`（`aliased=True`）；尾点/尾空格被静默规范化 | `p1-raw.txt`（RT/HASH/CASE/TRAIL 行）；`host-verify.txt:23-28` |
| 4 | 深路径（8 层，逻辑 132 字符） | **通过** | `p1-raw.txt:RT tag=deep-8-levels`；`host-verify.txt:25,97` |
| 5 | **50 并发写**（PowerShell runspace 池 ×50，8192B 确定性载荷） | **通过**：`CONC_WRITE_MS=3301 INVOKE_ERRORS=0 CONC_VERIFY_OK=50 CONC_VERIFY_BAD=0`；宿主逐文件重算 sha256 50/50 一致 | `p1-raw.txt`；`host-verify.txt:45-94` |
| 6 | 保存后完整性（宿主侧独立反证） | **通过**：`sha_match=True` 行 **143**、`sha_match=False` **0**、`CHECK_MISSING`（非预期缺失）**0**、`UNEXPECTED_PRESENT` **0**；blob↔manifest 哈希 run1 90/90、run2 28/28、pA/pB 17/17、run6 80/80 **0 不一致 0 缺失** | `host/host-verify.txt` §1/§4 |
| 7 | **工作区外写入**（Desktop / Documents / 主目录 / `C:\Windows\Temp` / `C:\ProgramData` / `C:\Program Files` / 会话 TEMP / `C:\` 根 / `\\?\` 前缀 / UNC 管理共享 / `..\` 穿越×2 / 嵌套目录） | **暂存成功、真实盘零残留**：沙箱内 `OUT_TOTAL=14 OUT_OK=14 OUT_ERR=0`；宿主 15 处真实路径 **`exists=False`**（UNC 管理共享在宿主侧可达：`UNC_LISTING_OK count=3`，故该负证有效） | `run2/.../_res/p2-raw.txt`；`host-verify.txt:143-171` |
| 8 | 暂存位置映射（新读数） | `\\?\C:\...` 前缀被规范化后与普通路径同落 `staged\fs\C\...`；真 UNC 落 **`staged\fs\_unc\127.0.0.1\C$\...`** | `host/host-extra.txt:47-76` |
| 9 | **隔离：真实盘零落盘** | **通过**：5 个 winstage run 的真实工作区 `dirs=0`、文件只有宿主预放种子；最终回答里的 `write` 产物也只在暂存 | `host-verify.txt:191-236`；各 run `workspace-inventory.txt` |
| 10 | **并行 A/B 暂存互不串** | **通过**：A/B 会话、暂存根、候选完全分离；A 暂存树 `has_ab-B-file=0`、B `has_ab-A-file=0`；同名文件 `same-name.txt` 在两个根里分别是 `A-VALUE`/`B-VALUE`；共享目录 `C:\Windows\Temp` 各只含自己那份；两条真实盘均无 | `host-verify.txt:246-262`；`pAB-raw.txt` |
| 11 | 并行时间重叠 | 成立：A `17:54:34.826→17:54:45.047`、B `17:54:34.762→17:54:45.020`，**完全重叠 ≈10.2 s** | `pA/.../pAB-raw.txt`、`pB/.../pAB-raw.txt` |
| 12 | **平台对照**（`WINSTAGE_SHELL=0`） | 按预期分化：pwsh 写**真实盘**（ws/Desktop/`%TEMP%` 三处 `exists=True`）；而 DSH `write` 工具产物**仍在暂存**且平台 shell 看不到 → 两个面不同步 | `host-verify.txt:351-356`；`platform/out/workspace-inventory.txt` |
| 13 | **node 子进程通道**（`node v24.21.0`） | 写入**确实被 shim 接管**（真实 ws 0 个 node 产物、真实盘 0 残留、暂存 178 文件），50 并发 `verifyOk=50 verifyBad=0 writeErrors=0`，宿主逐字节校验 50/50 一致 | `run6/.../_res2/n2.json`；`host-verify.txt:265-349` |
| 14 | node 通道的 **stat/exists 假阴性** | **不通过（新缺陷 N1）**：19 个用例里所有 `fs.existsSync` 均为 `False`（连刚写完、`readFileSync` 能读回的文件也是 False），而 `fs.readdirSync` 能列出新建目录的 5 个文件 | `n2.json` cases；`host-verify.txt:267-274,287` |
| 15 | node 通道的**递归删除** | **不通过（新缺陷 N2）**：`fs.rmSync(dir,{recursive:true,force:true})` 返回成功且 `existsAfter=false`，但宿主在暂存树里仍看到 `ndel\sub\b.txt`（3B，`BBB`） | `n2.json` `n-rmdir-recursive`；`host-extra.txt` 相关；`host-verify.txt:288` |
| 16 | node 通道的 **ADS** | **不通过（新缺陷 N3）**：`writeFileSync('nads-base.txt:r16s')` 成功，内容落到暂存区去冒号兄弟文件 `nads-base.txtr16s`（8B，sha=`7a442107…`=sha256('ADS-DATA')）；同一路径 PowerShell 是硬拒 | `host-extra.txt:78-83`；`p1-raw.txt:ADS` |
| 17 | 保留设备名 `CON/PRN/AUX/NUL/COM1/LPT1/COM9` | **硬拒、未污染**（PowerShell 与 node 均拒；`dev\` 目录本身会被暂存） | `p1-raw.txt:RT tag=devname-*`；`host-verify.txt:30-36` |
| 18 | NTFS ADS（PowerShell） | **硬拒** `The given path's format is not supported`（与 R11 一致） | `p1-raw.txt`、`p2-raw.txt:ADS_OUT` |
| 19 | **已知项复验**：`Get-ChildItem` overlay 新建目录 | **复现**（形态有变化）：`Get-ChildItem -File` 计数 **0**（R11 是抛异常）、`Directory.GetFiles` 抛 `DirectoryNotFoundException`、递归只数到真实盘种子 **3**；node `readdir` 却正确 | `p1-raw.txt:ENUM*`；`host-verify.txt:112-117` |
| 20 | **已知项复验**：递归删除 | **复现**：`[IO.Directory]::Delete(dir,$true)` 抛、`Remove-Item -Recurse` 抛 `Win32Exception`、`cmd rmdir /s /q` **rc=145**（`The directory is not empty`）；三种写法的目标文件都仍在暂存 | `p1-raw.txt:DEL*`；`host-verify.txt:42-44,118-127` |
| 21 | **已知项复验**：长路径阈值 | **复现并细化**：本夹具逻辑 **145 可写 / 166 失败**（=暂存侧 255 / 276 字符，260 处断）；显式逻辑 **158/248/300 全失败**（158 报 "too long"）；`\\?\` 对 ws 内长路径报 **Access denied**（不是长度错） | `p1-raw.txt:LONGPATH*`；`p2-raw.txt:LPTARGET*`；`host-extra.txt:27-37` |
| 22 | DSH `write` 工具 ↔ shell 命名空间（R11-D4） | **复现**：`write` 工具落 `staged\tool-channel.txt`（36B, sha=`b892768c…`），沙箱 shell 对同一路径 `exists=False`；`read` 工具能读回 | `host-extra.txt:39-44`；`stdout.ndjson` 的 `LINE_TOOL_READBACK` |
| 23 | 沙箱内 cwd 泄漏（R10-D3） | **复现**：pwsh `(Get-Location).Path` 与 node `process.cwd()` 均为 `<stage-root>\staged` | `p2-raw.txt:CWD`；`n2.json` `cwd`；`host-extra.txt:94-97` |
| 24 | 会话 TEMP 改写 | **复现**：`$env:TEMP` = `…\dsh-stage-temp\<guid>`（非真实 `%TEMP%`） | `p2-raw.txt:TEMP_ENV`；`n2.json` `env.TEMP` |
| 25 | 启动器暂存根唯一性 | **P2（新缺陷 N5）**：同刻度并发时 `%RANDOM%` 三连给出**相同**后缀（run1/run2 同为 `22498294474807`，pA/pB 同为 `231352823414912`）；隔离靠 `<outDir>` 不同而成立 | `host-extra.txt:85-92`；`meta.txt` |
| 26 | 敏感材料（协议 §5） | `.t/r16/fileio/**` 与 `docs/round16/**` 扫描 **0 命中**；本轮未读取任何敏感文件 | `host-verify.txt:358-359` |
| 27 | 沙箱内 DSH `glob`/目录类工具 | `not-run` | — |
| 28 | 符号链接/硬链接/重解析点、稀疏文件、>2MiB、staged→真实盘 apply | `not-run` | — |

---

## 3. 逐项原始片段

### 3.1 工作区内完整性（run1）
`…/run1/ws/_res/p1-raw.txt`（原样节选；完整 68 行经宿主抄录于 `host-verify.txt:101-140`）：
```
RT tag=1B rel=c01-1byte.bin wroteBytes=1 exists=True readBytes=1 match=True sha256_wrote=559aead0… sha256_read=559aead0…
RT tag=4KiB rel=c02-4kib.bin wroteBytes=4096 exists=True readBytes=4096 match=True …
RT tag=2MiB-random rel=c03-2mib-random.bin wroteBytes=2097152 exists=True readBytes=2097152 match=True sha256=0c777471…ad3130
RT tag=empty rel=c04-empty.bin wroteBytes=0 exists=True readBytes=0 match=True sha256=e3b0c442…b855
RT tag=gbk-nonutf8 rel=c06-gbk-bytes.txt wroteBytes=11 exists=True readBytes=11 match=True sha256=dca3cc9f…1769
RT tag=invalid-utf8 rel=c07-invalid_utf8.bin wroteBytes=8 exists=True readBytes=8 match=True sha256=2c0aafbc…1c69
RT tag=overwrite-2nd rel=c09-overwrite.txt wroteBytes=21 exists=True readBytes=21 match=True sha256=1a6eae84…f310d
RT tag=space+cjk-filename rel=a b 文件.txt wroteBytes=7 … match=True
RT tag=cjk-dir-cjk-file rel=中文目录\测试.txt wroteBytes=10 … match=True
RT tag=deep-8-levels rel=deep\L01\…\L08\leaf.txt wroteBytes=7 … match=True
RT_TOTAL=23 RT_MATCH=16 RT_ERROR=7
```
* GBK 样本 `D6 D0 CE C4 47 42 4B B2 E2 CA D4`（"中文GBK测试"）在宿主侧用 **strict UTF-8 解码（`throwOnInvalidBytes=true`）被拒** ⇒ 确为真正的非 UTF-8 文本，且暂存后逐字节无损（`host-extra.txt:19-22`）。
* **探针自述缺陷（诚实记录）**：`p1-raw.txt` 里 `STRICT_UTF8_DECODE_gbk=accepted` 是**我的探针 bug**
  （`New-Object Text.UTF8Encoding($false)` 的 `GetString()` 从不抛异常）；该项不构成证据，
  非 UTF-8 结论以上述宿主侧严格解码 + 字节 sha256 比对为准（`host-extra.txt:23-25`）。
* 覆盖写：最终 21B = `SECOND-CONTENT-LONGER`，无旧内容残留。

### 3.2 枚举 vs 直接访问（已知项复验，run1）
```
ENUM dir_exists=True
ENUM GetChildItem_dir count=0
ENUM DirGetFiles ERROR=… "Could not find a part of the path '…\run1\ws\enumdir'."
ENUM DirGetFileSystemEntries ERROR=… 同上
ENUM GetChildItem_recursive_files=3          ← 只剩真实盘种子
ENUM direct_path_exists=True
```
宿主在暂存树里**看得到**这些"枚举不到"的文件（`host-verify.txt:37-41` 五张 CHECK 全 `sha_match=True`），
证明"写入/落盘成功但枚举不可见"（不是写失败）。

### 3.3 递归删除（已知项复验，run1）
```
REN ok old_exists=False new_exists=True          ← 单文件改名正常
DELFILE ok exists_after=False                    ← 单文件删除正常
DELTREE ERROR … "Could not find a part of the path '…\run1\ws\del'."
DEL_END dir_exists=True a=False renamed=False b=True      ← b.txt 仍在
DEL2 RemoveItem ERROR Win32Exception :: The system cannot find the file specified
DEL2 DirDelete_nonrecursive ERROR … "The directory is not empty. "
DEL3 rmdir rc=145 out=The directory is not empty. dir_exists=True
```
宿主侧 `del\sub\b.txt`(3B)、`del2\x\y\c.txt`(3B)、`del3\s\d.txt`(3B) 全在暂存树中（`host-verify.txt:42-44`）。

### 3.4 长路径（已知项复验 + 阈值算术）
```
LONGPATH step=1 leafLen=103 dir=OK file=OK
LONGPATH step=2 leafLen=124 dir=OK file=OK
LONGPATH step=3 leafLen=145 dir=OK file=OK
LONGPATH step=4 leafLen=166 dir=ERROR … "Could not find a part of the path '…\d01-sss…\d04-sss…'."
LONGPATH_LAST_OK_LEN=145 LONGPATH_FIRST_FAIL_LEN=166
```
显式逻辑长度（`p2-raw.txt`）：
```
LPTARGET target=158 actualLen=158 write=ERROR … "The specified path, file name, or both are too long. … less than 260 …"
LPTARGET_UNC target=158 … write=ERROR … "Access to the path '\\?\C:\…\leaf.txt' is denied."
LPTARGET target=248/300 write=ERROR … "Could not find a part of the path …"（误导性）
```
算术（`host-extra.txt:27-37`）：本夹具 `stage_root_len=100` ⇒ `stagedLen = 逻辑长度 + 110`；
`145→255`（≤260 成功）、`166→276`（>260 失败）、`158→268`（失败）⇒ **可用逻辑预算 = 150 字符**。
R15 记录的"逻辑 158 触 260"是同一机制在**更短的 stage-root 前缀**下的读数（等价：`260 − 前缀`），不是矛盾。

### 3.5 工作区外矩阵（run2，节选）
```
OUT tag=desktop  path=C:\Users\Administrator\Desktop\r16fio-out-desktop.txt write=OK readback=D1-OUT-Desktop sha256=f96b035b…
OUT tag=programfiles path=C:\Program Files\r16fio-out-programfiles.txt write=OK sha256=563c5ec4…
OUT tag=sessiontemp path=…\dsh-stage-temp\<guid>\r16fio-out-sessiontemp.txt write=OK
OUT tag=wintemp-unc path=\\?\C:\Windows\Temp\r16fio-out-wintemp-unc.txt write=OK sha256=32c7dfb2…
OUT tag=unc-admin path=\\127.0.0.1\C$\Windows\Temp\r16fio-unc.txt write=OK sha256=8313c7c4…
OUT tag=traversal1 path=…\run2\ws\..\r16fio-out-traversal.txt write=OK
OUT_TOTAL=14 OUT_OK=14 OUT_ERR=0
```
宿主真实盘（`host-verify.txt:156-171`）**15 行全 `exists=False`**；其中 UNC 目标另经"宿主可达性正证"
（`UNC_LISTING_OK count=3`）确认不是因无权限而假阴。
另：`READOUT` 显示沙箱可**读**工作区外真实文件（`hosts` 824B、`win.ini` 167B，只记 sha256/长度）。

### 3.6 并行 A/B（pA/pB）
```
pA 暂存树: _res, ab-A-in.txt, abA-only.txt, same-name.txt, …   has_ab-B-file=0
pB 暂存树: _res, ab-B-in.txt, abB-only.txt, same-name.txt, …   has_ab-A-file=0
pA staged\fs\C\Windows\Temp\r16fio-ab-A.txt 76038370…  (18B)
pB staged\fs\C\Windows\Temp\r16fio-ab-B.txt 4081ac84…  (18B)
same-name.txt: pA=A-VALUE (ca91fc38…) / pB=B-VALUE (4c20d1a3…)   两个根各自正确
真实盘 C:\Windows\Temp\r16fio-ab-{A,B}.txt : exists=False / exists=False
```

### 3.7 node 子进程通道（run6）—— 本轮主要新读数
`_res2/n2.json`（原样字段）：
```
ws=…\run6\ws   cwd=…\run6\out\stage-root-23498889131755\staged   node=v24.21.0 platform=win32
n-1byte ok=True exists=False match=True readBytes=1        ← 写成功、读回一致，但 existsSync=False
n-2mib  ok=True exists=False match=True readBytes=2097152
n-ads   ok=True match=True readback=ADS-DATA streamPath=…\nads-base.txt:r16s
n-devname-CON/PRN/AUX/NUL/COM1/LPT1/COM9 ok=False (ENOENT)
n-trail-dot   ok=True existsRequested=False existsTrimmed=False   （宿主：staged\ntrail-dot 存在，5B）
n-deep-8      ok=True exists=False match=True readBytes=12
n-longpath-300/500 ok=False (ENOENT … mkdir)
n-enum  ok=True dirExists=False directExists=False readdir=[e1.txt…e5.txt] wsReaddirTop=[… ndeep,ndev,nenumdir,…]
n-rmdir-recursive ok=True existsAfter=False bExistsAfter=False     （宿主：staged\ndel\sub\b.txt 仍在，3B）
n-outside-wintemp / n-outside-desktop ok=True exists=False，真实盘均 False
conc: ms=192 writeErrors=0 verifyOk=50 verifyBad=0 readdirCount=50 readdirErr=null
```
宿主反证：`nc03-2mib.bin`、`nconc\n001…n050.bin`、`ndeep…leaf.txt`、`ntrail-dot`、`nads-base.txt`
全部在暂存区且 **sha256 与宿主重算一致**（`host-verify.txt:292-346`）；真实 ws 里 **0 个 node 产物**（`host-verify.txt:349`）。

### 3.8 平台对照（platform）
```
真实盘：platform\ws\platform-real-pwsh.txt exists=True 16B
        C:\Users\Administrator\Desktop\r16fio-platform-desktop.txt exists=True 21B
        %TEMP%\r16fio-platform-temp.txt exists=True 18B
DSH write 工具：staged\tool-channel.txt 存在（36B），而平台 shell 的 toolcheck 看到 exists=False
workspace-inventory: files=6 dirs=1（真实盘被写，对照有意如此）
```
⇒ "关 shell 沙箱" 后**只有 shell 面**回到真实盘，**fs 工具面仍在暂存**（与 R10 D4 一致）。

---

## 4. 与 R11 同域结论对照（复现 / 已修 / 变化）

| R11 判定项 | R11 结论 | R16 结论 | 状态 |
|---|---|---|---|
| 装配/lane（4/4 TS） | 通过 | 5/5 winstage `LANE_OK=true`（+1 平台对照） | **复现** |
| 工作区内字节完整性（含 2MiB/GBK/中文/emoji） | 通过 | 通过，新增 node 通道与 50 并发宿主逐字节校验 | **复现并加强** |
| 并发写 50/60 | 通过 | 50/50（PowerShell）+ 50/50（node） | **复现** |
| 工作区外写入不硬拒、真实盘零残留 | 通过（13 路径） | 通过（14 目标 / 15 真实路径 False），新增 Program Files、UNC 管理共享、嵌套目录 | **复现并加强** |
| R11-D1 递归删除失败 | 缺陷 | **复现**（三种写法全失败；另发现 node `force:true` 下**静默**失败，见 N2） | **未修（已知，R15 交接）** |
| R11-D2 目录枚举看不到新写入 | 缺陷 | **复现**（`GetChildItem -File` 由抛异常变为 **count=0**；.NET 仍抛；node `readdir` 反而正常，见 N1） | **未修（已知）** |
| R11-D3 长路径阈值被前缀吃掉 | 缺陷（186 失败） | **复现**：本夹具逻辑 **145 成功/166 失败**、显式 158 报 "too long"；`\\?\` 对 ws 内路径报 **Access denied** | **未修（已知）** |
| R11-D4 工具 ↔ shell 暂存命名空间分裂 | 缺陷 | **复现**（run1/run2/platform 三个 run） | **未修** |
| R11 保留名硬拒 / ADS(PS) 硬拒 / 尾点尾空格规范化 | 非缺陷 | 复现；**新增** node 通道 ADS 被静默改写（N3） | **变化** |
| R11 单一 `\?\` 前缀被规范化 | 观察 | 复现（落 `staged\fs\C\...`）；新增真 UNC 落 `staged\fs\_unc\...` | **复现并细化** |
| R10-D3 cwd 泄漏 / 会话 TEMP 改写 | 观察 | 复现（pwsh 与 node 两条通道） | **复现** |

---

## 5. 未覆盖 / 限定（`not-run`）

| 项 | 状态 | 说明 |
|---|---|---|
| 沙箱内 DSH `glob`/目录类工具 | `not-run` | 只测了 pwsh 列目录/.NET 枚举/node `readdir` |
| 符号链接 / 硬链接 / 重解析点 | `not-run` | 不在本轮必测清单 |
| 稀疏文件、>2MiB、超大单文件 | `not-run` | 2MiB 已覆盖 |
| node `statSync/lstatSync/accessSync` 逐 API 矩阵 | `not-run`（只观测 `existsSync`） | N1 的结论只适用于 `existsSync`；其余 API 推断为同类 `[推断]` |
| staged → 真实盘 apply/hostOperations 一致性 | `not-run` | headless 无审批应答者，永不提交（预期） |
| 只读文件覆盖（沙箱内） | `not-run` | R11 已测（硬拒）；本轮未重测 |
| 跨通道并发（工具写 + shell 写同一路径） | `not-run` | — |
| N1/N2 的根因定位 | `[推断]` | 未读 shim 源码（协议 §0.4 禁止改动/依赖源码定位）；现象与 R11-D2 同源 |
| 长路径 `\\?\` "Access denied" 的根因 | `[推断]` | 可能是 shim 对 ws 内 `\\?\` 前缀的写意图判定，未验证 |

---

## 6. 复现命令

```powershell
# 每个 run 的启动唯一入口（winstall 模式；平台对照把第 4 参换成 platform）
cmd /c "C:\Users\Administrator\Desktop\dsh-winstage-sandbox\docs\archive\round10\env\scripts\sbx-thread.cmd" `
  "C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r16\fileio\run1\ws" `
  "C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r16\fileio\run1\prompt.txt" `
  "C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r16\fileio\run1\out" winstage

# 宿主侧独立反证（不受限）
powershell -NoProfile -ExecutionPolicy Bypass -File .t\r16\fileio\host\host-verify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .t\r16\fileio\host\host-extra.ps1
```
（run1–run6 的 promptFile/探针脚本分别是各 `run*/prompt.txt` 与 `run*/ws/probe*.ps1`、`run6/ws/nprobe6.mjs`。）

---

## 7. 证据索引

| 内容 | 路径 |
|---|---|
| 四条判据 + 全部宿主反证（359 行） | `.t/r16/fileio/host/host-verify.txt`（生成脚本 `host/host-verify.ps1`） |
| 补充读数：run 身份表、严格 UTF-8、长路径算术、D4 分裂、UNC/`\\?\` 落点、node-ADS、启动器后缀（97 行） | `.t/r16/fileio/host/host-extra.txt`（脚本 `host/host-extra.ps1`） |
| run1 探针逐用例原文（68 行） | `run1/out/stage-root-22498294474807/staged/fs/C/…/run1/ws/_res/p1-raw.txt`（宿主抄录 `host-verify.txt:101-140`） |
| run2 探针逐用例原文（30 行） | `run2/out/stage-root-22498294474807/staged/fs/C/…/run2/ws/_res/p2-raw.txt`（抄录 `host-verify.txt:176-188`） |
| 并行 A/B 逐用例原文 | `pA/.../ws/_res/pAB-raw.txt`、`pB/.../ws/_res/pAB-raw.txt` |
| node 通道 JSON | `run6/out/stage-root-23498889131755/staged/fs/C/…/run6/ws/_res2/n2.json` |
| 每 run 的原始抽取证据 | `run{1,2,6}/out/{lane.txt,stderr.txt,exitcode.txt,session-id.txt,stage-root-path.txt,stage-root-inventory.txt,stage-root-meta.txt,workspace-inventory.txt,stdout.ndjson}`、`pA/out/*`、`pB/out/*`、`platform/out/*` |
| 探针脚本（可复跑） | `run1/ws/probe1.ps1`、`run2/ws/probe2.ps1`、`run6/ws/nprobe6.mjs`、`pA/ws/probePA.ps1`、`pB/ws/probePB.ps1`、`platform/ws/probePL.ps1`、各 `ws/toolcheck.ps1` |
| 缺陷清单 | `docs/round16/fileio-缺陷.md` |

---

## 8. 清理（协议 §5 延伸）

* 5 个 winstage run 的真实工作区**本来就零落盘**（各 `ws` 目录只有 3 个宿主预放种子，`dirs=0`），无需清理。
* `platform` 对照 run 按设计写了**真实盘**；取证快照后已删除 2 个一次性产物，并记录 sha256/字节数：

| 删除路径 | 字节 | sha256 | 记录 |
|---|---|---|---|
| `C:\Users\Administrator\Desktop\r16fio-platform-desktop.txt` | 21 | `d0b0330320953606fda8b76a015106998c2cfcb19863513f18f098cbba6bdba5` | `.t/r16/fileio/host/cleanup.txt` |
| `%TEMP%\r16fio-platform-temp.txt` | 18 | `1ea220b56bbafbd7521ba675e99a195daa405745c6ac3a712146babfa3bf10db` | `.t/r16/fileio/host/cleanup.txt` |

* 清理后复核：全部 12 个"工作区外"目标（run2/run6/pA/pB）在真实盘上 **0 命中**；平台写进其一次性 ws 的
  `platform-real-pwsh.txt` 保留在 `.t/r16/fileio/platform/ws`（属本域证据目录，非真实用户数据）。
* 敏感材料扫描：`.t/r16/fileio/**` 与 `docs/round16/**` **0 命中**（`host/host-verify.txt:358-359`）；本轮未读取任何凭据类文件。

## 9. 证据强度声明

* 本域**未修改任何仓库源码**（`src/**`、`dsh-plugin/**`、`tests/**`、`tools/**`、`shim/**` 均未写入），
  未改 `%DSH_HOME%\profiles\web\**`，未在自身会话加载沙箱（`meta.txt: inherited_WINSTAGE_SHELL=0`），
  未触碰 `%LOCALAPPDATA%\Temp\winstage-stage\dsh-host`，未 kill 3080 宿主；**未 spawn 新 teammate**（并行全部用 pwsh 后台 job）。
* 每个结论都有原始文件路径；宿主侧反证与沙箱内自述**分别**记录，凡不一致处（如 `existsSync`）以宿主证据 + 双通道交叉为准。
* 已知项（枚举/递归删除/长路径/D4）按协议要求**只报告不改动**，R16 读数已与 R11 逐条对照（§4）。
* golden 三件套哈希在取证前后一致：`shim=63808F51…`、`inject=07FE55DD…`、`probe=8CF81F4F…`（`host-verify.txt:4`）。
