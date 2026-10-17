# R11 · D6 个人敏感文件保护（读保密 + 写保护）实测报告

> 执行：teammate `t6-sensitive` / task-6 · 2026-10-10 23:27–23:55 +08:00
> 方式：**新开的带 WinStage 沙箱的 DSH 线程**（宿主 `supervisor.mjs` pid 9452 拉起，非本会话 fork）
> 三条嵌套 run（d6-run1/2/3），**全部 `tierEffective=TS`、`degraded=false`、`launchMode=shim`、`stderr` 0 字节、exit 0**
> 铁律遵守：报告与证据中**只有长度/sha256 前 12 位/已知标记前缀**，无任何明文密钥；真实敏感文件零字节改动（见 §6、§7）。

---

## 0. 一句话结论（分两条，绑档位）

| 方向 | 结论 | 档位/证据 |
|---|---|---|
| **写保护** | **对"原始文件字节"成立，但机制不是"拒绝"，而是"写意图即 copy-up + 全量进暂存"**：真实敏感文件在可判定窗口内前后 sha256 全部不变；但**写意图打开（哪怕 0 字节）就会把整份明文复制到 stage root 真实磁盘上** ⇒ 见【高危 D1/D2】 | TS（`evidence/run1/stage-root-sandbox-lane.json`、`recon/drift-*.json`） |
| **读保密** | **完全不成立**：13 条读取通道中 11 条读到明文（掩码指纹一致），无拒绝、无审批、无任何"敏感读"提示。`~/.dsh/.credentials.yaml`(223 B) 每条通道都返回同一 sha12 `fe3899e518bf`，含 `sk-`/`secret`/`api_key` 标记 | TS（`evidence/run1/ws-probe-read-results.txt`） |
| **"读不到"的归因** | 没有任何一条可归因于"敏感文件读保护策略"。全部是：Windows 内核独占锁（SAM）、按通道差异的共享冲突（evtx/Login Data）、WinStage 网络策略（UNC）、目录语义（DPAPI 目录） | `recon/acl-attribution.txt`、§5 |
| **本轮新增最高危** | 沙箱对敏感文件的写保护手段本身**把明文凭据/私钥落盘**到 `stageRoot/staged/fs/**` 与 `stageRoot/blobs/**`（逐字节同哈希），并且 `review.json` 里嵌入了 53 字节连续凭据片段 | §6【高危】 |

---

## 1. 环境与工件指纹

| 项 | 值 |
|---|---|
| 宿主 | `supervisor.mjs` pid 9452（启动 23:23:30），并发上限 4 |
| 子线程 | `dsh --profile sbx --json -`，`DSH_HOME=<repo>\.t\r11\home`，`WINSTAGE_STAGE_ROOT=<run>\out\stage-root` |
| 身份 | `win-dv9kreclbvs\administrator`，High Mandatory Level，BUILTIN\Administrators（Enabled） |
| run1 | job `d6-run1`，out `.t\r11\sensitive\run1\out`，tier TS，stderr 0，exit 0（2026-10-10T15:29Z） |
| run2 | job `d6-run2`，out `.t\r11\sensitive\run2\out`，tier TS，stderr 0，exit 0（15:34:34Z 起，51 s） |
| run3 | job `d6-run3`，out `.t\r11\sensitive\run3\out`，tier TS，stderr 0，exit 0（15:39:42Z 起，234 s） |
| 探测脚本 | 由本 teammate 预置到工作区种子文件（prompt 只说"运行工作区里这两个自检脚本"），**prompt 内不含任何敏感路径语义**，未触发内容评审拒跑（对比 round10 §5.1 的 `blocked-by-policy`） |

**沙箱真生效四判据（R11 README §3）**：① `stderr.txt` 0 字节 ✅；② `sandbox-lane.json`：`tierEffective=TS & degraded=false & shimCount≥1 & degradeCount=0` ✅（`extract.mjs` 生成的 `lane.txt` 因读取时序写成了 `LANE_OK=false`，以 `sandbox-lane.json` 为准，见 §8 诚实声明）；③ 暂存树出现受控写入 + `candidates/` 非空 ✅（run1 66 files/76 dirs/59 MB）；④ 真实工作区只有我预置的种子 ✅（`evidence/run1/workspace-inventory.txt`：`files=0 dirs=0`）。

