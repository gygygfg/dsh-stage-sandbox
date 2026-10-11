# R16 域六（task-6）缺陷清单：个人敏感文件保护（读/写/泄露面）

> 证据根：`.t\r16\sensitive/**`。主报告：`docs/round16/sensitive-报告.md`。
> 所有结论绑 **TS 档**（`tierEffective=TS / degraded=false / LANE_OK=true`；run1/run1b/run1c/run1d/run2b 一致）。
> **本文件不含任何密钥原文或片段**，只出现路径 / 字节数 / sha256。

---

## D6-1【高危 · 保密 · 未修】写意图 open（0 字节）把整份敏感文件明文复制到真实磁盘

**状态**：R11 首次实测 → R15 复验仍在 → **R16 再次复验仍在（未修）**。

**现象**：在 WinStage 沙箱内对真实敏感文件执行
`[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)`（**一个字节都不写**），
WinStage 立即把该文件整份复制到两个**真实磁盘**位置（stage root 是工作区里的普通目录，不受沙箱保护）：

* `<stageRoot>\staged\fs\C\Users\Administrator\.dsh\.credentials.yaml`（223 B，与本轮真实文件逐字节相同）
* `<stageRoot>\blobs\<sha256[0:2]>\<完整 sha256>`（223 B，同一明文）

**R16 实测读数**（run1d，`out\stage-root-...`；扫描器 `bin\scan-leak.mjs` 以"真实文件内容的 32 字节窗口指纹"判定）：

| 命中路径（已删） | 字节 | sha256 |
|---|---|---|
| `…\run1d\out\stage-root-24125820221036\staged\fs\C\Users\Administrator\.dsh\.credentials.yaml` | 223 | `dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` |
| `…\run1d\out\stage-root-24125820221036\blobs\db\dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` | 223 | 同上（逐字节相同） |
| `…\run1d\out\stage-root-24125820221036\staged\fs\C\Users\Administrator\.gitconfig` | 117 | `73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` |
| `…\run1d\out\stage-root-24125820221036\blobs\73\73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` | 117 | 同上 |

指纹窗口命中数：credentials **192/192** 个窗口全中（即整份明文）；`.gitconfig` **86/86** 全中。
扫描器原始输出：`recon/leak-scan-tree.txt`（首次扫描 `PLAINTEXT_HITS=5`）；删除记录：`recon/cleanup-run1d.txt`。

**差分最小复现（run2b，见报告 §4）**：先只读一次（不产生副本）→ 再写意图 open（0 字节）→ 副本出现。

**最小复现步骤**

1. 带沙箱的 DSH 线程内（`WINSTAGE_STAGE_ROOT` = `<stageRoot>\staged`，故 `stageRoot = Split-Path $env:WINSTAGE_STAGE_ROOT -Parent`）：
   `[IO.File]::Open("$env:USERPROFILE\.npmrc",'Open','Write','Read').Close()`
2. 宿主检查 `<stageRoot>\staged\fs\C\Users\Administrator\.npmrc` → 存在且 sha256 == 真实文件
3. 宿主检查 `<stageRoot>\blobs\<aa>\<sha256>` → 同一明文

**为何是高危**：模型只要"试探性打开写"（不需要写成功、不需要用户确认），凭据 / SSH 私钥 / 浏览器登录库
的完整明文就落到工作区内的真实磁盘上，长期留存（stage root 不随 run 结束销毁，见 §1 判据 2），
并且需要额外的清理动作才能合规（R16 本域共清理 6 处明文副本 + 1 处内嵌片段）。

**建议**：① copy-up 对敏感类别改为"拒绝写 / 仅内存 staging"；② 敏感路径的暂存对象强制 ACL/DPAPI 保护并在 run 结束销毁；
③ 至少把 `.dsh\.credentials.yaml`、`.ssh\*`、浏览器 `Login Data` 列入"写直接拒绝"白名单。

---

## D6-2【中 · 测试工具盲点（我自己踩到的）】按 `WINSTAGE_STAGE_ROOT` 直查会漏掉 copy-up 目标

**现象**：环境变量 `WINSTAGE_STAGE_ROOT` 在命令面指向的是 **`<stageRoot>\staged`**（store 根），
而 copy-up 的落点是 **`<stageRoot>\staged\fs\C\…`** 与 **`<stageRoot>\blobs\…`**。
若被测脚本只按该 env 递归找 `<env>\…`，会读到"无副本"，从而**误判 D6-1 不存在**。

**实测后果（run1c）**：`R16|PHASE|A|pre_existing_sensitive_copies=0`、`copies_after=0`、
`R16|CLEANUP|deleted=0`——**全为 0，但 run1d 用同样的写意图在同一 golden 下产生了明文副本**。
（run1c/run1d 的 env 读数：`R16|ENV|stageRootEnv=…\stage-root-236322359210522\staged`）。

**建议**：`sbx-extract.mjs` / 文档把"store 根"与"stage 根"的层级写清；或让 shim/plugin 额外导出
`WINSTAGE_STAGE_ROOT_DIR`（父目录）。报告与本域脚本已按 `Split-Path -Parent` 修正。

---

## D6-3【高 · 可用性 · 阻断】工作区种子脚本无法被执行：相对路径与 `-File` 都看不到暂存文件

