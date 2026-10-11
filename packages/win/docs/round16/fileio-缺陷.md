# 域1 · 文件读写 —— 缺陷清单（R16 / fileio）

> 日期：2026-10-11 · 复现环境：`docs\round10\env\scripts\sbx-thread.cmd` 新开的 6 个独立 DSH 线程
> （5 个 winstage run 全部 `LANE_OK=true`、`tierEffective=TS`、`degraded=false`、`stderr.txt` 0 字节；
> 1 个 platform 对照 `LANE_OK=false`）。
> 全部证据路径相对仓库根 `C:\Users\Administrator\Desktop\dsh-winstage-sandbox`。
> 约定：**实测** = 原样片段；`[推断]` = 未读源码的机理推测；`not-run` = 未测。
> 严重级：**P0** 阻断 / **P1** 重要 / **P2** 次要。**本轮未修改任何源码，全部只报告**（协议 §0.4）。

## 编号与严重级总览

| 编号 | 标题 | 严重级 | 性质 |
|---|---|---|---|
| `R16-FIO-N1` | node 通道 `fs.existsSync` 对 overlay 新建路径**一律假阴性**（而 `readdir`/`read`/`write` 正常） | **P1** | R16 新增观测（与 R11-D2 同族，但 API 面不同） |
| `R16-FIO-N2` | node `fs.rmSync(dir,{recursive:true,force:true})` **静默报告成功但并未删除** | **P1** | R16 新增观测（R11-D1 的"静默化"变体） |
| `R16-FIO-N3` | node 写 NTFS ADS 被**静默改写**为去冒号的兄弟文件（内容可读、可跨文件冲突） | **P2** | R16 新增观测 |
| `R16-FIO-N4` | node `fs.mkdirSync(dir,{recursive:true})` 对**已存在的 overlay 目录**返回 `ENOENT` | **P2** | R16 新增观测 |
| `R16-FIO-N5` | `sbx-thread.cmd` 的 `%RANDOM%` 三连在**同一时钟刻度**内给出相同后缀（隔离只靠 `<outDir>`） | **P2** | 工具/启动器侧（非产品 shim） |
| `R16-FIO-K1…K4` | R15 交接的三个已知项 + R11-D4 的**复验读数**（非新增缺陷，按协议只记录） | K1/K2/K4=P1，K3=P2 | 已知未修，见文末表 |

---

## R16-FIO-N1｜node 通道 `fs.existsSync` 对 overlay 新建路径一律假阴性 —— **P1**

**现象**：沙箱线程内 `node` 子进程（`v24.21.0`）新建的文件/目录：
* `fs.writeFileSync` **成功**、`fs.readFileSync` **能读回且内容一致**、`fs.readdirSync` **能列出**；
* 但 `fs.existsSync(同一路径)` **返回 `false`**（永远），目录亦同；`fs.existsSync` 的假阴性会直接导致
  "写丢了" 的错误结论，任何 `exists → write / exists → skip` 逻辑都会走错分支。

**最小复现**（沙箱线程内，pwsh 工具）：
```powershell
node -e "const fs=require('fs');const p=process.cwd()+'\\n1.txt';fs.writeFileSync(p,'X');console.log('exists='+fs.existsSync(p)+' read='+fs.readFileSync(p,'utf8'))"
# 实测输出： exists=false read=X      <- 写成功、读得到，但 exists 说没有
```

**原始证据**
1. `run6/out/stage-root-23498889131755/staged/fs/C/…/run6/ws/_res2/n2.json` 的 `cases`：
   `n-1byte/n-4kib/n-2mib/n-empty/n-gbk/n-utf8-emoji/n-cjk-name/n-deep-8` **全部** `ok=True, exists=False, match=True`；
   `n-enum`：`dirExists=False, directExists=False`，但 `readdir=[e1.txt…e5.txt]`（同一目录！）。
   宿主抄录：`.t/r16/fileio/host/host-verify.txt:267-274,287`。
2. 宿主侧证明文件**真的存在且字节正确**（假阴性而非写失败）：
   `host-verify.txt:292-346`（node 2MiB、50 个并发文件、深层 leaf 全部 `sha_match=True`）；
   `host-extra.txt:79-81`（`nads-base.txtr16s` 8B = `ADS-DATA`）。
