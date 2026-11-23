/* WinStageSandbox -- T4 shim: process injector.
 *
 * Method (d) from task-4: create the target process suspended, write the DLL
 * path into its address space, run a remote thread on kernel32!LoadLibraryW,
 * wait for it, then resume the main thread. The shim's DllMain auto-initializes
 * from the environment, so by the time the target's main thread executes its
 * first user instruction the hooks are already installed.
 *
 * Rejected alternatives (reasons in docs/T4-shim?.md):
 *   - QueueUserAPC(LoadLibraryW): early APCs are not reliably delivered to all
 *     processes before the entry point runs (and never to console-less ones).
 *   - PE import-table rewriting of the child: changes the on-disk/in-memory
 *     image, breaks signature assumptions, and is a much larger attack surface.
 *   - AppInit_DLLs / IFEO: writes global machine state (registry), which is
 *     exactly what this project must not do.
 *
 * Usage:
 *   winstage-inject.exe --dll <path> [--set-env NAME=VALUE]... [--report <file>]
 *                       [--cwd <dir>] [--timeout-ms <n>] -- <exe> [args...]
 *
 * Exit codes: 111 = injection failure, 112 = bad usage; otherwise the child's
 * exit code. stdout/stderr of the child are inherited from this process (the
 * caller redirects them), and the JSON report goes to --report.
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <tlhelp32.h>

#define INJECT_FAILED 111
#define USAGE_FAILED  112

typedef struct {
    wchar_t *dllPathStorage;
    const wchar_t *dll;
    const wchar_t *report;
    const wchar_t *cwd;
    DWORD timeoutMs;
    DWORD childTimeoutMs;
    const wchar_t *exe;
    wchar_t *cmdline;      /* mutable, passed to CreateProcessW */
    wchar_t *envBlock;     /* extra environment entries */
} Options;

static int write_report(const wchar_t *path, const char *json)
{
    if (!path) {
        return 0;
    }
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return 0;
    }
    DWORD wrote = 0;
    WriteFile(h, json, (DWORD)strlen(json), &wrote, NULL);
    CloseHandle(h);
    return 1;
}

static void json_escape_path(const wchar_t *path, char *out, size_t cch)
{
    char utf8[4096];
    utf8[0] = 0;
    WideCharToMultiByte(CP_UTF8, 0, path ? path : L"", -1, utf8, sizeof(utf8), NULL, NULL);
    size_t o = 0;
    for (size_t i = 0; utf8[i] && o + 3 < cch; i++) {
        if (utf8[i] == '\\' || utf8[i] == '"') {
            out[o++] = '\\';
        }
        out[o++] = utf8[i];
    }
    out[o] = 0;
}

/* ★ round-3 诊断（Lead）：注入器**分阶段**落报告。
 *
 * 动机（实测，`carrier-flake` 100 次里 2 次）：注入器退出码 0、子载体零输出，而
 * `--report` 指定的文件**根本不存在** —— 既没走成功路径（":498-503"）也没走
 * `fail()`（两条都写报告）。没有阶段信息就无法判断它停在哪一段。做法：参数解析完
 * 立刻写 `stage:"started"`，之后每过一个里程碑**覆盖**一次，正式结果同样覆盖它。
 * 本文件只是诊断产物（不属于 shim ABI），故常开；`write_report` 失败时把
 * "报告写不出去"也吐到 stderr，避免又一个静默失败。 */
static void trace_stage(const wchar_t *report, const char *stage, unsigned long extra)
{
    if (!report) {
        return;
    }
    char json[512];
    snprintf(json, sizeof(json),
             "{\"ok\":false,\"tool\":\"winstage-inject\",\"stage\":\"%s\",\"pid\":%lu,\"extra\":%lu}\n",
             stage, (unsigned long)GetCurrentProcessId(), extra);
    if (!write_report(report, json)) {
        fputs("{\"reportWrite\":\"failed\",\"stage\":\"", stderr);
        fputs(stage, stderr);
        fputs("\"}\n", stderr);
    }
}

static void fail(const wchar_t *report, const wchar_t *stage, const char *detail, DWORD lastError)
{
    char pathA[4096];
    json_escape_path(stage, pathA, sizeof(pathA));
    char json[5120];
    snprintf(json, sizeof(json),
             "{\"ok\":false,\"tool\":\"winstage-inject\",\"stage\":\"%s\",\"error\":\"%s\","
             "\"win32Error\":%lu}\n",
             pathA, detail, (unsigned long)lastError);
    fputs(json, stderr);
    if (!write_report(report, json)) {
        fputs("{\"reportWrite\":\"failed\",\"stage\":\"fail\"}\n", stderr);
    }
    ExitProcess(INJECT_FAILED);
}

