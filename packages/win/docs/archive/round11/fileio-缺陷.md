# D1 文件读写与落盘完整性 —— 缺陷清单（R11 / t1-fileio）

* 日期：2026-10-10
* 复现环境：新开的带 WinStage 沙箱的 DSH 线程（`dsh --profile sbx`，`WINSTAGE_SHELL=1`），
  每次 run 的 `lane.txt` 均为 `LANE_OK=true (tierEffective=TS, degraded=false)`，`stderr.txt` 为 0 字节。
* 全部证据路径相对仓库根 `C:\Users\Administrator\Desktop\dsh-winstage-sandbox`。
* 标注约定：实测=原样片段；`[推断]`=未读源码的机理推测。

---

## D1｜缺陷：**递归删除目录在暂存层失败**（严重）

**现象**：沙箱内可以对文件 `Move`/`Delete`，但**递归删除目录**的三种常见写法全部失败，且目录内文件原样留在暂存区。

**最小复现**（PowerShell 5.1，沙箱内；`$ws` = 该 run 的工作区绝对路径）
```powershell
[IO.Directory]::CreateDirectory("$ws\del\sub") | Out-Null
[IO.File]::WriteAllText("$ws\del\a.txt", 'AAA')
[IO.File]::WriteAllText("$ws\del\sub\b.txt", 'BBB')
[IO.File]::Move("$ws\del\a.txt", "$ws\del\renamed.txt")   # OK
[IO.File]::Delete("$ws\del\renamed.txt")                  # OK
[IO.Directory]::Delete("$ws\del", $true)                  # ← 抛 DirectoryNotFoundException
Remove-Item -LiteralPath "$ws\del2" -Recurse -Force       # ← 抛 Win32Exception
[IO.Directory]::Delete("$ws\del2\x\y", $false)            # ← "The directory is not empty."
```

**原始证据**
1. `.t/r11/fileio/run4/out/stage-root/staged/fs/C/Users/Administrator/Desktop/dsh-winstage-sandbox/.t/r11/fileio/run4/ws/_res/probe4r-raw.txt` 第 25-32 行：
```
DEL0 dir_exists=True a_exists=True b_exists=True
REN ok old_exists=False new_exists=True
DELFILE ok exists_after=False
DELTREE ERROR System.Management.Automation.MethodInvocationException :: Exception calling "Delete" with "2" argument(s): "Could not find a part of the path 'C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r11\fileio\run4\ws\del'."
DEL_END dir_exists=True a=False renamed=False b=True
DEL2_0 dir_exists=True c_exists=True
DEL2 RemoveItem ERROR System.ComponentModel.Win32Exception :: The system cannot find the file specified
DEL2 DirDelete_nonrecursive ERROR System.Management.Automation.MethodInvocationException :: Exception calling "Delete" with "2" argument(s): "The directory is not empty. "
```
2. 同一现象在 run2 复现（`.t/r11/fileio/run2/out/stdout.ndjson` 中 pwsh 工具结果 stderr）：
```
Exception calling "Delete" with "2" argument(s): "Could not find a part of the path '...\run2\ws\del'."
Remove-Item : The system cannot find the file specified
```
3. 宿主侧证明「目录没被删掉」——run2/run4 的暂存区仍保留原本应被递归删除的文件：
```
.t/r11/fileio/host-verify.txt:87  CHECK run=run2 note='run2 del\sub\b.txt (recursive delete failed -> still staged)' ... sha_match=True
.t/r11/fileio/host-verify.txt:88  CHECK run=run2 note='run2 del2\x\y\c.txt (Remove-Item -Recurse failed -> still staged)' ... sha_match=True
.t/r11/fileio/host-verify.txt:151 CHECK run=run4 note='run4 del\sub\b.txt survived recursive delete' ...
.t/r11/fileio/host-verify.txt:152 CHECK run=run4 note='run4 del2\x\y\c.txt survived Remove-Item -Recurse' ...
```
4. `[IO.Directory]::Exists($del)` 为 `True`、目录内文件可正常按路径读写，但删除动作找不到该目录（"Could not find a part of the path"）。

**影响**：`清理临时目录`、`删除构建产物`、`rm -rf` 语义在沙箱内**不可用**；调用方若只看异常并吞掉，会得到"静默未清理"的结果。
**`[推断]` 机理**：删除走的是「目录句柄/枚举」路径，而暂存层对新建目录的枚举/句柄映射不成立（与 D2 同源），
导致 recursive 删除在打开目录阶段就失败；单文件删除不需要目录句柄，故可用。
**未验证**：`cmd /c rmdir /s /q`、`[IO.Directory]::Delete` 对**真实盘已存在**目录的递归删除（`not-run`）。

