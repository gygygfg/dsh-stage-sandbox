# D2 实测报告：pip / node 包安装 + 国内镜像 + 安装后完整性（R11 · 新装配 TS 档复核）

> 会话域：`t2-pkgs`（共享任务 `task-2`）· 实测窗口：2026-10-10 23:26 – 00:20 (+08:00)
> 载体：**新开的带 WinStage 沙箱的 DSH 线程**（宿主 `.t/r11/bin/supervisor.mjs`，pid 见 `.t/r11/supervisor.pid.txt`）
> 证据根：`.t/r11/pkgs/**`（原始件）、`.t/r11/jobs/d2-pkgs-*/**`（队列产物）、`docs/archive/round111/pkgs-缺陷.md`
> 纪律：结论只写实测；未跑标 `not-run`，推断标 `[推断]`；**缺陷另列** `docs/archive/round111/pkgs-缺陷.md`（D2-1…D2-6）

---

## 0. 结论速览

| # | 请求项 | 判定 | 一句话 |
|---|---|---|---|
| 1a | npm 国内镜像真实生效（URL 级） | **通过** | 2 个包全部 `registry.npmmirror.com` 元数据 + `cdn.npmmirror.com` tarball；证据中 `registry.npmjs.org` 命中 **0** |
| 1b | pip 国内镜像真实生效（URL 级） | **不通过** | `pip config set` 报成功、文件也写进了暂存覆盖层，但 pip **读不到**，静默回落官方 PyPI（**缺陷 D2-1**，有宿主对照实验判决） |
| 1c | 镜像配置写到哪 / 是否动真实盘 | **通过（TS 档）** | 写的是用户级 `~/.npmrc` 与 `%APPDATA%\pip\pip.ini`，**全部进暂存**：真实盘 `~/.npmrc` 40 B/sha256 `3fc62c79…` **零变化**，`%APPDATA%\pip\` 全程不存在 |
| 2a | npm 安装后完整性 | **通过** | `npm ls --json` 无 `problems`；package-lock `integrity` 反解 `_cacache/content-v2` **2/2 sha512 重算一致**；node 冒烟正确；`node_modules` 1065 文件树两次读回同 digest |
| 2b | pip 安装后完整性 | **通过** | RECORD 逐文件 sha256：**total=519 / ok=505 / mismatch=0 / missing=0**（两档一致）；`pip check` 干净；`pip show` 与 import 版本一致 |
| 3 | 全局安装隔离（TS 档） | **通过** | `npm i -g cowsay` 被拒（`ENOENT -4058`）、`pip install --user` 被拒（`WinError 2`），真实盘**零残留** |
| 4 | 对照：platform 档（`WINSTAGE_SHELL=0`） | **重大差异** | **无 sandbox-lane、无 shim、shell 写入不收敛**：`npm i -g cowsay` 真装上真实盘、`~/.npmrc` 被真实改写、三个越界探针真落盘（**缺陷 D2-2**）；同时 `%APPDATA%\pip` 反被 `WinError 5` 拒绝 |
| 5 | 复现/推翻上一轮"开箱不可安装" | **部分推翻** | `uv venv` + `uv pip install` + import **完全可用**（上一轮记"不可用"）；`python -m venv` 仍失败但**根因改写**为 uv 的 PEP 668 标记 + 沙箱 TEMP 清理 `WinError 145`，**不是**"mkdtemp 0o700 连创建者都不可写" |

**一句话**：**TS 档把两个包管理器都"装得干净、测得准"，但只有 npm 的镜像配置真的生效；pip 的镜像配置会被沙箱的 stat 面吃掉，导致"表面成功、实走官方源"。** 另外，platform 档不是"更弱的沙箱"，而是**另一套语义**（真实盘 + 部分路径拒绝），其 shell 写入**没有**暂存收敛。

---

## 1. 运行档位与环境事实（每条附证据）

| 项 | 实测值 | 证据 |
|---|---|---|
| 宿主 node / npm | `v24.21.0` / **`12.2.0`**（注意：任务书里写 11.19.0，实测为 12.2.0） | `.t/r11/pkgs/evidence/run1/out-ev/raw-npm-01-node-version.txt`、`raw-npm-02-npm-version.txt` |
| uv | `uv 0.12.19 (bea138450 2026-09-24 x86_64-pc-windows-msvc)` | `run2b/out-ev/raw-pip-03-uv-version.txt` |
| 系统 python | `C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe`，`python --version` **无输出、exit=9009** | `run2b/out-ev/raw-pip-01-where-python.txt`、`state-pip.json`（`python-stub-version=9009`） |
| 实际使用的解释器 | uv 预置 CPython **3.12.14**（宿主机预置在 `.t/r11/pkgs/shared/uvpython`），自带 `pip 26.2.1` | `run2c/.../raw-pip2-02-shared-pip-version.txt` |
| **沙箱档位（TS）** | `launchMode=shim` / `tierEffective=TS` / `degraded=false` / `fallbackClass=none` / `shimCount=3` / `degradeCount=0`；`stderr.txt` **0 字节** | `run1|run2|run2b|run2c/out/stage-root/sandbox-lane.json` |
| 沙箱档位（platform 对照） | **`sandbox-lane.json` 不存在**；`lane.txt` = `LANE_OK=false`；stage-root 无 `registry/`、`audit.jsonl`、`shim.log` | `run3/out/lane.txt`、`run3/out/stage-root/` 清单 |
| `WINSTAGE_STAGE_ROOT` 语义**两档不同** | TS 档 = `<out>\stage-root\staged`；platform 档 = `<out>\stage-root` | `run2c/.../state-pip2.json:env.stageRoot` vs `run3/.../state-npm.json:env.stageRoot` |
| 子线程 cwd（TS） | `<out>\stage-root\staged`（真实可执行目录，故电池脚本全部落在 stage 直通区） | `run1/.../state-npm.json:env.cwd` |
| 嵌套 shell 工具单次上限 | 实测受 120 s 约束（`node_modules/@anthropic-ai/sdk/lib/tools/SessionToolRunner.mjs:16 TOOL_TIMEOUT_MS = 120000`）⇒ 电池按"每阶段一个短命令"拆分 | 读码 + 本报告 §6 的拆法 |

**运行清单**（5 次嵌套 run，均为单线程串行 3–6 个短命令）：

| jobId | run | mode | 覆盖 | 结局 |
|---|---|---|---|---|
| `d2-pkgs-1` | `run1` | winstage(TS) | npm 全量（镜像/完整性/隔离） | done exit=0 |
| `d2-pkgs-2` | `run2` | winstage(TS) | pip 首轮（**因我的引号 bug 失效**，仅 uv 段有效） | done exit=0 |
| `d2-pkgs-2b` | `run2b` | winstage(TS) | pip 二轮（仍受解释器/venv 影响） | done exit=0 |
| `d2-pkgs-2c` | `run2c` | winstage(TS) | **pip 主证据轮**（venv--without-pip + uv 引导 pip + 安装 + 配置） | done exit=0；三个 stage 全部 exit=0 并留证（`state-pip2.json` steps） |
| `d2-pkgs-3` | `run3` | platform | npm + pip 全量对照 | done exit=0 |

---

## 2. npm：镜像（URL 级）→ 完整性 → 隔离（`run1`，TS 档）

### 2.1 镜像真实生效（URL 级，非"国内可达"）

`npm config set registry https://registry.npmmirror.com` 前/后读值一致，并额外写入一个**只属于本轮**的哨兵键以证明"写的到底是哪个文件"：

