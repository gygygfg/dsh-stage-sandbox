# 域五（network, task-5）· R16 缺陷与发现

> 全部条目带本轮实测原始读数；主报告：`docs/round16/network-报告.md`。
> 本轮**未改任何仓库源码**（协议 §0.4），以下均为只读定位 + 复现步骤。
>
> **修复状态（2026-10-11 18:2x 更新）**：D5-R16-1 已由 **Lead** 按"两处同时改"结论落修
> （`dsh-plugin/cordis.patch.yml` 键搬到 `winstage-shell` 行 + `profiles\sbx\cordis.patch.yml` 的 shell 行重述），
> 本域**结构性复验已通过**：`dsh --profile sbx --dump-config`（无 overlay）里 `winstage-shell` 行 = `networkTier: OBSERVED_ONLINE`、
> 宿主行 ABSENT，机器判据 caseC `VERDICT=PASS`（详见报告 §4.6.1）。
> **行为复验（caseA/caseB/caseD）仍为 `not-run`**，等 Lead go（避免污染其他域在飞的沙箱线程）。

## D5-R16-1（P1）`networkTier` 键位落错行 ⇒ profile / 宿主行配置是空操作，只有环境变量有效

**现象**：把 `networkTier: OFFLINE` 写到 R15 文档/`dsh-plugin/cordis.patch.yml` 所指示的 **`winstage-sandbox`（宿主）行**，
run 内**没有任何效果**：lane 仍写 `requested=OBSERVED_ONLINE / state=not-implemented`，且 shell 命令**照常执行**。
同样的值写到 **`winstage-shell` 行**、或走 **`WINSTAGE_NETWORK_TIER` 环境变量**，则立刻生效（`OFFLINE/refused` + 所有命令被 fail-closed 拒绝）。

**原始读数（三次注入，其余条件完全相同）**：

| 注入点 | lane `network.requested` | `state` | 沙箱内 shell |
|---|---|---|---|
| `--patch overlay-offline.yml`（宿主行，`run-n2`） | `OBSERVED_ONLINE` | `not-implemented` | 正常执行（`staged\r16-n2-shell-attempt.txt` 38 B 落地） |
| `--patch overlay-offline-shell.yml`（shell 行，`run-n3`） | `OFFLINE` | `refused` | 3 次 `pwsh` 全部 `COMMAND_FAILED` |
| `WINSTAGE_NETWORK_TIER=OFFLINE`（`run-n4`） | `OFFLINE` | `refused` | 同上全部被拒 |

**最小复现（命令级）**：

```powershell
# A) 宿主行 —— 无效
$env:SBX_PATCH = "<repo>\.t\r16\network\overlay-offline.yml"   # 该 overlay 把 networkTier: OFFLINE 写在 id: winstage-sandbox 行
cmd /c "docs\archive\round10\env\scripts\sbx-thread.cmd <ws> <prompt> <out> winstage"
# ⇒ lane: requested=OBSERVED_ONLINE；prompt 里的 echo 命令写出的文件真实落在暂存树里

# B) shell 行 —— 有效
$env:SBX_PATCH = "<repo>\.t\r16\network\overlay-offline-shell.yml"  # 同一个键写在 id: winstage-shell 行
# ⇒ lane: requested=OFFLINE / state=refused；每条命令 COMMAND_FAILED
```

**根因（可定位到文件/行）**：

| 位置 | 事实 |
|---|---|
| `dsh-plugin/cordis.patch.yml:139` | `networkTier: OBSERVED_ONLINE` 写在 `id: winstage-sandbox`（宿主行） |
| `dsh-plugin/shell-executor.mjs:989` | `constructor(ctx, config)` —— `config` 是 **`winstage-shell` 行**的 config |
| `dsh-plugin/shell-executor.mjs:1067` | `this.networkTier = normalizeNetworkTier(stringOption(raw,'networkTier') ?? stringOption(process.env,'WINSTAGE_NETWORK_TIER'))`，其中 `raw` = 本行 config（`shell-executor.mjs:1005`） |
| `dsh-plugin/**` grep | `Select-String -Pattern networkTier` **只命中 `shell-executor.mjs`**（`:694/:705/:1067/:1624/:1707`），`host-plugin.mjs` **0 命中** ⇒ 宿主行上的键没有任何读者 |
| `%DSH_HOME%\profiles\sbx\cordis.patch.yml`（`id: winstage-sandbox` **和** `id: winstage-shell`） | 覆盖层对**整行 config 整体替换**：宿主行不带 `networkTier` ⇒ bundle 的默认键被丢弃（`dump-config-baseline.txt` 实证）；**shell 行同样被覆盖**（bundle 字面 `workspaceRoot` → 组合树变 profile 的 `!!js` 表达式）⇒ 只往 bundle 的 shell 行加键**仍会被 profile 层替换掉** |

