# `.git` 的暂存与完整性（2026-11-26）

本文记录 Windows 侧 `.git` 从「整棵 junction 直连真实盘」改为「控制面暂存 + 对象库 junction +
发布闸门」的设计、取舍与验收。对应 Linux 侧的经验来自 NeoAI（`runtime.git_path_class` /
`candidate._apply_order` / `_git_publish_gate`），但两边的成本约束不同，差异会逐条写明。

## 1. 要解决的问题（不是"洁癖"）

旧口径 R42-GIT：`.git`/`node_modules`/`.venv` 用 junction 直连真实盘，为了 `git status` 能用。
代价是**整条安全链路被绕过**：

```
载荷 → 写 .git/hooks/post-commit → junction → 真实盘
     → 用户下一次 git commit 执行它（沙箱早已退出）
```

盲批（"看不懂就确定"）下没有任何一层能拦住：暂存层看不到（junction 不在暂存树里）、
候选里没有、审批里没有。`git config core.hooksPath` / `core.pager` 同理（任意命令执行）。

## 2. 设计：按「可变性」三切

| 部分 | 处置 | 理由 |
|---|---|---|
| `HEAD` / `index` / `refs/**` / `logs/**` / `packed-refs` / `shallow` / `commondir` / `worktrees/**` | 复制进暂存树，**可发布**（`pointer`） | 决定"下一次 commit 变成什么"，必须能被审批 |
| `objects/**` | **按档位二选一**：shim 档由垫片重定向进暂存（成为 `object` 候选，先于指针发布）；非 shim 档（T1/T0）是 junction 直连真实盘 | 内容寻址、只增不改；复制一个真实仓库的对象库是 GB 级成本，但垫片已经能零成本重定向 |
| `config` / `hooks/**` / `info/**` / `description` / `modules/**` | 复制进暂存树，**永不发布**（`other`） | 改变 git 的行为（钩子、`core.hooksPath`/`core.pager`），不是"状态" |
| `*.lock` / `gc.log` | 不复制、不发布（`transient`） | 锁与日志不是状态，复制只会制造噪声候选 |

