# 域五（network, task-5）· R11 网络服务与网络访问实测报告

> 执行侧：由常驻宿主 `.t\r11\bin\supervisor.mjs` 拉起的 **5 个带 WinStage 沙箱的嵌套 DSH 线程**（`--profile sbx`、`WINSTAGE_SHELL=1`、每 run 独立 stage root），run 内只跑本人预置的探针脚本。
> 复核侧：宿主未受限线程（本人，danger-full-access）：出站/DNS/tarball 控制组、绑定矩阵控制组、`host-serve`(18873)、方向 B 的连入与 **kill 测试**、WFP 前后全量枚举、监听面清点。
> 证据分层：`[实测]` = 有原始输出落盘；`not-run` = 未执行；`[推断]` = 由原始读数推导。
> 时间：2026-10-10 23:27–23:52（+08:00）。run 计数 5/5（配额用满）。

## 0. 直接回答 Lead 的关键问题

**问：是否有真实的网络策略 / WFP 过滤器在生效？还是出站全开、入站全开？**

**答：没有任何真实的 WFP 过滤器或网络策略在生效；出站全开、入站全开。** 依据（全部为本次实测读数，不是文档口径）：

| 判据 | 读数 | 证据 |
|---|---|---|
| 本机 WFP 过滤器集合（run 前/后各一次全量枚举） | `<filterKey>` **1522 → 1522**；`winstage` 命中 **0 → 0**；`dsh-` 命中 **0 → 0**；**两次 filters XML 逐字节相同**（sha256 `98cae41547bcffd47401b27bd15cfac40b78bf3d4b6b6d8d9527ff9e2f0750d3`） | `evidence/COMPRESS-MANIFEST.json`、`evidence/wfp-pre-filters.xml.gz`、`evidence/wfp-post-filters.xml.gz` |
| `sandbox-lane.json` 里的网络/策略字段 | **一个都没有**。全部 12 个键是执行档位与降级面：`kind/launchMode/tierEffective(TS)/fallbackReason/requestedTier(auto)/winStageEnabled/fallbackClass/degraded(false)/at/summary/seq/history` | `evidence/audit-scan-n{1,2,3,5}.json` → `sandbox-lane.json.topLevelKeys` |
| `audit.jsonl` 是否记录网络事件 | **不记录**。4 个完成的 run 的 `op` 直方图只有 `reg.open / reg.query / file.open / reg.create`，网络类 op 命中 **0** | `evidence/audit-scan-n1.json` 等 |
| `sandbox-audit.json` 摘要 | 只有 `filesRead/filesWritten/registryRead/registryWritten/...`，**没有任何网络计数** | `evidence/audit-scan-n*.json` |
| 出站行为 vs 宿主未受限控制组 | DNS/HTTPS/TCP/tarball **逐项一致**（见 §2） | `evidence/sbx-n*/summary.json` vs `evidence/host-out.json` |
| 入站绑定 | `127.0.0.1:0`、`0.0.0.0:0`、`::1:0`、**`0.0.0.0:80`** 全部 `BIND OK` + 自请求 200（见 §3） | `evidence/sbx-n1/summary.json` 等 |
| 跨进程可达 | 沙箱→宿主、宿主→沙箱 **双向都通**（见 §4） | `evidence/cross-match.json`、`evidence/host-kill-test.json` |

代码侧（`[读码]`，仅作对照，不作为结论来源）：`src/netpolicy.mjs` 的默认档是 `OBSERVED_ONLINE`，该档在 `src/wfp.mjs::planOfflineRules` 里直接抛 `WFP_TIER_NOT_IMPLEMENTED`，**不作任何阻断声明**；只有 `OFFLINE` 档才走 `installNetworkPolicy()`（真实 `FwpmFilterAdd0`）。`src/executor.mjs:1870` `const networkTier = options.networkTier ?? 'OBSERVED_ONLINE'`。**`dsh-plugin/*.mjs` 里 `networkTier|netpolicy|wfp|network` 命中 0** ⇒ profile 面没有把档位接到执行器的入口，实际线程永远停在默认档。`src/wfp.mjs` 顶部逐字声明"一个 `Fwpm*Add0` 都没调用过"。
⇒ 「代码里有策略层」与「运行期真的装了过滤器」之间**没有桥**，本次 WFP 前后逐字节相同就是这条的运行时证据。

