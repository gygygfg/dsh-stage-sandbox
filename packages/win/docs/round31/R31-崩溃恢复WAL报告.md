# R31 · R21-FS-07 崩溃恢复 WAL（apply intent journal）（第十批）

> 范围：`packages/win`。执行：Lead + 2 个 teammate（file-shim / gate-runner），2026-10-21。
> 前置：R19–R30 已提交（`e211dc2`）。用户要求"每阶段 commit 后自动继续"⇒ 第 ② 阶段：**apply 崩溃恢复 WAL**。

---

## 0. 一句话结论

| 项 | 内容 | 结果 |
|---|---|---|
| **R31-A（R21-FS-07）** | apply 持同 store `apply.lock`、内存回滚快照；**进程中途崩溃 ⇒ 真实盘混合态、无恢复记录** | **已修**：apply 意图 WAL `<store.dir>/apply.journal`（JSON + version + sha256；R24 整批快照 + 每 change after 身份）；成功/回滚成功删、回滚失败保留 `partial`、崩溃保留 `applying`；恢复 API `recoverApplyJournal()` + `applyCandidate`/`init` 自动触发；并发守卫、损坏 fail-closed、pid 判死即时回收锁、崩溃测试缝 |
| 读数 | 修前红：真实子进程 apply 中途被杀 ⇒ 真实盘 **mixed new=5/old=75**、store 无 journal、代码无恢复/崩溃缝字符串 | 修后 post **24/24**：N=1/2 崩溃 ⇒ journal 保留 ⇒ 恢复后真实盘**逐字节回原态**、候选 pending、事件 `RECOVERED_APPLY_JOURNAL`；损坏 fail-closed；并发守卫；幂等 |

最终树：shim 未变（dll `5AAB28F3…` 331776 B）；dist `D9E9D358…`（176497 B）；基线 **167 条**；verify **55 套件**。

---

## 1. 修前红（gate-runner 独立）

驱动 `.t\r31-gate\run-r31-crash.ts`：80 文件×256KB 候选；父进程监视首个真实文件被写成新内容后立即 `taskkill /F` 子进程。

| 证据 | HEAD（`e211dc2` / workspace `A943A723…`）读数 |
|---|---|
| 代码 | `apply.journal` / `RECOVERED_APPLY_JOURNAL` / `APPLY_JOURNAL_CORRUPT` / `RECOVERY_CONCURRENT_MODIFICATION` / `WINSTAGE_TEST_CRASH_AFTER_APPLY_WRITES` **全部不存在** |
| 行为 | 崩溃后真实盘 **mixed new=5 / old=75**（其余 0）；store 无 journal；无恢复入口/事件 |

⇒ 红基线成立：崩溃后真实盘停混合态、无持久恢复记录、下次 apply 无法自动回滚。

## 2. 修复（file-shim，`src/workspace.ts` 180042 B）

- **journal**：`<store.dir>/apply.journal` = JSON `{payload, checksum:{algo:'sha256',hex}}`；payload 含 version=1、
  candidateId、createdAt、phase（applying|partial）、maxSnapshotBytes、R24 快照（原 bytes base64/mode/hidden-system/
  absent/newParents/目录树 entries）+ 每 change afterKind/afterHash/afterMode；temp+rename 原子写。
  超 64MiB 写前 `APPLY_JOURNAL_TOO_LARGE`；损坏/截断/版本/校验失败 ⇒ `APPLY_JOURNAL_CORRUPT` fail-closed（init 与 applyCandidate 都拒）。
- **生命周期**：成功删；回滚成功删；回滚失败保留 `phase=partial`；崩溃保留 `phase=applying`。
- **恢复**：导出 `Workspace#recoverApplyJournal()`（同步，返回 recovered/skipped/events）；`applyCandidate` 取锁后先恢复；
  `init()` 见 journal 尝试锁（timeout=0，忙则跳过交给持锁进程）。逐 change 并发守卫：原态 ⇒ noop、==本批 after ⇒ 逐字节恢复、
  其它 ⇒ `RECOVERY_CONCURRENT_MODIFICATION` 跳过不覆盖；候选置回 pending、`lastApply.recovered=true`、
  事件 JSONL `<store.dir>/apply.events.jsonl`（`RECOVERED_APPLY_JOURNAL`/`_PARTIAL`）。
