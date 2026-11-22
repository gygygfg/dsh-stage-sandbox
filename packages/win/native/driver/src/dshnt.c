/*
 * dshnt.sys — dshnt NT 文件视图 minifilter（v1）
 *
 * 作用（只做这四件事，其余交给 ProjFS）：
 *   1. 把域内进程对“真实工作区” C:\ws\** 的打开重定向到 ProjFS 视图根；
 *   2. 拒绝域内进程直接访问视图根 / store 根（防篡改暂存与证据）；
 *   3. 按域/路径执行 globalMask + 规则（allow/deny/stage/mask）；
 *   4. 维护 PID→域映射（子进程继承）、可信 PID（控制面/provider/apply）、审计计数。
 *
 * 不做的（v1，见 docs/nt/STATUS.md）：
 *   - 注册表暂存、GUI/IPC/进程视图；
 *   - 名称提供者（GetFinalPathNameByHandle 会显示视图路径；不构成绕过，
 *     因为直接打开视图根会被本驱动拒绝）；
 *   - 异步事件推送（改为 QueryEvents 轮询，避免 FltSendMessage 生命周期问题）。
 *
 * 关键不变量：域内进程对工作区的任何打开都必须落到视图；真实工作区唯一的写者
 * 是持有 grantApply 的 apply helper。任何一条不满足都必须拒绝，不得直通。
 *
 * 设计依据：Microsoft SimRep sample 的 IoReplaceFileObjectName + STATUS_REPARSE
 * 模式（M0 已在 Windows 10 上实测同路径透明、相对打开、raw NT 写、删除、改名）。
 */

#include <fltKernel.h>
#include <ntifs.h>
#include <ntstrsafe.h>
#include "dshnt_abi.h"

/* 指针别名（ABI 头只定义了值类型）；ROUND_UP 在 C 模式下不保证可见。 */
typedef DSHNT_MSG_HEADER *PDSHNT_MSG_HEADER;
typedef DSHNT_EVENTS_REPLY *PDSHNT_EVENTS_REPLY;
#define DSHNT_ROUND_UP(value, align) (((value) + ((align) - 1)) & ~((align) - 1))

#define DSHNT_TAG 'tnhD'
#define DSHNT_ALTITUDE L"371100"
#define DSHNT_VERSION_STRING L"0.1.0"

#define DSHNT_MAX_DOMAINS 32
#define DSHNT_MAX_RULES 512
#define DSHNT_MAX_GRANT_PATHS 8
#define DSHNT_MAX_ALLOCS 4096
#define DSHNT_EVENT_RING 64
#define DSHNT_PROC_BUCKETS 256
#define DSHNT_DOMAIN_ID_CHARS 64
#define DSHNT_MAX_GRANTS 16

typedef struct _DSHNT_PATH {
    UNICODE_STRING Device;  /* \Device\HarddiskVolume3 */
    UNICODE_STRING Rel;     /* \ws\sub（卷内相对，以反斜杠开头） */
} DSHNT_PATH, *PDSHNT_PATH;

typedef struct _DSHNT_RULE {
    UNICODE_STRING Id;
    UNICODE_STRING Type;
    DSHNT_PATH Match;
    ULONG AccessMask;
    ULONG Action;
} DSHNT_RULE;

typedef struct _DSHNT_DOMAIN {
    UNICODE_STRING Id;
    UNICODE_STRING Label;
    DSHNT_PATH Workspace;
    DSHNT_PATH View;
    DSHNT_PATH Store;
    WCHAR DriveLetter[3];
    ULONG TokenMode;
    ULONG DefaultRead;
    ULONG NetworkMode;
    ULONG RuleStart;
    ULONG RuleCount;
} DSHNT_DOMAIN;

typedef struct _DSHNT_POLICY {
    ULONG Generation;
    UCHAR Hash[32];
    ULONG DomainCount;
    ULONG RuleCount;
    ULONG MaskCount;
    DSHNT_DOMAIN Domains[DSHNT_MAX_DOMAINS];
    DSHNT_RULE Rules[DSHNT_MAX_RULES];
    DSHNT_RULE Masks[DSHNT_MAX_RULES];
    /* 每个字符串单独分配，避免“字符串块扩容后指针失效”。 */
    PVOID Allocs[DSHNT_MAX_ALLOCS];
    ULONG AllocCount;
} DSHNT_POLICY;

typedef struct _DSHNT_PROC_ENTRY {
    LIST_ENTRY Link;
    ULONG Pid;
    ULONG Flags;
    WCHAR DomainId[DSHNT_DOMAIN_ID_CHARS];
} DSHNT_PROC_ENTRY;

typedef struct _DSHNT_PROC_SNAPSHOT {
    BOOLEAN Found;
    ULONG Flags;
    WCHAR DomainId[DSHNT_DOMAIN_ID_CHARS];
} DSHNT_PROC_SNAPSHOT;

typedef struct _DSHNT_GRANT {
    LIST_ENTRY Link;
    ULONG Pid;
    UCHAR ImageHash[32];
    ULONG PathCount;
    DSHNT_PATH Paths[DSHNT_MAX_GRANT_PATHS];
    PVOID Strings[DSHNT_MAX_GRANT_PATHS * 2];
    ULONG StringCount;
} DSHNT_GRANT;

typedef struct _DSHNT_GLOBALS {
    PFLT_FILTER Filter;
    PFLT_PORT ServerPort;
    PFLT_PORT ClientPort;
    ULONG ClientPid;

    ERESOURCE Lock;
    LIST_ENTRY ProcBuckets[DSHNT_PROC_BUCKETS];
    LIST_ENTRY Grants;

    DSHNT_POLICY *Policy;

    /* 审计 */
    DSHNT_EVENT_RECORD Events[DSHNT_EVENT_RING];
    ULONG EventHead;
    ULONG EventTail;
    ULONG EventCount;
    ULONG EventDropped;

    /* 统计 */
    volatile LONG64 Redirects;
    volatile LONG64 Denies;
    volatile LONG64 Masks;
    volatile LONG ProcessCount;
    ULONG LastError;
} DSHNT_GLOBALS;

static DSHNT_GLOBALS g_Dshnt;

/* 仅用于诊断：策略解析失败时定位到具体分支（0xD0000000|stage）。 */
static ULONG g_ParseStage;

/* ---------------------------------------------------------------- prototypes */

DRIVER_INITIALIZE DriverEntry;
static NTSTATUS DshntUnload(_In_ FLT_FILTER_UNLOAD_FLAGS Flags);
static NTSTATUS DshntInstanceSetup(_In_ PCFLT_RELATED_OBJECTS FltObjects,
                                   _In_ FLT_INSTANCE_SETUP_FLAGS Flags,
                                   _In_ DEVICE_TYPE VolumeDeviceType,
                                   _In_ FLT_FILESYSTEM_TYPE VolumeFilesystemType);
static FLT_PREOP_CALLBACK_STATUS DshntPreCreate(_Inout_ PFLT_CALLBACK_DATA Cbd,
                                                _In_ PCFLT_RELATED_OBJECTS FltObjects,
                                                _Flt_CompletionContext_Outptr_ PVOID *CompletionContext);
static FLT_PREOP_CALLBACK_STATUS DshntPreSetInformation(_Inout_ PFLT_CALLBACK_DATA Cbd,
                                                        _In_ PCFLT_RELATED_OBJECTS FltObjects,
                                                        _Flt_CompletionContext_Outptr_ PVOID *CompletionContext);
static FLT_POSTOP_CALLBACK_STATUS DshntPostSetInformation(_Inout_ PFLT_CALLBACK_DATA Cbd,
                                                          _In_ PCFLT_RELATED_OBJECTS FltObjects,
                                                          _In_opt_ PVOID CompletionContext,
                                                          _In_ FLT_POST_OPERATION_FLAGS Flags);
static NTSTATUS DshntConnect(_In_ PFLT_PORT ClientPort,
                             _In_opt_ PVOID ServerPortCookie,
                             _In_reads_bytes_opt_(SizeOfContext) PVOID ConnectionContext,
                             _In_ ULONG SizeOfContext,
                             _Outptr_result_maybenull_ PVOID *ConnectionPortCookie);
static VOID DshntDisconnect(_In_opt_ PVOID ConnectionCookie);
static NTSTATUS DshntMessage(_In_opt_ PVOID PortCookie,
                             _In_reads_bytes_opt_(InputBufferLength) PVOID InputBuffer,
                             _In_ ULONG InputBufferLength,
                             _Out_writes_bytes_to_opt_(OutputBufferLength, *ReturnOutputBufferLength) PVOID OutputBuffer,
                             _In_ ULONG OutputBufferLength,
                             _Out_ PULONG ReturnOutputBufferLength);
static VOID DshntProcessNotify(_In_ HANDLE ParentId, _In_ HANDLE ProcessId, _In_ BOOLEAN Create);

static const FLT_OPERATION_REGISTRATION g_DshntOperations[] = {
    { IRP_MJ_CREATE,
      FLTFL_OPERATION_REGISTRATION_SKIP_PAGING_IO,
      DshntPreCreate,
      NULL },
    { IRP_MJ_SET_INFORMATION,
      FLTFL_OPERATION_REGISTRATION_SKIP_PAGING_IO,
      DshntPreSetInformation,
      DshntPostSetInformation },
    { IRP_MJ_OPERATION_END }
};

static const FLT_REGISTRATION g_DshntRegistration = {
    sizeof(FLT_REGISTRATION),   /* Size */
    FLT_REGISTRATION_VERSION,   /* Version */
    0,                          /* Flags */
    NULL,                       /* Context */
    g_DshntOperations,          /* OperationRegistration */
    DshntUnload,                /* FilterUnloadCallback */
    DshntInstanceSetup,         /* InstanceSetupCallback */
    NULL,                       /* InstanceQueryTeardownCallback */
    NULL,                       /* InstanceTeardownStartCallback */
    NULL,                       /* InstanceTeardownCompleteCallback */
    NULL,                       /* GenerateFileNameCallback */
    NULL,                       /* NormalizeNameComponentCallback */
    NULL,                       /* NormalizeNameComponentCleanupCallback */
    NULL,                       /* TransactionNotificationCallback */
    NULL                        /* NormalizeNameComponentExCallback */
};

/* ------------------------------------------------------------------- policy */

static VOID DshntInitUnicode(_Out_ PUNICODE_STRING s)
{
    s->Buffer = NULL;
    s->Length = 0;
    s->MaximumLength = 0;
}