static BOOL build_environment(const wchar_t *sets[], int setCount, wchar_t **out)
{
    /* Start from our own environment and append/override NAME=VALUE entries. */
    wchar_t *cur = GetEnvironmentStringsW();
    if (!cur) {
        return FALSE;
    }
    size_t cap = 65536;
    wchar_t *block = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, cap * sizeof(wchar_t));
    if (!block) {
        FreeEnvironmentStringsW(cur);
        return FALSE;
    }
    size_t used = 0;
    int append_block = 0;
    for (wchar_t *p = cur; *p; p += wcslen(p) + 1) {
        if ((p[0] == L'=' && p[1] != 0)) {
            /* "=C:=C:\..." pseudo entries must be preserved verbatim and first */
            append_block++;
        }
        size_t len = wcslen(p);
        if (used + len + 2 >= cap) {
            break;
        }
        memcpy(block + used, p, (len + 1) * sizeof(wchar_t));
        used += len;
        block[used++] = L'\0';
    }
    FreeEnvironmentStringsW(cur);
    (void)append_block;

    for (int i = 0; i < setCount; i++) {
        const wchar_t *kv = sets[i];
        const wchar_t *eq = wcschr(kv, L'=');
        if (!eq) {
            continue;
        }
        size_t nameLen = (size_t)(eq - kv);
        /* remove an existing entry with the same name (case-insensitive) */
        wchar_t *w = block;
        while (*w) {
            size_t len = wcslen(w);
            if (_wcsnicmp(w, kv, nameLen) == 0 && w[nameLen] == L'=') {
                memmove(w, w + len + 1, (used - (size_t)(w - block) - len) * sizeof(wchar_t));
                used -= len + 1;
                continue;
            }
            w += len + 1;
        }
        size_t len = wcslen(kv);
        if (used + len + 2 >= cap) {
            continue;
        }
        memcpy(block + used, kv, (len + 1) * sizeof(wchar_t));
        used += len;
        block[used++] = L'\0';
    }
    block[used] = L'\0';
    /* Environment blocks are double-NUL terminated; the loop above already
     * wrote the terminator for each entry, so ensure a final empty entry. */
    if (used == 0 || block[used - 1] != L'\0') {
        block[used++] = L'\0';
    }
    block[used] = L'\0';
    *out = block;
    return TRUE;
}

/* ── 无参数启动（透明性）──────────────────────────────────────────────────────
 *
 * 命令行走 `wmic process get CommandLine` 是可见的。真实红队 recon 正是从
 * `C:\winstage-plugin\...\winstage-inject.exe --dll ... --report ...` 反查到机制。
 * 因此：
 *   · DLL 路径优先取环境变量 `WINSTAGE_INJECT_DLL`（不可见于命令行）；
 *   · 报告路径取 `WINSTAGE_INJECT_REPORT`；
 *   · WMI 那条路没有可控环境（服务端起进程），改用 `--job <file>`：一个 base64
 *     编码的 key=value 文件，和 helper 放在一起，命令行只出现一个中性文件名。
 * 这三种来源的变量在创建子进程前都会从**本进程环境**里删掉，避免泄漏给载体。
 */
static int b64_value(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static int b64_decode(const char *in, unsigned char *out, size_t cap)
{
    unsigned int acc = 0;
    int bits = 0;
    size_t o = 0;
    for (const char *p = in; p && *p; p++) {
        if (*p == '=' ) break;
        if (*p == '\r' || *p == '\n' || *p == ' ' || *p == '\t') continue;
        int v = b64_value(*p);
        if (v < 0) return -1;
        acc = (acc << 6) | (unsigned int)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (o >= cap) return -1;
            out[o++] = (unsigned char)((acc >> bits) & 0xFFu);
        }
    }
    return (int)o;
}

/** Read `path` (base64 text), decode to UTF-8 and return a wide copy. */
static wchar_t *read_job_text(const wchar_t *path)
{
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    char raw[8192];
    DWORD read = 0;
    BOOL ok = ReadFile(h, raw, sizeof(raw) - 1, &read, NULL);
    CloseHandle(h);
    if (!ok) {
        return NULL;
    }
    raw[read] = 0;
    unsigned char bytes[6144];
    int n = b64_decode(raw, bytes, sizeof(bytes));
    if (n <= 0) {
        return NULL;
    }
    int wc = MultiByteToWideChar(CP_UTF8, 0, (const char *)bytes, n, NULL, 0);
    if (wc <= 0) {
        return NULL;
    }
    wchar_t *w = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (size_t)(wc + 1) * sizeof(wchar_t));
    if (!w) {
        return NULL;
    }
    MultiByteToWideChar(CP_UTF8, 0, (const char *)bytes, n, w, wc);
    w[wc] = 0;
    return w;
}

static wchar_t *env_dup(const wchar_t *name)
{
    DWORD n = GetEnvironmentVariableW(name, NULL, 0);
    if (n == 0) {
        return NULL;
    }
    wchar_t *out = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (size_t)n * sizeof(wchar_t));
    if (!out) {
        return NULL;
    }
    DWORD got = GetEnvironmentVariableW(name, out, n);
    if (got == 0 || got >= n) {
        HeapFree(GetProcessHeap(), 0, out);
        return NULL;
    }
    return out;
}

