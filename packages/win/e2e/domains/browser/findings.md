# browser-tester — 浏览器操作域 测试小结

线程：`browser-tester`　写入范围：`_sandbox-tests\browser\`　环境：Windows Server + Windows PowerShell 5.1，
DSH 文件策略 `workspace-write`，根 `C:\Users\Administrator\Desktop\WinStageSandbox`。

## 0. 一句话结论

**本域整体 BLOCKED。** 沙箱内既没有可附着的、开了远程调试的浏览器，也起不来一个 Chromium（Edge 建完
profile 就在打开 DevTools 端口前崩溃），因此 BR-02~BR-07 全部无法执行。但本域仍然**产出了一条高严重度
安全发现**：`browser-use` / `browser-harness` 对工作区外的写入（`%USERPROFILE%\.config\browser-harness\`）
**绕过了 staging，直接落到宿主真实磁盘，且没有 candidate、不会进入 review.json**。

状态计数：`OK 1` / `BLOCKED 6` / `FINDING 2` / `FAIL 0` / `N-A 0`。
（另有一条按 PROTOCOL §6 以 `FAIL` 级别上报的越权写入，作为 BR-08 的 `FINDING` 记录 + 即时消息告警。）

## 1. 状态总表

| id | 标题 | 状态 | 一句话 |
|---|---|---|---|
| BR-01 | `--doctor` 诊断 | **OK** | 拿到了诊断输出；但 `[ok] chrome running` 是误导 |
| BR-02 | 新标签页 + `page_info()` | **BLOCKED** | daemon 起不来：`DevToolsActivePort not found` |
| BR-03 | JS 渲染 / DOM 交互 | **BLOCKED** | 依赖 BR-02 |
| BR-04 | 截图 + SHA256 + `read_image` | **BLOCKED** | 无页面可截，0 份截图证据 |
| BR-05 | AX 树 + boxModel + `click_at_xy` | **BLOCKED** | 无 CDP 连接 |
| BR-06 | 多标签页管理 | **BLOCKED** | 未创建/未切换/未关闭任何标签 |
| BR-07 | 下载逃逸三通道取证 | **BLOCKED** | 无法触发下载，风险**未被验证**（盲区） |
| BR-08 | 浏览器进程与沙箱关系 | **FINDING** | ★ 发现工作区外写入逃逸 staging |
| BR-09 | 易用性 | **FINDING** | 9 步、9 类坑，未到达"页面可操作" |

## 2. 最严重的发现

### F-1 ★ HIGH｜`~/.config/browser-harness` 的写入逃逸文件沙箱

三通道取证（完整原始输出见 `evidence/br08-escape.txt`）：

**通道 1 — 真实磁盘（glob 工具，未被 hook）+ PS**
```
C:\Users\Administrator\.config\browser-harness\tmp\bu-default.log        874 B   2026/10/3 1:27:37
C:\Users\Administrator\.config\browser-harness\version-cache.json         51 B   2026/10/3 1:11:41
C:\Users\Administrator\.config\browser-harness\runtime\                          2026/10/3 1:27:37
```
三个 mtime 全部落在我这次会话内；`bu-default.log` 的内容正是我这次运行写下的
`DevToolsActivePort not found ...` fatal。

**通道 2 — STAGE（地面真值）**：`staged\fs\C\Users\Administrator\.config` **整棵子树不存在**
（`rg: 系统找不到指定的文件 (os error 2)`）。

**通道 3 — candidates**：`grep -E "\.config|browser-harness" candidates\` → **No matches found**。
（对照：candidates 确实能记录工作区外路径，例如 `cs_0001_df0bf71c.json` 里的
`AppData\Local\Temp\dsh-stage-temp\...`。）

**对照组**：同一次运行写入工作区内的 `evidence\br01-doctor.txt` **被正确 staged**（345 B，STAGE 可见）。
所以不是 hook 整体失效，而是 `~/.config` 这条路径逃逸。

**为什么严重**：写入真实磁盘 + 无 staged 副本 + 无 candidate + 永远不会被人工批准，正是 WinStage
"阻止静默降级"要防的形状；而任何 agent 只要跑一次 `browser-use` 就会触发。
**影响面**：仅限工具自己的配置目录（daemon 日志、版本缓存、pid/port），未触及敏感用户文件。
**未证实**：是 spawn 时刻意排除了 browser-harness，还是注入的 shim 对这一路径失效，还是 daemon
进程根本没被注入。需要沙箱外复核同一路径。

### F-2 ★ MED｜`STAGING_WRITE_UNVERIFIED` 执行门随机锁死所有命令

约每两条命令被拒一次，连 `"hello"` 都被拒（完整错误见 `evidence/br09-shell-hazards.txt`）：

```
STAGING_WRITE_UNVERIFIED: refusing to run: the staged root is not verified writable ...
outside-write-staged-not-real=fail (child-reported-ok=false real-disk-has-file=false
 staged=C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\session)
