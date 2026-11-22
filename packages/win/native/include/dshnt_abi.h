/*
 * dshnt_abi.h — NT 内核沙箱驱动/launcher/apply helper 的共享 ABI。
 *
 * 状态：M1 冻结版本（v2）。任何字段变化都必须提升 DSHNT_ABI_VERSION，并让两端
 *       fail-closed（驱动拒绝版本不符；控制面在 hello 时不匹配即报
 *       NT_DRIVER_VERSION_MISMATCH）。
 *
 * 设计约束：
 *   - 不使用指针；所有变长字符串用“相对字符串区起点的偏移 + 字节长度”表达；
 *   - 字符串统一 UTF-16LE（与 Windows 原生 UNICODE_STRING 一致）；
 *   - 结构显式 pack(8)，字段宽度固定；
 *   - 驱动只接受 generation 更大的策略；同 generation 幂等；
 *   - 所有消息都带 header，Size 必须与 payload 长度一致，否则拒绝；
 *   - 规则数组的顺序**有语义**：控制面已按“特异性降序 + deny>mask>stage>allow +
 *     rule.id 稳定排序”排好，驱动按顺序取第一条命中（见 docs/nt/POLICY.md §2）。
 *
 * v2 相对 v1 的变化：
 *   + DshntMsgRegisterProcess / DshntMsgUnregisterProcess（PID→域、子进程继承、
 *     provider/apply 可信 PID）；
 *   + DshntMsgQueryEvents（审计事件轮询；避免内核→用户异步推送）；
 *   + DSHNT_STATS 增加 ProcessCount/Events/LastError；
 *   + DSHNT_REGISTER_DOMAIN 增加 WorkspaceRoot/StoreRoot（与策略核对）。
 */

#ifndef DSHNT_ABI_H
#define DSHNT_ABI_H

#if defined(_KERNEL_MODE)
#include <ntddk.h>
#else
#include <windows.h>
#include <stdint.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define DSHNT_ABI_VERSION 2u
#define DSHNT_POLICY_MAGIC 0x4453484Eu /* 'DSHN' */
#define DSHNT_PORT_NAME L"\\DshNtPort"
#define DSHNT_MAX_PATH_CHARS 32767u

/* 审计事件里单条路径/域/规则的上限（固定记录，便于轮询）。 */
#define DSHNT_EVENT_PATH_CHARS 260u
#define DSHNT_EVENT_ID_CHARS 64u
#define DSHNT_EVENT_BATCH 32u

#pragma pack(push, 8)

/* 消息类型。 */
typedef enum _DSHNT_MSG_TYPE {
  DshntMsgHello = 1,
  DshntMsgSetPolicy = 2,
  DshntMsgRegisterDomain = 3,
  DshntMsgUnregisterDomain = 4,
  DshntMsgGrantApply = 5,
  DshntMsgRevokeApply = 6,
  DshntMsgQueryStats = 7,
  DshntMsgEvent = 8,
  DshntMsgRegisterProcess = 9,
  DshntMsgUnregisterProcess = 10,
  DshntMsgQueryEvents = 11,
  DshntMsgReply = 0x8000
} DSHNT_MSG_TYPE;

/* 访问类别位。与 src/nt/types.ts 的 NtAccess 一一对应。 */
#define DSHNT_ACCESS_READ 0x00000001u
#define DSHNT_ACCESS_WRITE 0x00000002u
#define DSHNT_ACCESS_EXECUTE 0x00000004u
#define DSHNT_ACCESS_DELETE 0x00000008u
#define DSHNT_ACCESS_RENAME 0x00000010u
#define DSHNT_ACCESS_ATTRIBUTE 0x00000020u

/* 动作。 */
typedef enum _DSHNT_ACTION {
  DshntActionAllow = 0,
  DshntActionDeny = 1,
  DshntActionStage = 2,
  DshntActionMask = 3
} DSHNT_ACTION;

/* 路径匹配形状。v1 只支持 exact/prefix。 */
typedef enum _DSHNT_MATCH_KIND {
  DshntMatchExact = 0,
  DshntMatchPrefix = 1
} DSHNT_MATCH_KIND;

/* 令牌模式。 */
typedef enum _DSHNT_TOKEN_MODE {
  DshntTokenAppContainer = 0,
  DshntTokenRestricted = 1
} DSHNT_TOKEN_MODE;

/* 网络档位。 */
typedef enum _DSHNT_NETWORK_MODE {
  DshntNetworkOffline = 0,
  DshntNetworkAllowlist = 1,
  DshntNetworkObserved = 2
} DSHNT_NETWORK_MODE;

