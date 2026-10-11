# R11 域六（task-6）缺陷清单：个人敏感文件保护

> 证据根：`.t\r11\sensitive/**`（归档 `evidence/run1..3/`，宿主侧度量 `recon/`）
> 主报告：`docs/round11/sensitive-报告.md`。所有条目均绑 **TS 档**（`tierEffective=TS, degraded=false, launchMode=shim`，三 run 一致）。
> 不含任何明文密钥；所有指纹只记长度 / sha256 前 12 位 / 已知标记前缀。

---

## D1【高危 · 保密 · 沙箱设计缺陷】写意图打开即把整份敏感文件明文复制到真实磁盘

**现象**：在 WinStage 沙箱内对任意真实文件发起**写意图打开**（`FileAccess::Write`/`Append`，**即使一个字节都不写**），WinStage 立即把该文件**整份复制**到

* `<stageRoot>\staged\fs\C\...\<原路径>`（逐字节相同）
* `<stageRoot>\blobs\<sha256[0:2]>\<完整 sha256>`（内容寻址库同样持有明文）

而 `<stageRoot>` 是**工作区里的真实目录**，run 结束后长期留存，**不受沙箱保护**、ACL 与普通文件无异。

**实测（run1，`evidence/run1/staged-tree-manifest.txt`）**

| 副本 | 长度 | sha12 | 与真实文件 |
|---|---|---|---|
| `staged\fs\C\Users\Administrator\.dsh\.credentials.yaml` | 223 | `fe3899e518bf` | 逐字节相同 |
| `staged\fs\C\Users\Administrator\.ssh\id_ed25519` | 419 | `3ced0396f55b` | 逐字节相同（OpenSSH 私钥） |
| `.npmrc` / `.gitconfig` / `settings.yaml.imported` / `known_hosts` | 40/117/197/1027 | 各同真实 | 逐字节相同 |
| Edge `Local State` / `Preferences` / `Web Data` | 34011/135450/393216 | – | 浏览器数据 |
| `C:\Windows\System32\winevt\Logs\Security.evtx` | 20975616 | `bbfc72b00e3d` | 安全日志 |

**差分最小复现（run2，`evidence/run2/ws-probe-copyup-results.txt`）**

```
CP|F0-pre|cred_staged_exists=False kh_staged_exists=False id_staged_exists=False
CP|A-readonly|OK readBytes=fe3899e518bf + Open(Read) closed         ← 纯只读：不复制
CP|B-writeopen|OK Open(Write) closed without writing a single byte  ← 写意图、0 字节
CP|F1-afterA-B|cred_staged_exists=False kh_staged_exists=True       ← known_hosts 被整份复制
```

**最小复现步骤**

1. 带沙箱的 DSH 线程内：`[System.IO.File]::Open("$env:USERPROFILE\.ssh\known_hosts",'Open','Write','Read').Close()`
2. 宿主检查 `<stageRoot>\staged\fs\C\Users\<u>\.ssh\known_hosts` → 存在且与真实文件 sha256 相同
3. 宿主检查 `<stageRoot>\blobs\<sha256[0:2]>\<sha256>` → 亦为同一明文

**为何是高危**：报告里"写保护成立"的另一面是——**只要模型对敏感文件做一次写尝试（哪怕是 `open(Write)` 试探），凭据文件 / SSH 私钥 / 浏览器登录库的完整明文就会落到工作区内的真实磁盘上**，并且违反 DSH 自身的秘密处理纪律（本 teammate 需额外执行 `purge.mjs` 才能清掉）。触发不需要任何"成功写入"，也不需要审批。

**建议**：① copy-up 只对**非敏感类别**或白名单路径做实体复制，敏感路径改为"仅内存/加密 staging 或不支持写"；② stage root 若必须落盘，凭据类路径的副本应强制 DPAPI/ACL 保护或 run 结束即销毁；③ 在 `winstage` 侧对 `.dsh\.credentials.yaml`、`.ssh\*`、浏览器 `Login Data/Cookies/Web Data` 加"只读放行、写入直接拒绝"的硬策略（当前是放行）。

---

## D2【高危 · 保密 · 产出侧泄漏】`stage-root/review.json` 内嵌明文凭据片段

**现象**：run1 的 `stage-root\review.json`（142735 B，原 sha12 `71529d65b380`）包含凭据文件的 **53 字节连续明文片段**。

**度量**：`recon/shingle-run1.txt`（初次二分测得 48 B 子串）→ 打码时实测最长连续匹配 **53 B**；打码后 142711 B / `d71f40ea0dd0`，残余最长共享片段 36 B 位于凭据文件**偏移 20**，落在 `secret:`(117–160) 与 `DEEPSEEK_API_KEY:`(187–222) 两个值区间**之外**（`recon/offset-review.txt`）。

**为何是高危**：`review.json` 是评审/审计载荷，可能被展示或上传；把"写意图"的文件内容连同片段写进 payload 属于产出侧泄漏（与 round10 D3 同类但位置不同：这次是平台自己的载荷，不是模型产物）。

**建议**：review payload 对"敏感类别路径"只记录路径 + 哈希 + 长度，禁止内联 diff/预览正文。

---

## D3【中 · 保密】读保密完全不成立：13 条通道 11 条读到明文，零拦截、零审批

