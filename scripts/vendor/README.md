# `scripts/vendor/` —— 私有依赖的本地引导

## 问题

本仓三个包都依赖 `@deepseek-ai/*`，而这些包**不在公共 registry**
（实测 `registry.npmjs.org` 与 `registry.npmmirror.com` 均 404）。于是 `pnpm install`
在依赖图的第一步就失败，连带 `pnpm -r typecheck` 与 `prepare`（构建 `dist/`）都跑不了。

可用的实体在本机 DSH 桌面端的安装目录里：

```
%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar
  └─ dsh/node_modules/@deepseek-ai/   共 289 个包
```

## 解法：把"备齐依赖"变成安装流程的一环

```
pnpm install
  └─ preinstall: node scripts/vendor/bootstrap.mjs
       ├─ .dsh-vendor 已有包？→ 跳过（幂等）
       ├─ 否则 → asar-extract.mjs   从 app.asar 提取依赖闭包 → .dsh-vendor/node_modules
       └─ make-overrides.mjs        建 4 个占位包 + 重写 pnpm-workspace.yaml 的 overrides 段
```

因此**新机器上的完整流程就是一条命令**：装好 DSH 桌面端 → `pnpm install`。

## 文件

| 文件 | 作用 |
|---|---|
| `bootstrap.mjs` | 引导入口（挂在根 `package.json` 的 `preinstall`）。幂等；`--force` 强制重建 |
| `asar-extract.mjs` | 从 `app.asar` 按**依赖闭包**提取 `@deepseek-ai/*`（只读 asar，只写 `.dsh-vendor/`） |
| `make-overrides.mjs` | 建 4 个占位包 + 生成 `pnpm-workspace.yaml` 的 overrides 段（内容无变化时不写文件） |
| `asar-probe.mjs` | 诊断探针：确定 asar 的偏移基址公式。**不在引导链路上** |

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_APP_ASAR` | 指定 `app.asar` 路径（默认按 `%LOCALAPPDATA%\Programs\DeepSeek Harness\…` 等候选自动探测） |
| `DSH_VENDOR_SKIP=1` | 跳过引导（例如你已有内网 registry） |

## 诚实声明

- **占位是按需推导的，不是固定名单**：`make-overrides.mjs` 逐个检查 vendor 里的包
  （`package.json` 存在、且其声明的入口文件确实在盘上），只有**确实没有实体**的才建占位。
  目前只有 `dsh-approval` 一个 —— asar 与 `app.asar.unpacked` 里都没有它。
  占位包被真实引用时，运行期立刻报错、tsc 报 TS2307，**不会静默假绿**。
- ★ **不要用固定名单建占位**（实测教训）：旧版无条件把 4 个包写成占位，而其中
  `dsh-bash-local` / `dsh-bash-sandbox` / `node-addon-system` 在 asar 里**有真实实体**，
  于是它们的 `lib/index.js` 被占位内容覆盖，`packages/linux/src/shell/staged-shell.ts`
  的 `class StagedShellExecutor extends SandboxBashExecutor` 拿到 `undefined`，
  vitest 直接 `Class extends value undefined` 挂掉两个 spec。
  占位是没有实体时的退路，**不能反过来销毁实体**。
- **`.dsh-vendor/` 不入库**（gitignore）：体积大、平台相关、可随时重建。
- `pnpm-workspace.yaml` 里 `# --- BEGIN/END LOCAL VENDOR OVERRIDES ---` 之间是**脚本生成区**，
  不要手改 —— 改了会在下次 `preinstall` 被覆盖。
- `pnpm-lock.yaml` **入库**：overrides 用的是相对 `file:` 路径，只要 bootstrap 跑过，
  锁文件就是可复现的。安装时若报 "local dependency is outdated"，加 `--no-frozen-lockfile`
  或重新跑一次 bootstrap。

## 如果将来拿到内网 registry

1. 删掉 `pnpm-workspace.yaml` 的 overrides 段；
2. 删掉根 `package.json` 的 `preinstall`；
3. 仓库根加 `.npmrc`：`@deepseek-ai:registry=<内网源>`；
4. 删掉本目录。
