# 域五（network, task-5）· R16 网络服务与网络访问实测报告

> 执行侧：域5 owner 线程（3080 web 会话，`WINSTAGE_SHELL=0`，**本会话未加载沙箱**），
> 通过 `docs\archive\round10\env\scripts\sbx-thread.cmd` 新起 **4 个独立的 `--profile sbx` 沙箱线程**（每 run 唯一 stage root），
> 外加 1 个**宿主未受限控制组**（`WINSTAGE_SHELL=0`，真实盘）。
> 证据分层：`[实测]` = 有原始输出落盘；`[读码]` = 只读源码核对；`[推断]` = 由原始读数推导；`not-run` = 未执行。
> 时间：2026-10-11 17:50–18:00（+08:00）。run 计数 **4/6**（协议上限 6）。
> 全部 4 个 run 过协议 §1.1 四条判据（`lane=TS`，见 §1）。

---

## 0. 直接回答（先给结论）

**问：出站是否收敛？入站是否可绑、能否被同机外部进程访问？真实 WFP 过滤器还在不在？**

**答：出站未收敛（全开放）、入站全开放且作用域语义与宿主一致、真实 WFP 过滤器 0 个（前后逐字节相同）。
R15 §3 的网络档位接线在"默认档读数"上复现，但键位落错行——profile/宿主行配置无效，只有环境变量有效。**

| # | 结论 | 关键读数 | 证据 |
|---|---|---|---|
| 1 | **出站未收敛**：沙箱内 HTTPS/DNS/TCP 与宿主控制组**逐项一致** | npmmirror `200 / 23 356 B / 412 ms`；tuna `200 / 11 565 B / 236 ms`；`registry.npmjs.org:443` 沙箱与控制组**同为 `ETIMEDOUT`** | `run-n1/.../outbound-head.txt`、`host/outbound-head.txt` |
| 2 | **入站可绑 + 同机外部可达**（双向、含 LAN IP） | 沙箱内 PID 1648 绑 `127.0.0.1:38611` 与 `0.0.0.0:38612`；外部（宿主）4 次探测：loopback@127.0.0.1 `200`、loopback@LAN **拒绝**、wildcard@127.0.0.1 `200`、wildcard@LAN `200` | `external-n1.json`、`run-n1/.../inbound-requests.jsonl`、`final.json` |
| 3 | **真实 WFP 过滤器 0 个** | `netsh wfp show filters` 前后 **filters XML sha256 完全相同**（`5405262E…34AD6`）；`<filterKey>` 1486→1486；`winstage` 命中 0→0、`dsh-` 命中 0→0 | `wfp/COMPRESS-MANIFEST.json`、`wfp/pre-filters.xml.gz`、`wfp/post-filters.xml.gz` |
| 4 | 默认档网络姿态如实"未实现" | lane `network.requested=OBSERVED_ONLINE / state=not-implemented / enforced=false / verified=false` | `audit-scan-n1.json`、`run-n1/.../sandbox-lane.json` |
| 5 | **（新，P1；已修·结构性复验通过，见 §4.6.1）networkTier 键位落错行**：写在 `winstage-sandbox` 宿主行，消费者 `shell-executor` 读 `winstage-shell` 行 | 宿主行 overlay=`OFFLINE` ⇒ lane 仍 `OBSERVED_ONLINE` 且命令**照常执行**；shell 行 overlay=`OFFLINE` 或 `WINSTAGE_NETWORK_TIER=OFFLINE` ⇒ lane `OFFLINE/refused` 且**所有 shell 命令被拒** | §4 的三次注入矩阵；`dump-*-config*.txt`；`run-n{2,3,4}` |
| 6 | OFFLINE 一旦生效，**fail-closed 正确**（拒绝执行任何命令） | 两 run（n3/n4）全部 `pwsh` 返回 `COMMAND_FAILED`，无一条命令落地；`staged\r16-n2-shell-attempt.txt` 不存在 | `run-n3/stdout.ndjson`、`run-n4/stdout.ndjson` |

---

## 1. run 有效性（协议 §1.1 四条判据，缺一不可）

机器核对脚本：`.t\r16\network\verify-runs.mjs` → `verify-runs.json`。

| run | 目的 / 档位来源 | session-id | 判据① `stderr.txt` | 判据② 暂存面 | 判据③ 真实工作区 | 判据④ `lane.txt` | 判定 |
|---|---|---|---|---|---|---|---|
| **n1** | 出站+入站主测；`profile` 默认（宿主行无 overlay） | `session-68f7501a-e670-4246-ab6d-044aa28ed8e0` | **0 B** | `staged\network-n1\{outbound.json,outbound-head.txt,ready.json,inbound-requests.jsonl,final.json,netstat-*.txt}` + `staged\r16-n1-fs-marker.txt`，`candidates\cs_0007_af2b4fc9.json` | 只有 `seed-net.txt`(4 B) | `LANE_OK=true` `tierEffective=TS` `degraded=false` `shimCount=6` | **VALID (lane=TS)** |
| **n2** | 档位注入 A：`--patch` 改**宿主行** `networkTier: OFFLINE` | `session-1bb4d693-e140-49df-b25f-2dd188368c63` | **0 B** | `staged\r16-n2-{fs-marker,shell-attempt,listing}.txt`，`candidates\cs_0004_2add6032.json` | 只有 `seed-net.txt` | `LANE_OK=true` `TS` `degraded=false` | **VALID (lane=TS)** |
| **n3** | 档位注入 B：`--patch` 改**shell 行** `networkTier: OFFLINE` | `session-a6082e21-d320-4e97-9395-c8263251d8f4` | **0 B** | `staged\r16-n2-fs-marker.txt`（唯一写入；shell 全被拒），`candidates\cs_0001_b3865911.json` | 只有 `seed-net.txt` | `LANE_OK=true` `TS` `degraded=false` | **VALID (lane=TS)** |
| **n4** | 档位注入 C：环境变量 `WINSTAGE_NETWORK_TIER=OFFLINE` | `session-ce8ce236-c0b8-40ee-b71f-d369deaec348` | **0 B** | `staged\r16-n2-fs-marker.txt`，`candidates\cs_0001_b3865911.json` | 只有 `seed-net.txt` | `LANE_OK=true` `TS` `degraded=false` | **VALID (lane=TS)** |

