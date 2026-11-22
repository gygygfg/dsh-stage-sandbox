# dshnt-launch.exe — 域启动器

> 只做“把目标进程放进域”这件事：token / Job / mitigation / 环境 / cwd / 域注册。
> 不解析命令、不跑 shell、不碰真实工作区。

## 输入

```text
dshnt-launch.exe
  --domain <id>
  --view <viewRoot>
  --workspace <workspaceRoot>
  --policy-generation <n>
  --network <offline|allowlist|observed>
  --job-memory-mb <n>
  --job-active-processes <n>
  --job-cpu-percent <n>
  --token <appcontainer|restricted>
  --sid <S-1-...>        # appcontainer 时
  --cwd <path>           # 默认 viewRoot
  --env-allow <K=V> ...  # 环境白名单（不 merge 父环境）
  -- <argv...>           # 目标进程
```

退出码透传目标进程；launcher 自身错误用独立退出码 + stderr 机读码
（`NT_LAUNCH_*`），不得冒充目标命令失败。

## 启动顺序

1. 校验输入：路径已规范化、域 id 唯一、view/workspace 不重叠、policy generation 合法。
2. 打开 AppContainer profile（每域独立）或创建受限令牌；设置 Low IL。
3. 创建 Job Object：
   - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   - `JOB_OBJECT_LIMIT_PROCESS_MEMORY` / `JOB_OBJECT_LIMIT_JOB_MEMORY`
   - `JOB_OBJECT_LIMIT_ACTIVE_PROCESS`
   - CPU rate control（可用时）
4. 构造 `STARTUPINFOEX`：
   - `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`（AppContainer）
   - `PROC_THREAD_ATTRIBUTE_JOB_LIST`
   - `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`
   - `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY`
   - `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`（只保留 stdio；关闭继承句柄）
5. `CreateProcessAsUserW` / `CreateProcessW` with `CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT`。
6. 通过控制面/端口注册 `(pid, domainId, viewRoot, sid)`；等确认。
7. `ResumeThread`；等待/透传退出码。
8. 清理：注销域、删 AppContainer profile、关 Job/句柄。

## 环境

- **绝不 merge 父环境**；按允许清单重建。
- `TEMP`/`TMP` 指向视图内 `.dsh-tmp`（标记为不参与候选）。
- `PWD`/`OLDPWD`/`DSH_*` 指向视图根或逻辑根由控制面决定；输出由 conceal 还原。
- 代理/凭据变量按策略剥离；不得把宿主 token 传入域。

## 进程缓解（seccomp 等价物）

- 默认：CFG、扩展点禁用、禁止动态代码（按工具兼容性选择）、禁止 Win32k（非 GUI 命令）。
- ACG/CIG 会破坏 JIT（Node/.NET/PowerShell），**按域 opt-in**，不要默认全开。
- 任何缓解导致启动失败都必须显式报 `NT_CAPABILITY_MISSING`，不回退直跑。

## 网络

- `offline`：WFP 按 AppContainer SID block 全部出站/入站（回环/DNS 策略单独决定）。
- `allowlist`：只放行 host:port；必须回读确认过滤器已安装。
- `observed`：只记录；状态卡标注未强制。
- 网络强制失败 ⇒ 拒绝执行，不静默放行。

## 安全

- launcher 自身可信；不得把端口句柄/策略句柄传给目标进程。
- `HANDLE_LIST` 关闭所有非 stdio 继承句柄；防止目录 fd 上溯。
- 域注册必须在 `ResumeThread` 前完成；注册失败即终止子进程。
- 退出/崩溃时 Job 关闭杀整树；清理 AppContainer profile 与域表项。