## 1. 沙箱是否真的生效（4 条硬判据，逐 run）

| run | 内容 | exit | `stderr.txt` | `lane.txt` | 暂存面 | 真实 workspace | 生效 |
|---|---|---|---|---|---|---|---|
| d5-n1 | quick×2 + serve（serve 崩） | 0 | **0 B** | `LANE_OK=true` `tierEffective=TS` `degraded=false` | `staged\d5-n1\{result.json,steps.jsonl,lodash-4.17.21.tgz}` | 只有 `seed-net.txt`(4 B) | ✅ |
| d5-n2 | quick-repl×2 + serve（serve 崩） | 0 | **0 B** | 同上 | 同上 | 只有 `seed-net.txt` | ✅ |
| d5-n3 | quick + serve（serve 崩） | 0 | **0 B** | 同上 | `staged\d5-n3\{quick\*,serve\*}` | 只有 `seed-net.txt` | ✅ |
| d5-n4 | quick-repl + serve（serve 崩） | 0 | **0 B** | 同上 | `staged\d5-n4\{quick\*,serve\*}` | 只有 `seed-net.txt` | ✅ |
| d5-n5 | recycle（进程内 listener + 子进程 listener + 宿主 kill） | 0 | **0 B** | 同上 | `staged\d5-n5\{result.json,steps.jsonl,ready-18895.json,serve-log-18895.jsonl}` | 只有 `seed-net.txt` | ✅ |

机器读数（例，d5-n3）：`stderr.txt` 0 字节、`lane.txt` 含 `LANE_OK=true   (判据：degraded===false 且 tierEffective==='TS')`、`workspace-inventory.txt` 只有 `seed-net.txt 4 19b25856e1c1`。⇒ **沙箱真生效，且 5 个 run 全程零真实盘污染**（报告类产物全在暂存区）。

## 2. 出站实测（沙箱内 vs 宿主控制组）

### 2.1 DNS（`evidence/sbx-n3-quick/summary.json` ↔ `evidence/host-out.json`）

| 目标 | 沙箱内 | 宿主控制组 | 判定 |
|---|---|---|---|
| `registry.npmmirror.com` | `lookup 120.220.81.136`（42 ms）/ `resolve4 120.220.81.136` | `120.220.81.136`（113 ms） | 一致 |
| `pypi.tuna.tsinghua.edu.cn` | `101.6.15.130`（3 ms） | `101.6.15.130` | 一致 |
| `www.baidu.com` | `39.156.70.46 / 39.156.70.239` | 同 | 一致 |
| `example.com` | `104.20.23.154 / 172.66.147.243` | 同 | 一致 |
| `no-such-host-d5.invalid`（负控） | `ENOTFOUND: getaddrinfo ENOTFOUND no-such-host-d5.invalid`（36 ms） | 同（`ENOTFOUND`） | 一致 |

### 2.2 HTTPS（状态码 / 字节数 / 耗时 / TLS）

| 目标 | 沙箱内（n3） | 宿主控制组 |
|---|---|---|
| `GET https://registry.npmmirror.com/lodash` | **200 / 209 137 B / 341 ms / TLSv1.3 / `Tengine`** | 200 / 209 137 B / 735 ms / TLSv1.3 / `Tengine` |
| `GET https://pypi.tuna.tsinghua.edu.cn/simple/six/` | **200 / 11 565 B / 974 ms / TLSv1.3 / `nginx/1.22.1`** | 200 / 11 565 B / TLSv1.3 / `nginx/1.22.1` |
| `GET https://www.baidu.com/` | **200 / 29 506 B / 553 ms / TLSv1.2 / `BWS/1.1`** | 200 / 同字节数 |
| `GET https://example.com/` | **200 / 577 B / 1 548 ms / TLSv1.3 / `cloudflare`** | 200 / 577 B / TLSv1.3 / `cloudflare` |