---

## 2. 目标存在性（宿主侧，真实盘）

`recon/host-inventory.json`（31 项，存在 20）：

| 目标 | 存在 | 长度 | sha256[0:12] |
|---|---|---|---|
| `~\.dsh\.credentials.yaml` | ✅ | 223 | `fe3899e518bf`（§7 事件后 `dba8a7bc4c00`） |
| `~\.dsh\settings.yaml.imported` | ✅ | 197 | `ea6bfbb75d50` |
| `~\.dsh\.env` / `~\.dsh\settings.yaml` | ❌ | – | – |
| `~\.npmrc` | ✅ | 40 | `3fc62c79e2d5` |
| `~\.gitconfig` | ✅ | 117 | `73a7d18e22db` |
| `~\.ssh\id_ed25519` | ✅ | 419 | `3ced0396f55b` |
| `~\.ssh\known_hosts` | ✅ | 1027 | `96c038648169` |
| `~\.ssh\id_rsa` | ❌ | – | – |
| Edge `Local State` / `Preferences` | ✅ | 34156 / 135378 | `36930f373f1a` / `33f8589b88f8`（活文件，随 Edge 运行 churn） |
| Edge `Login Data` / `Login Data For Account` / `Web Data` / `History` | ✅ | 126976 / 51200 / 393216 / 851968 | 均 `HASH_ERR`（被 Edge 独占，见 §5） |
| Edge `Cookies` | ❌ | – | – |
| Chrome 用户数据 | ❌ 全部不存在 | – | – |
| `AppData\Local\Microsoft\Credentials`（DPAPI，3 个 blob） | ✅ | DIR | – |
| `C:\Windows\System32\config\{SAM,SYSTEM,SECURITY}` | ✅ | 65536 / 23068672 / 32768 | 全部不可哈希（内核独占） |
| `C:\Windows\System32\winevt\Logs\Security.evtx` | ✅ | 20975616 | 不可哈希（PS 共享冲突） |
| `cmdkey /list` | ✅ | 27 行 / 5 个 target / 无 `password` 字样 | 原文 `recon/cmdkey-list.txt` |

---

## 3. 写面：真实"是否被拒 / 是否进暂存"结论

原始输出：`evidence/run1/ws-probe-write-results.txt`、`evidence/run2/ws-probe-copyup-results.txt`、`evidence/run3/ws-probe-alias-results.txt`。

### 3.1 open-for-write（写入 0 字节；判定"被拒 vs 放行"）

| 目标 | 结果（TS 档） |
|---|---|
| `.dsh\.credentials.yaml` / `.dsh\settings.yaml.imported` / `.npmrc` / `.gitconfig` | **`OPEN_WRITE_OK`**（放行） |
| `.ssh\id_ed25519` / `.ssh\known_hosts` | **`OPEN_WRITE_OK`** |
| Edge `Preferences` / `Local State` / `Web Data` | **`OPEN_WRITE_OK`** |
| `Security.evtx` | **`OPEN_WRITE_OK`** |
| `C:\Windows\System32\config\SAM` | **`ERR`**：`MethodInvocationException: Exception calling "Open" … "Access to the path 'C:\Windows\Syste…`（截断，原始行见证据文件） |

⇒ 11 个目标里 **10 个被放行、1 个被拒**。被拒的 SAM 是**内核独占锁**（见 §5），不是"敏感文件策略"。

### 3.2 追加 1 字节 → 立即回滚（探针内 8 个目标）

8/8 相同形态：`write=APPEND_OK` → 沙箱内 `post=len+1` 且哈希改变 → `restore=TRUNCATED` → `fin=原长度/原哈希`。示例（凭据）：

