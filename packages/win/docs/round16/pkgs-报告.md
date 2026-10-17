# D2 实测报告：pip / node 包安装 + 全局国内镜像 + 保存后完整性（R16 · golden 三件套）

> 会话域：`pkgs`（共享任务 `task-2`）· 实测窗口：2026-10-11 17:46 – 19:0x (+08:00)
> 载体：**新开的带 WinStage 沙箱的 DSH 线程**（每次 `docs\archive\round10\env\scripts\sbx-thread.cmd <ws> <prompt> <out> winstage`）
> 沙箱件：`shim/out/winstage-shim.dll` = `63808F51…C8A99EB`（golden，与 R15 §5 一致）
> 证据根：`.t/r16/pkgs/**` · 缺陷另列 `docs/round16/pkgs-缺陷.md`
> 纪律：结论只写实测；没跑的写 `not-run`，推断标 `[推断]`；报告一律中文。

---

## 0. 结论速览

| # | 请求项 | 判定 | 一句话 |
|---|---|---|---|
| 1 | 探测可用解释器 | **通过** | `python` 只是 WindowsApps 商店桩（exit 9009、stdout/stderr 全空）、`py` 不存在；真实可用的是 **uv 0.12.19 + uv 管理的 CPython 3.12.14**（自带 pip 26.2.1） |
| 2a | npm 全局镜像（user 级 `.npmrc`） | **通过** | `npm config set registry` 与哨兵键都写进暂存覆盖层；安装日志 **`registry.npmmirror.com`×5 / `cdn.npmmirror.com`×2 / `registry.npmjs.org`×0** |
| 2b | pip 全局镜像（`pip config set global.index-url`） | **不通过** | TS 档下**写配置这一步就被拒**：`PermissionError [WinError 5] …\AppData\Roaming\pip`（run2/run3 各复现 1 次）⇒ 配置面不存在（缺陷 **D2-R16-1**） |
| 3a | npm 实际安装 2 包 | **通过** | `left-pad@1.3.0` + `lodash@4.17.21`，`added 2 packages in 15s`，全部 URL 指向 npmmirror |
| 3b | pip 实际安装 2–3 纯 wheel | **通过** | `six 1.17.0` / `idna 3.20` / `packaging 26.3`；**默认（配置）路径走官方源**（`pypi.org`×354、`files.pythonhosted.org`×342、清华×0）；**显式 `--index-url` 走清华**（清华×972、`pypi.org`×0） |
| 4 | 保存后完整性 | **通过** | npm：lock `integrity`(sha512) ↔ 内容寻址缓存 tarball 重算 **2/2 MATCH**，字节数与 npmmirror `dist.size` 一致；pip：RECORD 逐文件 sha256 **total=572 / ok=535 / mismatch=0 / missing=0**（宿主独立复算同值）；另与 **PyPI 官方 JSON 的 sha256** 交叉一致 |
| 5 | 隔离（真实盘零污染） | **通过** | 真实 `~/.npmrc` 40 B/`3fc62c79…` 与基线**逐字节相同**；`%APPDATA%\pip`、`%APPDATA%\Python`、`~\.pip`、3 个越界探针文件**全部不存在**；真实 `npm-cache` **31344 文件/1,058,418,328 B 与基线完全一致**；全局 `node_modules` 未变 |
| 6 | 配置生效位置 | **已说清** | 沙箱内的配置写入**只落暂存覆盖层**（`staged\fs\C\Users\Administrator\.npmrc`，77 B），**不回写真实用户配置、运行后不持久**；沙箱内 npm **会**读到覆盖层（哨兵键可见）；pip 则连写都失败 ⇒ 两侧都不生效 |
| 7 | 每 run 过 §1.1 四条判据 | **全部通过** | 6 个 run（含 1 smoke）全部 `LANE_OK=true`、`stderr.txt` 0 B、真实工作区只剩预放种子 |

**一句话**：**npm 这条线本轮全绿**（镜像 URL 级、完整性、隔离、配置只在沙箱内生效）；**pip 这条线在 golden 下比 R11 更早就断了——不是"配置写了读不到"，而是"配置根本写不进去"**（`WinError 5`，见 D2-R16-1），于是不显式传 `--index-url` 时 pip **静默走官方 PyPI**。显式 `--index-url https://pypi.tuna.tsinghua.edu.cn/simple` 是当前唯一被实测打通的 pip 镜像通道。

---

## 1. 运行清单与 §1.1 四条判据

全部 6 个 run 都是 `winstall` 主路（`WINSTAGE_SHELL=1`、唯一钉住 `WINSTAGE_STAGE_ROOT`、清 `DSH_SESSION_ID`）。

