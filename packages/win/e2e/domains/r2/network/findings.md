# WinStage 沙箱第二轮实测报告 —— network（网络服务与网络访问）域

- 线程：`network`（`_sandbox-tests\r2\network\`）
- 会话：`session-4c5d9889-7b7f-4132-931b-a26a3c1d924d`，DSH 文件策略 `danger-full-access`，审批 `never`
- 环境：Windows Server 2025 Datacenter 10.0.26100 · node v24.21.0 · curl 8.16.0 (Schannel) · **pwsh 7（本轮）**
- 身份：`WIN-DV9KRECLBVS\Administrator`（SID `…-500`）但 **`IsAdminRole=False` → UAC 过滤后的非提权令牌**
- 状态统计：**OK 5 / FINDING 3 / FAIL 2 / BLOCKED 0 / N-A 0**（NET-01~NET-10）
- 命令数：49 次 `pwsh` 调用（66 条记录），单条均带 `timeoutMs`；监听器测试后端口零残留

---

## 0. 一句话结论

**网络面被"零管控"，且这一点是"可证明"而不是"没观察到"**：WinStage shim 的 hook 目标表
（`shim/src/ws_hook.c` 的 `g_targets[]`）里**只有文件 / 进程创建 / 注册表 API，没有任何一个网络 API**，
固件层没有 WinStage 防火墙规则（344 条规则中 0 条）、没有 WFP 层、没有服务/驱动。
出站、DNS、UDP 全开，**没有网络命名空间隔离**，loopback 与 LAN 地址与宿主完全共享。

**但本轮真正的网络行为变化来自另一个变量**：进程令牌变成**非提权**。
它单独解释了本轮所有"网络异常"——curl/Invoke-WebRequest/所有 Schannel 客户端的 HTTPS 全部失败
（`SEC_E_NO_CREDENTIALS`）、ICMP 连 127.0.0.1 都被拒（`Access is denied`）、
`netsh wfp show state` / `Get-NetFirewallRule` 全部因缺提权而无法取证。
**这些都不是沙箱策略**，而是令牌权限。

---

## 1. 直接回答任务要求的核心问题

### 网络是否被隔离？**没有。零隔离，有硬证据。**

| 问题 | 答案 | 证据 |
|---|---|---|
| 网络命名空间隔离 | **不存在** | 沙箱内起的监听器出现在系统**全局**连接表：`TCP 0.0.0.0:28472 LISTENING <沙箱pid>`；该表同时含宿主自己的 `0.0.0.0:445`(PID 4)、`0.0.0.0:5985`(PID 4)、`127.0.0.1:3080`(DSH GUI) |
| 宿主能否把数据送进沙箱监听器 | **能，且三个地址都通** | `127.0.0.1:28472` / `192.168.20.58:28472`(LAN) / `169.254.83.107:28472`(Tailscale) 全部 `HTTP 200`，服务端记录到对应 HIT 与 peer 地址 |
| 沙箱能否访问宿主进程的监听器 | **能** | `GET http://127.0.0.1:3080/` → `HTTP 401 dsh web authentication required` |
| 沙箱是否看到宿主真实网络身份 | **是** | `ipconfig /all` + `route print -4`：默认网关 `192.168.20.1`、真实 loopback、真实网卡 `192.168.20.58` |

### 网络是否被管控/限速？**没有被管控；没有被限速。**

- 防火墙三 profile `EnableFirewall=1`、`DefaultInboundAction/OutboundAction` 均未配置（走 Windows 默认）；
  **344 条规则里没有一条**匹配 `WinStage|DSH|DeepSeek|node.exe|winstage-shim`，也没有一条涉及测试端口。
- 0.0.0.0 监听器在 LAN 地址收到连接 → **入站没有过滤**。
- 吞吐：npmmirror `typescript-5.5.4.tgz` **5.008 MB/s**、registry 索引 6.77 MB / **4.754 MB/s**、
  单次 52.9 MB 下载哈希精确一致。无平台期、无连接级上限 → **无人工限速**。

### 有代理 / TLS 中间人吗？**没有，两个独立方法互证。**

- `netsh winhttp show proxy` → `Direct access`；WinINET `ProxyEnable=0` 且其余全空；无任何 `*PROXY*` 环境变量。
- 证书链全部上溯公有根：example.com→Cloudflare→SSL.com→AAA；清华→YR2→ISRG Root X1；npmmirror→RapidSSL→DigiCert。
- **交叉验证**：52.9 MB 载荷 SHA256 与远端 `SHASUMS256.txt` 完全吻合 → 不存在解密改写型中间盒。

---

## 2. 本轮重点：WFP / 防火墙那一段的实测结论

