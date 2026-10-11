# D2 缺陷与异常清单（pip / node 包安装 · 国内镜像 · 安装后完整性）

> 轮次：R11 · 域：`t2-pkgs`（task-2）· 实测时间 2026-10-10 23:26–00:15 (+08:00)
> 纪律：每条只写实测到的原始输出与路径；推断处标 `[推断]`；未跑标 `not-run`。
> 本文件只列**缺陷/异常**，正面结论与完整证据见 `docs/round11/pkgs-报告.md`。

---

## D2-1【高】TS 档下 `pip config set global.index-url` 不生效，pip 静默回落官方 PyPI

**请求项直接命中**：任务写明"证据里不得出现 pypi.org / registry.npmjs.org 的下载 URL（否则判'声称镜像实为官方源'）"。
本例正是这一陷阱的**真实发生形态**，且根因在沙箱而非配置写法。

**实测链（全部在 `launchMode=shim / tierEffective=TS / degraded=false` 的嵌套线程内）**：

1. `pip config set` **成功**并报出写入路径：
   `.t/r11/pkgs/run2c/out/stage-root/staged/out-ev/raw-pip2-04-pipenv-config-set.txt`
   ```
   Writing to C:\Users\Administrator\AppData\Roaming\pip\pip.ini
   ```
   exit=0（`state-pip2.json` stages: `pipenv-config-set=0`）。

