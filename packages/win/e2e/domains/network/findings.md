# WinStage 沙箱测试报告 —— 网络服务与网络访问域（network-tester）

- 测试线程：`network-tester`（`_sandbox-tests\network\`）
- 会话：`session-eb7c901d-97ed-4f83-9096-33c97138c361`，文件策略 `workspace-write`
- 环境：Windows 10.0.26100（Windows PowerShell **5.1** — 不是 pwsh 7）/ node v24.21.0 / curl 8.16.0 (Schannel)
- 身份：`WIN-DV9KRECLBVS\Administrator`，**isAdmin=True**
- 网络：唯一有效网卡 = Hyper-V vEthernet（Intel Wireless-AC 9462 Virtual Switch），`192.168.20.58/24`，网关/DNS = `192.168.20.1`；另有未激活的 Tailscale 接口
- 状态计数：**OK 6 / FINDING 2 / FAIL 1 / BLOCKED 0 / N-A 0**（共 9 项：NET-01~NET-08 + NET-09 基础设施）

---

## 0. 一句话结论

**WinStage 沙箱在网络维度上等于「没有沙箱」**：出站全协议完全开放（HTTP/HTTPS/TCP/UDP，含境外与境外 UDP），无代理、无 TLS 中间人，DNS 走系统解析器；本地监听不受限（可绑 `0.0.0.0:80/443`，因为会话已提权）；**不做网络命名空间隔离**，loopback 与宿主共享。本次没发现「沙箱该拦而没拦」的网络类安全问题，但也**没有任何网络隔离保护**——需要隔离时必须靠用户自己只绑 `127.0.0.1` 或依赖 Windows 防火墙。

---

## 1. 两类结论的明确区分（Lead 要求的关键项）

### (a) 沙箱造成的限制 → 网络功能本身：**无**；沙箱基础设施：**有，且严重**

**网络功能层面没有任何沙箱限制**（这是结论，不是推测）：

| 能力 | 结果 | 证据 |
|---|---|---|
| 出站 HTTP/HTTPS | 5/5 返回 200 | NET-02 |
| 出站 TCP 任意端口 | 443/80/53 全部 CONNECTED | NET-06 |
| 出站 UDP | 内网 + 境外 8.8.8.8:53 均收到应答 | NET-06 |
| DNS | 4/4 解析成功，走 192.168.20.1 | NET-01 |
| 代理 | 无任何代理/ PAC / WinHTTP 代理 | NET-03 |
| 本地监听 | 高位端口 bind 成功，跨进程可 GET | NET-04 |
| 低位端口 | 80/443 绑定成功（**因提权**，非沙箱放行） | NET-05 |
| 命名空间隔离 | **不存在** | NET-07 |

**沙箱基础设施层面确实有阻塞性缺陷**（NET-09，状态 FAIL），这些才是测试过程中真正拖慢进度的东西：

1. **`STAGING_WRITE_UNVERIFIED` 执行门随机拒绝命令**（≥7 次）。完全相同的一条命令，第一次被拒、重试 1~2 次就通过。报错原文：
   > the confined execution backend could not run the command: STAGING_WRITE_UNVERIFIED: refusing to run: the staged root is not verified writable by the identity this run uses (measured as not writable). reason: 1 staging-write check(s) failed: outside-write-staged-not-real=fail (child-reported-ok=false real-disk-has-file=false staged=…). If the command ran, writes outside the workspace would NOT be captured into staging while the caller still sees exit code 0 — that is the silent-degradation shape this gate exists to prevent.

   探测子进程退出码变体：`exit=2` 与 `exit=3762504530`(0xE0434352，CLR 异常)。
2. **staging 层 EBUSY —— 路径里保留未展开的 `%ALLUSERSPROFILE%` 字面量**：
   `Error: EBUSY: resource busy or locked, open '…\.dshstage\sessions\session-eb7c901d-…\staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive\938209ac-…'`
   子进程在 WER ReportArchive 下建目录时，宿主侧 staging 写入抛 EBUSY，整条命令 **exit 1 且零输出**。这是最恶劣的形态：失败但没有任何可读错误。
3. **`Start-Process … -RedirectStandardOutput <工作区路径>` 直接让命令 exit 1 零输出**；去掉重定向后同样场景完全正常。
4. **PS 内 `Set-Content` 紧跟 `Get-Content` 同路径返回空**（0 字节），但 STAGE 通道读同一文件内容完整（例：`net03-proxy.txt` 673 字节 / 23 行）。
5. **沙箱内进程写自己的工作区目录不会落到宿主真实磁盘**，只进 staging；harness 的 `read`/`glob` 工具看真实磁盘 → 看不到。必须走 `.dshstage\…\staged\fs\C\…` 才是地面真值。
6. `pwsh` 不在 PATH（实际宿主是 `Windows PowerShell 5.1`）。
7. 长命令 + 网络访问时多次工具侧 60s 超时 / 整条命令挂起。

### (b) 本机网络环境 / GFW 造成的不可达 → **本次为零**

- **境外站点全部可达**：`example.com` HTTP 200，TTFB 1.420s，解析到 Cloudflare `172.66.147.243`；`github.com` HTTP 200，TTFB 0.485s，下载 576 649 B，解析到 `20.205.243.166`。
- **境外 UDP 也可达**：`8.8.8.8:53` 收到 65 字节应答，241ms。
- 因此**本机不存在 GFW 级别的境外阻断**，本次测试中没有任何「境外不可达」需要归因给网络环境。

> 但这一条必须写进文档：**如果换到一台真正被 GFW 拦截的机器上跑同样的脚本，`example.com`/`github.com` 会超时**，而沙箱的报错里没有任何「这是网络环境、不是沙箱」的提示，极易被误报为沙箱缺陷。建议把「境外不可达 = 环境事实」写进 DSH 网络文档，并要求先用国内站点（百度/清华/npmmirror）做基线对照。

---

## 2. 逐 checkpoint 结论

### NET-01 DNS —— **OK**
4/4 解析成功，全部走本机唯一 DNS `192.168.20.1`，`hosts` 文件无生效条目，无 `127.0.0.1` 本地解析器劫持。

| 域名 | 结果 | 首次解析耗时 |
|---|---|---|
| www.baidu.com | CNAME `www.a.shifen.com` → `110.242.69.21`, `110.242.70.57` | 895 ms |
| registry.npmmirror.com | CNAME `*.w.cdngslb.com` → `123.6.194.34`（另见 `119.188.172.139`） | 31 ms |
| pypi.tuna.tsinghua.edu.cn | CNAME `mirrors.tuna…` → `bfdmirrors.s.tuna…` → `101.6.15.130` | 6 ms |
| github.com | `20.205.243.166` | 7 ms |

`nslookup` 与 `Resolve-DnsName` 结果一致（含 IPv6 AAAA）。**易错点**：`nslookup` 对 `192.168.20.1` 反解失败时把 Server 打印成 `localhost` / `bogon`，容易被误读成「DNS 被本地劫持」。

### NET-02 出站 HTTPS —— **OK**

| URL | code | TTFB | total | bytes | 远端 |
|---|---|---|---|---|---|
| https://www.baidu.com/ | 200 | 0.247 s | 0.249 s | 29 506 | 110.242.70.57:443 |
| https://pypi.tuna.tsinghua.edu.cn/simple/ | 200 | 0.960 s | 0.960 s | 0（被自身 1MB 上限截断，curl exit=63） | 101.6.15.130:443 |
| https://registry.npmmirror.com/ | 200 | 1.959 s | 1.959 s | 1 287 | 116.117.158.52:443 |
| https://example.com/（境外） | 200 | 1.420 s | 1.420 s | 577 | 172.66.147.243:443 |
| https://github.com/（境外） | 200 | 0.485 s | 0.978 s | 576 649 | 20.205.243.166:443 |

**易错点**：`curl --max-filesize` 触发时退出码 63，只看退出码会误判「站点打不开」——必须同时看 `-w` 里的 `http_code`。

### NET-03 代理 / 证书 —— **OK（未被劫持）**
- `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/`ALL_PROXY`（含小写）全部 unset；`cmd /c set | findstr proxy` 为空。
- `netsh winhttp show proxy` → `Direct access (no proxy server)`。
- `HKCU\…\Internet Settings`：`ProxyEnable=0`，`ProxyServer`/`ProxyOverride`/`AutoConfigURL`/`AutoDetect` 全空。
- TLS 证书链全部上溯公有根，`CHAIN_BUILD_OK=True`，**无自签/私有 CA**：