| run | 目的 | session-id | stage root | 判据①stderr | 判据②暂存面 | 判据③真实 ws | 判据④lane | exit |
|---|---|---|---|---|---|---|---|---|
| smoke | lane 冒烟 + 解释器探测 | `session-f833d7af-44b3-47b1-8469-67f8dd0a8be6` | `smoke\out\stage-root-22146154998788` | **0 B** | 223 文件/70.0 MB，含 `staged\pkgs-smoke.txt` | 1→1（seed 51 B） | `tierEffective=TS / degraded=false` **LANE_OK=true** | 0 |
| run1 | npm 首轮（**早停**：未 `call npm`） | `session-1aff7b64-1c6a-45fa-a1bd-6131280e29a0` | `run1\out\stage-root-23488941410931` | **0 B** | 1076 文件/163.0 MB，含 `staged\out-ev-npm\raw\*` | **9→9，13543 B = 13543 B** | TS / false / **true** | 0 |
| run2 | pip 主证据（A/B/C 三电池） | `session-82902d9b-4405-4f4e-b9a3-6c2763e15bc2` | `run2\out\stage-root-23488941410931` | **0 B** | 3023 文件/185.9 MB，含 `staged\out-ev-pip\**` | 8→8，14315 B = 14315 B | TS / false / **true** | 0 |
| run3 | pip `-vv` URL 级 A/B | `session-26afe7b6-a013-47af-abfc-e1d1310b65ed` | `run3\out\stage-root-29039299294086` | **0 B** | 2341 文件/82.5 MB，含 `staged\out-ev-pipvv\raw\*` | 2 个种子，run 末清单 = 宿主当前清单 | TS / false / **true** | 0 |
| run4 | npm 修复版（`call npm`） | `session-8b71c88b-31db-42b5-90e3-6f9deb4a1c9b` | `run4\out\stage-root-29039299294086` | **0 B** | 3316 文件/37.6 MB，含 `staged\out-ev-npm\**` | 9 个种子（13748 B），run 末清单 = 宿主当前清单 | TS / false / **true** | 0 |
| run5 | 新目录创建探针（pip 失败操作） | `session-53ee9aa4-de3f-4194-b174-26c0a350b56e` | `run5\out\stage-root-32168498213067` | **0 B** | 72 文件/27.7 MB，含 `staged\out-ev-mkdir\raw\*` | 3→3（4070 B） | TS / false / **true** | 0 |

- 每 run 的 `lane.txt` 都含 `tierEffective=TS`、`degraded=false`、`fallbackClass=none`、`degradeCount=0`、`LANE_OK=true`（如 `run4\out\lane.txt`）。
- 判据③的取法：**run1/run2/run5 有宿主侧 pre-run 清单**（`host\ws-pre-{run1,run2,run5}.txt`），与同 run 的 `out\workspace-inventory.txt` **逐行逐哈希相等**（run1 连总字节数都相等：13543 B）；**run3/run4 未单独存 pre-run 清单**，改用"run 结束清单 vs 宿主当前清单逐行逐哈希相等 + 种子在启动后未被宿主改动"两条合证（`host/` 目录内文件与 `run3/4\ws` 现态一致）。
- run1/run2 的 `out\lane.txt` 中 `conclusion` 中文因控制台代码页显示为乱码，属显示层问题，字段本体在 `stage-root-meta.txt` 里是合法 JSON——**不影响判据**（判据只看 `degraded`/`tierEffective`，均为 ASCII 值）。

### 1.1 run1 早停的原因（方法学，不是沙箱缺陷）

`npm` 在 PATH 上是 **`npm.cmd`**。批处理里调用另一个批处理**不加 `call` 就不返回**（与 R10 §5.2 的 `dsh` 坑同族）：
`battery-npm-a.cmd` 执行到第 2 步 `npm -v` 即被转交控制权、脚本终止 ⇒ 只留下 `env/01/02` 三个文件。
证据：`run1\out\stdout.ndjson` 的 CALL#5 结果只有 `[01] node -v` / `[02] npm -v` / `EXIT=0`。
**处置**：`battery-npm-*.cmd` 全部改成 `call npm …`（run4 用它跑通；`run4\ws\battery-npm-*.cmd` 里有 14 处 `call npm`）。

---

## 2. 解释器与工具链事实（请求项 1）