四条判据逐 run 全绿（`verify-runs.json`：`c1..c4` 全 `true`，`verdict="VALID (lane=TS)"`）；
每个 run 的 `stderr.txt` 都是 **0 字节**（loader 无告警），暂存根都在 `<outDir>` 内且无守护（R10 配方默认）。

---

## 2. 出站实测（沙箱内 vs 宿主控制组）

原始文件：`run-n1/stage-root-r16n1/staged/network-n1/outbound.json`（沙箱内，node v24.21.0）
↔ `host/outbound.json`（宿主 `WINSTAGE_SHELL=0` 控制组，同一探针脚本 `sbx-outbound.mjs`）。
三侧 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` **全为 null**（沙箱内 `WINSTAGE_SHELL=null`、`WINSTAGE_STAGE_ROOT` 指向暂存树）。

### 2.1 DNS `[实测]`

| 目标 | 沙箱内（n1） | 宿主控制组 | 判定 |
|---|---|---|---|
| `registry.npmmirror.com` | `lookup 120.220.81.136`（360 ms）/ `resolve4 120.220.81.136` | 同（25 ms） | 一致 |
| `pypi.tuna.tsinghua.edu.cn` | `101.6.15.130`（4 ms） | 同（14 ms） | 一致 |
| `registry.npmjs.org` | `lookup 141.193.154.210` / `resolve4 12 个 104.16.x.x` | 同 | 一致 |
| `no-such-host-r16.invalid`（负控） | `ENOTFOUND getaddrinfo`（48 ms） | 同 | 一致 |

### 2.2 HTTPS `[实测]`

| 目标 | 沙箱内（n1） | 宿主控制组 | 判定 |
|---|---|---|---|
| `GET https://registry.npmmirror.com/left-pad` | **200 / 23 356 B（`content-length: 4982`，压缩传输）/ 412 ms / `Tengine`** | 200 / 23 356 B / 327 ms / `Tengine` | **逐字节一致** |
| `GET https://pypi.tuna.tsinghua.edu.cn/simple/six/` | **200 / 11 565 B / 236 ms / `nginx/1.22.1`** | 200 / 11 565 B / 211 ms | **逐字节一致** |
| `GET https://registry.npmjs.org/left-pad` | **失败** `TypeError: fetch failed \| cause=UND_ERR_CONNECT_TIMEOUT`（10 456 ms） | 失败（同样 `UND_ERR_CONNECT_TIMEOUT`，10 238 ms） | 一致（**上游链路成因，不是沙箱策略**） |

> 判读：`content-length` 4982 与解压后 23 356 B 的差值 = `br`/`gzip` 传输编码，**不是**截断；
> 两侧同为 23 356 B ⇒ 沙箱没有插代理、没有重写响应。

### 2.3 裸 TCP `[实测]`

| 目标 | 沙箱内 | 宿主控制组 | 判定 |
|---|---|---|---|
| `registry.npmmirror.com:443` | `ok` 21 ms，`local 10.81.126.50:59089` | `ok` 21 ms | 一致 |
| `registry.npmjs.org:443` | `ETIMEDOUT` 12 002 ms | `ETIMEDOUT` 12 003 ms | **逐项一致** |

**⇒ 出站完全未收敛**：没有任何 DNS 改向、代理注入、TCP 拦截的痕迹；唯一的失败项在宿主控制组上同样失败。

---

## 3. 入站实测（沙箱内起监听 → 宿主外部连入）

沙箱内探针：`run-n1` 的 `sbx-inbound.mjs`（node 进程 **PID 1648**，`127.0.0.1:38611` + `0.0.0.0:38612`，hold 90 s，带带外 nonce `R16-D5-B8JKYR`）。
外部探针：**宿主未受限 pwsh**（`external-inbound.ps1`，pid 10420 侧），先轮询到沙箱写出的 `ready.json`（等待 140 892 ms）再连入。

### 3.1 绑定 + 外部可达 `[实测]`

| 探测 | 结果 | 证据 |
|---|---|---|
| 沙箱内绑 `127.0.0.1:38611` | `BIND OK`（`boundAddress=127.0.0.1`） | `final.json` |
| 沙箱内绑 `0.0.0.0:38612` | `BIND OK`（`boundAddress=0.0.0.0`） | `final.json` |
| 外部 `GET http://127.0.0.1:38611/ping` | **200**，110 B，158 ms，带回 nonce | `external-n1.json` |
| 外部 `GET http://10.81.126.50:38611/ping`（LAN IP） | **拒绝**（"由于目标计算机积极拒绝"）2 075 ms | 同上（loopback 绑定作用域被尊重） |
| 外部 `GET http://127.0.0.1:38612/ping` | **200**，108 B，27 ms | 同上 |
| 外部 `GET http://10.81.126.50:38612/ping`（LAN IP） | **200**，111 B，12 ms | 同上（wildcard 生效） |
| 负控 `127.0.0.1:38699`（无监听） | 拒绝，2 004 ms | 同上 |

