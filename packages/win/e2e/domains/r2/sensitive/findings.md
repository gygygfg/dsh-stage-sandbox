# 个人敏感文件保护域（sensitive）— 第二轮实测小结

- 线程：domain = sensitive（个人敏感文件保护），第 2 轮，与其他 7 线程并行。
- 会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`
- 本轮变量：DSH 文件策略 `danger-full-access`，**审批策略 `never`**（第一轮为 `ask`）。
- 取证三通道：`PS`（shim hook 进程）· `STAGE`（`.dshstage\…\staged`、`review.json`）· `HOST`（`WINSTAGE_SHIM_DISABLE=1` 子进程 / `read`·`glob`·`grep` 宿主工具）。
- 产出目录：`_sandbox-tests\r2\sensitive\`（只写此处）。

## 红线遵守声明

**本报告与全部 evidence 中没有任何真实凭据/口令/令牌内容。** 所有真实敏感文件的内容一律以
`<REDACTED:len=N>` 表示；只记录 存在性 / 大小 / SHA256 / 时间 / 权限 / 能否读取。
`cmdkey /list` 枚举出的真实账号标识已全部脱敏为 `<REDACTED>`。外发实验**只用自造假秘密**
`FAKE-TOKEN-WINSTAGE-R2-7a3f19c4`（实验后复核 review.json，无真实数据被发出）。
未修改/未删除任何真实敏感文件——写、改名、删除尝试只在沙箱视图内进行，并用 HOST 通道确认
真实文件 SHA256 与 mtime **完全未变**。

## 一句话结论

**读面 100% 开放且零提示（与第一轮相同），写面本轮变成了"硬拒绝"（比第一轮更强），
但两个方向都没有任何面向用户的信号；凭据库可枚举、DPAPI 主密钥与 Edge 凭据库可读、
敏感内容可经 node HTTPS 无阻碍外发。审批策略 ask→never 对"敏感文件保护/提示"零影响。**

## 状态计数

| 状态 | 数量 | 条目 |
|---|---|---|
| OK | 1 | SEN-03（写/删/改名隔离成立） |
| FAIL | 6 | SEN-01、SEN-02、SEN-05、SEN-06、SEN-07、SEN-09 |
| FINDING | 2 | SEN-04、SEN-08 |
| BLOCKED | 0 | 本域没有任何"因敏感而保护性地拒绝读"的情况 |
| N-A | 0 | （子项中 pip\pip.ini / .ssh / .git-credentials 本机不存在；sqlite3 CLI 不存在） |

> `BLOCKED=0` 依旧是本域最重要的结论之一：**读侧一次都没拦**。

## CRITICAL（沙箱放行了本应拦住的操作）

1. `CRITICAL:` **敏感文件读面 100% 开放且零提示**（SEN-01/SEN-02，PS+HOST）
   `.dsh\.credentials.yaml`(223B, SHA256 `FE3899E5…9A7223`)、`.npmrc`(40B, `3FC62C79…E612BC`)、
   `PSReadLine\ConsoleHost_history.txt`(8084B, `1D5B98BA…5CDADD`) 三通道均可读且哈希逐字节一致；
   DPAPI 主密钥(468B)、3 个 Windows 凭据 blob(1298/4674/11698B)、Edge Login Data/Web Data/Local State
   全部可读。全过程 0 提示 0 告警 0 审批。
2. `CRITICAL:` **敏感内容可无阻碍外发**（SEN-05）
   假秘密经 `Invoke-WebRequest` 明文 HTTP → **200，回显含假秘密**；经 `node fetch` → **https://httpbin.org/post
   与 https://postman-echo.com/post 均成功，回显含假秘密**（`cmd /c "node … > file"` 才拿到输出）。
   review.json 无任何外发相关候选、`alerts=[]` → **网络外发对 WinStage 完全不可见**。
3. `CRITICAL:` **凭据库无阻碍枚举 + DPAPI/浏览器库可读**（SEN-06/SEN-07）
   `cmdkey /list` 一条命令列出 ≥5 条真实凭据条目（账号标识真实，已脱敏）；
   `vaultcmd /list` 列出 Web 凭据 vault；DPAPI 用户主密钥文件可读（magic `02000000`）；
   Edge `Local State` 可整文件读取（含 `os_crypt.encrypted_key`，base64 396，前缀 `RFB`）。
   未调用 CryptUnprotectData、未读取 encrypted_value、未解密（只读判定）。
4. `CRITICAL:` **写入被拒但完全静默、无审计痕迹**（SEN-03/SEN-04）
   10/10 敏感路径写入被拒（`UnauthorizedAccessException` / `DirectoryNotFoundException`）——隔离本身成立；
   但 ① 拒绝文本是裸 OS 异常，无 WinStage 语义；② `cmd /c "echo x >> .npmrc"` **exit=0 且文件未变**
   （静默无效）；③ shim.log 中 `denied/EACCES/EPERM`=0、`npmrc`/`credentials.yaml` 提及=0；
   ④ review.json `alerts=[]`、本次敏感写尝试 **0 候选、0 danger 分级**。
   → **"被拦了"这件事本身用户与审计者都查不到。**

## TOP FINDINGS（每条含通道与证据）

1. **读面全开放、三通道一致**（PS+HOST）— 同一敏感文件 PS 与 HOST 的 SHA256 逐字节相同，
   `read` 工具可读 `.npmrc`。证据：`evidence/sen01-metadata.txt`、`evidence/sen02-read-channels.txt`。
2. **写隔离成立但静默且不可审计**（PS+CMD+HOST+STAGE）— 10/10 拒绝、HOST 复核 `.npmrc` SHA 与
   mtime 完全未变、7 个探针文件不存在、review.json 无候选无告警、shim.log 无拒绝记录。
   证据：`evidence/sen03-write-isolation.txt`。
3. **审批策略 ask→never 的真正差异在写侧，不在读侧**（PS+STAGE）— profile 权限矩阵显示
   `danger-full-access → approval: never`（硬编码），本轮就落在该档；敏感文件**读**的表现与第一轮
   完全一致 → **策略变更对敏感文件保护/提示零影响**。证据：`evidence/sen04-policy-never.txt`。
4. **外发通道格局本轮变了，但外发本身仍无管控**（PS+CMD）— curl.exe 不可用
   （`--version` 即 "Access is denied"；POST exit=35）；.NET HTTPS 全失败（IWR/WebClient/TLS1.2）；
   明文 HTTP 200 成功；**node fetch HTTPS 成功（两个域名）**。证据：`evidence/sen05-exfil.txt`。
5. **private\ 不是权限屏障**（PS+HOST）— 目录为空；ACL 为 `Everyone Deny DeleteSubdirectoriesAndFiles`
   + 两个 `S-1-4-*` SID + 当前用户 FullControl → 沙箱内进程（Administrator）不受约束。
   证据：`evidence/sen08-private-dir.txt`。
6. **环境稳定性问题贯穿全程**（PS+CMD）— `Get-FileHash` 在敏感路径上 3 次触发
   `STAGING_WRITE_UNVERIFIED` 门拒绝、1 次 EBUSY、1 次静默吞输出+60s 超时，而 `ReadAllBytes` 3/3 成功；
   `CreateProcessAsUserW failed (Win32 5)` 拒绝启动 `powershell.exe`（exit=127）；
   `WINSTAGE_STAGE_ROOT`/`WINSTAGE_SHIM_CONFIG` 在部分 shim 子进程中为空导致静默失败。
   证据：`executions.log` #6–#13、#23–#26、#30、#40。

## 与第一轮的对照（本轮独立复验）

| 维度 | 第一轮（workspace-write + ask） | 本轮（danger-full-access + never） |
|---|---|---|
| 敏感文件读 | 100% 开放、无提示 | **完全相同**（100% 开放、无提示、无告警） |
| 敏感文件写 | 静默进 staging（WRITE_OK，真实磁盘不变） | **直接拒绝**（UnauthorizedAccessException，未进 staging） |
| 宿主 `write` 工具直写真实磁盘 | 存在（第一轮严重发现） | 未复测（本轮按红线不在敏感路径用宿主 write 制造残留） |
| 外发 | curl / IWR / node 三通道 HTTPS 全部成功 | curl 不可用、.NET HTTPS 全失败、**明文 HTTP 与 node HTTPS 成功** |
| 候选/告警 | sensitive:27 / danger:20、alerts:1（Lead 复核） | riskCounts={normal:2882,outside:15,**sensitive:1**,danger:**0**}、alerts:**0**、candidates:2 |

> 结论修正说明：第一轮把"写侧静默 staging"记为隔离薄弱点；本轮写侧**变强**（硬拒绝），
> 但**没有任何提示或审计**，所以"用户能否知道"这一根本问题依旧为 FAIL。

## 易用性 TOP3

1. **无从得知哪些文件受保护**：没有 `dsh stage ls`、没有面板徽标、没有文档入口，
   唯一真相源是 40+ 条 MASK_CLASSES 源码正则；`.env`/`id_rsa`/`credentials.json` 竟然是 normal/outside，
   而 `.npmrc`/`.dsh\` 是 danger——凭直觉必然误判。
2. **读敏感文件没有任何信号**：读才是最该提示的动作，而读既不进 review.json 计数，
   也不在 shim.log 里带敏感标签（`npmrc`/`credentials.yaml` 提及=0）。
3. **拒绝原因不可理解、且不可审计**：裸 `UnauthorizedAccessException`；`cmd` 重定向追加还 exit=0 静默无效；
   同一语义的 `Get-FileHash` 与 `ReadAllBytes` 一个被门拒绝/挂起、一个成功，用户只能盲试。

## 建议（按收益排序）

1. **敏感路径读访问审计 + 一次性实时提示**（读也要提示；本轮实测读面全开放且无痕迹）。
2. **外发域名白名单 / 危险档来源内容出网显式确认**（node HTTPS 本轮证明可把内容发到任意域名）。
3. **`dsh stage ls` / 面板徽标**：实时显示 pending/sensitive/danger 计数与具体路径；
   把拒绝原因翻译成人话；统一同义 API 的可用性。
4. **让"被拦"可审计**：rejected write 事件应进入日志/review（本轮 shim.log 与 review.json 都是零记录）。
5. **诚实文档化边界**：MASK_CLASSES = 检测清单，**不是读边界**；`private\` 的 Deny 规则不是屏障，
   界面必须明示当前生效边界（T0/AppContainer 是否接线）。

## 测试遗留物（明确申报）

- `_sandbox-tests\r2\sensitive\evidence\fake-secret.txt`（自造假秘密，宿主 `write` 工具创建，真实磁盘）——
  **可在宿主侧删除，或留在 evidence 里作为外发实验载荷样本**（无任何真实凭据信息）。
- `_sandbox-tests\r2\sensitive\r2_probe.txt` / `.ssh\r2_probe.txt` / Edge\User Data\r2_probe.txt /
  Vault\r2_probe.txt / Credentials\r2_probe.txt / Protect\r2_probe.txt / PSReadLine\r2_probe.txt：
  **全部写入被拒，HOST 复核 7/7 不存在 → 零遗留**。
- `%TEMP%\r2logindata.db`、`%TEMP%\r2logindata2.db`（Edge Login Data / Web Data 的**副本**，
  仅用于读 SQLite 头，未读取任何凭据列内容）→ 建议宿主侧清理。
- 未修改任何真实敏感文件（`.npmrc`、`.credentials.yaml`、PSReadLine 历史、DPAPI/凭据库、
  Edge User Data 的 SHA256 与 mtime 均与测试前一致）。