3. 对照组（同一 run 的 PowerShell 通道）：`[IO.File]::Exists` 对 overlay 新文件返回 **True**
   （`p1-raw.txt` 的 `RT … exists=True`）⇒ 假阴性是 **node/libuv 通道特有**，不是"文件不存在"。

**影响**：Agent/脚本用 node 写文件后用 `existsSync` 自检 ⇒ **必然误报失败**；`npm`/`pip`/任何
"先探测再写"的 node 工具链在沙箱内会走错分支（重写、报错、跳过）。
**`[推断]` 机理**：与 R11-D2 同源——暂存层虚拟化了 open/read/write/readdir，但**属性/stat 类查询**
（`existsSync` 走 `GetFileAttributes`）没有 read-through 到 overlay 的合成目录；`.NET File.Exists` 走了
另一条被虚拟化的路径，故两者结论相反。
**建议修复**：在 shim 的属性查询路径上补 overlay 合成目录的 read-through（与 R11-D2 的枚举修复同一处），
或在 lane 里显式声明"overlay 元数据查询不可靠"。**验证方式**：`run6` 的 `n2.json` 用例重跑后应变为 `exists=True`。

---

## R16-FIO-N2｜node 递归删除 `force:true` 下**静默成功**（实际未删） —— **P1**

**现象**：`fs.rmSync(dir, {recursive:true, force:true})` **不抛异常**、`existsAfter=false`，
但目录与其中的文件**仍然留在暂存区**。调用方若用 `force:true`（清理临时目录的常见写法）
会得到"既没报错、文件也还在"的**静默未清理**。

**最小复现**（沙箱线程内）：
```powershell
node -e "const fs=require('fs'),p=require('path');const d=p.join(process.cwd(),'ndel','sub');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'b.txt'),'BBB');fs.rmSync(p.join(process.cwd(),'ndel'),{recursive:true,force:true});console.log('after='+fs.existsSync(p.join(process.cwd(),'ndel')))"
# 实测输出： after=false   <- 但宿主在暂存区仍看到 ndel\sub\b.txt
```

**原始证据**
1. `run6/.../_res2/n2.json`：`n-rmdir-recursive ok=True existsAfter=false bExistsAfter=false`
   （`host-verify.txt:288`）。
2. 宿主在暂存树中确认文件仍在：`staged/fs/C/…/run6/ws/ndel/sub/b.txt`，3 B，内容 `BBB`。
3. PowerShell 对照（抛错而不是静默）：`run1` 的
   `DELTREE ERROR … "Could not find a part of the path '…\ws\del'."`、
   `DEL2 RemoveItem ERROR Win32Exception :: The system cannot find the file specified`、
   `DEL3 rmdir rc=145 out=The directory is not empty.`（`p1-raw.txt`；`host-verify.txt:118-127`），
   且 `del\sub\b.txt`/`del2\x\y\c.txt`/`del3\s\d.txt` 均仍在暂存（`host-verify.txt:42-44`）。
   ⇒ **差异点**：PowerShell 会抛错（调用方至少知道失败），node 在 `force:true` 下**吞掉失败**。

**影响**：`rm -rf` 语义在沙箱内不可用；`force:true` 让它变成**静默数据残留**，比 R11-D1 更难发现。
**`[推断]` 机理**：同 R11-D1（递归删除需要目录枚举/句柄，暂存层不成立）；`force:true` 把底层错误吞掉。
**建议修复**：修 R11-D1 的枚举/删除路径；在此之前，node/RimRaf 类工具在沙箱内应把"递归删除后仍存在"
判为**产品级告警**写入 lane。**验证方式**：`n-rmdir-recursive` 用例应变为宿主暂存树中目录消失。

---

## R16-FIO-N3｜node 写 ADS 被静默改写为"去冒号兄弟文件" —— **P2**

**现象**：同一逻辑路径（`…\nads-base.txt:r16s`）在两个通道下行为不一致：
* **PowerShell**：`[IO.File]::Create("…\ads-base.txt:r16stream")` → **硬拒** `The given path's format is not supported`（R11 结论复现）；
* **node**：`fs.writeFileSync("…\nads-base.txt:r16s")` → **成功**，内容落成**兄弟文件 `nads-base.txtr16s`**（冒号被静默丢弃），
  `fs.readFileSync` 同路径还能读回（shim 反向映射），而 `fs.readdirSync` 看到的是 `nads-base.txtr16s`。