/* 在策略里单独分配一份字符串（生命周期 = 策略）。 */
static NTSTATUS DshntPolicyStrdup(_Inout_ DSHNT_POLICY *policy,
                                  _In_ PCUNICODE_STRING src,
                                  _Out_ PUNICODE_STRING dst)
{
    PVOID copy;

    DshntInitUnicode(dst);
    if (src->Length == 0) {
        return STATUS_SUCCESS;
    }
    if (policy->AllocCount >= DSHNT_MAX_ALLOCS) {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    copy = ExAllocatePool2(POOL_FLAG_NON_PAGED, src->Length + sizeof(WCHAR), DSHNT_TAG);
    if (copy == NULL) {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlCopyMemory(copy, src->Buffer, src->Length);
    ((PWCH)copy)[src->Length / sizeof(WCHAR)] = 0;
    policy->Allocs[policy->AllocCount++] = copy;
    dst->Buffer = (PWCH)copy;
    dst->Length = src->Length;
    dst->MaximumLength = (USHORT)(src->Length + sizeof(WCHAR));
    return STATUS_SUCCESS;
}

/* \??\C: → \Device\HarddiskVolumeN（符号链接查询；失败即策略非法）。 */
static NTSTATUS DshntDriveToDevice(_In_ WCHAR letter, _Out_ PUNICODE_STRING device)
{
    WCHAR link[8];
    UNICODE_STRING linkName;
    OBJECT_ATTRIBUTES oa;
    HANDLE handle = NULL;
    NTSTATUS status;
    WCHAR targetBuffer[128];
    UNICODE_STRING target;

    link[0] = L'\\';
    link[1] = L'?';
    link[2] = L'?';
    link[3] = L'\\';
    link[4] = letter;
    link[5] = L':';
    link[6] = 0;

    RtlInitUnicodeString(&linkName, link);
    InitializeObjectAttributes(&oa, &linkName, OBJ_CASE_INSENSITIVE | OBJ_KERNEL_HANDLE, NULL, NULL);

    status = ZwOpenSymbolicLinkObject(&handle, GENERIC_READ, &oa);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    target.Buffer = targetBuffer;
    target.Length = 0;
    target.MaximumLength = sizeof(targetBuffer);
    status = ZwQuerySymbolicLinkObject(handle, &target, NULL);
    ZwClose(handle);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    if (target.Length == 0) {
        return STATUS_INVALID_PARAMETER;
    }

    DshntInitUnicode(device);
    device->Buffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, target.Length + sizeof(WCHAR), DSHNT_TAG);
    if (device->Buffer == NULL) {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlCopyMemory(device->Buffer, target.Buffer, target.Length);
    device->Buffer[target.Length / sizeof(WCHAR)] = 0;
    device->Length = target.Length;
    device->MaximumLength = (USHORT)(target.Length + sizeof(WCHAR));
    return STATUS_SUCCESS;
}

static VOID DshntFreePath(_Inout_ PDSHNT_PATH path)
{
    if (path->Device.Buffer != NULL) {
        ExFreePoolWithTag(path->Device.Buffer, DSHNT_TAG);
    }
    if (path->Rel.Buffer != NULL) {
        ExFreePoolWithTag(path->Rel.Buffer, DSHNT_TAG);
    }
    DshntInitUnicode(&path->Device);
    DshntInitUnicode(&path->Rel);
}

/*
 * 把一条 Win32 绝对路径（C:\ws\sub）拆成 (Device, Rel=\ws\sub)。
 * 两个字符串各自分配，调用方用 DshntFreePath 释放（或复制进策略后再释放）。
 */
static NTSTATUS DshntSplitWin32(_In_ PCUNICODE_STRING win32,
                                _Out_ PDSHNT_PATH out,
                                _Out_opt_ PWCHAR driveOut)
{
    NTSTATUS status;
    UNICODE_STRING device;
    ULONG prefixChars = 2;
    ULONG bytes;

    DshntInitUnicode(&out->Device);
    DshntInitUnicode(&out->Rel);

    if (win32->Buffer == NULL || win32->Length < 4) {
        return STATUS_INVALID_PARAMETER;
    }
    if (!((win32->Buffer[0] >= L'A' && win32->Buffer[0] <= L'Z') ||
          (win32->Buffer[0] >= L'a' && win32->Buffer[0] <= L'z')) ||
        win32->Buffer[1] != L':' || win32->Buffer[2] != L'\\') {
        return STATUS_INVALID_PARAMETER;
    }

    status = DshntDriveToDevice(win32->Buffer[0], &device);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    bytes = win32->Length - prefixChars * sizeof(WCHAR);
    while (bytes >= sizeof(WCHAR) &&
           win32->Buffer[prefixChars + (bytes / sizeof(WCHAR)) - 1] == L'\\') {
        bytes -= sizeof(WCHAR);
    }
    if (bytes < 2 * sizeof(WCHAR)) {
        /* 盘根（C:\）不能作为工作区/视图/规则根。 */
        ExFreePoolWithTag(device.Buffer, DSHNT_TAG);
        return STATUS_INVALID_PARAMETER;
    }

    out->Device = device;
    out->Rel.Buffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, bytes + sizeof(WCHAR), DSHNT_TAG);
    if (out->Rel.Buffer == NULL) {
        DshntFreePath(out);
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlCopyMemory(out->Rel.Buffer, win32->Buffer + prefixChars, bytes);
    out->Rel.Buffer[bytes / sizeof(WCHAR)] = 0;
    out->Rel.Length = (USHORT)bytes;
    out->Rel.MaximumLength = (USHORT)(bytes + sizeof(WCHAR));

    if (driveOut != NULL) {
        driveOut[0] = win32->Buffer[0];
        driveOut[1] = L':';
        driveOut[2] = 0;
    }
    return STATUS_SUCCESS;
}

/* 解析 + 复制进策略（临时字符串随后释放）。 */
static NTSTATUS DshntPolicyPath(_Inout_ DSHNT_POLICY *policy,
                                _In_ PCUNICODE_STRING win32,
                                _Out_ PDSHNT_PATH out,
                                _Out_opt_ PWCHAR driveOut)
{
    DSHNT_PATH parsed;
    NTSTATUS status;

    status = DshntSplitWin32(win32, &parsed, driveOut);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    status = DshntPolicyStrdup(policy, &parsed.Device, &out->Device);
    if (NT_SUCCESS(status)) {
        status = DshntPolicyStrdup(policy, &parsed.Rel, &out->Rel);
    }
    DshntFreePath(&parsed);
    return status;
}

static BOOLEAN DshntPathHasPrefix(_In_ PCUNICODE_STRING path, _In_ PCUNICODE_STRING prefix)
{
    UNICODE_STRING p;

    if (prefix->Length == 0) {
        return TRUE;
    }
    if (path->Length < prefix->Length) {
        return FALSE;
    }
    p.Buffer = path->Buffer;
    p.Length = prefix->Length;
    p.MaximumLength = prefix->Length;
    if (!RtlEqualUnicodeString(&p, prefix, TRUE)) {
        return FALSE;
    }
    if (path->Length == prefix->Length) {
        return TRUE;
    }
    return path->Buffer[prefix->Length / sizeof(WCHAR)] == L'\\';
}

static BOOLEAN DshntPathEquals(_In_ PCUNICODE_STRING a, _In_ PCUNICODE_STRING b)
{
    return a->Length == b->Length && RtlEqualUnicodeString(a, b, TRUE);
}

static VOID DshntFreePolicy(_In_opt_ DSHNT_POLICY *policy)
{
    ULONG i;
    if (policy == NULL) {
        return;
    }
    for (i = 0; i < policy->AllocCount; i++) {
        if (policy->Allocs[i] != NULL) {
            ExFreePoolWithTag(policy->Allocs[i], DSHNT_TAG);
        }
    }
    ExFreePoolWithTag(policy, DSHNT_TAG);
}

/* 从 payload 字符串区取一个字符串（指向 payload；仅解析期间有效）。 */
static NTSTATUS DshntRefString(_In_ const UCHAR *Strings, _In_ ULONG StringBytes,
                               _In_ DSHNT_STRING_REF ref, _Out_ PUNICODE_STRING out)
{
    if (ref.Bytes == 0) {
        DshntInitUnicode(out);
        return STATUS_SUCCESS;
    }
    if ((ref.Bytes & 1) != 0 || ref.Bytes > StringBytes || ref.Offset > StringBytes - ref.Bytes) {
        return STATUS_INVALID_PARAMETER;
    }
    out->Buffer = (PWCH)(Strings + ref.Offset);
    out->Length = (USHORT)ref.Bytes;
    out->MaximumLength = (USHORT)ref.Bytes;
    return STATUS_SUCCESS;
}

static NTSTATUS DshntParsePolicy(_In_ const UCHAR *payload, _In_ ULONG payloadLength,
                                 _Outptr_ DSHNT_POLICY **outPolicy)
{
    const DSHNT_POLICY_HEADER *hdr;
    const UCHAR *strings;
    const DSHNT_DOMAIN_ENTRY *domains;
    const DSHNT_RULE_ENTRY *rules;
    ULONG domainsOffset;
    ULONG need;
    DSHNT_POLICY *policy;
    NTSTATUS status = STATUS_SUCCESS;
    ULONG i;

    if (payload == NULL || payloadLength < sizeof(DSHNT_POLICY_HEADER)) {
        g_ParseStage = 1;
        return STATUS_INVALID_PARAMETER;
    }
    hdr = (const DSHNT_POLICY_HEADER *)payload;
    if (hdr->Magic != DSHNT_POLICY_MAGIC || hdr->AbiVersion != DSHNT_ABI_VERSION) {
        g_ParseStage = 2;
        return STATUS_REVISION_MISMATCH;
    }
    if (hdr->DomainCount == 0 || hdr->DomainCount > DSHNT_MAX_DOMAINS ||
        hdr->RuleCount + hdr->GlobalMaskCount > DSHNT_MAX_RULES) {
        g_ParseStage = 3;
        return STATUS_INVALID_PARAMETER;
    }
    if (hdr->StringBytes > payloadLength - sizeof(*hdr)) {
        g_ParseStage = 4;
        return STATUS_INVALID_PARAMETER;
    }

    strings = payload + sizeof(*hdr);
    domainsOffset = (ULONG)DSHNT_ROUND_UP(hdr->StringBytes, sizeof(PVOID));
    need = sizeof(*hdr) + domainsOffset;
    if (need > payloadLength) {
        g_ParseStage = 5;
        return STATUS_INVALID_PARAMETER;
    }
    domains = (const DSHNT_DOMAIN_ENTRY *)(strings + domainsOffset);
    need += hdr->DomainCount * sizeof(DSHNT_DOMAIN_ENTRY);
    if (need > payloadLength) {
        g_ParseStage = 6;
        return STATUS_INVALID_PARAMETER;
    }
    rules = (const DSHNT_RULE_ENTRY *)((const UCHAR *)domains + hdr->DomainCount * sizeof(DSHNT_DOMAIN_ENTRY));
    need += (hdr->RuleCount + hdr->GlobalMaskCount) * sizeof(DSHNT_RULE_ENTRY);
    if (need > payloadLength) {
        g_ParseStage = 7;
        return STATUS_INVALID_PARAMETER;
    }

    policy = ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*policy), DSHNT_TAG);
    if (policy == NULL) {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlZeroMemory(policy, sizeof(*policy));
    policy->Generation = hdr->Generation;
    RtlCopyMemory(policy->Hash, hdr->Hash, sizeof(policy->Hash));

    for (i = 0; i < hdr->DomainCount; i++) {
        const DSHNT_DOMAIN_ENTRY *src = &domains[i];
        DSHNT_DOMAIN *dst = &policy->Domains[i];
        UNICODE_STRING workspace, view, store;
        UNICODE_STRING refString;
        WCHAR drive[3];

        g_ParseStage = 20;
        status = DshntRefString(strings, hdr->StringBytes, src->WorkspaceRoot, &workspace);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 21;
        status = DshntRefString(strings, hdr->StringBytes, src->ViewRoot, &view);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 22;
        status = DshntRefString(strings, hdr->StringBytes, src->StoreRoot, &store);
        if (!NT_SUCCESS(status)) goto fail;

        /* 注意：src->Id 是 STRING_REF，不是 UNICODE_STRING；必须先转成视图再复制。 */
        g_ParseStage = 23;
        status = DshntRefString(strings, hdr->StringBytes, src->Id, &refString);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 24;
        status = DshntPolicyStrdup(policy, &refString, &dst->Id);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 25;
        status = DshntRefString(strings, hdr->StringBytes, src->Label, &refString);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 26;
        status = DshntPolicyStrdup(policy, &refString, &dst->Label);
        if (!NT_SUCCESS(status)) goto fail;

        g_ParseStage = 30;
        status = DshntPolicyPath(policy, &workspace, &dst->Workspace, drive);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 31;
        status = DshntPolicyPath(policy, &view, &dst->View, NULL);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 32;
        status = DshntPolicyPath(policy, &store, &dst->Store, NULL);
        if (!NT_SUCCESS(status)) goto fail;

        dst->DriveLetter[0] = drive[0];
        dst->DriveLetter[1] = drive[1];
        dst->DriveLetter[2] = 0;
        dst->TokenMode = src->TokenMode;
        dst->DefaultRead = src->DefaultRead;
        dst->NetworkMode = src->NetworkMode;
        dst->RuleStart = src->RuleStart;
        dst->RuleCount = src->RuleCount;

        /* 硬不变量：工作区/视图/store 必须同卷且互不重叠（控制面也校验，双保险）。 */
        if (dst->RuleStart > hdr->RuleCount ||
            dst->RuleCount > hdr->RuleCount - dst->RuleStart) {
            g_ParseStage = 8;
            status = STATUS_INVALID_PARAMETER;
            goto fail;
        }
        if (!DshntPathEquals(&dst->Workspace.Device, &dst->View.Device) ||
            !DshntPathEquals(&dst->Workspace.Device, &dst->Store.Device)) {
            g_ParseStage = 9;
            status = STATUS_INVALID_PARAMETER;
            goto fail;
        }
        if (DshntPathHasPrefix(&dst->View.Rel, &dst->Workspace.Rel) ||
            DshntPathHasPrefix(&dst->Workspace.Rel, &dst->View.Rel) ||
            DshntPathHasPrefix(&dst->Store.Rel, &dst->Workspace.Rel) ||
            DshntPathHasPrefix(&dst->Workspace.Rel, &dst->Store.Rel)) {
            g_ParseStage = 10;
            status = STATUS_INVALID_PARAMETER;
            goto fail;
        }
    }

    for (i = 0; i < hdr->RuleCount; i++) {
        const DSHNT_RULE_ENTRY *src = &rules[i];
        DSHNT_RULE *dst = &policy->Rules[i];
        UNICODE_STRING path;
        UNICODE_STRING refString;

        g_ParseStage = 40;
        status = DshntRefString(strings, hdr->StringBytes, src->Path, &path);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 41;
        status = DshntPolicyPath(policy, &path, &dst->Match, NULL);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 42;
        status = DshntRefString(strings, hdr->StringBytes, src->Id, &refString);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 43;
        status = DshntPolicyStrdup(policy, &refString, &dst->Id);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 44;
        status = DshntRefString(strings, hdr->StringBytes, src->Type, &refString);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 45;
        status = DshntPolicyStrdup(policy, &refString, &dst->Type);
        if (!NT_SUCCESS(status)) goto fail;
        dst->AccessMask = src->AccessMask;
        dst->Action = src->Action;
    }

    for (i = 0; i < hdr->GlobalMaskCount; i++) {
        const DSHNT_RULE_ENTRY *src = &rules[hdr->RuleCount + i];
        DSHNT_RULE *dst = &policy->Masks[i];
        UNICODE_STRING path;

        g_ParseStage = 50;
        status = DshntRefString(strings, hdr->StringBytes, src->Path, &path);
        if (!NT_SUCCESS(status)) goto fail;
        g_ParseStage = 51;
        status = DshntPolicyPath(policy, &path, &dst->Match, NULL);
        if (!NT_SUCCESS(status)) goto fail;
        DshntInitUnicode(&dst->Id);
        DshntInitUnicode(&dst->Type);
        dst->AccessMask = DSHNT_ACCESS_READ | DSHNT_ACCESS_WRITE | DSHNT_ACCESS_DELETE |
                          DSHNT_ACCESS_RENAME | DSHNT_ACCESS_ATTRIBUTE | DSHNT_ACCESS_EXECUTE;
        dst->Action = DshntActionMask;
    }

    policy->DomainCount = hdr->DomainCount;
    policy->RuleCount = hdr->RuleCount;
    policy->MaskCount = hdr->GlobalMaskCount;
    *outPolicy = policy;
    return STATUS_SUCCESS;

fail:
    DshntFreePolicy(policy);
    return status;
}

/* --------------------------------------------------------------- proc table */

static ULONG DshntProcBucket(_In_ ULONG pid)
{
    return pid % DSHNT_PROC_BUCKETS;
}

static DSHNT_PROC_ENTRY *DshntFindProcLocked(_In_ ULONG pid)
{
    LIST_ENTRY *head = &g_Dshnt.ProcBuckets[DshntProcBucket(pid)];
    LIST_ENTRY *link;
    for (link = head->Flink; link != head; link = link->Flink) {
        DSHNT_PROC_ENTRY *entry = CONTAINING_RECORD(link, DSHNT_PROC_ENTRY, Link);
        if (entry->Pid == pid) {
            return entry;
        }
    }
    return NULL;
}

static VOID DshntCopyDomainId(_Out_writes_(DSHNT_DOMAIN_ID_CHARS) PWCHAR dst,
                              _In_opt_ PCUNICODE_STRING src)
{
    ULONG chars;

    RtlZeroMemory(dst, DSHNT_DOMAIN_ID_CHARS * sizeof(WCHAR));
    if (src == NULL || src->Buffer == NULL) {
        return;
    }
    chars = src->Length / sizeof(WCHAR);
    if (chars > DSHNT_DOMAIN_ID_CHARS - 1) {
        chars = DSHNT_DOMAIN_ID_CHARS - 1;
    }
    RtlCopyMemory(dst, src->Buffer, chars * sizeof(WCHAR));
}

static DSHNT_PROC_ENTRY *DshntAddProcLocked(_In_ ULONG pid, _In_ ULONG flags,
                                            _In_opt_ PCUNICODE_STRING domainId)
{
    DSHNT_PROC_ENTRY *entry = DshntFindProcLocked(pid);
    if (entry != NULL) {
        if (flags != 0) {
            entry->Flags = flags;
        }
        if (domainId != NULL && domainId->Length > 0) {
            DshntCopyDomainId(entry->DomainId, domainId);
        }
        return entry;
    }

    entry = ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*entry), DSHNT_TAG);
    if (entry == NULL) {
        return NULL;
    }
    RtlZeroMemory(entry, sizeof(*entry));
    entry->Pid = pid;
    entry->Flags = flags;
    DshntCopyDomainId(entry->DomainId, domainId);
    InsertTailList(&g_Dshnt.ProcBuckets[DshntProcBucket(pid)], &entry->Link);
    InterlockedIncrement(&g_Dshnt.ProcessCount);
    return entry;
}

