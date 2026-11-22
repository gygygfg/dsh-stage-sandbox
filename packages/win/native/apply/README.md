# dshnt-apply.exe — CAS 发布助手

> **唯一**被允许写真实工作区的进程。输入是已批准的 manifest；不接受任意命令/任意路径。

## 为什么单独一个进程

- 插件宿主（Node）对真实工作区写被驱动拒绝，避免“插件代码 bug 误写真实盘”；
- apply helper 只做最小、可审计的 CAS 写入，攻击面远小于整个宿主；
- 驱动只对 helper 的 PID + image hash 临时授权，退出即撤销。

## 输入（命名管道，长度前缀 + JSON/manifest）

```json
{
  "workspaceRoot": "C:\\work\\proj",
  "candidateId": "cs_...",
  "expectedBase": { "src/a.ts": "<sha256>", "...": "..." },
  "changes": [
    { "rel": "src/a.ts", "kind": "modified", "afterBlob": "<path>", "afterSha256": "..." },
    { "rel": "src/b.ts", "kind": "created", "afterBlob": "...", "afterSha256": "..." },
    { "rel": "src/c.ts", "kind": "deleted", "beforeSha256": "..." }
  ]
}
```

- `afterBlob` 是候选 CAS 中的只读 blob；helper 只读它。
- 路径必须是规范化相对路径；拒绝 `..`/绝对/设备/UNC/ADS/通配符。
- 每个 change 的 before/after 哈希必须由控制面校验过；helper 再复核。

## 执行

1. 校验 manifest（schema、路径、哈希、候选/工作区一致）。
2. 整批并发预检当前真实文件哈希 == `expectedBase`；任一不符 ⇒
   `NT_APPLY_CONFLICT`，**零写**。
3. 写前 journal（intent），记录每个路径的 before/after 哈希与临时文件名。
4. 按安全顺序写：
   - 先写临时文件（同目录、唯一名）→ flush → `ReplaceFile`/`MoveFileEx`；
   - 删除：先移到废纸/备份，再删；
   - 目录：先建后删，避免父目录先消失。
5. 复核落盘哈希；失败则按 journal 回滚已写项。
6. 写 undo 快照（成功项），记录归档到 `undo/`；`/winstage undo` 可回退。
7. 返回逐文件结果；失败项不得报成功。

## 安全

- 只接受 host 的命名管道连接（ACL）；不接受沙箱进程。
- 不跟随 reparse/符号链接到工作区外；硬链接/ADS v1 拒绝。
- 目标路径必须在 `workspaceRoot` 内；越界/非法路径整批拒绝。
- 不执行 manifest 里的任何命令/脚本；只做文件复制/替换/删除。
- 崩溃恢复：启动时读 journal，提示/自动完成或回滚；不得留下半写状态。