- **附加关键修复**：崩溃遗留 `apply.lock` 的 mtime 很新（<120s）会挡住恢复 ⇒ 锁内 pid 判死即时清锁（保留 120s mtime 兜底）。
- **崩溃测试缝**：`WINSTAGE_TEST_CRASH_AFTER_APPLY_WRITES=N` ⇒ 第 N 条成功写后 `process.abort()`（仅测试 env，生产不设无变化）。

### 读数
- 新套件 `tests/r31-apply-journal.ts` **10 断言**：HEAD **10/7 红** → 修后 **10/0/0**（N=1/2 真实子进程 exit 134 → journal 留存 →
  init 恢复逐字节回原态、候选 pending、事件；损坏双入口 fail-closed 零写；并发守卫；大小上限；journal 不在 workspace 内）。
- 回归：r24 13/0、r21 24/0、workspace-regressions 29/0、e2e-flow；r28 19/0、r19 17/0、r20 22/0、r22 12/0、r23 13/0、r27-edge 16/0；tsc=0。
- 本轮无 shim C 改动（私有 out 沿用 R30 DLL）。

## 3. 最终门禁

| 关口 | 读数 | 证据 |
|---|---|---|
| `tsc` / 基线 | **0** / **167 条逐字相符** | `phase3-final-all.log` |
| **verify 55** | **ALL PASS / EXIT=0；✓=3149 / ✗=0 / SKIP=15**（r31 10/0、r24 13/0、r21-file 24/0、r27-edge 16/0、r28 19/0；无 CI 拦截） | `verify-*` |
| **R31 post 独立复核** | **24/24**：正常/失败 journal 清理；崩溃缝 N=1/2 ⇒ exit 134、journal 保留 ⇒ 恢复逐字节回原态+候选 pending+事件+幂等；损坏 `APPLY_JOURNAL_CORRUPT` 零写；并发守卫 skip 不覆盖；pid 判死回收锁 | `journal-post-*` |
| gates | tsc 0、suite-wiring 22/0、baseline-integrity 14/0、167 条相符、residual 54/0 + plant 55/9 | 同上 |
| 矩阵 / managed / TS / T1 lane | 46/46 / 7/7 / 14/14 / 14/14 | 同上 |
| G1–G4 / R26A / R28A / R29A / R30A | 52/52 / 22/22 / 15/15 / 27/27；24/24；11/11；20/20；32/32 | 同上 |
| 4 沙箱 / lane / 生产 lane / 闭环节 | 按口径（file-cow 16/19 carrier）/ 9/9 / 9/9 / 30/30 | 同上 |

### autotest clean（DSH-as-node）

`exit=1；套件 52 通过 / 3 失败 / 0 SKIP；3079 ok / 10 bad`：①产品红 **0**；②已登记环境：`r21-fs-policy` 8（模块身份）、
`r24-atomic` 1（E2）、`r28-apply-attributes` 19/1（R29-B1 仅 DSH-as-node，plain 19/0 已复现差异）、file-cow 16/19、audit；
③CI 本轮未命中；ebk 未跑（无 docker/KVM）。

---

## 4. 残余（R31）

1. journal 含快照 base64（存于 store.dir；敏感口径与暂存相同，不新增真实盘明文）。
2. **无 fsync**：不承诺断电 durability（进程崩溃可恢复；断电掉未刷盘 journal 的极端场景不承诺）。
3. 并发跳过不自动合并（`RECOVERY_CONCURRENT_MODIFICATION` 留给人工/后续规则）。
4. PID 复用极窄竞态；`init()` 锁忙时跳过恢复（交给持锁进程）。
5. 继承 R27–R30 其余残余（CI 签名/策略、真实远端 SMB/ebk、R21-LC-05、DSH-as-node 运行时差异、
   ACL 非暂存语义、32760–32767 长路径、结构性残余）。

## 5. 后续（自动继续）

R32：autotest DSH-as-node 运行时差异（r21-fs-policy `isFsError` 模块身份 / r24-atomic E2 只读回滚 / r28-apply 19/1），
让 autotest 在 DSH-as-node 下同样干净；R33：环境/宿主/结构性残余收尾与最终残余清单。
