# r3 轮测试记录（2026-10-04 实测）

本轮目的是**验证**（而不是复述）WinStage 沙箱的隔离语义，结果证伪了 `PROTOCOL.md` v1
的若干前提，并暴露出执行门粘滞、会话中途失根、读面无审计等新问题。

- 配套文档：`..\PROTOCOL.md`（已加入 `## r3 更正（2026-10-04 实测）`，条目编号 C1–C10）
- 证据原件：`.t\dsh2\home\sessions\--C-Users-Administrator-Desktop-WinStageSandbox-.t-dsh2-ws--\session-<sid>\session.v4.jsonl.zstd`
- 本线程纪律：**未**启停 3080/3081、**未**改 profile、**未** approve/apply 任何候选、
  **未**跑任何新的沙箱域测试。本线程只做**文档更正 + 通道复核**：独立重解压/对照会话日志、
  `cmd` 与 PS 双通道对照、`cmd /c "x > file"` 取证法复现、自身产出的真实盘落点核查。

---

## 1. 方法

### 1.1 隔离实例（3081 车道）

r3 全部域测试跑在**隔离实例**上：另一套 `.t\dsh2` 数据根（`ws = .t\dsh2\ws`，
home 在 `.t\dsh2\home`），Web GUI 监听 **3081**；主实例 **3080** 保持原样，仅用于
只读对照。探活证据（NODE）：

```
port 3080 -> OPEN (6ms)      port 3081 -> OPEN (4ms)      port 3082 -> CLOSED (ECONNREFUSED)
GET 3081/ -> HTTP 401 bytes=68       GET 3080/ -> HTTP 401 bytes=68
```

同日该车道 home 下有 20 个会话目录，其中 r3 当天（2026-10-04）6 个，即下表六域。

### 1.2 CDP 驱动新线程

