# Windows E2E 实测 · 缺陷与发现（win11）

> 轮次：整理轮（测试套件整理 + E2E 测试流程脚本）
> 环境：宿主 docker 28 + dockurr/windows v5.14 + QEMU 10.0.6 + `/dev/kvm` + Win11 25H2 中文 ISO
> 证据分层：`[实测]` = 真的跑出该结果；`[未实测]` = 未取得运行期证据。

## 0. 结论速览

本轮把整条流程（ebk probe → compose → up → wait → 旅客机装 DSH/插件/起 web → 宿主取 DOM/截图）
写成了可复跑脚本 `tools/ebk-sandbox-test.ts`，并**实际拉起 win11、装好 DSH、成功 `dsh plugin add`**。
但**端到端自动跑通被两个环境阻塞挡住**（见 B1/B2），且旅客机无人值守引导暴露出 **5 个真实脚本缺陷（已全部修复）**。

| # | 类型 | 一句话 | 状态 |
|---|---|---|---|
| B1 | 环境阻塞 | 默认走 Microsoft 下载 ISO ⇒ **本机 IP 被拦** | 绕过：本地 ISO 作 `custom.iso` |
| B2 | 环境阻塞 | dockurr 的无人值守应答文件**对这份中文 custom ISO 不生效** ⇒ 落到手动安装界面（产品密钥） | `[实测]` 未解决（见证据截图） |
| F1 | 缺陷（已修） | `install.bat` 子串语法 `%%A:~0,1%` 多了结尾 `%` ⇒ 钩子执行到第一行就停 | ✅ |
| F2 | 缺陷（已修） | `bootstrap.ps1` 起 `dsh web` 的嵌套引号生成**无效路径**（`Out-File` IOException） | ✅ |
| F3 | 缺陷（已修） | `bootstrap.ps1` 的 `SaveJson` 用 `Set-Content -Encoding utf8` **写 BOM** ⇒ 宿主 `JSON.parse` 会炸 | ✅ |
| F4 | 缺陷（已修） | 单元素数组经 `ConvertTo-Json` 变成对象 ⇒ 前后读数不是数组，污染比对不可靠 | ✅ |
| F5 | 缺陷（已修） | 控制台自动化在本 guest **不可靠**：中文 IME 劫持按键；后续会话按键到不了 VM | ⚠ 记录 |
| F6 | 缺陷（已修） | `tools/win-gui/run.cmd` 含非 ASCII ⇒ `suite-wiring`（R11）判红（**整理前既有**） | ✅ |
| F7 | 缺陷（已修） | `dsh-plugin/client.ts` 的 `danger` 样式对象有**重复 `background` 键**（esbuild 警告） | ✅ |
| F8 | 文档漂移 | round10 的 `sbx-thread.cmd` 仍设 `WINSTAGE_SBX_WORKSPACE`，而现源码**已不读**该变量 | ⚠ 记录 |
| F9 | 缺陷（已修） | 两个 `.ts` 测试里残留 `.mjs` 断言/正则（`dsh2-shell-fallback-verify`、`registry-conformance`） | ✅ |
| P1 | 正例 | 旅客机内 **DSH 安装成功**、`dsh plugin --profile web add` **exit=0**、暂存根/工作区读数落盘 | ✅ |

## 1. 证据

| 证据 | 路径 |
|---|---|
| 手动安装界面（产品密钥）截图 | `.t/ebk/r1/artifacts/install-manual-productkey.png` |
| dockurr 识别本地 ISO 并构建镜像 | `docker logs win11-r1`（"Extracting local ISO image… Detected: Windows 11 Pro (Chinese)"） |
| 复用镜像启动到桌面（自动登录，Samba 已映射） | `.t/ebk/peek2/final.png`、`.t/ebk/peek3/*.png` |
| DSH 已装 + 插件 add 成功 + web 启动失败原文 | `.t/ebk/reuse/shared/bootstrap-console.log`、`bootstrap-reuse.log` |
| 工作区前读数（单对象形态＝缺陷 F4 现场） | `.t/ebk/reuse/shared/ws-before-reuse.json` |

## 2. 细节

### B1 · Microsoft 下载被 IP 拦截 `[实测]`
```
❯ Requesting Windows 11 from the Microsoft servers...
❯ ERROR: Microsoft blocked the automated download request based on your IP address.
```
**绕过**：把本地 ISO 放进 storage 并命名 **`custom.iso`**（dockurr `/run/install.sh:1287`
`detectCustom` 优先认它，命中即跳过 VERSION 解析与下载）。`--iso` 即做这件事。
> 注意：给 `VERSION` 传 ISO 文件名**不生效**（`Invalid VERSION specified`）。

### B2 · 无人值守应答文件对中文 custom ISO 不生效 `[实测]`
即使 dockurr 打印 "Adding win11x64.xml for automatic installation…"，安装仍停在**手动产品密钥页**
（见证据截图）。⇒ **本机无法用这份中文 ISO 做全自动新装**。
可选出路（均 `[未实测]`）：换 dockurr 原生支持的版本/语言 ISO；或走 `VERSION_URL`（网络需通）；
或复用宿主既有的 `/home/windows/data.img` 已装镜像（见下）。

### F5 · 控制台自动化不可靠 `[实测]`
复用已装镜像时 `/oem/install.bat` 不会重跑，只能经 noVNC 控制台手动拉起 bootstrap。实测：
① 中文 IME 会把 ASCII 按键变成拼音候选（截图 `.t/ebk/peek3/after-type.png` 可见候选条）；
② 后续会话里 `page.keyboard` 的按键**不再进入 VM**（`whoami` 也没回显）。
⇒ 结论：**guest 侧自动化不能依赖 noVNC 打字**；应让 dockurr 在安装期自动跑 OEM 钩子（需 B2 解决），
或在镜像里预置"开机自启脚本"。

### F1–F4 · 旅客机脚本缺陷（已修）`[实测]`
- F1：`if not "%%A:~0,1%"=="#"` → `%%A:~0,1`（结尾 `%` 使整条批处理中止，故钩子只写了表头）。
- F2：`Start-Process cmd.exe -ArgumentList "/c \"\"$dshCmd\" … > \"$webLog\""` 生成无效路径；
  改为**生成 `dshweb-<run>.cmd`** 承载重定向（cmd 可把 stdout 重定向到 UNC 路径）。
- F3/F4：见上表。

### F6–F9
- F6：`tools/win-gui/run.cmd`（已迁 `e2e/guest/run-win-gui.cmd`）非 ASCII ⇒ R11 判红；改为纯 ASCII 注释。
- F7：`dsh-plugin/client.ts:1460/1465` 重复 `background`；删其一。
- F8：`docs/round10/env/scripts/sbx-thread.cmd` 仍导出 `WINSTAGE_SBX_WORKSPACE`，而源码已用它作 profile 配置来源之外的死键。
- F9：`tests/dsh2-shell-fallback-verify.ts`、`tests/registry-conformance.ts` 的 `.mjs` 断言改为 `.ts`。

## 3. 仍未提供的保证（如实声明）

- **本机端到端未跑通**：因 B2 + F5，未取得「面板出现 → 批准 → 真实落盘」的端到端证据；
  面板 DOM/截图驱动（`e2e/lib/web-gui.ts` + `panel-dom.ts`）**已就绪但未在真实会话上触发**。
- lane 判据（4）未读取：因 web 未起来。
- 复用镜像的 `data.img` 为宿主既有资产，本轮**只读式启动**、未做破坏性写入。
