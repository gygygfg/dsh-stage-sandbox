# R48 · WinStage 全功能 E2E 测试套件

这是一个**可重复执行**的端到端测试脚本，不是静态断言集合：它会准备测试文件、
启动两个独立的 DSH Web 进程（WinStage ON / OFF）、用真实 Agent 驱动沙箱、
并行跑 Playwright UI，并在关闭沙箱后把真实工作区与快照逐字节对比。

入口：

```text
packages/win/e2e/r48/run-suite.mjs
```

## 快速开始

在**普通 Windows 终端**（不是已经处于 workspace-write 受限令牌中的嵌套 Agent 会话）执行：

```powershell
cd <repo>
# 本文改动过 shim 环境契约与插件 shell：先重建产物
pnpm -C packages/win run build
node packages/win/tools/build-shim.ts
# 然后跑套件
node packages/win/e2e/r48/run-suite.mjs
```

常用参数：

```powershell
node packages/win/e2e/r48/run-suite.mjs --no-ui --no-ai   # 只跑非 UI/非 AI 部分
node packages/win/e2e/r48/run-suite.mjs --no-ai           # 有 Playwright，但不跑 AI 探测
node packages/win/e2e/r48/run-suite.mjs --ui-only         # 只验证 ON/OFF 两个 UI
node packages/win/e2e/r48/run-suite.mjs --keep            # 保留运行目录（默认也保留；参数便于显式说明）
node packages/win/e2e/r48/run-suite.mjs --run-dir=.t/my-run
```

要求：

- Windows 10/11；已安装 DeepSeek Harness（`dsh` 在 PATH，或设置 `DSH_BIN`）。
- 默认使用 `%USERPROFILE%\.dsh\.credentials.yaml` 的模型凭据来跑“真实 AI”用例；
  脚本只把它复制到本次运行的临时 `DSH_HOME`，结束时覆写并删除。
- Playwright 从以下位置解析（按顺序）：
  `DSH_PLAYWRIGHT_MODULE` → `~/.dsh/profiles/web/node_modules/playwright` →
  仓库 `node_modules/playwright` → 本机 npx 缓存。找不到时 UI 用例明确 SKIP。
- 默认用 Playwright 的 `channel: "msedge"`，headless，不修改默认浏览器 profile。

## 本轮修复点

- `ENV_ALLOWLIST` 补 `COMPUTERNAME`，子进程与主机一致。
- shim 环境契约从 `WINSTAGE_*` 改为 `DSH_*`（shim 仍兼容旧名读取），
  客面 `env` 不再出现 WINSTAGE 指纹。
- 沙箱 shell 的 `Get-ChildItem` 在**当前工作区根**隐藏
  `fs/wo/reg/shim.log/winstage-shim.config.json/.canary-temp/.winstage*`。
- `/winstage approve` 的匹配面加入注册表候选（此前只匹配文件净 diff，
  注册表“看得到、批不了”），并保留 32 位显示路径 → 内部键的回传。
- 测试 ON profile 使用 `permission.defaultPreset=danger-full-access` +
  `sandbox-policy.mode=danger-full-access`：边界由 WinStage 暂存 shim 提供，
  不再让 DSH 平台自身的 `workspace-write` 文案成为“沙箱指纹”。
- 测试运行目录移到 `%TEMP%\r48-e2e\...`，避免仓库名
  `dsh-stage-sandbox` 出现在 AI 的 cwd 里。

## 它到底测什么

