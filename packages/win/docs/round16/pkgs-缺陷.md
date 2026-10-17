# D2 缺陷与异常清单（pip / node 包安装 · 国内镜像 · 安装后完整性 · R16）

> 轮次：R16 · 域：`pkgs`（共享任务 `task-2`）· 实测窗口 2026-10-11 17:46 – 19:0x (+08:00)
> 沙箱件：golden `shim/out/winstage-shim.dll` = `63808F51…C8A99EB`；6 个 run 全部 `tierEffective=TS` / `degraded=false` / `LANE_OK=true` / `stderr.txt` 0 B。
> 纪律：每条只写实测到的原始输出与路径；推断标 `[推断]`；未跑标 `not-run`。
> 正面结论与完整证据见 `docs/round16/pkgs-报告.md`。

---

## D2-R16-1【P1】TS 档下 pip 全局镜像配置**写不进去**（`os.makedirs` WinError 5），pip 静默回落官方 PyPI

**请求项直接命中**：任务要求"配置**全局**国内镜像（pip `pip config set global.index-url …`）"，并且"证据里不得出现 pypi.org 的下载 URL"。本例正是这一陷阱的**实际发生形态**，而且比 R11 的更早失败：R11 是"写了但读不到"，R16 是"**根本写不下去**"。

### 现象

在 `launchMode=shim / tierEffective=TS / degraded=false` 的嵌套线程内，**两次独立 run**（run2、run3）执行同一条命令：

```cmd
"%VENV%\Scripts\python.exe" -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

原样输出（`.t/r16/pkgs/run2/out/stage-root-23488941410931/staged/out-ev-pip/raw/raw-pip-20-config-set.txt`；
`.t/r16/pkgs/run3/out/stage-root-29039299294086/staged/out-ev-pipvv/raw/raw-pv-03-config-set.txt`）：

```
Writing to C:\Users\Administrator\AppData\Roaming\pip\pip.ini
ERROR: Unable to save configuration. Please report this as a bug.
Traceback (most recent call last):
  File "...\pip\_internal\commands\configuration.py", line 274, in _save_configuration
    self.configuration.save()
  File "...\pip\_internal\configuration.py", line 221, in save
    ensure_dir(os.path.dirname(fname))
  File "...\pip\_internal\utils\misc.py", line 133, in ensure_dir
    os.makedirs(path)
  File "<frozen os>", line 225, in makedirs
PermissionError: [WinError 5] 拒绝访问。: 'C:\\Users\\Administrator\\AppData\\Roaming\\pip'
ERROR: Internal Error.
EXIT=1
```

**后果（URL 级）**——配置发现全部落空，pip 走默认官方索引：

- `pip config debug`（`raw-pip-23`、`raw-pv-04`）：`C:\ProgramData\pip\pip.ini`、`<venv>\pip.ini`、`C:\Users\Administrator\pip\pip.ini`、`C:\Users\Administrator\AppData\Roaming\pip\pip.ini` **全部 `exists: False`**。
- 沙箱内 `type %APPDATA%\pip\pip.ini` → `The system cannot find the path specified.`（exit 1）；`existsSync/stat/read` 三面全 `ENOENT`（`raw-pip-25-fs-face-pipini.json`、`raw-pip-47-fs-face-after.json`）。
- 默认路径 `pip install -vv six`（`run3/.../raw-pv-05-install-vv-config-path.txt`）：
  ```
  Starting new HTTPS connection (1): pypi.org:443
  https://pypi.org:443 "GET /simple/pip/ HTTP/1.1" 200 38310
  Found link https://files.pythonhosted.org/packages/3d/9d/…/pip-0.2.tar.gz (from https://pypi.org/simple/pip/), version: 0.2
  ```
  URL 计数（`.t/r16/pkgs/verify/mirror-url-grep.txt`）：**`pypi.org`=354、`files.pythonhosted.org`=342、`pypi.tuna.tsinghua.edu.cn`=0**。
- 对照：**显式** `--index-url https://pypi.tuna.tsinghua.edu.cn/simple` 生效（`Looking in indexes: …清华…`，清华=972、`pypi.org`=0；`raw-pv-06/07`、`raw-pip-40/41`）。
- 宿主对照（`host/ctrl/raw/ctrl-07/08`）：同一台机的同一 pip，用 `PIP_CONFIG_FILE` 指向清华 ini → 打印 `Looking in indexes: https://pypi.tuna.tsinghua.edu.cn/simple`；不设配置 → **没有**该行 ⇒ 判决"沙箱内配置确实没生效"。