---

## D2｜缺陷：**沙箱内目录枚举看不到本次写入**（严重）

**现象**：`Get-ChildItem` / `[IO.Directory]::GetFiles` 对**本次会话内新建**的目录返回
`DirectoryNotFoundException`（或对工作区根只返回宿主预置种子），但**按完整路径直接读写这些文件完全正常**。

**最小复现**（沙箱内）
```powershell
$d = "$ws\enumdir"
[IO.Directory]::CreateDirectory($d) | Out-Null
1..5 | ForEach-Object { [IO.File]::WriteAllText("$d\e$_.txt", "E$_") }
[IO.Directory]::Exists($d)                 # True
[IO.File]::Exists("$d\e1.txt")             # True（内容可读）
Get-ChildItem -LiteralPath $d -File       # ← DirectoryNotFoundException
[IO.Directory]::GetFiles($d)               # ← 同样的异常
Get-ChildItem -LiteralPath $ws -Recurse -File | Measure-Object   # ← 只数到宿主种子（3）
```

**原始证据**
1. `.t/r11/fileio/run4/.../run4/ws/_res/probe4r-raw.txt` 第 20-24 行：
```
ENUM dir_exists=True
ENUM GetChildItem_dir ERROR=System.IO.DirectoryNotFoundException :: Could not find a part of the path 'C:\...\run4\ws\enumdir'.
ENUM DirGetFiles ERROR=System.Management.Automation.MethodInvocationException :: Exception calling "GetFiles" with "1" argument(s): "Could not find a part of the path 'C:\...\run4\ws\enumdir'."
ENUM GetChildItem_recursive=3
ENUM direct_path_exists=True
```
2. run3 独立复现（`.t/r11/fileio/run3/.../run3/ws/_res/probe3r-raw.txt` 第 14、44-48 行）：
```
TRAIL_WS_ENTRIES=probe3b.ps1|probe3r.ps1|seed.txt
--- LISTING ---
FILE probe3b.ps1 size=1312
FILE probe3r.ps1 size=7203
FILE seed.txt size=4
LISTING_FILE_COUNT=3
```
（该 run 实际写入了 dev/、lp4…lp12/、sub/、ulp/、ads-base.txt、dupsep.txt、readonly.txt、trail-dot、trail-sp、`_res/` 等，枚举一概看不见。）
3. run2/run4 的并发目录同样枚举不到（`CONC_COUNTED=0` / `counted=-1`、`CONC_DIRFILES` 异常），
   而 60/60 个文件按路径读回且 sha256 全部一致：
```
.t/r11/fileio/run4/.../probe4r-raw.txt:157-159
CONC_COUNT ERROR=System.IO.DirectoryNotFoundException :: Could not find a part of the path 'C:\...\run4\ws\conc'.
CONC_DIRFILES ERROR=... Exception calling "GetFiles" ...
CONC_SUMMARY expected=60 counted=-1 verify_ok=60 verify_bad=0
```

**影响**：任何"先写文件再列目录确认"的自检都会**误报失败**；依赖 `readdir` 的工具链
（列目录、增量扫描、打包、`glob`）在沙箱内对本次写入不可见。这是**最容易造成 Agent 误判**的一类问题。
**`[推断]` 机理**：暂存层把「文件路径」重定向到 `staged\fs\<盘符>\...`，但**目录枚举**没有走同一套虚拟化
（或未做 read-through 合并），于是枚举看到的是真实盘的目录视图。
**未验证**：DSH 自带 `glob`/列目录工具是否同样受影响（`not-run`）。

---

## D3｜缺陷：**长/深路径阈值被暂存根前缀吃掉（186 字符即失败）**（中）

