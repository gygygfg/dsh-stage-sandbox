/* WinStageSandbox -- T4 shim: process-creation hooks + child self-injection.
 *
 * WHY THIS EXISTS (defect ① second half, measured):
 * The shim is a user-mode IAT patch: it only covers the process the DLL was
 * loaded into. `run.cmd ... --tier TS -- cmd /c <script>.cmd` injects **cmd.exe**
 * and nothing else, so every process the script starts (`powershell.exe`,
 * `node.exe`, ...) ran completely unhooked: measured in the shim log, only the
 * cmd.exe PID ever initialized, and `node -e "fs.writeFileSync(<real path>)"` /
 * `powershell Set-Content <real path>` created REAL files on the host disk
 * (shim/out/../.t/shim-delete/raw/diag-child.txt). Every delete form that runs in
 * such a child therefore bypassed the staging layer by construction, no matter
 * which file API it used.
 *
 * Fix: CreateProcess* are hook targets too (measured callers: cmd.exe's
 * `CreateProcessW` for `powershell.exe` and `node.exe`, IAT hits in cmd.exe,
 * ucrtbase, msvcrt, sechost). The wrapper forces CREATE_SUSPENDED on the child,
 * remote-injects this very DLL (the same CreateProcess(SUSPENDED) +
 * LoadLibraryW transport `winstage-inject.exe` uses), and resumes the child only
 * if the caller did not ask for a suspended process.
 *
 * Fail-closed, like every other hook here: if the child cannot be injected, the
 * child is terminated, CreateProcess* fails with ERROR_ACCESS_DENIED and nothing
 * runs unhooked. That is the only honest option -- a child we cannot inject WILL
 * write straight through to the real system (see the measurement above).
 */
#include "winstage_internal.h"
#include <tlhelp32.h>

static wchar_t g_selfDll[WS_PATH_MAX];
static int g_selfDllOk;
static HMODULE g_selfBase; /* this shim's module base (for remote export addresses) */
/* defect 4: was a non-reentrant `volatile LONG g_procLock`. */
static WsLock g_procLock = { 0, 0, 0, "proc" };
static long g_injectCount;
static long g_injectFail;

/* defect 3: the remote LoadLibraryW wait used to be a hard 30 s. A stuck child
 * then froze the *calling* process (the carrier) for 30 s, which the outside
 * world only saw as "hangs". Injection normally takes well under 100 ms; the
 * default is deliberately far below 30 s but far above 100 ms, because a cold
 * cache / an AV scanner reading the just-loaded DLL can legitimately take a
 * second. Override with WINSTAGE_INJECT_WAIT_MS (50..60000) when bisecting. */
#define WS_INJECT_WAIT_DEFAULT_MS 2000

static DWORD ws_inject_wait_ms(void)
{
    static volatile LONG cached = -1;
    LONG c = cached;
    if (c >= 0) {
        return (DWORD)c;
    }
    DWORD ms = WS_INJECT_WAIT_DEFAULT_MS;
    wchar_t buf[32];
    DWORD n = GetEnvironmentVariableW(L"WINSTAGE_INJECT_WAIT_MS", buf, 32);
    if (n > 0 && n < 32) {
        long v = 0;
        int ok = 1;
        for (DWORD i = 0; i < n; i++) {
            if (buf[i] < L'0' || buf[i] > L'9') { ok = 0; break; }
            v = v * 10 + (buf[i] - L'0');
            if (v > 60000) { ok = 0; break; }
        }
        if (ok && v >= 50) {
            ms = (DWORD)v;
        }
    }
    InterlockedExchange(&cached, (LONG)ms);
    return ms;
}

/* Called from ws_hook_init() once the self module is known. */
void ws_proc_set_self_module(HMODULE self)
{
    if (!self) {
        return;
    }
    g_selfBase = self;
    DWORD n = GetModuleFileNameW(self, g_selfDll, WS_PATH_MAX);
    g_selfDllOk = (n > 0 && n < WS_PATH_MAX);
    ws_log("child injection armed: self=%ls ok=%d", g_selfDllOk ? g_selfDll : L"(unknown)", g_selfDllOk);
}

/* ---------------------------------------------------------- env contract */

/* The shim's DllMain auto-initializes from DSH_STAGE_ROOT /
 * DSH_SHIM_CONFIG / DSH_SHIM_LOG. When the caller passes an explicit
 * environment block those variables are NOT necessarily in it, and an injected
 * child whose shim loads inert is worse than no injection at all (it would look
 * hooked while writing through). Rebuild the block with the three contract
 * variables overridden/added. Returns a HeapAlloc'd block (caller frees) or NULL
 * on failure (the caller then fails the CreateProcess* fail-closed). */