**"修哪里才够用"（本轮实测结论，详见报告 §4.6）**：

| 改动 | 对 `profiles\sbx` 是否生效 | 证据 |
|---|---|---|
| 只改 bundle，把键加到 **宿主行**（R15 现状） | ❌ 无效 | `run-n2`：lane 仍 `OBSERVED_ONLINE`，命令照跑 |
| 只改 bundle，把键加到 **`winstage-shell` 行** | ❌ **仍无效** —— profile 覆盖同一行且整体替换 config | `dump-default-config.txt`（bundle shell 行 = 字面 `workspaceRoot`）↔ `dump-config-baseline.txt`（被换成 profile 的 `!!js` 表达式） |
| bundle 的 **shell 行** + `profiles\sbx\cordis.patch.yml` 的 **shell 行**同时声明 | ✅ 生效 | `run-n3`（overlay 版等价验证）：lane `OFFLINE/refused`，命令全被拒 |

⇒ 结论：**必须两处同时改**（或改成跨行回退读 / loader 深合并）。只改 `dsh-plugin/**` 一行**修不完整**。

**判定方法学缺口（同源，建议一并处理）**：R14/R15 的验收读数恰好是**代码默认值** `OBSERVED_ONLINE`，
所以"键生效"与"键根本不存在"在读数上**不可区分**。任何"接线类"验收都必须至少注入一个**非默认值**（如 `CONTROLLED_ONLINE`/`OFFLINE`）看姿态变化。

**建议修复（择一，推荐 1+2 同时做）**：