- `raw-npm-03-registry-before.txt` → `https://registry.npmmirror.com`
- `raw-npm-09-marker-after.txt` → `d2pkgs-marker-20261010`
- `raw-npm-10-config-list.txt` 原样（节选）：
  ```
  ; "user" config from C:\Users\Administrator\.npmrc

  registry = "https://registry.npmmirror.com"
  user-agent = "d2pkgs-marker-20261010"
  ```
  ⇒ 写入目标是**用户级 `~/.npmrc`**（不是工作区、不是 builtin）。

安装 2 个包，`--loglevel http`，原始行（`raw-npm-11-install-2pkgs.txt`）：
```
npm http fetch GET 200 https://registry.npmmirror.com/left-pad 222ms (cache miss)
npm http fetch GET 200 https://registry.npmmirror.com/lodash 103ms (cache miss)
npm http fetch GET 200 https://cdn.npmmirror.com/packages/left-pad/1.3.0/left-pad-1.3.0.tgz 417ms (cache miss)
npm http fetch GET 200 https://cdn.npmmirror.com/packages/lodash/4.17.21/lodash-4.17.21.tgz 3183ms (cache miss)
added 2 packages in 6s
```
`package-lock.json` 的 `resolved`（`state-npm.json:checks.lock_entries`）：
```
node_modules/left-pad@1.3.0 https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz
node_modules/lodash@4.17.21  https://registry.npmmirror.com/lodash/-/lodash-4.17.21.tgz
```
**反证扫描**：全部原始证据里 `registry.npmjs.org` 命中 **0**（`Select-String` 全量扫 `evidence/**/raw-*.txt`）。