**现象**：工作区内绝对路径长度 **186 字符**（远小于 MAX_PATH 260）的写入就失败；
浅路径（<约 180）正常。`\\?\` 长路径前缀同样失败。

**最小复现**（沙箱内）
```powershell
$seg = 'S' * 24
$rel = 'lp4'; 1..4 | ForEach-Object { $rel += '\' + $seg }      # 绝对路径 186 字符
[IO.Directory]::CreateDirectory((Join-Path $ws ($rel)))          # ← "Could not find a part of the path"
$ulp = '\\?\' + (Join-Path $ws ($rel + '\leaf.txt'))
[IO.File]::WriteAllText($ulp, 'X')                               # ← 同样失败
```

**原始证据**：`.t/r11/fileio/run3/.../run3/ws/_res/probe3r-raw.txt` 第 17-23 行
```
LONGPATH depth=4 abslen=186 staged_rel_len_would_be=286 ERROR ... "Could not find a part of the path '...\run3\ws\lp4\SSSS...'."
LONGPATH depth=6 abslen=236 staged_rel_len_would_be=336 ERROR ... "Could not find a part of the path '...\run3\ws\lp6\SSSS...'."
LONGPATH depth=8 abslen=286 staged_rel_len_would_be=386 ERROR ... "Could not find a part of the path '...\run3\ws\lp8\SSSS...'."
LONGPATH depth=10 abslen=337 staged_rel_len_would_be=437 ERROR ... "The specified path, file name, or both are too long. The fully qualified file name must be less than 260 characters, and the directory name must be less than 248 characters."
LONGPATH depth=12 abslen=387 staged_rel_len_would_be=487 ERROR ... "The specified path, file name, or both are too long. ..."
ULONGPATH abslen=336 unc_len=340
ULONGPATH write=ERROR ... "Could not find a part of the path '\\?\C:\...\run3\ws\ulp\SSSS...'."
```
旁证（另一次 run）：run1 的 40 层深路径（绝对路径约 253 字符）是该 run **唯一**失败用例
（`RT_TOTAL=12 RT_MATCH=11 RT_ERROR=1`，`run1/.../ws/_res/SUMMARY.txt`），宿主侧确认该 leaf 文件不存在：
```
.t/r11/fileio/host-verify.txt:31 CHECK_MISSING_AS_EXPECTED run=run1 note='deep path 40 levels leaf (run1 RT_ERROR)' rel=run1\ws\c08-deep\d01\...\d40\leaf.txt
```
反之，**浅路径**同样机制下全部成功（`host-verify.txt:11-30`）。

**影响**：位于较深目录下的仓库/npm 缓存/pnpm store（路径常 >180 字符）在沙箱内会**误报"路径不存在"**；
错误信息是 `Could not find a part of the path`（误导性：路径其实存在）。
**`[推断]` 机理**：shim 把绝对路径映射为 `<stage-root>\staged\fs\<盘符>\<原路径>`，
stage root 前缀约 100 字符，因此**可用预算 ≈ 260 − 前缀 ≈ 160–190**；`\\?\` 前缀在映射时被规范化掉，
没有真正启用长路径支持。
**建议**（供 Lead 决策，不在本域改动范围）：把 `WINSTAGE_STAGE_ROOT` 放到更短的路径（如 `C:\r11s\<job>`）可显著抬高阈值，需另测验证。

---

## D4｜缺陷：**DSH 文件工具与 shell 的暂存命名空间互不可见（单向）**（严重）

**现象**：同一沙箱线程内，
* DSH `write` 工具把工作区内文件写到 **`<stage-root>\staged\<相对路径>`**；
  把工作区外文件写到 **`<stage-root>\staged-ext\<hash前2>\<hash16>\<basename>`**（manifest 里以**字面绝对路径**为 key，`origin=dsh-tool`）。
* shell（pwsh）把同一绝对路径写到 **`<stage-root>\staged\fs\<盘符>\<原路径>`**。
* 于是 **shell 看不到 `write` 工具刚写的文件**：`[IO.File]::Exists(同一路径)` 返回 `False`。
* 反向（shell 写 → DSH `read` 工具读）**正常**，`read` 工具似乎有多个候选回退，因此不易察觉。

**最小复现**
```
1. write 工具： file_path = C:\...\run4\ws\tool-channel.txt, content = TOOL-CHANNEL-OK-0123456789ABCDEFGHIJ
2. read  工具： 同一路径 → 返回内容 TOOL-CHANNEL-OK-0123456789ABCDEFGHIJ（成功）
3. pwsh：       [IO.File]::Exists('C:\...\run4\ws\tool-channel.txt') → False
                （宿主机上该文件确实存在：out\stage-root\staged\tool-channel.txt，36B）
```

**原始证据**
1. `.t/r11/fileio/run4/.../run4/ws/_res/pwsh-toolchannel.txt` 第 1 行（pwsh 视角）：
```
TOOLREAD rel=tool-channel.txt exists=False
```
2. 同一 run 的 `read` 工具回读（`.t/r11/fileio/run4/out/stdout.ndjson` final）：
```
LINE_TOOL_READBACK=TOOL-CHANNEL-OK-0123456789ABCDEFGHIJ
```
3. 宿主侧证明工具写入真实落盘在**另一处**：
```
.t/r11/fileio/host-verify.txt:185 CHECK_WRITETOOL run=run4 rel=tool-channel.txt staged_bytes=36 expected_bytes=36 sha_match=True sha=b892768c3948c9544ec95ad9b4563e0534d732225adb3dc920e944779c0e3e05
（路径 = .t/r11/fileio/run4/out/stage-root/staged/tool-channel.txt）
```
4. 工作区外同样分裂。pwsh 视角（`.t/r11/fileio/run3/.../run3/ws/_res/pwsh-toolchannel.txt`）：
```
TOOLREAD path=C:\Users\Administrator\Desktop\r11-d1-tool-desktop.txt exists=False
TOOLREAD path=C:\Users\Administrator\r11-d1-tool-home.txt exists=False
TOOLREAD path=C:\Windows\Temp\r11-d1-tool-wintemp.txt exists=False
```
   而 `read` 工具在这些路径上回读成功（run3 final `LINE_TOOLREAD`），宿主侧文件位于 `staged-ext\`：
```
.t/r11/fileio/run3/out/stage-root/staged-ext\3a\3af3d90edda9b1b8\r11-d1-tool-desktop.txt  size=19
.t/r11/fileio/run3/out/stage-root/staged-ext\50\50e23d60efbd8050\r11-d1-tool-home.txt     size=16
.t/r11/fileio/run3/out/stage-root/staged-ext\2c\2ca1fae039d9b05c\r11-d1-tool-wintemp.txt  size=19
（manifest.json 中 key 为字面路径、origin=dsh-tool、external=true）
```
5. 反向正常（shell 写 → `read` 工具读到）：run2/run3/run4 的 prompt 第 2 步都用 `read` 工具读取 **pwsh 写出**的
   `_res/SUMMARY.txt`、`_res/probe3r-raw.txt`，全部成功返回内容。

**影响**：Agent 若「用 `write` 工具写 → 用 shell 校验」，会得到**假阴性（文件丢失）**；若据此重写或报错，会污染诊断结论。
**`[推断]` 机理**：DSH fs 工具与 shim 各自维护路径→暂存路径的映射规则（工具：工作区相对/内容寻址；shim：`fs\<盘符>`），
两套规则对同一路径给出不同暂存位置；`read` 工具带多候选回退掩盖了不一致，`write`/shell 单点判定则暴露。
**未验证**：`edit` 工具是否与 `write` 同规则（`not-run`）。

---

## 非缺陷（行为记录，供验收时区分）

| 行为 | 实测 | 证据 |
|---|---|---|
| 保留设备名 `CON/PRN/AUX/COM1/LPT1/COM9` | 硬拒（`Could not find a part of the path`），未写设备、未污染真实盘 | `run3/.../probe3r-raw.txt:5-11`；`host-verify.txt:159-165` 全为 `CHECK_MISSING_AS_EXPECTED` |
| `NUL` | 硬拒：`FileStream was asked to open a device that was not a file` | `run3/.../probe3r-raw.txt:8` |
| 尾点 / 尾空格文件名 | **静默改名为去掉尾字符的名字**（`trail-dot.`→`trail-dot`、`trail-sp `→`trail-sp`）；`exists_requested=True` 是 Windows 归一化的假象。与平台行为一致，但调用方需知道拿到的是改名后的文件 | `run3/.../probe3r-raw.txt:12-14`；`host-verify.txt:153-154` |
| NTFS ADS `file:stream` | 硬拒：`The given path's format is not supported`；`Get-Item -Stream *` 亦失败 | `run3/.../probe3r-raw.txt:15-16` |
| 只读文件覆盖 | 硬拒：`Access to the path ... is denied`（平台一致） | `run3/.../probe3r-raw.txt:27` |
| 工作区外写入（Desktop/主目录/Documents/`C:\Windows\Temp`/会话 TEMP/`C:\` 根/ProgramData/`..` 穿越） | **不硬拒、静默暂存**；真实盘 13/13 `Test-Path=False` | `run3/.../probe3r-raw.txt:28-43`；`host-verify.txt` §3 |
| 会话 TEMP | 沙箱内 `$env:TEMP` 被改写为 `<stage-root 侧临时目录>\dsh-stage-temp\<guid>`（非真实 `%TEMP%`） | `run3/.../probe3r-raw.txt:4` |
| 并发写 | 50/50、60/60 全部存在且 sha256 一致，无错乱 | `run4/.../probe4r-raw.txt:96,97-159`；`run2/.../_res/SUMMARY.txt` |

## 证据强度声明

* 本清单中 D1–D4 的**观测**均有原始文件 + 原样片段；D2/D3/D4 的**根因**标注为 `[推断]`，未阅读并不得修改 shim 实现。
* D2/D4 各在 **2 次独立 run** 中复现（D2: run3+run4；D4: run3+run4），D1 在 2 次 run 中复现（run2+run4），D3 有 run1+run3 两处独立证据。
* 本域**未修改任何产品代码**，未触碰 `~/.dsh/**`、`profiles/web`、`.t/r11/bin/**`、`.t/r11/home/**`，未 kill 3080 宿主。