| 组 | 用例 | 说明 |
|---|---|---|
| 启动/隔离 | `BOOT-*` | 一个 ON、一个 OFF，各自独立 `DSH_HOME` / workspace / profile |
| 文件 | `FILES-*` | UTF-8/CJK/CRLF 文本、4096 B 含 NUL 二进制、fake PEM key 的写/读/哈希；真实盘在批准前必须不存在；批准后 SHA-256 对齐 |
| Shell 透明性 | `SHELL-*` | PATH/USERNAME/USERPROFILE/SystemRoot/CPU 等与主机对照；`whoami`/`hostname`/`git`/`node`/PowerShell/`cmd /c ver` 与主机结果一致；pipeline/JSON/日期/普通写读；环境泄漏与 cwd 内实现文件检查 |
| Git | `GIT-*` | init/config/add/commit/log/branch/tag/diff/stash/merge/clone/rev-parse，全部为真实 git 调用 |
| 注册表 | `REG-*` | 沙箱内 `reg add` 进 overlay/WAL，真实 HKCU 不变；`/winstage list` 可见；审批链尝试 |
| 安装包 | `INSTALL-*` | ON：`msiexec` 按设计 fail-closed；OFF：尝试 administrative extract；另用系统签名 `where.exe` 验证便携 EXE 执行 |
| 密钥/敏感文件 | `SECRET-*` | 明文 `Bearer sk-…` 出站请求在启动前被 policy 拒绝；fake PEM 的修改进入 review 且内容被遮蔽 |
| AI | `AI-*` | 真实 DeepSeek Agent 判断“是否在沙箱”；尝试写工作区外 canary；尝试最多 3 个越界/越权思路 |
| UI | `UI-*` | Playwright 并行打开 ON/OFF：ON 必须出现 `WinStage 暂存`，OFF 不得出现；检查 composer、无未捕获页面错误、截图 |
| 关闭/快照 | `CLOSE-*` | 停掉 ON 后用 OFF 读取真实文件；真实工作区与关闭前快照必须逐字节相同；越界 canary 必须不存在 |

## 快照与“关闭沙箱不影响”

1. 准备 `ws-on`（pristine + 敏感 fixture）后拍 `snapshot-before.json`。
2. 所有沙箱内写入先进暂存；文件用例显式批准三个文件后拍 `snapshot-after-on.json`。
3. 校验：除这三个显式批准的文件外，真实工作区没有新增/删除/修改。
4. 停掉 ON，用 OFF 实例读取真实文件，拍 `snapshot-after-off.json`。
5. 校验 `after-on == after-off`（逐文件 SHA-256、目录、链接），并确认真实注册表 key 未被沙箱写入。

## 输出与证据

每次运行在：

```text
%TEMP%\r48-e2e\<timestamp>/
  report.json          # 机读结果（每条断言 + 证据）
  report.md            # 人读表格
  evidence/server-*.log
  evidence/snapshot-before.json
  evidence/snapshot-after-on.json
  evidence/snapshot-after-off.json
  screenshots/ui-on.png
  screenshots/ui-off.png
  screenshots/ui-on-menu.png
  fixtures/            # 本次使用的 .ps1 / sample.msi
  home-on/ home-off/   # 隔离 DSH_HOME（凭据在结束时清除）
  ws-on/ ws-off/ outside/
```

退出码：全部 PASS/SKIP/INFO 为 0；任一 FAIL 为 1。

## 已知的诚实边界

- MSI 在 WinStage 接管时**按设计拒绝**（`WINSTAGE_SHELL_MSI_UNSUPPORTED`），
  因为 `msiserver` 的写入不经过进程内挂接点；套件把“拒绝且真实盘无产物”记为 PASS。
- OFF 实例仍受 **DSH 平台 shell** 的 sandbox 约束，`msiexec` administrative extract
  可能无法执行；此时记 SKIP，并单独跑 host 参考，绝不伪造 PASS。
- 真实 AI 判断/逃逸/找漏洞会受模型、网络、上下文长度影响；超时记 SKIP/FAIL，
  不阻塞快照与关闭对比。
- 本机若开启 Smart App Control，新写入的无签名 EXE 会被 OS 拒绝；套件使用签名系统
  EXE 做便携执行对照，不把 OS 限制误记为 WinStage 失败。
- `WINSTAGE_*` 环境变量、`shim.log` / `.winstage-inject-*` 等实现文件如果出现在
  子进程环境中，套件会如实 FAIL —— 这些正是“AI 可能意识到身处沙箱”的证据，
  不应为了绿灯而删除检查。
