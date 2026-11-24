/* WinStageSandbox -- T4 shim: process injector (command-line helper).
 *
 * Method (d) from task-4: create the target process suspended, write the DLL
 * path into its address space, run a remote thread on kernel32!LoadLibraryW,
 * wait for it, then call the exported WinstageShimInit remotely and resume the
 * main thread. By the time the target's main thread executes its first
 * instruction the hooks are installed.
 *
 * The launch/inject sequence itself lives in ws_launch.c: the host's native
 * addon (shim/addon/winstage-addon.c) uses the very same code, so it can create
 * the child **inside the harness process** instead of spawning this helper.
 * This file is now only the CLI/reporting shell around it.
 *
 * Usage:
 *   winstage-inject.exe --dll <path> [--set-env NAME=VALUE]... [--report <file>]
 *                       [--cwd <dir>] [--timeout-ms <n>] [--forward-stdin]
 *                       -- <exe> [args...]
 *
 * Exit codes: 111 = injection failure, 112 = bad usage; otherwise the child's
 * exit code.
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "ws_launch.h"

#define INJECT_FAILED 111
#define USAGE_FAILED  112

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
 * `--report` 指定的文件**根本不存在** —— 既没走成功路径也没走 `fail()`（两条都写
 * 报告）。没有阶段信息就无法判断它停在哪一段。做法：参数解析完立刻写
 * `stage:"started"`，之后每过一个里程碑**覆盖**一次，正式结果同样覆盖它。
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

static void fail(const wchar_t *report, const wchar_t *stage, const char *detail, DWORD error)
{
    char stageA[256];
    json_escape_path(stage, stageA, sizeof(stageA));
    char json[1024];
    snprintf(json, sizeof(json),
             "{\"ok\":false,\"tool\":\"winstage-inject\",\"stage\":\"%s\",\"error\":\"%s\","
             "\"win32Error\":%lu}\n",
             stageA, detail, (unsigned long)error);
    fputs(json, stderr);
    if (!write_report(report, json)) {
        fputs("{\"reportWrite\":\"failed\",\"stage\":\"fail\"}\n", stderr);
    }
    ExitProcess(INJECT_FAILED);
}

/* ── stdin forwarding (2026-11-24) ──────────────────────────────────────────
 *
 * The command text must not appear on any command line: an agent that lists
 * processes would read `helper.exe -- cmd.exe /d /c C:\Windows\Temp\~x.cmd`.
 * With `--forward-stdin` the caller writes the shell input to our stdin; we hand
 * it to the child through a pipe and create the child as a plain `cmd.exe /d /q`.
 */
