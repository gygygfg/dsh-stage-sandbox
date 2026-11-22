# ProjFS provider helper

> 用系统内置 `ProjFS.sys` 提供 COW 视图：lower=真实工作区，upper=视图根。
> 本 helper 是**可信用户态进程**，不在沙箱域内。

## 生命周期

1. 控制面创建/选择视图根（与工作区同卷优先，避免跨卷重定向不确定性）。
2. helper 调 `PrjStartVirtualizing(viewRoot, callbacks, ...)`。
3. 宿主经命名管道下发 backing store（真实工作区）与排除规则。
4. helper 处理 placeholder/内容/目录枚举/通知。
5. 停止时 `PrjStopVirtualizing`；崩溃由宿主检测并 fail-closed。

## 回调

| 回调 | 处理 |
|---|---|
| `GET_PLACEHOLDER_INFO` | 从 backing store 读元数据；写 placeholder info |
| `GET_FILE_DATA` | 从 backing store 读内容；`PrjWriteFileData` |
| `QUERY_DIRECTORY` / `START/END_DIRECTORY_ENUMERATION` | 列 backing store；排序/游标/重启扫描 |
| `NOTIFICATION` | 文件打开/新建/覆盖/删除/改名；用于审计与候选提示 |
| `PRJ_UPDATE_*` | 允许 tombstone/dirty data（删除权威） |

## 语义

- placeholder = 未修改；读走 backing store。
- 写/截断/追加 ⇒ ProjFS 物化为 full file；内容落视图根。
- 删除 ⇒ tombstone；目录枚举隐藏，且不得回退到 lower 复活。
- 目录枚举由 ProjFS 合并本地 full/tombstone 与投影项；helper 只负责投影。
- 视图根/store 对沙箱直接访问由 minifilter 拒绝；helper 以受信 PID 访问。

## 控制面协议（命名管道，草案）

```text
host -> helper: START { viewRoot, backingRoot, excludes[] }
host -> helper: STOP
host -> helper: STATUS
helper -> host: READY { viewRoot, projfsVersion }
helper -> host: EVENT { kind, relPath, pid? }
helper -> host: ERROR { code, message }
```

- 所有路径 UTF-16LE；相对路径用 `\`；拒绝 `..`/设备/UNC/ADS（与 `src/nt/paths.ts` 同口径）。
- 事件不包含文件内容；高频事件可采样。

## 性能

- 首次枚举/水合会触发回调；用目录缓存、批量写 placeholder、避免逐文件同步往返。
- 大文件 `GET_FILE_DATA` 分块；不要一次分配整个文件。
- 10k/50k 文件枚举、`git status`、`pnpm install`、`tsc` 必须实测（M0）。
- 若 ProjFS 枚举不可接受：备选“完整复制 + 重定向”（目录枚举原生），见 `docs/nt/M0-SPIKE.md` §6。

## 安全

- helper 以用户身份运行，不是沙箱进程；不得接受沙箱输入。
- 只读 backing store；**绝不写真实工作区**。
- 视图根 ACL：宿主/provider/对应域 SID；其他域/普通进程拒绝。
- 崩溃/退出必须让控制面 fail-closed；不得让沙箱落回真实盘。