| 主机 | TLS | leaf issuer | 链根 |
|---|---|---|---|
| www.baidu.com | Tls12 | GlobalSign RSA OV SSL CA 2018 | GlobalSign Root CA - R3 |
| pypi.tuna.tsinghua.edu.cn | Tls13 | Let's Encrypt YR2 | — |
| registry.npmmirror.com | Tls13 | RapidSSL TLS RSA CA G1 (DigiCert) | — |
| example.com | Tls13 | Cloudflare TLS Issuing ECC CA 3 (SSL.com) | SSL.com TLS ECC Root CA 2022 |
| github.com | Tls13 | Sectigo Public Server Authentication CA DV E36 | Sectigo PSS Root E46 |

`curl -v` 确认从 `192.168.20.58:56171` 直连 `110.242.70.57:443`，ALPN `http/1.1`，无中间跳。

### NET-04 本地回环监听 —— **OK**
- bind 成功：`node http.createServer().listen(28471,'127.0.0.1')`，pid=896。
- `netstat -ano` → `TCP 127.0.0.1:28471 0.0.0.0:0 LISTENING 896` ⇒ **绑的是 loopback，不是 `0.0.0.0`**。
- **全新进程**（与起服务的进程无亲缘关系）`curl.exe http://127.0.0.1:28471/` → **HTTP 200**，246 B 固定 JSON；另一个全新进程 `cmd /c curl … /health` → HTTP 200，252 B。
- LAN 网卡地址 `http://192.168.20.58:28471/` → curl (7) 连接失败 ⇒ 未对外暴露。
- **测后已关闭**：`Stop-Process -Id 896 -Force` → `still_alive=False`，LISTENING 行消失，只剩两条 `TIME_WAIT`。