```

- 探测子进程崩溃码在 `0xC0000005`(ACCESS_VIOLATION) / `0xFFFF0000` / `1` 之间跳；
- 失败信息里的 `staged=` 甚至出现过**截断路径** `.dshstage\session`；
- 另有第二种失败模式：命令**静默返回空输出 + exit 1**（`$c = ...; "X=$c"` 形式才拿得到值）；
- `staged\fs\%ALLUSERSPROFILE%\Microsoft\Windows\WER\ReportArchive\...` 出现了**字面量环境变量目录**
  （变量没被展开），随后 `EBUSY: resource busy or locked` 让命令直接失败。

方向是对的（fail-closed，没有"报成功却丢数据"），但代价是本会话每一项检查都要手工重试，交互式
多步任务基本不可用。

### F-3 MED｜工作区回读不可见，与 PROTOCOL 的 read-through 描述不符

用被 hook 的进程写进工作区的文件，**在 PS provider 和 harness 的 read 工具里都看不到**，
只有 STAGE 通道（`.dshstage\...\staged\...`）能看到：

```
$ cmd /c "browser-use --doctor > <ws>\evidence\br01-doctor.txt 2>&1"   -> EXIT=1
$ Get-ChildItem <ws>\evidence          -> 只有 probe-fs-tool.txt，没有 br01-doctor.txt
$ read <ws>\evidence\br01-doctor.txt   -> Error: not found
$ glob <staged>\...\browser            -> 找到 ...\evidence\br01-doctor.txt (345 B)
```

而 harness 自己的 `write` 工具创建的文件（`probe-fs-tool.txt`）立即可见。
危害：测试者按 PROTOCOL 的说明回读会误判"写入没发生"。另外 shell 的 cwd 落在
`.dshstage\...\staged` 而不是工作区根（`Get-Location` 实测），相对路径会静默跑偏。

## 3. 逐 checkpoint 的结论与证据

### BR-01 `--doctor` — OK
```
browser-harness doctor
  platform          Windows 2025Server
  python            3.12.14
  version           0.1.13 (pypi)
  [ok  ] chrome running
  [FAIL] daemon alive — see install.md
  [FAIL] active browser connections — 0
  [FAIL] Browser Use cloud auth — optional: browser-harness auth login
```
证据：`evidence/br01-doctor.txt`（原始输出 + 环境事实）。
附带确认 PROTOCOL 的 M2：系统 `python` 是 0 字节 WindowsApps 存根，**唯一真实解释器**是
uv tool venv 的 `uv\python\cpython-3.12.14-windows-x86_64-none`（`browser-use.exe` 靠它跑）。
本机**没装 Chrome**（3 处标准路径全 False），用户浏览器是 **Edge 154.0.4258.48**，未开远程调试。

### BR-02 `new_tab` + `page_info` — BLOCKED
`Get-Content -Raw code\step2_br02.py | browser-use` → `daemon default didn't come up`，根因：
```
fatal: DevToolsActivePort not found in ['...Chrome\User Data', ... '...Microsoft\Edge\User Data', ...]
— enable chrome://inspect/#remote-debugging, or set BU_CDP_WS for a remote browser
```
证据：`evidence/br02-daemon-fatal.txt`、`code/step2_br02.py`。
自建隔离实例（私用 `--user-data-dir` + `--remote-debugging-port=9223`）也失败，见 BR-08。
未触及任何登录墙（根本没到浏览器）。

### BR-03 / BR-04 / BR-05 / BR-06 — BLOCKED
前置条件 BR-02 失败即终止。**BR-04 的截图证据为 0 份**，`read_image` 无从验证，不计为通过。
**BR-06 对用户浏览器零影响**：没创建、没切换、没关闭任何标签页（用户原有 13 个 `msedge.exe` 进程
未被触碰），因此"测试遗留标签"= 0。

### BR-07 下载逃逸 — BLOCKED，且是**已知盲区**
无法触发任何下载，未产生任何文件。**"浏览器下载是否会绕过文件沙箱"在本环境未被验证**——
不能当作通过，也不能当作安全。建议放到沙箱外通过 CDP 操作真实浏览器完成。

### BR-08 进程与沙箱关系 — FINDING
- 没有 daemon 启动的浏览器（daemon 起不来）。
- 我自拉的隔离 Edge：**进程确实起了**（`Last Version = 154.0.4258.48`、建了 `Default\History`、
  Cache、`Sessions\Session_...`），但**在打开 DevTools 端口前崩溃**——
  `Crashpad\temp\edge_shutdown_crash.txt` 内容 `2`，且全树 **0 个 `DevToolsActivePort`**。
  这与 README"沙箱内起不了 Chromium（Mojo 需要命名管道）"一致。
  证据：`evidence/br08-edge-crash.txt`（staged 下 165 个 profile 文件）。