**⇒ 入站全开放**：沙箱内能绑 loopback 与 wildcard 高位端口，同机**外部未受限进程**可连入并从 LAN IP 访问；绑定作用域语义（loopback 不响应 LAN、wildcard 响应 LAN）与宿主一致，**没有任何端口绑定拦截或作用域改写**。

### 3.2 双向交叉比对（nonce + peer 端口）`[实测]`

沙箱内服务端逐请求日志 `run-n1/.../inbound-requests.jsonl`（3 条）与外部 4 次探测**一一对应**：

```json
{"t":"2026-10-11T09:53:18.191Z","label":"loopback-127.0.0.1:38611","peer":"127.0.0.1:59169","local":"127.0.0.1:38611","ua":"r16-d5-external-prober","nonceHeader":"R16-D5-B8JKYR","nonceMatch":true}
{"t":"2026-10-11T09:53:20.403Z","label":"wildcard-0.0.0.0:38612","peer":"127.0.0.1:59173","local":"127.0.0.1:38612","ua":"r16-d5-external-prober","nonceHeader":"R16-D5-B8JKYR","nonceMatch":true}
{"t":"2026-10-11T09:53:20.436Z","label":"wildcard-0.0.0.0:38612","peer":"10.81.126.50:59174","local":"10.81.126.50:38612","ua":"r16-d5-external-prober","nonceHeader":"R16-D5-B8JKYR","nonceMatch":true}
```

- 外部探针未连上的那次（loopback@LAN）在沙箱服务端**没有任何请求记录** ⇒ 拒绝发生在 TCP 层，不是应用层。
- 宿主侧 `netstat` 在探测后同一时刻看到 `10.81.126.50:59174 → 10.81.126.50:38612 ESTABLISHED`（PID 10420 ↔ 1648），
  与沙箱日志的 `peer=10.81.126.50:59174` **是同一连接**。

### 3.3 监听归属与自清 `[实测]`

- 外部 `netstat -ano`（监听期间）：`TCP 0.0.0.0:38612 … LISTENING 1648`、`TCP 127.0.0.1:38611 … LISTENING 1648`
  ⇒ **沙箱内进程的监听在宿主 TCP 命名空间里可见、归属 PID 明确**（`external-n1.json` → `netstatDuring`）。
- 沙箱内自己跑的 `netstat -ano`（`netstat-3861.txt`）读到同一批 LISTENING 行 ⇒ 两侧读数互证。
- hold 结束（`sawStop=false`，满 90 s）后 `final.json` 记 `closedCount=2`；收尾检查 38600–38700 **0 个监听**、无残留探针进程。

---

## 4. 网络档位核验（R15 §3 接线）—— 本轮核心新发现 `[实测 + 读码]`

### 4.1 lane `network` 段原文（UTF-8 原样，`run-n{1,3}/.../sandbox-lane.json`）

**run-n1（默认档）**：

```json
"network": {
  "requested": "OBSERVED_ONLINE",
  "state": "not-implemented",
  "enforced": false,
  "verified": false,
  "reason": "档位 OBSERVED_ONLINE 未实现（WFP_TIER_NOT_IMPLEMENTED）：planOfflineRules: tier OBSERVED_ONLINE is not implemented — only OFFLINE is a hard block. …—— 该档位不作出阻断声明，因此仍允许执行，但绝不报告 enforced=true",
  "perOpAudit": false,
  "note": "逐条网络操作（connect/bind）的审计未实现；本字段只回答\"当前档位与是否真的强制\"。默认档 OBSERVED_ONLINE 下本机不安装任何真实 WFP 过滤器（R11 实测 netsh wfp 前后逐字节相同）。"
}
```

**run-n3（shell 行 OFFLINE 生效）**：

```json
"network": {
  "requested": "OFFLINE",
  "state": "refused",
  "enforced": false,
  "verified": false,
  "reason": "WFP_UNAVAILABLE: WFP 绑定表不可用（缺少 fwpmEngineOpen0, fwpmEngineClose0, fwpmSubLayerAdd0, fwpmFilterAdd0, fwpmFilterDeleteById0, fwpmSubLayerDeleteByKey0），无法调用 FwpmFilterAdd0 安装阻断过滤器 —— 拒绝声称网络已阻断（fail-closed）",
  "perOpAudit": false,
  "note": "…"
}
```

⇒ R15 §3 的四个字段（`requested/state/enforced/verified/reason`）**如实反映"未强制"**，没有伪造 `enforced=true`；
`state=refused` 时执行器按 `assertNetworkPolicyEnforceable()` fail-closed 拒绝命令（§4.3）。

### 4.2 三次档位注入矩阵（同一 profile、同一探针，只改注入点）`[实测]`

| 注入点 | 载体 | lane `network.requested` | lane `state` | 沙箱内 shell 命令 | 结论 |
|---|---|---|---|---|---|
| **A. `winstage-sandbox` 宿主行**（R15 文档推荐键位） | `SBX_PATCH=overlay-offline.yml` | **`OBSERVED_ONLINE`**（不是 OFFLINE） | `not-implemented` | **正常执行**（`staged\r16-n2-shell-attempt.txt` 38 B 落地） | ❌ **无效** |
| **B. `winstage-shell` 行** | `SBX_PATCH=overlay-offline-shell.yml` | **`OFFLINE`** | **`refused`** | **全部被拒**（3 次 `pwsh` 均 `COMMAND_FAILED`，无文件落地） | ✅ 有效 |
| **C. 环境变量** | `WINSTAGE_NETWORK_TIER=OFFLINE`（无 overlay） | **`OFFLINE`** | **`refused`** | **全部被拒** | ✅ 有效 |