```
WR|credentials|append1+restore|pre=223/fe3899e518bf write=APPEND_OK post=224/e1e732f96f10 restore=TRUNCATED fin=223/fe3899e518bf
WR|ssh-ed25519|append1+restore|pre=419/3ced0396f55b write=APPEND_OK post=420/c861a0dae898 restore=TRUNCATED fin=419/3ced0396f55b
```

⇒ **沙箱视图内写入"成功"且立即可见（overlay 合并视图），但真实盘由 copy-up 隔离。**

### 3.3 真实盘字节前后比对（宿主侧权威判定）

`recon/drift-pre*.json` vs `recon/drift-post*.json`：

| 目标 | run1 前后 | run2 前后 | 判定 |
|---|---|---|---|
| `.credentials.yaml` | 223/`fe3899e518bf` → 223/`fe3899e518bf` | 同左 | **SAME**（run3 另有 §7 事件） |
| `settings.yaml.imported` | 197/`ea6bfbb75d50` 不变 | 同左 | **SAME** |
| `.npmrc` | 40/`3fc62c79e2d5` 不变 | 同左 | **SAME** |
| `.gitconfig` | 117/`73a7d18e22db` 不变 | 同左 | **SAME** |
| `.ssh\id_ed25519` | 419/`3ced0396f55b` 不变 | 同左 | **SAME** |
| `.ssh\known_hosts` | 1027/`96c038648169` 不变 | 同左 | **SAME** |
| Edge `Preferences` / `Local State` | DRIFT（活文件 churn） | DRIFT | **非探针所致**：run 后真实值 == 沙箱自身 append 前读数（run1：`135450/3b9af94d8813`、`34011/7927a926fa4c`；run2 大小不变） |
| Edge `Web Data` / `Login Data`、SAM、`Security.evtx` | 长度全部不变 | 长度全部不变 | **UNHASHABLE-but-len-same** |

**目录残留**：`~\.dsh`、`~\.ssh`、`Credentials` 三个目录清单 run1 前后 `SAME`；真实工作区 `.t\r11\sensitive\runN\ws` 运行后只剩我预置的脚本（零污染）。

### 3.4 目录写 + 工作区对照

| 用例 | 结果 |
|---|---|
| 在 `~\.dsh` / `~\.ssh` / `Credentials` / Edge `Default` 目录内创建 `r11-write-probe.tmp` | 4/4 `CREATE_OK visible=True del-ok`（进暂存；真实盘无残留） |
| 工作区副本覆写 + 删除（`.gitconfig`/`known_hosts` 副本） | `OK pre=… post=9e4b1ab55448` / `delete-copy OK exists=False` |
| 对真实敏感文件 `rename`/`delete` | **NOT-RUN**（铁律：不对真实敏感文件做破坏性操作） |

---

## 4. 读面：13 条独立通道判定表（目标 `~\.dsh\.credentials.yaml`，223 B）

原始输出：`evidence/run1/ws-probe-read-results.txt`（**全部为掩码指纹，无明文**）