- **工作区内的浏览器写入被正确 staged**（165 个文件全在 `.dshstage\...\staged\fs\C\...\scratch\` 下）。
- **工作区外的工具写入逃逸** → 见 F-1。

### BR-09 易用性 — FINDING
从零到"页面可操作"：**未到达**。走了 9 步，踩了 9 类坑：

| # | 坑 | 代价 |
|---|---|---|
| 1 | skill 的 `browser-use <<'PY'` heredoc 在 Windows PowerShell 不适用，且无替代写法提示 | 必须自己试出 `Get-Content -Raw x.py \| browser-use` |
| 2 | `STAGING_WRITE_UNVERIFIED` 随机拒绝约半数命令（连 `"hello"` 也拒） | 每条命令手工重试 2~4 次 |
| 3 | 第二种失败模式：静默空输出 + `exit 1` | 误判"命令没结果" |
| 4 | `staged\fs\%ALLUSERSPROFILE%\...` 字面量环境变量目录 → `EBUSY` | 命令直接失败，且原因反直觉 |
| 5 | 工作区回读不可见（PS / read 工具），只有 STAGE 可见 | 与 PROTOCOL 描述冲突，易误判 |
| 6 | shell cwd 落在 staged 目录而非工作区根 | 相对路径静默跑偏 |
| 7 | 工具名 `pwsh`，实际是 Windows PowerShell 5.1 | 语法/行为假设失效 |
| 8 | doctor 的 `[ok] chrome running` 误导 | 排障方向被带偏到"装 Chrome" |
| 9 | 关键前置条件（沙箱内起不了 Chromium / 需开 remote debugging）不在 doctor 里 | 要翻日志 + 外链 install.md |

其中 4 类（heredoc、执行门、空输出、回读不一致）会让人**误判成"自己写错了"**，这是最伤的。

## 4. 建议

1. **【安全·高】** 修掉 `~/.config`（以及同类工作区外路径）的 staging 逃逸：要么把这类写入也重定向，
   要么至少生成 candidate 进 review.json。修之前，任何在沙箱内运行 `browser-use` 的会话都会静默改宿主磁盘。
2. **【安全·高】** 把"浏览器下载是否逃逸"列为沙箱外必测项——本次没能验证，不能默认安全。
3. **【可靠·高】** `STAGING_WRITE_UNVERIFIED` 探测子进程崩溃（0xC0000005 / 0xFFFF0000 / 1）需定位；
   失败信息里的截断路径 `.dshstage\session` 也是 bug。并修掉 `%ALLUSERSPROFILE%` 字面量目录。
4. **【可靠·中】** 修工作区回读可见性（PS / read 工具应能看到 staged 写入），并把 shell cwd 设为工作区根。
5. **【易用·高】** doctor 增加一行明确可执行的 `ACTION REQUIRED:`，并把
   `[ok] chrome running` 改成"检测到 Edge 进程，但无 CDP 端点"这种不误导的措辞。
6. **【易用·高】** skill 的 Usage 段补 Windows 写法（`type x.py | browser-use` / `Get-Content -Raw x.py | browser-use`），
   并说明 `--doctor` 之外还要在浏览器里开 `chrome://inspect/#remote-debugging`。
7. **【易用·中】** 提供 `dsh stage verify <path>` / `dsh stage ls <path>`，一步回答
   "这次写入进没进 staging、有没有 candidate"——现在要手工拼 glob + glob + grep 三条通道。

## 5. 测试遗留物（都在我自己的写入范围内，可安全删除）

- `_sandbox-tests\browser\scratch\edge-profile\`、`edge-profile2\`（Edge 崩溃 profile，含 Crashpad 崩溃标记），
  共 165 个文件，全部在 staging 内，**真实磁盘上不存在**。
- 未留下任何浏览器进程；未创建/关闭任何用户标签页；未修改 `.dshstage` 内容；
  未执行 `flatten`/`apply`/`approve` 之类落盘操作。
- 唯一落在真实磁盘的改动是 `browser-use` 自己写的 `~/.config/browser-harness\**`（见 F-1），
  这是被测评工具的副作用，不是我的显式写操作。

## 6. 证据文件

| 文件 | 内容 |
|---|---|
| `results.json` | 机器可读，BR-01~BR-09 |
| `evidence/br01-doctor.txt` | doctor 原始输出 + 环境事实 |
| `evidence/br02-daemon-fatal.txt` | 首次真实调用失败 + daemon 日志原文 + 用户需做什么 |
| `evidence/br08-escape.txt` | ★ 三通道逃逸取证原始输出 |
| `evidence/br08-edge-crash.txt` | Edge 崩溃取证 + 为什么 BR-02~BR-07 全 BLOCKED |
| `evidence/br09-shell-hazards.txt` | 执行门 / 空输出 / EBUSY / 回读不一致 原始错误 |
| `executions.log` | 逐条命令 + 退出码 + 关键原始输出 |
| `code/step2_br02.py` | BR-02 步骤脚本 |