static VOID DshntRemoveProcLocked(_In_ ULONG pid)
{
    LIST_ENTRY *head = &g_Dshnt.ProcBuckets[DshntProcBucket(pid)];
    LIST_ENTRY *link;
    for (link = head->Flink; link != head; link = link->Flink) {
        DSHNT_PROC_ENTRY *entry = CONTAINING_RECORD(link, DSHNT_PROC_ENTRY, Link);
        if (entry->Pid == pid) {
            RemoveEntryList(&entry->Link);
            ExFreePoolWithTag(entry, DSHNT_TAG);
            InterlockedDecrement(&g_Dshnt.ProcessCount);
            return;
        }
    }
}

/* 快照式读取：不把受锁保护的指针带出临界区。 */
static BOOLEAN DshntSnapshotProc(_In_ ULONG pid, _Out_ DSHNT_PROC_SNAPSHOT *out)
{
    DSHNT_PROC_ENTRY *entry;
    RtlZeroMemory(out, sizeof(*out));
    ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
    entry = DshntFindProcLocked(pid);
    if (entry != NULL) {
        out->Found = TRUE;
        out->Flags = entry->Flags;
        RtlStringCchCopyW(out->DomainId, DSHNT_DOMAIN_ID_CHARS, entry->DomainId);
    }
    ExReleaseResourceLite(&g_Dshnt.Lock);
    return out->Found;
}

static DSHNT_DOMAIN *DshntFindDomainLocked(_In_opt_ PCUNICODE_STRING domainId)
{
    ULONG i;
    if (domainId == NULL || domainId->Buffer == NULL || g_Dshnt.Policy == NULL) {
        return NULL;
    }
    for (i = 0; i < g_Dshnt.Policy->DomainCount; i++) {
        DSHNT_DOMAIN *d = &g_Dshnt.Policy->Domains[i];
        if (d->Id.Length == 0) continue; /* 已注销（tombstone） */
        if (DshntPathEquals(&d->Id, domainId)) {
            return d;
        }
    }
    return NULL;
}

/* ------------------------------------------------------------------- events */

static VOID DshntRecordEvent(_In_ ULONG type, _In_ ULONG accessMask, _In_ ULONG action,
                             _In_ ULONG pid, _In_opt_ PCUNICODE_STRING domainId,
                             _In_opt_ PCUNICODE_STRING path, _In_opt_ PCUNICODE_STRING ruleId)
{
    DSHNT_EVENT_RECORD *rec;
    LARGE_INTEGER now;

    if (KeGetCurrentIrql() > APC_LEVEL) {
        return;
    }

    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
    if (g_Dshnt.EventCount >= DSHNT_EVENT_RING) {
        g_Dshnt.EventDropped++;
        ExReleaseResourceLite(&g_Dshnt.Lock);
        return;
    }
    rec = &g_Dshnt.Events[g_Dshnt.EventHead];
    RtlZeroMemory(rec, sizeof(*rec));
    rec->Type = type;
    rec->AccessMask = accessMask;
    rec->Action = action;
    rec->Pid = pid;
    KeQuerySystemTime(&now);
    rec->Timestamp100ns = (UINT64)now.QuadPart;
    if (domainId != NULL && domainId->Buffer != NULL) {
        ULONG chars = domainId->Length / sizeof(WCHAR);
        if (chars >= DSHNT_EVENT_ID_CHARS) chars = DSHNT_EVENT_ID_CHARS - 1;
        RtlCopyMemory(rec->DomainId, domainId->Buffer, chars * sizeof(WCHAR));
    }
    if (path != NULL && path->Buffer != NULL) {
        ULONG chars = path->Length / sizeof(WCHAR);
        if (chars >= DSHNT_EVENT_PATH_CHARS) chars = DSHNT_EVENT_PATH_CHARS - 1;
        RtlCopyMemory(rec->Path, path->Buffer, chars * sizeof(WCHAR));
    }
    if (ruleId != NULL && ruleId->Buffer != NULL) {
        ULONG chars = ruleId->Length / sizeof(WCHAR);
        if (chars >= DSHNT_EVENT_ID_CHARS) chars = DSHNT_EVENT_ID_CHARS - 1;
        RtlCopyMemory(rec->RuleId, ruleId->Buffer, chars * sizeof(WCHAR));
    }

    g_Dshnt.EventHead = (g_Dshnt.EventHead + 1) % DSHNT_EVENT_RING;
    g_Dshnt.EventCount++;
    ExReleaseResourceLite(&g_Dshnt.Lock);
}