2. 文件**确实写成了**，内容正确，落在暂存覆盖层：
   `.t/r11/pkgs/run2c/out/stage-root/staged/fs/C/Users/Administrator/AppData/Roaming/pip/pip.ini`
   ```
   [global]
   index-url = https://pypi.tuna.tsinghua.edu.cn/simple
   ```
   真实盘 `%APPDATA%\pip\` 全程不存在（见报告 §5）。

3. 但**同一进程的后续读回**在属性面看不到它——node 侧 `fs.existsSync(pip.ini)` 返回 `false`，而同一路径 `fs.readFileSync` 却读出了上面那段内容
   （`state-pip2.json` → `checks.pip_ini_roaming = {"exists": false, "content": "[global]\r\nindex-url = ..."}`）。
   即：**open/read 面可见，stat/枚举面不可见**（见 D2-3）。

4. 后果：pip 自己的配置发现走 stat，于是**没有加载该配置**，`pip install` 静默使用默认 index。
   `.t/r11/pkgs/run2c/.../raw-pip2-06-pipenv-install-default-temp.txt`（原样）：
   ```
   Collecting six
     Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
   Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
   Installing collected packages: six
   Successfully installed six-1.17.0
   ```
   —— **没有 `Looking in indexes:` 行**。

5. **宿主对照实验（判决性）**：同一 pip（26.2.1）在本机跑同一命令两次
   - 用 `PIP_CONFIG_FILE` 指向同一份清华配置 → `.t/r11/pkgs/host-verify/ctrl-with-config.txt`：
     ```
     Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple
     Collecting six
       Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
     ```
     且 `.t/r11/pkgs/host-verify/ctrl-config-list.txt`：
     ```
     global.index-url='https://pypi.tuna.tsinghua.edu.cn/simple'
     ```
   - 不设任何配置 → `.t/r11/pkgs/host-verify/ctrl-no-config.txt`：
     ```
     Collecting six
       Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
     Would install six-1.17.0
     ```
   沙箱内输出与"**无配置**"对照组逐行同形，与"有配置"对照组明显不同 ⇒ **沙箱内的 pip 配置没生效**。

**影响**：凡依赖 `pip config set`/`redirect …/pip.ini` 做内网镜像落地的流程，在 TS 档里会**表面成功、实际走官方源**（若无出网则表现为超时/失败，与"镜像不可达"混淆，极难归因）。
**对照**：npm 侧同类配置**生效**（`npm config set registry` 后被 npm 读到，见报告 §2.1），同一沙箱内两条通道行为不一致。
**收窄条件**（未实测，`not-run`）：`pip install --index-url <mirror>` 走命令行参数、不经配置发现，`[推断]` 应可生效；本轮**未跑**，不作结论。

---

## D2-2【高】platform 模式（`WINSTAGE_SHELL=0`）对 shell 写入**零收敛**：真实盘被改

**实测**（`d2-pkgs-3`，`mode=platform`，`.t/r11/pkgs/run3/out/meta.txt` 记 `WINSTAGE_SHELL=0`）：

| 观测 | TS 档（run1） | platform 档（run3） |
|---|---|---|
| `sandbox-lane.json` | 存在：`shim / TS / degraded=false` | **不存在**（`lane.txt`: `LANE_OK=false`） |
| `stage-root` 结构 | 含 `registry/`、`audit.jsonl`、`shim.log` | 仅 `blobs/cache/candidates/private/real/staged/staged-ext`，**无 `registry/`、无 `audit.jsonl`、无 `shim.log`** |
| `npm config set user-agent`（写 `~/.npmrc`） | 真实盘**未变**（见 §5） | 真实盘 **被改**：`~/.npmrc` 40 B → 75 B，sha256 `3fc62c79…` → `51fd9752…`，多出 `user-agent=d2pkgs-marker-20261010` |
| `npm install -g cowsay` | 被拒（ENOENT），零残留 | **成功**，真实盘出现 `AppData\Roaming\npm\node_modules\cowsay` + `cowsay{,.cmd,.ps1}` + `cowthink{,.cmd,.ps1}`，`node_modules` 由 `@deepseek-ai,npm,pnpm` 变为 `@deepseek-ai,cowsay,npm,pnpm` |
| 越界写探针 `C:\d2-pkgs-desktop-probe.txt` / `~\.d2-pkgs-home-probe.txt` / `C:\Windows\Temp\d2-pkgs-probe.txt` | 三个真实盘文件均**不存在**；内容只出现在 stage 覆盖层 | 三个真实盘文件**全部存在**，内容 `D2-PKGS-OUTSIDE` |
| `npm-cache`（真实盘 `%LOCALAPPDATA%\npm-cache`） | 不变（临时安装用 `--cache <stage>`） | 字节数 `1058420951` → `1058418328`（-2623 B） |

原始证据：`run3/out/stage-root/staged/out-ev/state-npm.json`（`outside_writes.*.seenInSandbox=true`，`g_side.cowsayDir=true`，`gCowsayExit=0`）、`raw-npm-01-npm-g-cowsay.txt`（`added 41 packages in 4s`，全部 `registry.npmmirror.com` / `cdn.npmmirror.com`）。

**并非"无沙箱"而是"另一套语义"**：platform 档下并非所有写都成功——同一线程里
`run3/.../raw-pip2-04-pip-config-set.txt` 原样：
```
Writing to C:\Users\Administrator\AppData\Roaming\pip\pip.ini
ERROR: Unable to save configuration. Please report this as a bug.
...
PermissionError: [WinError 5] 拒绝访问。: 'C:\\Users\\Administrator\\AppData\\Roaming\\pip'
ERROR: Internal Error.
```
⇒ **platform 档 = 真实文件系统 + 部分路径拒绝（ACL/策略式），没有暂存重定向**；TS 档 = **暂存重定向**（真实盘零落盘）。
两者不是"强弱"关系，而是**两种不同的边界**：TS 挡的是"落真实盘"，platform 挡的是"部分路径不可建/不可写"。

**已处置（超出本域写入范围，属测试自产残留的还原）**：见 `docs/round11/pkgs-报告.md` §5.3 的清理记录，`~/.npmrc` 已按基线字节还原为 40 B / sha256 `3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc`，cowsay/cowthink 与三个探针文件已删除；终态复核见 §5.2。
**建议**：对外口径不得把 TS 档的"零落盘"推广到 platform 档；两档必须在验收矩阵里分列。

---

## D2-3【中】新写入（被重定向）的路径在 stat/枚举面不可见，但 open/read 可见

TS 档内同一进程、同一路径，**两种 API 给出相反答案**，本轮至少 4 处独立复现：

| # | 路径 | `fs.stat/exists` | `fs.readFileSync` | 证据 |
|---|---|---|---|---|
| 1 | `~/.npmrc`（`npm config set` 刚写） | — | 读出含 `user-agent=d2pkgs-marker-20261010` | `run1/.../state-npm.json:checks.npmrc_after` |
| 2 | `%APPDATA%\pip\pip.ini`（`pip config set` 刚写） | `exists:false` | 读出 `[global] index-url = …清华…` | `run2c/.../state-pip2.json:checks.pip_ini_roaming` |
| 3 | `C:\d2-pkgs-desktop-probe.txt`（node 刚写） | `seenInSandbox:false` | `readBack:"D2-PKGS-OUTSIDE"` | `run1/.../state-npm.json:checks.outside_writes.desktop` |
| 4 | 同上，`~` 与 `C:\Windows\Temp` 两处 | `false` | 正常读回 | 同上 |

覆盖层里文件确实存在（`run1/out/stage-root/staged/fs/C/Users/Administrator/.npmrc`、`.../fs/C/d2-pkgs-desktop-probe.txt`）。
**直接后果**：(a) D2-1 的 pip 配置失效；(b) `npm install -g` 的失败形态从上一轮的 `EPERM(errno -4048)` 变成本轮 `ENOENT(errno -4058)`——
`run1/.../raw-npm-01-npm-g-cowsay.txt` 原样：
```
npm error code ENOENT
npm error syscall mkdir
npm error path C:\Users\Administrator\AppData\Roaming\npm\node_modules\cowsay
npm error errno -4058
npm error enoent ENOENT: no such file or directory, mkdir '…\node_modules\cowsay'
```
`[推断]`：npm 先 stat 父目录失败 ⇒ 判定"父目录不存在"⇒ 报 ENOENT；实际是属性面看不到该路径，而执行面（若走到）本会被重定向。
与 `docs/round10/汇总报告.md` 记录的 D-P1「npm 目录面一致性（`readdir↔stat` 矛盾 / `cmd if exist`）」同族，本轮在**包管理器配置与安装**场景下再次独立复现。

---

## D2-4【中】`python -m venv`（带 pip）失败的真因被重新定位：uv 的 PEP 668 标记，不是"受限令牌 / mkdtemp 0o700"

上一轮记「`python -m venv` 失败（管道捕获 ensurepip + mkdtemp 双重原因）；`--without-pip` 成功」。
**本轮复现了"带 pip 失败 / `--without-pip` 成功"，但根因不同**——原样输出把链条摊开了。

TS 档（run2b）`raw-pip-09-venv0-create.txt` / `raw-pip-01-venv-with-pip.txt`：
```
Error: Command '[...\venv0\Scripts\python.exe', '-m', 'ensurepip', '--upgrade', '--default-pip']' returned non-zero exit status 1.
```
TS 档（run2c）`raw-pip2-06-ensurepip-run-shared.txt` 给出 ensurepip 内部的**两层**失败：
```
error: externally-managed-environment
This environment is externally managed
This Python installation is managed by uv and should not be modified.
...
subprocess.CalledProcessError: Command '[...python.exe, '-W', 'ignore::DeprecationWarning', '-c', '...']' returned non-zero exit status 1.
During handling of the above exception, another exception occurred:
...
  File "...\tempfile.py", line 954, in cleanup