static wchar_t *ws_env_with_contract(const wchar_t *env)
{
    static const wchar_t *names[4] = { L"DSH_STAGE_ROOT", L"DSH_SHIM_LOG", L"DSH_SHIM_CONFIG", L"DSH_REGSTAGE_SESSION_DIR" };
    const wchar_t *values[4] = { g_ws.stageRoot, g_ws.logPath, g_ws.configPath, g_ws.regStageDir };
    size_t total = 1;
    for (const wchar_t *p = env; p && *p; p += wcslen(p) + 1) {
        int skip = 0;
        for (int i = 0; i < 4; i++) {
            size_t nl = wcslen(names[i]);
            if (_wcsnicmp(p, names[i], nl) == 0 && p[nl] == L'=') {
                skip = 1;
                break;
            }
        }
        if (!skip) {
            total += wcslen(p) + 1;
        }
    }
    for (int i = 0; i < 4; i++) {
        if (values[i] && values[i][0]) {
            total += wcslen(names[i]) + 1 + wcslen(values[i]) + 1;
        }
    }
    wchar_t *block = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, total * sizeof(wchar_t));
    if (!block) {
        return NULL;
    }
    size_t used = 0;
    for (const wchar_t *p = env; p && *p; p += wcslen(p) + 1) {
        int skip = 0;
        for (int i = 0; i < 3; i++) {
            size_t nl = wcslen(names[i]);
            if (_wcsnicmp(p, names[i], nl) == 0 && p[nl] == L'=') {
                skip = 1;
                break;
            }
        }
        if (skip) {
            continue;
        }
        size_t len = wcslen(p);
        memcpy(block + used, p, (len + 1) * sizeof(wchar_t));
        used += len + 1;
    }
    for (int i = 0; i < 3; i++) {
        if (!values[i] || !values[i][0]) {
            continue;
        }
        size_t nl = wcslen(names[i]);
        memcpy(block + used, names[i], nl * sizeof(wchar_t));
        used += nl;
        block[used++] = L'=';
        size_t vl = wcslen(values[i]);
        memcpy(block + used, values[i], vl * sizeof(wchar_t));
        used += vl;
        block[used++] = L'\0';
    }
    block[used] = L'\0';
    return block;
}

/* -------------------------------------------------------------- injection */

/* ★ R20①：DllMain 不再做初始化，所以远程 LoadLibraryW 成功只代表模块已映射。
 * 这里在子进程里再起一个远程线程调用本 DLL 导出的 `WinstageShimInit()`，等它返回
 * （= 初始化完成）之后，调用方才会 ResumeThread。重活因此不再跑在 loader-lock /
 * CLR 未初始化窗口里，初始化失败也变成可判定的返回码。
 *
 * 远程地址 = 远程模块基址 + (本地导出地址 - 本地模块基址)：同一个 DLL 映像在
 * 两个进程里的相对偏移一致（远程 LoadLibraryW 返回的 HMODULE 就是远程基址）。
 *
 * 失败语义：线程超时/以异常码结束 ⇒ 子进程里没有可用钩子 ⇒ 失败关闭（调用方会
 * TerminateProcess）；返回普通 Win32 错误码时保持 R20 之前的 DllMain 语义
 * （子进程继续跑，只记录日志）——DISABLE=1 的 1058 就是这类情况。 */
static int ws_remote_init(HANDLE hProcess, HMODULE remoteModule)
{
    if (!g_selfBase || !remoteModule) {
        SetLastError(ERROR_MOD_NOT_FOUND);
        return 0;
    }
    BYTE *localFn = (BYTE *)(void *)&WinstageShimInit;
    BYTE *remoteFn = (BYTE *)(ULONG_PTR)remoteModule + (localFn - (BYTE *)g_selfBase);
    HANDLE th = CreateRemoteThread(hProcess, NULL, 0, (LPTHREAD_START_ROUTINE)remoteFn, NULL, 0, NULL);
    if (!th) {
        return 0;
    }
    DWORD waitMs = ws_inject_wait_ms();
    ws_stuck_enter("inject:remote-WinstageShimInit");
    DWORD wait = WaitForSingleObject(th, waitMs);
    ws_stuck_leave();
    DWORD rc = 0;
    GetExitCodeThread(th, &rc);
    CloseHandle(th);
    if (wait != WAIT_OBJECT_0) {
        ws_log("STUCK remote WinstageShimInit did not complete within %lu ms (pid=%lu); failing closed",
               (unsigned long)waitMs, (unsigned long)GetProcessId(hProcess));
        SetLastError(ERROR_TIMEOUT);
        return 0;
    }
    if ((rc & 0x80000000u) != 0) {
        ws_log("remote WinstageShimInit crashed (exit=0x%lx, pid=%lu); failing closed",
               (unsigned long)rc, (unsigned long)GetProcessId(hProcess));
        SetLastError(rc);
        return 0;
    }
    if (rc != 0) {
        ws_log("child shim init returned %lu (pid=%lu); child continues (same semantics as the"
               " previous DllMain auto-init)",
               (unsigned long)rc, (unsigned long)GetProcessId(hProcess));
    }
    return 1;
}