### 最小复现（命令级）

```cmd
rem 1) 起沙箱线程（golden 三件套、TS 档）
cmd /c "<REPO>\docs\archive\round10\env\scripts\sbx-thread.cmd" <wsDir> <promptFile> <outDir> winstage
rem 2) 线程内（一次 pwsh 调用）：
uv venv --python C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe --seed --index-url https://pypi.tuna.tsinghua.edu.cn/simple <outDir>\venv
<outDir>\venv\Scripts\python.exe -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
rem 期望（宿主行为）：Writing to …\pip.ini 且 exit=0
rem 实测（TS 档）：Writing to …\pip.ini 然后 PermissionError [WinError 5] …\AppData\Roaming\pip，exit=1
```

### 根因（能定到的部分 + 明确标出的推断）

- **已定位到操作**：失败点是 `pip/_internal/utils/misc.py:133 ensure_dir()` → `os.makedirs('C:\\Users\\Administrator\\AppData\\Roaming\\pip')`，即**对逻辑路径显式新建目录**这一步被拒（`WinError 5`），不是写文件、不是权限模板。
- **已排除"沙箱禁止该路径"**：run5 的 `staged/out-ev-mkdir/raw/raw-mk-04-node-mkdir.json` 里，**同一逻辑路径**由 node 执行 `mkdirSync('C:\\Users\\Administrator\\AppData\\Roaming\\pip', {recursive:true})` 返回 **`"mkdir":"ok"`**，随后同进程 `writeFileSync` 也 `"ok"`。⇒ 拒绝与**调用方/调用序列**有关，与该路径本身无关。
- **`[推断]`**（两条候选，未在本轮定死）：
  1. CPython 的 `os.mkdir`（CRT `_wmkdir` → `CreateDirectoryW`，随后可能还有一次属性/ACL 相关的 Win32 调用）里，**只有 `CreateDirectoryW` 被 shim 重定向**，后续那一环在逻辑路径上落回真实盘并被拒 → `WinError 5`；node/libuv 的 `mkdirSync` 只走 `CreateDirectoryW`，所以 `ok`。
  2. shim 的目录面状态机：pip 在 `config set` 之前**先做过** `os.path.isfile('…\\pip\\pip.ini')` 的配置发现（负向结果），这次负向查找把后续对 `…\\pip` 的建目录判成 `ACCESS_DENIED`。
- **未跑**：同 run 内 Python 与 node 对同一逻辑路径的 A/B（第 7 个 run，超出本域 run 预算）。建议 Lead 用下面这段一次性分辨：
  ```cmd
  rem 同一个沙箱线程、同一个 pwsh 调用里依次执行：
  node -e "require('fs').mkdirSync(process.env.APPDATA+'\\r16-p6-node')" & echo node_rc=%ERRORLEVEL%
  "C:\Users\Administrator\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe" -c "import os;os.makedirs(os.environ['APPDATA']+'\\r16-p6-py');print('py_ok')" & echo py_rc=%ERRORLEVEL%
  "C:\...\python.exe" -c "import os;print(os.path.isdir(os.environ['APPDATA']+'\\r16-p6-py2\\pip.ini'));os.makedirs(os.environ['APPDATA']+'\\r16-p6-py2');print('py2_ok')" & echo py2_rc=%ERRORLEVEL%
  ```
  若 `node_rc=0` 而 `py_rc≠0`（候选 1 成立），修法落在 shim 的 `CreateDirectory` 分支；若 `py_rc=0` 而 `py2_rc≠0`（候选 2 成立），修法落在 shim 的负向查找/状态清理。

### 影响

- 任何依赖 `pip config`（`%APPDATA%\pip\pip.ini` 或 `C:\ProgramData\pip\pip.ini`）落地内网镜像的流程，在 TS 档下**连配置都建不起来**；无出网时表现为超时/失败，会被误判为"镜像不可达"。
- 与 **R15 §0** 的"golden 不含 R12 的 P0 目录枚举修复"一致：R12 的目录面修复被撤走后，**显式建目录**这条路径回到 R12 之前形态（R11 当时能写成功，说明 R11 的件与此不同）。

### 建议修复