> 注：因为真实盘 `~/.npmrc` **本来就有** `registry=https://registry.npmmirror.com`（基线 40 B，见 §5.1），单看 registry 值无法区分"生效"还是"继承"。所以本轮靠 ①哨兵键 `user-agent` ②`npm config list` 显示的来源文件 ③安装日志的 URL 三者合证。

### 2.2 安装后完整性：**通过**

| 校验 | 结果 | 证据 |
|---|---|---|
| `npm ls --json` | 依赖树干净，**无 `problems` 键**（npm 12 仅在有问题时输出该键）；两个依赖 `resolved` 均指向 npmmirror | `raw-npm-12-npm-ls-json.txt` |
| lock integrity → 内容寻址缓存反解 | integrity `sha512-<b64>` → hex → `<cache>/_cacache/content-v2/sha512/<hh>/<hh>/<rest>`，**逐个重算**：`left-pad: exists=true, match=true, gzip=true, bytes=3619`；`lodash: exists=true, match=true, gzip=true, bytes=318961` | `state-npm.json:checks.integrity` |
| node 冒烟 | `SMOKE lodash.chunk=[[1,2],[3,4]]` / `SMOKE leftPad="  x"` / `SMOKE versions=4.17.21,1.3.0` | `raw-npm-01-node-smoke.txt` |
| 二次读回 | `node_modules` **1065 文件 / 1,422,911 B**，`tree1==tree2`，digest `e4c41bf58d54bc19d6ed9c47cc72f59266a186dab79bda2d184d24abf42245e4` | `state-npm.json:checks.tree1/tree2/tree_stable=true` |
| ws 内 npm 缓存 | 11 文件 / 561,343 B（内容寻址缓存本身） | `state-npm.json:checks.cacheTree` |

### 2.3 全局安装：被拒 + 真实盘零残留

`npm install -g cowsay`（exit = `4294963238`，即 -4058）原始尾部（`raw-npm-01-npm-g-cowsay.txt`）：
```
npm error code ENOENT
npm error syscall mkdir
npm error path C:\Users\Administrator\AppData\Roaming\npm\node_modules\cowsay
npm error errno -4058
npm error enoent ENOENT: no such file or directory, mkdir '…\AppData\Roaming\npm\node_modules\cowsay'
```
`npm prefix -g` / `npm root -g` 仍能读出真实路径（`…\AppData\Roaming\npm`、`…\npm\node_modules`）——**读得到、写不进**。
沙箱内自查 `cowsayDir=false / cowsayCmd=false`；真实盘复核 `…\npm\node_modules\cowsay` **不存在**，`node_modules` 仍为 `@deepseek-ai,npm,pnpm`。
（与上一轮的差异：错误码由 `EPERM -4048` 变为 `ENOENT -4058`，见缺陷 **D2-3**。）

---

## 3. pip：镜像（★不生效）→ 完整性 → 隔离

### 3.1 解释器与 venv 的真实情况