/* 默认读策略。 */
typedef enum _DSHNT_DEFAULT_READ {
  DshntDefaultReadDeny = 0,
  DshntDefaultReadAllow = 1
} DSHNT_DEFAULT_READ;

/* 进程注册标志。 */
#define DSHNT_PROC_ROOT 0x00000001u    /* 域根进程：子进程继承该域 */
#define DSHNT_PROC_TRUSTED 0x00000002u /* 控制面/provider/apply：不重定向、不拒绝 */

/* 消息头。 */
typedef struct _DSHNT_MSG_HEADER {
  UINT32 Size;     /* 整个消息（header + payload）字节数 */
  UINT16 Version;  /* DSHNT_ABI_VERSION */
  UINT16 Type;     /* DSHNT_MSG_TYPE */
  UINT32 Status;   /* NTSTATUS / Win32；请求时为 0 */
  UINT32 Reserved;
} DSHNT_MSG_HEADER;

/* HELLO 回复。 */
typedef struct _DSHNT_HELLO_REPLY {
  UINT32 AbiVersion;
  UINT32 Capabilities; /* bit0 policy, bit1 domain, bit2 apply, bit3 events */
  WCHAR DriverVersion[64];
  WCHAR Altitude[32];
} DSHNT_HELLO_REPLY;

#define DSHNT_CAP_POLICY 0x00000001u
#define DSHNT_CAP_DOMAIN 0x00000002u
#define DSHNT_CAP_APPLY 0x00000004u
#define DSHNT_CAP_EVENTS 0x00000008u

/*
 * 策略 payload 布局（全部相对 payload 起点 = header 之后）：
 *
 *   [0 .. StringBytes)                    UTF-16LE 字符串区
 *   align8(StringBytes)                   domain 数组（DomainCount 项）
 *   + DomainCount * sizeof(DOMAIN_ENTRY)  rule 数组（RuleCount 项）
 *   + RuleCount * sizeof(RULE_ENTRY)      endpoint 数组（按域 EndpointStart 索引）
 *
 * STRING_REF.Offset 相对字符串区起点；Bytes 为 UTF-16LE 字节数，不含 NUL。
 */
typedef struct _DSHNT_POLICY_HEADER {
  UINT32 Magic;          /* DSHNT_POLICY_MAGIC */
  UINT32 AbiVersion;     /* DSHNT_ABI_VERSION */
  UINT32 Generation;     /* 单调递增 */
  UINT32 DomainCount;
  UINT32 GlobalMaskCount;
  UINT32 RuleCount;
  UINT32 StringBytes;    /* UTF-16LE 字节数 */
  UINT32 Reserved;
  UINT8  Hash[32];       /* SHA-256(canonical policy JSON) */
} DSHNT_POLICY_HEADER;

/* 字符串引用：相对字符串区起点的字节偏移/长度。 */
typedef struct _DSHNT_STRING_REF {
  UINT32 Offset;
  UINT32 Bytes; /* UTF-16LE 字节数；不含 NUL */
} DSHNT_STRING_REF;

/* Job 限制。 */
typedef struct _DSHNT_JOB_LIMITS {
  UINT64 MemoryBytes;
  UINT32 ActiveProcessLimit;
  UINT32 CpuPercent;
  UINT32 KillOnClose;
  UINT32 Reserved;
} DSHNT_JOB_LIMITS;

/* 网络端点（allowlist）。host 是 STRING_REF；port 1..65535。 */
typedef struct _DSHNT_ENDPOINT {
  DSHNT_STRING_REF Host;
  UINT16 Port;
  UINT8  Protocol; /* 0=tcp, 1=udp */
  UINT8  Reserved;
} DSHNT_ENDPOINT;

/* 域条目。 */
typedef struct _DSHNT_DOMAIN_ENTRY {
  DSHNT_STRING_REF Id;
  DSHNT_STRING_REF Label;
  DSHNT_STRING_REF WorkspaceRoot;
  DSHNT_STRING_REF ViewRoot;
  DSHNT_STRING_REF StoreRoot;
  DSHNT_STRING_REF AppContainerSid; /* 可为空 */
  UINT32 TokenMode;                 /* DSHNT_TOKEN_MODE */
  UINT32 DefaultRead;               /* DSHNT_DEFAULT_READ */
  UINT32 NetworkMode;               /* DSHNT_NETWORK_MODE */
  UINT32 EndpointCount;
  UINT32 EndpointStart; /* 端点数组下标 */
  UINT32 RuleCount;
  UINT32 RuleStart;     /* 规则数组下标 */
  DSHNT_JOB_LIMITS Job;
} DSHNT_DOMAIN_ENTRY;