### 2.3 裸 TCP

| 目标 | 沙箱内 | 宿主控制组 | 判定 |
|---|---|---|---|
| `registry.npmmirror.com:443` | `ok` 25–30 ms，`local 10.81.120.56:xxxxx` | `ok` 29–32 ms | 一致 |
| `1.1.1.1:443` | `ECONNREFUSED` 2 034–2 098 ms | `ECONNREFUSED` 2 022–2 071 ms | **逐项一致**（上游链路成因，与沙箱无关） |

### 2.4 tarball 下载 + sha512 与 registry 声明比对

沙箱内（`evidence/sbx-n3-quick/summary.json` → `tarball-download`）：

```json
{"status":200,"bytes":318961,"ms":1319,
 "sha512base64":"v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
 "sha256hex":"6a087ac9e5702a0c9d60fbcd48696012646ec8df1491dea472b150e79fcaf804",
 "redirects":["302 https://cdn.npmmirror.com/packages/lodash/4.17.21/lodash-4.17.21.tgz"],
 "declaredIntegrity":"sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==",
 "sha512MatchesRegistry":true}
```

- `sha512base64` 与 `registry.npmmirror.com/lodash/4.17.21` 声明的 `dist.integrity` **完全相等**；`sha256hex` 与沙箱暂存树 `blobs\6a\6a087ac9…` 一致（subresource 落盘同一份）。
- d5-n4（第二会话独立复现）与宿主控制组**同样为 true**。代理环境变量：三侧 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` **全为 null**。

## 3. 入站实测

### 3.1 绑定矩阵（沙箱内，共 8 个样本；n1×2 含 80、n3 含 80、n2×2、n4）

| kind | n1 (a) | n1 (b) / n3 | 自请求 | LAN IP 访问（10.81.120.56） |
|---|---|---|---|---|
| `loopback-ephemeral` `127.0.0.1:0` | BIND OK → 57535 | BIND OK → 62041 / 55929 | **200 + tokenMatch** | **`ECONNREFUSED` ≈2.0 s**（绑定范围被尊重） |
| `wildcard-ephemeral` `0.0.0.0:0` | BIND OK → 58894 | BIND OK → 55056 / 55948 | 200 + tokenMatch | **`ok`**（wildcard 生效） |
| `ipv6-loopback-ephemeral` `::1:0` | BIND OK → 58897（IPv6） | BIND OK → 55059 / 55951 | 200 + tokenMatch | — |
| **`wildcard-privileged-80` `0.0.0.0:80`** | **BIND OK** `boundPort=80` | **BIND OK** `boundPort=80` | **200 + tokenMatch** | **`ok`** |
| `loopback-fixed` `127.0.0.1:18891/18893` | BIND OK | BIND OK | 200 + tokenMatch | `ECONNREFUSED` ≈2.0 s |

⇒ 沙箱内**能绑特权端口 80 并从 LAN IP 被访问**（Windows 无特权端口门禁；宿主控制组 `evidence/host-bind.json` 同样成功），**没有任何端口绑定拦截或作用域改写**；绑定作用域语义与宿主一致（loopback 绑定在 LAN IP 上拒绝，wildcard 绑定可达）。

### 3.2 DSH GUI 端口对照

- 宿主侧对照（控制组）：`get-nettcpconnection -State Listen` 里 `127.0.0.1:3080` **LISTENING，OwningProcess=8960**（用户 GUI + Lead 会话），前后一致（`evidence/listen-baseline.txt`、`evidence/listen-final.txt`）。
- 沙箱侧对 3080 的绑定/连接探测：**`not-run`（遵守"绝不动 3080"的纪律，未从沙箱内向 3080 发起任何绑定或连接）**。
- `[实测]` **等价判据**：本次已证明沙箱与宿主**共用同一 TCP/端口命名空间** —— 沙箱内起的子进程监听 `127.0.0.1:18895`，宿主 `netstat -ano` 直接看到 `TCP 127.0.0.1:18895 0.0.0.0:0 LISTENING 10440` 并能连入（§4.2）；宿主侧 `127.0.0.1:18873` 服务也能被沙箱内进程连上（§4.1）。⇒ `[推断]` 3080 对沙箱内进程同样可见/可达。这**不替代**对 3080 的直接实测，按 3080 的纪律保留 `not-run`。

## 4. 跨进程可达性（隔离关键，双向）

### 4.1 方向 A：沙箱内进程 → 沙箱外（宿主）服务 `[实测]`

宿主侧 `host-serve.mjs` 绑 `127.0.0.1:18873`，token `D5-HOST-TOKEN-7b2e`，逐请求写 `evidence/host-18873.jsonl`（peer/ua/时间）。
沙箱内 `to-host` 读数（4 个 run，n1×2、n2×2、n3、n4 = **6 次连接**）全部 `200`，且 `hostTokenMatch=true`（对照 `evidence/sbx-n*/summary.json`）；负控 `127.0.0.1:18898`（未绑定）全为 `ECONNREFUSED`。

**交叉比对**（`evidence/cross-match.json`，按 peer 端口逐条对齐两边原始日志）：

```json
{"directionA":{"sandboxPeers":6,"matched":6,"unmatched":0,"hostLogEntries":7}}
```

沙箱侧记录的 peer（如 `127.0.0.1:58903 / 65176 / 52531 / 61719 / 55968 / 55958`）在宿主服务端日志里**逐条找到同一 peer 的记录**（`hostLogEntries=7` = 6 条沙箱 + 1 条本人宿主自检）。示例（`evidence/host-18873.jsonl`）：

```json
{"t":"2026-10-10T15:34:03.904Z","method":"GET","url":"/","peer":"127.0.0.1:58903","local":"127.0.0.1:18873","ua":"d5-sbx-probe"}
```

### 4.2 方向 B：宿主进程 → 沙箱内起的服务 `[实测 · 本轮新补齐]`

R10 该方向为 `not-run`；本轮补齐。d5-n5 在沙箱内 **spawn 一个独立 node 子进程**监听 `127.0.0.1:18895`（nonce `D5N5-child-server`），宿主侧 `host-kill-test.mjs` 从沙箱外连入：

宿主侧原始读数（`evidence/host-kill-test.json`）：

```json
{"connected":{"ok":true,"status":200,"nonceHeader":"D5N5-child-server","bodyPid":10440,
  "peerSeenByServer":"127.0.0.1:55911","local":"127.0.0.1:55911","ms":24,
  "netstatBefore":["TCP    127.0.0.1:18895        0.0.0.0:0              LISTENING       10440", ...],
  "listenerPidFromNetstat":10440,"waitedMs":43710}}