| 步骤 | 结果 | 原始证据 |
|---|---|---|
| `where python` | 仅 WindowsApps 桩（exit 9009，无输出） | `run2c/.../raw-pip2-01-ensurepip-version-shared.txt` 同轮 |
| `uv python find 3.12` | exit=0 | `state-pip.json` |
| `uv python install 3.12`（warm，解释器已在沙箱外预置） | **exit=2**：`Failed to create Python minor version link directory / cause: failed to remove directory …cpython-3.12-windows-x86_64-none: 目录不是空的。(os error 145)` | `run2b/out-ev/raw-pip-06-uv-python-install-warm.txt`；宿主同操作 exit=0 / **652 ms**（`.t/r11/pkgs/shared/uv-warm-timing.txt`）→ 属**越界删除被正确阻止**（缺陷 D2-6） |
| `python -m venv <dir>`（默认带 pip） | **exit=1**：`Error: Command '[...\venv0\Scripts\python.exe', '-m', 'ensurepip', '--upgrade', '--default-pip']' returned non-zero exit status 1.` | `run2b/out-ev/raw-pip-09-venv0-create.txt` |
| `python -m venv --without-pip <dir>` | **exit=0** | `run2c/.../state-pip2.json`（`venv-without-pip=0`），`raw-pip2-01-venv-without-pip.txt`（空输出） |
| **uv 引导 pip（可用路径）** | `uv pip install --python <venv>\Scripts\python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple pip` → **exit=0**，`+ pip==26.2.1`；随后 venv 内 `pip 26.2.1` 可用 | `run2c/.../raw-pip2-02-uv-bootstrap-pip.txt`、`raw-pip2-03-pipenv-pip-version.txt` |

**ensurepip 失败的完整因果链**（`run2c/.../raw-pip2-06-ensurepip-run-shared.txt`，原样节选）：
```
error: externally-managed-environment
This environment is externally managed
This Python installation is managed by uv and should not be modified.
...
subprocess.CalledProcessError: Command '[...python.exe, '-W', 'ignore::DeprecationWarning', '-c', '...']' returned non-zero exit status 1.
During handling of the above exception, another exception occurred:
...
  File "...\tempfile.py", line 954, in cleanup
    self._rmtree(self.name, ignore_errors=self._ignore_cleanup_errors)
OSError: [WinError 145] 目录不是空的。: 'C:\Users\ADMINI~1\AppData\Local\Temp\dsh-stage-temp\<uuid>\tmp2s0tu0na'
```
⇒ **主因是 PEP 668**（uv 解释器带 `EXTERNALLY-MANAGED`），次因是沙箱 TEMP 目录清理 `WinError 145`。**不是**上一轮说的"管道捕获 + mkdtemp 0o700"（见 §4）。

### 3.2 国内镜像：**配置面失败**（★本节是 D2-1 的正面证据）

- `pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple` → **exit=0**，`Writing to C:\Users\Administrator\AppData\Roaming\pip\pip.ini`（`raw-pip2-04-pip-config-set.txt`、`raw-pip2-04-pipenv-config-set.txt`）
- 该文件**真的写成了**（内容正确）且**落在暂存覆盖层**：
  `.t/r11/pkgs/run2c/out/stage-root/staged/fs/C/Users/Administrator/AppData/Roaming/pip/pip.ini`
  ```
  [global]
  index-url = https://pypi.tuna.tsinghua.edu.cn/simple
  ```
- 但沙箱内 `fs.existsSync(该文件) = false`（`state-pip2.json:checks.pip_ini_roaming.exists=false`），而同一路径 `readFileSync` 读出了上面内容 ⇒ **stat 面与 read 面矛盾**（缺陷 D2-3）
- 后果：`pip install` **不打印 `Looking in indexes:`**（`raw-pip2-06-pipenv-install-default-temp.txt`、`raw-pip2-07-pipenv-install-stage-temp.txt`），原样：
  ```
  Collecting six
    Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
  Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
  Installing collected packages: six
  Successfully installed six-1.17.0
  ```
- **宿主对照（判决）**：同一 pip，`PIP_CONFIG_FILE` 指向同一份清华配置 ⇒ `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple`（`host-verify/ctrl-with-config.txt`）；不带任何配置 ⇒ 与沙箱输出**逐行同形**、且无该行（`host-verify/ctrl-no-config.txt`）。
  ⇒ **沙箱内的 pip 走的是默认官方 index**，不是清华。**任务明令"证据里不得出现 pypi.org 的下载 URL"——本例即"声称镜像实为官方源"的实际形态，根因在沙箱 stat 面。**