用 CDP（`ws\_r3\` 下的 `cdp.mjs` / `sess.mjs` / `gui.mjs`）连到 3081 的 Web GUI，
**从 UI 新建会话/线程**并按域派活（每域一个 session id，互不共享上下文），避免手工
操作引入偏差；期间用 `ui.png` 截图留证。

### 1.3 按帧 zstd 解压会话取证

会话日志 `session.v4.jsonl.zstd` 是**多帧 zstd 流**，一次性解压会截断。做法：

1. 自写**帧扫描**解压器（`unz2.mjs` / `unzall.mjs`），逐帧解压并拼接为 `s_<sid>.jsonl`；
   独立复核线程又用 `iv\extract.mjs` **独立重实现**一遍，两份对照。
2. 完整性判据：`badJSON=0`、`seq` 严格单调递增、`dupSeq=0`、`nonMonotonic=0`。
3. 提取结论时只认 `assistant/message` 的 **text 部件**里的 `===R3-RESULT===`；
   排除模板回显（`agent/inbox/spliced`、`user/message`、`tool/result`、`session/title-llm-request`）
   与只出现在 `reasoning` 里的草稿（`d6e30323` seq=323 即此类，已正确排除）。

> ⚠️ **方法坑（必须记住）**：执行者自己的 6 份会话副本中有 **4 份被截断成严格字节前缀**，
> 截断处仍是合法 JSONL（看起来完整）。被截掉的恰好是这 4 个会话**自己的最终结论**：

| session | 执行者副本 | 独立重解压 | 相等? | 缺失的结论 |
|---|---|---|---|---|
| 4a363277 | 189462 B / 74 行 | 189462 B / 74 行 | true | — |
| 7fe91f0f | 693317 B / 199 行 | 693317 B / 199 行 | true | — |
| 73feedf7 | 1433709 B / 295 行 | 1850942 B / 377 行 | **false** | `[R3-REGNET]` FINDING（L375） |
| 97132a99 | 1166251 B / 322 行 | 2021968 B / 423 行 | **false** | `[R3-PKG]`（L421） |
| d6e30323 | 1227704 B / 260 行 | 1849590 B / 334 行 | **false** | `[R3-FS-SEN]` FINDING（L332） |
| 16192a87 | 1604627 B / 210 行 | 3438219 B / 415 行 | **false** | `[R3-FS-SEN]` FAIL（L413） |

→ **任何取证都必须以独立重解压的会话日志为准**；不要用别人导出的副本下结论。

---

## 2. 结果索引表（六域）

| 会话 id | 域 | 状态 | 关键发现 |
|---|---|---|---|
| `session-4a363277-10c5-4402-a9ea-a3a7bd02406b` | 前置自检 | **OK** | 环境/通道前置自检通过；本会话 seq=20 是**唯一**含 `WINSTAGE_*` 原始 env dump 的记录（`stage_root`/`WINSTAGE_SHIM_CONFIG`/`WINSTAGE_REGSTAGE_SESSION_DIR` 均非空）；注意 `ROOT_WRITE_OK` 只表示「写进了覆盖层」，真实磁盘无 `__pf.txt` |
| `session-16192a87-28a7-4718-9220-aefdea3c2021` | FS + 敏感 | **FAIL** | `FS-01`/`FS-07` = BLOCKED\|FAIL；`SEN-01/02/03/05` FAIL；`FS-02/03/04/05/06/08` OK；**真实磁盘零产物**（隔离守住）；会话中途自述 shim 脱离、env 清空、工作区写被 NTFS 拒绝 |
| `session-97132a99-9238-4b1a-8cf1-f51c7047b3aa` | pip + node | **FAIL** | `ND-01..06` **全 OK**；`PIP-02`/`PIP-03`/`ND-07` FAIL。`PIP-02` 写 `C:\ProgramData\pip\pip.ini` 报成功且进程内 SHA256 自洽，但**新进程 `exists:False`、暂存树与真实磁盘都没有**（执行门自检 `outside-write-staged-not-real=fail`）。**是载体层问题，不是 pip/npm 本身的问题** |
| `session-73feedf7-23c7-4304-bd4c-ea2e121c82e2` | 注册表 + 网络 | **FINDING** | `REG-05` OK（**真实 hive 未变**）、`NET-01/03/04` OK；`NET-02` **HTTPS 全挂 `SEC_E_NO_CREDENTIALS`**；`REG-01..04`/`REG-06` BLOCKED |
| `session-d6e30323-1fe8-4470-8509-36a4de194dae` | FS + 敏感（第二次） | **FINDING** | **真值通道前提被证伪**（宿主 write 落 `<stage>\_hostonly\a.txt`）；**中途失根**（`WINSTAGE_STAGE_ROOT` 变空、暂存产物消失、报文只有 `Access is denied`）；**执行门闩锁**（触发后连 `Write-Output` 都被拒） |
| `session-7fe91f0f-c3c7-40db-8f3d-628ca5587cb4` | （域测试未开始） | **BLOCKED-by-approval** | 卡在**无人应答的 `approval/asked`**（seq=197，pwsh 请求 escalate 到 danger-full-access 以创建产出目录），无 `turn/end`，因此没有 `R3-RESULT`。**这是「卡死」不是「失败」**，统计时必须单列 |

六域汇总：**1 OK / 2 FAIL / 2 FINDING / 1 BLOCKED-by-approval**；真实磁盘零产物。

---

## 3. `PROTOCOL.md` 更正指针

`PROTOCOL.md` 开头新增 `## r3 更正（2026-10-04 实测）`，条目与证据对应如下
（原文全部保留，仅在证伪处加「已被 r3 证伪，见 r3 更正 C#」标注）：