A 与 B/C 的差异坐实了键位问题：**配置确实被 loader 组合进去了**（见 §4.3），但消费者读不到。

### 4.3 组合配置三份 dump（证明 overlay 本身生效）`[实测]`

| 证据文件 | 命令 | 关键读数 |
|---|---|---|
| `dump-default-config.txt` | `dsh --profile sbx --dump-default-config` | bundle 层：`winstage-sandbox` 行 config 含 `networkTier: OBSERVED_ONLINE`；**`winstage-shell` 行 config 只有 `workspaceRoot`** |
| `dump-config-baseline.txt` | `dsh --profile sbx --dump-config` | profile 覆盖层**整体替换**了宿主行 config ⇒ `networkTier` 键**被丢弃**（只剩 `enabled/workspaceRoot`） |
| `dump-config-offline-hostrow.txt` | `… --patch overlay-offline.yml --dump-config` | 宿主行 config **确实**含 `networkTier: OFFLINE`（Compare-Object 唯一差异） |
| `dump-config-offline-shellrow.txt` | `… --patch overlay-offline-shell.yml --dump-config` | **`winstage-shell` 行** config 含 `networkTier: OFFLINE` |

### 4.4 根因（可定位到文件/行）`[读码]`

| 位置 | 事实 |
|---|---|
| `dsh-plugin/cordis.patch.yml:139` | R15 把 `networkTier: OBSERVED_ONLINE` 写在 **`winstage-sandbox`**（宿主）行 |
| `%DSH_HOME%\profiles\sbx\cordis.patch.yml`（`id: winstage-sandbox`） | 覆盖层重述该行 config 但**不带** `networkTier` ⇒ 键被丢弃（bundle 注释 `cordis.patch.yml:137-138` 自己警告过这个坑） |
| `dsh-plugin/shell-executor.mjs:989` | `constructor(ctx, config)` —— `config` 是 **`winstage-shell` 行**的 config |
| `dsh-plugin/shell-executor.mjs:1067` | `this.networkTier = normalizeNetworkTier(stringOption(raw,'networkTier') ?? stringOption(process.env,'WINSTAGE_NETWORK_TIER'))` |
| 全仓 grep（判据） | `Select-String -Path dsh-plugin\*.mjs -Pattern networkTier` **只命中 `shell-executor.mjs`**（`:694/:705/:1067/:1624/:1707`），**`host-plugin.mjs` 0 命中** ⇒ 宿主行上的 `networkTier` 是**没有任何读者**的死键（进得了组合树，进不了执行器） |

⇒ **R15 的接线只打通了"环境变量"这一条入口；profile/文档推荐的宿主行键位是空操作。**
R14/R15 的验收读数恰好是**默认值** `OBSERVED_ONLINE`（= 代码默认），因此无法区分"键生效"与"键不存在"——
这是判定方法上的缺口（建议见缺陷 D5-R16-1）。**"修哪里才够用"的结论见 §4.6。**

### 4.5 OFFLINE 生效后的行为与可诊断性

- **fail-closed 正确**：n3/n4 的每一次 `pwsh` 都是 `status:"error"`、`result:"Error: COMMAND_FAILED: 命令失败。"`，
  工作区/暂存树里**没有** `r16-n2-shell-attempt.txt`、`r16-n2-listing.txt` ⇒ 没有任何命令被执行。
- **但模型可见的错误不含原因**：`stdout.ndjson` 里 3 次 `tool_result` 全是通用 `COMMAND_FAILED: 命令失败。`，
  没有 `SANDBOX_NETWORK_POLICY_UNENFORCED`、没有 reason；原因只落在 `sandbox-lane.json` 的 `network.reason`。
  模型在 n3 里只能猜"offline environment without a specific error code"（见 `run-n3/stdout.ndjson:12`）⇒ 缺陷 D5-R16-2。
- `ctx.fs`（`write` 工具）**不受该闸门影响**（`staged\r16-n2-fs-marker.txt` 28 B 正常暂存）⇒ 网络闸门只拦 shell 执行面。

### 4.6 修哪里才够用（结论：只改 bundle 不够，profile 覆盖层必须同时重述）

**实测事实（同一 profile、同一台机，只差组合层次）**：

| 层 / 命令 | `winstage-shell` 行 config 原文 | `winstage-sandbox`（宿主）行 config 原文 |
|---|---|---|
| bundle 层 `dsh --profile sbx --dump-default-config`（`dump-default-config.txt`） | `workspaceRoot: C:\Users\Administrator\Desktop\dsh-winstage-sandbox`（bundle 字面值） | `enabled: true` / `workspaceRoot: <字面值>` / `probeOnStart: true` / **`networkTier: OBSERVED_ONLINE`** |
| bundle+profile `dsh --profile sbx --dump-config`（`dump-config-baseline.txt`） | `workspaceRoot: !!js process.env.WINSTAGE_SBX_WORKSPACE ?? '…/ws-default'`（**profile 的值**） | `enabled: true` / `workspaceRoot: !!js …` / `probeOnStart: true`（**`networkTier` 消失**） |