/* --------------------------------------------------------------- decisions */

static ULONG DshntAccessFromCreate(_In_ PFLT_CALLBACK_DATA Cbd)
{
    ACCESS_MASK desired = 0;
    ULONG access = 0;
    ULONG disposition;
    ULONG options;

    if (Cbd->Iopb->Parameters.Create.SecurityContext != NULL) {
        desired = Cbd->Iopb->Parameters.Create.SecurityContext->DesiredAccess;
    }
    disposition = Cbd->Iopb->Parameters.Create.Options >> 24;
    options = Cbd->Iopb->Parameters.Create.Options & 0x00FFFFFF;

    if (desired & (FILE_READ_DATA | FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE)) {
        access |= DSHNT_ACCESS_READ;
    }
    if (desired & (FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | WRITE_DAC | WRITE_OWNER)) {
        access |= DSHNT_ACCESS_WRITE;
    }
    if (desired & FILE_WRITE_ATTRIBUTES) {
        access |= DSHNT_ACCESS_ATTRIBUTE;
    }
    if (desired & FILE_EXECUTE) {
        access |= DSHNT_ACCESS_EXECUTE;
    }
    if (desired & DELETE) {
        access |= DSHNT_ACCESS_DELETE;
    }
    if (disposition == FILE_SUPERSEDE || disposition == FILE_OVERWRITE ||
        disposition == FILE_OVERWRITE_IF || disposition == FILE_CREATE) {
        access |= DSHNT_ACCESS_WRITE;
    }
    if (options & FILE_DELETE_ON_CLOSE) {
        access |= DSHNT_ACCESS_DELETE;
    }
    if (access == 0) {
        access = DSHNT_ACCESS_READ;
    }
    return access;
}

/* 规则匹配：globalMask 先命中即 mask；域规则按控制面给定顺序取第一条命中。 */
static ULONG DshntDecideLocked(_In_ DSHNT_DOMAIN *domain,
                               _In_ PCUNICODE_STRING device,
                               _In_ PCUNICODE_STRING rel,
                               _In_ ULONG accessMask,
                               _Out_opt_ PUNICODE_STRING *ruleId)
{
    ULONG i;

    if (ruleId != NULL) *ruleId = NULL;

    for (i = 0; i < g_Dshnt.Policy->MaskCount; i++) {
        DSHNT_RULE *mask = &g_Dshnt.Policy->Masks[i];
        if (!DshntPathEquals(device, &mask->Match.Device)) continue;
        if (DshntPathHasPrefix(rel, &mask->Match.Rel)) {
            return DshntActionMask;
        }
    }

    for (i = 0; i < domain->RuleCount; i++) {
        ULONG index = domain->RuleStart + i;
        DSHNT_RULE *rule;
        if (index >= g_Dshnt.Policy->RuleCount) break;
        rule = &g_Dshnt.Policy->Rules[index];
        if ((rule->AccessMask & accessMask) == 0) continue;
        if (!DshntPathEquals(device, &rule->Match.Device)) continue;
        if (!DshntPathHasPrefix(rel, &rule->Match.Rel)) continue;
        if (ruleId != NULL) *ruleId = &rule->Id;
        return rule->Action;
    }

    if (accessMask == DSHNT_ACCESS_READ) {
        return domain->DefaultRead == DshntDefaultReadAllow ? DshntActionAllow : DshntActionDeny;
    }
    return DshntActionDeny;
}

/*
 * 视图路径 → 逻辑工作区路径。
 *
 * 域内进程对视图根的“直接”打开与重定向后的续开在这里是同一种请求：
 * 前者是显式访问暂存，后者是 STATUS_REPARSE 之后 IO 管理器用新名字重发的 create。
 * 我们不（也无法）区分两者，而是把视图路径映射回逻辑路径，再套用**同一套**规则：
 *   · 规则允许 ⇒ 放行（暂存目录本身就是该进程的数据）；
 *   · 规则拒绝 ⇒ 拒绝（防止绕过 ws 上的 deny/mask 规则直接写暂存）。
 *
 * 这样就不需要 file-object context 来标记“这次打开是重定向续开”。
 */
static NTSTATUS DshntLogicalFromView(_In_ const DSHNT_DOMAIN *domain,
                                     _In_ PCUNICODE_STRING rest,
                                     _Out_ PUNICODE_STRING logical,
                                     _Out_ PVOID *heap,
                                     _In_ PWCHAR stackBuf,
                                     _In_ ULONG stackChars)
{
    ULONG suffixBytes = rest->Length - domain->View.Rel.Length;
    ULONG totalBytes = domain->Workspace.Rel.Length + suffixBytes;
    PWCH buffer = stackBuf;

    *heap = NULL;
    if (totalBytes + sizeof(WCHAR) > stackChars * sizeof(WCHAR)) {
        buffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, totalBytes + sizeof(WCHAR), DSHNT_TAG);
        if (buffer == NULL) {
            return STATUS_INSUFFICIENT_RESOURCES;
        }
        *heap = buffer;
    }

    RtlCopyMemory(buffer, domain->Workspace.Rel.Buffer, domain->Workspace.Rel.Length);
    if (suffixBytes > 0) {
        RtlCopyMemory((PUCHAR)buffer + domain->Workspace.Rel.Length,
                      (PUCHAR)rest->Buffer + domain->View.Rel.Length,
                      suffixBytes);
    }
    buffer[totalBytes / sizeof(WCHAR)] = 0;
    logical->Buffer = buffer;
    logical->Length = (USHORT)totalBytes;
    logical->MaximumLength = (USHORT)(totalBytes + sizeof(WCHAR));
    return STATUS_SUCCESS;
}

/* ---------------------------------------------------------------- callbacks */

static FLT_PREOP_CALLBACK_STATUS
DshntPreCreate(_Inout_ PFLT_CALLBACK_DATA Cbd,
               _In_ PCFLT_RELATED_OBJECTS FltObjects,
               _Flt_CompletionContext_Outptr_ PVOID *CompletionContext)
{
    NTSTATUS status;
    PFLT_FILE_NAME_INFORMATION nameInfo = NULL;
    DSHNT_PROC_SNAPSHOT proc;
    UNICODE_STRING domainId;
    UNICODE_STRING rest;
    DSHNT_DOMAIN *domain = NULL;
    ULONG access;
    ULONG action;
    PUNICODE_STRING ruleId = NULL;
    BOOLEAN granted = FALSE;
    ULONG redirectBytes = 0;
    ULONG pid = (ULONG)(ULONG_PTR)PsGetCurrentProcessId();
    FLT_PREOP_CALLBACK_STATUS result = FLT_PREOP_SUCCESS_NO_CALLBACK;
    PVOID newNameBuffer = NULL;
    UNICODE_STRING domainIdCopy;

    UNREFERENCED_PARAMETER(CompletionContext);
    UNREFERENCED_PARAMETER(FltObjects);

    if (FlagOn(Cbd->Iopb->OperationFlags, SL_OPEN_PAGING_FILE) ||
        FlagOn(Cbd->Iopb->TargetFileObject->Flags, FO_VOLUME_OPEN) ||
        FlagOn(Cbd->Iopb->Parameters.Create.Options, FILE_OPEN_BY_FILE_ID)) {
        return result;
    }

    if (!DshntSnapshotProc(pid, &proc)) {
        return result;
    }
    if (FlagOn(proc.Flags, DSHNT_PROC_TRUSTED)) {
        return result;
    }
    RtlInitUnicodeString(&domainIdCopy, proc.DomainId);

    if (FlagOn(Cbd->Iopb->OperationFlags, SL_OPEN_TARGET_DIRECTORY)) {
        ClearFlag(Cbd->Iopb->OperationFlags, SL_OPEN_TARGET_DIRECTORY);
        status = FltGetFileNameInformation(Cbd,
                                           FLT_FILE_NAME_OPENED | FLT_FILE_NAME_QUERY_FILESYSTEM_ONLY,
                                           &nameInfo);
        SetFlag(Cbd->Iopb->OperationFlags, SL_OPEN_TARGET_DIRECTORY);
    } else {
        status = FltGetFileNameInformation(Cbd,
                                           FLT_FILE_NAME_OPENED | FLT_FILE_NAME_QUERY_DEFAULT,
                                           &nameInfo);
    }
    if (!NT_SUCCESS(status)) {
        return result;
    }
    status = FltParseFileNameInformation(nameInfo);
    if (!NT_SUCCESS(status)) {
        FltReleaseFileNameInformation(nameInfo);
        return result;
    }

    ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);

    domain = DshntFindDomainLocked(&domainIdCopy);
    if (domain == NULL) {
        ExReleaseResourceLite(&g_Dshnt.Lock);
        FltReleaseFileNameInformation(nameInfo);
        return result;
    }
    if (!DshntPathEquals(&nameInfo->Volume, &domain->Workspace.Device)) {
        ExReleaseResourceLite(&g_Dshnt.Lock);
        FltReleaseFileNameInformation(nameInfo);
        return result;
    }

    rest.Buffer = nameInfo->Name.Buffer + (nameInfo->Volume.Length / sizeof(WCHAR));
    rest.Length = nameInfo->Name.Length - nameInfo->Volume.Length;
    rest.MaximumLength = rest.Length;

    /* apply helper 的 grant：授权路径内直接写真实工作区（仍是唯一写者）。 */
    if (!IsListEmpty(&g_Dshnt.Grants)) {
        LIST_ENTRY *link;
        for (link = g_Dshnt.Grants.Flink; link != &g_Dshnt.Grants && !granted; link = link->Flink) {
            DSHNT_GRANT *grant = CONTAINING_RECORD(link, DSHNT_GRANT, Link);
            ULONG g;
            if (grant->Pid != pid) continue;
            if (grant->PathCount == 0) {
                granted = TRUE;
                break;
            }
            for (g = 0; g < grant->PathCount; g++) {
                if (DshntPathEquals(&nameInfo->Volume, &grant->Paths[g].Device) &&
                    DshntPathHasPrefix(&rest, &grant->Paths[g].Rel)) {
                    granted = TRUE;
                    break;
                }
            }
        }
    }

    if (granted) {
        action = DshntDecideLocked(domain, &nameInfo->Volume, &rest, DSHNT_ACCESS_WRITE, &ruleId);
        if (action == DshntActionMask || action == DshntActionDeny) {
            UNICODE_STRING pathName = nameInfo->Name;
            InterlockedIncrement64(&g_Dshnt.Masks);
            ExReleaseResourceLite(&g_Dshnt.Lock);
            DshntRecordEvent(DshntEventMask, DSHNT_ACCESS_WRITE, action, pid, &domainIdCopy, &pathName,
                             ruleId);
            FltReleaseFileNameInformation(nameInfo);
            Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
            return FLT_PREOP_COMPLETE;
        }
        ExReleaseResourceLite(&g_Dshnt.Lock);
        FltReleaseFileNameInformation(nameInfo);
        return result;
    }

    /* store 根：域内进程一律不可访问（证据/候选 blob/journal）。 */
    if (DshntPathHasPrefix(&rest, &domain->Store.Rel)) {
        UNICODE_STRING pathName = nameInfo->Name;
        InterlockedIncrement64(&g_Dshnt.Denies);
        ExReleaseResourceLite(&g_Dshnt.Lock);
        DshntRecordEvent(DshntEventDeny, 0, DshntActionDeny, pid, &domainIdCopy, &pathName, NULL);
        FltReleaseFileNameInformation(nameInfo);
        Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
        return FLT_PREOP_COMPLETE;
    }

    access = DshntAccessFromCreate(Cbd);

    /*
     * 视图根：这既可能是重定向后的续开（STATUS_REPARSE 用新名字重发 create），
     * 也可能是域内进程显式打开暂存目录。映射回逻辑路径后按同一套规则判定：
     * 规则拒绝就拒绝，允许就放行（不再二次重定向）。
     */
    if (DshntPathHasPrefix(&rest, &domain->View.Rel)) {
        UNICODE_STRING logical;
        PVOID heap = NULL;
        WCHAR stackBuf[512];
        NTSTATUS build;
        ULONG viewAction;

        build = DshntLogicalFromView(domain, &rest, &logical, &heap, stackBuf, ARRAYSIZE(stackBuf));
        if (!NT_SUCCESS(build)) {
            ExReleaseResourceLite(&g_Dshnt.Lock);
            FltReleaseFileNameInformation(nameInfo);
            Cbd->IoStatus.Status = build;
            return FLT_PREOP_COMPLETE;
        }

        viewAction = DshntDecideLocked(domain, &nameInfo->Volume, &logical, access, &ruleId);
        ExReleaseResourceLite(&g_Dshnt.Lock);
        if (heap != NULL) {
            ExFreePoolWithTag(heap, DSHNT_TAG);
        }

        if (viewAction == DshntActionDeny || viewAction == DshntActionMask) {
            UNICODE_STRING pathName = nameInfo->Name;
            if (viewAction == DshntActionMask) {
                InterlockedIncrement64(&g_Dshnt.Masks);
            } else {
                InterlockedIncrement64(&g_Dshnt.Denies);
            }
            DshntRecordEvent(viewAction == DshntActionMask ? DshntEventMask : DshntEventDeny,
                             access, viewAction, pid, &domainIdCopy, &pathName, ruleId);
            FltReleaseFileNameInformation(nameInfo);
            Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
            return FLT_PREOP_COMPLETE;
        }

        FltReleaseFileNameInformation(nameInfo);
        return result;
    }
    action = DshntDecideLocked(domain, &nameInfo->Volume, &rest, access, &ruleId);

    if (action == DshntActionDeny || action == DshntActionMask) {
        UNICODE_STRING pathName = nameInfo->Name;
        if (action == DshntActionMask) {
            InterlockedIncrement64(&g_Dshnt.Masks);
        } else {
            InterlockedIncrement64(&g_Dshnt.Denies);
        }
        ExReleaseResourceLite(&g_Dshnt.Lock);
        DshntRecordEvent(action == DshntActionMask ? DshntEventMask : DshntEventDeny,
                         access, action, pid, &domainIdCopy, &pathName, ruleId);
        FltReleaseFileNameInformation(nameInfo);
        Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
        return FLT_PREOP_COMPLETE;
    }

    /* 工作区内一切访问都重定向到视图（读也要，否则看不到已暂存内容）。 */
    if (DshntPathHasPrefix(&rest, &domain->Workspace.Rel)) {
        UNICODE_STRING suffix;
        ULONG bufferBytes;

        suffix.Buffer = rest.Buffer + (domain->Workspace.Rel.Length / sizeof(WCHAR));
        suffix.Length = rest.Length - domain->Workspace.Rel.Length;
        suffix.MaximumLength = suffix.Length;

        bufferBytes = nameInfo->Volume.Length + domain->View.Rel.Length + suffix.Length;
        redirectBytes = bufferBytes;
        newNameBuffer = ExAllocatePool2(POOL_FLAG_NON_PAGED, bufferBytes + sizeof(WCHAR), DSHNT_TAG);
        if (newNameBuffer == NULL) {
            ExReleaseResourceLite(&g_Dshnt.Lock);
            FltReleaseFileNameInformation(nameInfo);
            g_Dshnt.LastError = STATUS_INSUFFICIENT_RESOURCES;
            Cbd->IoStatus.Status = STATUS_INSUFFICIENT_RESOURCES;
            return FLT_PREOP_COMPLETE;
        }
        RtlCopyMemory(newNameBuffer, nameInfo->Volume.Buffer, nameInfo->Volume.Length);
        RtlCopyMemory((PUCHAR)newNameBuffer + nameInfo->Volume.Length,
                      domain->View.Rel.Buffer, domain->View.Rel.Length);
        if (suffix.Length > 0) {
            RtlCopyMemory((PUCHAR)newNameBuffer + nameInfo->Volume.Length + domain->View.Rel.Length,
                          suffix.Buffer, suffix.Length);
        }
        ((PWCH)newNameBuffer)[bufferBytes / sizeof(WCHAR)] = 0;
    }

    ExReleaseResourceLite(&g_Dshnt.Lock);

    if (newNameBuffer != NULL) {
        status = IoReplaceFileObjectName(Cbd->Iopb->TargetFileObject, (PWCH)newNameBuffer,
                                         (USHORT)redirectBytes);
        FltReleaseFileNameInformation(nameInfo);
        ExFreePoolWithTag(newNameBuffer, DSHNT_TAG);
        if (!NT_SUCCESS(status)) {
            g_Dshnt.LastError = status;
            Cbd->IoStatus.Status = status;
            return FLT_PREOP_COMPLETE;
        }
        InterlockedIncrement64(&g_Dshnt.Redirects);
        Cbd->IoStatus.Status = STATUS_REPARSE;
        Cbd->IoStatus.Information = IO_REPARSE;
        return FLT_PREOP_COMPLETE;
    }

    FltReleaseFileNameInformation(nameInfo);
    return result;
}