1. **shim 侧**：把 `CreateDirectoryW`（及 CPython `os.mkdir` 后续那次属性调用）在**逻辑路径**上统一重定向到 stage 覆盖层，**不得**像 R14 那样顺手在真实盘建目录（R15 §2.2 的教训；`WINSTAGE_STAGE_DIRAWARE` 现为 opt-in，可作为实现基础）。
2. **回归夹具**：把"`%APPDATA%\pip` 不存在时 `os.makedirs` 应成功"与"`pip config set` 后 `pip config list` 能读到 `global.index-url`"写成沙箱内断言，纳入 lane=TS 的门禁套件。
3. 短期**用户面绕行**（本轮实测有效，但不要当修复）：`pip install --index-url <镜像>` / `pip download --index-url <镜像>`；`uv` 侧同样传 `--index-url` / `UV_DEFAULT_INDEX`。

---

## D2-R16-2【P2】重定向写入后 **stat/属性面与 read 面给出相反答案**（同一进程、同一路径）

**请求项相关**：这是"配置写到哪里 / 是否真的生效"能否判准的前置条件，也是 D2-R16-1 的成因候选之一。

### 现象（本轮 3 类独立读数，全在 TS 档）

| # | 路径 | `existsSync` | `stat` | `readFileSync` | 证据 |
|---|---|---|---|---|---|
| 1 | `C:\Users\Administrator\.npmrc`（`npm config set` 刚写） | `true` | **`ok size=40`**（= 真实盘那个 40 B 文件） | **`ok bytes=77`**（= 覆盖层内容，含哨兵 `user-agent=r16-pkgs-marker-20261011`） | `run4/.../raw-npm-10-fs-face-probe.json`；`raw-npm-33-npmrc-after-hash.json`（`bytes:77, statSize:40, sha256=2c6e0c74…`） |
| 2 | `C:\r16-pkgs-desktop-probe.txt` 等 3 个越界探针（node 刚写） | `false` | `ENOENT` | **`ok`，内容 `R16-PKGS-OUTSIDE`** | `run4/.../raw-npm-29-outside-write.json` |
| 3 | 同一逻辑目录，先 `mkdir` 成功、后跨进程 `type`/`dir` | — | `ENOENT` | 进程内 `readBack` ok | `run5/.../raw-mk-04-node-mkdir.json`、`raw-mk-05-type-croot-marker.txt`（`The system cannot find the path specified.`）、`raw-mk-10-dir-croot.txt`（`File Not Found`） |

**run5 的完整读数**（每行一条，`raw-mk-04-node-mkdir.json`）：
```
{"tag":"C-root-nonrecursive","dir":"C:\\r16-mkdir-probe","mkdir":"EEXIST …file already exists…","write":"ok","existsSync":false,"statIsDir":"ENOENT","readBack":"R16-MKDIR"}
{"tag":"appdata-nonrecursive","dir":"…\\AppData\\Roaming\\r16-mkdir-probe","mkdir":"EEXIST …","write":"ok","existsSync":false,"statIsDir":"ENOENT","readBack":"R16-MKDIR"}
{"tag":"home-nested-nonrecursive","dir":"…\\.r16-mkdir-probe\\deep","mkdir":"ok","write":"ok","existsSync":false,"statIsDir":"ENOENT","readBack":"R16-MKDIR"}
{"tag":"appdata-recursive-makedirs","dir":"…\\AppData\\Roaming\\r16-mkdir-probe-r\\a\\b","mkdir":"ok","write":"ok","existsSync":false,"statIsDir":"ENOENT","readBack":"R16-MKDIR"}
{"tag":"pip-target-recursive-makedirs","dir":"…\\AppData\\Roaming\\pip","mkdir":"ok","write":"ok","existsSync":false,"statIsDir":"ENOENT","readBack":"R16-MKDIR"}
```
⇒ **`mkdir` 报成功、内容可读、但属性/枚举面看不到**；跨进程连"文件在哪"都找不到；而第二次 `mkdir` 又能得到 `EEXIST`（说明 shim 内部**记得**建过）。

### 最小复现（命令级）

```cmd
cmd /d /c "<REPO>\docs\archive\round10\env\scripts\sbx-thread.cmd" <ws> <prompt> <out> winstage
rem 线程内：
node -e "const fs=require('fs');const p=process.env.APPDATA+'\\r16-face-probe';fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'\\m.txt','X');console.log('exists='+fs.existsSync(p),'stat='+(fs.statSync(p).size),'read='+fs.readFileSync(p+'\\m.txt','utf8'))"
rem 实测：mkdir ok / write ok；exists=false、stat 抛 ENOENT；read 成功
```
宿主侧同路径**不存在**（`.t/r16/pkgs/host/` 复核；真实盘零落盘）。

### 根因