| 项 | 宿主侧实测 | 证据 |
|---|---|---|
| `where python` | `C:\Users\Administrator\AppData\Local\Microsoft\WindowsApps\python.exe` | `host\probe-where-python.out.txt` |
| `python -V` | **exit=9009，stdout 与 stderr 均 0 字节** ⇒ 商店别名桩，不可用 | `host\probe-python-V.out.txt`（0 B）、`.err.txt`（0 B） |
| `py -3 -V` / `where py` | `'py' is not recognized as an internal or external command…` / `INFO: Could not find files for the given pattern(s).` | `host\probe-py3-V.err.txt`、`host\probe-where-py.err.txt` |
| `uv` | `uv 0.12.19 (bea138450 2026-09-24 x86_64-pc-windows-msvc)`，`C:\Users\Administrator\.local\bin\uv.exe` | `host\probe-uv-version.out.txt`、`host\probe-where-uv.out.txt` |
| uv 管理的 CPython | `3.12.14 (main, Sep 24 2026, 17:57:31) [MSC v.1944 64 bit (AMD64)]`，`%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none\python.exe` | 宿主 `host\probe-uv-python-list.out.txt`；**沙箱内** `run2\...\raw-pip-07/08` |
| 该解释器自带 pip | `pip 26.2.1 from …\uv\python\…\Lib\site-packages\pip (python 3.12)` | `run2\...\raw-pip-09-managed-pip.txt` |
| node / npm | `v24.21.0` / **`12.2.0`**（任务书写的 11.19.0 与实测不符，记实测值） | `host\probe-node-v.out.txt`、`host\probe-npm-v.out.txt` |

**沙箱内（run2）**：`where python` → 无匹配；`python -V` → exit 9009、输出空；`py -3 -V` → `CommandNotFoundException`。
⇒ **"WindowsApps 的 python.exe 只是商店别名"在本机成立**；本轮 pip 全部走 `uv venv --seed` 预置的 venv pip（`uv venv --python <CPython> --seed --index-url https://pypi.tuna.tsinghua.edu.cn/simple`，exit 0，日志 `+ pip==26.2.1`，见 `run2\...\raw-pip-10-uv-venv-seed.txt`）。
未使用 R11 的 `UV_PYTHON_INSTALL_MIRROR` 冷装路径：解释器**已在**宿主预置（uv 缓存里现成，见上表），`uv venv` 只需 `--python` 指过去，`not-run` 项见 §8。

---

## 3. npm：镜像（URL 级）→ 完整性 → 隔离（run4）

### 3.1 镜像真实生效（URL 级）

- `npm config set registry https://registry.npmmirror.com` → exit 0（`raw-npm-04`）；写入的是**用户级** `C:\Users\Administrator\.npmrc`。
- 为区分"生效"与"继承"，额外写哨兵键 `user-agent=r16-pkgs-marker-20261011`（exit 0，`raw-npm-05`），`npm config list`（`raw-npm-06`）原样：
  ```
  ; "user" config from C:\Users\Administrator\.npmrc

  registry = "https://registry.npmmirror.com"
  user-agent = "r16-pkgs-marker-20261011"
  ```
- `npm config get userconfig` → `C:\Users\Administrator\.npmrc`（`raw-npm-09`）。
- 安装原始日志（`raw-npm-12-install.txt`，`--loglevel http`）：
  ```
  npm http fetch GET 200 https://registry.npmmirror.com/npm 378ms
  npm http fetch GET 200 https://registry.npmmirror.com/left-pad 333ms (cache miss)
  npm http fetch GET 200 https://registry.npmmirror.com/lodash 116ms (cache miss)
  npm http fetch GET 200 https://cdn.npmmirror.com/packages/left-pad/1.3.0/left-pad-1.3.0.tgz 744ms (cache miss)
  npm http fetch GET 200 https://cdn.npmmirror.com/packages/lodash/4.17.21/lodash-4.17.21.tgz 10139ms (cache miss)
  added 2 packages in 15s
  ```
- **URL 级统计**（`verify\mirror-url-grep.txt`，按正则 `-AllMatches` 计数）：
  | 文件 | registry.npmmirror.com | cdn.npmmirror.com | **registry.npmjs.org** |
  |---|---|---|---|
  | `raw-npm-12-install.txt` | 5 | 2 | **0** |
  | `raw-npm-13-ls.json` | 2 | 0 | **0** |
  | `raw-npm-14-package-lock.json` | 2 | 0 | **0** |
  | `raw-npm-21-integrity.json` | 2 | 0 | **0** |
- `package-lock.json` 两条 `resolved` 均 `https://registry.npmmirror.com/<pkg>/-/<pkg>-<ver>.tgz`。

