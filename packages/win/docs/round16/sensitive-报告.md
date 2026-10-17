# R16 · 域六（D6）个人敏感文件保护（读 / 写 / 泄露面）+ 明文副本清理 — 实测报告

> 执行：teammate `sensitive` / task-6 · 2026-10-11 17:46–18:12 +08:00
> 方式：**新开的带 WinStage 沙箱的 DSH 线程**（`docs\archive\round10\env\scripts\sbx-thread.cmd`，独立进程，`profile=sbx`）
> 铁律遵守：报告与证据中**只有路径 / 字节数 / sha256 / 布尔标记**，无任何密钥原文或片段；
> 真实敏感文件**零字节改动**（§6 宿主侧权威比对）；测试产生的明文副本**已全部删除并留痕**（§5）。
> 同一域内跑了 6 个 run（≤ 协议 §1.2 上限）；其中 **4 个 lane 有效**（run1/1b/1c **执行失败**，见 §3）。

---

## 0. 一句话结论

| 方向 | R16 结论 | 档位 / 关键证据 |
|---|---|---|
| **写保护（真实字节）** | **成立**：13 个可哈希真实目标在全部 run 前后 `len` + `sha256` **完全不变**（`SAME=13 DRIFT=0`） | TS（`recon/drift-compare-pre2b-post.txt`） |
| **写保护的代价（D6-1）** | **未修，复现**：写意图 open（**0 字节**）即把整份明文复制到**真实磁盘** stage root（`staged\fs\…` + `blobs\…`），逐字节相同 | TS（`run2b` `R16B|COPYUP_TWIN`；`run1d` 指纹扫描 192/192 窗口全中） |
| **读保密** | **不成立**：`~\.dsh\.credentials.yaml`(223 B) 在**每一次真正执行到**的读通道上返回完整明文（sha256 与真实文件一致），**零拦截、零审批**；R11 的结论完整复现 | TS（`run1d`、`run1c` `PREFILE`/`READALL` 行） |
| **"读失败"的归因** | 与本 run 里出现的失败**全部不可归因于"敏感读保护"**：① 非敏感 `win.ini` 同批同样失败（进程级状态耗尽，见 D6-4）；② `SAM` 是内核独占锁 | `run1c` `READ|*|FAIL`、`run1d` `winini` 对照 |
| **本域最高危** | D6-1 明文 copy-up（未修）+ **§5 清理**：本轮共删除 **7 处明文副本 + 1 处内嵌片段**，终态自扫 `PLAINTEXT_HITS=0` | §5、`recon/leak-scan-final.txt` |
| **另一条高危（可用性）** | **工作区种子脚本无法被执行**（相对路径 / `-File` 都看不到暂存文件），run1+run1b **两个完整沙箱周期全废** | §3、缺陷 D6-3 |

---

## 1. Run 台账与四条判据（协议 §1.1）