⇒ 两处读数合起来证明：`profiles\sbx\cordis.patch.yml` **覆盖了 `winstage-shell` 行**，且补丁语义是**整行 config 整体替换**
（宿主行的 `networkTier: OBSERVED_ONLINE` 在组合树里被替换掉，就是同一语义的直接证据）。

**结论（可操作的判定规则）**：

1. **只改 `dsh-plugin/cordis.patch.yml`（bundle）不够** —— 若把 `networkTier` 加到 bundle 的 **`winstage-shell` 行**，
   凡**覆盖了该行的 profile**（含 `profiles\sbx`）都会在 profile 层把整行 config 换掉 ⇒ 键照样丢，`dump-config` 里看不到，lane 依旧 `OBSERVED_ONLINE`。
2. **必须同时**在 `%DSH_HOME%\profiles\sbx\cordis.patch.yml` 的 **`winstage-shell` 行重述 `networkTier`**（与该行已有的 `workspaceRoot` 一样逐键重述）。
   `profiles\sbx` 是 R10 配方里唯一的沙箱 profile，本轮所有 run 都走它，所以这条不是"可选优化"，是**生效前提**。
3. **替代方案**（可省掉 profile 重述，但改动面更大、需单独评估）：让 `shell-executor` **跨行回退**读宿主行键；或把 loader 的覆盖语义从"整体替换"改成"深合并"。
   若选跨行回退，本报告 §4.2 的注入 A（宿主行 overlay）应当从"无效"变为"生效"，可用 `.t\r16\network\fix-verify\run-fix-verify.cmd hostrow` 交叉验证。
4. **验收必须用非默认值**：只用 `OBSERVED_ONLINE`（= 代码默认）验收，**永远无法区分"键生效"与"键不存在"**（R14/R15 正是如此）。
   最小判据 = `dsh --profile sbx --dump-config`（**不加任何 overlay**）里 `winstage-shell` 行出现 `networkTier:`，
   再配一次"非默认档真的改变姿态"的 run。配方与机器判据见 `.t\r16\network\fix-verify\expectations.md`（`run-fix-verify.cmd full`）。

### 4.6.1 修复后结构性复验 `[实测]`（2026-10-11 18:2x，Lead 落修后由本域独立复跑）

| 检查 | 命令 | 读数 |
|---|---|---|
| 组合树（bundle+profile，**无 overlay**） | `dsh --profile sbx --dump-config` | 全 dump 里 `networkTier` **只出现 1 次**：**`winstage-shell` 行 = `OBSERVED_ONLINE`**；`winstage-sandbox`（宿主）行 = **ABSENT**；`winstage-fs` 行 = ABSENT |
| bundle 层 | `dsh --profile sbx --dump-default-config` | 同上（shell 行 `OBSERVED_ONLINE`、宿主行 ABSENT）⇒ 键确实从宿主行**搬到了 shell 行** |
| profile 覆盖层（只读） | `%DSH_HOME%\profiles\sbx\cordis.patch.yml` 的 `winstage-shell` 行 | 逐字含 `networkTier: OBSERVED_ONLINE` |
| 机器判据 caseC | `node fix-verify\check-fix-verify.mjs`（只查组合树） | **PASS**：`VERDICT=PASS hardFailures=[]`，exit 0 |
| 源码封印（附） | `node tools\baseline-sha256.mjs --check` | `基线一致：118 个受封印文件与 docs/源码基线.sha256 逐条相符`（exit 0） |

证据：`.t\r16\network\fix-verify\postfix\{dump-config-composed-postfix.txt, dump-default-config-postfix.txt, verdict.json, inspect-rows.mjs}`。

> 附注（供 Lead 判断，未计入缺陷）：`docs/源码基线.sha256` 的 118 条里 **0 条 `.yml`**（封印面为 `*.mjs` 等），
> 故本次修复所改的 `dsh-plugin/cordis.patch.yml` **本身不在封印内** —— `--check` 全绿**不能**证明该 yml 未漂移；
> 建议把 `dsh-plugin/cordis.patch.yml` 纳入封印面。
>
> **行为复验状态 = `not-run`**（等 Lead go：立刻跑 OFFLINE 会让其他域在飞的沙箱线程命令全被拒）。
> 配方已通过 `dry` + stub 冒烟 + checker 双向自测；Lead 追加的 **caseD（纯配置驱动端到端）**已实现并冒烟通过
> （临时改 `profiles/sbx` → 跑 → 逐字节还原 + sha256 双验证），见 `fix-verify\expectations.md` §7。

### 4.6.2 封印面补录的独立复验 `[实测]`（作者之外的人复核，2026-10-11 18:3x）

Lead 采纳 §4.6.1 附注后把 `dsh-plugin/*.yml` 加进 `tools/baseline-sha256.mjs` 的 `INCLUDED_GLOBS`（118 → **119** 条）。
本人**不引用 Lead 的中转读数**，用三条互相独立的路径复验：

