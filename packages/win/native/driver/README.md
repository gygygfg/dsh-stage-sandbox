# dshnt.sys — 小型 minifilter

> 职责：**同路径重定向 + 策略**；不实现 copy-up/whiteout/目录合并（ProjFS 负责）。

## 注册

- `FltRegisterFilter`，altitude 在 M0 实测后固定（建议高于 ProjFS 相关过滤，避免重定向后
  再次命中；具体值由 `fltmc filters` 顺序验证）。
- `InstanceSetup` 只为本地固定卷注册；网络卷/可移动卷 v1 明确不支持。
- 回调：
  - `IRP_MJ_CREATE`（核心）
  - `IRP_MJ_CLEANUP` / `IRP_MJ_CLOSE`（上下文回收）
  - `IRP_MJ_DIRECTORY_CONTROL`（仅做 store/view 隐藏；合并交给 ProjFS）
  - `IRP_MJ_SET_INFORMATION`（写/删/改名/属性的兜底）
  - `IRP_MJ_ACQUIRE_FOR_SECTION_SYNCHRONIZATION`（写映射前确保已物化）
  - `IRP_MJ_DEVICE_CONTROL` / `IRP_MJ_FILE_SYSTEM_CONTROL`（卷/设备操作拒绝）
- `PsSetCreateProcessNotifyRoutineEx`：域继承/清理。
- 通信端口：`\DshNtPort`（见 `include/dshnt_abi.h`）。

## PreCreate 重定向（SimRep 模式）

对域内进程 + 受保护根路径：

1. `FltGetFileNameInformation(FLT_FILE_NAME_NORMALIZED | FLT_FILE_NAME_QUERY_DEFAULT)`；
2. 计算逻辑路径；查策略（global mask → 域规则 → 默认）；
3. 需要重定向时：
   - 目标 = `viewRoot + relative(logical, workspaceRoot)`；
   - `IoReplaceFileObjectName(TargetFileObject, target)`；
   - `Data->Iopb->TargetFileObject->RelatedFileObject = NULL`；
   - `Data->IoStatus.Status = STATUS_REPARSE; Data->IoStatus.Information = IO_REPARSE;`
   - `return FLT_PREOP_COMPLETE;`
4. 直接访问 view/store 根、设备、backup intent、`FILE_OPEN_BY_FILE_ID` ⇒ `STATUS_ACCESS_DENIED`；
5. ADS/硬链接创建 ⇒ `STATUS_NOT_SUPPORTED`（v1）。

### 必须处理的细节

- `SL_OPEN_TARGET_DIRECTORY`、尾随名、`FILE_OPEN_REPARSE_POINT`、目录/非目录标志；
- 相对打开：v1 cwd=视图根，且只保留 stdio 句柄；仍需对 handle-relative 打开做最终路径解析，
  不能假设调用方一定用绝对路径；
- 大小写/长路径（>260）/Unicode/8.3 短名；
- 驱动自身 I/O 的递归：用 per-thread flag 或 `FltAllocateCallbackData` 绕过；
- 失败关闭：无法解析最终路径的写/删/改名 ⇒ 拒绝，不要“猜一个路径”。

## 策略缓存

- 控制面通过端口下发 `DSHNT_POLICY_HEADER`（草案见 ABI）；驱动按 generation 原子切换。
- 规则按 `match.kind` + 路径前缀排序；查询用前缀 trie 或预排序数组。
- 决策结果可缓存到 `FILE_OBJECT`/stream-handle context，但策略 generation 变化时失效。
- 端口 ACL 只允许控制面/launcher；沙箱进程不得注册域或下发策略。

## 审计

- `deny` 必发事件；`stage`/`redirect`/`mask` 可采样。
- 事件字段：domain id、path、access、action、pid、image、rule id、FILETIME。
- 不记录文件内容；路径可按策略脱敏。
- 高流量用环形缓冲/批量拉取；不要在每个 I/O 同步等用户态。

## 验收

- S1–S15（见 `docs/nt/M0-SPIKE.md`）；
- 未注册进程不拦截；
- raw `NtCreateFile`/`NtOpenFile` 仍被重定向；
- 子进程继承域；
- 驱动卸载/重载无泄漏上下文；
- Driver Verifier + 压力（并发 create/write/delete/rename/enum）无 BSOD。