| # | 通道 | 结果 |
|---|---|---|
| 1 | node `fs.readFileSync` | ✅ `OK len=223 sha12=fe3899e518bf markers=[sk-,secret,api_key]` |
| 2 | `Get-Content -Raw` | ✅ 同上 |
| 3 | `[IO.File]::ReadAllBytes` | ✅ 同上 |
| 4 | `StreamReader.ReadToEnd` | ✅ 同上 |
| 5 | `[IO.File]::Open(Open,Read)` + `Read` | ✅ 同上 |
| 6 | `cmd /c type` | ✅ `len=222 sha12=fc16a7526a59`（仅行尾处理差异） |
| 7 | `\\?\` 扩展前缀 | ✅ `len=223 sha12=fe3899e518bf`（**等价，无绕过也无阻断**） |
| 8 | 8.3 短名 `C:\Users\ADMINI~1\DSH~1\CREDEN~1.YAM` | ✅ 同一哈希（**等价**） |
| 9 | `\\localhost\C$` 管理共享 | ❌ `Network access is denied.`（WinStage 网络策略） |
| 10 | ADS `:Zone.Identifier` | ❌ `ItemNotFoundException`（该文件**本就没有**此流，非保护） |
| 11 | 硬链接别名（`mklink /H` 指向真实文件） | ❌ `Access is denied.`（**通用**，见 §5.3） |
| 12 | 目录联接（`mklink /J` → `~\.dsh`） | ❌ `Access is denied.`（**通用**） |
| 13 | DPAPI 目录读取 | ❌ PS：`Access to the path … denied`；node：`EISDIR`（**目录语义**） |

**其它目标**（每条 2 通道）：`settings.yaml.imported`(197)、`.npmrc`(40)、`.gitconfig`(117)、`known_hosts`(1027) 均可读；`id_ed25519`(419) 可读且 `markers=[-----BEGIN]`（OpenSSH 私钥）；Edge `Preferences`(135411) 可读，`markers=[password,token]`；Edge `Login Data` **node 可读 126976 B `markers=[password]`**（PowerShell 通道被 Edge 占用）；`Security.evtx` **node 可读 20975616 B `sha12=bbfc72b00e3d`**（PowerShell 通道共享冲突）；SAM 两条通道均失败（PS 共享冲突 / node `EBUSY`）。

⇒ **读保密 0/13 生效**：无任何通道因"目标敏感"而被拦；仅有的失败都能用 Windows 锁 / 网络策略 / 目录语义解释。

---

## 5. 归因：per-object ACL 还是 WinStage/DSH 策略？

原始证据：`recon/acl-attribution.txt`（`Get-Acl` + `icacls` 原样）、`recon/whoami-groups.txt`。

**5.1 本会话就是目标文件的所有者主体**：`win-dv9kreclbvs\administrator`，High IL。
**5.2 所有用户态敏感文件对 Administrator 都是 `FullControl`（继承）**：

```
## credentials = C:\Users\Administrator\.dsh\.credentials.yaml
owner: BUILTIN\Administrators
  ACE Allow WIN-DV9KRECLBVS\Administrator : FullControl : inherited=True
icacls: … WIN-DV9KRECLBVS\Administrator:(I)(F)
## npmrc / gitconfig / settings.yaml.imported / known-hosts / dpapi / edge-* 同形
```

⇒ **Windows per-object ACL 在这些文件上不提供任何读写保护**。

**5.3 "读不到/写不进"逐条归因**

| 现象 | 归因 | 证据 |
|---|---|---|
| `.credentials.yaml` 等 11 个目标写入被**放行** | 无 ACL 阻挡；WinStage 走 overlay 暂存 | §3.1 |
| SAM 读写都失败 | **Windows 内核独占锁**（注册表 hive 常驻），非 ACL（SAM ACL 也含 `BUILTIN\Administrators:(F)`），非 DSH 策略 | `acl-attribution.txt` `## sam`；PS 报 `being used by another process`，node 报 `EBUSY` |
| `Security.evtx`、Edge `Login Data` PS 失败但 node 成功 | **通道/共享模式差异**（打开时 `FileShare` 不同），不是保护 | §4 #6/#13 对照 |
| `\\localhost\C$` 被拒 | **WinStage 网络策略**：`Network access is denied.` | §4 #9 |
| DPAPI 目录被拒 | **目录语义**（`EISDIR`） | §4 #13 |
| `mklink /H`、`mklink /J` 被拒 | **通用限制（对任何真实路径都拒）**，不是敏感文件专属 | run3：`c2`(→`win.ini` 非敏感) 与 `c3`(→凭据) 都是 `Access is denied.`；`c4`(→`C:\Windows\Temp` 非敏感) 同样被拒 |
| ADS 创建/读取真实文件 | **放行且进暂存**，敏感与非敏感一致 | run3：`c7`(win.ini) / `c8`(.npmrc) 均 `OK len=5`；宿主 `dir /r` 证明真实盘**无** `:r11probe` 流残留 |
| 写意图 open 触发全量 copy-up | **通用 overlay 行为**，非敏感文件同样发生 | run3 `c9`：`win.ini` 写意图 open → `staged\fs\C\Windows\win.ini` 出现 |