/* 规则条目。 */
typedef struct _DSHNT_RULE_ENTRY {
  DSHNT_STRING_REF Id;
  DSHNT_STRING_REF Type;
  DSHNT_STRING_REF Path;
  UINT32 MatchKind;  /* DSHNT_MATCH_KIND */
  UINT32 AccessMask; /* DSHNT_ACCESS_* */
  UINT32 Action;     /* DSHNT_ACTION */
  UINT32 Reserved;
} DSHNT_RULE_ENTRY;

/* globalMask 用 RULE_ENTRY 表达，只填 Path/MatchKind（Action 固定 mask）。 */

/* 注册域请求。字符串根必须与当前策略里的同名域一致（不一致 ⇒ 拒绝）。 */
typedef struct _DSHNT_REGISTER_DOMAIN {
  DSHNT_STRING_REF Id;
  DSHNT_STRING_REF WorkspaceRoot;
  DSHNT_STRING_REF ViewRoot;
  DSHNT_STRING_REF StoreRoot;
  DSHNT_STRING_REF AppContainerSid;
} DSHNT_REGISTER_DOMAIN;

/* 注销域请求。 */
typedef struct _DSHNT_UNREGISTER_DOMAIN {
  DSHNT_STRING_REF Id;
} DSHNT_UNREGISTER_DOMAIN;

/* 进程注册：PID → 域。ROOT 的子进程自动继承；TRUSTED 不参与重定向/拒绝。 */
typedef struct _DSHNT_REGISTER_PROCESS {
  UINT32 Pid;
  UINT32 Flags;
  DSHNT_STRING_REF DomainId;
} DSHNT_REGISTER_PROCESS;

typedef struct _DSHNT_UNREGISTER_PROCESS {
  UINT32 Pid;
  UINT32 Reserved;
} DSHNT_UNREGISTER_PROCESS;

/* apply helper 授权请求。paths 是 UTF-16 路径数组，用 STRING_REF 数组表达。 */
typedef struct _DSHNT_GRANT_APPLY {
  UINT32 Pid;
  UINT8  ImageHash[32]; /* SHA-256(image)；控制面校验后下发，驱动只存证 */
  UINT32 PathCount;
  UINT32 PathStart; /* STRING_REF 数组下标（相对本消息字符串区） */
} DSHNT_GRANT_APPLY;

/* 查询统计回复。 */
typedef struct _DSHNT_STATS {
  UINT32 Domains;
  UINT32 Rules;
  UINT64 Redirects;
  UINT64 Denies;
  UINT64 Masks;
  UINT32 PolicyGeneration;
  UINT32 LastError;
  UINT32 ProcessCount;
  UINT32 Reserved;
  UINT64 Events;
} DSHNT_STATS;

/* 事件类型。 */
typedef enum _DSHNT_EVENT_TYPE {
  DshntEventDeny = 1,
  DshntEventStage = 2,
  DshntEventMask = 3,
  DshntEventRedirect = 4,
  DshntEventDomain = 5,
  DshntEventDriver = 6
} DSHNT_EVENT_TYPE;

/*
 * 固定尺寸审计事件（轮询批次）。路径按 UTF-16LE 存，NUL 结尾（超长截断）。
 * 不记录文件内容；deny/mask 必记，redirect 采样。
 */
typedef struct _DSHNT_EVENT_RECORD {
  UINT32 Type; /* DSHNT_EVENT_TYPE */
  UINT32 AccessMask;
  UINT32 Action;
  UINT32 Pid;
  UINT64 Timestamp100ns; /* FILETIME */
  WCHAR DomainId[DSHNT_EVENT_ID_CHARS];
  WCHAR Path[DSHNT_EVENT_PATH_CHARS];
  WCHAR RuleId[DSHNT_EVENT_ID_CHARS];
} DSHNT_EVENT_RECORD;

typedef struct _DSHNT_EVENTS_REPLY {
  UINT32 Count;
  UINT32 Dropped;
  DSHNT_EVENT_RECORD Records[DSHNT_EVENT_BATCH];
} DSHNT_EVENTS_REPLY;

#pragma pack(pop)

#ifdef __cplusplus
}
#endif

#endif /* DSHNT_ABI_H */