**现象**：run1 的嵌套线程按提示执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\probe-r1.ps1`，
返回：

```
The argument '.\probe-r1.ps1' to the -File parameter does not exist.
```

但**同一目录、同一真实盘**上该文件存在（宿主 `Get-ChildItem` 可见 11786 B，ACL 为
`WIN-DV9KRECLBVS\Administrator:(I)(OI)(CI)(F)`，无 deny）：

* `R16C|CWD` = `…\run1c\out\stage-root-236322359210522\staged`（**不是**工作区）
* `R16D|$EXISTS|wsfile|True`（绝对路径 `Test-Path` 为真，经插件通道）

即：命令面的 cwd 指向**暂存镜像深处**，而 Win32/子进程解析工作区路径时看不到暂存层：

| 调用方式 | 结果 |
|---|---|
| `powershell -File .\probe-r1.ps1`（相对，run1） | **失败**：argument does not exist |
| `Get-Content -LiteralPath .\probe-r1.ps1 -Raw`（相对，run1b） | **失败**：Cannot find path '.\probe-r1.ps1' |
| `Get-Content -LiteralPath '<工作区绝对路径>\probe-r1.ps1' -Raw`（插件通道） | **成功** |
| `… -Raw \| powershell -NoProfile -Command -`（run1c/run1d/run2b） | **成功**（探针正常输出） |

**为何是高**：沙箱会话的常见用法（预置脚本 + 相对路径执行）**整体不可用**；run1 与 run1b 两次
完整沙箱启动周期全部浪费在"文件不存在"上（各 2–3 分钟 + lane 判据全绿但零结论）。
模型看不到"cwd 是暂存镜像"这一事实，也不会自己推出绝对路径写法。

**建议**：① 命令面 cwd 改为真实工作区（或在 `-File`/相对路径解析处也接 shim 重定向）；
② 至少在 shell 回执/环境变量里显式给出"当前目录属于暂存镜像，工作区文件请用绝对路径"；
③ 文档把绝对路径 + `-Command -` 的可用写法写进配方。

---

## D6-4【中 · 稳定性 · 与敏感无关】单个命令行进程里打开约 30+ 个文件后，**一切**读/写意图开始失败

**现象**（run1c，同一进程内顺序调用）：前 ~24 次 `[IO.File]::ReadAllBytes`（8 个目标 × 预先基线 2 轮 + 标记检测）
全部成功（含 223 B 凭据明文，`PREFILE`/`MARKERS` 行）；随后第 25 次起的**全部**调用失败：

```
R16|READ|cred|A1-ReadAllBytes|FAIL|err=MethodInvocationException
… （8 目标 × 8 通道 = 64 次读全部 FAIL）
R16|WRITE|cred|openwrite-0bytes|ERR:MethodInvocationException
R16|WRITE|gitconfig|openwrite-0bytes|ERR:MethodInvocationException
R16|POSTFILE|cred|READ_FAIL|err=MethodInvocationException
```

**关键归因证据**：失败的**不只有敏感文件**——非敏感的 `C:\Windows\win.ini` 在同批次同样失败；
而 run1d 用**同一个探针、同一 golden、同一 TS 档**、把文件操作数从 ~100 降到 6 次，则 4/4 全部成功
（`R16D|READALL|cred|OK|bytes=223`、`winini|OK|bytes=167`、`OPENW|…|OK`、`CTRL_NEW|WRITE_OK`）。
⇒ **与"目标是否敏感"无关，是进程级状态/资源耗尽**，不存在读保护语义。

**为何要报**：① 长会话里文件工具会大面积报错；② 更危险的是**检测工具会把它读成"无泄漏/无副本"**
（`CLEANUP|deleted=0` 实为"看都看不见"，而不是"确实没有"）——本域差点据此写出错误结论；
③ 错误文本被包成 `MethodInvocationException`，原始 Win32 错误与 code 全丢，根因不可诊断。

**建议**：① 定位 shim/插件里按句柄/路径累积的状态（疑似句柄或重定向缓存未释放）并修复；
② 失败时保留 `InnerException` / `GetLastWin32Error()`，不要只回传包装类型；
③ 读取失败必须与"内容为空/不存在"在回执里明确区分。

---

## D6-5【低 · 语义】命令面 cwd 与"真实工作区"的差异没有任何提示

**现象**：`R16C|CWD` = `<stageRoot>\staged`、`R16D|ENV|cwd` = 同上；
而 `workspace-inventory.txt` 里真实工作区只有种子文件（判据 3 通过）。
用户/模型侧没有任何读数说明"当前目录是暂存镜像"，导致 D6-3 的路径困惑。

**建议**：在 shell 回执或 env 里显式暴露 `WINSTAGE_WORKSPACE_DIR`（真实路径）与"cwd 属于暂存镜像"的标识。

---

## 附：本条不报为缺陷的对照项（避免把 Windows 自身行为当沙箱缺陷）

| 现象 | 真实归因 | 证据 |
|---|---|---|
| `SAM` 读写失败（`MethodInvocationException`） | Windows 内核独占锁（注册表 hive 常驻） | `R16|PREFILE|sam|len=-1`、`READ|sam|…|FAIL` |
| Edge `Login Data` / `Web Data` / `Cookies` 无法宿主侧哈希 | Edge 正在运行（14 进程）持有独占锁 | `drift-*.json` 中 `hash-err:WriteErrorException`；故**写测试全程排除 Edge**，未对活库做任何写意图 |
| 目录写 `~\.dsh\`、`~\.ssh\` 成功并可见 | 普通 overlay 暂存行为（run 后宿主侧无残留） | `R16|DIRWRITE|…|CREATE_OK|visible=True|deleted=True` |