**结论：网络面是"零管控"，而不是"实际执行了策略"。** 依据分四层，逐层收紧：

1. **`netsh wfp show state` 无法出证据（环境限制，非沙箱）**：`error=5 (ERROR_ACCESS_DENIED)`
   + `The requested operation requires elevation`；`netsh wfp show filters` 同样。
   这是**唯一"本该做而没做成"**的取证项，如实记录而不是推断掉。
2. **绕过提权限制从注册表读到真实策略**：三 profile `EnableFirewall=1`，
   `DefaultInboundAction=''`/`DefaultOutboundAction=''`（=未配置=BlockInbound/AllowOutbound 默认）。
3. **规则与安装面为零**：344 条规则中 WinStage/DSH 相关 **0** 条；测试端口 **0** 条；
   无 WinStage 服务、无驱动、`AppInit_DLLs` 空且 `LoadAppInit_DLLs=0`（不存在全局注入点）。
4. **源码级决定性证据**：`shim/src/ws_hook.c` 的 `g_targets[]` 完整列出
   `CreateFile*` `CreateDirectory*` `DeleteFile*` `MoveFile*` `RemoveDirectory*` `CopyFile*`
   `SetFileAttributes*` `GetFileAttributes*` `NtOpenFile` `NtSetInformationFile`
   `MoveFileWithProgressW` `CreateProcessW/AsUserW` + 23 个 `Reg*`。
   **网络 API 数量 = 0**（无 socket/connect/bind/send/recv/WSAStartup/WinHttp/WinINet/DnsQuery/Fwpm*）。
   `shim/src/` 只有 `ws_file.c / ws_reg.c / ws_proc.c / ws_stage.c / ws_mask.c / ws_regstore.c / ws_t3reg.c / ws_hook.c / ws_util.c / ws_entry.c`，**没有网络模块**。
   shim 日志里 `socket|tcp|udp|dns|proxy|filter` 只命中 2 行，且都是 `CreateDirectoryW` 路径记录。

> 注：`ws_reg.c` 注释里出现的 "Winsock/WSAStartup 10107" 是 shim 的**注册表 hook 返回错尺寸缓冲区**
> 导致 Winsock 目录读取失败（即 shim 在前一轮**造成过**一个网络相关 bug），属于注册表路径的缺陷，
> 不是网络拦截。

---

## 3. 逐 checkpoint

### NET-01 出站 HTTPS 三通道 —— **FAIL**（三通道结果分裂）
| 客户端 | 结果 |
|---|---|
| `node -e "fetch(...)"` | **200**，3171 B，`sha256=f410428039e2c922a14058df067a4482691c9304a5c01a75847f9f3f2d3307f6` |
| `curl.exe` | **exit 35**，`code=000`，0 B：`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)` |
| `Invoke-WebRequest` | 失败：`基础连接已经关闭: 接收时发生错误` |
| `.NET SslStream` / `HttpClient` | `No credentials are available in the security package` / 空错误 |

**内容完整性（关键）**：走 node/OpenSSL 下载 `node-v24.21.0-darwin-arm64.tar.gz`
= **52 909 993 B**，SHA256 `bed7eea5…f6057` **与远端 `SHASUMS256.txt` 完全一致 → MATCH=true**。
⇒ 报文在途未被改写；**坏的只是 Schannel 一族 TLS 客户端**。

**对照**：纯 HTTP 全部正常（`curl http://nodejs.org/...` → 200/3171 B；`http://example.com/` → 200/577 B）；
`node tls.connect` 拿到 `TLSv1.3 / TLS_AES_256_GCM_SHA384 / CN=*.nodejs.org`；裸 TCP 443 连接 247 ms 成功。
**回归**：上一轮同为 curl 8.16.0 (Schannel) 却 HTTPS 正常 —— 差异与提权状态一致。

**易用性**：报错只提 Windows 安全包，用户第一反应必然是"证书/站点坏了"。需要 4 条命令才能把
"Schannel 特有" 与 "网络本身没问题" 分开。建议文档加一行：*本会话 Schannel 不可用，
node/python/git 等自带 TLS 栈的客户端仍可用*。

### NET-02 DNS —— **OK**
`Resolve-DnsName` / `nslookup` / `node dns.promises.resolve4` 三家一致：
`nodejs.org` → `104.16.212.131, 104.16.213.131`（TTL 60，冷启 1117 ms / 热 8 ms）；
`example.com` → `104.20.23.154, 172.66.147.243` + 2×AAAA（121 ms）；解析器 = 网卡网关 `192.168.20.1`。
不存在域名报错可理解：`DNS name does not exist` / `DNS_ERROR_RCODE_NAME_ERROR`；
node 报 `code=ENOTFOUND msg=queryA ENOTFOUND …`。`-Server 8.8.8.8` 也成功。
**易用性**：顺。坑：`nslookup` 因网关反解失败打印 `Server: localhost`，像本地劫持。