**最小复现**（沙箱线程内）：
```powershell
node -e "const fs=require('fs');const b=process.cwd()+'\\nads-base.txt';fs.writeFileSync(b,'BASE-DATA');fs.writeFileSync(b+':s','ADS-DATA');console.log(fs.readFileSync(b+':s','utf8'),fs.readdirSync(process.cwd()).filter(n=>n.startsWith('nads')))"
```

**原始证据**
1. `run6/.../_res2/n2.json`：`n-ads ok=True readback=ADS-DATA match=True streamPath=…\nads-base.txt:r16s`；
   `wsReaddirTop` 中出现 `nads-base.txtr16s`（无冒号）。
2. 宿主：`staged/fs/C/…/run6/ws/nads-base.txtr16s` 8 B，sha `7a4421071da4e64ba8d68b1dbd4f418ed18ab7883cba388a8890e460b60718e2`
   = `sha256('ADS-DATA')`；同目录 `nads-base.txt` 9 B = `BASE-DATA`（`host-extra.txt:78-83`）。
3. PowerShell 对照：`p1-raw.txt` `ADS write=ERROR … The given path's format is not supported.`；
   `p2-raw.txt` `ADS_OUT write=ERROR`（同一结论，工作区外亦然）。

**影响**：①同一路径的"支持/拒绝"依赖调用通道，行为不可预期；②冒号被丢弃意味着
`a.txt:X` 与真实文件 `a.txtX` **同名冲突**，可能静默覆盖真实文件或读到错误的流内容；
③若被当作"ADS 可用"，后续读取/回放语义与原意不符。
**建议修复**：统一 ADS 判定（要么两条通道都硬拒并给一致错误码，要么显式实现 stream 命名空间且**保留** `:`），
禁止"丢字符"式归一化。**验证方式**：两条通道对同一 ADS 路径给出相同结论。

---

## R16-FIO-N4｜node `mkdirSync(recursive:true)` 对已存在的 overlay 目录返回 `ENOENT` —— **P2**

**现象**：第一次 `fs.mkdirSync('<ws>\ndev', {recursive:true})` 成功（宿主能看到暂存目录 `ndev`），
随后对**同一已存在目录**再次 `mkdirSync(..., {recursive:true})` 返回
`ENOENT: no such file or directory, mkdir '…\ndev'`；6 个保留名用例因此全部以 `mkdir` 失败告终
（而不是"目录已存在 → 继续写文件名"）。

**最小复现**（沙箱线程内）：
```powershell
node -e "const fs=require('fs');const d=process.cwd()+'\\ndev';fs.mkdirSync(d,{recursive:true});console.log('1st ok');try{fs.mkdirSync(d,{recursive:true});console.log('2nd ok')}catch(e){console.log('2nd '+e.code)}"
# 实测： 1st ok / 2nd ENOENT
```

**原始证据**
1. `run6/.../_res2/n2.json`：`n-devname-CON` 报 `ENOENT … open '…\ndev\CON'`（×1 次 mkdir 成功后的 open 失败），
   `n-devname-PRN/AUX/NUL/COM1/LPT1/COM9` **全部**报 `ENOENT … mkdir '…\ndev'`（`host-verify.txt:275-281`）。
2. 宿主确认 `staged/fs/C/…/run6/ws/ndev` **存在**（目录已暂存）⇒ 不是"目录没建成"。
3. 说明 `recursive:true` 的"已存在则成功"语义在 overlay 目录上不成立。
**影响**：node 工具链里 `mkdirSync(dir,{recursive:true})`（极常见）对沙箱内新建目录的第二次调用会抛错，
导致保留名/幂等建目录类逻辑误判。
**`[推断]` 机理**：shim 的 `CreateDirectory` 路径对"staged-only 已存在目录"未按 `ERROR_ALREADY_EXISTS` 处理，
被映射成 `ENOENT`（错误码语义错误）。与 R11-D2/N1 的 overlay 元数据缺口同源。
**建议修复**：overlay 目录的 `CreateDirectory` 应返回 `ERROR_ALREADY_EXISTS`（node 侧即"成功"），
而不是 `ENOENT`。**验证方式**：上述两行复现应输出 `1st ok / 2nd ok`。