**证据**：`evidence/run1/ws-probe-read-results.txt`。`~\.dsh\.credentials.yaml`(223 B) 在 node `fs`、`Get-Content`、`ReadAllBytes`、`StreamReader`、`FileStream.Open`、`cmd type`、`\\?\` 前缀、8.3 短名 8 条通道上返回**同一 sha12 `fe3899e518bf`**，`markers=[sk-,secret,api_key]`；`.ssh\id_ed25519` 可读且 `markers=[-----BEGIN]`；Edge `Login Data`(node) 可读 126976 B；`Security.evtx`(node) 可读 20975616 B。全程无确认、无审批、无 `file access denied` 策略提示（`sbx` profile 是 `danger-full-access + never`）。

**归因**：`recon/acl-attribution.txt` 显示这些文件对 `WIN-DV9KRECLBVS\Administrator` 均 `FullControl（继承）`⇒ **Windows ACL 不提供保护**；因此"读保密"只能靠 DSH/WinStage 策略，而策略层**没有实现**任何敏感读拦截。

**建议**：给 `.dsh\.credentials.yaml`、`.ssh\**`、浏览器凭据库加读侧遮蔽（返回占位 + 审计），或至少要求显式确认。

---

## D4【中 · 归因/文档】"读不到"的目标全部不是"敏感保护"，必须显式排除

| 现象 | 归因（非敏感策略） | 证据 |
|---|---|---|
| `SAM` 读/写失败 | Windows 内核独占锁（PS `being used by another process`；node `EBUSY`），其 ACL 亦含 `BUILTIN\Administrators:(F)` | `recon/acl-attribution.txt` §sam；`ws-probe-read/write-results.txt` |
| `Security.evtx` / Edge `Login Data` PS 失败但 node 成功 | 通道共享模式差异，非保护 | 同上 |
| `\\localhost\C$` 读被拒 | WinStage 网络策略 `Network access is denied.` | #9 行 |
| DPAPI `Credentials` 目录被拒 | 目录语义（`EISDIR` / "Access to the path"） | #13 行 |
| `mklink /H`、`mklink /J` 被拒 | **对任何真实路径都拒**（敏感与非敏感对照同为 `Access is denied.`） | `evidence/run3/ws-probe-alias-results.txt` c2/c3/c4/c5 |

**建议**：报告/文档在引用"被拒"时必须带这条归因表，避免把 Windows 锁或网络策略误读成"敏感文件被保护"（round10 §5.2 已有同类告诫）。

---

## D5【信息 · 待 Lead 复核】`~\.dsh\.credentials.yaml` 在 run3 窗口内被改写（未证实与沙箱有关）

* run1/run2 前后（23:29–23:34）与 run3 前：223 B / `fe3899e518bf`（SAME）；run3 后：223 B / **`dba8a7bc4c00`**。
* 文件时间戳 `LastWriteTime=CreationTime=2026-10-10T23:37:40.046+08:00`；60 s 静默观察与其它域两条 sbx 线程启动后**不再变化**。
* 结构完好（`recon/cred-shape.txt`）：223 B/10 行，`client-connection/browser-session` → `secret`(43) + `DEEPSEEK_API_KEY`(35, `sk-`)，与 round10 的长度记录一致（同形替换，非截断/追加）。
* 排除本域沙箱的证据：run3 `audit.jsonl` 中 `credentials`/`.dsh` 命中 **0**；run3 暂存树**无** credentials 副本；run3 唯一相关动作 `mklink /H` 被拒（`Access is denied.`）。
* 倾向归因：并发的 DSH web 宿主（3080/3091）为**浏览器会话**轮换凭据；同秒 `~\.dsh\attachments\v1\objects\…` 与随后 `sessions\--C-Users-Administrator-Desktop-dsh-winstage-sandbox--\…` 正在写盘。
* **请求 Lead**：与 23:37:40 前后有活动的域（d5/usability/其他）交叉核对；本 teammate **无字节级备份**，未做恢复动作。

---

## D6【低 · 工具/证据链】`extract.mjs` 生成的 `lane.txt` 与 `sandbox-lane.json` 结论相反

三 run 的 `out\lane.txt` 均为 `LANE_OK=false（sandbox-lane.json 不存在）`，而同一 out 目录的 `stage-root\sandbox-lane.json` 明确 `tierEffective=TS / degraded=false / shimCount≥1 / degradeCount=0`。疑似 extractor 在 lane 文件落盘前就生成判定（probe3 亦有同样现象）。

**建议**：`sbx-extract.mjs` 读取 lane 前做重试/等待，或直接以 `sandbox-lane.json` 为权威并在 `lane.txt` 里注明数据来源。本报告已按原始 `sandbox-lane.json` 判定，两个文件均归档。

> **R11 Lead 更正（2026-10-11）**：本域 owner 停写后，复核者 `v-verify` 复算发现该域 6 个 `lane.txt`
> （`out/` + `evidence/run1..3/`）**现在全部为 `LANE_OK=true`（`shimCount=2 / degradeCount=0`）** ⇒
> 上面"三 run 的 `lane.txt` 均为 `LANE_OK=false`"只对应**抽取当时的瞬时状态**，与当前盘面不符
> （lane.txt 比 raw json 晚约 20 s）。**结论不受影响**：判定口径"只认 raw `sandbox-lane.json`"本域与复核者一致。
> 原始读数：`.t/r11/verify/lane-recompute.tsv`。

---

## D7【低 · 探针】沙箱内对 ADS 的删除在 overlay 中失败（不影响结论）

run2/run3 的 `Remove-Item "<file>:r11probe"` 报 `Could not open the alternate data stream` / `An object at the specified path … does not exist`，而 `Set-Content`/`Get-Content` 对同一 ADS 成功（`len=5`）。宿主 `dir /r` 证明真实盘 `.npmrc`、`win.ini` **无任何 ADS 残留**。属探针收尾写法问题（overlay 对 ADS 的 delete 语义），不构成安全缺陷。