/*
 * 改名/硬链接：
 *   - 绝对目标路径（RootDirectory == NULL）且落在工作区 ⇒ 改写成视图路径，
 *     否则 rename 会把视图里的文件搬进真实工作区（写穿）。
 *   - 相对目标（RootDirectory != NULL）⇒ 父目录句柄已在视图内，直接放行。
 *   - 硬链接 ⇒ 拒绝（v1 不支持，硬链接会绕过暂存语义）。
 */
typedef struct _DSHNT_RENAME_CONTEXT {
    PVOID Original;
    PVOID Allocation;
} DSHNT_RENAME_CONTEXT;

/* FileRenameInformation(.Ex) 共用布局：偏移 0 是 ReplaceIfExists / Flags。 */
typedef struct _DSHNT_RENAME_INFO {
    ULONG Flags;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
} DSHNT_RENAME_INFO;

static FLT_PREOP_CALLBACK_STATUS
DshntPreSetInformation(_Inout_ PFLT_CALLBACK_DATA Cbd,
                       _In_ PCFLT_RELATED_OBJECTS FltObjects,
                       _Flt_CompletionContext_Outptr_ PVOID *CompletionContext)
{
    FILE_INFORMATION_CLASS infoClass;
    DSHNT_PROC_SNAPSHOT proc;
    ULONG pid = (ULONG)(ULONG_PTR)PsGetCurrentProcessId();

    *CompletionContext = NULL;

    if (!DshntSnapshotProc(pid, &proc) || FlagOn(proc.Flags, DSHNT_PROC_TRUSTED)) {
        return FLT_PREOP_SUCCESS_NO_CALLBACK;
    }

    infoClass = Cbd->Iopb->Parameters.SetFileInformation.FileInformationClass;

    if (infoClass == FileLinkInformation) {
        InterlockedIncrement64(&g_Dshnt.Denies);
        Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
        return FLT_PREOP_COMPLETE;
    }

    if (infoClass == FileRenameInformation || infoClass == FileRenameInformationEx) {
        DSHNT_RENAME_INFO *info = (DSHNT_RENAME_INFO *)Cbd->Iopb->Parameters.SetFileInformation.InfoBuffer;
        PFLT_FILE_NAME_INFORMATION destInfo = NULL;
        NTSTATUS status;
        UNICODE_STRING domainId;
        UNICODE_STRING rest;
        DSHNT_DOMAIN *domain;
        DSHNT_RENAME_CONTEXT *ctx;
        PVOID replacement;
        ULONG allocBytes;
        ULONG bufferBytes;
        PVOID viewPath = NULL;
        UNICODE_STRING pathCopy;

        if (info == NULL || info->RootDirectory != NULL) {
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }

        status = FltGetDestinationFileNameInformation(FltObjects->Instance,
                                                      FltObjects->FileObject,
                                                      info->RootDirectory,
                                                      info->FileName,
                                                      info->FileNameLength,
                                                      FLT_FILE_NAME_OPENED | FLT_FILE_NAME_QUERY_DEFAULT,
                                                      &destInfo);
        if (!NT_SUCCESS(status)) {
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }
        status = FltParseFileNameInformation(destInfo);
        if (!NT_SUCCESS(status)) {
            FltReleaseFileNameInformation(destInfo);
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }

        RtlInitUnicodeString(&domainId, proc.DomainId);
        ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
        domain = DshntFindDomainLocked(&domainId);
        if (domain == NULL) {
            ExReleaseResourceLite(&g_Dshnt.Lock);
            FltReleaseFileNameInformation(destInfo);
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }

        rest.Buffer = destInfo->Name.Buffer + (destInfo->Volume.Length / sizeof(WCHAR));
        rest.Length = destInfo->Name.Length - destInfo->Volume.Length;
        rest.MaximumLength = rest.Length;

        /* store 目标：拒绝（改名到 store 等于把内容搬进证据区）。 */
        if (DshntPathEquals(&destInfo->Volume, &domain->Workspace.Device) &&
            DshntPathHasPrefix(&rest, &domain->Store.Rel)) {
            UNICODE_STRING pathName = destInfo->Name;
            InterlockedIncrement64(&g_Dshnt.Denies);
            ExReleaseResourceLite(&g_Dshnt.Lock);
            DshntRecordEvent(DshntEventDeny, DSHNT_ACCESS_RENAME, DshntActionDeny, pid,
                             &domainId, &pathName, NULL);
            FltReleaseFileNameInformation(destInfo);
            Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
            return FLT_PREOP_COMPLETE;
        }

        /* 视图内的目标（相对改名/已在暂存里）：按逻辑路径判定后放行。 */
        if (DshntPathEquals(&destInfo->Volume, &domain->Workspace.Device) &&
            DshntPathHasPrefix(&rest, &domain->View.Rel)) {
            UNICODE_STRING logical;
            PVOID heap = NULL;
            WCHAR stackBuf[512];
            NTSTATUS build;
            ULONG viewAction;

            build = DshntLogicalFromView(domain, &rest, &logical, &heap, stackBuf, ARRAYSIZE(stackBuf));
            viewAction = NT_SUCCESS(build)
                ? DshntDecideLocked(domain, &destInfo->Volume, &logical, DSHNT_ACCESS_RENAME, NULL)
                : DshntActionDeny;
            ExReleaseResourceLite(&g_Dshnt.Lock);
            if (heap != NULL) {
                ExFreePoolWithTag(heap, DSHNT_TAG);
            }
            if (!NT_SUCCESS(build)) {
                FltReleaseFileNameInformation(destInfo);
                Cbd->IoStatus.Status = build;
                return FLT_PREOP_COMPLETE;
            }
            if (viewAction == DshntActionDeny || viewAction == DshntActionMask) {
                UNICODE_STRING pathName = destInfo->Name;
                InterlockedIncrement64(&g_Dshnt.Denies);
                DshntRecordEvent(DshntEventDeny, DSHNT_ACCESS_RENAME, viewAction, pid,
                                 &domainId, &pathName, NULL);
                FltReleaseFileNameInformation(destInfo);
                Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
                return FLT_PREOP_COMPLETE;
            }
            FltReleaseFileNameInformation(destInfo);
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }

        if (!DshntPathEquals(&destInfo->Volume, &domain->Workspace.Device) ||
            !DshntPathHasPrefix(&rest, &domain->Workspace.Rel)) {
            ExReleaseResourceLite(&g_Dshnt.Lock);
            FltReleaseFileNameInformation(destInfo);
            return FLT_PREOP_SUCCESS_NO_CALLBACK;
        }

        {
            ULONG action = DshntDecideLocked(domain, &destInfo->Volume, &rest,
                                             DSHNT_ACCESS_RENAME, NULL);
            UNICODE_STRING pathName = destInfo->Name;
            if (action == DshntActionDeny || action == DshntActionMask) {
                InterlockedIncrement64(&g_Dshnt.Denies);
                ExReleaseResourceLite(&g_Dshnt.Lock);
                DshntRecordEvent(DshntEventDeny, DSHNT_ACCESS_RENAME, action, pid, &domainId, &pathName, NULL);
                FltReleaseFileNameInformation(destInfo);
                Cbd->IoStatus.Status = STATUS_ACCESS_DENIED;
                return FLT_PREOP_COMPLETE;
            }
        }

        {
            UNICODE_STRING suffix;
            suffix.Buffer = rest.Buffer + (domain->Workspace.Rel.Length / sizeof(WCHAR));
            suffix.Length = rest.Length - domain->Workspace.Rel.Length;
            suffix.MaximumLength = suffix.Length;
            bufferBytes = destInfo->Volume.Length + domain->View.Rel.Length + suffix.Length;
            viewPath = ExAllocatePool2(POOL_FLAG_NON_PAGED, bufferBytes + sizeof(WCHAR), DSHNT_TAG);
            if (viewPath == NULL) {
                ExReleaseResourceLite(&g_Dshnt.Lock);
                FltReleaseFileNameInformation(destInfo);
                Cbd->IoStatus.Status = STATUS_INSUFFICIENT_RESOURCES;
                return FLT_PREOP_COMPLETE;
            }
            RtlCopyMemory(viewPath, destInfo->Volume.Buffer, destInfo->Volume.Length);
            RtlCopyMemory((PUCHAR)viewPath + destInfo->Volume.Length,
                          domain->View.Rel.Buffer, domain->View.Rel.Length);
            if (suffix.Length > 0) {
                RtlCopyMemory((PUCHAR)viewPath + destInfo->Volume.Length + domain->View.Rel.Length,
                              suffix.Buffer, suffix.Length);
            }
            ((PWCH)viewPath)[bufferBytes / sizeof(WCHAR)] = 0;
        }

        ExReleaseResourceLite(&g_Dshnt.Lock);
        FltReleaseFileNameInformation(destInfo);
        UNREFERENCED_PARAMETER(pathCopy);

        allocBytes = FIELD_OFFSET(FILE_RENAME_INFORMATION, FileName) + bufferBytes + sizeof(WCHAR);
        replacement = ExAllocatePool2(POOL_FLAG_NON_PAGED, allocBytes, DSHNT_TAG);
        ctx = ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*ctx), DSHNT_TAG);
        if (replacement == NULL || ctx == NULL) {
            if (replacement != NULL) ExFreePoolWithTag(replacement, DSHNT_TAG);
            if (ctx != NULL) ExFreePoolWithTag(ctx, DSHNT_TAG);
            ExFreePoolWithTag(viewPath, DSHNT_TAG);
            Cbd->IoStatus.Status = STATUS_INSUFFICIENT_RESOURCES;
            return FLT_PREOP_COMPLETE;
        }
        RtlZeroMemory(replacement, allocBytes);
        ((DSHNT_RENAME_INFO *)replacement)->Flags = info->Flags;
        ((DSHNT_RENAME_INFO *)replacement)->RootDirectory = NULL;
        ((DSHNT_RENAME_INFO *)replacement)->FileNameLength = bufferBytes;
        RtlCopyMemory(((DSHNT_RENAME_INFO *)replacement)->FileName, viewPath, bufferBytes);
        ExFreePoolWithTag(viewPath, DSHNT_TAG);

        ctx->Original = info;
        ctx->Allocation = replacement;
        Cbd->Iopb->Parameters.SetFileInformation.InfoBuffer = replacement;
        FltSetCallbackDataDirty(Cbd);
        *CompletionContext = ctx;
        return FLT_PREOP_SUCCESS_WITH_CALLBACK;
    }

    return FLT_PREOP_SUCCESS_NO_CALLBACK;
}