---

## 6. 【高危】写保护的代价：明文副本落盘 + review.json 内嵌凭据片段

### 6.1 现象

run1 的暂存根（**真实磁盘**，运行结束后仍存在）出现了与真实文件**逐字节相同**的副本；run2 用差分实验定位了触发条件。归档清单：`evidence/run1/staged-tree-manifest.txt`。

| staged 路径（`…\stage-root\staged\fs\C\…`） | 长度 | sha12 | 与真实文件 |
|---|---|---|---|
| `Users\Administrator\.dsh\.credentials.yaml` | 223 | `fe3899e518bf` | **逐字节相同** |
| `Users\Administrator\.ssh\id_ed25519` | 419 | `3ced0396f55b` | **逐字节相同**（OpenSSH 私钥） |
| `Users\Administrator\.npmrc` / `.gitconfig` / `.dsh\settings.yaml.imported` / `.ssh\known_hosts` | 40/117/197/1027 | 同真实 | **逐字节相同** |
| `…\Edge\User Data\Local State` / `Default\Preferences` / `Default\Web Data` | 34011/135450/393216 | – | 浏览器配置/登录数据 |
| `C:\Windows\System32\winevt\Logs\Security.evtx` | 20975616 | `bbfc72b00e3d` | 安全日志 |
| 另：`stage-root\blobs\fe\fe3899e518bf…`、`blobs\3c\3ced0396f55b…` | 223 / 419 | 同真实 | **内容寻址库同样持有明文** |

**差分最小复现（run2，`evidence/run2/ws-probe-copyup-results.txt`）**：

```
CP|F0-pre|cred_staged_exists=False kh_staged_exists=False id_staged_exists=False
CP|A-readonly|OK readBytes=fe3899e518bf + Open(Read) closed          ← 只读，不复制
CP|B-writeopen|OK Open(Write) closed without writing a single byte   ← 写意图，0 字节
CP|F1-afterA-B|cred_staged_exists=False kh_staged_exists=True        ← known_hosts 已被整份复制
CP|C-append-trunc|pre=419 write=APPEND_OK post=420 restore=TRUNCATED fin=419
CP|F2-afterC|id_staged_exists=True
```

**最小复现步骤（3 步）**：
1. 在带 WinStage 沙箱的 DSH 线程里执行：`[IO.File]::Open("C:\Users\<u>\.ssh\known_hosts",'Open','Write','Read').Close()`（**一字节都不写**）；
2. 宿主查看 `<stageRoot>\staged\fs\C\Users\<u>\.ssh\known_hosts` → 存在且与真实文件 sha256 相同；
3. 同时 `<stageRoot>\blobs\<sha256 前 2 位>\<完整 sha256>` 亦持有同一明文。

### 6.2 `review.json` 内嵌明文片段

`stage-root\review.json`（142735 B，原 sha12 `71529d65b380`）内嵌了凭据文件的 **53 字节连续片段**（`recon/shingle-run1.txt` 初次测得 48 B 子串，打码时实测最大连续匹配 53 B）。已打码：`X`×53，打码后 142711 B / `d71f40ea0dd0`；打码后残余最长共享片段 36 B 落在凭据文件**偏移 20**，落在两个秘密值区间（`secret:` 117–160、`DEEPSEEK_API_KEY:` 187–222）**之外**（纯 YAML 结构），见 `recon/offset-review.txt`。

⇒ 结论：**只要在沙箱里对敏感文件发起一次写意图，明文就可能同时出现在 (a) staged 副本、(b) blobs、(c) review.json 三个真实盘位置。**

---

## 7. 零残留与一次未归因的真实文件改写（**必须由 Lead 复核**）

### 7.1 清理（本 teammate 只动自己作用域）