**对照（同一沙箱，镜像确实生效的两条通道）**：
- npm：见 §2.1（URL 级）
- uv：`uv pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple pip` 的索引缓存里存有清华 URL（`run2c/.../staged/uv-cache/simple-v25/index/46901b1a4cb2cba0/pip.rkyv` 内可直接读到）：
  ```
  https://pypi.tuna.tsinghua.edu.cn/simple/pip/../../packages/3d/9d/1e31…/pip-0.2.tar.gz
  ```
  `uv python install` 走的也是 `UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone`

### 3.3 安装后完整性：**通过**（RECORD 逐文件 sha256）

沙箱内 `pip install` 成功装入 `six 1.17.0` / `idna 3.20`（venv：`--without-pip` + uv 引导的 pip）。
RECORD 校验（PEP 376：路径相对**含 `.dist-info` 的目录**）由宿主对**沙箱产物**复算（我的沙箱内校验脚本有路径 bug，故以复算为准，两档一致）：

| 档 | total | ok | mismatch | missing | unchecked | 证据 |
|---|---|---|---|---|---|---|
| TS（run2c） | **519** | **505** | **0** | **0** | 14 | `.t/r11/pkgs/host-verify/run2c-record.txt` |
| platform（run3） | **519** | **505** | **0** | **0** | 14 | `.t/r11/pkgs/host-verify/run3-record.txt` |

（`unchecked=14` 为 RECORD 中无哈希的行，如 `*.dist-info/RECORD` 自身。）
```
VERIFY {… "total": 519, "ok": 505, "mismatch": 0, "missing": 0, "unchecked": 14, "bad": [],
        "imports": {"six": "1.17.0", "idna": "3.20"}, "six_file": true}
```
| 其余校验 | 结果 | 证据 |
|---|---|---|
| `pip check` | `No broken requirements found.`（沙箱内 exit=0；宿主复跑同） | `run2c/.../raw-pip2-03-pip-check.txt`、`host-verify/run2c-pipcheck.txt` |
| `pip show` vs import | `pip show`：six `1.17.0` / idna `3.20`；`import`：`IMPORT six=1.17.0 idna=3.20` | `host-verify/run2c-pipshow.txt`、`run2c/.../raw-pip2-05-import-versions.txt` |
| 二次读回（site-packages） | platform 档 `tree1==tree2`；TS 档 **两次不一致**（同 838 文件/10,254,653 B，三个不同 digest），最终态与宿主复算一致 `7f7c9a1417a5a83f…`（宿主 3/3 稳定） | 缺陷 **D2-5**；`host-verify/rewalk-run2c.txt`、`rewalk-run3.txt` |

### 3.4 `--user` 隔离：被拒、零残留

TS 档 `pip install --user --break-system-packages idna`（先绕开 PEP 668）→ **exit=1**，原样：
```
  WARNING: Failed to write executable - trying to use .deleteme logic
ERROR: Could not install packages due to an OSError: [WinError 2] 系统找不到指定的文件。: 'C:\Users\Administrator\AppData\Roaming\Python\Python312\Scripts\idna.exe' -> '…\idna.exe.deleteme'
```
真实盘 `%APPDATA%\Python` **不存在**（`state-pip2.json:roaming_python_exists=false` + §5.2 复核）。
> 注：不带 `--break-system-packages` 时 pip 更早被 PEP 668 拒绝（`externally-managed-environment`），那是 uv 的解释器策略、**不是**沙箱拒绝——两者必须分开记。

---

## 4. 与上一轮结论的对照：复现 / 推翻（`docs/沙箱并行实测报告-6域与独立复核.md` §3）