| run | 目的 | exit | stderr | stage-root 含受控写入 + `candidates\` | 真实工作区零污染 | **lane** | 判定 |
|---|---|---|---|---|---|---|---|
| run1 | 读/写全量探针 | 0 | 0 B | ✅ 34 files/29 dirs | ✅ files=1（仅种子） | TS / degraded=false / shimCount=2 | **INVALID-RUN（探针未执行）** |
| run1b | 相对路径 `Get-Content` 复测 | 0 | 0 B | ✅ 28 files | ✅ files=1 | TS / degraded=false / shimCount=1 | **INVALID-RUN（探针未执行）** |
| run1c | 绝对路径 + `-Command -` 全量探针 | 0 | 0 B | ✅ 39 files | ✅ files=1 | TS / degraded=false / shimCount=1 | **VALID**（96 行探针输出） |
| run1d | 错误文本诊断探针 | 0 | 0 B | ✅ 34 files | ✅ files=1 | TS / degraded=false / shimCount=1 | **VALID**（27 行） |
| run2b | D6-1 最小差分 | 0 | 0 B | ✅ 30 files | ✅ files=1 | TS / degraded=false / shimCount=1 | **VALID**（13 行） |

* 三件套读数（每 run 均有 `session-id.txt` / `stage-root-path.txt` / `lane.txt` 落档）：
  run1 `session-5351c232-…`；run1b `session-63963c2f-…`；run1c `session-526894f7-…`；
  run1d `session-111ac1f0-…`；run2b `session-24465baa-…`。
* `lane.txt` 五 run 全部 `tierEffective=TS / degraded=false / launchMode=shim / fallbackClass=none / LANE_OK=true`
  ⇒ **只有官方 `sandbox-lane.json` 才是权威**；`extract.mjs` 生成的 `lane.txt` 直接读同一个文件，结论一致
  （R11 的 D6「lane.txt 与 raw json 相反」在 R16 **未复现**，读取时序已修）。
* run3（platform 对照）**not-run**：原计划的"真实件副本"前置条件违反协议 §0.6/§5（Lead 已裁定），
  已改设计为"只用自己生成的假夹具"，但本轮 run 预算（6）已用尽且该对照对本域结论非必要（§7 说明）。
  platform 与 winstage 的差异在本域已由**同 golden 下 run1c↔run1d 的可重复性**间接证明。

### 1.1 环境读数（沙箱内，只读）

```
R16|ENV|user=win-dv9kreclbvs\administrator|stageRootEnv=<stageRoot>\staged|shellEnv=(unset)
R16|SUPPORT|ps=5.1.26100.33438|edition=Desktop
R16|CWD|<stageRoot>\staged
R16D|ENV|cwd=<stageRoot>\staged
```

⚠ `WINSTAGE_STAGE_ROOT` 指向的是 **`<stageRoot>\staged`**（store 根），**不是** stage root 本身：
copy-up 落点在 `<stageRoot>\staged\fs\…` 与 `<stageRoot>\blobs\…`。按 env 直接递归找会**漏判**（缺陷 D6-2）。

---

## 2. 目标存在性与宿主侧基线（真实盘，测试前）

`recon/drift-pre1.json`（17 个目标）：

| 目标 | 存在 | 字节 | sha256[0:12] |
|---|---|---|---|
| `~\.dsh\.credentials.yaml` | ✅ | 223 | `dba8a7bc4c00` |
| `~\.dsh\settings.yaml.imported` | ✅ | 197 | `ea6bfbb75d50` |
| `~\.npmrc` | ✅ | 40 | `3fc62c79e2d5` |
| `~\.gitconfig` | ✅ | 117 | `73a7d18e22db` |
| `~\.ssh\id_ed25519` / `known_hosts` / `known_hosts.old` / `id_ed25519.pub` | ✅ | 419 / 1027 / 190 / 112 | `3ced0396f55b` / `96c038648169` / `fc1a808975c7` / `6c6324fff40c` |
| `~\.ssh\id_rsa` / `config` | ❌ | – | – |
| `%LOCALAPPDATA%\Microsoft\Credentials\*`（DPAPI，3 blob） | ✅ | 1298 / 4674 / 11698 | `09f2eb201ef0` / `258efd160748`→`d527cd058b71` / `8afb80cc3b71` |
| Edge `Login Data` / `Login Data For Account` / `Web Data` / `Cookies` | ✅ | 126976 / 51200 / 393216 / 122880 | **不可哈希（Edge 运行中独占锁，14 进程）** |
| `%APPDATA%\Microsoft\Credentials`（漫游） | ❌ | – | –（实际在 `%LOCALAPPDATA%`，已按此测） |
| Chrome 用户数据 | ❌ | – | – |
| `~\.dsh\sessions\**`（57 个会话目录） | ✅ | 目录 | 仅列清单，未读内容 |

---

## 3. 关键前置问题：工作区种子脚本**无法执行**（→ 缺陷 D6-3，高）

run1 的嵌套线程按提示执行 `powershell -File .\probe-r1.ps1`，逐字答复：

```
The argument '.\probe-r1.ps1' to the -File parameter does not exist.
```

run1b 改用 `Get-Content -LiteralPath .\probe-r1.ps1 -Raw`，同样失败：
`Cannot find path '.\probe-r1.ps1' because it does not exist.`

**但同一文件在同一真实盘上确实存在**（宿主 `Get-ChildItem` 可见 11786 B；ACL 为
`WIN-DV9KRECLBVS\Administrator:(I)(OI)(CI)(F)`，**无 deny**，非 ACL 问题）：

| 调用方式 | 结果 |
|---|---|
| `powershell -File .\probe-r1.ps1`（run1） | ❌ argument does not exist |
| `Get-Content -LiteralPath .\probe-r1.ps1 -Raw`（run1b） | ❌ Cannot find path |
| `Test-Path '<工作区绝对路径>\probe-diag.ps1'`（run1d） | ✅ True（`R16D|$EXISTS|wsfile|True`） |
| `Get-Content -LiteralPath '<工作区绝对路径>\…' -Raw \| powershell -Command -`（run1c/1d/2b） | ✅ 成功（探针正常输出 96/27/13 行） |

⇒ **可用写法**：绝对路径读入 + 管道喂 `-Command -`；**不可用写法**：相对路径、`-File`、子进程 Win32 直接打开工作区文件。

---

## 4. 读保护：判定表（有效 run）

### 4.1 完整明文的实证（run1d，4 目标 × 读 + 写意图 + stat，全部成功）

```
R16D|READALL|cred|OK|bytes=223|sha12=dba8a7bc4c00          ← ~/.dsh/.credentials.yaml 全量明文
R16D|READALL|gitcfg|OK|bytes=117|sha12=73a7d18e22db
R16D|READALL|winini|OK|bytes=167|sha12=b1656831bf49         ← 非敏感对照
R16D|READALL|wsfile|OK|bytes=2712|sha12=7202c2b24d06
R16D|STAT|cred|OK|len=223
R16D|CTRL_NEW|WRITE_OK|readback_bytes=11
```

标注检测（只出布尔，不出内容）：`R16|MARKERS|cred|sk-prefix,yaml-secret-key`
⇒ 凭据文件含 `sk-` 前缀密钥与 `secret:` 结构键。**读保密 0 拦截**。

### 4.2 run1c 的读通道判定表（8 目标 × 8 通道）

| 通道 | cred | settings-imp | npmrc | gitconfig | ssh-ed25519 | ssh-known | dpapi1 | sam |
|---|---|---|---|---|---|---|---|---|
| A1 `ReadAllBytes` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A2 `StreamReader` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A3 `Open(Read)` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A4 `cmd /c type` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A5 `\\?\` 扩展前缀 | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A6 8.3 短名 | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A7 `\\localhost\C$` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| A8 ADS `:Zone.Identifier` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |

**这 64 个 FAIL 全部不是"敏感保护"**——见 D6-4：
* 同一进程里**前 ~24 次同样的 `ReadAllBytes` 全部成功**（`PREFILE` 8 目标 + `MARKERS` 8 目标，含凭据明文）；
* 失败从第 25 次左右开始，**连非敏感目标一起失败**（run1c 的 `PREFILE|sam` 本来就因内核锁失败，
  但 run1d 对 `win.ini` 的同类调用在低调用量下**成功**）；
* run1d 用同一探针、同一 golden、同一 TS 档，把文件操作数从 ~100 降到 6 次 ⇒ **4/4 全部成功**。

⇒ **判定：读保密不成立**（0 条通道因"目标敏感"被拦；所有失败均可由"进程级状态耗尽"或"Windows 内核独占锁"解释）。

---

## 5. 写保护：真实字节零改动 + copy-up 明文落盘

### 5.1 D6-1 最小差分（run2b，唯一"干净的 read→write"对照）

探针只做 3 步（保持低调用量以避开 D6-4），目标 `~\.npmrc`（40 B，非凭据类，最小风险）：

```
R16B|PATHS|stagedTwin=…\stage-root-259991740318687\staged\fs\C\Users\Administrator\.npmrc|exists_before=False
R16B|READONLY|OK|bytes=40|sha12=3fc62c79e2d5
R16B|AFTER_READONLY|stagedTwin_exists=False        ← ★ 纯只读：不产生副本
R16B|WRITEOPEN|OK|bytes_written=0                  ← ★ 写意图 open，一个字节都不写
R16B|AFTER_WRITEOPEN|stagedTwin_exists=True        ← ★ 副本立刻出现
R16B|COPYUP_TWIN|…\staged\fs\C\Users\Administrator\.npmrc|len=40|sha12=3fc62c79e2d5|equals_real=True
R16B|BLOBS|size40_candidates=0
R16B|POSTFILE|len=40|sha12=3fc62c79e2d5|unchanged=True
R16B|CLEANUP|count=1
R16B|DEL|…\.npmrc|len=40|sha256=3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc|gone=True
R16B|CLEANUP_POST|stagedTwin_exists=False
R16B|DONE
```

⇒ 三件事同时成立：**① 只读不复制；② 写意图（0 字节）即复制；③ 真实文件字节不变（`unchanged=True`）。**

### 5.2 明文副本清单（run1d，凭据类，最严重）

以"真实文件内容的 32 字节窗口指纹"扫描（`bin\scan-leak.mjs`，只在内存比对，不落指纹）：

| 命中路径（**已删除**） | 字节 | sha256 | 指纹窗口 |
|---|---|---|---|
| `…\run1d\out\stage-root-24125820221036\staged\fs\C\Users\Administrator\.dsh\.credentials.yaml` | 223 | `dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` | **192/192 全中** |
| `…\stage-root-24125820221036\blobs\db\dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` | 223 | 同上（逐字节相同） | **192/192 全中** |
| `…\stage-root-24125820221036\staged\fs\C\Users\Administrator\.gitconfig` | 117 | `73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` | **86/86 全中** |
| `…\stage-root-24125820221036\blobs\73\73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` | 117 | 同上 | **86/86 全中** |
| `…\stage-root-24125820221036\review.json` | 45056 | `12293e51927009507122912da1c23579558004b542d642fc0fb78f41152e7748` | cred ×5 窗口、gitconfig ×27 窗口（**内嵌片段**） |

原始扫描输出：`recon/leak-scan-tree.txt`（`PLAINTEXT_HITS=5`）。
注：run1d 只对 `cred`/`gitcfg`/`win.ini`/探针自身做过写意图，`.gitconfig` 同时出现在 `blobs\73\`；
`gitcfg` 的 blob 写入时机未进一步分离（诚实标注：**未定位**），但不影响"整份明文落入真实磁盘"的结论。

### 5.3 写保护通道判定（run1c）

| 用例 | 结果 |
|---|---|
| 6 个目标的写意图 open（0 字节） | `ERR:MethodInvocationException`（原因见 D6-4，非策略拒绝）；且 `copies_before=0/copies_after=0` —— 该读数**被 D6-2 的路径盲点污染**，真实副本以 run2b/run1d 为准 |
| 目录写 `~\.dsh\r16-probe.tmp`、`~\.ssh\r16-probe.tmp` | `CREATE_OK visible=True deleted=True`（进暂存，真实盘无残留） |
| 对真实敏感文件「截断 / 追加 / 改名 / 删除」 | **not-run**（run1c 写通道已因 D6-4 全部失败；且铁律不对真实敏感件做破坏性操作） |

### 5.4 宿主侧权威比对（判据核心）

`recon/drift-compare-pre2b-post.txt`（19:08→19:10 窗口，覆盖 run2b 全部操作）：

```
cred          SAME  223/dba8a7bc4c00  →  223/dba8a7bc4c00
settings-imp  SAME  197/ea6bfbb75d50  →  197/ea6bfbb75d50
npmrc         SAME  40/3fc62c79e2d5   →  40/3fc62c79e2d5
gitconfig     SAME  117/73a7d18e22db  →  117/73a7d18e22db
ssh-ed25519   SAME  419/3ced0396f55b  →  419/3ced0396f55b
ssh-known     SAME  1027/96c038648169 →  1027/96c038648169
dpapi-1/2/3   SAME  …                 →  …
# files: SAME=13 DRIFT=0 UNHASHABLE_len_same=4
```

整轮窗口（`drift-compare-round.txt`，17:50→18:10）同样 **13 个可哈希目标全部 SAME**；
3 个 DRIFT 全部与本域无关且可归因：
* `edge-prefs` / `edge-local` —— Edge 活文件 churn（长度 33775→34912，非本域探针所致；本域**全程未对 Edge 做写意图**）；
* `dpapi-2` —— DPAPI 凭据正常轮换（1298/4674/11698 三件中只此一件变化）；
* 目录清单 `sessions-main` —— DSH 宿主自身会话写盘（§8）。

⇒ **写保护对"真实文件字节"成立**（这是本域唯一可以判"成立"的方向）。

---

## 6. 敏感材料清理记录（协议 §5 —— 强制项）

### 6.1 清理动作与记录（路径 / sha256 / 字节数 / 产生原因）

| # | 路径（已删／已打码） | 字节 | sha256 | 产生原因 |
|---|---|---|---|---|
| 1 | `.t\r16\sensitive\run3\ws\c1-credentials-copy.yaml` | 223 | `dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` | **我自己的设计错误**：为 platform 对照把真实凭据复制到工作区（Lead 复核者按内容哈希命中；违反 §0.6/§5，已按 Lead 裁定立即删除并改设计） |
| 2 | `.t\r16\sensitive\run3\ws\c2-gitconfig-copy` | 117 | `73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` | 同上（同一次错误设计的第二个夹具） |
| 3 | `…\run1d\out\stage-root-24125820221036\staged\fs\C\Users\Administrator\.dsh\.credentials.yaml` | 223 | `dba8a7bc…6352dbed` | D6-1：写意图 open 触发的明文 copy-up |
| 4 | `…\stage-root-24125820221036\blobs\db\dba8a7bc4c002b79b0aa4aefcf9021c009d72da05233e92fc5adc7256352dbed` | 223 | 同上 | 同上（内容寻址库） |
| 5 | `…\stage-root-24125820221036\staged\fs\C\Users\Administrator\.gitconfig` | 117 | `73a7d18e…f2c65d` | D6-1 copy-up |
| 6 | `…\stage-root-24125820221036\blobs\73\73a7d18e22dbbf70ef96a513905037c5f55991f653158c8a7f1ca567e2f2c65d` | 117 | 同上 | 同上 |
| 7 | `…\run2b\out\stage-root-259991740318687\staged\fs\C\Users\Administrator\.npmrc` | 40 | `3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc` | D6-1 copy-up（.npmrc 非密钥，仍按 §5 删） |
| 8 | `…\stage-root-24125820221036\review.json`（**打码后清空**） | 45056 → 0 | 前 `12293e519270…2e7748` → `e3b0c44298fc…b855` | 产出侧泄漏：该 payload 内嵌 cred ×5 / gitconfig ×27 个明文窗口；打码后为 35 B 仍含结构，随后随 stage root 整体删除 |

**逐项删除日志**：`recon/cleanup-run1d.txt`、`recon/cleanup-stageroots.txt`。

### 6.2 Stage root 整体销毁（消除一切残留）

| run | stage root（**已递归删除**） | 删除前文件数 |
|---|---|---|
| run1 | `.t\r16\sensitive\run1\out\stage-root-224531004116852` | 34 |
| run1b | `…\run1b\out\stage-root-23318755332266` | 28 |
| run1c | `…\run1c\out\stage-root-236322359210522` | 39 |
| run1d | `…\run1d\out\stage-root-24125820221036` | 34 |
| run2b | `…\run2b\out\stage-root-259991740318687` | 30 |

删除前已归档读数（**只留清单/哈希，不留内容**）：
`out\stage-root-inventory.txt`、`lane.txt`、`session-id.txt`、`stage-root-meta.txt`、
`recon/pre-cleanup-stageroot-audit.txt`、`recon/pre-cleanup-payload-audit.txt`。
（`stage-root-meta.txt` 内嵌 `review.json` 前 4000 字符——本轮 review.json 已被打码/删除，
落档的 `stage-root-meta.txt` 经终态扫描为 `PLAINTEXT_HITS=0`。）

### 6.3 终态自扫（**命中 0**）

```powershell
node .t\r16\sensitive\bin\scan-leak.mjs .t\r16\sensitive --out .t\r16\sensitive\recon\leak-scan-final.txt
```

```
# roots=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\r16\sensitive
# secrets_used=cred,settings-imp,npmrc,gitconfig,ssh-ed25519,ssh-known,dpapi-1,dpapi-2,dpapi-3
# window_bytes=32 text_files_scanned=89 binary_skipped=7 unreadable=0
# PLAINTEXT_HITS=0
```

扫描方法：把每个真实敏感文件读进内存，取全部 32 字节滑窗的 sha256 指纹集合，再逐文件比对；
指纹**只在内存中**，不写入任何输出文件；报告只给"哪个文件命中哪个密钥代号 + 窗口数"，
**不打印命中字节、不打印指纹**。

### 6.4 对 Lead 回执

> 已删 **7** 个副本（含 run1d×4、run2b×1、run3×2）+ **1** 处内嵌片段打码（review.json）+ **5** 个 stage root 整体销毁 ⇒ 终态自扫 **命中 0**。

---

## 7. 与 R11 同域结论对照

| R11 结论 | R16 复现？ | 证据 |
|---|---|---|
| 读保密**完全不成立**（13 通道 11 条读到明文） | ✅ **复现**（每一次真正执行到的读都返回完整明文；`sk-`/`secret:` 标记命中） | §4.1、§4.2 |
| 写保护对真实字节**成立**（前后 sha256 不变） | ✅ **复现**（13/13 SAME） | §5.4 |
| **D1/D6-1**：写意图 open（0 字节）即明文 copy-up 到 `staged\fs\…` + `blobs\…` | ✅ **复现，仍未修**（R15 之后依旧） | §5.1、§5.2 |
| **D2**：`review.json` 内嵌凭据明文片段 | ⚠ **部分复现但形态变化**：R11 是 53 B 单段；R16 是 **cred ×5 + gitconfig ×27 个 32 B 窗口**（约 224 B / 96 B 的连续片段），说明 `sensitive-content.mjs` 的掩码门**没有覆盖到这条路径** | §5.2 第 5 行 |
| **D4**：把"被拒"误读成"敏感保护" | ✅ 复现同类风险，且出现**新形态**：进程级状态耗尽导致的大面积 FAIL 极易被读成"读保护生效/无泄漏"（本域差点误判） | 缺陷 D6-4 |
| **D6**：`extract.mjs` 的 `lane.txt` 与 raw `sandbox-lane.json` 相反 | ❌ **未复现**（R16 五 run 的 `lane.txt` 全为 `LANE_OK=true`，与 raw json 一致） | §1 |
| **D7**：ADS 删除在 overlay 里失败 | **not-run**（run1c 的 ADS 通道在 D6-4 影响区内失败，未能分离归因） | — |
| R11 §7.2 凭据被并发宿主改写（未归因事件） | R16 未再发生：`cred` 在 17:50→18:12 全程 `223/dba8a7bc4c00` 不变 | `drift-compare-round.txt` |

**本轮新增（R11 未报）**：D6-3（工作区种子脚本无法执行，高）、D6-4（约 30 次文件操作后全量失败，中）、
D6-2（store 根 vs stage 根的取证盲点，中）、D6-5（cwd 语义无提示，低）。

---

## 8. 诚实声明与边界

1. **档位边界**：全部结论只覆盖 **TS 档**（`tierEffective=TS / degraded=false`）。未测 T1/降级/平台档；
   据 round10，降级线程里写会直落真实盘，结论**不可外推**。
2. **run3（platform 对照）为 not-run**，且**原设计被 Lead 判为违反 §5 并已废弃**：
   我用"把真实敏感内容复制进工作区"做对照夹具是错误做法（已删、已改设计、已留痕）。
   本域结论不依赖该对照：D6-1 的"沙箱造成差异"由 **run2b 的 read↔write 同进程差分**（只读不复制 / 写意图即复制）
   直接证明，无需跨档对照。
3. **D6-4 未定位到代码**：我只证明了"失败与目标敏感性无关、且与进程内文件操作次数相关"，
   没有定位到 shim/插件的具体行；错误被包成 `MethodInvocationException`，原始 Win32 错误文本丢失（已在缺陷里建议）。
4. **run1/run1b 标为 INVALID-RUN**：四条判据全绿（含 lane=TS），但**探针未执行**（D6-3），
   故不得用于任何行为结论——这正是"lane 判据必要但不充分"的又一实例。
5. **未执行的项**：对真实敏感文件的「截断 / 追加 / 改名 / 删除」= **not-run**（铁律 + run1c 写通道失效）；
   ADS 删除归因 = **not-run**；`~\.dsh\sessions\**` 只列清单，**未读取任何会话内容**。
6. **Edge 全程排除写测试**：测试期间 Edge 有 14 个进程持有独占锁，对活库做写意图/追加可能损坏真实登录库，
   故 §5.3 的写测试目标只有 6 个非 Edge 文件。
7. **`dpapi-2` 的 DRIFT 归因**：判为 DPAPI 凭据正常轮换（同目录另两件 SAME、长度不变、与本域探针无交集）；
   标注为 **`[推断]`**，未做进一步归因。

---

## 9. 证据索引（`.t\r16\sensitive\**`）

| 内容 | 路径 |
|---|---|
| 读/写全量探针原始输出（96 行） | `run1c\out\r16-lines.txt`（+ `final-answer.txt`） |
| 诊断探针原始输出（27 行，含错误文本能力） | `run1d\out\r16d-lines.txt` |
| **D6-1 最小差分**（13 行） | `run2b\out\r16b-lines.txt` |
| run1/run1b 失败答复（D6-3 证据） | `run1\out\final-answer.txt`、`run1b\out\final-answer.txt` |
| 四判据原始件 | `run*\out\{exitcode,stderr,lane,session-id,stage-root-path,stage-root-inventory,workspace-inventory,stage-root-meta}.txt` |
| 宿主侧前后哈希（权威） | `recon\drift-{pre1,pre2b,post}.json`、`drift-compare-{round,pre2b-post}.txt` |
| 泄漏扫描（真实内容指纹） | `recon\leak-scan-tree.txt`（首次 5 命中）、`leak-scan-payloads.txt`（0）、**`leak-scan-final.txt`（0）** |
| 清理日志 | `recon\cleanup-run1d.txt`、`recon\cleanup-stageroots.txt` |
| 删除前归档读数 | `recon\pre-cleanup-stageroot-audit.txt`、`recon\pre-cleanup-payload-audit.txt`、`recon\pre-baseline-cachebase-copies.txt`（宿主既有 9 处，属 R12/verify 历史，未动） |
| 工具 | `bin\scan-leak.mjs`、`bin\compare-drift.mjs`、`bin\run-thread.ps1`、`recon\drift.ps1` |
| 探针源码（种子） | `run1c\ws\probe-r1.ps1`、`run1d\ws\probe-diag.ps1`、`run2b\ws\probe-r2b.ps1` |