```

沙箱侧服务端日志 `evidence/sbx-n5/serve-log-18895.jsonl` **同一时刻记录了这次连接**：

```json
{"t":"2026-10-10T15:45:41.547Z","nonce":"D5N5-child-server","method":"GET","url":"/",
 "peer":"127.0.0.1:55911","local":"127.0.0.1:18895","ua":"d5-host-kill-test"}
```

⇒ 宿主记录的 `local=127.0.0.1:55911` 与沙箱服务端记录的 `peer=127.0.0.1:55911` **是同一连接**，且 ua 是宿主的 `d5-host-kill-test`。`cross-match.json` 的 `directionB.crossMatch.sandboxLogHasSamePeer = true`。**双向可达均成立**。

## 5. 端口回收与收尾清点

| 检查 | 读数 | 证据 |
|---|---|---|
| `server.close()` 后（**全新 socket**，`agent:false`） | **`ECONNREFUSED`**（沙箱内，3 ms） | `evidence/sbx-n5/summary.json` → `inproc-close-recycle.afterClose_freshSocket` |
| 宿主 `taskkill /F /PID 10440`（显式 kill 沙箱内子进程） | kill 前 `netstat` 有 `LISTENING 10440`，kill 后 **`netstat` 无 LISTENING 行**；宿主再连 **`ECONNREFUSED`** | `evidence/host-kill-test.json` → `after-kill` |
| 沙箱内再复核 kill 后端口 | `ECONNREFUSED`；子进程 `exitCode=1`（被强杀） | `evidence/sbx-n5/summary.json` → `child-hold-and-kill` |
| 收尾监听清点（18800–18999） | **0 个 listener** | `evidence/listen-final.txt` |
| 收尾残留进程 | 0 个本人探针进程；`3080` 仍 `LISTENING`（pid 8960，GUI 存活） | 同上 + 本文档执行记录 |
| 沙箱内新增监听是否残留 | 无：n5 的 listener 由宿主 kill 后消失；n1–n4 的 serve 崩溃前未留下监听 | `evidence/host-cross-probe.json`（`timeout-18881/18882/18883/18884`，全程无 `found-*`） |

> 一处**探针伪影**必须说明：n1–n4 的 `bind-matrix.afterClose` 记录的是 `ECONNRESET`（不是 `ECONNREFUSED`）。宿主侧对照 `evidence/host-recycle-control.json` 在同样"close 后用默认 agent 复连"下得到的是 `ECONNREFUSED`（`fresh` 与 `pooled` 都是），**没有复现 ECONNRESET** ⇒ 成因未定；本轮以 **d5-n5 的全新 socket 读数为准**（`ECONNREFUSED`），`ECONNRESET` 不作为任何沙箱结论。

## 6. 策略层 vs 真实状态（原始字段）

### 6.1 `sandbox-lane.json` 全文（`evidence/audit-scan-n3.json`，851 B 原样）

```json
{"kind":"winstage-sandbox-lane","launchMode":"shim","tierEffective":"TS","fallbackReason":null,
 "requestedTier":"auto","winStageEnabled":true,"fallbackClass":"none","degraded":false,
 "at":"2026-10-10T15:41:22.265Z","summary":{...},"seq":12,
 "history":{"commandSeq":12,"shimCount":12,"degradeCount":0,"firstDegrade":null,"rootLoss":null}}