static int read_all_stdin(char **out, DWORD *outLen)
{
    *out = NULL;
    *outLen = 0;
    HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
    if (!h || h == INVALID_HANDLE_VALUE) {
        return 1; /* no stdin: empty input is valid */
    }
    size_t cap = 4096, len = 0;
    char *buf = (char *)HeapAlloc(GetProcessHeap(), 0, cap);
    if (!buf) {
        return 0;
    }
    for (;;) {
        if (len + 2048 > cap) {
            size_t ncap = cap * 2;
            char *nb = (char *)HeapReAlloc(GetProcessHeap(), 0, buf, ncap);
            if (!nb) {
                HeapFree(GetProcessHeap(), 0, buf);
                return 0;
            }
            buf = nb;
            cap = ncap;
            if (cap > (1u << 20)) {
                break;
            }
        }
        DWORD got = 0;
        if (!ReadFile(h, buf + len, (DWORD)(cap - len), &got, NULL) || got == 0) {
            break;
        }
        len += got;
    }
    *out = buf;
    *outLen = (DWORD)len;
    return 1;
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
        if (*p == '=') break;
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

int wmain(int argc, wchar_t **argv)
{
    /* Our launcher must never run with the shim already mapped: its DLL/job
     * precheck would then hit the sandbox mask on the plugin path. */
    if (GetModuleHandleW(L"winstage-shim.dll")) {
        fprintf(stderr, "inject: self already carries the shim (pid=%lu)\n",
                (unsigned long)GetCurrentProcessId());
    }
    WsLaunchRequest req;
    memset(&req, 0, sizeof(req));
    req.timeoutMs = 30000;
#ifndef WINSTAGE_DISABLE_NO_WINDOW
    req.noWindow = 1;
#endif

    const wchar_t *sets[64];
    int setCount = 0;
    /* Diagnostic switches (default off; they exist so the launcher's process
     * creation can be bisected against the injection itself):
     *   --no-inject    create + resume the target WITHOUT the remote load
     *   --inherit-env  pass no environment block (let CreateProcessW inherit)  */
    int inheritEnv = 0;
    int forwardStdin = 0;
    const wchar_t *reportPath = NULL;
    const wchar_t *jobPath = NULL;
    DWORD childTimeoutMs = 300000; /* the child is terminated after this; a hung child
                                    * otherwise outlives the injector and keeps the DLL
                                    * and staging handles locked (real cleanup flakes) */

    int i = 1;
    for (; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) {
            i++;
            break;
        }
        if (wcscmp(argv[i], L"--dll") == 0 && i + 1 < argc) {
            req.dll = argv[++i];
        } else if (wcscmp(argv[i], L"--no-inject") == 0) {
            req.noInject = 1;
        } else if (wcscmp(argv[i], L"--inherit-env") == 0) {
            inheritEnv = 1;
        } else if (wcscmp(argv[i], L"--no-suspend") == 0) {
            req.noSuspend = 1;
        } else if (wcscmp(argv[i], L"--forward-stdin") == 0) {
            forwardStdin = 1;
        } else if (wcscmp(argv[i], L"--no-inherit") == 0) {
            req.noInheritHandles = 1;
        } else if (wcscmp(argv[i], L"--job") == 0 && i + 1 < argc) {
            jobPath = argv[++i];
        } else if (wcscmp(argv[i], L"--report") == 0 && i + 1 < argc) {
            reportPath = argv[++i];
        } else if (wcscmp(argv[i], L"--cwd") == 0 && i + 1 < argc) {
            req.cwd = argv[++i];
        } else if (wcscmp(argv[i], L"--set-env") == 0 && i + 1 < argc) {
            if (setCount < (int)(sizeof(sets) / sizeof(sets[0]))) {
                sets[setCount++] = argv[++i];
            } else {
                i++;
            }
        } else if (wcscmp(argv[i], L"--timeout-ms") == 0 && i + 1 < argc) {
            req.timeoutMs = (DWORD)_wtoi(argv[++i]);
        } else if (wcscmp(argv[i], L"--child-timeout-ms") == 0 && i + 1 < argc) {
            childTimeoutMs = (DWORD)_wtoi(argv[++i]);
        } else {
            break;
        }
    }

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
    if (!req.dll || !req.dll[0]) {
        envDll = env_dup(L"WINSTAGE_INJECT_DLL");
        if (envDll) {
            req.dll = envDll;
        }
    }
    if (!reportPath || !reportPath[0]) {
        envReport = env_dup(L"WINSTAGE_INJECT_REPORT");
        if (envReport) {
            reportPath = envReport;
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
                        if (!req.dll || !req.dll[0]) {
                            req.dll = val; /* points into jobBlock (kept alive) */
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
    if (!req.dll || !req.dll[0]) {
        if (getenv("WINSTAGE_INJECT_DEBUG")) {
            fprintf(stderr, "inject: argv job=%ls jobBlock=%d\n", jobPath ? jobPath : L"(none)",
                    jobBlock ? 1 : 0);
        }
        wchar_t dir[4096];
        static wchar_t legacy[4096];
        if (self_dir(dir, 4096)) {
            _snwprintf(legacy, 4096, L"%lswinstage-shim.dll", dir);
            legacy[4095] = 0;
            req.dll = legacy;
        }
    }
    for (int k = 0; k < jobSetCount && setCount < (int)(sizeof(sets) / sizeof(sets[0])); k++) {
        sets[setCount++] = jobSets[k];
    }
    /* These are transport-only; the child must not see them in `set`. */
    SetEnvironmentVariableW(L"WINSTAGE_INJECT_DLL", NULL);
    SetEnvironmentVariableW(L"WINSTAGE_INJECT_REPORT", NULL);

    if (i >= argc || !req.dll || !req.dll[0]) {
        fputs("usage: winstage-inject.exe [--dll <path>] [--job <file>] [--set-env K=V]... [--report <json>] [--cwd <dir>] [--timeout-ms N] [--child-timeout-ms N] [--no-inject] [--inherit-env] -- <exe> [args...]\n", stderr);
        return USAGE_FAILED;
    }
    req.exe = argv[i];
    req.args = (const wchar_t *const *)(argv + i + 1);
    req.argCount = argc - (i + 1);
    /* ★ round-3 诊断：参数解析完成 ⇒ 立刻落下第一份阶段报告（此后每个里程碑覆盖它）。 */
    trace_stage(reportPath, "started", (unsigned long)argc);

    wchar_t *envBlock = NULL;
    if (!inheritEnv) {
        if (!ws_build_environment(sets, setCount, &envBlock)) {
            fail(reportPath, L"env", "cannot build the environment block", GetLastError());
        }
        req.envBlock = envBlock;
    }

    char *stdinData = NULL;
    DWORD stdinLen = 0;
    HANDLE stdinRead = NULL;
    HANDLE stdinWrite = NULL;
    if (forwardStdin && !req.noInheritHandles) {
        SECURITY_ATTRIBUTES sa;
        memset(&sa, 0, sizeof(sa));
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        if (!CreatePipe(&stdinRead, &stdinWrite, &sa, 0)) {
            fail(reportPath, L"stdin", "cannot create the stdin pipe", GetLastError());
        }
        SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
        req.stdinHandle = stdinRead;
        req.stdoutHandle = GetStdHandle(STD_OUTPUT_HANDLE);
        req.stderrHandle = GetStdHandle(STD_ERROR_HANDLE);
        if (!read_all_stdin(&stdinData, &stdinLen)) {
            fail(reportPath, L"stdin", "cannot read forwarded stdin", GetLastError());
        }
    }

    WsLaunchResult launched;
    if (!ws_launch(&req, &launched)) {
        if (stdinRead) CloseHandle(stdinRead);
        if (stdinWrite) CloseHandle(stdinWrite);
        char detailA[WS_LAUNCH_DETAIL_MAX];
        WideCharToMultiByte(CP_UTF8, 0, launched.detail, -1, detailA, sizeof(detailA), NULL, NULL);
        char dllA[4096];
        json_escape_path(req.dll, dllA, sizeof(dllA));
        char exitA[32];
        if (launched.haveRemoteThreadExit) {
            snprintf(exitA, sizeof(exitA), "%lu", (unsigned long)launched.remoteThreadExit);
        } else {
            snprintf(exitA, sizeof(exitA), "null");
        }
        char initA[32];
        if (launched.haveShimInitRc) {
            snprintf(initA, sizeof(initA), "%lu", (unsigned long)launched.shimInitRc);
        } else {
            snprintf(initA, sizeof(initA), "null");
        }
        char json[8192];
        snprintf(json, sizeof(json),
                 "{\"ok\":false,\"tool\":\"winstage-inject\",\"stage\":\"%ls\",\"error\":\"%s\","
                 "\"win32Error\":%lu,\"remoteThreadExit\":%s,\"shimInitRc\":%s,\"dll\":\"%s\"}\n",
                 launched.stage, detailA, (unsigned long)launched.error, exitA, initA, dllA);
        fputs(json, stderr);
        write_report(reportPath, json);
        return INJECT_FAILED;
    }

    if (stdinRead) {
        CloseHandle(stdinRead);
        stdinRead = NULL;
        DWORD off = 0;
        while (off < stdinLen) {
            DWORD wrote = 0;
            if (!WriteFile(stdinWrite, stdinData + off, stdinLen - off, &wrote, NULL) || wrote == 0) {
                break;
            }
            off += wrote;
        }
        CloseHandle(stdinWrite);
        stdinWrite = NULL;
    }
    if (stdinData) {
        HeapFree(GetProcessHeap(), 0, stdinData);
        stdinData = NULL;
    }
    trace_stage(reportPath, "resumed", (unsigned long)launched.pid);

    DWORD waitChild = WaitForSingleObject(launched.hProcess, childTimeoutMs);
    DWORD childExit = 0;
    int childTimedOut = 0;
    if (waitChild == WAIT_TIMEOUT) {
        childTimedOut = 1;
        TerminateProcess(launched.hProcess, 124);
        WaitForSingleObject(launched.hProcess, 10000);
        childExit = 124;
    }
    GetExitCodeProcess(launched.hProcess, &childExit);

    {
        char dllA[4096];
        json_escape_path(req.dll, dllA, sizeof(dllA));
        char initA[32];
        if (launched.haveShimInitRc) {
            snprintf(initA, sizeof(initA), "%lu", (unsigned long)launched.shimInitRc);
        } else {
            snprintf(initA, sizeof(initA), "null");
        }
        char json[6144];
        snprintf(json, sizeof(json),
                 "{\"ok\":true,\"tool\":\"winstage-inject\",\"dll\":\"%s\",\"childPid\":%lu,"
                 "\"childExitCode\":%lu,\"childTimedOut\":%s,\"remoteModule\":\"0x%llx\","
                 "\"shimInitRc\":%s}\n",
                 dllA, (unsigned long)launched.pid, (unsigned long)childExit,
                 childTimedOut ? "true" : "false", (unsigned long long)(ULONG_PTR)launched.remoteModule,
                 initA);
        write_report(reportPath, json);
    }
    CloseHandle(launched.hThread);
    CloseHandle(launched.hProcess);
    if (launched.hJob) {
        CloseHandle(launched.hJob);
    }
    if (envBlock) {
        HeapFree(GetProcessHeap(), 0, envBlock);
    }
    return (int)childExit;
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
