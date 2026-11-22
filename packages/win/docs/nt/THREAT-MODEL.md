# NT 内核沙箱威胁模型（v1）

> 本文件描述**要防什么、信任谁、残余什么**。它不是安全认证，也不能替代实测。
> 设计口径：安全边界只由内核/运行时强制提供；文本匹配只做风险分级。

## 1. 资产

| 资产 | 为什么重要 |
|---|---|
| 真实工作区 | AI 误操作/恶意依赖可能删除/覆盖源码、`.git`、构建产物 |
| 用户凭据 | `~/.ssh`、`.aws`、`.git-credentials`、DPAPI/Crypto、npm token、云 CLI |
| 暂存/候选/store | 未发布内容、before/after blob、证据、apply journal |
| 宿主进程 | 插件宿主、DSH、编辑器、终端；不得被沙箱读取/注入/控制 |
| 其它沙箱域 | 不同会话/尝试的视图与暂存必须互不可见 |
| 网络与宿主服务 | 本机回环服务、云元数据、内网、包管理器 |

## 2. 信任边界

```text
[可信]  DSH 宿主 / 插件控制面 / 驱动 / ProjFS provider / apply helper
   │
   │  ctx.sandbox.confine → launcher → 域令牌 + Job
   ▼
[不可信] 沙箱内任意进程（含 AI 生成的代码、脚本、依赖、子进程）
   │
   │  文件/注册表/网络/进程句柄请求
   ▼
[内核] dshnt.sys + ProjFS.sys + token/Job/WFP
```

- **控制面可信**：它编译策略、管理视图、冻结候选、发起 apply。
- **驱动可信**：它是策略的最终执行点；驱动 bug 等于边界失效。
- **ProjFS provider 可信**：它读真实工作区并投影；它不能写真实工作区。
- **apply helper 可信且最小**：唯一被允许写真实工作区的进程；只接受 manifest。
- **沙箱进程不可信**：不假设它会用 Win32 API、不假设它不调用 `NtCreateFile`、
  不假设它不创建子进程、不假设它会遵守路径字符串。

## 3. 硬不变量

1. **真实工作区零写**：沙箱与宿主对真实工作区的写都被驱动拒绝；只有 apply helper
   在批准后按 CAS 写。
2. **视图根/store 不可直接访问**：沙箱只能通过重定向后的逻辑路径访问视图；直接打开
   store/view 根一律拒绝。
3. **删除权威**：ProjFS tombstone = 删除；base 存在但视图既无 tombstone 也无 full/placeholder
   = corruption，不得按真实盘推断为未删除。
4. **默认拒绝**：未显式允许的写/删/改名/执行/属性一律拒绝；读按 domain 的 `defaultRead`。
5. **失败关闭**：驱动/ProjFS/策略/网络/apply 任一缺失 ⇒ 拒绝执行，不静默退回主机。
6. **文本不是边界**：命令行/脚本文本只用于风险分级与提示，绝不作为拒绝/放行的安全判据。

## 4. 攻击面与对策（v1）

| 攻击 | 例子 | 对策 | 残余 |
|---|---|---|---|
| 直达 NT API | 自写 `NtCreateFile`/`NtOpenFile`，绕过 IAT | minifilter 在 `IRP_MJ_CREATE` 统一重定向/拒绝 | 未覆盖的内核路径（见下） |
| 路径混淆 | `..`、`\\?\`、`\Device\HarddiskVolume`、volume GUID、8.3 短名 | 规范化 + 设备/UNC/ADS 拒绝 + 驱动按最终路径判定 | 新 NT 路径形态需持续测试 |
| 句柄上溯 | 继承目录 fd，`openat(dir, "..")` 等价 | launcher 只保留 stdio；`HANDLE_LIST`；驱动按 handle 解析 | 宿主遗留句柄需审计 |
| 相对路径 | cwd 在真实工作区 | v1 cwd=视图根；绝对 `C:\ws` 重定向；子进程继承域 | `pwd` 泄漏由 conceal 还原 |
| 子进程逃逸 | `cmd /c`、脚本、包管理器 | `PsSetCreateProcessNotifyRoutineEx` 域继承；Job kill-on-close | 未注册的既存进程不自动入域 |
| 直接访问 store | 打开 `D:\dshnt\view\...` | 驱动 deny 规则；ACL；重定向标记 | 驱动 flag 实现错误即绕过 |
| 硬链接/ADS | 链接到真实文件；写 `:stream` | v1 明确拒绝（`STATUS_NOT_SUPPORTED`） | 阶段 2 再支持 |
| 重解析点 | junction/symlink 指向真实盘/凭据 | 驱动解析最终路径；越界拒绝；不跟随到未允许根 | 复杂 reparse 需专项 |
| 网络 | 直连、DNS rebinding、云元数据 | WFP 按 AppContainer SID，默认 offline；allowlist 只放行 host:port | 无独立 netns；连接表仍可见 |
| 进程句柄 | 打开宿主/其它域进程 | AppContainer/低 IL + Job；阶段 3 加 `ObRegisterCallbacks` | v1 不隐藏进程列表 |
| 注册表 | 写 HKLM/HKCU | v1 敏感 HKLM 拒绝；HKCU 不暂存 | 阶段 2 才做注册表视图 |
| GUI/IPC | 窗口消息、命名管道、COM | v1 不做 | 阶段 3 |
| 驱动攻击 | 卸载/替换/伪造策略 | 驱动 ACL/签名；沙箱低权限；端口 ACL | 管理员可卸载（个人机威胁模型） |
| 资源耗尽 | fork 炸弹、磁盘写满 | Job active process/memory/CPU；暂存配额 | 配额计数实现需压力测试 |

## 5. 明确不承诺

- **不是 SELinux 移植**：没有 per-object 持久标签、没有类型强制运行时、没有 MAC 认证。
- **不是完整容器**：没有独立网络命名空间、没有独立进程 PID 视图、没有独立注册表 hive。
- **不保证反取证/反检测**：conceal 只做用户可见性，不隐藏驱动/ProjFS 痕迹。
- **不保证对恶意内核驱动/管理员有效**：管理员可加载/卸载驱动、改策略。
- **不保证所有第三方软件兼容**：AppContainer/低 IL 可能让部分工具失败；失败必须显式。

## 6. v1 残余清单（必须与“通过”一起读）

| 编号 | 残余 | 影响 | 计划 |
|---|---|---|---|
| N1 | HKCU 写不暂存 | 注册表修改直接落真实用户 hive | 阶段 2 |
| N2 | HKLM 敏感键直接拒绝 | 需要注册表写的安装/配置命令会失败 | 阶段 2 |
| N3 | 无独立 netns | 宿主连接表/端口可见；不是网络视图隔离 | 阶段 3 |
| N4 | 进程列表可见 | 沙箱能看到宿主进程名/PID | 阶段 3 |
| N5 | GUI/IPC 未隔离 | 窗口站/桌面/命名管道/COM 可触达 | 阶段 3 |
| N6 | ADS/硬链接限制 | 部分工具行为不同 | 阶段 2 |
| N7 | 缓存目录不在视图 | npm/pnpm/用户缓存写真实盘 | 设计决策；可配置 |
| N8 | 测试签名 | 个人机可用，分发不可用 | 正式签名 |
| N9 | ProjFS 性能/可用性 | 首次枚举慢；可选功能未启用 | M0 实测/诊断 |
| N10 | 宿主写拒绝可能误伤 | DSH 其它模块直写工作区会被拒 | 观察 + 显式 grant |
| N11 | 驱动 bug = 边界失效 | BSOD/绕过 | Driver Verifier/对抗测试/VM 快照 |
