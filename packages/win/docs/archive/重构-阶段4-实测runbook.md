# 阶段 4 · Windows 实测 Runbook

> 目的：在**真实 Windows** 里安装 `dsh-latest-windows-x64.exe`、加载重构后的
> `dsh-winstage-sandbox`，并按 `docs/round16/00-测试协议.md` 的五条判据验证
> 「写 → 暂存 → 分级审批 → 应用」全链路。
>
> **执行分工**（已与用户确认）：本沙箱的 `run_command` 被工具层导向
> `/run/neoai-docker/docker.sock`（不存在）⇒ 我**不能**直接跑 docker；
> 因此 **docker 编排命令由宿主执行**，我负责**生成 compose/脚本**、**给出判据**、
> **判读产物**。宿主 docker daemon 本身健康（用户 `docker ps` 正常）。

---

## 0. 前置（宿主终端）

```bash
# KVM / TUN：dockurr/windows 需要两者（缺 KVM 会退 TCG，极慢；缺 TUN 则 guest 网络受限）
ls -l /dev/kvm /dev/net/tun
# 缺失时（需要宿主 root + 有 /lib/modules）：
#   modprobe kvm_amd && ls -l /dev/kvm
#   modprobe tun     && ls -l /dev/net/tun

# 确认 ebk 宿主就绪
node /root/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs probe
```

> ⚠ 若 `/dev/kvm` 确实不可得：dockurr/windows 仍可跑但用 TCG 软件模拟，
> Windows 安装会到数小时级。用户已确认「可以等待」。

---

## 1. 生成 compose（可在我方生成，也可宿主生成）

用 ebk-compose skill（自包含，无需项目依赖）：

```bash
node /root/.config/opencode/skills/ebk-compose/scripts/ebk-compose.mjs \
  --os-id win11 --run-id winstage-refactor \
  --ram 8G --cpu 4 --disk 64G \
  --test-dir /root/code/dsh-sandbox-windows/.t/r17/win-shared \
  --oem-dir  /root/code/dsh-sandbox-windows/.t/r17/win-oem \
  --web-port 8066 --rdp-port 3390 \
  --username Docker --password admin --language en-US \
  --out /root/code/dsh-sandbox-windows/.t/r17/win11/docker-compose.yml
```

- `--test-dir` 挂到 guest 的 Samba `Z:` 共享（用于把**安装包、插件、验收脚本**送进去，
  并把**产物/证据**取回来）。
- `--oem-dir` 挂 `/oem`，可放 `install.bat` 自动安装。

---

## 2. 启动并等待就绪（宿主）

```bash
cd /root/code/dsh-sandbox-windows/.t/r17/win11
docker compose up -d
node /root/.config/opencode/skills/ebk-wait/scripts/ebk-wait.mjs \
  --container winstage-refactor --web-port 8066 --timeout-min 90 --boot-settle-sec 30
```

并行开录制（可选，ebk-capture）：

```bash
node /root/.config/opencode/skills/ebk-capture/scripts/ebk-capture.mjs \
  --url http://127.0.0.1:8066/ \
  --screenshots-dir .t/r17/win11/screenshots --video-dir .t/r17/win11 \
  --every-sec 60 --duration-sec 7200
```

---

## 3. Guest 内准备（经 Samba `Z:` 或 RDP/Web 控制台）

把以下内容放进 `--test-dir`（宿主即可，guest 从 `Z:` 读到）：

1. `dsh-latest-windows-x64.exe`：
   ```bash
   curl -L -o /root/code/dsh-sandbox-windows/.t/r17/win-shared/dsh-latest-windows-x64.exe \
     https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe
   ```
2. 重构后的插件包（把当前工作树打包；注意 `.git` 不可提交不影响打包）：
   ```bash
   cd /root/code/dsh-sandbox-windows
   tar --exclude=node_modules --exclude=.t --exclude=shim/out -czf \
     .t/r17/win-shared/dsh-winstage-sandbox.tgz .
   ```
3. 验收脚本 `verify.ps1`（见 §4）。

Guest 内（管理员 PowerShell）：

```powershell
# 安装 dsh
Start-Process -Wait "Z:\dsh-latest-windows-x64.exe" -ArgumentList "/S"
# 解包插件
mkdir C:\winstage -Force; tar -xzf Z:\dsh-winstage-sandbox.tgz -C C:\winstage
```

---

## 4. 验收（五条判据）与 `verify.ps1`

