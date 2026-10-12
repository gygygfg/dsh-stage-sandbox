# Lead 独立复核记录（不依赖队友，通道级取证）

工作区根：`C:\Users\Administrator\Desktop\WinStageSandbox`
本会话 stageRoot：`.dshstage\sessions\session-eb7c901d-97ed-4f83-9096-33c97138c361\staged`
DSH 文件策略：`workspace-write`；宿主为 Windows（受限令牌 + `winstage-shim.dll` IAT 注入）。

## L-01 写入隔离：真实磁盘零改动（PASS，多通道）

- 工作区外写入（`C:\Windows\Temp`、`%USERPROFILE%`、`%LOCALAPPDATA%\Temp`、`C:\ProgramData`）在 PS 通道**全部报告成功并可回读**，
  但 `cmd /c dir`、`reg.exe query` 与该路径的真实磁盘状态均为 not-found；内容出现在
  `staged\fs\<盘符>\<路径>`。
- 结论：写/改**不落真实磁盘**，进 staging 候选。这是本沙箱唯一稳定成立的核心保证。

## L-02 【高】硬链接别名可在**真实磁盘**上生成，且删除不生效

复现（全部本机实测，`_sandbox-tests\_lead\hardlink-*.txt` 为原始输出）：

1. `mklink /H <工作区>\_sandbox-tests\_lead\hardlink-alias.txt C:\Users\Administrator\.npmrc` → `exit 0`
   - `fsutil hardlink list C:\Users\Administrator\.npmrc` 输出**两条**：
     `\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\_lead\hardlink-alias.txt`
     `\Users\Administrator\.npmrc`
   - ⇒ 该硬链接**真的建在宿主磁盘上**，位于工作区外指向的路径、且未进候选审批面。
2. 经别名写入：`Set-Content -LiteralPath <别名> -Value <marker>` → PS 回读为新值；
   但**真实 `.npmrc` 内容与 SHA256 完全未变**（`3FC62C79…12BC`，长度 40，内容仍为原镜像配置）
   ⇒ 写入本身被 staging 拦住了（安全）。
3. **删除不生效**：`Remove-Item` 与 `cmd /c del /f /q` 均 `exit 0`，PS `Test-Path` = False，
   但 `cmd /c dir /b <别名>` **仍然列出该文件**，`fsutil hardlink list` **仍列出两条**。
   ⇒ 别名是真实磁盘上的**持久残留**，沙箱内两种删除都只是把删除动作暂存了（白障/墓碑语义）。
4. **残留无法从沙箱内清除**：另试 `Add-Type`/P-Invoke `DeleteFileW`（`A required privilege is not
   held by the client`，被拒）、`fsutil hardlink list`（仍列出两条）均无效；
   `.npmrc` 内容与 SHA256 始终未变（`3FC62C79…12BC`）。
5. **测试遗留物（已声明，需宿主侧清理）**：
   `_sandbox-tests\_lead\hardlink-alias.txt` —— 一个指向 `C:\Users\Administrator\.npmrc` 的
   **真实硬链接**，沙箱内不可删。宿主侧清理（普通用户即可）：
   `cmd /c del /f "C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\_lead\hardlink-alias.txt"`
   该命令无害：硬链接只是同一文件对象的另一个名字，删除它不改 `.npmrc` 内容。

判定：**写入隔离成立，但「对象身份/目录项」的隔离不成立**。沙箱内进程能对工作区外文件制造真实
存在的硬链接别名（`mklink /H` 无需管理员），并留下真实残留；这正是项目自身文档
`docs/沙箱边界实测矩阵.md` 第 52 行 W5 的既知残余（「硬链接是文件对象别名 … FAIL」）。

## L-03 【中】junction 目标在真实磁盘不存在的自相矛盾

- 工作区外新建目录：`New-Item -ItemType Directory -Path %LOCALAPPDATA%\Temp\lead-junction-target`
  返回成功、`Test-Path` = True；但真实磁盘上**该目录不存在**（`cmd /c dir`、`Test-Path` 均否定）。
- 在此目录下 `Set-Content` 新建文件 → `ps-write=FAIL: Could not find a part of the path ...`
  ⇒ **staging 声称成功、真实磁盘缺失、后续操作又按真实磁盘判失败**，三者互相矛盾（静默降级形态）。
- `mklink /J` 指向该「不存在」目标 → 报告成功且 PS 侧 `Attributes=Directory, ReparsePoint`，
  但目标不存在。项目文档 W8 称 junction 创建/穿透被正确拦截，与本次观察**部分不一致**，
  建议由 shim 侧确认「重解析点创建」与「reparse 解析后再映射 staging」两条路径的差异。