/**
 * Recover the real module base of our DLL in the child process.
 *
 * WHY THIS EXISTS (2026-11-23, real Windows 10 / x64): the remote
 * `LoadLibraryW` thread's exit code is a **DWORD**, so on x64 the module handle
 * (0x7ff8...) is truncated. `ws_remote_init()` added the export RVA to that
 * truncated value and started a thread at an unmapped / CFG-invalid address;
 * the child died with 0xC0000409, `ws_inject_into()` returned 0, and every
 * CreateProcess inside the sandbox failed closed with ERROR_ACCESS_DENIED
 * (observed as `whoami.exe: access denied` in the transparent-shim canary).
 *
 * The module table is authoritative, and the path comparison also rejects a
 * stale copy that happens to be mapped in the target.
 */
static HMODULE ws_find_remote_module(HANDLE hProcess)
{
    if (!g_selfDllOk) {
        return NULL;
    }
    DWORD pid = GetProcessId(hProcess);
    if (!pid) {
        return NULL;
    }
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    MODULEENTRY32W me;
    memset(&me, 0, sizeof(me));
    me.dwSize = sizeof(me);
    HMODULE found = NULL;
    if (Module32FirstW(snap, &me)) {
        do {
            if (me.szExePath[0] && _wcsicmp(me.szExePath, g_selfDll) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
            const wchar_t *a = wcsrchr(me.szExePath, L'\\');
            const wchar_t *b = wcsrchr(g_selfDll, L'\\');
            if (a && b && _wcsicmp(a + 1, b + 1) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return found;
}

static int ws_inject_into(HANDLE hProcess)
{
    if (!g_selfDllOk) {
        SetLastError(ERROR_MOD_NOT_FOUND);
        return 0;
    }
    SIZE_T bytes = (wcslen(g_selfDll) + 1) * sizeof(wchar_t);
    void *mem = VirtualAllocEx(hProcess, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!mem) {
        return 0;
    }
    int ok = 0;
    if (WriteProcessMemory(hProcess, mem, g_selfDll, bytes, NULL)) {
        /* kernel32!LoadLibraryW is at the same address in both processes: system
         * DLLs are relocated once per boot, not once per process (the same
         * assumption winstage-inject.exe already relies on). */
        FARPROC loadLibraryW = (FARPROC)g_orig.LoadLibraryW;
        if (!loadLibraryW) {
            loadLibraryW = (FARPROC)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
        }
        if (loadLibraryW) {
            HANDLE th = CreateRemoteThread(hProcess, NULL, 0, (LPTHREAD_START_ROUTINE)loadLibraryW, mem, 0, NULL);
            if (th) {
                /* defect 3: bounded wait. On timeout the caller terminates the
                 * (still suspended / half-initialised) child and fails closed
                 * with ERROR_DLL_INIT_FAILED, instead of freezing the parent. */
                DWORD waitMs = ws_inject_wait_ms();
                ws_stuck_enter("inject:remote-LoadLibraryW");
                DWORD wait = WaitForSingleObject(th, waitMs);
                ws_stuck_leave();
                DWORD moduleResult = 0;
                GetExitCodeThread(th, &moduleResult);
                CloseHandle(th);
                /* moduleResult == 0 means LoadLibraryW returned NULL in the child
                 * (e.g. a 32-bit child: an x64 DLL cannot be mapped there). */
                ok = (wait == WAIT_OBJECT_0 && moduleResult != 0);
                if (wait == WAIT_TIMEOUT) {
                    ws_log("STUCK remote LoadLibraryW did not complete within %lu ms (pid=%lu); failing closed",
                           (unsigned long)waitMs, (unsigned long)GetProcessId(hProcess));
                }
                if (!ok) {
                    SetLastError(ERROR_DLL_INIT_FAILED);
                }
                /* R20①：模块映射成功还不够 —— 在子进程里跑显式初始化并等它就绪。 */
                /* moduleResult is a truncated x64 HMODULE; the module table is
                 * the authoritative base (see ws_find_remote_module). */
                HMODULE remoteBase = ok ? ws_find_remote_module(hProcess) : NULL;
                if (ok && !remoteBase) {
                    remoteBase = (HMODULE)(ULONG_PTR)moduleResult;
                }
                if (ok && !ws_remote_init(hProcess, remoteBase)) {
                    if (GetLastError() == ERROR_SUCCESS) {
                        SetLastError(ERROR_DLL_INIT_FAILED);
                    }
                    ok = 0;
                }
            }
        }
    }
    VirtualFreeEx(hProcess, mem, 0, MEM_RELEASE);
    return ok;
}

/* ---------------------------------------------------------------- wmic RPC  --
 * 2026-11-23（AI 红队实测后的"重定向优先"修复）：
 *
 * `wmic process call create "cmd /c ..."` 由 **WmiPrvSE.exe（未注入的服务进程）**
 * 创建子进程 —— 垫片的 CreateProcess 钩子看不到它，真实盘会被写穿。
 * 硬拒绝不是唯一出路：wmic 的语义只是"把后面那串命令行交给 WMI 去起进程"，
 * 因此我们在**调用方**改写那条内层命令行，让它先经过 `winstage-inject.exe`：
 *
 *     wmic process call create "cmd /c echo x > C:\Windows\System32\x.txt"
 *   → wmic process call create "<injector> --dll <shim.dll> --set-env ... -- cmd /d /c <.wmi-*.cmd>"
 *
 * WmiPrvSE 起的仍然是"我们给的命令行"，注入器把真正的命令注入垫片后再放行 ⇒
 * 子进程的文件/注册表写入回到暂存树。wmic 对调用方的输出保持"Method execution
 * successful + ProcessId"的形态（PID 是注入器的，语义上仍是"被创建的那个进程"）。
 *
 * 失败关闭：改写构造不出来（缺配置/写不出脚本）⇒ CreateProcess 返回
 * ERROR_ACCESS_DENIED，绝不放行到真实 WMI。远程目标（/node:）不在此列 ——
 * 注入器路径在远端不存在，因此同样失败关闭。
 * ------------------------------------------------------------------------- */
typedef struct WsWmicToken {
    const wchar_t *start;
    int len;
    int quoted;
} WsWmicToken;

static int ws_wmic_next_token(const wchar_t *s, int *pos, WsWmicToken *out)
{
    int i = *pos;
    while (s[i] == L' ' || s[i] == L'\t') {
        i++;
    }
    if (!s[i]) {
        return 0;
    }
    int quoted = 0;
    if (s[i] == L'"') {
        quoted = 1;
        i++;
    }
    int start = i;
    while (s[i]) {
        /* 命令行里的 \" 是引号转义（Node/MSVCRT 风格），不是参数的结束 */
        if (quoted && s[i] == L'\\' && s[i + 1] == L'"') {
            i += 2;
            continue;
        }
        if (quoted && s[i] == L'"') {
            break;
        }
        if (!quoted && (s[i] == L' ' || s[i] == L'\t')) {
            break;
        }
        i++;
    }
    out->start = s + start;
    out->len = i - start;
    out->quoted = quoted;
    if (quoted && s[i] == L'"') {
        i++;
    }
    *pos = i;
    return 1;
}

static int ws_wmic_token_eq(const WsWmicToken *t, const wchar_t *literal)
{
    int n = (int)wcslen(literal);
    return t->len == n && _wcsnicmp(t->start, literal, n) == 0;
}

/** 返回 1 = 命中本地 process call create（inner 指向内层命令行）；2 = 远程目标；0 = 不相关 */
static int ws_wmic_extract_create(const wchar_t *cmd, const wchar_t **inner, int *innerLen)
{
    WsWmicToken tokens[64];
    int count = 0;
    int pos = 0;
    WsWmicToken token;
    while (count < 64 && ws_wmic_next_token(cmd, &pos, &token)) {
        tokens[count++] = token;
    }
    int remote = 0;
    for (int i = 0; i < count; i++) {
        if (tokens[i].len > 6 && _wcsnicmp(tokens[i].start, L"/node:", 6) == 0) {
            const wchar_t *value = tokens[i].start + 6;
            int len = tokens[i].len - 6;
            if (!((len == 1 && value[0] == L'.') || (len == 9 && _wcsnicmp(value, L"localhost", 9) == 0) ||
                  (len == 9 && _wcsnicmp(value, L"127.0.0.1", 9) == 0))) {
                remote = 1;
            }
        }
    }
    for (int i = 1; i + 3 < count; i++) {
        if (ws_wmic_token_eq(&tokens[i], L"process") && ws_wmic_token_eq(&tokens[i + 1], L"call") &&
            ws_wmic_token_eq(&tokens[i + 2], L"create")) {
            *inner = tokens[i + 3].start;
            *innerLen = tokens[i + 3].len;
            return remote ? 2 : 1;
        }
    }
    return 0;
}

static int ws_wmic_write_utf8(HANDLE file, const wchar_t *text, int len)
{
    if (len <= 0) {
        return 1;
    }
    int need = WideCharToMultiByte(CP_UTF8, 0, text, len, NULL, 0, NULL, NULL);
    if (need <= 0) {
        return 0;
    }
    char *buffer = (char *)malloc((size_t)need);
    if (!buffer) {
        return 0;
    }
    int got = WideCharToMultiByte(CP_UTF8, 0, text, len, buffer, need, NULL, NULL);
    DWORD wrote = 0;
    int ok = got == need && WriteFile(file, buffer, (DWORD)need, &wrote, NULL) && wrote == (DWORD)need;
    free(buffer);
    return ok;
}

/** 写内层命令脚本（UTF-8 + chcp 65001）；`\"` 还原成 `"`（wmic 外层引号留下的转义） */
static int ws_wmic_write_script(const wchar_t *inner, int innerLen, wchar_t *outPath, DWORD cch)
{
    const wchar_t *dir = g_ws.regStageDir[0] ? g_ws.regStageDir : g_ws.stageRoot;
    static volatile LONG seq = 0;
    _snwprintf(outPath, cch, L"%ls\\.wmi-%lu-%ld.cmd", dir, (unsigned long)GetCurrentProcessId(),
               (long)InterlockedIncrement(&seq));
    outPath[cch - 1] = 0;
    HANDLE file = CreateFileW(outPath, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return 0;
    }
    wchar_t *unescaped = (wchar_t *)malloc(((size_t)innerLen + 1) * sizeof(wchar_t));
    if (!unescaped) {
        CloseHandle(file);
        return 0;
    }
    int n = 0;
    for (int i = 0; i < innerLen; i++) {
        if (inner[i] == L'\\' && i + 1 < innerLen && inner[i + 1] == L'"') {
            unescaped[n++] = L'"';
            i++;
        } else {
            unescaped[n++] = inner[i];
        }
    }
    const wchar_t *head = L"@chcp 65001>nul\r\n@echo off\r\n";
    int ok = ws_wmic_write_utf8(file, head, (int)wcslen(head)) && ws_wmic_write_utf8(file, unescaped, n) &&
             ws_wmic_write_utf8(file, L"\r\n", 2);
    free(unescaped);
    CloseHandle(file);
    if (!ok) {
        DeleteFileW(outPath);
    }
    return ok;
}

/** 构造注入器命令行（作为 wmic 的唯一内层命令） */
static wchar_t *ws_wmic_build_inject_cmd(const wchar_t *scriptPath)
{
    if (!g_selfDll[0] || !g_ws.stageRoot[0] || !g_ws.configPath[0] || !g_ws.logPath[0]) {
        return NULL;
    }
    wchar_t dir[WS_PATH_MAX];
    ws_strlcpy_w(dir, g_selfDll, WS_PATH_MAX);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (!slash) {
        return NULL;
    }
    slash[1] = 0;
    wchar_t injector[WS_PATH_MAX];
    _snwprintf(injector, WS_PATH_MAX, L"%ls%ls", dir, L"winstage-inject.exe");
    injector[WS_PATH_MAX - 1] = 0;

    wchar_t regPart[WS_PATH_MAX + 64];
    regPart[0] = 0;
    if (g_ws.regStageDir[0]) {
        _snwprintf(regPart, WS_PATH_MAX + 64, L" --set-env \"DSH_REGSTAGE_SESSION_DIR=%ls\"", g_ws.regStageDir);
        regPart[WS_PATH_MAX + 63] = 0;
    }
    wchar_t auditPart[WS_PATH_MAX + 64];
    auditPart[0] = 0;
    if (g_ws.auditPath[0]) {
        _snwprintf(auditPart, WS_PATH_MAX + 64, L" --set-env \"DSH_AUDIT_LOG=%ls\"", g_ws.auditPath);
        auditPart[WS_PATH_MAX + 63] = 0;
    }
    size_t cch = (WS_PATH_MAX * 6) + 1024;
    wchar_t *out = (wchar_t *)malloc(cch * sizeof(wchar_t));
    if (!out) {
        return NULL;
    }
    _snwprintf(out, cch,
               L"\"%ls\" --dll \"%ls\" --set-env \"DSH_STAGE_ROOT=%ls\" --set-env \"DSH_SHIM_CONFIG=%ls\" "
               L"--set-env \"DSH_SHIM_LOG=%ls\"%ls%ls --cwd \"%ls\" -- cmd.exe /d /c \"%ls\"",
               injector, g_selfDll, g_ws.stageRoot, g_ws.configPath, g_ws.logPath, regPart, auditPart, g_ws.stageRoot,
               scriptPath);
    out[cch - 1] = 0;
    return out;
}

/* The staged CLI helper itself must be able to spawn the REAL wevtutil for a
 * read of a non-cleared channel. The marker is honoured only when the CURRENT
 * process image is our helper -- an agent's `set WINSTAGE_CLI_REAL=1 & sc ...`
 * runs inside cmd.exe and is still rewritten. */
static int ws_cli_real_bypass(void)
{
    wchar_t flag[8];
    if (GetEnvironmentVariableW(L"WINSTAGE_CLI_REAL", flag, 8) == 0 || flag[0] != L'1') {
        return 0;
    }
    wchar_t self[WS_PATH_MAX];
    if (!GetModuleFileNameW(NULL, self, WS_PATH_MAX)) {
        return 0;
    }
    const wchar_t *base = wcsrchr(self, L'\\');
    base = base ? base + 1 : self;
    return _wcsicmp(base, L"winstage-probe.exe") == 0;
}

/* --------------------------------------------------------------- sc.exe RPC --
 * 2026-11-23（第二轮实测）：`sc.exe` **不导入** advapi32 的 SCM API —— 它的导入表里
 * 只有 RPCRT4!NdrClientCall2，是 svcctl 接口的裸 RPC 客户端。因此 advapi32 覆盖层
 * （ws_scm.c）只能覆盖 PowerShell New-Service / .NET 这类程序化调用，`sc create`
 * 仍然直接写真实 SCM（实测真实服务键 + 真实启动）。
 *
 * 这里在 CreateProcess 处把 `sc.exe` 换成随垫片发布的 CLI 助手：
 *     sc.exe <args>  →  winstage-probe.exe --sc <args>
 * 助手是 advapi32 的薄 CLI（probe/winstage_sc.c），被注入后它的 SCM 调用就落到
 * ws_scm.c 的会话日志里；真实 services.exe 完全不被触碰。
 *
 * 只替换本机 `sc`/`sc.exe`；解析不出命令行就 fail-closed（绝不回落真 sc）。
 * ------------------------------------------------------------------------- */

static int ws_token_span(const wchar_t *s, int *outStart, int *outEnd)
{
    int i = 0;
    while (s[i] == L' ' || s[i] == L'\t') {
        i++;
    }
    *outStart = i;
    if (s[i] == L'"') {
        i++;
        while (s[i] && s[i] != L'"') {
            i++;
        }
        if (s[i] == L'"') {
            i++;
        }
    } else {
        while (s[i] && s[i] != L' ' && s[i] != L'\t') {
            i++;
        }
    }
    *outEnd = i;
    return i;
}

static int ws_basename_is_cli(const wchar_t *token, int len, const wchar_t *name)
{
    if (len >= 2 && token[0] == L'"' && token[len - 1] == L'"') {
        token++;
        len -= 2;
    }
    int start = 0;
    for (int i = 0; i < len; i++) {
        if (token[i] == L'\\' || token[i] == L'/') {
            start = i + 1;
        }
    }
    const wchar_t *base = token + start;
    int n = len - start;
    int nameLen = (int)wcslen(name);
    if (n == nameLen && _wcsnicmp(base, name, nameLen) == 0) {
        return 1;
    }
    if (n == nameLen + 4 && _wcsnicmp(base, name, nameLen) == 0 &&
        _wcsnicmp(base + nameLen, L".exe", 4) == 0) {
        return 1;
    }
    return 0;
}

/** Build `"<probe>" --sc <original arguments>`; NULL = could not build. */
static wchar_t *ws_cli_rewrite_cmd(LPCWSTR app, LPCWSTR cmd, const wchar_t *baseName,
                                   const wchar_t *mode, wchar_t *probeOut, DWORD probeCch)
{
    if (!g_selfDll[0]) {
        return NULL;
    }
    wchar_t dir[WS_PATH_MAX];
    ws_strlcpy_w(dir, g_selfDll, WS_PATH_MAX);
    wchar_t *slash = wcsrchr(dir, L'\\');
    if (!slash) {
        return NULL;
    }
    slash[1] = 0;
    _snwprintf(probeOut, probeCch, L"%lswinstage-probe.exe", dir);
    probeOut[probeCch - 1] = 0;

    const wchar_t *remainder = L"";
    if (cmd && cmd[0]) {
        int start = 0, end = 0;
        ws_token_span(cmd, &start, &end);
        if (ws_basename_is_cli(cmd + start, end - start, baseName)) {
            remainder = cmd + end;
        } else {
            remainder = cmd;
        }
    }
    size_t cch = wcslen(probeOut) + wcslen(remainder) + 64;
    wchar_t *out = (wchar_t *)malloc(cch * sizeof(wchar_t));
    if (!out) {
        return NULL;
    }
    if (wcscmp(mode, L"--evt") == 0 || wcscmp(mode, L"--task") == 0) {
        wchar_t journal[WS_PATH_MAX];
        const wchar_t *dir = g_ws.regStageDir[0] ? g_ws.regStageDir : g_ws.stageRoot;
        const wchar_t *leaf = (wcscmp(mode, L"--evt") == 0) ? L"eventlog.overlay.jsonl"
                                                           : L"tasks.overlay.jsonl";
        _snwprintf(journal, WS_PATH_MAX, L"%ls\\%ls", dir, leaf);
        journal[WS_PATH_MAX - 1] = 0;
        _snwprintf(out, cch, L"\"%ls\" %ls \"%ls\" %ls", probeOut, mode, journal, remainder);
    } else {
        _snwprintf(out, cch, L"\"%ls\" %ls %ls", probeOut, mode, remainder);
    }
    out[cch - 1] = 0;
    return out;
}

static BOOL ws_create_process_common(HANDLE token, int hasToken, LPCWSTR app, LPWSTR cmd,                                     LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta, BOOL inherit,
                                     DWORD flags, LPVOID env, LPCWSTR cwd, LPSTARTUPINFOW si,
                                     LPPROCESS_INFORMATION pi)
{
    /* ★ WP13（C1）：本函数旧实现会在**成功路径**把调用线程的 last error 硬清成 0
     * （原 `:208` 豁免分支与 `:235` 正常分支），而中途的 `HeapFree` / `ws_log` /
     * `ResumeThread` 也会覆写它。对照真实 API 语义：
     *   · `CreateProcessW` **成功时不改** last error ⇒ 钩子也应"不改"：还原入口值；
     *   · **失败时**必须把**真实 API 刚给出的错误**交给调用方（不是入口值）；
     *   · 转发分支（`!pi`）原样放行，**不还原**；
     *   · `ERROR_NOT_ENOUGH_MEMORY`（环境构造失败）是**本函数自己**的错误，刻意保留。
     * 入口保存必须是第一条语句，后面的还原点才有意义。 */
    DWORD ws_saved_last_error = GetLastError();
    WS_STUCK("CreateProcess");
    if (app || cmd) {
        ws_stuck_path(app ? app : cmd);
    }
    if (!pi) {
        return hasToken ? g_orig.CreateProcessAsUserW(token, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi)
                        : g_orig.CreateProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
    }
    /* Debug/protected creations cannot be injected safely (the debugger owns the
     * first event) and must not be broken, so they pass through with a log. */
    int exempt = (flags & (DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS | CREATE_PROTECTED_PROCESS)) != 0;
    /**
     * ── wmic process call create：把内层命令改道到注入器（见文件头注释）─────────
     * 只处理本机目标；`/node:` 指向远端时无法把注入器一起送过去，失败关闭。
     */
    wchar_t scProbe[WS_PATH_MAX];
    wchar_t *scRewrite = NULL;
    if (!exempt && !hasToken && !ws_cli_real_bypass()) {
        int isSc = 0, isEvt = 0, isTask = 0;
        if (app && app[0]) {
            isSc = ws_basename_is_cli(app, (int)wcslen(app), L"sc");
            isEvt = ws_basename_is_cli(app, (int)wcslen(app), L"wevtutil");
            isTask = ws_basename_is_cli(app, (int)wcslen(app), L"schtasks");
        } else if (cmd && cmd[0]) {
            int start = 0, end = 0;
            ws_token_span(cmd, &start, &end);
            isSc = ws_basename_is_cli(cmd + start, end - start, L"sc");
            isEvt = ws_basename_is_cli(cmd + start, end - start, L"wevtutil");
            isTask = ws_basename_is_cli(cmd + start, end - start, L"schtasks");
        }
        if (isSc || isEvt || isTask) {
            const wchar_t *mode = isSc ? L"--sc" : (isEvt ? L"--evt" : L"--task");
            const wchar_t *baseName = isSc ? L"sc" : (isEvt ? L"wevtutil" : L"schtasks");
            scRewrite = ws_cli_rewrite_cmd(app, cmd, baseName, mode, scProbe, WS_PATH_MAX);
            if (!scRewrite) {
                ws_log("staged CLI: could not build the helper command; failing closed");
                SetLastError(ERROR_ACCESS_DENIED);
                return FALSE;
            }
            ws_log("%ls redirected to the staged CLI helper",
                   isSc ? L"sc.exe" : (isEvt ? L"wevtutil.exe" : L"schtasks.exe"));
            cmd = scRewrite;
            app = scProbe;
        }
    }
    wchar_t *wmiRewrite = NULL;
    if (!exempt && !hasToken && cmd && cmd[0]) {
        const wchar_t *image = app ? app : cmd;
        const wchar_t *base = image;
        for (const wchar_t *p = image; *p; p++) {
            if (*p == L'\\' || *p == L'/') {
                base = p + 1;
            }
        }
        int isWmic = (_wcsicmp(base, L"wmic") == 0 || _wcsicmp(base, L"wmic.exe") == 0 ||
                      _wcsicmp(base, L"wmic\"") == 0);
        if (isWmic) {
            const wchar_t *inner = NULL;
            int innerLen = 0;
            int hit = ws_wmic_extract_create(cmd, &inner, &innerLen);
            if (hit == 2) {
                ws_log("wmic remote process-create (/node:) cannot be redirected; failing closed");
                SetLastError(ERROR_ACCESS_DENIED);
                return FALSE;
            }
            if (hit == 1) {
                wchar_t script[WS_PATH_MAX];
                if (ws_wmic_write_script(inner, innerLen, script, WS_PATH_MAX)) {
                    wmiRewrite = ws_wmic_build_inject_cmd(script);
                }
                if (!wmiRewrite) {
                    ws_log("wmic process create: could not build the injector command; failing closed");
                    SetLastError(ERROR_ACCESS_DENIED);
                    return FALSE;
                }
                ws_log("wmic process create redirected through the injector: script=%ls", script);
                cmd = wmiRewrite;
                app = NULL;
            }
        }
    }
    int forced = 0;
    DWORD newFlags = flags;
    if (!exempt && !(flags & CREATE_SUSPENDED)) {
        newFlags = flags | CREATE_SUSPENDED;
        forced = 1;
    }
    wchar_t *newEnv = NULL;
    wchar_t *inheritedEnv = NULL;
    int inheritContract = 0;
    if (!exempt) {
        /* 临时验证：把契约变量放进当前进程环境，让子进程用 NULL 继承。 */
        SetEnvironmentVariableW(L"DSH_STAGE_ROOT", g_ws.stageRoot);
        SetEnvironmentVariableW(L"DSH_SHIM_LOG", g_ws.logPath);
        SetEnvironmentVariableW(L"DSH_SHIM_CONFIG", g_ws.configPath);
        if (g_ws.regStageDir[0]) {
            SetEnvironmentVariableW(L"DSH_REGSTAGE_SESSION_DIR", g_ws.regStageDir);
        }
        env = NULL;
        inheritContract = 1;
    }
    if (!inheritContract && !exempt && !env) {
        /* 调用方用 NULL 表示“继承当前环境”。当前环境已被 ws_env_scrub_contract()
         * 清掉契约变量；必须显式复制一份再补回，否则子进程 shim 加载后是惰性的。 */
        inheritedEnv = GetEnvironmentStringsW();
        if (!inheritedEnv) {
            SetLastError(ERROR_NOT_ENOUGH_MEMORY);
            return FALSE;
        }
        env = inheritedEnv;
    }
    if (!exempt && env && !inheritedEnv) {
        /* 临时调试：显式 env 也改为基于当前进程环境重建。 */
        inheritedEnv = GetEnvironmentStringsW();
        if (inheritedEnv) env = inheritedEnv;
    }    if (!exempt && env) {
        newEnv = ws_env_with_contract((const wchar_t *)env);
        if (inheritedEnv) {
            FreeEnvironmentStringsW(inheritedEnv);
            inheritedEnv = NULL;
        }
        if (!newEnv) {
            ws_log("child env rebuild failed (explicit=%d)", env ? 1 : 0);
            /* 自己的错误：保留（不要被下面的还原点抹掉） */
            SetLastError(ERROR_NOT_ENOUGH_MEMORY);
            return FALSE;
        }
    }
    BOOL ok = hasToken
                  ? g_orig.CreateProcessAsUserW(token, app, cmd, pa, ta, inherit, newFlags,
                                                newEnv ? newEnv : env, cwd, si, pi)
                  : g_orig.CreateProcessW(app, cmd, pa, ta, inherit, newFlags,
                                          newEnv ? newEnv : env, cwd, si, pi);
    /* 立刻取走真实 API 的错误：下面还有 HeapFree/日志，它们都会覆写线程状态 */
    DWORD createErr = GetLastError();
    if (inheritContract) {
        SetEnvironmentVariableW(L"DSH_STAGE_ROOT", NULL);
        SetEnvironmentVariableW(L"DSH_SHIM_LOG", NULL);
        SetEnvironmentVariableW(L"DSH_SHIM_CONFIG", NULL);
    }
    if (!ok) {
        ws_log("CreateProcess failed err=%lu env=%p newEnv=%p inherited=%d flags=0x%lx",
               (unsigned long)createErr, env, newEnv, inheritedEnv ? 1 : 0, (unsigned long)newFlags);
    }
    if (newEnv) {
        HeapFree(GetProcessHeap(), 0, newEnv);
    }
    if (!ok) {
        if (wmiRewrite) {
            free(wmiRewrite);
        }
        if (scRewrite) {
            free(scRewrite);
        }
        SetLastError(createErr);
        return FALSE;
    }
    if (exempt) {
        ws_log("child created WITHOUT injection (debug/protected creation, flags=0x%lx)", (unsigned long)flags);
        SetLastError(ws_saved_last_error);
        return TRUE;
    }
    if (!ws_inject_into(pi->hProcess)) {
        DWORD err = GetLastError();
        ws_lock_enter(&g_procLock);
        g_injectFail++;
        ws_lock_leave(&g_procLock);
        ws_log("fail-closed CreateProcess: cannot inject the shim into the child (win32=%lu); "
               "the child was terminated rather than left unhooked", (unsigned long)err);
        TerminateProcess(pi->hProcess, (UINT)-1);
        CloseHandle(pi->hThread);
        CloseHandle(pi->hProcess);
        memset(pi, 0, sizeof(*pi));
        SetLastError(ERROR_ACCESS_DENIED);
        return FALSE;
    }
    ws_lock_enter(&g_procLock);
    g_injectCount++;
    ws_lock_leave(&g_procLock);
    if (scRewrite) {
        ws_log("sc.exe child injected pid=%lu", (unsigned long)pi->dwProcessId);
    }
    if (g_ws.verbose) {
        ws_log("child injected (pid=%lu) app=%ls", (unsigned long)pi->dwProcessId,
               app ? app : (cmd ? cmd : L"(null)"));
    }
    if (forced) {
        ResumeThread(pi->hThread);
    }
    if (wmiRewrite) {
        free(wmiRewrite);
    }
    if (scRewrite) {
        free(scRewrite);
    }
    SetLastError(ws_saved_last_error);
    return TRUE;
}

BOOL WINAPI ws_CreateProcessW(LPCWSTR app, LPWSTR cmd, LPSECURITY_ATTRIBUTES pa, LPSECURITY_ATTRIBUTES ta,
                              BOOL inherit, DWORD flags, LPVOID env, LPCWSTR cwd,
                              LPSTARTUPINFOW si, LPPROCESS_INFORMATION pi)
{
    return ws_create_process_common(NULL, 0, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
}

BOOL WINAPI ws_CreateProcessAsUserW(HANDLE token, LPCWSTR app, LPWSTR cmd, LPSECURITY_ATTRIBUTES pa,
                                    LPSECURITY_ATTRIBUTES ta, BOOL inherit, DWORD flags, LPVOID env,
                                    LPCWSTR cwd, LPSTARTUPINFOW si, LPPROCESS_INFORMATION pi)
{
    if (!g_orig.CreateProcessAsUserW) {
        SetLastError(ERROR_CALL_NOT_IMPLEMENTED);
        return FALSE;
    }
    return ws_create_process_common(token, 1, app, cmd, pa, ta, inherit, flags, env, cwd, si, pi);
}