判据取自 `docs/round16/00-测试协议.md`：

| # | 判据 | 读法 |
|---|---|---|
| 1 | loader 无告警 | `stderr.txt` **0 字节** |
| 2 | 暂存面在工作 | 暂存根含沙箱写出的文件 + `candidates\*.json` |
| 3 | 真实工作区零污染 | 真实工作区只有预放种子 |
| 4 | **lane 真的是 TS** | `sandbox-lane.json` 的 `degraded===false` 且 `tierEffective==='TS'` |
| 5 | **隔离只能由宿主侧读数判** | 沙箱内的 `Test-Path` 不得自证；须**沙箱外**对真实盘取前后读数 |

`verify.ps1` 骨架（写入 `Z:\`，与插件一起）：

```powershell
$ErrorActionPreference = 'Stop'
$ws  = 'C:\winstage-ws'          # 真实工作区
$out = 'Z:\r17-out'
New-Item -ItemType Directory -Force $ws,$out | Out-Null
Set-Content "$ws\seed.txt" 'SEED'

# 判据3 前读数（沙箱外）
Get-ChildItem -Recurse $ws | Select-Object FullName,Length | Out-File "$out\ws-before.txt"

# 起一个 headless dsh 沙箱线程：让它写一个工作区文件
#   提示词要求：写 staged-probe.txt；把读数写进最终回答；不要提任何问题
$prompt = 'Create a file named staged-probe.txt in the workspace with content HELLO. Do not ask any questions. Then print the workspace listing.'
$env:WINSTAGE_SHELL = '1'
dsh --profile web --json - 2> "$out\stderr.txt" > "$out\stdout.json" <<< $prompt

# 判据3 后读数（沙箱外）
Get-ChildItem -Recurse $ws | Select-Object FullName,Length | Out-File "$out\ws-after.txt"
# 判据1
"stderr bytes = " + (Get-Item "$out\stderr.txt").Length | Out-File "$out\judge.txt" -Append
# 判据4：lane
Get-Content 'C:\winstage-stage\dsh-host\**\sandbox-lane.json' -ErrorAction SilentlyContinue |
  Out-File "$out\lane.txt"
```

> 判据 2/4 的具体清单键名以本仓既有实测为准（见 `docs/round16/*-报告.md` 的读数格式）。

---

## 5. 取回产物（宿主）

```bash
node /root/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs collect \
  --container winstage-refactor \
  --test-dir /root/code/dsh-sandbox-windows/.t/r17/win-shared \
  --artifacts-dir /root/code/dsh-sandbox-windows/.t/r17/artifacts
```

清理：

```bash
node /root/.config/opencode/skills/ebk-environment/scripts/ebk-env.mjs cleanup \
  --compose-file /root/code/dsh-sandbox-windows/.t/r17/win11/docker-compose.yml \
  --storage-dir  /root/code/dsh-sandbox-windows/.t/r17/win11/storage \
  --run-dir      /root/code/dsh-sandbox-windows/.t/r17/win11
```

---

## 6. 我方（沙箱）负责的判读

宿主执行上述命令后，把 `.t/r17/artifacts` 与 `r17-out` 交回；我据此：

1. 核对判据 1/3/4（字节数、前后清单 diff、lane 字段）；
2. 判据 2：清点暂存树木与 `candidates\*.json`；
3. 判据 5：只认**沙箱外**读数，沙箱内 `Test-Path` 一律不作隔离证据；
4. 出 `docs/archive/重构-阶段4-实测报告.md`，逐条给原始文件路径与判读结论；未跑到的一律写 `not-run`。

---

## 7. 兜底（宿主也缺 KVM 时）

apt 有 `qemu-system-x86`（10.0.13）；宿主已有 37GB Windows GPT 镜像 `/home/windows/data.img`
与 Win11 中文 ISO。可用宿主 QEMU（TCG）直接起该镜像，跳过 docker/ebk：

```bash
apt-get install -y qemu-system-x86 qemu-utils
qemu-system-x86_64 -m 8G -smp 4 -accel tcg \
  -drive file=/home/windows/data.img,format=raw,if=virtio \
  -netdev user,id=n0,hostfwd=tcp::3390-:3389 -device virtio-net-pci,netdev=n0 \
  -vnc :1 -snapshot
```

（`-snapshot` 保证宿主原始镜像不被写坏；RDP 经 3390 进入。）