| 上一轮结论 | 本轮实测 | 判定 |
|---|---|---|
| 「npm 镜像通」 | 复现（URL 级：registry/cdn.npmmirror.com，0 处 npmjs.org） | **复现** |
| 「pip 镜像通（清华，URL 级）」 | **不成立**：`pip config set` 不生效，实走官方源（宿主对照判决） | **推翻**（缺陷 D2-1） |
| 「安装后完整性通过（RECORD total=517 ok=514 mismatch=0 missing=3）」 | 通过（total=519 ok=505 mismatch=0 missing=0）；missing 计数差异来自包集不同与路径解析修正 | **复现** |
| 「全局安装被隔离（EPERM + 零落盘）」 | 隔离成立、零落盘成立；错误码变 `ENOENT -4058`（`pip --user` 变 `WinError 2`） | **复现（错误码更新）** |
| **「mkdtemp 的 `0o700` 目录连创建者都不可写 → pip/ensurepip 必然失败」** | **未复现**。本轮 mkdtemp 在**沙箱 TEMP（被重定向到 stage 覆盖层）**下：目录**创建成功**，但 `os.stat` / `open` 报 `FileNotFoundError [WinError 3]`；把 `TEMP` 指到 stage 直通目录后**一切正常**（`mode=0o777`、写/列/回读 ok、`os.mkdir(p,0o700)` 写 ok） | **推翻（现象不同）**：真正的现象是"**新写入路径在属性/枚举面不可见**"（缺陷 D2-3），与 `0o700` 无关 |
| **「python -m venv（含 pip）失败（管道捕获 ensurepip + mkdtemp 双重原因）」** | "带 pip 失败 / `--without-pip` 成功"复现；但**根因改写**：PEP 668 uv `EXTERNALLY-MANAGED` 为**主因**，沙箱 TEMP 清理 `WinError 145` 为**次因**，与"管道捕获""0o700"无关 | **部分推翻**（缺陷 D2-4） |
| 「`uv venv` / `uv python find` 不可用（管道读解释器 stdout，os error 5）」 | **推翻**：`uv venv --python <py> <dir>` **exit=0**；`uv pip install` exit=0；venv 内 `import six` → `UVENV six=1.17.0` | **推翻** |
| 「uv 默认缓存（工作区外）导致全部命令失败」 | 本轮把 `UV_CACHE_DIR` 指到 stage 内即正常；`uv python install` 的失败另有原因（越界删除被阻止，D2-6） | 部分复现（缓存位置确实要紧） |
| 「WindowsApps `python.exe` 存在但不可用（exit 9009）」 | **复现**（exit=9009，stdout/stderr 全空） | **复现** |
| 「必须打 shim（把 mkdtemp mode 0o700 改 0o755）才能装」 | 本轮**未使用任何 python 侧 shim**，pip（uv 引导）与 uv 两条路都装成功了；npm 也无需 shim | **推翻（前提不再必要）** |

原始 mkdtemp 两种环境的对照（`run2b/out-ev/`）：
- 默认 TEMP（沙箱 `…\AppData\Local\Temp\dsh-stage-temp\<uuid>`，写入被重定向）：
  `{"mkdtemp_default": {"dir": "…\\d2mk-516es_68", "mode_err": "FileNotFoundError(2, '系统找不到指定的文件。')", "write": "FAIL FileNotFoundError: [WinError 3] 系统找不到指定的路径。…"}, "os_mkdir_700_write": "FAIL …"}`
- `TEMP` = stage 内目录：`{"mkdtemp_default": {"dir": "…\\tmp\\d2mk-4yzrmz8v", "mode": "0o777", "write": "ok", "listdir": ["a.txt"], "readback": "x"}, "mkdtemp_mode700": {… "chmod700": "ok", "write": "ok"}, "os_mkdir_700_write": "ok"}`

---

## 5. 隔离取证：真实盘是否被改动

### 5.1 基线（实测前，宿主侧）

`.t/r11/pkgs/host-baseline-before.json`（captured 2026-10-10T23:28:27+08:00）：
```
~/.npmrc            存在, 40 B, sha256=3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc, mtime=2026-09-11T03:17:43
                    内容 = "registry=https://registry.npmmirror.com"
%APPDATA%\pip\pip.ini   不存在
%APPDATA%\Python        不存在
AppData\Roaming\npm\node_modules = @deepseek-ai, npm, pnpm（无 cowsay）
%LOCALAPPDATA%\npm-cache   31343 文件 / 1,058,419,919 B
```

### 5.2 TS 档（sandboxed）终态复核：**零落盘**