/** Directory of this executable (with trailing backslash). */
static int self_dir(wchar_t *out, DWORD cch)
{
    if (!GetModuleFileNameW(NULL, out, cch)) {
        return 0;
    }
    wchar_t *slash = wcsrchr(out, L'\\');
    if (!slash) {
        return 0;
    }
    slash[1] = 0;
    return 1;
}

/* Resolve the target the way CreateProcessW does NOT: SearchPathW with and
 * without the .exe extension, then an absolute path. Passing a bare "powershell.exe"
 * to lpApplicationName fails with Win32 2 -- the same gap as the project's
 * documented "no PATHEXT resolution" defect. */
static BOOL resolve_executable(const wchar_t *in, wchar_t *out, DWORD cch)
{
    out[0] = 0;
    wchar_t found[4096];
    DWORD n = 0;
    if (wcschr(in, L'\\') || wcschr(in, L'/')) {
        if (GetFileAttributesW(in) != INVALID_FILE_ATTRIBUTES) {
            n = GetFullPathNameW(in, cch, out, NULL);
            return n > 0 && n < cch;
        }
        return FALSE;
    }
    if (SearchPathW(NULL, in, NULL, 4096, found, NULL) > 0) {
        n = GetFullPathNameW(found, cch, out, NULL);
        return n > 0 && n < cch;
    }
    if (SearchPathW(NULL, in, L".exe", 4096, found, NULL) > 0) {
        n = GetFullPathNameW(found, cch, out, NULL);
        return n > 0 && n < cch;
    }
    return FALSE;
}

/* Append one argument using the CommandLineToArgvW/MSVCRT quoting rules, so the
 * child's CRT parses the same argv the caller meant. */
static BOOL append_quoted_arg(wchar_t *buf, size_t cap, size_t *pos, const wchar_t *arg)
{
    size_t len = wcslen(arg);
    int needQuote = (len == 0);
    for (size_t i = 0; i < len; i++) {
        if (arg[i] == L' ' || arg[i] == L'\t' || arg[i] == L'"') {
            needQuote = 1;
            break;
        }
    }
    if (*pos + 1 >= cap) {
        return FALSE;
    }
    if (needQuote) {
        buf[(*pos)++] = L'"';
    }
    size_t backslashes = 0;
    for (size_t i = 0; i < len; i++) {
        if (arg[i] == L'\\') {
            backslashes++;
            continue;
        }
        if (arg[i] == L'"') {
            /* escape the quote and double the preceding backslashes */
            for (size_t k = 0; k < backslashes * 2 + 1; k++) {
                if (*pos + 1 >= cap) return FALSE;
                buf[(*pos)++] = L'\\';
            }
            if (*pos + 1 >= cap) return FALSE;
            buf[(*pos)++] = L'"';
            backslashes = 0;
            continue;
        }
        for (size_t k = 0; k < backslashes; k++) {
            if (*pos + 1 >= cap) return FALSE;
            buf[(*pos)++] = L'\\';
        }
        backslashes = 0;
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = arg[i];
    }
    /* trailing backslashes must be doubled inside quotes */
    for (size_t k = 0; k < backslashes * (needQuote ? 2 : 1); k++) {
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = L'\\';
    }
    if (needQuote) {
        if (*pos + 1 >= cap) return FALSE;
        buf[(*pos)++] = L'"';
    }
    buf[*pos] = 0;
    return TRUE;
}

/* ★ R20①（carrier）—— 延迟初始化的第二步。
 *
 * DllMain 现在**不做**初始化（只登记意图），所以远程 LoadLibraryW 成功只代表
 * "模块映射进来了"，钩子还没装。注入器在本进程把同一个 DLL 加载一次、用
 * GetProcAddress 拿到 `WinstageShimInit`，再用

 *     远程地址 = 远程模块基址 + (本地导出地址 - 本地模块基址)

 * 算出它在目标进程里的地址（同一 DLL 映像的相对偏移在两个进程里一致；系统 DLL
 * 同址的假设已在 LoadLibraryW 那步用过，这里是同一原理但更严格 —— 只用同一个文件）。
 * 之后在目标进程里起第二个远程线程调用它，等返回码（= 初始化结果）后才由调用方
 * ResumeThread。DllMain 已惰性化，因此这里在本进程的 LoadLibrary 不会装任何钩子。
 *
 * 失败处理：LoadLibrary 失败 ⇒ 老行为（fail closed）。初始化线程以异常码结束
 * ⇒ 进程没有可用钩子，同样 fail closed。初始化返回普通 Win32 错误码时保持旧语义
 * （注入成功、子进程继续；rc 写进报告），因为 DISABLE=1（rc=1058）与"配置不全导致
 * DllMain 初始化失败但进程照跑"在 R20 之前就是这个行为。 */
