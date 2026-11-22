# NT 沙箱策略格式（v1）

> 实现：`src/nt/types.ts` / `src/nt/policy.ts`。本文是控制面与驱动的“同一份语言”。
> 策略只接受**绝对本地 Win32 路径**；设备/UNC/ADS/通配符在 v1 一律拒绝。

## 1. 模型

```text
domain（主体）
  └─ rule（对象类型 + 路径 + 访问 + 动作）
globalMasks（所有域共享的强制遮蔽）
```

| 概念 | 字段 | 含义 |
|---|---|---|
| 域 | `id` / `label` | 会话/尝试 id；label 是审计/分类标签 |
| 工作区 | `workspaceRoot` | 真实工作区（lower） |
| 视图 | `viewRoot` | ProjFS 视图根（upper/staging） |
| 存储 | `storeRoot` | 候选/证据/日志（必须与工作区不重叠） |
| 令牌 | `tokenMode` / `appContainerSid` | AppContainer 或受限令牌；网络白名单要求 AppContainer |
| 资源 | `job` | 内存/进程数/CPU/kill-on-close |
| 网络 | `network.mode` / `allow` | `offline` / `allowlist` / `observed` |
| 默认读 | `defaultRead` | 未命中规则时读放行/拒绝；写类默认拒绝 |
| 规则 | `rules[]` | 见下 |

## 2. 规则

```ts
interface NtRule {
  id: string              // 域内唯一；审计命中原因
  type: string            // workspace/system/secret/store/...（分类标签）
  match: { kind: 'exact' | 'prefix'; path: string }
  access: NtAccess[]      // read/write/execute/delete/rename/attribute
  action: 'allow' | 'deny' | 'stage' | 'mask'
  note?: string
}
```

### 动作语义

| 动作 | 读 | 写/删/改名/属性 | 驱动行为 |
|---|---|---|---|
| `allow` | 允许 | 允许（仅工作区外） | 直通 |
| `deny` | 拒绝 | 拒绝 | `STATUS_ACCESS_DENIED` |
| `stage` | 不允许（策略非法） | 进视图根 | 重定向到 ProjFS 视图 |
| `mask` | 不可见/拒绝 | 拒绝 | 读返回不存在/空；写拒绝 |

### 优先级

1. `globalMasks` 命中 ⇒ `mask`（读不可见，写拒绝）。
2. 域规则按特异性降序：`exact` > 更长 `prefix`；同特异性 `deny > mask > stage > allow`；
   再按 `rule.id` 稳定排序。
3. 未命中 ⇒ 读用 `defaultRead`；写/删/改名/执行/属性一律 `deny`。

### 硬校验（违反即 `NT_POLICY_INVALID`）

- `viewRoot` / `storeRoot` 与 `workspaceRoot` 不得互相包含；
- 不同域之间 `viewRoot` / `storeRoot` 不得重复/嵌套；不得落在别的域工作区内；
- **工作区内 `allow` 写/删/改名/属性 = 非法**（会绕过暂存直接写真实盘）；
- `stage` 规则必须在 `workspaceRoot` 内，且只能用于写类访问；
- 路径不能是设备/UNC/ADS/通配符；不能超长；
- `appcontainer` 模式必须有合法 SID；不同域的 AppContainer SID 不得重复（WFP 按 SID 过滤）；
- `allowlist` 网络要求 `tokenMode='appcontainer'`；
- `rule.id` / domain `id` 不得重复；
- Job 数值必须为正；CPU 0..100；端口 1..65535。

## 3. 示例

```ts
const policy: NtPolicySet = {
  version: 1,
  generation: 1,
  createdAt: new Date().toISOString(),
  globalMasks: defaultCredentialMasks('C:\\Users\\alice'), // .ssh/.aws/.gnupg/...
  domains: [{
    id: 'sess-1',
    label: 'dsh.ai.sess-1',
    workspaceRoot: 'C:\\work\\proj',
    viewRoot: 'D:\\dshnt\\view\\sess-1',
    storeRoot: 'D:\\dshnt\\store\\sess-1',
    tokenMode: 'appcontainer',
    appContainerSid: 'S-1-15-2-1-2-3-4',
    job: { memoryMb: 4096, activeProcessLimit: 256, cpuPercent: 80, killOnClose: true },
    network: { mode: 'offline', allow: [] },
    defaultRead: 'deny',
    rules: [
      ...defaultRulesForDomain({
        workspaceRoot: 'C:\\work\\proj',
        viewRoot: 'D:\\dshnt\\view\\sess-1',
        storeRoot: 'D:\\dshnt\\store\\sess-1',
      }),
      // 精确 deny 覆盖工作区 allow
      {
        id: 'deny-local-secret',
        type: 'secret',
        match: { kind: 'exact', path: 'C:\\work\\proj\\secret.txt' },
        access: ['read'],
        action: 'deny',
      },
    ],
  }],
}
```

`defaultRulesForDomain()` 生成：

- 工作区读/执行 `allow`；
- 工作区写/删/改名/属性 `stage`；
- store 直接访问 `deny`（驱动更早的硬拒绝也会命中）；
- 视图路径**不再单独写 deny 规则**：M1 实测重定向续开会用视图新名字重发 create，
  驱动把视图路径映射回逻辑工作区路径后按同一套规则判定（见 `M1-REPORT.md` §3.1）。
  因此按视图路径写的 deny/mask 规则永远不会命中，策略里不要依赖它们；
- `C:\Windows`、`C:\Program Files`、`C:\Program Files (x86)` 读/执行 `allow`、写 `deny`。

## 4. 网络

| 模式 | 强制 | 说明 |
|---|---|---|
| `offline` | WFP block all | 默认；适合 AI shell |
| `allowlist` | WFP allow host:port | 需要 AppContainer SID；DNS/回环/元数据单独策略 |
| `observed` | 不拦截 | 只记录；**不得当作隔离边界**，状态卡会标 warning |

## 5. v1 不支持（明确拒绝，不静默降级）

- 设备命名空间（`\Device\*`、`\\?\GLOBALROOT\*`）；
- UNC（`\\server\share`）；
- ADS（`file:stream`）；
- 通配符/正则规则（驱动只认 exact/prefix；控制面可展开为前缀）；
- 每文件持久标签（ADS/EA/side DB）——后续阶段；
- 注册表规则——后续阶段；
- 进程/网络“命名空间”级隔离——后续阶段或容器。

## 6. 错误与状态

策略错误统一 `NtError('NT_POLICY_INVALID', { errors, warnings })`；
状态卡通过 `src/nt/status.ts::renderStatusCard()` 展示：

```text
NT 沙箱：内核路径就绪
  执行档位: kernel-projfs-minifilter
  写屏障: kernel-projfs-minifilter
  驱动: 已加载 v0.1.0 abi=1 altitude=328000
  ProjFS: enabled=true provider=running view=D:\dshnt\view\sess-1
  策略: valid generation=1 hash=xxxx…
  域: 1
  网络: offline enforced=true
  Apply: ready
```