| # | 复验手段 | 读数 | 判定 |
|---|---|---|---|
| 1 | 工具自跑 `node tools\baseline-sha256.mjs --check` | `基线一致：119 个受封印文件与 docs/源码基线.sha256 逐条相符`，**exit 0** | ✅ |
| 2 | **我自己的枚举 + 自己的 sha256**（只借用源码里的 scope 声明 `INCLUDED_GLOBS/ROOT_FILES/EXCLUDED_DIRS`，不调用工具的 `collectEntries`）与清单逐条比对 | 枚举 **119** 个文件：`missing_or_changed=0`、`manifest_extra=0`；分族计数 `src 25 / tests 46 / dsh-plugin·mjs 17 / dsh-plugin·yml 1 / tools 26 / 根 4` = 119 | ✅ |
| 3 | 与工具 `collectEntries()` 交叉对账 | 工具 119 条，**disagreements=0** | ✅ |
| 4 | 清单卫生 | 119 非空行、`malformed=0`、无 CRLF、无 BOM、单一结尾 LF、路径字典序 | ✅ |
| 5 | 新增族覆盖完整性 | `dsh-plugin/` 磁盘上 `.yml` 只有 1 个（`cordis.patch.yml`），**在册**；`Get-FileHash`（第三种独立路径）`c32a183ad7b163e15c614851136b9134184a3d478fef2f904fcaa41cdf3b7a24` == 清单行逐字 | ✅ |
| 6 | **负控：改门控必红**（**不修改任何在盘文件**，只在内存里篡改清单文本一位十六进制） | 我的独立比对与工具 `diffManifest()` **都且仅都**命中 `dsh-plugin/cordis.patch.yml`（`changed=[…（清单 032a183a…7a24 / 磁盘 c32a183a…7a24）]`） | ✅ |
| 7 | `--write` 等价性（**未执行 `--write`**，因为它会重写封印件、超出本域写作用域）：用我自己的枚举独立重渲染清单，与在盘文件**逐字节比对** | **byte_identical=true**（两侧 10 851 B，`first_difference_line=null`）⇒ 在盘清单恰是 `--write` 会产出的内容 | ✅ |
| 8 | 独立重跑 Lead 提到的两个套件 | `tests/baseline-integrity.mjs` → `RESULT: PASS checks=14 failures=0`（exit 0）；`tests/suite-wiring.mjs` → `RESULT: PASS checks=29 failures=0`（exit 0） | ✅ |

证据：`.t\r16\network\sealcheck\{check-stdout.txt, seal-audit.json, negative-control.json, manifest-tampered-in-memory.txt, write-equivalence.json, baseline-integrity.out.txt, suite-wiring.out.txt, seal-audit.mjs, seal-negative-control.mjs, seal-write-equivalence.mjs}`。

> 结论：**"改 `dsh-plugin/cordis.patch.yml` 必让基线变红"这条闭环成立**，且 119 条与磁盘**逐条一致**（三条独立路径互证）。
> 唯一未做的形态是"真改一次 yml 再跑 `--check` 看 exit 4"——那需要改动封印件（超出本域写作用域），
> 本轮以第 6 条的**内存篡改负控**替代，等价覆盖了"机制是否报警"这一点。

---

## 5. WFP：前后对照（证明"是否安装了真实过滤器"）`[实测]`

宿主未受限 pwsh（**管理员**）执行只读枚举：`netsh wfp show state file=…`、`netsh wfp show filters file=…`（均 `rc=0`）。
原 3.6 MB / 4.5 MB XML 已 gzip（roundtrip sha256 校验通过），清单见 `wfp/COMPRESS-MANIFEST.json`。

| 时点 | `<filterKey>` | `<subLayerKey>` | `<calloutKey>` | `winstage` 命中 | `dsh-` 命中 | filters XML sha256 |
|---|---|---|---|---|---|---|
| run 前 | **1486** | 1486 | 0 | **0** | **0** | `5405262E650D2AFD973E33A9FC87FAF13D19BDDFB62B2D4D3D158BF373434AD6` |
| run 后（4 run，含 2 次 OFFLINE 尝试） | **1486** | 1486 | 0 | **0** | **0** | `5405262E…34AD6`（**逐字节相同**） |

`[实测]` **filters XML 前后 sha256 完全一致** ⇒ 4 个沙箱线程（含 `networkTier=OFFLINE` 的两次）**没有安装、也没有拆除任何 WFP 对象**。
`state.xml` 前后不一致（4 523 581 B → 4 512 263 B），但按 R11 口径其差异为易变字段（`timeStamp`/`sessionKey`/`aleConnectedEndpoints`）；
本轮**未逐行 diff**（`not-run`），因为决定性判据是 filters 逐字节相同 + `winstage/dsh` 命中 0。
OFFLINE 两次都停在"绑定表不可用"（`fwpmEngineOpen0` 等 6 个函数缺席）⇒ **连 `FwpmEngineOpen0` 都没被调用**，谈不上改系统状态。

> 读数差异说明：R11 记录 `<filterKey>=1522`，本轮 **1486**。这是**宿主机自身 WFP 状态**在两天间的变化（Windows 服务/安全软件注册的过滤器数），
> 不归因于沙箱；本轮判据用的是"同一时点前后逐字节相同 + 关键词命中 0"。

---

## 6. 审计面（复现 R11 D5-N2 / D5-N3）`[实测]`

扫描器：`.t\r16\network\audit-scan.mjs` → `audit-scan-n{1..4}.json`。

| run | `audit.jsonl` 行数 | 严格 `JSON.parse` 失败 | 剥掉 `[winstage-audit][pid][tid] ` 前缀后失败 | `op` 直方图 | 网络类 op |
|---|---|---|---|---|---|
| n1 | 19 524 | **19 524 / 19 524（100%）** | 0 | `reg.open 10611 / reg.query 5894 / reg.create 2208 / file.open 810 / reg.set 1` | **0** |
| n2 | 10 141 | **10 141 / 10 141（100%）** | 0 | `reg.open 5546 / reg.query 2957 / reg.create 1224 / file.open 414` | **0** |
| n3 | **文件不存在**（shell 全被拒 ⇒ 无命令可审计） | — | — | — | — |
| n4 | **文件不存在**（同上） | — | — | — | — |