static FLT_POSTOP_CALLBACK_STATUS
DshntPostSetInformation(_Inout_ PFLT_CALLBACK_DATA Cbd,
                        _In_ PCFLT_RELATED_OBJECTS FltObjects,
                        _In_opt_ PVOID CompletionContext,
                        _In_ FLT_POST_OPERATION_FLAGS Flags)
{
    DSHNT_RENAME_CONTEXT *ctx = (DSHNT_RENAME_CONTEXT *)CompletionContext;

    UNREFERENCED_PARAMETER(FltObjects);
    UNREFERENCED_PARAMETER(Flags);

    if (ctx != NULL) {
        Cbd->Iopb->Parameters.SetFileInformation.InfoBuffer = ctx->Original;
        if (ctx->Allocation != NULL) {
            ExFreePoolWithTag(ctx->Allocation, DSHNT_TAG);
        }
        ExFreePoolWithTag(ctx, DSHNT_TAG);
    }
    return FLT_POSTOP_FINISHED_PROCESSING;
}

/* ------------------------------------------------------------ port handling */

static NTSTATUS DshntConnect(_In_ PFLT_PORT ClientPort,
                             _In_opt_ PVOID ServerPortCookie,
                             _In_reads_bytes_opt_(SizeOfContext) PVOID ConnectionContext,
                             _In_ ULONG SizeOfContext,
                             _Outptr_result_maybenull_ PVOID *ConnectionPortCookie)
{
    PACCESS_TOKEN token;
    BOOLEAN admin;

    UNREFERENCED_PARAMETER(ServerPortCookie);
    UNREFERENCED_PARAMETER(ConnectionContext);
    UNREFERENCED_PARAMETER(SizeOfContext);

    *ConnectionPortCookie = NULL;
    if (KeGetCurrentIrql() != PASSIVE_LEVEL) {
        return STATUS_INVALID_DEVICE_STATE;
    }

    token = PsReferencePrimaryToken(PsGetCurrentProcess());
    if (token == NULL) {
        return STATUS_ACCESS_DENIED;
    }
    admin = SeTokenIsAdmin(token);
    PsDereferencePrimaryToken(token);
    if (!admin) {
        return STATUS_ACCESS_DENIED;
    }

    InterlockedExchangePointer((PVOID *)&g_Dshnt.ClientPort, ClientPort);
    g_Dshnt.ClientPid = (ULONG)(ULONG_PTR)PsGetCurrentProcessId();
    return STATUS_SUCCESS;
}

static VOID DshntDisconnect(_In_opt_ PVOID ConnectionCookie)
{
    UNREFERENCED_PARAMETER(ConnectionCookie);
    InterlockedExchangePointer((PVOID *)&g_Dshnt.ClientPort, NULL);
    g_Dshnt.ClientPid = 0;
}

static NTSTATUS DshntFillReply(_In_ PDSHNT_MSG_HEADER in, _In_ UINT16 type, _In_ NTSTATUS status,
                               _In_reads_bytes_opt_(payloadBytes) const VOID *payload, _In_ ULONG payloadBytes,
                               _Out_writes_bytes_to_opt_(OutputBufferLength, *ReturnOutputBufferLength) PVOID OutputBuffer,
                               _In_ ULONG OutputBufferLength,
                               _Out_ PULONG ReturnOutputBufferLength)
{
    PDSHNT_MSG_HEADER out;
    ULONG total = sizeof(DSHNT_MSG_HEADER) + payloadBytes;

    if (OutputBuffer == NULL || OutputBufferLength < total) {
        return STATUS_BUFFER_TOO_SMALL;
    }
    out = (PDSHNT_MSG_HEADER)OutputBuffer;
    out->Size = total;
    out->Version = (UINT16)DSHNT_ABI_VERSION;
    out->Type = (UINT16)(type | DshntMsgReply);
    out->Status = (UINT32)status;
    out->Reserved = in->Reserved;
    if (payloadBytes > 0 && payload != NULL) {
        RtlCopyMemory((PUCHAR)OutputBuffer + sizeof(DSHNT_MSG_HEADER), payload, payloadBytes);
    }
    *ReturnOutputBufferLength = total;
    return STATUS_SUCCESS;
}

static NTSTATUS DshntHandleSetPolicy(_In_ const UCHAR *payload, _In_ ULONG payloadLength)
{
    DSHNT_POLICY *policy = NULL;
    NTSTATUS status;
    DSHNT_POLICY *old;

    status = DshntParsePolicy(payload, payloadLength, &policy);
    if (!NT_SUCCESS(status)) {
        g_Dshnt.LastError = 0xD0000000u | (g_ParseStage & 0xFFu);
        return status;
    }

    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
    if (g_Dshnt.Policy != NULL && policy->Generation < g_Dshnt.Policy->Generation) {
        ExReleaseResourceLite(&g_Dshnt.Lock);
        DshntFreePolicy(policy);
        return STATUS_REVISION_MISMATCH;
    }
    old = g_Dshnt.Policy;
    g_Dshnt.Policy = policy;
    ExReleaseResourceLite(&g_Dshnt.Lock);

    DshntFreePolicy(old);
    return STATUS_SUCCESS;
}

static NTSTATUS DshntHandleRegisterDomain(_In_ const DSHNT_REGISTER_DOMAIN *req,
                                          _In_ const UCHAR *strings, _In_ ULONG stringBytes)
{
    UNICODE_STRING id, workspace, view, store;
    NTSTATUS status;
    BOOLEAN ok = FALSE;
    DSHNT_PATH wsPath, viewPath, storePath;

    RtlZeroMemory(&wsPath, sizeof(wsPath));
    RtlZeroMemory(&viewPath, sizeof(viewPath));
    RtlZeroMemory(&storePath, sizeof(storePath));

    status = DshntRefString(strings, stringBytes, req->Id, &id);
    if (!NT_SUCCESS(status)) return status;
    status = DshntRefString(strings, stringBytes, req->WorkspaceRoot, &workspace);
    if (!NT_SUCCESS(status)) return status;
    status = DshntRefString(strings, stringBytes, req->ViewRoot, &view);
    if (!NT_SUCCESS(status)) return status;
    status = DshntRefString(strings, stringBytes, req->StoreRoot, &store);
    if (!NT_SUCCESS(status)) return status;

    status = DshntSplitWin32(&workspace, &wsPath, NULL);
    if (!NT_SUCCESS(status)) return status;
    status = DshntSplitWin32(&view, &viewPath, NULL);
    if (!NT_SUCCESS(status)) goto cleanup;
    status = DshntSplitWin32(&store, &storePath, NULL);
    if (!NT_SUCCESS(status)) goto cleanup;

    ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
    {
        DSHNT_DOMAIN *d = DshntFindDomainLocked(&id);
        if (d != NULL &&
            DshntPathEquals(&d->Workspace.Device, &wsPath.Device) &&
            DshntPathEquals(&d->Workspace.Rel, &wsPath.Rel) &&
            DshntPathEquals(&d->View.Device, &viewPath.Device) &&
            DshntPathEquals(&d->View.Rel, &viewPath.Rel) &&
            DshntPathEquals(&d->Store.Device, &storePath.Device) &&
            DshntPathEquals(&d->Store.Rel, &storePath.Rel)) {
            ok = TRUE;
        }
    }
    ExReleaseResourceLite(&g_Dshnt.Lock);

cleanup:
    DshntFreePath(&wsPath);
    DshntFreePath(&viewPath);
    DshntFreePath(&storePath);
    return ok ? STATUS_SUCCESS : STATUS_INVALID_PARAMETER;
}