OSError: [WinError 145] 目录不是空的。: 'C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\<uuid>\tmp2s0tu0na'
```
⇒ **主因 1 = PEP 668**（uv 安装的解释器带 `EXTERNALLY-MANAGED`，内层 pip 拒绝安装）；**次因 = 沙箱 TEMP 目录清理 WinError 145**。
与"受限令牌"和"mkdtemp 0o700 连创建者都不可写"**无关**（本轮 mkdtemp 见 D2/报告 §4.2：在 stage 内 TEMP 下完全正常）。
`--without-pip` 在 TS 档 exit=0（`run2c/.../state-pip2.json`：`venv-without-pip=0`），与上一轮一致。

**可用替代路径（本轮实测打通）**：`python -m venv --without-pip` + `uv pip install --python <venv> --index-url 清华 pip` 把 pip 装进 venv（exit 0，`run2c/.../raw-pip2-02-uv-bootstrap-pip.txt`：`+ pip==26.2.1`），之后 venv 内的 pip 完全可用。

---

## D2-5【低·观察】TS 档对同一 site-packages 连读两次 treeDigest 不一致（文件数/字节数相同）

`.t/r11/pkgs/run2c/.../state-pip2.json` 的 `checks`：
```
sp_tree1 {files:838, bytes:10254653, digest:381aff6618dd0f3e…}
sp_tree2 {files:838, bytes:10254653, digest:6157d7b53cb6e2ff…}
sp_tree3 {files:838, bytes:10254653, digest:7f7c9a1417a5a83f…}
sp_tree_stable: false
```
宿主对同一目录复算 3 次（`.t/r11/pkgs/host-verify/rewalk-run2c.txt`）：**三次全等** `7f7c9a1417a5a83f…`（= 沙箱的 tree3），`changed_files=[]`。
platform 档同一测量：tree1==tree2 稳定（`0abc26c3…`），其后 835→838 文件的变化可由紧随其后的 `import six` 生成 `__pycache__` 解释。
**结论（严格限定）**：TS 档内"连读两次同一棵树"**未做到可复现**；文件的**最终落盘态是自洽的**（宿主复算与 tree3 相同）。
`[推断]` 与 D2-3 同源：重定向写入存在"延迟可见/陈旧可见"窗口。**未定位到具体文件**（`not-run`：需在沙箱内做逐文件前后哈希对比）。

---

## D2-6【低】`uv python install`（已装版本，warm）在沙箱内失败：无法删除 stage 外的真实目录

`run2b/.../raw-pip-06-uv-python-install-warm.txt`（run2 同形）：
```
error: Failed to create Python minor version link directory
  cause: failed to remove directory `…\.t\r11\pkgs\shared\uvpython\cpython-3.12-windows-x86_64-none`: 目录不是空的。(os error 145)