### NET-03 TCP 连接面 —— **OK**
`example.com`：443 CONNECTED 265 ms、80 CONNECTED 178 ms、8080 CONNECTED 182 ms；
9000 / 25 静默超时 8 s（无 RST）。被拒端口的错误文本清晰：
`No connection could be made because the target machine actively refused it 127.0.0.1:59999`。
`Test-NetConnection` 同一次调用给出 `TcpTestSucceeded=True` 但 `PingSucceeded=False`。
**易用性**：顺。坑：9000/25 的超时与"沙箱拦我"不可区分（25 是常规 ISP 出站过滤）。

### NET-04 UDP 与 ICMP —— **FINDING**
**UDP 全开**：node dgram → `8.8.8.8:53` REPLY 44 B rcode=0 / 193 ms；网关 `192.168.20.1:53` REPLY 61 B / 15 ms。
**ICMP 被拒**：`ping` 对 8.8.8.8 / example.com / **127.0.0.1** 全部 `PING: transmit failed.`，100% 丢包；
`.NET Ping` 对三个目标（含 loopback）均返回 `Access is denied`；
`new Socket(Raw, Icmp)` **创建成功** ⇒ 拦的是 send 而非 socket 创建。
**loopback 同样失败 ⇒ 本地令牌限制，不是上游过滤，也不是 shim（shim 无网络 hook）。**
**易用性**：坑最大的一条 —— "连 127.0.0.1 都 100% 丢包"极像全网瘫痪。

### NET-05 监听与回连 —— **OK**
同一进程内 `127.0.0.1:28471` 与 `0.0.0.0:28472` 同时 bind 成功；
`netstat.exe -ano`（用**文件描述符 stdio** 起的孙进程，保证监听器当时活着）列出
`TCP 0.0.0.0:28472 … LISTENING 2760` 与 `TCP 127.0.0.1:28471 … LISTENING 2760`，共 8 行含客户端配对。
跑完每次 `GetActiveTcpListeners()` 对 28471/28472 **均为空 → 零残留**。
**易用性**：坑在于后台监听器**不跨工具调用存活**（退出码 124 / `dsh-stage: timeout after 120000ms`），
必须"起服务+探测+清理"写在**同一条 ≤120 s 命令**里；且抓孙进程输出必须用**文件描述符 stdio**，
走 PowerShell 管道会得到 `Access is denied`。

### NET-06 跨边界入站 —— **FINDING**
0.0.0.0 监听器在**三个地址**都收到完整 HTTP 响应：
`127.0.0.1:28472`→200/72 ms、`192.168.20.58:28472`→200/61 ms、`169.254.83.107:28472`→200/75 ms，
服务端记录到 peer `127.0.0.1:56887` / `192.168.20.58:56888` / `169.254.83.107:56889`。
反方向：沙箱访问宿主 DSH 进程的 `127.0.0.1:3080` → `HTTP 401`。
**诚实说明**：因 `WINSTAGE_SHIM_DISABLE=1` 本轮失效（见 NET-10），"宿主侧"指的是
**同一网络栈上真正独立的 OS 进程 + HOST 进程自己的 DSH GUI**，不是脱离 shim 的非受限进程。
**易用性**：最容易被自己骗的一条 —— 绑 `127.0.0.1` 看着像"被隔离"，下一个端口绑 `0.0.0.0` 就 LAN 可达。

### NET-07 代理与 TLS 中间人 —— **OK**
WinHTTP `Direct access (no proxy server)`；WinINET `ProxyEnable=0` 其余全空；
`.NET DefaultWebProxy` `IsBypassed=True`；子进程 `PROXY_ENV={}`（大小写都没有）。
证书链（node/OpenSSL，`authorized=true`、`authError=null`、TLSv1.3）全部公有根，无私有 CA。
**易用性**：需要 3 类命令；用户最容易跳过"证书链"这一步，而只有它能证伪透明中间盒。
另外本轮 `curl -v` 因 Schannel 故障**不能**用来读 issuer，必须改用 node —— 这个替代路径没有文档。

### NET-08 防火墙/WFP 策略 —— **FINDING**（详见 §2）
**易用性最差**，三个坑每一个都让第一版结论是**错的**：
1. `Get-NetFirewallRule -ErrorAction SilentlyContinue` 返回 **0**，看起来"这台机器没有防火墙规则"，
   但注册表里实际有 **344** 条 —— 访问被拒的错误被 `SilentlyContinue` 吃掉了；