> **诚实边界**：真实盘 `~/.npmrc` **本来就有** `registry=https://registry.npmmirror.com`（基线 40 B，见 §5），而读操作是直通的 ⇒ 即便沙箱内不写任何配置，npm 也会走镜像。所以本节的判据是三条合证：①哨兵键（只可能来自沙箱写入的覆盖层）②`npm config list` 显示的来源文件 ③安装日志的 URL。**不能说"镜像 URL 是沙箱配置带来的"**。

### 3.2 保存后完整性：**通过**

| 校验 | 结果 | 证据 |
|---|---|---|
| lock `integrity`(sha512) → 内容寻址缓存 tarball **重算** | left-pad：`bytes=3619`、`sha512` 重算 == integrity（`matchIntegrityHex=true`）、gzip 魔数 true；lodash：`bytes=318961`、同上 true | `raw-npm-21-integrity.json`；**宿主独立复算** `verify\host-run4-npm-verify.json` 同样 `MATCH`×2 |
| 与 npmmirror 公布值交叉 | left-pad `dist.size=3619`、`dist.integrity=sha512-XI5MPz…MCoEA==`；lodash `dist.size=318961`、`sha512-v2kDEe…FvSg==` ⇒ **三方一致** | `host\registry-meta-npmmirror.jsonl`、`verify\external-crosscheck.md` |
| `npm ls --json` | 无 `problems` 键；两个依赖 `resolved` 均 npmmirror | `raw-npm-13-ls.json` |
| node 冒烟 | `SMOKE lodash.chunk=[[1,2],[3,4]]` / `SMOKE leftPad="  x"` / `SMOKE versions=4.17.21,1.3.0` | `raw-npm-22-smoke.txt` |
| `npm cache verify` | `Content verified: 4 (555073 bytes)` / `Index entries: 4` | `raw-npm-20-cache-verify.txt` |
| 二次读回 | `node_modules` **1065 文件 / 1,422,903 B**，两次 digest 相同 = `3dae53e67fd48ae81cbeefbfbe1bbbad218b6decec7ade5ff17c3f1b375a0934` | `raw-npm-23-tree-digest.json` |

### 3.3 全局安装：被拒 + 真实盘零残留

`npm install -g cowsay`（exit `-4058`）原样（`raw-npm-27-g-cowsay.txt`）：
```
npm error code ENOENT
npm error syscall mkdir
npm error path C:\Users\Administrator\AppData\Roaming\npm\node_modules\cowsay
npm error errno -4058
```
`npm root -g` / `npm prefix -g` **读得到**真实路径（`raw-npm-24/25`）；真实盘 `node_modules` 前=`@deepseek-ai,npm,pnpm`、后=**完全相同**（`raw-npm-26/28`），`cowsay` 不存在（宿主复核）。

---

## 4. pip：镜像（★不生效）→ 完整性 → 隔离（run2 + run3）

### 4.1 `pip config set global.index-url` **写不进去**（D2-R16-1）

run2 与 run3 各一次，原样（`run2\...\raw-pip-20-config-set.txt`、`run3\...\raw-pv-03-config-set.txt`）：
```
Writing to C:\Users\Administrator\AppData\Roaming\pip\pip.ini
ERROR: Unable to save configuration. Please report this as a bug.
Traceback (most recent call last):
  ...
  File "...\pip\_internal\configuration.py", line 221, in save
    ensure_dir(os.path.dirname(fname))
  File "...\pip\_internal\utils\misc.py", line 133, in ensure_dir
    os.makedirs(path)
  File "<frozen os>", line 225, in makedirs
PermissionError: [WinError 5] 拒绝访问。: 'C:\\Users\\Administrator\\AppData\\Roaming\\pip'
ERROR: Internal Error.
EXIT=1
```
- `pip config debug`（`raw-pip-23`、`raw-pv-04`）四个候选配置文件全部 `exists: False`：
  `C:\ProgramData\pip\pip.ini` / `…\venv\pip.ini` / `C:\Users\Administrator\pip\pip.ini` / `C:\Users\Administrator\AppData\Roaming\pip\pip.ini`。
- 沙箱内 `type %APPDATA%\pip\pip.ini` → `The system cannot find the path specified.`（exit 1）；`fs.existsSync/stat/read` 三面全 `ENOENT`（`raw-pip-25`、`raw-pip-47`）。
- **注意 pip 的"global"是配置节名**；不带级别开关时 pip 把 `[global]` 节写进**用户级** `%APPDATA%\pip\pip.ini`。`--global` 级别应写 `C:\ProgramData\pip\pip.ini`（本轮 `not-run`，见 §8）。

### 4.2 后果：默认路径静默走官方源（URL 级）