---

## R16-FIO-N5｜启动器 `%RANDOM%` 三连同刻度撞名（隔离实际靠 `<outDir>`） —— **P2（工具侧）**

**现象**：`sbx-thread.cmd` 用 `set "STAGE_ROOT=%OUT%\stage-root-%RANDOM%%RANDOM%%RANDOM%"` 生成"每次唯一"的暂存根。
两次**同一时钟刻度**并发的启动给出的后缀**完全相同**：
* `run1` 与 `run2`：`stage-root-22498294474807`（`started_at` 17:50:31.29 / .22）
* `pA` 与 `pB`：`stage-root-231352823414912`（`started_at` 17:53:46.89 / .88）

**原始证据**：`.t/r16/fileio/host/host-extra.txt:85-92`；各 run `out/meta.txt` + `out/stage-root-path.txt`。
**影响（实测边界，不外推）**：本轮**隔离仍然成立**，因为完整暂存根 = `<outDir>\stage-root-<后缀>`，而协议要求
每个 run 用独立 `<outDir>`（§1）。但"后缀唯一性"这一层保护在同刻度并发下**失效**：若两个 run 共用 `<outDir>`
（或将来改用固定 `<outDir>` 的重跑/重试），将直接指向**同一个**暂存根，可能撞 `StageGuardUnavailableError`
或交叉污染；R10 §4.1 中"随机后缀保证分离"的说法在本轮读数下**需要修正为"靠 outDir 分离"**。
**建议修复（属 `docs/round10/env/scripts/`，本轮不得改）**：后缀改用真正唯一的值，例如
`for /f %%g in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(''N'')"') do set "SUF=%%g"`，
或至少叠加 `%TIME%`/进程号；并在脚本注释里把"唯一性来自 outDir"写清。
**验证方式**：同一刻并发两次，两个 `stage-root-path.txt` 叶子名应不同。

---

## 已知项复验（K1–K4）—— 按协议 §4 **不作为新缺陷**，但 R16 读数为准

