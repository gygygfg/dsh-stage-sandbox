# e2e/windows —— Windows E2E 运行手册

面向宿主执行 `tools/ebk-sandbox-test.ts` 的实操说明与踩坑记录（全部 `[实测]`）。

## 0. 前置

```bash
ls -l /dev/kvm /dev/net/tun           # 缺 KVM 会退 TCG（数小时级）
node /root/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs probe
```

## 1. ISO 与网络（**关键坑**）

- dockurr 默认从 Microsoft 下载 ISO。**本机 IP 会被拦截**：
  `ERROR: Microsoft blocked the automated download request based on your IP address.`
  之后它仍打印 "Downloading Windows 11..." 但会长期停滞。
- **可行路径 = 本地 ISO**。dockurr `detectCustom`（`/run/install.sh:1287`）优先认
  `custom.iso` / `boot.iso`，命中即**完全跳过 VERSION 解析与下载**。
  `--iso <file>` 就是把该文件硬链接成 `<storage>/custom.iso`。
- 注意：给 `VERSION` 传本地 ISO 的文件名**不生效**（`Invalid VERSION specified`）；
  必须是 `custom.iso` 这个**固定名**。

## 2. 复用既有镜像（更快，但注意 OEM 钩子）

- 宿主 `/home/windows/data.img` 是一份已装好的 Win11；`--storage /home/windows` 可秒起。
- **但** `/oem/install.bat` 只在 **Windows 安装阶段**执行（Autounattend FirstLogonCommands），
  复用已装好的盘**不会**再触发它 ⇒ `bootstrap.ps1` 不会自动跑。
  要全自动，必须**新装**（本流程默认新装到独立 storage）。
- 复用镜像时需要手动在 guest 内跑 `bootstrap.ps1`（经 Samba `Z:` / RDP）。

## 3. guest 引导

`/oem/install.bat` 在首次进桌面时被 dockurr 调用 → 读共享里的 `run.env` → 跑
`bootstrap.ps1`：建工作区 + 前读数 → 装 DSH → `dsh plugin add` → 起 `dsh web` →
写 `dsh-web-url-<run>.txt` → 等宿主 `driver-done-<run>.txt` → 后读数 + lane + RESULT。

## 4. 已知环境事实

| 事实 | 影响 |
|---|---|
| `dsh --profile desktop web` 报 `profile "desktop" is managed exclusively by the Electron application` | 只能 `--profile web` 起 web GUI |
| 插件 shim 的 `winstage-shim.dll` 需本机 zig 构建；发行包只带 C 源码 | 未构建时 lane 会**降级为 T1**（判据4 为红，如实记录） |
| `sandbox-policy.workspaceRoot` 已从 `process.env.WINSTAGE_SBX_WORKSPACE` 改为 profile 配置 | round10 的 `sbx-thread.cmd` 配方**已过期**（本仓的 env 注入不再被读） |
| `USER_PORTS` 由 ebk-compose 不发射 | 本流程在生成后补写（见 `lib/ebk.ts::patchUserPorts`） |

## 5. 产物

`artifacts/<runId>/{screenshots,dom,report}`；guest 经共享回写的 `ws-before/after-*.json`、
`lane-*.json`、`stage-root-inventory-*.json` 由 `collect` 取回 `artifacts/logs|collected`。