/*
 * 注销域：真实删除，不是 no-op。
 *
 * 为什么不能只返回成功：`NtSupervisor.down()` 依赖这里把域与 PID→域映射一起清掉；
 * 若域留在策略表里，下一次 up 之前的下属进程仍可能命中旧规则（重定向到已停的视图）。
 * 释放策略内存不安全（域数组是 policy 的一部分、规则按起始下标引用），因此用
 * `Id.Length=0` 让它不再被 `DshntFindDomainLocked` 命中；字符串仍由 policy 的
 * Allocs 统一释放。
 */
static NTSTATUS DshntHandleUnregisterDomain(_In_ const DSHNT_UNREGISTER_DOMAIN *req,
                                            _In_ const UCHAR *strings, _In_ ULONG stringBytes)
{
    UNICODE_STRING id;
    NTSTATUS status;
    DSHNT_DOMAIN *domain;
    ULONG bucket;

    status = DshntRefString(strings, stringBytes, req->Id, &id);
    if (!NT_SUCCESS(status)) return status;
    if (id.Length == 0) return STATUS_INVALID_PARAMETER;

    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);

    domain = DshntFindDomainLocked(&id);
    if (domain == NULL) {
        ExReleaseResourceLite(&g_Dshnt.Lock);
        return STATUS_NOT_FOUND;
    }
    domain->Id.Length = 0;
    domain->Id.MaximumLength = 0;

    /* 同时移除这个域的 PID→域映射（ROOT 进程退出前 down 也是常见路径）。 */
    for (bucket = 0; bucket < DSHNT_PROC_BUCKETS; bucket++) {
        LIST_ENTRY *head = &g_Dshnt.ProcBuckets[bucket];
        LIST_ENTRY *link = head->Flink;
        while (link != head) {
            DSHNT_PROC_ENTRY *entry = CONTAINING_RECORD(link, DSHNT_PROC_ENTRY, Link);
            LIST_ENTRY *next = link->Flink;
            UNICODE_STRING entryId;
            RtlInitUnicodeString(&entryId, entry->DomainId);
            if (DshntPathEquals(&entryId, &id)) {
                RemoveEntryList(&entry->Link);
                ExFreePoolWithTag(entry, DSHNT_TAG);
                InterlockedDecrement(&g_Dshnt.ProcessCount);
            }
            link = next;
        }
    }

    ExReleaseResourceLite(&g_Dshnt.Lock);
    return STATUS_SUCCESS;
}

static NTSTATUS DshntHandleRegisterProcess(_In_ const DSHNT_REGISTER_PROCESS *req,
                                           _In_ const UCHAR *strings, _In_ ULONG stringBytes)
{
    UNICODE_STRING id;
    NTSTATUS status;
    DSHNT_PROC_ENTRY *entry;

    status = DshntRefString(strings, stringBytes, req->DomainId, &id);
    if (!NT_SUCCESS(status)) return status;

    if (id.Buffer != NULL && id.Length > 0) {
        ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
        if (DshntFindDomainLocked(&id) == NULL) {
            ExReleaseResourceLite(&g_Dshnt.Lock);
            return STATUS_NOT_FOUND;
        }
        ExReleaseResourceLite(&g_Dshnt.Lock);
    }

    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
    entry = DshntAddProcLocked(req->Pid, req->Flags,
                               (id.Buffer != NULL && id.Length > 0) ? &id : NULL);
    ExReleaseResourceLite(&g_Dshnt.Lock);

    return entry == NULL ? STATUS_INSUFFICIENT_RESOURCES : STATUS_SUCCESS;
}

static NTSTATUS DshntHandleGrantApply(_In_ const DSHNT_GRANT_APPLY *req,
                                      _In_ const UCHAR *strings, _In_ ULONG stringBytes)
{
    DSHNT_GRANT *grant;
    ULONG i;
    NTSTATUS status = STATUS_SUCCESS;
    const DSHNT_STRING_REF *refs;

    if (req->PathCount > DSHNT_MAX_GRANT_PATHS) {
        return STATUS_INVALID_PARAMETER;
    }
    refs = (const DSHNT_STRING_REF *)(strings + (ULONG)DSHNT_ROUND_UP(stringBytes, sizeof(PVOID)));

    grant = ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(*grant), DSHNT_TAG);
    if (grant == NULL) return STATUS_INSUFFICIENT_RESOURCES;
    RtlZeroMemory(grant, sizeof(*grant));
    grant->Pid = req->Pid;
    RtlCopyMemory(grant->ImageHash, req->ImageHash, sizeof(grant->ImageHash));

    for (i = 0; i < req->PathCount; i++) {
        UNICODE_STRING path;
        DSHNT_PATH parsed;

        status = DshntRefString(strings, stringBytes, refs[i], &path);
        if (!NT_SUCCESS(status)) break;
        status = DshntSplitWin32(&path, &parsed, NULL);
        if (!NT_SUCCESS(status)) break;

        grant->Paths[i].Device.Buffer = parsed.Device.Buffer;
        grant->Paths[i].Device.Length = parsed.Device.Length;
        grant->Paths[i].Device.MaximumLength = parsed.Device.MaximumLength;
        grant->Paths[i].Rel.Buffer = parsed.Rel.Buffer;
        grant->Paths[i].Rel.Length = parsed.Rel.Length;
        grant->Paths[i].Rel.MaximumLength = parsed.Rel.MaximumLength;
        grant->Strings[grant->StringCount++] = parsed.Device.Buffer;
        grant->Strings[grant->StringCount++] = parsed.Rel.Buffer;
        grant->PathCount++;
    }

    if (!NT_SUCCESS(status)) {
        for (i = 0; i < grant->StringCount; i++) {
            if (grant->Strings[i] != NULL) ExFreePoolWithTag(grant->Strings[i], DSHNT_TAG);
        }
        ExFreePoolWithTag(grant, DSHNT_TAG);
        return status;
    }

    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
    InsertTailList(&g_Dshnt.Grants, &grant->Link);
    ExReleaseResourceLite(&g_Dshnt.Lock);
    return STATUS_SUCCESS;
}

static VOID DshntRevokeApply(_In_ ULONG pid)
{
    LIST_ENTRY *link;
    ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
    for (link = g_Dshnt.Grants.Flink; link != &g_Dshnt.Grants; link = link->Flink) {
        DSHNT_GRANT *grant = CONTAINING_RECORD(link, DSHNT_GRANT, Link);
        if (grant->Pid == pid) {
            ULONG i;
            RemoveEntryList(&grant->Link);
            for (i = 0; i < grant->StringCount; i++) {
                if (grant->Strings[i] != NULL) ExFreePoolWithTag(grant->Strings[i], DSHNT_TAG);
            }
            ExFreePoolWithTag(grant, DSHNT_TAG);
            break;
        }
    }
    ExReleaseResourceLite(&g_Dshnt.Lock);
}

static NTSTATUS
DshntMessage(_In_opt_ PVOID PortCookie,
             _In_reads_bytes_opt_(InputBufferLength) PVOID InputBuffer,
             _In_ ULONG InputBufferLength,
             _Out_writes_bytes_to_opt_(OutputBufferLength, *ReturnOutputBufferLength) PVOID OutputBuffer,
             _In_ ULONG OutputBufferLength,
             _Out_ PULONG ReturnOutputBufferLength)
{
    PDSHNT_MSG_HEADER hdr;
    const UCHAR *payload;
    ULONG payloadLength;
    NTSTATUS status = STATUS_SUCCESS;
    DSHNT_HELLO_REPLY hello;
    DSHNT_STATS stats;
    UINT16 type;

    UNREFERENCED_PARAMETER(PortCookie);
    *ReturnOutputBufferLength = 0;

    if (InputBuffer == NULL || InputBufferLength < sizeof(DSHNT_MSG_HEADER)) {
        return STATUS_INVALID_PARAMETER;
    }
    hdr = (PDSHNT_MSG_HEADER)InputBuffer;
    if (hdr->Size != InputBufferLength || hdr->Version != DSHNT_ABI_VERSION) {
        return STATUS_REVISION_MISMATCH;
    }

    type = hdr->Type;
    payload = (const UCHAR *)InputBuffer + sizeof(DSHNT_MSG_HEADER);
    payloadLength = InputBufferLength - sizeof(DSHNT_MSG_HEADER);

    switch (type) {
    case DshntMsgHello:
        RtlZeroMemory(&hello, sizeof(hello));
        hello.AbiVersion = DSHNT_ABI_VERSION;
        hello.Capabilities = DSHNT_CAP_POLICY | DSHNT_CAP_DOMAIN | DSHNT_CAP_APPLY | DSHNT_CAP_EVENTS;
        RtlStringCchCopyW(hello.DriverVersion, ARRAYSIZE(hello.DriverVersion), DSHNT_VERSION_STRING);
        RtlStringCchCopyW(hello.Altitude, ARRAYSIZE(hello.Altitude), DSHNT_ALTITUDE);
        return DshntFillReply(hdr, type, STATUS_SUCCESS, &hello, sizeof(hello),
                              OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgSetPolicy:
        status = DshntHandleSetPolicy(payload, payloadLength);
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgRegisterDomain:
        if (payloadLength < sizeof(DSHNT_REGISTER_DOMAIN)) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            status = DshntHandleRegisterDomain((const DSHNT_REGISTER_DOMAIN *)payload,
                                               payload + sizeof(DSHNT_REGISTER_DOMAIN),
                                               payloadLength - sizeof(DSHNT_REGISTER_DOMAIN));
        }
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgUnregisterDomain:
        if (payloadLength < sizeof(DSHNT_UNREGISTER_DOMAIN)) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            status = DshntHandleUnregisterDomain((const DSHNT_UNREGISTER_DOMAIN *)payload,
                                                 payload + sizeof(DSHNT_UNREGISTER_DOMAIN),
                                                 payloadLength - sizeof(DSHNT_UNREGISTER_DOMAIN));
        }
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgRegisterProcess:
        if (payloadLength < sizeof(DSHNT_REGISTER_PROCESS)) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            status = DshntHandleRegisterProcess((const DSHNT_REGISTER_PROCESS *)payload,
                                                payload + sizeof(DSHNT_REGISTER_PROCESS),
                                                payloadLength - sizeof(DSHNT_REGISTER_PROCESS));
        }
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgUnregisterProcess: {
        const DSHNT_UNREGISTER_PROCESS *req = (const DSHNT_UNREGISTER_PROCESS *)payload;
        if (payloadLength < sizeof(*req)) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
            DshntRemoveProcLocked(req->Pid);
            ExReleaseResourceLite(&g_Dshnt.Lock);
        }
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);
    }

    case DshntMsgGrantApply:
        if (payloadLength < sizeof(DSHNT_GRANT_APPLY)) {
            status = STATUS_INVALID_PARAMETER;
        } else {
            status = DshntHandleGrantApply((const DSHNT_GRANT_APPLY *)payload,
                                           payload + sizeof(DSHNT_GRANT_APPLY),
                                           payloadLength - sizeof(DSHNT_GRANT_APPLY));
        }
        return DshntFillReply(hdr, type, status, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);

    case DshntMsgRevokeApply: {
        const DSHNT_GRANT_APPLY *req = (const DSHNT_GRANT_APPLY *)payload;
        if (payloadLength >= sizeof(UINT32)) {
            DshntRevokeApply(req->Pid);
        }
        return DshntFillReply(hdr, type, STATUS_SUCCESS, NULL, 0, OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);
    }

    case DshntMsgQueryStats: {
        ULONG i;
        RtlZeroMemory(&stats, sizeof(stats));
        ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
        if (g_Dshnt.Policy != NULL) {
            for (i = 0; i < g_Dshnt.Policy->DomainCount; i++) {
                if (g_Dshnt.Policy->Domains[i].Id.Length > 0) stats.Domains++;
            }
            stats.Rules = g_Dshnt.Policy->RuleCount;
            stats.PolicyGeneration = g_Dshnt.Policy->Generation;
        }
        stats.ProcessCount = (UINT32)g_Dshnt.ProcessCount;
        ExReleaseResourceLite(&g_Dshnt.Lock);
        stats.Redirects = (UINT64)g_Dshnt.Redirects;
        stats.Denies = (UINT64)g_Dshnt.Denies;
        stats.Masks = (UINT64)g_Dshnt.Masks;
        stats.LastError = g_Dshnt.LastError;
        return DshntFillReply(hdr, type, STATUS_SUCCESS, &stats, sizeof(stats),
                              OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);
    }

    case DshntMsgQueryEvents: {
        PDSHNT_EVENTS_REPLY events;
        ULONG i;
        ULONG total = sizeof(DSHNT_MSG_HEADER) + sizeof(DSHNT_EVENTS_REPLY);

        if (OutputBuffer == NULL || OutputBufferLength < total) {
            return STATUS_BUFFER_TOO_SMALL;
        }
        events = (PDSHNT_EVENTS_REPLY)((PUCHAR)OutputBuffer + sizeof(DSHNT_MSG_HEADER));
        RtlZeroMemory(events, sizeof(*events));

        ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
        for (i = 0; i < g_Dshnt.EventCount && i < DSHNT_EVENT_BATCH; i++) {
            events->Records[i] = g_Dshnt.Events[g_Dshnt.EventTail];
            g_Dshnt.EventTail = (g_Dshnt.EventTail + 1) % DSHNT_EVENT_RING;
        }
        events->Count = i;
        events->Dropped = g_Dshnt.EventDropped;
        g_Dshnt.EventCount -= i;
        g_Dshnt.EventDropped = 0;
        ExReleaseResourceLite(&g_Dshnt.Lock);

        {
            PDSHNT_MSG_HEADER out = (PDSHNT_MSG_HEADER)OutputBuffer;
            out->Size = total;
            out->Version = (UINT16)DSHNT_ABI_VERSION;
            out->Type = (UINT16)(type | DshntMsgReply);
            out->Status = STATUS_SUCCESS;
            out->Reserved = hdr->Reserved;
        }
        *ReturnOutputBufferLength = total;
        return STATUS_SUCCESS;
    }

    default:
        return DshntFillReply(hdr, type, STATUS_INVALID_DEVICE_REQUEST, NULL, 0,
                              OutputBuffer, OutputBufferLength, ReturnOutputBufferLength);
    }
}