| 编号 | 已知项（来源） | R16 复验读数 | 证据 | 严重级 |
|---|---|---|---|---|
| `R16-FIO-K1` | `Get-ChildItem` 对 overlay 新建目录枚举不可见（R15 §0 明示"golden 不含 R12 的 P0 枚举修复"；R11-D2） | **复现，形态变化**：`Get-ChildItem -LiteralPath <新建目录> -File` → **count=0**（R11 是抛 `DirectoryNotFoundException`）；`[IO.Directory]::GetFiles` / `GetFileSystemEntries` → 抛 `DirectoryNotFoundException`；`Get-ChildItem -Recurse -File` 只数到真实盘种子 **3**；而按路径读写、`Directory.Exists` 均正常；node `readdir` 反而**正确**（见 N1） | `run1/.../_res/p1-raw.txt` `ENUM*`；抄录 `host-verify.txt:112-117`；宿主证明文件确在暂存 `host-verify.txt:37-41` | P1 |
| `R16-FIO-K2` | 递归删除目录失败（R11-D1） | **复现**：`[IO.Directory]::Delete(dir,$true)` 抛 `Could not find a part of the path`；`Remove-Item -Recurse -Force` 抛 `Win32Exception`；`cmd rmdir /s /q` **rc=145** `The directory is not empty.`；三种写法的目标文件全部仍在暂存；单文件 `Move`/`Delete` 正常 | `p1-raw.txt` `DEL0/REN/DELFILE/DELTREE/DEL_END/DEL2*/DEL3`；`host-verify.txt:42-44,118-127` | P1 |
| `R16-FIO-K3` | 长路径阈值被暂存前缀吃掉（R11-D3；R15 交接读数=逻辑 158） | **复现并细化为算术**：本夹具 `stage_root_len=100` ⇒ `stagedLen = 逻辑长度 + 110`；单调扫描**逻辑 145 OK / 166 FAIL**（暂存 255 / 276，260 处断）；显式**逻辑 158/248/300 全失败**（158 报 `The specified path … too long`，248/300 报误导性的 `Could not find a part of the path`）；`\\?\` 加在 ws 内长路径上仍失败，且错误为 **`Access to the path … is denied`**（不是长度错）——而 `\\?\C:\Windows\Temp\…` 被规范化后**成功**暂存；node 侧 `mkdirSync` 到 300/500 报 `ENOENT`（同样误导） | `p1-raw.txt` `LONGPATH*`/`ULONGPATH*`；`p2-raw.txt` `LPTARGET*`；算术 `host-extra.txt:27-37`；落点 `host-extra.txt:47-76` | P2（R11 定级=中；**未修**） |
| `R16-FIO-K4` | DSH 文件工具与 shell 的暂存命名空间互不可见（R11-D4） | **复现（3 个 run）**：`write` 工具 → `staged\tool-channel.txt`（36 B，sha `b892768c3948c9544ec95ad9b4563e0534d732225adb3dc920e944779c0e3e05`）；沙箱 shell 对同一绝对路径 `[IO.File]::Exists` = **False**（`TOOLREAD rel=tool-channel.txt exists=False bytes=-1`）；`read` 工具能读回；**平台对照 run 亦然**（shell 回到真实盘时该文件仍只在暂存） | `host-extra.txt:39-44`；`run*/out/stdout.ndjson` 的 `LINE_TOOL_READBACK`；`host-verify.txt:356` | P1 |

### 附带复现的非缺陷行为（供验收区分）

| 行为 | R16 读数 | 证据 |
|---|---|---|
| 保留设备名 `CON/PRN/AUX/NUL/COM1/LPT1/COM9` | PowerShell 与 node **双双硬拒**（错误文案不同：PS `Could not find a part of the path`/NUL 特判、node `ENOENT`）；`dev\` 目录本身会被暂存；真实盘零残留 | `p1-raw.txt` `devname-*`；`n2.json`；`host-verify.txt:30-36` |
| 尾点 / 尾空格文件名的规范化 | PowerShell 侧写 `trail-dot.`/`trail-sp ` 后**按去尾字符名**存在（`exists_trimmed_*=True`）；node 侧因 N1 的假阴性无法用 `existsSync` 判断，但宿主确认落成 `ntrail-dot`/`ntrail-sp`（5 B） | `p1-raw.txt` `TRAIL`；`n2.json`；`host-verify.txt:344-345` |
| 大小写 | `CaseTest.txt` 写入后 `casetest.txt` 可读且内容一致（`aliased=True`）——Windows 平台一致行为 | `p1-raw.txt` `CASE` |
| 工作区外写入 | 14/14 暂存成功、真实盘 15 处 `exists=False`（UNC 管理共享宿主可达，负证有效） | `p2-raw.txt`；`host-verify.txt:143-171` |
| 会话 TEMP | `$env:TEMP` 被改写为 `…\dsh-stage-temp\<guid>`（pwsh 与 node 一致） | `p2-raw.txt` `TEMP_ENV`；`n2.json` `env.TEMP` |
| 沙箱内 cwd | pwsh `(Get-Location).Path` 与 node `process.cwd()` 均为 `<stage-root>\staged`（R10-D3） | `p2-raw.txt` `CWD`；`host-extra.txt:94-97` |
| 平台对照（`WINSTAGE_SHELL=0`） | pwsh 写真实盘（ws/Desktop/`%TEMP%` 三处 `exists=True`），而 `write` 工具产物仍在暂存 ⇒ 两个面不同步 | `host-verify.txt:351-356` |

---

## 证据强度声明

* N1/N2/N3/N4 的**观测**均有原始文件 + 原样片段（沙箱内 JSON + 宿主侧独立反证）；
  其**根因**均标 `[推断]`，未读也未修改 shim 实现（协议 §0.4）。
* N1/N2/N4 在**同一 run 的 5–8 个用例**中重复出现（run6），另有 PowerShell/DotNet 对照通道给出相反行为；
  N3 有 PowerShell 对照通道的相反结论；N5 在**两对并行 run**中各自复现。
* 本轮**未修改任何仓库源码/受保护 profile**，未 kill 3080 宿主，未 spawn 新 teammate；
  `.t/r16/fileio/**` 与 `docs/round16/**` 敏感材料扫描 0 命中（`host-verify.txt:358-359`）。
