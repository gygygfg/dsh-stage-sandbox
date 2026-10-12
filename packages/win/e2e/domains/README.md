# e2e/domains —— 历史域实测脚本归档

本目录是 `_sandbox-tests/`（8 域并行实测 + r2/r3 复核）的**脚本与报告归档**，
由整理轮从 `_sandbox-tests/` 收编入版本库。收编面：

- 全部 `*.md` / `*.json` 报告（`results.json` / `findings.md` / `PROTOCOL.md` / `FINAL-REPORT.md` / runbook）
- 全部可执行探针脚本（`.ts`〔由 `.mjs` 转换〕/ `.cjs`〔原 `.js`〕/ `.ps1` / `.py` / `.cmd`）
- **排除** `evidence/`（原始输出、截图、二进制、浏览器 profile）：体积大且含宿主路径，按 `.gitignore` 原则不入库。

## 域索引

| 域 | 报告 | 要点（一句话） |
|---|---|---|
| `fs/` | `results.json` `findings.md` | **junction 写穿真实磁盘**（`C:\Windows\fs07-through.txt`）；staged-only 文件对目录枚举 API 不可见 |
| `browser/` `browser2/` `browser3/` | 各自 `results.json` `findings.md` + runbook | 沙箱内 Chromium 崩溃的根因是 **profile 被 staged 化**（非 GPU 本身）；EBUSY 死锁 |
| `pip/` | `results.json` `findings.md` | 镜像链路健康，但本机零可用 Python（Store 0 字节存根） |
| `node/` | `results.json` `findings.md` | npm 100% 不可用（元数据族 API 未走 overlay） |
| `exe/` | `results.json` `findings.md` | 下载可校验，但**进程创建不认工作区路径** |
| `registry/` | `results.json` `findings.md` | 255 个逐进程 hive ⇒ 跨进程不可见 |
| `network/` | `results.json` `findings.md` | 出站/监听全开，无命名空间隔离 |
| `sensitive/` | `results.json` `findings.md` | **读面无闸门** + 三通道可外发 |
| `_lead/` | `LEAD-independently-verified.md` | Lead 的通道级独立复核 |
| `r2/` `r2b/` `r3/` | 各自 `PROTOCOL.md` / `FINAL-REPORT.md` / `README.md` | 第二轮/第三轮复核；r3 更正了 v1 协议的多条结论 |

顶层另有 `FINAL-REPORT.md`（总报告）、`PROTOCOL.md`（v1 公共协议 + r3 更正）、
`FIX-BROWSER-USE.md`。

## 注意（这些是**归档**，不是活套件）

- 域探针脚本写死了旧会话路径（`C:\Users\Administrator\Desktop\WinStageSandbox\...`）与旧 API，
  **不保证**在别处可直接运行；它们是**证据的可复现记录**，不是 CI 套件。
- `*.ts` 由 `.mjs` 机械转换并带首行 `// @ts-nocheck`；`.cjs` 由 `.js` 改名（CommonJS 本相）。
- 结论以各域 `findings.md` 为准；`evidence/` 原件保留在磁盘但不在版本库。