/**
 * Find the module base of the DLL we just loaded in the target process.
 *
 * WHY THIS EXISTS (2026-11-23, real Windows 10 / x64):
 *   `LoadLibraryW` runs in a remote thread, and the only value we can read back
 *   through `GetExitCodeThread` is a **DWORD**. On x64 the module handle is a
 *   64-bit pointer (normally 0x7ff8...), so that read-back truncates it. Adding
 *   the export RVA to the truncated value made the "call WinstageShimInit"
 *   thread start at an unmapped / CFG-invalid address; the target died with
 *   `0xC0000409` and every injection ended in exit 111 ("remote
 *   WinstageShimInit failed"), which silently kept the whole lane on T1.
 *
 *   Enumerating the target's modules is the authoritative way to recover the
 *   real base: the loader already knows it, and the path match also rejects a
 *   stale copy that happens to be mapped into the target.
 *
 * @returns module base, or NULL when the snapshot cannot be taken (caller
 *          falls back to the legacy truncated handle).
 */
static HMODULE find_remote_module(DWORD pid, const wchar_t *dllPath)
{
    if (!dllPath) {
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
            if (me.szExePath[0] && _wcsicmp(me.szExePath, dllPath) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
            const wchar_t *a = wcsrchr(me.szExePath, L'\\');
            const wchar_t *b = wcsrchr(dllPath, L'\\');
            if (a && b && _wcsicmp(a + 1, b + 1) == 0) {
                found = (HMODULE)(void *)me.modBaseAddr;
                break;
            }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return found;
}

static FARPROC resolve_remote_export(HMODULE remoteModule, const wchar_t *dllPath)
{
    if (!remoteModule || !dllPath) {
        SetLastError(ERROR_INVALID_HANDLE);
        return NULL;
    }
    HMODULE local = LoadLibraryExW(dllPath, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!local) {
        return NULL;
    }
    FARPROC localFn = GetProcAddress(local, "WinstageShimInit");
    FARPROC remoteFn = NULL;
    if (localFn) {
        remoteFn = (FARPROC)((BYTE *)(ULONG_PTR)remoteModule + ((BYTE *)localFn - (BYTE *)local));
    } else {
        SetLastError(ERROR_PROC_NOT_FOUND);
    }
    FreeLibrary(local);
    return remoteFn;
}

int wmain(int argc, wchar_t **argv)
{
    /* Our launcher must never run with the shim already mapped: its DLL/job
     * precheck would then hit the sandbox mask on the plugin path. */
    if (GetModuleHandleW(L"winstage-shim.dll")) {
        DWORD ppid = 0;
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe;
            memset(&pe, 0, sizeof(pe));
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(snap, &pe)) {
                do {
                    if (pe.th32ProcessID == GetCurrentProcessId()) {
                        ppid = pe.th32ParentProcessID;
                        break;
                    }
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }
        fprintf(stderr, "inject: self already carries the shim (pid=%lu ppid=%lu)\n",
                (unsigned long)GetCurrentProcessId(), (unsigned long)ppid);
    }
    Options o;
    memset(&o, 0, sizeof(o));
    o.timeoutMs = 30000;
    o.childTimeoutMs = 300000; /* the child is terminated after this; a hung child
                                * otherwise outlives the injector and keeps the DLL
                                * and staging handles locked (real cleanup flakes) */

    const wchar_t *sets[64];
    int setCount = 0;
    /* Diagnostic switches (default off; they exist so the launcher's process
     * creation can be bisected against the injection itself):
     *   --no-inject    create + resume the target WITHOUT the remote load
     *   --inherit-env  pass no environment block (let CreateProcessW inherit)  */
    int noInject = 0;
    int inheritEnv = 0;
    int noSuspend = 0;
    int noInherit = 0;
    const wchar_t *jobPath = NULL;

    int i = 1;
    int sawDashDash = 0;
    for (; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) {
            sawDashDash = 1;
            i++;
            break;
        }
        if (wcscmp(argv[i], L"--dll") == 0 && i + 1 < argc) {
            o.dll = argv[++i];
        } else if (wcscmp(argv[i], L"--no-inject") == 0) {
            noInject = 1;
        } else if (wcscmp(argv[i], L"--inherit-env") == 0) {
            inheritEnv = 1;
        } else if (wcscmp(argv[i], L"--no-suspend") == 0) {
            noSuspend = 1;
        } else if (wcscmp(argv[i], L"--no-inherit") == 0) {
            noInherit = 1;
        } else if (wcscmp(argv[i], L"--job") == 0 && i + 1 < argc) {
            jobPath = argv[++i];
        } else if (wcscmp(argv[i], L"--report") == 0 && i + 1 < argc) {
            o.report = argv[++i];
        } else if (wcscmp(argv[i], L"--cwd") == 0 && i + 1 < argc) {
            o.cwd = argv[++i];
        } else if (wcscmp(argv[i], L"--set-env") == 0 && i + 1 < argc) {
            if (setCount < (int)(sizeof(sets) / sizeof(sets[0]))) {
                sets[setCount++] = argv[++i];
            } else {
                i++;
            }
        } else if (wcscmp(argv[i], L"--timeout-ms") == 0 && i + 1 < argc) {
            o.timeoutMs = (DWORD)_wtoi(argv[++i]);
        } else if (wcscmp(argv[i], L"--child-timeout-ms") == 0 && i + 1 < argc) {
            o.childTimeoutMs = (DWORD)_wtoi(argv[++i]);
        } else {
            break;
        }
    }
    (void)sawDashDash;
    /* ── 参数来源回退：环境变量 → job 文件 → 同目录同名默认 ──────────────────── */
    wchar_t *envDll = NULL;
    wchar_t *envReport = NULL;
    wchar_t *jobBlock = NULL;
    const wchar_t *jobSets[16];
    int jobSetCount = 0;
    static const struct {
        const wchar_t *key;
        const wchar_t *env;
    } jobMap[] = {
        { L"stage", L"DSH_STAGE_ROOT" },
        { L"config", L"DSH_SHIM_CONFIG" },
        { L"log", L"DSH_SHIM_LOG" },
        { L"regstage", L"DSH_REGSTAGE_SESSION_DIR" },
        { L"audit", L"DSH_AUDIT_LOG" },
        { L"helper", L"WINSTAGE_HELPER_DIR" },
    };
    if (!o.dll || !o.dll[0]) {
        envDll = env_dup(L"WINSTAGE_INJECT_DLL");
        if (envDll) {
            o.dll = envDll;
        }
    }
    if (!o.report || !o.report[0]) {
        envReport = env_dup(L"WINSTAGE_INJECT_REPORT");
        if (envReport) {
            o.report = envReport;
        }
    }
    if (jobPath && jobPath[0]) {
        jobBlock = read_job_text(jobPath);
        if (jobBlock) {
            wchar_t *line = jobBlock;
            while (line && *line) {
                wchar_t *nl = wcschr(line, L'\n');
                if (nl) {
                    *nl = 0;
                }
                size_t lineLen = wcslen(line);
                if (lineLen && line[lineLen - 1] == L'\r') {
                    line[lineLen - 1] = 0;
                }
                wchar_t *eq = wcschr(line, L'=');
                if (eq) {
                    *eq = 0;
                    const wchar_t *key = line;
                    const wchar_t *val = eq + 1;
                    if (_wcsicmp(key, L"dll") == 0) {
                        if (!o.dll || !o.dll[0]) {
                            o.dll = val; /* points into jobBlock (kept alive) */
                        }
                    } else if (val[0]) {
                        for (size_t k = 0; k < sizeof(jobMap) / sizeof(jobMap[0]); k++) {
                            if (_wcsicmp(key, jobMap[k].key) != 0 || jobSetCount >= 16) {
                                continue;
                            }
                            size_t need = wcslen(jobMap[k].env) + 1 + wcslen(val) + 1;
                            wchar_t *kv = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, need * sizeof(wchar_t));
                            if (!kv) {
                                continue;
                            }
                            _snwprintf(kv, need, L"%ls=%ls", jobMap[k].env, val);
                            kv[need - 1] = 0;
                            jobSets[jobSetCount++] = kv;
                            break;
                        }
                    }
                }
                line = nl ? nl + 1 : NULL;
            }
        }
    }
    if (!o.dll || !o.dll[0]) {
        if (getenv("WINSTAGE_INJECT_DEBUG")) {
            fprintf(stderr, "inject: argv job=%ls jobBlock=%d\n", jobPath ? jobPath : L"(none)",
                    jobBlock ? 1 : 0);
        }
        wchar_t dir[4096];
        static wchar_t legacy[4096];
        if (self_dir(dir, 4096)) {
            _snwprintf(legacy, 4096, L"%lswinstage-shim.dll", dir);
            legacy[4095] = 0;
            o.dll = legacy;
        }
    }
    for (int k = 0; k < jobSetCount && setCount < (int)(sizeof(sets) / sizeof(sets[0])); k++) {
        sets[setCount++] = jobSets[k];
    }
    /* These are transport-only; the child must not see them in `set`. */
    SetEnvironmentVariableW(L"WINSTAGE_INJECT_DLL", NULL);
    SetEnvironmentVariableW(L"WINSTAGE_INJECT_REPORT", NULL);

    if (i >= argc || !o.dll || !o.dll[0]) {
        fputs("usage: winstage-inject.exe [--dll <path>] [--job <file>] [--set-env K=V]... [--report <json>] [--cwd <dir>] [--timeout-ms N] [--child-timeout-ms N] [--no-inject] [--inherit-env] -- <exe> [args...]\n", stderr);
        return USAGE_FAILED;
    }
    o.exe = argv[i];
    /* ★ round-3 诊断：参数解析完成 ⇒ 立刻落下第一份阶段报告（此后每个里程碑覆盖它）。
     * 若某次失败run 连 `stage:"started"` 都没有，说明问题在参数解析/启动之前；
     * 若停在 started 之后、injected 之前，则卡在解析目标/预检/注入那一段。 */
    trace_stage(o.report, "started", (unsigned long)argc);

    /* Resolve the target: absolute path, PATH lookup, or PATH + ".exe". */
    wchar_t resolvedExe[4096];
    if (!resolve_executable(o.exe, resolvedExe, 4096)) {
        fail(o.report, L"resolve-executable",
             "cannot resolve the target executable (give an absolute path; PATHEXT/App Paths are not implied)",
             GetLastError() ? GetLastError() : ERROR_FILE_NOT_FOUND);
    }

    /* Build a command line that preserves the caller's argv: argv[0] is the
     * resolved executable and every argument is quoted per the MSVCRT rules. */
    size_t clLen = 0;
    for (int k = i; k < argc; k++) {
        clLen += wcslen(argv[k]) * 2 + 16;
    }
    clLen += wcslen(resolvedExe) * 2 + 16;
    o.cmdline = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, clLen * sizeof(wchar_t));
    if (!o.cmdline) {
        fail(o.report, L"alloc", "cannot allocate command line", GetLastError());
    }
    size_t pos = 0;
    if (!append_quoted_arg(o.cmdline, clLen, &pos, resolvedExe)) {
        fail(o.report, L"args", "command line too long", ERROR_FILENAME_EXCED_RANGE);
    }
    for (int k = i + 1; k < argc; k++) {
        if (pos + 1 >= clLen) {
            fail(o.report, L"args", "command line too long", ERROR_FILENAME_EXCED_RANGE);
        }
        o.cmdline[pos++] = L' ';
        o.cmdline[pos] = 0;
        if (!append_quoted_arg(o.cmdline, clLen, &pos, argv[k])) {
            fail(o.report, L"args", "command line too long", ERROR_FILENAME_EXCED_RANGE);
        }
    }
    o.exe = resolvedExe;

    BOOL envBuilt = inheritEnv ? FALSE : build_environment(sets, setCount, &o.envBlock);

    DWORD creationFlags = CREATE_UNICODE_ENVIRONMENT | (noSuspend ? 0u : CREATE_SUSPENDED);
    /* No console in this process (GUI subsystem / executor pipes) => do not let
     * the child allocate a visible console window. Its std handles are inherited. */
