# 合并记录（MERGE-NOTES）

本仓由两个独立仓库合并而成，**保留两者全部 git 历史**（`git-filter-repo --to-subdirectory-filter`
把各自内容移入子目录后再 `merge --allow-unrelated-histories`）。因此 commit 哈希被重写。

## 源 → 合并后哈希映射

| 源仓库 | 源 HEAD（合并前） | 合并后等价 HEAD |
|---|---|---|
| `/root/code/dsh-sandbox-windows`（`dsh-winstage-sandbox`） | `42ce094494ac2440d9e0144be9fab7a773f7db05` | `7bd05a2bed217fea559fb0f28f4c4680a4da9c61`（→ `packages/win`） |
| `/root/code/dsh-sandbox-linux`（`dsh-sandbox-linux` v0.2.0 / v2.3） | `d6a598581111ca6039d6fac5bfbda2ac2cbf403f` | `282bc4b841bb9454f126b8eb47d9b7cd7bab1ad7`（→ `packages/linux`） |
| （合并提交） | — | `52f8cc81aa088add6b64d2643415258671758012` |

## 合并方式

```bash
git clone <A> win && git clone <C> linux
git -C win   filter-repo --to-subdirectory-filter packages/win   --force
git -C linux filter-repo --to-subdirectory-filter packages/linux --force
git init /root/code/dsh-sandbox
git fetch <win>   && git checkout -b master FETCH_HEAD        # A 历史
git fetch <linux> && git merge --allow-unrelated-histories FETCH_HEAD
```

## 未入库资产（`filter-repo` 只带已提交内容）

以下被原 `.gitignore` 排除、但被测试/文档引用，已**文件系统级拷入**（仍 gitignore，不入库）：

| 路径（`packages/win/`） | 来源 | 体积 | 理由 |
|---|---|---|---|
| `shim/out/` | A | 13M | 已构建的 `winstage-shim.dll` 等；否则 TS lane 需重装 zig 工具链重建 |
| `tools/toolchain/` | A | 526M | zig 工具链；避免重新下载 |
| `esc/`、`filemod/` | A | 70M / 1.3M | `docs/实测证据记录.md`、`filemod` 报告直接引用 |
| `packages/win/node_modules/`、`packages/linux/node_modules/`、`dist/` | A/C | — | 由 `pnpm install` / 构建重建 |

**未搬运**（按整理决策放弃；如需可回溯原目录）：
A 的 `.t/`（17G 运行期证据）、`.dshstage/`（2G 暂存现场）、`_sandbox-tests/`、`_r3/`、`.lead/`、
`retest/`、`.recon/`；C 的 `ebk/container-artifacts/` 等运行产物（`ebk/artifacts/RESULT_linux_host.json` 已入库）。

> 原目录 `dsh-sandbox-windows` / `dsh-sandbox-linux` / `dsh-sandbox-windows-refactor` 已按计划删除。
> A 的 GitHub 远端（`gygygfg/dsh-winstage-sandbox`）未带入本仓；如需推送，请新加 remote 并注意历史已重写。

## 空壳 `dsh-sandbox-windows-refactor`

该目录**不是 git 仓、0 个真实文件**，仅含 4 个指向 A/C 的符号链接（`node_modules`、`.t`、
`shim/out`、`tools/toolchain`）。判定为未填充的脚手架，已删除。