`[推断]` 与 R11 **D2-3** 同族：重定向写入只覆盖了 `open/read/write` 面，**属性（`GetFileAttributes`/`stat`）与枚举（`FindFirstFile`）面没有同步到覆盖层**；R15 §0/§2.3 已确认 golden 不含 R12 的 P0 目录枚举修复（`CORE_enum_A THREW DirectoryNotFoundException`），本轮在**包管理器配置/安装**场景再次独立复现。

### 影响

- `pip config` 的配置发现（走 `os.path.isfile`）、npm 对父目录存在性的判断、`npm install -g` 的 `mkdir` 前置判断都会误判（见 D2-R16-3）。
- 嵌套 agent 的 `Get-ChildItem`/`dir` 列不出自己刚写的产物（本轮 run1/run2 的嵌套线程各白耗 10+ 分钟排查）。

### 建议修复

与 D2-R16-1 的第 1 条同一处：目录面/属性面要么**全部**重定向进 stage（含 `FindFirstFile`/`GetFileAttributes`），要么在无法重定向时**fail-visible**（返回明确错误而不是"成功但不可见"）。

---

## D2-R16-3【P2】`npm install -g` 被拒的错误形态是 `ENOENT -4058`（"父目录不存在"），掩盖了"被沙箱拦截"这一真因

`run4/.../raw-npm-27-g-cowsay.txt` 原样：
```
npm error code ENOENT
npm error syscall mkdir
npm error path C:\Users\Administrator\AppData\Roaming\npm\node_modules\cowsay
npm error errno -4058
npm error enoent ENOENT: no such file or directory, mkdir '…\node_modules\cowsay'
```
- `npm prefix -g` / `npm root -g` **能读出**真实路径（`raw-npm-24/25`），说明是"读得到、写不进"；真实盘 `node_modules` 前/后均 `@deepseek-ai,npm,pnpm`，`cowsay` 不存在（`raw-npm-26/28` + 宿主复核）。
- 与 R11 **D2-3** 同族（R11 记 `EPERM -4048` → 本轮 `ENOENT -4058`）：由于 D2-R16-2 的属性面不一致，npm 先 `stat` 父目录失败 ⇒ 判"父目录不存在"⇒ 报 `ENOENT`，而不是"操作被沙箱拒绝"。
- **影响**：用户/自动化把"沙箱拦截"误读成"npm 环境损坏/路径错误"，排障成本高。
- **建议**：被拦截的写操作返回明确的失败（如 `EPERM`/专用错误码 + 沙箱来源标记），或让属性面与写入面一致（D2-R16-2 的同一修法）。

---

## 非缺陷（方法学 / 环境事实，仅记录）

1. **`npm` 必须 `call`**：`npm` 在 PATH 上是 `npm.cmd`，批处理里直接调用会**吞掉脚本后续步骤**（run1 早停；与 R10 §5.2 的 `dsh` 坑同族）。这是**我方电池脚本**的坑，不是沙箱缺陷；`run4` 用 `call npm` 跑通。
2. **真实 `~/.npmrc` 本来就含 `registry=https://registry.npmmirror.com`**（基线 40 B，`host/` 基线记录）。读直通 ⇒ npm 镜像可用性**部分继承自真实配置**，不能全部归因于沙箱内写入；本报告用哨兵键 + `npm config list` 来源文件 + 安装日志 URL 三证合一来判定。
3. **控制台代码页**：`lane.txt` 里 `conclusion` 的中文在 PowerShell 里显示为乱码（文件本体是正确的 UTF-8/JSON），不影响 `degraded`/`tierEffective`/`LANE_OK` 判读。
4. **本轮未产生任何敏感材料副本**：本域不触碰凭据/密钥文件；三个越界探针内容为固定串 `R16-PKGS-OUTSIDE`，真实盘已确认不存在，**无需清理**。
5. **已知背景（不作为本域缺陷）**：网络档位 `OBSERVED_ONLINE` 未落地（`state: not-implemented`，与 R15 一致）；长路径 158 字符阈值未修——两者本轮均未触发、未测。

## 未跑 / 局限

| 项 | 状态 |
|---|---|
| D2-R16-1 的 API 级判定（同 run 内 Python vs node 建目录 A/B） | `not-run`（超单域 run 预算；命令已写在上面，可直接跑） |
| `pip config set --global`（`C:\ProgramData\pip\pip.ini`） | `not-run`（`[推断]` 撞同一处新目录创建） |
| platform 档（`WINSTAGE_SHELL=0`）对照 | `not-run`（会真实写盘；R11 D2-2 已有完整对照） |
| `pip install --user` / `python -m venv`（带 pip）/ `uv python install` 冷装 | `not-run`（见报告 §8） |