`sandbox-audit.json.summary`（n1）：`{"filesRead":67,"filesWritten":40,"filesDeleted":0,"filesMoved":0,"registryRead":728,"registryWritten":110,"filesWrittenInWorkspace":0,"filesWrittenOutside":40,…}`
——**只有文件/注册表计数，没有任何网络计数**。

⇒ **网络面既无强制、也无审计**：n1 在内核/用户态发了 3 次 HTTPS + 5 次 DNS + 2 次 TCP、并**监听并接受了 3 个外部连接**，
但审计面命中 **0**；`perOpAudit=false` 如实在 lane 里声明。D5-N2 / D5-N3 **完整复现**（见缺陷 D5-R16-3/4）。

---

## 7. 与 R11 同域结论的对照

| R11 结论 | 本轮读数 | 判定 |
|---|---|---|
| "出站全开放" | 沙箱内 npmmirror/tuna 全 200 且与宿主控制组逐字节一致；npmjs 两侧同 `ETIMEDOUT` | **复现** |
| "入站可绑且被同机进程访问" | loopback/wildcard 高位端口均可绑；宿主外部进程连入成功（200 + nonce 匹配 + peer 端口交叉一致）；LAN IP 语义与宿主一致 | **复现**（R11 用 18873/18895，本轮 38611/38612，独立端口与独立进程） |
| "真实 WFP 过滤器 0 个" | filters XML 前后**逐字节相同**（sha256 相等），`winstage`/`dsh-` 命中 0→0 | **复现** |
| `sandbox-lane.json` 有网络字段？R11：**零网络字段** | 本轮有 `network` 段（R15 新增），且默认档读数如实 | **已变化（R15 修复的一部分）** |
| D5-N2 审计面不记录网络活动 | n1 19 524 行 `op` 里网络类 **0**；`sandbox-audit.json` 无网络计数 | **复现（未修）** |
| D5-N3 `audit.jsonl` 非标准 JSONL | 严格解析 **19 524/19 524 失败**；剥前缀后 0 失败 | **复现（未修）** |
| D5-N5 "profile 面无 networkTier 入口、只能停在默认档" | 入口**已存在但接错行**：宿主行键无效；只有 shell 行/环境变量有效 | **部分修复 + 新缺陷 D5-R16-1** |
| D5-N1 `spawn`+`stdio:'pipe'` 崩溃 | 本轮探针**未用** pipe（全 in-process + 文件重定向） ⇒ `not-run`（未复测该边界） | **not-run** |

---

## 8. not-run / 诚实边界

1. **OFFLINE 的"真能挡住流量"仍未实测**（`not-run`）：执行器**没有 WFP 绑定表**，OFFLINE 只会走到 `state=refused` ⇒
   在任何配置下都不可能在本机装出真实过滤器；本轮也**未**手工改系统 WFP 状态（未授权、且属产品决策）。
   ⇒ OFFLINE 的**实际语义 = "拒绝执行一切命令"**，不是"允许命令但断网"。
2. **`state.xml` 前后差异未逐行归因**（`not-run`）：只用 filters 逐字节相同 + 关键词 0 命中作结论。
3. **特权端口 80 绑定 / LAN 绑定矩阵**未重测（`not-run`）：R11 已覆盖（`0.0.0.0:80` BIND OK）；本轮按任务要求选高位端口规避冲突。
4. **沙箱内直连/绑定 3080 未跑**（`not-run`，遵守"绝不动 3080"纪律）；只记录宿主 `127.0.0.1:3080` 始终 `LISTENING`（收尾 pid 9144）。
5. **`CONTROLLED_ONLINE` 档未测**（`not-run`）；**T1 档对照未测**（`not-run`）。
6. **沙箱主进程内 listener 由宿主连入**：本轮等价形式（沙箱内 node 进程内 `http.createServer`，PID 1648 = 沙箱 shell 的子进程）已实测成功，与 R11 §3.2 的 3080 保留项无关。
7. **`audit.jsonl` 的 `reg.set`** 是本轮新出现的 op（R11 只见到 4 种），未深查（`not-run`）。
8. 一处**取证编码坑（非产品缺陷）**：Windows PowerShell 5.1 的 `Get-Content` 默认按 ANSI 读文件，
   直接读 `sandbox-lane.json` 会把 UTF-8 中文显示成乱码（本报告 §4.1 的中文 reason 是用 `node` 以 UTF-8 读出的原文）；
   `sbx-extract.mjs` 生成的 `lane.txt` 同样含乱码 `conclusion=` 行（不影响 `LANE_OK`/`tierEffective` 判据）。

---

## 9. 复现命令

