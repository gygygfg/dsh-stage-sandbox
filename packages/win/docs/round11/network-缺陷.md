# 域五（network, task-5）· R11 缺陷与发现

> 全部条目都带本次实测原始读数；`not-run` / 成因未定 的项如实标注。主报告：`docs/round11/network-报告.md`。

## D5-N1（中）沙箱内 `spawn` + `stdio:'pipe'` ⇒ `read ENOTCONN` 未捕获崩溃

**现象**：d5-n3 / d5-n4 的 `serve` 命令只写出 `<<STEP serve-ready>>`（两个 listener 都 `BIND OK`）后**整进程死亡**，`exit=1`，没有 `child-spawn-diagnostic` / `hold-window` / `fatal` 任何后续步骤（说明不是被 JS 异常捕获路径处理，而是 Socket `error` 事件未捕获）。

**原始片段**（嵌套线程 final 里贴回的命令 stderr，`run-n3/out/stdout.ndjson`）：

```
at Object.Socket (node:net:550:41)
at createSocket (node:internal/child_process:337:14)
at ChildProcess.spawn (node:internal/child_process:492:23)
at spawn (node:child_process:813:9)
at startChildServer (file:///C:/Users/Administrator/Desktop/dsh-winstage-sandbox/.t/r11/network/sbx-probe.mjs:229:19)
Emitted 'error' event on Socket instance at:
    at emitErrorNT (node:internal/streams/destroy:170:8)
{
  errno: -4053,
  code: 'ENOTCONN',
  syscall: 'read'
}
Node.js v24.21.0
```

**证据**：`run-n3/out/stage-root/staged/d5-n3/serve/steps.jsonl`（只有 env + serve-ready）、`run-n3/out/stdout.ndjson`、`run-n4` 同形。

**规避（已验证）**：同一脚本用 `stdio:'ignore'` 时 spawn 正常（d5-n1/d5-n2 的旧版、以及 d5-n5 的最终版都能拉起子进程：`evidence/sbx-n5/summary.json` → `child-ready.childPid=10440`、宿主 `netstat` 看到 `LISTENING 10440`）。
**影响**：沙箱内**任何把子进程 stdout/stderr 接管道**的写法（含 `execFileSync`/`spawnSync` 的默认 pipe）都可能整进程崩溃，而不是返回错误码 —— 探针必须用文件重定向或 `stdio:'ignore'`。
**归属**：贴近"受限环境不能开命名管道"的已知边界（本轮在 WinStage TS 档复现并留了原始栈）。**未定位**是 shim 还是 AppContainer/Job 层；`not-run`。

## D5-N2（中）审计面不记录任何网络活动

`audit.jsonl` 四个完成 run 的 `op` 全集只有 `reg.open / reg.query / file.open / reg.create`（n1 46403 行、n2 24024 行、n3 6549 行、n5 17909 行），网络类 op 命中 **0**；`sandbox-audit.json.summary` 只有文件/注册表计数；`sandbox-lane.json` 无任何网络字段（详见主报告 §6）。
⇒ 网络面**既无强制、也无审计**：沙箱内发多少请求、连哪些 IP、监听哪些端口，事后**无法从审计面复盘**。若产品要宣称"可审计的网络边界"，这是缺口。

## D5-N3（低）`audit.jsonl` 不是标准 JSONL（行前缀）

每行形如 `[winstage-audit][9096][1312] {"op":"reg.open",...}`。用标准逐行 `JSON.parse` 会 **100% 失败**：本人第一版扫描器给出 `lines=42772, malformed=42772`（`evidence/audit-scan-n1.json` 的早期版本），剥离前缀后 `malformed=0`。
**建议**：消费方先切到第一个 `{`；或让写入侧输出严格 JSONL（另加上下文用字段承载）。

## D5-N4（低）网络关键词扫描的假阳性

- `review.json` 的 `counts.net = 42` 是"净变更行数（net changes）"，与网络无关；键名匹配会假阳性。
- 全文搜 `network|tcp|http` 会命中注册表键名（如 `HKLM\SOFTWARE\Microsoft\.NETFramework\...\System.Net.DisableExpect100ContinueTls13Fix`，R10 记录过 658 次命中）。
**判据要求**：网络相关判定**必须**看 `op` 字段与结构化字段名，不能全文检索。

## D5-N5（中）profile 面没有网络档位入口

`dsh-plugin/*.mjs` 对 `networkTier|netpolicy|wfp|network` 命中 **0**；执行器默认 `options.networkTier ?? 'OBSERVED_ONLINE'`（`src/executor.mjs:1870`），而 `OBSERVED_ONLINE` 在 `src/wfp.mjs::planOfflineRules` 直接 `WFP_TIER_NOT_IMPLEMENTED`（不作阻断声明），`installNetworkPolicy()` 只在 `OFFLINE` 档被调用（`src/executor.mjs:3205/3259`）。
⇒ 真实的 DSH 线程**只能停在"未实现、不阻断"档**；`OFFLINE` 的 fail-closed 与 WFP 强制在本机**当前无配置入口、不可验证**（与 R10 defects N3 同结论，本轮以 `seed*`/`lane`/`audit`/WFP 四路运行时读数再次确认其为现状）。

## D5-N6（低）本人探针证据污染（已归档，非产品缺陷）

为验证 `serve` 模式，本人在宿主机上跑了 `sbx-probe.mjs serve ... LOCALTEST 8`，其 listener 落在 18881/18882；当时在跑的 `host-cross-probe.mjs` 只按"HTTP 200"判定，把这次 **LOCALTEST** 监听记成了 `found-18881/found-18882`。已改名归档为 `evidence/host-cross-probe-POLLUTED-selftest.{json,steps.jsonl,stdout.txt}`，并在重跑版本中加了 **`x-d5-nonce` 精确相等**判据（`evidence/host-cross-probe.json` 里 `mismatch-*` 记录就是该守卫生效的样子）。
**教训**：宿主侧"发现监听"必须校验**带外 nonce**，否则同机任何进程的监听都会被误认。

## D5-N7（低）`ECONNRESET` vs `ECONNREFUSED`：端口回收读数的探针差异

n1–n4 的 `bind-matrix.afterClose` 为 `ECONNRESET`（Node 侧 `http.get` 默认连接池），而宿主对照 `host-recycle-control.json` 在 close 后 fresh/pooled **都**得到 `ECONNREFUSED`，未复现 `ECONNRESET` ⇒ **成因未定**。d5-n5 用 `agent:false`（全新 socket）在沙箱内得到 **`ECONNREFUSED`**，故端口回收结论只取该读数与宿主 `taskkill` 测试（`evidence/host-kill-test.json`）。**不把 `ECONNRESET` 当作沙箱行为结论。**