| 通道 | 原始读数 | URL 统计（`verify\mirror-url-grep.txt`） |
|---|---|---|
| run2 默认（读过配置、实际没有配置）`pip install -v six idna packaging` | `Obtaining dependency information for six from https://files.pythonhosted.org/packages/b7/ce/…whl.metadata` | `files.pythonhosted.org=3`、`pypi.org=0`、清华=0 |
| run3 默认路径 **`-vv`** `pip install -vv six` | `Starting new HTTPS connection (1): pypi.org:443` / `https://pypi.org:443 "GET /simple/pip/ HTTP/1.1" 200 38310` / `Found link https://files.pythonhosted.org/packages/3d/9d/…` | **`pypi.org=354`、`files.pythonhosted.org=342`、清华=0** |
| run3 **显式** `--index-url https://pypi.tuna.tsinghua.edu.cn/simple`（`-vv`） | `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple` / `Starting new HTTPS connection (1): pypi.tuna.tsinghua.edu.cn:443` / `Found link https://pypi.tuna.tsinghua.edu.cn/packages/18/ad/…` | **清华=972、`pypi.org=0`、`files.pythonhosted.org=0`** |
| run3 显式 `--index-url`（`pip download`，`-vv`） | `Looking in indexes: …清华…` / `Saved .\out-ev-pipvv\dl\six-1.17.0-py2.py3-none-any.whl` | 清华=693 |
| run2 显式 `--index-url`（`-v`，`--target`） | `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple` → `Successfully installed idna-3.20 packaging-26.3 six-1.17.0` | 清华=1 |

**宿主对照（判决性）**：同一台机、同一命令族（`host\ctrl\ctrl.cmd`，全部写在我的证据目录、未碰真实用户配置）：
- `PIP_CONFIG_FILE=<清华 ini>` → `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple`（`ctrl-07-download-with-config.txt`）；
- 不设任何配置（`--dry-run`）→ **没有** `Looking in indexes:` 行（`ctrl-08-dryrun-no-config-control.txt`）；
- `-vv`（`ctrl-09-download-vv.txt`）→ `Found index url https://pypi.tuna.tsinghua.edu.cn/simple/`、`GET /simple/pip/ HTTP/1.1 200`。
⇒ 沙箱内"默认路径"的输出与"无配置"对照组同形，与"有配置"对照组不同：**pip 没有加载任何镜像配置**。

### 4.3 保存后完整性：**通过**

venv（`six/idna/packaging`，`pip 26.2.1`）RECORD 逐文件 sha256：

| 树 | total | ok | mismatch | missing | unchecked | 证据 |
|---|---|---|---|---|---|---|
| `venv\Lib\site-packages`（沙箱内算） | **572** | **535** | **0** | **0** | 37 | `run2\...\raw-pip-34-record-verify.json` |
| 同上（**宿主独立复算**，另一套代码） | **572** | **535** | **0** | **0** | 37 | `verify\host-run2-pip-verify.json` |
| `--target tgt`（显式清华通道，沙箱内） | 91 | 54 | **0** | 1 | 36 | `raw-pip-43-record-verify-target.json` |

（`missing=1` 是 `../../bin/idna.exe` —— `--target` 不安装脚本，属安装方式语义，不是字节损坏；`unchecked` 是 RECORD 中无哈希的行。）

| 其余校验 | 结果 | 证据 |
|---|---|---|
| `pip check` | `No broken requirements found.` | `raw-pip-31` |
| `pip show` | six 1.17.0 / idna 3.20 / packaging 26.3，`Location` 全在 stage 内 | `raw-pip-32` |
| import | `IMPORT 1.17.0 3.20 26.3` | `raw-pip-33` |
| site-packages 二次读回 | 895 文件 / 11,277,245 B，两次 digest 同 = `ab5a029910182f639ae27d1864ef5262e59da5d72aa054749698165c93413e80`（**R11 D2-5 的"两次不一致"本轮未复现**） | `raw-pip-44-sp-tree-digest.json` |
| 下载 wheel 与 PyPI 官方值 | `six-1.17.0-py2.py3-none-any.whl`：本机 `bytes=11050`、宿主重算 `sha256=4721f391…3274`；PyPI JSON 公布 `sha256=4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274`、`size=11050` ⇒ **一致** | `verify\host-run2-pip-verify.json`、`verify\external-crosscheck.md` |

### 4.4 `pip config` 之外的隔离：零残留

- venv / `--target` / 下载目录全部在本次 stage 树内（`site.getsitepackages()` 打印即 stage 路径，`raw-pip-13`）。
- 真实盘 `%APPDATA%\pip`（含父目录 `pip`）、`%APPDATA%\Python`、`~\.pip`、`C:\ProgramData\pip\pip.ini` **全程不存在**（宿主复核 + 沙箱内 `raw-pip-47-fs-face-after.json`）。