2. netsh 走 PowerShell 管道报 `Access is denied`（像沙箱拦截），**不加管道**才显示真因 `requires elevation`；
3. `netsh wfp show state` 是枚举 WFP 过滤器的**权威手段**，却因缺提权**根本跑不了**。

### NET-09 可达性与吞吐 —— **OK**
见 §1。npmmirror 4.75–5.0 MB/s（`typescript-5.5.4.tgz` TTFB 38 ms）；
nodejs.org(headers, 10.3 MB) 1.586 MB/s；github.com 0.428 MB/s；清华 pypi 200 / TTFB 232 ms；
aliyun pypi **403**（站点拒绝，非沙箱）。
**易错点**：小请求测不出限速，必须做多 MB 持续传输 + 第二个源做对照。
附注：本轮 `npm view react version` 失败于 `EPERM …npm-cache\_cacache\tmp\***`
（**文件系统策略**，域 = 包管理器，不是网络）。

### NET-10 易用性 —— **FAIL**
- **`WINSTAGE_SHIM_DISABLE=1` 逃生开关对本轮文件写入失效**：开关变量确认已传入子进程，
  但加了它之后写 `C:\Windows\Temp`、workspace 根、`.dshstage` **仍然全部 EPERM**。
  只有 `stageRoot`（唯一 passthrough）下可写 ⇒ **协议 §3 依赖的 HOST 通道本轮不可用**。
- PowerShell 管道到原生命令**一律** `Access is denied`（`cmd.exe`/`node.exe`/`netstat.exe` 全部），
  不加管道即正常 ⇒ 极易误判为沙箱拒绝：
  - 孙进程用管道 stdio 时 `spawnSync` 返回 `status=null`、stdout/stderr 全空且**不报错**；
    改用**文件描述符 stdio** 才拿到完整输出（本轮最有价值的操作技巧）。
- PowerShell 往 workspace 路径写文件**直接挂起**（60 s 超时无输出），不是报错。
- 回答"是否隔离"需 4 类命令、"是否限速"需 2 类、"有无代理/MITM"需 3 类，
  且需要知道"令牌可能非提权 / 管道被禁 / WFP 需提权"等内部知识。

---

## 4. 易用性总表

| # | 步骤 | 几步 | 顺不顺 | 坑在哪 | 报错可理解 | 改进建议 |
|---|---|---|---|---|---|---|
| NET-01 | 测 HTTPS | 1×3 客户端 | **不顺** | Schannel 崩，报错指向安全包而非沙箱 | 否 | 文档声明"Schannel 不可用，用自带 TLS 栈的客户端" |
| NET-02 | DNS | 2 | 顺 | `nslookup` 显示 `Server: localhost` 像劫持 | 是 | 给"解析器=网关 ⇒ 未接管"判据 |
| NET-03 | TCP 面 | 1 | 顺 | 9000/25 静默超时像被拦 | 部分 | 文档："超时 ≠ 拦截，看有没有 RST" |
| NET-04 | UDP/ICMP | 2 | **不顺** | loopback 也 100% 丢包，像全网瘫痪 | 否 | 明说 ICMP 非提权不可用，改用 TCP 探测 |
| NET-05 | 起服务并自测 | 理想 1，实际多轮 | **不顺** | 监听器不跨调用存活；管道 stdio 拿不到输出 | 否（`status=null` 静默） | 给"单条命令内 起→探→清"模板 + fd-stdio 说明 |
| NET-06 | 判断可达边界 | 3 | 顺但易误判 | 绑 127.0.0.1 看着像隔离 | 是 | 明写"无网络命名空间隔离" |
| NET-07 | 代理/MITM | 3 类 | 一般 | 只有证书链能证伪中间盒；`curl -v` 不可用 | 部分 | 提供 `dsh net doctor` |
| NET-08 | 防火墙/WFP | 4 类 + 读源码 | **很不顺** | 三条命令各有一个"假结论"陷阱；WFP 权威命令跑不了 | **否** | 注册表读策略 + 打印 WFP 层名 + 令牌是否提权 |
| NET-09 | 吞吐 | 2 | 顺 | 小请求测不出限速 | 是 | 给标准吞吐探针，使跨轮可比 |
| NET-10 | 全流程 | — | **很不顺** | 逃生开关失效、管道被禁、写入挂起 | 否 | 修 HOST 通道；修管道错误文案 |

---

## 5. 给 DSH / 文档的 5 条建议（按优先级）