| 目标 | 期望 | 实测 | 结论 |
|---|---|---|---|
| `~/.npmrc` | 不被改 | **40 B / sha256 `3fc62c79…` / mtime 2026-09-11**（与基线逐字节相同） | ✅ 未动 |
| `%APPDATA%\pip\pip.ini`（含父目录 `pip`） | 不出现 | 不存在 | ✅ |
| `~/.pip\pip.ini`、`C:\ProgramData\pip\pip.ini` | 不出现 | 均不存在 | ✅ |
| `%APPDATA%\Python` | 不出现 | 不存在 | ✅ |
| `AppData\Roaming\npm\node_modules\cowsay` / `cowsay.cmd` | 不出现 | 不存在；`node_modules = @deepseek-ai,npm,pnpm` | ✅ |
| `C:\d2-pkgs-desktop-probe.txt`、`~\.d2-pkgs-home-probe.txt`、`C:\Windows\Temp\d2-pkgs-probe.txt` | 不出现 | 三者均不存在 | ✅ |
| 工作区 `.t/r11/pkgs/run1/ws` | 只应有我预放的 5 个种子文件 | harness `workspace-inventory.txt`：`files=5 dirs=0 bytes=21508`，逐项 sha256 一致 | ✅ |

**而内容全部可在 stage 覆盖层找到**（证明是"重定向"而非"丢弃"）：
```
.t/r11/pkgs/run1/out/stage-root/staged/fs/C/Users/Administrator/.npmrc           ← 含 user-agent=d2pkgs-marker-20261010
.t/r11/pkgs/run1/out/stage-root/staged/fs/C/d2-pkgs-desktop-probe.txt
.t/r11/pkgs/run1/out/stage-root/staged/fs/C/Users/Administrator/d2-pkgs-home-probe.txt
.t/r11/pkgs/run1/out/stage-root/staged/fs/C/Windows/Temp/d2-pkgs-probe.txt
.t/r11/pkgs/run2c/out/stage-root/staged/fs/C/Users/Administrator/AppData/Roaming/pip/pip.ini
```

### 5.3 platform 档对照：**真实盘被改**（已还原）

见缺陷 **D2-2**（含逐项对照表）。**测试自产残留的还原已执行**（这一步超出本域写入范围，属"把测试自己改动的宿主状态恢复原样"，记录如下）：

| 对象 | 处置前 | 处置后 |
|---|---|---|
| `~/.npmrc` | 75 B / sha256 `51fd9752…`（含哨兵 `user-agent=d2pkgs-marker-20261010`） | **40 B / sha256 `3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc`**（与基线逐字节一致） |
| `C:\d2-pkgs-desktop-probe.txt`、`~\.d2-pkgs-home-probe.txt`、`C:\Windows\Temp\d2-pkgs-probe.txt` | 存在（内容 `D2-PKGS-OUTSIDE`） | 已删除，`Test-Path=False` |
| `AppData\Roaming\npm\node_modules\cowsay` + `cowsay{,.cmd,.ps1}` + `cowthink{,.cmd,.ps1}` | 存在（23:50:22） | 已删除；`node_modules = @deepseek-ai,npm,pnpm` |
| `%LOCALAPPDATA%\npm-cache` | 31344 文件 / 1,058,418,328 B | **未回滚**（缓存内容，删改会造成更大副作用）：相对基线 `+1 文件 / -1,591 B`；**其中 +1 文件时间戳 2026-10-10T15:28:44Z 早于本轮沙箱 run（23:41 起），是 Lead 宿主侧 `npm -v`/`npm config get cache` 自身写下的 `_logs` 调试日志**；-1,591 B 的字节差发生在 platform run 之后，归因于该档真实盘上的 npm 活动 |

**结论**：**"真实盘零残留"只在 TS/沙箱档成立**。platform 档会真实落盘；对外口径必须分档陈述。

---

## 6. 方法学备注（供后续复用）

1. **`cmd /c` 引号陷阱**：Node 用 `spawnSync('cmd.exe', ['/c', '<含引号的命令>'])` 时会把内嵌 `"` 反斜杠转义，cmd 于是把 `\"C:\…\python.exe\"` 当成程序名 → `不是内部或外部命令`。
   本轮 `run2` 的 pip 段因此全废。**修法**：把命令写进 `.cmd` 文件，再 `cmd /d /c <file>`（本域 `d2common.mjs:makeSh` 已实现，`cmd-<domain>-<id>-<tag>.cmd` 留证）。