```
该目录是**沙箱外的真实目录**（解释器预置在 `.t/r11/pkgs/shared/uvpython`）。宿主上对同一操作（清空后重跑）`exit=0 / 652 ms`（`.t/r11/pkgs/shared/uv-warm-timing.txt`）。
⇒ 沙箱**正确地**阻止了越界删除；但 uv 的"小版本软链刷新"因此失败。属"隔离生效 + 工具链不兼容"的组合，不建议当漏洞，属易踩坑。

---

## 未跑 / 局限（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| 沙箱内 `pip install --index-url <清华>`（绕开配置发现） | `not-run` | 嵌套 run 已用满 5 次预算；`[推断]` 可生效但**未取证** |
| 沙箱内 `uv python install` 冷装 | `not-run`（沙箱内）/ 已测（宿主） | 宿主 116,279 ms（`.t/r11/pkgs/timing/timing.txt`），接近嵌套 shell 工具 120 s 上限，故本轮在沙箱内只测了 warm 路径 |
| D2-5 的具体差异文件 | `not-run` | 需沙箱内逐文件前后哈希 |
| `pip check`/`pip show`/import 的**沙箱内**执行 | 已跑（run2c stage c：`pip-check=0`、`pip-show=0`、`import-versions=0`），逐文件 RECORD 校验因我的脚本路径 bug 在沙箱内结果无效，改由宿主对**沙箱产物**复算（见报告 §3.3） | 无 |