### NET-05 端口与防火墙 —— **OK（附解读警告）**
- 重复 bind 正常拒绝：`EADDRINUSE`（errno -4091），`address already in use 127.0.0.1:28472`。
- 低位端口 **未被拒**：`0.0.0.0:80`、`0.0.0.0:443`、`0.0.0.0:8080` 全部 bind OK。
  **⚠ 原因是本会话 `isAdmin=True`（Windows 低端口限制只对非提权用户生效），不是沙箱放行。**
- 防火墙（**只读查询，未做任何修改**）：Domain/Private/Public 三 profile 均 `State=ON`，策略均 `BlockInbound,AllowOutbound`；当前 profile `LocalFirewallRules=N/A (GPO-store only)`。
- 沙箱本身对 bind 无任何限制。

### NET-06 出站非 HTTP —— **OK**
`github.com:443` CONNECTED 134 ms（本地 `192.168.20.58:53606`）、`www.baidu.com:443` 24 ms、`example.com:80` 189 ms、`1.1.1.1:53` 185 ms。UDP：内网 DNS `192.168.20.1:53` → REPLY 90 B `rcode=0 answers=3` 6 ms；境外 `8.8.8.8:53` → REPLY 65 B 241 ms。**无协议层限制。**

### NET-07 回环隔离 —— **FINDING：沙箱不做网络命名空间隔离**
- 沙箱内进程看到宿主真实网卡（`192.168.20.58` / 网关 `192.168.20.1`）。
- 我起的监听器直接出现在宿主**全局**连接表：`TCP 127.0.0.1:28471 LISTENING 896`；同表可见宿主既有服务 `127.0.0.1:3080`(DSH Web GUI)、`0.0.0.0:445`、`0.0.0.0:5985`、`0.0.0.0:47001`。
- 任何本机进程（含宿主进程）都能访问沙箱内起的 loopback 服务（已用无亲缘关系的新进程 GET 200 验证）。
- **这是同机、同网络栈**。外部访问不了 `192.168.20.58:28471` 只是因为**我们自己选了 `127.0.0.1`**，不是隔离。
- ⇒ 用户可见的隔离边界：**没有隔离边界**。需要隔离必须自行只绑 `127.0.0.1` 或依赖 Windows 防火墙 `BlockInbound`。

### NET-08 易用性 —— **FINDING**
无需任何额外配置。问题集中在「误判」与「取证摩擦」：见下表。

### NET-09 沙箱基础设施缺陷 —— **FAIL**
见 §1(a)。

---

## 3. 易用性表（硬性要求）