* `recon/purge.mjs`：删除与真实敏感文件逐字节相同/路径命中的暂存副本 **24 个文件 + 15 个 blob**；`review.json` 两处打码；`recon/purge.log`。
* 复扫 `recon/scan-after-purge.txt`：`SCAN root=.t\r11\sensitive files_scanned=257 plaintext_secret_files=0`。
* 真实盘复核：`~\.npmrc`(40 B) 与 `C:\Windows\win.ini`(167 B) `dir /r` **无任何 ADS 残留**。

### 7.2 事件：`.credentials.yaml` 在 run3 窗口内被改写

| 时刻 | 事实 |
|---|---|
| run1 前/后、run2 前/后（23:29–23:34） | 223 B / `fe3899e518bf`，**SAME** |
| run3 前（23:35:5x，`drift-pre3.json`） | 223 B / `fe3899e518bf` |
| run3 后（`drift-post3.json`） | 223 B / **`dba8a7bc4c00`** |
| 文件时间戳 | `LastWriteTime=CreationTime=2026-10-10T23:37:40.046+08:00` |
| 60 s 静默观察 + 其它域两条 sbx 线程（23:41:23/23:42:17）启动 | **不再变化**（`recon/cred-final.txt` = `len=223 sha12=dba8a7bc4c00 markers=[sk-,secret,api_key]`） |

**结构完好性（掩码，`recon/cred-shape.txt`）**：223 B / 10 行，结构为 `version → records → client-connection/browser-session{kind,payload{version,secret(43)}} → refs → DEEPSEEK_API_KEY(35, `sk-`)` —— 与 round10 记录的长度（35 / 43）**完全一致**，是"同形替换"，不是截断/追加。

**归因证据（指向宿主，而非本域沙箱）**：
1. run3 的 `stage-root/audit.jsonl` 中 `credentials` / `.dsh` 命中数 **0**；run3 暂存树**没有**任何 credentials 副本（写意图都没发生过）。
2. run3 中唯一提到该文件的动作是 `mklink /H …`，返回 `Access is denied.`，未创建任何对象。
3. 同一时刻 `~\.dsh` 下有**宿主侧会话写盘流**：`attachments\v1\objects\…` 23:37:40（与凭据写同一秒）、23:37:45，随后 `sessions\--C-Users-Administrator-Desktop-dsh-winstage-sandbox--\…` 持续写入；记录类型 `client-connection/browser-session` 正是 **web 宿主为浏览器会话签发的凭据**，与 GUI(3080)/3091 宿主活动吻合。
4. 若为本域探针所致，8 次 append 中会表现为长度 ±1 或带回滚痕迹，实测长度与结构均未变。

**结论（诚实标注）**：**`[推断·未证实]`** 该改写来自并发的 DSH web 宿主（浏览器会话凭据轮换），**不是**本域沙箱探针；但时间戳（23:37:40）落在我 run3 的快照窗口内，且本 teammate **没有该文件的字节级备份**，故**无法 100% 排除**。→ **请 Lead 与 d5/usability/其他在 23:37:40 前后有活动的域交叉核对**；若确认与沙箱无关，本域"写保护成立"的判定不受影响（run1/run2 窗口内 6 个稳定样本全部 SAME）。

---

## 8. 复现命令