/* ------------------------------------------------------------ process notify */

static VOID DshntProcessNotify(_In_ HANDLE ParentId, _In_ HANDLE ProcessId, _In_ BOOLEAN Create)
{
    ULONG pid = (ULONG)(ULONG_PTR)ProcessId;
    ULONG parent = (ULONG)(ULONG_PTR)ParentId;

    if (Create) {
        DSHNT_PROC_ENTRY *parentEntry;
        WCHAR domainCopy[DSHNT_DOMAIN_ID_CHARS];
        ULONG flags;
        BOOLEAN inherit = FALSE;

        if (parent == 0) {
            return;
        }
        RtlZeroMemory(domainCopy, sizeof(domainCopy));
        flags = 0;

        ExAcquireResourceSharedLite(&g_Dshnt.Lock, TRUE);
        parentEntry = DshntFindProcLocked(parent);
        if (parentEntry != NULL && !FlagOn(parentEntry->Flags, DSHNT_PROC_TRUSTED)) {
            RtlStringCchCopyW(domainCopy, DSHNT_DOMAIN_ID_CHARS, parentEntry->DomainId);
            flags = parentEntry->Flags & DSHNT_PROC_ROOT;
            inherit = TRUE;
        }
        ExReleaseResourceLite(&g_Dshnt.Lock);

        if (inherit) {
            UNICODE_STRING inheritId;
            RtlInitUnicodeString(&inheritId, domainCopy);
            ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
            (void)DshntAddProcLocked(pid, flags, &inheritId);
            ExReleaseResourceLite(&g_Dshnt.Lock);
            DshntRecordEvent(DshntEventDomain, 0, DshntActionAllow, pid, &inheritId, NULL, NULL);
        }
    } else {
        ExAcquireResourceExclusiveLite(&g_Dshnt.Lock, TRUE);
        DshntRemoveProcLocked(pid);
        ExReleaseResourceLite(&g_Dshnt.Lock);
        DshntRevokeApply(pid);
    }
}

/* ------------------------------------------------------------------- setup */

static NTSTATUS DshntInstanceSetup(_In_ PCFLT_RELATED_OBJECTS FltObjects,
                                   _In_ FLT_INSTANCE_SETUP_FLAGS Flags,
                                   _In_ DEVICE_TYPE VolumeDeviceType,
                                   _In_ FLT_FILESYSTEM_TYPE VolumeFilesystemType)
{
    UNREFERENCED_PARAMETER(FltObjects);
    UNREFERENCED_PARAMETER(Flags);

    if (VolumeFilesystemType != FLT_FSTYPE_NTFS && VolumeFilesystemType != FLT_FSTYPE_REFS) {
        return STATUS_FLT_DO_NOT_ATTACH;
    }
    if (VolumeDeviceType != FILE_DEVICE_DISK_FILE_SYSTEM) {
        return STATUS_FLT_DO_NOT_ATTACH;
    }
    return STATUS_SUCCESS;
}

static NTSTATUS DshntUnload(_In_ FLT_FILTER_UNLOAD_FLAGS Flags)
{
    ULONG i;

    UNREFERENCED_PARAMETER(Flags);

    (void)PsSetCreateProcessNotifyRoutine(DshntProcessNotify, TRUE);

    if (g_Dshnt.ClientPort != NULL) {
        FltCloseClientPort(g_Dshnt.Filter, &g_Dshnt.ClientPort);
    }
    if (g_Dshnt.ServerPort != NULL) {
        FltCloseCommunicationPort(g_Dshnt.ServerPort);
        g_Dshnt.ServerPort = NULL;
    }
    FltUnregisterFilter(g_Dshnt.Filter);
    g_Dshnt.Filter = NULL;

    DshntFreePolicy(g_Dshnt.Policy);
    g_Dshnt.Policy = NULL;

    for (i = 0; i < DSHNT_PROC_BUCKETS; i++) {
        while (!IsListEmpty(&g_Dshnt.ProcBuckets[i])) {
            LIST_ENTRY *link = RemoveHeadList(&g_Dshnt.ProcBuckets[i]);
            DSHNT_PROC_ENTRY *entry = CONTAINING_RECORD(link, DSHNT_PROC_ENTRY, Link);
            ExFreePoolWithTag(entry, DSHNT_TAG);
        }
    }
    while (!IsListEmpty(&g_Dshnt.Grants)) {
        LIST_ENTRY *link = RemoveHeadList(&g_Dshnt.Grants);
        DSHNT_GRANT *grant = CONTAINING_RECORD(link, DSHNT_GRANT, Link);
        ULONG k;
        for (k = 0; k < grant->StringCount; k++) {
            if (grant->Strings[k] != NULL) ExFreePoolWithTag(grant->Strings[k], DSHNT_TAG);
        }
        ExFreePoolWithTag(grant, DSHNT_TAG);
    }

    ExDeleteResourceLite(&g_Dshnt.Lock);
    return STATUS_SUCCESS;
}

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    NTSTATUS status;
    UNICODE_STRING portName;
    OBJECT_ATTRIBUTES oa;
    PSECURITY_DESCRIPTOR sd = NULL;
    ULONG i;

    UNREFERENCED_PARAMETER(RegistryPath);

    DbgPrintEx(DPFLTR_IHVDRIVER_ID, DPFLTR_INFO_LEVEL, "dshnt: loading %ws\n", DSHNT_VERSION_STRING);

    RtlZeroMemory(&g_Dshnt, sizeof(g_Dshnt));
    for (i = 0; i < DSHNT_PROC_BUCKETS; i++) {
        InitializeListHead(&g_Dshnt.ProcBuckets[i]);
    }
    InitializeListHead(&g_Dshnt.Grants);
    ExInitializeResourceLite(&g_Dshnt.Lock);

    status = FltRegisterFilter(DriverObject, &g_DshntRegistration, &g_Dshnt.Filter);
    if (!NT_SUCCESS(status)) {
        ExDeleteResourceLite(&g_Dshnt.Lock);
        return status;
    }

    status = FltBuildDefaultSecurityDescriptor(&sd, FLT_PORT_ALL_ACCESS);
    if (!NT_SUCCESS(status)) {
        FltUnregisterFilter(g_Dshnt.Filter);
        ExDeleteResourceLite(&g_Dshnt.Lock);
        return status;
    }

    RtlInitUnicodeString(&portName, DSHNT_PORT_NAME);
    InitializeObjectAttributes(&oa, &portName,
                               OBJ_CASE_INSENSITIVE | OBJ_KERNEL_HANDLE,
                               NULL, sd);

    status = FltCreateCommunicationPort(g_Dshnt.Filter,
                                        &g_Dshnt.ServerPort,
                                        &oa,
                                        NULL,
                                        DshntConnect,
                                        DshntDisconnect,
                                        DshntMessage,
                                        1);
    FltFreeSecurityDescriptor(sd);
    if (!NT_SUCCESS(status)) {
        FltUnregisterFilter(g_Dshnt.Filter);
        ExDeleteResourceLite(&g_Dshnt.Lock);
        return status;
    }

    status = PsSetCreateProcessNotifyRoutine(DshntProcessNotify, FALSE);
    if (!NT_SUCCESS(status)) {
        FltCloseCommunicationPort(g_Dshnt.ServerPort);
        FltUnregisterFilter(g_Dshnt.Filter);
        ExDeleteResourceLite(&g_Dshnt.Lock);
        return status;
    }

    status = FltStartFiltering(g_Dshnt.Filter);
    if (!NT_SUCCESS(status)) {
        (void)PsSetCreateProcessNotifyRoutine(DshntProcessNotify, TRUE);
        FltCloseCommunicationPort(g_Dshnt.ServerPort);
        FltUnregisterFilter(g_Dshnt.Filter);
        ExDeleteResourceLite(&g_Dshnt.Lock);
        return status;
    }

    return STATUS_SUCCESS;
}