---

## 5. 隔离取证：真实盘前后对照（请求项 5）

### 5.1 基线（17:46 宿主侧）

```
~/.npmrc            40 B  sha256=3fc62c79e2d5c41dd6446a8b328705ea8384bd99c9a6b3ec2f6e9de1dbe612bc  mtime=2026-10-10T23:53:42  content="registry=https://registry.npmmirror.com"
%APPDATA%\pip       不存在      %APPDATA%\Python 不存在      ~\.pip 不存在      C:\ProgramData\pip\pip.ini 不存在
%APPDATA%\npm\node_modules = @deepseek-ai, npm, pnpm（无 cowsay）
%LOCALAPPDATA%\npm-cache   31344 文件 / 1,058,418,328 B
C:\r16-pkgs-desktop-probe.txt / ~\.r16-pkgs-home-probe.txt / C:\Windows\Temp\r16-pkgs-probe.txt  均不存在
```

### 5.2 终态（19:0x 宿主侧）：**零落盘**

| 目标 | 实测 | 结论 |
|---|---|---|
| `~/.npmrc` | **40 B / `3fc62c79…` / mtime 未变** | ✅ 未动（run4 沙箱内 `raw-npm-33` 因 `npm config set` 存在覆盖层而读到 77 B；run2 沙箱内 `raw-pip-36` 在**没有**任何 `.npmrc` 写入的情况下读到真实 40 B/同一 sha256，与基线一致） |
| `%APPDATA%\pip`（及 pip.ini） | 不存在 | ✅ |
| `%APPDATA%\Python`、`~\.pip`、`C:\ProgramData\pip\pip.ini` | 均不存在 | ✅ |
| 全局 `node_modules\cowsay` / `cowsay.cmd` | 不存在；`node_modules` 仍 `@deepseek-ai,npm,pnpm`（前 26 / 后 28 两次列举相同） | ✅ |
| `C:\r16-pkgs-desktop-probe.txt`、`~\.r16-pkgs-home-probe.txt`、`C:\Windows\Temp\r16-pkgs-probe.txt` | 三者**均不存在**（宿主 `Test-Path=False`） | ✅ |
| `%LOCALAPPDATA%\npm-cache` | **31344 文件 / 1,058,418,328 B = 与基线逐个数字相同**；`_logs` 无 17:40 之后的新文件 | ✅ 零变化 |
| run1/run2/run4/run5 真实工作区 | 与宿主 pre-run 清单**逐行逐哈希一致**（run1 连字节总数都同为 13543） | ✅ |
| `C:\r16-mkdir-probe` 等 run5 探针目录 | 宿主侧**全部不存在** | ✅ |

**"重定向而非丢弃"的证据**（内容都在 stage 覆盖层里）：
```
staged\fs\C\Users\Administrator\.npmrc                77 B  sha256=2c6e0c743b10…（含哨兵 user-agent）
staged\fs\C\r16-pkgs-desktop-probe.txt                16 B  sha256=b4f4c62cf6fa…（内容 R16-PKGS-OUTSIDE）
staged\fs\C\Users\Administrator\.r16-pkgs-home-probe.txt  16 B  同上
staged\fs\C\Windows\Temp\r16-pkgs-probe.txt           16 B  同上
```
越界写探针在沙箱内的读数（`raw-npm-29-outside-write.json`）：`write="ok"` + `existsSync=false` + `read={ok, content:"R16-PKGS-OUTSIDE"}`——**写成功、属性面看不见、读取面看得见**。

### 5.3 配置"生效位置"（请求项 6）

- **npm**：`npm config set` 的写入落**覆盖层** `staged\fs\…\.npmrc`（77 B）；沙箱内 npm 后续**确实读到它**（`npm config list` 里出现哨兵键）；真实用户配置**未被改动**，且**运行结束后不持久**（真实盘仍是 40 B）。⇒ **配置生效范围 = 沙箱内（overlay），不外溢、不持久**。
- **pip**：写入被拒（WinError 5）⇒ 两处都没有配置文件，`pip config debug` 全部 `exists: False` ⇒ **配置面完全不存在**。
- 另有环境事实（不是本轮写入带来的）：真实 `~/.npmrc` **本来就**含 `registry=https://registry.npmmirror.com`，且读直通沙箱 ⇒ npm 的镜像可用性**部分是继承**的，不能全部归功于沙箱内配置（§3.1 已声明）。

---

## 6. 与 R11 同域结论的对照（复现 / 已修 / 变化）