#ifndef WINSTAGE_DISABLE_NO_WINDOW
    if (!GetConsoleWindow()) {
        creationFlags |= CREATE_NO_WINDOW;
    }
#endif

    {
        size_t dllLen = (wcslen(o.dll) + 1) * sizeof(wchar_t);
        if (dllLen > 32767) {
            fail(o.report, L"args", "dll path too long", ERROR_FILENAME_EXCED_RANGE);
        }
    }

    /* Normalize the DLL path first, then check existence: a literal
     * "is this absolute?" test broke callers that passed a relative path with a
     * different working directory, and reported it as "not found". */
    {
        wchar_t fullDll[4096];
        DWORD n = GetFullPathNameW(o.dll, 4096, fullDll, NULL);
        if (n == 0 || n >= 4096) {
            fail(o.report, L"precheck", "cannot normalize the dll path", GetLastError());
        }
        /* A freshly written DLL can be briefly locked by a crash handler or the
         * virus scanner; retry the existence check before declaring failure. */
        int attemptsLeft = 4;
        while (GetFileAttributesW(fullDll) == INVALID_FILE_ATTRIBUTES && attemptsLeft-- > 0) {
            Sleep(250);
        }
        if (GetFileAttributesW(fullDll) == INVALID_FILE_ATTRIBUTES) {
            DWORD err = GetLastError();
            /* Include the path: a misread job file otherwise looks exactly like
             * a missing DLL and costs a whole guest round-trip to diagnose. */
            char pathA[600];
            pathA[0] = 0;
            WideCharToMultiByte(CP_ACP, 0, fullDll, -1, pathA, sizeof(pathA), NULL, NULL);
            char detail[720];
            snprintf(detail, sizeof(detail), "%s: %s",
                     (err == ERROR_PATH_NOT_FOUND || err == ERROR_FILE_NOT_FOUND)
                         ? "dll file does not exist at the normalized path"
                         : "dll file is not accessible (locked?)",
                     pathA);
            fail(o.report, L"precheck", detail, err);
        }
        o.dllPathStorage = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, sizeof(fullDll));
        if (!o.dllPathStorage) {
            fail(o.report, L"alloc", "cannot allocate dll path storage", GetLastError());
        }
        memcpy(o.dllPathStorage, fullDll, sizeof(fullDll));
        o.dll = o.dllPathStorage;
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    memset(&si, 0, sizeof(si));
    memset(&pi, 0, sizeof(pi));
    si.cb = sizeof(si);

    if (!CreateProcessW(o.exe, o.cmdline, NULL, NULL, noInherit ? FALSE : TRUE, creationFlags,
                        envBuilt ? o.envBlock : NULL, o.cwd, &si, &pi)) {
        fail(o.report, L"CreateProcessW", "cannot create the target process", GetLastError());
    }

    int rc = 0;
    DWORD injectErr = 0;
    HMODULE remoteModule = NULL;
    BOOL injected = FALSE;
    void *remoteMem = NULL;
    DWORD remoteExitCode = 0;
    int haveRemoteExitCode = 0;
    DWORD shimInitRc = 0;
    int haveShimInitRc = 0;
    int shimInitFailed = 0;

    size_t dllBytes = (wcslen(o.dll) + 1) * sizeof(wchar_t);
    if (noInject) {
        /* Diagnostic: let the target run untouched (no remote load). Used to tell
         * "the injection broke X" apart from "creating the target like this broke
         * X". */
        injected = TRUE;
    } else {
    remoteMem = VirtualAllocEx(pi.hProcess, NULL, dllBytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    SIZE_T written = 0;
    if (!remoteMem) {
        injectErr = GetLastError();
    } else if (!WriteProcessMemory(pi.hProcess, remoteMem, o.dll, dllBytes, &written) || written != dllBytes) {
        injectErr = GetLastError() ? GetLastError() : ERROR_PARTIAL_COPY;
    }
    if (!injectErr) {
        HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
        FARPROC pLoadLibraryW = GetProcAddress(k32, "LoadLibraryW");
        if (!pLoadLibraryW) {
            injectErr = ERROR_PROC_NOT_FOUND;
        } else {
            HANDLE th = CreateRemoteThread(pi.hProcess, NULL, 0,
                                           (LPTHREAD_START_ROUTINE)pLoadLibraryW, remoteMem, 0, NULL);
            if (!th) {
                injectErr = GetLastError();
            } else {
                DWORD wait = WaitForSingleObject(th, o.timeoutMs);
                if (wait != WAIT_OBJECT_0) {
                    injectErr = ERROR_TIMEOUT;
                } else {
                    DWORD moduleResult = 0;
                    if (!GetExitCodeThread(th, &moduleResult)) {
                        injectErr = GetLastError();
                    } else {
                        remoteExitCode = moduleResult;
                        haveRemoteExitCode = 1;
                        if (moduleResult == 0) {
                            /* LoadLibraryW in the target returned NULL. Its
                             * GetLastError lives in the dead remote thread and is
                             * not readable, so report a distinct code instead of
                             * inventing ERROR_MOD_NOT_FOUND. */
                            injectErr = ERROR_DLL_INIT_FAILED;
                        } else {
                            /* Prefer the module table: the DWORD exit code above
                             * truncates a 64-bit HMODULE (see find_remote_module). */
                            remoteModule = find_remote_module(pi.dwProcessId, o.dll);
                            if (!remoteModule) {
                                remoteModule = (HMODULE)(ULONG_PTR)moduleResult;
                            }
                            injected = TRUE;
                        }
                    }
                }
                CloseHandle(th);
            }
        }
    }
    }

    /* ★ R20①：模块已映射（remoteModule != NULL）⇒ 在目标进程里调用导出的
     * WinstageShimInit()，等它返回（就绪）后才继续。 */
    if (injected && !noInject && remoteModule) {
        trace_stage(o.report, "loaded", (unsigned long)(ULONG_PTR)remoteModule);
        FARPROC remoteInit = resolve_remote_export(remoteModule, o.dll);
        if (!remoteInit) {
            injectErr = GetLastError() ? GetLastError() : ERROR_PROC_NOT_FOUND;
            shimInitFailed = 1;
            injected = FALSE;
        } else {
            HANDLE ith = CreateRemoteThread(pi.hProcess, NULL, 0,
                                            (LPTHREAD_START_ROUTINE)remoteInit, NULL, 0, NULL);
            if (!ith) {
                injectErr = GetLastError();
                shimInitFailed = 1;
                injected = FALSE;
            } else {
                DWORD initWait = WaitForSingleObject(ith, o.timeoutMs);
                DWORD initRc = 0;
                if (initWait != WAIT_OBJECT_0) {
                    injectErr = ERROR_TIMEOUT;
                    shimInitFailed = 1;
                    injected = FALSE;
                } else if (!GetExitCodeThread(ith, &initRc)) {
                    injectErr = GetLastError();
                    shimInitFailed = 1;
                    injected = FALSE;
                } else {
                    shimInitRc = initRc;
                    haveShimInitRc = 1;
                    if ((initRc & 0x80000000u) != 0) {
                        /* 初始化线程以异常码结束 ⇒ 目标进程里钩子没装成，
                         * 继续放行会变成"看起来沙箱、实际直写" ⇒ fail closed。 */
                        injectErr = initRc;
                        shimInitFailed = 1;
                        injected = FALSE;
                    }
                }
                CloseHandle(ith);
            }
        }
    }

    /* ★ round-3 诊断：注入阶段收尾（成功/失败都落一份，便于事后分段定位） */
    trace_stage(o.report, injected ? "injected" : "inject-failed", 0);
    if (!injected) {
        char detail[256];
        snprintf(detail, sizeof(detail), shimInitFailed ? "remote WinstageShimInit failed"
                                                        : "remote LoadLibraryW failed");
        TerminateProcess(pi.hProcess, INJECT_FAILED);
        char pathA[4096];
        json_escape_path(L"inject", pathA, sizeof(pathA));
        char json[6144];
        char dllA[4096];
        json_escape_path(o.dll, dllA, sizeof(dllA));
        char exitA[32];
        if (haveRemoteExitCode) {
            snprintf(exitA, sizeof(exitA), "%lu", (unsigned long)remoteExitCode);
        } else {
            snprintf(exitA, sizeof(exitA), "null");
        }
        char initA[32];
        if (haveShimInitRc) {
            snprintf(initA, sizeof(initA), "%lu", (unsigned long)shimInitRc);
        } else {
            snprintf(initA, sizeof(initA), "null");
        }
        snprintf(json, sizeof(json),
                 "{\"ok\":false,\"tool\":\"winstage-inject\",\"stage\":\"%s\",\"error\":\"%s\","
                 "\"win32Error\":%lu,\"remoteThreadExit\":%s,\"shimInitRc\":%s,\"dll\":\"%s\"}\n",
                 pathA, detail, (unsigned long)injectErr, exitA, initA, dllA);
        fputs(json, stderr);
        write_report(o.report, json);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (remoteMem) {
            /* the process is gone; nothing to free */
        }
        return INJECT_FAILED;
    }

    /* ★ round-4：把孩子收进 Job Object 并设置 `KILL_ON_JOB_CLOSE` —— 让"孤儿载体"从根上
     * 不可能出现。实测形态：载体挂住时，外部（`spawnSync` 超时、任务管理器强杀）会先杀掉
     * **注入器本身**，于是下面 `TerminateProcess(pi.hProcess, …)` 那条清理路径根本没机会执行，
     * 载体就带着 `winstage-shim.dll` 长期驻留：① 锁住 DLL，令下一次 `build-shim` 发布失败
     * （EPERM；实测残留 pid 4004 的 powershell 正是这么来的）；② 继续往暂存树里写。
     * Job 的 `KILL_ON_JOB_CLOSE` 由内核保证：注入器以**任何方式**消失时 Job 句柄关闭，
     * 载体连带被杀（孙进程也随 Job 一起走）。
     * 尽力而为：`CreateJobObjectW`/`SetInformationJobObject`/`AssignProcessToJobObject` 任一
     * 失败（例如宿主不允许嵌套 Job）就放弃并完全退回现状行为。句柄**故意不关** ——
     * 它活到进程结束，正是这条保证的实现方式。 */
    static HANDLE g_childJob = NULL;
    g_childJob = CreateJobObjectW(NULL, NULL);
    if (g_childJob) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
        memset(&jeli, 0, sizeof(jeli));
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(g_childJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli)) ||
            !AssignProcessToJobObject(g_childJob, pi.hProcess)) {
            CloseHandle(g_childJob);
            g_childJob = NULL;
        }
    }

    ResumeThread(pi.hThread);
    /* ★ round-3 诊断：子进程已放行。事后判读：
     *   停在 `stage:"injected"` ⇒ 注入器在放行前就没了（注入/句柄/线程那段）；
     *   停在 `stage:"resumed"`  ⇒ 注入器活着，而**子载体零输出**（问题在载体侧）；
     *   留下正式报告（含 childExitCode）⇒ 注入器走完了，看子退出码即可。 */
    trace_stage(o.report, "resumed", (unsigned long)pi.dwProcessId);
    DWORD waitChild = WaitForSingleObject(pi.hProcess, o.childTimeoutMs);
    DWORD childExit = 0;
    int childTimedOut = 0;
    if (waitChild == WAIT_TIMEOUT) {
        childTimedOut = 1;
        TerminateProcess(pi.hProcess, 124);
        WaitForSingleObject(pi.hProcess, 10000);
        childExit = 124;
    }
    GetExitCodeProcess(pi.hProcess, &childExit);
    rc = (int)childExit;

    {
        char dllA[4096];
        json_escape_path(o.dll, dllA, sizeof(dllA));
        char initA[32];
        if (haveShimInitRc) {
            snprintf(initA, sizeof(initA), "%lu", (unsigned long)shimInitRc);
        } else {
            snprintf(initA, sizeof(initA), "null");
        }
        char json[6144];
        snprintf(json, sizeof(json),
                 "{\"ok\":true,\"tool\":\"winstage-inject\",\"dll\":\"%s\",\"childPid\":%lu,"
                 "\"childExitCode\":%lu,\"childTimedOut\":%s,\"remoteModule\":\"0x%llx\","
                 "\"shimInitRc\":%s}\n",
                 dllA, (unsigned long)pi.dwProcessId, (unsigned long)childExit,
                 childTimedOut ? "true" : "false", (unsigned long long)(ULONG_PTR)remoteModule,
                 initA);
        write_report(o.report, json);
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return rc;
}

/* A console subsystem injector flashes a console window for every command the
 * agent runs (and for every wmic-created injector). Build with
 * -DWINSTAGE_GUI_SUBSYSTEM -mwindows so CreateProcess does not allocate a
 * console; the child still gets the inherited std handles (pipes/files). */
#ifdef WINSTAGE_GUI_SUBSYSTEM
int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR lpCmdLine, int nCmdShow)
{
    (void)hInst;
    (void)hPrev;
    (void)lpCmdLine;
    (void)nCmdShow;
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) {
        return 112;
    }
    int rc = wmain(argc, argv);
    LocalFree(argv);
    return rc;
}
#endif