1. 把 `networkTier` 声明挪到 **`winstage-shell` 行**（`dsh-plugin/cordis.patch.yml`），并在 `profiles/sbx/cordis.patch.yml` 的 shell 行重述该键（避免整体替换再丢一次）。
2. 让 `shell-executor` 允许**跨行**读取宿主行的同名配置作为后备（宿主行 → shell 行 → 环境变量），或把 lane 里 `network.requested` 增加 `source` 字段（`row|env|default`），让"键从哪来"可见。
3. 在 `/winstage status` 或 lane `note` 里明示"当前档位来源"，避免操作者以为 profile 里的键生效了。
4. 验收加一条非默认档对照（本轮 `run-n3`/`run-n4` 的两条命令可直接复用）。
5. 复验配方已就绪：`.t\r16\network\fix-verify\run-fix-verify.cmd full`（2 run + 组合配置 dump + 机器判据 `verdict.json`），
   判据与"修够没修够"的对照表见 `.t\r16\network\fix-verify\expectations.md`；检查器已用修复前证据做过双向自测（`selfcheck\`）。

**严重级**：**P1** —— 产品文档/配置面上"可配置网络档位"的承诺当前**不成立**（只有环境变量这条隐性入口有效）。

---

## D5-R16-2（P2）OFFLINE fail-closed 生效，但模型可见错误没有 code / reason

**现象**：`networkTier=OFFLINE`（生效时）每条命令都被正确拒绝，但工具返回给模型的错误是**通用文案**：

```json
{"type":"tool_result","status":"error","result":"Error: COMMAND_FAILED: 命令失败。"}
```

`run-n3/stdout.ndjson` 里 3 次 `pwsh` 全是这一句；没有 `SANDBOX_NETWORK_POLICY_UNENFORCED`、没有 netpolicy 的 `reason`。
模型只能猜"offline environment without a specific error code"（`run-n3/stdout.ndjson:12` 的 thinking 原文），
于是继续重试同类命令、并把它当成环境故障而非策略闸门。

**证据**：`run-n3/stdout.ndjson`（3 次 `tool_result`）、`run-n4/stdout.ndjson`；
原因文本只存在于 `run-n3/stage-root-r16n3/sandbox-lane.json` → `network.reason`。

**建议**：执行器的网络闸门错误（`executor.mjs:3257-3267`）应把 `error.code + summary.reason` 透传到 shell 工具的错误面
（至少附一行 reason），并保留 `COMMAND_FAILED` 作为外层分类。

**严重级**：**P2**（不阻断功能，但可诊断性差；线上会表现为"沙箱里什么命令都跑不了且没有任何解释"）。

---

## D5-R16-3（P2，复现 R11 D5-N2）审计面完全不记录网络活动

**现象**：n1 在内核/网络面做了 3 次 HTTPS、5 次 DNS、2 次裸 TCP，并**监听 + 接受了 3 个外部连接**，
但 `audit.jsonl` 的 `op` 全集只有文件/注册表（`reg.open / reg.query / reg.create / reg.set / file.open`），**网络类 op 命中 0**；
`sandbox-audit.json.summary` 也只有文件/注册表计数。

**原始读数**：`audit-scan-n1.json` → `audit.lines=19524`、`audit.network_ops=[]`、
`sandboxAudit={"filesRead":67,"filesWritten":40,"registryRead":728,"registryWritten":110,…}`（无网络字段）；n2 同形（10 141 行、网络 op 0）。
lane 自己如实写 `perOpAudit: false`。

**建议**：若产品要宣称"可审计的网络边界"，需要为 `connect/bind/DNS` 增加审计事件；否则应在文档里明确"网络面仅姿态可见、无逐条审计"。

**严重级**：**P2**（复现 R11 未修项）。

---

## D5-R16-4（P3，复现 R11 D5-N3）`audit.jsonl` 不是标准 JSONL（行前缀）

**现象**：每行形如 `[winstage-audit][9096][1312] {"op":"reg.open",…}`；标准逐行 `JSON.parse` **100% 失败**。
本轮量化：n1 **19 524/19 524** 失败、n2 **10 141/10 141** 失败；剥掉前缀后失败 **0**。
（消费方必须切到第一个 `{`；`audit-scan.mjs` 已实现该绕行。）

**建议**：写入侧输出严格 JSONL，把 pid/tid 放进字段里。

**严重级**：**P3**（消费侧可绕行）。

---

## D5-R16-5（观察项 / 非缺陷，但影响产品决策）`OFFLINE` 在本机永远只能"拒绝执行"，不可能真的"离线"

**读数**：`run-n3`/`run-n4` 的 lane `network.reason` 逐字给出
`WFP_UNAVAILABLE: WFP 绑定表不可用（缺少 fwpmEngineOpen0, fwpmEngineClose0, fwpmSubLayerAdd0, fwpmFilterAdd0, fwpmFilterDeleteById0, fwpmSubLayerDeleteByKey0）…`
⇒ 执行器（`src/executor.mjs:3206` 取 `options.networkBindings ?? this.api`）拿不到 WFP 绑定表，
OFFLINE 只可能停在 `state=refused`，再由 `assertNetworkPolicyEnforceable()` 拒绝一切命令；WFP 前后 filters XML 逐字节相同（§5）。

**含义（需 Lead 决策，不是 bug）**：当前 OFFLINE 的**实际语义是"拒绝执行所有命令"，而不是"允许命令但断网"**。
如果产品希望 OFFLINE = "命令可跑、网络被真阻断"，需要注入真实 WFP 绑定表（`Fwpm*Add0` 族）+ pin 回调；否则应在文案里把 OFFLINE 描述为 fail-closed 拒执行。

**严重级**：观察项（**不是**新缺陷；R15 §3 的"诚实边界"已部分声明，本轮给出运行时证据）。

---

## 附：本轮未记为缺陷的核对结果

- **出站未收敛、入站全开放、WFP 0 过滤器**：与 R11 一致，是**已知现状**（`OBSERVED_ONLINE` 不阻断），按要求如实记录，不作为修复项。
- **`sandbox-lane.json` 的中文乱码**：核对了文件字节，`tail_hex=20207d0a`（`  }\n`）⇒ 文件本身是合法 UTF-8 JSON；
  乱码来自 Windows PowerShell 5.1 `Get-Content` 的默认 ANSI 解码与 `lane.txt` 的抽取面，**不是产品缺陷**（但会误导取证，已在报告 §8.8 记录）。