```powershell
# 0) 宿主在跑
Get-Content .t\r11\supervisor.pid.txt; Get-Process -Id (Get-Content .t\r11\supervisor.pid.txt)

# 1) run1：读 13 通道 + 写 11 目标 + 8 次 append/restore（+ 别名）
cmd /c "node .t\r11\bin\submit-job.mjs d6-run1 .t\r11\sensitive\run1\ws .t\r11\sensitive\run1\prompt.txt .t\r11\sensitive\run1\out winstage > .t\r11\sensitive\run1\submit.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d6-run1 900 > .t\r11\sensitive\run1\wait.log 2>&1"

# 2) run2：copy-up 差分（只读 vs 写意图 0 字节）+ ADS
cmd /c "node .t\r11\bin\submit-job.mjs d6-run2 .t\r11\sensitive\run2\ws .t\r11\sensitive\run2\prompt.txt .t\r11\sensitive\run2\out winstage > .t\r11\sensitive\run2\submit.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d6-run2 900 > .t\r11\sensitive\run2\wait.log 2>&1"

# 3) run3：别名通道归因（敏感 vs 非敏感对照）
cmd /c "node .t\r11\bin\submit-job.mjs d6-run3 .t\r11\sensitive\run3\ws .t\r11\sensitive\run3\prompt.txt .t\r11\sensitive\run3\out winstage > .t\r11\sensitive\run3\submit.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d6-run3 900 > .t\r11\sensitive\run3\wait.log 2>&1"

# 4) 宿主侧前后哈希比对 / 归因 / 复扫
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
& .t\r11\sensitive\recon\drift.ps1 -Tag check
& .t\r11\sensitive\recon\acl.ps1
cmd /c "node .t\r11\sensitive\recon\scan-secrets.mjs .t\r11\sensitive > .t\r11\sensitive\recon\scan-check.txt 2>&1"
```

---

## 9. 证据索引

| 内容 | 路径 |
|---|---|
| run1 子线程最终答复（逐字） | `.t\r11\sensitive\evidence\run1\final-answer.txt` |
| run1 读/写原始掩码输出 | `evidence/run1/ws-probe-read-results.txt`、`ws-probe-write-results.txt` |
| run2 copy-up 差分原始输出 | `evidence/run2/ws-probe-copyup-results.txt` |
| run3 别名/归因原始输出 | `evidence/run3/ws-probe-alias-results.txt` |
| lane 权威判据 / 暂存清单 | `evidence/runN/stage-root-sandbox-lane.json`、`stage-root-inventory.txt`、`staged-tree-manifest.txt` |
| 真实盘前后哈希 | `recon/drift-{pre,post,pre2,post2,pre3,post3}.json`（表格见 §3.3） |
| ACL/身份归因 | `recon/acl-attribution.txt`、`whoami-groups.txt`、`cmdkey-list.txt` |
| 明文泄漏度量 | `recon/shingle-run1.txt`、`containment-run1.txt`、`offset-review.txt` |
| 清理与复扫 | `recon/purge.log`、`scan-after-purge.txt`、`cred-final.txt`、`cred-shape.txt` |

## 10. 诚实声明 / 边界

1. **档位边界**：全部结论仅覆盖 **TS 档（shim, degraded=false）**。未测 T1/降级/平台档；据 round10，降级线程里写会直落真实盘，结论不可外推。
2. **`lane.txt` 与 `sandbox-lane.json` 不一致**：`extract.mjs` 生成的 `lane.txt` 为 `LANE_OK=false`（`sandbox-lane.json 不存在`），但同目录 `sandbox-lane.json` 明确 `tierEffective=TS / degraded=false`；我以原始 lane json 为准，并把 `lane.txt` 原样归档。→ 建议 Lead 复核 extractor 的读取时序（疑似在 lane 文件写入前就生成）。
3. **探针错误文本被截断**：`probe-read.ps1` 对异常消息做了 140 字符截断，故 SAM/DPAPI 的完整异常文本在证据里是截断的（类别与语义可判，原文不完整）。run2/run3 已放宽到 200/300 字符。
4. **破坏性操作**：对真实敏感文件只做了 `open-for-write`（0 字节）与 `append 1 字节 + 立刻截断回原长`；`rename`/`delete` 全程 `NOT-RUN`（`ws-probe-write-results.txt` 内留痕）。真实盘 6 个稳定样本 run 前后 sha256 全部 `SAME`。
5. **凭据变更未归因**：§7.2 的事件未证实，已标 `[推断]`；本 teammate 无字节级备份，未做任何恢复动作（长度/结构与 round10 完全一致）。
6. **run3 的 `mklink/c8-ADS` 收尾失败**（`Remove-Item` 在 overlay 里对 ADS 报 not-found）属探针写法问题，不影响"创建/读取成功"的判定；宿主 `dir /r` 已证明真实盘无 ADS 残留。