2. **120 s 工具上限**：`npm install 2 包` 实测 7.2 s、`uv pip install` 2.5 s、`uv python install` **冷装 116 s（宿主）**⇒ 冷装不可放进单次嵌套 shell 调用；本域改为"宿主预置解释器 + 沙箱内 warm/find/venv/pip"。
3. **电池落点**：子线程 cwd = `<stage>\staged`（真实可执行目录），故电池应把产物写在 cwd/`WINSTAGE_STAGE_ROOT` 派生的真实路径下；`WINSTAGE_STAGE_ROOT` 两档语义不同（见 §1），必须做存在性回退。
4. **`runstage.cmd` 的控制台文件**：TS 档下 `%WINSTAGE_STAGE_ROOT%\staged` 不存在（该变量是"staged 工作区"而非 stage 根）⇒ 回退到工作区真实路径，重定向后被 l 落在 `staged\fs\C\…\ws\`；platform 档则落在 `staged\` 顶层。harvest 两处都收（`d2common`/`harvest.mjs` 已处理）。

---

## 7. 证据索引（主要）

| 内容 | 路径 |
|---|---|
| TS 档位判据（4 次） | `.t/r11/pkgs/run{1,2,2b,2c}/out/stage-root/sandbox-lane.json`；platform 无该文件（`run3/out/lane.txt`） |
| npm 镜像 / 安装 / 配置 | `.t/r11/pkgs/evidence/run1/out-ev/raw-npm-{03,08,09,10,11,12}.txt` |
| npm 完整性（integrity/tree） | `.t/r11/pkgs/evidence/run1/out-ev/state-npm.json` |
| npm 并发与冒烟 | `.../raw-npm-01-node-smoke.txt` |
| npm 全局安装被拒 | `.../raw-npm-01-npm-g-cowsay.txt`；沙箱内 `.../raw-npm-01-npm-g-cowsay.txt` + `prefix-g`/`root-g` |
| mkdtemp 双环境对照 | `.t/r11/pkgs/evidence/run2b/out-ev/raw-pip-0{1,2}-mkdtemp-probe-*.txt` |
| venv/ensurepip 失败链 | `run2b/out-ev/raw-pip-09-venv0-create.txt`、`run2c/out/stage-root/staged/out-ev/raw-pip2-06-ensurepip-run-shared.txt` |
| uv 通道成功 | `run2b/out-ev/raw-pip-0{4,5,6}-uv-*.txt`、`run2c/.../raw-pip2-02-uv-bootstrap-pip.txt` |
| pip 配置与安装（★镜像失效） | `run2c/.../raw-pip2-04-pipenv-config-set.txt`、`raw-pip2-05-pipenv-config-list-v.txt`、`raw-pip2-06-pipenv-install-default-temp.txt`、`raw-pip2-07-pipenv-install-stage-temp.txt` |
| pip 配置覆盖层落点 | `run2c/out/stage-root/staged/fs/C/Users/Administrator/AppData/Roaming/pip/pip.ini` |
| uv 索引缓存（清华 URL） | `run2c/out/stage-root/staged/uv-cache/simple-v25/index/46901b1a4cb2cba0/pip.rkyv` |
| RECORD / pip check / show | `.t/r11/pkgs/host-verify/run2c-record.txt`、`run3-record.txt`、`run2c-pipcheck.txt`、`run2c-pipshow.txt` |
| pip 镜像**宿主对照** | `.t/r11/pkgs/host-verify/ctrl-with-config.txt`、`ctrl-no-config.txt`、`ctrl-config-list.txt` |
| 树 digest 复算 | `.t/r11/pkgs/host-verify/rewalk-run2c.txt`、`rewalk-run3.txt` |
| 真实盘基线 / 终态 | `.t/r11/pkgs/host-baseline-before.json`、本报告 §5 |
| platform 档全量原始件 | `.t/r11/pkgs/run3/out/stage-root/staged/out-ev/**`（含 `state-npm.json`、`state-pip2.json`） |
| 宿主计时参考 | `.t/r11/pkgs/timing/timing.txt`、`.t/r11/pkgs/shared/uv-warm-timing.txt` |
| 电池与取证脚本 | `.t/r11/pkgs/scripts/{d2common.mjs,battery-npm.mjs,battery-pip.mjs,battery-pip2.mjs,runstage.cmd,harvest.mjs,rewalk.mjs,verify_reports.py}` |
| 缺陷清单 | `docs/archive/round111/pkgs-缺陷.md`（D2-1…D2-6） |