```powershell
# 0) 宿主控制组（未受限，WINSTAGE_SHELL=0）
node .t\r16\network\sbx-outbound.mjs .t\r16\network\host

# 1) WFP 前后只读快照（管理员）
cmd /c "netsh wfp show filters file=<abs>\wfp\pre-filters.xml"
cmd /c "netsh wfp show state   file=<abs>\wfp\pre-state.xml"
# … 跑完所有 run 后再取 post-*

# 2) run n1（默认档，出站+入站主测）
$env:SBX_STAGE_ROOT = "<abs>\run-n1\stage-root-r16n1"; Remove-Item Env:SBX_PATCH -EA 0
cmd /c "docs\archive\round10\env\scripts\sbx-thread.cmd <abs>\ws-n1 <abs>\prompt-n1.txt <abs>\run-n1 winstage"

# 3) 与 n1 并行：宿主未受限侧轮询 ready.json 并连入（外部探针）
powershell -NoProfile -File .t\r16\network\external-inbound.ps1 -RunOutDir <abs>\run-n1 -OutJson <abs>\external-n1.json -LanIp 10.81.126.50 -PollSeconds 420

# 4) 档位注入 A（宿主行，无效）/ B（shell 行，有效）/ C（环境变量，有效）
$env:SBX_PATCH = "<abs>\overlay-offline.yml";        # A → run-n2
$env:SBX_PATCH = "<abs>\overlay-offline-shell.yml";  # B → run-n3
$env:WINSTAGE_NETWORK_TIER = 'OFFLINE'               # C → run-n4（不带 SBX_PATCH）

# 5) 组合配置取证（证明 overlay 落到哪一行）
dsh --profile sbx --dump-default-config                       > .t\r16\network\dump-default-config.txt
dsh --profile sbx --dump-config                               > .t\r16\network\dump-config-baseline.txt
dsh --profile sbx --patch <abs>\overlay-offline.yml       --dump-config > .t\r16\network\dump-config-offline-hostrow.txt
dsh --profile sbx --patch <abs>\overlay-offline-shell.yml --dump-config > .t\r16\network\dump-config-offline-shellrow.txt

# 6) 判据核对 / 审计扫描
node .t\r16\network\verify-runs.mjs  .t\r16\network .t\r16\network\verify-runs.json
node .t\r16\network\audit-scan.mjs   .t\r16\network\run-n1 .t\r16\network\audit-scan-n1.json

# 7) 【Lead 落完 D5-R16-1 修复后】域内复验配方（2 run + 3 dump + 机器判据）
cmd /c ".t\r16\network\fix-verify\run-fix-verify.cmd" dry    # 前置检查 + 计划，不启动线程（已实跑通过）
cmd /c ".t\r16\network\fix-verify\run-fix-verify.cmd" full   # caseA(env) + caseB(shell 行 overlay) + caseC(dump) + verdict.json
```

---

## 10. 证据索引

| 路径 | 内容 |
|---|---|
| `verify-runs.json` / `verify-runs.mjs` | 四个 run 的 §1.1 四条判据机器核对结果 |
| `run-n1/` | **主测 run**：`stdout.ndjson`（62 行）、`stderr.txt`(0 B)、`lane.txt`、`workspace-inventory.txt`、`stage-root-r16n1/`（含 outbound/inbound 全套） |
| `run-n1/stage-root-r16n1/staged/network-n1/outbound.json` / `outbound-head.txt` | 沙箱内出站原始读数（DNS/HTTPS/TCP） |
| `run-n1/stage-root-r16n1/staged/network-n1/{ready.json,final.json,inbound-requests.jsonl,netstat-3861.txt,netstat-inner-after.txt}` | 沙箱内入站：绑定结果、hold 窗口、逐请求日志、监听归属 |
| `external-n1.json` / `external-inbound.ps1` | **外部（宿主未受限）连入**原始读数：ready 等待、4 次 HTTP、5 次 TCP、前后 netstat |
| `host/outbound.json` / `outbound-head.txt` | 宿主控制组出站（对照基线） |
| `run-n2/` | 档位注入 A（宿主行 OFFLINE）证据：命令照常执行 + `staged\r16-n2-shell-attempt.txt` |
| `run-n3/` | 档位注入 B（shell 行 OFFLINE）证据：`stdout.ndjson` 里 3 次 `COMMAND_FAILED` |
| `run-n4/` | 档位注入 C（环境变量 OFFLINE）证据 |
| `dump-default-config.txt` / `dump-config-baseline.txt` / `dump-config-offline-hostrow.txt` / `dump-config-offline-shellrow.txt` | 组合配置四份 dump（键位落点与"整体替换"坑的原始证据） |
| `overlay-offline.yml` / `overlay-offline-shell.yml` | 两个 `--patch` overlay（A/B） |
| `wfp/COMPRESS-MANIFEST.json` + `pre/post-{filters,state}.xml.gz` | WFP 前后只读全量枚举（gzip，roundtrip sha256 通过） |
| `audit-scan-n{1..4}.json` / `audit-scan.mjs` | `op` 直方图 + 网络类 op 命中 + `sandbox-audit` 摘要 + lane `network` 段 |
| `sbx-outbound.mjs` / `sbx-inbound.mjs` / `prompt-n1.txt` / `prompt-n2-offline.txt` | 沙箱内探针与 prompt（可复现） |
| `run-n*-launch.log` | `sbx-thread.cmd` 原始输出（`lane_ok=true`、exit=0） |
| `fix-verify/expectations.md` | **修复后复验配方与三条判据**（caseA=env / caseB=shell 行 overlay / caseC=组合配置 dump） |
| `fix-verify/run-fix-verify.cmd` | 复验启动器（`dry`/`full`/`baseline`/`hostrow`；不改源码与 profile） |
| `fix-verify/check-fix-verify.mjs` | 机器判据（判据①②③ + §1.1 + caseC），输出 `verdict.json`；已用三个自测夹具双向验证 |
| `fix-verify/overlay-tier.yml` / `overlay-tier-hostrow.yml` | 复验用 `--patch` overlay：shell 行（有效键位）/ 宿主行（用于区分跨行读修复） |
| `fix-verify/selfcheck/` | 检查器的自测夹具（`pos-env` / `pos-overlay` 应 PASS，`neg-hostrow` 应 FAIL） |

*本报告所有结论均带原始读数；未跑项一律 `not-run`，推断标 `[推断]`。缺陷见 `docs/round16/network-缺陷.md`。*