1. **【最高】把"令牌是否提权"打印进会话信息**。`IsAdminRole=False` 一个变量同时决定了
   HTTPS 是否可用、ICMP 是否可用、WFP/防火墙能否取证。不显示它，网络域结论会在不同轮次之间
   **静默翻转**，而使用者会归因给沙箱。
2. **修 `WINSTAGE_SHIM_DISABLE=1`**：它对文件写入已无效，导致协议的 HOST 取证通道失效。
   要么实现，要么在文档里改成明确的"不可用于文件写入"。
3. **新增 `dsh net doctor`**：一次输出 代理(env/WinHTTP/WinINET) + 从注册表读的防火墙 profile 动作 +
   WFP 层/子层名 + 令牌是否提权 + 用自带 TLS 栈的连通性探测 + 持续吞吐 +
   一句白话 `network isolation: NONE (loopback 与 LAN 地址与宿主共享)`。
4. **文档写明网络语义**：不做网络命名空间隔离；不提供出入站过滤、DNS 管控、按沙箱归因；
   出站默认不拦截；`0.0.0.0` 绑定即 LAN 暴露；低位端口可绑与否取决于是否提权；
   ICMP 在非提权会话不可用。
5. **修命令边界的错误文案**：管道被拒时说明"这是 stdio 管道限制，不是沙箱或网络拒绝"；
   孙进程用管道 stdio 时不要静默返回空输出。

---

## 6. 测试遗留物

- **监听器全部关闭**：每次跑完 `GetActiveTcpListeners()` 对 28471/28472 均为空，无残留进程占用端口。
- **未修改**防火墙规则 / 未做端口段扫描 / 未做 DoS / 未发垃圾流量；对外仅访问公共镜像与示例站。
- 测试写入的真实文件（host 通道，清理状态见下）：
  - `C:\Users\Administrator\Desktop\WinStageSandbox\_sandbox-tests\r2\network\`（本线程产出，保留）
  - `staged\` 根下：`r2hostprobe.js`、`r2writeprobe.js`、`r2writeprobe2.js`、`relwrite-*.txt`、
    `r2probe-result.txt`、`r2-*.txt`（netstat/curl/ping/ipconfig/route 输出）、`listener.log` ——
    均在会话 stageRoot 内（passthrough），**已保留作为原始证据**，未清理。
  - `C:\Windows\Temp\r2net-*.{log,xml,txt}` —— 多数因 EPERM 未创建成功；
    实际创建的 shim `selfcheck` 文件由 DSH 自身产生，非本线程。
- 未创建任何宿主侧 HKLM/HKCU 持久项，未新增服务/驱动/启动项。

---

## 7. 文件清单

- [`results.json`](results.json) —— 10 个 checkpoint 的机器可读结果（已校验可解析）
- [`findings.md`](findings.md) —— 本文件
- [`executions.log`](executions.log) —— 49 次调用 / 66 条命令 + 退出码 + 关键原始输出
- `evidence/`
  - [`net01-curl-schannel.txt`](evidence/net01-curl-schannel.txt) —— 三通道 HTTPS 分裂 + Schannel 原文
  - [`net01-content-integrity.txt`](evidence/net01-content-integrity.txt) —— 52.9 MB 与远端 SHASUMS 对账
  - [`net02-dns.txt`](evidence/net02-dns.txt) —— DNS 三工具 + NXDOMAIN
  - [`net03-04-tcp-udp-icmp.txt`](evidence/net03-04-tcp-udp-icmp.txt) —— TCP 面 / UDP / ICMP 拒绝
  - [`net05-06-isolation.txt`](evidence/net05-06-isolation.txt) —— 全局连接表 + 三地址入站 + 路由（隔离结论）
  - [`net07-proxy-tls.txt`](evidence/net07-proxy-tls.txt) —— 代理与证书链
  - [`net08-firewall-registry.txt`](evidence/net08-firewall-registry.txt) —— 注册表防火墙地真
  - [`net08-wfp-attempts.txt`](evidence/net08-wfp-attempts.txt) —— WFP 命令原文与限制
  - [`net08-shim-hook-targets.txt`](evidence/net08-shim-hook-targets.txt) —— **hook 目标表：网络 API = 0**
  - [`net08-elevation.txt`](evidence/net08-elevation.txt) —— 非提权令牌取证
  - [`net09-mirrors.txt`](evidence/net09-mirrors.txt) —— 镜像吞吐表
  - [`net10-usability-channels.txt`](evidence/net10-usability-channels.txt) —— 通道/管道/逃生开关失效
  - `net0506-*.js` / `net06-*.js` / `net0709.js` / `prober.js` —— 实验脚本（可复现）