分类实现：`src/git-path.ts::gitPathClass`（大小写不敏感、支持 `\` 与 `/`、取**最后一个** `.git`
以正确处理嵌套仓库）。发布位次：`object 0 → 普通文件 1 → pointer 2`；`other/transient = -1`。

物化实现：`src/workspace.ts::materializeGitControlTree`。复制时保留 `mtime`，第二次物化按
`size + mtime` 快速跳过（`.git/index` 在大仓库可达数十 MB，而物化是每条命令都跑）；
**每次执行前刷新基线**（真实盘是
lower，清单条目是 upper），否则批准过一次 `git commit` 之后暂存副本会停在旧 index 上，
下一次候选必然 `STALE_BASELINE`。复制预算：单文件 64 MiB / 总量 256 MiB / 50 000 条；
超限或出错时回落到整棵 junction，并把 `gitMode` 记成 `junction-budget` / `junction-fallback`
（fail-open 但**如实上报**，不是静默降级）。

## 3. 发布闸门（fail-closed）

`src/git-integrity.ts::checkGitIntegrity`，在 `Workspace._applyCandidateLocked` 里、**任何写入之前**
执行：

0. **捕获阶段就丢弃** `other`/`transient`（`ingestCapturedChanges` 记 `skipped: git-internal-*`，
   `exec` 的文本面会列出来）：一条 `git config user.email` 不该毒化整轮审批；它们本来也永不发布。
   文件工具（`write`/`edit`/`delete`）对 `.git/config` / hooks 的写入**直接拒绝**
   （`SANDBOX_GIT_INTERNAL`），拒绝发生在候选生成之前；
1. **类别闸门**（纵深防御）：候选里仍出现 `other`/`transient` 类 ⇒ 整单 `SANDBOX_GIT_INTERNAL`；
2. **引用完整性**：解析「应用之后」的 `HEAD`（含符号引用）、全部 refs（松散 + `packed-refs`）、
   `index` v2/v3 的 blob OID；逐个确认对象存在（松散 → pack 索引 → `info/alternates` → 本批候选）。
   缺一个 ⇒ `GIT_REFERENTIAL_INTEGRITY`，一个字节都不写；
3. `index` v4（路径前缀压缩）暂不支持 ⇒ `GIT_INDEX_UNSUPPORTED`（拒绝，而不是猜）。

为什么必须有：`index` 只存 blob 哈希，内容在 `objects/**`。先写指针、后写（或漏写）对象
会得到 `fatal: unable to read <oid>`——仓库不可用，且不是 git 自己能修的。这比"少发布一个
文件"严重得多。

**原子组**：只要选中集合命中任何一个 `.git` 路径，`applyCandidate` 就把本候选里**全部**
`.git` 路径一起纳入（`git commit` 同时改 index + refs + logs，不能只应用一半）。逐文件
"取消勾选"在 `.git` 上不可用；语义与 NeoAI 的 `atomic_group="git"` 一致。

## 4. 命令守卫

`src/git-path.ts::findDestructiveGitCommand` + `executor.run()` 前置闸门，拒绝：
`gc` / `prune` / `prune-packed` / `repack` / `maintenance` / `filter-branch` / `filter-repo`。
它们会**删除或重写真实对象库**，而对象库是 junction——暂存层没有副本，也就无从回滚。

`git add/commit/checkout/reset/merge/rebase` 等**不拒绝**：它们的写入落在暂存树，经闸门
按对象→指针顺序发布。这一条与 NeoAI **有意不同**（NeoAI 拒绝全部变更子命令、只允许专用
git 工具）：本项目的 agent 直接跑 `git`，一刀切会打断正常开发；而我们已经有发布闸门与
原子组，风险由"发布前校验"承担，而不是"命令面禁写"。

子进程环境额外注入 `GIT_OPTIONAL_LOCKS=0`：避免 `git status` 的 index 刷新把暂存层变成
噪声来源（该变量只禁**可选**锁，`git add/commit` 需要的锁照常）。

## 5. 与 NeoAI 的对照

| 维度 | NeoAI | 本项目 |
|---|---|---|
| `.git` 读取 | overlay lower，读穿透 | 控制面复制；对象库 junction |
| 对象库 | 进暂存、按对象→指针发布 | junction（GB 级成本取舍） |
| 分类 | object / pointer / transient / other | 同 |
| 排序 | 对象 → 普通 → 指针 | 同 |
| 完整性闸门 | `GIT_REFERENTIAL_INTEGRITY` | 同（`checkGitIntegrity`） |
| 原子组 | `atomic_group="git"`，禁逐文件 | 选中任一 `.git` 即整组纳入 |
| 命令面 | 拒绝全部变更子命令 | 只拒绝破坏对象库的那一小撮 |
| 读工具 | 沙箱内执行 + `GIT_OPTIONAL_LOCKS=0` | 命令侧注入 `GIT_OPTIONAL_LOCKS=0` |

## 6. 已知边界（必须与任何"通过"一起读）

- `node_modules` / `.venv` / `.hg` / `.svn` 仍是 junction：写入直落真实盘，不经暂存。
  载荷往真实 `node_modules` 塞带 `postinstall` 的包，仍是残余通道。
- 子模块（`.git/modules/**`）不暂存：物化时跳过并记 `submodules-unsupported`。
- 工作树的 `.git` 是**文件**（`gitdir:` 指针）⇒ 回落到整棵 junction（`junction-worktree`）。
- **非 shim 档**（T1/T0）：`git commit` 在审批前把新对象写进真实对象库。这些对象在 refs
  指向它们之前是不可达的垃圾，`gc` 会回收；但"真实盘在审批前发生了变化"必须如实承认。
  **shim 档**（DSH 插件的 `tier:'auto'` 通常落在这里）：对象写入同样被垫片重定向，因而是
  `object` 候选的一部分，拒绝时不会在真实盘留下任何东西。
- `undo`（R46）按**路径**做快照，因此 `.git/index`、`.git/refs/**` 这些普通文件可以回滚；
  不在其中是**审批前已经写进真实对象库的对象**（非 shim 档）与注册表候选。
- 复制预算超限 ⇒ 回落 junction（`junction-budget`），此时 `.git` **不受暂存保护**；
  `materializeForExecution()` 的 `gitMode` 是唯一可信读数。

## 7. 验收

```powershell
node tests\git-path.ts        # 68 断言：分类/排序/危险命令（含嵌套解释器写法）
node tests\git-integrity.ts   # 22 断言：真实 index/pack/packed-refs/悬空引用/类别闸门/路径穿越
node tests\git-staging.ts     # 22 断言：控制面复制/对象库 junction/真实 index 不被改写/未变跳过
node tests\suite-wiring.ts    # 注册表 = verify.cmd = 磁盘文件
node tests\baseline-integrity.ts
```

`git-staging.ts` 里最关键的一条不是"复制成功"，而是：在暂存树里跑 `git status` 与
`git commit` 之后，**真实 `.git/index` 的字节哈希不变**——这是"VCS 元数据真的被暂存层
接管"的最小证据。