| R11 结论（`docs/archive/round11/pkgs-报告.md`） | R16 实测 | 判定 |
|---|---|---|
| npm 镜像 URL 级通（npmmirror，0 处 npmjs.org） | 复现：npmmirror×5 / cdn×2 / **npmjs.org×0** | **复现** |
| **pip 镜像不生效**：`pip config set` 写成功但 pip 读不到（D2-1） | **形态加重**：R16 连"写"都失败（`PermissionError WinError 5`，2 run 复现），配置面根本不存在，pip 走官方源（pypi.org×354） | **复现且更靠前失败**（D2-R16-1） |
| 「沙箱内 `pip install --index-url <清华>`」**not-run** | **已跑通**：`Looking in indexes: …清华…`，清华×972 / pypi.org×0 | **R11 的 not-run 项已闭** |
| npm 完整性（integrity 反解 cacache 2/2 一致） | 复现（2/2 MATCH；并与 npmmirror `dist.size` 一致） | **复现** |
| pip RECORD 逐文件 sha256 `mismatch=0` | 复现（572/535/**0**/0；宿主独立复算同值） | **复现** |
| 全局安装被拒（EPERM -4048 → ENOENT -4058） | 复现 `ENOENT -4058` + 真实盘零残留 | **复现** |
| TS 档真实盘零落盘 | 复现且**更强**：`npm-cache` 文件数/字节数与基线**逐个数字相同** | **复现** |
| D2-5：TS 档同一 site-packages 连读两次 digest 不一致 | **未复现**：site-packages 两次一致、node_modules 两次一致（本域 4 次双读全部 `stable=true`） | **变化（未复现）** |
| D2-3：新写入路径 stat/枚举不可见、read 可见 | **复现且更锐利**：同一进程同一路径 `.npmrc` `stat.size=40` vs `read.bytes=77`；越界写 `existsSync=false` 但 read 成功 | **复现**（D2-R16-2） |
| 「mkdtemp 0o700 / 管道捕获 / 必须打 python 侧 shim」等旧因 | 本轮**未复现前提**：无任何 python 侧 shim，`uv venv --seed` + pip 全通 | **不再必要**（与 R11 一致） |
| platform 档（`WINSTAGE_SHELL=0`）对照 | `not-run`（理由见 §8） | **not-run** |
| 「`python -m venv` 带 pip 失败 = PEP 668 主因」 | `not-run`（本轮直接用 `uv venv --seed`，未跑 venv 内部 ensurepip） | **not-run** |

---

## 7. 方法学备注（供后续域复用）

1. **`npm` 必须 `call`**：同 R10 §5.2 的 `dsh` 坑。`npm.cmd` 被批处理直接调用会吞掉后续步骤（run1 实测）。`node`/`uv`/`python` 是 exe，不受影响。
2. **批处理引号规则同样适用于 `pip`/`uv`**：本轮所有 pip 命令都写成 `"%VPY%" -m pip …`，无引号陷阱（R11 的 `cmd /c` 陷阱未再现）。
3. **单次 shell 工具调用有时限（实测约 120 s）**：电池按"一阶段一命令"拆分；本轮每个 run 2–3 次调用，最长的一次（`pip install -vv` + 解析）也远低于上限。
4. **子线程 cwd = `<stage>\staged`，且 `WINSTAGE_STAGE_ROOT`（沙箱内）= 同一路径**（`run4\...\env-npm-01.txt`、`run3\...\env-pv-01.txt`）⇒ 电池把产物写在 `%CD%\out-ev-*` 下，天然落 stage 直通区，宿主可用 `stage-root-inventory.txt` 取证。
5. **不要试图在沙箱里"枚举"自己刚写的目录**：`Get-ChildItem`/`dir` 对新逻辑目录会空/报错（run1、run2 的嵌套 agent 都因此走了弯路，白耗 10+ 分钟）。取证一律"先写文件、宿主侧读 stage 树"。
6. **宿主侧读沙箱产物时不要用 PowerShell 的 `>` 重定向捕获 node 输出**（会写成带 BOM/UTF-16 的文件、`JSON.parse` 失败）；用 `cmd /d /c "node … > file"`。

---