| 编号 | 更正内容 | 主要证据 |
|---|---|---|
| C1 | 宿主 read/write 工具**不可当真值通道**：它既可能只落暂存、也可能直落真实磁盘（**同一会话内都不稳定**）；真值只能由**非沙箱进程**在真实磁盘上取得，且「宿主写+宿主读自洽」永不构成落盘证据 | `97132a99` CH-01、`d6e30323` CRITICAL（`_hostonly\a.txt` 落暂存；`_r3\fs-sen\results.json` 宿主写读自洽但真实磁盘不存在）；本线程 2026-10-05 反例：同会话两文件直落真实盘，另一通道探针只进暂存（见 §5） |
| C2 | `cmd /c dir` **不是** read-through（原 §3.2 把它列为「也被 hook」） | 暂存-only 文件：`cmd /c dir` → `File Not Found`，PS/.NET → `True`（有正对照） |
| C3 | overlay 有**三套互不可见**的布局，v1 只写了一种，且同路径两份内容都进同一 `review.json` | `staged\<ws 相对路径>` / `staged\fs\<盘符>\<绝对路径>` / `staged-ext\<hash>\<文件名>` |
| C4 | 「工作区外写入被暂存」不总成立：存在**静默丢失**这第三种状态 | `97132a99` PIP-02（`outside-write-staged-not-real=fail`） |
| C5 | 执行门 `STAGING_WRITE_UNVERIFIED` 会**闩锁**且无解除提示 | 连 `Write-Output` 被拒数分钟；退出码 `3762504530`/`2`/`127`；探针 `0xC0000005`、`0xE0434352`、`exit 127`、`>25s` 挂死 |
| C6 | 中途失根/会话漂移：报文只有 `Access is denied`，与策略拒绝**无法区分** | `WINSTAGE_STAGE_ROOT` 变空、多会话冒出、暂存产物消失 |
| C7 | PowerShell 原生命令 stdout 被静默吞掉 → 取证必须 `cmd /c "x > file"` 再读回 | `& node --version` 输出与退出码皆空；重定向后得 `v24.21.0`（本线程 2026-10-05 已复现） |
| C8 | **读面无审计**（写面有完整候选/风险分级/review 仪表） | `.dsh\.credentials.yaml`(223B, secret/API key)、`%USERPROFILE%\.npmrc`、PSReadLine 历史、Edge `Login Data`(126976B, `password_value`) 静默可读；DPAPI 可往返；伪造 AWS key/GitHub token 经 node HTTPS POST 到 httpbin 被原样回显 |
| C9 | 隔离**确实守住**的部分（勿误读为全盘失守） | 真实磁盘零产物；`C:\Windows\Temp` 三方式全拒；`System32`/`D:\` 越界写全拒；真实 `NTUSER.DAT` size/mtime 与基线一致（SHA256 因 hive 独占取不到 = `N-A`）；真实 hive 无测试键 |

---

## 4. 取证注意事项（从 r3 教训固化）

1. **落盘结论只能由 `REAL` 支撑**：真实磁盘 + **非沙箱进程**（用户自己的 PowerShell /
   资源管理器）。宿主工具、沙箱内 pwsh、node 都不算。
2. **写后自洽 ≠ 落盘**：`HOST write` + `HOST read` 一致只证明暂存层自洽。
3. **三套 overlay 布局都要列**，只看一套会漏（尤其「同路径两份内容」）。
4. **查三处**：真实磁盘（REAL）、暂存树（STAGE）、candidates/`review.json`（STAGE）；不一致
   就如实记录，不要互相推定。
5. **外部命令输出重定向到文件再读回**（C7）；输出为空先怀疑「被吞」。
6. **一句 `Access is denied` 不足以判定策略拦截**（C6）；先查 `WINSTAGE_STAGE_ROOT`
   是否非空、暂存产物是否还在。
7. **会话副本不可信一半**（见 1.3 表）：必须独立重解压 zstd 会话日志。
8. **读敏感文件成功不是隔离失败**，是读面缺口（C8）——与写面拦截分开陈述。

---

## 5. 本文档自身的落盘状态（实测复核过，含一个重要反例）

文档纠正线程 E 于 2026-10-05 用**双通道**复核了两个改写文件的落盘位置：

| 检查 | 结果 |
|---|---|
| `staged\_sandbox-tests\…`（宿主工具布局） | **无** `PROTOCOL.md`、**无** `r3\README.md`（该目录下只有另一个通道的 `_lane-probe\probe-*.txt`，2037B，mtime 自 09:01:59 起持续被重写） |
| `staged\fs\…`（shim 布局） | **空**（零文件） |
| `staged-ext\…`、`wo`、`real`、`private`、`cache`、`blobs` | 均**无**这两个文件的副本 |
| 真实磁盘 `_sandbox-tests\PROTOCOL.md` | **17781 B**，mtime `2026-10-05 08:58:12`（原文 6275 B / 10-03 01:09:36） |
| 真实磁盘 `_sandbox-tests\r3\README.md` | **9725 B**，mtime `2026-10-05 08:58:40` |
| `cmd /c dir <ws>\_sandbox-tests\r3`（真实盘窗口） | 返回 `README.md` |
| `review.json` 的 pending 候选（快照 `generatedAt 2026-10-05T01:00:34Z`，325 项） | **不含**这两个路径 |

**结论**：本次这两个文件的宿主 `write`/`edit` **直接落到了真实磁盘**，不是暂存。
因此不需要（也**没有**生成）`<stage>\_r3\PROTOCOL-r3-fixed.md` 那份人工 approve 回退件。

> ⚠️ **重要反例（与 C1 合用）**：同一 stage 根下，另一个通道在 `09:01:59` 的写入
> **只进了暂存**（`staged\_sandbox-tests\r3\_lane-probe\probe-*.txt`，真实磁盘无此文件）。
> 也就是说**宿主工具的落盘行为在同一会话内都不稳定**（可能取决于当时 shim/暂存是否介入，
> 本机当前 DSH 文件策略为 `danger-full-access`，也可能是诱因）。
> **不要预设**宿主工具「一定暂存」或「一定落真实盘」—— 每次都要用 `REAL` 通道复核；
> 并且 `cmd` 在本会话并不可靠（多次 `Program 'cmd.exe' failed to run: Access is denied`，
> 仅偶尔成功），所以「真实盘复核」最好由**用户自己的 PowerShell** 完成。
