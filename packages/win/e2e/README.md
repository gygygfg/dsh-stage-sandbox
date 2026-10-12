# e2e —— Windows 沙箱端到端测试台（收敛自历史散落脚本）

本目录把此前散落在 `_r3/`、`_sandbox-tests/`、`.t/dsh2`、`.t/boundary-dsh`、`.t/r17`、
`tools/win-gui/` 的一次性脚本，收敛成**一份可复跑、受版本控制、受治理**的测试台，
并把「用 ebk 起 Windows 环境 → 装 DSH → 载入插件 → 测沙箱 → 截屏 + 存 DOM」的整条流程
固化成 `tools/ebk-sandbox-test.ts`（Windows 宿主另给 `tools/ebk-sandbox-test.cmd`）。

> 与 `tests/` 的分工（**重要**）：`tests/` 是**离线确定性关口**（`verify.cmd` / `autotest`），
> 必须能在无 docker、无 Windows 的任何会话里跑绿。本目录的 E2E 需要 **docker + KVM + Windows guest**，
> 因此**不进 `verify.cmd`**，由 `tools/ebk-sandbox-test.ts` 单独驱动。

## 目录

| 路径 | 内容 | 语言 |
|---|---|---|
| `lib/cdp.ts` | 零依赖 CDP 客户端（Node 全局 WebSocket） | TS |
| `lib/web-gui.ts` | Playwright 驱动：截图 / 整页 outerHTML / 可访问性(AX) | TS |
| `lib/panel-dom.ts` | 「暂存待审」面板的结构化提取 + AX 裁剪 | TS |
| `lib/artifacts.ts` | 运行目录、`RESULT_*` 标记、sha256、JSON 落盘 | TS |
| `lib/ebk.ts` | ebk 技能封装（probe/compose/wait/capture/collect/cleanup）+ USER_PORTS 补丁 | TS |
| `guest/` | **入 guest 的载体脚本**：`install.bat`(OEM 钩子)、`bootstrap.ps1`、`verify.ps1` | BAT/PS1（**保持原语言**） |
| `domains/` | 历史 8 域实测脚本与报告的归档（见 `domains/README.md`） | 混合（见下） |
| `windows/` | 运行手册与 compose/配置说明 | MD |
| `artifacts/<runId>/`（运行时） | 截图 / DOM / AX / 报告 / 收集到的 guest 产物 | — |

## 怎么跑

```bash
# 宿主：需要 docker + /dev/kvm + /dev/net/tun（先 ebk probe）
node /root/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs probe

# 预演：只生成 compose 不启动
node tools/ebk-sandbox-test.ts --os-id win11 --run-id r1 \
  --iso /path/to/Win11.iso --storage .t/ebk/win11-r1-storage --dry-run

# 实跑（本地 ISO，避免 IP 拦截导致的下载失败）
node tools/ebk-sandbox-test.ts --os-id win11 --run-id r1 \
  --iso /path/to/Win11.iso --storage .t/ebk/win11-r1-storage \
  --keep --language Chinese --wait-timeout-min 120 --test-timeout-min 60
```

关键参数：

| 参数 | 说明 |
|---|---|
| `--iso <path>` | 本地 Windows ISO。会以 **`custom.iso`** 硬链接进 `--storage`；dockurr 的 `detectCustom` 优先认它，**完全跳过网络下载**（本机 IP 被 Microsoft 拦截时这是唯一可行路径）。 |
| `--storage <dir>` | 磁盘镜像目录（默认 `<workdir>/storage`）。`--keep` 时保留以便复跑。 |
| `--attach` | 复用已存在的容器（配 `--keep`），只重跑宿主驱动。 |
| `--keep` | 不 teardown，容器与 storage 保留。 |
| `--dsh-exe <exe>` | DSH 安装包（默认取 `.t/r17/win-shared/dsh-latest-windows-x64.exe`）。 |

## 流程（`tools/ebk-sandbox-test.ts`）

`probe → 准备共享/插件(npm pack) → 生成 compose(+USER_PORTS) → up → wait ready →
并发 noVNC 录制 → 旅客机 bootstrap（装 DSH+插件+起 dsh web+前后真值读数）→
宿主 Playwright 取面板 DOM/截图/AX 并驱动审批 → 等 RESULT 标记 → collect → cleanup → 报告`

## 判据（`docs/round16/00-测试协议.md`）

| # | 判据 | 本流程的读法 |
|---|---|---|
| 1 | loader 无告警 | 旅客机 `dsh-web-<run>.log` / `<out>/stderr.txt` |
| 2 | 暂存面在工作 | `stage-root-inventory-<run>.json` 含沙箱写出的文件 + `candidates/*.json` |
| 3 | 真实工作区零污染 | `ws-before-<run>.json` vs `ws-after-<run>.json` 差集为空 |
| 4 | lane 真的是 TS | `lane-<run>.json` 的 `degraded===false && tierEffective==='TS'` |
| 5 | 隔离只由沙箱外读数判 | 前后读数由**旅客机内不在 WinStage 沙箱里**的 PowerShell 取；宿主 DOM/截图仅作渲染证据 |

> 判据 4/5 是**致命判据**：前三条全绿也可能已静默降级（见 `docs/round16/00-测试协议.md`）。

## 渲染证据（截图 + DOM + AX）

宿主 Playwright 对每个状态各落三份：`artifacts/screenshots/<name>.png`、
`artifacts/dom/<name>.html`（整页 `document.documentElement.outerHTML`）、
`artifacts/dom/<name>.panel.json` + `<name>.ax.json`（面板结构 / 可访问性）。
状态点：`00-initial`、`01-new-session`、`02-after-prompt`、`03-selected`、`04-after-approve`。

## 语言政策（诚实声明）

- **JS 家族一律 TS 化入库**：`lib/*.ts`、`tools/ebk-sandbox-test.ts`，以及 `domains/` 下由 `.mjs` 收编的探针。
- **`guest/` 下的 PowerShell / CMD 保持原语言**：它们是**旅客机内的载体**，必须在 guest 上执行，
  TS 化没有意义。这是刻意的例外，不是遗漏。
- `domains/` 下由 `.js` 收编的探针改名 `.cjs`（它们本是 CommonJS；在 `type:module` 包里
  `.js` 会被当 ESM 而 require 直接抛错，改 `.cjs` 是**修复**）。
- `.ps1` / `.py` 探针保持原语言入库。

## 治理

- 新增/删除本目录的 `*.ts` 会改变**源码封印**（`docs/源码基线.sha256`，见 `tools/baseline-sha256.ts`
  的 `INCLUDED_GLOBS`）。改完跑 `node tools/baseline-sha256.ts --write` → 复核清单 diff → `--check`。
- `tests/suite-wiring.ts` 管的是 `tests/`；本目录的收录面由 `e2e/README.md` 与封印共同兜底。