## 8. 未跑 / 局限（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| platform 档（`WINSTAGE_SHELL=0`）对照 | `not-run` | 该档**会真实写盘**（R11 D2-2 已实测），本轮优先"真实盘零污染"；R11 已有完整对照，不重复 |
| `pip install --user` 隔离探针 | `not-run` | uv 管理的 CPython 默认无 `pip` 模块（`raw-pip-09` 是 venv 外的 pip 路径）；venv 内 pip 会直接拒绝 `--user`；R11 已测（WinError 2 + 真实盘 `%APPDATA%\Python` 不出现），本轮用 `%APPDATA%\Python` 不存在复核 |
| `python -m venv`（带 pip）失败链 / ensurepip / mkdtemp 0o700 | `not-run` | 本轮主路是 `uv venv --seed`（exit 0）；R11 的 PEP 668 归因未复核 |
| `pip config set --global`（写 `C:\ProgramData\pip\pip.ini`） | `not-run` | 用户级写入已失败；`[推断]` 会撞同一个"新目录创建"问题 |
| `uv python install`（冷装/镜像 `UV_PYTHON_INSTALL_MIRROR`） | `not-run` | 解释器已在宿主预置（uv 缓存里现成），无需下载；R11 D2-6 的越界删除未复核 |
| D2-R16-1 的 **API 级**精确归因 | `part` | 已排除"路径被禁"（run5 里 node `mkdirSync` 对同一 `%APPDATA%\pip` 返回 `ok`），但 Py 与 node 的差异是**跨 run**对比；同 run 内 Py/node A/B 需第 7 个 run（超本域 run 预算），未跑；见 `pkgs-缺陷.md` 的建议复现命令 |
| 网络档位/`network` 段 | 已知 | 与 R15 一致：`state: not-implemented`（本机不装真实 WFP），不作为本域结论 |

---

## 9. 证据索引（主要）

| 内容 | 路径 |
|---|---|
| 四条判据（6 run） | `.t/r16/pkgs/{smoke,run1,run2,run3,run4,run5}/out/lane.txt`、`stderr.txt`、`stage-root-inventory.txt`、`workspace-inventory.txt` |
| 宿主 pre-run 工作区清单 | `.t/r16/pkgs/host/ws-pre-{run1,run2,run5}.txt` |
| 解释器探测（宿主） | `.t/r16/pkgs/host/probe-*.out.txt`、`probe-*.err.txt` |
| npm 镜像/配置日志 | `.t/r16/pkgs/run4/out/stage-root-29039299294086/staged/out-ev-npm/raw/raw-npm-{03,04,05,06,07,08,09,12,13,14}.txt|json` |
| npm 完整性 + 冒烟 + 树 digest | 同上 `raw-npm-{20,21,22,23}.txt|json` |
| npm 全局安装被拒 / 全局目录列举 | 同上 `raw-npm-{24,25,26,27,28}.txt` |
| 越界写探针 / 真实盘回读 / 覆盖层 | 同上 `raw-npm-{29,30,31,32,33,34}.*` |
| **URL 级镜像判据汇总** | `.t/r16/pkgs/verify/mirror-url-grep.txt` |
| 外部公布值交叉校验 | `.t/r16/pkgs/verify/external-crosscheck.md`、`.t/r16/pkgs/host/registry-meta-npmmirror.jsonl` |
| 宿主独立复算（pip / npm） | `.t/r16/pkgs/verify/host-run2-pip-verify.json`、`host-run4-npm-verify.json`、`host-verify.mjs` |
| pip 配置失败（★） | `.t/r16/pkgs/run2/.../raw-pip-20-config-set.txt`、`.../raw-pip-23-config-debug.txt`、`.t/r16/pkgs/run3/.../raw-pv-03-config-set.txt`、`raw-pv-04-config-list-v.txt` |
| pip 默认路径 vs 显式清华（URL 级） | `.t/r16/pkgs/run3/.../raw-pv-{05,06,07}-*.txt`、`.t/r16/pkgs/run2/.../raw-pip-{30,40,41}-*.txt` |
| pip RECORD / show / check / import / 树 digest | `.t/r16/pkgs/run2/.../raw-pip-{31,32,33,34,35,43,44}.*` |
| 宿主 pip 对照实验 | `.t/r16/pkgs/host/ctrl/raw/ctrl-0{0..9}-*.txt`、`ctrl.cmd`、`pip-tsinghua.ini` |
| 新目录创建探针（run5） | `.t/r16/pkgs/run5/out/stage-root-32168498213067/staged/out-ev-mkdir/raw/raw-mk-0{1..10}-*` |
| 电池与助手脚本 | `.t/r16/pkgs/{run1,run2,run3,run4,run5}/ws/**`（`battery-*.cmd`、`helpers/*.mjs`） |
| 清理记录 | 宿主对照 venv/uvcache/dl 目录（15 MB）已删、日志保留；`npm-cache-tmp` 已删 |
| 缺陷清单 | `docs/round16/pkgs-缺陷.md`（D2-R16-1…3） |
