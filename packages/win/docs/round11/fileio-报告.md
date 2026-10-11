# D1 文件读写与落盘完整性 —— R11 沙箱实测报告

* 域：`t1-fileio` / 共享任务 `task-1`
* 日期：2026-10-10
* 执行方式：**新开的 4 个带 WinStage 沙箱的 DSH 线程**（常驻宿主 `supervisor.mjs` 拉起），
  宿主侧（本线程，不受限）做真实盘独立反证。
* 嵌套 run 计数：**4 / 5**（`d1-run1`…`d1-run4`），同时最多 2 个 job，单 run 全部 < 100 s（上限 900 s）。
  第 5 次配额**未使用**（无失败需重跑）。
* 所有结论均可由**下列原始文件**复现；未跑项写明 `not-run`；推断项写明 `[推断]`。

---

## 0. 结论速览

| # | 判定项 | 结论 | 决定性原始证据 |
|---|---|---|---|
| 1 | 沙箱装配（4/4 run） | **通过**：`stderr.txt` 全为 0 字节、`lane.txt` `LANE_OK=true`（`tierEffective=TS`、`degraded=false`）、退出码 0 | `.t/r11/fileio/run{1..4}/out/lane.txt`、`host-verify.txt` §0 |
| 2 | 工作区内写后回读（1B / 4KiB / 2MiB 随机 / 空文件 / UTF-8 中文+emoji / GBK 非 UTF-8 / 非法 UTF-8 / 覆盖写） | **通过**：run4 `RT_TOTAL=11 RT_MATCH=11 RT_ERROR=0`；run1 `12/11/1`（唯一失败=深层路径，见 #4）。宿主侧重算 payload 后比对暂存区字节，**156/156 `sha_match=True`** | `run4/out/stage-root/staged/fs/C/.../run4/ws/_res/probe4r-raw.txt:4-19`；`host-verify.txt` §1 |
| 3 | 文件名含空格+中文、中文目录+中文文件 | **通过**：`a b 文件.txt`(7B)、`中文目录\测试.txt`(10B) 写读一致，sha256 与宿主重算一致 | `run4/.../probe4r-raw.txt:16-18`；`host-verify.txt:19,20,29,30` |
| 4 | 深层路径 / 长路径（>260 及远小于 260） | **不通过（缺陷 D3）**：绝对路径 **186 字符即失败**；`\\?\` 前缀也失败；run1 40 层深路径是唯一 `RT_ERROR` | `run3/.../probe3r-raw.txt:17-23`；`host-verify.txt:31,166-171` |
| 5 | 并发写 ≥50 | **通过**：run2 50/50、run4 60/60 全部存在且逐字节 sha256 一致（`INVOKE_ERRORS=0`） | `run2/.../SUMMARY.txt`；`run4/.../probe4r-raw.txt:96-159`；`host-verify.txt:37-86,91-150` |
| 6 | 沙箱内**目录枚举**可见性 | **不通过（缺陷 D2）**：`Get-ChildItem`/`Directory.GetFiles` 看不到本次写入（直接按路径访问却正常） | `run4/.../probe4r-raw.txt:20-24`；`run3/.../probe3r-raw.txt:14,44-48` |
| 7 | 单文件删除 / 改名 | **通过**（暂存语义）：`Move` 成功、`Delete(file)` 成功、原路径随即不可见 | `run4/.../probe4r-raw.txt:26-27,29`；`run2` manifest `del\a.txt`、`del\renamed.txt` 条目已消失 |
| 8 | 递归删目录 | **不通过（缺陷 D1）**：`[IO.Directory]::Delete(dir,$true)` 与 `Remove-Item -Recurse -Force` 均失败，目录内文件仍在 | `run4/.../probe4r-raw.txt:28-32`；`run2` manifest 仍留 `del\sub\b.txt`、`del2\x\y\c.txt` |
| 9 | 工作区**外**写入（Desktop / 主目录 / Documents / `C:\Windows\Temp` / 会话 TEMP / `C:\` 根 / ProgramData / `..` 穿越） | **暂存成功，真实盘零残留**：沙箱内 `exists=True` 且回读字节正确；宿主侧 13 个真实路径 `Test-Path` **全 False** | `run3/.../probe3r-raw.txt:24-43`；`host-verify.txt:174-182` 与 §3（13 行 `REALDISK exists=False`） |
| 10 | 保留设备名 `CON/PRN/AUX/NUL/COM1/LPT1/COM9` | **硬拒**（行为正确，未落到设备、未污染） | `run3/.../probe3r-raw.txt:5-11`；`host-verify.txt:159-165` |
| 11 | 尾点 / 尾空格文件名 | **静默改名**（`trail-dot.`→`trail-dot`、`trail-sp `→`trail-sp`）；与 Windows 平台行为一致，但调用方拿到的是**改名后的文件** | `run3/.../probe3r-raw.txt:12-14`；`host-verify.txt:153-154` |
| 12 | NTFS ADS（`file.txt:stream`） | **硬拒**：`The given path's format is not supported`；`Get-Item -Stream *` 亦失败 | `run3/.../probe3r-raw.txt:15-16` |
| 13 | `\\?\` 前缀 | 对 `C:\Windows\Temp` 目标**被规范化后暂存成功**；对工作区内超长路径**失败** | `run3/.../probe3r-raw.txt:22-23,38-39`；`host-verify.txt:180` |
| 14 | `..` 穿越（`ws\..\x`、`ws\sub\..\..\x`） | **暂存成功**（落在 `staged\fs\C\...\run3\`），真实盘无 | `run3/.../probe3r-raw.txt:24-25`；`host-verify.txt:181-182`；`REALDISK exists=False` |
| 15 | 只读文件覆盖 | **硬拒** `Access to the path ... is denied`（平台一致） | `run3/.../probe3r-raw.txt:27` |
| 16 | DSH `write` 工具通道（工作区内） | **通过**：暂存 36B、sha256 与宿主重算一致；`read` 工具回读内容逐字符一致 | `host-verify.txt:185-186`；`run1/out/stdout.ndjson` 工具结果行 |
| 17 | **跨通道可见性**（`write` 工具 ↔ shell） | **不通过（缺陷 D4）**：两套互不相通的暂存命名空间；shell 看不到 `write` 工具刚写的文件 | `run4/.../_res/pwsh-toolchannel.txt:1`；`run3/.../_res/pwsh-toolchannel.txt:1-3` |
| 18 | 宿主侧独立反证 | 156/156 sha 一致、0 例意外缺失/意外存在、207 个 manifest↔blob 哈希一致、真实工作区仅含宿主种子 | `.t/r11/fileio/host-verify.txt`（250 行） |
| 19 | 沙箱内 `glob`/列目录类工具 | `not-run`（本域只测了 pwsh 列目录与 `read` 工具直读） | — |

**一句话结论**：工作区内的**按路径读写与落盘字节完整性是可信的**（含 2MiB、GBK、中文/emoji 文件名、50–60 并发），工作区外写入全部进暂存、真实盘零残留；但存在 4 类**功能性缺陷**：**递归删目录失败、目录枚举看不到新写入、长路径阈值被暂存前缀吃掉（186 字符即失败）、DSH 工具与 shell 的暂存命名空间互不可见**。

---

## 1. 执行清单（逐 run 记录）

| job | run | 模式 | 退出码 | `stderr.txt` 字节 | `lane.txt` | ws 真实文件数 | 关键脚本 |
|---|---|---|---|---|---|---|---|
| `d1-run1` | in-ws 核心（首次，日志函数有 bug） | winstage | 0 | 0 | `LANE_OK=true` TS | 3（全为宿主种子） | `probe1.ps1` |
| `d1-run2` | 并发 50 + 删除/改名/递归删 | winstage | 0 | 0 | `LANE_OK=true` TS | 3（全为宿主种子） | `probe2.ps1` |
| `d1-run3` | 边界名 + 工作区外矩阵 | winstage | 0 | 0 | `LANE_OK=true` TS | 3（全为宿主种子） | `probe3r.ps1` |
| `d1-run4` | 核心重跑（日志修正）+ 枚举 + 删除 + 并发 60 | winstage | 0 | 0 | `LANE_OK=true` TS | 3（全为宿主种子） | `probe4r.ps1` |

* 四条硬判据：① `stderr.txt` 空 ✅；② `lane.txt` `LANE_OK=true` ✅；③ 暂存区出现被测写入 + `candidates/` 有候选 ✅；
  ④ `workspace-inventory.txt` 只有宿主预置种子 ✅。
* run1 的说明：run1 首版脚本用了 `[string]::Join("`r`n", $ArrayList)`，PowerShell 绑定到 `params object[]` 重载，
  日志文件只写入了 `System.Collections.ArrayList`（33B）→ **逐用例文本丢失**。因此 run4 用 `-join` 重跑了核心矩阵，
  run1 的结论改用「宿主侧重算 payload ↔ 暂存区字节」比对（`host-verify.txt` §1），计数仍由 `SUMMARY.txt` 保留。
  这是**我的脚本 bug，不是被测缺陷**。

## 2. 证据索引（原始文件路径）

| 内容 | 路径 |
|---|---|
| run1 计数 | `.t/r11/fileio/run1/out/stage-root/staged/fs/C/Users/Administrator/Desktop/dsh-winstage-sandbox/.t/r11/fileio/run1/ws/_res/SUMMARY.txt` |
| run1 manifest（逐文件 size+stagedHash） | `.t/r11/fileio/run1/out/stage-root/manifest.json` |
| run2 计数 | `.t/r11/fileio/run2/out/stage-root/staged/fs/C/.../run2/ws/_res/SUMMARY.txt` |
| run2 事件流（含 pwsh stderr 原文） | `.t/r11/fileio/run2/out/stdout.ndjson` |
| run3 逐用例原文（48 行） | `.t/r11/fileio/run3/out/stage-root/staged/fs/C/.../run3/ws/_res/probe3r-raw.txt` |
| run3 write 工具跨通道回读 | `.t/r11/fileio/run3/out/stage-root/staged/fs/C/.../run3/ws/_res/pwsh-toolchannel.txt` |
| run4 逐用例原文（164 行） | `.t/r11/fileio/run4/out/stage-root/staged/fs/C/.../run4/ws/_res/probe4r-raw.txt` |
| run4 write 工具跨通道回读 | `.t/r11/fileio/run4/out/stage-root/staged/fs/C/.../run4/ws/_res/pwsh-toolchannel.txt` |
| 宿主侧反证（250 行） | `.t/r11/fileio/host-verify.txt`，脚本 `.t/r11/fileio/host-verify.ps1` |
| 宿主侧运行前基线 | `.t/r11/fileio/host-baseline.txt` |
| 每次 run 的沙箱原始证据 | `.t/r11/fileio/run{1..4}/out/{lane.txt,stderr.txt,exitcode.txt,stage-root-inventory.txt,workspace-inventory.txt,stage-root-meta.txt}` |
| 每次 run 的 prompt / 种子脚本 | `.t/r11/fileio/run{1..4}/{prompt.txt,ws/*.ps1}` |

> 说明：`staged/fs/C/...` 是 shim 对「绝对路径」的暂存映射（`<盘符>:\x` → `staged\fs\<盘符>\x`）；
> 工作区相对路径（DSH `write` 工具）映射到 `staged\<相对路径>`；工作区外（`external:true`）映射到 `staged-ext\<hash前缀>\<hash前缀>\<basename>`。

## 3. 逐条结论 + 原样片段

### 3.1 沙箱装配与 lane（#1）
`host-verify.txt:5-8`（原样）：
```
run1 : tierEffective=TS | degraded=false | LANE_OK=true ... ; stderr_bytes=0 ; exitcode=0
run2 : tierEffective=TS | degraded=false | LANE_OK=true ... ; stderr_bytes=0 ; exitcode=0
run3 : tierEffective=TS | degraded=false | LANE_OK=true ... ; stderr_bytes=0 ; exitcode=0
run4 : tierEffective=TS | degraded=false | LANE_OK=true ... ; stderr_bytes=0 ; exitcode=0
```
> 设施观察（非产品缺陷）：`probe3` 那次 run 的 `lane.txt` 实际是 `LANE_OK=false (sandbox-lane.json 不存在)`，
> 原因是该次 `out` 目录缺少 `stage-root-path.txt`（抽取器因此找不到 stage root），而同 run 的
> `stage-root/sandbox-lane.json` 写的是 `tierEffective=TS / degraded=false`。
> 本次 4 个 run 的 `out` 目录**都有** `stage-root-path.txt`，lane 判定正常。

### 3.2 工作区内写后回读（#2，#3）
`run4/.../probe4r-raw.txt:4-19`（节选，原样）：
```
RT tag=1B rel=c01-1byte.bin wroteBytes=1 exists=True readBytes=1 match=True sha256_wrote=559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd sha256_read=559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd
RT tag=2MiB-random rel=c03-2mib-random.bin wroteBytes=2097152 exists=True readBytes=2097152 match=True sha256_wrote=0c777471f3bcd047391f6bea1cbc2938ff2a989f350b75b85edbfde084ad3130 sha256_read=0c777471f3bcd047391f6bea1cbc2938ff2a989f350b75b85edbfde084ad3130
RT tag=empty rel=c04-empty.bin wroteBytes=0 exists=True readBytes=0 match=True sha256_wrote=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 sha256_read=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
UTF8_STR_CHARS=7 UTF8_BYTES=15
RT tag=utf8-cjk-emoji rel=c05-utf8-cjk-emoji.txt wroteBytes=15 exists=True readBytes=15 match=True sha256_wrote=02b62f7d5694063f970181ef73f8480a5f910b99edd3dd8543583c7c31c523f7 ...
RT tag=gbk-nonutf8 rel=c06-gbk-bytes.txt wroteBytes=11 exists=True readBytes=11 match=True ...
RT tag=invalid-utf8 rel=c07-invalid-utf8.bin wroteBytes=8 exists=True readBytes=8 match=True ...
STRICT_UTF8_DECODE_gbk=rejected MethodInvocationException
STRICT_UTF8_DECODE_invalid=rejected MethodInvocationException
RT tag=overwrite-1st rel=c09-overwrite.txt wroteBytes=13 exists=True readBytes=13 match=True ...
RT tag=overwrite-2nd rel=c09-overwrite.txt wroteBytes=21 exists=True readBytes=21 match=True sha256_wrote=1a6eae84c9b20781290809f9880e3d12bb5094758f78928cc5a3e5e7554f310d ...
CJKNAME=a b 文件.txt LEN=10
RT tag=space+cjk-filename rel=a b 文件.txt wroteBytes=7 exists=True readBytes=7 match=True ...
RT tag=cjk-dir-cjk-file rel=中文目录\测试.txt wroteBytes=10 exists=True readBytes=10 match=True ...
RT_TOTAL=11 RT_MATCH=11 RT_ERROR=0
```
* GBK 样本字节 `D6 D0 CE C4 47 42 4B B2 E2 CA D4`（"中文GBK测试"），严格 UTF-8 解码被拒 → 确认是**真正的非 UTF-8 文本**，且逐字节无损。
* 覆盖写：最终文件 21B = `SECOND-CONTENT-LONGER`，sha256 `1a6eae84…f310d`，无残留旧内容。

### 3.3 宿主侧独立反证（#18）
`host-verify.txt`（原样节选）：
```
L11: CHECK run=run1 note='1B=0x41' rel=run1\ws\c01-1byte.bin staged_bytes=1 expected_bytes=1 sha_match=True sha=559aead08264d5...
L86: CHECK run=run2 note='run2 conc #50' rel=run2\ws\conc\c050.bin staged_bytes=8192 expected_bytes=8192 sha_match=True sha=c4b4c6a4a87f...
L174: CHECK_OUTSIDE run=run3 note='desktop' staged=...\staged\fs\C\Users\Administrator\Desktop\r11-d1-out-desktop.txt staged_bytes=14 expected_bytes=14 sha_match=True sha=f96b035b6562...
-- run1 hashed_entries_checked=23 blob_ok=23 blob_mismatch=0 blob_missing=0 manifest_revision=27
-- run4 hashed_entries_checked=90 blob_ok=90 blob_mismatch=0 blob_missing=0 manifest_revision=95
```
统计（对 `host-verify.txt` 全文）：`sha_match=True` **156 行**，`sha_match=False` **0 行**，`CHECK_MISSING`（非预期缺失）**0**，`UNEXPECTED_PRESENT` **0**。
方法：宿主用与沙箱脚本**同一 payload 规格**（含 `System.Random(1337)`、`Random(i)`）重算期望 sha256，再对暂存区落盘文件取真实 sha256 比对。

### 3.4 工作区外写入 + 真实盘零残留（#9）
沙箱内（`run3/.../probe3r-raw.txt:28-43`，节选原样）：
```
OUT tag=Desktop path=C:\Users\Administrator\Desktop\r11-d1-out-desktop.txt write=OK exists=True bytes=14 readback=D1-OUT-Desktop
OUT tag=Documents path=... write=OK exists=True bytes=16 readback=D1-OUT-Documents
OUT tag=WinTemp path=C:\Windows\Temp\r11-d1-out-wintemp.txt write=OK exists=True bytes=14 readback=D1-OUT-WinTemp
OUT tag=SessionTemp path=C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\5a2ec6cf-...\r11-d1-out-sessiontemp.txt write=OK exists=True bytes=18 readback=D1-OUT-SessionTemp
OUT tag=WinTempUnc path=\\?\C:\Windows\Temp\r11-d1-out-wintemp-unc.txt write=OK exists=True bytes=17 readback=D1-OUT-WinTempUnc
OUT tag=Croot path=C:\r11-d1-out-croot.txt write=OK exists=True bytes=12 readback=D1-OUT-Croot
OUT tag=ProgramData path=C:\ProgramData\r11-d1-out-programdata.txt write=OK exists=True bytes=18 readback=D1-OUT-ProgramData
```
宿主真实盘（`host-verify.txt` §3，13 行全为 False；节选）：
```
REALDISK exists=False path=C:\Users\Administrator\Desktop\r11-d1-out-desktop.txt
REALDISK exists=False path=C:\Windows\Temp\r11-d1-out-wintemp.txt
REALDISK exists=False path=C:\r11-d1-out-croot.txt
REALDISK exists=False path=C:\ProgramData\r11-d1-out-programdata.txt
```
**结论：工作区外写入不硬拒、静默进暂存；真实盘硬证据为「零出现」。**
另：真实工作区清单 4 个 run 均为 3 个文件且全是宿主种子（`host-verify.txt` §4），例如 run4：
`probe4c.ps1`、`probe4r.ps1`、`seed.txt`。

### 3.5 并发（#5）
`run4/.../probe4r-raw.txt:96,157-159`（原样）：
```
CONC_WRITE_MS=1345 INVOKE_ERRORS=0
CONC_SUMMARY expected=60 counted=-1 verify_ok=60 verify_bad=0
CONC_COUNT ERROR=System.IO.DirectoryNotFoundException :: Could not find a part of the path '...\run4\ws\conc'.
```
run2（50 并发）：`CONC_VERIFY_OK=50 CONC_VERIFY_BAD=0 CONC_INVOKE_ERRORS=0`（`run2/.../_res/SUMMARY.txt`）。
实现：`runspacefactory` 池（并发上限 8）× 60 个 `AddScript`，每个写 8192B `Random(i)` 载荷；
验证阶段用同一 seed 重算期望 sha256 逐文件比对。全部一致。
> `counted=-1 / CONC_COUNTED=0` 不是写入失败，而是**目录枚举缺陷 D2**（见 3.6）。

### 3.6 缺陷（详见 `fileio-缺陷.md`）
```
run4/.../probe4r-raw.txt:20-24
ENUM dir_exists=True
ENUM GetChildItem_dir ERROR=System.IO.DirectoryNotFoundException :: Could not find a part of the path '...\run4\ws\enumdir'.
ENUM DirGetFiles ERROR=... Exception calling "GetFiles" ... '...\run4\ws\enumdir'.
ENUM GetChildItem_recursive=3
ENUM direct_path_exists=True
```
```
run4/.../probe4r-raw.txt:26-32
REN ok old_exists=False new_exists=True
DELFILE ok exists_after=False
DELTREE ERROR ... Exception calling "Delete" with "2" argument(s): "Could not find a part of the path '...\run4\ws\del'."
DEL_END dir_exists=True a=False renamed=False b=True
DEL2 RemoveItem ERROR System.ComponentModel.Win32Exception :: The system cannot find the file specified
DEL2 DirDelete_nonrecursive ERROR ... "The directory is not empty. "
```
```
run3/.../probe3r-raw.txt:12-14,44-48
TRAIL tag=dot requested=<trail-dot.> write=OK exists_requested=True exists_trimmed=True
TRAIL_WS_ENTRIES=probe3b.ps1|probe3r.ps1|seed.txt
--- LISTING ---
FILE probe3b.ps1 size=1312
FILE probe3r.ps1 size=7203
FILE seed.txt size=4
LISTING_FILE_COUNT=3
```
```
run3/.../probe3r-raw.txt:17,20-23
LONGPATH depth=4 abslen=186 staged_rel_len_would_be=286 ERROR ... "Could not find a part of the path '...\run3\ws\lp4\SSS...'."
LONGPATH depth=10 abslen=337 ... ERROR ... "The specified path, file name, or both are too long. The fully qualified file name must be less than 260 characters...
ULONGPATH abslen=336 unc_len=340
ULONGPATH write=ERROR ... CreateDirectory ... "Could not find a part of the path '\\?\C:\...\run3\ws\ulp\SSS...'."
```

### 3.7 删除的暂存语义与真实盘零残留（#7）
* 单文件删除/改名：`run4 raw:26-27`；`run2` manifest 中 `del\a.txt`、`del\renamed.txt` 条目**已消失** → 改动被暂存层正确抵消。
* 删除宿主预置的真实文件（run2）：宿主反证显示
  ```
  run=run2 manifest non-additive/deleted entries: seed-delete.txt state=deleted baseHash=22618f5d82dfc4597601221cf56b18b947fba8083e19e653d1125f57cf3ceaa0 stagedHash=
  run=run2 real ws seed-delete.txt exists=True sha256=22618f5d82dfc4597601221cf56b18b947fba8083e19e653d1125f57cf3ceaa0
  ```
  即：沙箱内删除被记为**墓碑**，**真实盘文件仍在且 sha256 未变** → 零残留。（`host-verify.txt` §6）
* **not-run**：沙箱内「删除真实种子文件后再次按路径读取」的可见性断言（run2 的逐用例文本因 run1 同款脚本 bug 丢失；
  run4 的同类用例因该 run 的 ws 未预置 `seed-delete.txt` 而不适用 —— `run4 raw:33-35` 记录了 `before_exists=False`，属无效用例）。

### 3.8 跨通道可见性（#17，缺陷 D4）
`run4/.../_res/pwsh-toolchannel.txt`（原样）：
```
TOOLREAD rel=tool-channel.txt exists=False
TOOLREAD rel=c04-empty.bin exists=True bytes=0 sha256=e3b0c442...
```
而同一个 `tool-channel.txt`：DSH `read` 工具回读内容 = `TOOL-CHANNEL-OK-0123456789ABCDEFGHIJ`（36 字符），
宿主侧暂存文件 = `run4/out/stage-root/staged/tool-channel.txt`，36B，sha256 `b892768c…`（`host-verify.txt:185-186`）。
`run3/.../_res/pwsh-toolchannel.txt`（原样）：
```
TOOLREAD path=C:\Users\Administrator\Desktop\r11-d1-tool-desktop.txt exists=False
TOOLREAD path=C:\Users\Administrator\r11-d1-tool-home.txt exists=False
TOOLREAD path=C:\Windows\Temp\r11-d1-tool-wintemp.txt exists=False
```
而宿主侧这 3 个文件在 `staged-ext\`（`run3/out/stage-root/manifest.json` 里 key 为字面绝对路径、`origin=dsh-tool`、`external` 或 `external:true` 记录）：
```
staged-ext\3a\3af3d90edda9b1b8\r11-d1-tool-desktop.txt  size=19
staged-ext\50\50e23d60efbd8050\r11-d1-tool-home.txt     size=16
staged-ext\2c\2ca1fae039d9b05c\r11-d1-tool-wintemp.txt  size=19
```
同时，`read` 工具**能**读到 pwsh 写的文件（run2 step2 读 `_res/SUMMARY.txt`、run3 step2 读 `probe3r-raw.txt`、run4 step2 读 `SUMMARY.txt` 均成功）。
→ 结论：**「工具写 → shell 查」不可见**（单向失败）；反向读（shell 写 → 工具读）正常。

---

## 4. 未覆盖 / 限定

| 项 | 状态 | 说明 |
|---|---|---|
| 沙箱内 `glob`/列目录类 DSH 工具 | `not-run` | 本域只验证了 pwsh 列目录与 `read` 工具直读；D2 的枚举缺陷是否传染 DSH `glob` 未实测 |
| 工作区内符号链接 / 硬链接 / 重解析点 | `not-run` | 不在 D1 必测清单内 |
| 稀疏文件、大于 2MiB（>32MiB 触发抽取器哈希上限） | `not-run` | 2MiB 已覆盖必测项 |
| 真实盘上「staged 应用（apply）」后的落盘一致性 | `not-run` | 本轮只测沙箱内暂存语义；apply/hostOperations 计数在 4 个 run 均为 0（`manifest.hostOperations`） |
| D2/D3 的根因定位 | `[推断]` | 见缺陷 D2/D3 的「推断」段落，未读 shim 源码（`.t/r11/bin/**` 与本域无关，且不得修改） |

## 5. 复现命令

```powershell
# 1) 投递 + 等待（必须 cmd /c + 重定向到文件）
cmd /c "node .t\r11\bin\submit-job.mjs d1-run4 .t\r11\fileio\run4\ws .t\r11\fileio\run4\prompt.txt .t\r11\fileio\run4\out winstage > .t\r11\fileio\run4\submit.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d1-run4 900 > .t\r11\fileio\run4\wait.log 2>&1"
# 2) 宿主侧反证（重算 payload 哈希 + 真实盘 Test-Path/Get-FileHash + blob 一致性）
powershell -NoProfile -ExecutionPolicy Bypass -File .t\r11\fileio\host-verify.ps1
```