```

键名做 `net|sock|wfp|policy|tier|proxy|port|dns|http` 匹配，只命中 `tierEffective` / `requestedTier`（**执行档位**，不是网络档位）。**没有 `networkTier` / `enforced` / `wfp*` 任何字段。**

### 6.2 `audit.jsonl`（行前缀 `[winstage-audit][pid][tid] `，JSON 在其后）

| run | 行数 | `op` 直方图 | 网络类 op |
|---|---|---|---|
| n1 | 46 403 | `reg.open 29581 / reg.query 13108 / file.open 1903 / reg.create 1811` | **0** |
| n2 | 24 024 | `reg.open 15137 / reg.query 6970 / file.open 1027 / reg.create 890` | **0** |
| n3 | 6 549 | `reg.open 4061 / reg.query 1968 / file.open 294 / reg.create 226` | **0** |
| n5 | 17 909 | `reg.open 11450 / reg.query 5021 / file.open 729 / reg.create 709` | **0** |

`malformed=0`（解析器需先剥掉 `[...]` 前缀，见缺陷 D5-N3）。⇒ 沙箱内发了多少次 DNS/HTTPS/TCP、监听哪些端口，**审计面完全不可见**。

### 6.3 `sandbox-audit.json`

`summary` 例（n5）：`{"filesRead":67,"filesWritten":33,"filesDeleted":0,"filesMoved":0,"registryRead":751,"registryWritten":28,"filesWrittenInWorkspace":0,"filesWrittenOutside":33,"filesDeletedInWorkspace":0}` —— 只有文件/注册表计数，**无网络计数**。

### 6.4 WFP 左右对照（宿主未受限侧，`netsh wfp show filters/state`）

| 时点 | `<filterKey>` | `winstage` | `dsh-` | filters sha256 |
|---|---|---|---|---|
| run 前（23:30） | 1522 | **0** | **0** | `98cae415…0750d3` |
| run 后（23:47） | 1522 | **0** | **0** | `98cae415…0750d3`（**逐字节相同**） |

`state.xml` 两次不一致，但 diff 的 1218 行**全部是易变字段**（`timeStamp`、`sessionKey`/`processId`、`aleConnectedEndpoints` 数量与 endpointId）——**没有任何 WinStage 子层/过滤器对象**。⇒ 5 个沙箱线程**没有安装、也没有拆除任何 WFP 对象**。

## 7. 缺陷 / 发现

见 `docs/round11/network-缺陷.md`。摘要：
1. **D5-N1（中）** 沙箱内 `child_process.spawn` + `stdio:'pipe'` 触发 `read ENOTCONN` 的 Socket `error`，**未捕获即整进程崩溃**（n3/n4 serve 因此只写完 `serve-ready` 就死）。`stdio:'ignore'` 正常。
2. **D5-N2（中）** 审计面不记录任何网络活动（§6.2/6.3）：网络面既无强制、也无审计。
3. **D5-N3（低）** `audit.jsonl` 每行带 `[winstage-audit][pid][tid] ` 前缀，标准 JSONL 解析器直接解析会 100% 失败（我方首个扫描器 42772/42772 malformed）。
4. **D5-N4（低）** `review.json` 的 `counts.net` 是"净变更行数"（42），做网络关键词扫描会假阳性；同理全文搜 `network|tcp|http` 会命中键名。
5. **D5-N5（中）** `dsh-plugin/*.mjs` 无 `networkTier` 入口 ⇒ profile 面无法把网络档位接到执行器；实际线程只能停在默认 `OBSERVED_ONLINE`（`not-implemented`，不作阻断声明）。真实 OFFLINE 强制在本机**当前不可验证**。

## 8. not-run / 诚实边界

1. **`OFFLINE` 档的"真能挡住流量"仍未实测**（`not-run`）：装 `FwpmFilterAdd0` 是系统级状态变更，本轮未授权、也未做；本轮只回答了"运行期真实状态是零过滤器"。
2. **沙箱内直连/绑定 3080 未跑**（纪律要求不动 3080），仅以 §3.2 的命名空间共用证据作为等价推断。
3. **`ECONNRESET`（n1–n4 afterClose）成因未定**：宿主对照未复现，已按探针差异处理，不作沙箱结论；结论只取 n5 的 `ECONNREFUSED`。
4. **方向 B 只覆盖"沙箱内 spawn 的子进程"**：进程内 listener 承载方向 B 的尝试在 n3/n4 因 D5-N1 崩溃而失败；n5 的等价形式（子进程 + stdio:'ignore'）成功。**"宿主连入沙箱主进程内 listener"未单独跑**（`not-run`）。
5. **T1（去 shim）档对照未跑**；`WINSTAGE_TIER=T1` 下网络行为差异未定论。
6. **WFP `state.xml` 两次不一致**已逐行 diff 并归因为易变字段，但未对每个差异字段逐一列举（只给了前 6 例）。
7. n3/n4 的 `serve` 崩溃使 `host-cross-probe.mjs`（监视 18881–18884）以 `timeout-*` 结束，其证据保留为"那段时间确实没有监听"的原始记录；另有一份**本人宿主侧 selftest 造成的污染证据**已改名归档：`evidence/host-cross-probe-POLLUTED-selftest.*`（说明见缺陷 D5-N6）。

## 9. 复现命令

```powershell
# 0) 宿主侧 WFP 前后快照（只读）
cmd /c ".t\r11\network\wfp-snapshot.cmd pre"
...
cmd /c ".t\r11\network\wfp-snapshot.cmd post"

# 1) 宿主控制组
node .t\r11\network\host-out.mjs .t\r11\network\evidence\host-out.json host
node .t\r11\network\host-bind.mjs .t\r11\network\evidence\host-bind.json host 10.81.120.56
node .t\r11\network\host-recycle-control.mjs .t\r11\network\evidence\host-recycle-control.json

# 2) 宿主侧服务（方向 A 的对端）——后台作业
node .t\r11\network\host-serve.mjs 18873 127.0.0.1 D5-HOST-TOKEN-7b2e .t\r11\network\evidence\host-18873.jsonl .t\r11\network\evidence\host-18873.pid

# 3) 嵌套沙箱线程（每 run 一个 job；run 内命令见对应 prompt-n*.txt）
cmd /c "node .t\r11\bin\submit-job.mjs d5-n5 .t\r11\network\ws-n5 .t\r11\network\prompt-n5.txt .t\r11\network\run-n5\out winstage > .t\r11\network\submit-n5.log 2>&1"
cmd /c "node .t\r11\bin\wait-job.mjs d5-n5 900 > .t\r11\network\wait-n5.log 2>&1"
# run 内：node <repo>\.t\r11\network\sbx-recycle.mjs "$env:WINSTAGE_STAGE_ROOT\d5-n5" D5N5 70

# 4) 方向 B：宿主侧连入 + kill 测试（与 run n5 并行）
node .t\r11\network\host-kill-test.mjs .t\r11\network\evidence\host-kill-test.json 18895 D5N5-child-server 300

# 5) 交叉比对 / 审计扫描 / 证据抽取
node .t\r11\network\cross-match.mjs .t\r11\network\evidence\cross-match.json
node .t\r11\network\audit-scan.mjs .t\r11\network\run-n5\out\stage-root .t\r11\network\evidence\audit-scan-n5.json
node .t\r11\network\extract-run.mjs .t\r11\network\run-n5\out d5-n5 .t\r11\network\evidence\sbx-n5
```

## 10. 证据索引

| 路径 | 内容 |
|---|---|
| `evidence/COMPRESS-MANIFEST.json` | WFP 4 份 XML 的 gzip 清单（压前/roundtrip sha256、filterKey 数、winstage/dsh 命中数、pre-post filters 逐字节相同） |
| `evidence/wfp-pre-filters.xml.gz` / `wfp-post-filters.xml.gz` / `wfp-pre-state.xml.gz` / `wfp-post-state.xml.gz` | 只读全量枚举原件（已 gzip，2.7 MB 全树） |
| `evidence/host-out.json` / `host-out.stdout.txt` | 宿主出站控制组（DNS/HTTPS/TCP/tarball） |
| `evidence/host-bind.json` | 宿主绑定矩阵控制组（含 `0.0.0.0:80`、LAN IP 负控、close 后回收） |
| `evidence/host-18873.jsonl` / `host-18873.pid` | 宿主侧方向 A 服务端逐请求日志（含 peer/ua） |
| `evidence/host-kill-test.json` / `.stdout.txt` | **方向 B** 宿主连入沙箱服务 + `taskkill` + 监听表前后 |
| `evidence/host-cross-probe.json` / `.stdout.txt` | 18881–18884 监视器（n3/n4 serve 崩溃 ⇒ 全程 `timeout-*`，这就是"无监听"的原始记录） |
| `evidence/host-cross-probe-POLLUTED-selftest.*` | 本人宿主 selftest 污染的那一份（改名归档，勿引用为沙箱证据） |
| `evidence/cross-match.json` / `.stdout.txt` | 方向 A 6/6 peer 交叉匹配 + 方向 B 同 peer 交叉匹配 |
| `evidence/host-recycle-control.json` | close 后 fresh/pooled 对照（成因判定用） |
| `evidence/sbx-n1/…sbx-n5/` | 每个 run 的沙箱内原始产物（`result.json`/`steps.jsonl`/`summary.json`/tarball/ready/serve-log） |
| `evidence/audit-scan-n{1,2,3,5}.json` | `sandbox-lane.json` 网络字段扫描 + `audit.jsonl` op 直方图 + `sandbox-audit.json` 摘要 |
| `evidence/lan-ips.txt` / `listen-baseline.txt` / `listen-final.txt` | LAN IP、宿主监听面前后清点 |
| `run-n{1..5}/out/` | 嵌套线程证据：`stdout.ndjson`（含 final 原文）、`stderr.txt`（0 B）、`exitcode.txt`、`lane.txt`、`workspace-inventory.txt`、`stage-root/` |
| `.t/r11/network/*.mjs` / `*.cmd` / `prompt-n*.txt` | 全部探针脚本与 prompt（可复现） |

*本报告所有结论均带原始读数；未跑项一律 `not-run`，推断标 `[推断]`。*