| # | 步骤 | 需要几步 | 顺不顺 | 坑在哪 | 报错是否可理解 | 改进建议 |
|---|---|---|---|---|---|---|
| NET-01 | DNS 排查 | 2 条命令 | 顺 | `nslookup` 把反解失败的 DNS 显示为 `localhost`/`bogon`，像劫持 | 是 | 文档给一行判据「解析器地址 = 网卡网关 ⇒ 未被沙箱接管」 |
| NET-02 | 出站 HTTPS 探测 | 1 条网站 ×5 | 顺 | `--max-filesize` 触发 exit 63，易误判站点故障；长命令偶发挂起 | 部分 | 文档给带 `-w` 模板的单站点推荐命令；显式说明 exit 63 含义 |
| NET-03 | 证明「无代理 + 无中间人」 | 3 类命令（env / WinHTTP+WinINET / 证书链） | **不顺** | `X509Chain.ChainElements[i].ChainElement.Subject` **静默返回空串**，第一版取证看起来像「链是空的」；`TcpClient` 直连 github 首次 15s 超时、curl 同 IP 正常 | 否（静默） | 提供 `dsh net doctor` 一次输出代理+证书 issuer+连通性 |
| NET-04 | 起本地服务并跨进程验证 | 理想 1 条命令；实际多轮试错 | **不顺** | `Start-Process -RedirectStandardOutput` 到工作区 → 整条命令 exit 1 零输出；后台长驻服务约 1 分钟被杀（exit 124），服务看门狗也会提前退出 → 假阴性 | 否（零输出） | 修 staging 重定向；文档给「单条命令内 Start-Process→探测→Stop-Process」模板 |
| NET-05 | 端口/防火墙检查 | 4 条命令 | 顺 | 「80/443 绑定成功」易被误读为沙箱放行，实为提权 | 是 | 文档写清「低位端口可绑 = f(是否提权)」 |
| NET-06 | TCP/UDP 连通性 | 1 个 node 脚本 | 顺 | UDP 无应答无法区分「被过滤」与「对端不回」 | 是 | 用「已知会回的网关 DNS」做对照（脚本已内置） |
| NET-07 | 判断隔离边界 | 3 条命令 | 顺但易误判 | 服务外部不可达看起来像隔离，其实只是 bind 地址选择 | 是 | 文档显式声明「不提供网络命名空间隔离」 |
| NET-08 | 全流程 | — | 一般 | 境外不可达没有「环境 vs 沙箱」的提示，极易误报 | 否 | 见 §1(b) 建议 |
| NET-09 | 任何命令 | — | **很不顺** | 执行门随机拒绝 / staging EBUSY 零输出 / 重定向不可用 / 读后写不可见 | **否** | 加自动重试；展开 `%ENV%` 再拼 staging 路径；修读后写可见性；错误里给人话解释 |

---

## 4. 给 DSH / 文档的 4 条建议（按优先级）

1. **修基础设施缺陷（NET-09）**：`STAGING_WRITE_UNVERIFIED` 加自动重试或降级为警告；staging 路径先展开 `%ALLUSERSPROFILE%` 之类环境变量；支持 `-RedirectStandardOutput` 到工作区；修 `Set-Content`→`Get-Content` 的读后写可见性。
2. **新增 `dsh net doctor`**：一次输出「代理环境变量 / WinHTTP / WinINET 系统代理 / 各站点证书 issuer 与链根 / 出站 TCP+UDP 连通性 / DNS 服务器地址 / 是否命名空间隔离」，把 NET-03 的 3 类命令和 NET-07 的判断压成 1 条。
3. **文档写明网络语义**：出站默认不拦截；境外不可达属本机网络环境（建议先用国内站点做基线对照）；**不提供网络命名空间隔离**；低位端口可绑与否取决于是否提权。
4. **给出可用模板**：① 1MB 内、带 `-w` 的 curl 探测模板；② 单条命令内「起服务→跨进程探测→关服务」模板；③ DNS 是否被接管的判据。

---

## 5. 测试遗留物

- 所有测试监听器均已关闭：`netstat` 对 `:80 / :443 / :8080 / :28471 / :28472` 的 LISTENING 扫描为**空**；`Stop-Process` 后进程 `still_alive=False`。
- 机器上剩余的两个 `node.exe` 是 **DSH 自身**：`npx-cli.js @deepseek-ai/dsh web`(pid 10856) 与 `dsh\lib\bin.js web`(pid 5168)，非本线程遗留。
- 测试过程中**未修改**防火墙规则、**未做**端口扫描/内网扫描、**未攻击**任何主机；所有下载均 < 1 MB（github 首页 576 KB 为最大）。

## 6. 状态计数

| 状态 | 数量 | 项 |
|---|---|---|
| OK | 6 | NET-01, NET-02, NET-03, NET-04, NET-05, NET-06 |
| FINDING | 2 | NET-07（无命名空间隔离）, NET-08（易用性） |
| FAIL | 1 | NET-09（staging 基础设施缺陷） |
| BLOCKED | 0 | — |
| N-A | 0 | — |

## 7. 文件清单

- `results.json` —— 机器可读逐 checkpoint 结果
- `findings.md` —— 本文件
- `executions.log` —— 逐条命令 + 退出码 + 关键原始输出
- `evidence/net01-resolve.txt`、`evidence/net01-nslookup.txt` —— DNS 原始输出
- `evidence/net02-curl.txt` —— 出站 HTTPS 原始 `-w` 输出
- `evidence/net03-proxy.txt`、`evidence/net03-tls.txt`、`evidence/net03-tls2.txt`、`evidence/net03-curl-v.txt` —— 代理与证书链原始输出
- `evidence/net04-crossproc.txt`、`evidence/net04-server.js` —— NET-04 原始输出与服务源码
- `evidence/net05-06-probe.txt`、`evidence/net05-06-probe.js` —— 端口/防火墙/非 HTTP 协议原始输出与源码
- `evidence/net07-isolation.txt` —— 隔离边界证据汇总
- `evidence/net04-crossprocess-notes.txt` —— NET-09 复现笔记