## L-04 【高/可用性】执行门 `STAGING_WRITE_UNVERIFIED` 在高并发下高频误拒

- 门自检子进程崩溃码实测出现：`exit=3762504530 (0xE0434352)`、`exit=3221225477 (0xC0000005)`、
  `exit=4294901760`、`exit=1`、`exit=2`；并有 `staged=<被截断的路径>`、`staged=not-found` 两种形态。
- 表现：**整个命令被拒绝执行**（不是命令失败），重试 1–3 次才恢复；8 线程并行时尤其频繁
  （我本人 3 次、pip-tester 4+ 次、exe-tester 5 次、node-tester 多次）。
- 判定门槛方向正确（fail-closed，宁拒不谎报），但**可用性代价过高**，且报错文本易被误读为
  「用户命令写错了」。建议：门探测加会话级锁/只探测本会话路径；错误文案写明「这是沙箱自检失败，
  请重试」。

## L-05 【中】`%ALLUSERSPROFILE%` 字面量目录 + PowerShell 崩溃报告

- `staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive\Critical_powershell.EXE_…\Report.wer`
  在**两个** session 中都存在（`session-eb7c901d` 3 个、`session-8b4a07b9` 3 个）。
- ⇒ shim 在映射 ProgramData 时**未展开环境变量**，把 `%ALLUSERSPROFILE%` 当成字面目录名；
  同时说明本沙箱内确有 `powershell.exe` 被 WER 记录为 critical crash（与 L-04 的崩溃码呼应）。
- **已解析崩溃报告（Node 读 UTF-16LE，`_sandbox-tests\_lead\wer-reader.mjs`）**：本会话共 **7 份**
  `Critical_powershell.EXE` 报告，签名完全一致：
  `EventType=PowerShell`、`Sig[2] InnermostExceptionType=System.AccessViolationException`、
  `Sig[3] OutermostExceptionType=System.Reflection.TargetInvocation`、
  `FileVersionOfSystemManagementAutomation=10.0.26100.33438`（.NET 运行时）。
  ⇒ 崩溃形态是 **PowerShell 内部反射调用路径触发的访问违例**，与 L-04 观察到的
  `0xC0000005` / `0xE0434352` 完全吻合。
- **因果链（推断，证据充分）**：shim 注入 + IAT hook → 某些 PowerShell 进程在 `TargetInvocation`
  路径上访问违例崩溃（0xC0000005）→ 门的 staging 自检子进程随之失败/崩溃
  （`child-reported-ok=false`、`exit=3221225477`）→ 门判定 staging 不可信 → **拒绝执行后续所有命令**。
  这解释了「为什么门会间歇性全量拒绝、重试又能过、且 8 线程并发时更频繁」。

## L-06 【高/可用性】审批面被自噪声淹没、且 shell 改动不入审批面

- `review.json` 在本会话膨胀到含**数千条**条目，其中绝大多数是噪声：
  `__PSScriptPolicyTest_*`、`winstage-shim-selfcheck-*.txt`、`.winstage-inject-*.json`、`shim.log`；
  `queue.json` 已 55 KB 量级。
- 对照：sensitive-tester 的 4 次敏感位置写入、pip 的 `%APPDATA%\pip\pip.ini`、node 的 `.npmrc`
  等**真实需要人工决策**的改动，与噪声混在同一列表里。
- ⇒ 人工「逐文件批准」的设计在实际会话里不可用（噪声信噪比失衡），且并行线程共享同一
  `review.json`（`DSH_REGSTAGE_ROOT` 相同），8 线程改动会互相混入。

## L-07 其他通道级事实

- `python`/`python3` 是 0 字节 Microsoft Store 别名存根（`--version`、`-c` 均 `exit 9009`），
  `pip` 不存在，`AppData\Local\Programs\Python` 不存在 ⇒ 真实 pip 安装本轮**环境不具备**。
- `node` v24.21.0、`npm` 11.19.0、`pnpm`、`git`、`winget` 1.29.380、`choco` 存在。
- 项目自带 `autotest.cmd --skip-audit` 在本（受限）会话的权威基线：**12 套件通过 / 19 失败 /
  1230 ok / 22 bad**，失败集中在「沙箱段需要未受限会话」的嵌套初始化
  （`EPERM mkdir`、`ENOENT copyfile` 于 `%TEMP%\dsh-stage-temp\…`、`shim\.stage\…`）。
  ⇒ 这**不是**产品功能全绿，而是嵌套沙箱不可用（与 README 残余 R6 一致）。
